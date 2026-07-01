// V2 SCANNER PREVIEW component — receives ONLY finalSummary from the new engine's report.
import type { FinalSummary } from '@/src/modules/finalReportAssembler/types'

export function FinalSummaryView({ summary }: { summary: FinalSummary }) {
  return (
    <section style={{ marginBottom: 20, padding: 16, border: '1px solid #333', borderRadius: 8 }}>
      <h2>Summary</h2>
      <p>{summary.walletPersonality}</p>
      <p>
        <strong>Financial:</strong> {summary.financialStatus.headline} ({summary.financialStatus.officialPnlStatus})
      </p>
      <p>
        <strong>Behavior:</strong> {summary.behavioralStatus.rotationStyle} / {summary.behavioralStatus.riskOnOff}
      </p>
      <p>
        <strong>Chains:</strong> {summary.chainParticipationSummary}
      </p>
      <p>
        <strong>Recovery:</strong> {summary.recoverySummary}
      </p>
    </section>
  )
}

export default FinalSummaryView
