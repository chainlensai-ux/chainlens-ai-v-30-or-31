// lib/server/v4QuoteUsd.ts — independent historical USD evidence for a Uniswap V4 pool's OTHER asset
// when it is neither ETH/WETH nor a verified USD stablecoin (e.g. BANKAT / BNKR: BNKR/USD over time).
//
// ONE conversion hop only:  scannedTokenUsd(t) = scannedTokenPerQuote(t) × quoteUsd(t)
// where quoteUsd(t) comes from a DIFFERENT, ordinary (20-byte address) pool of the quote token paired
// directly with WETH or a verified USD stablecoin, read as that pool's own genuine historical USD
// candles (token side verified). Never the V4 pool being priced, never a pool that also contains the
// scanned token (its quote price would be derived from the scanned token itself), never a quote pool
// paired with some third token (no TOKEN -> A -> B -> USD chains), never a current price backfilled
// over history.
//
// Cost: 1 pool-discovery read (cached 24h per chain + quote token) + 1 historical candle read (cached
// per 10-minute slot per chain + quote token, shared across scans). Warm: 0 calls.
// On-demand chart history (resolveIndependentQuoteUsdWindow): the SAME discovery + one hourly candle
// read of that pool ending at the window's end (before_timestamp), cached per window.

import { EVM_POOL_ADDRESS_RE, classifyOhlcvResponse, coingeckoMetaTokenSide } from '../evmChartCandles.ts'

export const QUOTE_POOL_MIN_LIQUIDITY_USD = 25_000
export const QUOTE_SERIES_SLOT_SEC = 600
export const QUOTE_SERIES_REQUEST = { resolution: 'minute' as const, aggregate: 5, limit: 290 } // 24h10m of 5m candles (the V4 reader's 24h window)
/** On-demand history windows: hourly candles of the same independent pool, ending at the window's end. */
export const QUOTE_HISTORY_MAX_HOURS = 400
const DISCOVERY_TTL_MS = 24 * 3_600_000
const DISCOVERY_FAIL_TTL_MS = 10 * 60_000
const CACHE_MAX = 500

export type QuotePoolChoice = { pool: string; side: 'base' | 'quote'; pairedWith: string; quoteSymbol: string | null; quoteDecimals: number | null; liquidityUsd: number; dex?: string | null }

/** Why one returned pool was not used as the independent quote pool. */
export type QuotePoolRejection =
  | 'pool_id_invalid' // malformed / non-40-byte pool id, or id and address disagree
  | 'missing_token_ids' // the pool record carries no base/quote token ids
  | 'quote_token_not_in_pool' // neither side is the quote token
  | 'side_unresolved'
  | 'excluded_source_pool'
  | 'circular' // the other side is the scanned token
  | 'wrong_anchor' // paired with something other than the verified wrapped native / stables
  | 'liquidity_missing' // anchored, but the provider reported no reserve
  | 'thin_liquidity' // anchored, reserve below QUOTE_POOL_MIN_LIQUIDITY_USD
export type QuotePoolCandidate = { pool: string | null; dex: string | null; side: 'base' | 'quote' | null; pairedWith: string | null; liquidityUsd: number | null; rejected: QuotePoolRejection | null }
/** Debug view of one discovery read. */
export type QuoteDiscoveryDebug = {
  httpStatus: number | null; poolsReturned: number; anchoredFound: number; anchoredRejected: number; candidates: QuotePoolCandidate[]; selectedLiquidityUsd: number | null
  /** Best liquidity among anchored candidates, and whether the $25K floor was the ONLY reason none was used (product review; the floor is unchanged). */
  bestAnchoredLiquidityUsd?: number | null
  rejectedOnlyByLiquidityFloor?: boolean
}
/** Debug view of one quote-history read. */
export type QuoteHistoryDebug = { provider: string | null; httpStatus: number | null; rows: number; validRows: number; oldestSec: number | null; latestSec: number | null }

/** Exact, debug-facing reason the quote asset's USD history was not proven. */
export type QuoteUsdFailureReason =
  | 'quote_asset_unverified'
  | 'wrapped_native_unverified'
  | 'stable_asset_unverified'
  | 'quote_pool_not_found'
  | 'quote_pool_liquidity_too_low'
  | 'quote_history_unavailable'
  | 'quote_history_stale'
  | 'quote_usd_price_unproven'
/** Selection outcome when no pool qualified: none anchored, or anchored but thin. */
export type QuoteSelectionFailure = 'quote_pool_not_found' | 'quote_pool_liquidity_too_low' | 'quote_asset_unverified'

/** Maps a lane detail (unchanged strings) onto the exact debug reason. */
export function quoteUsdFailureReason(detail: string | null, selection: QuoteSelectionFailure | null = null): QuoteUsdFailureReason {
  if (selection) return selection
  if (!detail) return 'quote_usd_price_unproven'
  if (detail === 'no_quote_token_pool_found' || detail === 'no_independent_quote_pool_with_eth_or_stable_liquidity') return 'quote_pool_not_found'
  if (detail === 'quote_decimals_unavailable') return 'quote_asset_unverified'
  if (detail.startsWith('quote_series_') || detail.endsWith('_usd_series_unavailable') || detail.endsWith('_unavailable')) return 'quote_history_unavailable'
  if (detail.startsWith('no_quote_usd_point_within_')) return 'quote_history_stale'
  return 'quote_usd_price_unproven'
}

export type QuoteUsdResult = {
  ok: boolean
  reason: 'quote_usd_price_unproven' | 'call_budget_exhausted' | null
  /** Why the quote lane failed, in detail (for debug). */
  detail: string | null
  quoteSymbol: string | null
  /** From the provider's token record; null when it carries none (the V4 reader then reads decimals() on-chain). */
  quoteDecimals: number | null
  pool: string | null
  pairedWith: string | null
  /** The independent pool's dex id and the quote token's side in it (debug). */
  poolDex?: string | null
  poolSide?: 'base' | 'quote' | null
  /** Why no independent pool qualified (debug; null when one did or discovery never ran). */
  selectionFailure?: QuoteSelectionFailure | null
  discovery?: QuoteDiscoveryDebug | null
  history?: QuoteHistoryDebug | null
  points: Array<[number, number]>
  callsUsed: number
  cache: { discovery: boolean; series: boolean }
}

type PoolRead = { json: unknown; httpStatus: number | null; provider?: string | null }
export type QuoteUsdDeps = {
  /** GeckoTerminal-shaped `/networks/{net}/tokens/{token}/pools?include=base_token,quote_token`. */
  fetchTokenPools: (chain: string, token: string, timeoutMs: number) => Promise<{ json: unknown; httpStatus: number | null }>
  /** A pool's genuine historical USD candles for `side` (minute / 5 / 290). `provider` is for debug. */
  fetchPoolUsdOhlcv: (chain: string, pool: string, side: 'base' | 'quote', timeoutMs: number) => Promise<PoolRead>
  now?: () => number
}

export type QuoteUsdWindowDeps = {
  fetchTokenPools: QuoteUsdDeps['fetchTokenPools']
  /** A pool's genuine hourly USD candles for `side`, `limit` rows strictly before `beforeSec`. */
  fetchPoolUsdOhlcvBefore: (chain: string, pool: string, side: 'base' | 'quote', req: { resolution: 'hour'; aggregate: 1; limit: number }, beforeSec: number, timeoutMs: number) => Promise<PoolRead>
  now?: () => number
}

type Seen = { symbol: string | null; decimals: number | null }
const discoveryCache = new Map<string, { expiresAt: number; value: QuotePoolChoice | null; detail: string | null; failure: QuoteSelectionFailure | null; seen: Seen | null; debug: QuoteDiscoveryDebug }>()
const seriesCache = new Map<string, { slot: number; points: Array<[number, number]> | null; detail: string | null; debug: QuoteHistoryDebug }>()
const windowCache = new Map<string, { expiresAt: number; points: Array<[number, number]> | null; detail: string | null; debug: QuoteHistoryDebug }>()
const WINDOW_TTL_MS = 6 * 3_600_000
const WINDOW_FAIL_TTL_MS = 60_000
export function resetQuoteUsdCache() {
  discoveryCache.clear()
  seriesCache.clear()
  windowCache.clear()
}
const bounded = <K, V>(m: Map<K, V>) => { if (m.size >= CACHE_MAX) m.delete(m.keys().next().value!) }

/** The 20-byte address a provider id ends with ("<network>_0x…", any network slug incl. underscores), else null. */
export function providerIdAddress(id: unknown): string | null {
  const s = String(id ?? '').toLowerCase()
  const tail = s.includes('_') ? s.slice(s.lastIndexOf('_') + 1) : s
  return /^0x[a-f0-9]{40}$/.test(tail) ? tail : null
}

export type QuoteSelectionInput = {
  quoteToken: string
  scannedToken: string
  excludePool: string
  anchors: ReadonlySet<string>
  /** 'wrapped_native_first': a quote/wrapped-native pool beats a quote/stable pool regardless of liquidity. */
  anchorPriority?: 'liquidity' | 'wrapped_native_first'
  wrappedNative?: string | null
}

/**
 * Picks the ordinary pool that pairs `quoteToken` DIRECTLY with one of `anchors` (wrapped native /
 * verified USD stables) on a verified side, excluding the V4 pool being priced and any pool that
 * contains the scanned token; ranked by liquidity (or wrapped-native first when the chain asks for it).
 * Every returned pool is reported with its rejection reason. Pure — exported for tests.
 */
export function selectIndependentQuotePool(json: unknown, input: QuoteSelectionInput): { choice: QuotePoolChoice | null; detail: string | null; failure?: QuoteSelectionFailure | null; seen?: Seen; debug?: QuoteDiscoveryDebug } {
  const data = (json as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return { choice: null, detail: 'quote_pool_discovery_schema_invalid', failure: null }
  const included = (json as { included?: unknown } | null)?.included
  const tokenAttrs = new Map<string, Record<string, unknown>>()
  if (Array.isArray(included)) {
    for (const inc of included as Array<Record<string, unknown>>) {
      if (inc?.type !== 'token') continue
      const attrs = (inc.attributes ?? {}) as Record<string, unknown>
      const addr = providerIdAddress(inc.id) ?? providerIdAddress(attrs.address)
      if (addr) tokenAttrs.set(addr, attrs)
    }
  }
  const quote = input.quoteToken.toLowerCase()
  const scanned = input.scannedToken.toLowerCase()
  const exclude = input.excludePool.toLowerCase()
  const wrapped = input.wrappedNative?.toLowerCase() ?? null
  // The quote token's own record (same token in every pool): symbol + decimals, when the provider has them.
  const qAttrs = tokenAttrs.get(quote) ?? {}
  const dec = Number(qAttrs.decimals)
  const seen: Seen = { symbol: typeof qAttrs.symbol === 'string' ? qAttrs.symbol : null, decimals: qAttrs.decimals != null && Number.isInteger(dec) && dec >= 0 && dec <= 36 ? dec : null }
  const rank = (c: QuotePoolChoice) => (input.anchorPriority === 'wrapped_native_first' && wrapped && c.pairedWith === wrapped ? 1 : 0)
  const candidates: QuotePoolCandidate[] = []
  let best: QuotePoolChoice | null = null
  let sawAny = false
  let anchoredFound = 0
  let anchoredRejected = 0
  let bestAnchored: number | null = null
  for (const p of data as Array<Record<string, unknown>>) {
    const attrs = (p.attributes ?? {}) as Record<string, unknown>
    const rel = (p.relationships ?? {}) as Record<string, { data?: { id?: unknown } }>
    const dex = String(rel.dex?.data?.id ?? '') || null
    const rawAddress = typeof attrs.address === 'string' ? attrs.address.toLowerCase() : null
    const fromId = providerIdAddress(p.id)
    const liqRaw = Number(attrs.reserve_in_usd)
    const liq = attrs.reserve_in_usd != null && Number.isFinite(liqRaw) ? liqRaw : null
    const cand: QuotePoolCandidate = { pool: rawAddress, dex, side: null, pairedWith: null, liquidityUsd: liq, rejected: null }
    candidates.push(cand)
    // Ordinary 20-byte pool only, whose id and address agree (no pool-id / PoolManager ambiguity).
    if (!rawAddress || !EVM_POOL_ADDRESS_RE.test(rawAddress) || fromId !== rawAddress) { cand.rejected = 'pool_id_invalid'; continue }
    if (rawAddress === exclude) { cand.rejected = 'excluded_source_pool'; continue }
    const baseAddr = providerIdAddress(rel.base_token?.data?.id)
    const quoteAddr = providerIdAddress(rel.quote_token?.data?.id)
    if (!baseAddr || !quoteAddr) { cand.rejected = 'missing_token_ids'; continue }
    const side: 'base' | 'quote' | null = baseAddr === quote ? 'base' : quoteAddr === quote ? 'quote' : null
    if (!side) { cand.rejected = 'quote_token_not_in_pool'; continue }
    sawAny = true
    const other = side === 'base' ? quoteAddr : baseAddr
    cand.side = side
    cand.pairedWith = other
    if (other === scanned) { cand.rejected = 'circular'; continue }
    if (!input.anchors.has(other)) { cand.rejected = 'wrong_anchor'; continue }
    anchoredFound++
    if (liq != null) bestAnchored = Math.max(bestAnchored ?? 0, liq)
    if (liq == null) { cand.rejected = 'liquidity_missing'; anchoredRejected++; continue }
    if (liq < QUOTE_POOL_MIN_LIQUIDITY_USD) { cand.rejected = 'thin_liquidity'; anchoredRejected++; continue }
    const c: QuotePoolChoice = { pool: rawAddress, side, pairedWith: other, quoteSymbol: seen.symbol, quoteDecimals: seen.decimals, liquidityUsd: liq, ...(dex ? { dex } : {}) }
    if (!best || rank(c) > rank(best) || (rank(c) === rank(best) && liq > best.liquidityUsd)) best = c
  }
  const failure: QuoteSelectionFailure | null = best ? null : anchoredFound > 0 ? 'quote_pool_liquidity_too_low' : 'quote_pool_not_found'
  const debug: QuoteDiscoveryDebug = {
    httpStatus: null, poolsReturned: data.length, anchoredFound, anchoredRejected, candidates: candidates.slice(0, 20), selectedLiquidityUsd: best?.liquidityUsd ?? null,
    bestAnchoredLiquidityUsd: bestAnchored,
    rejectedOnlyByLiquidityFloor: !best && anchoredFound > 0 && candidates.every((c) => c.rejected !== 'liquidity_missing') && candidates.some((c) => c.rejected === 'thin_liquidity'),
  }
  return { choice: best, detail: best ? null : sawAny ? 'no_independent_quote_pool_with_eth_or_stable_liquidity' : 'no_quote_token_pool_found', failure, seen, debug }
}

/** Genuine historical USD points ([bucket end ms, close]) from a pool's candles, only if its meta (when present) agrees on the side. */
export function quoteSeriesFromCandles(json: unknown, httpStatus: number | null, quoteToken: string, side: 'base' | 'quote', intervalSec: number, provider: string | null = null): { points: Array<[number, number]> | null; detail: string | null; debug: QuoteHistoryDebug } {
  const { code, normalized } = classifyOhlcvResponse('pool', httpStatus, json)
  const list = (json as { data?: { attributes?: { ohlcv_list?: unknown } } } | null)?.data?.attributes?.ohlcv_list
  const debug: QuoteHistoryDebug = { provider, httpStatus, rows: Array.isArray(list) ? list.length : 0, validRows: 0, oldestSec: null, latestSec: null }
  if (code !== 'ok') return { points: null, detail: `quote_series_${code}`, debug }
  if ((json as { meta?: unknown } | null)?.meta && coingeckoMetaTokenSide(json, quoteToken) !== side) return { points: null, detail: 'quote_series_side_mismatch', debug }
  const times = normalized.points.map((p) => Date.parse(p.timestamp) / 1000)
  Object.assign(debug, { validRows: normalized.points.length, oldestSec: times.length ? Math.min(...times) : null, latestSec: times.length ? Math.max(...times) : null })
  return { points: normalized.points.map((p) => [Date.parse(p.timestamp) + intervalSec * 1000, p.close] as [number, number]), detail: null, debug }
}

export async function resolveIndependentQuoteUsd(
  input: DiscoveryInput & { budget: number; deadlineMs: number },
  deps: QuoteUsdDeps,
): Promise<QuoteUsdResult> {
  const now = deps.now ?? Date.now
  const quote = input.quoteToken.toLowerCase()
  const out: QuoteUsdResult = { ok: false, reason: 'quote_usd_price_unproven', detail: null, quoteSymbol: null, quoteDecimals: null, pool: null, pairedWith: null, points: [], callsUsed: 0, cache: { discovery: false, series: false } }
  const timeout = () => Math.max(1, input.deadlineMs - now())
  const canCall = () => out.callsUsed < input.budget && now() < input.deadlineMs

  // 1. Independent quote pool (cached 24h; a failed discovery is cached 10 min).
  const found = await discoverQuotePool(input, deps.fetchTokenPools, out, canCall, timeout, now)
  if (!found) return out.reason === 'call_budget_exhausted' ? out : { ...out, reason: 'quote_usd_price_unproven' }
  const choice = found
  Object.assign(out, { quoteSymbol: choice.quoteSymbol, quoteDecimals: choice.quoteDecimals, pool: choice.pool, pairedWith: choice.pairedWith, poolDex: choice.dex ?? null, poolSide: choice.side })

  // 2. That pool's genuine historical USD candles (one read per 10-minute slot, shared).
  const slot = Math.floor(now() / 1000 / QUOTE_SERIES_SLOT_SEC) * QUOTE_SERIES_SLOT_SEC
  const sKey = `${input.chain}:${quote}:${choice.pool}`
  const s = seriesCache.get(sKey)
  let points: Array<[number, number]> | null
  if (s && s.slot === slot) {
    out.cache.series = true
    points = s.points
    out.detail = s.detail
    out.history = s.debug
  } else {
    if (!canCall()) return { ...out, reason: 'call_budget_exhausted', detail: 'call_budget' }
    out.callsUsed++
    const res = await deps.fetchPoolUsdOhlcv(input.chain, choice.pool, choice.side, timeout())
    const series = quoteSeriesFromCandles(res.json, res.httpStatus, quote, choice.side, QUOTE_SERIES_REQUEST.aggregate * 60, res.provider ?? null)
    points = series.points
    out.detail = series.detail
    out.history = series.debug
    bounded(seriesCache)
    seriesCache.set(sKey, { slot, points, detail: series.detail, debug: series.debug })
  }
  if (!points || points.length < 2) return { ...out, detail: out.detail ?? 'quote_series_too_short' }
  return { ...out, ok: true, reason: null, detail: null, points }
}

type DiscoveryInput = { chain: string } & QuoteSelectionInput

/** Cached independent-pool discovery shared by the live and the windowed lanes. Mutates `out` (calls, cache, detail, reason). */
async function discoverQuotePool(
  input: DiscoveryInput,
  fetchTokenPools: QuoteUsdDeps['fetchTokenPools'],
  out: QuoteUsdResult,
  canCall: () => boolean,
  timeout: () => number,
  now: () => number,
): Promise<QuotePoolChoice | null> {
  const quote = input.quoteToken.toLowerCase()
  const dKey = `${input.chain}:${quote}:${input.scannedToken.toLowerCase()}:${input.excludePool.toLowerCase()}`
  const d = discoveryCache.get(dKey)
  if (d && d.expiresAt > now()) {
    out.cache.discovery = true
    out.discovery = d.debug
    if (!d.value) Object.assign(out, { detail: d.detail, selectionFailure: d.failure, quoteSymbol: d.seen?.symbol ?? null, quoteDecimals: d.seen?.decimals ?? null })
    return d.value
  }
  if (!canCall()) { out.reason = 'call_budget_exhausted'; out.detail = 'call_budget'; return null }
  out.callsUsed++
  const res = await fetchTokenPools(input.chain, quote, timeout())
  const ok = res.httpStatus != null && res.httpStatus >= 200 && res.httpStatus < 300
  const sel = ok
    ? selectIndependentQuotePool(res.json, { quoteToken: quote, scannedToken: input.scannedToken, excludePool: input.excludePool, anchors: input.anchors, anchorPriority: input.anchorPriority, wrappedNative: input.wrappedNative })
    : { choice: null, detail: `quote_pool_discovery_http_${res.httpStatus ?? 'error'}`, failure: null, seen: undefined, debug: undefined }
  const debug: QuoteDiscoveryDebug = { ...(sel.debug ?? { poolsReturned: 0, anchoredFound: 0, anchoredRejected: 0, candidates: [], selectedLiquidityUsd: null }), httpStatus: res.httpStatus }
  out.discovery = debug
  bounded(discoveryCache)
  discoveryCache.set(dKey, { expiresAt: now() + (sel.choice ? DISCOVERY_TTL_MS : DISCOVERY_FAIL_TTL_MS), value: sel.choice, detail: sel.detail, failure: sel.failure ?? null, seen: sel.seen ?? null, debug })
  if (!sel.choice) Object.assign(out, { detail: sel.detail, selectionFailure: sel.failure ?? null, quoteSymbol: sel.seen?.symbol ?? null, quoteDecimals: sel.seen?.decimals ?? null })
  return sel.choice
}

/**
 * On-demand chart history: the quote token's genuine USD history over [fromSec, toSec] from the SAME
 * independent pool (hourly candles ending at the window's end). Called only after the user asks for
 * older candles. Cost: discovery (usually cached) + 1 candle read per window (cached 6h).
 */
export async function resolveIndependentQuoteUsdWindow(
  input: DiscoveryInput & { fromSec: number; toSec: number; budget: number; deadlineMs: number },
  deps: QuoteUsdWindowDeps,
): Promise<QuoteUsdResult> {
  const now = deps.now ?? Date.now
  const out: QuoteUsdResult = { ok: false, reason: 'quote_usd_price_unproven', detail: null, quoteSymbol: null, quoteDecimals: null, pool: null, pairedWith: null, points: [], callsUsed: 0, cache: { discovery: false, series: false } }
  const timeout = () => Math.max(1, input.deadlineMs - now())
  const canCall = () => out.callsUsed < input.budget && now() < input.deadlineMs
  const choice = await discoverQuotePool(input, deps.fetchTokenPools, out, canCall, timeout, now)
  if (!choice) return out.reason === 'call_budget_exhausted' ? out : { ...out, reason: 'quote_usd_price_unproven' }
  Object.assign(out, { quoteSymbol: choice.quoteSymbol, quoteDecimals: choice.quoteDecimals, pool: choice.pool, pairedWith: choice.pairedWith, poolDex: choice.dex ?? null, poolSide: choice.side })

  const beforeSec = Math.ceil(input.toSec / 3600) * 3600
  const fromSec = Math.floor(input.fromSec / 3600) * 3600
  const limit = Math.min(QUOTE_HISTORY_MAX_HOURS, Math.max(2, (beforeSec - fromSec) / 3600 + 1))
  const wKey = `${input.chain}:${input.quoteToken.toLowerCase()}:${choice.pool}:${beforeSec}:${limit}`
  const w = windowCache.get(wKey)
  let points: Array<[number, number]> | null
  if (w && w.expiresAt > now()) {
    out.cache.series = true
    points = w.points
    out.detail = w.detail
    out.history = w.debug
  } else {
    if (!canCall()) return { ...out, reason: 'call_budget_exhausted', detail: 'call_budget' }
    out.callsUsed++
    const res = await deps.fetchPoolUsdOhlcvBefore(input.chain, choice.pool, choice.side, { resolution: 'hour', aggregate: 1, limit }, beforeSec, timeout())
    const series = quoteSeriesFromCandles(res.json, res.httpStatus, input.quoteToken.toLowerCase(), choice.side, 3600, res.provider ?? null)
    points = series.points
    out.detail = series.detail
    out.history = series.debug
    bounded(windowCache)
    windowCache.set(wKey, { expiresAt: now() + (points ? WINDOW_TTL_MS : WINDOW_FAIL_TTL_MS), points, detail: series.detail, debug: series.debug })
  }
  if (!points || points.length < 2) return { ...out, detail: out.detail ?? 'quote_series_too_short' }
  return { ...out, ok: true, reason: null, detail: null, points }
}
