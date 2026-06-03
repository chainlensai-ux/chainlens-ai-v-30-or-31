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
    uniqueTokensTraded: number
    realizedPnlUsd: number | null
    realizedPnlPercent: number | null
    winningClosedLots: number
    losingClosedLots: number
    breakEvenClosedLots: number
    winRatePercent: number | null
    avgPnlUsdPerClosedLot: number | null
    avgReturnPercentPerClosedLot: number | null
    medianReturnPercentPerClosedLot: number | null
    avgHoldingTimeSeconds: number | null
    medianHoldingTimeSeconds: number | null
    largestWinUsd: number | null
    largestLossUsd: number | null
    confidence: 'high' | 'medium' | 'low' | 'open_check'
    sampleSizeLabel: 'insufficient' | 'early' | 'developing' | 'strong' | 'micro_sample'
    readyForWalletScore: boolean
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
    tradeStats:    { status: 'ok' | 'partial' | 'open_check'; closedLots: number; readyForWinRate: boolean; reason: string }
    behavior:      { status: 'ok' | 'partial' | 'open_check'; reason: string }
  }
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
}

// ── Formatters ───────────────────────────────────────────────────────────────────────────

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
  if (!ts || ts.closedLots < 10) return 'Requires 10+ verified closed lots.'
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
  if (!hasEstimatedPnl && (!ts || ts.closedLots === 0)) {
    checks.push(hasActivityProviderUnavailable(data)
      ? ACTIVITY_UNAVAILABLE_COPY
      : 'PnL remains Open Check until indexed transfer history has enough cost-basis coverage.')
  }
  if (ts && ts.closedLots > 0 && !isTradeStatsGradeable(ts)) {
    checks.push(isMicroSampleLocked(ts) ? 'Wallet score locked — matched sample is too small financially to grade.' : 'Wallet score locked — sample below 10 closed lots.')
  } else if (!ts || ts.closedLots === 0) {
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
    sentences.push(`Matched closed-lot sample shows ${ts.winningClosedLots} positive lot${ts.winningClosedLots !== 1 ? 's' : ''} and ${ts.losingClosedLots === 0 ? 'no matched losing closed lots' : `${ts.losingClosedLots} matched losing closed lot${ts.losingClosedLots !== 1 ? 's' : ''}`}. This is not a full wallet win rate. Official win rate is not calculated until 10+ verified closed lots.`)
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
      ? `Matched closed-lot sample: ${ts.winningClosedLots} positive lot${ts.winningClosedLots !== 1 ? 's' : ''} and ${ts.losingClosedLots === 0 ? 'no matched losing closed lots' : `${ts.losingClosedLots} matched losing closed lot${ts.losingClosedLots !== 1 ? 's' : ''}`}. Official win rate is not calculated until 10+ verified closed lots.`
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
        ? [`Real trade evidence: ${ts.closedLots} closed lots, ${fmtSignedUSD(ts.realizedPnlUsd)} matched realized PnL. Matched closed-lot sample: ${ts.winningClosedLots} positive lot${ts.winningClosedLots !== 1 ? 's' : ''}, ${ts.losingClosedLots === 0 ? 'no matched losing lots' : `${ts.losingClosedLots} matched losing lot${ts.losingClosedLots !== 1 ? 's' : ''}`}.`]
        : hasRealTrade
          ? [`Matched closed-lot sample: ${ts.winningClosedLots} positive lot${ts.winningClosedLots !== 1 ? 's' : ''} and ${ts.losingClosedLots === 0 ? 'no matched losing closed lots' : `${ts.losingClosedLots} matched losing lot${ts.losingClosedLots !== 1 ? 's' : ''}`} across ${ts.closedLots} reconstructed lots.`]
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
          0%,100% { opacity:1; box-shadow:0 0 6px rgba(45,212,191,0.70); }
          50%      { opacity:0.4; box-shadow:0 0 2px rgba(45,212,191,0.20); }
        }
        .ws-row:hover { background: rgba(255,255,255,0.025) !important; }
        .ws-scan-btn:hover:not(:disabled) {
          background: #25c0a8 !important;
          box-shadow: 0 0 24px rgba(45,212,191,0.40) !important;
        }
        @media (max-width: 768px) {
          .wallet-main { padding: 60px 14px 120px !important; }
          .wallet-input-row { flex-direction: column; max-width: 100% !important; }
          .wallet-input-row button { width: 100%; justify-content: center; }
          .ws-stat-grid     { grid-template-columns: repeat(2, 1fr) !important; }
          .ws-behavior-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .wallet-intel-grid, .wallet-score-grid { grid-template-columns: 1fr !important; }
          .wallet-trade-table { overflow-x: auto !important; }
          .ws-val-52        { font-size: 32px !important; letter-spacing: -0.02em !important; }
          .ws-holdings-header { display: none !important; }
          .ws-holdings-row {
            display: flex !important; flex-wrap: wrap !important;
            padding: 12px 14px !important; gap: 6px 0 !important; align-items: center !important;
          }
          .ws-col-token { flex: 0 0 100% !important; padding-bottom: 8px !important; border-bottom: 1px solid rgba(255,255,255,0.04) !important; }
          .ws-col-balance, .ws-col-value, .ws-col-change {
            flex: 1 1 33% !important; text-align: left !important; font-size: 12px !important;
          }
          .ws-col-balance::before { content: "Balance"; display: block; font-size: 8px; color: rgba(255,255,255,0.25); font-family: var(--font-plex-mono, monospace); text-transform: uppercase; letter-spacing: 0.10em; margin-bottom: 2px; }
          .ws-col-value::before   { content: "Value";   display: block; font-size: 8px; color: rgba(255,255,255,0.25); font-family: var(--font-plex-mono, monospace); text-transform: uppercase; letter-spacing: 0.10em; margin-bottom: 2px; }
          .ws-col-change::before  { content: "24h";     display: block; font-size: 8px; color: rgba(255,255,255,0.25); font-family: var(--font-plex-mono, monospace); text-transform: uppercase; letter-spacing: 0.10em; margin-bottom: 2px; }
        }
      `}</style>

      <div className="flex h-full overflow-hidden" style={{ color: '#e2e8f0' }}>

        {/* ── Left: scrollable main area ─────────────────────────────────── */}
        <div className="mob-scan-main wallet-main" style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', padding: '40px 48px 120px' }}>

          {/* Header */}
          <div style={{ marginBottom: '32px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
              <h1 style={{
                fontSize: '30px', fontWeight: 800, color: '#f8fafc', lineHeight: 1.1,
                margin: 0, fontFamily: 'var(--font-inter, Inter, sans-serif)',
                letterSpacing: '-0.02em',
              }}>
                Wallet Scanner
              </h1>
              <span style={{
                fontSize: '11px', fontWeight: 700, letterSpacing: '0.12em',
                padding: '4px 12px', borderRadius: '99px',
                background: 'rgba(139,92,246,0.18)',
                border: '1px solid rgba(139,92,246,0.40)',
                color: '#c4b5fd',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                textTransform: 'uppercase', flexShrink: 0,
              }}>
                Elite
              </span>
            </div>
            <p style={{
              fontSize: '14px', color: '#94a3b8', margin: 0,
              fontFamily: 'var(--font-inter, Inter, sans-serif)',
            }}>
              Advanced on-chain intelligence and AI-powered wallet analysis
            </p>
          </div>

          {/* Input */}
          <div className="wallet-input-row" style={{ display: 'flex', gap: '10px', maxWidth: '680px', marginBottom: '32px' }}>
            <div style={{ flex: 1, position: 'relative' }}>
              {/* Paste icon */}
              <button
                onClick={() => navigator.clipboard.readText().then(t => setInput(t)).catch(() => {})}
                title="Paste from clipboard"
                style={{
                  position: 'absolute', left: '13px', top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', padding: '0', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', color: 'rgba(255,255,255,0.32)',
                  transition: 'color 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.color = '#2DD4BF')}
                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.32)')}
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
                  width: '100%', padding: '13px 16px 13px 40px',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  borderRadius: '11px', color: '#e2e8f0',
                  fontSize: '16px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                  outline: 'none', transition: 'border-color 0.15s', boxSizing: 'border-box',
                }}
                onFocus={e => (e.currentTarget.style.borderColor = 'rgba(45,212,191,0.45)')}
                onBlur={e  => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)')}
              />
            </div>
            <button
              className="ws-scan-btn"
              onClick={handleScan}
              disabled={loading || !input.trim()}
              style={{
                padding: '13px 22px', borderRadius: '11px', border: 'none',
                background: (loading || !input.trim()) ? 'rgba(45,212,191,0.25)' : '#2DD4BF',
                color: (loading || !input.trim()) ? 'rgba(255,255,255,0.35)' : '#04101a',
                fontSize: '12px', fontWeight: 800,
                letterSpacing: '0.10em', textTransform: 'uppercase',
                cursor: (loading || !input.trim()) ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                boxShadow: (!loading && input.trim()) ? '0 0 20px rgba(45,212,191,0.25)' : 'none',
                transition: 'background 0.15s, box-shadow 0.15s, color 0.15s',
                whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '8px',
              }}
            >
              {loading ? 'Scanning…' : (
                <>
                  Scan
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M13 6l6 6-6 6"/>
                  </svg>
                </>
              )}
            </button>
          </div>

          {/* Deep Activity Scan toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
            <button
              onClick={() => setDeepActivity(v => !v)}
              disabled={loading}
              title="Fetches transfer history for estimated PnL and future trade reconstruction. Slower scan."
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '5px 11px', borderRadius: '7px',
                border: `1px solid ${deepActivity ? 'rgba(45,212,191,0.50)' : 'rgba(255,255,255,0.09)'}`,
                background: deepActivity ? 'rgba(45,212,191,0.07)' : 'transparent',
                color: deepActivity ? '#2DD4BF' : 'rgba(255,255,255,0.38)',
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase',
                cursor: loading ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                transition: 'all 0.15s',
              }}
            >
              {deepActivity && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              )}
              {deepActivity ? 'Deep Activity Scan On' : 'Run Deep Activity Scan'}
            </button>
            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.28)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', letterSpacing: '0.05em' }}>
              {deepActivity
                ? 'Deep Activity uses heavier analysis and is cached. Re-running too often will return the cached result.'
                : 'Fetches transfer history · slower scan'}
            </span>
          </div>

          {/* Loading skeleton */}
          {loading && (
            <div style={{ maxWidth: '680px' }}>
              {[180, 80, 120, 100, 110, 90].map((w, i) => (
                <div key={i} style={{
                  height: '14px', borderRadius: '6px', marginBottom: '14px',
                  width: `${w + i * 20}px`,
                  background: 'linear-gradient(90deg, rgba(255,255,255,0.05) 25%, rgba(255,255,255,0.10) 50%, rgba(255,255,255,0.05) 75%)',
                  backgroundSize: '200% 100%',
                  animation: 'shimmer 1.5s infinite',
                }} />
              ))}
            </div>
          )}

          {/* Error */}
          {error && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: '8px',
              padding: '12px 14px', borderRadius: '10px', maxWidth: '680px',
              background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.20)',
              color: '#fca5a5', fontSize: '13px', lineHeight: 1.5,
              fontFamily: 'var(--font-inter, Inter, sans-serif)',
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginTop: '1px' }}>
                <circle cx="12" cy="12" r="10" stroke="#fca5a5" strokeWidth="2"/>
                <path d="M12 8v4M12 16h.01" stroke="#fca5a5" strokeWidth="2" strokeLinecap="round"/>
              </svg>
              {error}
            </div>
          )}

          {/* CORTEX idle placeholder — shown before first scan */}
          {!result && !loading && (
            <div style={{ maxWidth: '720px', marginTop: '8px' }}>
              <div style={{ background: '#080c14', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '14px', padding: '18px 22px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '8px' }}>
                  <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'rgba(45,212,191,0.22)' }} />
                  <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                    CORTEX Wallet Read
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: '13px', color: 'rgba(255,255,255,0.28)', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                  Scan a wallet to generate a CORTEX wallet read.
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
            <div style={{ maxWidth: '100%', width: '100%', display: 'flex', flexDirection: 'column', gap: '16px' }}>

              {/* Scan cost / cache note banner */}
              {result.walletScanCacheNote && (result.walletScanCostMode === 'blocked_by_cooldown' || result.walletScanCostMode === 'blocked_by_cost_guard' || result.walletScanCostMode === 'historical_cached' || result.walletScanCostMode === 'deep_cached') && (
                <div style={{ fontSize: '11px', color: '#7dd3fc', background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.15)', borderRadius: '8px', padding: '8px 12px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.5 }}>
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
                  { label: 'FIFO PnL', note: mc.fifoPnL.closedLots > 0 ? `${mc.fifoPnL.closedLots} closed lots` : mc.swapDetection.candidateCount > 0 ? 'no matched lots' : 'no swap evidence', status: mc.fifoPnL.status },
                  { label: 'Trade stats', note: mc.tradeStats.closedLots > 0 ? `${mc.tradeStats.closedLots} lots` + (mc.tradeStats.readyForWinRate ? '' : ' — below threshold') : 'no closed lots', status: mc.tradeStats.status },
                ]
                return (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '10px 14px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '10px' }}>
                    <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.28)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', alignSelf: 'center', marginRight: '2px' }}>CORTEX checks</span>
                    {chips.map(chip => (
                      <span key={chip.label} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', color: statusColor(chip.status), border: `1px solid ${statusColor(chip.status)}30`, background: `${statusColor(chip.status)}0a`, borderRadius: '6px', padding: '3px 8px' }}>
                        <span style={{ opacity: 0.8 }}>{statusIcon(chip.status)}</span>
                        <span style={{ color: 'rgba(255,255,255,0.55)', fontWeight: 600 }}>{chip.label}</span>
                        <span style={{ opacity: 0.65 }}>{chip.note}</span>
                      </span>
                    ))}
                  </div>
                )
              })()}

              {/* Portfolio value card */}
              <div style={{
                background: '#080c14',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '18px',
                position: 'relative', overflow: 'hidden',
              }}>
                <div style={{
                  position: 'absolute', top: 0, left: 0, right: 0, height: '2px',
                  background: 'linear-gradient(90deg, #2DD4BF 0%, #8b5cf6 100%)',
                }} />
                <div style={{ padding: '28px 32px' }}>
                  <div style={{
                    fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em',
                    color: '#2DD4BF', textTransform: 'uppercase',
                    fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                    marginBottom: '10px',
                  }}>
                    Portfolio Value
                  </div>
                  <div className="ws-val-52" style={{
                    fontSize: '52px', fontWeight: 900, color: '#f1f5f9',
                    fontFamily: 'var(--font-inter, Inter, sans-serif)',
                    letterSpacing: '-0.03em', lineHeight: 1,
                    marginBottom: '14px',
                  }}>
                    {result.totalValue > 0 ? fmtUSD(result.totalValue) : result.holdings.length > 0 ? 'Value pending in current checks' : 'No signal in checked window'}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{
                      fontSize: '12px', color: 'rgba(255,255,255,0.32)',
                      fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                    }}>
                      {shortAddr(result.address)}
                    </span>
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
                  <div style={{ background: '#080c14', border: '1px solid rgba(45,212,191,0.18)', borderRadius: '16px', padding: '20px 22px', position: 'relative', overflow: 'hidden' }}>
                    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '2px', background: 'linear-gradient(90deg, #2DD4BF 0%, #4ade80 100%)' }} />
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.18em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Portfolio Intelligence</div>
                        <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', color: '#4ade80', border: '1px solid rgba(74,222,128,0.25)', background: 'rgba(74,222,128,0.07)', borderRadius: '999px', padding: '2px 7px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Portfolio Read Active</span>
                      </div>
                      <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.40)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{pi.holdingsScope}</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '14px' }}>
                      <div style={{ background: 'rgba(45,212,191,0.05)', border: '1px solid rgba(45,212,191,0.12)', borderRadius: '10px', padding: '12px' }}>
                        <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.30)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '6px' }}>Total Value</div>
                        <div style={{ fontSize: '20px', fontWeight: 800, color: '#2DD4BF', fontFamily: 'var(--font-inter, Inter, sans-serif)', letterSpacing: '-0.02em' }}>{pi.totalValue > 0 ? fmtUSD(pi.totalValue) : '—'}</div>
                      </div>
                      <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '10px', padding: '12px' }}>
                        <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.30)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '6px' }}>Visible Tokens</div>
                        <div style={{ fontSize: '20px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{pi.holdingsCount}</div>
                      </div>
                      <div style={{ background: concentrationLabel ? `${concentrationColor}0d` : 'rgba(255,255,255,0.03)', border: `1px solid ${concentrationLabel ? `${concentrationColor}28` : 'rgba(255,255,255,0.07)'}`, borderRadius: '10px', padding: '12px' }}>
                        <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.30)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '6px' }}>Concentration</div>
                        <div style={{ fontSize: '15px', fontWeight: 800, color: concentrationLabel ? concentrationColor : 'rgba(255,255,255,0.35)', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{concentrationLabel ?? '—'}</div>
                        {pi.topHolding && pi.topShare !== null && <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', marginTop: '3px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Largest visible holding: {pi.topHolding.symbol || pi.topHolding.name} at ~{pi.topShare.toFixed(0)}%.</div>}
                        {pi.top3Share !== null && pi.top3.length > 1 && <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', marginTop: '3px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Top 3 holdings make up ~{pi.top3Share.toFixed(0)}% of visible portfolio value.</div>}
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '14px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                      {pi.top3.length > 0 && (
                        <div>
                          <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.30)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '6px' }}>Top Holdings</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                            {pi.top3.map((h, i) => {
                              const pct = pi.totalValue > 0 ? ((h.value / pi.totalValue) * 100).toFixed(0) : null
                              return (
                                <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', color: '#e2e8f0', border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.03)', borderRadius: '6px', padding: '4px 9px' }}>
                                  <span style={{ fontWeight: 700 }}>{h.symbol || h.name}</span>
                                  {pct && <span style={{ color: 'rgba(255,255,255,0.38)', fontSize: '9px' }}>{pct}%</span>}
                                </span>
                              )
                            })}
                          </div>
                        </div>
                      )}
                      {pi.chains.length > 0 && (
                        <div>
                          <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.30)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '6px' }}>Chain Exposure</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                            {pi.chains.map(c => (
                              <span key={c} style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.07em', padding: '3px 8px', borderRadius: '6px', background: c === 'base' ? 'rgba(0,82,255,0.14)' : 'rgba(98,126,234,0.14)', border: c === 'base' ? '1px solid rgba(0,82,255,0.28)' : '1px solid rgba(98,126,234,0.28)', color: c === 'base' ? '#6ea8ff' : '#a5b4fc', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{c === 'base' ? 'Base' : c === 'ethereum' ? 'Ethereum' : c.toUpperCase().replace(/-/g, ' ')}</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    {(pi.stablePercent > 5 || pi.ethPercent > 5) && (
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '12px' }}>
                        {pi.stablePercent > 5 && <span style={{ fontSize: '10px', color: '#4ade80', border: '1px solid rgba(74,222,128,0.22)', background: 'rgba(74,222,128,0.05)', borderRadius: '6px', padding: '3px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Stablecoin exposure {pi.stablePercent.toFixed(0)}%</span>}
                        {pi.ethPercent > 5 && <span style={{ fontSize: '10px', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.22)', background: 'rgba(139,92,246,0.05)', borderRadius: '6px', padding: '3px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>ETH exposure {pi.ethPercent.toFixed(0)}%</span>}
                      </div>
                    )}
                    <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '10px' }}>
                      {totalEvents > 0 ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                          <span style={{ fontSize: '10px', color: '#4ade80', border: '1px solid rgba(74,222,128,0.20)', background: 'rgba(74,222,128,0.05)', borderRadius: '6px', padding: '3px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Activity indexed</span>
                          <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{totalEvents} indexed transfer events</span>
                          {swapCandidates === 0 ? (
                            <span style={{ fontSize: '10px', color: '#7dd3fc', border: '1px solid rgba(125,211,252,0.18)', background: 'rgba(56,189,248,0.05)', borderRadius: '6px', padding: '3px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>No reconstructable swap pairs in checked sample</span>
                          ) : (
                            <span style={{ fontSize: '10px', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.20)', background: 'rgba(139,92,246,0.05)', borderRadius: '6px', padding: '3px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{swapCandidates} swap pair{swapCandidates !== 1 ? 's' : ''} found</span>
                          )}
                        </div>
                      ) : (
                        <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.30)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Activity not available in checked sample</span>
                      )}
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
                    const closedLots = ts?.closedLots ?? 0
                    const portfolioActive = result.walletModuleCoverage?.portfolio.status === 'ok' || result.totalValue > 0 || result.holdings.length > 0
                    const tradeOpenCheck = closedLots === 0
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
                            CORTEX can read current holdings and exposure. Trading skill needs matched swap exits.
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
                            { label: closedLots > 0 && walletIntel.winRate === null ? 'Official Win Rate' : 'Win Rate', value: closedLots > 0 && walletIntel.winRate === null ? 'Not calculated yet' : fmtOpenPct(walletIntel.winRate), note: closedLots > 0 && walletIntel.winRate === null ? officialWinRateLockCopy(ts) : winRateNote },
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
                const statusBg = wf.status === 'ok' ? 'rgba(74,222,128,0.08)' : wf.status === 'partial' ? 'rgba(251,191,36,0.08)' : 'rgba(125,211,252,0.08)'
                const statusBorder = wf.status === 'ok' ? 'rgba(74,222,128,0.22)' : wf.status === 'partial' ? 'rgba(251,191,36,0.22)' : 'rgba(125,211,252,0.22)'
                const fmtDate = (ts: string | null) => ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
                return (
                  <div style={{ background: '#080c14', border: '1px solid rgba(45,212,191,0.18)', borderRadius: '16px', padding: '20px 22px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
                      <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.18em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>CORTEX Facts</div>
                      <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', color: statusColor, border: `1px solid ${statusBorder}`, background: statusBg, borderRadius: '999px', padding: '2px 7px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                        {wf.status === 'ok' ? 'full read' : wf.status === 'partial' ? 'partial read' : 'open check'}
                      </span>
                      {wf.limits.noClosedLotPnL && (
                        <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', color: '#7dd3fc', border: '1px solid rgba(125,211,252,0.18)', background: 'rgba(125,211,252,0.06)', borderRadius: '999px', padding: '2px 7px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>no closed lots</span>
                      )}
                    </div>

                    <div className="wallet-intel-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px', marginBottom: '14px' }}>
                      {[
                        { label: 'Portfolio Value', value: wf.summary.totalValueUsd > 0 ? fmtUSD(wf.summary.totalValueUsd) : '—' },
                        { label: 'Visible Tokens', value: String(wf.summary.holdingsCount) },
                        { label: 'Concentration', value: wf.summary.concentrationLabel === 'none' ? '—' : wf.summary.concentrationLabel.charAt(0).toUpperCase() + wf.summary.concentrationLabel.slice(1) },
                      ].map(c => (
                        <div key={c.label} style={{ background: 'rgba(45,212,191,0.04)', border: '1px solid rgba(45,212,191,0.10)', borderRadius: '10px', padding: '10px 12px' }}>
                          <div style={{ fontSize: '9px', color: 'rgba(45,212,191,0.55)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '5px' }}>{c.label}</div>
                          <div style={{ fontSize: '15px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{c.value}</div>
                        </div>
                      ))}
                    </div>

                    {wf.summary.topHoldings.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px', alignItems: 'center' }}>
                        <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', letterSpacing: '0.10em', textTransform: 'uppercase' }}>Top</span>
                        {wf.summary.topHoldings.map((h, i) => (
                          <span key={i} style={{ fontSize: '11px', fontWeight: 600, color: '#2DD4BF', background: 'rgba(45,212,191,0.08)', border: '1px solid rgba(45,212,191,0.18)', borderRadius: '999px', padding: '3px 9px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                            {h.symbol} <span style={{ color: 'rgba(45,212,191,0.55)' }}>{h.percent}%</span>
                          </span>
                        ))}
                      </div>
                    )}

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '14px', alignItems: 'center' }}>
                      {wf.summary.chainExposure.map((ce, i) => (
                        <span key={i} style={{ fontSize: '10px', fontWeight: 700, color: '#7dd3fc', background: 'rgba(56,189,248,0.07)', border: '1px solid rgba(56,189,248,0.18)', borderRadius: '6px', padding: '3px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                          {ce.chain.toUpperCase()} {ce.percent}%
                        </span>
                      ))}
                      {wf.summary.stablecoinExposurePercent > 5 && (
                        <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.40)', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '6px', padding: '3px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                          Stablecoins {wf.summary.stablecoinExposurePercent}%
                        </span>
                      )}
                      {wf.summary.nativeExposurePercent > 5 && (
                        <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.40)', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '6px', padding: '3px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                          ETH/WETH {wf.summary.nativeExposurePercent}%
                        </span>
                      )}
                    </div>

                    {wf.activity.eventCount > 0 && (
                      <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '10px', padding: '12px 14px', marginBottom: '12px' }}>
                        <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.14em', color: 'rgba(45,212,191,0.55)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '8px' }}>Activity Index</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 24px' }}>
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
                              <div style={{ fontSize: '8px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.10em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '2px' }}>{item.label}</div>
                              <div style={{ fontSize: '12px', fontWeight: 600, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{item.val}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {wf.activity.latestEvents.length > 0 && (
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '6px' }}>Recent Events</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {wf.activity.latestEvents.map((ev, i) => (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', color: 'rgba(255,255,255,0.55)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', padding: '4px 8px', background: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
                              <span style={{ color: ev.direction === 'buy' ? '#4ade80' : ev.direction === 'sell' ? '#f87171' : '#94a3b8', fontWeight: 700, minWidth: '20px' }}>{ev.direction === 'buy' ? '↓' : ev.direction === 'sell' ? '↑' : '?'}</span>
                              <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{ev.symbol}</span>
                              <span style={{ color: 'rgba(255,255,255,0.30)' }}>{ev.chain.toUpperCase()}</span>
                              {ev.valueUsdKnown && <span style={{ color: '#7dd3fc' }}>USD known</span>}
                              <span style={{ marginLeft: 'auto', color: 'rgba(255,255,255,0.25)', fontSize: '9px' }}>{new Date(ev.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {(wf.flowRead.receivedTokens.length > 0 || wf.flowRead.sentTokens.length > 0) && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
                        {wf.flowRead.receivedTokens.length > 0 && (
                          <div style={{ background: 'rgba(74,222,128,0.03)', border: '1px solid rgba(74,222,128,0.10)', borderRadius: '8px', padding: '10px 12px' }}>
                            <div style={{ fontSize: '9px', color: 'rgba(74,222,128,0.55)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '6px' }}>Received</div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 8px' }}>
                              {wf.flowRead.receivedTokens.slice(0, 5).map((t, i) => (
                                <span key={i} style={{ fontSize: '10px', color: '#4ade80', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                                  {t.symbol}<span style={{ color: 'rgba(74,222,128,0.45)', fontSize: '9px' }}>×{t.count}</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {wf.flowRead.sentTokens.length > 0 && (
                          <div style={{ background: 'rgba(248,113,113,0.03)', border: '1px solid rgba(248,113,113,0.10)', borderRadius: '8px', padding: '10px 12px' }}>
                            <div style={{ fontSize: '9px', color: 'rgba(248,113,113,0.55)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '6px' }}>Sent</div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 8px' }}>
                              {wf.flowRead.sentTokens.slice(0, 5).map((t, i) => (
                                <span key={i} style={{ fontSize: '10px', color: '#f87171', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                                  {t.symbol}<span style={{ color: 'rgba(248,113,113,0.45)', fontSize: '9px' }}>×{t.count}</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {(wf.flowRead.accumulationSignals.length > 0 || wf.flowRead.distributionSignals.length > 0) && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                        {wf.flowRead.accumulationSignals.slice(0, 3).map((s, i) => (
                          <span key={`acc-${i}`} style={{ fontSize: '10px', color: '#4ade80', background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.15)', borderRadius: '6px', padding: '3px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>↑ {s}</span>
                        ))}
                        {wf.flowRead.distributionSignals.slice(0, 3).map((s, i) => (
                          <span key={`dist-${i}`} style={{ fontSize: '10px', color: '#f87171', background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.15)', borderRadius: '6px', padding: '3px 8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>↓ {s}</span>
                        ))}
                      </div>
                    )}

                    {wf.sourceClassification.notes.length > 0 && (
                      <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.30)', lineHeight: 1.5, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '8px' }}>
                        {wf.sourceClassification.notes.join(' — ')}
                      </div>
                    )}
                    <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.22)', lineHeight: 1.5, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', background: 'rgba(45,212,191,0.03)', border: '1px solid rgba(45,212,191,0.08)', borderRadius: '7px', padding: '7px 10px' }}>
                      {wf.limits.reason}
                    </div>
                  </div>
                )
              })()}

              {(() => {
                const ts = result.walletTradeStatsSummary
                const ls = result.walletLotSummary
                if (!ts) return null
                const isOpenCheck = ts.status === 'open_check' || ts.closedLots === 0
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
                  <div style={{ background: '#080c14', border: '1px solid rgba(139,92,246,0.22)', borderRadius: '16px', padding: '20px 22px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
                      <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.18em', color: '#a78bfa', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Trading Intelligence</div>
                      <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', color: '#a78bfa', border: '1px solid rgba(139,92,246,0.25)', background: 'rgba(139,92,246,0.07)', borderRadius: '999px', padding: '2px 7px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>FIFO lots</span>
                      <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', color: ts.confidence === 'high' ? '#4ade80' : ts.confidence === 'medium' ? '#fbbf24' : '#94a3b8', border: `1px solid ${ts.confidence === 'high' ? 'rgba(74,222,128,0.22)' : ts.confidence === 'medium' ? 'rgba(251,191,36,0.22)' : 'rgba(148,163,184,0.18)'}`, background: ts.confidence === 'high' ? 'rgba(74,222,128,0.06)' : ts.confidence === 'medium' ? 'rgba(251,191,36,0.06)' : 'rgba(148,163,184,0.06)', borderRadius: '999px', padding: '2px 7px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{ts.confidence === 'open_check' ? 'open check' : `${ts.confidence} confidence`}</span>
                      <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', color: '#94a3b8', border: '1px solid rgba(148,163,184,0.15)', background: 'rgba(148,163,184,0.05)', borderRadius: '999px', padding: '2px 7px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{ts.sampleSizeLabel}</span>
                    </div>

                    {!isOpenCheck && (
                      <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.30)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: ts.economicSignificance === 'micro_sample' || ts.sampleSizeLabel === 'insufficient' ? '6px' : '14px', lineHeight: 1.4 }}>
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
                        <div style={{ color: '#7dd3fc', marginBottom: '10px' }}>
                          {(() => {
                            const mc = result.walletModuleCoverage
                            if (ls && (ls.pricedSwapEvents ?? 0) > 0) return 'CORTEX found priced activity, but buys and sells did not match inside the indexed window yet.'
                            if (mc?.activity && mc.activity.eventCount > 0 && mc.swapDetection.candidateCount === 0) return `${mc.activity.eventCount} transfer events indexed — no reconstructable swap pairs found in checked sample.`
                            if (mc?.swapDetection && mc.swapDetection.candidateCount > 0 && (mc.priceEvidence?.pricedEvents ?? 0) === 0) return 'Swap candidates found but price evidence was unavailable at time of trade. FIFO lot matching requires entry and exit price data.'
                            if (mc?.activity?.reason === 'provider_unavailable') return 'Activity provider unavailable. No FIFO lot matching was possible in this scan.'
                            return 'No matched priced closed lots yet.'
                          })()}
                        </div>
                        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', lineHeight: 1.5, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', background: 'rgba(125,211,252,0.04)', border: '1px solid rgba(125,211,252,0.10)', borderRadius: '8px', padding: '8px 10px' }}>
                          Requires matched buys and sells with price evidence. Current scan found transfers but no reconstructable swap pairs. Closed-lot stats not available yet.
                        </div>
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
                          const earlyWinPct = ts.closedLots > 0 ? Math.round((ts.winningClosedLots / ts.closedLots) * 100) : null
                          const earlyCards: Array<{ label: string; value: string | null; locked?: boolean; lockNote?: string; pnl?: number | null; early?: boolean }> = [
                            ...(earlyWinPct !== null && !hasEnough
                              ? [{ label: 'Matched Closed-Lot Read', value: `${ts.winningClosedLots}W / ${ts.losingClosedLots}L from ${ts.closedLots} matched lots`, early: true }]
                              : []),
                            { label: hasEnough ? 'Win Rate' : 'Official Win Rate', value: hasEnough && ts.winRatePercent !== null ? `${ts.winRatePercent.toFixed(1)}%` : null, locked: !hasEnough || ts.winRatePercent === null, lockNote: officialWinRateLockCopy(ts) },
                            { label: 'Avg PnL / Lot', value: ts.avgPnlUsdPerClosedLot !== null ? fmtSignedUSD(ts.avgPnlUsdPerClosedLot) : '—', pnl: ts.avgPnlUsdPerClosedLot },
                            { label: 'Avg Return / Lot', value: ts.avgReturnPercentPerClosedLot !== null ? `${ts.avgReturnPercentPerClosedLot >= 0 ? '+' : ''}${ts.avgReturnPercentPerClosedLot.toFixed(1)}%` : '—', pnl: ts.avgReturnPercentPerClosedLot },
                            { label: 'Median Return', value: ts.medianReturnPercentPerClosedLot !== null ? `${ts.medianReturnPercentPerClosedLot >= 0 ? '+' : ''}${ts.medianReturnPercentPerClosedLot.toFixed(1)}%` : '—', pnl: ts.medianReturnPercentPerClosedLot },
                            { label: 'Avg Hold Time', value: fmtHoldTime(ts.avgHoldingTimeSeconds) },
                            { label: 'Median Hold Time', value: fmtHoldTime(ts.medianHoldingTimeSeconds) },
                          ]
                          return (
                            <div className="wallet-intel-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px', marginBottom: '14px' }}>
                              {earlyCards.map(card => (
                                <div key={card.label} style={{ background: card.early ? 'rgba(167,139,250,0.07)' : 'rgba(255,255,255,0.03)', border: `1px solid ${card.early ? 'rgba(167,139,250,0.22)' : 'rgba(255,255,255,0.07)'}`, borderRadius: '12px', padding: '12px' }}>
                                  <div style={{ fontSize: '9px', color: card.early ? 'rgba(167,139,250,0.70)' : 'rgba(255,255,255,0.28)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '7px' }}>{card.label}</div>
                                  {card.locked ? (
                                    <div style={{ fontSize: '11px', color: '#7dd3fc', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.4 }}>
                                      Not calculated yet
                                      <div style={{ fontSize: '9px', color: 'rgba(125,211,252,0.55)', marginTop: '3px' }}>{card.lockNote}</div>
                                    </div>
                                  ) : (
                                    <div style={{ fontSize: '16px', fontWeight: 800, fontFamily: 'var(--font-inter, Inter, sans-serif)', color: card.early ? '#a78bfa' : ('pnl' in card && card.pnl !== null && card.pnl !== undefined ? (card.pnl >= 0 ? '#4ade80' : '#f87171') : '#e2e8f0') }}>{card.value}</div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )
                        })()}

                        {!hasEnough && (
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
                    ? `${ts.winningClosedLots} matched positive lot${ts.winningClosedLots !== 1 ? 's' : ''}`
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
                  : hasEnough ? fmtSignedUSD(walletIntel.pnl.avgWin) : 'Open Check'
                const avgLossDisplay = ts && closedLots > 0 && ts.losingClosedLots === 0
                  ? 'No matched losing closed lots found'
                  : avgMatchedLoss !== null ? fmtSignedUSD(avgMatchedLoss) : 'Open Check'
                const biggestWinDisplay = hasEnough
                  ? (ts?.largestWinUsd !== null && ts?.largestWinUsd !== undefined ? fmtSignedUSD(ts.largestWinUsd) : fmtSignedUSD(walletIntel.pnl.biggestWin))
                  : ts?.largestWinUsd !== null && ts?.largestWinUsd !== undefined && closedLots > 0
                    ? fmtSignedUSD(ts.largestWinUsd)
                    : 'Open Check'
                const biggestLossDisplay = ts && closedLots > 0 && ts.losingClosedLots === 0
                  ? 'No matched losing closed lots found'
                  : ts?.largestLossUsd !== null && ts?.largestLossUsd !== undefined
                    ? fmtSignedUSD(ts.largestLossUsd)
                    : 'Open Check'
                const avgHoldDisplay = walletIntel.tradeBehavior?.avgHoldTime ?? 'Open Check'
                return (
                  <div style={{ background: '#080c14', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '16px', padding: '20px 22px' }}>
                    <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.18em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '14px' }}>Trade Behavior</div>
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
                        <div key={card.label} style={{ background: ('early' in card && card.early) ? 'rgba(167,139,250,0.06)' : ('noLoss' in card && card.noLoss) ? 'rgba(45,212,191,0.06)' : 'rgba(255,255,255,0.03)', border: `1px solid ${('early' in card && card.early) ? 'rgba(167,139,250,0.20)' : ('noLoss' in card && card.noLoss) ? 'rgba(45,212,191,0.20)' : 'rgba(255,255,255,0.07)'}`, borderRadius: '12px', padding: '12px' }}>
                          <div style={{ fontSize: '9px', color: ('early' in card && card.early) ? 'rgba(167,139,250,0.65)' : ('noLoss' in card && card.noLoss) ? 'rgba(45,212,191,0.65)' : 'rgba(255,255,255,0.28)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '7px' }}>{card.label}</div>
                          <div style={{ fontSize: '16px', fontWeight: 800, color: ('early' in card && card.early) ? '#a78bfa' : ('noLoss' in card && card.noLoss) ? '#2DD4BF' : String(card.value).includes('Open Check') || String(card.value).includes('Locked') || String(card.value).includes('No closed') ? '#7dd3fc' : '#e2e8f0', lineHeight: 1.25 }}>{card.value}</div>
                        </div>
                      ))}
                    </div>
                    {!hasEnough && closedLots > 0 && (
                      <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.30)', marginTop: '10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.5 }}>
                        Not calculated yet — requires 10+ verified closed lots. This does not prove the wallet has never lost money.
                      </div>
                    )}
                  </div>
                )
              })()}

              <div style={{ background: '#080c14', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '16px', padding: '20px 22px' }}>
                <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.18em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '10px' }}>AI Wallet Personality</div>
                <p style={{ margin: 0, color: '#cbd5e1', fontSize: '13px', lineHeight: 1.75, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{walletIntel.personalitySummary}</p>
                {(result.walletTradeStatsSummary?.closedLots ?? 0) > 0 && (
                  <p style={{ margin: '10px 0 0', color: 'rgba(255,255,255,0.38)', fontSize: '11px', lineHeight: 1.55, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                    Portfolio value reflects current holdings; trade stats only reflect reconstructed closed lots, so large open holdings are not included in realized PnL.
                  </p>
                )}
                {walletIntel.openChecks.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '14px' }}>
                    {walletIntel.openChecks.map(check => (
                      <span key={check} style={{ fontSize: '10px', color: '#7dd3fc', border: '1px solid rgba(125,211,252,0.18)', background: 'rgba(56,189,248,0.06)', borderRadius: 999, padding: '5px 9px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{check}</span>
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


              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[
                  'Portfolio read: CORTEX',
                  ...(hasUsefulActivity ? ['Base activity: CORTEX'] : []),
                  'Release view',
                ].map((chip) => (
                  <span key={chip} style={{ fontSize: 11, color: '#94a3b8', border: '1px solid rgba(148,163,184,0.25)', borderRadius: 999, padding: '5px 10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                    {chip}
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
                return (
                  <div style={{
                    background: '#080c14',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '16px', overflow: 'hidden',
                  }}>
                    <div className="md:hidden" style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px' }}>
                      {visible.map((h, i) => {
                        const up = (h.change24h ?? 0) >= 0
                        const chainLabel = h.chain ? h.chain.replace(/-mainnet$/, '').replace(/-/g, ' ') : null
                        return (
                          <div key={`m-${i}`} style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '12px', background: 'rgba(255,255,255,0.01)', width: '100%', maxWidth: '100%', minWidth: 0 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, minWidth: 0 }}>
                              <div style={{ display: 'flex', gap: 10, minWidth: 0 }}>
                                {h.icon ? <img src={h.icon} alt={h.symbol} width={30} height={30} style={{ borderRadius: '50%', flexShrink: 0 }} /> : <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'linear-gradient(135deg,#2DD4BF,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, color: '#04101a', flexShrink: 0 }}>{h.symbol.slice(0,2).toUpperCase()}</div>}
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontSize: 13, fontWeight: 700, color: '#f8fafc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.symbol || h.name}</div>
                                  {h.name && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.name}</div>}
                                </div>
                              </div>
                              {chainLabel && <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.07em', padding: '2px 6px', borderRadius: 999, background: 'rgba(0,82,255,0.14)', border: '1px solid rgba(0,82,255,0.28)', color: '#6ea8ff', textTransform: 'uppercase', height: 'fit-content', flexShrink: 0 }}>{chainLabel}</span>}
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: 10 }}>
                              <div><div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>Balance</div><div style={{ fontSize: 13 }}>{fmtBalance(h.balance)}</div></div>
                              <div><div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>Value</div><div style={{ fontSize: 13 }}>{h.value > 0 ? fmtUSD(h.value) : 'Unverified'}</div></div>
                              <div><div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>24h</div><div style={{ fontSize: 13, color: h.change24h === null ? 'rgba(255,255,255,0.30)' : up ? '#2DD4BF' : '#ef4444' }}>{h.change24h === null ? '—' : fmtPct(h.change24h)}</div></div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    {/* Table header */}
                    <div className="ws-holdings-header" style={{
                      display: 'grid', gridTemplateColumns: '1fr 110px 120px 88px',
                      padding: '12px 20px',
                      borderBottom: '1px solid rgba(255,255,255,0.06)',
                      fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
                      color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase',
                      fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                    }}>
                      <span>Token</span>
                      <span style={{ textAlign: 'right' }}>Balance</span>
                      <span style={{ textAlign: 'right' }}>Value USD</span>
                      <span style={{ textAlign: 'right' }}>24h</span>
                    </div>

                    {/* Rows */}
                    {visible.map((h, i) => {
                      const up = (h.change24h ?? 0) >= 0
                      const chainLabel = h.chain
                        ? h.chain.replace(/-mainnet$/, '').replace(/-/g, ' ')
                        : null
                      const isLast = i === visible.length - 1 && (showAllHoldings || sorted.length <= PREVIEW)
                      return (
                        <div
                          key={i}
                          className="ws-row ws-holdings-row"
                          style={{
                            display: 'grid', gridTemplateColumns: '1fr 110px 120px 88px',
                            padding: '14px 20px',
                            borderBottom: isLast ? 'none' : '1px solid rgba(255,255,255,0.04)',
                            alignItems: 'center',
                            transition: 'background 0.12s',
                          }}
                        >
                          {/* Token col */}
                          <div className="ws-col-token" style={{ display: 'flex', alignItems: 'center', gap: '11px', minWidth: 0 }}>
                            {/* Logo */}
                            {h.icon ? (
                              <img src={h.icon} alt={h.symbol} width={34} height={34}
                                style={{ borderRadius: '50%', flexShrink: 0 }}
                                onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                              />
                            ) : (
                              <div style={{
                                width: '34px', height: '34px', borderRadius: '50%', flexShrink: 0,
                                background: 'linear-gradient(135deg,#2DD4BF,#8b5cf6)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: '11px', fontWeight: 800, color: '#04101a',
                              }}>
                                {h.symbol.slice(0, 2).toUpperCase()}
                              </div>
                            )}
                            {/* Name + chain pill */}
                            <div style={{ minWidth: 0 }}>
                              <div style={{
                                fontSize: '14px', fontWeight: 600, color: '#f1f5f9',
                                fontFamily: 'var(--font-inter, Inter, sans-serif)',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                marginBottom: '3px',
                              }}>
                                {h.symbol}
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                                <span style={{
                                  fontSize: '11px', color: 'rgba(255,255,255,0.28)',
                                  fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                  maxWidth: '80px',
                                }}>
                                  {h.name}
                                </span>
                                {chainLabel && (
                                  <span style={{
                                    fontSize: '9px', fontWeight: 700, letterSpacing: '0.07em',
                                    padding: '2px 6px', borderRadius: '99px', flexShrink: 0,
                                    background: chainLabel === 'base'
                                      ? 'rgba(0,82,255,0.14)'
                                      : chainLabel === 'ethereum'
                                        ? 'rgba(98,126,234,0.14)'
                                        : 'rgba(139,92,246,0.14)',
                                    border: chainLabel === 'base'
                                      ? '1px solid rgba(0,82,255,0.28)'
                                      : chainLabel === 'ethereum'
                                        ? '1px solid rgba(98,126,234,0.28)'
                                        : '1px solid rgba(139,92,246,0.28)',
                                    color: chainLabel === 'base'
                                      ? '#6ea8ff'
                                      : chainLabel === 'ethereum'
                                        ? '#a3b4f7'
                                        : '#c4b5fd',
                                    textTransform: 'uppercase',
                                    fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                                  }}>
                                    {chainLabel}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Balance */}
                          <div className="ws-col-balance" style={{
                            textAlign: 'right', fontSize: '13px', color: 'rgba(255,255,255,0.50)',
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
                          width: '100%', padding: '13px 20px',
                          background: 'none',
                          border: 'none', borderTop: '1px solid rgba(255,255,255,0.06)',
                          cursor: 'pointer', display: 'flex', alignItems: 'center',
                          justifyContent: 'center', gap: '6px',
                          fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em',
                          color: 'rgba(255,255,255,0.40)',
                          fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                          transition: 'color 0.15s',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.color = '#2DD4BF')}
                        onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.40)')}
                      >
                        {showAllHoldings ? (
                          <>
                            Show less
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M18 15l-6-6-6 6"/>
                            </svg>
                          </>
                        ) : (
                          <>
                            View all tokens ({hidden} more)
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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
                  background: '#080c14', border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: '14px', color: 'rgba(255,255,255,0.30)',
                  fontSize: '13px', fontFamily: 'var(--font-inter, Inter, sans-serif)',
                }}>
                  {result.reason
                    ? result.reason
                    : 'No token balances found for this wallet.'}
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.18)', marginTop: '6px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                    ChainLens intelligence checks complete · Try a different wallet or check back later
                  </div>
                </div>
              )}

              {/* ── CORTEX Wallet Read (inline — visible on mobile where sidebar is hidden) ── */}
              <div style={{
                background: '#080c14',
                border: '1px solid rgba(45,212,191,0.18)',
                borderRadius: '16px', overflow: 'hidden',
              }}>
                <div style={{ height: '2px', background: 'linear-gradient(90deg,#2DD4BF,#8b5cf6)', opacity: clarkVerdict ? 1 : 0.25 }} />
                <div style={{ padding: '18px 22px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '16px' }}>
                    <div style={{
                      width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0,
                      background: (clarkLoading || clarkVerdict) ? '#2DD4BF' : 'rgba(45,212,191,0.22)',
                      boxShadow: (clarkLoading || clarkVerdict) ? '0 0 8px rgba(45,212,191,0.70)' : 'none',
                      animation: clarkLoading ? 'clarkPulse 1.2s ease-in-out infinite' : 'none',
                    }} />
                    <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em', color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                      CORTEX Wallet Read
                    </span>
                  </div>

                  {clarkLoading && (
                    <div>
                      <ClarkDots />
                      <p style={{ marginTop: '8px', fontSize: '12px', color: 'rgba(255,255,255,0.35)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                        CORTEX is reading wallet activity…
                      </p>
                    </div>
                  )}

                  {!clarkLoading && clarkError && (
                    <p style={{ margin: 0, fontSize: '12px', color: '#fca5a5', lineHeight: 1.7, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                      {clarkError}
                    </p>
                  )}

                  {!clarkLoading && !clarkVerdict && (
                    <p style={{ margin: 0, fontSize: '12px', color: 'rgba(255,255,255,0.28)', lineHeight: 1.7, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                      Scan a wallet to generate a CORTEX wallet read.
                    </p>
                  )}

                  {!clarkLoading && clarkVerdict && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{ padding: '3px 10px', borderRadius: '99px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', background: 'rgba(45,212,191,0.12)', border: '1px solid rgba(45,212,191,0.28)', color: '#2DD4BF' }}>
                          {clarkVerdict.verdict}
                        </span>
                        <span style={{ padding: '3px 10px', borderRadius: '99px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.25)', color: '#fbbf24' }}>
                          {clarkVerdict.confidence} confidence
                        </span>
                      </div>

                      <p style={{ margin: 0, fontSize: '13px', color: '#f1f5f9', lineHeight: 1.6, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                        {clarkVerdict.read}
                      </p>

                      <div>
                        <p style={{ margin: '0 0 6px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Activity Read</p>
                        {clarkVerdict.keySignals.slice(0, 4).map((line, i) => (
                          <p key={i} style={{ margin: '0 0 4px', fontSize: '12px', color: i === 3 ? '#a78bfa' : '#cbd5e1' }}>— {line}</p>
                        ))}
                      </div>

                      <div>
                        <p style={{ margin: '0 0 6px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Missing Checks</p>
                        {clarkVerdict.risks.slice(0, 3).map((line, i) => (
                          <p key={i} style={{ margin: '0 0 4px', fontSize: '12px', color: '#fca5a5' }}>— {line}</p>
                        ))}
                      </div>

                      <div>
                        <p style={{ margin: '0 0 4px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Next action</p>
                        <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8' }}>{clarkVerdict.nextAction}</p>
                      </div>

                      <p style={{ margin: 0, fontSize: '10px', color: 'rgba(255,255,255,0.20)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                        Powered by CORTEX — verified on-chain data only
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
          width: '380px', flexShrink: 0,
          borderLeft: '1px solid rgba(255,255,255,0.08)',
          background: '#080c14',
          display: 'flex', flexDirection: 'column',
        }}>
          {/* Top gradient accent */}
          <div style={{
            height: '2px', flexShrink: 0,
            background: 'linear-gradient(90deg, #2DD4BF, #8b5cf6)',
            opacity: false ? 1 : 0.18,
            transition: 'opacity 0.4s',
          }} />

          {/* Header */}
          <div style={{
            padding: '20px 24px 16px', flexShrink: 0,
            borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: result ? '10px' : 0 }}>
              <div style={{
                width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                background: false ? '#2DD4BF' : 'rgba(45,212,191,0.22)',
                boxShadow: false ? '0 0 8px rgba(45,212,191,0.70)' : 'none',
                animation: 'none',
                transition: 'background 0.3s, box-shadow 0.3s',
              }} />
              <span style={{
                fontSize: '11px', fontWeight: 700, letterSpacing: '0.18em',
                color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              }}>
                Clark AI Verdict
              </span>
            </div>
            {result && (
              <div style={{
                fontSize: '11px', color: 'rgba(255,255,255,0.28)',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {result.address.slice(0, 10)}…{result.address.slice(-8)}
              </div>
            )}
          </div>

          {/* Body */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {clarkLoading && (
              <div>
                <ClarkDots />
                <p style={{ marginTop: '8px', fontSize: '12px', color: '#67e8f9', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                  CORTEX is reading wallet activity…
                </p>
              </div>
            )}
            {!clarkLoading && clarkError && (
              <p style={{ fontSize: '13px', color: '#fca5a5', lineHeight: 1.7, fontFamily: 'var(--font-inter, Inter, sans-serif)', margin: 0 }}>
                {clarkError}
              </p>
            )}
            {!clarkLoading && !clarkError && !clarkVerdict && (
              <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.22)', lineHeight: 1.7, fontFamily: 'var(--font-inter, Inter, sans-serif)', margin: 0 }}>
                Scan a wallet to generate a CORTEX wallet read.
              </p>
            )}
            {!clarkLoading && clarkVerdict && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ padding: '3px 10px', borderRadius: '99px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', background: 'rgba(45,212,191,0.12)', border: '1px solid rgba(45,212,191,0.28)', color: '#2DD4BF' }}>{clarkVerdict.verdict}</span>
                </div>
                <div><p style={{ margin: '0 0 4px', fontSize: '10px', color: '#64748b', letterSpacing: '0.10em', textTransform: 'uppercase' }}>Portfolio Read</p><p style={{ margin: 0, fontSize: '12px', color: '#e2e8f0', lineHeight: 1.6 }}>{clarkVerdict.read}</p></div>
                <div><p style={{ margin: '0 0 4px', fontSize: '10px', color: '#64748b', letterSpacing: '0.10em', textTransform: 'uppercase' }}>Activity Read</p>{clarkVerdict.keySignals.slice(0, 2).map((line, i) => <p key={i} style={{ margin: '0 0 4px', fontSize: '12px', color: '#cbd5e1' }}>— {line}</p>)}</div>
                <div><p style={{ margin: '0 0 4px', fontSize: '10px', color: '#64748b', letterSpacing: '0.10em', textTransform: 'uppercase' }}>Risk / Concentration</p><p style={{ margin: 0, fontSize: '12px', color: '#fcd34d' }}>— {clarkVerdict.keySignals[2]}</p></div>
                {clarkVerdict.keySignals[3] && <div><p style={{ margin: '0 0 4px', fontSize: '10px', color: '#64748b', letterSpacing: '0.10em', textTransform: 'uppercase' }}>Real Trade Evidence</p><p style={{ margin: 0, fontSize: '12px', color: '#a78bfa' }}>— {clarkVerdict.keySignals[3]}</p></div>}
                <div><p style={{ margin: '0 0 4px', fontSize: '10px', color: '#64748b', letterSpacing: '0.10em', textTransform: 'uppercase' }}>Missing Checks</p>{clarkVerdict.risks.slice(0, 3).map((line, i) => <p key={i} style={{ margin: '0 0 4px', fontSize: '12px', color: '#fca5a5' }}>— {line}</p>)}</div>
                <div><p style={{ margin: '0 0 4px', fontSize: '10px', color: '#64748b', letterSpacing: '0.10em', textTransform: 'uppercase' }}>Next Action</p><p style={{ margin: 0, fontSize: '12px', color: '#94a3b8' }}>{clarkVerdict.nextAction}</p></div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div style={{
            flexShrink: 0, padding: '12px 24px',
            borderTop: '1px solid rgba(255,255,255,0.06)',
            fontSize: '10px', color: 'rgba(255,255,255,0.20)',
            letterSpacing: '0.05em', lineHeight: 1.5,
            fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
          }}>
            Powered by CORTEX — Real-time onchain analysis
          </div>
        </aside>
      </div>
    </>
  )
}
