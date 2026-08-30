'use client'

// WalletScannerTabsV3 — Holdings / Sell Activity / Chains tabbed workspace for the Wallet Scanner
// V3 layout.
//
// SAFE REUSE, DISCLOSED (Wallet Scanner V3 layout task): each tab renders an EXISTING, already-
// tested component with its EXISTING props unchanged — HoldingsViewV2 (already reads the canonical
// pricedHoldings/chainValueUsd via selectHoldingsV2(), see that component/selector's own headers),
// SellActivitySummary, ChainSelectionView. No calculation logic is duplicated; this file only adds
// tab-switching UI state.
import { useState } from 'react'
import type { WalletV2Report } from '@/app/terminal/wallet-scanner/page'
import type { RobinhoodWalletScanResponse } from './RobinhoodChainSection'
import { HoldingsViewV2 } from './HoldingsViewV2'
import { SellActivitySummary } from './SellActivitySummary'
import { ChainSelectionView } from './ChainSelectionView'
import { RobinhoodChainSection } from './RobinhoodChainSection'

export type WalletScannerTabsV3Props = {
  report: WalletV2Report
  // ONE CANONICAL RESULT, DISCLOSED (split-Wallet-Scanner-results fix task): when present, Robinhood
  // Chain renders as ONE MORE TAB in this same tabbed workspace — a normal chain section inside the
  // one Wallet Scanner result model, never a second, separate top-level card/scanner. Optional — a
  // scan with no Robinhood result (not configured, not yet scanned) simply has no Robinhood tab.
  robinhoodResult?: RobinhoodWalletScanResponse | null
  onRobinhoodRescan?: () => void
  robinhoodRescanLoading?: boolean
  debugMode?: boolean
}

type TabKey = 'holdings' | 'sell-activity' | 'chains' | 'robinhood'

export function WalletScannerTabsV3({ report, robinhoodResult, onRobinhoodRescan, robinhoodRescanLoading, debugMode }: WalletScannerTabsV3Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('holdings')
  const TABS: Array<{ key: TabKey; label: string }> = [
    { key: 'holdings', label: 'Holdings' },
    { key: 'sell-activity', label: 'Sell Activity' },
    { key: 'chains', label: 'Chains' },
    ...(robinhoodResult ? [{ key: 'robinhood' as const, label: 'Robinhood' }] : []),
  ]

  return (
    <div className="ws-card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: '2px', borderBottom: '1px solid rgba(255,255,255,0.08)', padding: '10px 12px 0' }}>
        {TABS.map((tab) => {
          const active = activeTab === tab.key
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              style={{
                padding: '10px 16px', border: 'none', borderBottom: active ? '2px solid #2DD4BF' : '2px solid transparent',
                background: 'transparent', color: active ? '#e2e8f0' : 'rgba(148,163,184,0.55)',
                fontSize: '12px', fontWeight: 800, letterSpacing: '0.04em', cursor: 'pointer',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              }}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      <div style={{ padding: '18px 20px' }}>
        {activeTab === 'holdings' && (
          <HoldingsViewV2
            pricedHoldings={report.pricedHoldings}
            chainValueUsd={report.chainValueUsd}
            buyEntries={report.timelines?.buyTimeline?.entries}
            bridgeEntries={report.bridgeTimeline}
          />
        )}
        {activeTab === 'sell-activity' && (
          <SellActivitySummary
            sellTimeline={report.timelines?.sellTimelineV2}
            pnlV2={report.pnlV2}
            publicPnlStatus={report.finalSummary?.financialStatus?.officialPnlStatus}
          />
        )}
        {activeTab === 'chains' && (
          <ChainSelectionView data={report.chainSelection} chainActivityV2={report.chainActivityV2} />
        )}
        {/* ROBINHOOD AS A CHAIN TAB, DISCLOSED (split-Wallet-Scanner-results fix task): the exact
            same RobinhoodChainSection cards/tables (total, native ETH, priced/unpriced holdings,
            pricing coverage, verified swaps, skipped swap logs, Blockscout status, PnL status) now
            render inside this SAME tabbed workspace instead of as a separate, competing top-level
            card — one canonical result, Robinhood as one more chain section within it. */}
        {activeTab === 'robinhood' && robinhoodResult && (
          <RobinhoodChainSection
            result={robinhoodResult}
            onRescan={onRobinhoodRescan ?? (() => {})}
            rescanLoading={robinhoodRescanLoading ?? false}
            debugMode={debugMode ?? false}
          />
        )}
      </div>
    </div>
  )
}

export default WalletScannerTabsV3
