// lib/chartGeometry.ts — pure display geometry for the Token Scanner candlestick chart (PriceChartPanel).
//
// DISPLAY ONLY. Nothing here changes a candle: OHLC values, timestamps and order are read, never written.
// It decides (1) how wide candles are and where they sit horizontally, and (2) which price range the
// y-axis shows. Both are recomputed from the VISIBLE candles every render, so a timeframe switch, a
// PRICE <-> MCAP switch, a resize or a new scan can never keep a previous domain.
//
// HORIZONTAL (TradingView-style bar spacing):
//   - candles are index-spaced (no fake timestamps, no empty future slots), newest at the right with a
//     modest RIGHT_OFFSET_BARS gap before the price axis;
//   - when the whole series is visible it fills ~82% (<= 24 bars) rising to ~96% (>= 60 bars) of the plot, capped at
//     MAX_BAR_SPACING per candle, so a fresh token's 10-20 candles read as a chart instead of being
//     spread across a huge fixed timeline or blown up to full width;
//   - a zoomed / long series fills the plot (minus the right offset);
//   - body width is ~72% of the spacing, at least 1px, at most MAX_BODY_WIDTH, always leaving a gap.
//
// VERTICAL (robust autoscale): the TYPICAL band is the candle BODIES plus a wick allowance of
// max(WICK_ALLOWANCE_BODY_FRACTION x body span, WICK_ALLOWANCE_RANGE_MULTIPLE x median candle range).
// Normal and moderately long wicks are ALWAYS drawn in full: as long as the real high-low range stays
// within OUTLIER_SPAN_MULTIPLE x the typical band, the domain is simply the real range. Only a genuine
// display outlier (one extreme spike / dump that would squeeze every other candle into a thin strip) is
// clipped, and only on its own side, and only when it reaches more than OUTLIER_SIDE_EXCESS x the band
// beyond the band's edge: the display range then stops at the typical edge and the wick is drawn to the
// plot edge with a continuation mark and its TRUE value flagged (clippedHigh / clippedLow + trueMax /
// trueMin). A nearly flat market gets a minimum spread so it is centred rather than exploded into noise.

import type { ChartCandle } from './priceChartCandles.ts'

export const CANDLE_FILL_FRACTION = 0.82
/** A longer whole series fills more of the plot (no dead band on the left): 82% up to 24 bars, 96% from 60. */
export const CANDLE_FILL_FRACTION_LONG = 0.96
export function candleFillFraction(visible: number): number {
  if (visible <= 24) return CANDLE_FILL_FRACTION
  if (visible >= 60) return CANDLE_FILL_FRACTION_LONG
  return CANDLE_FILL_FRACTION + ((visible - 24) / 36) * (CANDLE_FILL_FRACTION_LONG - CANDLE_FILL_FRACTION)
}
export const MAX_BAR_SPACING = 80
export const MIN_BAR_SPACING = 1
export const MAX_BODY_WIDTH = 40
export const BODY_FRACTION = 0.72
export const RIGHT_OFFSET_BARS = 1
/** The right offset is one bar, but never more than this many px (room for the live price, no empty future). */
export const MAX_RIGHT_OFFSET_PX = 24

export type CandleGeometry = {
  spacing: number
  bodyW: number
  /** Centre x of visible candle i (0 = oldest visible). */
  xs: number[]
  /** Share of the plot width the visible candles occupy (0..1). */
  fill: number
}

export function candleGeometry(visible: number, total: number, plotW: number): CandleGeometry {
  if (visible <= 0 || !(plotW > 0)) return { spacing: 0, bodyW: 0, xs: [], fill: 0 }
  const rightPad = Math.min(MAX_RIGHT_OFFSET_PX, (plotW / (visible + RIGHT_OFFSET_BARS)) * RIGHT_OFFSET_BARS)
  const fitAll = (plotW - rightPad) / visible
  const spacing = visible >= total
    ? Math.max(MIN_BAR_SPACING, Math.min(MAX_BAR_SPACING, (plotW * candleFillFraction(visible)) / visible, fitAll))
    : Math.max(MIN_BAR_SPACING, fitAll)
  const bodyW = Math.max(1, Math.min(MAX_BODY_WIDTH, spacing * BODY_FRACTION, spacing >= 3 ? spacing - 1 : spacing))
  const xs = Array.from({ length: visible }, (_, i) => plotW - rightPad - (visible - 1 - i + 0.5) * spacing)
  return { spacing, bodyW, xs, fill: Math.min(1, (visible * spacing) / plotW) }
}

export const WICK_ALLOWANCE_BODY_FRACTION = 0.5
export const WICK_ALLOWANCE_RANGE_MULTIPLE = 3
export const DOMAIN_PAD_FRACTION = 0.06
/** No clipping unless the real high-low range exceeds this multiple of the typical (bodies + allowance) band. */
export const OUTLIER_SPAN_MULTIPLE = 2.5
/** ...and a side is clipped only when it reaches beyond the band's edge by more than this share of the band. */
export const OUTLIER_SIDE_EXCESS = 0.75
/** Minimum displayed spread for a (nearly) flat market, as a fraction of price. */
export const FLAT_MIN_SPREAD_FRACTION = 0.004

export type PriceDomain = {
  min: number
  max: number
  /** The real extremes of the visible candles (never altered). */
  trueMin: number
  trueMax: number
  /** A real wick extends beyond the displayed range (drawn to the edge and flagged with its true value). */
  clippedHigh: boolean
  clippedLow: boolean
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function robustPriceDomain(candles: ReadonlyArray<ChartCandle>, padFraction = DOMAIN_PAD_FRACTION): PriceDomain {
  if (candles.length === 0) return { min: 0, max: 1, trueMin: 0, trueMax: 1, clippedHigh: false, clippedLow: false }
  let coreLo = Infinity, coreHi = -Infinity, trueMin = Infinity, trueMax = -Infinity
  const ranges: number[] = []
  for (const c of candles) {
    coreLo = Math.min(coreLo, c.open, c.close)
    coreHi = Math.max(coreHi, c.open, c.close)
    trueMin = Math.min(trueMin, c.low)
    trueMax = Math.max(trueMax, c.high)
    ranges.push(c.high - c.low)
  }
  const bodySpan = coreHi - coreLo
  const allowance = Math.max(bodySpan * WICK_ALLOWANCE_BODY_FRACTION, median(ranges) * WICK_ALLOWANCE_RANGE_MULTIPLE)
  const typLo = coreLo - allowance
  const typHi = coreHi + allowance
  const typSpan = typHi - typLo
  // Clip only a genuine outlier: the whole real range is far wider than the typical band, and this side
  // reaches well beyond the band's edge. Everything else (incl. a moderately long wick) is drawn in full.
  const outlier = typSpan > 0 && trueMax - trueMin > typSpan * OUTLIER_SPAN_MULTIPLE
  const clipHi = outlier && trueMax - typHi > typSpan * OUTLIER_SIDE_EXCESS
  const clipLo = outlier && typLo - trueMin > typSpan * OUTLIER_SIDE_EXCESS
  let lo = clipLo ? typLo : trueMin
  let hi = clipHi ? typHi : trueMax
  const mid = (lo + hi) / 2
  const minSpread = Math.abs(mid) * FLAT_MIN_SPREAD_FRACTION || Number.EPSILON
  if (hi - lo < minSpread) { lo = mid - minSpread / 2; hi = mid + minSpread / 2 }
  const pad = (hi - lo) * padFraction
  const min = Math.max(0, lo - pad)
  const max = hi + pad
  return { min, max, trueMin, trueMax, clippedHigh: trueMax > max, clippedLow: trueMin < min }
}

/** Volume pane height: a proportional share of the price pane (0 when there is no real volume). */
export function volumePaneHeight(priceH: number, hasVolume: boolean): number {
  return hasVolume ? Math.round(priceH * 0.24) : 0
}
