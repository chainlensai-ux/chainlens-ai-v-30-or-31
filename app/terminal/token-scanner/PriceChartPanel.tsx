'use client'

// Token Scanner → Market → Price Chart. Trading-terminal style candlestick chart rendered as plain
// SVG at the container's real pixel width (no viewBox scaling, so axis text stays legible on
// mobile). Candle logic — validation, exact timeframe roll-ups, formatting — lives in
// lib/priceChartCandles.ts; this file only draws. It renders REAL returned OHLCV only: candles are
// spaced by index (buckets with no trades are collapsed, never filled), and a timeframe the data
// cannot genuinely produce is shown disabled rather than falling back to another timeframe's candles.

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  buildChartTimeframes,
  clampViewport,
  defaultViewport,
  formatChartPct,
  formatChartPrice,
  chartTimeIsUtc,
  formatChartTime,
  formatChartVolume,
  formatIntervalLabel,
  niceTicks,
  normalizeChartCandles,
  pctChange,
  panViewport,
  pickDefaultTimeframe,
  sameViewport,
  timeTickIndices,
  zoomViewport,
  type ChartCandle,
  type ChartCandleInput,
  type ChartTimeframeKey,
  type ChartViewport,
} from '@/lib/priceChartCandles'
import { candleGeometry, robustPriceDomain, volumePaneHeight } from '@/lib/chartGeometry'
import { formatCompactUsd, marketCapBasisLabel, scaleCandlesToMarketCap, type ChartMarketCapBasis } from '@/lib/chartMarketCap'
import {
  DAILY_FIRST_BATCH_MIN_CANDLES,
  HISTORY_MAX_REQUESTS_PER_ACTION,
  HISTORY_TARGET_SPAN_SEC,
  historyCutoffMs,
  isHistoryTimeframe,
  loadHistoryBatch,
  loadedSpanLabel,
  withHistory,
  type HistoryWindowResult,
} from '@/lib/chartHistory'
import {
  assessTimeframeQuality,
  assessTimeframeSet,
  lineChartXs,
  buildSparseLineSegments,
  nearestCandleIndex,
  planAutoHistory,
  AUTO_HISTORY_MAX_REQUESTS,
  resolveCoverageWindow,
  type ChartCoverageMeta,
  formatSpanShort,
  isPresentationUsable,
  restingCandleTarget,
  selectPresentationTimeframe,
  sparseTimeframeTooltip,
  type TimeframeQuality,
} from '@/lib/chartQuality'

const C = {
  panel: '#070d19',
  border: 'rgba(148,163,184,0.10)',
  grid: 'rgba(148,163,184,0.07)',
  axisText: '#64748b',
  text: '#cbd5e1',
  textStrong: '#e2e8f0',
  muted: '#475569',
  bull: '#22b8a6',
  bear: '#e0626c',
  bullVol: 'rgba(34,184,166,0.38)',
  bearVol: 'rgba(224,98,108,0.38)',
  crosshair: 'rgba(148,163,184,0.45)',
  tagBg: '#1e293b',
}
const MONO = 'var(--font-plex-mono), ui-monospace, SFMono-Regular, Menlo, monospace'

export type PriceChartPanelProps = {
  candles: ReadonlyArray<ChartCandleInput>
  /** Interval the candles were requested at, in seconds (null = infer from the real timestamps). */
  declaredIntervalSec: number | null
  /** Header badge. Defaults to "Live Candles"; pass e.g. a reconstruction notice for non-indexed sources. */
  badge?: ReactNode
  /** Small caption under the chart (e.g. which pool the candles come from). */
  footnote?: ReactNode
  /**
   * Loads REAL 5M candles on demand (only when the user selects 5M). Omit when the source has no
   * proven pool to read 5M from — 5M then stays disabled with its reason.
   */
  loadFiveMinute?: () => Promise<FiveMinuteLoadResult>
  /**
   * Trusted circulating supply for MCAP mode (lib/chartMarketCap.ts resolveChartMarketCapSupply).
   * Null keeps the chart in PRICE with MCAP disabled for `marketCapUnavailableReason`.
   */
  marketCapSupply?: number | null
  marketCapUnavailableReason?: string | null
  /** Which MCAP basis `marketCapSupply` is: verified circulating supply, or inferred from verified current MC ÷ price. */
  marketCapBasis?: ChartMarketCapBasis | null
  /**
   * Loads OLDER genuine hourly candles strictly before `beforeSec` (lib/chartHistory.ts). Called only
   * after the user selects 1H / 4H / 1D or pans/zooms past the oldest loaded candle. Omit when the
   * source has no on-demand history.
   */
  loadHistory?: (beforeSec: number) => Promise<HistoryLoadResult>
  /** What the loaded candles are, for the "24h loaded · real V4 swaps" line (null hides it). */
  historySourceLabel?: string | null
  /** Admin ?debug=1 scans only: shows per-timeframe presentation quality and why the timeframe was chosen. */
  debug?: boolean
  /** When the scan's candles were received (epoch ms) — the reference for the stale-data rule. Null disables it. */
  referenceTimeMs?: number | null
  /** False when native 5M timestamps are inferred/interpolated (V4 swaps without exact log times): 5M is never auto-selected. */
  fiveMinuteExactTime?: boolean
  /** The window the scan's candle request covered (lib/chartQuality.ts) — quality is judged against it, not just first->last candle. */
  coverage?: ChartCoverageMeta | null
}

export type HistoryLoadResult = HistoryWindowResult

export type ChartValueMode = 'MCAP' | 'PRICE'

// Callback-ref width tracker: re-attaches when the measured element changes (empty state -> chart).
function useElementWidth<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!el) return
    const measure = () => {
      const w = el.getBoundingClientRect().width
      if (Number.isFinite(w)) setWidth(Math.round(w))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, width] as const
}

const fmtTime = formatChartTime

function fmtSpan(ms: number): string {
  const h = ms / 3_600_000
  if (!Number.isFinite(h) || h <= 0) return ''
  if (h < 1) return `${Math.round(h * 60)}M`
  if (h < 48) return `${Math.round(h)}H`
  return `${Math.round(h / 24)}D`
}

export type FiveMinuteLoadResult =
  | { ok: true; intervalSec: number; points: ReadonlyArray<ChartCandleInput>; coverage?: ChartCoverageMeta | null }
  | { ok: false; message: string }

type FiveMinuteState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; candles: ChartCandle[]; coverage: ChartCoverageMeta | null }
  | { status: 'failed'; message: string }

type ChipState = { key: ChartTimeframeKey; available: boolean; loadable: boolean; reason: string | null; title: string; sparse?: boolean }

type HistoryState = { candles: ChartCandle[]; nextBeforeSec: number | null; hasMore: boolean; status: 'idle' | 'loading' | 'failed'; message: string | null; endReason?: string | null }

const IDLE_FIVE: FiveMinuteState = { status: 'idle' }
const IDLE_HISTORY: HistoryState = { candles: [], nextBeforeSec: null, hasMore: true, status: 'idle', message: null }
const FIVE_MIN_SEC = 300

export default function PriceChartPanel({ candles, declaredIntervalSec, badge, footnote, loadFiveMinute, marketCapSupply, marketCapUnavailableReason, marketCapBasis, loadHistory, historySourceLabel, debug, referenceTimeMs, fiveMinuteExactTime, coverage }: PriceChartPanelProps) {
  const normalized = useMemo(() => normalizeChartCandles(candles), [candles])
  const scanSet = useMemo(() => buildChartTimeframes(normalized, declaredIntervalSec), [normalized, declaredIntervalSec])
  // PRESENTATION QUALITY (lib/chartQuality.ts): "has >= 2 genuine buckets" only means the data exists.
  // The default is the finest timeframe whose genuine candles read as a coherent chart; a sparse one
  // (e.g. 7 x 15M across 13 days) is never the default. Decided from the SCAN's own candles only — so
  // history loaded later never flips the default mid-view — with zero extra requests.
  // LOADED WINDOW: the scan request's own window (limit x interval ending at the answer time, pool
  // creation when known) — a burst of candles is judged against what was loaded, not its own span.
  const scanWindow = useMemo(() => resolveCoverageWindow(coverage ?? null), [coverage])
  const poolCreatedMs = coverage?.poolCreatedSec != null ? coverage.poolCreatedSec * 1000 : null
  const qualityOpts = useMemo(() => ({ referenceMs: referenceTimeMs ?? null, fiveMinuteExactTime: fiveMinuteExactTime !== false, coverageFor: () => scanWindow, poolCreatedMs }), [referenceTimeMs, fiveMinuteExactTime, scanWindow, poolCreatedMs])
  const scanQuality = useMemo(() => assessTimeframeSet(scanSet, qualityOpts), [scanSet, qualityOpts])

  // On-demand OLDER history (hourly, genuine swaps), merged under the scan's candles for 1H / 4H / 1D.
  // Tied to the `candles` array it was loaded for, so a new scan starts from idle.
  const [histRaw, setHistRaw] = useState<{ source: ReadonlyArray<ChartCandleInput>; state: HistoryState } | null>(null)
  const hist: HistoryState = histRaw && histRaw.source === candles ? histRaw.state : IDLE_HISTORY
  const cutoffMs = useMemo(() => historyCutoffMs(normalized), [normalized])
  const tfSet = useMemo(() => withHistory(scanSet, hist.candles, cutoffMs), [scanSet, hist.candles, cutoffMs])
  const historyEnabled = loadHistory != null && cutoffMs != null && scanSet.nativeSec != null && scanSet.nativeSec <= 3600
  const historyBusy = useRef(false)
  const newestMs = normalized.length > 0 ? normalized[normalized.length - 1].t : null
  const historyCoveredSec = (h: HistoryState) => (newestMs == null || cutoffMs == null ? 0 : newestMs / 1000 - (h.nextBeforeSec ?? cutoffMs / 1000))
  const canLoadOlder = historyEnabled && hist.hasMore && hist.status !== 'loading'
  const historyCoverage = (histCandles: ReadonlyArray<ChartCandle>) => (key: ChartTimeframeKey) =>
    (scanWindow && isHistoryTimeframe(key) && histCandles.length > 0 ? { startMs: Math.min(scanWindow.startMs, histCandles[0].t), endMs: scanWindow.endMs } : scanWindow)
  // READABLE DEFAULT: when the chosen default still needs older genuine history to read as a chart, ONE
  // bounded batch is loaded automatically (planAutoHistory). The default is then re-chosen ONCE over that
  // snapshot — later pans/loads never flip it — so the view settles in a single stable update.
  const [autoSnap, setAutoSnap] = useState<{ source: ReadonlyArray<ChartCandleInput>; candles: ChartCandle[] } | null>(null)
  const autoHist = autoSnap && autoSnap.source === candles ? autoSnap.candles : null
  const defaultQuality = useMemo(
    () => (autoHist && autoHist.length > 0 ? assessTimeframeSet(withHistory(scanSet, autoHist, cutoffMs), { ...qualityOpts, coverageFor: historyCoverage(autoHist) }) : scanQuality),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- historyCoverage is a pure function of scanWindow
    [autoHist, scanSet, cutoffMs, qualityOpts, scanQuality, scanWindow],
  )
  const autoSelection = useMemo(() => selectPresentationTimeframe(defaultQuality), [defaultQuality])
  const defaultKey = useMemo(() => autoSelection.key ?? pickDefaultTimeframe(scanSet), [autoSelection, scanSet])
  // Current (history-aware) quality per available timeframe, for chip states and status copy.
  // With older history merged, 1H / 4H / 1D cover from the oldest genuine history candle to the scan's end.
  const tfQuality = useMemo(
    () => assessTimeframeSet(tfSet, { ...qualityOpts, coverageFor: historyCoverage(hist.candles) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- historyCoverage is a pure function of scanWindow
    [tfSet, qualityOpts, scanWindow, hist.candles],
  )
  const clearerThan = (key: ChartTimeframeKey): ChartTimeframeKey | null => {
    const order: ChartTimeframeKey[] = ['5M', '15M', '1H', '4H', '1D']
    return order.slice(order.indexOf(key) + 1).find((k) => { const q = tfQuality[k]; return q != null && isPresentationUsable(q.quality) }) ?? null
  }
  const [picked, setPicked] = useState<ChartTimeframeKey | null>(null)
  // Why an unavailable interval is off. Shown on tap/click (not only as a hover title) so the
  // reason reaches touch users too.
  const [chipNotice, setChipNotice] = useState<{ key: ChartTimeframeKey; text: string } | null>(null)

  // On-demand real 5M candles (never derived from 15M). Tied to the `candles` array it was loaded
  // for, so a new scan starts from idle without an effect.
  const [fiveRaw, setFiveRaw] = useState<{ source: ReadonlyArray<ChartCandleInput>; state: FiveMinuteState } | null>(null)
  const five: FiveMinuteState = fiveRaw && fiveRaw.source === candles ? fiveRaw.state : IDLE_FIVE
  const nativeFive = tfSet.timeframes.find((tf) => tf.key === '5M')!
  const fiveLoadable = !nativeFive.available && loadFiveMinute != null && (tfSet.nativeSec ?? 0) > FIVE_MIN_SEC
  // On-demand 5M is judged like every other timeframe, against ITS OWN request window (never skipped).
  const fiveQuality = useMemo(() => (five.status === 'ready' && five.candles.length > 0
    ? assessTimeframeQuality(five.candles, FIVE_MIN_SEC, { timeframe: '5M', referenceMs: referenceTimeMs ?? null, coverage: resolveCoverageWindow(five.coverage, poolCreatedMs), poolCreatedMs })
    : null), [five, referenceTimeMs, poolCreatedMs])

  const chipStates: ChipState[] = tfSet.timeframes.map((tf) => {
    if (tf.key === '5M' && fiveLoadable) {
      if (five.status === 'failed') return { key: tf.key, available: false, loadable: false, reason: `5M unavailable — ${five.message}`, title: five.message }
      if (five.status === 'ready' && five.candles.length < 2) return { key: tf.key, available: false, loadable: false, reason: '5M unavailable — the pool returned no 5-minute trading history yet', title: 'No 5M history yet' }
      const fiveSparse = fiveQuality != null && !isPresentationUsable(fiveQuality.quality)
      return { key: tf.key, available: true, loadable: five.status !== 'ready', reason: null, sparse: fiveSparse, title: five.status === 'loading' ? 'Loading real 5M candles…' : fiveSparse ? sparseTimeframeTooltip(fiveQuality!, clearerThan('5M')) : five.status === 'ready' ? `${five.candles.length} real 5M candles` : 'Load real 5M candles for this pool' }
    }
    if (!tf.available && historyEnabled && isHistoryTimeframe(tf.key) && hist.hasMore && hist.status !== 'failed') {
      return { key: tf.key, available: true, loadable: true, reason: null, title: hist.status === 'loading' ? 'Loading older candles…' : `Load older real ${tf.key} candles for this pool` }
    }
    // Data available but not presentation-usable: still selectable (the genuine candles stay reachable),
    // but dimmed and explained — never presented like normal chart coverage.
    const q = tfQuality[tf.key]
    const sparse = tf.available && q != null && !isPresentationUsable(q.quality)
    return {
      key: tf.key,
      available: tf.available,
      loadable: false,
      reason: tf.available ? null : (tf.unavailableReason ?? 'Needs more trading history'),
      title: sparse ? sparseTimeframeTooltip(q!, clearerThan(tf.key)) : tf.available ? `${tf.candles.length} real ${tf.key} candles${tf.origin === 'aggregated' ? ' (rolled up from finer real candles)' : ''}` : (tf.unavailableReason ?? 'Needs more trading history'),
      sparse,
    }
  })

  // A pick that is no longer available (new scan data) falls back to the default — never to
  // another timeframe's candles under the picked label.
  const fiveActive = picked === '5M' && fiveLoadable && five.status === 'ready' && five.candles.length >= 2
  // 1D picked while its first history batch loads, with fewer daily candles than a useful daily chart
  // (e.g. the scan's ~7 days): keep showing the timeframe that was on screen (with "Loading older
  // candles…") instead of flashing that short 1D chart and then replacing it. 1D appears once the
  // batch is applied (or fails) — one stable update.
  const [dailyDefer, setDailyDefer] = useState<{ source: ReadonlyArray<ChartCandleInput>; fallback: ChartTimeframeKey | null } | null>(null)
  const dailyCandleCount = tfSet.timeframes.find((tf) => tf.key === '1D')?.candles.length ?? 0
  const deferDaily = picked === '1D' && hist.status === 'loading' && dailyDefer != null && dailyDefer.source === candles && dailyCandleCount < DAILY_FIRST_BATCH_MIN_CANDLES
  const shownPick = deferDaily ? dailyDefer!.fallback : picked
  const activeTf = fiveActive ? null : (tfSet.timeframes.find((tf) => tf.key === shownPick && tf.available) ?? tfSet.timeframes.find((tf) => tf.key === defaultKey) ?? null)
  const activeKey: ChartTimeframeKey | null = fiveActive ? '5M' : (activeTf?.key ?? null)
  const priceSeries: ChartCandle[] = fiveActive && five.status === 'ready' ? five.candles : activeTf ? activeTf.candles : tfSet.nativeCandles
  // MCAP / PRICE: a view over the SAME candles (O/H/L/C × trusted circulating supply; volume
  // unchanged). The choice is tied to this scan's candle set, so a new scan starts from its default
  // and toggling never refetches or rescans.
  const mcapAvailable = marketCapSupply != null && Number.isFinite(marketCapSupply) && marketCapSupply > 0
  const [modeRaw, setModeRaw] = useState<{ source: ReadonlyArray<ChartCandleInput>; mode: ChartValueMode } | null>(null)
  const valueMode: ChartValueMode = !mcapAvailable ? 'PRICE' : modeRaw && modeRaw.source === candles ? modeRaw.mode : 'MCAP'
  const series: ChartCandle[] = valueMode === 'MCAP' ? scaleCandlesToMarketCap(priceSeries, marketCapSupply!) : priceSeries
  const fmtValue = (v: number, digits?: number) => (valueMode === 'MCAP' ? formatCompactUsd(v, 2) : formatChartPrice(v, digits))
  const mcapBasisInfo = marketCapBasisLabel(marketCapBasis ?? 'circulating_supply')
  const intervalSec = fiveActive ? FIVE_MIN_SEC : activeTf ? activeTf.sec : tfSet.nativeSec
  // Quality of what is on screen (PRICE candles; MCAP is the same series scaled, so the same verdict).
  const activeQuality: TimeframeQuality | null = fiveActive ? fiveQuality : activeKey ? (tfQuality[activeKey] ?? null) : null
  const userPicked = picked != null && activeKey === picked
  const selectionReason = userPicked ? `user_selected_${activeKey!.toLowerCase()}` : autoSelection.reason
  const fromQ = autoSelection.fallbackFrom ? defaultQuality[autoSelection.fallbackFrom] : null
  const qualityNote: string | null = activeQuality && !isPresentationUsable(activeQuality.quality)
    ? `Sparse trading — ${activeQuality.candleCount} genuine ${activeKey} candle${activeQuality.candleCount === 1 ? '' : 's'} across ${activeQuality.coverageKnown ? `the loaded ${formatSpanShort(activeQuality.coverageSpanSec ?? activeQuality.spanSec)}` : formatSpanShort(activeQuality.spanSec)}${!userPicked ? '' : clearerThan(activeKey!) ? ` · ${clearerThan(activeKey!)} reads clearer` : ''}`
    : !userPicked && fromQ && activeKey
      ? `${autoSelection.fallbackFrom} sparse · ${fromQ.candleCount} genuine candles across ${formatSpanShort(fromQ.spanSec)} — ${activeKey} selected for clearer history`
      : null

  const requestFive = async () => {
    if (!loadFiveMinute || five.status === 'loading') return
    const source = candles
    setFiveRaw({ source, state: { status: 'loading' } })
    setChipNotice({ key: '5M', text: 'Loading real 5M candles…' })
    let next: FiveMinuteState
    try {
      const res = await loadFiveMinute()
      next = res.ok ? { status: 'ready', candles: normalizeChartCandles(res.points), coverage: res.coverage ?? null } : { status: 'failed', message: res.message }
    } catch {
      next = { status: 'failed', message: 'The 5M candle request did not complete.' }
    }
    setFiveRaw((cur) => (cur && cur.source === source ? { source, state: next } : cur))
    if (next.status === 'ready' && next.candles.length >= 2) {
      setChipNotice(null)
      setPicked('5M')
    } else {
      setChipNotice({ key: '5M', text: next.status === 'failed' ? `5M unavailable — ${next.message}` : '5M unavailable — the pool returned no 5-minute trading history yet' })
    }
  }

  // Older history: a timeframe pick may chain up to 3 bounded requests toward that timeframe's target
  // span; reaching the left edge makes one; the readable-default rule below makes at most one automatic
  // batch per scan. Never auto-retried.
  const requestHistory = async (maxRequests: number, targetSpanSec: number | null, auto = false) => {
    if (!loadHistory || cutoffMs == null || historyBusy.current || !hist.hasMore) return
    historyBusy.current = true
    const source = candles
    setHistRaw({ source, state: { ...hist, status: 'loading', message: null } })
    // The chained responses are merged inside loadHistoryBatch and applied as ONE update below, so
    // the chart keeps its current view (with "Loading older candles…") instead of re-laying out
    // after every intermediate response. Same requests, same cursors.
    let done: HistoryState
    try {
      const out = await loadHistoryBatch({ start: hist, cutoffMs, newestMs, maxRequests, targetSpanSec, load: loadHistory })
      done = { candles: out.candles, nextBeforeSec: out.nextBeforeSec, hasMore: out.hasMore, status: out.failedMessage ? 'failed' : 'idle', message: out.failedMessage, endReason: out.endReason }
    } catch {
      done = { ...hist, status: 'failed', message: 'The history request did not complete.' }
    }
    setHistRaw((cur) => (cur && cur.source === source ? { source, state: done } : cur))
    if (auto) setAutoSnap({ source, candles: done.candles })
    historyBusy.current = false
  }
  // Once per scan (keyed by the candle array): load what the default needs to read as a chart.
  const autoPlan = planAutoHistory({ defaultKey, defaultQuality: defaultKey ? (scanQuality[defaultKey] ?? null) : null, historyEnabled, hasMore: hist.hasMore })
  const autoRan = useRef<ReadonlyArray<ChartCandleInput> | null>(null)
  useEffect(() => {
    if (autoRan.current === candles || !autoPlan.load || !autoPlan.key || picked != null) return
    autoRan.current = candles
    void requestHistory(AUTO_HISTORY_MAX_REQUESTS, HISTORY_TARGET_SPAN_SEC[autoPlan.key], true)
  })
  const loadOlderAtLeftEdge = () => {
    if (canLoadOlder && hist.status !== 'failed' && isHistoryTimeframe(activeKey)) void requestHistory(1, null)
  }

  const [wrapRef, width] = useElementWidth<HTMLDivElement>()
  const [hover, setHover] = useState<{ idx: number; y: number } | null>(null)
  const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null)

  const compact = width > 0 && width < 560
  const enough = series.length >= 2

  // ── Layout ────────────────────────────────────────────────────────────────────────────────────
  const hasVolume = series.some((c) => c.volume != null && c.volume > 0)
  const W = Math.max(width, 280)
  // Right axis sized to its widest label (tiny prices like $0.0₅4213 need more room than $1.23).
  const axisCharW = 6.6
  let widestLabel = 0
  for (const c of series.slice(-200)) {
    widestLabel = Math.max(widestLabel, fmtValue(c.high, 4).length, fmtValue(c.low, 4).length)
  }
  const axisW = Math.min(110, Math.max(56, Math.ceil(widestLabel * axisCharW + 14)))
  const plotW = W - axisW
  const priceH = compact ? 220 : 310
  // Dedicated volume pane: a proportional share of the price pane, clearly separated from it.
  const volGap = hasVolume ? 14 : 0
  const volH = volumePaneHeight(priceH, hasVolume)
  const timeAxisH = 22
  const priceTop = 8
  const priceBot = priceTop + priceH
  const volTop = priceBot + (hasVolume ? volGap : 0)
  const volBot = volTop + volH
  const H = volBot + timeAxisH

  // ── Viewport (zoom / pan over loaded candles only) ───────────────────────────────────────────
  // Resting view: the newest candles that fit at a readable minimum width. The user can zoom out to
  // every loaded candle, or in to MIN_VIEW_CANDLES. The view is tied to the series it was set on,
  // so a timeframe switch or new scan returns to the resting view.
  // Resting view: ~40 (phone) to ~100 (desktop) of the newest candles — a readable trading-chart density.
  const fit = restingCandleTarget(plotW, compact)
  const total = series.length
  // Keyed by timeframe + newest candle: older history prepended to the same series shifts the view by
  // the number of added candles, so the candles the user is looking at stay in place.
  const seriesKey = `${activeKey ?? 'native'}:${series[series.length - 1]?.t ?? 0}`
  const restView = defaultViewport(total, fit)
  // Also tied to the scan's candle array: a new scan (even with the same timeframe and newest candle)
  // always starts from its own resting view, never a previous token's zoom.
  const [viewRaw, setViewRaw] = useState<{ key: string; source: ReadonlyArray<ChartCandleInput>; view: ChartViewport; total: number } | null>(null)
  const viewValid = viewRaw != null && viewRaw.key === seriesKey && viewRaw.source === candles
  const prepended = viewValid ? Math.max(0, total - viewRaw!.total) : 0
  const view = viewValid ? clampViewport({ start: viewRaw!.view.start + prepended, end: viewRaw!.view.end + prepended }, total) : restView
  const isRest = sameViewport(view, restView)
  const setView = (v: ChartViewport) => {
    const next = clampViewport(v, total)
    setViewRaw({ key: seriesKey, source: candles, view: next, total })
    if (next.start === 0) loadOlderAtLeftEdge()
  }
  const resetView = () => { setViewRaw(null); setHover(null) }

  const data = enough ? series.slice(view.start, view.end) : []
  const n = data.length
  // A short series is drawn at a fixed minimum slot count, right-aligned (newest at the right edge), so
  // a handful of candles is not stretched across the whole plot. Candle order is untouched.
  // SPARSE VIEW: a timeframe that is not presentation-usable (only reachable by choosing it) is drawn as a
  // line/area through its REAL closes, spaced by real time, with a dot on every genuine observation —
  // never as a handful of floating candle bars.
  const lineMode = activeQuality != null && !isPresentationUsable(activeQuality.quality) && data.length >= 2
  const lineXs = lineMode ? lineChartXs(data.map((c) => c.t), plotW) : null
  // Continuity segments: real closes join only across gaps the timeframe's threshold allows; the line AND
  // its area break at every larger gap, and an isolated candle is a marker only.
  const sparseLine = lineMode ? buildSparseLineSegments(data, intervalSec) : null
  // Candles: TradingView-style bar spacing from the VISIBLE count (lib/chartGeometry.ts) — a short series
  // fills ~82% of the plot (capped per bar), a long/zoomed one fills it, newest at the right with a modest
  // offset; index-spaced, so no fake future timestamps and no empty timeline.
  const geo = candleGeometry(data.length, total, plotW)
  const layout = lineXs ? { slot: 1, pos: lineXs.map((x) => x - 0.5), mode: 'time' as const } : { slot: geo.spacing || 1, pos: geo.xs.map((x) => x / (geo.spacing || 1) - 0.5), mode: 'index' as const }
  const slot = layout.slot
  const bodyW = lineMode ? 4 : geo.bodyW
  const xC = (i: number) => ((layout.pos[i] ?? i) + 0.5) * slot

  // Wheel / trackpad: vertical wheel zooms around the cursor, horizontal swipe pans. Needs a
  // non-passive native listener so the page does not scroll while the cursor is on the chart.
  useEffect(() => {
    if (!svgEl || !enough) return
    const onWheel = (e: WheelEvent) => {
      const rect = svgEl.getBoundingClientRect()
      const x = e.clientX - rect.left
      if (x < 0 || x > plotW) return
      e.preventDefault()
      const width0 = view.end - view.start
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        setView(panViewport(view, total, (e.deltaX / plotW) * width0))
      } else {
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022))
        setView(zoomViewport(view, total, factor, x / plotW))
      }
      setHover(null)
    }
    svgEl.addEventListener('wheel', onWheel, { passive: false })
    return () => svgEl.removeEventListener('wheel', onWheel)
  })

  // Pointer gestures. Mouse: move = crosshair, press-drag = pan. Touch: tap = crosshair, horizontal
  // drag = pan, two fingers = pinch zoom. touch-action: pan-y leaves vertical page scrolling to the
  // browser, so a vertical swipe over the chart still scrolls the page.
  const gesture = useRef<{
    pointers: Map<number, { x: number; y: number }>
    dragStartX: number | null
    dragStartView: ChartViewport | null
    panning: boolean
    pinchStartDist: number | null
    pinchStartView: ChartViewport | null
  }>({ pointers: new Map(), dragStartX: null, dragStartView: null, panning: false, pinchStartDist: null, pinchStartView: null })

  if (!enough) {
    return (
      <div ref={wrapRef} style={{ marginBottom: '16px', borderRadius: '14px', padding: '14px 16px', background: C.panel, border: `1px solid ${C.border}` }}>
        <PanelHeader badge={badge} />
        <p style={{ margin: 0, fontSize: '12px', color: C.axisText, fontFamily: MONO, lineHeight: 1.6 }}>
          {normalized.length === 0 ? 'Candle history returned no valid OHLC rows for this pool.' : 'Not enough real candles returned to draw a chart yet.'}
        </p>
      </div>
    )
  }

  // Robust autoscale from the VISIBLE candles (recomputed every render: timeframe, PRICE/MCAP, resize and
  // new scans never keep an old domain). One extreme wick no longer squeezes the rest into a strip — it is
  // drawn to the edge and its TRUE value is flagged; the candle's OHLC is never changed.
  const domain = robustPriceDomain(data)
  const yMin = domain.min
  const yMax = domain.max
  const yP = (v: number) => priceTop + ((yMax - v) / (yMax - yMin)) * priceH
  const vFromY = (y: number) => yMax - ((y - priceTop) / priceH) * (yMax - yMin)
  const { ticks: yTicks } = niceTicks(yMin, yMax, compact ? 4 : 6)
  const maxVol = hasVolume ? Math.max(...data.map((c) => c.volume ?? 0)) : 0

  // Daily buckets are UTC days, so daily ticks and labels use UTC too (formatChartTime); finer
  // intervals keep the viewer's local clock.
  const tzOffset = chartTimeIsUtc(intervalSec) ? 0 : new Date(data[n - 1].t).getTimezoneOffset()
  const xTickIdx = timeTickIndices(data, Math.ceil((compact ? 64 : 84) / slot), tzOffset)

  const first = data[0]
  const last = data[n - 1]
  const latest = series[series.length - 1]
  const windowChange = pctChange(first.open, last.close)
  const windowSpan = fmtSpan(last.t - first.t + (intervalSec ?? 0) * 1000)
  const lastBull = latest.close >= latest.open
  const lastY = yP(latest.close)
  const lastInView = latest.close >= yMin && latest.close <= yMax

  const hoverC = hover != null && hover.idx < n ? data[hover.idx] : null
  const readout = hoverC ?? last
  const readoutChange = pctChange(readout.open, readout.close)
  const readoutColor = readout.close >= readout.open ? C.bull : C.bear

  const localPoint = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }
  const setCrosshair = (x: number, y: number) => {
    if (x < 0 || x > plotW || y < 0 || y > volBot) { setHover(null); return }
    setHover({ idx: Math.max(0, Math.min(n - 1, nearestCandleIndex(x, layout))), y })
  }
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const g = gesture.current
    const p = localPoint(e)
    g.pointers.set(e.pointerId, p)
    if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()]
      g.pinchStartDist = Math.max(1, Math.abs(a.x - b.x))
      g.pinchStartView = view
      g.dragStartX = null
      g.panning = false
      setHover(null)
      return
    }
    g.dragStartX = p.x
    g.dragStartView = view
    g.panning = false
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* not all pointers can be captured */ }
    setCrosshair(p.x, p.y)
  }
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const g = gesture.current
    const p = localPoint(e)
    if (g.pointers.has(e.pointerId)) g.pointers.set(e.pointerId, p)
    if (g.pointers.size >= 2 && g.pinchStartDist != null && g.pinchStartView) {
      const [a, b] = [...g.pointers.values()]
      const dist = Math.max(1, Math.abs(a.x - b.x))
      const mid = (a.x + b.x) / 2
      setView(zoomViewport(g.pinchStartView, total, dist / g.pinchStartDist, Math.max(0, Math.min(1, mid / plotW))))
      return
    }
    const pressed = e.pointerType === 'mouse' ? (e.buttons & 1) === 1 : g.pointers.has(e.pointerId)
    if (pressed && g.dragStartX != null && g.dragStartView) {
      const dx = p.x - g.dragStartX
      if (g.panning || Math.abs(dx) > 6) {
        g.panning = true
        const startWidth = g.dragStartView.end - g.dragStartView.start
        setView(panViewport(g.dragStartView, total, (-dx / plotW) * startWidth))
        setHover(null)
        return
      }
    }
    if (e.pointerType === 'mouse' || !g.panning) setCrosshair(p.x, p.y)
  }
  const endPointer = (e: ReactPointerEvent<SVGSVGElement>) => {
    const g = gesture.current
    g.pointers.delete(e.pointerId)
    if (g.pointers.size < 2) { g.pinchStartDist = null; g.pinchStartView = null }
    if (g.pointers.size === 0) { g.dragStartX = null; g.dragStartView = null; g.panning = false }
  }

  const tagH = 17
  const priceTag = (y: number, label: string, bg: string, fg: string) => (
    <g>
      <rect x={plotW + 1} y={y - tagH / 2} width={axisW - 2} height={tagH} rx={2} fill={bg} />
      <text x={plotW + 6} y={y + 3.8} fill={fg} style={{ fontSize: 10.5, fontFamily: MONO, fontWeight: 600 }}>{label}</text>
    </g>
  )

  const noticeVisible = chipNotice != null && (chipNotice.key === '5M' && five.status === 'loading'
    ? true
    : chipStates.some((c) => c.key === chipNotice.key && !c.available))

  const chips = (
    <div role="group" aria-label="Candle interval" style={{ display: 'inline-flex', gap: '2px', padding: '2px', borderRadius: '8px', background: 'rgba(15,23,42,0.9)', border: `1px solid ${C.border}` }}>
      {!tfSet.nativeIsStandard && tfSet.nativeSec != null && (
        <span title="Candles rebuilt from real recent swaps at this bucket width" style={{ padding: '4px 9px', borderRadius: '6px', fontSize: '10.5px', fontWeight: 700, fontFamily: MONO, color: C.textStrong, background: 'rgba(45,212,191,0.14)' }}>
          {formatIntervalLabel(tfSet.nativeSec)}
        </span>
      )}
      {chipStates.map((chip) => {
        const active = activeKey === chip.key
        const loading = (chip.key === '5M' && five.status === 'loading') || (chip.loadable && isHistoryTimeframe(chip.key) && hist.status === 'loading') || (chip.key === '1D' && deferDaily)
        return (
          <button
            key={chip.key}
            type="button"
            // aria-disabled (not disabled): an unavailable chip stays focusable and tappable so its
            // reason can be read on touch devices and by screen readers — it never selects data.
            aria-disabled={!chip.available}
            aria-pressed={active}
            aria-busy={loading || undefined}
            aria-label={chip.available ? `${chip.key} candles${chip.loadable ? ' (loads on demand)' : ''}${chip.sparse ? ' (sparse)' : ''}` : `${chip.key} unavailable: ${chip.reason ?? 'Needs more trading history'}`}
            title={chip.title}
            onClick={() => {
              if (!chip.available) {
                const reason = chip.reason ?? 'Needs more trading history'
                setChipNotice({ key: chip.key, text: reason.startsWith(chip.key) ? reason : `${chip.key}: ${reason}` })
                return
              }
              if (chip.key === '5M' && chip.loadable) { void requestFive(); return }
              setChipNotice(null)
              setPicked(chip.key)
              setHover(null)
              let willLoad = false
              if (historyEnabled && isHistoryTimeframe(chip.key) && (hist.status !== 'failed' || chip.available)) {
                const target = HISTORY_TARGET_SPAN_SEC[chip.key]
                willLoad = hist.hasMore && historyCoveredSec(hist) < target && hist.status !== 'loading'
                if (willLoad) void requestHistory(HISTORY_MAX_REQUESTS_PER_ACTION, target)
              }
              setDailyDefer(chip.key === '1D' && (willLoad || hist.status === 'loading') ? { source: candles, fallback: activeKey } : null)
            }}
            style={{
              padding: compact ? '4px 8px' : '4px 10px',
              borderRadius: '6px',
              border: 'none',
              fontSize: '10.5px',
              fontWeight: 700,
              fontFamily: MONO,
              letterSpacing: '0.04em',
              cursor: chip.available ? (loading ? 'progress' : 'pointer') : 'not-allowed',
              color: active ? C.textStrong : chip.available ? (chip.sparse ? '#56657a' : '#94a3b8') : '#334155',
              background: active ? 'rgba(45,212,191,0.14)' : 'transparent',
              textDecoration: chip.available ? 'none' : 'line-through',
              textDecorationColor: 'rgba(51,65,85,0.8)',
              opacity: loading ? 0.6 : 1,
            }}
          >
            {chip.key}
            {chip.sparse && <span aria-hidden style={{ display: 'inline-block', width: '4px', height: '4px', marginLeft: '3px', borderRadius: '50%', background: '#b45309', verticalAlign: 'middle' }} />}
          </button>
        )
      })}
    </div>
  )

  return (
    <div style={{ marginBottom: '16px', borderRadius: '14px', padding: compact ? '12px 10px 10px' : '14px 16px 12px', background: C.panel, border: `1px solid ${C.border}` }}>
      <PanelHeader badge={badge} />

      {/* Price + visible-window change, and interval selector */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginBottom: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: compact ? '22px' : '26px', fontWeight: 700, color: C.textStrong, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
            {fmtValue(latest.close)}
          </span>
          <span style={{ fontSize: '13px', fontWeight: 700, fontFamily: MONO, color: windowChange == null ? C.axisText : windowChange >= 0 ? C.bull : C.bear }}>
            {formatChartPct(windowChange)}
          </span>
          {windowSpan && <span title="Change across the visible candles (first open to last close)" style={{ fontSize: '10px', color: C.muted, fontFamily: MONO, letterSpacing: '0.06em' }}>{windowSpan} view</span>}
          <div role="group" aria-label="Chart value" style={{ display: 'inline-flex', gap: '2px', padding: '2px', borderRadius: '7px', background: 'rgba(15,23,42,0.7)', border: `1px solid ${C.border}`, alignSelf: 'center' }}>
            {(['MCAP', 'PRICE'] as const).map((m) => {
              const disabled = m === 'MCAP' && !mcapAvailable
              const active = valueMode === m
              return (
                <button
                  key={m}
                  type="button"
                  aria-pressed={active}
                  disabled={disabled}
                  title={disabled ? (marketCapUnavailableReason ?? 'Verified market cap unavailable') : m === 'MCAP' ? mcapBasisInfo.tooltip : 'Token price (USD)'}
                  onClick={() => { if (!disabled) { setModeRaw({ source: candles, mode: m }); setHover(null) } }}
                  style={{
                    padding: '3px 8px', borderRadius: '5px', border: 'none', fontSize: '10px', fontWeight: 700, fontFamily: MONO, letterSpacing: '0.05em',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    color: active ? C.textStrong : disabled ? '#334155' : '#94a3b8',
                    background: active ? 'rgba(45,212,191,0.14)' : 'transparent',
                  }}
                >
                  {m}
                </button>
              )
            })}
          </div>
          {valueMode === 'MCAP' && (
            <span title={mcapBasisInfo.tooltip} data-mcap-basis={marketCapBasis ?? 'circulating_supply'} style={{ fontSize: '9.5px', color: C.muted, fontFamily: MONO, letterSpacing: '0.04em', alignSelf: 'center' }}>
              {mcapBasisInfo.label}
            </span>
          )}
        </div>
        {chips}
      </div>
      {noticeVisible && chipNotice && (
        <p role="status" style={{ margin: '-2px 0 6px', fontSize: '10.5px', color: '#94a3b8', fontFamily: MONO, textAlign: compact ? 'left' : 'right' }}>
          {chipNotice.text}
        </p>
      )}

      {/* OHLCV readout — follows the crosshair, rests on the newest visible candle */}
      <div aria-live="polite" style={{ display: 'flex', flexWrap: 'wrap', gap: compact ? '2px 10px' : '2px 14px', minHeight: '18px', marginBottom: '6px', fontSize: '10.5px', fontFamily: MONO, fontVariantNumeric: 'tabular-nums', color: C.axisText }}>
        <span style={{ color: '#94a3b8' }}>{fmtTime(readout.t, intervalSec, 'readout')}</span>
        <span>O <span style={{ color: readoutColor }}>{fmtValue(readout.open)}</span></span>
        <span>H <span style={{ color: readoutColor }}>{fmtValue(readout.high)}</span></span>
        <span>L <span style={{ color: readoutColor }}>{fmtValue(readout.low)}</span></span>
        <span>C <span style={{ color: readoutColor }}>{fmtValue(readout.close)}</span></span>
        <span>V <span style={{ color: C.text }}>{formatChartVolume(readout.volume)}</span></span>
        <span title="This candle's change (its open to its close)">Candle <span style={{ color: readoutChange == null ? C.axisText : readoutChange >= 0 ? C.bull : C.bear }}>{formatChartPct(readoutChange)}</span></span>
      </div>

      <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
        {width > 0 && (
          <svg
            ref={setSvgEl}
            width={W}
            height={H}
            role="img"
            aria-label={`${n} ${formatIntervalLabel(intervalSec)} candles shown of ${total}, last ${valueMode === 'MCAP' ? 'market cap ' : ''}${fmtValue(latest.close)}, ${formatChartPct(windowChange)} over ${windowSpan}`}
            style={{ display: 'block', touchAction: 'pan-y', userSelect: 'none', cursor: 'crosshair' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPointer}
            onPointerCancel={(e) => { endPointer(e); setHover(null) }}
            onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover(null) }}
            onDoubleClick={resetView}
          >
            {/* Grid */}
            {yTicks.map((v) => (
              <line key={`gy${v}`} x1={0} x2={plotW} y1={yP(v)} y2={yP(v)} stroke={C.grid} strokeWidth={1} shapeRendering="crispEdges" />
            ))}
            {xTickIdx.map((i) => (
              <line key={`gx${i}`} x1={xC(i)} x2={xC(i)} y1={priceTop} y2={volBot} stroke={C.grid} strokeWidth={1} shapeRendering="crispEdges" />
            ))}
            <line x1={plotW + 0.5} x2={plotW + 0.5} y1={0} y2={volBot} stroke={C.border} strokeWidth={1} />
            <line x1={0} x2={W} y1={volBot + 0.5} y2={volBot + 0.5} stroke={C.border} strokeWidth={1} />
            {hasVolume && <line x1={0} x2={W} y1={volTop - volGap / 2} y2={volTop - volGap / 2} stroke={C.border} strokeWidth={1} shapeRendering="crispEdges" />}

            {/* Sparse view: straight segments between REAL closes (no smoothing), broken at every gap the
                continuity threshold does not support — line and area alike; isolated candles are markers only. */}
            {lineMode && sparseLine && (() => {
              const trend = data[data.length - 1].close >= data[0].close ? C.bull : C.bear
              return (
                <g data-chart-mode="line" data-line-segments={sparseLine.stats.segmentCount}>
                  {sparseLine.segments.map((seg) => {
                    if (seg.indices.length < 2) return null
                    const pts = seg.indices.map((i) => `${xC(i).toFixed(1)},${yP(data[i].close).toFixed(1)}`)
                    const first = seg.indices[0]
                    const lastI = seg.indices[seg.indices.length - 1]
                    return (
                      <g key={`s${data[first].t}`}>
                        <path d={`M${pts[0]} L${pts.slice(1).join(' L')} L${xC(lastI).toFixed(1)},${priceBot} L${xC(first).toFixed(1)},${priceBot} Z`} fill={trend} fillOpacity={0.08} stroke="none" />
                        <polyline points={pts.join(' ')} fill="none" stroke={trend} strokeWidth={1.6} strokeLinejoin="round" />
                      </g>
                    )
                  })}
                  {sparseLine.segments.flatMap((seg) => seg.indices.map((i) => (
                    <circle key={`p${data[i].t}`} cx={xC(i)} cy={yP(data[i].close)} r={seg.indices.length === 1 ? 3.2 : 2.4} fill={trend} />
                  )))}
                </g>
              )
            })()}
            {/* Candles */}
            {!lineMode && <g>
              {data.map((c, i) => {
                const x = xC(i)
                const bull = c.close >= c.open
                const clr = bull ? C.bull : C.bear
                const top = yP(Math.max(c.open, c.close))
                const bodyH = Math.max(1, yP(Math.min(c.open, c.close)) - top)
                return (
                  <g key={c.t}>
                    {/* A wick beyond the robust display range is drawn to the edge (its true value is flagged below). */}
                    <line x1={x} x2={x} y1={yP(Math.min(c.high, yMax))} y2={yP(Math.max(c.low, yMin))} stroke={clr} strokeWidth={1} shapeRendering="crispEdges" />
                    <rect x={x - bodyW / 2} y={top} width={bodyW} height={bodyH} fill={clr} shapeRendering="crispEdges" />
                  </g>
                )
              })}
            </g>}

            {/* Clipped extreme wicks: marker at the edge with the TRUE high / low (raw OHLC untouched) */}
            {!lineMode && domain.clippedHigh && (() => {
              const i = data.reduce((b, c, k) => (c.high > data[b].high ? k : b), 0)
              const x = xC(i)
              const label = `▲ ${fmtValue(domain.trueMax, 4)}`
              const tx = Math.max(4, Math.min(plotW - label.length * 6 - 4, x + 6))
              return (
                <g data-clipped="high" pointerEvents="none">
                  <path d={`M${x - 3.5},${priceTop + 6} L${x + 3.5},${priceTop + 6} L${x},${priceTop + 1} Z`} fill={C.text} />
                  <text x={tx} y={priceTop + 10} fill={C.text} style={{ fontSize: 9.5, fontFamily: MONO }}>{label}</text>
                </g>
              )
            })()}
            {!lineMode && domain.clippedLow && (() => {
              const i = data.reduce((b, c, k) => (c.low < data[b].low ? k : b), 0)
              const x = xC(i)
              const label = `▼ ${fmtValue(domain.trueMin, 4)}`
              const tx = Math.max(4, Math.min(plotW - label.length * 6 - 4, x + 6))
              return (
                <g data-clipped="low" pointerEvents="none">
                  <path d={`M${x - 3.5},${priceBot - 6} L${x + 3.5},${priceBot - 6} L${x},${priceBot - 1} Z`} fill={C.text} />
                  <text x={tx} y={priceBot - 3} fill={C.text} style={{ fontSize: 9.5, fontFamily: MONO }}>{label}</text>
                </g>
              )
            })()}

            {/* Volume — its own lower pane, same x and bar width as the candles above */}
            {hasVolume && (
              <g>
                {data.map((c, i) => {
                  if (c.volume == null || c.volume <= 0 || maxVol <= 0) return null
                  const h = Math.max(1, (c.volume / maxVol) * (volH - 4))
                  return <rect key={`v${c.t}`} x={xC(i) - bodyW / 2} y={volBot - h} width={bodyW} height={h} fill={c.close >= c.open ? C.bullVol : C.bearVol} shapeRendering="crispEdges" />
                })}
                <text x={4} y={volTop + 10} fill={C.muted} style={{ fontSize: 9, fontFamily: MONO, letterSpacing: '0.1em' }}>VOL {formatChartVolume(maxVol)}</text>
              </g>
            )}

            {/* Y axis labels */}
            {yTicks.map((v) => {
              const y = yP(v)
              if (y < priceTop + 6 || y > priceBot - 4) return null
              // Never draw an axis label underneath the current-price tag or the crosshair tag.
              if (lastInView && Math.abs(y - lastY) < tagH) return null
              if (hover && hover.y >= priceTop && hover.y <= priceBot && Math.abs(y - hover.y) < tagH) return null
              return <text key={`ty${v}`} x={plotW + 6} y={y + 3.5} fill={C.axisText} style={{ fontSize: 10, fontFamily: MONO, fontVariantNumeric: 'tabular-nums' }}>{fmtValue(v, 3)}</text>
            })}

            {/* X axis labels */}
            {xTickIdx.map((i) => {
              const label = fmtTime(data[i].t, intervalSec, 'axis')
              const half = (label.length * 6.2) / 2
              // Keep labels fully inside the plot, and out from under the crosshair's time tag.
              if (xC(i) - half < 0 || xC(i) + half > plotW) return null
              if (hover && Math.abs(xC(i) - xC(hover.idx)) < half + 58) return null
              return <text key={`tx${i}`} x={xC(i)} y={volBot + 15} textAnchor="middle" fill={C.axisText} style={{ fontSize: 10, fontFamily: MONO }}>{label}</text>
            })}

            {/* Current (latest real) price line + tag — shown when it lies inside the visible range */}
            {lastInView && <line x1={0} x2={plotW} y1={lastY} y2={lastY} stroke={lastBull ? C.bull : C.bear} strokeOpacity={0.7} strokeWidth={1} strokeDasharray="2 3" />}
            {lastInView && priceTag(lastY, fmtValue(latest.close, 4), lastBull ? C.bull : C.bear, '#04121a')}

            {/* Crosshair */}
            {hover && hoverC && (() => {
              const x = xC(hover.idx)
              const inPrice = hover.y >= priceTop && hover.y <= priceBot
              const timeLabel = fmtTime(hoverC.t, intervalSec, 'readout')
              const tw = timeLabel.length * 6.2 + 12
              const tx = Math.max(0, Math.min(plotW - tw, x - tw / 2))
              return (
                <g pointerEvents="none">
                  <line x1={x} x2={x} y1={priceTop} y2={volBot} stroke={C.crosshair} strokeWidth={1} strokeDasharray="3 3" />
                  {inPrice && <line x1={0} x2={plotW} y1={hover.y} y2={hover.y} stroke={C.crosshair} strokeWidth={1} strokeDasharray="3 3" />}
                  {inPrice && priceTag(hover.y, fmtValue(vFromY(hover.y), 4), C.tagBg, C.textStrong)}
                  <rect x={tx} y={volBot + 2} width={tw} height={tagH} rx={2} fill={C.tagBg} />
                  <text x={tx + tw / 2} y={volBot + 14} textAnchor="middle" fill={C.textStrong} style={{ fontSize: 10, fontFamily: MONO }}>{timeLabel}</text>
                </g>
              )
            })()}
          </svg>
        )}
        {width === 0 && <div style={{ height: `${H}px` }} />}
        {!isRest && width > 0 && (
          <button
            type="button"
            onClick={resetView}
            aria-label="Reset chart view"
            title="Reset view (or double-click the chart)"
            style={{ position: 'absolute', top: 6, left: 6, padding: '3px 8px', borderRadius: '6px', border: `1px solid ${C.border}`, background: 'rgba(15,23,42,0.92)', color: '#94a3b8', fontSize: '10px', fontWeight: 700, fontFamily: MONO, letterSpacing: '0.06em', cursor: 'pointer' }}
          >
            RESET VIEW
          </button>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap', marginTop: '6px', fontSize: '10px', color: C.muted, fontFamily: MONO }}>
        <span>
          {n === total ? `${n}` : `${n} of ${total}`} × {formatIntervalLabel(intervalSec)} real candles
          {activeTf?.origin === 'aggregated' ? ` · rolled up from ${hist.candles.length > 0 && isHistoryTimeframe(activeKey) ? `1H history + ${formatIntervalLabel(tfSet.nativeSec)}` : formatIntervalLabel(tfSet.nativeSec)}` : ''}
          {fiveActive ? ' · loaded on demand' : ''}
        </span>
        {footnote && <span>{footnote}</span>}
      </div>
      {qualityNote && (
        <div role="status" data-chart-quality={activeQuality?.quality ?? undefined} data-selected-timeframe-reason={selectionReason} style={{ marginTop: '2px', fontSize: '10px', color: '#b7791f', fontFamily: MONO }}>
          {qualityNote}
        </div>
      )}
      {(historySourceLabel || historyEnabled) && (
        <div role="status" data-history-end={hist.endReason ?? undefined} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap', marginTop: '2px', fontSize: '10px', color: C.muted, fontFamily: MONO }}>
          {historySourceLabel ? <span>{loadedSpanLabel(series[0].t, latest.t, intervalSec ?? 0)} · {historySourceLabel}</span> : <span />}
          {historyEnabled && (
            <span style={{ color: hist.status === 'failed' ? '#94a3b8' : C.muted }}>
              {hist.status === 'loading'
                ? 'Loading older candles…'
                : hist.status === 'failed'
                  ? `Older history unavailable — ${hist.message ?? 'request failed'}`
                  : !hist.hasMore
                    ? 'Full pool history loaded'
                    : isHistoryTimeframe(activeKey)
                      ? 'Scroll/zoom left for older history'
                      : 'Select 1H / 4H / 1D for older history'}
            </span>
          )}
        </div>
      )}
      {debug && (
        <pre data-chart-quality-debug style={{ margin: '8px 0 0', padding: '8px', borderRadius: '8px', background: 'rgba(2,6,23,0.6)', color: '#94a3b8', fontSize: '10px', fontFamily: MONO, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
          {JSON.stringify({
            selectedTimeframe: activeKey,
            selectedTimeframeReason: selectionReason,
            sparseLine: sparseLine?.stats ?? null,
            timeframeQuality: [...Object.values(tfQuality), ...(fiveQuality && !tfQuality['5M'] ? [fiveQuality] : [])].map((q) => ({
              timeframe: q!.timeframe, candleCount: q!.candleCount,
              candleSpanSec: q!.candleSpanSec, coverageStartSec: q!.coverageStartSec, coverageEndSec: q!.coverageEndSec, coverageSpanSec: q!.coverageSpanSec, coverageKnown: q!.coverageKnown,
              candleSpanExpectedBuckets: q!.candleSpanExpectedBuckets, coverageExpectedBuckets: q!.coverageExpectedBuckets,
              clusterDensity: q!.clusterDensity, coverageDensity: q!.coverageDensity, recentCoverage: q!.recentCoverage, largestGapBuckets: q!.largestGapBuckets,
              poolAgeSec: q!.poolAgeSec, effectiveCoverageSpanSec: q!.effectiveCoverageSpanSec,
              quality: q!.quality, reason: q!.rejectionReason,
            })),
          }, null, 1)}
        </pre>
      )}
    </div>
  )
}

function PanelHeader({ badge }: { badge?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '10px' }}>
      <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.14em', color: '#94a3b8', fontFamily: MONO }}>PRICE CHART</span>
      {badge ?? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '9.5px', fontWeight: 700, letterSpacing: '0.12em', color: '#5eead4', fontFamily: MONO }}>
          <span aria-hidden style={{ width: '6px', height: '6px', borderRadius: '50%', background: C.bull }} />
          LIVE CANDLES
        </span>
      )}
    </div>
  )
}
