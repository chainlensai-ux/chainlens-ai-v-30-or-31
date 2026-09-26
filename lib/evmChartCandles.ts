// lib/evmChartCandles.ts — pure candle logic for the EVM (ETH / Base / BNB / Robinhood) Token
// Scanner Price Chart. app/api/token/route.ts imports these; nothing here fetches.
//
// EVM CHART DEPTH + TOKEN SIDE, DISCLOSED (requested: "Make the new PriceChartPanel work properly
// for ALL EVM Token Scanner chains"). All four EVM chains share one GeckoTerminal candle pipeline
// (network ids eth / base / bsc / robinhood). Findings that shaped this module:
//
//  1. DEPTH. The first request was minute/15 x 96 (one day of 15m candles), then hour x 48, then
//     day x 7 — each tried only when the previous returned < 2 candles. 96 fifteen-minute candles
//     cannot produce a useful 4H or any 1D chart. Each rung of the SAME ladder now asks for more
//     rows from the SAME endpoint (15m x 672 = 7 days, 1h x 168 = 7 days, 1d x 30): zero extra
//     calls, same fallback order, same worst case. The rung's original window (96 / 48 / 7 rows) is
//     still what `priceChart` carries — GeckoTerminal returns the newest N buckets, so the last 96
//     of 672 are exactly what limit=96 returned — so every existing priceChart consumer (Base Radar's
//     timeline trend, the 150-point public cap, Clark) sees an unchanged series. The deeper series
//     is exposed separately as `chartCandles` for the Token Scanner panel only.
//
//  2. TOKEN SIDE. Pool OHLCV prices one side of the pool (`token=base|quote`). When the pool's
//     base/quote relationship ids did not identify the scanned token, the route tried `base` first
//     and accepted the first series with >= 2 candles — i.e. the PAIR token's price whenever the
//     scanned token was actually the quote side. An unproven side is now never guessed: that pool is
//     skipped (no HTTP call) and the chain falls through to token-level OHLCV, which is keyed by the
//     token address and therefore token-centric by construction.
//
//  3. NO REPAIRED ROWS. The previous normaliser substituted `close` for a missing/non-positive
//     open/high/low and widened high/low to cover open/close — inventing OHLC values the provider
//     never returned. Rows are now validated by the same normalizeChartCandles the chart itself
//     uses (lib/priceChartCandles.ts): an incomplete or inconsistent row is dropped, never repaired.
//
//  4. SWAP-REBUILT CANDLES. Trade reconstruction picked, per trade, whichever of several USD price
//     fields sat closest to the current price — so either side of the swap could win. A trade that
//     names its from/to token addresses now uses the price of the side that IS the scanned token;
//     a trade naming two other tokens is rejected. Bucket width stays data-dependent (span / 20),
//     so the chart keeps treating these as an irregular, non-standard interval.

import { normalizeChartCandles, type ChartCandleInput } from './priceChartCandles.ts'

export type EvmChartPoint = { timestamp: string; open: number; high: number; low: number; close: number; volume: number | null; priceUsd: number }

export type EvmChartRung = {
  /** Legacy priceChart.timeframe key — unchanged so existing consumers keep matching it. */
  key: '24h' | '48h' | '7d'
  resolution: 'minute' | 'hour' | 'day'
  aggregate: number
  /** Rows requested from the provider (one call). */
  requestLimit: number
  /** Rows the legacy `priceChart` window carries (the previous request limit). */
  windowLimit: number
  /** True candle width in seconds — what the chart rolls up from. */
  intervalSec: number
}

export const EVM_CHART_LADDER: ReadonlyArray<EvmChartRung> = [
  { key: '24h', resolution: 'minute', aggregate: 15, requestLimit: 672, windowLimit: 96, intervalSec: 900 },
  { key: '48h', resolution: 'hour', aggregate: 1, requestLimit: 168, windowLimit: 48, intervalSec: 3600 },
  { key: '7d', resolution: 'day', aggregate: 1, requestLimit: 30, windowLimit: 7, intervalSec: 86_400 },
]

/** GeckoTerminal network id per EVM chain key. */
export const EVM_CHART_NETWORK: Readonly<Record<string, string>> = { eth: 'eth', base: 'base', polygon: 'polygon_pos', bnb: 'bsc', robinhood: 'robinhood' }

export function incrementReason(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1
}

/**
 * GeckoTerminal ohlcv_list rows ([unix_sec, o, h, l, c, v], newest first) -> chronological points.
 * Rows missing or with a non-positive O/H/L/C, or whose body falls outside its own wick range, are
 * dropped — never repaired. Duplicate timestamps collapse to one row.
 */
export function normalizeGtOhlcvRows(list: unknown): { rawPointCount: number; validPointCount: number; rejectedReason?: string; points: EvmChartPoint[] } {
  if (!Array.isArray(list)) return { rawPointCount: 0, validPointCount: 0, rejectedReason: 'ohlcv_list_missing', points: [] }
  const inputs: ChartCandleInput[] = []
  for (const row of list) {
    if (!Array.isArray(row)) continue
    const ts = typeof row[0] === 'number' ? row[0] : typeof row[0] === 'string' && row[0].trim() !== '' ? Number(row[0]) : NaN
    if (!Number.isFinite(ts)) continue
    inputs.push({ timestamp: ts, open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5] })
  }
  const points: EvmChartPoint[] = normalizeChartCandles(inputs).map((c) => ({
    timestamp: new Date(c.t).toISOString(),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    priceUsd: c.close,
  }))
  const invalid = list.length - points.length
  return {
    rawPointCount: list.length,
    validPointCount: points.length,
    rejectedReason: points.length >= 2 ? undefined : (invalid > 0 ? 'invalid_or_non_positive_ohlcv_rows' : 'insufficient_points'),
    points,
  }
}

/** Legacy priceChart window (newest `windowLimit` rows) alongside the full real series. */
export function splitChartWindow<T>(points: ReadonlyArray<T>, windowLimit: number): { window: T[]; deep: T[] } {
  return { window: points.slice(-windowLimit), deep: [...points] }
}

/**
 * Which side of a GeckoTerminal pool the scanned token is on, from the pool's base_token /
 * quote_token relationship ids ("<network>_<address>"). EVM addresses are hex and case-insensitive,
 * so the comparison is lowercase. Null when the pool does not identify the token on either side —
 * callers must then NOT guess a side.
 */
export function resolveEvmPoolTokenSide(pool: Record<string, unknown>, tokenAddress: string, networkId: string): 'base' | 'quote' | null {
  const rel = (pool.relationships ?? {}) as Record<string, unknown>
  const baseData = ((rel.base_token as Record<string, unknown> | undefined)?.data) as Record<string, unknown> | undefined
  const quoteData = ((rel.quote_token as Record<string, unknown> | undefined)?.data) as Record<string, unknown> | undefined
  const baseId = String(baseData?.id ?? '').toLowerCase()
  const quoteId = String(quoteData?.id ?? '').toLowerCase()
  const tokenNorm = tokenAddress.toLowerCase()
  if (!tokenNorm) return null
  const expectedId = `${networkId}_${tokenNorm}`
  if (baseId === expectedId || baseId.endsWith(`_${tokenNorm}`)) return 'base'
  if (quoteId === expectedId || quoteId.endsWith(`_${tokenNorm}`)) return 'quote'
  return null
}

function toNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/**
 * USD price of the SCANNED token in one GeckoTerminal trade.
 *  - trade names from/to token addresses and one is the scanned token -> that side's USD price;
 *  - trade names addresses but neither is the scanned token -> rejected;
 *  - trade names no addresses (older/partial shape) -> legacy nearest-to-current-price pick,
 *    unchanged from the previous behaviour.
 */
export function pickTradePriceForToken(
  attrs: Record<string, unknown>,
  tokenAddress: string | null,
  currentPriceUsd: number | null,
): { price: number | null; reason?: string } {
  const fromAddr = typeof attrs.from_token_address === 'string' ? attrs.from_token_address.toLowerCase() : null
  const toAddr = typeof attrs.to_token_address === 'string' ? attrs.to_token_address.toLowerCase() : null
  const token = tokenAddress?.toLowerCase() ?? null
  if (token && (fromAddr || toAddr)) {
    const raw = fromAddr === token ? attrs.price_from_in_usd : toAddr === token ? attrs.price_to_in_usd : undefined
    if (raw === undefined) return { price: null, reason: 'trade_does_not_involve_scanned_token' }
    const price = toNum(raw)
    return price != null && price > 0 ? { price } : { price: null, reason: 'missing_positive_trade_price' }
  }
  const candidates = [
    toNum(attrs.price_in_usd),
    toNum(attrs.price_from_in_usd),
    toNum(attrs.price_to_in_usd),
    toNum(attrs.base_token_price_usd),
    toNum(attrs.quote_token_price_usd),
  ].filter((c): c is number => c != null && c > 0)
  if (candidates.length === 0) return { price: null, reason: 'missing_positive_trade_price' }
  if (currentPriceUsd == null || !(currentPriceUsd > 0)) return { price: candidates[0] }
  // Tiny tokens can vary by many orders across provider price fields, so prefer the nearest real
  // positive price instead of rejecting on a tight band.
  const eligible = candidates.filter((c) => c >= currentPriceUsd * 1e-9 && c <= currentPriceUsd * 1e9)
  if (eligible.length === 0) return { price: null, reason: 'trade_price_extreme_outlier' }
  return { price: eligible.reduce((best, c) => (Math.abs(Math.log(c / currentPriceUsd)) < Math.abs(Math.log(best / currentPriceUsd)) ? c : best), eligible[0]) }
}

// Reconstructs OHLCV candles from raw GeckoTerminal trade events — last-resort chart evidence.
// Only uses real trade prices of the scanned token — no generated or interpolated values.
// Requires >= 3 valid priced trades spanning >= 2 time buckets; returns empty candles otherwise.
// Bucket width is data-dependent (span / 20, min 1 minute), so these are never a standard interval.
export function reconstructCandlesFromTrades(
  trades: unknown[],
  currentPriceUsd: number | null,
  tokenAddress: string | null = null,
): { candles: EvmChartPoint[]; rawTradeCount: number; validTradePriceCount: number; rejectedTradeReasons: Record<string, number> } {
  const rejectedTradeReasons: Record<string, number> = {}
  if (!Array.isArray(trades) || trades.length < 3) {
    if (!Array.isArray(trades) || trades.length === 0) incrementReason(rejectedTradeReasons, 'no_trades_returned')
    else incrementReason(rejectedTradeReasons, 'fewer_than_three_trades')
    return { candles: [], rawTradeCount: Array.isArray(trades) ? trades.length : 0, validTradePriceCount: 0, rejectedTradeReasons }
  }
  type TradePoint = { tsMs: number; price: number; volUsd: number | null }
  const points: TradePoint[] = []
  for (const trade of trades) {
    const attrs = ((trade as Record<string, unknown>)?.attributes) as Record<string, unknown> | undefined
    if (!attrs) { incrementReason(rejectedTradeReasons, 'missing_trade_attributes'); continue }
    const tsRaw = attrs.block_timestamp ?? attrs.timestamp
    const tsMs: number | null = tsRaw == null ? null
      : typeof tsRaw === 'number' ? (tsRaw > 1e12 ? tsRaw : tsRaw * 1000)
      : !isNaN(Date.parse(String(tsRaw))) ? new Date(String(tsRaw)).getTime()
      : null
    if (!tsMs || isNaN(tsMs)) { incrementReason(rejectedTradeReasons, 'missing_trade_timestamp'); continue }
    const picked = pickTradePriceForToken(attrs, tokenAddress, currentPriceUsd)
    if (picked.price == null) { incrementReason(rejectedTradeReasons, picked.reason ?? 'missing_positive_trade_price'); continue }
    points.push({ tsMs, price: picked.price, volUsd: toNum(attrs.volume_in_usd) })
  }
  if (points.length < 3) {
    incrementReason(rejectedTradeReasons, 'fewer_than_three_valid_trade_prices')
    return { candles: [], rawTradeCount: trades.length, validTradePriceCount: points.length, rejectedTradeReasons }
  }
  points.sort((a, b) => a.tsMs - b.tsMs)
  const spanMs = points[points.length - 1].tsMs - points[0].tsMs
  if (spanMs < 60000) {
    incrementReason(rejectedTradeReasons, 'trade_span_under_one_minute')
    return { candles: [], rawTradeCount: trades.length, validTradePriceCount: points.length, rejectedTradeReasons }
  }
  const bucketMs = Math.max(60000, Math.ceil(spanMs / 20))
  const buckets = new Map<number, TradePoint[]>()
  for (const pt of points) {
    const key = Math.floor(pt.tsMs / bucketMs) * bucketMs
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(pt)
  }
  if (buckets.size < 2) {
    incrementReason(rejectedTradeReasons, 'fewer_than_two_trade_buckets')
    return { candles: [], rawTradeCount: trades.length, validTradePriceCount: points.length, rejectedTradeReasons }
  }
  const candles = Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([bucketStart, pts]) => {
      const prices = pts.map((p) => p.price)
      const volSum = pts.reduce((s, p) => s + (p.volUsd ?? 0), 0)
      return { timestamp: new Date(bucketStart).toISOString(), open: pts[0].price, high: Math.max(...prices), low: Math.min(...prices), close: pts[pts.length - 1].price, volume: volSum > 0 ? volSum : null, priceUsd: pts[pts.length - 1].price }
    })
  if (candles.length < 2) incrementReason(rejectedTradeReasons, 'fewer_than_two_reconstructed_candles')
  return { candles: candles.length >= 2 ? candles : [], rawTradeCount: trades.length, validTradePriceCount: points.length, rejectedTradeReasons }
}

// ── Candle ladder (phases 1-3 + swap fallback) with structured failure reasons ──────────────────
//
// CANDLE FALLBACK AUDIT, DISCLOSED (reported: EVM scans frequently fall back to "ESTIMATED TREND —
// Historical candles are not indexed yet"). Findings, from the route code plus the two published
// GeckoTerminal client SDKs (geckoterminal-api 0.9.0, geckoterminal-py 0.3.1 — live calls are not
// possible from the build sandbox):
//   - The public API exposes pool OHLCV only: /networks/{net}/pools/{pool}/ohlcv/{day|hour|minute},
//     minute aggregates 1/5/15, hour 1/4/12, day 1, limit <= 1000, token=base|quote.
//   - TOKEN-LEVEL OHLCV REMOVED. The old phase-2 request was
//     `${GECKO_BASE_URL ?? https://api.geckoterminal.com}/api/v2/networks/{net}/tokens/{addr}/ohlcv/...`
//     with only an Accept header. It cannot succeed in any configuration this code supports:
//     neither public GeckoTerminal SDK has a token-level OHLCV endpoint, and CoinGecko's paid token
//     OHLCV lives under a different path (/api/v3/onchain/...) and requires a pro API key this
//     request never sent; GECKO_BASE_URL is not documented anywhere in the repo, so production uses
//     the public host. It was up to 3 guaranteed misses (1 after the first-404 stop) against the
//     same rate-limited provider, and is no longer requested.
//   - 429 POLICY. One 429 means the shared provider is refusing this deployment right now. The
//     ladder records provider_rate_limited and makes NO further GeckoTerminal calls for the scan —
//     including the swap-rebuild step, which previously still fired up to 2 trades requests at the
//     same rate-limited provider. Only evidence that needs no further call (the route's
//     indexed-change estimated trend) may follow.
//   - The synthetic fallback used to set the failure reason to null, so the UI could only say "not
//     indexed yet" whatever happened. Every attempt records a structured code and the ladder returns
//     a summary that survives the synthetic fallback.

export type CandleFailureCode =
  | 'network_not_supported'
  | 'pool_not_indexed'
  | 'token_side_unresolved'
  | 'provider_rate_limited'
  | 'provider_http_error'
  | 'provider_empty'
  | 'provider_schema_invalid'
  | 'alternate_pool_failed'
  | 'swap_fallback_insufficient'
  | 'call_budget_exhausted'

export type CandleAttemptRoute = 'pool' | 'alternate_pool' | 'swaps'

export type CandleAttempt = {
  route: CandleAttemptRoute
  poolAddress: string | null
  side: 'base' | 'quote' | null
  timeframe: string | null
  httpStatus: number | null
  rows: number
  validRows: number
  code: CandleFailureCode | 'ok'
}

export type CandleFailureSummary = { code: CandleFailureCode; message: string; attempts: CandleAttempt[] }

const FAILURE_MESSAGES: Record<CandleFailureCode, string> = {
  network_not_supported: 'The candle provider does not index this network.',
  pool_not_indexed: 'No indexed trading pool with price history was found for this token.',
  token_side_unresolved: "The pool did not identify which side is this token, so its candles could not be attributed to it.",
  provider_rate_limited: 'The candle provider is rate-limiting requests right now. Try the scan again shortly.',
  provider_http_error: 'The candle provider did not respond successfully.',
  provider_empty: 'The pool returned no trading history yet.',
  provider_schema_invalid: 'The candle provider returned data in an unexpected format.',
  alternate_pool_failed: 'Neither the main pool nor the alternate pools returned price history.',
  swap_fallback_insufficient: 'Too few recent swaps to rebuild candles.',
  call_budget_exhausted: 'The candle request budget for this scan was used up before history was found.',
}

export function candleFailureMessage(code: CandleFailureCode): string {
  return FAILURE_MESSAGES[code]
}

/** Classifies one pool OHLCV response. */
export function classifyOhlcvResponse(route: 'pool', httpStatus: number | null, json: unknown): { code: CandleFailureCode | 'ok'; normalized: ReturnType<typeof normalizeGtOhlcvRows> } {
  const list = (json as { data?: { attributes?: { ohlcv_list?: unknown } } } | null)?.data?.attributes?.ohlcv_list
  const normalized = normalizeGtOhlcvRows(list)
  if (httpStatus === 429) return { code: 'provider_rate_limited', normalized }
  if (httpStatus === 404) return { code: route === 'pool' ? 'pool_not_indexed' : 'provider_http_error', normalized }
  if (httpStatus == null || httpStatus < 200 || httpStatus >= 300) return { code: 'provider_http_error', normalized }
  if (!Array.isArray(list)) return { code: 'provider_schema_invalid', normalized }
  if (normalized.points.length < 2) return { code: 'provider_empty', normalized }
  return { code: 'ok', normalized }
}

// Most specific/actionable first. A rate limit explains everything after it; an unresolved side
// explains why the main pool was never asked.
const FAILURE_PRIORITY: CandleFailureCode[] = [
  'network_not_supported',
  'provider_rate_limited',
  'token_side_unresolved',
  'pool_not_indexed',
  'provider_http_error',
  'provider_schema_invalid',
  'provider_empty',
  'call_budget_exhausted',
  'alternate_pool_failed',
  'swap_fallback_insufficient',
]

/** Picks the headline reason from the genuine routes tried (pool/alternate pool attempts outrank swap ones). */
export function summarizeCandleFailure(attempts: ReadonlyArray<CandleAttempt>, noPools: boolean, budgetExhausted = false): CandleFailureSummary {
  const codes = new Set<CandleFailureCode>()
  for (const a of attempts) if (a.code !== 'ok') codes.add(a.code)
  if (budgetExhausted) codes.add('call_budget_exhausted')
  let code: CandleFailureCode
  if (noPools && !codes.has('provider_rate_limited') && !codes.has('network_not_supported')) code = 'pool_not_indexed'
  else code = FAILURE_PRIORITY.find((c) => codes.has(c)) ?? 'provider_empty'
  return { code, message: FAILURE_MESSAGES[code], attempts: [...attempts] }
}

export type LadderPool = { poolId: string; address: string; name: string | null; liquidityUsd: number | null; pool: Record<string, unknown> }
export type LadderFetchResult = { json: unknown; httpStatus: number | null }
export type LadderDeps = {
  fetchPoolOhlcv: (poolAddress: string, rung: EvmChartRung, side: 'base' | 'quote') => Promise<LadderFetchResult>
  fetchTrades: (poolAddress: string) => Promise<LadderFetchResult>
}
export type LadderPriceChart = { timeframe: EvmChartRung['key']; points: EvmChartPoint[]; sourceStatus: 'ok' }

export type LadderResult = {
  priceChart: LadderPriceChart | null
  /** poolAddress/tokenSide are set only for pool OHLCV — the proven source the on-demand 5M read reuses. */
  chartCandles: { intervalSec: number; points: EvmChartPoint[]; poolAddress?: string; tokenSide?: 'base' | 'quote' } | null
  selectedPool: { address: string; name: string | null } | null
  /** Always false — token-level OHLCV is no longer requested (kept for the route's diagnostics shape). */
  usedTokenLevel: boolean
  usedTradeReconstruction: boolean
  reconstructedCandleCount: number
  /** Always false — see usedTokenLevel. */
  tokenLevelAttempted: boolean
  tradeReconstructionAttempted: boolean
  poolOhlcvAttempts: Array<{ poolId: string; poolAddress: string; tokenPosition: 'base' | 'quote'; timeframe: string; httpStatus?: number; rawPointCount: number; validPointCount: number; rejectedReason?: string }>
  tokenOhlcvAttempts: Array<{ timeframe: string; httpStatus?: number; rawPointCount: number; validPointCount: number; rejectedReason?: string }>
  attemptedTimeframes: string[]
  attemptedPools: Array<{ address: string; name: string | null; liquidityUsd: number | null }>
  tradePoolsAttempted: string[]
  rejectedTradeReasons: Record<string, number>
  rawTradeCount: number
  validTradePriceCount: number
  totalHttpCalls: number
  rateLimited: boolean
  rateLimitedAt: string | null
  skippedDueToRateLimit: number
  /** Legacy free-text reason (route diagnostics). */
  failureReason: string | null
  /** Structured result for the UI; null when real candles were found. */
  candleFailure: CandleFailureSummary | null
  attempts: CandleAttempt[]
}

/**
 * Hard cap on ALL GeckoTerminal candle-path calls per scan — pool OHLCV and swap (trades) reads
 * together. The ladder's own worst case is 7 (3 primary rungs + 2 alternate pools + 2 trades reads),
 * so the cap is never the binding limit; it guards future changes.
 */
export const EVM_MAX_OHLCV_CALLS = 10

/**
 * The EVM chart ladder: primary pool (15m -> 1h -> 1d), up to two alternate pools (15m), then
 * swap-rebuilt candles from up to two pools. Each step runs only if the previous ones found
 * nothing; pool candles are requested only for a side proven by the pool's own base/quote ids; a
 * 429 ends every further GeckoTerminal call for the scan (swap reads included).
 */
export async function runEvmCandleLadder(input: {
  pools: ReadonlyArray<LadderPool>
  contract: string
  networkId: string | null
  currentPriceUsd: number | null
  maxOhlcvCalls?: number
}, deps: LadderDeps): Promise<LadderResult> {
  const maxCalls = input.maxOhlcvCalls ?? EVM_MAX_OHLCV_CALLS
  const r: LadderResult = {
    priceChart: null, chartCandles: null, selectedPool: null, usedTokenLevel: false, usedTradeReconstruction: false,
    reconstructedCandleCount: 0, tokenLevelAttempted: false, tradeReconstructionAttempted: false, poolOhlcvAttempts: [],
    tokenOhlcvAttempts: [], attemptedTimeframes: [], attemptedPools: [], tradePoolsAttempted: [], rejectedTradeReasons: {},
    rawTradeCount: 0, validTradePriceCount: 0, totalHttpCalls: 0, rateLimited: false, rateLimitedAt: null,
    skippedDueToRateLimit: 0, failureReason: null, candleFailure: null, attempts: [],
  }
  if (!input.networkId) {
    r.failureReason = 'network_not_supported'
    r.candleFailure = { code: 'network_not_supported', message: FAILURE_MESSAGES.network_not_supported, attempts: [] }
    return r
  }
  const networkId = input.networkId
  let budgetExhausted = false
  const accept = (rung: EvmChartRung, points: EvmChartPoint[]) => {
    const { window, deep } = splitChartWindow(points, rung.windowLimit)
    r.priceChart = { timeframe: rung.key, points: window, sourceStatus: 'ok' }
    r.chartCandles = { intervalSec: rung.intervalSec, points: deep }
  }
  const canCall = () => {
    if (r.rateLimited) { r.skippedDueToRateLimit++; return false }
    if (r.totalHttpCalls >= maxCalls) { r.skippedDueToRateLimit++; budgetExhausted = true; return false }
    return true
  }
  const tryPool = async (pool: LadderPool, rungs: ReadonlyArray<EvmChartRung>, route: 'pool' | 'alternate_pool'): Promise<boolean> => {
    r.attemptedPools.push({ address: pool.address, name: pool.name, liquidityUsd: pool.liquidityUsd })
    const side = resolveEvmPoolTokenSide(pool.pool, input.contract, networkId)
    if (!side) {
      r.poolOhlcvAttempts.push({ poolId: pool.poolId, poolAddress: pool.address, tokenPosition: 'base', timeframe: 'none', rawPointCount: 0, validPointCount: 0, rejectedReason: 'token_side_unresolved' })
      r.attempts.push({ route, poolAddress: pool.address, side: null, timeframe: null, httpStatus: null, rows: 0, validRows: 0, code: 'token_side_unresolved' })
      r.failureReason = 'token_side_unresolved'
      return false
    }
    for (const rung of rungs) {
      if (!canCall()) return false
      r.attemptedTimeframes.push(`${rung.key}:${rung.resolution}/${rung.aggregate}x${rung.requestLimit}:${side}`)
      r.totalHttpCalls++
      const raw = await deps.fetchPoolOhlcv(pool.address, rung, side)
      const { code, normalized } = classifyOhlcvResponse('pool', raw.httpStatus, raw.json)
      r.attempts.push({ route, poolAddress: pool.address, side, timeframe: rung.key, httpStatus: raw.httpStatus, rows: normalized.rawPointCount, validRows: normalized.validPointCount, code })
      if (code === 'provider_rate_limited') {
        r.rateLimited = true
        r.rateLimitedAt = rung.key
        r.poolOhlcvAttempts.push({ poolId: pool.poolId, poolAddress: pool.address, tokenPosition: side, timeframe: rung.key, httpStatus: 429, rawPointCount: 0, validPointCount: 0, rejectedReason: 'rate_limited' })
        return false
      }
      r.poolOhlcvAttempts.push({ poolId: pool.poolId, poolAddress: pool.address, tokenPosition: side, timeframe: rung.key, ...(raw.httpStatus != null ? { httpStatus: raw.httpStatus } : {}), rawPointCount: normalized.rawPointCount, validPointCount: normalized.validPointCount, ...(normalized.rejectedReason ? { rejectedReason: normalized.rejectedReason } : {}) })
      if (code === 'ok') {
        accept(rung, normalized.points)
        r.chartCandles = { ...r.chartCandles!, poolAddress: pool.address, tokenSide: side }
        r.selectedPool = { address: pool.address, name: pool.name }
        r.failureReason = null
        return true
      }
      r.failureReason = normalized.rejectedReason ?? 'insufficient_points'
    }
    return false
  }

  // Phase 1: primary pool, full ladder.
  if (input.pools.length === 0) r.failureReason = 'primary_pool_missing'
  else if (await tryPool(input.pools[0], EVM_CHART_LADDER, 'pool')) return r

  // Phase 3: up to two alternate pools, 15m rung only.
  if (!r.rateLimited && input.pools.length > 1) {
    let anyAlternateTried = false
    for (const pool of input.pools.slice(1, 3)) {
      if (!canCall()) break
      anyAlternateTried = true
      if (await tryPool(pool, [EVM_CHART_LADDER[0]], 'alternate_pool')) return r
      if (r.rateLimited) break
    }
    if (anyAlternateTried) r.attempts.push({ route: 'alternate_pool', poolAddress: null, side: null, timeframe: null, httpStatus: null, rows: 0, validRows: 0, code: 'alternate_pool_failed' })
  }

  // Phase 5: swap-rebuilt candles from up to two pools (irregular bucket width). Same provider as
  // the OHLCV reads, so it is skipped entirely once that provider has returned 429, and each read
  // counts against the same hard cap.
  if (!r.rateLimited) r.tradeReconstructionAttempted = true
  for (const pool of input.pools.slice(0, 2)) {
    if (!canCall()) break
    r.attemptedTimeframes.push(`trade_recon:${pool.address.slice(0, 10)}`)
    r.tradePoolsAttempted.push(pool.address)
    r.totalHttpCalls++
    const raw = await deps.fetchTrades(pool.address)
    if (raw.httpStatus === 429) {
      r.rateLimited = true
      r.rateLimitedAt = 'trades'
      r.attempts.push({ route: 'swaps', poolAddress: pool.address, side: null, timeframe: null, httpStatus: 429, rows: 0, validRows: 0, code: 'provider_rate_limited' })
      break
    }
    const trades: unknown[] = Array.isArray((raw.json as { data?: unknown } | null)?.data) ? (raw.json as { data: unknown[] }).data : []
    const rebuilt = reconstructCandlesFromTrades(trades, input.currentPriceUsd, input.contract)
    r.rawTradeCount = Math.max(r.rawTradeCount, rebuilt.rawTradeCount)
    r.validTradePriceCount = Math.max(r.validTradePriceCount, rebuilt.validTradePriceCount)
    for (const [reason, count] of Object.entries(rebuilt.rejectedTradeReasons)) r.rejectedTradeReasons[reason] = (r.rejectedTradeReasons[reason] ?? 0) + count
    const code: CandleFailureCode | 'ok' = rebuilt.candles.length >= 2 ? 'ok' : 'swap_fallback_insufficient'
    r.attempts.push({ route: 'swaps', poolAddress: pool.address, side: null, timeframe: null, httpStatus: raw.httpStatus, rows: rebuilt.rawTradeCount, validRows: rebuilt.validTradePriceCount, code })
    if (rebuilt.candles.length >= 2) {
      r.reconstructedCandleCount = rebuilt.candles.length
      r.priceChart = { timeframe: '24h', points: rebuilt.candles, sourceStatus: 'ok' }
      r.chartCandles = null
      r.usedTradeReconstruction = true
      r.failureReason = null
      // Real prices, but not indexed OHLCV — the UI still says why indexed candles were missing.
      r.candleFailure = summarizeCandleFailure(r.attempts.filter((a) => a.route !== 'swaps'), input.pools.length === 0, budgetExhausted)
      return r
    }
  }
  if (!r.usedTradeReconstruction) r.failureReason = r.failureReason ?? 'trade_reconstruction_insufficient'
  r.candleFailure = summarizeCandleFailure(r.attempts, input.pools.length === 0, budgetExhausted)
  return r
}
