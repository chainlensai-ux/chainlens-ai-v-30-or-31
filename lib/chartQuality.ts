// lib/chartQuality.ts — pure, deterministic PRESENTATION quality for a Token Scanner chart timeframe.
//
// WHY (live bug): a Base token opened on 15M with 7 genuine 15-minute candles spread across 13 days.
// Timeframe availability (lib/priceChartCandles.ts) only asks "are there >= 2 genuine buckets?", and the
// default pick took the first available timeframe in 15M / 5M / 1H / 4H / 1D order — so 7 isolated
// candles became the normal default chart. Availability (the data exists) and presentation (the chart
// reads as a coherent series) are different questions; this module answers the second.
//
// NOTHING HERE CREATES DATA. Missing buckets are only COUNTED (to measure density and gaps); they are
// never filled, and OHLC is never computed from them. Quality is measured on PRICE candles; MCAP is a
// per-candle scale of the same series, so it inherits the same verdict.
//
// METRICS (per timeframe of width `tf`):
//   spanSec           last - first candle open time
//   expectedBuckets   floor(spanSec / tf) + 1 — the buckets the represented span could hold. The span
//                     is already min(pool age, loaded history): a young pool's series starts at its first
//                     trade, so a 45-minute-old pool is judged against 45 minutes, not days.
//   density           candleCount / expectedBuckets
//   window            the trailing min(QUALITY_WINDOW_BUCKETS, expectedBuckets) buckets ending at the newest
//                     candle — roughly what the resting chart view shows. A burst of recent activity after
//                     a long dead stretch is judged on the recent stretch, not diluted by the dead one.
//   recentCandles / recentCoverage   genuine candles inside the window / window buckets
//   largestGapBuckets / medianGapBuckets   distance between consecutive genuine candles, in buckets (1 = adjacent)
//
// STATES (thresholds tested in tests/chart-quality.test.ts):
//   good      recentCandles >= min(20, window)  AND recentCoverage >= 0.5
//             AND largestGapBuckets inside the window <= max(6, window / 4)
//   usable    recentCandles >= min(8, window)   AND recentCoverage >= 0.15
//             OR recentCandles >= min(5, window) AND recentCoverage >= 0.5 (a short but half-filled
//             series — e.g. 7 real days out of 14 — still reads as a trend)
//   sparse    >= 2 genuine candles, but the timeframe does not read as a continuous chart
//   unusable  fewer than 2 genuine candles
//   STALENESS (only with an explicit reference timestamp — never an implicit clock): with
//   staleBuckets = floor((referenceMs - newest candle) / tf) and threshold = max(12, window):
//     staleBuckets >  threshold      good   -> usable
//     staleBuckets >  4 x threshold  usable -> sparse
//   Demotion only (never a promotion), reason 'stale_recent_coverage'. No candle is added; a young pool
//   that simply stopped trading keeps its real candles and is only rated less presentable.
//   INFERRED TIME: when the source's 5M timestamps are not exact (Uniswap V4 swaps timed by block number
//   or by interpolation between block headers), 5M is never presentation-usable ('inferred_timestamps').
// 20 candles / 50% coverage is a readable trading chart; 8 candles / 15% is the least that still shows a
// trend at a glance (one candle every ~7 buckets). A window of 96 buckets is 24h at 15M, 4d at 1H, 16d at 4H.

import { CHART_TIMEFRAMES, type ChartCandle, type ChartTimeframeKey, type ChartTimeframeSet } from './priceChartCandles.ts'

export type ChartQualityState = 'good' | 'usable' | 'sparse' | 'unusable'

export const QUALITY_WINDOW_BUCKETS = 96
export const GOOD_MIN_CANDLES = 20
export const GOOD_MIN_COVERAGE = 0.5
export const USABLE_MIN_CANDLES = 8
export const USABLE_MIN_COVERAGE = 0.15
export const USABLE_SHORT_MIN_CANDLES = 5
export const GOOD_MAX_GAP_FRACTION = 0.25
export const GOOD_MAX_GAP_FLOOR = 6
export const STALE_MIN_BUCKETS = 12
export const STALE_SEVERE_FACTOR = 4

export type TimeframeQuality = {
  timeframe: ChartTimeframeKey | string
  timeframeSec: number
  candleCount: number
  spanSec: number
  expectedBuckets: number
  density: number
  windowBuckets: number
  recentCandles: number
  recentCoverage: number
  largestGapBuckets: number
  medianGapBuckets: number
  /** Whole buckets between the newest candle and the supplied reference time (null without one). */
  staleBuckets: number | null
  quality: ChartQualityState
  /** Why the timeframe is not 'good' (null when it is). */
  rejectionReason: string | null
}

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d

export function assessTimeframeQuality(
  candles: ReadonlyArray<ChartCandle>,
  timeframeSec: number,
  opts: { timeframe?: ChartTimeframeKey | string; referenceMs?: number | null } = {},
): TimeframeQuality {
  const tfMs = timeframeSec * 1000
  const n = candles.length
  const base = { timeframe: opts.timeframe ?? `${timeframeSec}s`, timeframeSec, candleCount: n }
  if (n === 0 || !(timeframeSec > 0)) {
    return { ...base, spanSec: 0, expectedBuckets: 0, density: 0, windowBuckets: 0, recentCandles: 0, recentCoverage: 0, largestGapBuckets: 0, medianGapBuckets: 0, staleBuckets: null, quality: 'unusable', rejectionReason: 'no_genuine_candles' }
  }
  const first = candles[0].t
  const last = candles[n - 1].t
  const spanSec = Math.max(0, Math.round((last - first) / 1000))
  const expectedBuckets = Math.floor(spanSec / timeframeSec) + 1
  const density = Math.min(1, n / expectedBuckets)
  const windowBuckets = Math.min(QUALITY_WINDOW_BUCKETS, expectedBuckets)
  const windowStart = last - (windowBuckets - 1) * tfMs
  const recent = candles.filter((c) => c.t >= windowStart)
  const recentCandles = recent.length
  const recentCoverage = Math.min(1, recentCandles / windowBuckets)
  const gapsOf = (cs: ReadonlyArray<ChartCandle>) => cs.slice(1).map((c, i) => (c.t - cs[i].t) / tfMs)
  const allGaps = gapsOf(candles)
  const recentGaps = gapsOf(recent)
  const sorted = [...allGaps].sort((a, b) => a - b)
  const largestGapBuckets = allGaps.length ? Math.max(...allGaps) : 0
  const medianGapBuckets = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
  const largestRecentGap = recentGaps.length ? Math.max(...recentGaps) : 0
  const staleBuckets = opts.referenceMs != null && Number.isFinite(opts.referenceMs) ? Math.max(0, Math.floor((opts.referenceMs - last) / tfMs)) : null

  let quality: ChartQualityState
  let rejectionReason: string | null = null
  if (n < 2) { quality = 'unusable'; rejectionReason = 'fewer_than_2_candles' }
  else if (
    recentCandles >= Math.min(GOOD_MIN_CANDLES, windowBuckets) && recentCoverage >= GOOD_MIN_COVERAGE
    && largestRecentGap <= Math.max(GOOD_MAX_GAP_FLOOR, windowBuckets * GOOD_MAX_GAP_FRACTION)
  ) quality = 'good'
  else if (
    (recentCandles >= Math.min(USABLE_MIN_CANDLES, windowBuckets) && recentCoverage >= USABLE_MIN_COVERAGE)
    || (recentCandles >= Math.min(USABLE_SHORT_MIN_CANDLES, windowBuckets) && recentCoverage >= GOOD_MIN_COVERAGE)
  ) {
    quality = 'usable'
    rejectionReason = recentCandles < Math.min(GOOD_MIN_CANDLES, windowBuckets) ? 'few_recent_candles' : recentCoverage < GOOD_MIN_COVERAGE ? 'low_recent_coverage' : 'large_recent_gap'
  } else {
    quality = 'sparse'
    rejectionReason = recentCandles < Math.min(USABLE_MIN_CANDLES, windowBuckets) ? 'too_few_recent_candles' : 'recent_coverage_too_low'
  }
  // Staleness demotes only (never promotes, never adds candles).
  if (staleBuckets != null && (quality === 'good' || quality === 'usable')) {
    const threshold = Math.max(STALE_MIN_BUCKETS, windowBuckets)
    if (quality === 'good' && staleBuckets > threshold) { quality = 'usable'; rejectionReason = 'stale_recent_coverage' }
    if (quality === 'usable' && staleBuckets > threshold * STALE_SEVERE_FACTOR) { quality = 'sparse'; rejectionReason = 'stale_recent_coverage' }
  }
  return {
    ...base, spanSec, expectedBuckets, density: round(density), windowBuckets, recentCandles, recentCoverage: round(recentCoverage),
    largestGapBuckets: round(largestGapBuckets, 2), medianGapBuckets: round(medianGapBuckets, 2), staleBuckets, quality, rejectionReason,
  }
}

const RANK: Record<ChartQualityState, number> = { good: 3, usable: 2, sparse: 1, unusable: 0 }
export const qualityRank = (q: ChartQualityState): number => RANK[q]
export const isPresentationUsable = (q: ChartQualityState): boolean => q === 'good' || q === 'usable'

/**
 * Quality of every AVAILABLE timeframe in a set (unavailable ones are absent). `referenceMs` enables the
 * stale rule; `fiveMinuteExactTime: false` (inferred / interpolated V4 swap timestamps) keeps 5M from
 * ever being presentation-usable — its candles stay reachable, it is just never the default.
 */
export function assessTimeframeSet(set: ChartTimeframeSet, opts: { referenceMs?: number | null; fiveMinuteExactTime?: boolean } = {}): Partial<Record<ChartTimeframeKey, TimeframeQuality>> {
  const out: Partial<Record<ChartTimeframeKey, TimeframeQuality>> = {}
  for (const tf of set.timeframes) {
    if (!tf.available) continue
    const q = assessTimeframeQuality(tf.candles, tf.sec, { timeframe: tf.key, referenceMs: opts.referenceMs })
    out[tf.key] = tf.key === '5M' && opts.fiveMinuteExactTime === false && q.quality !== 'unusable'
      ? { ...q, quality: 'sparse', rejectionReason: 'inferred_timestamps' }
      : q
  }
  return out
}

/** Natural finest -> coarsest order in which a presentation-usable timeframe is chosen. */
export const PRESENTATION_PREFERENCE: ReadonlyArray<ChartTimeframeKey> = ['5M', '15M', '1H', '4H', '1D']

export type TimeframeSelection = {
  key: ChartTimeframeKey | null
  /** e.g. 'default_15m_good', '15m_sparse_fallback_to_1h', 'all_timeframes_sparse_best_1d'. */
  reason: string
  /** The preferred timeframe that was passed over for being sparse (null when the first choice held). */
  fallbackFrom: ChartTimeframeKey | null
  quality: ChartQualityState | null
}

/**
 * Picks the finest timeframe (in PRESENTATION_PREFERENCE order) whose presentation quality is good or
 * usable. When nothing passes, the least-bad available timeframe is shown and marked sparse: highest
 * quality rank, then highest recent coverage, then the coarser one. Never invents a timeframe.
 */
export function selectPresentationTimeframe(qualities: Partial<Record<ChartTimeframeKey, TimeframeQuality>>): TimeframeSelection {
  const available = PRESENTATION_PREFERENCE.filter((k) => qualities[k])
  if (available.length === 0) return { key: null, reason: 'no_standard_timeframe_available', fallbackFrom: null, quality: null }
  const firstChoice = available[0]
  const lc = (k: ChartTimeframeKey) => k.toLowerCase()
  const pass = available.find((k) => isPresentationUsable(qualities[k]!.quality))
  if (pass) {
    const q = qualities[pass]!.quality
    return pass === firstChoice
      ? { key: pass, reason: `default_${lc(pass)}_${q}`, fallbackFrom: null, quality: q }
      : { key: pass, reason: `${lc(firstChoice)}_${qualities[firstChoice]!.quality}_fallback_to_${lc(pass)}`, fallbackFrom: firstChoice, quality: q }
  }
  const secOf = (k: ChartTimeframeKey) => CHART_TIMEFRAMES.find((t) => t.key === k)!.sec
  const best = [...available].sort((a, b) => {
    const qa = qualities[a]!, qb = qualities[b]!
    return qualityRank(qb.quality) - qualityRank(qa.quality) || qb.recentCoverage - qa.recentCoverage || secOf(b) - secOf(a)
  })[0]
  return { key: best, reason: `all_timeframes_sparse_best_${lc(best)}`, fallbackFrom: best === firstChoice ? null : firstChoice, quality: qualities[best]!.quality }
}

/** "13d", "6h", "45m" — the represented span of a series, for compact status copy. */
export function formatSpanShort(spanSec: number): string {
  if (!Number.isFinite(spanSec) || spanSec <= 0) return '0m'
  if (spanSec < 3600) return `${Math.max(1, Math.round(spanSec / 60))}m`
  if (spanSec < 48 * 3600) return `${Math.round(spanSec / 3600)}h`
  return `${Math.round(spanSec / 86_400)}d`
}

const TF_WORD: Record<string, string> = { '5M': '5-minute', '15M': '15-minute', '1H': '1-hour', '4H': '4-hour', '1D': 'daily' }
/** Tooltip for a sparse timeframe chip, e.g. "Only 7 genuine 15-minute candles are available across 13d. Use 1H for a clearer view." */
export function sparseTimeframeTooltip(q: TimeframeQuality, better: ChartTimeframeKey | null): string {
  return `Only ${q.candleCount} genuine ${TF_WORD[q.timeframe] ?? String(q.timeframe)} candle${q.candleCount === 1 ? '' : 's'} ${q.candleCount === 1 ? 'is' : 'are'} available across ${formatSpanShort(q.spanSec)}.${better ? ` Use ${better} for a clearer view.` : ''}`
}

// ── Layout for short series ─────────────────────────────────────────────────────────────────────
/** A series shorter than this is drawn at this many slots, right-aligned, instead of stretched across the plot. */
export const MIN_DISPLAY_SLOTS = 24
/** Resting view target: ~40 (phone) to ~100 (desktop) candles, from the plot width. */
export function restingCandleTarget(plotW: number, compact: boolean): number {
  const t = Math.round(plotW / (compact ? 8 : 9))
  return Math.max(40, Math.min(100, Number.isFinite(t) ? t : 40))
}
/** Slot width and left offset (in slots) for `visible` candles of a `total`-candle series. Pure; indices keep true order. */
export function chartSlotLayout(visible: number, total: number, plotW: number): { slot: number; offset: number } {
  const slots = total < MIN_DISPLAY_SLOTS ? Math.max(visible, MIN_DISPLAY_SLOTS) : Math.max(1, visible)
  return { slot: plotW / slots, offset: slots - Math.max(0, visible) }
}
