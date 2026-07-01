// Shared personality-label card. Takes a pre-derived label (see
// app/frontend/lib/holdingsHeuristics.derivePersonality) — never derives anything itself, so this
// stays a dumb presentational component reusable across sections.
import { motion } from 'framer-motion'

export function PersonalityCard({ title, label }: { title: string; label: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      style={{
        padding: '12px 16px', borderRadius: '13px', marginBottom: '16px',
        background: 'linear-gradient(135deg, rgba(139,92,246,0.08), rgba(45,212,191,0.05))',
        border: '1px solid rgba(139,92,246,0.22)', display: 'flex', alignItems: 'center', gap: '10px',
      }}
    >
      <span style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.65)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
        {title}
      </span>
      <span style={{ fontSize: '13px', fontWeight: 800, color: '#c4b5fd' }}>{label}</span>
    </motion.div>
  )
}

export default PersonalityCard
