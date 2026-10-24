// Shared section divider — clear visual separation between major report sections (Wallet
// Personality / PnL Summary / Holdings / Behavior Intel / Diagnostics). Purely presentational.
import { motion } from 'framer-motion'

export function SectionDivider({ label, optional }: { label: string; optional?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '28px 0 16px' }}
    >
      <span style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', color: optional ? 'rgba(158,161,164,0.45)' : 'rgba(31,214,220,0.75)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', whiteSpace: 'nowrap' }}>
        {label}{optional ? ' (optional)' : ''}
      </span>
      <span style={{ flex: 1, height: '1px', background: optional ? 'rgba(255,255,255,0.05)' : 'linear-gradient(90deg, rgba(31,214,220,0.35), transparent)' }} />
    </motion.div>
  )
}

export default SectionDivider
