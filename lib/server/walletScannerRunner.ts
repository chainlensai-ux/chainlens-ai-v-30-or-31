import { fetchWalletSnapshot, type WalletSnapshotOptions } from '@/lib/server/walletSnapshot'

export type WalletScannerRunnerInput = {
  address: string
  refresh?: boolean
  deepScan?: boolean
  deepActivity?: boolean
  chainMode?: 'auto' | 'base' | 'eth' | 'base_eth' | 'all_supported'
}

function buildRunnerWalletModuleCoverage(snapshot: any) {
  const holdingsCount = snapshot.holdingsCount ?? (Array.isArray(snapshot.holdings) ? snapshot.holdings.length : 0)
  const totalValue = typeof snapshot.totalValue === 'number' ? snapshot.totalValue : 0
  const closedLots = snapshot.walletLotSummary?.closedLots ?? snapshot.closedLots ?? snapshot.estimatedPnl?.closedLots ?? 0
  const openLots = snapshot.walletLotSummary?.openedLots ?? snapshot.openLots ?? snapshot.walletOpenPositionSummary?.openLots ?? 0
  const eventCount = snapshot.walletEvidenceSummary?.totalEvents ?? snapshot.walletBehavior?.txCount ?? snapshot.txCount ?? 0
  const pricedEvents = snapshot.walletPriceEvidenceSummary?.pricedEvents ?? 0
  const swapCandidates = snapshot.walletSwapSummary?.swapCandidateCount ?? snapshot.walletPriceEvidenceSummary?.swapCandidateEvents ?? 0
  return {
    portfolio: { status: holdingsCount > 0 && totalValue > 0 ? 'ok' : holdingsCount > 0 ? 'partial' : 'open_check', evidence: holdingsCount > 0 ? ['holdings'] : [], reason: holdingsCount > 0 ? `${holdingsCount}_holdings_loaded` : 'no_holdings_found' },
    activity: { status: eventCount > 0 ? 'partial' : 'open_check', evidence: eventCount > 0 ? ['activity_events'] : [], eventCount, reason: eventCount > 0 ? `${eventCount}_events_indexed` : 'no_activity_events' },
    swapDetection: { status: swapCandidates > 0 ? 'ok' : 'open_check', evidence: swapCandidates > 0 ? ['swap_candidates'] : [], candidateCount: swapCandidates, reason: swapCandidates > 0 ? `${swapCandidates}_swap_candidates_found` : 'no_swap_candidates_to_price' },
    priceEvidence: { status: pricedEvents > 0 ? 'ok' : 'open_check', pricedEvents, reason: pricedEvents > 0 ? `${pricedEvents}_events_priced` : 'no_priced_swap_events' },
    fifoPnL: { status: closedLots > 0 ? 'ok' : 'locked_no_closed_lots', closedLots, reason: closedLots > 0 ? `${closedLots}_closed_lots_matched` : openLots > 0 ? 'open_lots_tracked_no_closed_trades' : 'no_closed_lots' },
    tradeStats: { status: closedLots >= 10 ? 'ok' : closedLots > 0 ? 'locked_insufficient_trades' : 'locked_no_closed_lots', closedLots, openedLots: openLots, readyForWinRate: closedLots >= 10, reason: closedLots >= 10 ? `${closedLots}_closed_lots_ready` : closedLots > 0 ? `${closedLots}_closed_lots_below_threshold` : 'no_closed_lots' },
    behavior: { status: snapshot.walletBehavior ? 'partial' : 'open_check', reason: snapshot.walletBehavior ? 'limited_activity_signal' : 'no_activity_data' },
    walletOpenPositionSummary: snapshot.walletOpenPositionSummary ?? null,
    openPositionPerformanceSummary: snapshot.openPositionPerformanceSummary ?? null,
  }
}

function buildRunnerWalletScanHealth(coverage: any, snapshot: any) {
  const holdingsCount = snapshot.holdingsCount ?? (Array.isArray(snapshot.holdings) ? snapshot.holdings.length : 0)
  const usableModules: string[] = []
  const lockedModules: string[] = []
  for (const key of ['portfolio', 'activity', 'swapDetection', 'priceEvidence', 'fifoPnL', 'tradeStats', 'behavior']) {
    const status = coverage[key]?.status
    if (status === 'ok' || status === 'partial') usableModules.push(key)
    else lockedModules.push(key)
  }
  if (holdingsCount <= 0 && coverage.activity?.status === 'open_check') return { status: 'open_check', title: 'Wallet scan open check', summary: 'ChainLens could not find usable holdings or activity evidence for this wallet.', usableModules, lockedModules, nextAction: 'Verify the wallet address and chain, or try again later.' }
  if (coverage.fifoPnL?.status !== 'ok') return { status: 'limited_pnl', title: 'Portfolio found — PnL needs more trade evidence', summary: 'Holdings were loaded, but closed lots/cost basis are incomplete.', usableModules, lockedModules, nextAction: 'Run deeper recovery if budget allows.' }
  if (coverage.tradeStats?.status !== 'ok') return { status: 'partial', title: 'Wallet scan mostly complete', summary: 'Holdings and PnL evidence were found, but win-rate stats need more meaningful closed trades.', usableModules, lockedModules, nextAction: 'Win-rate stats unlock with more meaningful closed trades.' }
  return { status: 'ok', title: 'Wallet scan complete', summary: 'Holdings, activity, and PnL evidence were all available for this wallet.', usableModules, lockedModules, nextAction: 'Review the full wallet scanner breakdown.' }
}

export async function runWalletScanner(input: WalletScannerRunnerInput) {
  const address = String(input.address ?? '').trim().toLowerCase()
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return { ok: false, status: 400, error: 'Invalid wallet address.' as const }
  }
  const options: WalletSnapshotOptions = { refresh: input.refresh === true }
  const snapshot: any = await fetchWalletSnapshot(address, options)
  const walletModuleCoverage = snapshot.walletModuleCoverage ?? buildRunnerWalletModuleCoverage(snapshot)
  const walletScanHealth = snapshot.walletScanHealth ?? buildRunnerWalletScanHealth(walletModuleCoverage, snapshot)
  return {
    ok: true,
    status: 200,
    address: snapshot.address,
    holdings: snapshot.holdings ?? [],
    totalValue: snapshot.totalValue ?? null,
    txCount: snapshot.txCount ?? null,
    behaviorChain: snapshot.behaviorChain ?? null,
    walletBehavior: snapshot.walletBehavior ?? null,
    estimatedPnl: snapshot.estimatedPnl ?? null,
    dataFreshness: snapshot.dataFreshness ?? 'live',
    cacheAgeSeconds: snapshot.cacheAgeSeconds ?? null,
    historicalRecoveryStatus: snapshot.historicalRecoveryStatus ?? snapshot.historicalCoverage?.status ?? null,
    pnlCoverage: snapshot.pnlCoverage ?? snapshot.estimatedPnl?.coverage ?? null,
    openLots: snapshot.openLots ?? snapshot.walletOpenPositionSummary?.openLots ?? walletModuleCoverage?.tradeStats?.openedLots ?? null,
    closedLots: snapshot.closedLots ?? snapshot.estimatedPnl?.closedLots ?? walletModuleCoverage?.fifoPnL?.closedLots ?? null,
    walletScanHealth,
    walletModuleCoverage,
    walletTokenPnlSummary: snapshot.walletTokenPnlSummary ?? null,
    walletTokenPnlRead: snapshot.walletTokenPnlRead ?? [],
    walletTradeStatsSummary: snapshot.walletTradeStatsSummary ?? null,
    walletHistoricalCoverageSummary: snapshot.walletHistoricalCoverageSummary ?? null,
    walletOpenPositionSummary: snapshot.walletOpenPositionSummary ?? walletModuleCoverage?.walletOpenPositionSummary ?? null,
    openPositionPerformanceSummary: snapshot.openPositionPerformanceSummary ?? walletModuleCoverage?.openPositionPerformanceSummary ?? null,
    warnings: snapshot.warnings ?? snapshot.walletScanCacheNote ?? null,
  }
}
