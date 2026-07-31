'use client'

// WalletScannerResultsV3 — composes the Wallet Scanner V3 layout (compact header, three-card
// summary row, tabbed Holdings/Sell Activity/Chains workspace, collapsible Advanced Diagnostics)
// from EXISTING, already-tested components and EXISTING data/props — see each sub-component's own
// header for what it reuses and why. This file adds no new calculations, no new network requests,
// and no new API fields; it only rearranges how the same `report` data (and the same handlers
// page.tsx already passes to the old layout) is displayed.
//
// ROLLOUT, DISCLOSED: gated by a plain module-level constant in page.tsx
// (WALLET_SCANNER_UI_V3) rather than a new environment variable or feature-flag service — this
// codebase has no existing feature-flag pattern (confirmed by search before adding this), and a new
// env var would be a "risky environment change" this task explicitly avoids. The OLD layout JSX in
// page.tsx is left fully intact (not deleted) for instant rollback by flipping that one constant.
import type { WalletV2Report } from '@/app/terminal/wallet-scanner/page'
import { WalletScannerHeaderV3 } from './WalletScannerHeaderV3'
import { WalletScannerSummaryRowV3 } from './WalletScannerSummaryRowV3'
import { WalletScannerTabsV3 } from './WalletScannerTabsV3'
import { WalletScannerDiagnosticsV3 } from './WalletScannerDiagnosticsV3'
import { WalletPersonalityCard } from './WalletPersonalityCard'

export type WalletScannerResultsV3Props = {
  report: WalletV2Report
  loading: boolean
  isFullRecoveryAdmin: boolean
  onDeepScan: () => void
  onAdminAction: () => void
  scanDurationMs: number | null
  moduleErrors: Record<string, string> | null
}

export function WalletScannerResultsV3({
  report,
  loading,
  isFullRecoveryAdmin,
  onDeepScan,
  onAdminAction,
  scanDurationMs,
  moduleErrors,
}: WalletScannerResultsV3Props) {
  return (
    <div className="ws-result-fade">
      <WalletScannerHeaderV3
        report={report}
        loading={loading}
        isFullRecoveryAdmin={isFullRecoveryAdmin}
        onDeepScan={onDeepScan}
        onAdminAction={onAdminAction}
      />
      <WalletScannerSummaryRowV3 report={report} />
      {/* WALLET PERSONALITY, DISCLOSED: full-width, directly below the Portfolio Intelligence /
          Smart Money Score / PnL summary row — never squeezed into the Smart Money Score card
          itself (see WalletPersonalityCard.tsx's own header for why it always renders, even with
          zero PnL evidence). */}
      <WalletPersonalityCard report={report} />
      <div style={{ marginBottom: '16px' }}>
        <WalletScannerTabsV3 report={report} />
      </div>
      <WalletScannerDiagnosticsV3 report={report} scanDurationMs={scanDurationMs} moduleErrors={moduleErrors} />
    </div>
  )
}

export default WalletScannerResultsV3
