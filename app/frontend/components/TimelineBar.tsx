// Shared horizontal dot-plot timeline — points plotted proportionally by real timestamp, colored
// by caller-supplied tone, with hover-for-details. Reused by PnlStatusCard's sell timeline.
import { useState } from 'react'
import { motion } from 'framer-motion'

export type TimelinePoint = {
  key: string
  timestamp: number
  color: string
  tooltip: string
}

export function TimelineBar({ points }: { points: TimelinePoint[] }) {
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  if (points.length === 0) return null

  const timestamps = points.map((p) => p.timestamp)
  const minTs = Math.min(...timestamps)
  const maxTs = Math.max(...timestamps)
  const span = maxTs - minTs || 1
  const hovered = points.find((p) => p.key === hoverKey) ?? null

  return (
    <div style={{ position: 'relative', height: '48px', borderRadius: '10px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{ position: 'absolute', left: '4%', right: '4%', top: '50%', height: '1px', background: 'rgba(255,255,255,0.10)' }} />
      {points.map((p, i) => {
        const pct = 4 + ((p.timestamp - minTs) / span) * 92
        return (
          <motion.div
            key={p.key}
            initial={{ opacity: 0, scale: 0 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.2, delay: Math.min(i, 20) * 0.03 }}
            whileHover={{ scale: 1.4 }}
            onMouseEnter={() => setHoverKey(p.key)}
            onMouseLeave={() => setHoverKey((cur) => (cur === p.key ? null : cur))}
            style={{
              position: 'absolute', left: `${pct}%`, top: '50%', width: '10px', height: '10px',
              borderRadius: '999px', background: p.color, transform: 'translate(-50%, -50%)', cursor: 'pointer',
              boxShadow: `0 0 8px ${p.color}80`,
            }}
          />
        )
      })}
      {hovered && (
        <div
          style={{
            position: 'absolute', bottom: '54px',
            left: `${4 + ((hovered.timestamp - minTs) / span) * 92}%`,
            transform: 'translateX(-50%)', padding: '8px 10px', borderRadius: '9px',
            background: '#0b1220', border: '1px solid rgba(255,255,255,0.12)', fontSize: '11px',
            color: '#e2e8f0', whiteSpace: 'nowrap', zIndex: 10,
          }}
        >
          {hovered.tooltip}
        </div>
      )}
    </div>
  )
}

export default TimelineBar
