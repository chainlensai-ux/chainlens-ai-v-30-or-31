// Shared metric card for PnL-style headers (Realized PnL / Unrealized PnL / ROI). Color-codes only
// on the real numeric sign — green for positive, red for negative, gray for null/zero. Never
// colors a null value as if it were a real result.
import { motion } from 'framer-motion'

export type PnLHeaderCardProps = {
  label: string
  value: string
  tone: 'positive' | 'negative' | 'neutral'
  index?: number
}

const TONE_COLOR: Record<PnLHeaderCardProps['tone'], string> = {
  positive: '#4ade80',
  negative: '#f87171',
  neutral: 'rgba(148,163,184,0.55)',
}

export function toneFromValue(value: number | null | undefined): PnLHeaderCardProps['tone'] {
  if (value == null) return 'neutral'
  if (value > 0) return 'positive'
  if (value < 0) return 'negative'
  return 'neutral'
}

export function PnLHeaderCard({ label, value, tone, index = 0 }: PnLHeaderCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, delay: index * 0.04 }}
      whileHover={{ scale: 1.015 }}
      style={{
        flex: '1 1 170px', minWidth: '150px', padding: '14px 16px', borderRadius: '13px',
        background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <div style={{ fontSize: '9px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: '6px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
        {label}
      </div>
      <div style={{ fontSize: '18px', fontWeight: 800, color: TONE_COLOR[tone] }}>{value}</div>
    </motion.div>
  )
}

export default PnLHeaderCard
