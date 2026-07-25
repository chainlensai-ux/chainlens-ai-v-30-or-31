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
import { HoldingsViewV2 } from './HoldingsViewV2'
import { SellActivitySummary } from './SellActivitySummary'
import { ChainSelectionView } from './ChainSelectionView'

export type WalletScannerTabsV3Props = {
  report: WalletV2Report
}

type TabKey = 'holdings' | 'sell-activity' | 'chains'

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'holdings', label: 'Holdings' },
  { key: 'sell-activity', label: 'Sell Activity' },
  { key: 'chains', label: 'Chains' },
]

export function WalletScannerTabsV3({ report }: WalletScannerTabsV3Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('holdings')

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
      </div>
    </div>
  )
}

export default WalletScannerTabsV3
