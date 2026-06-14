'use client'

import { useMemo } from 'react'
import type { RadarTimeline } from '@/lib/baseRadarSignals'

const TREND_LABELS: Record<RadarTimeline['trend'], string> = {
  up: 'Up',
  down: 'Down',
  flat: 'Flat',
  unknown: 'Unknown',
}

const TREND_COLORS: Record<RadarTimeline['trend'], string> = {
  up: '#34d399',
  down: '#fca5a5',
  flat: '#94a3b8',
  unknown: '#64748b',
}

export default function TimelineMiniChart({ timeline }: { timeline: RadarTimeline }) {
  const { points, trend, label } = timeline

  const path = useMemo(() => {
    const values = points.map((p) => p.value)
    if (values.length < 2) return ''
    const min = Math.min(...values)
    const max = Math.max(...values)
    const spread = max - min || 1
    return values.map((v, i) => {
      const x = (i / (values.length - 1)) * 320
      const y = 56 - ((v - min) / spread) * 44
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    }).join(' ')
  }, [points])

  return (
    <section style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.03)', borderRadius: '14px', padding: '14px', marginBottom: '12px', maxWidth: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '8px' }}>
        <h3 style={{ margin: 0, color: '#f8fafc', fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Timeline</h3>
        <span style={{ padding: '3px 8px', borderRadius: '999px', border: `1px solid ${TREND_COLORS[trend]}55`, background: `${TREND_COLORS[trend]}1a`, color: TREND_COLORS[trend], fontSize: '9px', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          {TREND_LABELS[trend]}
        </span>
      </div>
      {path ? (
        <svg viewBox="0 0 320 64" width="100%" height="72" role="img" aria-label="Radar timeline mini chart" style={{ display: 'block', maxWidth: '100%', borderRadius: '10px', background: 'rgba(15,23,42,0.65)', border: '1px solid rgba(45,212,191,0.12)' }}>
          <path d={path} fill="none" stroke={TREND_COLORS[trend]} strokeWidth="2" />
          <path d={`${path} L320 64 L0 64 Z`} fill={`${TREND_COLORS[trend]}14`} stroke="none" />
        </svg>
      ) : null}
      <p style={{ margin: '8px 0 0', color: '#94a3b8', fontSize: '11px', lineHeight: 1.45 }}>{label}</p>
    </section>
  )
}
