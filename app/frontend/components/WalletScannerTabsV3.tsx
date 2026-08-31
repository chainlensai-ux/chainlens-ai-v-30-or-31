'use client'

// WalletScannerTabsV3 — Holdings / Sell Activity / Chains tabbed workspace for the Wallet Scanner
// V3 layout.
//
// SAFE REUSE, DISCLOSED (Wallet Scanner V3 layout task): each tab renders an EXISTING, already-
// tested component with its EXISTING props unchanged — HoldingsViewV2 (already reads the canonical
// pricedHoldings/chainValueUsd via selectHoldingsV2(), see that component/selector's own headers),
// SellActivitySummary, ChainSelectionView. No calculation logic is duplicated; this file only adds
// tab-switching UI state.
import { useMemo, useState } from 'react'
import type { WalletV2Report } from '@/app/terminal/wallet-scanner/page'
import type { RobinhoodWalletScanResponse } from './RobinhoodChainSection'
import { HoldingsViewV2 } from './HoldingsViewV2'
import { SellActivitySummary } from './SellActivitySummary'
import { ChainSelectionView } from './ChainSelectionView'
import { RobinhoodChainSection } from './RobinhoodChainSection'
import { mergeRobinhoodIntoPricedHoldings } from '@/app/frontend/lib/mergedWalletView'

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
  // ROBINHOOD-IN-HOLDINGS, DISCLOSED (finish-Wallet-Scanner-Robinhood-integration follow-up, this
  // task's own explicit requirement 2/3): the Holdings tab now shows Robinhood alongside ETH/Base as
  // ONE merged holdings view, instead of being reachable ONLY via the separate Robinhood tab below —
  // the Robinhood tab still exists (requirement 4), now scoped to chain-specific evidence/debug
  // detail (Activity, Blockscout status, PnL gate reasoning) rather than being the only place a
  // user can see a Robinhood holding at all. See mergedWalletView.ts's own header for why this never
  // fabricates a price/value and never double-counts against report.portfolioTotalByChain.
  const merged = useMemo(
    () => mergeRobinhoodIntoPricedHoldings(report.pricedHoldings, report.chainValueUsd, robinhoodResult, report.portfolioTotalByChain),
    [report.pricedHoldings, report.chainValueUsd, robinhoodResult, report.portfolioTotalByChain],
  )
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
            pricedHoldings={merged.pricedHoldings}
            chainValueUsd={merged.chainValueUsd}
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
        {/* ROBINHOOD AS A CHAIN TAB, DISCLOSED (split-Wallet-Scanner-results fix task, narrowed by
            the finish-Wallet-Scanner-Robinhood-integration follow-up's requirement 4): Robinhood
            holdings themselves now live in the normal Holdings tab above (merged in via
            mergeRobinhoodIntoPricedHoldings) — this tab is no longer the only place to see them.
            What stays HERE is chain-specific evidence/debug detail that has no EVM-chain equivalent
            in the Holdings tab: Activity items, Blockscout call evidence, and the Robinhood PnL
            gate's own detailed reasoning (verified swap count, skipped logs, disabled reason). */}
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
