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
import { formatCompactUsd, marketCapBasisLabel, scaleCandlesToMarketCap, type ChartMarketCapBasis } from '@/lib/chartMarketCap'
import {
  HISTORY_MAX_REQUESTS_PER_ACTION,
  HISTORY_TARGET_SPAN_SEC,
  historyCutoffMs,
  isHistoryTimeframe,
  loadHistoryBatch,
  loadedSpanLabel,
  withHistory,
  type HistoryWindowResult,
} from '@/lib/chartHistory'

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
  | { ok: true; intervalSec: number; points: ReadonlyArray<ChartCandleInput> }
  | { ok: false; message: string }

type FiveMinuteState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; candles: ChartCandle[] }
  | { status: 'failed'; message: string }

type ChipState = { key: ChartTimeframeKey; available: boolean; loadable: boolean; reason: string | null; title: string }

type HistoryState = { candles: ChartCandle[]; nextBeforeSec: number | null; hasMore: boolean; status: 'idle' | 'loading' | 'failed'; message: string | null; endReason?: string | null }

const IDLE_FIVE: FiveMinuteState = { status: 'idle' }
const IDLE_HISTORY: HistoryState = { candles: [], nextBeforeSec: null, hasMore: true, status: 'idle', message: null }
const FIVE_MIN_SEC = 300

export default function PriceChartPanel({ candles, declaredIntervalSec, badge, footnote, loadFiveMinute, marketCapSupply, marketCapUnavailableReason, marketCapBasis, loadHistory, historySourceLabel }: PriceChartPanelProps) {
  const normalized = useMemo(() => normalizeChartCandles(candles), [candles])
  const scanSet = useMemo(() => buildChartTimeframes(normalized, declaredIntervalSec), [normalized, declaredIntervalSec])
  const defaultKey = useMemo(() => pickDefaultTimeframe(scanSet), [scanSet])

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

  const chipStates: ChipState[] = tfSet.timeframes.map((tf) => {
    if (tf.key === '5M' && fiveLoadable) {
      if (five.status === 'failed') return { key: tf.key, available: false, loadable: false, reason: `5M unavailable — ${five.message}`, title: five.message }
      if (five.status === 'ready' && five.candles.length < 2) return { key: tf.key, available: false, loadable: false, reason: '5M unavailable — the pool returned no 5-minute trading history yet', title: 'No 5M history yet' }
      return { key: tf.key, available: true, loadable: five.status !== 'ready', reason: null, title: five.status === 'loading' ? 'Loading real 5M candles…' : five.status === 'ready' ? `${five.candles.length} real 5M candles` : 'Load real 5M candles for this pool' }
    }
    if (!tf.available && historyEnabled && isHistoryTimeframe(tf.key) && hist.hasMore && hist.status !== 'failed') {
      return { key: tf.key, available: true, loadable: true, reason: null, title: hist.status === 'loading' ? 'Loading older candles…' : `Load older real ${tf.key} candles for this pool` }
    }
    return {
      key: tf.key,
      available: tf.available,
      loadable: false,
      reason: tf.available ? null : (tf.unavailableReason ?? 'Needs more trading history'),
      title: tf.available ? `${tf.candles.length} real ${tf.key} candles${tf.origin === 'aggregated' ? ' (rolled up from finer real candles)' : ''}` : (tf.unavailableReason ?? 'Needs more trading history'),
    }
  })

  // A pick that is no longer available (new scan data) falls back to the default — never to
  // another timeframe's candles under the picked label.
  const fiveActive = picked === '5M' && fiveLoadable && five.status === 'ready' && five.candles.length >= 2
  // 1D picked while its first history batch loads, with only 1-2 partial daily candles so far: keep
  // showing the timeframe that was on screen (with "Loading older candles…") instead of presenting
  // those partial days as the 1D chart. 1D appears once the batch is applied (or fails).
  const [dailyDefer, setDailyDefer] = useState<{ source: ReadonlyArray<ChartCandleInput>; fallback: ChartTimeframeKey | null } | null>(null)
  const dailyCandleCount = tfSet.timeframes.find((tf) => tf.key === '1D')?.candles.length ?? 0
  const deferDaily = picked === '1D' && hist.status === 'loading' && dailyDefer != null && dailyDefer.source === candles && dailyCandleCount <= 2
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

  const requestFive = async () => {
    if (!loadFiveMinute || five.status === 'loading') return
    const source = candles
    setFiveRaw({ source, state: { status: 'loading' } })
    setChipNotice({ key: '5M', text: 'Loading real 5M candles…' })
    let next: FiveMinuteState
    try {
      const res = await loadFiveMinute()
      next = res.ok ? { status: 'ready', candles: normalizeChartCandles(res.points) } : { status: 'failed', message: res.message }
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

  // Older history: explicit user action only. A timeframe pick may chain up to 3 bounded requests
  // toward that timeframe's target span; reaching the left edge makes one. Never auto-retried.
  const requestHistory = async (maxRequests: number, targetSpanSec: number | null) => {
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
    historyBusy.current = false
  }
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
  const volGap = 6
  const volH = hasVolume ? (compact ? 44 : 60) : 0
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
  const minSlot = compact ? 4 : 5
  const fit = Math.max(2, Math.floor(plotW / minSlot))
  const total = series.length
  // Keyed by timeframe + newest candle: older history prepended to the same series shifts the view by
  // the number of added candles, so the candles the user is looking at stay in place.
  const seriesKey = `${activeKey ?? 'native'}:${series[series.length - 1]?.t ?? 0}`
  const restView = defaultViewport(total, fit)
  const [viewRaw, setViewRaw] = useState<{ key: string; view: ChartViewport; total: number } | null>(null)
  const prepended = viewRaw && viewRaw.key === seriesKey ? Math.max(0, total - viewRaw.total) : 0
  const view = viewRaw && viewRaw.key === seriesKey ? clampViewport({ start: viewRaw.view.start + prepended, end: viewRaw.view.end + prepended }, total) : restView
  const isRest = sameViewport(view, restView)
  const setView = (v: ChartViewport) => {
    const next = clampViewport(v, total)
    setViewRaw({ key: seriesKey, view: next, total })
    if (next.start === 0) loadOlderAtLeftEdge()
  }
  const resetView = () => { setViewRaw(null); setHover(null) }

  const data = enough ? series.slice(view.start, view.end) : []
  const n = data.length
  const slot = n > 0 ? plotW / n : plotW
  const bodyW = Math.max(1, Math.min(slot * 0.66, 16))
  const xC = (i: number) => (i + 0.5) * slot

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

  let lo = Infinity
  let hi = -Infinity
  for (const c of data) { if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high }
  const span = hi - lo > 0 ? hi - lo : hi * 0.02
  const yMin = Math.max(0, lo - span * 0.08)
  const yMax = hi + span * 0.08
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
    setHover({ idx: Math.max(0, Math.min(n - 1, Math.floor(x / slot))), y })
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
            aria-label={chip.available ? `${chip.key} candles${chip.loadable ? ' (loads on demand)' : ''}` : `${chip.key} unavailable: ${chip.reason ?? 'Needs more trading history'}`}
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
              color: active ? C.textStrong : chip.available ? '#94a3b8' : '#334155',
              background: active ? 'rgba(45,212,191,0.14)' : 'transparent',
              textDecoration: chip.available ? 'none' : 'line-through',
              textDecorationColor: 'rgba(51,65,85,0.8)',
              opacity: loading ? 0.6 : 1,
            }}
          >
            {chip.key}
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
          {windowSpan && <span style={{ fontSize: '10px', color: C.muted, fontFamily: MONO, letterSpacing: '0.06em' }}>{windowSpan}</span>}
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
        <span>Chg <span style={{ color: readoutChange == null ? C.axisText : readoutChange >= 0 ? C.bull : C.bear }}>{formatChartPct(readoutChange)}</span></span>
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
            {hasVolume && <line x1={0} x2={plotW} y1={volTop - volGap / 2} y2={volTop - volGap / 2} stroke={C.grid} strokeWidth={1} />}

            {/* Candles */}
            <g>
              {data.map((c, i) => {
                const x = xC(i)
                const bull = c.close >= c.open
                const clr = bull ? C.bull : C.bear
                const top = yP(Math.max(c.open, c.close))
                const bodyH = Math.max(1, yP(Math.min(c.open, c.close)) - top)
                return (
                  <g key={c.t}>
                    <line x1={x} x2={x} y1={yP(c.high)} y2={yP(c.low)} stroke={clr} strokeWidth={1} shapeRendering="crispEdges" />
                    <rect x={x - bodyW / 2} y={top} width={bodyW} height={bodyH} fill={clr} shapeRendering="crispEdges" />
                  </g>
                )
              })}
            </g>

            {/* Volume — same index scale as the candles above */}
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
