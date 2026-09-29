// lib/server/solanaChartHistory.ts — on-demand OLDER Solana chart history (GET /api/token/chart-candles
// ?chain=solana&timeframe=history). Solana's own lane — not the EVM one:
//   - identities are base58 and CASE-SENSITIVE: the mint and pool are validated and compared exactly,
//     never lowercased (cache keys included);
//   - the scan charts 15m x 672 (7 days) of GeckoTerminal pool OHLCV for the mint's proven side of its
//     active market pair (lib/server/solanaProviders.ts fetchSolanaOhlcv). When the user selects 1H /
//     4H / 1D or pans past the oldest candle, this reads genuine HOURLY GeckoTerminal OHLCV for that
//     same pool and side strictly before a cursor (before_timestamp);
//   - the side is proven here from the pool's own base/quote ids (one GeckoTerminal pool read, cached
//     30 min per exact mint + pool); a client-claimed side must agree or the request fails;
//   - response meta, when it names the mint, must name the same side;
//   - end of history needs evidence, exactly as the EVM lane: no_older_candles (zero rows),
//     reached_pool_creation (pool_created_at from the pool read) or history_cursor_not_advancing.
//     A short page is never an end. nextBeforeSec is the oldest returned candle, strictly < cursor.
// Hard cap: 2 provider calls per request (0 on a cache hit); windows cached 6h; concurrent identical
// requests share one read. CoinGecko is not used: its on-chain Solana routing is not verified here.

import { normalizeGtOhlcvRows, type EvmChartPoint } from '../evmChartCandles.ts'

export const SOLANA_BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
export const SOLANA_HISTORY_REQUEST = { resolution: 'hour' as const, aggregate: 1, limit: 1000 }
export const SOLANA_HISTORY_INTERVAL_SEC = 3600
export const SOLANA_HISTORY_MAX_PROVIDER_CALLS = 2
export const SOLANA_HISTORY_MAX_AGE_SEC = 3 * 365 * 86_400
const OK_TTL_MS = 6 * 3_600_000
const FAIL_TTL_MS = 60_000
const RATE_LIMITED_TTL_MS = 30_000
const SIDE_TTL_MS = 30 * 60_000
const CACHE_MAX = 500

export type SolanaHistoryEndReason = 'no_older_candles' | 'reached_pool_creation' | 'history_cursor_not_advancing'
export type SolanaHistoryFailure = 'invalid_request' | 'pool_not_indexed' | 'token_side_unresolved' | 'token_identity_unverified' | 'provider_rate_limited' | 'provider_http_error' | 'provider_schema_invalid'

export type SolanaHistoryResult =
  | { ok: true; intervalSec: number; points: EvmChartPoint[]; hasMore: boolean; nextBeforeSec: number | null; endReason: SolanaHistoryEndReason | null; source: 'geckoterminal' }
  | { ok: false; code: SolanaHistoryFailure; message: string; hasMore: boolean }

const MESSAGES: Record<SolanaHistoryFailure, string> = {
  invalid_request: 'Invalid chart history request.',
  pool_not_indexed: 'This pool is not indexed by the candle provider.',
  token_side_unresolved: "The pool did not identify which side is this mint, so its older candles could not be attributed to it.",
  token_identity_unverified: 'The returned history named a different token, so it was not used.',
  provider_rate_limited: 'The candle provider is rate-limiting requests right now. Try again shortly.',
  provider_http_error: 'The candle provider did not respond successfully.',
  provider_schema_invalid: 'The candle provider returned data in an unexpected format.',
}

type FetchJson = (url: string) => Promise<{ json: unknown; httpStatus: number | null }>

const sideCache = new Map<string, { side: 'base' | 'quote'; createdSec: number | null; expiresAt: number }>()
const historyCache = new Map<string, { value: SolanaHistoryResult; expiresAt: number }>()
const inFlight = new Map<string, Promise<{ result: SolanaHistoryResult; providerCalls: number }>>()
export function resetSolanaChartHistoryState() { sideCache.clear(); historyCache.clear(); inFlight.clear() }
const bounded = <K, V>(m: Map<K, V>) => { if (m.size >= CACHE_MAX) m.delete(m.keys().next().value!) }
const fail = (code: SolanaHistoryFailure, hasMore = true): SolanaHistoryResult => ({ ok: false, code, message: MESSAGES[code], hasMore })

/** The exact (case-preserved) address a GeckoTerminal id "solana_<address>" ends with, else null. */
function exactIdAddress(id: unknown): string | null {
  const s = String(id ?? '')
  const tail = s.startsWith('solana_') ? s.slice('solana_'.length) : null
  return tail && SOLANA_BASE58_RE.test(tail) ? tail : null
}

/** The mint's side in a GeckoTerminal Solana pool record — exact, case-sensitive. Pure; exported for tests. */
export function resolveSolanaGtPoolSide(poolData: unknown, mint: string): 'base' | 'quote' | null {
  const rel = ((poolData as { relationships?: Record<string, { data?: { id?: unknown } }> } | null)?.relationships ?? {})
  if (exactIdAddress(rel.base_token?.data?.id) === mint) return 'base'
  if (exactIdAddress(rel.quote_token?.data?.id) === mint) return 'quote'
  return null
}

export async function loadSolanaPoolHistory(
  params: { mint: string | null; pool: string | null; side?: string | null; before: number | null },
  fetchJson: FetchJson,
  opts: { baseUrl?: string; now?: () => number } = {},
): Promise<{ result: SolanaHistoryResult; providerCalls: number; cacheHit: boolean }> {
  const now = opts.now ?? Date.now
  const mint = String(params.mint ?? '')
  const pool = String(params.pool ?? '')
  const nowSec = Math.floor(now() / 1000)
  const before = Math.floor(Number(params.before) / 3600) * 3600
  const claimed = params.side == null || params.side === '' ? null : params.side
  if (!SOLANA_BASE58_RE.test(mint) || !SOLANA_BASE58_RE.test(pool) || !Number.isFinite(before) || before <= 0 || before > nowSec + 3600 || before < nowSec - SOLANA_HISTORY_MAX_AGE_SEC
    || (claimed != null && claimed !== 'base' && claimed !== 'quote')) {
    return { result: fail('invalid_request', false), providerCalls: 0, cacheHit: false }
  }
  const idKey = `solana:${mint}:${pool}`
  const checkClaim = (r: SolanaHistoryResult): SolanaHistoryResult => {
    const proven = sideCache.get(idKey)?.side ?? null
    return claimed != null && proven != null && claimed !== proven ? fail('token_side_unresolved', false) : r
  }
  const key = `${idKey}:history:${before}:${SOLANA_HISTORY_REQUEST.limit}`
  const cached = historyCache.get(key)
  if (cached && cached.expiresAt > now()) return { result: checkClaim(cached.value), providerCalls: 0, cacheHit: true }
  const pending = inFlight.get(key)
  if (pending) return { result: checkClaim((await pending).result), providerCalls: 0, cacheHit: true }

  const base = (opts.baseUrl ?? 'https://api.geckoterminal.com').replace(/\/$/, '')
  const work = (async (): Promise<{ result: SolanaHistoryResult; providerCalls: number }> => {
    let calls = 0
    let proof = sideCache.get(idKey)
    if (!proof || proof.expiresAt <= now()) {
      calls++
      const res = await fetchJson(`${base}/api/v2/networks/solana/pools/${pool}`)
      if (res.httpStatus === 429) return { result: fail('provider_rate_limited'), providerCalls: calls }
      if (res.httpStatus === 404) return { result: fail('pool_not_indexed', false), providerCalls: calls }
      if (res.httpStatus == null || res.httpStatus < 200 || res.httpStatus >= 300) return { result: fail('provider_http_error'), providerCalls: calls }
      const data = (res.json as { data?: unknown } | null)?.data
      if (!data || typeof data !== 'object') return { result: fail('provider_schema_invalid'), providerCalls: calls }
      const side = resolveSolanaGtPoolSide(data, mint)
      if (!side) return { result: fail('token_side_unresolved', false), providerCalls: calls }
      const createdMs = Date.parse(String(((data as { attributes?: Record<string, unknown> }).attributes ?? {}).pool_created_at ?? ''))
      proof = { side, createdSec: Number.isFinite(createdMs) && createdMs > 0 ? Math.floor(createdMs / 1000) : null, expiresAt: now() + SIDE_TTL_MS }
      bounded(sideCache)
      sideCache.set(idKey, proof)
    }
    const side = proof.side
    if (claimed != null && claimed !== side) return { result: fail('token_side_unresolved', false), providerCalls: calls }
    const end = (reason: SolanaHistoryEndReason, points: EvmChartPoint[] = []): SolanaHistoryResult =>
      ({ ok: true, intervalSec: SOLANA_HISTORY_INTERVAL_SEC, points, hasMore: false, nextBeforeSec: null, endReason: reason, source: 'geckoterminal' })

    calls++
    const r = SOLANA_HISTORY_REQUEST
    const raw = await fetchJson(`${base}/api/v2/networks/solana/pools/${pool}/ohlcv/${r.resolution}?aggregate=${r.aggregate}&limit=${r.limit}&currency=usd&token=${side}&before_timestamp=${before}`)
    if (raw.httpStatus === 429) return { result: fail('provider_rate_limited'), providerCalls: calls }
    if (raw.httpStatus == null || raw.httpStatus < 200 || raw.httpStatus >= 300) return { result: fail(raw.httpStatus === 404 ? 'pool_not_indexed' : 'provider_http_error'), providerCalls: calls }
    const meta = (raw.json as { meta?: { base?: { address?: unknown }; quote?: { address?: unknown } } } | null)?.meta
    const metaSide = meta ? (meta.base?.address === mint ? 'base' : meta.quote?.address === mint ? 'quote' : null) : null
    if (metaSide != null && metaSide !== side) return { result: fail('token_identity_unverified', false), providerCalls: calls }
    const list = (raw.json as { data?: { attributes?: { ohlcv_list?: unknown } } } | null)?.data?.attributes?.ohlcv_list
    if (!Array.isArray(list)) return { result: fail('provider_schema_invalid'), providerCalls: calls }
    if (list.length === 0) return { result: end('no_older_candles'), providerCalls: calls }
    const points = normalizeGtOhlcvRows(list).points.filter((p) => Date.parse(p.timestamp) / 1000 < before)
    if (points.length === 0) return { result: end('history_cursor_not_advancing'), providerCalls: calls }
    const oldest = Math.min(...points.map((p) => Date.parse(p.timestamp) / 1000))
    if (proof.createdSec != null && oldest <= Math.floor(proof.createdSec / 3600) * 3600) return { result: end('reached_pool_creation', points), providerCalls: calls }
    return { result: { ok: true, intervalSec: SOLANA_HISTORY_INTERVAL_SEC, points, hasMore: true, nextBeforeSec: oldest, endReason: null, source: 'geckoterminal' }, providerCalls: calls }
  })()
  inFlight.set(key, work)
  try {
    const out = await work
    bounded(historyCache)
    historyCache.set(key, { value: out.result, expiresAt: now() + (out.result.ok ? OK_TTL_MS : out.result.code === 'provider_rate_limited' ? RATE_LIMITED_TTL_MS : FAIL_TTL_MS) })
    return { result: checkClaim(out.result), providerCalls: out.providerCalls, cacheHit: false }
  } finally {
    inFlight.delete(key)
  }
}
