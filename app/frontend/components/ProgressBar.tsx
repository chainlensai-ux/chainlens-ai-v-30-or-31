// Shared generic progress bar — value/max, with a color and optional label. Reused by
// RecoveryHealthCard (pages used) and available for any future percentage visualization.
import { motion } from 'framer-motion'

export type ProgressBarProps = {
  value: number
  max: number
  color?: string
  height?: number
  label?: string
}

export function ProgressBar({ value, max, color = '#2DD4BF', height = 6, label }: ProgressBarProps) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0

  return (
    <div>
      {label && <div style={{ fontSize: '10px', color: 'rgba(148,163,184,0.60)', marginBottom: '6px' }}>{label}</div>}
      <div style={{ height, borderRadius: '999px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          style={{ height: '100%', borderRadius: '999px', background: `linear-gradient(90deg, ${color}, ${color}cc)` }}
        />
      </div>
    </div>
  )
}

export default ProgressBar
