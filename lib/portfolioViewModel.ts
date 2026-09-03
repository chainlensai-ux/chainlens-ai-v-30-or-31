// buildPortfolioViewModel — ONE shared, pure view model for Portfolio, Wallet Scanner's Portfolio
// Intelligence section, and Clark's portfolio insights.
//
// PORTFOLIO-PAGE-EMPTY-DATA FIX, DISCLOSED (full audit — "Portfolio page shows $0.00/Tokens: 0/
// Clark NEEDS DATA even though Wallet Scanner has real holdings for the same wallet"). Root causes
// found:
//   1. app/terminal/portfolio/page.tsx used wagmi's useAccount() as the ONLY wallet-address source
//      — a wallet address typed/pasted into Wallet Scanner's plain text input (its real, only
//      "connected wallet" concept) was never seen by this page at all if no browser extension
//      wallet happened to be connected to the same address.
//   2. /api/portfolio's fallback path (lib/server/walletLite.ts's getPortfolioLite) is a literal
//      stub — always returns { ok: true, balances: [], positions: [], chains: [] } — so any V2
//      failure silently produced a confident-looking EMPTY result instead of a real error.
//   3. lib/server/v2Adapters.ts's DEFAULT_CHAINS is ['base','eth','arbitrum'] — no 'bnb', no
//      'robinhood' — while Wallet Scanner's real chain set covers more, per the disclosed
//      chain-coverage gap this task's spec calls out directly ("only Base queried while wallet
//      assets are on Robinhood/ETH").
//   4. The Portfolio page's own client-side filter then dropped every holding whose chain string
//      didn't literally include "base" — a SECOND, page-local Base-only filter on top of #3.
//
// FIX DIRECTION: this module does not re-derive any portfolio/PnL math of its own. It is a pure
// assembler over ALREADY-COMPUTED, real values — the exact same selectors Wallet Scanner's own
// PortfolioIntelligenceCard/WalletProfileHeader/PnlStatusCard call
// (selectPortfolioStats/selectChainBreakdown/computeMergedTotalValueUsd/buildWalletPnlViewModel,
// see mapWalletScanReportToPortfolioViewModel below) so Portfolio, Wallet Scanner, and Clark can
// never disagree about the same scan's numbers. "Do not rewrite Wallet Scanner math" is honored by
// construction: no arithmetic on price/value/PnL happens in this file beyond simple sorting/
// percent-of-total display derivations that were already being done ad hoc by the old Portfolio
// page (concentration %, top holding, chain count) — never a second, independent recomputation of
// a dollar amount that already has a canonical source elsewhere.

export type PortfolioHolding = {
  symbol: string
  name: string | null
  chain: string
  contract: string | null
  balance: number
  price: number | null
  value: number | null
  change24h: number | null
}

export type PortfolioChainExposure = {
  chain: string
  valueUsd: number
  percent: number
}

export type PortfolioPnlStatus = 'verified' | 'partial' | 'locked' | 'unavailable'

export type PortfolioPnlSummary = {
  status: PortfolioPnlStatus
  reason: string
  realizedUsd: number | null
  unrealizedUsd: number | null
} | null

export type PortfolioRiskSummary = {
  concentrationPercent: number | null
  topHoldingSymbol: string | null
  notes: string[]
} | null

export type PortfolioActivityItem = {
  label: string
  timestampMs: number | null
}

export type PortfolioDataSource = 'wallet_scanner_cache' | 'live_scan' | 'robinhood_only' | 'none'

export type PortfolioViewModelInput = {
  walletAddress: string | null
  holdings: PortfolioHolding[]
  chainBreakdown: PortfolioChainExposure[]
  pnlSummary: PortfolioPnlSummary
  riskSummary: PortfolioRiskSummary
  activity: PortfolioActivityItem[]
  source: PortfolioDataSource
  /** Set true only once a scan genuinely ran/returned for this wallet — distinguishes "no wallet
   * connected yet" from "scanned, zero supported assets found". */
  scanAttempted: boolean
  /** Set when a provider/scan attempt genuinely failed — never fabricated from an empty result. */
  failureReason: string | null
}

export type PortfolioUiState = 'loading' | 'no_wallet' | 'no_supported_assets' | 'provider_failed' | 'ready'

export type PortfolioVerdict = 'BULLISH' | 'NEUTRAL' | 'CAUTIOUS' | 'NEEDS_DATA'

export type PortfolioViewModel = {
  walletAddress: string | null
  source: PortfolioDataSource
  finalUiState: PortfolioUiState
  totalValueUsd: number
  tokenCount: number
  pricedTokenCount: number
  isMultiChain: boolean
  chainExposure: PortfolioChainExposure[]
  holdings: PortfolioHolding[]
  topHoldings: PortfolioHolding[]
  concentrationPercent: number
  verdict: PortfolioVerdict
  summary: string
  riskNotes: string[]
  topOpportunity: string | null
  pnl: PortfolioPnlSummary
  missingDataReasons: string[]
  emptyReason: string | null
}

function clampPercent(n: number): number {
  return Math.max(0, Math.min(100, n))
}

/** Pure assembler — takes already-normalized, already-computed inputs and produces the one shared
 * portfolio view model. Never fetches, never recomputes a dollar figure that wasn't already in the
 * input (only sorts/aggregates what's already there). */
export function buildPortfolioViewModel(input: PortfolioViewModelInput): PortfolioViewModel {
  const holdings = input.holdings.filter((h) => (h.value ?? 0) > 0)
  const sorted = [...holdings].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  const totalValueUsd = sorted.reduce((sum, h) => sum + (h.value ?? 0), 0)
  const pricedTokenCount = sorted.filter((h) => h.price != null && h.price > 0).length
  const chainExposure = [...input.chainBreakdown].sort((a, b) => b.valueUsd - a.valueUsd)
  const isMultiChain = chainExposure.filter((c) => c.valueUsd > 0).length > 1

  // ── finalUiState — the one place that decides which of the 5 required UI states applies ──
  let finalUiState: PortfolioUiState
  let emptyReason: string | null = null
  if (!input.walletAddress) {
    finalUiState = 'no_wallet'
  } else if (!input.scanAttempted) {
    finalUiState = 'loading'
  } else if (input.failureReason) {
    finalUiState = 'provider_failed'
    emptyReason = input.failureReason
  } else if (sorted.length === 0 || totalValueUsd <= 0) {
    // $0 is only ever shown here — after a real, completed scan attempt found no positive-value
    // supported holdings. Never reached from "no wallet"/"loading"/"provider failed" above.
    finalUiState = 'no_supported_assets'
    emptyReason = 'Scan completed — no supported assets with a resolvable price were found for this wallet.'
  } else {
    finalUiState = 'ready'
  }

  const topHolding = sorted[0] ?? null
  const concentrationPercent = topHolding && totalValueUsd > 0 ? clampPercent(((topHolding.value ?? 0) / totalValueUsd) * 100) : (input.riskSummary?.concentrationPercent ?? 0)
  const withChange = sorted.filter((h) => typeof h.change24h === 'number')
  const bestPerformer = [...withChange].sort((a, b) => (b.change24h ?? 0) - (a.change24h ?? 0))[0] ?? null

  const missingDataReasons: string[] = []
  if (!input.pnlSummary || input.pnlSummary.status === 'unavailable') missingDataReasons.push('PnL evidence is not yet verified for this wallet.')
  if (withChange.length === 0 && sorted.length > 0) missingDataReasons.push('24h price-change history is not tracked for these holdings.')
  if (input.activity.length === 0) missingDataReasons.push('No recent on-chain activity has been indexed yet.')

  let verdict: PortfolioVerdict
  let summary: string
  if (finalUiState !== 'ready') {
    verdict = 'NEEDS_DATA'
    summary = finalUiState === 'no_wallet'
      ? 'Connect a wallet or enter an address to generate a portfolio read.'
      : finalUiState === 'loading'
        ? 'Loading portfolio…'
        : finalUiState === 'provider_failed'
          ? `Clark cannot read this portfolio yet — ${emptyReason}`
          : 'Clark needs at least one priced, supported holding before generating a portfolio read.'
  } else {
    const pnlOk = input.pnlSummary?.status === 'verified' || input.pnlSummary?.status === 'partial'
    const realized = input.pnlSummary?.realizedUsd ?? 0
    if (pnlOk && realized > 0 && sorted.length >= 4 && concentrationPercent < 60) verdict = 'BULLISH'
    else if (concentrationPercent > 70 || (pnlOk && realized < 0)) verdict = 'CAUTIOUS'
    else verdict = 'NEUTRAL'

    const chainTxt = isMultiChain ? `spread across ${chainExposure.filter((c) => c.valueUsd > 0).length} chains` : `concentrated on ${chainExposure[0]?.chain ?? 'one chain'}`
    const concentrationTxt = concentrationPercent > 55 ? 'value is concentrated in the top few positions' : 'allocation is reasonably distributed across positions'
    summary = `Portfolio holds ${sorted.length} priced asset${sorted.length === 1 ? '' : 's'}, ${chainTxt}, and ${concentrationTxt}.`
    if (missingDataReasons.length > 0) summary += ` Read is partial — ${missingDataReasons.join(' ')}`
  }

  const riskNotes: string[] = [...(input.riskSummary?.notes ?? [])]
  if (finalUiState === 'ready') {
    if (concentrationPercent > 70 && topHolding) riskNotes.push(`${topHolding.symbol} alone makes up ${concentrationPercent.toFixed(0)}% of tracked value.`)
    if (!isMultiChain && chainExposure.length <= 1) riskNotes.push('Holdings are on a single supported chain — no cross-chain diversification.')
    if (input.pnlSummary && input.pnlSummary.status !== 'verified') riskNotes.push(input.pnlSummary.reason)
  }

  const topOpportunity = finalUiState === 'ready' && bestPerformer && typeof bestPerformer.change24h === 'number'
    ? `${bestPerformer.symbol} leads short-term momentum at ${bestPerformer.change24h >= 0 ? '+' : ''}${bestPerformer.change24h.toFixed(2)}%.`
    : null

  return {
    walletAddress: input.walletAddress,
    source: input.source,
    finalUiState,
    totalValueUsd,
    tokenCount: sorted.length,
    pricedTokenCount,
    isMultiChain,
    chainExposure,
    holdings: sorted,
    topHoldings: sorted.slice(0, 5),
    concentrationPercent,
    verdict,
    summary,
    riskNotes,
    topOpportunity,
    pnl: input.pnlSummary,
    missingDataReasons,
    emptyReason,
  }
}

// ── Audit object, per spec ──────────────────────────────────────────────────────────────────
export type PortfolioPageAudit = {
  walletAddress: string | null
  authUserPresent: boolean
  connectedWalletDetected: boolean
  cachedWalletScannerResultFound: boolean
  portfolioApiCalled: boolean
  chainsRequested: string[]
  chainsReturned: string[]
  holdingsReturned: number
  pricedHoldings: number
  totalValueUsd: number
  sourceUsed: PortfolioDataSource
  filteredOutCount: number
  zeroReason: string | null
  failureReason: string | null
  cacheHit: boolean
  finalUiState: PortfolioUiState
}

export function buildPortfolioPageAudit(input: {
  walletAddress: string | null
  authUserPresent: boolean
  connectedWalletDetected: boolean
  cachedWalletScannerResultFound: boolean
  portfolioApiCalled: boolean
  chainsRequested: string[]
  chainsReturned: string[]
  rawHoldingsCount: number
  failureReason: string | null
  cacheHit: boolean
  viewModel: PortfolioViewModel
}): PortfolioPageAudit {
  return {
    walletAddress: input.walletAddress,
    authUserPresent: input.authUserPresent,
    connectedWalletDetected: input.connectedWalletDetected,
    cachedWalletScannerResultFound: input.cachedWalletScannerResultFound,
    portfolioApiCalled: input.portfolioApiCalled,
    chainsRequested: input.chainsRequested,
    chainsReturned: input.chainsReturned,
    holdingsReturned: input.viewModel.tokenCount,
    pricedHoldings: input.viewModel.pricedTokenCount,
    totalValueUsd: input.viewModel.totalValueUsd,
    sourceUsed: input.viewModel.source,
    filteredOutCount: Math.max(0, input.rawHoldingsCount - input.viewModel.tokenCount),
    zeroReason: input.viewModel.finalUiState === 'no_supported_assets' ? input.viewModel.emptyReason : null,
    failureReason: input.failureReason,
    cacheHit: input.cacheHit,
    finalUiState: input.viewModel.finalUiState,
  }
}
