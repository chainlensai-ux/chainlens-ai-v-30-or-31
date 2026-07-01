'use client'

// V2 SCANNER PREVIEW — temporary page showcasing the new 90-Day Intelligence Engine in isolation.
//
// IMPORTANT: this is a preview surface only. It does NOT replace, and is not linked from, the
// production Wallet Scanner (app/terminal/wallet-scanner), which keeps using its existing
// /api/wallet backend and holdings/PnL UI unchanged. The new engine has no holdings/portfolio-
// pricing module yet, so every scan through this page will show empty holdings/PnL — that is
// expected and clearly labeled below, not a bug in this preview page.
//
// Implemented as a Client Component (not the async Server Component shape from the original
// spec) because scanWallet() calls `fetch('/api/scan')` with a relative URL — that only resolves
// in a browser context. A Server Component fetch would need an absolute URL (server has no
// implicit origin), so fetching client-side here is the correct, working shape for this API
// client as specified.

import { useEffect, useState } from 'react'
import { scanWallet, type ScanWalletApiResponse } from '@/app/frontend/api/scanWallet'
import {
  BehaviorIntelView,
  BuyTimelineView,
  ChainSelectionView,
  DistributionTimelineView,
  FifoAndPnlView,
  FinalSummaryView,
  RecoveryPolicyView,
  SellTimelineView,
  WindowCoverageView,
} from '@/app/frontend/components'
import type { FinalReport } from '@/src/modules/finalReportAssembler/types'

export default function WalletV2PreviewPage({ params }: { params: { address: string } }) {
  const walletAddress = params.address
  const [report, setReport] = useState<FinalReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    scanWallet(walletAddress, ['base', 'eth'], 'normal')
      .then((response: ScanWalletApiResponse) => {
        if (cancelled) return
        if (!response.success || !response.data) {
          throw new Error(response.error?.message ?? 'Scan failed')
        }
        setReport(response.data as FinalReport)
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
    <div style={{ padding: 24, fontFamily: 'monospace' }}>
      <div style={{ marginBottom: 16, padding: 10, background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.4)', borderRadius: 8 }}>
        <strong>V2 Scanner Preview</strong> — new 90-Day Intelligence Engine. Holdings/portfolio
        value are not yet available in this engine; only behavioral/timeline/recovery/PnL-evidence
        sections below are populated.
      </div>

      {loading && <p>Scanning {walletAddress}…</p>}
      {error && (
        <div style={{ padding: 10, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 8 }}>
          Scan failed — try again later. ({error})
        </div>
      )}

      {report && (
        <>
          <FinalSummaryView summary={report.finalSummary} />
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
