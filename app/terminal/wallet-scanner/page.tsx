'use client'

import { useEffect, useState } from 'react'
import { usePlanWithLoading, LockedPanel, canAccessFeature } from '@/lib/usePlan'
import { supabase } from '@/lib/supabaseClient'

// ── Types ────────────────────────────────────────────────────────────────────────────

type Holding = {
  contract?: string
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

type WatchlistWallet = {
  id?: string
  address: string
  label?: string | null
  portfolio_value?: number | null
  chain_mode?: string | null
  source?: string | null
  saved_at?: string | null
}

type WalletTier = 'Smart Money' | 'Positive Early Read' | 'Average Trader' | 'Losing Wallet' | 'Open Check'
type WalletIntelStatus = 'ok' | 'partial' | 'open_check'
type WalletConfidence = 'high' | 'medium' | 'low' | 'open check'

const gradeToneFor = (grade: string | null | undefined) => {
  switch (grade) {
    case 'A+': return { color: '#10b981', bg: 'rgba(16,185,129,0.14)', border: 'rgba(16,185,129,0.36)' }
    case 'A': return { color: '#14b8a6', bg: 'rgba(20,184,166,0.14)', border: 'rgba(20,184,166,0.36)' }
    case 'B': return { color: '#3b82f6', bg: 'rgba(59,130,246,0.14)', border: 'rgba(59,130,246,0.36)' }
    case 'C': return { color: '#f59e0b', bg: 'rgba(245,158,11,0.14)', border: 'rgba(245,158,11,0.36)' }
    case 'D': return { color: '#f97316', bg: 'rgba(249,115,22,0.14)', border: 'rgba(249,115,22,0.36)' }
    case 'F': return { color: '#ef4444', bg: 'rgba(239,68,68,0.14)', border: 'rgba(239,68,68,0.36)' }
    default: return { color: '#c4b5fd', bg: 'rgba(139,92,246,0.12)', border: 'rgba(139,92,246,0.28)' }
  }
}

const cleanWalletArchetype = (archetype: string | null | undefined): string | null => {
  const normalized = typeof archetype === 'string' ? archetype.trim() : ''
  if (!normalized || normalized === 'null' || normalized === 'undefined' || normalized === 'Open Check') return null
  return normalized
}

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

type OpenPositionPerformanceSummary = {
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
      contract: string; symbol: string; chain: string; openLots: number
      amountRemaining: number
      avgEntryPriceUsd: number | null
      currentPriceUsd: number | null
      currentValueUsd: number | null
      costBasisUsd: number
      unrealizedPnlUsd: number | null
      unrealizedPnlPercent: number | null
    }>
  } | null

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
  pnlQuality?: 'exact_fifo' | 'exact_fifo_micro_sample' | 'fifo_with_estimates' | 'sell_side_only' | 'open_positions_cost_missing' | 'activity_only' | 'no_trade_evidence' | 'missing_cost_basis'
  pnlQualityReason?: string
  tradeIntelligence?: {
    status: 'ready' | 'partial' | 'open_check'
    tradeIntelLots: number
    publicPerformanceLots: number
    verifiedPnlLots: number
    rawMatchedLots: number
    excludedLots: number
    verifiedButExcludedLots: number
    confidence: 'high' | 'medium' | 'low'
    primaryStyle: 'high_speed_rotator' | 'portfolio_rebalancer' | 'stable_quote_rotator' | 'accumulator' | 'distributor' | 'mixed_rotator' | 'not_enough_data'
    summary: string
    signals: { uniqueTokensTraded: number; avgHoldingTimeSeconds: number | null }
    limitations: string[]
    behaviorConfidenceReason?: string
    rotationSpeedLabel?: string
    avgHoldTimeLabel?: string
    repeatedTokenPatterns?: string[]
    lossPattern?: string | null
    stablePairDependence?: 'high' | 'medium' | 'low' | 'unknown'
    riskStyle?: string
    tradeStyleSummary?: string
    evidenceQuality?: 'high' | 'medium' | 'low'
    profitSkillStatus?: 'near_flat_not_proven' | 'integrity_invalid_not_proven' | 'locked_small_sample' | 'unlocked'
  }
  publicPnlStatus?: 'ok' | 'limited_verified_sample' | 'open_check' | 'near_flat_verified_sample' | 'flat_estimate_only' | 'partial_near_flat' | 'open_check_integrity_invalid'
  publicPnlDisplayLabel?: string
  publicPnlDisplayReason?: string
  pnlIntegrityCheck?: {
    ok: boolean
    status: 'ok' | 'warning' | 'invalid'
    errors: string[]
    warnings: string[]
    violations: string[]
  }
  publicPerformanceClosedLots?: number
  verifiedButExcludedClosedLots?: number
  excludedClosedLots?: number
  rawMatchedClosedLots?: number
  publicPerformanceRealizedPnlUsd?: number | null
  publicRealizedPnlUsd?: number | null
  publicWinRatePercent?: number | null
  walletRecoveryRecommendation?: {
    recommended: boolean
    mode: 'targeted_token_recovery' | 'targeted_recovery_attempted' | 'attempted_light' | 'attempted_provider_failed' | 'skipped_cost_guard' | 'skipped_micro_wallet' | 'none'
    targetTokens: Array<{ contract: string; symbol: string; chain: string; estimatedUsd: number }>
    reason: string
    estimatedExtraPages: number
  }
  walletReconstructionRecovery?: {
    highActivityPoorReconstruction: boolean
    highActivityReason: 'wallet_side_activity' | 'swap_candidates' | 'evidence_context_only' | null
    reason: 'high_activity_trade_reconstruction_incomplete' | null
    evidenceEvents: number
    walletSideEvents: number
    walletSideTransactions: number
    swapCandidateEvents: number
    rawMatchedClosedLots: number
    excludedClosedLots: number
    publicPerformanceClosedLots: number
    topFailureReason: string | null
    summary: string | null
    recoveryAttempted: boolean
    recoveryCapped: boolean
    budget: {
      extraPagesAllowed: number
      extraPagesUsed: number
      extraPriceAttemptsAllowed: number
      extraPriceAttemptsUsed: number
      creditsUsed: number
      capHitReason: string | null
    }
  }
  walletTradeReconstructionFunnel?: {
    walletSideTransactions: number
    swapCandidateEvents: number
    candidateSwapTransactions: number
    parsedSwapTransactions: number
    candidateBuyLegs: number
    candidateSellLegs: number
    matchedBuySellPairs: number
    rawClosedLots: number
    publicGradeClosedLots: number
    excludedClosedLots: number
    exclusionBreakdown: {
      estimateOnly: number
      syntheticCostBasis: number
      flatPrice: number
      missingCost: number
      missingSellPrice: number
      missingBuyPrice: number
      weakIndependence: number
      dust: number
      unsupportedRouter: number
      noQuoteLeg: number
      noPriorBuy: number
      budgetCapped: number
    }
    topFailureReasons: string[]
  }
  walletActivitySummary?: {
    walletSideEvents: number
    walletSideTransactions: number
    walletInitiatedTransactions: number
    receivedCount: number
    sentCount: number
    swapLikeWalletTransactions: number
    transferOnlyWalletTransactions: number
    claimOrAirdropLikeWalletTransactions: number
    trueActivityWindowDays: number | null
    firstWalletSideActivityAt: string | null
    lastWalletSideActivityAt: string | null
  }
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
    totalEvidenceEvents?: number
    walletSideEvents?: number
    reconstructionContextEvents?: number
    unknownContextEvents?: number
    totalRawLogs?: number
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
    realClosedLots?: number
    syntheticClosedLots?: number
    unknownCostSellLots?: number
    closedLotsForStats?: number
    syntheticLotsExcludedFromStats?: number
    unknownCostSellValueUsd?: number
    pnlUnavailableReason?: string | null
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
    confidenceLabel?: 'open_check' | 'break_even_only' | 'very_small_sample' | 'small_sample' | 'early_confidence' | 'developing' | 'high'
    sampleWarning?: string | null
    meaningfulClosedLots: number
    dustClosedLots: number
    meaningfulCostBasisUsd: number
    avgCostBasisPerClosedLot: number | null
    economicSignificance: 'meaningful' | 'micro_sample' | 'open_check'
    economicSignificanceReason: string
    missing: string[]
    closedLotsForStats?: number
    publicClosedLots?: number
    performanceClosedLots?: number
    publicPnlStatus?: 'ok' | 'limited_verified_sample' | 'open_check' | 'near_flat_verified_sample' | 'flat_estimate_only' | 'partial_near_flat' | 'open_check_integrity_invalid'
    publicPnlDisplayLabel?: string
    publicPnlDisplayReason?: string
    publicPerformanceClosedLots?: number
    verifiedButExcludedClosedLots?: number
    excludedClosedLots?: number
    rawMatchedClosedLots?: number
    publicRealizedPnlUsd?: number | null
    publicPerformanceRealizedPnlUsd?: number | null
    publicWinRatePercent?: number | null
    winningPerformanceLots?: number
    losingPerformanceLots?: number
    breakEvenPerformanceLots?: number
    winRateStatus?: 'unlocked' | 'locked_small_sample' | 'locked_integrity_invalid'
    pnlUnavailableReason?: string | null
    verifiedClosedLots?: number
    rawClosedLots?: number
    estimateOnlyClosedLots?: number
    syntheticClosedLotsExcluded?: number
    pnlIntegrityStatus?: 'ok' | 'warning' | 'invalid' | null
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
    verificationStatus?: 'verifiable' | 'partial' | 'not_available' | 'synthetic_cost_basis_missing' | 'estimate_only_price_flat' | 'price_independence_missing'
    publicPnlStatus?: 'ok' | 'limited_verified_sample' | 'open_check' | 'near_flat_verified_sample' | 'flat_estimate_only' | 'partial_near_flat' | 'open_check_integrity_invalid'
    pnlUnavailableReason?: string | null
    pnlDecisive?: boolean
    includedInPublicStats?: boolean
    pnlLockedReason?: string | null
    rawRealizedPnlUsd?: number | null
    rawRealizedPnlPercent?: number | null
  }>
  walletPersonality?: {
    personality: string
    scores: { sniperScore: number; smartMoneyScore: number; rotatorScore: number; degenScore: number } | null
    summary: string
    basis?: 'behavior_only' | 'pnl_verified'
    pnlUsed?: boolean
    profitSkillStatus?: 'not_proven' | 'integrity_invalid_not_proven' | 'unlocked'
    signals?: string[]
    limitations?: string[]
  }
  walletPnlWindows?: {
    '3d': { realizedPnlUsd: number | null; closedLots: number; winRatePercent: number | null; winRateStatus?: 'unlocked' | 'locked_small_sample' | 'locked_integrity_invalid'; publicPnlStatus?: string; reason?: string } | { closedLots: 0; fallback: string }
    '7d': { realizedPnlUsd: number | null; closedLots: number; winRatePercent: number | null; winRateStatus?: 'unlocked' | 'locked_small_sample' | 'locked_integrity_invalid'; publicPnlStatus?: string; reason?: string } | { closedLots: 0; fallback: string }
    '30d': { realizedPnlUsd: number | null; closedLots: number; winRatePercent: number | null; winRateStatus?: 'unlocked' | 'locked_small_sample' | 'locked_integrity_invalid'; publicPnlStatus?: string; reason?: string } | { closedLots: 0; fallback: string }
  }
  walletBotScore?: {
    score: number | null
    classification: 'Human-like' | 'Assisted / semi-automated' | 'Likely bot' | 'High-frequency bot' | 'Not enough behavior data'
    reason: string
    basis?: 'behavior_only' | 'behavior_with_public_performance'
    profitSkillStatus?: 'not_proven' | 'unlocked'
    pnlUsed?: false
    signals?: string[]
  }
  walletScanCostMode?: 'basic' | 'basic_cached' | 'deep_cached' | 'deep_live' | 'historical_cached' | 'historical_live' | 'blocked_by_cooldown' | 'blocked_by_cost_guard'
  walletScanCacheNote?: string
  pnlCacheQuality?: 'complete' | 'partial_needs_historical' | 'stale_low_coverage' | 'partial_public_performance' | 'partial_invalid_integrity' | 'limited_verified_sample'
  walletPnlRecoveryCta?: string
  walletHistoricalRecoveryStatus?: 'needed' | 'attempted' | 'attempted_light' | 'attempted_capped' | 'attempted_recovered' | 'attempted_no_recovery' | 'not_attempted' | 'blocked' | 'timed_out'
  walletHistoricalRecoveryReason?: string | null
  walletScanBudget?: {
    scanMode: string
    requestedHistoricalScan: boolean
    walletValueTier: 'micro' | 'small' | 'standard' | 'high_value' | 'whale'
    totalCreditTarget: number
    totalCreditHardCap: number
    creditsUsed: number
    creditsRemaining: number
    budgetCapHit: boolean
    budgetCapReason: string | null
    totalBudgetCapHit?: boolean
    historicalPhaseCapHit?: boolean
    historicalBudgetCapReason?: string | null
    estimatedCreditsUsed?: number
    actualCreditsUsed?: number
    skippedAfterBudgetCap: number
    estimatedCreditsSavedByCache: number
  }
  walletHistoricalCoverage?: {
    checked: boolean
    olderEntriesRecovered: number
    cappedForCostSafety: boolean
    highValueWalletPrioritised: boolean
    coverageLevel: 'none' | 'light' | 'medium' | 'deep'
    reason: string | null
    cacheHit?: boolean
  }
  walletDeepScanTiming?: {
    portfolioMs: number
    activityMs: number
    swapDetectionMs: number
    pricingMs: number
    fifoMs: number
    tradeStatsMs: number
    historicalMs: number
    totalMs: number
    cacheReadMs: number
    cacheWriteMs: number
  }
  walletModuleCoverage?: {
    portfolio:     { status: 'ok' | 'partial' | 'open_check'; evidence: string[]; reason: string }
    activity:      { status: 'ok' | 'partial' | 'open_check'; evidence: string[]; eventCount: number; reason: string }
    swapDetection: { status: 'ok' | 'partial' | 'open_check'; evidence: string[]; candidateCount: number; reason: string }
    priceEvidence: { status: 'ok' | 'partial' | 'open_check'; pricedEvents: number; reason: string }
    fifoPnL:       { status: 'ok' | 'partial' | 'open_check'; closedLots: number; reason: string }
    tradeStats:    { status: 'ok' | 'partial' | 'open_check'; closedLots: number; rawClosedLots?: number; excludedLots?: number; estimateOnlyClosedLots?: number; syntheticClosedLotsExcluded?: number; openedLots: number; readyForWinRate: boolean; reason: string }
    behavior:      { status: 'ok' | 'partial' | 'open_check'; reason: string }
    walletOpenPositionSummary?: {
      status: 'partial' | 'open_check'
      openLots: number
      uniqueTokens: number
      totalOpenCostBasisUsd: number | null
      tokens: Array<{ contract: string; symbol: string; chain: string; openLots: number; totalAmount: number; avgEntryPriceUsd: number | null; totalCostBasisUsd: number; firstOpenedAt: string; latestOpenedAt: string }>
      missing: string[]
      reason: string
    } | null
    openPositionPerformanceSummary?: OpenPositionPerformanceSummary
  openPositionPnlStatus?: 'estimate_only' | 'public_grade' | 'unavailable' | string
  }
  walletOpenPositionSummary?: {
    status: 'partial' | 'open_check'
    openLots: number
    uniqueTokens: number
    totalOpenCostBasisUsd: number | null
    tokens: Array<{ contract: string; symbol: string; chain: string; openLots: number; totalAmount: number; avgEntryPriceUsd: number | null; totalCostBasisUsd: number; firstOpenedAt: string; latestOpenedAt: string }>
    missing: string[]
    reason: string
  } | null
  openPositionPerformanceSummary?: OpenPositionPerformanceSummary
  openPositionPnlStatus?: 'estimate_only' | 'public_grade' | 'unavailable' | string
  walletProfile?: {
    score: number | null
    grade: string | null
    profileColor: 'emerald' | 'green' | 'teal' | 'yellow' | 'orange' | 'red' | null
    confidence: 'low' | 'medium' | 'high'
    walletCategory: string | null
    portfolioBehavior: string | null
    tradingBehavior: string | null
    portfolioConfidence: 'low' | 'medium' | 'high'
    tradingConfidence: 'low' | 'medium' | 'high'
    profileSummary: string | null
    signals: string[]
    reasons: string[]
    strengths: string[]
    weaknesses: string[]
    followability: 'Low' | 'Moderate' | 'High'
    nextAction: string
    evidenceCoverage: number
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
  walletPnlOutlierNote?: string | null
  walletPricingCoverageNote?: string | null
  walletValueTier?: 'micro' | 'small' | 'standard' | 'high_value'
  walletHistoricalScanNote?: string | null
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


// WIN-RATE-TRUST-FIX-1: the "Official"/public win rate may only ever be shown as a number when
// the backend's own public-grade sample is unlocked. Raw/derived win rates (from rawMatchedClosedLots,
// closedLots, or winningClosedLots) must never be relabeled as official/public once that gate fails.

function publicPnlLocked(result: WalletResult, ts: WalletResult['walletTradeStatsSummary'] | undefined = result.walletTradeStatsSummary): boolean {
  const status = result.publicPnlStatus ?? ts?.publicPnlStatus ?? null
  return result.publicRealizedPnlUsd == null || result.publicWinRatePercent == null || ts?.publicRealizedPnlUsd == null || ts?.publicWinRatePercent == null || status !== 'ok' || ts?.pnlIntegrityStatus === 'invalid' || (ts?.publicPerformanceClosedLots ?? 0) === 0
}

function publicWinRateUnlocked(ts: WalletResult['walletTradeStatsSummary'] | undefined): boolean {
  if (!ts) return false
  const publicPerfLots = ts.publicPerformanceClosedLots ?? 0
  return Boolean(
    Number.isFinite(ts.publicWinRatePercent) &&
    publicPerfLots >= 10 &&
    ts.winRateStatus !== 'locked_small_sample' &&
    ts.winRateStatus !== 'locked_integrity_invalid' &&
    ts.pnlIntegrityStatus !== 'invalid' &&
    ts.publicPnlStatus !== 'open_check_integrity_invalid' &&
    (ts.scoreUnlocked === true || ts.readyForWalletScore === true)
  )
}

// WIRE-WALLET-ACTIONS-1: client-side, public-safe export. Reuses the same backend signals the
// page already renders — never derives win rate from raw lots, and only treats the public
// realized PnL as "final" when it is the same number the public PnL pipeline produced.
function buildWalletReport(result: WalletResult) {
  const ts = result.walletTradeStatsSummary
  const publicLots = result.publicPerformanceClosedLots ?? ts?.publicPerformanceClosedLots ?? 0
  const rawLots = result.rawMatchedClosedLots ?? ts?.rawMatchedClosedLots ?? ts?.rawClosedLots ?? ts?.closedLots ?? 0
  const excludedLots = result.excludedClosedLots ?? ts?.excludedClosedLots ?? Math.max(0, rawLots - publicLots)
  const integrityInvalid = (result.publicPnlStatus ?? ts?.publicPnlStatus) === 'open_check_integrity_invalid' || ts?.pnlIntegrityStatus === 'invalid' || result.pnlIntegrityCheck?.status === 'invalid'
  const publicSamplePnlUsd = (integrityInvalid || publicPnlLocked(result, ts)) ? null : (result.publicPerformanceRealizedPnlUsd ?? ts?.publicRealizedPnlUsd ?? null)
  const winRateUnlocked = publicWinRateUnlocked(ts)
  const profitSkillProven = publicLots >= 10 && !integrityInvalid

  const topHoldings = (result.walletFacts?.summary?.topHoldings ?? [...result.holdings].sort((a, b) => b.value - a.value).slice(0, 5).map(h => ({ symbol: h.symbol, chain: h.chain ?? 'unknown', valueUsd: h.value, percent: null })))

  const activeChains = result.walletFacts?.summary?.chainExposure?.map(c => c.chain)
    ?? Array.from(new Set([...(result.holdings.map(h => h.chain).filter(Boolean) as string[])]))

  const limitations = [
    ...(result.tradeIntelligence?.limitations ?? []),
    ...(!winRateUnlocked ? ['Win rate locked — needs 10+ public-grade closed trades.'] : []),
    ...(!profitSkillProven ? ['Profit skill not proven — public-grade closed-lot sample below 10.'] : []),
    excludedLots > 0 ? `${excludedLots} excluded lot(s) are not counted as realized performance.` : null,
  ].filter((x): x is string => Boolean(x))

  const nextActions = [
    result.walletProfile?.nextAction,
    'Review Top Holdings',
    'Inspect Realized Trades',
  ].filter((x): x is string => Boolean(x))

  return {
    walletAddress: result.address,
    scanTimestamp: new Date().toISOString(),
    portfolioValueUsd: Number.isFinite(result.totalValue) ? result.totalValue : null,
    topHoldings,
    activeChains,
    activitySummary: result.walletBehavior?.recentActivitySummary ?? null,
    publicTradeEvidenceSummary: {
      pnlQuality: publicPnlLocked(result, ts) ? null : (result.pnlQuality ?? null),
      reason: publicPnlLocked(result, ts) ? 'Public PnL and win rate are locked; behavior-only reads may still be shown.' : (result.pnlQualityReason ?? null),
    },
    publicPnlStatus: {
      status: result.publicPnlStatus ?? ts?.publicPnlStatus ?? null,
      label: result.publicPnlDisplayLabel ?? ts?.publicPnlDisplayLabel ?? null,
      reason: result.publicPnlDisplayReason ?? ts?.publicPnlDisplayReason ?? null,
    },
    publicSamplePnl: Number.isFinite(publicSamplePnlUsd)
      ? { label: 'Public-sample PnL', valueUsd: publicSamplePnlUsd }
      : null,
    winRate: winRateUnlocked
      ? { label: 'Win Rate', valuePercent: ts!.publicWinRatePercent }
      : { label: 'Win Rate: Locked', valuePercent: null },
    profitSkillStatus: profitSkillProven ? 'Profit skill evidence-eligible' : 'Profit skill not proven',
    closedLotCounts: {
      publicGradeTrades: publicLots,
      rawMatchedLots: rawLots,
      excludedLots,
    },
    tradeIntelligenceSummary: result.tradeIntelligence
      ? { primaryStyle: result.tradeIntelligence.primaryStyle, summary: result.tradeIntelligence.tradeStyleSummary ?? result.tradeIntelligence.summary }
      : null,
    walletProfileSummary: result.walletProfile?.profileSummary ?? null,
    limitations,
    nextActions,
  }
}

function isTradeStatsGradeable(ts: WalletResult['walletTradeStatsSummary'] | undefined): boolean {
  const decisiveClosedLots = (ts?.winningClosedLots ?? 0) + (ts?.losingClosedLots ?? 0)
  return Boolean(
    ts &&
    ts.closedLots >= 10 &&
    decisiveClosedLots >= 1 &&
    ts.isBreakEvenOnly !== true &&
    ts.economicSignificance === 'meaningful' &&
    ts.confidence !== 'low' &&
    ts.confidence !== 'open_check' &&
    ts.pnlIntegrityStatus !== 'invalid' &&
    ts.readyForWalletScore
  )
}

function hasNoDecisiveClosedLots(ts: WalletResult['walletTradeStatsSummary'] | undefined): boolean {
  return Boolean(
    ts &&
    ts.closedLots > 0 &&
    ((ts.winningClosedLots ?? 0) + (ts.losingClosedLots ?? 0)) === 0
  )
}

type DataModeRead = {
  dataMode: 'strict' | 'minimal' | 'fallback' | 'insufficient'
  dataConfidence: 'verified' | 'high' | 'medium' | 'low' | 'estimated' | 'minimal' | 'insufficient'
  dataConfidenceReasons: string[]
  rawClosedLots: number
  rawRealizedPnlUsd: number | null
  rawWinningLots: number
  rawLosingLots: number
  rawBreakEvenLots: number
  rawWinRatePercent: number | null
  rawSampleLabel: 'single trade' | 'very small sample' | 'early sample' | 'break-even only' | null
}

function deriveDataModeAndConfidence(data: WalletResult): DataModeRead {
  const ts = data.walletTradeStatsSummary
  const openPos = data.walletModuleCoverage?.walletOpenPositionSummary ?? data.walletOpenPositionSummary ?? null
  const closedLots = ts?.closedLots ?? 0
  const winningLots = ts?.winningClosedLots ?? 0
  const losingLots = ts?.losingClosedLots ?? 0
  const breakEvenLots = ts?.breakEvenClosedLots ?? Math.max(0, closedLots - winningLots - losingLots)
  const decisiveClosedLots = winningLots + losingLots
  const breakEvenOnly = hasNoDecisiveClosedLots(ts)
  const reasons: string[] = []

  let dataMode: DataModeRead['dataMode']
  if (ts?.scoreUnlocked === true || (ts?.readyForWalletScore === true && closedLots >= 10)) {
    dataMode = 'strict'
    reasons.push(`${closedLots} verified closed lots support a full official read`)
  } else if (closedLots >= 1 || !!openPos) {
    dataMode = 'minimal'
    if (closedLots >= 1) reasons.push(`${closedLots} reconstructed closed lot${closedLots !== 1 ? 's' : ''} found — below the 10-lot threshold for an official read`)
    if (openPos) reasons.push('open-position evidence found from indexed buy-side activity')
    if (breakEvenOnly) reasons.push('all matched closed lots are break-even — no decisive win or loss yet')
  } else if ((data.walletModuleCoverage?.activity?.eventCount ?? 0) > 0) {
    dataMode = 'fallback'
    reasons.push('activity indexed, but no closed lots or open-position evidence could be reconstructed')
  } else {
    dataMode = 'insufficient'
    reasons.push('no usable trading or open-position evidence indexed for this wallet')
  }

  let dataConfidence: DataModeRead['dataConfidence']
  if (dataMode === 'strict') dataConfidence = ts?.confidence === 'high' ? 'verified' : 'high'
  else if (dataMode === 'minimal') dataConfidence = breakEvenOnly ? 'minimal' : decisiveClosedLots > 0 ? 'low' : 'estimated'
  else if (dataMode === 'fallback') dataConfidence = 'estimated'
  else dataConfidence = 'insufficient'

  let rawSampleLabel: DataModeRead['rawSampleLabel'] = null
  if (breakEvenOnly && closedLots > 0) rawSampleLabel = 'break-even only'
  else if (decisiveClosedLots === 1) rawSampleLabel = 'single trade'
  else if (decisiveClosedLots > 1 && decisiveClosedLots < 5) rawSampleLabel = 'very small sample'
  else if (decisiveClosedLots >= 5 && decisiveClosedLots < 10) rawSampleLabel = 'early sample'

  return {
    dataMode,
    dataConfidence,
    dataConfidenceReasons: reasons,
    rawClosedLots: closedLots,
    rawRealizedPnlUsd: ts?.realizedPnlUsd ?? null,
    rawWinningLots: winningLots,
    rawLosingLots: losingLots,
    rawBreakEvenLots: breakEvenLots,
    rawWinRatePercent: decisiveClosedLots >= 1 ? (ts?.winRatePercent ?? (winningLots / decisiveClosedLots) * 100) : null,
    rawSampleLabel,
  }
}

function isMicroSampleLocked(ts: WalletResult['walletTradeStatsSummary'] | undefined): boolean {
  return Boolean(
    ts &&
    ts.closedLots >= 10 &&
    !hasNoDecisiveClosedLots(ts) &&
    (ts.economicSignificance === 'micro_sample' || ts.confidence === 'low' || !ts.readyForWalletScore)
  )
}

function officialWinRateLockCopy(ts: WalletResult['walletTradeStatsSummary'] | undefined): string {
  if (!ts || ts.closedLots === 0) return 'Requires closed-lot evidence.'
  if (hasNoDecisiveClosedLots(ts)) return 'Break-even only — official win rate needs at least one decisive winning or losing closed lot.'
  if (ts.closedLots < 10) return `Raw rate from ${ts.closedLots} closed lot${ts.closedLots !== 1 ? 's' : ''} — official rate unlocks at 10+.`
  if (isMicroSampleLocked(ts)) return 'Matched sample is too small financially to grade.'
  return 'Requires gradeable matched closed-lot evidence.'
}

function walletScoreLockCopy(ts: WalletResult['walletTradeStatsSummary'] | undefined): string {
  if (!ts || ts.closedLots === 0) return 'Needs closed lot evidence to score.'
  if (hasNoDecisiveClosedLots(ts)) return 'Score locked: break-even-only samples need at least one decisive winning or losing closed lot.'
  if (ts.closedLots < 10) return 'Score not calculated until 10+ verified closed lots.'
  if (isMicroSampleLocked(ts)) return 'Matched sample is too small financially to grade.'
  return 'Score not calculated until 10+ gradeable closed lots include a decisive win or loss.'
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

// Local (client-safe) mirror of the server's trade-style label map — never outputs "sniper".
function readableTradeStyleLabel(style: string | null | undefined): string | null {
  if (!style || style === 'not_enough_data') return null
  const map: Record<string, string> = {
    high_speed_rotator: 'High-speed rotator',
    swing_rotator: 'Swing rotator',
    conviction_accumulator: 'Conviction accumulator',
    stablecoin_router: 'Stablecoin router',
    airdrop_farmer: 'Airdrop farmer',
    low_activity_holder: 'Low-activity holder',
    mixed_behavior: 'Mixed behavior',
    portfolio_rebalancer: 'Portfolio rebalancer',
    stable_quote_rotator: 'Stablecoin router',
    accumulator: 'Conviction accumulator',
    distributor: 'Distributor',
    mixed_rotator: 'Mixed behavior',
  }
  if (map[style]) return map[style]
  if (/sniper/i.test(style)) return 'Mixed behavior'
  return style.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
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
      : ts && hasNoDecisiveClosedLots(ts)
        ? `${closedTrades} lots reconstructed, but all are break-even — score needs at least one decisive win or loss.`
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
  // PNL-SAFETY-FIX-1: every closed lot behind this wallet's stats is a synthetic FIFO safety
  // placeholder (no real buy/cost basis recovered) — don't present its $0 break-even as a real
  // verified result. closedLots above stays the raw FIFO count on purpose; this flag is additive.
  const costBasisMissing = ts?.pnlUnavailableReason === 'missing_cost_basis' || ts?.publicPnlStatus === 'open_check'
  const coreReady = pnlEvidenceReady && !noLotsNullPnl && !costBasisMissing
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
  const costBasisMissing = ts?.pnlUnavailableReason === 'missing_cost_basis' || ts?.publicPnlStatus === 'open_check'
  if (costBasisMissing) {
    checks.push('PnL open check')
    checks.push(`${closedLots} sell${closedLots !== 1 ? 's' : ''} found, cost basis missing`)
    checks.push('Original buys were not recovered, so profit/loss cannot be verified.')
    checks.push(`Real closed trades: ${ts?.closedLotsForStats ?? 0}`)
    return Array.from(new Set([...(data.walletIntelligence?.openChecks ?? []), ...checks])).slice(0, 5)
  }
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
    if (hasNoDecisiveClosedLots(ts)) {
      sentences.push(`Matched closed-lot sample shows ${ts.closedLots} reconstructed lots, all break-even. Win rate and wallet score stay locked until at least one decisive winning or losing closed lot appears.`)
    } else {
      const _beNote = ts.breakEvenClosedLots > 0 ? `, ${ts.breakEvenClosedLots} break-even` : ''
      sentences.push(`Matched closed-lot sample shows ${ts.winningClosedLots} positive lot${ts.winningClosedLots !== 1 ? 's' : ''}${_beNote} and ${ts.losingClosedLots} losing lots across ${ts.closedLots} reconstructed lots. Win rate is not calculated — the matched sample did not meet economic quality gates.`)
    }
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


function walletCategoryFromValue(value: number): string {
  if (value >= 1_000_000) return 'Whale'
  if (value >= 100_000) return 'Large Portfolio'
  if (value >= 10_000) return 'Mid Portfolio'
  return 'Small Portfolio'
}

function pctOf(total: number, value: number): number {
  return total > 0 ? (value / total) * 100 : 0
}

function derivePortfolioBehaviorFromHoldings(pi: ReturnType<typeof derivePortfolioIntelligence>): string {
  if (pi.chains.length >= 2) return 'Multi-Chain Portfolio Manager'
  if (pi.stablePercent >= 45) return 'Treasury Style Portfolio'
  if ((pi.topShare ?? 0) >= 55) return 'Conviction Holder'
  if (pi.holdingsCount >= 8) return 'Diversified Holder'
  return 'Meme Speculator'
}

function deriveTradingBehaviorFromEvidence(data: WalletResult): string {
  const ts = data.walletTradeStatsSummary
  if (!ts || ts.closedLots < 10 || !isTradeStatsGradeable(ts)) return 'Insufficient Evidence'
  const avgHoldDays = (ts.avgHoldingTimeSeconds ?? 0) / 86400
  if (ts.closedLots >= 60 && avgHoldDays < 1) return 'Day Trader'
  if (ts.closedLots >= 25 && avgHoldDays <= 14) return 'Active Trader'
  if (avgHoldDays >= 3 && avgHoldDays <= 45) return 'Swing Trader'
  if ((ts.openedLots ?? 0) > ts.closedLots) return 'Position Rotator'
  if ((ts.winRatePercent ?? 0) >= 65 && (ts.realizedPnlUsd ?? 0) > 0) return 'Smart Money Candidate'
  return 'Active Trader'
}

function deriveRiskLabel(topShare: number | null, top3Share: number | null, stablePercent: number): 'Low' | 'Moderate' | 'High' {
  if ((topShare ?? 0) >= 55 || (top3Share ?? 0) >= 82 || stablePercent < 5) return 'High'
  if ((topShare ?? 0) >= 25 || (top3Share ?? 0) >= 55) return 'Moderate'
  return 'Low'
}

function riskDots(level: number): string {
  return '●'.repeat(level) + '○'.repeat(Math.max(0, 5 - level))
}

function fmtRelativeTime(iso: string | null | undefined): string {
  if (!iso) return 'Open Check'
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return 'Open Check'
  const diff = Date.now() - ts
  const mins = Math.max(0, Math.floor(diff / 60000))
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function scoreGradeFromProfile(data: WalletResult, walletIntel: WalletIntelligence): { score: number | null; grade: string | null } {
  const score = data.walletProfile?.score ?? walletIntel.walletScore
  const grade = data.walletProfile?.grade ?? (score == null ? null : score >= 95 ? 'A+' : score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F')
  return { score, grade }
}

function allocationRows(data: WalletResult, max = 4): Array<{ label: string; percent: number }> {
  const pi = derivePortfolioIntelligence(data)
  const sorted = [...data.holdings].filter(h => h.value > 0).sort((a, b) => b.value - a.value)
  const rows = sorted.slice(0, max - 1).map(h => ({ label: h.symbol || h.name, percent: pctOf(pi.totalValue, h.value) }))
  const used = rows.reduce((s, r) => s + r.percent, 0)
  if (sorted.length >= max && used < 100) rows.push({ label: 'Other', percent: Math.max(0, 100 - used) })
  return rows
}

function institutionalSummary(data: WalletResult, pi: ReturnType<typeof derivePortfolioIntelligence>, tradingBehavior: string): string {
  const fragments = [derivePortfolioBehaviorFromHoldings(pi)]
  if ((data.walletTradeStatsSummary?.realizedPnlUsd ?? 0) > 0) fragments.push('Consistent realized gains')
  if (deriveRiskLabel(pi.topShare, pi.top3Share, pi.stablePercent) === 'Moderate') fragments.push('Moderate concentration')
  else fragments.push(`${deriveRiskLabel(pi.topShare, pi.top3Share, pi.stablePercent)} risk concentration`)
  if (tradingBehavior !== 'Insufficient Evidence') fragments.push(tradingBehavior)
  return fragments.slice(0, 3).join(' · ')
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

function WalletScanProgress({ hasPreviousResult, deepScan }: { hasPreviousResult: boolean; deepScan: boolean }) {
  const modules = [
    { label: 'Portfolio loading', detail: 'Reading visible holdings and value first.' },
    { label: 'Activity indexing', detail: 'Indexing wallet-side transfer history.' },
    { label: 'Swap pairs', detail: 'Grouping token legs into CORTEX candidates.' },
    { label: 'Pricing evidence', detail: 'Resolving cost-basis evidence without synthetic numbers.' },
    { label: 'FIFO matching', detail: 'Matching buys and sells with existing safety rules.' },
    { label: 'Trade stats', detail: 'Unlocking stats only after verified closed lots.' },
  ]
  return (
    <div style={{ maxWidth: '760px', marginTop: hasPreviousResult ? '0' : '24px' }}>
      <div style={{
        background: 'rgba(8,12,20,0.86)', border: '1px solid rgba(45,212,191,0.14)', borderRadius: '16px', padding: '16px 18px',
        boxShadow: '0 0 36px rgba(45,212,191,0.04)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
          <ClarkDots />
          <div>
            <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.16em', color: '#7dd3fc', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
              {hasPreviousResult ? 'Deep Scan running — refreshing CORTEX read…' : deepScan ? 'Deep Scan running' : 'CORTEX scan in progress'}
            </div>
            <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.42)', marginTop: '3px', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
              {hasPreviousResult
                ? 'Keeping the previous verified read visible while slower trade stats finish.'
                : deepScan
                  ? 'Portfolio, activity, swap candidates, pricing evidence, and trade stats resolve in order without blocking the whole page.'
                  : 'Modules appear as soon as verified evidence is returned or served from cache.'}
            </div>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '8px' }}>
          {modules.map((m, i) => (
            <div key={m.label} style={{ border: '1px solid rgba(255,255,255,0.07)', borderRadius: '10px', padding: '10px 11px', background: 'rgba(255,255,255,0.018)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: i < 2 ? '#7dd3fc' : 'rgba(255,255,255,0.48)', fontSize: '10px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                <span style={{ width: '6px', height: '6px', borderRadius: '999px', background: i < 2 ? '#7dd3fc' : 'rgba(125,211,252,0.28)', boxShadow: i < 2 ? '0 0 10px rgba(125,211,252,0.35)' : 'none' }} />
                {m.label}
              </div>
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.32)', marginTop: '5px', lineHeight: 1.45, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                {m.detail}
              </div>
            </div>
          ))}
        </div>
      </div>
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
  const [freshScanBypass, setFreshScanBypass] = useState(false)
  const [noCacheWrite, setNoCacheWrite] = useState(false)
  const [addressCopied, setAddressCopied] = useState(false)
  const [watchlistStatus, setWatchlistStatus] = useState<'idle' | 'saving' | 'success' | 'exists' | 'error'>('idle')
  const [watchlistMessage, setWatchlistMessage] = useState<string | null>(null)
  const [watchlistWallets, setWatchlistWallets] = useState<WatchlistWallet[]>([])
  const [watchlistLoading, setWatchlistLoading] = useState(false)
  const [watchlistDeleting, setWatchlistDeleting] = useState<string | null>(null)
  const clarkLoading = loading
  const showDebugCacheControls = deepActivity && (plan === 'pro' || plan === 'elite' || betaEliteActive || process.env.NODE_ENV !== 'production')

  async function loadWalletWatchlist() {
    setWatchlistLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) {
        setWatchlistWallets([])
        return
      }
      const res = await fetch('/api/watchlist/wallets', { headers: { Authorization: `Bearer ${token}` } })
      const json = await res.json().catch(() => null)
      if (res.ok) setWatchlistWallets(Array.isArray(json?.wallets) ? json.wallets : [])
    } finally {
      setWatchlistLoading(false)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadWalletWatchlist()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  function copyAddress(address: string) {
    navigator.clipboard?.writeText(address).then(() => {
      setAddressCopied(true)
      setTimeout(() => setAddressCopied(false), 1500)
    }).catch(() => {})
  }

  async function handleAddWalletToWatchlist() {
    if (!result?.address || watchlistStatus === 'saving') return
    setWatchlistStatus('saving')
    setWatchlistMessage(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) {
        setWatchlistStatus('error')
        setWatchlistMessage('Sign in to add wallets to your watchlist.')
        return
      }
      const res = await fetch('/api/watchlist/wallets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          address: result.address,
          label: result.walletProfile?.walletCategory ?? null,
          portfolioValue: Number.isFinite(result.totalValue) ? result.totalValue : null,
          chainMode: result.behaviorChain ?? 'base',
          source: 'wallet-scanner',
        }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        setWatchlistStatus('error')
        setWatchlistMessage(json?.error ?? 'Could not add wallet to watchlist.')
        return
      }
      if (json?.alreadyExists) {
        setWatchlistStatus('exists')
        setWatchlistMessage('Already in watchlist')
      } else {
        setWatchlistStatus('success')
        setWatchlistMessage('Added to watchlist')
      }
      await loadWalletWatchlist()
    } catch {
      setWatchlistStatus('error')
      setWatchlistMessage('Could not add wallet to watchlist.')
    }
  }

  async function handleRemoveWalletFromWatchlist(address: string) {
    if (!address || watchlistDeleting) return
    setWatchlistDeleting(address)
    setWatchlistMessage(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) {
        setWatchlistStatus('error')
        setWatchlistMessage('Sign in to manage your watchlist.')
        return
      }
      const res = await fetch(`/api/watchlist/wallets?address=${encodeURIComponent(address)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        setWatchlistStatus('error')
        setWatchlistMessage(json?.error ?? 'Could not remove wallet.')
        return
      }
      setWatchlistWallets((wallets) => wallets.filter((wallet) => wallet.address.toLowerCase() !== address.toLowerCase()))
      setWatchlistStatus('idle')
      setWatchlistMessage('Removed from watchlist')
    } catch {
      setWatchlistStatus('error')
      setWatchlistMessage('Could not remove wallet.')
    } finally {
      setWatchlistDeleting(null)
    }
  }

  function handleExportWalletReport() {
    if (!result?.address) return
    const report = buildWalletReport(result)
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const shortAddress = `${result.address.slice(0, 6)}${result.address.slice(-4)}`
    const dateStr = new Date().toISOString().slice(0, 10)
    const a = document.createElement('a')
    a.href = url
    a.download = `chainlens-wallet-report-${shortAddress}-${dateStr}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  async function handleScan(forceDeep = false) {
    const q = input.trim()
    if (!q) return
    // forceDeep lets the "Run deep recovery scan" CTA opt into deep activity on the immediate rescan
    // without waiting for the deepActivity state update to flush through this closure.
    const useDeep = deepActivity || forceDeep
    setLoading(true)
    setError(null)
    setShowAllHoldings(false)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const canDebug = useDeep && (plan === 'pro' || plan === 'elite' || betaEliteActive || process.env.NODE_ENV !== 'production')
      const cacheBust = freshScanBypass ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` : undefined
      const res  = await fetch(canDebug ? '/api/wallet?debug=true' : '/api/wallet', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ address: q, ...(useDeep ? { deepActivity: true } : {}), ...(canDebug && freshScanBypass ? { debugFresh: true, bypassCache: true, cacheBust, ...(noCacheWrite ? { noCacheWrite: true } : {}) } : {}) }),
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
        .wallet-profile-v3 { background: #0B0D10; color: #F2F4F7; font-family: var(--font-inter, Inter, sans-serif); }
        .wpv3-card { background: #111418; border: 1px solid #222832; border-radius: 12px; padding: 20px; transition: background 0.16s, border-color 0.16s; }
        .wpv3-card:hover { background: #141820; border-color: #2c3440; }
        .wpv3-title { font-size: 14px; font-weight: 600; color: #F2F4F7; margin: 0 0 18px; letter-spacing: 0.01em; }
        .wpv3-label { font-size: 13px; color: #A8B0BD; }
        .wpv3-value { font-size: 24px; font-weight: 600; color: #F2F4F7; line-height: 1.1; }
        .wpv3-support { font-size: 12px; color: #6F7885; line-height: 1.5; }
        .wpv3-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
        .wpv3-metric-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid rgba(34,40,50,0.72); }
        .wpv3-metric-row:last-child { border-bottom: 0; }
        .wpv3-pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 5px 10px; font-size: 12px; font-weight: 700; border: 1px solid #222832; background: rgba(255,255,255,0.02); }
        .wpv3-button { border: 1px solid #2f3743; background: #141820; color: #F2F4F7; border-radius: 10px; padding: 10px 14px; font-size: 12px; font-weight: 700; cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease; }
        .wpv3-button:hover:not(:disabled) { background: #1b212c; border-color: #3f4b5c; }
        .wpv3-button:disabled { cursor: not-allowed; opacity: 0.55; }
        .wpv3-button-primary { background: #F2F4F7; color: #0B0D10; border-color: #F2F4F7; }
        .wpv3-button-primary:hover:not(:disabled) { background: #d8dce1; }
        @media (max-width: 900px) { .wpv3-grid { grid-template-columns: 1fr !important; } }

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
              onClick={() => handleScan()}
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
              {loading ? (deepActivity ? 'Deep Scan running…' : 'Scanning…') : (
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

            {showDebugCacheControls && (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '7px 10px', borderRadius: '10px', border: '1px solid rgba(251,191,36,0.24)', background: 'rgba(251,191,36,0.055)' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '10px', color: '#fbbf24', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                  <input type="checkbox" checked={freshScanBypass} disabled={loading} onChange={e => setFreshScanBypass(e.target.checked)} />
                  Fresh scan / bypass cache
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '10px', color: freshScanBypass ? '#fbbf24' : 'rgba(255,255,255,0.28)', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                  <input type="checkbox" checked={noCacheWrite} disabled={loading || !freshScanBypass} onChange={e => setNoCacheWrite(e.target.checked)} />
                  Do not write cache
                </label>
              </div>
            )}
          </div>

          {/* Progressive loading state */}
          {loading && !result && (
            <><WalletScanProgress hasPreviousResult={false} deepScan={deepActivity} /><div style={{ maxWidth: '700px', marginTop: '12px' }}>
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
            </div></>
          )}
          {loading && result && <WalletScanProgress hasPreviousResult deepScan={deepActivity} />}

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
          {result && (() => {
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
            const walletCategory = cleanWalletArchetype(result.walletProfile?.walletCategory)
            const portfolioBehavior = cleanWalletArchetype(result.walletProfile?.portfolioBehavior)
            const tradingBehavior = cleanWalletArchetype(result.walletProfile?.tradingBehavior)
            return (
            <div className="ws-result-fade" style={{ maxWidth: '100%', width: '100%', display: 'flex', flexDirection: 'column', gap: '20px', marginTop: '28px' }}>

              {loading && (
                <div style={{ fontSize: '11px', color: '#7dd3fc', background: 'rgba(56,189,248,0.05)', border: '1px solid rgba(56,189,248,0.14)', borderRadius: '10px', padding: '10px 14px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.6, display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <ClarkDots />
                  <span>Refreshing CORTEX read… previous verified modules remain visible until the new scan is ready.</span>
                </div>
              )}

              {/* Scan cost / cache note banner */}
              {result.walletScanCacheNote && (result.walletScanCostMode === 'blocked_by_cooldown' || result.walletScanCostMode === 'blocked_by_cost_guard' || result.walletScanCostMode === 'historical_cached' || result.walletScanCostMode === 'deep_cached') && (
                <div style={{ fontSize: '11px', color: '#7dd3fc', background: 'rgba(56,189,248,0.05)', border: '1px solid rgba(56,189,248,0.12)', borderRadius: '10px', padding: '10px 14px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.6, display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                  <span style={{ flexShrink: 0, marginTop: '1px' }}>ℹ</span>
                  {result.walletScanCacheNote}
                </div>
              )}

              {/* Wallet Profile Dashboard V3 */}
              {(() => {
                const pi = derivePortfolioIntelligence(result)
                const ts = result.walletTradeStatsSummary
                const activity = result.walletFacts?.activity
                const scoreGrade = scoreGradeFromProfile(result, walletIntel)
                const tone = gradeToneFor(scoreGrade.grade)
                const chains = pi.chains.length > 0 ? pi.chains.map(c => c.charAt(0).toUpperCase() + c.slice(1)) : ['Ethereum', 'Base']
                const category = walletCategory ?? walletCategoryFromValue(pi.totalValue)
                const portfolioClass = portfolioBehavior ?? derivePortfolioBehaviorFromHoldings(pi)
                const tradeClass = tradingBehavior ?? deriveTradingBehaviorFromEvidence(result)
                const risk = deriveRiskLabel(pi.topShare, pi.top3Share, pi.stablePercent)
                // PNL-SAFETY-FIX: must use the verified/real-backed closed-lot count, not the raw
                // closedLots count, which can still include synthetic FIFO-backfilled lots.
                const _verifiedClosedLots = ts?.verifiedClosedLots ?? ts?.closedLotsForStats ?? ts?.closedLots ?? 0
                const tradeEvidenceStrong = Boolean(ts && _verifiedClosedLots > 0 && ts.realizedPnlUsd !== null && ts.pnlUnavailableReason !== 'missing_cost_basis')
                const allocation = allocationRows(result)
                const missing = Array.from(new Set([
                  ...(result.walletEvidenceSummary?.missing ?? []),
                  ...(result.walletSwapSummary?.missing ?? []),
                  ...(result.walletPriceEvidenceSummary?.missing ?? []),
                  ...(result.walletLotSummary?.missing ?? []),
                ])).slice(0, 3)
                const coverage = result.walletProfile?.evidenceCoverage ?? (Math.round(((result.walletEvidenceSummary?.hashCoverage ?? 0) + (result.walletEvidenceSummary?.timestampCoverage ?? 0)) / 2) || (result.walletModuleCoverage ? 84 : 0))
                const confidence = result.walletProfile?.confidence ?? (coverage >= 80 ? 'high' : coverage >= 50 ? 'medium' : 'low')
                const summary = result.walletProfile?.profileSummary ?? institutionalSummary(result, pi, tradeClass)
                const strengths = result.walletProfile?.strengths ?? []
                const weaknesses = result.walletProfile?.weaknesses ?? []
                const profileSignals = result.walletProfile?.signals ?? []
                const profileReasons = result.walletProfile?.reasons ?? []
                const nextActions = [
                  result.walletProfile?.nextAction,
                  'Review Top Holdings',
                  'Inspect Realized Trades',
                  'Compare Wallet Peers',
                  'Monitor Exposure Changes',
                ].filter((action, index, actions): action is string => Boolean(action && actions.indexOf(action) === index)).slice(0, 4)
                const activeChains = new Set([...(pi.chains ?? []), ...(result.walletClosedTradeSamples ?? []).map(t => t.chain)]).size || pi.chains.length || 1
                const behaviorTags = [
                  ...(result.walletFacts?.flowRead.accumulationSignals?.length ? ['Accumulation'] : []),
                  ...(result.walletFacts?.flowRead.distributionSignals?.length ? ['Distribution'] : []),
                  ...(pi.holdingsCount >= 3 ? ['Rotation'] : []),
                  ...(pi.stablePercent >= 20 ? ['Stablecoin Rotation'] : []),
                  ...(pi.stablePercent < 10 ? ['Risk-On'] : ['Risk-Off']),
                ].slice(0, 3)
                return (
                  <section className="wallet-profile-v3" style={{ border: '1px solid #222832', borderRadius: '12px', padding: '20px', background: '#0B0D10' }}>
                    <div className="wpv3-card" style={{ marginBottom: '16px' }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
                        <div>
                          <p className="wpv3-title">Wallet Profile</p>
                          <div style={{ fontSize: '28px', fontWeight: 600, letterSpacing: '-0.03em', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{shortAddr(result.address)}</div>
                          <div className="wpv3-support" style={{ marginTop: '10px' }}>{chains.join(' · ')}</div>
                        </div>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <span className="wpv3-pill" style={{ color: tone.color, borderColor: tone.border }}>Score {scoreGrade.score ?? '—'}</span>
                          <span className="wpv3-pill" style={{ color: tone.color, borderColor: tone.border }}>{scoreGrade.grade ?? '—'}</span>
                        </div>
                      </div>
                      <div style={{ height: '1px', background: '#222832', margin: '18px 0 14px' }} />
                      <div className="wpv3-support" style={{ color: '#A8B0BD' }}>{summary}</div>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
                        {[category, portfolioClass, tradeClass].map(x => <span key={x} className="wpv3-pill" style={{ color: '#A8B0BD' }}>{x}</span>)}
                      </div>
                    </div>

                    <div className="wpv3-grid">
                      <div className="wpv3-card">
                        <p className="wpv3-title">Portfolio Overview</p>
                        {[
                          ['Total Value', pi.totalValue > 0 ? fmtUSD(pi.totalValue) : 'Open Check'],
                          ['24H Change', fmtPct(result.holdings.reduce((s,h)=>s+(h.change24h ?? 0),0) / Math.max(1,result.holdings.filter(h=>h.change24h!==null).length))],
                          ['Assets Held', String(pi.holdingsCount)],
                          ['Stablecoin Share', `${pi.stablePercent.toFixed(0)}%`],
                        ].map(([label,value]) => <div key={label} className="wpv3-metric-row"><span className="wpv3-label">{label}</span><span className="wpv3-value" style={{ fontSize: '20px' }}>{value}</span></div>)}
                        <div style={{ marginTop: '16px' }}><div className="wpv3-label" style={{ marginBottom: '8px' }}>Allocation</div>{allocation.map(row => <div key={row.label} style={{ display: 'grid', gridTemplateColumns: '56px 1fr 44px', gap: '10px', alignItems: 'center', marginBottom: '8px' }}><span className="wpv3-support">{row.label}</span><div style={{ height: '8px', background: '#222832', borderRadius: '999px', overflow: 'hidden' }}><div style={{ width: `${Math.min(100,row.percent)}%`, height: '100%', background: '#A8B0BD' }} /></div><span className="wpv3-support" style={{ textAlign: 'right' }}>{row.percent.toFixed(0)}%</span></div>)}</div>
                      </div>

                      <div className="wpv3-card">
                        <p className="wpv3-title">Risk & Concentration</p>
                        {[
                          ['Overall Risk', risk],
                          ['Top Asset Weight', pi.topShare == null ? 'Open Check' : `${pi.topShare.toFixed(0)}%`],
                          ['Top 3 Exposure', pi.top3Share == null ? 'Open Check' : `${pi.top3Share.toFixed(0)}%`],
                          ['Illiquid Exposure', `${Math.max(0, 100 - pi.stablePercent - pi.ethPercent).toFixed(0)}%`],
                        ].map(([label,value]) => <div key={label} className="wpv3-metric-row"><span className="wpv3-label">{label}</span><span className="wpv3-value" style={{ fontSize: '20px' }}>{value}</span></div>)}
                        <div style={{ marginTop: '16px' }}>{[
                          ['Concentration', riskDots(risk === 'High' ? 4 : risk === 'Moderate' ? 3 : 2)],
                          ['Volatility', riskDots(pi.ethPercent >= 50 ? 4 : 3)],
                          ['Liquidity Risk', riskDots(pi.stablePercent >= 30 ? 1 : 2)],
                          ['Counterparty Risk', riskDots(2)],
                        ].map(([label,value]) => <div key={label} className="wpv3-metric-row"><span className="wpv3-label">{label}</span><span style={{ color: '#E8C76D', letterSpacing: '0.16em' }}>{value}</span></div>)}</div>
                      </div>

                      {(() => {
                        // ACTIVITY-ATTRIBUTION-FIX: public Activity Summary shows WALLET-SIDE activity,
                        // not total evidence (which includes context-only reconstruction logs).
                        const act = result.walletActivitySummary
                        const evidenceTotal = result.walletEvidenceSummary?.totalEvidenceEvents ?? result.walletEvidenceSummary?.totalEvents ?? 0
                        const walletSide = act?.walletSideEvents ?? result.walletEvidenceSummary?.walletSideEvents ?? 0
                        const contextOnly = result.walletEvidenceSummary?.reconstructionContextEvents ?? Math.max(0, evidenceTotal - walletSide)
                        const walletSideTxns = act?.walletSideTransactions ?? null
                        const contextHeavy = evidenceTotal >= 100 && walletSide > 0 && walletSide < evidenceTotal * 0.4
                        return (
                          <div className="wpv3-card">
                            <p className="wpv3-title">Activity Summary</p>
                            {[
                              ['Last Active', fmtRelativeTime(act?.lastWalletSideActivityAt ?? activity?.lastSeenAt ?? result.walletBehavior?.recentActivitySummary)],
                              ['Wallet-side transfers', String(walletSide)],
                              ['Wallet-side transactions', walletSideTxns != null ? String(walletSideTxns) : String(activity?.groupedTxCount ?? result.walletBehavior?.txCount ?? 'Open Check')],
                              ['DEX Trades', String(result.walletSwapSummary?.highConfidenceCount ?? result.walletSwapSummary?.swapCandidateCount ?? 0)],
                              ['Active Chains', String(activeChains)],
                            ].map(([label,value]) => <div key={label} className="wpv3-metric-row"><span className="wpv3-label">{label}</span><span className="wpv3-value" style={{ fontSize: '20px' }}>{value}</span></div>)}
                            {contextOnly > 0 && (
                              <p className="wpv3-support" style={{ marginTop: '10px', color: '#9aa4b2' }}>
                                {evidenceTotal} evidence events indexed for reconstruction · {contextOnly} context-only log{contextOnly !== 1 ? 's' : ''} used for transaction reconstruction are not counted as wallet activity.
                              </p>
                            )}
                            {contextHeavy && (
                              <p className="wpv3-support" style={{ marginTop: '6px', color: '#fbbf24' }}>
                                High reconstruction context, limited direct wallet activity.
                              </p>
                            )}
                            <div className="wpv3-label" style={{ marginTop: '14px' }}>Behavior</div><div className="wpv3-support" style={{ marginTop: '6px', color: '#F2F4F7' }}>{behaviorTags.join(' · ')}</div>
                            <div className="wpv3-label" style={{ marginTop: '14px' }}>Recent Pattern</div><div className="wpv3-support" style={{ marginTop: '6px' }}>{result.walletFacts?.flowRead.accumulationSignals?.[0] ?? 'Increased exposure review requires more indexed activity.'}</div>
                          </div>
                        )
                      })()}

                      {result.walletReconstructionRecovery?.highActivityPoorReconstruction && (() => {
                        const rr = result.walletReconstructionRecovery!
                        const failureCopy: Record<string, string> = {
                          prior_buy_cost_basis_missing: 'Exit activity found, but the matching buy cost basis was not in the indexed window.',
                          quote_leg_or_price_missing: 'Swap candidates were found, but quote legs/prices were incomplete.',
                          synthetic_cost_basis_estimate_only: 'Matched lots relied on synthetic/estimated cost basis, not verifiable buys.',
                          flat_price_estimate_only: 'Matched lots priced from flat/estimate-only data, excluded from public performance.',
                          historical_depth_insufficient: 'Deeper transaction history is needed to complete trade reconstruction.',
                          budget_cap_reached: 'Scan budget cap was reached before reconstruction completed.',
                          trade_reconstruction_incomplete: 'Trade candidates could not be promoted to public-grade closed lots.',
                        }
                        const deepPathExists = typeof setDeepActivity === 'function'
                        return (
                          <div className="wpv3-card" style={{ border: '1px solid rgba(251,191,36,0.22)', background: 'rgba(251,191,36,0.03)' }}>
                            <p className="wpv3-title" style={{ color: '#fbbf24' }}>Trade reconstruction incomplete</p>
                            <p className="wpv3-support" style={{ marginBottom: '10px', color: '#cbd5e1' }}>
                              {rr.highActivityReason === 'swap_candidates'
                                ? 'ChainLens found many swap candidates, but could not build public-grade performance evidence from this scan.'
                                : 'ChainLens found genuine wallet-side activity, but could not build public-grade performance evidence from this scan.'}
                            </p>
                            {[
                              ['Evidence events indexed', String(rr.evidenceEvents)],
                              ['Wallet-side transfers', String(rr.walletSideEvents)],
                              ['Swap candidates', String(rr.swapCandidateEvents)],
                              ['Raw matched lots', String(rr.rawMatchedClosedLots)],
                              ['Excluded lots', String(rr.excludedClosedLots)],
                              ['Public-grade lots', String(rr.publicPerformanceClosedLots)],
                            ].map(([label, value]) => (
                              <div key={label} className="wpv3-metric-row"><span className="wpv3-label">{label}</span><span className="wpv3-value" style={{ fontSize: '20px' }}>{value}</span></div>
                            ))}
                            {rr.topFailureReason && (
                              <p className="wpv3-support" style={{ marginTop: '10px' }}>{failureCopy[rr.topFailureReason] ?? rr.summary}</p>
                            )}
                            <p className="wpv3-support" style={{ marginTop: '8px', color: '#9aa4b2' }}>
                              {rr.recoveryAttempted
                                ? (rr.recoveryCapped ? 'Targeted recovery was attempted but reached its safe budget cap.' : 'Targeted recovery was attempted this scan.')
                                : 'Targeted recovery has not been attempted yet for this wallet.'}
                            </p>
                            <p className="wpv3-support" style={{ marginTop: '10px', color: '#fbbf24', fontWeight: 700 }}>
                              {deepPathExists && !deepActivity ? 'Try deeper recovery' : 'Deep recovery recommended'}
                            </p>
                            {deepPathExists && !deepActivity && (
                              <button
                                type="button"
                                className="wpv3-button"
                                style={{ marginTop: '8px' }}
                                disabled={loading}
                                onClick={() => { setDeepActivity(true); void handleScan(true) }}
                              >
                                Run deep recovery scan
                              </button>
                            )}
                          </div>
                        )
                      })()}

                      {(() => {
                        // RECON-FUNNEL-1: compact debug-style funnel — shows where candidates were lost
                        // between "evidence collected" and "public-grade closed lot" so a wallet with real
                        // swap candidates never looks like "no activity" when the pipeline simply failed
                        // to promote those candidates to verified lots.
                        const f = result.walletTradeReconstructionFunnel
                        const reasonLabels: Record<string, string> = {
                          estimateOnly: 'Estimate-only price',
                          syntheticCostBasis: 'Synthetic/missing cost basis',
                          flatPrice: 'Flat price / near-zero PnL',
                          missingCost: 'Missing cost basis',
                          missingSellPrice: 'Missing sell price',
                          missingBuyPrice: 'Missing buy price',
                          weakIndependence: 'Weak price independence',
                          dust: 'Dust / micro lot',
                          unsupportedRouter: 'Unsupported router/aggregator',
                          noQuoteLeg: 'No quote leg found',
                          noPriorBuy: 'No prior buy found',
                          budgetCapped: 'Scan budget capped',
                        }
                        return (
                          <div className="wpv3-card">
                            <p className="wpv3-title">Trade Reconstruction Funnel</p>
                            {!f ? (
                              <p className="wpv3-support" style={{ marginTop: '10px', color: '#9aa4b2' }}>No reconstruction funnel available for this scan.</p>
                            ) : (
                              <>
                                {[
                                  ['Wallet-side transactions', String(f.walletSideTransactions)],
                                  ['Swap candidate events', String(f.swapCandidateEvents)],
                                  ['Parsed swap transactions', String(f.parsedSwapTransactions)],
                                  ['Candidate buy legs', String(f.candidateBuyLegs)],
                                  ['Candidate sell legs', String(f.candidateSellLegs)],
                                  ['Matched buy/sell pairs', String(f.matchedBuySellPairs)],
                                  ['Raw closed lots', String(f.rawClosedLots)],
                                  ['Public-grade closed lots', String(f.publicGradeClosedLots)],
                                  ['Excluded closed lots', String(f.excludedClosedLots)],
                                ].map(([label, value]) => (
                                  <div key={label} className="wpv3-metric-row"><span className="wpv3-label">{label}</span><span className="wpv3-value" style={{ fontSize: '20px' }}>{value}</span></div>
                                ))}
                                {f.topFailureReasons.length > 0 && (
                                  <p className="wpv3-support" style={{ marginTop: '10px', color: '#9aa4b2' }}>
                                    Top failure reasons: {f.topFailureReasons.map(r => reasonLabels[r] ?? r).join(', ')}
                                  </p>
                                )}
                                {Object.entries(f.exclusionBreakdown).some(([, count]) => count > 0) && (
                                  <p className="wpv3-support" style={{ marginTop: '8px', color: '#9aa4b2' }}>
                                    Exclusion breakdown: {Object.entries(f.exclusionBreakdown)
                                      .filter(([, count]) => count > 0)
                                      .map(([reason, count]) => `${reasonLabels[reason] ?? reason}: ${count}`)
                                      .join(', ')}
                                  </p>
                                )}
                              </>
                            )}
                          </div>
                        )
                      })()}

                      <div className="wpv3-card">
                        <p className="wpv3-title">Trade Evidence</p>
                        <div className="wpv3-support" style={{ marginBottom: '8px', color: '#9aa4b2' }}>
                          {(() => {
                            const q = result.pnlQuality
                            if (q === 'exact_fifo') return 'Verified trade evidence'
                            if (q === 'exact_fifo_micro_sample' && result.pnlQualityReason === 'outlier_lots_excluded') return 'Verified trades found, abnormal-pricing outlier excluded'
                            if (q === 'exact_fifo_micro_sample') return 'Verified dust trades found, not enough meaningful trade data'
                            if (q === 'fifo_with_estimates') return 'Public-safe FIFO read'
                            if (q === 'missing_cost_basis') return 'Sell found — buy cost missing'
                            if (q === 'sell_side_only') return 'Sell found — buy cost missing'
                            if (q === 'open_positions_cost_missing') return 'Open position — cost basis missing'
                            if (q === 'activity_only') return 'Activity found — no matched trade yet'
                            return null
                          })()}
                          {result.walletRecoveryRecommendation?.recommended && (
                            <span style={{ marginLeft: '8px', color: '#7dd3fc' }}>Targeted recovery recommended</span>
                          )}
                        </div>
                        <p className="wpv3-support" style={{ marginBottom: '8px' }}>
                          PnL is calculated from matched buy/sell lots. When buys are missing, ChainLens shows sell proceeds or open position value but does not fake profit.
                        </p>
                        {tradeEvidenceStrong && (result.publicPnlStatus ?? ts!.publicPnlStatus) === 'open_check_integrity_invalid' ? (() => {
                          const integrityErrors = result.pnlIntegrityCheck?.errors ?? []
                          const reasonLabel = (e: string) => e === 'sells_exceed_buys' ? 'Sells exceed buys'
                            : e === 'pnl_portfolio_delta_mismatch' ? 'Portfolio delta mismatch'
                            : e === 'coverage_percent_below_threshold' ? 'Low coverage'
                            : e
                          return <div>
                            <div className="wpv3-value" style={{ fontSize: '22px', color: '#F08A8A' }}>PnL integrity check failed</div>
                            <p className="wpv3-support" style={{ marginTop: '6px' }}>Trades were reconstructed, but profit stats are not public-grade yet.</p>
                            {integrityErrors.length > 0 && (
                              <ul style={{ marginTop: '8px', paddingLeft: '18px', color: '#9aa4b2' }}>
                                {integrityErrors.slice(0, 3).map(e => <li key={e}>{reasonLabel(e)}</li>)}
                              </ul>
                            )}
                            <p className="wpv3-support" style={{ marginTop: '8px', color: '#fbbf24' }}>Win rate and profit-skill scoring are locked.</p>
                          </div>
                        })() : tradeEvidenceStrong ? (() => {
                          const publicStatus = result.publicPnlStatus ?? ts!.publicPnlStatus
                          const publicLots = result.publicPerformanceClosedLots ?? ts!.publicPerformanceClosedLots ?? ts!.publicClosedLots ?? ts!.performanceClosedLots ?? 0
                          const rawLots = result.rawMatchedClosedLots ?? ts!.rawMatchedClosedLots ?? ts!.rawClosedLots ?? ts!.closedLots ?? 0
                          const excludedLots = result.excludedClosedLots ?? ts!.excludedClosedLots ?? Math.max(0, rawLots - publicLots)
                          const winRateUnlockedHere = publicWinRateUnlocked(ts)
                          const labelPnl = publicStatus === 'limited_verified_sample' || publicStatus === 'near_flat_verified_sample' || publicStatus === 'open_check' || publicStatus === 'flat_estimate_only' ? 'Public-sample PnL' : 'Realized PnL'
                          const hasPublicWin = (ts!.winningPerformanceLots ?? 0) > 0
                          const hasPublicLoss = (ts!.losingPerformanceLots ?? 0) > 0
                          const rows: [string, string][] = [
                            [labelPnl, publicPnlLocked(result, ts) ? 'Locked' : fmtSignedUSD(ts!.publicPerformanceRealizedPnlUsd ?? ts!.publicRealizedPnlUsd ?? null)],
                            ['Win Rate', winRateUnlockedHere ? `${(ts!.publicWinRatePercent as number).toFixed(0)}%` : 'Locked'],
                            ['Public-grade trades', String(publicLots)],
                            ['Verified but limited/excluded', String(result.verifiedButExcludedClosedLots ?? ts!.verifiedButExcludedClosedLots ?? Math.max(0, (ts!.verifiedClosedLots ?? 0) - publicLots))],
                            ['Estimate-only excluded', String(ts!.estimateOnlyClosedLots ?? 0)],
                            ['Synthetic/missing-cost excluded', String(ts!.syntheticClosedLotsExcluded ?? 0)],
                            ['Raw matched lots', String(rawLots)],
                            ['Average Hold Period', fmtSecondsToHuman(ts!.avgHoldingTimeSeconds) ?? 'Open Check'],
                            ['Best Trade', hasPublicWin ? fmtSignedUSD(ts!.largestWinUsd) : 'No verified win'],
                            ['Worst Trade', hasPublicLoss ? fmtSignedUSD(ts!.largestLossUsd) : 'No verified loss'],
                            ['Average Win', hasPublicWin ? fmtSignedUSD(deriveAverageMatchedWinUsd(result)) : 'No verified win'],
                            ['Average Loss', hasPublicLoss ? fmtSignedUSD(deriveAverageMatchedLossUsd(result)) : 'No verified loss'],
                          ]
                          return <>
                            <p className="wpv3-support" style={{ marginBottom: '8px', color: '#cbd5e1' }}>
                              Based on {publicLots} public-grade lots. {excludedLots} raw matched lots excluded.
                            </p>
                            <p className="wpv3-support" style={{ marginBottom: '8px' }}>
                              Based on {publicLots} public-grade lots, not full wallet history.
                            </p>
                            {!winRateUnlockedHere && <p className="wpv3-support" style={{ marginBottom: '8px', color: '#fbbf24' }}>Win rate and profit-skill scoring unlock at 10 public-grade trades.</p>}
                            {rows.map(([label,value]) => <div key={label} className="wpv3-metric-row"><span className="wpv3-label">{label}</span><span className="wpv3-value" style={{ fontSize: '20px', color: String(value).startsWith('+') ? '#7DDC9A' : String(value).startsWith('-') ? '#F08A8A' : '#F2F4F7' }}>{value}</span></div>)}
                          </>
                        })() : (() => {
                          // PRESENTATION-ONLY: contextual partial-read copy keyed off the existing
                          // pnlQuality value — never a generic "Insufficient Trade Evidence" when
                          // there is any trade-adjacent activity to report.
                          const q = result.pnlQuality
                          const recoveryNote = result.walletRecoveryRecommendation?.recommended
                            ? 'Historical recovery may unlock additional realized trade evidence.'
                            : null
                          let title = 'Insufficient Trade Evidence'
                          let body = 'No fabricated win rate, PnL, or hold-time metrics are shown without reconstructed closed lots.'
                          if (q === 'open_positions_cost_missing') {
                            title = 'Partial Trade Read'
                            body = 'Open positions detected. Historical trading activity was identified but closed-lot reconstruction is incomplete.'
                          } else if (q === 'missing_cost_basis' || q === 'sell_side_only') {
                            title = 'Partial Trade Read'
                            body = 'Sell activity detected but corresponding buy cost basis has not yet been verified.'
                          } else if (q === 'activity_only') {
                            title = 'Partial Trade Read'
                            body = 'Activity identified, but no matched buy/sell pair has been reconstructed yet.'
                          }
                          return <div>
                            <div className="wpv3-value" style={{ fontSize: '24px' }}>{title}</div>
                            <p className="wpv3-support">{body}</p>
                            {recoveryNote && <p className="wpv3-support" style={{ marginTop: '6px', color: '#7dd3fc' }}>{recoveryNote}</p>}
                          </div>
                        })()}
                      </div>

                      <div className="wpv3-card">
                        <p className="wpv3-title">Trade Intelligence Read</p>
                        {(() => {
                          const ti = result.tradeIntelligence
                          if (!ti || ti.status === 'open_check') {
                            // PRESENTATION-ONLY: a wallet can have real behavior signals (accumulation,
                            // distribution, rotation, multi-chain participation) even while the
                            // performance score stays locked — show what we know instead of a blanket
                            // "Not Enough Data" when those signals exist.
                            if (behaviorTags.length > 0 || activeChains > 1) {
                              return <div>
                                <div className="wpv3-value" style={{ fontSize: '24px' }}>Behavior Read Available</div>
                                <p className="wpv3-support" style={{ marginBottom: '8px' }}>Performance score remains locked, but behavior signals are available from indexed activity.</p>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
                                  {behaviorTags.map(tag => <span key={tag} className="wpv3-support" style={{ border: '1px solid rgba(125,211,252,0.3)', borderRadius: '999px', padding: '3px 10px', color: '#7dd3fc' }}>{tag}</span>)}
                                  {activeChains > 1 && <span className="wpv3-support" style={{ border: '1px solid rgba(125,211,252,0.3)', borderRadius: '999px', padding: '3px 10px', color: '#7dd3fc' }}>Multi-chain participation</span>}
                                </div>
                                <p className="wpv3-support" style={{ color: '#fbbf24' }}>Performance evidence still developing — profit skill not yet proven.</p>
                              </div>
                            }
                            return <div><div className="wpv3-value" style={{ fontSize: '24px' }}>Not Enough Data</div><p className="wpv3-support">No meaningful wallet behavior signals were found in indexed activity.</p></div>
                          }
                          const styleLabel = readableTradeStyleLabel(ti.primaryStyle) ?? ti.primaryStyle.replace(/_/g, ' ')
                          const profitNotProven = ti.profitSkillStatus != null && ti.profitSkillStatus !== 'unlocked'
                          const profitSkillText = ti.profitSkillStatus === 'near_flat_not_proven' ? 'Near-flat / not proven'
                            : ti.profitSkillStatus === 'integrity_invalid_not_proven' ? 'Not proven (integrity)'
                            : ti.profitSkillStatus === 'locked_small_sample' ? 'Locked (small sample)'
                            : ti.profitSkillStatus === 'unlocked' ? 'Unlocked'
                            : (ti.publicPerformanceLots < 10 ? 'Locked (small sample)' : 'Unlocked')
                          const followability = result.walletProfile?.followability ?? 'Low'
                          return <>
                            <p className="wpv3-support" style={{ marginBottom: '8px' }}>{ti.tradeStyleSummary ?? ti.summary}</p>
                            {[
                              ['Style', styleLabel],
                              ['Status', ti.status === 'ready' ? 'Ready' : 'Partial'],
                              ['Confidence', (ti.confidence ?? 'low').replace(/^./, c => c.toUpperCase())],
                              ['Behavior lots', String(ti.tradeIntelLots)],
                              ['Raw matched lots', String(ti.rawMatchedLots)],
                              ['Public PnL lots', String(ti.publicPerformanceLots)],
                              ['Avg hold', ti.avgHoldTimeLabel ?? fmtSecondsToHuman(ti.signals.avgHoldingTimeSeconds) ?? 'Open Check'],
                              ['Profit skill', profitSkillText],
                              ['Followability', followability],
                            ].map(([label,value]) => <div key={label} className="wpv3-metric-row"><span className="wpv3-label">{label}</span><span className="wpv3-value" style={{ fontSize: '20px', textTransform: 'capitalize' }}>{value}</span></div>)}
                            {profitNotProven && <p className="wpv3-support" style={{ marginTop: '10px', color: '#fbbf24' }}>Strong behavior evidence. Profit edge not proven.</p>}
                            {ti.limitations.length > 0 && <div className="wpv3-label" style={{ marginTop: '14px' }}>Limitations</div>}
                            {ti.limitations.map(x => <div key={x} className="wpv3-support" style={{ marginTop: '6px' }}>○ {x.replace(/_/g, ' ')}</div>)}
                          </>
                        })()}
                      </div>

                      <div className="wpv3-card">
                        <p className="wpv3-title">Confidence & Coverage</p>
                        {[
                          ['Confidence', confidence.charAt(0).toUpperCase() + confidence.slice(1)],
                          ['Data Coverage', `${coverage}%`],
                          ['Missing Labels', String(weaknesses.length || missing.length)],
                          ['Unverified Pairs', String(result.walletPriceEvidenceSummary?.openCheckEvents ?? result.walletSwapSummary?.lowConfidenceCount ?? 0)],
                          ['Portfolio Confidence', result.walletProfile?.portfolioConfidence ?? (pi.holdingsCount > 0 ? 'high' : 'low')],
                          ['Trading Confidence', result.walletProfile?.tradingConfidence ?? (tradeEvidenceStrong ? ts!.confidence : 'low')],
                        ].map(([label,value]) => <div key={label} className="wpv3-metric-row"><span className="wpv3-label">{label}</span><span className="wpv3-value" style={{ fontSize: '20px', textTransform: 'capitalize' }}>{value}</span></div>)}
                        <div className="wpv3-label" style={{ marginTop: '14px' }}>Strengths</div>{(strengths.length ? strengths : profileSignals).slice(0, 3).map(x => <div key={x} className="wpv3-support" style={{ marginTop: '6px', color: '#7DDC9A' }}>✓ {x}</div>)}
                        <div className="wpv3-label" style={{ marginTop: '14px' }}>Needs Review</div>{(weaknesses.length ? weaknesses : (missing.length ? missing.map(x => x.replace(/_/g, ' ')) : ['NFT Activity','Bridge Flows','Private Label Attribution'])).slice(0, 3).map(x => <div key={x} className="wpv3-support" style={{ marginTop: '6px' }}>○ {x}</div>)}
                        {walletIntel.openChecks[0] && <div className="wpv3-support" style={{ marginTop: '10px', color: '#E8C76D' }}>Open Check: {walletIntel.openChecks[0]}</div>}
                      </div>

                      <div className="wpv3-card">
                        <p className="wpv3-title">Next Actions</p>
                        {nextActions.map((x,i) => <div key={x} className="wpv3-metric-row"><span className="wpv3-label">{i+1}. {x}</span></div>)}
                        <div className="wpv3-label" style={{ marginTop: '14px' }}>Followability</div><div className="wpv3-value" style={{ fontSize: '20px', marginTop: '6px' }}>{result.walletProfile?.followability ?? 'Open Check'}</div>
                        {profileReasons[0] && <p className="wpv3-support" style={{ marginTop: '10px' }}>{profileReasons[0]}</p>}
                        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '18px' }}>
                          <button
                            type="button"
                            className="wpv3-button wpv3-button-primary"
                            disabled={!result?.address || watchlistStatus === 'saving'}
                            onClick={handleAddWalletToWatchlist}
                          >
                            {watchlistStatus === 'saving' ? 'Saving…' : 'Add To Watchlist'}
                          </button>
                          <button type="button" className="wpv3-button" disabled={!result?.address} onClick={handleExportWalletReport}>
                            Export Report
                          </button>
                        </div>
                        {watchlistMessage && (
                          <p
                            className="wpv3-support"
                            style={{ marginTop: '10px', color: watchlistStatus === 'error' ? '#f87171' : watchlistStatus === 'exists' ? '#7dd3fc' : '#4ade80' }}
                          >
                            {watchlistMessage}
                          </p>
                        )}
                      </div>
                    </div>
                  </section>
                )
              })()}


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
                    if (closedLots > 0) return `${closedLots} matched lots`
                    if (openedLots > 0 && pricedEvents > 0) return `${openedLots} open lot${openedLots !== 1 ? 's' : ''} tracked, no closed sells yet`
                    if (pricedEvents > 0 && openedLots === 0) return 'priced swaps found, no lots opened'
                    if (candidates > 0 && pricedEvents === 0) return 'candidates unpriced'
                    if (mc.walletOpenPositionSummary) return 'Open position detected — no matched sells yet'
                    if ((result.walletLotSummary?.unmatchedSells ?? 0) > 0) return 'Exit detected — entry missing from indexed window'
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
                    if (tradeClosedLots > 0) return `${tradeClosedLots} verified trades` + ((mc.tradeStats.excludedLots ?? 0) > 0 ? ` · ${mc.tradeStats.excludedLots} excluded` : '') + (mc.tradeStats.readyForWinRate ? '' : ' — below threshold')
                    if ((mc.tradeStats.excludedLots ?? 0) > 0) return `Verified stats locked — ${mc.tradeStats.excludedLots} estimate-only/synthetic lots excluded`
                    if (tradeOpenedLots > 0) return `no verified trades yet — ${tradeOpenedLots} open lot${tradeOpenedLots !== 1 ? 's' : ''} tracked`
                    if (mc.swapDetection.candidateCount > 0 && (mc.priceEvidence?.pricedEvents ?? 0) === 0) return 'no verified closed lots'
                    return 'no verified trades for stats yet'
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
                    <button
                      onClick={() => copyAddress(result.address)}
                      title="Copy wallet address"
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: '4px',
                        border: '1px solid rgba(255,255,255,0.10)',
                        background: addressCopied ? 'rgba(45,212,191,0.12)' : 'rgba(255,255,255,0.03)',
                        color: addressCopied ? '#5eead4' : 'rgba(255,255,255,0.45)',
                        borderRadius: '6px', padding: '3px 8px', cursor: 'pointer',
                        fontSize: '9px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                        letterSpacing: '0.08em', textTransform: 'uppercase',
                      }}
                    >
                      {addressCopied ? 'Copied' : 'Copy'}
                    </button>
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
                const walletSideEventsRow = result.walletActivitySummary?.walletSideEvents ?? result.walletEvidenceSummary?.walletSideEvents ?? null
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
                            <span style={{ fontSize: '11px', fontWeight: 600, color: '#4ade80', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>Evidence indexed</span>
                            <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.40)', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>·</span>
                            <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.40)', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{totalEvents} evidence events{walletSideEventsRow != null ? ` · ${walletSideEventsRow} wallet-side` : ''}</span>
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
                    const openPos = result.walletModuleCoverage?.walletOpenPositionSummary ?? result.walletOpenPositionSummary ?? null
                    const hasOpenLots = (openedLots > 0 || !!openPos) && !hasClosedTradeEvidence
                    const tradeOpenCheck = closedLots === 0
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
                    const confidenceNote = hasNoDecisiveClosedLots(ts) ? 'break-even only' : walletIntel.confidence === 'open check' ? (closedLots > 0 ? `${closedLots} closed lots reconstructed` : 'Closed-lot stats not available yet') : 'Evidence weighted'
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
                              const winRateUnlocked = publicWinRateUnlocked(ts)
                              const label = 'Win Rate'
                              const value = winRateUnlocked ? `${(ts!.publicWinRatePercent as number).toFixed(1)}%` : 'Locked'
                              const note = winRateUnlocked ? 'Public-grade closed trades only.' : 'Needs 10+ public-grade closed trades.'
                              return { label, value, note }
                            })(),
                            { label: 'Confidence', value: hasNoDecisiveClosedLots(ts) ? 'break-even only' : ts ? (ts.confidence === 'open_check' ? 'open check' : ts.confidence) : walletIntel.confidence, note: confidenceNote },
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
                  const hasOpenLotsForPnl = (_openedLotsForPnl > 0 || !!_openPosForPnl) && !hasRealTrade
                  // ESTIMATED-PNL-LOCK-FIX: when public PnL is locked (integrity invalid / 0 public
                  // lots), a $0 average-cost estimate must not read as a useful break-even result.
                  const _estPnlLocked = publicPnlLocked(result, result.walletTradeStatsSummary ?? undefined)
                  if (hasRealTrade) {
                    const legacyVal = fmtSignedUSD(walletIntel.pnl.total)
                    const ts = result.walletTradeStatsSummary
                    const isBreakEvenOnly = !!(ts && hasNoDecisiveClosedLots(ts))
                    const totalIsZeroish = walletIntel.pnl.total == null || Math.abs(walletIntel.pnl.total) < 0.005
                    const perfForExposure = result.openPositionPerformanceSummary ?? result.walletModuleCoverage?.openPositionPerformanceSummary ?? null
                    const openPosTokenContracts = new Set((_openPosForPnl?.tokens ?? []).map((t: { contract?: string }) => String(t.contract ?? '').toLowerCase()).filter(Boolean))
                    const matchingHoldings = result.holdings.filter(h => h.value > 0 && openPosTokenContracts.has(String(h.contract ?? '').toLowerCase()))
                    const totalHoldingsValue = result.holdings.reduce((s, h) => s + (h.value > 0 ? h.value : 0), 0)
                    // Fallback: no open-position summary at all — use the largest non-dust holding as exposure evidence
                    const _topHolding = [...result.holdings].sort((a, b) => b.value - a.value)[0] ?? null
                    const fallbackExposureHolding = (!_openPosForPnl && !perfForExposure && _topHolding && _topHolding.value >= 1) ? _topHolding : null
                    const exposureUsd = (perfForExposure?.totalCurrentValueUsd ?? perfForExposure?.matchedCurrentOpenValueUsd ?? null)
                      ?? (matchingHoldings.length > 0 ? matchingHoldings.reduce((s, h) => s + h.value, 0) : null)
                      ?? (fallbackExposureHolding ? fallbackExposureHolding.value : null)
                    const exposureTokenSymbol = matchingHoldings.length > 0 ? null : (fallbackExposureHolding ? (fallbackExposureHolding.symbol || fallbackExposureHolding.name) : null)
                    const exposureWalletPercent = (fallbackExposureHolding && totalHoldingsValue > 0) ? (fallbackExposureHolding.value / totalHoldingsValue) * 100 : null
                    const costBasisRaw = _openPosForPnl?.totalOpenCostBasisUsd ?? perfForExposure?.totalOpenCostBasisUsd ?? null
                    const costBasisIsDust = costBasisRaw != null && costBasisRaw > 0 && costBasisRaw < 0.01
                    const costBasisKnown = costBasisRaw != null && costBasisRaw >= 0.01
                    const showOpenExposureCard = isBreakEvenOnly && totalIsZeroish && exposureUsd != null && exposureUsd > 0 && !costBasisKnown

                    if (showOpenExposureCard) {
                      const fmtUsd2 = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                      return (
                        <div style={{ background: '#080c14', border: '1px solid rgba(251,191,36,0.15)', borderRadius: '18px', padding: '16px 20px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                            <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.18em', color: '#fbbf24', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Open Position Read</div>
                            <span style={{ fontSize: '8px', fontWeight: 700, color: 'rgba(251,191,36,0.55)', border: '1px solid rgba(251,191,36,0.2)', background: 'rgba(251,191,36,0.05)', borderRadius: '999px', padding: '1px 6px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>PnL open check</span>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: '8px' }}>
                            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '10px', padding: '10px' }}>
                              <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.22)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '5px' }}>Current Open Exposure</div>
                              <div style={{ fontSize: '15px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{fmtUsd2(exposureUsd)}</div>
                              {exposureTokenSymbol && (
                                <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.32)', marginTop: '3px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                                  {exposureTokenSymbol}{exposureWalletPercent != null ? ` · ${exposureWalletPercent.toFixed(0)}% of wallet` : ''}
                                </div>
                              )}
                            </div>
                            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '10px', padding: '10px' }}>
                              <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.22)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '5px' }}>Cost Basis</div>
                              <div style={{ fontSize: '13px', fontWeight: 700, color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{costBasisIsDust ? 'Dust / incomplete' : 'Open Check / incomplete'}</div>
                            </div>
                            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '10px', padding: '10px' }}>
                              <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.22)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '5px' }}>Unrealized PnL</div>
                              <div style={{ fontSize: '13px', fontWeight: 700, color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Not calculated</div>
                            </div>
                          </div>
                          <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.28)', lineHeight: 1.4, marginTop: '10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                            Current holding detected, but cost basis is incomplete from indexed activity. Closed-lot realized PnL ({legacyVal === 'Open Check' ? '—' : legacyVal} break-even sample) is shown separately below.
                          </div>
                        </div>
                      )
                    }

                    // WIN-RATE-TRUST-FIX-1: no open-position summary or open-position performance
                    // evidence at all — show an explicit no-estimate state instead of an empty
                    // "Average-Cost Estimate —" box.
                    if (!_openPosForPnl && !perfForExposure) {
                      return (
                        <div style={{ background: '#080c14', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '18px', padding: '16px 20px', opacity: 0.62 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                            <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.18em', color: 'rgba(45,212,191,0.45)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Position Estimate</div>
                          </div>
                          <div style={{ fontSize: '13px', fontWeight: 700, color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>No open position estimate</div>
                          <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.28)', lineHeight: 1.4, marginTop: '6px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                            No public-safe open-lot estimate is available from this scan.
                          </div>
                        </div>
                      )
                    }

                    return (
                      <div style={{ background: '#080c14', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '18px', padding: '16px 20px', opacity: 0.62 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                          <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.18em', color: 'rgba(45,212,191,0.45)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Position Estimate</div>
                          <span style={{ fontSize: '8px', fontWeight: 700, color: 'rgba(125,211,252,0.45)', border: '1px solid rgba(125,211,252,0.15)', background: 'rgba(56,189,248,0.04)', borderRadius: '999px', padding: '1px 6px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>avg cost</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '10px', padding: '10px' }}>
                            <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.22)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '5px' }}>Average-Cost Estimate</div>
                            <div style={{ fontSize: '15px', fontWeight: 700, color: _estPnlLocked ? '#fbbf24' : legacyVal === 'Open Check' ? 'rgba(255,255,255,0.22)' : legacyVal.startsWith('-') ? '#f87171' : '#4ade80', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{_estPnlLocked ? 'Locked' : legacyVal === 'Open Check' ? '—' : legacyVal}</div>
                          </div>
                          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '10px', padding: '10px' }}>
                            <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.22)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '5px' }}>Method</div>
                            <div style={{ fontSize: '13px', fontWeight: 700, color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Avg cost basis</div>
                          </div>
                        </div>
                        <div style={{ fontSize: '10px', color: _estPnlLocked ? 'rgba(251,191,36,0.55)' : 'rgba(255,255,255,0.22)', lineHeight: 1.4, marginTop: '10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                          {_estPnlLocked ? 'Estimated PnL is locked because public-grade performance evidence failed integrity checks.' : 'Average-cost position estimate. Matched closed-lot evidence is shown separately below.'}
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

              {/* Trading Intelligence — personality, bot detection, and windowed PnL (derived from existing FIFO closed-lot data) */}
              {result.walletPersonality && (() => {
                const wp = result.walletPersonality
                const bot = result.walletBotScore
                const windows = result.walletPnlWindows
                const personalityColor =
                  wp.personality === 'Smart Money' ? '#4ade80'
                  : wp.personality === 'Sniper' ? '#2DD4BF'
                  : wp.personality === 'Rotator' ? '#fbbf24'
                  : wp.personality === 'Degen' ? '#f87171'
                  : '#7dd3fc'
                const botColor =
                  bot?.classification === 'High-frequency bot' || bot?.classification === 'Likely bot' ? '#f87171'
                  : bot?.classification === 'Assisted / semi-automated' ? '#fbbf24'
                  : '#4ade80'
                const fmtUsdSigned = (v: number) => `${v < 0 ? '-' : '+'}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                const scoreRows: Array<{ label: string; value: number }> = wp.scores
                  ? [
                      { label: 'Sniper', value: wp.scores.sniperScore },
                      { label: 'Smart Money', value: wp.scores.smartMoneyScore },
                      { label: 'Rotator', value: wp.scores.rotatorScore },
                      { label: 'Degen', value: wp.scores.degenScore },
                    ]
                  : []
                const combinedSummary = [wp.summary, bot?.reason].filter(Boolean).join(' ')
                // PRESENTATION-ONLY: derive a friendlier behavior-based read for the personality/bot
                // cards when the backend has not classified them, without changing any backend value.
                const localBehaviorTags = [
                  ...(result.walletFacts?.flowRead.accumulationSignals?.length ? ['Accumulation'] : []),
                  ...(result.walletFacts?.flowRead.distributionSignals?.length ? ['Distribution'] : []),
                  ...((result.walletFacts?.summary?.chainExposure?.length ?? 0) > 1 ? ['Multi-Chain Participation'] : []),
                ]
                const hasActivityEvidence = (result.walletBehavior?.txCount ?? 0) > 0 || (result.walletBehavior?.activeDays ?? 0) > 0
                const personalityDisplayLabel = wp.personality !== 'Not enough data'
                  ? wp.personality
                  : localBehaviorTags.includes('Accumulation') ? 'Emerging Accumulator'
                  : localBehaviorTags.includes('Distribution') ? 'Distribution-Oriented Wallet'
                  : localBehaviorTags.includes('Multi-Chain Participation') ? 'Active Multi-Chain Participant'
                  : hasActivityEvidence ? 'Conviction Holder'
                  : null
                const personalityIsDerived = wp.personality === 'Not enough data' && personalityDisplayLabel != null
                const botDisplayClassification = bot
                  ? bot.classification
                  : hasActivityEvidence ? 'Low Confidence Read' : null
                return (
                  <div style={{ background: 'rgba(6,10,18,0.95)', border: '1px solid rgba(45,212,191,0.12)', borderRadius: '18px', overflow: 'hidden' }}>
                    <div style={{ padding: '18px 24px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <div style={{ width: '3px', height: '16px', borderRadius: '2px', background: 'linear-gradient(180deg, #2DD4BF, rgba(45,212,191,0.3))', flexShrink: 0 }} />
                      <span className="ws-section-header" style={{ color: '#e2e8f0' }}>Trading Intelligence</span>
                    </div>

                    <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
                      {/* Personality + bot score row */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1.3fr) minmax(180px, 1fr)', gap: '14px' }} className="wallet-intel-grid">
                        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '14px' }}>
                          <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.13em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '8px' }}>Wallet Personality</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: scoreRows.length > 0 ? '12px' : '0' }}>
                            <span style={{ fontSize: '18px', fontWeight: 800, color: personalityColor, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{personalityDisplayLabel ?? wp.personality}</span>
                          </div>
                          {personalityIsDerived && (
                            <p className="wpv3-support" style={{ marginBottom: '8px', color: '#fbbf24' }}>Performance classification remains locked until enough verified closed lots exist.</p>
                          )}
                          {wp.basis === 'behavior_only' && wp.profitSkillStatus !== 'unlocked' && (
                            <p className="wpv3-support" style={{ marginBottom: '8px', color: '#fbbf24' }}>Behavior-only read. Profit skill locked because {wp.profitSkillStatus === 'integrity_invalid_not_proven' ? 'PnL integrity failed' : 'public PnL sample is too small or partial'}.</p>
                          )}
                          {scoreRows.length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                              {scoreRows.map(row => (
                                <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                  <div style={{ width: '76px', fontSize: '10px', color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{row.label}</div>
                                  <div style={{ flex: 1, height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,0.05)', overflow: 'hidden' }}>
                                    <div style={{ height: '100%', width: `${row.value}%`, borderRadius: '3px', background: row.label === wp.personality ? personalityColor : 'rgba(255,255,255,0.18)' }} />
                                  </div>
                                  <div style={{ width: '30px', textAlign: 'right', fontSize: '10px', color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{row.value}</div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '14px' }}>
                          <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.13em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '8px' }}>Bot Score</div>
                          {bot ? (
                            <>
                              <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px', marginBottom: '8px' }}>
                                <div style={{ fontSize: '32px', lineHeight: 0.9, fontWeight: 950, letterSpacing: '-0.04em', color: botColor, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{bot.score}</div>
                                <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', marginBottom: '4px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>/100</div>
                              </div>
                              <div style={{ height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,0.05)', overflow: 'hidden', marginBottom: '8px' }}>
                                <div style={{ height: '100%', width: `${bot.score}%`, borderRadius: '3px', background: botColor }} />
                              </div>
                              <span style={{ display: 'inline-block', fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', color: botColor, border: `1px solid ${botColor}33`, background: `${botColor}14`, borderRadius: '999px', padding: '3px 9px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', textTransform: 'uppercase' }}>{bot.classification}</span>
                              {bot.basis === 'behavior_only' && bot.profitSkillStatus === 'not_proven' && (
                                <p className="wpv3-support" style={{ marginTop: '8px', color: '#fbbf24' }}>Bot score is behavior-only. Profit skill is locked because PnL integrity failed.</p>
                              )}
                            </>
                          ) : botDisplayClassification ? (
                            <>
                              <span style={{ display: 'inline-block', fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', color: '#7dd3fc', border: '1px solid rgba(125,211,252,0.3)', background: 'rgba(125,211,252,0.08)', borderRadius: '999px', padding: '3px 9px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', textTransform: 'uppercase', marginBottom: '8px' }}>{botDisplayClassification}</span>
                              <p className="wpv3-support" style={{ marginTop: '8px' }}>Automation confidence remains limited until enough wallet-side behavior is observed.</p>
                            </>
                          ) : (
                            <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>Not enough data</div>
                          )}
                        </div>
                      </div>

                      {/* Windowed PnL cards */}
                      {windows && (() => {
                        const windowKeys = ['3d', '7d', '30d'] as const
                        const anyWindowHasData = windowKeys.some(key => {
                          const w = windows[key]
                          return w.closedLots > 0 && 'realizedPnlUsd' in w && w.realizedPnlUsd != null
                        })
                        if (!anyWindowHasData) {
                          const _windowsTs = result.walletTradeStatsSummary
                          const lockedOpenLots = result.walletLotSummary?.openedLots ?? _windowsTs?.openedLots ?? 0
                          const lockedMatchedTrades = result.rawMatchedClosedLots ?? _windowsTs?.rawMatchedClosedLots ?? _windowsTs?.rawClosedLots ?? 0
                          return (
                            <div>
                              <div className="ws-stat-label" style={{ marginBottom: '8px' }}>Time-Windowed Realized PnL</div>
                              <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '14px' }}>
                                <div style={{ fontSize: '13px', fontWeight: 700, color: '#7dd3fc', fontFamily: 'var(--font-inter, Inter, sans-serif)', marginBottom: '6px' }}>Realized PnL Locked</div>
                                <p className="wpv3-support" style={{ margin: 0 }}>Verified closed-lot evidence is required before period PnL can be calculated.</p>
                                {(lockedOpenLots > 0 || lockedMatchedTrades > 0) && (
                                  <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.32)', marginTop: '8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                                    {lockedOpenLots > 0 ? `${lockedOpenLots} open position${lockedOpenLots !== 1 ? 's' : ''}` : ''}
                                    {lockedOpenLots > 0 && lockedMatchedTrades > 0 ? ' · ' : ''}
                                    {lockedMatchedTrades > 0 ? `${lockedMatchedTrades} matched trade${lockedMatchedTrades !== 1 ? 's' : ''}` : ''}
                                  </div>
                                )}
                              </div>
                            </div>
                          )
                        }
                        return (
                          <div>
                            <div className="ws-stat-label" style={{ marginBottom: '8px' }}>Time-Windowed Realized PnL</div>
                            <div className="wallet-intel-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px' }}>
                              {windowKeys.map(key => {
                                const w = windows[key]
                                const hasData = w.closedLots > 0 && 'realizedPnlUsd' in w && w.realizedPnlUsd != null
                                const integrityLocked = 'winRateStatus' in w && w.winRateStatus === 'locked_integrity_invalid'
                                return (
                                  <div key={key} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '12px' }}>
                                    <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '7px' }}>{key.toUpperCase()} PnL</div>
                                    {hasData && 'realizedPnlUsd' in w && w.realizedPnlUsd != null ? (
                                      <>
                                        <div style={{ fontSize: '18px', fontWeight: 800, color: w.realizedPnlUsd < 0 ? '#f87171' : '#4ade80', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{fmtUsdSigned(w.realizedPnlUsd)}</div>
                                        <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.32)', marginTop: '4px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                                          {w.closedLots} closed lot{w.closedLots !== 1 ? 's' : ''}{w.winRatePercent != null ? ` · ${w.winRatePercent}% win rate` : ''}
                                        </div>
                                      </>
                                    ) : integrityLocked ? (
                                      <div style={{ fontSize: '12px', color: '#fbbf24', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{('reason' in w && w.reason) || 'PnL integrity check failed, so window PnL and win rate are locked.'}</div>
                                    ) : (
                                      <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.32)', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{'fallback' in w ? w.fallback : 'Not enough data'}</div>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })()}

                      {/* Recent trade behavior summary */}
                      {combinedSummary && (
                        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)', lineHeight: 1.6, fontFamily: 'var(--font-inter, Inter, sans-serif)', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '14px' }}>
                          {combinedSummary}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })()}

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
                const openPos = result.walletModuleCoverage?.walletOpenPositionSummary ?? result.walletOpenPositionSummary ?? null
                const hasOpenLots = (_tiOpenedLots > 0 || !!openPos) && !hasClosedTradeEvidence
                const isOpenCheck = !hasClosedTradeEvidence
                const hasEnough = isTradeStatsGradeable(ts)
                const isBreakEvenOnly = ts.isBreakEvenOnly === true || ((_tiClosedLots > 0) && ts.winningClosedLots === 0 && ts.losingClosedLots === 0 && (ts.breakEvenClosedLots ?? 0) === _tiClosedLots)
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
                    {(() => {
                      const coveragePct = result.estimatedPnl?.coveragePercent ?? 0
                      const closedLots = ls?.closedLots ?? ts.closedLots ?? 0
                      const openLots = ls?.openedLots ?? ts.openedLots ?? 0
                      const unmatchedBuys = ls?.unmatchedBuys ?? 0
                      const unmatchedSells = ls?.unmatchedSells ?? 0
                      const historicalStatus = result.walletHistoricalRecoveryStatus
                        ?? (result.walletHistoricalCoverage?.checked ? 'attempted' : (coveragePct < 60 || unmatchedBuys > 0 || unmatchedSells > 0 || closedLots < 10 ? 'needed' : 'attempted'))
                      const winRateLocked = ts.winRatePercent == null || ts.closedLots < 10 || ts.isBreakEvenOnly === true
                      const lockReason = ts.isBreakEvenOnly === true
                        ? 'break-even only — needs decisive winning or losing closed lots'
                        : ts.closedLots < 10
                          ? 'needs 10+ verified closed lots'
                          : 'needs decisive closed-lot evidence'
                      const showRecoveryPanel = coveragePct < 60 || closedLots < 10 || unmatchedBuys > 0 || unmatchedSells > 0 || historicalStatus !== 'attempted' || result.pnlCacheQuality !== 'complete'
                      if (!showRecoveryPanel) return null
                      const stat = (label: string, value: string | number, tone: string = '#e2e8f0') => (
                        <div key={label} style={{ background: 'rgba(15,23,42,0.52)', border: '1px solid rgba(148,163,184,0.14)', borderRadius: '9px', padding: '8px 10px' }}>
                          <div style={{ fontSize: '8px', color: 'rgba(148,163,184,0.68)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '4px' }}>{label}</div>
                          <div style={{ fontSize: '12px', fontWeight: 800, color: tone }}>{value}</div>
                        </div>
                      )
                      return (
                        <div style={{ fontSize: '12px', color: 'rgba(226,232,240,0.84)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '12px', lineHeight: 1.55, background: 'rgba(251,191,36,0.045)', border: '1px solid rgba(251,191,36,0.16)', borderRadius: '10px', padding: '10px 13px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', marginBottom: '8px' }}>
                            <div style={{ fontWeight: 800, fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(251,191,36,0.88)' }}>PnL status: partial</div>
                            <div style={{ fontSize: '10px', color: 'rgba(251,191,36,0.68)' }}>{result.walletPnlRecoveryCta ?? 'Run historical recovery / Retry deep scan when budget allows'}</div>
                          </div>
                          {result.pnlCacheQuality && result.pnlCacheQuality !== 'complete' && (
                            <div style={{ marginBottom: '8px', fontSize: '11px', color: 'rgba(251,191,36,0.72)' }}>
                              Cached wallet snapshot loaded, but historical PnL recovery is still needed for fuller trade stats.
                            </div>
                          )}
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: '7px', marginBottom: '8px' }}>
                            {stat('Coverage', `${coveragePct}%`, coveragePct >= 60 ? '#4ade80' : '#fbbf24')}
                            {stat('Closed lots', closedLots)}
                            {stat('Open lots', openLots)}
                            {stat('Unmatched buys', unmatchedBuys, unmatchedBuys > 0 ? '#fbbf24' : '#94a3b8')}
                            {stat('Unmatched sells', unmatchedSells, unmatchedSells > 0 ? '#fbbf24' : '#94a3b8')}
                            {stat('Historical recovery', historicalStatus.replaceAll('_', ' '), historicalStatus === 'blocked' ? '#f87171' : historicalStatus === 'attempted' ? '#4ade80' : '#fbbf24')}
                          </div>
                          {winRateLocked && (
                            <div style={{ fontSize: '10px', color: 'rgba(148,163,184,0.74)' }}>
                              Win rate locked until decisive closed lots exist: {lockReason}. Realized PnL is not final while coverage is partial.
                            </div>
                          )}
                        </div>
                      )
                    })()}
                    {result.walletPnlOutlierNote && (
                      <div style={{ fontSize: '12px', color: 'rgba(148,163,184,0.80)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '12px', lineHeight: 1.55, background: 'rgba(148,163,184,0.05)', border: '1px solid rgba(148,163,184,0.18)', borderRadius: '10px', padding: '10px 13px' }}>
                        <div style={{ fontWeight: 700, fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '5px', color: 'rgba(148,163,184,0.90)' }}>Pricing outliers excluded</div>
                        <div style={{ fontSize: '11px', color: 'rgba(148,163,184,0.65)' }}>
                          CORTEX excluded abnormal trade lots so wallet stats are not inflated by bad pricing or decimal evidence.{' '}
                          {result.walletPnlOutlierNote}
                        </div>
                      </div>
                    )}
                    {!result.walletHistoricalScanNote && result.walletHistoricalCoverage && (
                      <div style={{ fontSize: '12px', color: 'rgba(148,163,184,0.84)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '12px', lineHeight: 1.55, background: 'rgba(148,163,184,0.045)', border: '1px solid rgba(148,163,184,0.16)', borderRadius: '10px', padding: '10px 13px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', marginBottom: '6px' }}>
                          <div style={{ fontWeight: 800, fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(226,232,240,0.92)' }}>Historical Coverage</div>
                          <div style={{ fontSize: '10px', color: 'rgba(148,163,184,0.60)' }}>
                            {result.walletHistoricalCoverage.checked ? 'Full historical scan checked' : 'Historical scan not run'}
                          </div>
                        </div>
                        <div style={{ fontSize: '11px', color: 'rgba(148,163,184,0.68)' }}>
                          Older entries recovered: {result.walletHistoricalCoverage.olderEntriesRecovered}.{' '}
                          {result.walletHistoricalCoverage.cappedForCostSafety && 'Historical scan capped for cost safety. '}
                          This scan used a capped evidence budget to keep wallet analysis cost-safe.
                        </div>
                        {(ls?.unmatchedSells ?? 0) > 0 && (
                          <div style={{ marginTop: '6px', fontSize: '11px', color: 'rgba(203,213,225,0.62)' }}>
                            Some exits could not be graded because earlier entries were not found in the indexed history.
                          </div>
                        )}
                        {result.walletHistoricalCoverage.highValueWalletPrioritised && (
                          <div style={{ marginTop: '6px', fontSize: '11px', color: 'rgba(167,139,250,0.78)' }}>
                            High-value wallet detected — ChainLens prioritised the highest-impact trade evidence first.
                          </div>
                        )}
                      </div>
                    )}

                    {result.walletPricingCoverageNote && (
                      <div style={{ fontSize: '12px', color: 'rgba(148,163,184,0.80)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '12px', lineHeight: 1.55, background: 'rgba(148,163,184,0.05)', border: '1px solid rgba(148,163,184,0.18)', borderRadius: '10px', padding: '10px 13px' }}>
                        <div style={{ fontWeight: 700, fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '5px', color: 'rgba(148,163,184,0.90)' }}>Pricing coverage</div>
                        <div style={{ fontSize: '11px', color: 'rgba(148,163,184,0.65)' }}>{result.walletPricingCoverageNote}</div>
                      </div>
                    )}
                    {result.walletHistoricalScanNote && (
                      <div style={{ fontSize: '12px', color: 'rgba(148,163,184,0.80)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '12px', lineHeight: 1.55, background: 'rgba(148,163,184,0.05)', border: '1px solid rgba(148,163,184,0.18)', borderRadius: '10px', padding: '10px 13px' }}>
                        <div style={{ fontWeight: 700, fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '5px', color: 'rgba(148,163,184,0.90)' }}>Historical Coverage</div>
                        <div style={{ fontSize: '11px', color: 'rgba(148,163,184,0.65)' }}>{result.walletHistoricalScanNote}</div>
                      </div>
                    )}
                    {(ls?.unmatchedSells ?? 0) > 0 && (
                      <div style={{ fontSize: '11px', color: 'rgba(251,191,36,0.65)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '10px', lineHeight: 1.5, background: 'rgba(251,191,36,0.04)', border: '1px solid rgba(251,191,36,0.14)', borderRadius: '8px', padding: '8px 12px' }}>
                        <span style={{ fontWeight: 800, color: 'rgba(251,191,36,0.85)' }}>Exit detected — entry missing from indexed window.</span>{' '}
                        Exit detected, but entry is outside the indexed window. PnL Open Check — prior buy not found.
                      </div>
                    )}
                    {!isOpenCheck && isBreakEvenOnly && (ls?.unmatchedSells ?? 0) > 0 && (
                      <div style={{ fontSize: '12px', color: 'rgba(251,191,36,0.80)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '12px', lineHeight: 1.55, background: 'rgba(251,191,36,0.05)', border: '1px solid rgba(251,191,36,0.18)', borderRadius: '10px', padding: '10px 13px' }}>
                        <div style={{ fontWeight: 700, fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '5px' }}>Missing Entry History</div>
                        <div style={{ fontSize: '11px', color: 'rgba(251,191,36,0.70)' }}>
                          {ls!.unmatchedSells} exit{ls!.unmatchedSells !== 1 ? 's were' : ' was'} found with no matching buy inside the indexed window.
                          These exits are excluded from the FIFO score — they cannot be graded as wins or losses without knowing the original entry cost.
                          If earlier buy transactions exist on-chain, deeper history would allow CORTEX to match them and unlock a full realized PnL picture.
                        </div>
                      </div>
                    )}
                    {!isOpenCheck && (
                      <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', fontFamily: 'var(--font-inter, Inter, sans-serif)', marginBottom: ts.economicSignificance === 'micro_sample' || ts.sampleSizeLabel === 'insufficient' ? '8px' : '16px', lineHeight: 1.5 }}>
                        {isBreakEvenOnly
                          ? 'Break-even sample only — no decisive winning or losing closed lots yet.'
                          : 'Closed-lot sample only — does not include current open holdings.'}
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
                              const perf = result.openPositionPerformanceSummary ?? result.walletModuleCoverage?.openPositionPerformanceSummary ?? null
                              const coverage = perf?.coverageLabel ?? 'cost_basis_only'
                              const openEstimateOnly = result.openPositionPnlStatus === 'estimate_only'
                              const openLotsCount = result.walletLotSummary?.openedLots ?? openPos?.openLots ?? 0
                              const costBasis = perf?.totalOpenCostBasisUsd ?? openPos?.totalOpenCostBasisUsd ?? null
                              const fmtUsd2 = (v: number) => `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                              const fmtPct2 = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`

                              // Pick display values based on coverage tier
                              const currentValueLabel = coverage === 'full' ? 'Open position value' : coverage === 'partial' ? 'Open position value (partial)' : null
                              const unrealizedLabel = openEstimateOnly ? 'Unrealized PnL' : coverage === 'full' ? 'Unrealized PnL' : coverage === 'partial' ? 'Unrealized PnL (Partial)' : null
                              const displayCurrentValue = coverage === 'full' ? (perf?.totalCurrentValueUsd ?? null) : coverage === 'partial' ? (perf?.matchedCurrentOpenValueUsd ?? null) : null
                              const displayUnrealizedPnl = coverage === 'full' ? (perf?.totalUnrealizedPnlUsd ?? null) : coverage === 'partial' ? (perf?.matchedUnrealizedPnlUsd ?? null) : null
                              const displayUnrealizedPct = coverage === 'full' ? (perf?.totalUnrealizedPnlPercent ?? null) : coverage === 'partial' ? (perf?.matchedUnrealizedPnlPercent ?? null) : null

                              const summaryCards = [
                                { label: 'Tracked Entry Cost', value: costBasis != null ? `~${fmtUsd2(costBasis)}` : '—', color: '#e2e8f0', dim: false },
                                ...(currentValueLabel ? [{ label: currentValueLabel, value: displayCurrentValue != null ? fmtUsd2(displayCurrentValue) : '—', color: '#e2e8f0', dim: displayCurrentValue == null }] : []),
                                ...(unrealizedLabel ? [{ label: unrealizedLabel, value: openEstimateOnly ? 'Locked' : displayUnrealizedPnl != null ? `${displayUnrealizedPnl >= 0 ? '+' : '-'}${fmtUsd2(displayUnrealizedPnl)}${displayUnrealizedPct != null ? ` (${fmtPct2(displayUnrealizedPct)})` : ''}` : '—', color: openEstimateOnly ? '#fbbf24' : displayUnrealizedPnl == null ? '#94a3b8' : displayUnrealizedPnl >= 0 ? '#4ade80' : '#f87171', dim: displayUnrealizedPnl == null && !openEstimateOnly }] : []),
                              ]

                              const perfTokens = perf?.tokens ?? []
                              const footerNote = openEstimateOnly
                                ? 'Current value uses estimate-only pricing, so unrealized PnL is not public-grade.'
                                : coverage === 'full'
                                ? 'Unrealized. Still open — not banked profit. Not realized PnL.'
                                : coverage === 'partial'
                                  ? `Partial coverage — Unrealized matched open lots only. ${perf!.unmatchedSymbols.join(', ')} current value unavailable, excluded from Open Position PnL.`
                                  : 'Current value unavailable for open tokens — showing tracked cost basis only.'

                              return (
                                <div style={{ marginBottom: '14px' }}>
                                  {/* Header row */}
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                                    <span style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.14em', color: '#fbbf24', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Open Position PnL</span>
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
                                            {openEstimateOnly && tCurrent != null && (
                                              <span style={{ fontSize: '11px', fontWeight: 700, color: '#fbbf24', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Unrealized PnL: Locked</span>
                                            )}
                                            {!openEstimateOnly && tUnrealized != null && (
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
                                    {footerNote} Still open — not banked profit. Realized PnL locked until matched buy → sell closed lots exist.
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
                                if ((ls?.unmatchedSells ?? 0) > 0) return `No closed lots — ${ls!.unmatchedSells} exit${ls!.unmatchedSells !== 1 ? 's were' : ' was'} detected, but the matching entry is outside the indexed window. PnL Open Check — prior buy not found.`
                                if (mc?.walletOpenPositionSummary) return 'No closed lots — open position detected from indexed buy-side activity, but no matched sells yet.'
                                if (ls && (ls.pricedSwapEvents ?? 0) > 0) return 'No closed lots — CORTEX found priced activity, but buys and sells did not match inside the indexed window yet (open holding only).'
                                if (mc?.activity && mc.activity.eventCount > 0 && mc.swapDetection.candidateCount === 0) return `No closed lots — ${mc.activity.eventCount} transfer events indexed but no reconstructable swap pairs found in checked sample (no matched exit yet).`
                                if (mc?.swapDetection && mc.swapDetection.candidateCount > 0 && (mc.priceEvidence?.pricedEvents ?? 0) === 0) return 'No closed lots — swap-like movement found, but pricing is incomplete: quote-side price evidence could not be verified from the available sample.'
                                if (mc?.activity?.reason === 'provider_unavailable') return 'No closed lots — activity layer unavailable. No FIFO lot matching was possible in this scan.'
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
                          {(() => {
                            const pnlBreakEven = isBreakEvenOnly && ts.realizedPnlUsd !== null && ts.realizedPnlUsd === 0
                            // PUBLIC-PNL-CARD-GATING: matched realized PnL / return are raw closed-lot
                            // reads — when public PnL is locked they must not render as green profit.
                            const summaryPublicLocked = publicPnlLocked(result, ts)
                            return [
                              { label: 'Closed Lots', value: String(ts.closedLots), neutral: false },
                              { label: 'Matched Realized PnL', value: summaryPublicLocked ? 'Locked' : (pnlBreakEven ? '$0.00 break-even' : (ts.realizedPnlUsd !== null ? fmtSignedUSD(ts.realizedPnlUsd) : '—')), pnl: summaryPublicLocked || pnlBreakEven ? undefined : ts.realizedPnlUsd, neutral: summaryPublicLocked || pnlBreakEven },
                              { label: 'Return', value: summaryPublicLocked ? 'Locked' : (ts.realizedPnlPercent !== null ? `${ts.realizedPnlPercent >= 0 ? '+' : ''}${ts.realizedPnlPercent.toFixed(1)}%` : '—'), pnl: summaryPublicLocked || isBreakEvenOnly ? undefined : ts.realizedPnlPercent, neutral: summaryPublicLocked || isBreakEvenOnly },
                              { label: 'Tokens Traded', value: String(ts.uniqueTokensTraded), neutral: false },
                              { label: 'Wins', value: isBreakEvenOnly ? 'No decisive winning lots yet' : String(ts.winningClosedLots), neutral: isBreakEvenOnly },
                              { label: 'Losses', value: isBreakEvenOnly ? 'No decisive losing lots yet' : String(ts.losingClosedLots), neutral: isBreakEvenOnly },
                            ].map(card => (
                              <div key={card.label} style={{ background: card.neutral ? 'rgba(148,163,184,0.04)' : 'rgba(255,255,255,0.03)', border: `1px solid ${card.neutral ? 'rgba(148,163,184,0.14)' : 'rgba(255,255,255,0.07)'}`, borderRadius: '12px', padding: '12px' }}>
                                <div style={{ fontSize: '9px', color: card.neutral ? 'rgba(148,163,184,0.55)' : 'rgba(255,255,255,0.28)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '7px' }}>{card.label}</div>
                                <div style={{ fontSize: card.neutral ? '12px' : '18px', fontWeight: 800, fontFamily: 'var(--font-inter, Inter, sans-serif)', color: card.neutral ? 'rgba(148,163,184,0.70)' : ('pnl' in card && card.pnl !== null && card.pnl !== undefined ? (card.pnl >= 0 ? '#4ade80' : '#f87171') : '#e2e8f0') }}>{card.value}</div>
              </div>
                            ))
                          })()}
                        </div>

                        {(() => {
                          const dm = deriveDataModeAndConfidence(result)
                          if (dm.dataMode === 'strict') return null
                          return (
                            <div style={{ background: 'rgba(125,211,252,0.04)', border: '1px solid rgba(125,211,252,0.14)', borderRadius: '10px', padding: '10px 12px', marginBottom: '12px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                                <span style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.14em', color: '#7dd3fc', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Early Evidence Read</span>
                                <span style={{ fontSize: '8px', fontWeight: 700, color: 'rgba(125,211,252,0.55)', border: '1px solid rgba(125,211,252,0.18)', background: 'rgba(125,211,252,0.04)', borderRadius: '999px', padding: '1px 6px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{dm.dataMode}</span>
                              </div>
                              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)', lineHeight: 1.6, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                                {dm.rawSampleLabel === 'break-even only'
                                  ? `Break-even sample only — ${dm.rawClosedLots} closed lot${dm.rawClosedLots !== 1 ? 's' : ''}, $0.00 matched realized PnL, no decisive win or loss.`
                                  : dm.rawSampleLabel
                                    ? `${dm.rawSampleLabel.charAt(0).toUpperCase()}${dm.rawSampleLabel.slice(1)} — ${dm.rawWinningLots}W / ${dm.rawLosingLots}L${dm.rawBreakEvenLots > 0 ? ` / ${dm.rawBreakEvenLots} break-even` : ''}${dm.rawWinRatePercent !== null ? `, win rate locked` : ''}.`
                                    : 'Limited evidence indexed for this wallet.'}
                              </div>
                              <div style={{ fontSize: '10px', color: 'rgba(125,211,252,0.55)', marginTop: '6px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.5 }}>
                                Official win rate locked · Score locked until enough verified closed lots · This does not prove the wallet has never lost money.
                              </div>
                            </div>
                          )
                        })()}

                        {(() => {
                          const rawWinRate = ts.closedLots > 0 && !hasNoDecisiveClosedLots(ts) ? ts.winRatePercent ?? (ts.winningClosedLots / ts.closedLots) * 100 : null
                          const isBreakEvenOnly = ts.isBreakEvenOnly === true || (ts.closedLots > 0 && ts.winningClosedLots === 0 && ts.losingClosedLots === 0 && ts.breakEvenClosedLots === ts.closedLots)
                          const isSmallSample = ts.closedLots > 0 && !hasEnough
                          // PUBLIC-PNL-CARD-GATING: when public PnL is locked (integrity invalid /
                          // 0 public-grade lots / null public stats), raw win rate / avg PnL / avg
                          // return / median return must NOT render as green public-looking numbers.
                          // They are behavior-only estimates and must show "Locked" instead.
                          const publicLocked = publicPnlLocked(result, ts)
                          const lockedPnlCard = (label: string) => ({ label, value: 'Locked', publicLock: true })
                          const profitSkillCard = { label: 'Profit Skill', value: 'Not Proven', publicLock: true }
                          const earlyCards: Array<{ label: string; value: string | null; locked?: boolean; lockNote?: string; pnl?: number | null; raw?: boolean; breakEven?: boolean; publicLock?: boolean }> = [
                            publicLocked ? lockedPnlCard('Win Rate') : {
                              label: 'Win Rate',
                              value: isBreakEvenOnly ? 'Break-even only' : rawWinRate !== null ? `${rawWinRate.toFixed(1)}%` : null,
                              locked: !isBreakEvenOnly && rawWinRate === null,
                              lockNote: officialWinRateLockCopy(ts),
                              raw: !isBreakEvenOnly && isSmallSample && rawWinRate !== null,
                              breakEven: isBreakEvenOnly,
                            },
                            publicLocked ? lockedPnlCard('Realized PnL') : { label: 'Realized PnL', value: ts.publicRealizedPnlUsd !== null && ts.publicRealizedPnlUsd !== undefined ? fmtSignedUSD(ts.publicRealizedPnlUsd) : '—', pnl: ts.publicRealizedPnlUsd },
                            publicLocked ? lockedPnlCard('Avg PnL / Lot') : { label: 'Avg PnL / Lot', value: ts.avgPnlUsdPerClosedLot !== null ? fmtSignedUSD(ts.avgPnlUsdPerClosedLot) : '—', pnl: ts.avgPnlUsdPerClosedLot },
                            publicLocked ? lockedPnlCard('Avg Return / Lot') : { label: 'Avg Return / Lot', value: ts.avgReturnPercentPerClosedLot !== null ? `${ts.avgReturnPercentPerClosedLot >= 0 ? '+' : ''}${ts.avgReturnPercentPerClosedLot.toFixed(1)}%` : '—', pnl: ts.avgReturnPercentPerClosedLot },
                            publicLocked ? lockedPnlCard('Median Return') : { label: 'Median Return', value: ts.medianReturnPercentPerClosedLot !== null ? `${ts.medianReturnPercentPerClosedLot >= 0 ? '+' : ''}${ts.medianReturnPercentPerClosedLot.toFixed(1)}%` : '—', pnl: ts.medianReturnPercentPerClosedLot },
                            publicLocked ? profitSkillCard : { label: 'Profit Skill', value: 'Public-grade', pnl: null },
                            { label: 'Avg Hold Time', value: fmtHoldTime(ts.avgHoldingTimeSeconds) },
                            { label: 'Median Hold Time', value: fmtHoldTime(ts.medianHoldingTimeSeconds) },
                          ]
                          const _rawLotsCopy = result.walletTradeReconstructionFunnel?.rawClosedLots ?? result.rawMatchedClosedLots ?? ts.rawClosedLots ?? ts.closedLots ?? 0
                          const _pubLotsCopy = result.publicPerformanceClosedLots ?? ts.publicPerformanceClosedLots ?? 0
                          return (
                            <>
                            {publicLocked && (
                              <div style={{ fontSize: '11px', color: '#fbbf24', background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.18)', borderRadius: '8px', padding: '9px 12px', marginBottom: '12px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.55 }}>
                                Profit is locked. {_rawLotsCopy} raw matched lots were found, but {_pubLotsCopy} passed public-grade performance checks. Trade behavior is usable; profit skill is not proven.<br />{_rawLotsCopy} raw matched lots found, but {_pubLotsCopy} passed public-grade performance checks. Trade behavior is usable. Profit skill is not proven.<br />Reasons: estimate-only prices, synthetic/missing cost basis, dust/micro lots, and PnL integrity mismatch.
                              </div>
                            )}
                            <div className="wallet-intel-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px', marginBottom: '14px' }}>
                              {earlyCards.map(card => (
                                <div key={card.label} style={{ background: card.publicLock ? 'rgba(251,191,36,0.05)' : card.breakEven ? 'rgba(148,163,184,0.05)' : card.raw ? 'rgba(251,191,36,0.05)' : 'rgba(255,255,255,0.03)', border: `1px solid ${card.publicLock ? 'rgba(251,191,36,0.20)' : card.breakEven ? 'rgba(148,163,184,0.18)' : card.raw ? 'rgba(251,191,36,0.20)' : 'rgba(255,255,255,0.07)'}`, borderRadius: '12px', padding: '12px' }}>
                                  <div style={{ fontSize: '9px', color: card.publicLock ? 'rgba(251,191,36,0.65)' : card.breakEven ? 'rgba(148,163,184,0.65)' : card.raw ? 'rgba(251,191,36,0.65)' : 'rgba(255,255,255,0.28)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '7px' }}>{card.label}</div>
                                  {card.publicLock ? (
                                    <div style={{ fontSize: '14px', fontWeight: 800, color: '#fbbf24', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                                      Locked
                                      <div style={{ fontSize: '9px', fontWeight: 600, color: 'rgba(251,191,36,0.55)', marginTop: '3px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Not public PnL · profit skill not proven</div>
                                    </div>
                                  ) : card.locked ? (
                                    <div style={{ fontSize: '11px', color: '#7dd3fc', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.4 }}>
                                      Not calculated yet
                                      <div style={{ fontSize: '9px', color: 'rgba(125,211,252,0.55)', marginTop: '3px' }}>{card.lockNote}</div>
                                    </div>
                                  ) : (
                                    <div style={{ fontSize: card.breakEven ? '13px' : '16px', fontWeight: 800, fontFamily: 'var(--font-inter, Inter, sans-serif)', color: card.breakEven ? 'rgba(148,163,184,0.80)' : card.raw ? '#fbbf24' : ('pnl' in card && card.pnl !== null && card.pnl !== undefined ? (card.pnl >= 0 ? '#4ade80' : '#f87171') : '#e2e8f0') }}>{card.value}</div>
                                  )}
                                  {card.breakEven && <div style={{ fontSize: '9px', color: 'rgba(148,163,184,0.50)', marginTop: '3px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>no decisive trades · score unlocks at 10+</div>}
                                  {card.raw && !card.breakEven && <div style={{ fontSize: '9px', color: 'rgba(251,191,36,0.50)', marginTop: '3px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>score unlocks at 10+</div>}
                                </div>
                              ))}
                            </div>
                            </>
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
                        {ls && ls.unmatchedSells > 0 && (
                          <div style={{ fontSize: '11px', color: 'rgba(148,163,184,0.65)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.55, background: 'rgba(148,163,184,0.03)', border: '1px solid rgba(148,163,184,0.10)', borderRadius: '8px', padding: '7px 11px', marginTop: '8px' }}>
                            Some exits were detected without matching entries inside the indexed window. Deeper history may unlock more realized PnL.
                          </div>
                        )}

                        {(result.walletClosedTradeSamples?.length ?? 0) > 0 && (() => {
                          // VISIBLE-SAMPLE-DEDUPE: the same reconstructed lot can appear twice in the
                          // visible sample array (e.g. SEARXLY). Dedupe ONLY the rendered rows by a
                          // stable identity key — underlying raw evidence is never mutated.
                          const _seenSampleKeys = new Set<string>()
                          const samples = result.walletClosedTradeSamples!.filter(s => {
                            const k = `${(s.tokenAddress ?? '').toLowerCase()}|${s.entryTxHash ?? ''}|${s.exitTxHash ?? ''}|${s.amountClosed}|${s.openedAt}|${s.closedAt}`
                            if (_seenSampleKeys.has(k)) return false
                            _seenSampleKeys.add(k)
                            return true
                          })
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
                                <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Matched Trade Evidence</div>
                                <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Sample of reconstructed buy → sell lots. These are behavior evidence only unless they pass public-grade PnL checks.</span>
                              </div>
                              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.28)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.5, marginBottom: '10px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px', padding: '8px 10px' }}>
                                Sample of reconstructed buy → sell lots. These are behavior evidence only unless they pass public-grade PnL checks. When public PnL is locked, per-lot PnL shows as “Locked”.
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                {samples.map((s, i) => {
                                  // SAMPLE-LOT-INTEGRITY-FIX: when public PnL is locked or this lot is excluded,
                                  // do not fall back to raw-labeled aliases in the public UI; raw values remain debug-only.
                                  const samplePnlLocked = publicPnlLocked(result, ts) || s.includedInPublicStats === false || s.publicPnlStatus !== 'ok'
                                  const lotPnlUsd = samplePnlLocked ? null : (s.realizedPnlUsd ?? null)
                                  const lotPnlPercent = samplePnlLocked ? null : (s.realizedPnlPercent ?? null)
                                  const pnlColor = lotPnlUsd === null ? '#94a3b8' : lotPnlUsd >= 0 ? '#4ade80' : '#f87171'
                                  const holdStr = fmtHoldTime(s.holdingTimeSeconds)
                                  const pnlStr = lotPnlUsd !== null ? `${lotPnlUsd >= 0 ? '+' : '-'}$${Math.abs(lotPnlUsd).toFixed(2)}` : (samplePnlLocked ? 'Locked' : '—')
                                  const pctStr = lotPnlPercent !== null ? ` (${lotPnlPercent >= 0 ? '+' : ''}${lotPnlPercent.toFixed(1)}%)` : ''
                                  // PUBLIC-PNL-ROW-GATING: explain WHY a locked row shows no public PnL — never
                                  // surface rawRealizedPnlUsd here. Verify-entry/exit buttons below stay intact.
                                  const lockReason = !samplePnlLocked ? null
                                    : s.verificationStatus === 'synthetic_cost_basis_missing' ? 'Not public-grade: missing independent entry price (synthetic cost basis).'
                                    : s.verificationStatus === 'price_independence_missing' ? 'Not public-grade: missing independent entry price.'
                                    : s.verificationStatus === 'estimate_only_price_flat' ? 'Not public-grade: estimate-only / flat price.'
                                    : s.pnlLockedReason ?? 'Not public-grade: estimate-only price, missing independent entry price, synthetic cost basis, dust lot, or integrity lock.'
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
                                      <div style={{ minWidth: '90px' }} title={lockReason ?? undefined}>
                                        <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.10em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '3px' }}>PnL</div>
                                        <div style={{ fontSize: '13px', fontWeight: 700, color: samplePnlLocked ? '#fbbf24' : pnlColor, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{pnlStr}</div>
                                        {pctStr && <div style={{ fontSize: '10px', color: pnlColor, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', opacity: 0.7 }}>{pctStr}</div>}
                                        {lockReason && <div style={{ fontSize: '8px', color: 'rgba(251,191,36,0.55)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginTop: '3px', lineHeight: 1.4, maxWidth: '150px' }}>{lockReason}</div>}
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
                const earlyWinPct = closedLots > 0 && ts && !hasNoDecisiveClosedLots(ts) ? Math.round((ts.winningClosedLots / ts.closedLots) * 100) : null
                const earlyLossPct = closedLots > 0 && ts && !hasNoDecisiveClosedLots(ts) ? Math.round((ts.losingClosedLots / ts.closedLots) * 100) : null
                const winRateUnlockedTB = publicWinRateUnlocked(ts)
                const winRateLabel = winRateUnlockedTB ? 'Win Rate' : 'Matched Closed-Lot Read'
                const lossRateLabel = !hasEnough && closedLots > 0 ? 'Matched Losing Lots' : 'Loss Rate'
                const winRateDisplay = winRateUnlockedTB
                  ? `${(ts!.publicWinRatePercent as number).toFixed(1)}%`
                  : ts && closedLots > 0
                    ? `${ts.winningClosedLots} matched positive lot${ts.winningClosedLots !== 1 ? 's' : ''}${ts.breakEvenClosedLots > 0 ? `, ${ts.breakEvenClosedLots} break-even` : ''}`
                    : 'Open Check'
                const lossRateDisplay = hasEnough
                  ? fmtOpenPct(walletIntel.lossRate)
                  : !hasEnough && ts && closedLots > 0
                    ? (ts.losingClosedLots === 0 ? 'None found in matched sample' : `${ts.losingClosedLots} matched losing lot${ts.losingClosedLots !== 1 ? 's' : ''}`)
                    : 'Open Check'
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
                    <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.34)', marginTop: '14px', fontFamily: 'var(--font-inter, Inter, sans-serif)', lineHeight: 1.6 }}>
                      Behavior confidence is based on verified movement patterns, not public profit.
                    </div>
                    {!hasEnough && closedLots > 0 && (
                      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.28)', marginTop: '8px', fontFamily: 'var(--font-inter, Inter, sans-serif)', lineHeight: 1.6 }}>
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
                  <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.18em', color: 'rgba(45,212,191,0.80)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>CORTEX Wallet Read</div>
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

            <div style={{ marginTop: '4px', background: 'rgba(45,212,191,0.035)', border: '1px solid rgba(45,212,191,0.12)', borderRadius: '14px', padding: '14px', boxShadow: '0 0 24px rgba(45,212,191,0.035)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '12px' }}>
                <div>
                  <p style={{ margin: 0, fontSize: '9px', fontWeight: 800, color: 'rgba(45,212,191,0.70)', letterSpacing: '0.16em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Wallet Watchlist</p>
                  <p style={{ margin: '5px 0 0', fontSize: '11px', color: 'rgba(148,163,184,0.68)', lineHeight: 1.4 }}>Saved wallets stay here until you remove them.</p>
                </div>
                <button
                  type="button"
                  onClick={handleAddWalletToWatchlist}
                  disabled={!result?.address || watchlistStatus === 'saving'}
                  style={{ border: '1px solid rgba(45,212,191,0.30)', background: result?.address ? 'rgba(45,212,191,0.10)' : 'rgba(148,163,184,0.06)', color: result?.address ? '#2DD4BF' : 'rgba(148,163,184,0.35)', borderRadius: '999px', padding: '7px 10px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', cursor: result?.address && watchlistStatus !== 'saving' ? 'pointer' : 'not-allowed' }}
                >
                  {watchlistStatus === 'saving' ? 'Saving…' : 'Save'}
                </button>
              </div>

              {watchlistMessage && (
                <p style={{ margin: '0 0 10px', fontSize: '11px', color: watchlistStatus === 'error' ? '#f87171' : watchlistStatus === 'exists' ? '#7dd3fc' : '#4ade80', lineHeight: 1.4 }}>
                  {watchlistMessage}
                </p>
              )}

              {watchlistLoading ? (
                <p style={{ margin: 0, fontSize: '12px', color: 'rgba(148,163,184,0.55)' }}>Loading saved wallets…</p>
              ) : watchlistWallets.length === 0 ? (
                <p style={{ margin: 0, fontSize: '12px', color: 'rgba(148,163,184,0.45)', lineHeight: 1.55 }}>No saved wallets yet. Scan a wallet, then click Save.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {watchlistWallets.map((wallet) => {
                    const deleting = watchlistDeleting?.toLowerCase() === wallet.address.toLowerCase()
                    return (
                      <div key={wallet.id ?? wallet.address} style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '10px', borderRadius: '11px', background: 'rgba(6,10,18,0.72)', border: '1px solid rgba(255,255,255,0.06)' }}>
                        <button type="button" onClick={() => setInput(wallet.address)} title="Load wallet address" style={{ minWidth: 0, flex: 1, textAlign: 'left', border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }}>
                          <p style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '11px', color: '#e2e8f0', fontWeight: 700, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{wallet.address.slice(0, 8)}…{wallet.address.slice(-6)}</p>
                          <p style={{ margin: '4px 0 0', fontSize: '10px', color: 'rgba(148,163,184,0.55)' }}>{wallet.portfolio_value ? fmtUSD(wallet.portfolio_value) : 'Value not saved'}{wallet.label ? ` · ${wallet.label}` : ''}</p>
                        </button>
                        <button type="button" aria-label="Remove wallet from watchlist" disabled={deleting} onClick={() => handleRemoveWalletFromWatchlist(wallet.address)} style={{ width: '30px', height: '30px', flexShrink: 0, borderRadius: '9px', border: '1px solid rgba(248,113,113,0.22)', background: 'rgba(248,113,113,0.08)', color: deleting ? 'rgba(248,113,113,0.45)' : '#f87171', cursor: deleting ? 'wait' : 'pointer', fontSize: '14px', lineHeight: 1 }}>
                          🗑
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
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
