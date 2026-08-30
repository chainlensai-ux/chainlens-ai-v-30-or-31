'use client'

// WalletScannerHeaderV3 — compact hero header for the Wallet Scanner V3 layout.
//
// SAFE REUSE, DISCLOSED (Wallet Scanner V3 layout task): renders the EXACT SAME already-tested
// WalletOverview/PortfolioSnapshot/Actions functions WalletProfileHeader.tsx exports (see that
// file's own "EXPORTED, DISCLOSED" comments) — no calculation, selector, or data-flow logic is
// duplicated here. This file is presentation-only: a tighter card wrapper around the same three
// pieces, dropping PortfolioIntelligenceCard/SmartMoneyScoreCard/PnlAndConfidenceRow/BehaviorSummary
// (which move into WalletScannerSummaryRowV3/WalletScannerDiagnosticsV3 in the V3 layout) from what
// WalletProfileHeader itself renders as one monolithic card.
import type { WalletV2Report } from '@/app/terminal/wallet-scanner/page'
import type { RobinhoodWalletScanResponse } from './RobinhoodChainSection'
import { WalletOverview, PortfolioSnapshot, Actions } from './WalletProfileHeader'

export type WalletScannerHeaderV3Props = {
  report: WalletV2Report
  loading: boolean
  isFullRecoveryAdmin: boolean
  onDeepScan: () => void
  onAdminAction: () => void
  // ONE CANONICAL RESULT, DISCLOSED (split-Wallet-Scanner-results fix task): optional — forwarded
  // straight to PortfolioSnapshot so the live V3 hero total merges Robinhood in. See
  // app/frontend/lib/mergedWalletView.ts's own header.
  robinhoodResult?: RobinhoodWalletScanResponse | null
}

export function WalletScannerHeaderV3({ report, loading, isFullRecoveryAdmin, onDeepScan, onAdminAction, robinhoodResult }: WalletScannerHeaderV3Props) {
  return (
    <div
      className="wph-root ws-result-fade"
      style={{
        background: 'linear-gradient(160deg, rgba(45,212,191,0.05), rgba(6,10,18,0.97))',
        border: '1px solid rgba(45,212,191,0.18)', borderRadius: '18px', padding: '20px 22px', marginBottom: '16px',
        display: 'flex', flexDirection: 'column', gap: '16px',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 12px 32px rgba(0,0,0,0.28)',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <WalletOverview report={report} />
        <Actions loading={loading} isFullRecoveryAdmin={isFullRecoveryAdmin} onDeepScan={onDeepScan} onAdminAction={onAdminAction} />
      </div>
      <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)' }} />
      <PortfolioSnapshot report={report} robinhoodResult={robinhoodResult} />
    </div>
  )
}

export default WalletScannerHeaderV3
