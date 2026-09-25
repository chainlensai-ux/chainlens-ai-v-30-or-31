// lib/priceChartCandles.ts — pure candle logic for the Token Scanner Price Chart.
//
// REAL-OHLCV-ONLY, DISCLOSED (requested: "Use REAL returned OHLCV only. Never fabricate/interpolate
// candles. Disabled/unavailable intervals must not silently reuse 1H data."). Everything here works
// on the candles a provider actually returned — nothing is interpolated, gap-filled or synthesized:
//
//   - normalizeChartCandles: drops non-finite / non-positive / internally inconsistent rows, sorts
//     chronologically, and collapses duplicate timestamps (last row wins). It never invents a row.
//   - resolveNativeIntervalSec: the interval the provider candles were fetched at. A declared
//     interval is trusted only when every real timestamp gap is an exact multiple of it (providers
//     omit buckets with no trades, so gaps of 2x/3x are normal); otherwise it is inferred from the
//     gaps themselves, and a non-standard width (e.g. trade-reconstructed buckets) stays non-standard.
//   - aggregateCandles: rolls real lower-interval candles up into a HIGHER interval by exact OHLCV
//     aggregation (open = first real open, high = max, low = min, close = last real close, volume =
//     sum) inside UTC-aligned buckets. A bucket only exists if at least one real candle fell in it.
//     A lower interval is NEVER produced from a higher one — that would be fabrication.
//   - buildChartTimeframes: which of 5M/15M/1H/4H/1D are genuinely available, each carrying its own
//     candles. Unavailable timeframes carry an empty series and a reason — never another timeframe's
//     data.
// Kept dependency-free so tests/price-chart-candles.test.ts can exercise it directly.

export type ChartCandle = {
  /** Candle open time, epoch milliseconds (UTC). */
  t: number
  open: number
  high: number
  low: number
  close: number
  /** Real volume in USD, or null when the provider returned none for this candle. */
  volume: number | null
}

export type ChartCandleInput = {
  timestamp: string | number
  open: unknown
  high: unknown
  low: unknown
  close: unknown
  volume?: unknown
}

export type ChartTimeframeKey = '5M' | '15M' | '1H' | '4H' | '1D'

export const CHART_TIMEFRAMES: ReadonlyArray<{ key: ChartTimeframeKey; sec: number }> = [
  { key: '5M', sec: 300 },
  { key: '15M', sec: 900 },
  { key: '1H', sec: 3600 },
  { key: '4H', sec: 14_400 },
  { key: '1D', sec: 86_400 },
]

/** An aggregated (derived) timeframe needs at least this many real buckets to be worth enabling. */
export const MIN_DERIVED_CANDLES = 4
/** The native (as-fetched) timeframe keeps the chart's long-standing >= 2 candle threshold. */
export const MIN_NATIVE_CANDLES = 2

// Relative tolerance for high/low consistency checks — provider rows are floats and a high that is
// a hair under the open/close from rounding is not a corrupt candle.
const EPS = 1e-9

function finitePositive(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

function toEpochMs(ts: string | number): number | null {
  if (typeof ts === 'number') {
    if (!Number.isFinite(ts) || ts <= 0) return null
    return ts > 1e12 ? ts : ts * 1000
  }
  const ms = Date.parse(ts)
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

export function normalizeChartCandles(rows: ReadonlyArray<ChartCandleInput> | null | undefined): ChartCandle[] {
  if (!Array.isArray(rows)) return []
  const byTs = new Map<number, ChartCandle>()
  for (const row of rows) {
    if (!row) continue
    const t = toEpochMs(row.timestamp)
    const open = finitePositive(row.open)
    const high = finitePositive(row.high)
    const low = finitePositive(row.low)
    const close = finitePositive(row.close)
    if (t == null || open == null || high == null || low == null || close == null) continue
    // A candle whose high is below its low, or whose body sits outside its own wick range, is
    // internally inconsistent — drop it rather than "repair" it into something the provider never said.
    const tol = high * EPS
    if (high + tol < low) continue
    if (high + tol < Math.max(open, close) || low - tol > Math.min(open, close)) continue
    const volRaw = row.volume
    const volNum = typeof volRaw === 'number' ? volRaw : typeof volRaw === 'string' && volRaw.trim() !== '' ? Number(volRaw) : NaN
    const volume = Number.isFinite(volNum) && volNum >= 0 ? volNum : null
    byTs.set(t, { t, open, high, low, close, volume })
  }
  return [...byTs.values()].sort((a, b) => a.t - b.t)
}

function gapsSec(candles: ReadonlyArray<ChartCandle>): number[] {
  const out: number[] = []
  for (let i = 1; i < candles.length; i++) out.push(Math.round((candles[i].t - candles[i - 1].t) / 1000))
  return out
}

/**
 * The interval (seconds) the candles were fetched at, or null when there are too few candles to
 * tell. `declaredSec` (what the request asked for) is trusted only if every real gap is an exact
 * multiple of it. Otherwise the smallest real gap is used — which for sparse-but-regular series is
 * the true width, and for irregular reconstructed buckets is honestly non-standard.
 */
export function resolveNativeIntervalSec(candles: ReadonlyArray<ChartCandle>, declaredSec?: number | null): number | null {
  const gaps = gapsSec(candles).filter((g) => g > 0)
  if (declaredSec != null && declaredSec > 0) {
    if (gaps.length === 0 || gaps.every((g) => g % declaredSec === 0)) return declaredSec
  }
  if (gaps.length === 0) return null
  return Math.min(...gaps)
}

export function aggregateCandles(candles: ReadonlyArray<ChartCandle>, targetSec: number): ChartCandle[] {
  const bucketMs = targetSec * 1000
  const out: ChartCandle[] = []
  let cur: ChartCandle | null = null
  let curKey = Number.NaN
  let curHasVolume = false
  for (const c of candles) {
    const key = Math.floor(c.t / bucketMs) * bucketMs
    if (cur == null || key !== curKey) {
      if (cur) out.push(curHasVolume ? cur : { ...cur, volume: null })
      cur = { t: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 }
      curKey = key
      curHasVolume = c.volume != null
      continue
    }
    cur.high = Math.max(cur.high, c.high)
    cur.low = Math.min(cur.low, c.low)
    cur.close = c.close
    if (c.volume != null) { cur.volume = (cur.volume ?? 0) + c.volume; curHasVolume = true }
  }
  if (cur) out.push(curHasVolume ? cur : { ...cur, volume: null })
  return out
}

export type ChartTimeframeState = {
  key: ChartTimeframeKey
  sec: number
  available: boolean
  /** 'native' = the provider's own candles; 'aggregated' = exact roll-up of real lower-interval candles. */
  origin: 'native' | 'aggregated' | null
  candles: ChartCandle[]
  /** Why the timeframe is unavailable (shown on the disabled chip). Null when available. */
  unavailableReason: string | null
}

export type ChartTimeframeSet = {
  nativeSec: number | null
  /** True when the native width is one of the five standard timeframes. */
  nativeIsStandard: boolean
  timeframes: ChartTimeframeState[]
  /** The provider's own candles, always real — used when the native width is non-standard. */
  nativeCandles: ChartCandle[]
}

export function buildChartTimeframes(candles: ReadonlyArray<ChartCandle>, declaredSec?: number | null): ChartTimeframeSet {
  const nativeSec = resolveNativeIntervalSec(candles, declaredSec)
  const nativeIsStandard = nativeSec != null && CHART_TIMEFRAMES.some((tf) => tf.sec === nativeSec)
  const timeframes: ChartTimeframeState[] = CHART_TIMEFRAMES.map(({ key, sec }) => {
    const base = { key, sec }
    if (nativeSec == null || candles.length < MIN_NATIVE_CANDLES) {
      return { ...base, available: false, origin: null, candles: [], unavailableReason: 'Not enough real candles returned' }
    }
    if (sec === nativeSec) {
      return { ...base, available: true, origin: 'native', candles: [...candles], unavailableReason: null }
    }
    if (sec < nativeSec) {
      return { ...base, available: false, origin: null, candles: [], unavailableReason: `No real ${key} candles — history is only indexed at a coarser interval` }
    }
    // Exact roll-up needs the target to be a whole multiple of the native width, or buckets would
    // split real candles across two target buckets.
    if (sec % nativeSec !== 0) {
      return { ...base, available: false, origin: null, candles: [], unavailableReason: `${key} cannot be built exactly from the indexed interval` }
    }
    const agg = aggregateCandles(candles, sec)
    if (agg.length < MIN_DERIVED_CANDLES) {
      return { ...base, available: false, origin: null, candles: [], unavailableReason: `Not enough real history for ${key} candles yet` }
    }
    return { ...base, available: true, origin: 'aggregated', candles: agg, unavailableReason: null }
  })
  return { nativeSec, nativeIsStandard, timeframes, nativeCandles: [...candles] }
}

/**
 * Default selection: 1H when it has a useful amount of real history, otherwise the densest
 * available timeframe (smallest interval), otherwise null (native non-standard series only).
 */
export function pickDefaultTimeframe(set: ChartTimeframeSet): ChartTimeframeKey | null {
  const oneHour = set.timeframes.find((tf) => tf.key === '1H')
  if (oneHour?.available && oneHour.candles.length >= 24) return '1H'
  const first = set.timeframes.find((tf) => tf.available)
  return first ? first.key : null
}

export function formatIntervalLabel(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '—'
  if (sec % 86_400 === 0) return `${sec / 86_400}D`
  if (sec % 3600 === 0) return `${sec / 3600}H`
  if (sec % 60 === 0) return `${sec / 60}M`
  return `${sec}S`
}

// ── Price formatting ────────────────────────────────────────────────────────────────────────────

const SUBSCRIPT_DIGITS = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉']

function toSubscript(n: number): string {
  return String(n).split('').map((d) => SUBSCRIPT_DIGITS[Number(d)] ?? d).join('')
}

/**
 * Chart price formatter that stays readable for tiny memecoin prices. Prices at or above 1 use
 * grouped decimals; prices below 0.0001 use the compact zero-count notation traders expect
 * ($0.0₅4213 = 0.000004213). `sig` is the number of significant digits after the leading zeros.
 * Returns '—' for anything non-finite, so NaN/Infinity can never reach the screen.
 */
export function formatChartPrice(value: number | null | undefined, sig = 4): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value === 0) return '$0'
  const neg = value < 0
  const v = Math.abs(value)
  let body: string
  if (v >= 1000) body = v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
  else if (v >= 1) body = v.toFixed(v >= 100 ? 2 : 4)
  else {
    // Leading zeros after the decimal point: 0.00042 -> 3, 0.001 -> 2, 0.5 -> 0. (floor(-log10(v))
    // would say 3 for exactly 0.001 and never terminate the carry case below.)
    const zeros = Math.max(0, Math.ceil(-Math.log10(v)) - 1)
    const digits = Math.round(v * 10 ** (zeros + sig))
    // Rounding can carry into an extra digit (0.0009999 -> 1000 at sig 3); recompute from the rounded value.
    if (digits >= 10 ** sig) return formatChartPrice(neg ? -(10 ** -zeros) : 10 ** -zeros, sig)
    const sigStr = String(digits).padStart(sig, '0').replace(/0+$/, '') || '0'
    body = zeros >= 4 ? `0.0${toSubscript(zeros)}${sigStr}` : `0.${'0'.repeat(zeros)}${sigStr}`
  }
  return `${neg ? '-' : ''}$${body}`
}

export function formatChartVolume(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—'
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`
  return `$${value.toFixed(value >= 10 ? 0 : 2)}`
}

export function formatChartPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  const s = abs >= 1000 ? abs.toFixed(0) : abs.toFixed(2)
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${s}%`
}

/** % change from `from` to `to`; null when either side is unusable (never NaN/Infinity). */
export function pctChange(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from == null || to == null || !Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return null
  const pct = ((to - from) / from) * 100
  return Number.isFinite(pct) ? pct : null
}

// ── Axis ticks ──────────────────────────────────────────────────────────────────────────────────

/** "Nice" evenly spaced price ticks inside [min, max] (1/2/2.5/5 x 10^n steps). */
export function niceTicks(min: number, max: number, targetCount: number): { ticks: number[]; step: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || targetCount < 1) return { ticks: [], step: 0 }
  const range = max - min
  const mag = 10 ** Math.floor(Math.log10(range / targetCount))
  // Pick the 1/2/2.5/5/10 x 10^n step whose tick count lands closest to the target (rounding the
  // rough step UP, as is common, can halve the label count — e.g. 5.3e-5 -> 1e-4 gives 3 ticks).
  let step = mag
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (Math.abs(range / (m * mag) - targetCount) < Math.abs(range / step - targetCount)) step = m * mag
  }
  const ticks: number[] = []
  const start = Math.ceil(min / step) * step
  for (let v = start, i = 0; v <= max + step * 1e-9 && i < 50; v += step, i++) {
    // Strip float drift (0.1 + 0.2) so labels and positions agree.
    ticks.push(Number(v.toPrecision(12)))
  }
  return { ticks, step }
}

const TIME_TICK_STEPS_SEC = [300, 900, 1800, 3600, 7200, 10_800, 14_400, 21_600, 43_200, 86_400, 172_800, 259_200, 604_800, 1_209_600, 2_592_000]

/**
 * Indices of candles to label on the X axis. The chart spaces candles by index (like trading
 * terminals — gaps where no trades happened are collapsed, never filled), so a label is placed on
 * the first candle of each time step. The step is the smallest one that keeps labels at least
 * `minSpacingCandles` apart.
 */
export function timeTickIndices(candles: ReadonlyArray<ChartCandle>, minSpacingCandles: number, tzOffsetMin = 0): number[] {
  if (candles.length < 2) return candles.length === 1 ? [0] : []
  const spacing = Math.max(1, minSpacingCandles)
  const maxLabels = Math.max(1, Math.floor(candles.length / spacing))
  const shift = -tzOffsetMin * 60_000 // align steps to the viewer's local clock (midnight, 00:00 …)
  for (const stepSec of TIME_TICK_STEPS_SEC) {
    const stepMs = stepSec * 1000
    // Candle indices where a new time step begins (the first candle is excluded: it rarely sits on
    // a round time and would crowd the axis edge).
    const boundaries: number[] = []
    for (let i = 1; i < candles.length; i++) {
      if (Math.floor((candles[i].t + shift) / stepMs) !== Math.floor((candles[i - 1].t + shift) / stepMs)) boundaries.push(i)
    }
    if (boundaries.length > maxLabels) continue // too dense at this step — coarsen
    // Sparse series can still bunch boundaries together; keep only those far enough apart.
    const kept: number[] = []
    for (const i of boundaries) if (kept.length === 0 || i - kept[kept.length - 1] >= spacing) kept.push(i)
    if (kept.length > 0) return kept
  }
  return [0]
}
