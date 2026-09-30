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
// LOADED-WINDOW COVERAGE (live bug #2: 6 x 5M candles in a 2h loaded window were never judged — and a
// burst of candles judged only on its own first->last span looks dense). When the window ChainLens
// actually requested/received is known (resolveCoverageWindow), density is measured against THAT window
// (coverageDensity), and the trailing window below ends at the loaded window's end, not at the newest
// candle. clusterDensity (count / own span) is kept for debug only. Unknown window => the old candle-span
// logic, never a guessed window.
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
  /** First -> last genuine candle. */
  candleSpanSec: number
  candleSpanExpectedBuckets: number
  /** candleCount / candleSpanExpectedBuckets — how tight the cluster itself is. */
  clusterDensity: number
  /** The loaded window the series is judged against (seconds); equals the candle span when unknown. */
  coverageStartSec: number | null
  coverageEndSec: number | null
  coverageSpanSec: number | null
  coverageExpectedBuckets: number
  /** candleCount / coverageExpectedBuckets — the primary presentation density. */
  coverageDensity: number
  poolAgeSec: number | null
  effectiveCoverageSpanSec: number
  coverageKnown: boolean
  /** Whole buckets between the newest candle and the supplied reference time (null without one). */
  staleBuckets: number | null
  quality: ChartQualityState
  /** Why the timeframe is not 'good' (null when it is). */
  rejectionReason: string | null
}

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d

/**
 * The window ChainLens actually asked for and received, for one loaded candle series. Metadata from the
 * request that was already made — never an extra call.
 *   requestEndSec      when the request was answered (candles "up to now")
 *   requestedStartSec  requestEndSec - limit x interval (count-bounded provider pages), or the start of a
 *                      proven time-bounded read (V4 swap logs), or null when the request had no window
 *   requestedLimit     row limit of the request (null = not count-bounded)
 *   returnedRows       rows the provider returned
 *   windowProven       the whole [requestedStartSec, requestEndSec] range was read (e.g. every log page)
 *   poolCreatedSec     the charted pool's own creation time, when the provider reported it
 */
export type ChartCoverageMeta = {
  requestEndSec: number
  requestedStartSec: number | null
  requestedLimit: number | null
  returnedRows: number
  oldestSec: number | null
  newestSec: number | null
  windowProven?: boolean
  poolCreatedSec?: number | null
}

/** Builds coverage metadata from a request that was just answered (pure). */
export function buildCoverageMeta(input: { requestEndSec: number; intervalSec: number; limit: number | null; points: ReadonlyArray<{ timestamp: string | number }>; poolCreatedSec?: number | null; windowSec?: number | null; windowProven?: boolean }): ChartCoverageMeta {
  const ts = input.points.map((p) => (typeof p.timestamp === 'number' ? (p.timestamp > 1e12 ? p.timestamp / 1000 : p.timestamp) : Date.parse(p.timestamp) / 1000)).filter((t) => Number.isFinite(t))
  const windowSec = input.windowSec ?? (input.limit != null ? input.limit * input.intervalSec : null)
  return {
    requestEndSec: Math.floor(input.requestEndSec),
    requestedStartSec: windowSec != null ? Math.floor(input.requestEndSec - windowSec) : null,
    requestedLimit: input.limit,
    returnedRows: input.points.length,
    oldestSec: ts.length ? Math.floor(Math.min(...ts)) : null,
    newestSec: ts.length ? Math.floor(Math.max(...ts)) : null,
    ...(input.windowProven ? { windowProven: true } : {}),
    ...(input.poolCreatedSec != null && Number.isFinite(input.poolCreatedSec) ? { poolCreatedSec: Math.floor(input.poolCreatedSec) } : {}),
  }
}

/**
 * The presentation window a loaded series is judged against (ms), or null when unknown.
 *   - a count-truncated page (returnedRows >= requestedLimit) proves nothing older: [oldest candle, end];
 *   - a proven time window, or a short page of a pool KNOWN to predate the requested window: the full
 *     requested window [max(requestedStart, poolCreated), end] — what was asked for is what the chart
 *     shows, so a small burst inside it is judged as a burst;
 *   - pool age unknown: [oldest candle, end] (a young pool is never penalized by a guessed window).
 * The window always contains every returned candle; nothing here creates candles.
 */
export function resolveCoverageWindow(meta: ChartCoverageMeta | null | undefined, poolCreatedMs?: number | null): { startMs: number; endMs: number; basis: 'requested_window' | 'returned_range' } | null {
  if (!meta || !Number.isFinite(meta.requestEndSec) || meta.oldestSec == null) return null
  const endMs = Math.max(meta.requestEndSec, meta.newestSec ?? meta.requestEndSec) * 1000
  const oldestMs = meta.oldestSec * 1000
  const createdMs = meta.poolCreatedSec != null ? meta.poolCreatedSec * 1000 : poolCreatedMs != null && Number.isFinite(poolCreatedMs) ? poolCreatedMs : null
  const truncated = meta.requestedLimit != null && meta.returnedRows >= meta.requestedLimit
  const canUseRequested = meta.requestedStartSec != null && !truncated && (meta.windowProven === true || createdMs != null)
  if (!canUseRequested) return { startMs: oldestMs, endMs, basis: 'returned_range' }
  const start = Math.max(meta.requestedStartSec! * 1000, createdMs ?? -Infinity)
  return { startMs: Math.min(start, oldestMs), endMs, basis: 'requested_window' }
}

/** 5M is judged more strictly: a handful of 5-minute candles is never a normal intraday chart. */
export const FIVE_MIN_GOOD_MIN_COVERAGE = 0.6
export const FIVE_MIN_USABLE_MIN_CANDLES = 12
export const FIVE_MIN_USABLE_SHORT_MIN_CANDLES = 6

export function assessTimeframeQuality(
  candles: ReadonlyArray<ChartCandle>,
  timeframeSec: number,
  opts: { timeframe?: ChartTimeframeKey | string; referenceMs?: number | null; coverage?: { startMs: number; endMs: number } | null; poolCreatedMs?: number | null } = {},
): TimeframeQuality {
  const tfMs = timeframeSec * 1000
  const n = candles.length
  const base = { timeframe: opts.timeframe ?? `${timeframeSec}s`, timeframeSec, candleCount: n }
  const cov = opts.coverage ?? null
  const blank = {
    candleSpanSec: 0, candleSpanExpectedBuckets: 0, clusterDensity: 0, coverageStartSec: cov ? Math.floor(cov.startMs / 1000) : null, coverageEndSec: cov ? Math.floor(cov.endMs / 1000) : null,
    coverageSpanSec: null, coverageExpectedBuckets: 0, coverageDensity: 0, poolAgeSec: null, effectiveCoverageSpanSec: 0, coverageKnown: cov != null,
  }
  if (n === 0 || !(timeframeSec > 0)) {
    return { ...base, ...blank, spanSec: 0, expectedBuckets: 0, density: 0, windowBuckets: 0, recentCandles: 0, recentCoverage: 0, largestGapBuckets: 0, medianGapBuckets: 0, staleBuckets: null, quality: 'unusable', rejectionReason: 'no_genuine_candles' }
  }
  const first = candles[0].t
  const last = candles[n - 1].t
  const candleSpanSec = Math.max(0, Math.round((last - first) / 1000))
  const candleSpanExpectedBuckets = Math.floor(candleSpanSec / timeframeSec) + 1
  const clusterDensity = Math.min(1, n / candleSpanExpectedBuckets)
  // Effective coverage: the loaded window (never narrower than the candles themselves); unknown => candle span.
  const effStart = cov ? Math.min(cov.startMs, first) : first
  const effEnd = cov ? Math.max(cov.endMs, last) : last
  const startBucket = Math.floor(effStart / tfMs)
  const endBucket = Math.floor(effEnd / tfMs)
  const coverageExpectedBuckets = endBucket - startBucket + 1
  const coverageDensity = Math.min(1, n / coverageExpectedBuckets)
  const windowBuckets = Math.min(QUALITY_WINDOW_BUCKETS, coverageExpectedBuckets)
  const windowStartBucket = endBucket - windowBuckets + 1
  const recent = candles.filter((c) => Math.floor(c.t / tfMs) >= windowStartBucket)
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
  const refForAge = cov ? cov.endMs : opts.referenceMs ?? null
  const poolAgeSec = opts.poolCreatedMs != null && refForAge != null ? Math.max(0, Math.round((refForAge - opts.poolCreatedMs) / 1000)) : null

  const five = timeframeSec === 300
  const goodMinCov = five ? FIVE_MIN_GOOD_MIN_COVERAGE : GOOD_MIN_COVERAGE
  const usableMin = five ? FIVE_MIN_USABLE_MIN_CANDLES : USABLE_MIN_CANDLES
  const usableShortMin = five ? FIVE_MIN_USABLE_SHORT_MIN_CANDLES : USABLE_SHORT_MIN_CANDLES
  let quality: ChartQualityState
  let rejectionReason: string | null = null
  if (n < 2) { quality = 'unusable'; rejectionReason = 'fewer_than_2_candles' }
  else if (
    recentCandles >= Math.min(GOOD_MIN_CANDLES, windowBuckets) && recentCoverage >= goodMinCov
    && largestRecentGap <= Math.max(GOOD_MAX_GAP_FLOOR, windowBuckets * GOOD_MAX_GAP_FRACTION)
  ) quality = 'good'
  else if (
    (recentCandles >= Math.min(usableMin, windowBuckets) && recentCoverage >= USABLE_MIN_COVERAGE)
    || (recentCandles >= Math.min(usableShortMin, windowBuckets) && recentCoverage >= GOOD_MIN_COVERAGE)
  ) {
    quality = 'usable'
    rejectionReason = recentCandles < Math.min(GOOD_MIN_CANDLES, windowBuckets) ? 'few_recent_candles' : recentCoverage < goodMinCov ? 'low_recent_coverage' : 'large_recent_gap'
  } else {
    quality = 'sparse'
    // A tight burst that fills its own span but not the loaded window is named as such.
    rejectionReason = cov && clusterDensity >= 0.5 && coverageExpectedBuckets > candleSpanExpectedBuckets
      ? 'insufficient_loaded_window_coverage'
      : recentCandles < Math.min(usableMin, windowBuckets) ? 'too_few_recent_candles' : 'recent_coverage_too_low'
  }
  // Staleness demotes only (never promotes, never adds candles).
  if (staleBuckets != null && (quality === 'good' || quality === 'usable')) {
    const threshold = Math.max(STALE_MIN_BUCKETS, windowBuckets)
    if (quality === 'good' && staleBuckets > threshold) { quality = 'usable'; rejectionReason = 'stale_recent_coverage' }
    if (quality === 'usable' && staleBuckets > threshold * STALE_SEVERE_FACTOR) { quality = 'sparse'; rejectionReason = 'stale_recent_coverage' }
  }
  return {
    ...base,
    spanSec: candleSpanSec, expectedBuckets: coverageExpectedBuckets, density: round(coverageDensity),
    candleSpanSec, candleSpanExpectedBuckets, clusterDensity: round(clusterDensity),
    coverageStartSec: Math.floor(effStart / 1000), coverageEndSec: Math.floor(effEnd / 1000), coverageSpanSec: Math.round((effEnd - effStart) / 1000),
    coverageExpectedBuckets, coverageDensity: round(coverageDensity), poolAgeSec, effectiveCoverageSpanSec: Math.round((effEnd - effStart) / 1000), coverageKnown: cov != null,
    windowBuckets, recentCandles, recentCoverage: round(recentCoverage),
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
export function assessTimeframeSet(
  set: ChartTimeframeSet,
  opts: {
    referenceMs?: number | null
    fiveMinuteExactTime?: boolean
    /** The loaded window per timeframe (lib/chartQuality.ts resolveCoverageWindow); null/absent = unknown. */
    coverageFor?: (key: ChartTimeframeKey) => { startMs: number; endMs: number } | null
    poolCreatedMs?: number | null
  } = {},
): Partial<Record<ChartTimeframeKey, TimeframeQuality>> {
  const out: Partial<Record<ChartTimeframeKey, TimeframeQuality>> = {}
  for (const tf of set.timeframes) {
    if (!tf.available) continue
    const q = assessTimeframeQuality(tf.candles, tf.sec, { timeframe: tf.key, referenceMs: opts.referenceMs, coverage: opts.coverageFor?.(tf.key) ?? null, poolCreatedMs: opts.poolCreatedMs })
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
/** Most slots a short series is spread over in time-proportional layout (wider spans are scaled down). */
export const MAX_TIME_SLOTS = 96
/**
 * X layout for the visible candles. A normal series (>= MIN_DISPLAY_SLOTS candles, or a zoomed slice)
 * keeps the trading-terminal index layout. A SHORT series shown whole is laid out by its real timestamps:
 * each candle sits at its bucket offset (gaps preserved, newest at the right edge), over at least
 * MIN_DISPLAY_SLOTS slots, so a few candles are neither stretched into a "complete" chart nor packed as
 * if contiguous. Spans wider than MAX_TIME_SLOTS buckets are scaled proportionally. Pure; never moves a
 * candle out of order or adds one.
 */
export function chartXLayout(times: ReadonlyArray<number>, intervalSec: number | null, total: number, plotW: number): { slot: number; pos: number[]; mode: 'index' | 'time' } {
  const n = times.length
  if (n === 0) return { slot: plotW, pos: [], mode: 'index' }
  if (total >= MIN_DISPLAY_SLOTS || n !== total || !(intervalSec != null && intervalSec > 0)) return { slot: plotW / n, pos: times.map((_, i) => i), mode: 'index' }
  const tfMs = intervalSec * 1000
  const offs = times.map((t) => (t - times[0]) / tfMs)
  const spanB = offs[n - 1]
  const scale = spanB + 1 > MAX_TIME_SLOTS ? (MAX_TIME_SLOTS - 1) / spanB : 1
  const slots = Math.max(MIN_DISPLAY_SLOTS, Math.min(MAX_TIME_SLOTS, Math.ceil(spanB * scale) + 1))
  return { slot: plotW / slots, pos: offs.map((b) => slots - 1 - (spanB - b) * scale), mode: 'time' }
}

/** Index of the candle whose centre is nearest `x` (layout from chartXLayout). */
export function nearestCandleIndex(x: number, layout: { slot: number; pos: ReadonlyArray<number> }): number {
  let best = 0
  let bestD = Infinity
  layout.pos.forEach((p, i) => { const d = Math.abs((p + 0.5) * layout.slot - x); if (d < bestD) { bestD = d; best = i } })
  return best
}
