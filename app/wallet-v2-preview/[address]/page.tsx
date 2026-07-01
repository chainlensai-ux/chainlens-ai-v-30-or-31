'use client'

// V2 SCANNER PREVIEW — temporary page showcasing the new 90-Day Intelligence Engine, including
// holdings/portfolio value (src/modules/holdings + pricing + portfolio).
//
// IMPORTANT: this remains a preview surface only. It does NOT replace, and is not linked from, the
// production Wallet Scanner (app/terminal/wallet-scanner), which keeps using its existing
// /api/wallet backend and holdings/PnL UI, completely unchanged. This page calls /api/scan-v2
// (app/api/scan-v2/route.ts) — a separate route from production's /api/scan, which is untouched
// and still returns exactly the Step 5 shape via the unmodified runWalletScan().
//
// Implemented as a Client Component because scanWalletV2() calls a relative fetch URL, which only
// resolves in a browser context (a Server Component fetch would need an absolute URL).

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

type PreviewReport = FinalReport & { holdings: TokenHolding[]; portfolio: PortfolioSummary }

export default function WalletV2PreviewPage({ params }: { params: { address: string } }) {
  const walletAddress = params.address
  const [report, setReport] = useState<PreviewReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    scanWalletV2(walletAddress, ['base', 'eth'], 'normal')
      .then((response: ScanWalletApiResponse) => {
        if (cancelled) return
        if (!response.success || !response.data) {
          throw new Error(response.error?.message ?? 'Scan failed')
        }
        setReport(response.data as PreviewReport)
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
        <strong>V2 Scanner Preview</strong> — new 90-Day Intelligence Engine, with holdings and
        portfolio value via src/modules/holdings, pricing, and portfolio. Note:
        chainSelection&apos;s own visible_value_usd gates are still 0 in this preview (wiring real
        holdings value into chainSelection's gate evaluation would require modifying
        src/pipeline/index.ts itself, which this V2 orchestration deliberately does not touch) —
        use the Holdings section below for actual portfolio value.
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
