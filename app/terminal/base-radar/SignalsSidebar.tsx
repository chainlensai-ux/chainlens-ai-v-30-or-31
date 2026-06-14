'use client'

import type { RadarSignal, RadarSignalSeverity } from '@/lib/baseRadarSignals'

const SEVERITY_COLORS: Record<RadarSignalSeverity, string> = {
  positive: '#34d399',
  neutral: '#94a3b8',
  watch: '#fbbf24',
  risk: '#fb923c',
  critical: '#f87171',
}

const SEVERITY_LABELS: Record<RadarSignalSeverity, string> = {
  positive: 'Positive',
  neutral: 'Neutral',
  watch: 'Watch',
  risk: 'Risk',
  critical: 'Critical',
}

function SignalRow({ signal }: { signal: RadarSignal }) {
  const color = SEVERITY_COLORS[signal.severity]
  return (
    <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <span aria-hidden style={{ marginTop: '4px', width: '8px', height: '8px', borderRadius: '999px', background: color, flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: '#e2e8f0', fontSize: '11px', fontWeight: 700 }}>{signal.label}</span>
          <span style={{ padding: '2px 6px', borderRadius: '999px', border: `1px solid ${color}55`, background: `${color}1a`, color, fontSize: '9px', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {SEVERITY_LABELS[signal.severity]}
          </span>
        </div>
        <p style={{ margin: '4px 0 0', color: '#94a3b8', fontSize: '11px', lineHeight: 1.45 }}>{signal.reason}</p>
      </div>
    </div>
  )
}

export default function SignalsSidebar({ signals }: { signals: RadarSignal[] }) {
  return (
    <section style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.03)', borderRadius: '14px', padding: '14px', marginBottom: '12px', maxWidth: '100%', overflow: 'hidden' }}>
      <h3 style={{ margin: '0 0 8px', color: '#f8fafc', fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Signals</h3>
      <div>
        {signals.map((signal, idx) => <SignalRow key={`${signal.label}-${idx}`} signal={signal} />)}
      </div>
    </section>
  )
}
