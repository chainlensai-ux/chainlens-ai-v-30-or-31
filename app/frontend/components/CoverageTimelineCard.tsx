'use client'

// CoverageTimelineCard — premium redesign of the Window Coverage section. Frontend-only; does not
// modify behaviorIntel or any other backend module. All three segment values
// (realDataDays/inferredDays/recoveredExtraDays) and coverageBasis are real fields from
// src/modules/behaviorIntel/types.ts's WindowCoverage — nothing here is invented; the tooltip text
// is a plain restatement of those same real numbers.
import { motion } from 'framer-motion'
import type { WindowCoverage } from '@/src/modules/behaviorIntel/types'
import { StatusBadge, type StatusTone } from './StatusBadge'
import { CalendarIcon } from './Icons'

export type CoverageTimelineCardProps = {
  data: WindowCoverage | null | undefined
}

const BASIS_LABEL: Record<string, { label: string; tone: StatusTone }> = {
  full_window: { label: 'Full Window', tone: 'success' },
  partial_window_plus_targeted_recovery: { label: 'Partial + Recovery', tone: 'info' },
  partial_window: { label: 'Partial Window', tone: 'warning' },
}

function Segment({ label, days, color, percent, index }: { label: string; days: number; color: string; percent: number; index: number }) {
  return (
    <div style={{ flex: '1 1 120px', minWidth: '100px' }}>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, delay: index * 0.05 }}
        style={{ height: '10px', borderRadius: '999px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden', marginBottom: '8px' }}
      >
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${percent}%` }}
          transition={{ duration: 0.5, ease: 'easeOut', delay: index * 0.05 }}
          style={{ height: '100%', background: color, borderRadius: '999px' }}
        />
      </motion.div>
      <div style={{ fontSize: '9px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: '2px' }}>{label}</div>
      <div style={{ fontSize: '13px', fontWeight: 800, color: '#e2e8f0' }}>{days} day{days === 1 ? '' : 's'}</div>
    </div>
  )
}

export function CoverageTimelineCard({ data }: CoverageTimelineCardProps) {
  const realDataDays = data?.realDataDays ?? 0
  const inferredDays = data?.inferredDays ?? 0
  const recoveredExtraDays = data?.recoveredExtraDays ?? 0
  const coverageBasis = data?.coverageBasis ?? 'partial_window'
  const total = realDataDays + inferredDays + recoveredExtraDays || 1

  const basis = BASIS_LABEL[coverageBasis] ?? { label: coverageBasis, tone: 'neutral' as StatusTone }
  const tooltip = `${realDataDays} real day(s) directly fetched, ${inferredDays} day(s) inferred (not directly fetched), ${recoveredExtraDays} additional day(s) recovered via targeted historical pages. Basis: ${coverageBasis}.`

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
        <span style={{ color: '#2DD4BF', display: 'inline-flex' }}><CalendarIcon size={16} /></span>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>Window Coverage</h3>
      </div>

      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <Segment label="Real Days" days={realDataDays} color="#38bdf8" percent={(realDataDays / total) * 100} index={0} />
        <Segment label="Inferred Days" days={inferredDays} color="#a855f7" percent={(inferredDays / total) * 100} index={1} />
        <Segment label="Recovered Days" days={recoveredExtraDays} color="#4ade80" percent={(recoveredExtraDays / total) * 100} index={2} />
      </div>

      <div style={{ paddingTop: '12px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: '10px' }} title={tooltip}>
        <StatusBadge label={basis.label} tone={basis.tone} />
        <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.50)' }}>Hover for coverage details</span>
      </div>
    </section>
  )
}

export default CoverageTimelineCard
