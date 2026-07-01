// V2 SCANNER PREVIEW component — receives ONLY recoveryPolicy from the new engine's report.
//
// V2-SAFE GUARD: `data.evaluation` and every per-entry array field (`triggeredBy`,
// `recoveredEvents`) defensively fall back to [] rather than crashing if missing/malformed.
import type { RecoveryPolicyResult } from '@/src/modules/recoveryPolicy/types'

export function RecoveryPolicyView({ data }: { data: RecoveryPolicyResult | null | undefined }) {
  const evaluation = Array.isArray(data?.evaluation) ? data!.evaluation : []
  const triggered = evaluation.filter((e) => e.recoveryTriggered)
  const totalPagesUsedThisWallet = data?.totalPagesUsedThisWallet ?? 0
  const maxHistoricalPagesPerWallet = data?.caps?.maxHistoricalPagesPerWallet ?? 0
  const maxHistoricalPagesPerToken = data?.caps?.maxHistoricalPagesPerToken ?? 0

  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Recovery Policy</h3>
      <p>
        Pages used: {totalPagesUsedThisWallet} / {maxHistoricalPagesPerWallet} (wallet cap), {maxHistoricalPagesPerToken} per token
      </p>
      {triggered.length === 0 ? (
        <p>No token met a recovery trigger this scan.</p>
      ) : (
        <ul>
          {triggered.map((entry) => {
            const triggeredBy = Array.isArray(entry.triggeredBy) ? entry.triggeredBy : []
            const recoveredEvents = Array.isArray(entry.recoveredEvents) ? entry.recoveredEvents : []
            return (
              <li key={`${entry.chain}-${entry.token}`}>
                {entry.token} on {entry.chain} — triggered by: {triggeredBy.map((t) => t.rule).join(', ')} — {entry.pagesUsed} page(s) used, {recoveredEvents.length} event(s) recovered
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export default RecoveryPolicyView
