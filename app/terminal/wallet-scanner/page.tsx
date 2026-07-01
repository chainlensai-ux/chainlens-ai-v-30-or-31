'use client'

// Wallet Scanner — powered by the ChainLens 90-Day Intelligence Engine (V2).
//
// This page calls scanWalletV2() -> POST /api/scan-v2 -> runWalletScanV2(), which combines the
// unmodified runWalletScan() Step 5 report with holdings/portfolio value from
// src/modules/holdings, pricing, and portfolio. The old profiler backend (lib/server/
// walletSnapshot.ts via app/api/wallet/route.ts) is no longer called from this page.

import { useEffect, useState } from 'react'
import { scanWalletV2, type ScanWalletApiResponse } from '@/app/frontend/api/scanWallet'
import {
  BehaviorIntelView,
  BuyTimelineView,
  ChainSelectionView,
  DistributionTimelineView,
  FifoAndPnlView,
  FinalSummaryView,
  HoldingsView,
  RecoveryPolicyView,
  SellTimelineView,
  WindowCoverageView,
} from '@/app/frontend/components'
import type { FinalReport } from '@/src/modules/finalReportAssembler/types'
import type { TokenHolding } from '@/src/modules/holdings/types'
import type { PortfolioSummary } from '@/src/modules/portfolio/types'

type WalletV2Report = FinalReport & { holdings: TokenHolding[]; portfolio: PortfolioSummary }

export default function WalletScannerPage() {
  const [input, setInput] = useState('')
  const [walletAddress, setWalletAddress] = useState<string | null>(null)
  const [report, setReport] = useState<WalletV2Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!walletAddress) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setReport(null)

    scanWalletV2(walletAddress, ['base', 'eth'], 'normal')
      .then((response: ScanWalletApiResponse) => {
        if (cancelled) return
        if (!response.success || !response.data) {
          throw new Error(response.error?.message ?? 'Scan failed')
        }
        setReport(response.data as WalletV2Report)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // eslint-disable-next-line no-console
        console.error('Scan failed', err)
        setError(err instanceof Error ? err.message : 'Scan failed — try again later')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [walletAddress])

  return (
    <div style={{ padding: 24, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
      <h1 style={{ fontSize: 20, fontWeight: 800, marginBottom: 16 }}>Wallet Scanner</h1>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Paste a wallet address (0x...)"
          style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.03)', color: 'inherit' }}
        />
        <button
          onClick={() => setWalletAddress(input.trim())}
          disabled={loading || !input.trim()}
          style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid rgba(45,212,191,0.45)', background: 'rgba(45,212,191,0.08)', color: '#2DD4BF', cursor: loading || !input.trim() ? 'not-allowed' : 'pointer' }}
        >
          Scan
        </button>
      </div>

      {loading && <p>Scanning {walletAddress}…</p>}
      {error && (
        <div style={{ padding: 10, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 8, marginBottom: 16 }}>
          Scan failed — try again later. ({error})
        </div>
      )}

      {report && (
        <>
          <FinalSummaryView summary={report.finalSummary} />
          <HoldingsView holdings={report.holdings} portfolio={report.portfolio} />
          <ChainSelectionView data={report.chainSelection} />
          <BuyTimelineView data={report.timelines.buyTimeline} />
          <SellTimelineView data={report.timelines.sellTimeline} />
          <DistributionTimelineView data={report.timelines.distributionTimeline} />
          <RecoveryPolicyView data={report.recoveryPolicy} />
          <FifoAndPnlView data={report.fifoAndPnl} />
          <BehaviorIntelView data={report.behaviorIntel} />
          <WindowCoverageView data={report.windowCoverage} />
        </>
      )}
    </div>
  )
}
