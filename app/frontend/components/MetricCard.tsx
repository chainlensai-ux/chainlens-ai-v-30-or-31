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

// VISUAL PRIORITY, DISCLOSED, ADDITIVE (UI/trust follow-up task — confirmed production confusion: a
// stable Realized PnL rendered with the exact same visual weight as a naturally-moving combined
// estimate, so the two read as equally "official" and any movement in the estimate looked like the
// verified number itself had changed). `emphasis` is purely presentational — it never touches
// `value`/`tone`/any selector logic. Defaults to `'primary'`, the pre-existing look, so every
// existing caller is visually unchanged; `'muted'` is opt-in, used only for the non-official
// combined/unrealized tiles.
export type MetricCardEmphasis = 'primary' | 'muted'

export type MetricCardProps = {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: MetricCardTone
  icon?: ReactNode
  index?: number
  emphasis?: MetricCardEmphasis
}

export function MetricCard({ label, value, sub, tone = 'neutral', icon, index = 0, emphasis = 'primary' }: MetricCardProps) {
  const muted = emphasis === 'muted'
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay: Math.min(index, 20) * 0.035 }}
      whileHover={{ scale: 1.02 }}
      style={{
        flex: '1 1 150px', minWidth: '140px', minHeight: '78px', padding: '13px 15px', borderRadius: '13px',
        background: muted ? 'rgba(255,255,255,0.012)' : 'rgba(255,255,255,0.02)',
        border: muted ? '1px dashed rgba(255,255,255,0.08)' : '1px solid rgba(255,255,255,0.06)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '2px',
        opacity: muted ? 0.82 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '9px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.72)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
        {icon}
        {label}
      </div>
      <div style={{ fontSize: muted ? '15px' : '17px', fontWeight: muted ? 700 : 800, color: muted ? 'rgba(226,232,240,0.75)' : TONE_COLOR[tone] }}>{value}</div>
      {sub && <div style={{ fontSize: '10px', color: 'rgba(148,163,184,0.55)' }}>{sub}</div>}
    </motion.div>
  )
}

export default MetricCard
