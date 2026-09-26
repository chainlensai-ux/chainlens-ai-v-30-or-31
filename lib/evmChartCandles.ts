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

/**
 * CoinGecko on-chain (/api/v3/onchain/networks/{network}/...) network id per EVM chain key. The
 * on-chain API serves GeckoTerminal's index, and eth / base / bsc are CoinGecko's documented ids.
 * Robinhood is deliberately absent: GeckoTerminal's 'robinhood' slug is confirmed live, but nothing
 * verifies it on CoinGecko's on-chain API, so Robinhood keeps GeckoTerminal as its primary until
 * /api/debug/coingecko-onchain-probe?network=robinhood proves otherwise.
 */
export const COINGECKO_ONCHAIN_NETWORK: Readonly<Record<string, string>> = { eth: 'eth', base: 'base', bnb: 'bsc' }

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
  | 'token_identity_unverified'
  | 'provider_rate_limited'
  | 'provider_http_error'
  | 'provider_empty'
  | 'provider_schema_invalid'
  | 'alternate_pool_failed'
  | 'swap_fallback_insufficient'
  | 'call_budget_exhausted'

/** 'coingecko_pool' is the CoinGecko on-chain read; every other route is GeckoTerminal. */
export type CandleAttemptRoute = 'coingecko_pool' | 'pool' | 'alternate_pool' | 'swaps'
export type CandleProvider = 'coingecko_onchain' | 'geckoterminal'

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
  token_identity_unverified: "The returned price history could not be proven to belong to this token, so it was not used.",
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
  'token_identity_unverified',
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
  /** CoinGecko on-chain pool OHLCV; `token` is 'base' | 'quote' | the scanned token's address. */
  fetchCoingeckoPoolOhlcv?: (poolAddress: string, rung: EvmChartRung, token: string) => Promise<LadderFetchResult>
}

/**
 * Which side of the pool a CoinGecko on-chain OHLCV response's `meta` names the scanned token as
 * (meta.base.address / meta.quote.address). Null when meta is absent or names neither side.
 */
export function coingeckoMetaTokenSide(json: unknown, tokenAddress: string): 'base' | 'quote' | null {
  const meta = (json as { meta?: { base?: { address?: unknown }; quote?: { address?: unknown } } } | null)?.meta
  const token = tokenAddress.toLowerCase()
  if (!token || !meta) return null
  if (typeof meta.base?.address === 'string' && meta.base.address.toLowerCase() === token) return 'base'
  if (typeof meta.quote?.address === 'string' && meta.quote.address.toLowerCase() === token) return 'quote'
  return null
}

/** Latest real close within 3x either way of the scan's live price — rules out the pair token's series. */
export function closeMatchesLivePrice(points: ReadonlyArray<EvmChartPoint>, livePriceUsd: number | null): boolean {
  const last = points[points.length - 1]?.close
  if (last == null || !(last > 0) || livePriceUsd == null || !(livePriceUsd > 0)) return false
  const ratio = last / livePriceUsd
  return ratio >= 1 / 3 && ratio <= 3
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
  /** GeckoTerminal returned 429 (ends every further GeckoTerminal call for the scan). */
  rateLimited: boolean
  rateLimitedAt: string | null
  /** CoinGecko returned 429 (the ladder then fell back to GeckoTerminal). */
  coingeckoRateLimited: boolean
  coingeckoAttempted: boolean
  /** Which provider's pool OHLCV is on screen; null for swap-rebuilt or no candles. */
  candleProvider: CandleProvider | null
  skippedDueToRateLimit: number
  /** Legacy free-text reason (route diagnostics). */
  failureReason: string | null
  /** Structured result for the UI; null when real candles were found. */
  candleFailure: CandleFailureSummary | null
  attempts: CandleAttempt[]
}

/**
 * Hard cap on ALL candle-path provider calls per scan — CoinGecko, GeckoTerminal pool OHLCV and swap
 * (trades) reads together. The ladder's own worst case is 8 (1 CoinGecko + 3 primary rungs + 2
 * alternate pools + 2 trades reads), so the cap is never the binding limit; it guards future changes.
 */
export const EVM_MAX_OHLCV_CALLS = 10

/**
 * The EVM chart ladder:
 *   0. CoinGecko on-chain pool OHLCV, primary pool, 15m x 672 — ONE call. Real rows for a proven
 *      token => done; GeckoTerminal is never called.
 *   1. GeckoTerminal primary pool (15m -> 1h -> 1d)
 *   2. up to two alternate pools (GeckoTerminal 15m)
 *   3. swap-rebuilt candles from up to two pools
 * (The route's estimated trend follows only when this returns no chart.) Each step runs only if the
 * previous ones found nothing. A CoinGecko failure of any kind, 429 included, falls through once to
 * GeckoTerminal and CoinGecko is not retried; a GeckoTerminal 429 ends every further GeckoTerminal
 * call for the scan (swap reads included).
 *
 * TOKEN IDENTITY. GeckoTerminal pool candles are requested only for a side proven by the pool's own
 * base/quote ids. CoinGecko is asked for that same proven side (token=base|quote — the semantics
 * already verified for this index). When the pool doesn't prove a side, CoinGecko is asked by the
 * scanned token's own address instead, and the series is used only when the response's meta names
 * the token on one side AND the latest close sits within 3x of the scan's live price; otherwise it
 * is rejected as token_identity_unverified, so a WETH/WBNB/USDC series can never pass as the token.
 */
export async function runEvmCandleLadder(input: {
  pools: ReadonlyArray<LadderPool>
  contract: string
  networkId: string | null
  /** CoinGecko on-chain network id; null skips CoinGecko (unsupported chain or no key). */
  coingeckoNetworkId?: string | null
  currentPriceUsd: number | null
  maxOhlcvCalls?: number
}, deps: LadderDeps): Promise<LadderResult> {
  const maxCalls = input.maxOhlcvCalls ?? EVM_MAX_OHLCV_CALLS
  const r: LadderResult = {
    priceChart: null, chartCandles: null, selectedPool: null, usedTokenLevel: false, usedTradeReconstruction: false,
    reconstructedCandleCount: 0, tokenLevelAttempted: false, tradeReconstructionAttempted: false, poolOhlcvAttempts: [],
    tokenOhlcvAttempts: [], attemptedTimeframes: [], attemptedPools: [], tradePoolsAttempted: [], rejectedTradeReasons: {},
    rawTradeCount: 0, validTradePriceCount: 0, totalHttpCalls: 0, rateLimited: false, rateLimitedAt: null,
    coingeckoRateLimited: false, coingeckoAttempted: false, candleProvider: null,
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
        r.candleProvider = 'geckoterminal'
        r.failureReason = null
        return true
      }
      r.failureReason = normalized.rejectedReason ?? 'insufficient_points'
    }
    return false
  }

  // Phase 0: CoinGecko on-chain, primary pool, 15m rung — one call.
  const cgPool = input.pools[0]
  if (deps.fetchCoingeckoPoolOhlcv && input.coingeckoNetworkId && cgPool && canCall()) {
    const rung = EVM_CHART_LADDER[0]
    const provenSide = resolveEvmPoolTokenSide(cgPool.pool, input.contract, networkId)
    const tokenParam = provenSide ?? input.contract.toLowerCase()
    r.coingeckoAttempted = true
    r.attemptedTimeframes.push(`coingecko:${rung.key}:${rung.resolution}/${rung.aggregate}x${rung.requestLimit}:${provenSide ?? 'address'}`)
    r.totalHttpCalls++
    const raw = await deps.fetchCoingeckoPoolOhlcv(cgPool.address, rung, tokenParam)
    const classified = classifyOhlcvResponse('pool', raw.httpStatus, raw.json)
    let code: CandleFailureCode | 'ok' = classified.code
    let side: 'base' | 'quote' | null = provenSide
    if (code === 'ok' && !provenSide) {
      const metaSide = coingeckoMetaTokenSide(raw.json, input.contract)
      if (metaSide && closeMatchesLivePrice(classified.normalized.points, input.currentPriceUsd)) side = metaSide
      else code = 'token_identity_unverified'
    }
    r.attempts.push({ route: 'coingecko_pool', poolAddress: cgPool.address, side, timeframe: rung.key, httpStatus: raw.httpStatus, rows: classified.normalized.rawPointCount, validRows: classified.normalized.validPointCount, code })
    if (code === 'provider_rate_limited') r.coingeckoRateLimited = true
    if (code === 'ok' && side) {
      accept(rung, classified.normalized.points)
      r.chartCandles = { ...r.chartCandles!, poolAddress: cgPool.address, tokenSide: side }
      r.selectedPool = { address: cgPool.address, name: cgPool.name }
      r.candleProvider = 'coingecko_onchain'
      r.failureReason = null
      return r
    }
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

// ── TEMPORARY candle-resolution diagnostics (admin/debug only) ──────────────────────────────────
//
// CHART DEBUG PANEL, DISCLOSED (requested: see why an EVM scan fell back to the estimated trend,
// directly from a normal Token Scanner scan, without a standalone debug route). This is a pure,
// presentational re-shaping of data the ladder already produced (LadderResult.attempts) — it makes
// ZERO provider calls and changes no candle-routing/selection behaviour. The caller
// (app/api/token/route.ts) builds this ONLY when the request is both authorized and asked for it,
// and never includes API keys, secrets, auth headers, or raw provider response bodies — the inputs
// below don't carry any of those, so there is nothing to redact.

export type ChartDebugStage =
  | 'coingecko_15m'
  | 'primary_pool_15m'
  | 'primary_pool_1h'
  | 'primary_pool_1d'
  | 'alternate_pool'
  | 'swap_rebuild'
  | 'estimated_trend'

export type ChartDebugProvider = CandleProvider | null

export type ChartDebugAttempt = {
  stage: ChartDebugStage
  /** Which provider this stage calls; null for the no-call estimated trend. */
  provider: ChartDebugProvider
  pool: string | null
  /** Human interval label ('15m' | '1h' | '1d'), or null for stages with no single interval. */
  interval: string | null
  status: 'ok' | CandleFailureCode | 'skipped'
  httpStatus: number | null
  rowsReturned: number
  /** Plain-language reason; null for 'ok' and 'skipped'. */
  reason: string | null
}

export type ChartDebugFinalSource = 'coingecko_onchain' | 'geckoterminal' | 'swap_rebuilt' | 'estimated_trend' | 'none'

export type ChartDebugInfo = {
  chain: string
  network: string | null
  /** CoinGecko on-chain network id, or null when this chain isn't routed to CoinGecko. */
  coingeckoNetwork: string | null
  scannedToken: string
  selectedPool: string | null
  tokenSide: 'base' | 'quote' | null
  requestedInterval: string | null
  requestedLimit: number | null
  /** The existing internal chartSource label (pool_ohlcv / trade_reconstructed / synthetic_*), for
   * cross-referencing with the rest of the scan response. */
  source: string | null
  attempts: ChartDebugAttempt[]
  rateLimited: boolean
  rateLimitedProvider: 'coingecko_onchain' | 'geckoterminal' | 'both' | null
  /** Which provider/route produced what's on screen. */
  finalSource: ChartDebugFinalSource
  /** Which stage produced it. */
  finalStage: ChartDebugStage | 'none'
  finalCandleCount: number
  /** The structured CandleFailureCode behind the fallback; null when real pool OHLCV was used. */
  fallbackReason: CandleFailureCode | null
}

const STAGE_INTERVAL: Record<ChartDebugStage, string | null> = {
  coingecko_15m: '15m',
  primary_pool_15m: '15m',
  primary_pool_1h: '1h',
  primary_pool_1d: '1d',
  alternate_pool: '15m',
  swap_rebuild: null,
  estimated_trend: null,
}

const STAGE_PROVIDER: Record<ChartDebugStage, ChartDebugProvider> = {
  coingecko_15m: 'coingecko_onchain',
  primary_pool_15m: 'geckoterminal',
  primary_pool_1h: 'geckoterminal',
  primary_pool_1d: 'geckoterminal',
  alternate_pool: 'geckoterminal',
  swap_rebuild: 'geckoterminal',
  estimated_trend: null,
}

const ALL_STAGES: ChartDebugStage[] = ['coingecko_15m', 'primary_pool_15m', 'primary_pool_1h', 'primary_pool_1d', 'alternate_pool', 'swap_rebuild', 'estimated_trend']

function stageForAttempt(a: CandleAttempt): ChartDebugStage | null {
  if (a.route === 'coingecko_pool') return 'coingecko_15m'
  if (a.route === 'alternate_pool') return 'alternate_pool'
  if (a.route === 'swaps') return 'swap_rebuild'
  if (a.route === 'pool') {
    if (a.timeframe === '24h') return 'primary_pool_15m'
    if (a.timeframe === '48h') return 'primary_pool_1h'
    if (a.timeframe === '7d') return 'primary_pool_1d'
  }
  return null
}

function finalSourceForStage(stage: ChartDebugStage | 'none'): ChartDebugFinalSource {
  if (stage === 'none') return 'none'
  if (stage === 'estimated_trend') return 'estimated_trend'
  if (stage === 'swap_rebuild') return 'swap_rebuilt'
  return STAGE_PROVIDER[stage] ?? 'none'
}

/**
 * Builds the (debug-only) candle-resolution trail from data the ladder already produced. Every
 * stage always appears exactly once, in order, marked 'skipped' if the ladder never reached it
 * (e.g. everything after CoinGecko succeeded, or every GeckoTerminal call after its 429) — never
 * inventing rows or reasons. Where a stage ran more than once (two alternate pools, two swap
 * reads), the successful run is shown, else the last one.
 */
export function buildEvmChartDebugInfo(input: {
  chain: string
  network: string | null
  coingeckoNetwork?: string | null
  scannedToken: string
  /** Every attempt the ladder made (LadderResult.attempts), success or failure. */
  attempts: ReadonlyArray<CandleAttempt>
  candleFailure: CandleFailureSummary | null
  selectedPoolAddress: string | null
  tokenSide: 'base' | 'quote' | null
  rateLimited: boolean
  coingeckoRateLimited?: boolean
  usedEstimatedTrend: boolean
  /** The existing chartSource / chartReason / final rendered candle count. */
  source: string | null
  finalCandleCount: number
}): ChartDebugInfo {
  const byStage = new Map<ChartDebugStage, ChartDebugAttempt>()
  for (const a of input.attempts) {
    const stage = stageForAttempt(a)
    if (!stage) continue
    if (a.poolAddress == null && a.code === 'alternate_pool_failed') continue // the ladder's own summary marker row
    const prev = byStage.get(stage)
    if (prev?.status === 'ok') continue
    byStage.set(stage, {
      stage,
      provider: STAGE_PROVIDER[stage],
      pool: a.poolAddress,
      interval: STAGE_INTERVAL[stage],
      status: a.code,
      httpStatus: a.httpStatus,
      rowsReturned: a.validRows,
      reason: a.code === 'ok' ? null : candleFailureMessage(a.code),
    })
  }
  let finalStage: ChartDebugStage | 'none' = 'none'
  const attempts: ChartDebugAttempt[] = ALL_STAGES.map((stage) => {
    if (stage === 'estimated_trend') {
      if (input.usedEstimatedTrend) {
        finalStage = stage
        return { stage, provider: null, pool: null, interval: null, status: 'ok', httpStatus: null, rowsReturned: input.finalCandleCount, reason: input.candleFailure ? candleFailureMessage(input.candleFailure.code) : null }
      }
      return { stage, provider: null, pool: null, interval: null, status: 'skipped', httpStatus: null, rowsReturned: 0, reason: null }
    }
    const found = byStage.get(stage)
    if (found) {
      if (found.status === 'ok' && finalStage === 'none') finalStage = stage
      return found
    }
    return { stage, provider: STAGE_PROVIDER[stage], pool: null, interval: STAGE_INTERVAL[stage], status: 'skipped', httpStatus: null, rowsReturned: 0, reason: null }
  })
  const primaryRung = EVM_CHART_LADDER[0]
  const cgLimited = input.coingeckoRateLimited === true
  const rateLimitedProvider = cgLimited && input.rateLimited ? 'both' : cgLimited ? 'coingecko_onchain' : input.rateLimited ? 'geckoterminal' : null
  const finalSource = finalSourceForStage(finalStage)
  return {
    chain: input.chain,
    network: input.network,
    coingeckoNetwork: input.coingeckoNetwork ?? null,
    scannedToken: input.scannedToken,
    selectedPool: input.selectedPoolAddress,
    tokenSide: input.tokenSide,
    requestedInterval: STAGE_INTERVAL.primary_pool_15m,
    requestedLimit: primaryRung.requestLimit,
    source: input.source,
    attempts,
    rateLimited: input.rateLimited || cgLimited,
    rateLimitedProvider,
    finalSource,
    finalStage,
    finalCandleCount: input.finalCandleCount,
    fallbackReason: finalSource === 'coingecko_onchain' || finalSource === 'geckoterminal' ? null : (input.candleFailure?.code ?? null),
  }
}
