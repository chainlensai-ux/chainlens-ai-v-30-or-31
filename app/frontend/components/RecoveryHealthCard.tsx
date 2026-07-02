'use client'

// RecoveryHealthCard — premium redesign of the Recovery Policy section. Frontend-only; does not
// modify src/modules/recoveryPolicy or any other backend module.
//
// HONESTY NOTE: RecoveryPolicyResult (src/modules/recoveryPolicy/types.ts) has no "status"/
// "confidence" field of its own — those are derived here, purely, from real caps/evaluation data:
//   - status ('Healthy'/'Partial'/'Limited'): 'Limited' when totalPagesUsedThisWallet has hit the
//     wallet cap (no more recovery could happen even if warranted); 'Partial' when at least one
//     token actually triggered recovery and used pages under the cap; 'Healthy' when nothing
//     needed recovery at all. This is a coarse, disclosed heuristic over real numbers — never a
//     fabricated field.
//   - The footer's "Recovery engine confidence" reuses this same derived status rather than
//     inventing a second, different confidence metric on top of it.
// Reason/rule badges use the real RecoveryTriggerRule values
// ('token_value_usd_gte'|'in_top_3_holdings'|'repeated_in_sell_timeline_min_count') — never
// invented labels.
import { motion } from 'framer-motion'
import type { RecoveryPolicyResult } from '@/src/modules/recoveryPolicy/types'
import { ChainBadge } from './ChainBadge'
import { StatusBadge, type StatusTone } from './StatusBadge'
import { ProgressBar } from './ProgressBar'
import { ShieldIcon } from './Icons'

export type RecoveryHealthCardProps = {
  data: RecoveryPolicyResult | null | undefined
}

type RecoveryStatus = 'Healthy' | 'Partial' | 'Limited'

function deriveStatus(data: RecoveryPolicyResult): { status: RecoveryStatus; tone: StatusTone } {
  const cap = data.caps.maxHistoricalPagesPerWallet
  const used = data.totalPagesUsedThisWallet
  const triggeredCount = data.evaluation.filter((e) => e.recoveryTriggered).length

  if (cap > 0 && used >= cap) return { status: 'Limited', tone: 'warning' }
  if (triggeredCount > 0) return { status: 'Partial', tone: 'info' }
  return { status: 'Healthy', tone: 'success' }
}

const cardVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { duration: 0.24, delay: Math.min(i, 20) * 0.04 } }),
}

export function RecoveryHealthCard({ data }: RecoveryHealthCardProps) {
  const evaluation = Array.isArray(data?.evaluation) ? data!.evaluation : []
  const caps = data?.caps ?? { maxHistoricalPagesPerWallet: 0, maxHistoricalPagesPerToken: 0 }
  const totalPagesUsed = data?.totalPagesUsedThisWallet ?? 0
  const triggered = evaluation.filter((e) => e.recoveryTriggered)
  const { status, tone } = data ? deriveStatus(data) : { status: 'Healthy' as const, tone: 'success' as const }

  return (
    <section>
      <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
        <span style={{ color: '#2DD4BF', display: 'inline-flex' }}><ShieldIcon size={17} /></span>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>Recovery Health</h3>
        <StatusBadge label={status} tone={tone} glow />
      </motion.div>

      <div style={{ marginBottom: '16px' }}>
        <ProgressBar value={totalPagesUsed} max={caps.maxHistoricalPagesPerWallet} label={`Pages used: ${totalPagesUsed} / ${caps.maxHistoricalPagesPerWallet}`} color="#2DD4BF" />
        <div style={{ fontSize: '11px', color: 'rgba(148,163,184,0.55)', marginTop: '6px' }}>Per token cap: {caps.maxHistoricalPagesPerToken} page(s)</div>
      </div>

      {triggered.length === 0 ? (
        <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', margin: 0 }}>No token met a recovery trigger this scan.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {triggered.map((entry, i) => {
            const rules = Array.isArray(entry.triggeredBy) ? entry.triggeredBy : []
            const recoveredCount = Array.isArray(entry.recoveredEvents) ? entry.recoveredEvents.length : 0
            return (
              <motion.div
                key={`${entry.chain}-${entry.token}`}
                custom={i}
                variants={cardVariants}
                initial="hidden"
                animate="visible"
                style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', padding: '11px 14px', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
              >
                <ChainBadge chain={entry.chain} />
                <span style={{ fontSize: '12px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                  {entry.token.slice(0, 8)}…{entry.token.slice(-4)}
                </span>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {rules.map((r) => <StatusBadge key={r.rule} label={r.rule} tone="neutral" />)}
                </div>
                <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'rgba(148,163,184,0.65)' }}>
                  {entry.pagesUsed} page(s) · {recoveredCount} event(s) recovered
                </span>
              </motion.div>
            )
          })}
        </div>
      )}

      <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.60)' }}>Recovery engine confidence:</span>
        <StatusBadge label={status} tone={tone} />
      </div>
    </section>
  )
}

export default RecoveryHealthCard
