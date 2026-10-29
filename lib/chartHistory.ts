// lib/chartHistory.ts — on-demand OLDER chart history for the Token Scanner Price Chart (pure; no I/O).
//
// The scan loads recent candles (Uniswap V4: up to the pool's last 24h). When the user selects
// 1H / 4H / 1D, or pans/zooms past the oldest loaded candle, the page's history loader fetches older
// GENUINE hourly swap candles strictly before a cursor (GET /api/token/chart-candles?timeframe=history).
// This module merges them:
//   - cutoff = the first whole hour at/after the scan's oldest candle. Everything from the cutoff on
//     comes from the scan's own candles (newer evidence always wins); history fills only hours before
//     the cutoff, so the scan's partial first hour is replaced by one complete history hour, never
//     double-counted.
//   - merge by timestamp, de-duplicated (an hour already held is never overwritten by a later, older
//     response), ascending. Hours with no trade stay absent — nothing is filled or interpolated.
//   - 1H / 4H / 1D are rebuilt from the merged hourly series (exact roll-ups); 5M / 15M are untouched.
//   - 15-MINUTE HISTORY (Uniswap V4 swap history with exact or fixed-block times): the same swaps bucketed
//     at 15 minutes instead of an hour. Every helper takes the history interval (default 1H); with 15M
//     history the cutoff/merge align to 15 minutes and 15M joins 1H / 4H / 1D as a history timeframe, so a
//     quiet pool's 15M is no longer limited to the scan's 24h read. Same reads, same genuine trades.

import { aggregateCandles, MIN_DERIVED_CANDLES, normalizeChartCandles, type ChartCandle, type ChartCandleInput, type ChartTimeframeKey, type ChartTimeframeSet } from './priceChartCandles.ts'

export const HISTORY_INTERVAL_SEC = 3600

/** How much history each long timeframe asks for (loads stop earlier when the pool is younger). */
export const HISTORY_TARGET_SPAN_SEC: Readonly<Record<'1H' | '4H' | '1D', number>> = {
  '1H': 3 * 86_400,
  '4H': 21 * 86_400,
  '1D': 60 * 86_400,
}
/**
 * 1D first batch: while the first history batch for 1D is loading, a daily series shorter than this
 * keeps the previously shown timeframe on screen (with the loading notice) instead of flashing a short
 * daily chart that the batch then replaces. A young pool whose history ends sooner shows exactly its
 * real days once the batch completes.
 */
export const DAILY_FIRST_BATCH_MIN_CANDLES = 30
/** Requests one user action may chain (selecting a timeframe); a pan to the left edge makes one. */
export const HISTORY_MAX_REQUESTS_PER_ACTION = 3

/** History bucket widths a source may serve: hourly (default) or 15-minute (exact-time V4 swaps). */
export type HistoryIntervalSec = 900 | 3600
export const FIFTEEN_MIN_HISTORY_INTERVAL_SEC: HistoryIntervalSec = 900
/** 15M asks for two days of genuine 15-minute history (192 buckets at most). */
export const HISTORY_TARGET_SPAN_15M_SEC = 2 * 86_400
export const normalizeHistoryIntervalSec = (sec: number | null | undefined): HistoryIntervalSec => (sec === 900 ? 900 : 3600)

/** Timeframes older history can fill: 1H / 4H / 1D, plus 15M when the history itself is 15-minute. */
export const isHistoryTimeframe = (key: ChartTimeframeKey | null, historySec: number = HISTORY_INTERVAL_SEC): key is '15M' | '1H' | '4H' | '1D' =>
  key === '1H' || key === '4H' || key === '1D' || (key === '15M' && historySec === 900)

/** Target span a history timeframe asks for (null for a timeframe history never fills). */
export function historyTargetSpanSec(key: ChartTimeframeKey | null): number | null {
  if (key === '15M') return HISTORY_TARGET_SPAN_15M_SEC
  return key === '1H' || key === '4H' || key === '1D' ? HISTORY_TARGET_SPAN_SEC[key] : null
}

/** First whole history bucket (1H default) at/after the oldest scan candle (ms), or null without candles. */
export function historyCutoffMs(native: ReadonlyArray<ChartCandle>, historySec: number = HISTORY_INTERVAL_SEC): number | null {
  if (native.length === 0) return null
  const ms = historySec * 1000
  return Math.ceil(native[0].t / ms) * ms
}

/** Adds older history candles: only whole buckets strictly before `cutoffMs`; existing buckets win; ascending. */
export function mergeHistoryCandles(existing: ReadonlyArray<ChartCandle>, incoming: ReadonlyArray<ChartCandle>, cutoffMs: number, historySec: number = HISTORY_INTERVAL_SEC): ChartCandle[] {
  const ms = historySec * 1000
  const byT = new Map<number, ChartCandle>()
  for (const c of existing) byT.set(c.t, c)
  for (const c of incoming) {
    if (c.t % ms !== 0 || c.t >= cutoffMs || byT.has(c.t)) continue
    byT.set(c.t, c)
  }
  return [...byT.values()].sort((a, b) => a.t - b.t)
}

/**
 * The scan's timeframes with every history timeframe rebuilt over history + scan candles (exact roll-ups
 * from the history interval). Unchanged without history, or when the scan's native interval does not
 * divide the history interval.
 */
export function withHistory(set: ChartTimeframeSet, history: ReadonlyArray<ChartCandle>, cutoffMs: number | null, historySec: number = HISTORY_INTERVAL_SEC): ChartTimeframeSet {
  const nativeSec = set.nativeSec
  if (history.length === 0 || cutoffMs == null || nativeSec == null || nativeSec > historySec || historySec % nativeSec !== 0) return set
  const recent = set.nativeCandles.filter((c) => c.t >= cutoffMs)
  const recentBuckets = nativeSec === historySec ? recent : aggregateCandles(recent, historySec)
  const merged = [...history.filter((c) => c.t < cutoffMs), ...recentBuckets]
  const timeframes = set.timeframes.map((tf) => {
    if (!isHistoryTimeframe(tf.key, historySec) || tf.sec < historySec || tf.sec % historySec !== 0) return tf
    const candles = tf.sec === historySec ? merged : aggregateCandles(merged, tf.sec)
    if (candles.length < MIN_DERIVED_CANDLES) return tf
    return { ...tf, available: true, origin: 'aggregated' as const, candles, unavailableReason: null }
  })
  return { ...set, timeframes }
}

/** Loaded span label, e.g. "24H loaded", "12D loaded". */
export function loadedSpanLabel(oldestMs: number, newestMs: number, intervalSec: number): string {
  const h = (newestMs - oldestMs + intervalSec * 1000) / 3_600_000
  if (!Number.isFinite(h) || h <= 0) return ''
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m loaded`
  if (h < 48) return `${Math.round(h)}h loaded`
  return `${Math.round(h / 24)}d loaded`
}

/** One on-demand history response (the page's loader shape). */
export type HistoryWindowResult =
  | { ok: true; points: ReadonlyArray<ChartCandleInput>; hasMore: boolean; nextBeforeSec: number | null; endReason?: string | null; /** Bucket width the server built (default 1H). */ intervalSec?: number | null }
  | { ok: false; message: string; hasMore?: boolean }

export type HistoryBatchOutcome = {
  candles: ChartCandle[]
  nextBeforeSec: number | null
  hasMore: boolean
  failedMessage: string | null
  requests: number
  /** Why paging ended in this batch: the server's evidence, or 'history_cursor_not_advancing'. Null while more remains. */
  endReason: string | null
}

/**
 * Runs up to `maxRequests` chained history requests (stopping early at `targetSpanSec` of coverage,
 * the end of history, or a failure) and merges them internally. The caller applies the outcome as
 * ONE visible update, so the chart does not re-layout after every intermediate response. The
 * request sequence and cursors are exactly those of issuing the requests one by one.
 */
export async function loadHistoryBatch(input: {
  start: { candles: ReadonlyArray<ChartCandle>; nextBeforeSec: number | null; hasMore: boolean }
  cutoffMs: number
  newestMs: number | null
  maxRequests: number
  targetSpanSec: number | null
  load: (beforeSec: number) => Promise<HistoryWindowResult>
  /** History bucket width expected from every response (default 1H). A response at another width is never merged. */
  intervalSec?: number
  /**
   * Checked after each merged response: true ends the batch there (more history stays loadable). The automatic
   * batch passes "the default view now reads as a chart", so it does not wait on further sequential provider
   * requests once the first one already made the chart readable.
   */
  stopWhen?: (candles: ReadonlyArray<ChartCandle>) => boolean
}): Promise<HistoryBatchOutcome> {
  const historySec = input.intervalSec ?? HISTORY_INTERVAL_SEC
  let candles: ChartCandle[] = [...input.start.candles]
  let nextBeforeSec = input.start.nextBeforeSec
  let hasMore = input.start.hasMore
  let requests = 0
  let endReason: string | null = null
  const requested = new Set<number>()
  const covered = () => (input.newestMs == null ? 0 : input.newestMs / 1000 - (nextBeforeSec ?? input.cutoffMs / 1000))
  for (let i = 0; i < input.maxRequests && hasMore; i++) {
    if (input.targetSpanSec != null && covered() >= input.targetSpanSec) break
    const before = nextBeforeSec ?? Math.floor(input.cutoffMs / 1000)
    // Never request the same window twice (belt and braces over the strictly-decreasing cursor).
    if (requested.has(before)) { hasMore = false; endReason = 'history_cursor_not_advancing'; break }
    requested.add(before)
    let res: HistoryWindowResult
    try {
      requests++
      res = await input.load(before)
    } catch {
      res = { ok: false, message: 'The history request did not complete.' }
    }
    if (!res.ok) return { candles, nextBeforeSec, hasMore: res.hasMore ?? hasMore, failedMessage: res.message, requests, endReason: null }
    // A response bucketed at another width would mix 15-minute and hourly candles in one series: stop, never merge.
    if (res.points.length > 0 && res.intervalSec != null && res.intervalSec !== historySec) {
      return { candles, nextBeforeSec, hasMore: false, failedMessage: 'Older candles came back at a different interval, so they were not merged.', requests, endReason: 'history_interval_mismatch' }
    }
    const next = res.nextBeforeSec
    candles = mergeHistoryCandles(candles, normalizeChartCandles(res.points), input.cutoffMs, historySec)
    if (res.hasMore && !(next != null && next < before)) {
      // "More" claimed but the cursor did not move back: stop instead of re-requesting a window.
      hasMore = false
      endReason = 'history_cursor_not_advancing'
    } else {
      hasMore = res.hasMore
      if (!hasMore) endReason = res.endReason ?? 'provider_end'
    }
    nextBeforeSec = next ?? nextBeforeSec
    if (hasMore && input.stopWhen?.(candles)) break
  }
  return { candles, nextBeforeSec, hasMore, failedMessage: null, requests, endReason }
}
