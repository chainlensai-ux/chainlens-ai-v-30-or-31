'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

type Observation = {
  observedAt: string
  riskScore: number
  riskLabel: string | null
  coverage: string
  liquidityUsd: number | string | null
  marketCapUsd: number | string | null
  holderPoints: number | null
  holderBasis: string | null
  scannerVersion: string
  riskMethodologyVersion: string
}

type Props = {
  chain: string
  contract: string
}

export default function CortexRiskEvolution({ chain, contract }: Props) {
  const [observations, setObservations] = useState<Observation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [disabled, setDisabled] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function loadHistory() {
      setLoading(true)
      setError(false)
      setDisabled(false)
      setObservations([])

      try {
        const { data } = await supabase.auth.getSession()
        const token = data.session?.access_token
        // Preview requires authentication; Production returns 404 regardless.
        // Allow the request without a token so disabled environments can hide the panel.

        const query = new URLSearchParams({ chain, contract })
        const response = await fetch(`/api/cortex/history?${query}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: 'no-store',
        })

        if (response.status === 404) {
          if (!cancelled) setDisabled(true)
          return
        }

        if (!response.ok) throw new Error('history_unavailable')

        const json = await response.json()
        if (!cancelled) {
          setObservations(Array.isArray(json.observations) ? json.observations : [])
        }
      } catch {
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    if (chain && contract) void loadHistory()

    return () => { cancelled = true }
  }, [chain, contract])

  const history = observations
    .filter(o =>
      Number.isInteger(o.riskScore) &&
      o.riskScore >= 0 &&
      o.riskScore <= 100 &&
      Number.isFinite(Date.parse(o.observedAt))
    )
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))

  const latest = history.at(-1)
  const comparable = latest
    ? history.filter(o =>
        o.scannerVersion === latest.scannerVersion &&
        o.riskMethodologyVersion === latest.riskMethodologyVersion
      )
    : []

  const first = comparable[0]
  const last = comparable.at(-1)
  const hasTrend = comparable.length >= 2
  const delta = hasTrend ? last!.riskScore - first!.riskScore : null

  const fmtMoney = (value: number | string | null) => {
    if (value == null) return 'Unavailable'
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return 'Unavailable'
    return '$' + n.toLocaleString('en-AU', { maximumFractionDigits: 0 })
  }

  const metricChange = (key: 'liquidityUsd' | 'marketCapUsd') => {
    if (!hasTrend) return null
    const a = Number(first![key])
    const b = Number(last![key])
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null
    return ((b - a) / a) * 100
  }

  const liquidityChange = metricChange('liquidityUsd')
  const marketCapChange = metricChange('marketCapUsd')

  const holdersComparable =
    hasTrend &&
    first!.holderPoints != null &&
    last!.holderPoints != null &&
    first!.holderBasis != null &&
    first!.holderBasis === last!.holderBasis

  const holderChange = holdersComparable
    ? last!.holderPoints! - first!.holderPoints!
    : null

  const riskColor = delta == null ? '#94a3b8'
    : delta > 0 ? '#fb7185'
    : delta < 0 ? '#34d399' : '#94a3b8'

  const chartPoints = comparable.map((o, i) => ({
    x: comparable.length === 1 ? 0 : 12 + (i * 476) / (comparable.length - 1),
    y: 112 - o.riskScore,
    observation: o,
  }))

  const line = chartPoints.map(p => `${p.x},${p.y}`).join(' ')

  if (disabled || loading) return null

  return (
    <section style={{
      marginBottom: 16,
      padding: '18px 20px',
      borderRadius: 16,
      background: 'linear-gradient(150deg,rgba(12,19,24,.96),rgba(6,10,14,.98))',
      border: '1px solid rgba(45,212,191,.22)',
      fontFamily: 'var(--font-plex-mono)',
    }}>
      <div style={{
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: '.14em',
        color: '#5eead4',
        marginBottom: 8,
      }}>
        CORTEX RISK EVOLUTION
      </div>

      {loading ? (
        <p style={{ color: '#9ca3af', fontSize: 12 }}>Loading historical evidence...</p>
      ) : error ? (
        <p style={{ color: '#9ca3af', fontSize: 12 }}>
          Historical risk data is currently unavailable.
        </p>
      ) : observations.length === 0 ? (
        <p style={{ color: '#9ca3af', fontSize: 12 }}>
          No historical observations recorded yet.
        </p>
      ) : (
        <div>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            gap: 12, flexWrap: 'wrap', alignItems: 'center',
          }}>
            <div>
              <div style={{ color: '#f1f5f9', fontSize: 12, fontWeight: 800 }}>
                {hasTrend ? 'HISTORICAL RISK TREND' : 'BUILDING HISTORY'}
              </div>
              <div style={{ color: '#64748b', fontSize: 10, marginTop: 5 }}>
                {history.length} recorded observation{history.length === 1 ? '' : 's'}
                {' · '}Last observed {latest
                  ? new Date(latest.observedAt).toLocaleString('en-AU')
                  : 'unknown'}
              </div>
            </div>

            {hasTrend && (
              <div style={{
                color: riskColor, fontSize: 16,
                fontWeight: 800, textAlign: 'right',
              }}>
                {delta! > 0 ? '+' : ''}{delta} risk points
                <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 500 }}>
                  {delta! > 0 ? 'Risk increased' :
                   delta! < 0 ? 'Risk decreased' : 'Risk unchanged'}
                </div>
              </div>
            )}
          </div>

          {hasTrend ? (
            <>
              <div style={{ marginTop: 20, width: '100%', overflow: 'hidden' }}>
                <svg viewBox="0 0 500 135"
                  role="img"
                  aria-label="Historical risk scores from recorded token scans"
                  style={{ width: '100%', display: 'block' }}>
                  {[12, 62, 112].map(y => (
                    <line key={y} x1="12" y1={y} x2="488" y2={y}
                      stroke="rgba(148,163,184,.16)" strokeDasharray="4 5" />
                  ))}
                  <polyline points={line}
                    fill="none" stroke={riskColor}
                    strokeWidth="2.5" strokeLinejoin="round" />
                  {chartPoints.map((p, i) => (
                    <circle key={i} cx={p.x} cy={p.y} r="4"
                      fill={riskColor} stroke="#0c1318" strokeWidth="2">
                      <title>
                        {new Date(p.observation.observedAt).toLocaleString('en-AU')}
                        {': '}{p.observation.riskScore}/100
                      </title>
                    </circle>
                  ))}
                </svg>
              </div>

              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(135px,1fr))',
                gap: 10, marginTop: 12,
              }}>
                {[
                  { label: 'FIRST RISK SCORE', value: first!.riskScore + '/100' },
                  { label: 'LATEST RISK SCORE', value: last!.riskScore + '/100' },
                  { label: 'LIQUIDITY CHANGE', value: liquidityChange == null
                      ? 'Not comparable' : `${liquidityChange >= 0 ? '+' : ''}${liquidityChange.toFixed(1)}%` },
                  { label: 'MARKET CAP CHANGE', value: marketCapChange == null
                      ? 'Not comparable' : `${marketCapChange >= 0 ? '+' : ''}${marketCapChange.toFixed(1)}%` },
                  { label: 'TOP-10 HOLDER CHANGE', value: holderChange == null
                      ? 'Not comparable' : `${holderChange >= 0 ? '+' : ''}${holderChange} points` },
                ].map(metric => (
                  <div key={metric.label} style={{
                    padding: 12, borderRadius: 10,
                    background: 'rgba(255,255,255,.025)',
                    border: '1px solid rgba(148,163,184,.12)',
                  }}>
                    <div style={{
                      color: '#64748b', fontSize: 9,
                      letterSpacing: '.07em', marginBottom: 7,
                    }}>{metric.label}</div>
                    <div style={{
                      color: '#e2e8f0', fontSize: 15, fontWeight: 800,
                    }}>{metric.value}</div>
                  </div>
                ))}
              </div>

              <div style={{
                color: '#94a3b8', fontSize: 11,
                lineHeight: 1.7, marginTop: 14,
              }}>
                {delta! > 0
                  ? `Risk increased by ${delta} points between recorded observations.`
                  : delta! < 0
                    ? `Risk decreased by ${Math.abs(delta!)} points between recorded observations.`
                    : 'Risk score remained unchanged between the first and latest comparable observations.'}
                {' '}These are scan observations, not continuous monitoring.
              </div>
            </>
          ) : (
            <div style={{
              marginTop: 14, padding: 14, borderRadius: 10,
              background: 'rgba(94,234,212,.04)',
              border: '1px solid rgba(94,234,212,.12)',
            }}>
              <div style={{
                color: '#f1f5f9', fontSize: 17,
                fontWeight: 800, marginBottom: 6,
              }}>
                {latest ? latest.riskScore + '/100' : '—'}
              </div>
              <div style={{
                color: '#94a3b8', fontSize: 11, lineHeight: 1.7,
              }}>
                More distinct observations using the same scoring methodology
                are needed before a reliable historical comparison is available.
              </div>
              {latest && (
                <div style={{ color: '#64748b', fontSize: 10, marginTop: 9 }}>
                  Stored liquidity: {fmtMoney(latest.liquidityUsd)}
                  {' · '}Evidence: {latest.coverage}
                </div>
              )}
            </div>
          )}

          <div style={{
            color: '#64748b', fontSize: 10,
            marginTop: 14, lineHeight: 1.6,
          }}>
            {comparable.length < history.length
              ? 'Some observations use different scanner or risk methodologies and are excluded from this comparison. '
              : ''}
            Partial evidence and irregular scan intervals can affect interpretation.
            Historical changes are not predictions of future performance.
          </div>
        </div>
      )}
    </section>
  )
}
