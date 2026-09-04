// buildWalletScannerViewModel — ONE shared assembler that keeps portfolio VALUE and PnL EVIDENCE
// as separate view models so the Wallet Scanner UI can never contradict itself.
//
// CONFIRMED LIVE BUG, DISCLOSED (this task): a wallet with canonicalTotalValueUsd = $8,669.94,
// Base $8,664.03, ETH $5.91, pricedHoldingsCount = 24 still rendered green Base PnL $0.00 because
// pnlV2.chainBreakdown defaults realizedPnlUsd to 0 when closedLots=0 / official realizedPnlUsd
// is null. Portfolio value is NOT PnL. This file never recomputes FIFO/pricing — it only reads
// the existing selectors (selectPortfolioStats, selectChainBreakdown, computeMergedTotalValueUsd,
// buildWalletPnlViewModel) and labels their outputs.
import { selectPortfolioStats } from '@/app/frontend/components/PortfolioIntelligenceCard'
import { selectChainBreakdown, type ChainBreakdownRow } from '@/app/frontend/components/WalletProfileHeader'
import type { PortfolioSummary } from '@/src/modules/portfolio/types'
import type { Portfolio as EnginePortfolioV2 } from '@/lib/engine/modules/portfolio/types'
import type { PricedHolding } from '@/lib/engine/modules/pricing/types'
import type { PnlV2 } from '@/lib/engine/modules/pnl/types'
import type { PublicPnlStatus, UnrealizedReconciliationSummary } from '@/src/modules/fifoEngine/types'
import type { PnlReconciliationSummary } from '@/src/lib/pnlReconciliation'
import type { CanonicalSampleManifestAudit } from '@/src/lib/canonicalPnlSampleManifest'
import type { RobinhoodWalletScanResponse } from '@/app/frontend/components/RobinhoodChainSection'
import {
  computeMergedTotalValueUsd,
  deriveCanonicalMergeOverride,
  mergeRobinhoodIntoPricedHoldings,
  type CanonicalMergeOverride,
} from '@/app/frontend/lib/mergedWalletView'
import { fmtUsd } from '@/app/frontend/lib/holdingsHeuristics'
import {
  buildWalletPnlViewModel,
  shouldSuppressUnverifiedZeroPnl,
  type WalletPnlCombinedStatus,
  type WalletPnlBoxStatus,
  type WalletPnlChainRow,
  type WalletPnlViewModel,
} from '@/app/frontend/lib/buildWalletPnlViewModel'

export type PortfolioValueStatus = 'ready' | 'unavailable'

export type PortfolioValueView = {
  totalValueUsd: number | null
  valueByChain: Record<string, number>
  pricedHoldingsCount: number
  unpricedHoldingsCount: number
  topHoldings: Array<{ symbol: string; percent: number }>
  valueStatus: PortfolioValueStatus
  failureReason: string | null
}

export type PnlEvidenceView = {
  combinedStatus: WalletPnlCombinedStatus
  combinedRealizedPnlUsd: number | null
  combinedReason: string
  chainPnlRows: WalletPnlChainRow[]
  unrealizedStatus: WalletPnlBoxStatus
  roiStatus: WalletPnlBoxStatus
  blockingReasons: string[]
}

export type WalletScannerViewAudit = {
  walletAddress: string | null
  portfolioTotalValueUsd: number | null
  portfolioValueByChain: Record<string, number>
  pricedHoldingsCount: number
  unpricedHoldingsCount: number
  combinedPnlStatus: WalletPnlCombinedStatus
  combinedRealizedPnlUsd: number | null
  basePnlStatus: WalletPnlChainRow['status'] | null
  baseRealizedPnlUsd: number | null
  ethPnlStatus: WalletPnlChainRow['status'] | null
  robinhoodPnlStatus: WalletPnlChainRow['status'] | null
  displayedPortfolioValue: string | null
  displayedPnlValues: Record<string, string>
  zeroValuesSuppressed: string[]
  finalUiState: string
  failureReason: string | null
}

export type WalletScannerViewModel = {
  portfolioValueView: PortfolioValueView
  pnlEvidenceView: PnlEvidenceView
  pnlViewModel: WalletPnlViewModel
  audit: WalletScannerViewAudit
}

export type BuildWalletScannerViewModelParams = {
  walletAddress?: string | null
  portfolio?: PortfolioSummary | null
  portfolioV2?: EnginePortfolioV2 | null
  chainValueUsd?: Record<number, number> | null
  portfolioTotalByChain?: Record<string, number> | null
  pricedHoldings?: PricedHolding[] | null
  canonicalOverride?: CanonicalMergeOverride
  canonicalTotalValueUsd?: number | null
  finalCanonicalMergeAudit?: { robinhoodMerged: boolean } | null
  pnlV2?: PnlV2 | null
  publicPnlStatus?: PublicPnlStatus | null
  unrealizedReconciliation?: UnrealizedReconciliationSummary | null
  reconciliationSummary?: PnlReconciliationSummary | null
  canonicalSampleManifestAudit?: CanonicalSampleManifestAudit | null
  robinhoodResult?: RobinhoodWalletScanResponse | null
  chainsScanned?: string[]
}

function parseSignedUsd(value: string | null): number | null {
  if (!value || value === '—') return null
  const n = Number(value.replace(/[^0-9.\-]/g, ''))
  if (!Number.isFinite(n)) return null
  if (value.startsWith('-')) return -Math.abs(n)
  return n
}

function chainValueMap(rows: ChainBreakdownRow[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of rows) out[row.chain] = row.valueUsd
  return out
}

export function buildPortfolioValueView(params: BuildWalletScannerViewModelParams): PortfolioValueView {
  const { stats } = selectPortfolioStats(params.portfolio, params.portfolioV2)
  const canonicalOverride = params.canonicalOverride ?? deriveCanonicalMergeOverride({
    canonicalTotalValueUsd: params.canonicalTotalValueUsd,
    finalCanonicalMergeAudit: params.finalCanonicalMergeAudit,
  })
  const merged = computeMergedTotalValueUsd(stats.totalValueUsd, params.robinhoodResult, canonicalOverride)
  const totalValueUsd = merged.totalValueUsd
  const breakdown = selectChainBreakdown(
    params.chainValueUsd,
    totalValueUsd,
    params.portfolio?.chainValueBreakdown,
    params.portfolioTotalByChain,
  )
  const holdings = mergeRobinhoodIntoPricedHoldings(
    params.pricedHoldings,
    params.chainValueUsd,
    params.robinhoodResult,
    params.portfolioTotalByChain,
  ).pricedHoldings
  const priced = holdings.filter((h) => h.valueUsd != null && h.valueUsd > 0)
  const unpriced = holdings.filter((h) => h.valueUsd == null || h.valueUsd === 0)
  // Prefer the real priced-holdings list (the same rows the Holdings tab renders). Fall back to
  // selectPortfolioStats only when the list was never supplied (preview path).
  const pricedHoldingsCount = params.pricedHoldings != null || (params.robinhoodResult?.ok === true)
    ? priced.length
    : stats.pricedTokenCount
  const unpricedHoldingsCount = params.pricedHoldings != null || (params.robinhoodResult?.ok === true)
    ? unpriced.length
    : 0
  const valueByChain = chainValueMap(breakdown)
  const valueStatus: PortfolioValueStatus = totalValueUsd != null && totalValueUsd > 0 ? 'ready' : 'unavailable'
  return {
    totalValueUsd,
    valueByChain,
    pricedHoldingsCount,
    unpricedHoldingsCount,
    topHoldings: stats.topChips,
    valueStatus,
    failureReason: valueStatus === 'unavailable' ? 'No priced holdings found for this wallet.' : null,
  }
}

export function buildPnlEvidenceView(params: BuildWalletScannerViewModelParams): { pnlEvidenceView: PnlEvidenceView; pnlViewModel: WalletPnlViewModel } {
  const pnlViewModel = buildWalletPnlViewModel({
    pnlV2: params.pnlV2,
    publicPnlStatus: params.publicPnlStatus,
    unrealizedReconciliation: params.unrealizedReconciliation,
    reconciliationSummary: params.reconciliationSummary,
    canonicalSampleManifestAudit: params.canonicalSampleManifestAudit,
    robinhoodResult: params.robinhoodResult,
    chainsScanned: params.chainsScanned,
  })
  const blockingReasons: string[] = []
  if (pnlViewModel.combinedStatus === 'unavailable' || pnlViewModel.combinedStatus === 'locked') {
    blockingReasons.push(pnlViewModel.combinedReason)
  }
  if (pnlViewModel.unrealizedBox.status === 'Locked' || pnlViewModel.unrealizedBox.status === 'Unavailable') {
    blockingReasons.push(`Unrealized: ${pnlViewModel.unrealizedBox.reason}`)
  }
  if (pnlViewModel.roiBox.status === 'Locked' || pnlViewModel.roiBox.status === 'Unavailable') {
    blockingReasons.push(`ROI: ${pnlViewModel.roiBox.reason}`)
  }
  for (const row of pnlViewModel.chainRows) {
    if (row.status !== 'Verified') blockingReasons.push(`${row.label}: ${row.reason}`)
  }
  return {
    pnlViewModel,
    pnlEvidenceView: {
      combinedStatus: pnlViewModel.combinedStatus,
      combinedRealizedPnlUsd: parseSignedUsd(pnlViewModel.combinedRealizedBox.value),
      combinedReason: pnlViewModel.combinedReason,
      chainPnlRows: pnlViewModel.chainRows,
      unrealizedStatus: pnlViewModel.unrealizedBox.status,
      roiStatus: pnlViewModel.roiBox.status,
      blockingReasons,
    },
  }
}

function rawChainPnlUsd(pnlV2: PnlV2 | null | undefined, chain: 'base' | 'eth'): number | null {
  if (!pnlV2) return null
  const chainId = chain === 'base' ? 8453 : 1
  const row = pnlV2.chainBreakdown.find((c) => c.chainId === chainId)
  return row != null && Number.isFinite(row.realizedPnlUsd) ? row.realizedPnlUsd : null
}

export function buildWalletScannerViewAudit(params: {
  walletAddress: string | null
  portfolioValueView: PortfolioValueView
  pnlEvidenceView: PnlEvidenceView
  pnlViewModel: WalletPnlViewModel
  pnlV2?: PnlV2 | null
}): WalletScannerViewAudit {
  const { portfolioValueView: p, pnlEvidenceView: e, pnlViewModel: vm, pnlV2 } = params
  const baseRow = e.chainPnlRows.find((r) => r.chain === 'base')
  const ethRow = e.chainPnlRows.find((r) => r.chain === 'eth' || r.chain === 'ethereum')
  const rhRow = e.chainPnlRows.find((r) => r.chain === 'robinhood')
  const zeroValuesSuppressed: string[] = []
  const rawBase = rawChainPnlUsd(pnlV2, 'base')
  const rawEth = rawChainPnlUsd(pnlV2, 'eth')
  if (baseRow && shouldSuppressUnverifiedZeroPnl(baseRow.status, rawBase)) zeroValuesSuppressed.push('base')
  if (ethRow && shouldSuppressUnverifiedZeroPnl(ethRow.status, rawEth)) zeroValuesSuppressed.push('eth')
  if (shouldSuppressUnverifiedZeroPnl(vm.combinedRealizedBox.status, pnlV2?.realizedPnlUsd ?? null)) {
    zeroValuesSuppressed.push('combined')
  }
  const displayedPnlValues: Record<string, string> = {
    combined: vm.combinedRealizedBox.value ?? '—',
    unrealized: vm.unrealizedBox.value ?? '—',
    roi: vm.roiBox.value ?? '—',
  }
  if (baseRow) displayedPnlValues.base = baseRow.value ?? '—'
  if (ethRow) displayedPnlValues.eth = ethRow.value ?? '—'
  if (rhRow) displayedPnlValues.robinhood = rhRow.value ?? '—'

  const portfolioReady = p.valueStatus === 'ready'
  const pnlUnavailable = e.combinedStatus === 'unavailable' || e.combinedStatus === 'locked'
  const finalUiState = portfolioReady && pnlUnavailable
    ? 'portfolio_ready_pnl_unavailable'
    : portfolioReady && e.combinedStatus === 'verified'
      ? 'portfolio_ready_pnl_verified'
      : portfolioReady
        ? 'portfolio_ready_pnl_partial'
        : pnlUnavailable
          ? 'portfolio_unavailable_pnl_unavailable'
          : 'portfolio_unavailable'

  return {
    walletAddress: params.walletAddress,
    portfolioTotalValueUsd: p.totalValueUsd,
    portfolioValueByChain: p.valueByChain,
    pricedHoldingsCount: p.pricedHoldingsCount,
    unpricedHoldingsCount: p.unpricedHoldingsCount,
    combinedPnlStatus: e.combinedStatus,
    combinedRealizedPnlUsd: e.combinedRealizedPnlUsd,
    basePnlStatus: baseRow?.status ?? null,
    baseRealizedPnlUsd: parseSignedUsd(baseRow?.value ?? null),
    ethPnlStatus: ethRow?.status ?? null,
    robinhoodPnlStatus: rhRow?.status ?? null,
    displayedPortfolioValue: p.totalValueUsd != null ? fmtUsd(p.totalValueUsd) : null,
    displayedPnlValues,
    zeroValuesSuppressed,
    finalUiState,
    failureReason: p.failureReason ?? (pnlUnavailable ? e.combinedReason : null),
  }
}

export function buildWalletScannerViewModel(params: BuildWalletScannerViewModelParams): WalletScannerViewModel {
  const portfolioValueView = buildPortfolioValueView(params)
  const { pnlEvidenceView, pnlViewModel } = buildPnlEvidenceView(params)
  const audit = buildWalletScannerViewAudit({
    walletAddress: params.walletAddress ?? null,
    portfolioValueView,
    pnlEvidenceView,
    pnlViewModel,
    pnlV2: params.pnlV2,
  })
  return { portfolioValueView, pnlEvidenceView, pnlViewModel, audit }
}

export default buildWalletScannerViewModel
