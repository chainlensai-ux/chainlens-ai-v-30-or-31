// V2 SCANNER PREVIEW component — receives ONLY recoveryPolicy from the new engine's report.
import type { RecoveryPolicyResult } from '@/src/modules/recoveryPolicy/types'

export function RecoveryPolicyView({ data }: { data: RecoveryPolicyResult }) {
  const triggered = data.evaluation.filter((e) => e.recoveryTriggered)
  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Recovery Policy</h3>
      <p>
        Pages used: {data.totalPagesUsedThisWallet} / {data.caps.maxHistoricalPagesPerWallet} (wallet cap), {data.caps.maxHistoricalPagesPerToken} per token
      </p>
      {triggered.length === 0 ? (
        <p>No token met a recovery trigger this scan.</p>
      ) : (
        <ul>
          {triggered.map((entry) => (
            <li key={`${entry.chain}-${entry.token}`}>
              {entry.token} on {entry.chain} — triggered by: {entry.triggeredBy.map((t) => t.rule).join(', ')} — {entry.pagesUsed} page(s) used, {entry.recoveredEvents.length} event(s) recovered
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default RecoveryPolicyView
