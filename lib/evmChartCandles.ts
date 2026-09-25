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
