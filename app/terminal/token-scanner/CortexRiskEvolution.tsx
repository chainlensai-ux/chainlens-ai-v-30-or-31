'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { riskColorFromCanonicalLabel, riskLabelFromCanonicalScore } from '@/lib/riskScoreDirection'
import {
  buildRiskEvolution, buildWhatChanged, coverageReasonText, createCortexHistoryStore, formatSpan, humanizeStatus,
  labelledPointIndexes, storedUsd,
  type ChangeNote, type CortexObservation, type FactorChange, type RiskEvolutionModel, type ValueComparison,
} from './cortexRiskEvolutionModel'

type Props = {
  chain: string
  contract: string
  /** 'scanning' while a scan of this token is in flight; 'complete' once its result is on screen. */
  phase: 'scanning' | 'complete'
  /** Recorded time of the just-finished scan's observation, when the server accepted it for storage. */
  expectedObservedAt?: string | null
}

type Recording = 'waiting' | 'recorded' | 'not_found' | null
type View =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error' }
  | { status: 'ready'; observations: unknown[]; recording: Recording; refreshFailed: boolean; nextCursor?: string | null }

// One store per browser session: shared cache + in-flight de-duplication across the scanning and result panels.
const store = createCortexHistoryStore({
  getSession: async () => {
    const { data } = await supabase.auth.getSession().catch(() => ({ data: { session: null } }))
    return { token: data.session?.access_token ?? null, userId: data.session?.user?.id ?? null }
  },
})

// Account history is authenticated and available outside Preview as well.
const DEPLOY_ENV = process.env.NEXT_PUBLIC_VERCEL_ENV

const TEAL = '#5eead4'
const AMBER = '#fbbf24'
const MUTED = '#94a3b8'
const DIM = '#64748b'
const WORSE = '#fb7185'
const BETTER = '#34d399'
const INK = '#e2e8f0'

const fmtTime = (iso: string | number) =>
  new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const fmtUsd = (n: number) =>
  '$' + new Intl.NumberFormat('en-US', { notation: n >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: n >= 100_000 ? 2 : 0 }).format(n)
const signed = (n: number, digits = 0) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}`
const scoreColor = (score: number) => riskColorFromCanonicalLabel(riskLabelFromCanonicalScore(score))
const toneColor = (tone: ChangeNote['tone']) => (tone === 'worse' ? WORSE : tone === 'better' ? BETTER : tone === 'caution' ? AMBER : MUTED)
const coverageText = (o: CortexObservation) =>
  o.coverage === 'complete' ? 'Complete evidence'
    : o.coverage === 'provider_unavailable' ? 'Provider unavailable'
      : `Partial evidence${coverageReasonText(o.coverageReason) ? ` · missing ${coverageReasonText(o.coverageReason)}` : ''}`

export default function CortexRiskEvolution({ chain, contract, phase, expectedObservedAt = null }: Props) {
  const [view, setView] = useState<View>({ status: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)
  const [olderLoading, setOlderLoading] = useState(false)
  const requestRef = useRef(0)
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event !== 'SIGNED_OUT' && event !== 'SIGNED_IN') return
      requestRef.current += 1
      setView({ status: 'loading' })
      setReloadTick(n => n + 1)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!chain || !contract) return
    const id = ++requestRef.current
    const isCurrent = () => requestRef.current === id
    let cancelled = false
    const live = () => !cancelled && isCurrent()

    async function run() {
      // Show whatever is already cached for this user/token immediately; the load below only adds to it.
      const cached = await store.peek(chain, contract)
      if (!live()) return
      if (cached?.kind === 'disabled') { setView({ status: 'disabled' }); return }
      setView((prev) => {
        const base = cached?.kind === 'ok' ? cached.observations : prev.status === 'ready' ? prev.observations : null
        if (!base) return { status: 'loading' }
        return { status: 'ready', observations: base, recording: expectedObservedAt ? 'waiting' : null, refreshFailed: false, nextCursor: cached?.kind === 'ok' ? cached.nextCursor : null }
      })

      const snapshot = await store.load(chain, contract, { expectedObservedAt, force: reloadTick > 0, isCurrent: live })
      if (!live()) return
      if (process.env.NODE_ENV !== 'production' || DEPLOY_ENV === 'preview') {
        console.info('[cortex-history]', { chain, phase, latencyMs: snapshot.latencyMs, attempts: snapshot.attempts, currentScanRecorded: snapshot.currentScanRecorded, outcome: snapshot.outcome.kind })
      }
      const { outcome } = snapshot
      if (outcome.kind === 'disabled') { setView({ status: 'disabled' }); return }
      const recording: Recording = snapshot.currentScanRecorded == null ? null : snapshot.currentScanRecorded ? 'recorded' : 'not_found'
      if (outcome.kind === 'ok') { setView({ status: 'ready', observations: outcome.observations, recording, refreshFailed: false, nextCursor: outcome.nextCursor }); return }
      // A failed refresh keeps the history already on screen and says so, instead of blanking it.
      setView((prev) => (prev.status === 'ready' ? { ...prev, recording: null, refreshFailed: true } : { status: 'error' }))
    }
    void run()
    return () => { cancelled = true }
    // phase is only reported in the latency log; it never re-triggers a load on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, contract, expectedObservedAt, reloadTick])

  const retry = useCallback(() => setReloadTick((n) => n + 1), [])
  async function loadOlder() {
    if (olderLoading || view.status !== 'ready' || !view.nextCursor) return
    const epoch = requestRef.current
    const cursor = view.nextCursor
    setOlderLoading(true)
    try {
      const { data } = await supabase.auth.getSession()
      if (!data.session) return
      const params = new URLSearchParams({ chain, contract, cursor })
      const response = await fetch(`/api/cortex/history?${params}`, { headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: 'no-store' })
      const page = await response.json()
      if (epoch !== requestRef.current) return
      if (!response.ok || !Array.isArray(page.observations)) throw new Error('history_read')
      setView(prev => {
        if (prev.status !== 'ready' || prev.nextCursor !== cursor) return prev
        return { ...prev, observations: [...prev.observations, ...page.observations], nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null, refreshFailed: false }
      })
    } catch { if (epoch === requestRef.current) setView(prev => prev.status === 'ready' ? { ...prev, refreshFailed: true } : prev) }
    finally { setOlderLoading(false) }
  }

  if (view.status === 'disabled' || store.isDisabled()) return null

  const model: RiskEvolutionModel | null = view.status === 'ready' ? buildRiskEvolution(view.observations) : null
  const unrated = view.status === 'ready' ? view.observations.filter((o): o is { observedAt: string; riskScore: null } => Boolean(o && typeof o === 'object' && (o as { riskScore?: unknown }).riskScore == null && typeof (o as { observedAt?: unknown }).observedAt === 'string')) : []
  const chip = view.status === 'loading' ? { text: 'LOADING', color: TEAL }
    : view.status === 'error' ? { text: 'UNAVAILABLE', color: MUTED }
      : model?.state === 'trend' ? { text: 'HISTORY AVAILABLE', color: TEAL }
        : { text: 'BUILDING HISTORY', color: AMBER }

  return (
    <section aria-label="CORTEX risk evolution" aria-busy={view.status === 'loading'} className="cre-root">
      <style>{CSS}</style>
      <header className="cre-head">
        <div style={{ minWidth: 0 }}>
          <div className="cre-kicker">CORTEX RISK EVOLUTION</div>
          <div className="cre-sub">Recorded CORTEX scans of this token · not continuous monitoring</div>
        </div>
        <span className="cre-chip" style={{ color: chip.color, borderColor: `${chip.color}55`, background: `${chip.color}12` }}>
          {view.status === 'loading' && <span className="cre-pulse" style={{ background: chip.color }} />}
          {chip.text}
        </span>
      </header>

      <ScanStatus phase={phase} view={view} />

      {view.status === 'loading' ? (
        <Skeleton />
      ) : view.status === 'error' ? (
        <div className="cre-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ color: MUTED, fontSize: 12 }}>Historical risk data could not be loaded. The current scan above is unaffected.</span>
          <button type="button" onClick={retry} className="cre-btn">Retry</button>
        </div>
      ) : model == null || model.state === 'empty' ? (
        <div className="cre-panel" style={{ color: MUTED, fontSize: 12, lineHeight: 1.7 }}>
          {unrated.length ? `${unrated.length} completed Unrated scan(s) are saved to this account. Unrated scans are not numerical risk comparisons.` : 'No observations recorded for this token yet.'}{' '}
          {phase === 'scanning' ? 'This scan becomes the first one once it completes.' : 'A comparison appears after this token has been scanned again with the same methodology.'}
        </div>
      ) : model.state === 'building' ? (
        <Building model={model} />
      ) : (
        <Trend model={model} />
      )}

      {view.status === 'ready' && view.refreshFailed && (
        <div style={{ color: AMBER, fontSize: 10, marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          Could not refresh history; showing the last loaded observations.
          <button type="button" onClick={retry} className="cre-btn cre-btn-sm">Retry</button>
        </div>
      )}
      {unrated.length > 0 && <details style={{ marginTop: 12, color: MUTED, fontSize: 12 }}><summary>Saved Unrated scans ({unrated.length})</summary><ul>{unrated.map((o, i) => <li key={`${o.observedAt}:${i}`}>{fmtTime(o.observedAt)} · Unrated · insufficient measured evidence</li>)}</ul></details>}
      {view.status === 'ready' && view.nextCursor && <button type="button" className="cre-btn" disabled={olderLoading} onClick={loadOlder}>{olderLoading ? 'Loading older scans…' : 'Load older scans'}</button>}

      {model && model.state !== 'empty' && (
        <footer className="cre-foot">
          {model.excludedForMethodology > 0
            ? `${model.excludedForMethodology} earlier observation${model.excludedForMethodology === 1 ? '' : 's'} used a different scanner or risk methodology and ${model.excludedForMethodology === 1 ? 'is' : 'are'} not compared. `
            : ''}
          Each point is a stored scan result; nothing between scans is estimated. Market figures are the values recorded at each scan, shown separately from the CORTEX risk score. Historical changes are not predictions.
        </footer>
      )}
    </section>
  )
}

function ScanStatus({ phase, view }: { phase: Props['phase']; view: View }) {
  const recording = view.status === 'ready' ? view.recording : null
  let text: string | null = null
  let color = MUTED
  if (phase === 'scanning') { text = 'Scan in progress: its observation is recorded when the scan completes.'; color = TEAL }
  else if (recording === 'waiting') { text = 'Recording this scan to history…'; color = TEAL }
  else if (recording === 'recorded') { text = 'This scan is included below.'; color = BETTER }
  else if (recording === 'not_found') { text = 'This scan was not added as a new point (it matched an earlier recorded observation or was not stored).'; color = MUTED }
  else if (view.status === 'loading') { text = 'Loading historical intelligence…'; color = TEAL }
  if (!text) return null
  const busy = phase === 'scanning' || recording === 'waiting' || view.status === 'loading'
  return (
    <div role="status" aria-live="polite" className="cre-status" style={{ color }}>
      {busy && <span className="cre-pulse" style={{ background: color }} />}
      {text}
    </div>
  )
}

function Skeleton() {
  return (
    <div className="cre-grid-hero" aria-hidden>
      <div className="cre-panel" style={{ display: 'grid', gap: 10 }}>
        <div className="shimmer-line" style={{ width: '40%', height: 9 }} />
        <div className="shimmer-line" style={{ width: '55%', height: 30 }} />
        <div className="shimmer-line" style={{ width: '70%', height: 9 }} />
      </div>
      <div className="cre-panel" style={{ display: 'grid', gap: 10 }}>
        <div className="shimmer-line" style={{ width: '30%', height: 9 }} />
        <div className="shimmer-line" style={{ width: '100%', height: 64 }} />
        <div className="shimmer-line" style={{ width: '85%', height: 9 }} />
      </div>
    </div>
  )
}

function ScoreHero({ score, label, caption, delta }: { score: number; label: string | null; caption: string; delta?: number }) {
  const color = scoreColor(score)
  return (
    <div className="cre-panel cre-hero" style={{ borderColor: `${color}40`, background: `linear-gradient(140deg, ${color}14, rgba(8,13,17,.6) 60%)` }}>
      <div className="cre-label">CURRENT RECORDED RISK</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color, fontSize: 38, fontWeight: 800, lineHeight: 1 }}>{score}</span>
        <span style={{ color: DIM, fontSize: 13 }}>/100</span>
        {delta != null && (
          <span className="cre-delta" style={{ color: delta > 0 ? WORSE : delta < 0 ? BETTER : MUTED, borderColor: `${delta > 0 ? WORSE : delta < 0 ? BETTER : MUTED}55` }}>
            {delta === 0 ? 'No change' : `${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)} pts`}
          </span>
        )}
      </div>
      {label && <div style={{ color, fontSize: 12, fontWeight: 700, marginTop: 6 }}>{label}</div>}
      <div style={{ color: DIM, fontSize: 10, marginTop: 8, lineHeight: 1.6 }}>{caption}</div>
      <div className="cre-track" aria-hidden><div style={{ width: `${score}%`, background: `linear-gradient(90deg, ${TEAL}, ${AMBER} 55%, ${WORSE})` }} /></div>
    </div>
  )
}

function EvidenceMeter({ observations }: { observations: CortexObservation[] }) {
  const complete = observations.filter((o) => o.coverage === 'complete').length
  const pct = observations.length ? (complete / observations.length) * 100 : 0
  const color = pct === 100 ? BETTER : pct >= 50 ? AMBER : WORSE
  return (
    <div>
      <div className="cre-label">EVIDENCE COVERAGE</div>
      <div style={{ color: INK, fontSize: 13, fontWeight: 700 }}>{complete} of {observations.length} scan{observations.length === 1 ? '' : 's'} with complete evidence</div>
      <div className="cre-track" aria-hidden><div style={{ width: `${pct}%`, background: color }} /></div>
    </div>
  )
}

function Building({ model }: { model: Extract<RiskEvolutionModel, { state: 'building' }> }) {
  const { latest } = model
  const liquidity = storedUsd(latest.liquidityUsd)
  return (
    <div className="cre-grid-hero">
      <ScoreHero score={latest.riskScore} label={latest.riskLabel} caption={`Recorded ${fmtTime(latest.observedAt)} · ${coverageText(latest)}`} />
      <div className="cre-panel" style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
        <div>
          <div className="cre-label">HISTORY</div>
          <div style={{ color: INK, fontSize: 13, fontWeight: 700 }}>1 comparable observation</div>
          <div style={{ color: MUTED, fontSize: 11, lineHeight: 1.7, marginTop: 4 }}>
            A before/after comparison appears once this token has a second scan recorded with the same scoring methodology.
          </div>
        </div>
        <div className="cre-timeline" aria-hidden>
          <span className="cre-node" style={{ background: scoreColor(latest.riskScore) }} />
          <span className="cre-rail" />
          <span className="cre-node cre-node-ghost" />
        </div>
        <div style={{ color: DIM, fontSize: 10 }}>Stored liquidity: {liquidity != null ? fmtUsd(liquidity) : 'Not recorded'}</div>
      </div>
    </div>
  )
}

function Trend({ model }: { model: Extract<RiskEvolutionModel, { state: 'trend' }> }) {
  const notes = buildWhatChanged(model)
  const ranked = model.factors.filter((f) => f.direction !== 'not_comparable')
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="cre-grid-hero">
        <ScoreHero
          score={model.latest.riskScore}
          label={model.latest.riskLabel}
          delta={model.riskDelta}
          caption={`${model.comparable.length} comparable scans over ${formatSpan(model.spanMs)} · last ${fmtTime(model.latest.observedAt)}`}
        />
        <div className="cre-panel" style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
          <EvidenceMeter observations={model.comparable} />
          <div>
            <div className="cre-label">WHAT CHANGED</div>
            <ul className="cre-notes">
              {notes.map((n, i) => (
                <li key={i}>
                  <span className="cre-dot" style={{ background: toneColor(n.tone) }} />
                  <span><span style={{ color: DIM, fontSize: 9, letterSpacing: '.08em' }}>{n.group === 'risk' ? 'RISK' : n.group === 'market' ? 'MARKET' : 'EVIDENCE'} </span>{n.text}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {model.chartReady ? <RiskChart key={`${model.comparable.length}:${model.latest.observedAt}`} model={model} /> : <BeforeAfter first={model.first} latest={model.latest} delta={model.riskDelta} />}

      {model.factors.length > 0 && (
        <div className="cre-panel">
          <div className="cre-label">RECORDED RISK CHECKS · FIRST VS LATEST</div>
          <div className="cre-factors">
            {model.factors.map((f) => <FactorRow key={f.key} factor={f} />)}
          </div>
          {ranked.length < model.factors.length && (
            <div style={{ color: DIM, fontSize: 10, marginTop: 8 }}>Checks not recorded in both scans are listed as not comparable.</div>
          )}
        </div>
      )}

      <div>
        <div className="cre-label" style={{ marginLeft: 2 }}>MARKET CONTEXT · RECORDED VALUES</div>
        <div className="cre-metrics">
          <MetricCard label="LIQUIDITY" comparison={model.liquidity} format={fmtUsd} changeText={(c) => `${signed(c, 1)}%`} worseWhen="down" />
          <MetricCard label="MARKET CAP" comparison={model.marketCap} format={fmtUsd} changeText={(c) => `${signed(c, 1)}%`} worseWhen={null} />
          <MetricCard label="TOP-10 HOLDER SHARE" comparison={model.topHolders} format={(n) => `${n}%`} changeText={(c) => `${signed(c)} pts`} worseWhen="up" />
        </div>
      </div>
    </div>
  )
}

function BeforeAfter({ first, latest, delta }: { first: CortexObservation; latest: CortexObservation; delta: number }) {
  const card = (o: CortexObservation, tag: string) => (
    <div className="cre-panel" style={{ borderColor: `${scoreColor(o.riskScore)}40`, minWidth: 0 }}>
      <div className="cre-label">{tag}</div>
      <div style={{ color: scoreColor(o.riskScore), fontSize: 26, fontWeight: 800, lineHeight: 1.1 }}>{o.riskScore}<span style={{ color: DIM, fontSize: 12 }}>/100</span></div>
      {o.riskLabel && <div style={{ color: scoreColor(o.riskScore), fontSize: 11, fontWeight: 700, marginTop: 4 }}>{o.riskLabel}</div>}
      <div style={{ color: DIM, fontSize: 10, marginTop: 8, lineHeight: 1.6 }}>{fmtTime(o.observedAt)}<br />{coverageText(o)}</div>
    </div>
  )
  const color = delta > 0 ? WORSE : delta < 0 ? BETTER : MUTED
  return (
    <figure style={{ margin: 0 }} aria-label="Risk score, first versus latest recorded scan">
      <div className="cre-ba">
        {card(first, 'FIRST RECORDED SCAN')}
        <div className="cre-ba-mid" style={{ color }}>
          <span style={{ fontSize: 15, fontWeight: 800 }}>{delta === 0 ? '=' : signed(delta)}</span>
          <span className="cre-ba-arrow" aria-hidden>→</span>
          <span style={{ fontSize: 9, color: DIM }}>{formatSpan(Date.parse(latest.observedAt) - Date.parse(first.observedAt))} apart</span>
        </div>
        {card(latest, 'LATEST RECORDED SCAN')}
      </div>
      <figcaption style={{ color: DIM, fontSize: 10, marginTop: 8 }}>
        Two recorded scans: shown side by side. A chart appears from three comparable scans; no line is drawn between two points.
      </figcaption>
    </figure>
  )
}

const BANDS = [
  { from: 0, to: 20, color: '#34d399' },
  { from: 20, to: 40, color: '#fbbf24' },
  { from: 40, to: 60, color: '#f59e0b' },
  { from: 60, to: 75, color: '#f97316' },
  { from: 75, to: 100, color: '#f87171' },
]

function RiskChart({ model }: { model: Extract<RiskEvolutionModel, { state: 'trend' }> }) {
  const { points } = model
  const [active, setActive] = useState(points.length - 1)
  const labelled = labelledPointIndexes(points)
  const p = points[Math.min(active, points.length - 1)]
  const prev = active > 0 ? points[active - 1].observation : null
  const o = p.observation
  const liq = storedUsd(o.liquidityUsd)
  const mcap = storedUsd(o.marketCapUsd)
  const tipLeft = p.xPct > 62
  const detail = (
    <>
      <div style={{ color: DIM, fontSize: 9 }}>{fmtTime(o.observedAt)}</div>
      <div style={{ color: scoreColor(o.riskScore), fontSize: 15, fontWeight: 800 }}>
        {o.riskScore}/100{o.riskLabel ? <span style={{ fontSize: 10, fontWeight: 600 }}> · {o.riskLabel}</span> : null}
      </div>
      {prev && <div style={{ color: o.riskScore > prev.riskScore ? WORSE : o.riskScore < prev.riskScore ? BETTER : MUTED, fontSize: 10 }}>{signed(o.riskScore - prev.riskScore)} vs previous scan</div>}
      <div style={{ color: MUTED, fontSize: 10, marginTop: 4 }}>{coverageText(o)}</div>
      <div style={{ color: DIM, fontSize: 10, marginTop: 2 }}>Liq {liq != null ? fmtUsd(liq) : '—'} · MCap {mcap != null ? fmtUsd(mcap) : '—'}{o.holderPoints != null ? ` · Top-10 ${o.holderPoints}%` : ''}</div>
    </>
  )
  return (
    <figure className="cre-panel" style={{ margin: 0 }} aria-label="Recorded risk score history">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <div className="cre-label" style={{ margin: 0 }}>RISK SCORE BY RECORDED SCAN</div>
        <div style={{ color: DIM, fontSize: 10 }}>Hover, tap or tab through points</div>
      </div>
      <div className="cre-chart">
        <div className="cre-yaxis" aria-hidden>
          {[100, 75, 50, 25, 0].map((s) => <span key={s} style={{ top: `${100 - s}%` }}>{s}</span>)}
        </div>
        <div className="cre-plot" onMouseLeave={() => setActive(points.length - 1)}>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden className="cre-svg">
            {BANDS.map((b) => (
              <rect key={b.from} x="0" width="100" y={100 - b.to} height={b.to - b.from} fill={b.color} opacity="0.045" />
            ))}
            {[25, 50, 75].map((y) => (
              <line key={y} x1="0" y1={y} x2="100" y2={y} stroke="rgba(148,163,184,.14)" strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
            ))}
            {/* Dashed segments: they only connect recorded scans; there is no data between them. */}
            <polyline points={points.map((pt) => `${pt.xPct},${pt.yPct}`).join(' ')} fill="none" stroke="url(#cre-line)" strokeWidth="2" strokeDasharray="6 4" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            <line x1={p.xPct} y1="0" x2={p.xPct} y2="100" stroke="rgba(94,234,212,.35)" vectorEffect="non-scaling-stroke" />
            <defs>
              <linearGradient id="cre-line" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor={TEAL} stopOpacity=".55" />
                <stop offset="1" stopColor={AMBER} stopOpacity=".8" />
              </linearGradient>
            </defs>
          </svg>
          {points.map((pt, i) => {
            const color = scoreColor(pt.observation.riskScore)
            const partial = pt.observation.coverage !== 'complete'
            const isActive = i === active
            return (
              <button
                key={`${pt.observation.observedAt}-${i}`}
                type="button"
                className="cre-point"
                aria-label={`${fmtTime(pt.observation.observedAt)}: risk score ${pt.observation.riskScore} of 100${partial ? ', partial evidence' : ''}`}
                aria-pressed={isActive}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onClick={() => setActive(i)}
                style={{ left: `${pt.xPct}%`, top: `${pt.yPct}%` }}
              >
                {(labelled.has(i) || isActive) && <span className="cre-point-label" style={{ color }}>{pt.observation.riskScore}</span>}
                <span
                  className="cre-point-dot"
                  style={{
                    background: partial ? '#0b1116' : color,
                    boxShadow: `${partial ? `inset 0 0 0 2px ${color}, ` : ''}0 0 0 ${isActive ? 4 : 0}px ${color}33`,
                    transform: `scale(${isActive ? 1.25 : 1})`,
                  }}
                />
              </button>
            )
          })}
          <div className="cre-tip" aria-hidden style={{ left: `${p.xPct}%`, top: `${Math.min(p.yPct, 60)}%`, transform: `translate(${tipLeft ? 'calc(-100% - 14px)' : '14px'}, -10%)` }}>
            {detail}
          </div>
        </div>
      </div>
      {/* Narrow screens: the selected scan's details sit under the chart instead of floating over other points. */}
      <div className="cre-detail" role="status" aria-live="polite">{detail}</div>
      <figcaption className="cre-xaxis">
        <span>{fmtTime(model.first.observedAt)}</span>
        <span style={{ color: DIM }}>{formatSpan(model.spanMs)} · {model.comparable.length} scans</span>
        <span>{fmtTime(model.latest.observedAt)}</span>
      </figcaption>
      <div style={{ color: DIM, fontSize: 10, marginTop: 6 }}>Hollow points: partial evidence. Dashed lines only join recorded scans.</div>
    </figure>
  )
}

function FactorRow({ factor }: { factor: FactorChange }) {
  const meta: Record<FactorChange['direction'], { text: string; color: string; icon: string }> = {
    improved: { text: 'Improved', color: BETTER, icon: '▼' },
    worsened: { text: 'Worsened', color: WORSE, icon: '▲' },
    unchanged: { text: 'Unchanged', color: MUTED, icon: '=' },
    changed: { text: 'Changed', color: AMBER, icon: '↔' },
    not_comparable: { text: 'Not comparable', color: DIM, icon: '·' },
  }
  const m = meta[factor.direction]
  return (
    <div className="cre-factor">
      <div style={{ minWidth: 0 }}>
        <div style={{ color: INK, fontSize: 11, fontWeight: 700 }}>{factor.label}</div>
        <div style={{ color: DIM, fontSize: 10, marginTop: 2, overflowWrap: 'anywhere' }}>
          {factor.direction === 'unchanged' ? humanizeStatus(factor.to) : `${humanizeStatus(factor.from)} → ${humanizeStatus(factor.to)}`}
        </div>
      </div>
      <span className="cre-tag" style={{ color: m.color, borderColor: `${m.color}55` }}>{m.icon} {m.text}</span>
    </div>
  )
}

function MetricCard({ label, comparison, format, changeText, worseWhen }: {
  label: string
  comparison: ValueComparison
  format: (n: number) => string
  changeText: (change: number) => string
  worseWhen: 'up' | 'down' | null
}) {
  const changeColor = !comparison.comparable || comparison.change === 0 || worseWhen == null ? MUTED
    : (comparison.change > 0) === (worseWhen === 'up') ? WORSE : BETTER
  return (
    <div className="cre-panel" style={{ minWidth: 0 }}>
      <div className="cre-label">{label}</div>
      {comparison.comparable ? (
        <>
          <div style={{ color: INK, fontSize: 13, fontWeight: 700, overflowWrap: 'anywhere' }}>{format(comparison.from)} → {format(comparison.to)}</div>
          <div style={{ color: changeColor, fontSize: 16, fontWeight: 800, marginTop: 4 }}>{changeText(comparison.change)}</div>
        </>
      ) : (
        <>
          <div style={{ color: INK, fontSize: 13, fontWeight: 700 }}>Not comparable</div>
          <div style={{ color: DIM, fontSize: 10, marginTop: 4, lineHeight: 1.5 }}>{comparison.reason}</div>
        </>
      )}
    </div>
  )
}

const CSS = `
.cre-root{margin-bottom:16px;padding:clamp(14px,3.5vw,20px);border-radius:16px;position:relative;min-width:0;font-family:var(--font-plex-mono);
  background:radial-gradient(120% 140% at 0% 0%,rgba(45,212,191,.09),transparent 55%),radial-gradient(90% 120% at 100% 100%,rgba(251,191,36,.06),transparent 60%),linear-gradient(150deg,rgba(12,19,24,.97),rgba(6,10,14,.99));
  border:1px solid rgba(45,212,191,.22);box-shadow:inset 0 1px 0 rgba(255,255,255,.03)}
.cre-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.cre-kicker{font-size:11px;font-weight:800;letter-spacing:.16em;color:#5eead4}
.cre-sub{font-size:10px;color:#64748b;margin-top:4px}
.cre-chip{display:inline-flex;align-items:center;gap:6px;font-size:9px;font-weight:800;letter-spacing:.12em;padding:4px 9px;border-radius:999px;border:1px solid;white-space:nowrap}
.cre-pulse{width:6px;height:6px;border-radius:50%;display:inline-block;animation:crePulse 1.4s ease-in-out infinite;flex-shrink:0}
@keyframes crePulse{0%,100%{opacity:.35}50%{opacity:1}}
.cre-status{display:flex;align-items:center;gap:8px;font-size:11px;margin-bottom:12px;line-height:1.5}
.cre-panel{padding:14px;border-radius:12px;background:rgba(255,255,255,.022);border:1px solid rgba(148,163,184,.12)}
.cre-label{font-size:9px;letter-spacing:.12em;color:#64748b;margin-bottom:8px;font-weight:700}
.cre-grid-hero{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.4fr);gap:12px}
.cre-hero{display:flex;flex-direction:column;justify-content:center}
.cre-delta{font-size:11px;font-weight:800;padding:2px 8px;border:1px solid;border-radius:999px;margin-left:4px}
.cre-track{height:4px;border-radius:999px;background:rgba(255,255,255,.06);overflow:hidden;margin-top:10px}
.cre-track>div{height:100%;border-radius:999px}
.cre-notes{list-style:none;margin:0;padding:0;display:grid;gap:7px}
.cre-notes li{display:flex;gap:8px;align-items:flex-start;color:#cbd5e1;font-size:11px;line-height:1.55}
.cre-dot{width:6px;height:6px;border-radius:50%;margin-top:6px;flex-shrink:0}
.cre-timeline{display:flex;align-items:center;gap:6px}
.cre-node{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.cre-node-ghost{border:1px dashed rgba(148,163,184,.5)}
.cre-rail{flex:1;height:1px;background:repeating-linear-gradient(90deg,rgba(148,163,184,.4) 0 4px,transparent 4px 8px)}
.cre-ba{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:10px;align-items:stretch}
.cre-ba-mid{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:0 4px}
.cre-ba-arrow{font-size:20px;line-height:1}
.cre-chart{display:grid;grid-template-columns:24px minmax(0,1fr);gap:8px;padding-top:6px}
.cre-yaxis{position:relative;height:190px;color:#64748b;font-size:9px}
.cre-yaxis span{position:absolute;right:0;transform:translateY(-50%)}
.cre-plot{position:relative;height:190px;min-width:0;margin:0 10px}
.cre-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.cre-point{position:absolute;transform:translate(-50%,-50%);width:28px;height:28px;padding:0;border:0;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:50%}
.cre-point:focus-visible{outline:2px solid #5eead4;outline-offset:1px}
.cre-point-dot{display:block;width:10px;height:10px;border-radius:50%;border:2px solid #0b1116;box-sizing:content-box;transition:transform .15s ease,box-shadow .15s ease}
.cre-point-label{position:absolute;bottom:22px;left:50%;transform:translateX(-50%);font-size:10px;font-weight:800;white-space:nowrap;pointer-events:none}
.cre-tip{position:absolute;pointer-events:none;min-width:170px;max-width:220px;padding:9px 11px;border-radius:10px;background:rgba(8,12,16,.96);border:1px solid rgba(94,234,212,.28);box-shadow:0 8px 24px rgba(0,0,0,.45);z-index:2}
.cre-detail{display:none}
.cre-xaxis{display:flex;justify-content:space-between;gap:8px;margin:6px 10px 0 42px;color:#94a3b8;font-size:10px;flex-wrap:wrap}
.cre-factors{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:8px}
.cre-factor{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 10px;border-radius:9px;background:rgba(255,255,255,.02);border:1px solid rgba(148,163,184,.09)}
.cre-tag{font-size:9px;font-weight:800;letter-spacing:.06em;padding:3px 7px;border-radius:999px;border:1px solid;white-space:nowrap}
.cre-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));gap:10px}
.cre-btn{font-family:inherit;font-size:11px;font-weight:700;color:#5eead4;background:rgba(94,234,212,.08);border:1px solid rgba(94,234,212,.35);border-radius:8px;padding:6px 12px;cursor:pointer}
.cre-btn-sm{padding:3px 9px;font-size:10px}
.cre-foot{color:#64748b;font-size:10px;margin-top:14px;line-height:1.6}
@media (max-width:640px){
  .cre-grid-hero{grid-template-columns:minmax(0,1fr)}
  .cre-ba{grid-template-columns:minmax(0,1fr)}
  .cre-ba-arrow{transform:rotate(90deg)}
  .cre-plot,.cre-yaxis{height:160px}
  .cre-tip{display:none}
  .cre-detail{display:block;margin-top:10px;padding:9px 11px;border-radius:10px;background:rgba(8,12,16,.9);border:1px solid rgba(94,234,212,.22)}
}
@media (prefers-reduced-motion:reduce){.cre-pulse{animation:none}.cre-point-dot{transition:none}}
`
