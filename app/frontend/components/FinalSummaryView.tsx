// V2 SCANNER PREVIEW component — receives ONLY finalSummary from the new engine's report.
//
// V2-SAFE GUARD: every nested field defensively falls back to a safe default rather than crashing
// if `summary` or a nested object is missing at runtime.
import type { FinalSummary } from '@/src/modules/finalReportAssembler/types'

export function FinalSummaryView({ summary }: { summary: FinalSummary | null | undefined }) {
  const walletPersonality = summary?.walletPersonality ?? 'Insufficient data to classify wallet behavior.'
  const financialHeadline = summary?.financialStatus?.headline ?? 'PnL unavailable due to missing evidence.'
  const officialPnlStatus = summary?.financialStatus?.officialPnlStatus ?? 'unavailable'
  const rotationStyle = summary?.behavioralStatus?.rotationStyle ?? 'unknown'
  const riskOnOff = summary?.behavioralStatus?.riskOnOff ?? 'unknown'
  const chainParticipationSummary = summary?.chainParticipationSummary ?? 'No chain participation data available.'
  const recoverySummary = summary?.recoverySummary ?? 'No recovery attempted.'

  return (
    <section style={{ marginBottom: 20, padding: 16, border: '1px solid #333', borderRadius: 8 }}>
      <h2>Summary</h2>
      <p>{walletPersonality}</p>
      <p>
        <strong>Financial:</strong> {financialHeadline} ({officialPnlStatus})
      </p>
      <p>
        <strong>Behavior:</strong> {rotationStyle} / {riskOnOff}
      </p>
      <p>
        <strong>Chains:</strong> {chainParticipationSummary}
      </p>
      <p>
        <strong>Recovery:</strong> {recoverySummary}
      </p>
    </section>
  )
}

export default FinalSummaryView
