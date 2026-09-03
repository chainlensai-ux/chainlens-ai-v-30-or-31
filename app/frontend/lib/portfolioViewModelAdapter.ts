// mapWalletScanReportToPortfolioViewModel — adapts a real Wallet Scanner scan result
// (WalletV2Report, the exact same object app/terminal/wallet-scanner/page.tsx already renders)
// into lib/portfolioViewModel.ts's shared PortfolioViewModelInput shape, using the SAME selectors
// Wallet Scanner's own cards already call (selectPortfolioStats, selectChainBreakdown,
// computeMergedTotalValueUsd, buildWalletPnlViewModel) — never a second, independently-derived
// number. This is the one place Portfolio, Wallet Scanner, and Clark all funnel through so they
// can never disagree about the same scan.
import { selectPortfolioStats, selectChainBreakdown } from '@/app/frontend/components'
import type { WalletV2Report } from '@/app/terminal/wallet-scanner/page'
import { computeMergedTotalValueUsd, deriveCanonicalMergeOverride } from '@/app/frontend/lib/mergedWalletView'
import { buildWalletPnlViewModel } from '@/app/frontend/lib/buildWalletPnlViewModel'
import type { RobinhoodWalletScanResponse } from '@/lib/walletScan/canonicalWalletSelectors'
import type { TokenListEntry } from '@/src/modules/portfolio/types'
import {
  buildPortfolioViewModel,
  type PortfolioViewModel,
  type PortfolioHolding,
  type PortfolioDataSource,
  type PortfolioPnlSummary,
  type PortfolioPnlStatus,
} from '@/lib/portfolioViewModel'

export type { WalletV2Report }

function pnlStatusFromCombined(status: string): PortfolioPnlStatus {
  if (status === 'verified') return 'verified'
  if (status === 'partial') return 'partial'
  if (status === 'locked') return 'locked'
  return 'unavailable'
}

function parseUsd(value: string | null): number | null {
  if (!value) return null
  const n = Number(value.replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : null
}

/** Real, real-data-only mapping. Holdings come from report.portfolio.tokens (the full, already-
 * priced token list this scan produced) plus a real Robinhood holdings result when one was
 * scanned — never fabricated, never re-priced here. The total/PnL/chain-exposure figures come
 * from the same canonical selectors the rest of Wallet Scanner's UI already trusts. */
export function mapWalletScanReportToPortfolioViewModel(
  report: WalletV2Report | null,
  robinhoodResult: RobinhoodWalletScanResponse | null | undefined,
  source: PortfolioDataSource,
  opts: { scanAttempted: boolean; failureReason: string | null },
): PortfolioViewModel {
  const walletAddress = report?.scanMetadata?.walletAddress ?? null

  if (!report) {
    return buildPortfolioViewModel({
      walletAddress,
      holdings: [],
      chainBreakdown: [],
      pnlSummary: null,
      riskSummary: null,
      activity: [],
      source,
      scanAttempted: opts.scanAttempted,
      failureReason: opts.failureReason,
    })
  }

  const { stats } = selectPortfolioStats(report.portfolio, report.portfolioV2)
  const merged = computeMergedTotalValueUsd(stats.totalValueUsd, robinhoodResult, deriveCanonicalMergeOverride(report))
  const chainBreakdown = selectChainBreakdown(report.chainValueUsd, merged.totalValueUsd, report.portfolio?.chainValueBreakdown, report.portfolioTotalByChain)

  // Full enumerable holdings list — report.portfolio.tokens (v1 PortfolioSummary) is the one shape
  // in this report that carries every priced token, not just the top-5 portfolioV2.topHoldings cap
  // (see PortfolioIntelligenceCard.tsx's own "ONE HONEST GAP" disclosure on that limitation).
  const evmHoldings: PortfolioHolding[] = (report.portfolio?.tokens ?? []).map((t: TokenListEntry) => ({
    symbol: t.symbol,
    name: t.name,
    chain: t.chain,
    contract: t.contract,
    balance: t.amount,
    price: t.priceUsd,
    value: t.valueUsd,
    change24h: null, // real engine does not track per-token 24h change — never fabricated here
  }))

  const robinhoodHoldings: PortfolioHolding[] = (merged.robinhoodIncluded && robinhoodResult?.ok)
    ? [
        ...(robinhoodResult.holdings.native && robinhoodResult.holdings.native.valueUsd != null
          ? [{
              symbol: robinhoodResult.holdings.native.symbol,
              name: robinhoodResult.holdings.native.symbol,
              chain: 'robinhood',
              contract: null,
              balance: robinhoodResult.holdings.native.uiBalance ?? 0,
              price: robinhoodResult.holdings.native.priceUsd,
              value: robinhoodResult.holdings.native.valueUsd,
              change24h: null,
            }]
          : []),
        ...robinhoodResult.holdings.holdings
          .filter((h) => h.valueUsd != null)
          .map((h) => ({
            symbol: h.symbol ?? '?',
            name: h.name ?? h.symbol ?? 'Unknown',
            chain: 'robinhood',
            contract: h.address,
            balance: h.uiBalance ?? 0,
            price: h.priceUsd,
            value: h.valueUsd,
            change24h: null,
          })),
      ]
    : []

  const pnlViewModel = buildWalletPnlViewModel({
    pnlV2: report.pnlV2,
    publicPnlStatus: report.finalSummary?.financialStatus?.officialPnlStatus,
    unrealizedReconciliation: report.fifoAndPnl?.unrealizedReconciliation,
    reconciliationSummary: report.reconciliationSummary,
    canonicalSampleManifestAudit: report.canonicalSampleManifestAudit,
    robinhoodResult,
    chainsScanned: Array.isArray(report.scanMetadata?.chainsScanned) ? report.scanMetadata.chainsScanned : [],
  })

  const pnlSummary: PortfolioPnlSummary = {
    status: pnlStatusFromCombined(pnlViewModel.combinedStatus),
    reason: pnlViewModel.combinedReason,
    realizedUsd: parseUsd(pnlViewModel.combinedRealizedBox.value),
    unrealizedUsd: parseUsd(pnlViewModel.unrealizedBox.value),
  }

  return buildPortfolioViewModel({
    walletAddress,
    holdings: [...evmHoldings, ...robinhoodHoldings],
    chainBreakdown,
    pnlSummary,
    riskSummary: null,
    activity: [],
    source,
    scanAttempted: opts.scanAttempted,
    failureReason: opts.failureReason,
  })
}
