// Smart Money Score card — compact, additive summary of report.smartMoneyScore. Renders nothing
// when the field is absent (older responses, or scanWalletV2's job-route fallback path, which
// doesn't compute this field) — never assumes it's present.
//
// HONESTY NOTE: every number here is exactly what lib/engine/modules/smartMoney/
// computeSmartMoneyScore.ts produced — a disclosed heuristic derived from real module outputs, not
// a claim of a precise, validated "wallet quality" metric. No new data is invented here.

import type { SmartMoneyScore } from '@/lib/engine/modules/smartMoney/types'

export type SmartMoneyScoreCardProps = {
  smartMoneyScore: SmartMoneyScore | null | undefined
}

const COMPONENT_LABELS: Array<{ key: keyof SmartMoneyScore['components']; label: string }> = [
  { key: 'pnlScore', label: 'PnL' },
  { key: 'behaviorScore', label: 'Behavior' },
  { key: 'personalityScore', label: 'Personality' },
  { key: 'chainActivityScore', label: 'Chain Activity' },
  { key: 'riskScore', label: 'Risk' },
  { key: 'signalsScore', label: 'Signals' },
]

function scoreColor(score: number): string {
  if (score >= 70) return '#4ade80'
  if (score >= 40) return '#fbbf24'
  return '#f87171'
}

export function SmartMoneyScoreCard({ smartMoneyScore }: SmartMoneyScoreCardProps) {
  if (!smartMoneyScore) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
        <span style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.70)' }}>
          Smart Money Score
        </span>
        <span style={{ fontSize: '22px', fontWeight: 900, color: scoreColor(smartMoneyScore.score) }}>
          {smartMoneyScore.score}
        </span>
        <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.55)' }}>/ 100</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '8px' }}>
        {COMPONENT_LABELS.map(({ key, label }) => (
          <div key={key} style={{ fontSize: '11px' }}>
            <span style={{ color: '#64748b' }}>{label} — </span>
            <span style={{ fontWeight: 700, color: scoreColor(smartMoneyScore.components[key]) }}>
              {smartMoneyScore.components[key]}
            </span>
          </div>
        ))}
      </div>

      {smartMoneyScore.notes.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '11px', color: 'rgba(148,163,184,0.75)' }}>
          {smartMoneyScore.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default SmartMoneyScoreCard
