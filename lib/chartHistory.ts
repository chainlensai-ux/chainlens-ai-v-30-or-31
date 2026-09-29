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

import { aggregateCandles, MIN_DERIVED_CANDLES, normalizeChartCandles, type ChartCandle, type ChartCandleInput, type ChartTimeframeKey, type ChartTimeframeSet } from './priceChartCandles.ts'

export const HISTORY_INTERVAL_SEC = 3600
const HOUR_MS = HISTORY_INTERVAL_SEC * 1000

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

export const isHistoryTimeframe = (key: ChartTimeframeKey | null): key is '1H' | '4H' | '1D' => key === '1H' || key === '4H' || key === '1D'

/** First whole hour at/after the oldest scan candle (ms), or null without candles. */
export function historyCutoffMs(native: ReadonlyArray<ChartCandle>): number | null {
  if (native.length === 0) return null
  return Math.ceil(native[0].t / HOUR_MS) * HOUR_MS
}

/** Adds older hourly candles: only whole hours strictly before `cutoffMs`; existing hours win; ascending. */
export function mergeHistoryCandles(existing: ReadonlyArray<ChartCandle>, incoming: ReadonlyArray<ChartCandle>, cutoffMs: number): ChartCandle[] {
  const byT = new Map<number, ChartCandle>()
  for (const c of existing) byT.set(c.t, c)
  for (const c of incoming) {
    if (c.t % HOUR_MS !== 0 || c.t >= cutoffMs || byT.has(c.t)) continue
    byT.set(c.t, c)
  }
  return [...byT.values()].sort((a, b) => a.t - b.t)
}

/** The scan's timeframes with 1H / 4H / 1D rebuilt over history + scan candles. Unchanged without history. */
export function withHistory(set: ChartTimeframeSet, history: ReadonlyArray<ChartCandle>, cutoffMs: number | null): ChartTimeframeSet {
  const nativeSec = set.nativeSec
  if (history.length === 0 || cutoffMs == null || nativeSec == null || nativeSec > HISTORY_INTERVAL_SEC || HISTORY_INTERVAL_SEC % nativeSec !== 0) return set
  const recent = set.nativeCandles.filter((c) => c.t >= cutoffMs)
  const recentHourly = nativeSec === HISTORY_INTERVAL_SEC ? recent : aggregateCandles(recent, HISTORY_INTERVAL_SEC)
  const hourly = [...history.filter((c) => c.t < cutoffMs), ...recentHourly]
  const timeframes = set.timeframes.map((tf) => {
    if (!isHistoryTimeframe(tf.key)) return tf
    const candles = tf.sec === HISTORY_INTERVAL_SEC ? hourly : aggregateCandles(hourly, tf.sec)
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
  | { ok: true; points: ReadonlyArray<ChartCandleInput>; hasMore: boolean; nextBeforeSec: number | null; endReason?: string | null }
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
}): Promise<HistoryBatchOutcome> {
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
    const next = res.nextBeforeSec
    candles = mergeHistoryCandles(candles, normalizeChartCandles(res.points), input.cutoffMs)
    if (res.hasMore && !(next != null && next < before)) {
      // "More" claimed but the cursor did not move back: stop instead of re-requesting a window.
      hasMore = false
      endReason = 'history_cursor_not_advancing'
    } else {
      hasMore = res.hasMore
      if (!hasMore) endReason = res.endReason ?? 'provider_end'
    }
    nextBeforeSec = next ?? nextBeforeSec
  }
  return { candles, nextBeforeSec, hasMore, failedMessage: null, requests, endReason }
}
