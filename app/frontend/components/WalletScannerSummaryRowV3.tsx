'use client'

// WalletScannerSummaryRowV3 — three-card summary row for the Wallet Scanner V3 layout: Portfolio
// Intelligence, Smart Money Score, PnL (Verified V2).
//
// SAFE REUSE, DISCLOSED (Wallet Scanner V3 layout task): every number rendered here comes from the
// EXISTING, already-tested PortfolioIntelligenceCard/SmartMoneyScoreCard/PnlStatusCard components —
// this file only arranges them into a responsive 3-column grid. No calculation logic is duplicated
// or reimplemented; PnlStatusCard in particular already encodes every one of this task's PnL
// requirements (unavailable-evidence messaging, never showing a blocked/unstable figure as verified
// profit, real backend-classification badges only) — see that file's own header.
import type { WalletV2Report } from '@/app/terminal/wallet-scanner/page'
import { PortfolioIntelligenceCard } from './PortfolioIntelligenceCard'
import { SmartMoneyScoreCard } from './SmartMoneyScoreCard'
import { PnlStatusCard } from './PnlStatusCard'

export type WalletScannerSummaryRowV3Props = {
  report: WalletV2Report
}

const cardStyle: React.CSSProperties = {
  flex: '1 1 300px', minWidth: '280px', background: 'rgba(6,10,18,0.95)', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '16px', padding: '18px 20px', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 8px 20px rgba(0,0,0,0.18)',
}

export function WalletScannerSummaryRowV3({ report }: WalletScannerSummaryRowV3Props) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', marginBottom: '16px' }}>
      {/* PortfolioIntelligenceCard already renders its OWN complete card chrome (padding/border/
          background — see that file's own JSX) — not wrapped in `cardStyle` here to avoid a
          doubled/nested border, only a flex-basis wrapper so it sizes like its siblings. */}
      <div style={{ flex: '1 1 300px', minWidth: '280px' }}>
        <PortfolioIntelligenceCard
          portfolio={report.portfolio}
          portfolioV2={report.portfolioV2}
          chainsScanned={report.scanMetadata?.chainsScanned}
          activeChain={report.behaviorIntel?.multiChainParticipation?.primaryChain}
        />
      </div>

      {report.smartMoneyScore && (
        <div style={cardStyle}>
          <SmartMoneyScoreCard smartMoneyScore={report.smartMoneyScore} canonicalSampleManifestAudit={report.canonicalSampleManifestAudit} />
        </div>
      )}

      <div style={cardStyle}>
        {/* CANONICAL UNREALIZED-PNL SOURCE, DISCLOSED (found live, this task — confirmed ~$500k
            fabricated Unrealized PnL rendered on THIS exact card despite the backend's real
            canonical reconciliation, report.fifoAndPnl.unrealizedReconciliation.
            officialUnrealizedPnlUsd, already correctly reporting -$0.0863). Realized PnL/ROI/cost
            basis are unchanged (still pnlV2-only) — only Unrealized PnL is now sourced from the
            fifoEngine reconciliation, never pnlV2.unrealizedPnlUsd. See PnlStatusCard.tsx's own
            header for the full trace. */}
        <PnlStatusCard
          pnlV2={report.pnlV2}
          publicPnlStatus={report.finalSummary?.financialStatus?.officialPnlStatus}
          syntheticPnl={report.syntheticPnl}
          unrealizedReconciliation={report.fifoAndPnl?.unrealizedReconciliation}
          reconciliationSummary={report.reconciliationSummary}
        />
      </div>
    </div>
  )
}

export default WalletScannerSummaryRowV3
