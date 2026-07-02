// Shared generic metric tile — label + value + optional icon/sub, tone-colored. Reused by
// PnlStatusCard's metric grid. Distinct from PnLHeaderCard (kept as-is, still used by the older
// PnLTab) — this version adds an icon slot and a fixed min-height for grid uniformity.
import { motion } from 'framer-motion'
import type { ReactNode } from 'react'

export type MetricCardTone = 'positive' | 'negative' | 'neutral'

const TONE_COLOR: Record<MetricCardTone, string> = {
  positive: '#4ade80',
  negative: '#f87171',
  neutral: 'rgba(226,232,240,0.92)',
}

export function toneFromNumber(value: number | null | undefined): MetricCardTone {
  if (value == null) return 'neutral'
  if (value > 0) return 'positive'
  if (value < 0) return 'negative'
  return 'neutral'
}

export type MetricCardProps = {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: MetricCardTone
  icon?: ReactNode
  index?: number
}

export function MetricCard({ label, value, sub, tone = 'neutral', icon, index = 0 }: MetricCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay: Math.min(index, 20) * 0.035 }}
      whileHover={{ scale: 1.02 }}
      style={{
        flex: '1 1 150px', minWidth: '140px', minHeight: '78px', padding: '13px 15px', borderRadius: '13px',
        background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '2px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '9px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.72)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
        {icon}
        {label}
      </div>
      <div style={{ fontSize: '17px', fontWeight: 800, color: TONE_COLOR[tone] }}>{value}</div>
      {sub && <div style={{ fontSize: '10px', color: 'rgba(148,163,184,0.55)' }}>{sub}</div>}
    </motion.div>
  )
}

export default MetricCard
