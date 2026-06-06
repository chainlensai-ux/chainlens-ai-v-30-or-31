'use client'

import { useState } from 'react'
import { usePlanWithLoading, LockedPanel, canAccessFeature } from '@/lib/usePlan'
import { supabase } from '@/lib/supabaseClient'

// ── Types ────────────────────────────────────────────────────────────────────────────

type Holding = {
  name: string
  symbol: string
  icon: string | null
  chain: string | null
  balance: number
  value: number
  price: number | null
  change24h: number | null
  verified: boolean
}

type WalletBehavior = {
  status: 'ok' | 'partial' | 'unavailable'
  source: 'activity_layer' | 'unavailable'
  txCount: number | null
  activeDays: number | null
  topTokens: string[]
  topContracts: string[]
  inboundCount: number | null
  outboundCount: number | null
  stablecoinActivity: boolean
  recentActivitySummary: string
  reason: string
}

type ClarkVerdict = {
  verdict: string
  confidence: string
  read: string
  keySignals: string[]
  risks: string[]
  nextAction: string
}

type WalletTier = 'Smart Money' | 'Positive Early Read' | 'Average Trader' | 'Losing Wallet' | 'Open Check'
type WalletIntelStatus = 'ok' | 'partial' | 'open_check'
type WalletConfidence = 'high' | 'medium' | 'low' | 'open check'

type WalletRecentTrade = {
  token: string
  entry: number | null
  exit: number | null
  pnl: number | null
  holdTime: string | null
  size: number | null
  status: 'closed' | 'open' | 'unavailable' | string
}

type WalletIntelligence = {
  status: WalletIntelStatus
  confidence: WalletConfidence
  walletScore: number | null
  walletTier: WalletTier
  winRate: number | null
  lossRate: number | null
  pnl: {
    total: number | null
    sevenDay: number | null
    thirtyDay: number | null
    thisMonth: number | null
    realized: number | null
    unrealized: number | null
    biggestWin: number | null
    biggestLoss: number | null
    avgWin: number | null
    avgLoss: number | null
  }
  tradeBehavior?: {
    closedTrades: number
    avgHoldTime: string | null
    reason: string
  }
  personalitySummary: string
  recentTrades: WalletRecentTrade[]
  openChecks: string[]
}

type WalletResult = {
  address: string
  totalValue: number
  holdings: Holding[]
  txCount: number | null
  firstTxDate: string | null
  walletAgeDays: number | null
  providerUsed?: 'portfolio_layer' | 'holdings_layer' | 'fallback_layer' | 'unverified' | 'none' | null
  providerStatus?: 'ok' | 'partial' | 'failed' | null
  holdingsCount?: number | null
  totalUsdAvailable?: boolean
  reason?: string | null
  portfolioSource?: 'portfolio_layer' | 'holdings_layer' | 'fallback_layer' | 'unverified' | 'none'
  behaviorSource?: 'activity_layer' | 'unavailable'
  behaviorChain?: 'base'
  pnlSource?: 'activity_layer' | 'fallback_layer' | 'unavailable'
  pnlCoverageReason?: string
  hiddenDustCount?: number
  unpricedHoldingsCount?: number
  walletBehavior?: WalletBehavior | null
  estimatedPnl?: {
    status: 'ok' | 'partial' | 'unavailable' | 'error'
    confidence: 'high' | 'medium' | 'low' | null
    coveragePercent: number
    source: 'activity_layer' | 'fallback_layer' | 'none'
    totalEstimatedPnlUsd: number | null
    unrealizedPnlUsd: number | null
    realizedPnlUsd: number | null
    method: 'average_cost_estimate'
    tokens: Array<{ symbol: string; contract: string; estimatedUnrealizedPnlUsd: number | null; estimatedRealizedPnlUsd: number | null; coveragePercent: number; confidence: 'high' | 'medium' | 'low' }>
    reason: string
  }
  walletIntelligence?: WalletIntelligence
  walletEvidenceSummary?: {
    status: 'ready' | 'partial' | 'missing_hashes' | 'no_events' | 'provider_unavailable' | 'not_requested' | 'ok' | 'open_check'
    totalEvents: number
    eventsWithHash: number
    eventsWithTimestamp: number
    hashCoverage?: number
    timestampCoverage?: number
    readyForSwapDetection?: boolean
    sampleHashes?: string[]
    sampleTimestamps?: string[]
    missing: string[]
  }
  walletSwapSummary?: {
    status: 'ok' | 'partial' | 'open_check'
    swapCandidateCount: number
    highConfidenceCount: number
    mediumConfidenceCount: number
    lowConfidenceCount: number
    missing: string[]
  }
  walletPriceEvidenceSummary?: {
    status: 'ok' | 'partial' | 'open_check'
    swapCandidateEvents: number
    pricedEvents: number
    openCheckEvents: number
    unavailableEvents: number
    stableLegPricedEvents: number
    wethLegPricedEvents: number
    historicalPricedEvents: number
    priceAttemptLimitReached: boolean
    readyForLotMatching: boolean
    missing: string[]
  }
  walletLotSummary?: {
    status: 'ok' | 'partial' | 'open_check'
    pricedSwapEvents: number
    openedLots: number
    closedLots: number
    partiallyClosedLots: number
    unmatchedBuys: number
    unmatchedSells: number
    realizedPnlUsd: number | null
    realizedPnlPercent: number | null
    totalCostBasisClosedUsd: number | null
    totalProceedsClosedUsd: number | null
    readyForTradeStats: boolean
    missing: string[]
  }
  walletTradeStatsSummary?: {
    status: 'ok' | 'partial' | 'open_check'
    closedLots: number
    openedLots?: number
    uniqueTokensTraded: number
    realizedPnlUsd: number | null
    realizedPnlPercent: number | null
    winningClosedLots: number
    losingClosedLots: number
    breakEvenClosedLots: number
    isBreakEvenOnly?: boolean
    winRatePercent: number | null
    avgPnlUsdPerClosedLot: number | null
    avgReturnPercentPerClosedLot: number | null
    medianReturnPercentPerClosedLot: number | null
    avgHoldingTimeSeconds: number | null
    medianHoldingTimeSeconds: number | null
    largestWinUsd: number | null
    largestLossUsd: number | null
    confidence: 'high' | 'medium' | 'low' | 'open_check'
    sampleSizeLabel: 'insufficient' | 'very_small_sample' | 'small_sample' | 'early_confidence' | 'early' | 'developing' | 'strong' | 'micro_sample'
    readyForWalletScore: boolean
    rawStatsAvailable?: boolean
    scoreUnlocked?: boolean
    confidenceLabel?: 'open_check' | 'very_small_sample' | 'small_sample' | 'early_confidence' | 'developing' | 'high'
    sampleWarning?: string | null
    meaningfulClosedLots: number
    dustClosedLots: number
    meaningfulCostBasisUsd: number
    avgCostBasisPerClosedLot: number | null
    economicSignificance: 'meaningful' | 'micro_sample' | 'open_check'
    economicSignificanceReason: string
    missing: string[]
  }
  walletTradeStatsSource?: 'base_sample' | 'historical_promoted_preview'
  walletClosedTradeSamples?: Array<{
    tokenSymbol: string
    tokenAddress: string
    chain: string
    openedAt: string
    closedAt: string
    holdingTimeSeconds: number | null
    amountClosed: number
    entryPriceUsd: number | null
    exitPriceUsd: number | null
    realizedPnlUsd: number | null
    realizedPnlPercent: number | null
    confidence: 'low' | 'medium' | 'high'
    entryTxHash?: string | null
    exitTxHash?: string | null
    verificationStatus?: 'verifiable' | 'partial' | 'not_available'
  }>
  walletScanCostMode?: 'basic' | 'basic_cached' | 'deep_cached' | 'deep_live' | 'historical_cached' | 'historical_live' | 'blocked_by_cooldown' | 'blocked_by_cost_guard'
  walletScanCacheNote?: string
  walletModuleCoverage?: {
    portfolio:     { status: 'ok' | 'partial' | 'open_check'; evidence: string[]; reason: string }
    activity:      { status: 'ok' | 'partial' | 'open_check'; evidence: string[]; eventCount: number; reason: string }
    swapDetection: { status: 'ok' | 'partial' | 'open_check'; evidence: string[]; candidateCount: number; reason: string }
    priceEvidence: { status: 'ok' | 'partial' | 'open_check'; pricedEvents: number; reason: string }
    fifoPnL:       { status: 'ok' | 'partial' | 'open_check'; closedLots: number; reason: string }
    tradeStats:    { status: 'ok' | 'partial' | 'open_check'; closedLots: number; openedLots: number; readyForWinRate: boolean; reason: string }
    behavior:      { status: 'ok' | 'partial' | 'open_check'; reason: string }
    walletOpenPositionSummary?: {
      status: 'partial' | 'open_check'
      openLots: number
      uniqueTokens: number
      totalOpenCostBasisUsd: number | null
      tokens: Array<{ symbol: string; chain: string; openLots: number; totalAmount: number; avgEntryPriceUsd: number | null; totalCostBasisUsd: number; firstOpenedAt: string; latestOpenedAt: string }>
      missing: string[]
      reason: string
    } | null
  }
  walletOpenPositionSummary?: {
    status: 'partial' | 'open_check'
    openLots: number
    uniqueTokens: number
    totalOpenCostBasisUsd: number | null
    tokens: Array<{ symbol: string; chain: string; openLots: number; totalAmount: number; avgEntryPriceUsd: number | null; totalCostBasisUsd: number; firstOpenedAt: string; latestOpenedAt: string }>
    missing: string[]
    reason: string
  } | null
  openPositionPerformanceSummary?: {
    status: 'partial'
    openLots: number
    uniqueTokens: number
    totalOpenCostBasisUsd: number | null
    totalCurrentValueUsd: number | null
    totalUnrealizedPnlUsd: number | null
    totalUnrealizedPnlPercent: number | null
    allTokensMatched: boolean
    matchedTokenCount: number
    unmatchedTokenCount: number
    matchedOpenCostBasisUsd: number | null
    matchedCurrentOpenValueUsd: number | null
    matchedUnrealizedPnlUsd: number | null
    matchedUnrealizedPnlPercent: number | null
    coverageLabel: 'full' | 'partial' | 'cost_basis_only'
    unmatchedSymbols: string[]
    tokens: Array<{
      symbol: string; chain: string; openLots: number
      amountRemaining: number
      avgEntryPriceUsd: number | null
      currentPriceUsd: number | null
      currentValueUsd: number | null
      costBasisUsd: number
      unrealizedPnlUsd: number | null
      unrealizedPnlPercent: number | null
    }>
  } | null
  walletFacts?: {
    status: 'ok' | 'partial' | 'open_check'
    summary: {
      totalValueUsd: number
      holdingsCount: number
      chainExposure: Array<{ chain: string; valueUsd: number; percent: number }>
      topHoldings: Array<{ symbol: string; chain: string; valueUsd: number; percent: number }>
      largestHolding: string | null
      concentrationLabel: 'high' | 'medium' | 'balanced' | 'none'
      stablecoinExposurePercent: number
      nativeExposurePercent: number
    }
    activity: {
      eventCount: number
      groupedTxCount: number
      walletInitiatedTxCount: number
      inboundCount: number
      outboundCount: number
      unknownCount: number
      firstSeenAt: string | null
      lastSeenAt: string | null
      recentActivityWindowDays: number | null
      latestEvents: Array<{
        timestamp: string
        txHash: string
        direction: string
        symbol: string
        chain: string
        amount: number
        valueUsdKnown: boolean
        counterparty: string | null
      }>
    }
    flowRead: {
      receivedTokens: Array<{ symbol: string; count: number; totalAmountApprox: number; latestAt: string | null }>
      sentTokens: Array<{ symbol: string; count: number; totalAmountApprox: number; latestAt: string | null }>
      topCounterparties: Array<{ address: string; direction: string; count: number; latestAt: string | null }>
      accumulationSignals: string[]
      distributionSignals: string[]
    }
    sourceClassification: {
      swapLikeTxs: number
      transferOnlyTxs: number
      claimOrAirdropLikeTxs: number
      bridgeLikeTxs: number
      unknownTxs: number
      notes: string[]
    }
    limits: {
      sampleBased: boolean
      maxEventsUsed: number
      noClosedLotPnL: boolean
      reason: string
    }
  }
  walletActivityCoverageNote?: string | null
  _debug?: {
    basePnlReconstructionDebug?: {
      sampleUnpricedAfterReceipt?: Array<{ txHash: string; symbol: string; finalReason: string }>
    } | null
  }
}

// ── Formatters ───────────────────────────────────────────────────────────────────────────

function unpricedReasonLabel(finalReason: string): string {
  if (finalReason === 'receipt_checked_no_counter_asset') return 'No quote asset found in checked receipt'
  if (finalReason === 'receipt_checked_no_quote_leg') return 'No quote leg found'
  if (finalReason === 'receipt_checked_no_native_value') return 'No native ETH payment found'
  if (finalReason === 'receipt_checked_no_wallet_quote_transfer') return 'No wallet-side quote transfer found'
  if (/^\d+_swap_candidates_unpriced$/.test(finalReason)) return 'Swap candidates unpriced'
  return finalReason.replace(/_/g, ' ')
}

function fmtUSD(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(2)}K`
  return `$${v.toFixed(2)}`
}

function fmtSignedUSD(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return 'Open Check'
  return `${v >= 0 ? '+' : '-'}${fmtUSD(Math.abs(v))}`
}


function hasActivityProviderUnavailable(data: WalletResult): boolean {
  const status = data.walletEvidenceSummary?.status
  const missing = data.walletEvidenceSummary?.missing ?? []
  return (status === 'provider_unavailable' || status === 'open_check') && missing.includes('activity_provider_unavailable')
}

const ACTIVITY_UNAVAILABLE_COPY = 'Activity history unavailable from current checks. ChainLens did not calculate PnL for this wallet.'

function fmtOpenPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return 'Open Check'
  return `${v.toFixed(1)}%`
}

function safeNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function closedTradeSamplePnlStats(data: WalletResult, side: 'win' | 'loss'): { average: number; count: number } | null {
  const samples = data.walletClosedTradeSamples ?? []
  const pnls = samples
    .map(s => safeNum(s.realizedPnlUsd))
    .filter((pnl): pnl is number => pnl !== null && (side === 'win' ? pnl > 0 : pnl < 0))
  if (pnls.length === 0) return null
  return { average: pnls.reduce((sum, pnl) => sum + pnl, 0) / pnls.length, count: pnls.length }
}

function deriveAverageMatchedLossUsd(data: WalletResult): number | null {
  const ts = data.walletTradeStatsSummary
  if (!ts || ts.losingClosedLots <= 0) return null

  const sampleStats = closedTradeSamplePnlStats(data, 'loss')
  if (sampleStats !== null && sampleStats.count === ts.losingClosedLots) return sampleStats.average

  const avgPnlPerClosedLot = safeNum(ts.avgPnlUsdPerClosedLot)
  if (ts.losingClosedLots === ts.closedLots && avgPnlPerClosedLot !== null && avgPnlPerClosedLot < 0) {
    return avgPnlPerClosedLot
  }

  const backendAvgLoss = safeNum(data.walletIntelligence?.pnl?.avgLoss)
  return backendAvgLoss !== null && backendAvgLoss < 0 ? backendAvgLoss : null
}

function deriveAverageMatchedWinUsd(data: WalletResult): number | null {
  const ts = data.walletTradeStatsSummary
  if (!ts || ts.winningClosedLots <= 0) return null

  const sampleStats = closedTradeSamplePnlStats(data, 'win')
  if (sampleStats !== null && sampleStats.count === ts.winningClosedLots) return sampleStats.average

  const avgPnlPerClosedLot = safeNum(ts.avgPnlUsdPerClosedLot)
  if (ts.winningClosedLots === ts.closedLots && avgPnlPerClosedLot !== null && avgPnlPerClosedLot > 0) {
    return avgPnlPerClosedLot
  }

  const backendAvgWin = safeNum(data.walletIntelligence?.pnl?.avgWin)
  return backendAvgWin !== null && backendAvgWin > 0 ? backendAvgWin : null
}


function isTradeStatsGradeable(ts: WalletResult['walletTradeStatsSummary'] | undefined): boolean {
  return Boolean(
    ts &&
    ts.closedLots >= 10 &&
    ts.economicSignificance === 'meaningful' &&
    ts.confidence !== 'low' &&
    ts.confidence !== 'open_check' &&
    ts.readyForWalletScore
  )
}

function isMicroSampleLocked(ts: WalletResult['walletTradeStatsSummary'] | undefined): boolean {
  return Boolean(
    ts &&
    ts.closedLots >= 10 &&
    (ts.economicSignificance === 'micro_sample' || ts.confidence === 'low' || !ts.readyForWalletScore)
  )
}

function officialWinRateLockCopy(ts: WalletResult['walletTradeStatsSummary'] | undefined): string {
  if (!ts || ts.closedLots === 0) return 'Requires closed-lot evidence.'
  if (ts.closedLots < 10) return `Raw rate from ${ts.closedLots} closed lot${ts.closedLots !== 1 ? 's' : ''} — official rate unlocks at 10+.`
  if (isMicroSampleLocked(ts)) return 'Matched sample is too small financially to grade.'
  return 'Requires gradeable matched closed-lot evidence.'
}

function walletScoreLockCopy(ts: WalletResult['walletTradeStatsSummary'] | undefined): string {
  if (!ts || ts.closedLots === 0) return 'Needs closed lot evidence to score.'
  if (ts.closedLots < 10) return 'Score not calculated until 10+ verified closed lots.'
  if (isMicroSampleLocked(ts)) return 'Matched sample is too small financially to grade.'
  return 'Score not calculated until matched evidence passes wallet-score gates.'
}

function normalizeChainName(chain: string | null | undefined): string | null {
  if (!chain) return null
  const c = chain.toLowerCase().replace(/-mainnet$/, '')
  if (c === 'base') return 'base'
  if (c === 'ethereum' || c === 'eth') return 'ethereum'
  return c
}

function chainHoldingsScope(chains: string[]): string {
  const normalized = Array.from(new Set(chains.map(c => normalizeChainName(c)).filter((c): c is string => Boolean(c))))
  if (normalized.length === 1 && normalized[0] === 'base') return 'Base holdings'
  if (normalized.length === 1 && normalized[0] === 'ethereum') return 'Ethereum holdings'
  if (normalized.length === 2 && normalized.includes('base') && normalized.includes('ethereum')) return 'Base and Ethereum holdings'
  return normalized.length > 1 ? 'multi-chain holdings' : 'Visible holdings'
}

function fmtSecondsToHuman(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null
  const h = Math.floor(seconds / 3600)
  const d = Math.floor(h / 24)
  if (d >= 1) return `${d}d ${h % 24}h`
  if (h >= 1) return `${h}h ${Math.floor((seconds % 3600) / 60)}m`
  return `${Math.floor(seconds / 60)}m`
}

function deriveWalletTier(winRate: number | null, closedCount = 0): WalletTier {
  if (winRate === null || !Number.isFinite(winRate) || closedCount < 10) return 'Open Check'
  if (winRate >= 65) return 'Smart Money'
  if (winRate >= 40) return 'Average Trader'
  return 'Losing Wallet'
}

function deriveTradeBehavior(data: WalletResult): WalletIntelligence['tradeBehavior'] & { winRate: number | null; lossRate: number | null; avgWin: number | null; avgLoss: number | null; biggestWin: number | null; biggestLoss: number | null } {
  const ts = data.walletTradeStatsSummary
  const backend = data.walletIntelligence
  const recentClosed = backend?.recentTrades?.filter(t => t.status === 'closed' && safeNum(t.pnl) !== null) ?? []
  const closedTrades = ts ? ts.closedLots : (backend?.tradeBehavior?.closedTrades ?? recentClosed.length)
  const hasEnoughClosedTrades = ts ? isTradeStatsGradeable(ts) : closedTrades >= 10
  const winRate = hasEnoughClosedTrades ? (ts?.winRatePercent ?? safeNum(backend?.winRate)) : null
  const lossRate = hasEnoughClosedTrades && ts
    ? (ts.closedLots > 0 ? (ts.losingClosedLots / ts.closedLots) * 100 : null)
    : (hasEnoughClosedTrades ? safeNum(backend?.lossRate) : null)
  const avgHoldTime = ts?.avgHoldingTimeSeconds != null
    ? fmtSecondsToHuman(ts.avgHoldingTimeSeconds)
    : (backend?.tradeBehavior?.avgHoldTime ?? null)
  return {
    closedTrades,
    avgHoldTime,
    reason: hasEnoughClosedTrades
      ? 'Closed lots reconstructed from indexed entry and exit evidence.'
      : closedTrades > 0
        ? `${closedTrades} lots reconstructed — 10+ needed for full stats.`
        : 'No reconstructed closed lots yet.',
    winRate,
    lossRate,
    avgWin: deriveAverageMatchedWinUsd(data) ?? safeNum(backend?.pnl?.avgWin),
    avgLoss: deriveAverageMatchedLossUsd(data),
    biggestWin: hasEnoughClosedTrades ? (ts?.largestWinUsd ?? safeNum(backend?.pnl?.biggestWin)) : null,
    biggestLoss: hasEnoughClosedTrades ? (ts?.largestLossUsd ?? safeNum(backend?.pnl?.biggestLoss)) : null,
  }
}

function derivePnlOverview(data: WalletResult): WalletIntelligence['pnl'] {
  const backend = data.walletIntelligence?.pnl
  const estimated = data.estimatedPnl
  const ls = data.walletLotSummary
  const ts = data.walletTradeStatsSummary
  const hasClosedLotEvidence = (ls?.closedLots ?? ts?.closedLots ?? 0) > 0
  // Require real token coverage — ignore estimatedPnl with 0 tokens or 0 coverage
  const estimatedUsable = (estimated?.status === 'ok' || estimated?.status === 'partial')
    && (estimated?.tokens?.length ?? 0) > 0
    && (estimated?.coveragePercent ?? 0) > 0
  const pnlEvidenceReady = hasClosedLotEvidence || estimatedUsable
  // No closed lots + null realized PnL → force total/realized/unrealized open check
  const noLotsNullPnl = (ts?.closedLots ?? 0) === 0 && (ls?.realizedPnlUsd ?? null) === null
  const coreReady = pnlEvidenceReady && !noLotsNullPnl
  return {
    total:      coreReady ? (safeNum(backend?.total)      ?? (estimatedUsable ? safeNum(estimated?.totalEstimatedPnlUsd) : null)) : null,
    sevenDay:   pnlEvidenceReady ? safeNum(backend?.sevenDay)    : null,
    thirtyDay:  pnlEvidenceReady ? safeNum(backend?.thirtyDay)   : null,
    thisMonth:  pnlEvidenceReady ? safeNum(backend?.thisMonth)   : null,
    realized:   coreReady ? (safeNum(backend?.realized)   ?? (estimatedUsable ? safeNum(estimated?.realizedPnlUsd)       : null)) : null,
    unrealized: coreReady ? (safeNum(backend?.unrealized) ?? (estimatedUsable ? safeNum(estimated?.unrealizedPnlUsd)     : null)) : null,
    biggestWin: pnlEvidenceReady ? safeNum(backend?.biggestWin)  : null,
    biggestLoss:pnlEvidenceReady ? safeNum(backend?.biggestLoss) : null,
    avgWin:     pnlEvidenceReady ? safeNum(backend?.avgWin)      : null,
    avgLoss:    pnlEvidenceReady ? safeNum(backend?.avgLoss)     : null,
  }
}

function deriveWalletScore(data: WalletResult): { score: number | null; scoreStatus: 'ok' | 'open_check'; confidence: WalletConfidence } {
  const behavior = deriveTradeBehavior(data)
  const winRate = behavior.winRate
  const avgWin = behavior.avgWin
  const avgLoss = behavior.avgLoss
  const thirtyDay = derivePnlOverview(data).thirtyDay
  if (behavior.closedTrades < 10 || winRate === null || avgWin === null || avgLoss === null || thirtyDay === null) {
    return { score: null, scoreStatus: 'open_check', confidence: 'open check' }
  }

  const confidenceBoost = Math.min(20, behavior.closedTrades * 2)
  const payoffRatio = Math.max(0, Math.min(25, avgLoss === 0 ? 25 : (avgWin / Math.abs(avgLoss)) * 12.5))
  const trendScore = thirtyDay > 0 ? 15 : thirtyDay < 0 ? 0 : 7
  const score = Math.max(0, Math.min(100, Math.round(winRate * 0.4 + payoffRatio + trendScore + confidenceBoost)))
  const confidence: WalletConfidence = behavior.closedTrades >= 20 ? 'high' : behavior.closedTrades >= 8 ? 'medium' : 'low'
  return { score, scoreStatus: 'ok', confidence }
}

function buildWalletOpenCheck(data: WalletResult): string[] {
  const checks: string[] = []
  const estimated = data.estimatedPnl
  const ts = data.walletTradeStatsSummary
  const hasEstimatedPnl = estimated?.status === 'ok' || estimated?.status === 'partial'
  const openedLots = ts?.openedLots ?? data.walletLotSummary?.openedLots ?? 0
  const closedLots = ts?.closedLots ?? 0
  const openPos = data.walletModuleCoverage?.walletOpenPositionSummary ?? data.walletOpenPositionSummary ?? null
  const hasOpenPosition = openedLots > 0 && closedLots === 0
  if (!hasEstimatedPnl && (!ts || closedLots === 0) && !hasOpenPosition) {
    checks.push(hasActivityProviderUnavailable(data)
      ? ACTIVITY_UNAVAILABLE_COPY
      : 'PnL remains Open Check until indexed transfer history has enough cost-basis coverage.')
  }
  if (ts && closedLots > 0 && !isTradeStatsGradeable(ts)) {
    checks.push(isMicroSampleLocked(ts) ? 'Wallet score locked — matched sample is too small financially to grade.' : 'Wallet score locked — sample below 10 closed lots.')
  } else if (hasOpenPosition) {
    checks.push('Open entries tracked — realized stats unlock after sell exits.')
    const uniqueTokens = openPos?.uniqueTokens ?? 0
    if (openedLots > 0 && uniqueTokens > 0) {
      checks.push(`${openedLots} open lot${openedLots !== 1 ? 's' : ''} across ${uniqueTokens} token${uniqueTokens !== 1 ? 's' : ''}`)
    }
  } else if (!ts || closedLots === 0) {
    checks.push('Win rate requires matched closed lots with priced entry and exit evidence.')
  }
  checks.push('Recent trade rows require matched entries, exits, and price evidence.')
  if (!data.walletBehavior || data.walletBehavior.status === 'unavailable') checks.push('Activity behavior is limited for the currently checked chain window.')
  return Array.from(new Set([...(data.walletIntelligence?.openChecks ?? []), ...checks])).slice(0, 4)
}

function deriveWalletPersonality(data: WalletResult): string {
  if (data.walletIntelligence?.personalitySummary) return data.walletIntelligence.personalitySummary
  const behavior = deriveTradeBehavior(data)
  const pnl = derivePnlOverview(data)
  const ts = data.walletTradeStatsSummary
  const holdingCount = data.holdings.length
  const activity = data.walletBehavior

  // Open-position branch: has priced open lots but no closed lots yet
  const openedLots = ts?.openedLots ?? data.walletLotSummary?.openedLots ?? 0
  const closedLots = ts?.closedLots ?? 0
  const openPos = data.walletModuleCoverage?.walletOpenPositionSummary ?? data.walletOpenPositionSummary ?? null
  if (openedLots > 0 && closedLots === 0) {
    const openLots = openPos?.openLots ?? openedLots
    const uniqueTokens = openPos?.uniqueTokens ?? 0
    const tokenStr = uniqueTokens > 0 ? `${uniqueTokens} token${uniqueTokens !== 1 ? 's' : ''}` : 'tracked tokens'
    return `This wallet shows ${holdingCount} visible holding${holdingCount !== 1 ? 's' : ''} and ${openLots} tracked open entry lot${openLots !== 1 ? 's' : ''} across ${tokenStr}. CORTEX found priced swap evidence and can read active exposure, but no sell exits have closed yet. Realized PnL, win rate, and wallet score unlock once matched closed lots are detected.`
  }

  const sentences: string[] = []
  if (holdingCount > 0) {
    sentences.push(`This wallet currently shows ${holdingCount} visible token holding${holdingCount === 1 ? '' : 's'}, so the scanner can describe portfolio exposure but not trading skill by balance alone.`)
  } else {
    sentences.push('This wallet has no visible priced holdings in the checked window, so classification remains limited.')
  }
  if (ts && ts.closedLots > 0 && ts.realizedPnlUsd !== null) {
    sentences.push(`Real trade evidence: ${ts.closedLots} closed lots reconstructed with ${fmtSignedUSD(ts.realizedPnlUsd)} realized PnL from priced FIFO lots.`)
  } else if (pnl.total !== null) {
    sentences.push('Indexed transfer history provides an estimated PnL signal, but it is not treated as a win-rate label without reconstructed closed lots.')
  } else {
    sentences.push(hasActivityProviderUnavailable(data)
      ? 'Activity source did not return usable history. No PnL was calculated.'
      : 'PnL remains Open Check because sufficient transaction, swap, balance, and price evidence was not available in the current scan.')
  }
  if (ts && ts.closedLots > 0 && ts.closedLots < 10) {
    const _beNote = ts.breakEvenClosedLots > 0 ? `, ${ts.breakEvenClosedLots} break-even` : ''
    sentences.push(`Matched closed-lot sample shows ${ts.winningClosedLots} positive lot${ts.winningClosedLots !== 1 ? 's' : ''}${_beNote} and ${ts.losingClosedLots === 0 ? 'no matched losing closed lots' : `${ts.losingClosedLots} matched losing closed lot${ts.losingClosedLots !== 1 ? 's' : ''}`}. This is not a full wallet win rate. Official win rate is not calculated until 10+ verified closed lots.`)
  } else if (ts && ts.closedLots >= 10 && ts.winRatePercent === null) {
    const _beNote = ts.breakEvenClosedLots > 0 ? `, ${ts.breakEvenClosedLots} break-even` : ''
    sentences.push(`Matched closed-lot sample shows ${ts.winningClosedLots} positive lot${ts.winningClosedLots !== 1 ? 's' : ''}${_beNote} and ${ts.losingClosedLots} losing lots across ${ts.closedLots} reconstructed lots. Win rate is not calculated — the matched sample did not meet economic quality gates.`)
  } else if (!ts || ts.closedLots === 0) {
    if (behavior.closedTrades < 10) {
      sentences.push('Not enough closed lots have been reconstructed to classify trading skill yet.')
    }
    if (activity?.status === 'ok' && (activity.txCount ?? 0) > 0) {
      sentences.push('Recent activity exists on the checked chain, but entries and exits still need to be matched before score, tier, or win rate can be shown.')
    } else {
      sentences.push('Activity evidence is limited, so this read stays conservative and avoids copy-trading claims.')
    }
  }
  return sentences.slice(0, 4).join(' ')
}

function derivePortfolioIntelligence(data: WalletResult) {
  const holdings = [...data.holdings].sort((a, b) => b.value - a.value)
  const totalValue = data.totalValue > 0 ? data.totalValue : holdings.reduce((sum, h) => sum + (Number.isFinite(h.value) ? h.value : 0), 0)
  const top3 = holdings.slice(0, 3)
  const topHolding = holdings[0] ?? null
  const topShare = totalValue > 0 && topHolding ? (topHolding.value / totalValue) * 100 : null
  const top3Share = totalValue > 0 ? (top3.reduce((sum, h) => sum + h.value, 0) / totalValue) * 100 : null
  const concentration: 'high' | 'medium' | 'balanced' | null = topShare === null ? null : topShare >= 50 ? 'high' : topShare >= 25 ? 'medium' : 'balanced'
  const chainSet = new Set<string>()
  for (const h of holdings) {
    if (h.chain) {
      const c = normalizeChainName(h.chain)
      if (c === 'base') chainSet.add('base')
      else if (c === 'ethereum') chainSet.add('ethereum')
      else if (c) chainSet.add(c)
    }
  }
  const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'BUSD', 'FRAX', 'LUSD', 'USDC.E', 'USDBC'])
  const stableValue = holdings.filter(h => STABLE_SYMBOLS.has(h.symbol.toUpperCase())).reduce((s, h) => s + h.value, 0)
  const stablePercent = totalValue > 0 ? (stableValue / totalValue) * 100 : 0
  const ETH_SYMBOLS = new Set(['ETH', 'WETH'])
  const ethValue = holdings.filter(h => ETH_SYMBOLS.has(h.symbol.toUpperCase())).reduce((s, h) => s + h.value, 0)
  const ethPercent = totalValue > 0 ? (ethValue / totalValue) * 100 : 0
  let portfolioType: string
  if (holdings.length === 0) portfolioType = 'No visible holdings'
  else if (ethPercent >= 50) portfolioType = 'ETH-heavy wallet'
  else if (stablePercent >= 50) portfolioType = 'Stablecoin-heavy wallet'
  else if (topShare !== null && topShare >= 50) portfolioType = 'Concentrated portfolio'
  else if (holdings.length >= 3) portfolioType = 'Multi-token portfolio'
  else portfolioType = 'Small visible portfolio'
  const chains = [...chainSet]
  return { totalValue, top3, topHolding, topShare, top3Share, concentration, chains, holdingsScope: chainHoldingsScope(chains), stablePercent, ethPercent, portfolioType, holdingsCount: holdings.length }
}

function buildWalletIntelligence(data: WalletResult): WalletIntelligence {
  const tradeBehavior = deriveTradeBehavior(data)
  const pnl = derivePnlOverview(data)
  const score = deriveWalletScore(data)
  const walletTier = data.walletIntelligence?.walletTier ?? deriveWalletTier(tradeBehavior.winRate, tradeBehavior.closedTrades)
  return {
    status: score.scoreStatus === 'ok' ? 'ok' : 'open_check',
    confidence: score.confidence,
    walletScore: score.score,
    walletTier,
    winRate: tradeBehavior.winRate,
    lossRate: tradeBehavior.lossRate,
    pnl,
    tradeBehavior,
    personalitySummary: deriveWalletPersonality(data),
    recentTrades: data.walletIntelligence?.recentTrades ?? [],
    openChecks: buildWalletOpenCheck(data),
  }
}

function fmtBalance(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000)     return `${(v / 1_000).toFixed(2)}K`
  if (v < 0.0001)     return v.toExponential(2)
  if (v < 1)          return v.toFixed(4)
  return v.toFixed(2)
}

function fmtPct(v: number | null): string {
  if (v === null) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

// ── Clark verdict parser ──────────────────────────────────────────────────────────────────────────

type ClarkVerdictCard = {
  verdict: 'AVOID' | 'WATCH' | 'SCAN DEEPER' | 'TRUSTWORTHY' | 'UNKNOWN'
  confidence: 'Low' | 'Medium' | 'High'
  read: string
  keySignals: string[]
  risks: string[]
  nextAction: string
}

const FALLBACK_VERDICT: ClarkVerdictCard = {
  verdict: 'SCAN DEEPER',
  confidence: 'Low',
  read: 'Wallet balances loaded, but Clark could not complete the AI verdict right now.',
  keySignals: [
    'Wallet balances were retrieved',
    'Token holdings are visible',
    'Portfolio value is available if real',
  ],
  risks: [
    'AI verdict not ready in current checks',
    'Transaction behavior not fully summarized',
    'Manual review recommended',
  ],
  nextAction: 'Review holdings now, then rerun Clark analysis in a moment.',
}

function extractSection(text: string, header: string): string {
  const m = text.match(new RegExp(`${header}\\s*:\\s*([\\s\\S]*?)(?:\\n(?:Asset|Verdict|Confidence|Read|Key signals|Risks|Next action)\\s*:|$)`, 'i'))
  return (m?.[1] ?? '').trim()
}

function parseStructuredClark(text: string): ClarkVerdictCard | null {
  const verdict = text.match(/\bVerdict:\s*(AVOID|WATCH|SCAN DEEPER|TRUSTWORTHY|UNKNOWN)\b/i)?.[1]?.toUpperCase() as ClarkVerdictCard['verdict'] | undefined
  const confidence = text.match(/\bConfidence:\s*(Low|Medium|High)\b/i)?.[1] as ClarkVerdictCard['confidence'] | undefined
  if (!verdict || !confidence) return null
  const read = extractSection(text, 'Read') || 'Not enough verified data to make a strong call.'
  const bulletify = (content: string, fallback: string[]) => {
    const rows = content
      .split(/\n|•|-/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 3)
    return rows.length > 0 ? rows : fallback
  }
  return {
    verdict,
    confidence,
    read,
    keySignals: bulletify(extractSection(text, 'Key signals'), FALLBACK_VERDICT.keySignals),
    risks: bulletify(extractSection(text, 'Risks'), FALLBACK_VERDICT.risks),
    nextAction: extractSection(text, 'Next action') || FALLBACK_VERDICT.nextAction,
  }
}

// ── Loading dots ──────────────────────────────────────────────────────────────────────────────

function ClarkDots() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '4px 0' }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          width: '6px', height: '6px', borderRadius: '50%', background: '#2DD4BF',
          display: 'inline-block',
          animation: 'clarkDot 1.1s ease-in-out infinite',
          animationDelay: `${i * 0.18}s`,
        }} />
      ))}
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────────────────

export default function WalletScannerPage() {
  const { plan, loading: planLoading, betaEliteActive } = usePlanWithLoading()
  const [input, setInput]               = useState('')
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [result, setResult]             = useState<WalletResult | null>(null)
  const [showAllHoldings, setShowAllHoldings] = useState(false)
  const [deepActivity, setDeepActivity] = useState(false)
  const clarkLoading = loading

  async function handleScan() {
    const q = input.trim()
    if (!q) return
    setLoading(true)
    setError(null)
    setResult(null)
    setShowAllHoldings(false)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const canDebug = deepActivity && (plan === 'pro' || plan === 'elite' || betaEliteActive || process.env.NODE_ENV !== 'production')
      const res  = await fetch(canDebug ? '/api/wallet?debug=true' : '/api/wallet', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ address: q, ...(deepActivity ? { deepActivity: true } : {}) }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Scan failed')
      setResult(json)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Scan failed')
    } finally {
      setLoading(false)
    }
  }

  function dataQualityForWallet(data: WalletResult): string {
    const hasPortfolio = data.holdings.length > 0 || data.totalValue > 0
    return hasPortfolio ? 'Release view' : 'No signal in checked window'
  }


  function getCortexRead(data: WalletResult): { summary: string; bullets: string[]; tradeBullet: string | null; earlyWinBullet: string | null; caveat: string } {
    if (!data || data.holdings.length === 0) {
      return {
        summary: 'Scan a wallet to generate a CORTEX wallet read.',
        bullets: [],
        tradeBullet: null,
        earlyWinBullet: null,
        caveat: '',
      }
    }
    const sorted = [...data.holdings].sort((a, b) => b.value - a.value)
    const total = data.totalValue > 0 ? data.totalValue : sorted.reduce((acc, h) => acc + (Number.isFinite(h.value) ? h.value : 0), 0)
    const top = sorted.slice(0, 3)
    const topShare = total > 0 ? (top.reduce((acc, h) => acc + h.value, 0) / total) * 100 : null
    const concentration = topShare === null ? 'Unverified' : topShare >= 70 ? 'High concentration' : topShare >= 40 ? 'Balanced concentration' : 'Diversified spread'
    const activityOk = data.walletBehavior?.status === 'ok' && (data.walletBehavior.txCount ?? 0) > 0
    const wf = data.walletFacts
    const wfActivity = wf?.activity
    const wfActivityMsg = wfActivity && wfActivity.eventCount > 0
      ? `${wfActivity.eventCount} indexed transfer events across ${wfActivity.groupedTxCount} tx groups — ${wfActivity.walletInitiatedTxCount} wallet-initiated.`
      : null
    const activityMsg = wfActivityMsg ?? (activityOk
      ? 'Activity detected in checked Base window.'
      : hasActivityProviderUnavailable(data)
        ? ACTIVITY_UNAVAILABLE_COPY
        : data.walletBehavior?.status === 'ok'
          ? 'No recent Base activity in checked window.'
          : 'Activity signal is limited in current checks.')
    const ts = data.walletTradeStatsSummary
    const tradeBullet = ts && ts.closedLots > 0 && ts.realizedPnlUsd !== null
      ? `Real trade evidence: ${ts.closedLots} closed lots reconstructed, ${fmtSignedUSD(ts.realizedPnlUsd)} realized PnL from priced FIFO lots.`
      : null
    const earlyWinBullet = ts && ts.closedLots > 0
      ? `Matched closed-lot sample: ${ts.winningClosedLots} positive lot${ts.winningClosedLots !== 1 ? 's' : ''}${ts.breakEvenClosedLots > 0 ? `, ${ts.breakEvenClosedLots} break-even` : ''} and ${ts.losingClosedLots === 0 ? 'no matched losing closed lots' : `${ts.losingClosedLots} matched losing closed lot${ts.losingClosedLots !== 1 ? 's' : ''}`}. Official win rate is not calculated until 10+ verified closed lots.`
      : null
    const bullets = [
      total > 0 ? `Portfolio value observed: ${fmtUSD(total)}` : 'Portfolio value: Unverified',
      top.length > 0 ? `Top holdings: ${top.map(h => h.symbol || h.name).filter(Boolean).join(', ')}` : 'Top holdings: Unverified',
      `Concentration read: ${concentration}`,
      ...(activityOk ? [activityMsg] : []),
      ...(ts && ts.closedLots > 0 ? [`Coverage: trade stats are based on ${ts.closedLots} matched closed lots only; current holdings remain separate.`] : []),
    ]
    const caveat = tradeBullet
      ? (!activityOk ? activityMsg : '')
      : (!activityOk ? activityMsg : (data.totalValue <= 0 ? 'Some holdings are unpriced or still being verified.' : ''))
    return {
      summary: tradeBullet
        ? 'CORTEX verified holdings and reconstructed real trade evidence from priced FIFO lots.'
        : 'CORTEX can read verified holdings, but deeper behavior data is still forming.',
      bullets,
      tradeBullet,
      earlyWinBullet,
      caveat: data.totalValue <= 0 && !tradeBullet ? 'Some holdings are unpriced or still being verified.' : caveat,
    }
  }

  function buildWalletVerdict(data: WalletResult): ClarkVerdict {
    const sorted = [...data.holdings].sort((a, b) => b.value - a.value)
    const total = data.totalValue > 0 ? data.totalValue : sorted.reduce((acc, h) => acc + (Number.isFinite(h.value) ? h.value : 0), 0)
    const largest = sorted[0] ?? null
    const top3 = sorted.slice(0, 3)
    const largestShare = total > 0 && largest ? (largest.value / total) * 100 : null
    const topShare = total > 0 ? (top3.reduce((acc, h) => acc + h.value, 0) / total) * 100 : null
    const baseTx = data.walletBehavior?.txCount ?? 0
    const hasActivity = data.walletBehavior?.status === 'ok' && baseTx > 0
    const ts = data.walletTradeStatsSummary
    const hasRealTrade = ts && ts.closedLots > 0
    const verdict = sorted.length === 0 ? 'INCOMPLETE READ' : hasActivity ? 'ACTIVE WALLET' : 'WATCH'
    const keySignals: string[] = [
      `Portfolio read: ${total > 0 ? fmtUSD(total) : 'unverified value'} across ${sorted.length} tracked token${sorted.length === 1 ? '' : 's'}.`,
      hasActivity ? 'Activity read: Recent Base activity detected in the checked window.' : hasActivityProviderUnavailable(data) ? `Activity read: ${ACTIVITY_UNAVAILABLE_COPY}` : 'Activity read: Recent Base activity is limited in the checked window.',
      `Risk / concentration: ${largest ? `${largest.symbol || 'Top asset'} is the largest visible holding${largestShare != null ? ` (${largestShare.toFixed(1)}% of visible portfolio)` : ''}${topShare != null ? `; top 3 holdings make up ${topShare.toFixed(1)}% of visible portfolio value` : ''}.` : 'Largest holding remains unverified.'}`,
      ...(hasRealTrade && ts.realizedPnlUsd !== null
        ? [`Real trade evidence: ${ts.closedLots} closed lots, ${fmtSignedUSD(ts.realizedPnlUsd)} matched realized PnL. Matched closed-lot sample: ${ts.winningClosedLots} positive lot${ts.winningClosedLots !== 1 ? 's' : ''}${ts.breakEvenClosedLots > 0 ? `, ${ts.breakEvenClosedLots} break-even` : ''}, ${ts.losingClosedLots === 0 ? 'no matched losing lots' : `${ts.losingClosedLots} matched losing lot${ts.losingClosedLots !== 1 ? 's' : ''}`}.`]
        : hasRealTrade
          ? [`Matched closed-lot sample: ${ts.winningClosedLots} positive lot${ts.winningClosedLots !== 1 ? 's' : ''}${ts.breakEvenClosedLots > 0 ? `, ${ts.breakEvenClosedLots} break-even` : ''} and ${ts.losingClosedLots === 0 ? 'no matched losing closed lots' : `${ts.losingClosedLots} matched losing lot${ts.losingClosedLots !== 1 ? 's' : ''}`} across ${ts.closedLots} reconstructed lots.`]
          : []),
    ]
    const risks = hasRealTrade
      ? [
          isTradeStatsGradeable(ts) ? 'Win rate from matched closed lots only.' : officialWinRateLockCopy(ts),
          walletScoreLockCopy(ts),
          'Some buys and sells may sit outside the indexed scan window.',
        ]
      : [
          hasActivityProviderUnavailable(data) ? ACTIVITY_UNAVAILABLE_COPY : 'PnL is not verified from this scan.',
          'Win rate and wallet intent are not verified.',
          'Entries and exits timing are not verified.',
        ]
    return {
      verdict,
      confidence: hasActivity ? 'Medium' : 'Low',
      read: total > 0
        ? `CORTEX verified visible holdings and estimated portfolio value from ${chainHoldingsScope(sorted.map(h => h.chain ?? '').filter(Boolean))}.`
        : 'CORTEX found visible holdings, but value is incomplete or unverified in current checks.',
      keySignals,
      risks,
      nextAction: 'Monitor entries/exits and run token scans on major holdings. No trade call.',
    }
  }

  const clarkVerdict = result ? buildWalletVerdict(result) : null
  const clarkError = !loading && error ? 'Wallet read could not be completed. Check the address and try again.' : null

  if (planLoading) return <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>Loading plan access…</div>
  if (!betaEliteActive && !canAccessFeature(plan, 'wallet-scanner')) return <LockedPanel feature="wallet-scanner" />

  return (
    <>
      <style>{`
        @keyframes clarkDot {
          0%,60%,100% { transform:translateY(0);  opacity:0.35; }
          30%          { transform:translateY(-5px); opacity:1; }
        }
        @keyframes clarkPulse {
          0%,100% { opacity:1; box-shadow:0 0 8px rgba(45,212,191,0.80); }
          50%      { opacity:0.4; box-shadow:0 0 3px rgba(45,212,191,0.25); }
        }
        @keyframes shimmer {
          0%   { background-position: -400px 0; }
          100% { background-position: 400px 0; }
        }
        @keyframes scanLine {
          0%   { transform: translateY(-100%); opacity: 0; }
          10%  { opacity: 0.6; }
          90%  { opacity: 0.6; }
          100% { transform: translateY(100vh); opacity: 0; }
        }
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes glowPulse {
          0%,100% { box-shadow: 0 0 20px rgba(45,212,191,0.08); }
          50%      { box-shadow: 0 0 32px rgba(45,212,191,0.18); }
        }
        .ws-row:hover { background: rgba(255,255,255,0.030) !important; }
        .ws-scan-btn:hover:not(:disabled) {
          background: linear-gradient(135deg, #2DD4BF, #22c5ae) !important;
          box-shadow: 0 0 28px rgba(45,212,191,0.50), 0 4px 16px rgba(0,0,0,0.30) !important;
          transform: translateY(-1px);
        }
        .ws-scan-btn { transition: background 0.15s, box-shadow 0.18s, color 0.15s, transform 0.12s !important; }
        .ws-card-hover:hover { border-color: rgba(45,212,191,0.25) !important; box-shadow: 0 0 20px rgba(45,212,191,0.06) !important; transition: border-color 0.2s, box-shadow 0.2s; }
        .ws-result-fade { animation: fadeUp 0.3s ease both; }
        .ws-chip-hover:hover { background: rgba(45,212,191,0.14) !important; border-color: rgba(45,212,191,0.35) !important; color: #2DD4BF !important; transition: all 0.15s; }
        .ws-section-divider { height: 1px; background: linear-gradient(90deg, rgba(255,255,255,0.07) 0%, transparent 80%); margin: 4px 0; }
        .ws-stat-value { font-size: 22px; font-weight: 800; color: #e2e8f0; font-family: var(--font-inter, Inter, sans-serif); letter-spacing: -0.02em; line-height: 1.15; }
        .ws-stat-label { font-size: 9px; font-weight: 700; letter-spacing: 0.13em; text-transform: uppercase; color: rgba(255,255,255,0.28); font-family: var(--font-plex-mono, IBM Plex Mono, monospace); margin-bottom: 5px; }
        .ws-card { background: rgba(6,10,18,0.95); border: 1px solid rgba(255,255,255,0.07); border-radius: 16px; }
        .ws-card-teal { background: rgba(6,10,18,0.95); border: 1px solid rgba(45,212,191,0.14); border-radius: 16px; }
        .ws-card-purple { background: rgba(6,10,18,0.95); border: 1px solid rgba(139,92,246,0.18); border-radius: 16px; }
        .ws-section-header { font-size: 11px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; font-family: var(--font-plex-mono, IBM Plex Mono, monospace); }
        .ws-facts-flow-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        @media (max-width: 768px) {
          .wallet-main { padding: 52px 16px 100px !important; }
          .wallet-input-row { flex-direction: column; max-width: 100% !important; }
          .wallet-input-row button { width: 100%; justify-content: center; }
          .ws-stat-grid     { grid-template-columns: repeat(2, 1fr) !important; }
          .ws-behavior-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .wallet-intel-grid, .wallet-score-grid { grid-template-columns: 1fr !important; }
          .wallet-trade-table { overflow-x: auto !important; }
          .ws-val-52        { font-size: 36px !important; letter-spacing: -0.025em !important; }
          .ws-holdings-header { display: none !important; }
          .ws-holdings-row {
            display: flex !important; flex-wrap: wrap !important;
            padding: 12px 16px !important; gap: 6px 0 !important; align-items: center !important;
          }
          .ws-col-token { flex: 0 0 100% !important; padding-bottom: 8px !important; border-bottom: 1px solid rgba(255,255,255,0.05) !important; }
          .ws-col-balance, .ws-col-value, .ws-col-change {
            flex: 1 1 33% !important; text-align: left !important; font-size: 13px !important;
          }
          .ws-col-balance::before { content: "Balance"; display: block; font-size: 8px; color: rgba(255,255,255,0.25); font-family: var(--font-plex-mono, monospace); text-transform: uppercase; letter-spacing: 0.10em; margin-bottom: 2px; }
          .ws-col-value::before   { content: "Value";   display: block; font-size: 8px; color: rgba(255,255,255,0.25); font-family: var(--font-plex-mono, monospace); text-transform: uppercase; letter-spacing: 0.10em; margin-bottom: 2px; }
          .ws-col-change::before  { content: "24h";     display: block; font-size: 8px; color: rgba(255,255,255,0.25); font-family: var(--font-plex-mono, monospace); text-transform: uppercase; letter-spacing: 0.10em; margin-bottom: 2px; }
          .ws-facts-flow-grid { grid-template-columns: 1fr !important; }
          .ws-portfolio-grid { grid-template-columns: 1fr !important; }
          .ws-pi-bottom { flex-direction: column !important; }
        }
      `}</style>

      <div className="flex h-full overflow-hidden" style={{ color: '#e2e8f0' }}>

        {/* ── Left: scrollable main area ─────────────────────────────────── */}
        <div className="mob-scan-main wallet-main" style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', padding: '36px 40px 120px', background: 'radial-gradient(ellipse 80% 35% at 50% 0%, rgba(45,212,191,0.035) 0%, transparent 65%)' }}>

          {/* Header */}
          <div style={{ marginBottom: '36px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '12px' }}>
              <h1 style={{
                fontSize: '32px', fontWeight: 900, lineHeight: 1.05,
                margin: 0, fontFamily: 'var(--font-inter, Inter, sans-serif)',
                letterSpacing: '-0.03em',
                background: 'linear-gradient(135deg, #f1f5f9 0%, #94a3b8 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              }}>
                Wallet Scanner
              </h1>
              <span style={{
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
                padding: '4px 12px', borderRadius: '99px',
                background: 'linear-gradient(135deg, rgba(139,92,246,0.22), rgba(168,85,247,0.14))',
                border: '1px solid rgba(139,92,246,0.45)',
                color: '#c4b5fd',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                textTransform: 'uppercase', flexShrink: 0,
                boxShadow: '0 0 16px rgba(139,92,246,0.15)',
              }}>
                Elite
              </span>
            </div>
            <p style={{
              fontSize: '14px', color: 'rgba(148,163,184,0.80)', margin: 0,
              fontFamily: 'var(--font-inter, Inter, sans-serif)',
              letterSpacing: '0.01em',
            }}>
              Advanced on-chain intelligence · AI-powered wallet analysis
            </p>
          </div>

          {/* Input */}
          <div className="wallet-input-row" style={{ display: 'flex', gap: '10px', maxWidth: '700px', marginBottom: '20px' }}>
            <div style={{ flex: 1, position: 'relative' }}>
              {/* Paste icon */}
              <button
                onClick={() => navigator.clipboard.readText().then(t => setInput(t)).catch(() => {})}
                title="Paste from clipboard"
                style={{
                  position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', padding: '0', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', color: 'rgba(255,255,255,0.30)',
                  transition: 'color 0.15s', zIndex: 1,
                }}
                onMouseEnter={e => (e.currentTarget.style.color = '#2DD4BF')}
                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.30)')}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="2" width="6" height="4" rx="1"/>
                  <rect x="4" y="6" width="16" height="16" rx="2"/>
                  <path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2"/>
                </svg>
              </button>
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleScan() }}
                disabled={loading}
                placeholder="0x… wallet address"
                spellCheck={false}
                style={{
                  width: '100%', padding: '14px 16px 14px 42px',
                  background: 'rgba(255,255,255,0.035)',
                  border: '1px solid rgba(255,255,255,0.09)',
                  borderRadius: '13px', color: '#e2e8f0',
                  fontSize: '15px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                  outline: 'none',
                  transition: 'border-color 0.18s, box-shadow 0.18s',
                  boxSizing: 'border-box',
                  boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.18)',
                }}
                onFocus={e => {
                  e.currentTarget.style.borderColor = 'rgba(45,212,191,0.50)'
                  e.currentTarget.style.boxShadow = '0 0 0 3px rgba(45,212,191,0.08), inset 0 1px 3px rgba(0,0,0,0.18)'
                }}
                onBlur={e => {
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'
                  e.currentTarget.style.boxShadow = 'inset 0 1px 3px rgba(0,0,0,0.18)'
                }}
              />
            </div>
            <button
              className="ws-scan-btn"
              onClick={handleScan}
              disabled={loading || !input.trim()}
              style={{
                padding: '14px 24px', borderRadius: '13px', border: 'none',
                background: (loading || !input.trim())
                  ? 'rgba(45,212,191,0.20)'
                  : 'linear-gradient(135deg, #2DD4BF, #22c5ae)',
                color: (loading || !input.trim()) ? 'rgba(255,255,255,0.30)' : '#03121e',
                fontSize: '11px', fontWeight: 900,
                letterSpacing: '0.12em', textTransform: 'uppercase',
                cursor: (loading || !input.trim()) ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                boxShadow: (!loading && input.trim())
                  ? '0 0 24px rgba(45,212,191,0.30), 0 4px 12px rgba(0,0,0,0.25)'
                  : 'none',
                whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '8px',
              }}
            >
              {loading ? 'Scanning…' : (
                <>
                  Scan
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M13 6l6 6-6 6"/>
                  </svg>
                </>
              )}
            </button>
          </div>

          {/* Deep Activity Scan toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px', flexWrap: 'wrap' }}>
            <button
              onClick={() => setDeepActivity(v => !v)}
              disabled={loading}
              title="Fetches transfer history for estimated PnL and future trade reconstruction. Slower scan."
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '6px 13px', borderRadius: '8px',
                border: `1px solid ${deepActivity ? 'rgba(45,212,191,0.45)' : 'rgba(255,255,255,0.08)'}`,
                background: deepActivity ? 'rgba(45,212,191,0.08)' : 'rgba(255,255,255,0.02)',
                color: deepActivity ? '#2DD4BF' : 'rgba(255,255,255,0.35)',
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase',
                cursor: loading ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                transition: 'all 0.18s',
                boxShadow: deepActivity ? '0 0 14px rgba(45,212,191,0.12)' : 'none',
              }}
            >
              {deepActivity ? (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
                </svg>
              )}
              {deepActivity ? 'Deep Activity On' : 'Deep Activity Scan'}
            </button>
            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.22)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', letterSpacing: '0.04em' }}>
              {deepActivity
                ? 'Heavier analysis · cached · rerun returns cached result'
                : 'Fetches transfer history · slower scan'}
            </span>
          </div>

          {/* Loading skeleton */}
          {loading && (
            <div style={{ maxWidth: '700px', marginTop: '24px' }}>
              <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '16px', padding: '24px', marginBottom: '12px' }}>
                {[220, 140, 180, 110, 160, 90].map((w, i) => (
                  <div key={i} style={{
                    height: '12px', borderRadius: '6px', marginBottom: i === 5 ? 0 : '14px',
                    width: `${w + i * 12}px`, maxWidth: '100%',
                    background: 'linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.09) 50%, rgba(255,255,255,0.04) 100%)',
                    backgroundSize: '600px 100%',
                    animation: `shimmer 1.6s ease-in-out ${i * 0.1}s infinite`,
                  }} />
                ))}
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                {[1,2,3].map(i => (
                  <div key={i} style={{ flex: 1, height: '70px', borderRadius: '12px', background: 'linear-gradient(90deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.07) 50%, rgba(255,255,255,0.03) 100%)', backgroundSize: '600px 100%', animation: `shimmer 1.6s ease-in-out ${i * 0.15}s infinite` }} />
                ))}
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: '10px',
              padding: '14px 16px', borderRadius: '12px', maxWidth: '700px', marginTop: '16px',
              background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.18)',
              color: '#fca5a5', fontSize: '13px', lineHeight: 1.55,
              fontFamily: 'var(--font-inter, Inter, sans-serif)',
              boxShadow: '0 0 24px rgba(239,68,68,0.06)',
            }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginTop: '1px' }}>
                <circle cx="12" cy="12" r="10" stroke="#fca5a5" strokeWidth="1.8"/>
                <path d="M12 8v4M12 16h.01" stroke="#fca5a5" strokeWidth="2" strokeLinecap="round"/>
              </svg>
              {error}
            </div>
          )}

          {/* CORTEX idle placeholder — shown before first scan */}
          {!result && !loading && (
            <div style={{ maxWidth: '700px', marginTop: '16px' }}>
              <div style={{
                background: 'rgba(8,12,20,0.80)',
                border: '1px solid rgba(45,212,191,0.10)',
                borderRadius: '16px', padding: '22px 26px',
                boxShadow: '0 0 40px rgba(45,212,191,0.03)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                  <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'rgba(45,212,191,0.25)', boxShadow: '0 0 6px rgba(45,212,191,0.20)' }} />
                  <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em', color: 'rgba(45,212,191,0.45)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                    CORTEX · Wallet Intelligence
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: '13px', color: 'rgba(255,255,255,0.25)', fontFamily: 'var(--font-inter, Inter, sans-serif)', lineHeight: 1.6 }}>
                  Enter a wallet address above to generate an AI-powered CORTEX wallet read — portfolio value, trading intelligence, and on-chain behavior.
                </p>
              </div>
            </div>
          )}

          {/* Results */}
          {result && !loading && (() => {
            const sorted = [...result.holdings].sort((a, b) => b.value - a.value)
            const largest = sorted[0] ?? null
            const quality = dataQualityForWallet(result)
            const b = result.walletBehavior
            const walletIntel = buildWalletIntelligence(result)
            const tierTone = walletIntel.walletTier === 'Smart Money'
              ? { bg: 'rgba(34,197,94,0.13)', border: 'rgba(34,197,94,0.32)', color: '#4ade80' }
              : walletIntel.walletTier === 'Positive Early Read'
                ? { bg: 'rgba(45,212,191,0.10)', border: 'rgba(45,212,191,0.28)', color: '#2DD4BF' }
                : walletIntel.walletTier === 'Average Trader'
                  ? { bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.30)', color: '#fbbf24' }
                  : walletIntel.walletTier === 'Losing Wallet'
                    ? { bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.30)', color: '#f87171' }
                    : { bg: 'rgba(56,189,248,0.10)', border: 'rgba(56,189,248,0.25)', color: '#7dd3fc' }
            const hasUsefulActivity = Boolean(
              b?.status === 'ok' &&
              ((b.txCount ?? 0) > 0 || (b.activeDays ?? 0) > 0 || (b.inboundCount ?? 0) > 0 || (b.outboundCount ?? 0) > 0 || (b.topTokens?.length ?? 0) > 0 || (b.topContracts?.length ?? 0) > 0)
            )
            const hasPortfolioIntelligence = sorted.length > 0 || result.totalValue > 0
            const hasCortexFacts = Boolean(result.walletFacts)
            const showLegacyPortfolioCards = !(hasPortfolioIntelligence && hasCortexFacts)
            return (
            <div className="ws-result-fade" style={{ maxWidth: '100%', width: '100%', display: 'flex', flexDirection: 'column', gap: '20px', marginTop: '28px' }}>

              {/* Scan cost / cache note banner */}
              {result.walletScanCacheNote && (result.walletScanCostMode === 'blocked_by_cooldown' || result.walletScanCostMode === 'blocked_by_cost_guard' || result.walletScanCostMode === 'historical_cached' || result.walletScanCostMode === 'deep_cached') && (
                <div style={{ fontSize: '11px', color: '#7dd3fc', background: 'rgba(56,189,248,0.05)', border: '1px solid rgba(56,189,248,0.12)', borderRadius: '10px', padding: '10px 14px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.6, display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                  <span style={{ flexShrink: 0, marginTop: '1px' }}>ℹ</span>
                  {result.walletScanCacheNote}
                </div>
              )}

              {/* Module coverage strip — shows what was checked vs what had evidence */}
              {result.walletModuleCoverage && (() => {
                const mc = result.walletModuleCoverage!
                const statusIcon = (s: 'ok' | 'partial' | 'open_check') =>
                  s === 'ok' ? '✓' : s === 'partial' ? '~' : '○'
                const statusColor = (s: 'ok' | 'partial' | 'open_check') =>
                  s === 'ok' ? '#4ade80' : s === 'partial' ? '#fbbf24' : '#7dd3fc'
                const chips: { label: string; note: string; status: 'ok' | 'partial' | 'open_check' }[] = [
                  { label: 'Portfolio', note: mc.portfolio.status === 'ok' ? `${(mc.portfolio.evidence.includes('total_value') ? 'value + ' : '')}holdings` : mc.portfolio.reason.replace(/_/g, ' '), status: mc.portfolio.status },
                  { label: 'Activity', note: mc.activity.eventCount > 0 ? `${mc.activity.eventCount} events indexed` : mc.activity.status === 'open_check' && mc.activity.reason === 'provider_unavailable' ? 'unavailable' : 'not checked', status: mc.activity.status },
                  { label: 'Swap pairs', note: mc.swapDetection.candidateCount > 0 ? `${mc.swapDetection.candidateCount} candidates` : mc.activity.eventCount > 0 ? 'none found in sample' : 'no activity', status: mc.swapDetection.status },
                  { label: 'FIFO PnL', note: (() => {
                    const closedLots = mc.fifoPnL.closedLots
                    const openedLots = result.walletLotSummary?.openedLots ?? 0
                    const pricedEvents = mc.priceEvidence?.pricedEvents ?? 0
                    const candidates = mc.swapDetection.candidateCount
                    if (closedLots > 0) return `${closedLots} closed lots`
                    if (openedLots > 0 && pricedEvents > 0) return `${openedLots} open lot${openedLots !== 1 ? 's' : ''} tracked, no closed sells yet`
                    if (pricedEvents > 0 && openedLots === 0) return 'priced swaps found, no lots opened'
                    if (candidates > 0 && pricedEvents === 0) return 'candidates unpriced'
                    if (candidates > 0) return 'no swap evidence priced'
                    return 'no swap evidence'
                  })(), status: (() => {
                    const closedLots = mc.fifoPnL.closedLots
                    const openedLots = result.walletLotSummary?.openedLots ?? 0
                    const pricedEvents = mc.priceEvidence?.pricedEvents ?? 0
                    if (closedLots > 0) return mc.fifoPnL.status
                    if (openedLots > 0 && pricedEvents > 0) return 'partial' as const
                    return mc.fifoPnL.status
                  })() },
                  { label: 'Trade stats', note: (() => {
                    const tradeClosedLots = mc.tradeStats.closedLots
                    const tradeOpenedLots = mc.tradeStats.openedLots ?? 0
                    if (tradeClosedLots > 0) return `${tradeClosedLots} lots` + (mc.tradeStats.readyForWinRate ? '' : ' — below threshold')
                    if (tradeOpenedLots > 0) return `no closed trades yet — ${tradeOpenedLots} open lot${tradeOpenedLots !== 1 ? 's' : ''} tracked`
                    if (mc.swapDetection.candidateCount > 0 && (mc.priceEvidence?.pricedEvents ?? 0) === 0) return 'no verified closed lots'
                    return 'no closed lots'
                  })(), status: mc.tradeStats.status },
                ]
                return (
                  <div style={{ padding: '12px 16px', background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '12px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.16em', color: 'rgba(255,255,255,0.22)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', flexShrink: 0 }}>Checks</span>
                    <span style={{ width: '1px', height: '14px', background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />
                    {chips.map(chip => (
                      <span key={chip.label} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', color: statusColor(chip.status), borderRadius: '6px', padding: '3px 0' }}>
                        <span style={{ fontSize: '9px', opacity: 0.9 }}>{statusIcon(chip.status)}</span>
                        <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{chip.label}</span>
                        <span style={{ color: 'rgba(255,255,255,0.35)', fontWeight: 400 }}>{chip.note}</span>
                      </span>
                    ))}
                  </div>
                )
              })()}

              {/* Portfolio value hero */}
              <div style={{
                background: 'linear-gradient(135deg, #060c18 0%, #080f1c 60%, rgba(45,212,191,0.04) 100%)',
                border: '1px solid rgba(45,212,191,0.15)',
                borderRadius: '20px',
                position: 'relative', overflow: 'hidden',
                boxShadow: '0 0 60px rgba(45,212,191,0.06), 0 20px 60px rgba(0,0,0,0.30)',
              }}>
                <div style={{
                  position: 'absolute', top: 0, left: 0, right: 0, height: '2px',
                  background: 'linear-gradient(90deg, transparent 0%, #2DD4BF 30%, #8b5cf6 70%, transparent 100%)',
                  opacity: 0.9,
                }} />
                <div style={{
                  position: 'absolute', top: '20px', right: '20px', width: '200px', height: '200px',
                  background: 'radial-gradient(circle, rgba(45,212,191,0.07) 0%, transparent 70%)',
                  pointerEvents: 'none',
                }} />
                <div style={{ padding: '30px 34px', position: 'relative' }}>
                  <div style={{
                    fontSize: '10px', fontWeight: 700, letterSpacing: '0.20em',
                    color: 'rgba(45,212,191,0.70)', textTransform: 'uppercase',
                    fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                    marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '7px',
                  }}>
                    <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#2DD4BF', display: 'inline-block', boxShadow: '0 0 6px #2DD4BF' }} />
                    Portfolio Value
                  </div>
                  <div className="ws-val-52" style={{
                    fontSize: '54px', fontWeight: 900, color: '#f8fafc',
                    fontFamily: 'var(--font-inter, Inter, sans-serif)',
                    letterSpacing: '-0.035em', lineHeight: 1,
                    marginBottom: '16px',
                    textShadow: result.totalValue > 0 ? '0 0 40px rgba(45,212,191,0.15)' : 'none',
                  }}>
                    {result.totalValue > 0 ? fmtUSD(result.totalValue) : result.holdings.length > 0 ? 'Value pending' : 'No signal'}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
                    <span style={{
                      fontSize: '12px', color: 'rgba(255,255,255,0.28)',
                      fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                      letterSpacing: '0.04em',
                    }}>
                      {shortAddr(result.address)}
                    </span>
                    {result.holdings.length > 0 && (
                      <span style={{ fontSize: '10px', color: 'rgba(45,212,191,0.55)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', letterSpacing: '0.10em' }}>
                        {result.holdings.length} token{result.holdings.length !== 1 ? 's' : ''} indexed
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Portfolio Intelligence — always visible when holdings exist */}
              {(() => {
                const pi = derivePortfolioIntelligence(result)
                if (pi.holdingsCount === 0 && pi.totalValue === 0) return null
                const mc = result.walletModuleCoverage
                const totalEvents = result.walletEvidenceSummary?.totalEvents ?? 0
                const swapCandidates = mc?.swapDetection.candidateCount ?? 0
                const concentrationLabel = pi.concentration === 'high' ? 'High concentration' : pi.concentration === 'medium' ? 'Medium concentration' : pi.concentration === 'balanced' ? 'Balanced spread' : null
                const concentrationColor = pi.concentration === 'high' ? '#fbbf24' : pi.concentration === 'medium' ? '#a78bfa' : '#4ade80'
                return (
                  <div style={{ background: 'rgba(6,10,18,0.95)', border: '1px solid rgba(45,212,191,0.14)', borderRadius: '18px', overflow: 'hidden' }}>
                    {/* Section header */}
                    <div style={{ padding: '18px 24px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ width: '3px', height: '16px', borderRadius: '2px', background: 'linear-gradient(180deg, #2DD4BF, #4ade80)', flexShrink: 0 }} />
                        <span className="ws-section-header" style={{ color: '#e2e8f0' }}>Portfolio Intelligence</span>
                        <span style={{ fontSize: '9px', fontWeight: 600, color: '#4ade80', background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.18)', borderRadius: '999px', padding: '2px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Active</span>
                      </div>
                      <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.30)', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{pi.holdingsScope}</span>
                    </div>

                    <div style={{ padding: '20px 24px' }}>
                      {/* Top stats row */}
                      <div className="ws-portfolio-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '20px' }}>
                        <div style={{ background: 'rgba(45,212,191,0.04)', border: '1px solid rgba(45,212,191,0.10)', borderRadius: '12px', padding: '16px' }}>
                          <div className="ws-stat-label">Total Value</div>
                          <div style={{ fontSize: '24px', fontWeight: 800, color: '#2DD4BF', fontFamily: 'var(--font-inter, Inter, sans-serif)', letterSpacing: '-0.025em', lineHeight: 1.1 }}>{pi.totalValue > 0 ? fmtUSD(pi.totalValue) : '—'}</div>
                        </div>
                        <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '12px', padding: '16px' }}>
                          <div className="ws-stat-label">Visible Tokens</div>
                          <div className="ws-stat-value">{pi.holdingsCount}</div>
                          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.30)', fontFamily: 'var(--font-inter, Inter, sans-serif)', marginTop: '4px' }}>{pi.portfolioType}</div>
                        </div>
                        <div style={{ background: concentrationLabel ? `${concentrationColor}09` : 'rgba(255,255,255,0.025)', border: `1px solid ${concentrationLabel ? `${concentrationColor}22` : 'rgba(255,255,255,0.06)'}`, borderRadius: '12px', padding: '16px' }}>
                          <div className="ws-stat-label">Concentration</div>
                          <div style={{ fontSize: '18px', fontWeight: 800, color: concentrationLabel ? concentrationColor : 'rgba(255,255,255,0.30)', fontFamily: 'var(--font-inter, Inter, sans-serif)', letterSpacing: '-0.01em', lineHeight: 1.2 }}>{concentrationLabel ?? '—'}</div>
                          {pi.topHolding && pi.topShare !== null && (
                            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', fontFamily: 'var(--font-inter, Inter, sans-serif)', marginTop: '5px', lineHeight: 1.4 }}>
                              {pi.topHolding.symbol || pi.topHolding.name} · {pi.topShare.toFixed(0)}% of portfolio
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Holdings + chains row */}
                      <div className="ws-pi-bottom" style={{ display: 'flex', gap: '20px', marginBottom: '16px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                        {pi.top3.length > 0 && (
                          <div style={{ flex: '1 1 auto', minWidth: '160px' }}>
                            <div className="ws-stat-label" style={{ marginBottom: '8px' }}>Top Holdings</div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '7px' }}>
                              {pi.top3.map((h, i) => {
                                const pct = pi.totalValue > 0 ? ((h.value / pi.totalValue) * 100).toFixed(0) : null
                                const isTop = i === 0
                                return (
                                  <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', fontFamily: 'var(--font-inter, Inter, sans-serif)', color: isTop ? '#f1f5f9' : '#94a3b8', border: `1px solid ${isTop ? 'rgba(45,212,191,0.20)' : 'rgba(255,255,255,0.08)'}`, background: isTop ? 'rgba(45,212,191,0.05)' : 'rgba(255,255,255,0.025)', borderRadius: '8px', padding: '5px 10px' }}>
                                    <span style={{ fontWeight: 700 }}>{h.symbol || h.name}</span>
                                    {pct && <span style={{ color: isTop ? 'rgba(45,212,191,0.65)' : 'rgba(255,255,255,0.30)', fontSize: '10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{pct}%</span>}
                                  </span>
                                )
                              })}
                            </div>
                          </div>
                        )}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0 }}>
                          {pi.chains.length > 0 && (
                            <div>
                              <div className="ws-stat-label" style={{ marginBottom: '7px' }}>Chain Exposure</div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                                {pi.chains.map(c => (
                                  <span key={c} style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', padding: '4px 10px', borderRadius: '7px', background: c === 'base' ? 'rgba(0,82,255,0.12)' : 'rgba(98,126,234,0.12)', border: c === 'base' ? '1px solid rgba(0,82,255,0.24)' : '1px solid rgba(98,126,234,0.24)', color: c === 'base' ? '#6ea8ff' : '#a5b4fc', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{c === 'base' ? 'Base' : c === 'ethereum' ? 'Ethereum' : c.toUpperCase().replace(/-/g, ' ')}</span>
                                ))}
                              </div>
                            </div>
                          )}
                          {(pi.stablePercent > 5 || pi.ethPercent > 5) && (
                            <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                              {pi.stablePercent > 5 && <span style={{ fontSize: '10px', color: '#4ade80', border: '1px solid rgba(74,222,128,0.18)', background: 'rgba(74,222,128,0.04)', borderRadius: '7px', padding: '3px 9px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Stablecoins {pi.stablePercent.toFixed(0)}%</span>}
                              {pi.ethPercent > 5 && <span style={{ fontSize: '10px', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.18)', background: 'rgba(139,92,246,0.04)', borderRadius: '7px', padding: '3px 9px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>ETH {pi.ethPercent.toFixed(0)}%</span>}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Activity row */}
                      <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '14px' }}>
                        {totalEvents > 0 ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                            <span style={{ fontSize: '11px', fontWeight: 600, color: '#4ade80', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>Activity indexed</span>
                            <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.40)', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>·</span>
                            <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.40)', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{totalEvents} transfer events</span>
                            {swapCandidates === 0 ? (
                              <span style={{ fontSize: '10px', color: '#7dd3fc', border: '1px solid rgba(125,211,252,0.15)', background: 'rgba(56,189,248,0.04)', borderRadius: '6px', padding: '2px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>no swap pairs in sample</span>
                            ) : (
                              <span style={{ fontSize: '10px', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.18)', background: 'rgba(139,92,246,0.04)', borderRadius: '6px', padding: '2px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{swapCandidates} swap pair{swapCandidates !== 1 ? 's' : ''}</span>
                            )}
                          </div>
                        ) : (
                          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.28)', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>Activity not available in checked sample</span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })()}

              {/* Wallet Score + PnL Intelligence */}
              <div className="wallet-score-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1.05fr) minmax(280px, 1.6fr)', gap: '14px' }}>
                <div style={{
                  background: 'radial-gradient(circle at top right, rgba(45,212,191,0.16), transparent 34%), #080c14',
                  border: `1px solid ${tierTone.border}`,
                  borderRadius: '18px', padding: '22px', position: 'relative', overflow: 'hidden',
                  boxShadow: '0 18px 50px rgba(0,0,0,0.28)',
                }}>
                  <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', borderTop: '2px solid rgba(45,212,191,0.55)' }} />
                  {(() => {
                    const ts = result.walletTradeStatsSummary
                    const _ls = result.walletLotSummary
                    // Use walletLotSummary as source of truth for lot counts
                    const closedLots = _ls?.closedLots ?? ts?.closedLots ?? 0
                    const openedLots = _ls?.openedLots ?? ts?.openedLots ?? 0
                    const portfolioActive = result.walletModuleCoverage?.portfolio.status === 'ok' || result.totalValue > 0 || result.holdings.length > 0
                    // Priority: closedLots > 0 wins over openedLots > 0
                    const hasClosedTradeEvidence = closedLots > 0
                    const hasOpenLots = openedLots > 0 && !hasClosedTradeEvidence
                    const tradeOpenCheck = closedLots === 0
                    const openPos = result.walletModuleCoverage?.walletOpenPositionSummary ?? result.walletOpenPositionSummary ?? null
                    if (portfolioActive && hasOpenLots) {
                      const costBasis = openPos?.totalOpenCostBasisUsd ?? null
                      const uniqueTokens = openPos?.uniqueTokens ?? 0
                      const tokenPills = openPos?.tokens ?? []
                      return (
                        <>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '16px' }}>
                            <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.18em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                              Wallet Status
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '13px', fontWeight: 800, color: '#4ade80', border: '1px solid rgba(74,222,128,0.30)', background: 'rgba(74,222,128,0.08)', borderRadius: '8px', padding: '7px 14px', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                              <span style={{ fontSize: '10px' }}>●</span> Portfolio Active
                            </span>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '13px', fontWeight: 800, color: '#fbbf24', border: '1px solid rgba(251,191,36,0.30)', background: 'rgba(251,191,36,0.08)', borderRadius: '8px', padding: '7px 14px', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                              <span style={{ fontSize: '10px' }}>◑</span> Trading Active Entries
                            </span>
                          </div>
                          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.45)', lineHeight: 1.55, fontFamily: 'var(--font-inter, Inter, sans-serif)', marginBottom: '16px' }}>
                            {`CORTEX tracked ${openedLots} open lot${openedLots !== 1 ? 's' : ''} across ${uniqueTokens > 0 ? uniqueTokens : 'multiple'} token${uniqueTokens !== 1 ? 's' : ''}. Win rate and score unlock after sell exits are detected.`}
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px', marginBottom: tokenPills.length > 0 ? '14px' : '0' }}>
                            <div style={{ background: 'rgba(251,191,36,0.04)', border: '1px solid rgba(251,191,36,0.15)', borderRadius: '12px', padding: '12px' }}>
                              <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.13em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '6px' }}>Win Rate</div>
                              <div style={{ fontSize: '14px', color: '#fbbf24', fontWeight: 800, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.3 }}>Pending exits</div>
                              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.32)', marginTop: '4px' }}>{openedLots} open lot{openedLots !== 1 ? 's' : ''} tracked — win rate unlocks after closed trades.</div>
                            </div>
                            <div style={{ background: 'rgba(251,191,36,0.04)', border: '1px solid rgba(251,191,36,0.15)', borderRadius: '12px', padding: '12px' }}>
                              <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.13em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '6px' }}>Wallet Score</div>
                              <div style={{ fontSize: '14px', color: '#fbbf24', fontWeight: 800, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.3 }}>Pending realized score</div>
                              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.32)', marginTop: '4px' }}>Open-position evidence found. Score unlocks after closed-lot evidence.</div>
                            </div>
                          </div>
                          {(tokenPills.length > 0 || costBasis !== null) && (
                            <div style={{ background: 'rgba(251,191,36,0.03)', border: '1px solid rgba(251,191,36,0.12)', borderRadius: '10px', padding: '10px 12px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
                                <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.35)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Open Position</span>
                                {costBasis !== null && (
                                  <span style={{ fontSize: '10px', fontWeight: 700, color: '#fbbf24', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>~${costBasis.toFixed(2)} tracked cost basis</span>
                                )}
                              </div>
                              {tokenPills.length > 0 && (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                                  {tokenPills.map((t, i) => (
                                    <span key={i} style={{ fontSize: '11px', fontWeight: 700, color: '#fbbf24', background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.20)', borderRadius: '6px', padding: '3px 9px', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                                      {t.symbol} <span style={{ fontWeight: 400, fontSize: '9px', opacity: 0.7, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{t.openLots}L</span>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      )
                    }
                    if (portfolioActive && tradeOpenCheck) {
                      return (
                        <>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '16px' }}>
                            <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.18em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                              Wallet Status
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '13px', fontWeight: 800, color: '#4ade80', border: '1px solid rgba(74,222,128,0.30)', background: 'rgba(74,222,128,0.08)', borderRadius: '8px', padding: '7px 14px', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                              <span style={{ fontSize: '10px' }}>●</span> Portfolio Active
                            </span>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '13px', fontWeight: 800, color: '#7dd3fc', border: '1px solid rgba(125,211,252,0.25)', background: 'rgba(56,189,248,0.07)', borderRadius: '8px', padding: '7px 14px', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                              <span style={{ fontSize: '10px' }}>○</span> Trading Open Check
                            </span>
                          </div>
                          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.45)', lineHeight: 1.55, fontFamily: 'var(--font-inter, Inter, sans-serif)', marginBottom: '16px' }}>
                            {(result.walletModuleCoverage?.swapDetection?.candidateCount ?? 0) > 0 && (result.walletModuleCoverage?.priceEvidence?.pricedEvents ?? 0) === 0
                              ? 'CORTEX found swap-like movement, but could not verify quote-side price evidence from the available sample.'
                              : 'CORTEX can read current holdings and exposure. Trading skill needs matched swap exits.'}
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' }}>
                            <div style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '12px' }}>
                              <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.13em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '6px' }}>Win Rate</div>
                              <div style={{ fontSize: '14px', color: '#7dd3fc', fontWeight: 800, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.3 }}>Trading Open Check</div>
                              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.28)', marginTop: '4px' }}>No closed lots yet</div>
                            </div>
                            <div style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '12px' }}>
                              <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.13em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '6px' }}>Wallet Score</div>
                              <div style={{ fontSize: '14px', color: '#7dd3fc', fontWeight: 800, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.3 }}>Trading Open Check</div>
                              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.28)', marginTop: '4px' }}>Requires closed-lot evidence</div>
                            </div>
                          </div>
                        </>
                      )
                    }
                    const winRateNote = walletIntel.winRate !== null ? 'Closed lots only' : closedLots > 0 ? officialWinRateLockCopy(ts) : 'No closed lots yet'
                    const confidenceNote = walletIntel.confidence === 'open check' ? (closedLots > 0 ? `${closedLots} closed lots reconstructed` : 'Closed-lot stats not available yet') : 'Evidence weighted'
                    const scoreReason = walletIntel.walletScore === null ? walletScoreLockCopy(ts) : null
                    return (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '18px' }}>
                          <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.18em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                            Instant Wallet Score
                          </div>
                          {walletIntel.walletTier !== 'Open Check' && (
                            <span style={{ padding: '5px 10px', borderRadius: '999px', background: tierTone.bg, border: `1px solid ${tierTone.border}`, color: tierTone.color, fontSize: '10px', fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                              {walletIntel.walletTier}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', marginBottom: '14px' }}>
                          <div style={{ fontSize: walletIntel.walletScore === null ? '40px' : '56px', lineHeight: 0.9, fontWeight: 950, letterSpacing: '-0.06em', color: walletIntel.walletScore === null ? '#7dd3fc' : '#f8fafc', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                            {walletIntel.walletScore === null ? (closedLots > 0 ? 'Partial Trade Read' : 'Open Check') : walletIntel.walletScore}
                          </div>
                          {walletIntel.walletScore !== null && <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.35)', marginBottom: '4px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>/100</div>}
                        </div>
                        {scoreReason && (
                          <div style={{ fontSize: '11px', color: '#7dd3fc', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '12px', lineHeight: 1.4 }}>
                            {scoreReason}
                          </div>
                        )}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' }}>
                          {[
                            (() => {
                              const rawRate = ts && closedLots > 0 && walletIntel.winRate === null ? (ts.winRatePercent ?? (ts.winningClosedLots / closedLots) * 100) : null
                              const label = walletIntel.winRate !== null ? 'Win Rate' : closedLots > 0 && closedLots < 10 ? 'Win Rate (raw)' : closedLots > 0 ? 'Official Win Rate' : 'Win Rate'
                              const value = walletIntel.winRate !== null ? fmtOpenPct(walletIntel.winRate) : rawRate !== null ? `${rawRate.toFixed(1)}%` : fmtOpenPct(null)
                              const note = walletIntel.winRate !== null ? winRateNote : rawRate !== null ? officialWinRateLockCopy(ts) : 'No closed lots yet'
                              return { label, value, note }
                            })(),
                            { label: 'Confidence', value: ts ? (ts.confidence === 'open_check' ? 'open check' : ts.confidence) : walletIntel.confidence, note: confidenceNote },
                          ].map(item => (
                            <div key={item.label} style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '12px' }}>
                              <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.13em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '6px' }}>{item.label}</div>
                              <div style={{ fontSize: '18px', color: item.value === 'Not calculated yet' || item.value === 'Open Check' ? '#7dd3fc' : '#e2e8f0', fontWeight: 800, textTransform: item.label === 'Confidence' ? 'capitalize' : 'none' }}>{item.value}</div>
                              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.28)', marginTop: '4px' }}>{item.note}</div>
                            </div>
                          ))}
                        </div>
                      </>
                    )
                  })()}
                </div>

                {(() => {
                  const hasRealTrade = (result.walletTradeStatsSummary?.closedLots ?? 0) > 0
                  const _openedLotsForPnl = (result.walletTradeStatsSummary?.openedLots ?? result.walletLotSummary?.openedLots ?? 0)
                  const _openPosForPnl = result.walletModuleCoverage?.walletOpenPositionSummary ?? result.walletOpenPositionSummary ?? null
                  const hasOpenLotsForPnl = _openedLotsForPnl > 0 && !hasRealTrade
                  if (hasRealTrade) {
                    const legacyVal = fmtSignedUSD(walletIntel.pnl.total)
                    return (
                      <div style={{ background: '#080c14', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '18px', padding: '16px 20px', opacity: 0.62 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                          <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.18em', color: 'rgba(45,212,191,0.45)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Position Estimate</div>
                          <span style={{ fontSize: '8px', fontWeight: 700, color: 'rgba(125,211,252,0.45)', border: '1px solid rgba(125,211,252,0.15)', background: 'rgba(56,189,248,0.04)', borderRadius: '999px', padding: '1px 6px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>avg cost</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '10px', padding: '10px' }}>
                            <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.22)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '5px' }}>Average-Cost Estimate</div>
                            <div style={{ fontSize: '15px', fontWeight: 700, color: legacyVal === 'Open Check' ? 'rgba(255,255,255,0.22)' : legacyVal.startsWith('-') ? '#f87171' : '#4ade80', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{legacyVal === 'Open Check' ? '—' : legacyVal}</div>
                          </div>
                          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '10px', padding: '10px' }}>
                            <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.22)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '5px' }}>Method</div>
                            <div style={{ fontSize: '13px', fontWeight: 700, color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Avg cost basis</div>
                          </div>
                        </div>
                        <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.22)', lineHeight: 1.4, marginTop: '10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                          Average-cost position estimate. Matched closed-lot evidence is shown separately below.
                        </div>
                      </div>
                    )
                  }
                  if (hasOpenLotsForPnl) {
                    const costBasis = _openPosForPnl?.totalOpenCostBasisUsd ?? null
                    const uniqueTokens = _openPosForPnl?.uniqueTokens ?? 0
                    const tokenPills = _openPosForPnl?.tokens ?? []
                    return (
                      <div style={{ background: '#080c14', border: '1px solid rgba(251,191,36,0.15)', borderRadius: '18px', padding: '22px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
                          <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.18em', color: '#fbbf24', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Position Estimate</div>
                          <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.25)', background: 'rgba(251,191,36,0.06)', borderRadius: '999px', padding: '2px 7px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>open entries</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px', marginBottom: '12px' }}>
                          {[
                            { label: 'Open Lots', value: String(_openedLotsForPnl) },
                            { label: 'Active Tokens', value: uniqueTokens > 0 ? String(uniqueTokens) : '—' },
                            { label: 'Tracked Cost Basis', value: costBasis !== null ? `~$${costBasis.toFixed(2)}` : '—' },
                          ].map(card => (
                            <div key={card.label} style={{ background: 'rgba(251,191,36,0.04)', border: '1px solid rgba(251,191,36,0.12)', borderRadius: '12px', padding: '12px' }}>
                              <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '7px' }}>{card.label}</div>
                              <div style={{ fontSize: '18px', fontWeight: 800, color: '#fbbf24', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{card.value}</div>
                            </div>
                          ))}
                        </div>
                        {tokenPills.length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '12px' }}>
                            {tokenPills.map((t, i) => (
                              <span key={i} style={{ fontSize: '11px', fontWeight: 700, color: '#fbbf24', background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.20)', borderRadius: '6px', padding: '3px 9px', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                                {t.symbol} <span style={{ fontWeight: 400, fontSize: '9px', opacity: 0.7, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{t.openLots}L</span>
                              </span>
                            ))}
                          </div>
                        )}
                        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.32)', lineHeight: 1.5, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                          Open entries found, but no sell exits yet. Realized PnL unlocks after FIFO lots close.
                        </div>
                      </div>
                    )
                  }
                  return (
                    <div style={{ background: '#080c14', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '18px', padding: '22px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
                        <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.18em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Position Estimate</div>
                        <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', color: '#7dd3fc', border: '1px solid rgba(125,211,252,0.25)', background: 'rgba(56,189,248,0.06)', borderRadius: '999px', padding: '2px 7px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>avg cost basis</span>
                      </div>
                      <div className="wallet-intel-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px' }}>
                        {[
                          { label: 'Total PnL All Time', value: fmtSignedUSD(walletIntel.pnl.total) },
                          { label: '7D PnL', value: fmtSignedUSD(walletIntel.pnl.sevenDay) },
                          { label: '30D PnL', value: fmtSignedUSD(walletIntel.pnl.thirtyDay) },
                          { label: 'This Month PnL', value: fmtSignedUSD(walletIntel.pnl.thisMonth) },
                          { label: 'Realized PnL', value: fmtSignedUSD(walletIntel.pnl.realized) },
                          { label: 'Unrealized PnL', value: fmtSignedUSD(walletIntel.pnl.unrealized) },
                        ].map(card => (
                          <div key={card.label} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '12px' }}>
                            <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '7px' }}>{card.label}</div>
                            <div style={{ fontSize: '18px', fontWeight: 800, color: card.value === 'Open Check' ? '#7dd3fc' : card.value.startsWith('-') ? '#f87171' : '#4ade80', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{card.value}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.32)', lineHeight: 1.5, marginTop: '12px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                        {(() => {
                          const mc = result.walletModuleCoverage
                          if (mc?.activity && mc.activity.eventCount > 0 && mc.swapDetection.candidateCount === 0) {
                            return `${mc.activity.eventCount} transfer events indexed — no reconstructable swap pairs found. Closed-lot PnL not available yet.`
                          }
                          if (mc?.activity?.reason === 'provider_unavailable') {
                            return 'Activity provider unavailable in this scan. PnL stays open check until transfer evidence is indexed.'
                          }
                          if (mc?.swapDetection && mc.swapDetection.candidateCount > 0 && (mc.priceEvidence?.pricedEvents ?? 0) === 0 && mc.fifoPnL.closedLots === 0) {
                            return 'Swap candidates found, but price evidence was unavailable at trade time. FIFO lot matching requires priced entry and exit legs.'
                          }
                          if (mc?.swapDetection && mc.swapDetection.candidateCount > 0 && mc.fifoPnL.closedLots === 0) {
                            return 'Swap candidates found but no matched buy/sell lot pairs yet. Closed-lot PnL not available until FIFO lots close.'
                          }
                          return 'Closed-lot stats not available yet. PnL values only appear when priced buy/sell lot pairs are reconstructed.'
                        })()}
                      </div>
                    </div>
                  )
                })()}
              </div>

              {/* CORTEX Facts — factual wallet intelligence from holdings + indexed activity */}
              {result.walletFacts && (() => {
                const wf = result.walletFacts!
                const statusColor = wf.status === 'ok' ? '#4ade80' : wf.status === 'partial' ? '#fbbf24' : '#7dd3fc'
                const statusBg = wf.status === 'ok' ? 'rgba(74,222,128,0.06)' : wf.status === 'partial' ? 'rgba(251,191,36,0.06)' : 'rgba(125,211,252,0.06)'
                const statusBorder = wf.status === 'ok' ? 'rgba(74,222,128,0.18)' : wf.status === 'partial' ? 'rgba(251,191,36,0.18)' : 'rgba(125,211,252,0.18)'
                const fmtDate = (ts: string | null) => ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
                return (
                  <div style={{ background: 'rgba(6,10,18,0.95)', border: '1px solid rgba(45,212,191,0.12)', borderRadius: '18px', overflow: 'hidden' }}>
                    {/* Header */}
                    <div style={{ padding: '18px 24px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <div style={{ width: '3px', height: '16px', borderRadius: '2px', background: 'linear-gradient(180deg, #2DD4BF, rgba(45,212,191,0.3))', flexShrink: 0 }} />
                      <span className="ws-section-header" style={{ color: '#e2e8f0' }}>CORTEX Facts</span>
                      <span style={{ fontSize: '9px', fontWeight: 600, color: statusColor, background: statusBg, border: `1px solid ${statusBorder}`, borderRadius: '999px', padding: '2px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                        {wf.status === 'ok' ? 'full read' : wf.status === 'partial' ? 'partial read' : 'open check'}
                      </span>
                      {wf.limits.noClosedLotPnL && (
                        <span style={{ fontSize: '9px', fontWeight: 600, color: '#7dd3fc', border: '1px solid rgba(125,211,252,0.15)', background: 'rgba(125,211,252,0.04)', borderRadius: '999px', padding: '2px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>no closed lots</span>
                      )}
                    </div>

                    <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
                      {/* Top holdings row */}
                      {wf.summary.topHoldings.length > 0 && (
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }}>
                          <div style={{ flex: '1 1 auto' }}>
                            <div className="ws-stat-label" style={{ marginBottom: '8px' }}>Top Holdings</div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                              {wf.summary.topHoldings.map((h, i) => (
                                <span key={i} style={{ fontSize: '12px', fontWeight: 700, color: i === 0 ? '#2DD4BF' : '#94a3b8', background: i === 0 ? 'rgba(45,212,191,0.07)' : 'rgba(255,255,255,0.03)', border: `1px solid ${i === 0 ? 'rgba(45,212,191,0.20)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '8px', padding: '5px 11px', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                                  {h.symbol} <span style={{ fontWeight: 400, fontSize: '10px', opacity: 0.6, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{h.percent}%</span>
                                </span>
                              ))}
                            </div>
                          </div>
                          <div style={{ flexShrink: 0 }}>
                            <div className="ws-stat-label" style={{ marginBottom: '8px' }}>Chain</div>
                            <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                              {wf.summary.chainExposure.map((ce, i) => (
                                <span key={i} style={{ fontSize: '11px', fontWeight: 700, color: '#7dd3fc', background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.15)', borderRadius: '7px', padding: '4px 10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                                  {ce.chain.toUpperCase()} <span style={{ opacity: 0.6 }}>{ce.percent}%</span>
                                </span>
                              ))}
                              {wf.summary.stablecoinExposurePercent > 5 && <span style={{ fontSize: '10px', color: '#4ade80', background: 'rgba(74,222,128,0.04)', border: '1px solid rgba(74,222,128,0.15)', borderRadius: '7px', padding: '4px 9px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Stable {wf.summary.stablecoinExposurePercent}%</span>}
                              {wf.summary.nativeExposurePercent > 5 && <span style={{ fontSize: '10px', color: '#a78bfa', background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.15)', borderRadius: '7px', padding: '4px 9px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>ETH {wf.summary.nativeExposurePercent}%</span>}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Activity stats grid */}
                      {wf.activity.eventCount > 0 && (
                        <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px', padding: '14px 18px' }}>
                          <div className="ws-stat-label" style={{ marginBottom: '12px', color: 'rgba(45,212,191,0.50)' }}>Activity Index</div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))', gap: '12px 20px' }}>
                            {[
                              { label: 'Events', val: String(wf.activity.eventCount) },
                              { label: 'Tx Groups', val: String(wf.activity.groupedTxCount) },
                              { label: 'Wallet-Init', val: String(wf.activity.walletInitiatedTxCount) },
                              { label: 'Inbound', val: String(wf.activity.inboundCount) },
                              { label: 'Outbound', val: String(wf.activity.outboundCount) },
                              { label: 'First Seen', val: fmtDate(wf.activity.firstSeenAt) },
                              { label: 'Last Seen', val: fmtDate(wf.activity.lastSeenAt) },
                            ].map(item => (
                              <div key={item.label}>
                                <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.10em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '3px' }}>{item.label}</div>
                                <div style={{ fontSize: '14px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)', letterSpacing: '-0.01em' }}>{item.val}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Latest events */}
                      {wf.activity.latestEvents.length > 0 && (
                        <div>
                          <div className="ws-stat-label" style={{ marginBottom: '8px' }}>Recent Events</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                            {wf.activity.latestEvents.map((ev, i) => (
                              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', background: 'rgba(255,255,255,0.018)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '9px' }}>
                                <span style={{ width: '22px', height: '22px', borderRadius: '6px', background: ev.direction === 'buy' ? 'rgba(74,222,128,0.10)' : ev.direction === 'sell' ? 'rgba(248,113,113,0.10)' : 'rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '11px', color: ev.direction === 'buy' ? '#4ade80' : ev.direction === 'sell' ? '#f87171' : '#94a3b8', fontWeight: 700 }}>
                                  {ev.direction === 'buy' ? '↓' : ev.direction === 'sell' ? '↑' : '·'}
                                </span>
                                <span style={{ fontSize: '13px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)', minWidth: '40px' }}>{ev.symbol}</span>
                                <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.30)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', letterSpacing: '0.06em' }}>{ev.chain.toUpperCase()}</span>
                                {ev.valueUsdKnown && <span style={{ fontSize: '10px', color: '#7dd3fc', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>USD known</span>}
                                <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'rgba(255,255,255,0.28)', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{new Date(ev.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Received / Sent panels */}
                      {(wf.flowRead.receivedTokens.length > 0 || wf.flowRead.sentTokens.length > 0) && (
                        <div className="ws-facts-flow-grid">
                          {wf.flowRead.receivedTokens.length > 0 && (
                            <div style={{ background: 'rgba(74,222,128,0.02)', border: '1px solid rgba(74,222,128,0.09)', borderRadius: '12px', padding: '14px 16px' }}>
                              <div className="ws-stat-label" style={{ color: 'rgba(74,222,128,0.55)', marginBottom: '10px' }}>Received Tokens</div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                {wf.flowRead.receivedTokens.slice(0, 5).map((t, i) => (
                                  <span key={i} style={{ fontSize: '12px', color: '#4ade80', fontFamily: 'var(--font-inter, Inter, sans-serif)', fontWeight: 600 }}>
                                    {t.symbol}<span style={{ color: 'rgba(74,222,128,0.40)', fontSize: '10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', fontWeight: 400 }}> ×{t.count}</span>
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {wf.flowRead.sentTokens.length > 0 && (
                            <div style={{ background: 'rgba(248,113,113,0.02)', border: '1px solid rgba(248,113,113,0.09)', borderRadius: '12px', padding: '14px 16px' }}>
                              <div className="ws-stat-label" style={{ color: 'rgba(248,113,113,0.55)', marginBottom: '10px' }}>Sent Tokens</div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                {wf.flowRead.sentTokens.slice(0, 5).map((t, i) => (
                                  <span key={i} style={{ fontSize: '12px', color: '#f87171', fontFamily: 'var(--font-inter, Inter, sans-serif)', fontWeight: 600 }}>
                                    {t.symbol}<span style={{ color: 'rgba(248,113,113,0.40)', fontSize: '10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', fontWeight: 400 }}> ×{t.count}</span>
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Signals */}
                      {(wf.flowRead.accumulationSignals.length > 0 || wf.flowRead.distributionSignals.length > 0) && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {wf.flowRead.accumulationSignals.slice(0, 3).map((s, i) => (
                            <span key={`acc-${i}`} style={{ fontSize: '11px', color: '#4ade80', background: 'rgba(74,222,128,0.05)', border: '1px solid rgba(74,222,128,0.14)', borderRadius: '7px', padding: '4px 10px', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>↑ {s}</span>
                          ))}
                          {wf.flowRead.distributionSignals.slice(0, 3).map((s, i) => (
                            <span key={`dist-${i}`} style={{ fontSize: '11px', color: '#f87171', background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.14)', borderRadius: '7px', padding: '4px 10px', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>↓ {s}</span>
                          ))}
                        </div>
                      )}

                      {/* Source classification + limits */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {wf.sourceClassification.notes.length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                            {wf.sourceClassification.notes.map((n, i) => (
                              <span key={i} style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '6px', padding: '3px 9px', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{n}</span>
                            ))}
                          </div>
                        )}
                        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.25)', lineHeight: 1.55, fontFamily: 'var(--font-inter, Inter, sans-serif)', background: 'rgba(255,255,255,0.015)', borderRadius: '9px', padding: '9px 12px', border: '1px solid rgba(255,255,255,0.05)' }}>
                          {wf.limits.reason}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })()}

              {(() => {
                const ts = result.walletTradeStatsSummary
                const ls = result.walletLotSummary
                if (!ts) return null
                // Use walletLotSummary as source of truth; closedLots > 0 wins
                const _tiClosedLots = ls?.closedLots ?? ts.closedLots ?? 0
                const _tiOpenedLots = ls?.openedLots ?? ts.openedLots ?? 0
                const hasClosedTradeEvidence = _tiClosedLots > 0
                const hasOpenLots = _tiOpenedLots > 0 && !hasClosedTradeEvidence
                const isOpenCheck = !hasClosedTradeEvidence
                const openPos = result.walletModuleCoverage?.walletOpenPositionSummary ?? result.walletOpenPositionSummary ?? null
                const hasEnough = isTradeStatsGradeable(ts)
                function fmtHoldTime(seconds: number | null): string {
                  if (seconds === null || !Number.isFinite(seconds)) return '—'
                  const h = Math.floor(seconds / 3600)
                  const d = Math.floor(h / 24)
                  if (d >= 1) return `${d}d ${h % 24}h`
                  if (h >= 1) return `${h}h ${Math.floor((seconds % 3600) / 60)}m`
                  return `${Math.floor(seconds / 60)}m`
                }
                return (
                  <div style={{ background: 'rgba(6,10,18,0.95)', border: '1px solid rgba(139,92,246,0.18)', borderRadius: '18px', overflow: 'hidden' }}>
                    {/* Header */}
                    <div style={{ padding: '18px 24px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <div style={{ width: '3px', height: '16px', borderRadius: '2px', background: 'linear-gradient(180deg, #a78bfa, rgba(139,92,246,0.3))', flexShrink: 0 }} />
                      <span className="ws-section-header" style={{ color: '#e2e8f0' }}>Trading Intelligence</span>
                      <span style={{ fontSize: '9px', fontWeight: 600, color: '#a78bfa', border: '1px solid rgba(139,92,246,0.22)', background: 'rgba(139,92,246,0.06)', borderRadius: '999px', padding: '2px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>FIFO lots</span>
                      {/* Trade Evidence State badge */}
                      {hasClosedTradeEvidence ? (
                        <span style={{ fontSize: '9px', fontWeight: 700, color: '#4ade80', border: '1px solid rgba(74,222,128,0.22)', background: 'rgba(74,222,128,0.06)', borderRadius: '999px', padding: '2px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Closed Trade Evidence</span>
                      ) : hasOpenLots ? (
                        <span style={{ fontSize: '9px', fontWeight: 700, color: '#fbbf24', border: '1px solid rgba(251,191,36,0.22)', background: 'rgba(251,191,36,0.06)', borderRadius: '999px', padding: '2px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Open Position Evidence</span>
                      ) : (
                        <span style={{ fontSize: '9px', fontWeight: 700, color: '#94a3b8', border: '1px solid rgba(148,163,184,0.15)', background: 'rgba(148,163,184,0.04)', borderRadius: '999px', padding: '2px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Portfolio / Activity Only</span>
                      )}
                      <span style={{ fontSize: '9px', fontWeight: 600, color: ts.confidence === 'high' ? '#4ade80' : ts.confidence === 'medium' ? '#fbbf24' : '#94a3b8', border: `1px solid ${ts.confidence === 'high' ? 'rgba(74,222,128,0.20)' : ts.confidence === 'medium' ? 'rgba(251,191,36,0.20)' : 'rgba(148,163,184,0.15)'}`, background: ts.confidence === 'high' ? 'rgba(74,222,128,0.05)' : ts.confidence === 'medium' ? 'rgba(251,191,36,0.05)' : 'rgba(148,163,184,0.04)', borderRadius: '999px', padding: '2px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{ts.confidence === 'open_check' ? 'open check' : `${ts.confidence} confidence`}</span>
                      <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.30)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{ts.sampleSizeLabel}</span>
                    </div>

                    <div style={{ padding: '20px 24px' }}>
                    {/* Evidence state context block */}
                    {hasClosedTradeEvidence ? (
                      <div style={{ fontSize: '12px', color: 'rgba(74,222,128,0.70)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '14px', lineHeight: 1.5, background: 'rgba(74,222,128,0.04)', border: '1px solid rgba(74,222,128,0.10)', borderRadius: '8px', padding: '8px 11px' }}>
                        CORTEX reconstructed {_tiClosedLots} closed buy → sell lot{_tiClosedLots !== 1 ? 's' : ''}.
                      </div>
                    ) : hasOpenLots ? (
                      <div style={{ fontSize: '12px', color: 'rgba(251,191,36,0.70)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '14px', lineHeight: 1.5, background: 'rgba(251,191,36,0.04)', border: '1px solid rgba(251,191,36,0.10)', borderRadius: '8px', padding: '8px 11px' }}>
                        CORTEX found {_tiOpenedLots} open entr{_tiOpenedLots !== 1 ? 'ies' : 'y'} but no sell exits yet. Win rate and realized PnL unlock after closed trades.{' '}
                        <span style={{ color: 'rgba(255,255,255,0.35)' }}>Rescan later after exits, or use deeper history when available.</span>
                      </div>
                    ) : (
                      <div style={{ fontSize: '12px', color: 'rgba(148,163,184,0.60)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '14px', lineHeight: 1.5, background: 'rgba(148,163,184,0.03)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: '8px', padding: '8px 11px' }}>
                        No matched trade pairs found in the indexed window.
                      </div>
                    )}
                    {result.walletActivityCoverageNote && (
                      <div style={{ fontSize: '11px', color: 'rgba(251,191,36,0.65)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '10px', lineHeight: 1.55, background: 'rgba(251,191,36,0.03)', border: '1px solid rgba(251,191,36,0.10)', borderRadius: '8px', padding: '7px 11px' }}>
                        <span style={{ fontWeight: 700, color: 'rgba(251,191,36,0.80)' }}>Partial chain coverage:</span>{' '}{result.walletActivityCoverageNote}
                      </div>
                    )}
                    {!isOpenCheck && (
                      <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', fontFamily: 'var(--font-inter, Inter, sans-serif)', marginBottom: ts.economicSignificance === 'micro_sample' || ts.sampleSizeLabel === 'insufficient' ? '8px' : '16px', lineHeight: 1.5 }}>
                        Closed-lot sample only — does not include current open holdings.
                      </div>
                    )}
                    {!isOpenCheck && ts.economicSignificance === 'micro_sample' && (
                      <div style={{ fontSize: '10px', color: '#7dd3fc', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '14px', lineHeight: 1.4 }}>
                        CORTEX found matched trades, but the closed-lot sample is too small financially to grade this wallet yet.
                      </div>
                    )}

                    {!isOpenCheck && result.walletTradeStatsSource === 'historical_promoted_preview' && (
                      <div style={{ fontSize: '10px', color: 'rgba(139,92,246,0.70)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '8px', lineHeight: 1.4 }}>
                        Enhanced with deeper historical coverage.
                      </div>
                    )}

                    {isOpenCheck ? (
                      <div style={{ fontSize: '13px', lineHeight: 1.6, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                        {hasOpenLots ? (
                          <>
                            {/* Open Position Performance */}
                            {(() => {
                              const perf = result.openPositionPerformanceSummary
                              const coverage = perf?.coverageLabel ?? 'cost_basis_only'
                              const openLotsCount = result.walletLotSummary?.openedLots ?? openPos?.openLots ?? 0
                              const costBasis = perf?.totalOpenCostBasisUsd ?? openPos?.totalOpenCostBasisUsd ?? null
                              const fmtUsd2 = (v: number) => `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                              const fmtPct2 = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`

                              // Pick display values based on coverage tier
                              const currentValueLabel = coverage === 'full' ? 'Current Open Value' : coverage === 'partial' ? 'Matched Open Value' : null
                              const unrealizedLabel = coverage === 'full' ? 'Unrealized Est.' : coverage === 'partial' ? 'Matched Unrealized Est.' : null
                              const displayCurrentValue = coverage === 'full' ? (perf?.totalCurrentValueUsd ?? null) : coverage === 'partial' ? (perf?.matchedCurrentOpenValueUsd ?? null) : null
                              const displayUnrealizedPnl = coverage === 'full' ? (perf?.totalUnrealizedPnlUsd ?? null) : coverage === 'partial' ? (perf?.matchedUnrealizedPnlUsd ?? null) : null
                              const displayUnrealizedPct = coverage === 'full' ? (perf?.totalUnrealizedPnlPercent ?? null) : coverage === 'partial' ? (perf?.matchedUnrealizedPnlPercent ?? null) : null

                              const summaryCards = [
                                { label: 'Tracked Entry Cost', value: costBasis != null ? `~${fmtUsd2(costBasis)}` : '—', color: '#e2e8f0', dim: false },
                                ...(currentValueLabel ? [{ label: currentValueLabel, value: displayCurrentValue != null ? fmtUsd2(displayCurrentValue) : '—', color: '#e2e8f0', dim: displayCurrentValue == null }] : []),
                                ...(unrealizedLabel ? [{ label: unrealizedLabel, value: displayUnrealizedPnl != null ? `${displayUnrealizedPnl >= 0 ? '+' : '-'}${fmtUsd2(displayUnrealizedPnl)}${displayUnrealizedPct != null ? ` (${fmtPct2(displayUnrealizedPct)})` : ''}` : '—', color: displayUnrealizedPnl == null ? '#94a3b8' : displayUnrealizedPnl >= 0 ? '#4ade80' : '#f87171', dim: displayUnrealizedPnl == null }] : []),
                              ]

                              const perfTokens = perf?.tokens ?? []
                              const footerNote = coverage === 'full'
                                ? 'Unrealized estimate based on current holdings price. Not realized PnL — still open.'
                                : coverage === 'partial'
                                  ? `Partial coverage — ${perf!.unmatchedSymbols.join(', ')} current value unavailable, excluded from matched unrealized estimate.`
                                  : 'Current value unavailable for open tokens — showing tracked entry cost only.'

                              return (
                                <div style={{ marginBottom: '14px' }}>
                                  {/* Header row */}
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                                    <span style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.14em', color: '#fbbf24', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Open Position Performance</span>
                                    <span style={{ fontSize: '9px', color: 'rgba(251,191,36,0.55)', border: '1px solid rgba(251,191,36,0.18)', background: 'rgba(251,191,36,0.04)', borderRadius: '999px', padding: '1px 7px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                                      {openLotsCount} open entr{openLotsCount !== 1 ? 'ies' : 'y'}
                                    </span>
                                    {coverage === 'partial' && (
                                      <span style={{ fontSize: '9px', color: 'rgba(251,191,36,0.45)', border: '1px solid rgba(251,191,36,0.12)', background: 'rgba(251,191,36,0.03)', borderRadius: '999px', padding: '1px 7px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>partial coverage</span>
                                    )}
                                  </div>
                                  {/* Summary stat grid */}
                                  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${summaryCards.length}, minmax(0,1fr))`, gap: '8px', marginBottom: '10px' }}>
                                    {summaryCards.map(card => (
                                      <div key={card.label} style={{ background: 'rgba(251,191,36,0.04)', border: '1px solid rgba(251,191,36,0.12)', borderRadius: '10px', padding: '10px 11px' }}>
                                        <div style={{ fontSize: '8px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '5px' }}>{card.label}</div>
                                        <div style={{ fontSize: '13px', fontWeight: 800, color: card.dim ? '#94a3b8' : card.color, fontFamily: 'var(--font-inter, Inter, sans-serif)', lineHeight: 1.2 }}>{card.value}</div>
                                      </div>
                                    ))}
                                  </div>
                                  {/* Per-token rows */}
                                  {perfTokens.length > 0 && (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginBottom: '10px' }}>
                                      {perfTokens.map((t, i) => {
                                        const tUnrealized = t.unrealizedPnlUsd
                                        const tUnrealizedPct = t.unrealizedPnlPercent
                                        const tCurrent = t.currentValueUsd
                                        const isUnmatched = tCurrent == null
                                        return (
                                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', background: isUnmatched ? 'rgba(255,255,255,0.01)' : 'rgba(255,255,255,0.02)', border: `1px solid ${isUnmatched ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.05)'}`, borderRadius: '8px', padding: '8px 10px', opacity: isUnmatched ? 0.6 : 1 }}>
                                            <span style={{ fontSize: '12px', fontWeight: 700, color: isUnmatched ? '#94a3b8' : '#fbbf24', fontFamily: 'var(--font-inter, Inter, sans-serif)', minWidth: '56px' }}>{t.symbol}</span>
                                            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{t.openLots} lot{t.openLots !== 1 ? 's' : ''}</span>
                                            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>cost {fmtUsd2(t.costBasisUsd)}</span>
                                            {tCurrent != null && <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>now {fmtUsd2(tCurrent)}</span>}
                                            {tUnrealized != null && (
                                              <span style={{ fontSize: '11px', fontWeight: 700, color: tUnrealized >= 0 ? '#4ade80' : '#f87171', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                                                {tUnrealized >= 0 ? '+' : '-'}{fmtUsd2(tUnrealized)}{tUnrealizedPct != null ? ` (${fmtPct2(tUnrealizedPct)})` : ''}
                                              </span>
                                            )}
                                            {isUnmatched && <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.25)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>current price unavailable</span>}
                                          </div>
                                        )
                                      })}
                                    </div>
                                  )}
                                  {/* Footer note */}
                                  <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.28)', lineHeight: 1.5, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', background: 'rgba(251,191,36,0.03)', border: '1px solid rgba(251,191,36,0.08)', borderRadius: '7px', padding: '7px 10px' }}>
                                    {footerNote} Still open — realized stats unlock after sell exits.
                                  </div>
                                </div>
                              )
                            })()}
                            {/* Win Rate helper for open-lot wallets */}
                            <div style={{ fontSize: '11px', color: 'rgba(251,191,36,0.55)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.55, background: 'rgba(251,191,36,0.03)', border: '1px solid rgba(251,191,36,0.08)', borderRadius: '8px', padding: '9px 12px' }}>
                              <span style={{ fontWeight: 700, color: 'rgba(251,191,36,0.80)' }}>Win rate needs closed buy → sell pairs.</span>{' '}This wallet has open entries only — no sell exits have been detected yet. Win rate and wallet score unlock once matched closed lots are reconstructed.
                            </div>
                          </>
                        ) : (
                          <>
                            <div style={{ color: '#7dd3fc', marginBottom: '10px' }}>
                              {(() => {
                                const mc = result.walletModuleCoverage
                                if (ls && (ls.pricedSwapEvents ?? 0) > 0) return 'CORTEX found priced activity, but buys and sells did not match inside the indexed window yet.'
                                if (mc?.activity && mc.activity.eventCount > 0 && mc.swapDetection.candidateCount === 0) return `${mc.activity.eventCount} transfer events indexed — no reconstructable swap pairs found in checked sample.`
                                if (mc?.swapDetection && mc.swapDetection.candidateCount > 0 && (mc.priceEvidence?.pricedEvents ?? 0) === 0) return 'CORTEX found swap-like movement, but could not verify quote-side price evidence from the available sample.'
                                if (mc?.activity?.reason === 'provider_unavailable') return 'Activity provider unavailable. No FIFO lot matching was possible in this scan.'
                                return 'No matched priced closed lots yet.'
                              })()}
                            </div>
                            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', lineHeight: 1.5, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', background: 'rgba(125,211,252,0.04)', border: '1px solid rgba(125,211,252,0.10)', borderRadius: '8px', padding: '8px 10px' }}>
                              {(() => {
                                const _mc = result.walletModuleCoverage
                                const _unpricedWithCandidates = (_mc?.swapDetection?.candidateCount ?? 0) > 0 && (_mc?.priceEvidence?.pricedEvents ?? 0) === 0
                                if (_unpricedWithCandidates) {
                                  const _reasons = result._debug?.basePnlReconstructionDebug?.sampleUnpricedAfterReceipt ?? []
                                  if (_reasons.some(r => r.finalReason === 'receipt_checked_no_counter_asset')) {
                                    return 'Receipt checked: no USDC/WETH/native ETH quote leg found.'
                                  }
                                  const _firstReason = _reasons[0]?.finalReason
                                  if (_firstReason) return unpricedReasonLabel(_firstReason) + '.'
                                  return 'Price evidence unavailable at trade time. Closed-lot PnL requires priced entry and exit legs.'
                                }
                                return 'Requires matched buys and sells with price evidence. Current scan found transfers but no reconstructable swap pairs. Closed-lot stats not available yet.'
                              })()}
                            </div>
                          </>
                        )}
                      </div>
                    ) : (
                      <>
                        <div className="wallet-intel-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px', marginBottom: '10px' }}>
                          {[
                            { label: 'Closed Lots', value: String(ts.closedLots) },
                            { label: 'Matched Realized PnL', value: ts.realizedPnlUsd !== null ? fmtSignedUSD(ts.realizedPnlUsd) : '—', pnl: ts.realizedPnlUsd },
                            { label: 'Return', value: ts.realizedPnlPercent !== null ? `${ts.realizedPnlPercent >= 0 ? '+' : ''}${ts.realizedPnlPercent.toFixed(1)}%` : '—', pnl: ts.realizedPnlPercent },
                            { label: 'Tokens Traded', value: String(ts.uniqueTokensTraded) },
                            { label: 'Wins', value: String(ts.winningClosedLots) },
                            { label: 'Losses', value: String(ts.losingClosedLots) },
                          ].map(card => (
                            <div key={card.label} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '12px' }}>
                              <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '7px' }}>{card.label}</div>
                              <div style={{ fontSize: '18px', fontWeight: 800, fontFamily: 'var(--font-inter, Inter, sans-serif)', color: 'pnl' in card && card.pnl !== null && card.pnl !== undefined ? (card.pnl >= 0 ? '#4ade80' : '#f87171') : '#e2e8f0' }}>{card.value}</div>
                            </div>
                          ))}
                        </div>

                        {(() => {
                          const rawWinRate = ts.closedLots > 0 ? ts.winRatePercent ?? (ts.winningClosedLots / ts.closedLots) * 100 : null
                          const isBreakEvenOnly = ts.isBreakEvenOnly === true || (ts.closedLots > 0 && ts.winningClosedLots === 0 && ts.losingClosedLots === 0 && ts.breakEvenClosedLots === ts.closedLots)
                          const isSmallSample = ts.closedLots > 0 && !hasEnough
                          const earlyCards: Array<{ label: string; value: string | null; locked?: boolean; lockNote?: string; pnl?: number | null; raw?: boolean; breakEven?: boolean }> = [
                            {
                              label: hasEnough ? 'Win Rate' : isSmallSample ? 'Win Rate (raw)' : 'Win Rate',
                              value: isBreakEvenOnly ? 'Break-even only' : rawWinRate !== null ? `${rawWinRate.toFixed(1)}%` : null,
                              locked: !isBreakEvenOnly && rawWinRate === null,
                              lockNote: officialWinRateLockCopy(ts),
                              raw: !isBreakEvenOnly && isSmallSample && rawWinRate !== null,
                              breakEven: isBreakEvenOnly,
                            },
                            { label: 'Avg PnL / Lot', value: ts.avgPnlUsdPerClosedLot !== null ? fmtSignedUSD(ts.avgPnlUsdPerClosedLot) : '—', pnl: ts.avgPnlUsdPerClosedLot },
                            { label: 'Avg Return / Lot', value: ts.avgReturnPercentPerClosedLot !== null ? `${ts.avgReturnPercentPerClosedLot >= 0 ? '+' : ''}${ts.avgReturnPercentPerClosedLot.toFixed(1)}%` : '—', pnl: ts.avgReturnPercentPerClosedLot },
                            { label: 'Median Return', value: ts.medianReturnPercentPerClosedLot !== null ? `${ts.medianReturnPercentPerClosedLot >= 0 ? '+' : ''}${ts.medianReturnPercentPerClosedLot.toFixed(1)}%` : '—', pnl: ts.medianReturnPercentPerClosedLot },
                            { label: 'Avg Hold Time', value: fmtHoldTime(ts.avgHoldingTimeSeconds) },
                            { label: 'Median Hold Time', value: fmtHoldTime(ts.medianHoldingTimeSeconds) },
                          ]
                          return (
                            <div className="wallet-intel-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px', marginBottom: '14px' }}>
                              {earlyCards.map(card => (
                                <div key={card.label} style={{ background: card.breakEven ? 'rgba(148,163,184,0.05)' : card.raw ? 'rgba(251,191,36,0.05)' : 'rgba(255,255,255,0.03)', border: `1px solid ${card.breakEven ? 'rgba(148,163,184,0.18)' : card.raw ? 'rgba(251,191,36,0.20)' : 'rgba(255,255,255,0.07)'}`, borderRadius: '12px', padding: '12px' }}>
                                  <div style={{ fontSize: '9px', color: card.breakEven ? 'rgba(148,163,184,0.65)' : card.raw ? 'rgba(251,191,36,0.65)' : 'rgba(255,255,255,0.28)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '7px' }}>{card.label}</div>
                                  {card.locked ? (
                                    <div style={{ fontSize: '11px', color: '#7dd3fc', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.4 }}>
                                      Not calculated yet
                                      <div style={{ fontSize: '9px', color: 'rgba(125,211,252,0.55)', marginTop: '3px' }}>{card.lockNote}</div>
                                    </div>
                                  ) : (
                                    <div style={{ fontSize: card.breakEven ? '13px' : '16px', fontWeight: 800, fontFamily: 'var(--font-inter, Inter, sans-serif)', color: card.breakEven ? 'rgba(148,163,184,0.80)' : card.raw ? '#fbbf24' : ('pnl' in card && card.pnl !== null && card.pnl !== undefined ? (card.pnl >= 0 ? '#4ade80' : '#f87171') : '#e2e8f0') }}>{card.value}</div>
                                  )}
                                  {card.breakEven && <div style={{ fontSize: '9px', color: 'rgba(148,163,184,0.50)', marginTop: '3px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>no decisive trades · score unlocks at 10+</div>}
                                  {card.raw && !card.breakEven && <div style={{ fontSize: '9px', color: 'rgba(251,191,36,0.50)', marginTop: '3px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>raw · score unlocks at 10+</div>}
                                </div>
                              ))}
                            </div>
                          )
                        })()}

                        {!hasEnough && ts.sampleWarning && (
                          <div style={{ fontSize: '11px', color: '#fbbf24', background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.15)', borderRadius: '8px', padding: '8px 12px', marginBottom: '10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                            {ts.sampleWarning} Stats only include matched buy→sell lots. Current holdings and unmatched sells are not counted as realized PnL.
                          </div>
                        )}
                        {!hasEnough && !ts.sampleWarning && (
                          <div style={{ fontSize: '11px', color: '#fbbf24', background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.15)', borderRadius: '8px', padding: '8px 12px', marginBottom: '10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                            Early closed-lot sample — stats only include matched buy→sell lots. Current holdings and unmatched sells are not counted as realized PnL.
                          </div>
                        )}

                        {ls && (ls.unmatchedBuys > 0 || ls.unmatchedSells > 0) && (
                          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.32)', lineHeight: 1.5, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                            {ls.unmatchedBuys > 0 && <span>{ls.unmatchedBuys} open buy lot{ls.unmatchedBuys !== 1 ? 's are' : ' is'} still open. </span>}
                            {ls.unmatchedSells > 0 && <span>{ls.unmatchedSells} sell{ls.unmatchedSells !== 1 ? 's have' : ' has'} no matched buy inside the indexed window, so CORTEX does not score them as wins/losses.</span>}
                          </div>
                        )}

                        {(result.walletClosedTradeSamples?.length ?? 0) > 0 && (() => {
                          const samples = result.walletClosedTradeSamples!
                          const confColor = (c: string) => c === 'high' ? '#4ade80' : c === 'medium' ? '#fbbf24' : '#94a3b8'
                          const fmtAmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : n >= 1 ? n.toFixed(2) : n.toFixed(4)
                          const fmtPx = (v: number | null) => v === null ? '—' : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toPrecision(3)}`
                          const explorerBase = (chain: string, hash: string) => {
                            if (chain === 'base') return `https://basescan.org/tx/${hash}`
                            if (chain === 'eth') return `https://etherscan.io/tx/${hash}`
                            return null
                          }
                          return (
                            <div style={{ marginTop: '18px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                                <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Matched Closed Trades</div>
                                <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Sample of reconstructed buy → sell lots used in this wallet read.</span>
                              </div>
                              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.28)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.5, marginBottom: '10px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px', padding: '8px 10px' }}>
                                Matched PnL is calculated only from reconstructed buy → sell lots. It excludes current holdings, open buy lots, and sells with no matched buy inside the indexed window.
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                {samples.map((s, i) => {
                                  const pnlColor = s.realizedPnlUsd === null ? '#94a3b8' : s.realizedPnlUsd >= 0 ? '#4ade80' : '#f87171'
                                  const holdStr = fmtHoldTime(s.holdingTimeSeconds)
                                  const pnlStr = s.realizedPnlUsd !== null ? `${s.realizedPnlUsd >= 0 ? '+' : '-'}$${Math.abs(s.realizedPnlUsd).toFixed(2)}` : '—'
                                  const pctStr = s.realizedPnlPercent !== null ? ` (${s.realizedPnlPercent >= 0 ? '+' : ''}${s.realizedPnlPercent.toFixed(1)}%)` : ''
                                  const vStatus = s.verificationStatus ?? 'not_available'
                                  const entryUrl = s.entryTxHash ? explorerBase(s.chain, s.entryTxHash) : null
                                  const exitUrl = s.exitTxHash ? explorerBase(s.chain, s.exitTxHash) : null
                                  return (
                                    <div key={i} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '10px', padding: '10px 12px', display: 'flex', flexWrap: 'wrap', gap: '6px 14px', alignItems: 'flex-start' }}>
                                      <div style={{ minWidth: '70px' }}>
                                        <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.10em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '3px' }}>Token</div>
                                        <div style={{ fontSize: '13px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{s.tokenSymbol}</div>
                                        <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.20)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginTop: '2px' }}>{s.chain.toUpperCase()}</div>
                                      </div>
                                      <div style={{ minWidth: '110px' }}>
                                        <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.10em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '3px' }}>Entry → Exit</div>
                                        <div style={{ fontSize: '12px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{fmtPx(s.entryPriceUsd)} → {fmtPx(s.exitPriceUsd)}</div>
                                        <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.20)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginTop: '2px' }}>{fmtAmt(s.amountClosed)} units</div>
                                      </div>
                                      <div style={{ minWidth: '90px' }}>
                                        <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.10em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '3px' }}>PnL</div>
                                        <div style={{ fontSize: '13px', fontWeight: 700, color: pnlColor, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{pnlStr}</div>
                                        {pctStr && <div style={{ fontSize: '10px', color: pnlColor, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', opacity: 0.7 }}>{pctStr}</div>}
                                      </div>
                                      <div style={{ minWidth: '70px' }}>
                                        <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.10em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '3px' }}>Hold</div>
                                        <div style={{ fontSize: '12px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{holdStr}</div>
                                      </div>
                                      <div>
                                        <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.10em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '3px' }}>Conf</div>
                                        <div style={{ fontSize: '10px', color: confColor(s.confidence), fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', fontWeight: 600 }}>{s.confidence}</div>
                                      </div>
                                      <div style={{ flexBasis: '100%', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '2px' }}>
                                        {vStatus === 'verifiable' && entryUrl && (
                                          <a href={entryUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '9px', color: '#7dd3fc', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', textDecoration: 'none', border: '1px solid rgba(125,211,252,0.20)', borderRadius: '6px', padding: '2px 7px' }}>Verify entry ↗</a>
                                        )}
                                        {vStatus === 'verifiable' && exitUrl && (
                                          <a href={exitUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '9px', color: '#7dd3fc', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', textDecoration: 'none', border: '1px solid rgba(125,211,252,0.20)', borderRadius: '6px', padding: '2px 7px' }}>Verify exit ↗</a>
                                        )}
                                        {vStatus === 'partial' && (
                                          <>
                                            {entryUrl && <a href={entryUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '9px', color: '#7dd3fc', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', textDecoration: 'none', border: '1px solid rgba(125,211,252,0.20)', borderRadius: '6px', padding: '2px 7px' }}>Verify entry ↗</a>}
                                            {exitUrl && <a href={exitUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '9px', color: '#7dd3fc', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', textDecoration: 'none', border: '1px solid rgba(125,211,252,0.20)', borderRadius: '6px', padding: '2px 7px' }}>Verify exit ↗</a>}
                                            <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.30)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '6px', padding: '2px 7px' }}>partial proof</span>
                                          </>
                                        )}
                                        {vStatus === 'not_available' && (
                                          <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.22)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>proof unavailable</span>
                                        )}
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          )
                        })()}
                      </>
                    )}
                    </div>{/* end padding wrapper */}
                  </div>
                )
              })()}

              {(() => {
                const ts = result.walletTradeStatsSummary
                const closedLots = ts?.closedLots ?? 0
                if (!ts || closedLots === 0) return null
                const hasEnough = isTradeStatsGradeable(ts)
                const closedTradesDisplay = closedLots > 0
                  ? `${closedLots} reconstructed`
                  : 'No closed lots yet'
                const earlyWinPct = closedLots > 0 && ts ? Math.round((ts.winningClosedLots / ts.closedLots) * 100) : null
                const earlyLossPct = closedLots > 0 && ts ? Math.round((ts.losingClosedLots / ts.closedLots) * 100) : null
                const winRateLabel = !hasEnough && closedLots > 0 ? 'Matched Closed-Lot Read' : 'Win Rate'
                const lossRateLabel = !hasEnough && closedLots > 0 ? 'Matched Losing Lots' : 'Loss Rate'
                const winRateDisplay = hasEnough && ts?.winRatePercent !== null && ts?.winRatePercent !== undefined
                  ? `${ts.winRatePercent.toFixed(1)}%`
                  : !hasEnough && ts && closedLots > 0
                    ? `${ts.winningClosedLots} matched positive lot${ts.winningClosedLots !== 1 ? 's' : ''}${ts.breakEvenClosedLots > 0 ? `, ${ts.breakEvenClosedLots} break-even` : ''}`
                    : 'Open Check'
                const lossRateDisplay = hasEnough
                  ? fmtOpenPct(walletIntel.lossRate)
                  : !hasEnough && ts && closedLots > 0
                    ? (ts.losingClosedLots === 0 ? 'None found in matched sample' : `${ts.losingClosedLots} matched losing lot${ts.losingClosedLots !== 1 ? 's' : ''}`)
                    : 'Open Check'
                const avgMatchedWin = deriveAverageMatchedWinUsd(result)
                const avgMatchedLoss = deriveAverageMatchedLossUsd(result)
                const avgProfitDisplay = avgMatchedWin !== null
                  ? fmtSignedUSD(avgMatchedWin)
                  : hasEnough ? fmtSignedUSD(walletIntel.pnl.avgWin)
                  : closedLots > 0 && ts.winningClosedLots === 0 ? 'No winning closed lots yet'
                  : 'Open Check'
                const avgLossDisplay = ts && closedLots > 0 && ts.losingClosedLots === 0
                  ? 'No matched losing closed lots found'
                  : avgMatchedLoss !== null ? fmtSignedUSD(avgMatchedLoss) : 'Open Check'
                const biggestWinDisplay = hasEnough
                  ? (ts?.largestWinUsd !== null && ts?.largestWinUsd !== undefined ? fmtSignedUSD(ts.largestWinUsd) : fmtSignedUSD(walletIntel.pnl.biggestWin))
                  : ts?.largestWinUsd !== null && ts?.largestWinUsd !== undefined && closedLots > 0
                    ? fmtSignedUSD(ts.largestWinUsd)
                    : closedLots > 0 && ts.winningClosedLots === 0 ? 'No winning closed lots yet'
                    : 'Open Check'
                const biggestLossDisplay = ts && closedLots > 0 && ts.losingClosedLots === 0
                  ? 'No matched losing closed lots found'
                  : ts?.largestLossUsd !== null && ts?.largestLossUsd !== undefined
                    ? fmtSignedUSD(ts.largestLossUsd)
                    : 'Open Check'
                const avgHoldDisplay = walletIntel.tradeBehavior?.avgHoldTime ?? 'Open Check'
                return (
                  <div style={{ background: 'rgba(6,10,18,0.95)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '18px', overflow: 'hidden' }}>
                    <div style={{ padding: '18px 24px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div style={{ width: '3px', height: '16px', borderRadius: '2px', background: 'linear-gradient(180deg, #2DD4BF, rgba(45,212,191,0.3))', flexShrink: 0 }} />
                      <span className="ws-section-header" style={{ color: '#e2e8f0' }}>Trade Behavior</span>
                    </div>
                    <div style={{ padding: '20px 24px' }}>
                    <div className="wallet-intel-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '10px' }}>
                      {[
                        { label: winRateLabel, value: winRateDisplay, early: !hasEnough && closedLots > 0 },
                        { label: lossRateLabel, value: lossRateDisplay, early: !hasEnough && closedLots > 0 },
                        { label: 'Avg Matched Win', value: avgProfitDisplay },
                        { label: 'Avg Matched Loss', value: avgLossDisplay, noLoss: avgLossDisplay === 'No matched losing closed lots found' },
                        { label: 'Biggest Matched Win', value: biggestWinDisplay },
                        { label: 'Biggest Matched Loss', value: biggestLossDisplay, noLoss: biggestLossDisplay === 'No matched losing closed lots found' },
                        { label: 'Avg Hold Time', value: avgHoldDisplay },
                        { label: 'Closed Trades', value: closedTradesDisplay },
                      ].map(card => (
                        <div key={card.label} style={{ background: ('early' in card && card.early) ? 'rgba(167,139,250,0.06)' : ('noLoss' in card && card.noLoss) ? 'rgba(45,212,191,0.05)' : 'rgba(255,255,255,0.025)', border: `1px solid ${('early' in card && card.early) ? 'rgba(167,139,250,0.18)' : ('noLoss' in card && card.noLoss) ? 'rgba(45,212,191,0.18)' : 'rgba(255,255,255,0.06)'}`, borderRadius: '12px', padding: '14px' }}>
                          <div className="ws-stat-label" style={{ color: ('early' in card && card.early) ? 'rgba(167,139,250,0.60)' : ('noLoss' in card && card.noLoss) ? 'rgba(45,212,191,0.60)' : undefined }}>{card.label}</div>
                          <div style={{ fontSize: '17px', fontWeight: 800, fontFamily: 'var(--font-inter, Inter, sans-serif)', letterSpacing: '-0.01em', lineHeight: 1.25, color: ('early' in card && card.early) ? '#a78bfa' : ('noLoss' in card && card.noLoss) ? '#2DD4BF' : String(card.value).includes('Open Check') || String(card.value).includes('Locked') || String(card.value).includes('No closed') || String(card.value).includes('No winning') ? '#7dd3fc' : '#e2e8f0' }}>{card.value}</div>
                        </div>
                      ))}
                    </div>
                    {!hasEnough && closedLots > 0 && (
                      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.28)', marginTop: '14px', fontFamily: 'var(--font-inter, Inter, sans-serif)', lineHeight: 1.6 }}>
                        Not calculated yet — requires 10+ verified closed lots. This does not prove the wallet has never lost money.
                      </div>
                    )}
                    </div>
                  </div>
                )
              })()}

              <div style={{ background: 'linear-gradient(135deg, #080c14 0%, rgba(45,212,191,0.02) 100%)', border: '1px solid rgba(45,212,191,0.12)', borderRadius: '18px', padding: '22px 26px', boxShadow: '0 0 30px rgba(45,212,191,0.04)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2DD4BF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
                    <path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/>
                  </svg>
                  <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.18em', color: 'rgba(45,212,191,0.80)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>AI Wallet Personality</div>
                </div>
                <p style={{ margin: 0, color: '#cbd5e1', fontSize: '13px', lineHeight: 1.80, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{walletIntel.personalitySummary}</p>
                {(result.walletTradeStatsSummary?.closedLots ?? 0) > 0 && (
                  <p style={{ margin: '12px 0 0', color: 'rgba(255,255,255,0.32)', fontSize: '11px', lineHeight: 1.60, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', padding: '8px 10px', border: '1px solid rgba(255,255,255,0.05)' }}>
                    Portfolio value reflects current holdings; trade stats only reflect reconstructed closed lots, so large open holdings are not included in realized PnL.
                  </p>
                )}
                {walletIntel.openChecks.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '7px', marginTop: '16px' }}>
                    {walletIntel.openChecks.map(check => (
                      <span key={check} style={{ fontSize: '10px', color: '#7dd3fc', border: '1px solid rgba(125,211,252,0.16)', background: 'rgba(56,189,248,0.05)', borderRadius: '8px', padding: '5px 10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.4 }}>{check}</span>
                    ))}
                  </div>
                )}
              </div>

              {walletIntel.recentTrades.length > 0 && <div style={{ background: '#080c14', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '16px', overflow: 'hidden' }}>
                <div style={{ padding: '18px 22px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
                  <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.18em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Recent Trades</div>
                  <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.28)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Closed trades only</div>
                </div>
                <div className="wallet-trade-table">
                  <div style={{ minWidth: '760px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr repeat(6, 1fr)', gap: '10px', padding: '10px 22px', fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                      {['Token', 'Entry', 'Exit', 'PnL', 'Hold Time', 'Size', 'Status'].map(h => <div key={h}>{h}</div>)}
                    </div>
                    {walletIntel.recentTrades.slice(0, 8).map((trade, idx) => (
                      <div key={`${trade.token}-${idx}`} style={{ display: 'grid', gridTemplateColumns: '1.2fr repeat(6, 1fr)', gap: '10px', padding: '12px 22px', fontSize: '12px', color: '#cbd5e1', borderBottom: idx === walletIntel.recentTrades.slice(0, 8).length - 1 ? 'none' : '1px solid rgba(255,255,255,0.045)' }}>
                        <div style={{ fontWeight: 800 }}>{trade.token || 'Open Check'}</div>
                        <div>{trade.entry === null ? 'Open Check' : fmtUSD(trade.entry)}</div>
                        <div>{trade.exit === null ? 'Open Check' : fmtUSD(trade.exit)}</div>
                        <div style={{ color: trade.pnl === null ? '#7dd3fc' : trade.pnl >= 0 ? '#4ade80' : '#f87171' }}>{fmtSignedUSD(trade.pnl)}</div>
                        <div>{trade.holdTime ?? 'Open Check'}</div>
                        <div>{trade.size === null ? 'Open Check' : fmtUSD(trade.size)}</div>
                        <div>{trade.status || 'Open Check'}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>}

              {showLegacyPortfolioCards && <div className="ws-stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
                {[
                  { label: 'Portfolio Value', value: result.totalValue > 0 ? fmtUSD(result.totalValue) : result.holdings.length > 0 ? 'Value pending in current checks' : 'No signal in checked window', sub: 'Portfolio read active', color: '#2DD4BF' },
                  { label: 'Token Count', value: sorted.length.toLocaleString(), sub: 'Visible token balances', color: '#a78bfa' },
                  { label: 'Largest Holding', value: largest ? largest.symbol : 'No signal in checked window', sub: largest ? fmtUSD(largest.value) : 'No holdings found', color: '#fbbf24' },
                  { label: 'Data Quality', value: quality, sub: quality === 'Release view' ? 'Portfolio read active' : 'No fresh Base activity signal', color: quality === 'Release view' ? '#94a3b8' : '#fbbf24' },
                ].map(card => (
                  <div key={card.label} style={{
                    background: '#080c14',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '14px', padding: '18px 20px',
                  }}>
                    <div style={{
                      fontSize: '10px', fontWeight: 700, letterSpacing: '0.13em',
                      color: 'rgba(255,255,255,0.32)', textTransform: 'uppercase',
                      fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                      marginBottom: '8px',
                    }}>
                      {card.label}
                    </div>
                    <div style={{
                      fontSize: '24px', fontWeight: 800, color: card.color,
                      fontFamily: 'var(--font-inter, Inter, sans-serif)',
                      marginBottom: '5px', letterSpacing: '-0.01em', lineHeight: 1.1,
                    }}>
                      {card.value}
                    </div>
                    <div style={{
                      fontSize: '11px', color: 'rgba(255,255,255,0.25)',
                      fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                    }}>
                      {card.sub}
                    </div>
                  </div>
                ))}
              </div>}


              <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap', alignItems: 'center' }}>
                {[
                  { label: 'Portfolio read: CORTEX', color: 'rgba(45,212,191,0.50)', bg: 'rgba(45,212,191,0.04)', border: 'rgba(45,212,191,0.14)' },
                  ...(hasUsefulActivity ? [{ label: 'Base activity: CORTEX', color: 'rgba(45,212,191,0.50)', bg: 'rgba(45,212,191,0.04)', border: 'rgba(45,212,191,0.14)' }] : []),
                  { label: 'Release view', color: 'rgba(148,163,184,0.50)', bg: 'rgba(148,163,184,0.03)', border: 'rgba(148,163,184,0.12)' },
                ].map((chip) => (
                  <span key={chip.label} style={{ fontSize: '10px', color: chip.color, background: chip.bg, border: `1px solid ${chip.border}`, borderRadius: '999px', padding: '4px 10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', letterSpacing: '0.06em' }}>
                    {chip.label}
                  </span>
                ))}
              </div>


              {/* ── Behavior card ────────────────────────────────────────────────── */}
              {hasUsefulActivity && result.walletBehavior?.status === 'ok' && (
                <div style={{
                  background: '#080c14',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '14px', padding: '18px 22px',
                }}>
                  <div style={{
                    fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em',
                    color: '#2DD4BF', textTransform: 'uppercase',
                    fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                    marginBottom: '14px',
                  }}>
                    Base Activity
                  </div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginBottom: 10 }}>Behavior scope: Base only</div>
                                    <div className="ws-behavior-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '12px' }}>
                    {[
                      { label: 'Recent Txs', value: result.walletBehavior.txCount ?? '—' },
                      { label: 'Active Days', value: result.walletBehavior.activeDays ?? '—' },
                      { label: 'Inbound', value: result.walletBehavior.inboundCount ?? '—' },
                      { label: 'Outbound', value: result.walletBehavior.outboundCount ?? '—' },
                    ].map(s => (
                      <div key={s.label}>
                        <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.28)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.10em' }}>{s.label}</div>
                        <div style={{ fontSize: '20px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{String(s.value)}</div>
                      </div>
                    ))}
                  </div>
                  {result.walletBehavior.topTokens.length > 0 && (
                    <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '6px' }}>
                      <span style={{ color: 'rgba(255,255,255,0.28)' }}>Top tokens: </span>
                      {result.walletBehavior.topTokens.slice(0, 5).join(', ')}
                    </div>
                  )}
                  {result.walletBehavior.stablecoinActivity && (
                    <div style={{ fontSize: '11px', color: '#a78bfa', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                      Stablecoin movement detected
                    </div>
                  )}
                  {result.walletBehavior.txCount === 0 && (
                    <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: 8 }}>
                      {hasActivityProviderUnavailable(result) ? ACTIVITY_UNAVAILABLE_COPY : 'No recent Base activity found in checked window.'}
                    </div>
                  )}
                </div>
              )}

              {!hasCortexFacts && <div style={{
                background: '#080c14',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '14px', padding: '16px 18px'
              }}>
                <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.12em', color: '#2DD4BF', textTransform: 'uppercase', marginBottom: 10 }}>CORTEX Wallet Read</div>
                {(() => { const read = getCortexRead(result); return (
                  <>
                    <p style={{ fontSize: 13, color: '#cbd5e1', margin: '0 0 8px' }}>{read.summary}</p>
                    {read.bullets.map((bline, idx) => <p key={idx} style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', margin: '0 0 4px' }}>• {bline}</p>)}
                    {read.tradeBullet && (
                      <p style={{ fontSize: 12, color: '#a78bfa', margin: '0 0 4px', fontWeight: 600 }}>• {read.tradeBullet}</p>
                    )}
                    {read.earlyWinBullet && (
                      <p style={{ fontSize: 12, color: '#a78bfa', margin: '0 0 4px', fontWeight: 600 }}>• {read.earlyWinBullet}</p>
                    )}
                    {read.caveat && <p style={{ fontSize: 11, color: '#94a3b8', margin: '8px 0 0' }}>{read.caveat}</p>}
                  </>
                )})()}
              </div>}

              {sorted.length > 0 ? (() => {
                const PREVIEW = 10
                const visible = showAllHoldings ? sorted : sorted.slice(0, PREVIEW)
                const hidden  = sorted.length - PREVIEW
                const chainAbbr = (raw: string | null): string => {
                  if (!raw) return ''
                  const n = raw.replace(/-mainnet$/, '').replace(/-/g, ' ').toLowerCase().trim()
                  if (n === 'base') return 'BASE'
                  if (n === 'ethereum') return 'ETH'
                  if (n === 'arbitrum one' || n === 'arbitrum') return 'ARB'
                  if (n === 'optimism' || n === 'op mainnet') return 'OP'
                  if (n === 'polygon') return 'POLY'
                  if (n === 'avalanche') return 'AVAX'
                  if (n === 'bsc' || n === 'binance smart chain') return 'BSC'
                  if (n === 'solana') return 'SOL'
                  if (n === 'zksync' || n === 'zksync era') return 'ZKS'
                  if (n === 'linea') return 'LINEA'
                  if (n === 'scroll') return 'SCRL'
                  return n.slice(0, 5).toUpperCase()
                }
                const chainStyle = (raw: string | null): { bg: string; border: string; color: string } => {
                  const abbr = chainAbbr(raw)
                  if (abbr === 'BASE')  return { bg: 'rgba(0,82,255,0.12)',    border: '1px solid rgba(0,82,255,0.28)',    color: '#6ea8ff' }
                  if (abbr === 'ETH')   return { bg: 'rgba(98,126,234,0.12)',  border: '1px solid rgba(98,126,234,0.28)',  color: '#a3b4f7' }
                  if (abbr === 'ARB')   return { bg: 'rgba(40,160,240,0.12)',  border: '1px solid rgba(40,160,240,0.28)',  color: '#7dd3fc' }
                  if (abbr === 'OP')    return { bg: 'rgba(255,4,32,0.10)',    border: '1px solid rgba(255,4,32,0.25)',    color: '#fca5a5' }
                  if (abbr === 'POLY')  return { bg: 'rgba(130,71,229,0.12)', border: '1px solid rgba(130,71,229,0.28)', color: '#c4b5fd' }
                  return { bg: 'rgba(139,92,246,0.10)', border: '1px solid rgba(139,92,246,0.24)', color: '#c4b5fd' }
                }
                return (
                  <div style={{
                    background: 'rgba(6,10,18,0.95)',
                    border: '1px solid rgba(45,212,191,0.12)',
                    borderRadius: '18px', overflow: 'hidden',
                  }}>
                    {/* Section header */}
                    <div style={{ padding: '18px 24px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div style={{ width: '3px', height: '16px', borderRadius: '2px', background: 'linear-gradient(180deg, #2DD4BF, rgba(45,212,191,0.3))', flexShrink: 0 }} />
                      <span className="ws-section-header" style={{ color: '#e2e8f0' }}>Holdings</span>
                      <span style={{ fontSize: '10px', fontWeight: 600, color: 'rgba(255,255,255,0.28)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', padding: '2px 8px', borderRadius: '99px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>{sorted.length} tokens</span>
                      {result.totalValue > 0 && (
                        <span style={{ fontSize: '13px', fontWeight: 700, color: '#2DD4BF', fontFamily: 'var(--font-inter, Inter, sans-serif)', marginLeft: 'auto', letterSpacing: '-0.01em' }}>
                          {fmtUSD(result.totalValue)}
                        </span>
                      )}
                    </div>

                    {/* Mobile cards */}
                    <div className="md:hidden" style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '16px' }}>
                      {visible.map((h, i) => {
                        const up = (h.change24h ?? 0) >= 0
                        const abbr = chainAbbr(h.chain)
                        const cs = chainStyle(h.chain)
                        return (
                          <div key={`m-${i}`} style={{ border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '14px', background: 'rgba(255,255,255,0.015)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                                {h.icon
                                  ? <img src={h.icon} alt={h.symbol} width={32} height={32} style={{ borderRadius: '50%', flexShrink: 0 }} onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                                  : <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'linear-gradient(135deg,#2DD4BF,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, color: '#04101a', flexShrink: 0 }}>{h.symbol.slice(0,2).toUpperCase()}</div>
                                }
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontSize: 14, fontWeight: 700, color: '#f1f5f9', fontFamily: 'var(--font-inter, Inter, sans-serif)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.symbol}</div>
                                  {h.name && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', fontFamily: 'var(--font-inter, Inter, sans-serif)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '120px' }}>{h.name}</div>}
                                </div>
                              </div>
                              {abbr && <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.08em', padding: '2px 7px', borderRadius: 999, background: cs.bg, border: cs.border, color: cs.color, flexShrink: 0, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{abbr}</span>}
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
                              <div><div style={{ fontSize: 9, color: 'rgba(255,255,255,0.28)', fontFamily: 'var(--font-plex-mono, monospace)', textTransform: 'uppercase', letterSpacing: '0.10em', marginBottom: 3 }}>Balance</div><div style={{ fontSize: 13, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', color: 'rgba(255,255,255,0.55)' }}>{fmtBalance(h.balance)}</div></div>
                              <div><div style={{ fontSize: 9, color: 'rgba(255,255,255,0.28)', fontFamily: 'var(--font-plex-mono, monospace)', textTransform: 'uppercase', letterSpacing: '0.10em', marginBottom: 3 }}>Value</div><div style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--font-inter, Inter, sans-serif)', color: '#e2e8f0' }}>{h.value > 0 ? fmtUSD(h.value) : '—'}</div></div>
                              <div><div style={{ fontSize: 9, color: 'rgba(255,255,255,0.28)', fontFamily: 'var(--font-plex-mono, monospace)', textTransform: 'uppercase', letterSpacing: '0.10em', marginBottom: 3 }}>24h</div><div style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', color: h.change24h === null ? 'rgba(255,255,255,0.22)' : up ? '#2DD4BF' : '#ef4444' }}>{h.change24h === null ? '—' : fmtPct(h.change24h)}</div></div>
                            </div>
                          </div>
                        )
                      })}
                    </div>

                    {/* Table header */}
                    <div className="ws-holdings-header" style={{
                      display: 'grid', gridTemplateColumns: '1fr 110px 120px 88px',
                      padding: '10px 24px',
                      borderBottom: '1px solid rgba(255,255,255,0.05)',
                      fontSize: '9px', fontWeight: 700, letterSpacing: '0.14em',
                      color: 'rgba(255,255,255,0.22)', textTransform: 'uppercase',
                      fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                      background: 'rgba(255,255,255,0.01)',
                    }}>
                      <span>Token</span>
                      <span style={{ textAlign: 'right' }}>Balance</span>
                      <span style={{ textAlign: 'right' }}>Value USD</span>
                      <span style={{ textAlign: 'right' }}>24h</span>
                    </div>

                    {/* Rows */}
                    {visible.map((h, i) => {
                      const up = (h.change24h ?? 0) >= 0
                      const abbr = chainAbbr(h.chain)
                      const cs = chainStyle(h.chain)
                      const isLast = i === visible.length - 1 && (showAllHoldings || sorted.length <= PREVIEW)
                      return (
                        <div
                          key={i}
                          className="ws-row ws-holdings-row"
                          style={{
                            display: 'grid', gridTemplateColumns: '1fr 110px 120px 88px',
                            padding: '13px 24px',
                            borderBottom: isLast ? 'none' : '1px solid rgba(255,255,255,0.035)',
                            alignItems: 'center',
                            transition: 'background 0.12s',
                          }}
                        >
                          {/* Token col */}
                          <div className="ws-col-token" style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                            {h.icon ? (
                              <img src={h.icon} alt={h.symbol} width={32} height={32}
                                style={{ borderRadius: '50%', flexShrink: 0 }}
                                onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                              />
                            ) : (
                              <div style={{
                                width: '32px', height: '32px', borderRadius: '50%', flexShrink: 0,
                                background: 'linear-gradient(135deg,#2DD4BF,#8b5cf6)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: '11px', fontWeight: 800, color: '#04101a',
                              }}>
                                {h.symbol.slice(0, 2).toUpperCase()}
                              </div>
                            )}
                            <div style={{ minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                                <span style={{
                                  fontSize: '14px', fontWeight: 600, color: '#f1f5f9',
                                  fontFamily: 'var(--font-inter, Inter, sans-serif)',
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                }}>
                                  {h.symbol}
                                </span>
                                {abbr && (
                                  <span style={{
                                    fontSize: '9px', fontWeight: 700, letterSpacing: '0.08em',
                                    padding: '1px 6px', borderRadius: '99px', flexShrink: 0,
                                    background: cs.bg, border: cs.border, color: cs.color,
                                    fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                                  }}>
                                    {abbr}
                                  </span>
                                )}
                              </div>
                              {h.name && (
                                <span style={{
                                  fontSize: '11px', color: 'rgba(255,255,255,0.28)',
                                  fontFamily: 'var(--font-inter, Inter, sans-serif)',
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                  display: 'block', maxWidth: '120px',
                                }}>
                                  {h.name}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Balance */}
                          <div className="ws-col-balance" style={{
                            textAlign: 'right', fontSize: '13px', color: 'rgba(255,255,255,0.45)',
                            fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                          }}>
                            {fmtBalance(h.balance)}
                          </div>

                          {/* Value */}
                          <div className="ws-col-value" style={{
                            textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#e2e8f0',
                            fontFamily: 'var(--font-inter, Inter, sans-serif)',
                          }}>
                            {fmtUSD(h.value)}
                          </div>

                          {/* 24h */}
                          <div className="ws-col-change" style={{
                            textAlign: 'right', fontSize: '13px', fontWeight: 600,
                            color: h.change24h === null
                              ? 'rgba(255,255,255,0.18)'
                              : up ? '#2DD4BF' : '#ef4444',
                            fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                          }}>
                            {fmtPct(h.change24h)}
                          </div>
                        </div>
                      )
                    })}

                    {/* Expand / collapse button */}
                    {sorted.length > PREVIEW && (
                      <button
                        onClick={() => setShowAllHoldings(v => !v)}
                        style={{
                          width: '100%', padding: '14px 24px',
                          background: 'rgba(255,255,255,0.01)',
                          border: 'none', borderTop: '1px solid rgba(255,255,255,0.05)',
                          cursor: 'pointer', display: 'flex', alignItems: 'center',
                          justifyContent: 'center', gap: '7px',
                          fontSize: '11px', fontWeight: 700, letterSpacing: '0.09em',
                          color: 'rgba(255,255,255,0.35)',
                          fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                          transition: 'color 0.15s, background 0.15s',
                        }}
                        onMouseEnter={e => {
                          e.currentTarget.style.color = '#2DD4BF'
                          e.currentTarget.style.background = 'rgba(45,212,191,0.04)'
                        }}
                        onMouseLeave={e => {
                          e.currentTarget.style.color = 'rgba(255,255,255,0.35)'
                          e.currentTarget.style.background = 'rgba(255,255,255,0.01)'
                        }}
                      >
                        {showAllHoldings ? (
                          <>
                            Show less
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M18 15l-6-6-6 6"/>
                            </svg>
                          </>
                        ) : (
                          <>
                            View all {sorted.length} tokens ({hidden} more)
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M6 9l6 6 6-6"/>
                            </svg>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                )
              })() : (
                <div style={{
                  padding: '40px 24px', textAlign: 'center',
                  background: 'rgba(6,10,18,0.95)', border: '1px solid rgba(45,212,191,0.10)',
                  borderRadius: '18px', color: 'rgba(255,255,255,0.30)',
                  fontSize: '13px', fontFamily: 'var(--font-inter, Inter, sans-serif)',
                }}>
                  {result.reason
                    ? result.reason
                    : 'No token balances found for this wallet.'}
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.15)', marginTop: '8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', letterSpacing: '0.05em' }}>
                    ChainLens intelligence checks complete · Try a different wallet or check back later
                  </div>
                </div>
              )}

              {/* ── CORTEX Wallet Read (inline — visible on mobile where sidebar is hidden) ── */}
              <div style={{
                background: 'linear-gradient(135deg, #070b14 0%, #060a11 100%)',
                border: '1px solid rgba(45,212,191,0.14)',
                borderRadius: '18px', overflow: 'hidden',
                boxShadow: '0 0 40px rgba(45,212,191,0.05)',
              }}>
                <div style={{ height: '2px', background: 'linear-gradient(90deg, transparent, #2DD4BF 40%, #8b5cf6 70%, transparent)', opacity: clarkVerdict ? 0.85 : 0.20, transition: 'opacity 0.5s' }} />
                <div style={{ padding: '20px 24px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
                    <div style={{
                      width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0,
                      background: (clarkLoading || clarkVerdict) ? '#2DD4BF' : 'rgba(45,212,191,0.20)',
                      boxShadow: (clarkLoading || clarkVerdict) ? '0 0 10px rgba(45,212,191,0.80)' : 'none',
                      animation: clarkLoading ? 'clarkPulse 1.2s ease-in-out infinite' : 'none',
                    }} />
                    <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em', color: 'rgba(45,212,191,0.65)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                      CORTEX · Wallet Read
                    </span>
                  </div>

                  {clarkLoading && (
                    <div>
                      <ClarkDots />
                      <p style={{ marginTop: '10px', fontSize: '12px', color: 'rgba(45,212,191,0.55)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', letterSpacing: '0.03em' }}>
                        CORTEX reading wallet activity…
                      </p>
                    </div>
                  )}

                  {!clarkLoading && clarkError && (
                    <p style={{ margin: 0, fontSize: '12px', color: '#fca5a5', lineHeight: 1.7, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                      {clarkError}
                    </p>
                  )}

                  {!clarkLoading && !clarkVerdict && (
                    <p style={{ margin: 0, fontSize: '12px', color: 'rgba(255,255,255,0.22)', lineHeight: 1.7, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                      Scan a wallet to generate a CORTEX wallet read.
                    </p>
                  )}

                  {!clarkLoading && clarkVerdict && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{ padding: '4px 12px', borderRadius: '99px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', background: 'rgba(45,212,191,0.10)', border: '1px solid rgba(45,212,191,0.25)', color: '#2DD4BF', boxShadow: '0 0 12px rgba(45,212,191,0.10)' }}>
                          {clarkVerdict.verdict}
                        </span>
                        <span style={{ padding: '4px 12px', borderRadius: '99px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.22)', color: '#fbbf24' }}>
                          {clarkVerdict.confidence} confidence
                        </span>
                      </div>

                      <p style={{ margin: 0, fontSize: '13px', color: '#e2e8f0', lineHeight: 1.65, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                        {clarkVerdict.read}
                      </p>

                      <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '10px', padding: '12px 14px' }}>
                        <p style={{ margin: '0 0 8px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.14em', color: '#334155', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Activity Read</p>
                        {clarkVerdict.keySignals.slice(0, 4).map((line, i) => (
                          <p key={i} style={{ margin: '0 0 5px', fontSize: '12px', color: i === 3 ? '#a78bfa' : '#94a3b8', lineHeight: 1.5 }}>— {line}</p>
                        ))}
                      </div>

                      <div>
                        <p style={{ margin: '0 0 8px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.14em', color: '#334155', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Missing Checks</p>
                        {clarkVerdict.risks.slice(0, 3).map((line, i) => (
                          <p key={i} style={{ margin: '0 0 5px', fontSize: '12px', color: '#fca5a5', lineHeight: 1.5 }}>— {line}</p>
                        ))}
                      </div>

                      <div>
                        <p style={{ margin: '0 0 6px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.14em', color: '#334155', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Next action</p>
                        <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8', lineHeight: 1.6 }}>{clarkVerdict.nextAction}</p>
                      </div>

                      <p style={{ margin: 0, fontSize: '10px', color: 'rgba(255,255,255,0.15)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', letterSpacing: '0.05em' }}>
                        CORTEX · Verified on-chain data only
                      </p>
                    </div>
                  )}
                </div>
              </div>

            </div>
            )
          })()}
        </div>

        {/* ── Right: Clark verdict panel ────────────────────────────────────────────── */}
        <aside className="mob-verdict-panel hidden md:flex" style={{
          width: '360px', flexShrink: 0,
          borderLeft: '1px solid rgba(255,255,255,0.07)',
          background: 'linear-gradient(180deg, #070b14 0%, #060a12 100%)',
          display: 'flex', flexDirection: 'column',
        }}>
          {/* Top gradient accent */}
          <div style={{
            height: '2px', flexShrink: 0,
            background: 'linear-gradient(90deg, transparent 0%, #2DD4BF 40%, #8b5cf6 70%, transparent 100%)',
            opacity: clarkVerdict ? 0.85 : 0.15,
            transition: 'opacity 0.5s',
          }} />

          {/* Header */}
          <div style={{
            padding: '22px 24px 16px', flexShrink: 0,
            borderBottom: '1px solid rgba(255,255,255,0.055)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: result ? '10px' : 0 }}>
              <div style={{
                width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                background: clarkVerdict ? '#2DD4BF' : 'rgba(45,212,191,0.20)',
                boxShadow: clarkVerdict ? '0 0 10px rgba(45,212,191,0.70)' : 'none',
                transition: 'background 0.4s, box-shadow 0.4s',
              }} />
              <span style={{
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em',
                color: 'rgba(255,255,255,0.50)', textTransform: 'uppercase',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              }}>
                CORTEX · Wallet Read
              </span>
            </div>
            {result && (
              <div style={{
                fontSize: '10px', color: 'rgba(255,255,255,0.22)',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                letterSpacing: '0.04em',
              }}>
                {result.address.slice(0, 10)}…{result.address.slice(-8)}
              </div>
            )}
          </div>

          {/* Body */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {clarkLoading && (
              <div>
                <ClarkDots />
                <p style={{ marginTop: '10px', fontSize: '12px', color: 'rgba(45,212,191,0.60)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', letterSpacing: '0.03em' }}>
                  CORTEX reading wallet activity…
                </p>
              </div>
            )}
            {!clarkLoading && clarkError && (
              <p style={{ fontSize: '12px', color: '#fca5a5', lineHeight: 1.7, fontFamily: 'var(--font-inter, Inter, sans-serif)', margin: 0 }}>
                {clarkError}
              </p>
            )}
            {!clarkLoading && !clarkError && !clarkVerdict && (
              <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.18)', lineHeight: 1.7, fontFamily: 'var(--font-inter, Inter, sans-serif)', margin: 0 }}>
                Scan a wallet to generate a CORTEX wallet read.
              </p>
            )}
            {!clarkLoading && clarkVerdict && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap' }}>
                  <span style={{ padding: '4px 11px', borderRadius: '99px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', background: 'rgba(45,212,191,0.10)', border: '1px solid rgba(45,212,191,0.25)', color: '#2DD4BF', boxShadow: '0 0 12px rgba(45,212,191,0.10)' }}>{clarkVerdict.verdict}</span>
                </div>
                <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '10px', padding: '10px 12px' }}>
                  <p style={{ margin: '0 0 5px', fontSize: '9px', color: '#475569', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Portfolio Read</p>
                  <p style={{ margin: 0, fontSize: '12px', color: '#e2e8f0', lineHeight: 1.65 }}>{clarkVerdict.read}</p>
                </div>
                <div>
                  <p style={{ margin: '0 0 6px', fontSize: '9px', color: '#475569', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Activity Read</p>
                  {clarkVerdict.keySignals.slice(0, 2).map((line, i) => <p key={i} style={{ margin: '0 0 5px', fontSize: '12px', color: '#94a3b8', lineHeight: 1.5 }}>— {line}</p>)}
                </div>
                <div>
                  <p style={{ margin: '0 0 6px', fontSize: '9px', color: '#475569', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Risk / Concentration</p>
                  <p style={{ margin: 0, fontSize: '12px', color: '#fbbf24', lineHeight: 1.5 }}>— {clarkVerdict.keySignals[2]}</p>
                </div>
                {clarkVerdict.keySignals[3] && (
                  <div>
                    <p style={{ margin: '0 0 6px', fontSize: '9px', color: '#475569', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Real Trade Evidence</p>
                    <p style={{ margin: 0, fontSize: '12px', color: '#a78bfa', lineHeight: 1.5 }}>— {clarkVerdict.keySignals[3]}</p>
                  </div>
                )}
                <div>
                  <p style={{ margin: '0 0 6px', fontSize: '9px', color: '#475569', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Missing Checks</p>
                  {clarkVerdict.risks.slice(0, 3).map((line, i) => <p key={i} style={{ margin: '0 0 5px', fontSize: '12px', color: '#fca5a5', lineHeight: 1.5 }}>— {line}</p>)}
                </div>
                <div>
                  <p style={{ margin: '0 0 6px', fontSize: '9px', color: '#475569', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Next Action</p>
                  <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8', lineHeight: 1.6 }}>{clarkVerdict.nextAction}</p>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div style={{
            flexShrink: 0, padding: '12px 22px',
            borderTop: '1px solid rgba(255,255,255,0.05)',
            fontSize: '10px', color: 'rgba(255,255,255,0.16)',
            letterSpacing: '0.06em', lineHeight: 1.5,
            fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
          }}>
            CORTEX · Verified on-chain analysis only
          </div>
        </aside>
      </div>
    </>
  )
}
