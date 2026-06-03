'use client'

import { useState, type ReactNode } from 'react'
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

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

// ── Loading dots ──────────────────────────────────────────────────────────────────────────────

function ClarkDots() {
  return (
    <div className="flex items-center gap-1.5 py-1">
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-teal-300 shadow-[0_0_12px_rgba(45,212,191,0.65)]"
        />
      ))}
    </div>
  )
}


type CardProps = {
  title: string
  eyebrow?: string
  children: ReactNode
  accent?: 'teal' | 'blue' | 'violet' | 'amber'
  className?: string
}

const accentClasses: Record<NonNullable<CardProps['accent']>, string> = {
  teal: 'before:bg-[#10B981]',
  blue: 'before:bg-[#3B82F6]',
  violet: 'before:bg-[#3B82F6]',
  amber: 'before:bg-[#F59E0B]',
}

function DashboardCard({ title, eyebrow, children, accent = 'teal', className = '' }: CardProps) {
  return (
    <section className={`relative overflow-hidden rounded-xl border border-white/[0.06] bg-[#111827] p-5 shadow-[0_0_20px_rgba(0,0,0,0.3)] transition-all duration-200 before:absolute before:left-0 before:top-0 before:h-px before:w-full before:opacity-70 hover:shadow-[0_0_30px_rgba(0,0,0,0.45)] md:p-6 ${accentClasses[accent]} ${className}`}>
      <div className="relative mb-5 flex items-center justify-between gap-3">
        <div>
          {eyebrow && <p className="mb-1 font-mono text-xs font-semibold uppercase tracking-[0.18em] text-[#9CA3AF]">{eyebrow}</p>}
          <h2 className="text-lg font-semibold tracking-tight text-[#F3F4F6]">{title}</h2>
        </div>
        <div className="h-2 w-2 rounded-full bg-[#3B82F6] shadow-[0_0_18px_rgba(59,130,246,0.8)]" />
      </div>
      {children}
    </section>
  )
}

type HeaderBarProps = {
  input: string
  setInput: (value: string) => void
  loading: boolean
  handleScan: () => void
  result: WalletResult | null
  deepActivity: boolean
  setDeepActivity: (updater: (value: boolean) => boolean) => void
}

function HeaderBar({ input, setInput, loading, handleScan, result, deepActivity, setDeepActivity }: HeaderBarProps) {
  return (
    <header className="rounded-xl border border-white/[0.06] bg-[#111827] p-5 shadow-[0_0_20px_rgba(0,0,0,0.3)] transition-all duration-200 hover:shadow-[0_0_30px_rgba(0,0,0,0.45)] md:p-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-[#F3F4F6] md:text-2xl">Wallet Scanner</h1>
            <span className="rounded-full border border-blue-500/30 bg-blue-500/20 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-blue-400">Base native</span>
            <span className="rounded-full border border-green-500/30 bg-green-500/20 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-green-400">Elite</span>
          </div>
          <p className="max-w-2xl text-sm text-[#9CA3AF]">Advanced on-chain intelligence and AI-powered wallet analysis.</p>
          <p className="mt-2 font-mono text-xs text-[#9CA3AF]/75">
            {result?.address ? `Scanned wallet: ${shortAddr(result.address)}` : 'Paste any 0x wallet address to start a scan.'}
          </p>
        </div>

        <div className="w-full max-w-2xl space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative min-w-0 flex-1">
              <button
                type="button"
                onClick={() => navigator.clipboard.readText().then(t => setInput(t)).catch(() => {})}
                title="Paste from clipboard"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9CA3AF] transition hover:text-[#3B82F6]"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="2" width="6" height="4" rx="1" />
                  <rect x="4" y="6" width="16" height="16" rx="2" />
                  <path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2" />
                </svg>
              </button>
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleScan() }}
                disabled={loading}
                placeholder="0x… wallet address"
                spellCheck={false}
                className="w-full rounded-xl border border-white/[0.06] bg-[#0B0F19]/80 py-3 pl-10 pr-4 font-mono text-sm text-[#F3F4F6] outline-none transition placeholder:text-[#9CA3AF]/45 focus:border-[#3B82F6]/60 focus:bg-[#0B0F19] disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
            <button
              type="button"
              onClick={handleScan}
              disabled={loading || !input.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3B82F6] px-6 py-3 font-mono text-xs font-bold uppercase tracking-[0.16em] text-white shadow-[0_0_24px_rgba(59,130,246,0.28)] transition hover:bg-blue-400 disabled:cursor-not-allowed disabled:bg-blue-500/20 disabled:text-white/35 disabled:shadow-none"
            >
              {loading ? 'Scanning…' : 'Scan'}
              {!loading && <span aria-hidden="true">→</span>}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setDeepActivity(v => !v)}
              disabled={loading}
              title="Fetches transfer history for estimated PnL and future trade reconstruction. Slower scan."
              className={`rounded-lg border px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em] transition disabled:cursor-not-allowed disabled:opacity-60 ${deepActivity ? 'border-green-500/30 bg-green-500/20 text-green-400' : 'border-white/[0.06] bg-[#0B0F19]/60 text-[#9CA3AF] hover:border-blue-500/30 hover:text-blue-400'}`}
            >
              {deepActivity ? 'Deep Activity Scan On' : 'Run Deep Activity Scan'}
            </button>
            <span className="font-mono text-[10px] tracking-wide text-[#9CA3AF]/60">
              {deepActivity ? 'Heavier analysis · cached between runs' : 'Fetches transfer history · slower scan'}
            </span>
          </div>
        </div>
      </div>
    </header>
  )
}

function SummaryRow({ data, quality }: { data: WalletResult; quality: string }) {
  const portfolio = derivePortfolioIntelligence(data)
  const ts = data.walletTradeStatsSummary
  const pnl = ts?.realizedPnlUsd ?? data.walletLotSummary?.realizedPnlUsd ?? data.estimatedPnl?.totalEstimatedPnlUsd ?? null
  const activity = data.walletFacts?.activity?.eventCount ?? data.walletBehavior?.txCount ?? data.txCount
  const items = [
    { label: 'Portfolio Value', value: portfolio.totalValue > 0 ? fmtUSD(portfolio.totalValue) : 'Value pending', sub: `${portfolio.holdingsCount} visible holding${portfolio.holdingsCount === 1 ? '' : 's'}`, tone: 'text-[#10B981]' },
    { label: 'Concentration', value: portfolio.concentration ? portfolio.concentration.toUpperCase() : 'Open Check', sub: portfolio.topShare !== null ? `Top asset ${portfolio.topShare.toFixed(1)}%` : 'Top asset pending', tone: 'text-[#3B82F6]' },
    { label: 'Activity', value: activity !== null && activity !== undefined ? activity.toLocaleString() : 'Open Check', sub: quality, tone: 'text-[#3B82F6]' },
    { label: 'PnL', value: fmtSignedUSD(pnl), sub: data.pnlCoverageReason ?? data.estimatedPnl?.reason ?? 'Matched evidence only', tone: pnl !== null && pnl >= 0 ? 'text-[#10B981]' : pnl !== null ? 'text-[#EF4444]' : 'text-[#9CA3AF]' },
    { label: 'Closed Lots', value: `${ts?.closedLots ?? data.walletLotSummary?.closedLots ?? 0}`, sub: ts?.sampleSizeLabel ? `Sample: ${ts.sampleSizeLabel}` : 'Requires matched exits', tone: 'text-[#F59E0B]' },
  ]

  return (
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      {items.map(item => (
        <div key={item.label} className="rounded-xl border border-white/[0.06] bg-[#111827] p-5 shadow-[0_0_20px_rgba(0,0,0,0.3)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_0_30px_rgba(0,0,0,0.45)]">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-[#9CA3AF]">{item.label}</p>
          <p className={`mt-2 font-mono text-2xl font-semibold tracking-tight ${item.tone}`}>{item.value}</p>
          <p className="mt-2 line-clamp-2 text-xs leading-5 text-[#9CA3AF]">{item.sub}</p>
        </div>
      ))}
    </section>
  )
}

function AIVerdictCard({ clarkVerdict, clarkLoading, clarkError }: { clarkVerdict: ClarkVerdict | null; clarkLoading: boolean; clarkError: string | null }) {
  return (
    <DashboardCard title="AI Verdict" eyebrow="CORTEX wallet read" accent="teal">
      {clarkLoading && (
        <div className="space-y-3">
          <ClarkDots />
          <p className="font-mono text-xs text-cyan-200">CORTEX is reading wallet activity…</p>
        </div>
      )}
      {!clarkLoading && clarkError && <p className="text-sm leading-6 text-[#EF4444]">{clarkError}</p>}
      {!clarkLoading && !clarkError && !clarkVerdict && <p className="text-sm leading-6 text-[#9CA3AF]">Scan a wallet to generate a CORTEX wallet read.</p>}
      {!clarkLoading && clarkVerdict && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-blue-500/30 bg-blue-500/20 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-blue-400">{clarkVerdict.verdict}</span>
            <span className={`rounded-full px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] ${clarkVerdict.confidence.toLowerCase().includes('high') ? 'border border-green-500/30 bg-green-500/20 text-green-400' : clarkVerdict.confidence.toLowerCase().includes('medium') ? 'border border-amber-500/30 bg-amber-500/20 text-amber-400' : 'border border-red-500/30 bg-red-500/20 text-red-400'}`}>Confidence: {clarkVerdict.confidence}</span>
          </div>
          <p className="text-sm leading-6 text-[#F3F4F6]/80">{clarkVerdict.read}</p>
          <div className="space-y-3">
            {clarkVerdict.keySignals.slice(0, 4).map((line, i) => (
              <p key={i} className="rounded-lg border border-white/[0.06] bg-white/[0.04] p-3 text-xs leading-5 text-[#F3F4F6]/80">{line}</p>
            ))}
          </div>
          <div>
            <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#EF4444]/80">Missing checks</p>
            <ul className="space-y-2">
              {clarkVerdict.risks.slice(0, 3).map((line, i) => <li key={i} className="text-xs leading-5 text-rose-200/80">— {line}</li>)}
            </ul>
          </div>
          <p className="border-t border-white/[0.06] pt-3 text-xs leading-5 text-[#9CA3AF]">{clarkVerdict.nextAction}</p>
        </div>
      )}
    </DashboardCard>
  )
}

function PortfolioExposureCard({ data, showAllHoldings, setShowAllHoldings }: { data: WalletResult; showAllHoldings: boolean; setShowAllHoldings: (updater: (value: boolean) => boolean) => void }) {
  const portfolio = derivePortfolioIntelligence(data)
  const sorted = [...data.holdings].sort((a, b) => b.value - a.value)
  const preview = showAllHoldings ? sorted : sorted.slice(0, 5)

  return (
    <DashboardCard title="Portfolio Exposure" eyebrow={portfolio.holdingsScope} accent="blue">
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.04] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#9CA3AF]">Type</p>
          <p className="mt-1 text-sm font-bold text-[#F3F4F6]">{portfolio.portfolioType}</p>
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.04] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#9CA3AF]">Stable</p>
          <p className="mt-1 text-sm font-bold text-[#10B981]">{portfolio.stablePercent.toFixed(1)}%</p>
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.04] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#9CA3AF]">Native</p>
          <p className="mt-1 text-sm font-bold text-[#3B82F6]">{portfolio.ethPercent.toFixed(1)}%</p>
        </div>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        {portfolio.top3.map(h => {
          const pct = portfolio.totalValue > 0 ? (h.value / portfolio.totalValue) * 100 : null
          return <span key={`${h.symbol}-${h.chain}`} className="rounded-full border border-white/[0.06] bg-white/[0.04] px-3 py-1 font-mono text-[11px] text-[#F3F4F6]/80">{h.symbol || h.name}{pct !== null ? ` · ${pct.toFixed(0)}%` : ''}</span>
        })}
        {portfolio.chains.map(chain => <span key={chain} className="rounded-full border border-blue-400/25 bg-blue-500/10 px-3 py-1 font-mono text-[11px] uppercase tracking-wide text-[#3B82F6]">{chain}</span>)}
      </div>
      <div className="overflow-hidden rounded-xl border border-white/[0.06]">
        <div className="grid grid-cols-[1.4fr_1fr_1fr] bg-white/[0.04] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-[#9CA3AF]">
          <span>Token</span><span className="text-right">Balance</span><span className="text-right">Value</span>
        </div>
        {preview.length === 0 ? (
          <p className="p-4 text-sm text-[#9CA3AF]">No visible holdings in the checked window.</p>
        ) : preview.map(h => (
          <div key={`${h.symbol}-${h.name}-${h.chain}`} className="grid grid-cols-[1.4fr_1fr_1fr] items-center border-t border-white/[0.06] px-3 py-3 text-sm">
            <div className="min-w-0">
              <p className="truncate font-bold text-[#F3F4F6]">{h.symbol || h.name}</p>
              <p className="truncate text-xs text-[#9CA3AF]">{h.name}{h.chain ? ` · ${h.chain}` : ''}</p>
            </div>
            <p className="text-right font-mono text-xs text-[#9CA3AF]">{fmtBalance(h.balance)}</p>
            <p className="text-right font-mono text-xs font-bold text-[#10B981]">{fmtUSD(h.value)}</p>
          </div>
        ))}
      </div>
      {sorted.length > 5 && (
        <button type="button" onClick={() => setShowAllHoldings(v => !v)} className="mt-3 rounded-lg border border-white/[0.06] px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#9CA3AF] transition hover:border-blue-500/30 hover:text-[#10B981]">
          {showAllHoldings ? 'Show fewer holdings' : `Show all ${sorted.length} holdings`}
        </button>
      )}
    </DashboardCard>
  )
}

function ActivityIndexCard({ data }: { data: WalletResult }) {
  const activity = data.walletFacts?.activity
  const behavior = data.walletBehavior
  const totalEvents = activity?.eventCount ?? behavior?.txCount ?? data.txCount
  const latestEvents = activity?.latestEvents ?? []
  const unavailable = hasActivityProviderUnavailable(data)

  return (
    <DashboardCard title="Activity Index" eyebrow="Base behavior" accent="violet">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.04] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#9CA3AF]">Events</p>
          <p className="mt-1 text-xl font-black text-[#3B82F6]">{totalEvents !== null && totalEvents !== undefined ? totalEvents.toLocaleString() : 'Open'}</p>
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.04] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#9CA3AF]">Inbound</p>
          <p className="mt-1 text-xl font-black text-[#10B981]">{activity?.inboundCount ?? behavior?.inboundCount ?? '—'}</p>
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.04] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#9CA3AF]">Outbound</p>
          <p className="mt-1 text-xl font-black text-[#F59E0B]">{activity?.outboundCount ?? behavior?.outboundCount ?? '—'}</p>
        </div>
      </div>
      <p className="mt-4 text-sm leading-6 text-[#9CA3AF]">
        {activity && activity.eventCount > 0
          ? `${activity.eventCount} indexed transfer events across ${activity.groupedTxCount} tx groups — ${activity.walletInitiatedTxCount} wallet-initiated.`
          : unavailable
            ? ACTIVITY_UNAVAILABLE_COPY
            : behavior?.recentActivitySummary ?? 'Activity signal is limited in current checks.'}
      </p>
      {latestEvents.length > 0 && (
        <div className="mt-4 space-y-2">
          {latestEvents.slice(0, 3).map(event => (
            <div key={`${event.txHash}-${event.timestamp}-${event.symbol}`} className="rounded-lg border border-white/[0.06] bg-white/[0.04] p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="font-mono text-xs font-bold text-[#F3F4F6]">{event.symbol}</p>
                <p className="font-mono text-[10px] uppercase tracking-wide text-[#9CA3AF]">{event.direction}</p>
              </div>
              <p className="mt-1 text-xs text-[#9CA3AF]">{event.timestamp} · {fmtBalance(event.amount)} units</p>
            </div>
          ))}
        </div>
      )}
    </DashboardCard>
  )
}

function TradingIntelligenceCard({ data }: { data: WalletResult }) {
  const walletIntel = buildWalletIntelligence(data)
  const ts = data.walletTradeStatsSummary
  const closedLots = ts?.closedLots ?? 0
  const pnl = walletIntel.pnl
  const stats = [
    { label: 'Wallet Tier', value: walletIntel.walletTier, tone: 'text-[#10B981]' },
    { label: 'Score', value: walletIntel.walletScore !== null ? `${walletIntel.walletScore}/100` : 'Open Check', tone: 'text-[#3B82F6]' },
    { label: 'Win Rate', value: walletIntel.winRate !== null ? fmtOpenPct(walletIntel.winRate) : officialWinRateLockCopy(ts), tone: 'text-[#10B981]' },
    { label: 'Realized PnL', value: fmtSignedUSD(pnl.realized), tone: pnl.realized !== null && pnl.realized >= 0 ? 'text-[#10B981]' : pnl.realized !== null ? 'text-[#EF4444]' : 'text-[#F3F4F6]/80' },
  ]

  return (
    <DashboardCard title="Trading Intelligence" eyebrow="Closed-lot evidence" accent="amber">
      <div className="grid gap-3 md:grid-cols-2">
        {stats.map(item => (
          <div key={item.label} className="rounded-lg border border-white/[0.06] bg-white/[0.04] p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#9CA3AF]">{item.label}</p>
            <p className={`mt-2 text-lg font-black ${item.tone}`}>{item.value}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-xl border border-white/[0.06] bg-black/20 p-4">
        <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-[#9CA3AF]">Personality Summary</p>
        <p className="mt-2 text-sm leading-6 text-[#F3F4F6]/80">{walletIntel.personalitySummary}</p>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.04] p-3"><p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#9CA3AF]">Closed Lots</p><p className="mt-1 text-xl font-black text-[#F59E0B]">{closedLots}</p></div>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.04] p-3"><p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#9CA3AF]">Avg Win</p><p className="mt-1 text-xl font-black text-[#10B981]">{fmtSignedUSD(pnl.avgWin)}</p></div>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.04] p-3"><p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#9CA3AF]">Avg Loss</p><p className="mt-1 text-xl font-black text-[#EF4444]">{fmtSignedUSD(pnl.avgLoss)}</p></div>
      </div>
    </DashboardCard>
  )
}

function MatchedTradesTable({ data }: { data: WalletResult }) {
  const samples = data.walletClosedTradeSamples ?? []
  const backendTrades = data.walletIntelligence?.recentTrades ?? []

  return (
    <DashboardCard title="Matched Trades" eyebrow="FIFO samples" accent="violet">
      <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
        <table className="min-w-full overflow-hidden text-left text-sm">
          <thead className="bg-white/[0.04] font-mono text-xs uppercase tracking-[0.16em] text-[#9CA3AF]">
            <tr>
              <th className="px-3 py-3">Token</th>
              <th className="px-3 py-3 text-right">Entry</th>
              <th className="px-3 py-3 text-right">Exit</th>
              <th className="px-3 py-3 text-right">PnL</th>
              <th className="px-3 py-3 text-right">Hold</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.06]">
            {samples.length > 0 ? samples.slice(0, 8).map((sample, index) => (
              <tr key={`${sample.tokenAddress}-${sample.openedAt}-${sample.closedAt}`} className={`text-[#F3F4F6]/80 transition hover:bg-white/10 ${index % 2 === 1 ? 'bg-white/5' : 'bg-transparent'}`}>
                <td className="px-3 py-3 font-bold text-[#F3F4F6]">{sample.tokenSymbol}</td>
                <td className="px-3 py-3 text-right font-mono text-xs">{sample.entryPriceUsd !== null ? fmtUSD(sample.entryPriceUsd) : '—'}</td>
                <td className="px-3 py-3 text-right font-mono text-xs">{sample.exitPriceUsd !== null ? fmtUSD(sample.exitPriceUsd) : '—'}</td>
                <td className={`px-3 py-3 text-right font-mono text-xs font-bold ${sample.realizedPnlUsd !== null && sample.realizedPnlUsd >= 0 ? 'text-[#10B981]' : sample.realizedPnlUsd !== null ? 'text-[#EF4444]' : 'text-[#9CA3AF]'}`}>{fmtSignedUSD(sample.realizedPnlUsd)}</td>
                <td className="px-3 py-3 text-right font-mono text-xs text-[#9CA3AF]">{sample.holdingTimeSeconds !== null ? `${Math.round(sample.holdingTimeSeconds / 3600)}h` : '—'}</td>
              </tr>
            )) : backendTrades.length > 0 ? backendTrades.slice(0, 8).map((trade, index) => (
              <tr key={`${trade.token}-${index}`} className={`text-[#F3F4F6]/80 transition hover:bg-white/10 ${index % 2 === 1 ? 'bg-white/5' : 'bg-transparent'}`}>
                <td className="px-3 py-3 font-bold text-[#F3F4F6]">{trade.token}</td>
                <td className="px-3 py-3 text-right font-mono text-xs">{trade.entry !== null ? fmtUSD(trade.entry) : '—'}</td>
                <td className="px-3 py-3 text-right font-mono text-xs">{trade.exit !== null ? fmtUSD(trade.exit) : '—'}</td>
                <td className={`px-3 py-3 text-right font-mono text-xs font-bold ${trade.pnl !== null && trade.pnl >= 0 ? 'text-[#10B981]' : trade.pnl !== null ? 'text-[#EF4444]' : 'text-[#9CA3AF]'}`}>{fmtSignedUSD(trade.pnl)}</td>
                <td className="px-3 py-3 text-right font-mono text-xs text-[#9CA3AF]">{trade.holdTime ?? '—'}</td>
              </tr>
            )) : (
              <tr><td colSpan={5} className="px-3 py-8 text-center text-sm text-[#9CA3AF]">No matched closed trades available in the checked sample.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </DashboardCard>
  )
}

function WalletScannerLayout({
  children,
}: {
  children: ReactNode
}) {
  return <main className="h-full overflow-y-auto overflow-x-hidden bg-[#0B0F19] px-4 py-6 text-[#F3F4F6] sm:px-6 lg:px-10 lg:py-8">{children}</main>
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

  if (planLoading) return <div className="flex min-h-[60vh] flex-1 items-center justify-center font-mono text-[#9CA3AF]">Loading plan access…</div>
  if (!betaEliteActive && !canAccessFeature(plan, 'wallet-scanner')) return <LockedPanel feature="wallet-scanner" />

  return (
    <WalletScannerLayout>
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <HeaderBar
          input={input}
          setInput={setInput}
          loading={loading}
          handleScan={handleScan}
          result={result}
          deepActivity={deepActivity}
          setDeepActivity={setDeepActivity}
        />

        {loading && (
          <section className="rounded-xl border border-white/[0.06] bg-slate-950/70 p-5 shadow-xl shadow-black/20">
            <div className="space-y-3">
              {['w-8/12', 'w-11/12', 'w-7/12', 'w-10/12'].map((widthClass, index) => (
                <div key={index} className={`h-3 animate-pulse rounded-full bg-white/10 ${widthClass}`} />
              ))}
            </div>
          </section>
        )}

        {error && !loading && (
          <section className="rounded-xl border border-rose-400/20 bg-rose-950/20 p-4 text-sm text-rose-200">
            {error}
          </section>
        )}

        {!result && !loading && (
          <section className="rounded-xl border border-dashed border-white/[0.06] bg-slate-950/40 p-8 text-center">
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-teal-300">Ready for scan</p>
            <h2 className="mt-3 text-2xl font-black tracking-tight text-white">Three-section wallet intelligence dashboard</h2>
            <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-[#9CA3AF]">
              Scan a wallet to populate the Summary Header, AI Verdict + Portfolio cards, and Trading Intelligence + matched trade tables.
            </p>
          </section>
        )}

        {result && (
          <>
            <SummaryRow data={result} quality={dataQualityForWallet(result)} />

            <section className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.25fr)]">
              <div className="flex min-w-0 flex-col gap-5">
                <AIVerdictCard clarkVerdict={clarkVerdict} clarkLoading={clarkLoading} clarkError={clarkError} />
                <PortfolioExposureCard data={result} showAllHoldings={showAllHoldings} setShowAllHoldings={setShowAllHoldings} />
                <ActivityIndexCard data={result} />
              </div>

              <div className="flex min-w-0 flex-col gap-5">
                <TradingIntelligenceCard data={result} />
                <MatchedTradesTable data={result} />
              </div>
            </section>
          </>
        )}
      </div>
    </WalletScannerLayout>
  )
}
