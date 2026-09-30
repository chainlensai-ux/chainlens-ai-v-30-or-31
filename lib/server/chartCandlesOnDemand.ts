// lib/server/chartCandlesOnDemand.ts — real 5M candles, fetched ONLY when a user selects 5M.
//
// ON-DEMAND 5M, DISCLOSED (requested: "fetch 5M ON DEMAND only when the user selects 5M" — never
// derived from 15M, never added to every scan). A normal token scan makes zero 5M requests. When
// the user clicks 5M, GET /api/token/chart-candles calls loadOnDemandCandles, which:
//   1. accepts only an EVM chain the chart pipeline supports and 0x addresses;
//   2. prices the SCANNED token's side of the SAME pool the scan's 15m candles came from. The side
//      is taken from the scan's own verified result when this server instance still holds it
//      (rememberVerifiedChartPool); otherwise it is re-proven from the pool's own base/quote ids with
//      one pool read. The client-supplied pool is never trusted for the side;
//   3. reads minute aggregate 5 x 288 rows (24h) for that proven side from CoinGecko's on-chain pool
//      OHLCV first (when the chain is routed to CoinGecko and a key is configured); only when that
//      read fails or returns no usable rows does it make the same read against GeckoTerminal. Both
//      support minute aggregates 1/5/15. Never derived from 15m;
//   4. caches by chain + token + pool + timeframe and de-duplicates concurrent identical requests.
// Hard cap: 3 provider calls per request (GeckoTerminal side verification only on a verification-
// cache miss, CoinGecko once, GeckoTerminal OHLCV only after a CoinGecko failure), 0 on a cache hit.

import {
  COINGECKO_ONCHAIN_NETWORK,
  EVM_CHART_NETWORK,
  EVM_POOL_ID_RE,
  v4PoolIdOhlcvSupported,
  isEvmPoolIdentifier,
  candleFailureMessage,
  classifyOhlcvResponse,
  coingeckoMetaTokenSide,
  EVM_POOL_ADDRESS_RE,
  normalizeGtOhlcvRows,
  resolveEvmPoolTokenSide,
  type CandleFailureCode,
  type CandleProvider,
  type EvmChartPoint,
} from '../evmChartCandles.ts'
import { buildCoverageMeta, type ChartCoverageMeta } from '../chartQuality.ts'

export const ON_DEMAND_CHAINS = ['eth', 'base', 'bnb', 'robinhood'] as const
export type OnDemandChain = (typeof ON_DEMAND_CHAINS)[number]

export const ON_DEMAND_TIMEFRAMES = {
  '5m': { resolution: 'minute' as const, aggregate: 5, limit: 288, intervalSec: 300 },
}
export type OnDemandTimeframe = keyof typeof ON_DEMAND_TIMEFRAMES

export const ON_DEMAND_MAX_PROVIDER_CALLS = 3
const RESULT_TTL_MS = 60_000
const RATE_LIMITED_TTL_MS = 30_000
const VERIFIED_POOL_TTL_MS = 30 * 60_000

export type OnDemandResult =
  | { ok: true; timeframe: OnDemandTimeframe; intervalSec: number; points: EvmChartPoint[]; source: CandleProvider; /** Requested/received window (limit x interval ending at the answer time; pool creation when known). */ coverage?: ChartCoverageMeta }
  | { ok: false; timeframe: OnDemandTimeframe | null; code: CandleFailureCode | 'invalid_request'; message: string }

export type FetchJson = (url: string) => Promise<{ json: unknown; httpStatus: number | null }>
/** CoinGecko on-chain pool OHLCV reader (lib/server/coingeckoOnchainOhlcv.ts); `side` is proven. */
export type FetchCoingeckoOhlcv = (
  chain: string,
  pool: string,
  req: { resolution: 'minute' | 'hour' | 'day'; aggregate: number; limit: number },
  side: 'base' | 'quote',
  /** Older-history cursor (candles strictly before this time); omitted for recent reads. */
  beforeSec?: number,
) => Promise<{ json: unknown; httpStatus: number | null }>

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

const verifiedPools = new Map<string, { side: 'base' | 'quote'; expiresAt: number }>()
const resultCache = new Map<string, { value: OnDemandResult; expiresAt: number }>()
const inFlight = new Map<string, Promise<{ result: OnDemandResult; providerCalls: number }>>()

const poolKey = (chain: string, token: string, pool: string) => `${chain}:${token.toLowerCase()}:${pool.toLowerCase()}`

/** Called by the scan route when its pool OHLCV succeeded with a proven side. */
export function rememberVerifiedChartPool(chain: string, token: string, pool: string, side: 'base' | 'quote', now = Date.now()) {
  verifiedPools.set(poolKey(chain, token, pool), { side, expiresAt: now + VERIFIED_POOL_TTL_MS })
}

/** Test hook — clears all in-memory state. */
export function resetOnDemandCandleState() {
  verifiedPools.clear()
  resultCache.clear()
  inFlight.clear()
  historyCache.clear()
  historyInFlight.clear()
  poolCreatedAtSec.clear()
}

function fail(timeframe: OnDemandTimeframe | null, code: CandleFailureCode | 'invalid_request', message?: string): OnDemandResult {
  return { ok: false, timeframe, code, message: message ?? (code === 'invalid_request' ? 'Invalid chart request.' : candleFailureMessage(code)) }
}

export function isOnDemandChain(v: string | null): v is OnDemandChain {
  return v != null && (ON_DEMAND_CHAINS as readonly string[]).includes(v)
}

export async function loadOnDemandCandles(
  params: { chain: string | null; token: string | null; pool: string | null; timeframe: string | null },
  fetchJson: FetchJson,
  opts: { baseUrl?: string; now?: () => number; fetchCoingecko?: FetchCoingeckoOhlcv; poolIdSupport?: { coingecko?: boolean; geckoterminal?: boolean } } = {},
): Promise<{ result: OnDemandResult; providerCalls: number; cacheHit: boolean }> {
  const now = opts.now ?? Date.now
  const timeframe = params.timeframe && params.timeframe in ON_DEMAND_TIMEFRAMES ? (params.timeframe as OnDemandTimeframe) : null
  if (!timeframe) return { result: fail(null, 'invalid_request', 'Unsupported chart timeframe.'), providerCalls: 0, cacheHit: false }
  if (!isOnDemandChain(params.chain)) return { result: fail(timeframe, 'network_not_supported'), providerCalls: 0, cacheHit: false }
  const token = params.token ?? ''
  const pool = params.pool ?? ''
  // Token: strict 20-byte address. Pool: a 20-byte pool contract OR a bytes32 V4/Infinity pool id.
  if (!ADDRESS_RE.test(token) || !isEvmPoolIdentifier(pool)) return { result: fail(timeframe, 'invalid_request'), providerCalls: 0, cacheHit: false }
  // A pool id is only ever sent to a provider whose support for it is proven (per-provider flags in
  // lib/evmChartCandles.ts). GeckoTerminal also proves the side when it isn't remembered, so an
  // unproven GeckoTerminal needs a remembered side before CoinGecko alone can be asked.
  const isPoolId = EVM_POOL_ID_RE.test(pool)
  const cgPoolOk = !isPoolId || (opts.poolIdSupport?.coingecko ?? v4PoolIdOhlcvSupported('coingecko', EVM_CHART_NETWORK[params.chain] ?? null))
  const gtPoolOk = !isPoolId || (opts.poolIdSupport?.geckoterminal ?? v4PoolIdOhlcvSupported('geckoterminal', EVM_CHART_NETWORK[params.chain] ?? null))
  if (!cgPoolOk && !gtPoolOk) return { result: fail(timeframe, 'provider_unsupported_pool_id'), providerCalls: 0, cacheHit: false }
  const chain = params.chain
  const network = EVM_CHART_NETWORK[chain]
  if (!network) return { result: fail(timeframe, 'network_not_supported'), providerCalls: 0, cacheHit: false }

  const key = `${poolKey(chain, token, pool)}:${timeframe}`
  const cached = resultCache.get(key)
  if (cached && cached.expiresAt > now()) return { result: cached.value, providerCalls: 0, cacheHit: true }
  const pending = inFlight.get(key)
  if (pending) {
    const shared = await pending
    return { result: shared.result, providerCalls: 0, cacheHit: true }
  }

  const base = (opts.baseUrl ?? 'https://api.geckoterminal.com').replace(/\/$/, '')
  const work = (async (): Promise<{ result: OnDemandResult; providerCalls: number }> => {
    let calls = 0
    const tf = ON_DEMAND_TIMEFRAMES[timeframe]
    let side: 'base' | 'quote' | null = null
    const remembered = verifiedPools.get(poolKey(chain, token, pool))
    if (remembered && remembered.expiresAt > now()) side = remembered.side
    else if (!gtPoolOk) return { result: fail(timeframe, 'provider_unsupported_pool_id'), providerCalls: calls }
    else {
      calls++
      const poolRes = await fetchJson(`${base}/api/v2/networks/${network}/pools/${pool.toLowerCase()}`)
      if (poolRes.httpStatus === 429) return { result: fail(timeframe, 'provider_rate_limited'), providerCalls: calls }
      if (poolRes.httpStatus === 404) return { result: fail(timeframe, 'pool_not_indexed'), providerCalls: calls }
      if (poolRes.httpStatus == null || poolRes.httpStatus < 200 || poolRes.httpStatus >= 300) return { result: fail(timeframe, 'provider_http_error'), providerCalls: calls }
      const data = (poolRes.json as { data?: unknown } | null)?.data
      if (!data || typeof data !== 'object') return { result: fail(timeframe, 'provider_schema_invalid'), providerCalls: calls }
      side = resolveEvmPoolTokenSide(data as Record<string, unknown>, token, network)
      if (!side) return { result: fail(timeframe, 'token_side_unresolved'), providerCalls: calls }
      rememberVerifiedChartPool(chain, token, pool, side, now())
      const createdMs = Date.parse(String(((data as { attributes?: Record<string, unknown> }).attributes ?? {}).pool_created_at ?? ''))
      if (Number.isFinite(createdMs) && createdMs > 0) poolCreatedAtSec.set(`${chain}:${pool.toLowerCase()}`, Math.floor(createdMs / 1000))
    }
    // Coverage of THIS request: `limit` x interval ending now (no extra call; pool age only when already read).
    const coverageOf = (points: EvmChartPoint[]) => buildCoverageMeta({
      requestEndSec: Math.floor(now() / 1000), intervalSec: tf.intervalSec, limit: tf.limit, points,
      poolCreatedSec: poolCreatedAtSec.get(`${chain}:${pool.toLowerCase()}`) ?? poolCreatedAtSec.get(`${chain}:${pool}`) ?? null,
    })
    if (cgPoolOk && opts.fetchCoingecko && COINGECKO_ONCHAIN_NETWORK[chain]) {
      calls++
      const cg = await opts.fetchCoingecko(chain, pool.toLowerCase(), { resolution: tf.resolution, aggregate: tf.aggregate, limit: tf.limit }, side)
      const cgOut = classifyOhlcvResponse('pool', cg.httpStatus, cg.json)
      // Its meta, when it names the token, must agree with the proven side (as in the history lane).
      const cgMetaOk = !(cg.json as { meta?: unknown } | null)?.meta || coingeckoMetaTokenSide(cg.json, token) == null || coingeckoMetaTokenSide(cg.json, token) === side
      if (cgOut.code === 'ok' && cgMetaOk) return { result: { ok: true, timeframe, intervalSec: tf.intervalSec, points: cgOut.normalized.points, source: 'coingecko_onchain', coverage: coverageOf(cgOut.normalized.points) }, providerCalls: calls }
    }
    if (!gtPoolOk) return { result: fail(timeframe, 'provider_unsupported_pool_id'), providerCalls: calls }
    if (calls >= ON_DEMAND_MAX_PROVIDER_CALLS) return { result: fail(timeframe, 'call_budget_exhausted'), providerCalls: calls }
    calls++
    const url = `${base}/api/v2/networks/${network}/pools/${pool.toLowerCase()}/ohlcv/${tf.resolution}?aggregate=${tf.aggregate}&limit=${tf.limit}&currency=usd&token=${side}`
    const raw = await fetchJson(url)
    const { code, normalized } = classifyOhlcvResponse('pool', raw.httpStatus, raw.json)
    if (code !== 'ok') return { result: fail(timeframe, code), providerCalls: calls }
    return { result: { ok: true, timeframe, intervalSec: tf.intervalSec, points: normalized.points, source: 'geckoterminal', coverage: coverageOf(normalized.points) }, providerCalls: calls }
  })()
  inFlight.set(key, work)
  try {
    const out = await work
    const ttl = !out.result.ok && out.result.code === 'provider_rate_limited' ? RATE_LIMITED_TTL_MS : RESULT_TTL_MS
    resultCache.set(key, { value: out.result, expiresAt: now() + ttl })
    return { ...out, cacheHit: false }
  } finally {
    inFlight.delete(key)
  }
}

// ── On-demand OLDER history for normal 20-byte pools ─────────────────────────────────────────────
//
// The scan reads a bounded recent window (15m x 672 = 7 days), so an old pool's 1D chart stops at
// ~8 daily candles. When the user selects 1H / 4H / 1D or pans past the oldest candle, the page asks
// GET /api/token/chart-candles?timeframe=history for genuine HOURLY pool OHLCV strictly before a
// cursor — the same providers and the same proven token side as the scan:
//   1. the scanned token's side: the scan's remembered proof, else one GeckoTerminal pool read
//      (the same proof as on-demand 5M); a client-supplied side must agree or the request fails;
//   2. CoinGecko on-chain hour x 1000 with before_timestamp (its meta, when present, must name the
//      same side), else GeckoTerminal hour x 1000 with before_timestamp;
//   3. rows at/after the cursor are dropped (no inclusive-boundary duplicate).
// END OF HISTORY needs evidence — a short page is NOT evidence (sparse pools skip hours with no
// trades, and neither provider's page contract promises a full page while older data remains).
// hasMore turns false only when:
//   - no_older_candles: the providers returned ZERO rows before the cursor (a CoinGecko zero is
//     cross-checked with GeckoTerminal inside the same 3-call cap);
//   - reached_pool_creation: the oldest candle sits in the hour of the pool's own pool_created_at
//     (known when this request read the pool from GeckoTerminal);
//   - history_cursor_not_advancing: the provider returned rows but none before the cursor, so the
//     next cursor could not move back — stopped rather than re-requesting the same window.
// Otherwise hasMore stays true and nextBeforeSec is the oldest returned candle, strictly < cursor.
// Hard cap: 3 provider calls per request (0 on a cache hit). Windows are immutable history, cached
// 6h; concurrent identical requests share one read. V4 PoolIds never come here.

export const POOL_HISTORY_REQUEST = { resolution: 'hour' as const, aggregate: 1, limit: 1000 }
export const POOL_HISTORY_INTERVAL_SEC = 3600
export const POOL_HISTORY_MAX_PROVIDER_CALLS = 3
export const POOL_HISTORY_MAX_AGE_SEC = 3 * 365 * 86_400
const HISTORY_OK_TTL_MS = 6 * 3_600_000
const HISTORY_FAIL_TTL_MS = 60_000
const HISTORY_CACHE_MAX = 500

export type PoolHistoryEndReason = 'no_older_candles' | 'reached_pool_creation' | 'history_cursor_not_advancing'

export type PoolHistoryResult =
  | { ok: true; intervalSec: number; points: EvmChartPoint[]; hasMore: boolean; nextBeforeSec: number | null; endReason: PoolHistoryEndReason | null; source: CandleProvider }
  | { ok: false; code: CandleFailureCode | 'invalid_request'; message: string; hasMore: boolean }

const historyCache = new Map<string, { value: PoolHistoryResult; expiresAt: number }>()
/** pool_created_at (sec) from a GeckoTerminal pool read this server made — end-of-history evidence only. */
const poolCreatedAtSec = new Map<string, number>()
const historyInFlight = new Map<string, Promise<{ result: PoolHistoryResult; providerCalls: number }>>()

const historyFail = (code: CandleFailureCode | 'invalid_request', hasMore = true, message?: string): PoolHistoryResult =>
  ({ ok: false, code, hasMore, message: message ?? (code === 'invalid_request' ? 'Invalid chart history request.' : candleFailureMessage(code)) })

export async function loadPoolOhlcvHistory(
  params: { chain: string | null; token: string | null; pool: string | null; side?: string | null; before: number | null },
  fetchJson: FetchJson,
  opts: { baseUrl?: string; now?: () => number; fetchCoingecko?: FetchCoingeckoOhlcv } = {},
): Promise<{ result: PoolHistoryResult; providerCalls: number; cacheHit: boolean }> {
  const now = opts.now ?? Date.now
  if (!isOnDemandChain(params.chain)) return { result: historyFail('network_not_supported', false), providerCalls: 0, cacheHit: false }
  const chain = params.chain
  const token = String(params.token ?? '').toLowerCase()
  const pool = String(params.pool ?? '').toLowerCase()
  const nowSec = Math.floor(now() / 1000)
  const before = Math.floor(Number(params.before) / 3600) * 3600
  const claimedSide = params.side == null || params.side === '' ? null : params.side
  if (!ADDRESS_RE.test(token) || !EVM_POOL_ADDRESS_RE.test(pool) || !Number.isFinite(before) || before <= 0 || before > nowSec + 3600 || before < nowSec - POOL_HISTORY_MAX_AGE_SEC
    || (claimedSide != null && claimedSide !== 'base' && claimedSide !== 'quote')) {
    return { result: historyFail('invalid_request', false), providerCalls: 0, cacheHit: false }
  }
  const network = EVM_CHART_NETWORK[chain]
  if (!network) return { result: historyFail('network_not_supported', false), providerCalls: 0, cacheHit: false }

  const key = `${poolKey(chain, token, pool)}:history:${before}:${POOL_HISTORY_REQUEST.limit}`
  const cached = historyCache.get(key)
  if (cached && cached.expiresAt > now()) return { result: checkClaim(cached.value), providerCalls: 0, cacheHit: true }
  const pending = historyInFlight.get(key)
  if (pending) return { result: checkClaim((await pending).result), providerCalls: 0, cacheHit: true }

  // Cached results are shared across callers, so the client's claimed side is checked per request.
  function checkClaim(r: PoolHistoryResult): PoolHistoryResult {
    const proven = verifiedPools.get(poolKey(chain, token, pool))?.side ?? null
    return claimedSide != null && proven != null && claimedSide !== proven ? historyFail('token_side_unresolved', false) : r
  }

  const base = (opts.baseUrl ?? 'https://api.geckoterminal.com').replace(/\/$/, '')
  const work = (async (): Promise<{ result: PoolHistoryResult; providerCalls: number }> => {
    let calls = 0
    // 1. The scanned token's proven side in this exact pool.
    let side: 'base' | 'quote' | null = null
    const remembered = verifiedPools.get(poolKey(chain, token, pool))
    if (remembered && remembered.expiresAt > now()) side = remembered.side
    else {
      calls++
      const poolRes = await fetchJson(`${base}/api/v2/networks/${network}/pools/${pool}`)
      if (poolRes.httpStatus === 429) return { result: historyFail('provider_rate_limited'), providerCalls: calls }
      if (poolRes.httpStatus === 404) return { result: historyFail('pool_not_indexed', false), providerCalls: calls }
      if (poolRes.httpStatus == null || poolRes.httpStatus < 200 || poolRes.httpStatus >= 300) return { result: historyFail('provider_http_error'), providerCalls: calls }
      const data = (poolRes.json as { data?: unknown } | null)?.data
      if (!data || typeof data !== 'object') return { result: historyFail('provider_schema_invalid'), providerCalls: calls }
      side = resolveEvmPoolTokenSide(data as Record<string, unknown>, token, network)
      if (!side) return { result: historyFail('token_side_unresolved', false), providerCalls: calls }
      rememberVerifiedChartPool(chain, token, pool, side, now())
      const createdMs = Date.parse(String(((data as { attributes?: Record<string, unknown> }).attributes ?? {}).pool_created_at ?? ''))
      if (Number.isFinite(createdMs) && createdMs > 0) {
        if (poolCreatedAtSec.size >= HISTORY_CACHE_MAX) poolCreatedAtSec.delete(poolCreatedAtSec.keys().next().value!)
        poolCreatedAtSec.set(`${chain}:${pool}`, Math.floor(createdMs / 1000))
      }
    }
    if (claimedSide != null && claimedSide !== side) return { result: historyFail('token_side_unresolved', false), providerCalls: calls }

    const createdSec = poolCreatedAtSec.get(`${chain}:${pool}`) ?? null
    const end = (reason: PoolHistoryEndReason, source: CandleProvider, points: EvmChartPoint[] = []): PoolHistoryResult =>
      ({ ok: true, intervalSec: POOL_HISTORY_INTERVAL_SEC, points, hasMore: false, nextBeforeSec: null, endReason: reason, source })
    const window = (json: unknown, source: CandleProvider): PoolHistoryResult | null => {
      const list = (json as { data?: { attributes?: { ohlcv_list?: unknown } } } | null)?.data?.attributes?.ohlcv_list
      if (!Array.isArray(list)) return null
      if (list.length === 0) return end('no_older_candles', source)
      const points = normalizeGtOhlcvRows(list).points.filter((p) => Date.parse(p.timestamp) / 1000 < before)
      // Rows came back but none before the cursor: the cursor cannot move — stop, never repeat it.
      if (points.length === 0) return end('history_cursor_not_advancing', source)
      const oldest = Math.min(...points.map((p) => Date.parse(p.timestamp) / 1000))
      if (createdSec != null && oldest <= Math.floor(createdSec / 3600) * 3600) return end('reached_pool_creation', source, points)
      return { ok: true, intervalSec: POOL_HISTORY_INTERVAL_SEC, points, hasMore: true, nextBeforeSec: oldest, endReason: null, source }
    }

    // 2. CoinGecko on-chain first, then GeckoTerminal — both with the before cursor. A CoinGecko
    // answer of zero older rows is not taken alone as the end of history: GeckoTerminal is asked too.
    let cgEnd: PoolHistoryResult | null = null
    if (opts.fetchCoingecko && COINGECKO_ONCHAIN_NETWORK[chain]) {
      calls++
      const cg = await opts.fetchCoingecko(chain, pool, POOL_HISTORY_REQUEST, side, before)
      const metaOk = !(cg.json as { meta?: unknown } | null)?.meta || coingeckoMetaTokenSide(cg.json, token) === side
      const out = cg.httpStatus != null && cg.httpStatus >= 200 && cg.httpStatus < 300 && metaOk ? window(cg.json, 'coingecko_onchain') : null
      if (out && out.ok && out.endReason === 'no_older_candles') cgEnd = out
      else if (out) return { result: out, providerCalls: calls }
    }
    if (calls >= POOL_HISTORY_MAX_PROVIDER_CALLS) return { result: cgEnd ?? historyFail('call_budget_exhausted'), providerCalls: calls }
    calls++
    const r = POOL_HISTORY_REQUEST
    const raw = await fetchJson(`${base}/api/v2/networks/${network}/pools/${pool}/ohlcv/${r.resolution}?aggregate=${r.aggregate}&limit=${r.limit}&currency=usd&token=${side}&before_timestamp=${before}`)
    if (raw.httpStatus === 429) return { result: historyFail('provider_rate_limited'), providerCalls: calls }
    if (raw.httpStatus == null || raw.httpStatus < 200 || raw.httpStatus >= 300) return { result: historyFail(raw.httpStatus === 404 ? 'pool_not_indexed' : 'provider_http_error'), providerCalls: calls }
    const out = window(raw.json, 'geckoterminal')
    return { result: out ?? cgEnd ?? historyFail('provider_schema_invalid'), providerCalls: calls }
  })()
  historyInFlight.set(key, work)
  try {
    const out = await work
    if (historyCache.size >= HISTORY_CACHE_MAX) historyCache.delete(historyCache.keys().next().value!)
    historyCache.set(key, { value: out.result, expiresAt: now() + (out.result.ok ? HISTORY_OK_TTL_MS : out.result.code === 'provider_rate_limited' ? RATE_LIMITED_TTL_MS : HISTORY_FAIL_TTL_MS) })
    return { result: checkClaim(out.result), providerCalls: out.providerCalls, cacheHit: false }
  } finally {
    historyInFlight.delete(key)
  }
}
