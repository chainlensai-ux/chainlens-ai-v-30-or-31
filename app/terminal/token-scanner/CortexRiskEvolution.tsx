'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { riskColorFromCanonicalLabel, riskLabelFromCanonicalScore } from '@/lib/riskScoreDirection'
import {
  buildRiskEvolution, formatSpan, labelledPointIndexes, loadCortexHistory,
  type CortexObservation, type RiskEvolutionModel, type ValueComparison,
} from './cortexRiskEvolutionModel'

type Props = {
  chain: string
  contract: string
}

type LoadState = { status: 'loading' } | { status: 'disabled' } | { status: 'error' } | { status: 'ready'; observations: unknown[] }

const fmtTime = (iso: string | number) =>
  new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

const fmtUsd = (n: number) =>
  '$' + new Intl.NumberFormat('en-US', { notation: n >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: n >= 100_000 ? 2 : 0 }).format(n)

const signed = (n: number, digits = 0) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}`

// A score's own canonical band colour (same thresholds the scanner uses), for points and labels.
const scoreColor = (score: number) => riskColorFromCanonicalLabel(riskLabelFromCanonicalScore(score))

const MUTED = '#94a3b8'
const DIM = '#64748b'
const WORSE = '#fb7185'
const BETTER = '#34d399'

export default function CortexRiskEvolution({ chain, contract }: Props) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    async function run() {
      setLoad({ status: 'loading' })
      // Preview requires authentication; Production returns 404 regardless, which hides the panel.
      const { data } = await supabase.auth.getSession().catch(() => ({ data: { session: null } }))
      const outcome = await loadCortexHistory(chain, contract, data.session?.access_token ?? null)
      if (cancelled) return
      if (outcome.kind === 'disabled') setLoad({ status: 'disabled' })
      else if (outcome.kind === 'error') setLoad({ status: 'error' })
      else setLoad({ status: 'ready', observations: outcome.observations })
    }
    if (chain && contract) void run()
    return () => { cancelled = true }
  }, [chain, contract])

  if (load.status === 'loading' || load.status === 'disabled') return null

  const model: RiskEvolutionModel = load.status === 'ready' ? buildRiskEvolution(load.observations) : { state: 'empty' }

  return (
    <section
      aria-label="CORTEX risk evolution"
      style={{
        marginBottom: 16,
        padding: 'clamp(14px, 3.5vw, 20px)',
        borderRadius: 16,
        background: 'linear-gradient(150deg,rgba(12,19,24,.96),rgba(6,10,14,.98))',
        border: '1px solid rgba(45,212,191,.22)',
        fontFamily: 'var(--font-plex-mono)',
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em', color: '#5eead4', marginBottom: 8 }}>
        CORTEX RISK EVOLUTION
      </div>

      {load.status === 'error' ? (
        <p style={{ color: '#9ca3af', fontSize: 12, margin: 0 }}>Historical risk data is currently unavailable.</p>
      ) : model.state === 'empty' ? (
        <p style={{ color: '#9ca3af', fontSize: 12, margin: 0 }}>No historical observations recorded yet.</p>
      ) : model.state === 'building' ? (
        <BuildingHistory model={model} />
      ) : (
        <Trend model={model} />
      )}

      {model.state !== 'empty' && load.status === 'ready' && (
        <div style={{ color: DIM, fontSize: 10, marginTop: 14, lineHeight: 1.6 }}>
          {model.excludedForMethodology > 0
            ? `${model.excludedForMethodology} earlier observation${model.excludedForMethodology === 1 ? '' : 's'} used a different scanner or risk methodology and ${model.excludedForMethodology === 1 ? 'is' : 'are'} not compared. `
            : ''}
          These are recorded scan observations, not continuous monitoring; nothing between them is estimated.
          Historical changes are not predictions of future performance.
        </div>
      )}
    </section>
  )
}

function BuildingHistory({ model }: { model: Extract<RiskEvolutionModel, { state: 'building' }> }) {
  const { latest } = model
  const liquidity = latest.liquidityUsd == null ? null : Number(latest.liquidityUsd)
  return (
    <div>
      <div style={{ color: '#f1f5f9', fontSize: 12, fontWeight: 800 }}>BUILDING HISTORY</div>
      <div style={{ color: DIM, fontSize: 10, marginTop: 5 }}>
        1 comparable observation · Recorded {fmtTime(latest.observedAt)}
      </div>
      <div style={{ marginTop: 14, padding: 14, borderRadius: 10, background: 'rgba(94,234,212,.04)', border: '1px solid rgba(94,234,212,.12)' }}>
        <div style={{ color: scoreColor(latest.riskScore), fontSize: 17, fontWeight: 800, marginBottom: 6 }}>
          {latest.riskScore}/100{latest.riskLabel ? <span style={{ color: MUTED, fontSize: 11, fontWeight: 600 }}> · {latest.riskLabel}</span> : null}
        </div>
        <div style={{ color: MUTED, fontSize: 11, lineHeight: 1.7 }}>
          A trend appears once this token has a second observation recorded with the same scoring methodology.
        </div>
        <div style={{ color: DIM, fontSize: 10, marginTop: 9 }}>
          Stored liquidity: {liquidity != null && Number.isFinite(liquidity) && liquidity > 0 ? fmtUsd(liquidity) : 'Not recorded'}
          {' · '}Evidence: {latest.coverage}
        </div>
      </div>
    </div>
  )
}

function Trend({ model }: { model: Extract<RiskEvolutionModel, { state: 'trend' }> }) {
  const { riskDelta: delta, first, latest } = model
  const deltaColor = delta > 0 ? WORSE : delta < 0 ? BETTER : MUTED
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: '#f1f5f9', fontSize: 12, fontWeight: 800 }}>HISTORICAL RISK TREND</div>
          <div style={{ color: DIM, fontSize: 10, marginTop: 5, lineHeight: 1.5 }}>
            {model.comparable.length} comparable observations over {formatSpan(model.spanMs)}
            {' · '}Last recorded {fmtTime(latest.observedAt)}
          </div>
        </div>
        <div style={{ color: deltaColor, fontSize: 16, fontWeight: 800, textAlign: 'right' }}>
          {signed(delta)} risk points
          <div style={{ fontSize: 10, color: MUTED, fontWeight: 500 }}>
            {first.riskScore} → {latest.riskScore} · {delta > 0 ? 'Risk increased' : delta < 0 ? 'Risk decreased' : 'Risk unchanged'}
          </div>
        </div>
      </div>

      <RiskChart model={model} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap: 10, marginTop: 12 }}>
        <MetricCard label="LIQUIDITY" comparison={model.liquidity} format={fmtUsd} changeText={(c) => `${signed(c, 1)}%`} worseWhen="down" />
        <MetricCard label="MARKET CAP" comparison={model.marketCap} format={fmtUsd} changeText={(c) => `${signed(c, 1)}%`} worseWhen={null} />
        <MetricCard label="TOP-10 HOLDER SHARE" comparison={model.topHolders} format={(n) => `${n}%`} changeText={(c) => `${signed(c)} pts`} worseWhen="up" />
      </div>

      {model.partialEvidenceCount > 0 && (
        <div style={{ color: '#fbbf24', fontSize: 10, marginTop: 12, lineHeight: 1.6 }}>
          {model.partialEvidenceCount} of {model.comparable.length} observations had partial evidence coverage, so their scores
          rest on fewer checks.
        </div>
      )}
    </div>
  )
}

function RiskChart({ model }: { model: Extract<RiskEvolutionModel, { state: 'trend' }> }) {
  const { points } = model
  const line = points.map((p) => `${p.xPct},${p.yPct}`).join(' ')
  const labelled = labelledPointIndexes(points)
  return (
    <figure style={{ margin: '18px 0 0', minWidth: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: 8 }}>
        {/* Risk score axis: higher is riskier. */}
        <div aria-hidden style={{ position: 'relative', width: 24, height: 150, color: DIM, fontSize: 10, textAlign: 'right' }}>
          {[100, 50, 0].map((score) => (
            <span key={score} style={{ position: 'absolute', right: 0, top: `calc(18px + ${(100 - score) / 100} * (100% - 28px))`, transform: 'translateY(-50%)' }}>{score}</span>
          ))}
        </div>
        <div style={{ position: 'relative', height: 150, minWidth: 0 }}>
          <div style={{ position: 'absolute', top: 18, bottom: 10, left: 8, right: 8 }}>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}>
              {[0, 50, 100].map((y) => (
                <line key={y} x1="0" y1={y} x2="100" y2={y} stroke="rgba(148,163,184,.16)" strokeDasharray="4 5" vectorEffect="non-scaling-stroke" />
              ))}
              <polyline points={line} fill="none" stroke="rgba(226,232,240,.55)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            </svg>
            {points.map((p, i) => {
              const showLabel = labelled.has(i)
              const color = scoreColor(p.observation.riskScore)
              const title = `${fmtTime(p.observation.observedAt)}: ${p.observation.riskScore}/100${p.observation.riskLabel ? ` (${p.observation.riskLabel})` : ''}${p.observation.coverage !== 'complete' ? ', partial evidence' : ''}`
              return (
                <div key={`${p.observation.observedAt}-${i}`} title={title} style={{ position: 'absolute', left: `${p.xPct}%`, top: `${p.yPct}%`, transform: 'translate(-50%, -50%)' }}>
                  {showLabel && (
                    <span style={{ position: 'absolute', bottom: 9, left: '50%', transform: 'translateX(-50%)', color, fontSize: 10, fontWeight: 800, whiteSpace: 'nowrap' }}>
                      {p.observation.riskScore}
                    </span>
                  )}
                  <span style={{
                    display: 'block', width: 9, height: 9, borderRadius: '50%', border: '2px solid #0c1318', boxSizing: 'content-box',
                    // Partial-evidence observations are drawn hollow.
                    background: p.observation.coverage !== 'complete' ? '#0c1318' : color,
                    boxShadow: p.observation.coverage !== 'complete' ? `inset 0 0 0 2px ${color}` : undefined,
                  }} />
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <figcaption style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginLeft: 40, marginTop: 4, color: DIM, fontSize: 10 }}>
        <span>{fmtTime(model.first.observedAt)}</span>
        <span style={{ textAlign: 'right' }}>{fmtTime(model.latest.observedAt)}</span>
      </figcaption>
      <ObservationList observations={model.comparable} />
    </figure>
  )
}

// The same observations as a text list, for screen readers (the chart itself is decorative).
function ObservationList({ observations }: { observations: CortexObservation[] }) {
  return (
    <ul style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', margin: -1, padding: 0 }}>
      {observations.map((o, i) => (
        <li key={`${o.observedAt}-${i}`}>{fmtTime(o.observedAt)}: risk score {o.riskScore} of 100{o.coverage !== 'complete' ? ', partial evidence' : ''}</li>
      ))}
    </ul>
  )
}

function MetricCard({ label, comparison, format, changeText, worseWhen }: {
  label: string
  comparison: ValueComparison
  format: (n: number) => string
  changeText: (change: number) => string
  /** Which direction is the riskier one, for colour only; null = neutral. */
  worseWhen: 'up' | 'down' | null
}) {
  const changeColor = !comparison.comparable || comparison.change === 0 || worseWhen == null ? MUTED
    : (comparison.change > 0) === (worseWhen === 'up') ? WORSE : BETTER
  return (
    <div style={{ padding: 12, borderRadius: 10, background: 'rgba(255,255,255,.025)', border: '1px solid rgba(148,163,184,.12)', minWidth: 0 }}>
      <div style={{ color: DIM, fontSize: 9, letterSpacing: '.07em', marginBottom: 7 }}>{label}</div>
      {comparison.comparable ? (
        <>
          <div style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 700, overflowWrap: 'anywhere' }}>
            {format(comparison.from)} → {format(comparison.to)}
          </div>
          <div style={{ color: changeColor, fontSize: 15, fontWeight: 800, marginTop: 4 }}>{changeText(comparison.change)}</div>
        </>
      ) : (
        <>
          <div style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 700 }}>Not comparable</div>
          <div style={{ color: DIM, fontSize: 10, marginTop: 4, lineHeight: 1.5 }}>{comparison.reason}</div>
        </>
      )}
    </div>
  )
}
