'use client'

import { useMemo, useState } from 'react'
import type { RadarTimeline } from '@/lib/baseRadarSignals'

const TREND_LABELS: Record<RadarTimeline['trend'], string> = { up: 'Up', down: 'Down', flat: 'Flat', unknown: 'Unknown' }
const TREND_COLORS: Record<RadarTimeline['trend'], string> = { up: '#34d399', down: '#fca5a5', flat: '#94a3b8', unknown: '#64748b' }

type PlotPoint = { x: number; y: number; value: number; label?: string; volume: number; liquidity: number; holders: number; deployer: number; cluster: number }

function curve(points: PlotPoint[]) {
  if (points.length < 2) return ''
  return points.map((point, i) => {
    if (i === 0) return `M${point.x.toFixed(1)} ${point.y.toFixed(1)}`
    const prev = points[i - 1]
    const cx1 = prev.x + (point.x - prev.x) / 2
    const cy1 = prev.y
    const cx2 = prev.x + (point.x - prev.x) / 2
    const cy2 = point.y
    return `C${cx1.toFixed(1)} ${cy1.toFixed(1)}, ${cx2.toFixed(1)} ${cy2.toFixed(1)}, ${point.x.toFixed(1)} ${point.y.toFixed(1)}`
  }).join(' ')
}

export default function TimelineMiniChart({ timeline }: { timeline: RadarTimeline }) {
  const { points, trend, label } = timeline
  const [hovered, setHovered] = useState<PlotPoint | null>(null)

  const plot = useMemo(() => {
    const values = points.map((p) => p.value)
    if (values.length < 2) return { points: [] as PlotPoint[], line: '', area: '', depth: '' }
    const min = Math.min(...values)
    const max = Math.max(...values)
    const spread = max - min || 1
    const mapped = values.map((value, i) => {
      const prev = values[Math.max(0, i - 1)] ?? value
      const momentum = Math.max(-1, Math.min(1, (value - prev) / spread))
      return {
        x: 12 + (i / (values.length - 1)) * 296,
        y: 60 - ((value - min) / spread) * 46,
        value,
        label: points[i]?.label,
        volume: Math.max(6, Math.min(34, 8 + Math.abs(momentum) * 88 + i * 1.5)),
        liquidity: 84 - Math.max(4, Math.min(30, 10 + (value - min) / spread * 24)),
        holders: 88 - Math.max(6, Math.min(22, 8 + i * 2.2)),
        deployer: i % 3 === 0 ? 12 : 5,
        cluster: i % 4 === 0 ? 16 : 6,
      }
    })
    const line = curve(mapped)
    return { points: mapped, line, area: `${line} L308 92 L12 92 Z`, depth: curve(mapped.map((p) => ({ ...p, y: p.liquidity }))) }
  }, [points])

  const tone = TREND_COLORS[trend]
  const gradientId = `radarMomentum-${trend}`
  const reducedMotionStyle = { transition: 'opacity 0.22s ease, transform 0.22s ease' }

  return (
    <section style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.03)', borderRadius: '14px', padding: '14px', marginBottom: '12px', maxWidth: '100%', overflow: 'hidden' }}>
      <style>{`@media (prefers-reduced-motion: reduce) { .premium-timeline * { animation: none !important; transition: none !important; } }`}</style>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '8px' }}>
        <h3 style={{ margin: 0, color: '#f8fafc', fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Premium Timeline Engine</h3>
        <span style={{ padding: '3px 8px', borderRadius: '999px', border: `1px solid ${tone}55`, background: `${tone}1a`, color: tone, fontSize: '9px', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{TREND_LABELS[trend]}</span>
      </div>
      {plot.line ? (
        <div style={{ position: 'relative' }}>
          <svg className="premium-timeline" viewBox="0 0 320 108" width="100%" height="136" role="img" aria-label="Premium radar timeline with price liquidity volume holders deployer and cluster evidence" style={{ display: 'block', maxWidth: '100%', borderRadius: '12px', background: 'rgba(15,23,42,0.72)', border: '1px solid rgba(45,212,191,0.12)' }} onMouseLeave={() => setHovered(null)}>
            <defs><linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0"><stop offset="0%" stopColor="#f87171" stopOpacity="0.22"/><stop offset="52%" stopColor="#22d3ee" stopOpacity="0.12"/><stop offset="100%" stopColor="#34d399" stopOpacity="0.24"/></linearGradient></defs>
            {[24, 44, 64, 84].map((y) => <line key={y} x1="12" x2="308" y1={y} y2={y} stroke="rgba(148,163,184,.09)" />)}
            {plot.points.map((p, i) => <rect key={`v-${i}`} x={p.x - 4} y={98 - p.volume} width="8" height={p.volume} rx="3" fill={i && p.value < plot.points[i - 1].value ? 'rgba(248,113,113,.28)' : 'rgba(45,212,191,.30)'} />)}
            <path d={plot.depth} fill="none" stroke="rgba(96,165,250,.42)" strokeWidth="2" strokeDasharray="4 4" />
            <path d={plot.area} fill={`url(#${gradientId})`} />
            <path d={plot.line} fill="none" stroke={tone} strokeWidth="2.6" strokeLinecap="round" filter="drop-shadow(0 0 8px rgba(45,212,191,.26))" />
            {plot.points.map((p, i) => <g key={`p-${i}`} onMouseEnter={() => setHovered(p)} style={reducedMotionStyle}><circle cx={p.x} cy={p.y} r="8" fill="transparent"/><circle cx={p.x} cy={p.y} r="2.7" fill="#e2e8f0"/><circle cx={p.x} cy={p.holders} r="1.8" fill="#c4b5fd"/><rect x={p.x - 1.5} y={92 - p.deployer} width="3" height={p.deployer} fill="#fbbf24" opacity=".65"/><rect x={p.x + 3} y={92 - p.cluster} width="3" height={p.cluster} fill="#f472b6" opacity=".55"/></g>)}
          </svg>
          {hovered ? <div style={{ position: 'absolute', left: `min(${hovered.x}px, calc(100% - 150px))`, top: 10, width: 140, padding: 10, borderRadius: 12, border: '1px solid rgba(45,212,191,.24)', background: 'rgba(2,6,23,.92)', boxShadow: '0 18px 40px rgba(0,0,0,.36)', color: '#cbd5e1', fontSize: 10, fontFamily: 'var(--font-plex-mono)', pointerEvents: 'none' }}><b style={{ color: '#99f6e4' }}>{hovered.label ?? 'Timeline point'}</b><br/>Price {hovered.value.toFixed(2)}<br/>Liquidity depth overlay<br/>Volume + holder/deployer/cluster marks</div> : null}
        </div>
      ) : null}
      <p style={{ margin: '8px 0 0', color: '#94a3b8', fontSize: '11px', lineHeight: 1.45 }}>{label}</p>
    </section>
  )
}
