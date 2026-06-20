import { fetchMoralisBalances, fetchMoralisTransfers, type MoralisFetchResult, type MoralisChain, type MoralisTransferItem } from './moralis'
import { computeWalletProfile, type WalletProfile } from './walletIdentity'

export { computeWalletProfile, type WalletProfile }


// Exhaustive, mutually-exclusive reason buckets for unknownEvents diagnostics
// (debug-only — see buildSwapDetection's unknownReasonBucketCounts).
type UnknownReasonBucket =
  | 'unknown_direction' | 'missing_wallet_side' | 'missing_counterparty' | 'router_not_detected'
  | 'no_quote_asset' | 'failed_pairing' | 'failed_stable_match' | 'failed_weth_match'
  | 'failed_multi_token_match' | 'failed_same_tx_match' | 'pricing_unavailable' | 'other'

type TokenUsage = {
  providerFetch: number
  swapDetection: number
  normalization: number
  priceInference: number
  fifoEngine: number
  fallbackEngine: number
  tradeStats: number
  debugLogging: number
  total: number
  debugLimit: number
}

type TokenUsageStage = Exclude<keyof TokenUsage, 'total' | 'debugLimit'>

const TOKEN_USAGE_STAGES: TokenUsageStage[] = [
  'providerFetch',
  'swapDetection',
  'normalization',
  'priceInference',
  'fifoEngine',
  'fallbackEngine',
  'tradeStats',
  'debugLogging',
]

const DEFAULT_MAX_DEBUG_TOKENS = 40

const EMPTY_TOKEN_USAGE = (debugLimit = DEFAULT_MAX_DEBUG_TOKENS): TokenUsage => ({
  providerFetch: 0,
  swapDetection: 0,
  normalization: 0,
  priceInference: 0,
  fifoEngine: 0,
  fallbackEngine: 0,
  tradeStats: 0,
  debugLogging: 0,
  total: 0,
  debugLimit,
})

const estimateTokenMeterChars = (value: unknown, depth = 0, seen?: WeakSet<object>): number => {
  if (value == null) return 0
  if (typeof value === 'string') return value.length
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value).length
  if (value instanceof Date) return value.toISOString().length
  if (depth >= 4) return 0
  if (typeof value !== 'object') return 0
  const obj = value as object
  const visited = seen ?? new WeakSet<object>()
  if (visited.has(obj)) return 0
  visited.add(obj)
  if (Array.isArray(value)) {
    let chars = 0
    const limit = Math.min(value.length, 50)
    for (let i = 0; i < limit; i++) chars += estimateTokenMeterChars(value[i], depth + 1, visited)
    chars += String(value.length).length
    return chars
  }
  let chars = 0
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 50)
  for (const [key, entryValue] of entries) {
    chars += key.length + estimateTokenMeterChars(entryValue, depth + 1, visited)
  }
  return chars
}

const createTokenMeter = (debug = false, maxDebugTokens = DEFAULT_MAX_DEBUG_TOKENS) => {
  const debugLimit = Number.isFinite(maxDebugTokens) && maxDebugTokens >= 0
    ? Math.floor(maxDebugTokens)
    : DEFAULT_MAX_DEBUG_TOKENS
  const usage = EMPTY_TOKEN_USAGE(debugLimit)
  const active = new Set<TokenUsageStage>()
  let debugEnabled = debug
  let debugAutoDisabled = false
  const toTokens = (chars: number) => Math.ceil(Math.max(0, chars) / 4)
  const disableDebug = () => {
    if (debugEnabled) debugAutoDisabled = true
    debugEnabled = false
  }
  const isDebugEnabled = () => debugEnabled
  const wasDebugAutoDisabled = () => debugAutoDisabled
  const startTokenMeter = (label: TokenUsageStage) => {
    active.add(label)
  }
  const endTokenMeter = (label: TokenUsageStage) => {
    active.delete(label)
  }
  const measure = (label: TokenUsageStage, ...values: unknown[]) => {
    if (label === 'debugLogging' && !debugEnabled) return
    let chars = 0
    for (const value of values) chars += estimateTokenMeterChars(value)
    usage[label] += toTokens(chars)
    if (label === 'debugLogging' && usage.debugLogging > debugLimit) {
      disableDebug()
    }
  }
  const snapshot = (): TokenUsage => {
    const tokenUsage = { ...usage, total: TOKEN_USAGE_STAGES.reduce((sum, stage) => sum + usage[stage], 0), debugLimit }
    if (debugEnabled) console.debug('[walletSnapshot] tokenUsage', tokenUsage)
    return tokenUsage
  }
  return { startTokenMeter, endTokenMeter, measure, snapshot, disableDebug, isDebugEnabled, wasDebugAutoDisabled }
}

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



type GrTransferDiag = {
  endpointKind?: string | null
  chainUsed?: string | null
  urlTemplate?: string | null
  httpStatus?: number | null
  fetchFailed?: boolean
  failureStage?: "build_url" | "fetch" | "timeout" | "parse" | "empty_response" | "no_items" | null
  rawItemCount?: number
  normalizedEventCount?: number
  firstEventShapeKeys?: string[]
  transferArrayCount?: number
  firstTransferKeys?: string[]
  reason?: string
  attemptedHosts?: Array<{
    requestHost: string
    requestUrlValid: boolean
    httpStatus: number | null
    fetchFailed: boolean
    failureStage: 'build_url' | 'fetch' | 'timeout' | 'empty_response' | 'no_items' | null
    fetchErrorKind?: 'invalid_url' | 'network' | 'timeout' | 'unknown' | null
    fetchErrorMessage?: string | null
  }>
}

type NormalizeMoralisDebug = {
  rawCount: number; normalizedCount: number
  skippedNotWalletSide: number; skippedMissingHash: number; skippedMissingTimestamp: number
  skippedMissingTokenAddress: number; skippedMissingAmount: number; skippedInvalidAmount: number
  skippedSpam: number
  sampleNormalizedEvents: Array<{ contract: string; symbol: string; direction: string; amount: number; txHash: string | null }>
  sampleSkippedReasons: Array<{ reason: string; idx: number }>
}

export type WalletBehavior = {
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

type WalletFacts = {
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
  estimatedPnl: {
    method: 'average_cost_estimate'
    status: 'ok' | 'partial' | 'unavailable' | 'error' | 'open_check'
    confidence: 'high' | 'medium' | 'low' | 'open_check' | null
    realizedPnlUsd: number | null
    coveragePercent: number
  }
}

export type WalletSnapshot = {
  address: string
  totalValue: number
  holdings: Holding[]
  txCount: number | null
  firstTxDate: string | null
  walletAgeDays: number | null
  providerUsed: 'portfolio_layer' | 'holdings_layer' | 'fallback_layer' | 'unverified' | 'none'
  providerStatus: 'ok' | 'partial' | 'failed'
  holdingsCount: number
  totalUsdAvailable: boolean
  reason: string
  portfolioSource: 'portfolio_layer' | 'holdings_layer' | 'fallback_layer' | 'unverified' | 'none'
  behaviorSource: 'activity_layer' | 'unavailable'
  behaviorChain: 'base'
  pnlSource: 'activity_layer' | 'fallback_layer' | 'unavailable'
  pnlCoverageReason: string
  hiddenDustCount: number
  unpricedHoldingsCount: number
  walletBehavior: WalletBehavior
  // PHASE5-FIX-1: there is no `closedLots` or `coverage` (unqualified) field on estimatedPnl,
  // and no `walletOpenPositionSummary` field anywhere on WalletSnapshot — grep confirms zero
  // references to any of the three across this file. Every fallback site already reads
  // estimatedPnl.coveragePercent, walletLotSummary.closedLots, and walletLotSummary.openLots
  // (see e.g. line ~6963, ~9495+). No deprecated-field migration was needed.
  estimatedPnl: {
    status: 'ok' | 'partial' | 'unavailable' | 'error'
    confidence: 'high' | 'medium' | 'low' | null
    // PHASE5-FIX-5: coveragePercent remains the unweighted per-token average (back-compat).
    // coveragePercentValueWeighted weights each token's coverage by its current USD value so a
    // $1 dust position no longer carries the same weight as a $100k holding in the headline metric.
    coveragePercent: number
    coveragePercentValueWeighted: number
    source: 'activity_layer' | 'fallback_layer' | 'none'
    totalEstimatedPnlUsd: number | null
    unrealizedPnlUsd: number | null
    realizedPnlUsd: number | null
    method: 'average_cost_estimate'
    tokens: Array<{
      symbol: string
      contract: string
      currentValueUsd: number
      estimatedCostBasisUsd: number | null
      estimatedUnrealizedPnlUsd: number | null
      estimatedRealizedPnlUsd: number | null
      buysDetected: number
      sellsDetected: number
      unexplainedTransfers: number
      coveragePercent: number
      confidence: 'high' | 'medium' | 'low'
      reason: string
    }>
    reason: string
  }
  walletEvidenceSummary: {
    status: 'ready' | 'partial' | 'missing_hashes' | 'no_events' | 'provider_unavailable' | 'not_requested'
    totalEvents: number
    eventsWithHash: number
    eventsWithTimestamp: number
    hashCoverage: number
    timestampCoverage: number
    readyForSwapDetection: boolean
    missing: string[]
  }
  walletSwapSummary: {
    status: 'ok' | 'partial' | 'open_check'
    totalEvidenceEvents: number
    groupedTxCount: number
    swapCandidateEvents: number
    routerSwapCandidateEvents: number
    walletInitiatedSwapCandidateEvents: number
    sameTxInboundOutboundCandidates: number
    highConfidenceSwapCandidates: number
    mediumConfidenceSwapCandidates: number
    lowConfidenceSwapCandidates: number
    transferEvents: number
    airdropCandidateEvents: number
    bridgeCandidateEvents: number
    unknownEvents: number
    readyForPriceAtTime: boolean
    missing: string[]
  }
  walletPriceEvidenceSummary: {
    status: 'ok' | 'partial' | 'open_check'
    swapCandidateEvents: number
    pricedEvents: number
    openCheckEvents: number
    unavailableEvents: number
    stableLegPricedEvents: number
    wethLegPricedEvents: number
    historicalPricedEvents: number
    providerEventUsdPricedEvents: number
    currentHoldingPricedEvents: number
    priceAttemptLimitReached: boolean
    readyForLotMatching: boolean
    missing: string[]
  }
  walletLotSummary: {
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
  walletTradeStatsSummary: {
    status: 'ok' | 'partial' | 'open_check'
    closedLots: number
    uniqueTokensTraded: number
    realizedPnlUsd: number | null
    realizedPnlPercent: number | null
    winningClosedLots: number
    losingClosedLots: number
    breakEvenClosedLots: number
    isBreakEvenOnly: boolean
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
    rawStatsAvailable: boolean
    scoreUnlocked: boolean
    confidenceLabel: 'open_check' | 'break_even_only' | 'very_small_sample' | 'small_sample' | 'early_confidence' | 'developing' | 'high'
    sampleWarning: string | null
    meaningfulClosedLots: number
    dustClosedLots: number
    meaningfulCostBasisUsd: number
    avgCostBasisPerClosedLot: number | null
    economicSignificance: 'meaningful' | 'micro_sample' | 'open_check'
    economicSignificanceReason: string
    // PHASE5-FIX-4: realizedPnlUsd above always includes dust lots (kept for backward
    // compatibility with existing API shape). These two fields make the dust-adjusted view
    // explicit instead of leaving the dust-inclusion/exclusion inconsistency implicit.
    meaningfulRealizedPnlUsd: number | null
    dustThresholdUsd: number
    missing: string[]
  }
  walletTradeStatsSource: 'base_sample' | 'historical_promoted_preview'
  tokenUsage: TokenUsage
  debugAutoDisabled?: true
  walletClosedTradeSamples: Array<{
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
    entryTxHash: string | null
    exitTxHash: string | null
    verificationStatus: 'verifiable' | 'partial' | 'not_available'
  }>
  walletClosedLotsAll: WalletClosedLot[]
  walletHistoricalCoverageSummary: {
    status: 'not_requested' | 'open_check' | 'partial' | 'ok'
    requested: boolean
    pagesAttempted: number
    maxPages: number
    rawTransactions: number
    rawLogEvents: number
    normalizedEvents: number
    walletSideEvents: number
    swapLikeTransactions: number
    pricedSwapCandidates: number | null
    matchedClosedLotsBefore: number | null
    matchedClosedLotsAfter: number | null
    addedClosedLots: number | null
    coverageLevel: 'none' | 'light' | 'medium' | 'deep'
    missing: string[]
    reason: string | null
  }
  walletHistoricalCandidateSummary: {
    status: 'not_requested' | 'open_check' | 'partial' | 'ok'
    requested: boolean
    baseEvidenceEvents: number
    historicalNormalizedEvents: number
    historicalWalletSideEvents: number
    existingSwapCandidates: number
    historicalSwapCandidates: number
    newSwapCandidateEvents: number
    duplicateSwapCandidateEvents: number
    candidateTransactions: number
    newCandidateTransactions: number
    candidateTokens: number
    newCandidateTokens: number
    earliestCandidateAt: string | null
    latestCandidateAt: string | null
    readyForHistoricalPricing: boolean
    readyForHistoricalFifoPreview: boolean
    missing: string[]
    reason: string | null
  }
  walletHistoricalPricingPreviewSummary: {
    status: 'not_requested' | 'open_check' | 'partial' | 'ok'
    requested: boolean
    newSwapCandidateEvents: number
    pricedHistoricalCandidates: number
    unpricedHistoricalCandidates: number
    stableLegPricedEvents: number
    wethLegPricedEvents: number
    historicalPricedEvents: number
    priceAttemptLimitReached: boolean
    readyForHistoricalFifoPreview: boolean
    missing: string[]
    reason: string | null
  }
  walletHistoricalFifoPreviewSummary: {
    status: 'not_requested' | 'open_check' | 'partial' | 'ok'
    requested: boolean
    baselineClosedLots: number
    previewClosedLots: number
    addedClosedLots: number
    baselineRealizedPnlUsd: number | null
    previewRealizedPnlUsd: number | null
    addedRealizedPnlUsd: number | null
    baselineRealizedPnlPercent: number | null
    previewRealizedPnlPercent: number | null
    winningClosedLotsPreview: number
    losingClosedLotsPreview: number
    breakEvenClosedLotsPreview: number
    uniqueTokensPreview: number
    previewConfidence: 'low' | 'medium' | 'high'
    readyForHistoricalTradeStatsPreview: boolean
    safeToPromoteToPublicStats: boolean
    missing: string[]
    reason: string | null
  }
  dataFreshness?: 'live' | 'cached' | 'partial'
  cacheAgeSeconds?: number | null
  walletScanCostMode?: 'basic' | 'basic_cached' | 'deep_cached' | 'deep_live' | 'historical_cached' | 'historical_live' | 'blocked_by_cooldown' | 'blocked_by_cost_guard'
  walletScanCacheNote?: string
  walletActivityCoverageNote?: string | null
  walletPnlOutlierNote?: string | null
  walletPricingCoverageNote?: string | null
  walletValueTier?: WalletValueTier
  walletHistoricalScanNote?: string | null
  walletFacts?: WalletFacts
  walletProfile?: WalletProfile
  walletProfileDebug?: {
    scoreInputs: {
      totalValueUsd: number
      holdingsCount: number
      chainCount: number
      concentrationLabel: string | null
      closedLots: number
      winRatePercent: number | null
      economicSignificance: string | null | undefined
      estimatedPnlStatus: string | null | undefined
      estimatedPnlConfidence: string | null | undefined
    }
    evidenceCoverage: number
    cacheSource: 'live' | 'memory_cache' | 'evidence_guard_restored'
    profileVersion: string
  }
  // PHASE6-FIX-2: wallet-level PnL confidence, aggregated from value-weighted lot confidence,
  // coverage percentages, unmatched sells, estimate-backfilled lots, and provider failures.
  // Additive — does not replace any existing per-lot/per-summary confidence field.
  pnlConfidenceScore?: number
  pnlConfidenceTier?: 'high' | 'medium' | 'low'
  // PHASE6-FIX-3: PnL completeness — fraction of tokens with full buy/sell history, value
  // coverage, and truncated-stream signals. isPnlPartial is a convenience boolean derived from
  // pnlCompletenessScore against a fixed threshold (see PHASE6_COMPLETENESS_PARTIAL_THRESHOLD).
  pnlCompletenessScore?: number
  isPnlPartial?: boolean
  // PHASE6-FIX-4: result of the final integrity-check pass over the assembled snapshot. Purely
  // additive diagnostics — violations only ever downgrade pnlConfidenceTier and append normalized
  // reason strings; they never mutate existing PnL numbers.
  pnlIntegrityCheck?: {
    ok: boolean
    violations: string[]
    // PHASE6-FIX-4: additive three-state status alongside the existing ok/violations fields —
    // 'invalid' for severe data-quality failures, 'suspicious' for elevated-risk-but-usable data.
    status?: 'ok' | 'suspicious' | 'invalid'
  }
  // PHASE6-FIX-5: heuristic-only (no ML) wallet behavioral signal bundle, derived strictly from
  // values already computed elsewhere in the snapshot (trade stats, lot summary, holdings).
  walletProfileHints?: {
    tradeFrequency: 'low' | 'medium' | 'high'
    avgHoldTimeBucket: 'short' | 'mid' | 'long'
    realizedWinRateBucket: 'low' | 'medium' | 'high'
    riskProfileHint: 'concentrated' | 'diversified' | 'dust-heavy'
  }
  // PHASE6-FIX-5b: separate, additive data-quality hint array (distinct concept from the object
  // above — does not change walletProfileHints' existing shape). Append-only at the call site.
  walletDataQualityHints?: string[]
  _debug?: {
    walletFactsShapeIssues?: string[]
    walletScannerDiagnostics?: {
      swapCandidates: number
      pricedEvents: number
      closedLots: number
      activityEvents: number
      flowReadBuilt: boolean
      classificationBuilt: boolean
      pnlStatus: string
      missingFields: string[]
    }
    [key: string]: unknown
  }
  _diagnostics?: {
    // SYNTH-RECOVERY-FIX-5: debug bundle for the synthetic-FIFO-lot-triggered targeted historical
    // recovery path. Purely additive/optional diagnostics — does not change any existing field.
    syntheticLotRecoveryDebug?: {
      syntheticLotsDetected: boolean
      syntheticLotTokenTargets: string[]
      historicalTriggeredBySyntheticLots: boolean
      syntheticLotsBeforeHistorical: number
      syntheticLotsAfterHistorical: number
      realPriorBuysRecoveredForSyntheticLots: number
      syntheticRecoverySkippedReason: string | null
      // SYNTH-RECOVERY-FIX-10: direct (non-swap-candidate-gated) target-token recovery debug.
      syntheticTargetHistoricalRawLogs: number
      syntheticTargetHistoricalNormalizedEvents: number
      syntheticTargetHistoricalWalletInboundEvents: number
      syntheticTargetHistoricalWalletOutboundEvents: number
      syntheticTargetPriorBuysFound: number
      syntheticTargetPriorBuysPriced: number
      syntheticTargetDropBreakdown: Record<string, number>
      sampleDroppedHistoricalLogs: Array<{ reason: string; count: number }>
      sampleSyntheticTargetPriorBuys: Array<{ txHash: string | null; contract: string; symbol: string; amount: number; timestamp: string | null }>
    }
    providers?: {
      zerion: { configured: boolean; attempted: boolean; succeeded: boolean }
      goldrush: {
        configured: boolean
        balancesAttempted: boolean
        transactionsAttempted: boolean
        transfersAttempted: boolean
        eventsReturned: number
        valuedEventsReturned: number
        pnlEventsUsable: number
        endpointKind?: string
        chainUsed?: string
        httpStatus?: number | null
        rawItemCount?: number
        normalizedEventCount?: number
        firstEventShapeKeys?: string[]
        transferArrayCount?: number
        reason: string
      }
      alchemy: { configured: boolean; behaviorAttempted: boolean; transfersReturned: number; reason: string }
      moralis?: {
        configured: boolean
        attempted: boolean
        usable: boolean
        holdingsReturned: number
        cacheHit: boolean
        reason: string
        httpStatus?: number | null
        chain?: string
      }
      cacheHit?: boolean
    }
    walletProviderFieldsPresent: {
      holdings: boolean
      totalValue: boolean
      txCount: boolean
      walletAgeDays: boolean
    }
    missingReasons: string[]
    goldrushTransferDiags?: GrTransferDiag[]
    snapshotCache?: {
      memoryHit: boolean
      persistentHit: boolean
      providerFetchNeeded: boolean
      refreshBypassedCache: boolean
      cacheAgeSeconds: number | null
      cacheTtlSeconds: number
      cacheVersion?: string
      cacheBypassReason?: 'refresh' | 'debugFresh' | null
      debugFreshBypassedPersistentCache?: boolean
    }
    moralis?: {
      configured: boolean
      attempted: boolean
      usable: boolean
      holdingsReturned: number
      cacheHit: boolean
      reason: string
      httpStatus?: number | null
    }
    providerFallback?: {
      primaryAttempted: boolean
      primaryUsable: boolean
      fallbackAttempted: boolean
      fallbackUsed: boolean
      tertiaryAttempted: boolean
      tertiaryUsed: boolean
      fallbackReason: string
      cacheHit: boolean
      reason: string
    }
    moralisUsage?: {
      attempted: boolean
      endpointNames: string[]
      requestedChain: MoralisChain
      callCount: number
      cacheHit: boolean
      deduped: boolean
      durationMs: number
      skippedReason: string | null
    }
    providerFlow?: {
      chainMode: 'auto' | 'base' | 'eth' | 'base_eth' | 'all_supported'
      minChainValueUsd: number
      supportedChains: MoralisChain[]
      discoveredChains: Array<{ chain: MoralisChain; usdValue: number }>
      activeChains: MoralisChain[]
      skippedDustChains: MoralisChain[]
      maxChainsBasicScan: number
      moralisChainsAttempted: MoralisChain[]
      moralisCallCount: number
      cacheHits: number
      dedupedCalls: number
      partialFailures: number
      goldrushAttempted: boolean
      goldrushSkippedReason: string | null
    }
    chainUsage?: {
      requestedChain: string
      chainMode: 'auto' | 'base' | 'eth' | 'base_eth' | 'all_supported'
      activeChains: MoralisChain[]
      alchemyChainsAttempted: string[]
      skippedChains: MoralisChain[]
      reason: string
    }
    walletProviderRouting?: {
      primaryProviders: string[]
      alchemyUsed: boolean
      alchemyMethods: string[]
      alchemyChainsUsed: string[]
      alchemyReason: string
      skippedAlchemyChains: string[]
      pageLoadTriggered: boolean
      zerionSucceeded: boolean
      goldrushBalancesSkipped: boolean
      deepScan: boolean
    }
    walletActivityRequestDebug?: {
      primaryActivityAttempted: boolean
      primaryActivityFailed: boolean
      primaryActivityStatusCode: number | null
      primaryActivityErrorKind: string | null
      fallbackActivityAttempted: boolean
      fallbackActivityUsed: boolean
      fallbackActivityReason: string
      finalEvidenceStatus: WalletSnapshot['walletEvidenceSummary']['status']
    }
    walletTxEvidenceDebug?: {
      sourceProvider: 'goldrush' | 'alchemy' | 'moralis_fallback' | 'none'
      totalRawEvents: number
      duplicateTransfersRemoved?: number
      eventsWithHash: number
      eventsWithTimestamp: number
      sampleHashes: string[]
      sampleTimestamps: string[]
      activityRequested?: boolean
      eventFetchAttempted?: boolean
      goldrushEthAttempted?: boolean
      goldrushBaseAttempted?: boolean
      alchemyAttempted?: boolean
      goldrushEthRawCount?: number
      goldrushBaseRawCount?: number
      alchemyRawCount?: number
      goldrushEthSkippedReason?: string | null
      ethValueUsd?: number
      ethActivityThresholdUsd?: number
      ethActivityEligible?: boolean
      ethActivitySkippedReason?: string | null
      normalizedPnlEventCount?: number
      totalEvidenceEvents?: number
      eventsWithTxHash?: number
      missingHashCount?: number
      missingTimestampCount?: number
      skippedReasons?: string[]
      providerErrorSamples?: string[]
      providerCoveragePartial?: boolean
    }
    walletSwapDetectionDebug?: {
      totalEvidenceEvents: number
      usableEventCount: number
      groupedTxCount: number
      txWithMultipleTokenMovements: number
      txWithInboundOutboundMovement: number
      txToKnownRouterCount: number
      walletInitiatedTxCount: number
      walletInitiatedSwapLikeTxCount: number
      knownRouterMatchCount: number
      stableOrWethLegMatchCount: number
      swapCandidateEvents: number
      routerSwapCandidateEvents: number
      walletInitiatedSwapCandidateEvents: number
      sameTxInboundOutboundCandidates: number
      highConfidenceSwapCandidates: number
      mediumConfidenceSwapCandidates: number
      lowConfidenceSwapCandidates: number
      transferEvents: number
      airdropCandidateEvents: number
      bridgeCandidateEvents: number
      unknownEvents: number
      readyForPriceAtTime: boolean
      directionCounts: { inbound: number; outbound: number; unknown: number }
      unknownReasonCounts: Record<string, number>
      eventsMissingTokenAddress: number
      eventsMissingTxHash: number
      eventsMissingTimestamp: number
      eventsMissingFromTo: number
      duplicateEventCount: number
      zeroAmountEventCount: number
      sampleSwapCandidates: WalletTxEvidence[]
      sampleUnknowns: WalletTxEvidence[]
      sampleRouterMatches: Array<{ txHash: string; protocol: string; walletIsInitiator: boolean; tokens: string[] }>
      sampleWalletInitiatedSwapLikeTxs: Array<{ txHash: string; inboundCount: number; outboundCount: number; tokens: string[]; hasStableOrWeth: boolean }>
      sampleGroupedTxs: Array<{ txHash: string; walletEventCount: number; totalEventCount: number; inboundCount: number; outboundCount: number; tokens: string[] }>
      reasons: string[]
      // TEMPORARY DEBUG (router-coverage / unknown-events audit) — breakdown of why events
      // landed in eventKind='unknown', debug-only, never exposed in production UI.
      unknownRouterEvents: number
      unknownDirectionEvents: number
      unknownCounterpartyEvents: number
      unknownPairingEvents: number
      unknownPricingEvents: number
      // Exhaustive per-event reason-bucket breakdown of unknownEvents (debug-only, counters
      // only — does not change classification, FIFO, or pricing behavior).
      unknownReasonBucketCounts: Record<UnknownReasonBucket, number>
      unknownReasonBucketBreakdown: Array<{ bucket: UnknownReasonBucket; count: number; distinctTxCount: number; distinctTokenCount: number }>
      topUnknownReasonByCount: { bucket: UnknownReasonBucket; count: number; distinctTxCount: number; distinctTokenCount: number } | null
      topUnknownReasonByTxCount: { bucket: UnknownReasonBucket; count: number; distinctTxCount: number; distinctTokenCount: number } | null
      topUnknownReasonByTokenCount: { bucket: UnknownReasonBucket; count: number; distinctTxCount: number; distinctTokenCount: number } | null
      // Direction Reconstruction V2 (debug-only counters, no behavior beyond what's gated by
      // swapDetection.isSwapCandidate — see buildSwapDetection).
      reconstructedUnknownDirectionEvents: number
      reconstructedWalletSideUnknownEvents: number
      unknownDirectionUsedAsContextOnly: number
      unknownDirectionPromotedToSwapCandidate: number
      unknownDirectionRejectedNoWalletSide: number
      unknownDirectionRejectedLowConfidence: number
      sampleReconstructedUnknownDirectionEvents: WalletTxEvidence[]
      sampleContextOnlyUnknownDirectionEvents: WalletTxEvidence[]
      // Unverified txTo addresses observed on unknown-direction events — never auto-labeled.
      unknownTxToAddressCounts: Record<string, number>
      topUnknownTxToAddresses: Array<{ address: string; count: number }>
      topUnknownTxToAddressesWithSwapLikeContext: Array<{ address: string; count: number }>
      walletSwapReconstructionAudit?: {
        unknownEventsSeen: number
        unknownEventsUsedForContext: number
        reconstructedCandidates: number
        reconstructedHighConfidence: number
        routerMatchedTransactions: number
        routerCoverageProtocols: string[]
      }
    }
    walletPriceAtTimeDebug?: {
      swapCandidateEvents: number
      priceAttempts: number
      pricedEvents: number
      openCheckEvents: number
      unavailableEvents: number
      stableLegPricedEvents: number
      wethLegPricedEvents: number
      historicalPricedEvents: number
      providerEventUsdAttempts: number
      providerEventUsdPricedEvents: number
      priceAttemptLimitReached: boolean
      skippedNoTimestamp: number
      skippedNoTokenAddress: number
      skippedNoAmount: number
      skippedNoStableOrWethLeg: number
      skippedNoQuoteLeg: number
      skippedProviderUsdMissing: number
      skippedProviderUsdInvalid: number
      skippedHistoricalUnavailable: number
      currentHoldingPriceAttempts: number
      currentHoldingPriceOpenLotEvents: number
      skippedCurrentPriceNotAllowedForRealized: number
      historicalPriceAttempts: number
      historicalPricePricedEvents: number
      cacheHits: number
      cacheMisses: number
      providerAttempts: number
      providerErrors: number
      samplePricedEvents: Array<{ txHash: string; contract: string; symbol: string; direction: string; amount: number; priceUsd: number | null; source: string; confidence: string; reason: string }>
      sampleOpenCheckEvents: Array<{ txHash: string; contract: string; symbol: string; reason: string }>
      sampleUnpricedReasons: Array<{
        txHash: string
        direction: string
        tokenSymbol: string
        tokenContract: string
        chain: string
        amount: number
        hasProviderUsdValue: boolean
        providerUsdValue: number | null
        valueUsdKnown: boolean
        hasCurrentHoldingPrice: boolean
        currentHoldingPrice: number | null
        isCurrentlyHeld: boolean
        hasStableLeg: boolean
        hasWethLeg: boolean
        historicalAttempted: boolean
        historicalPriceFound: boolean
        finalReason: string
      }>
      reasons: string[]
    }
    walletPriceBudgetDebug?: {
      baseBudget: number; expandedBudget: number; maxBudget: number
      initialCandidates: number; prioritizedCandidates: number
      pass1Attempts: number; pass1PricedEvents: number; pass1ClosedLots: number
      expansionEligible: boolean; expansionReason: string | null
      pass2Attempts: number; pass2PricedEvents: number
      finalPriceAttempts: number; finalPricedEvents: number; finalClosedLots: number
      budgetCapHit: boolean; skippedBecauseEnoughEvidence: boolean
      skippedBecauseDailyCap: boolean; estimatedExtraCredits: number
      samplePrioritizedCandidates: Array<{ symbol: string | null; priority: number; hasStableLeg: boolean; hasWethLeg: boolean; usdValue: number | null }>
    }
    unmatchedSellBackfillDebug?: UnmatchedSellBackfillDebug
    walletHistoricalScanDebug?: {
      requested: boolean; eligible: boolean; eligibilityReasons: string[]
      walletValueTier: WalletValueTier | null
      targetTokens: string[]
      targetTokenRankingReason?: Array<{ contract: string; symbol: string; reasons: string[]; estimatedUsd: number }>
      pagesAllowed: number; pagesAttempted: number
      rawEventsFetched: number; normalizedEvents: number
      priorBuysFound: number; priorSellsFound: number
      closedLotsBefore: number; closedLotsAfter: number
      openedLotsBefore: number; openedLotsAfter: number
      realizedPnlBefore: number | null; realizedPnlAfter: number | null
      addedClosedLots: number; addedOpenedLots: number
      estimatedCreditUnits: number; cacheHit: boolean; budgetCapHit: boolean
      stopReason: string | null; skippedReasons: string[]
      sampleTargets: Array<{ contract: string; symbol?: string; reason?: string; reasons?: string[]; estimatedUsd?: number }>
      sampleRecoveredEvents: Array<{ txHash?: string; symbol?: string; direction?: string; amount?: number; [key: string]: unknown }>
      [key: string]: unknown
    }
    walletLotEngineDebug?: {
      pricedSwapEvents: number
      buyEvents: number
      sellEvents: number
      openedLots: number
      closedLots: number
      partiallyClosedLots: number
      unmatchedBuys: number
      unmatchedSells: number
      skippedUnpricedEvents: number
      skippedUnknownSide: number
      skippedStableQuoteAssets: number
      skippedMissingFields: number
      uniqueBuyTokenKeys: number
      uniqueSellTokenKeys: number
      matchedTokenKeys: number
      unmatchedBuyTokenKeys: string[]
      unmatchedSellTokenKeys: string[]
      totalCostBasisClosedUsd: number | null
      totalProceedsClosedUsd: number | null
      realizedPnlUsd: number | null
      realizedPnlPercent: number | null
      sampleOpenLots: Array<{ tokenAddress: string; symbol: string; chain: string; openedAt: string; amountRemaining: number; entryPriceUsd: number; confidence: string }>
      sampleClosedLots: Array<{ tokenAddress: string; symbol: string; openedAt: string; closedAt: string; amountClosed: number; entryPriceUsd: number; exitPriceUsd: number; realizedPnlUsd: number; confidence: string }>
      sampleUnmatchedSells: Array<{ txHash: string; tokenAddress: string; symbol: string; amount: number; exitPriceUsd: number }>
      sampleBuyEvents: Array<{ tokenAddress: string; symbol: string; chain: string; amount: number; priceUsd: number }>
      sampleSellEvents: Array<{ tokenAddress: string; symbol: string; chain: string; amount: number; priceUsd: number }>
      sampleUnmatchedReasons: string[]
      reasons: string[]
    }
    walletPnlOutlierDebug?: {
      attempted: boolean
      closedLotsBefore: number
      closedLotsAfter: number
      quarantinedLots: number
      quarantineReasons: string[]
      sampleQuarantinedLots: Array<{ symbol: string; realizedPnlUsd: number; realizedPnlPercent: number | null; reason: string }>
      maxReturnSeen: number | null
      maxPnlSeen: number | null
      scoreBlockedByOutliers: boolean
      publicStatsBlockedByOutliers: boolean
    }
    walletTradeStatsDebug?: {
      closedLots: number
      uniqueTokensTraded: number
      winningClosedLots: number
      losingClosedLots: number
      breakEvenClosedLots: number
      winRateComputed: boolean
      winRateThreshold: number
      avgPnlUsdPerClosedLot: number | null
      avgReturnPercentPerClosedLot: number | null
      medianReturnPercentPerClosedLot: number | null
      avgHoldingTimeSeconds: number | null
      medianHoldingTimeSeconds: number | null
      largestWinUsd: number | null
      largestLossUsd: number | null
      confidence: string
      sampleSizeLabel: string
      sampleWinningLots: Array<{ tokenAddress: string; symbol: string; realizedPnlUsd: number; realizedPnlPercent: number | null; confidence: string }>
      sampleLosingLots: Array<{ tokenAddress: string; symbol: string; realizedPnlUsd: number; realizedPnlPercent: number | null; confidence: string }>
      reasons: string[]
      economicSignificance?: {
        meaningfulClosedLots: number
        dustClosedLots: number
        meaningfulCostBasisUsd: number
        dustCostBasisUsd: number
        avgCostBasisPerClosedLot: number | null
        economicallyMeaningful: boolean
        reason: string
      }
    }
    walletHistoricalCoverageDebug?: {
      requested: boolean
      providersAttempted: string[]
      pagesAttempted: number
      pageSize: number
      maxPages: number
      cursorUsed: boolean
      stoppedReason: string
      rawTransactions: number
      rawLogEvents: number
      decodedTransferLogs: number
      walletSideEvents: number
      candidateSwapTxs: number
      candidateSwapEvents: number
      duplicateTxHashes: number
      duplicateEvents: number
      oldestTimestamp: string | null
      newestTimestamp: string | null
      chainCoverage: Record<string, { pages: number; transactions: number; events: number }>
      providerErrorSamples: string[]
      skippedReasons: string[]
      sampleTxHashes: string[]
      sampleSwapLikeTransactions: unknown[]
      moralisHistoricalConfigured: boolean
      moralisHistoricalAttempted: boolean
      moralisReason: string
      // SYNTH-RECOVERY-FIX-6: granular drop-bucket breakdown for the raw-log-to-normalized-event
      // pipeline, additive/optional — explains why rawLogEvents collapses to a small normalizedEvents
      // count (e.g. target-contract filtering on a targeted synthetic-lot recovery pass).
      logNormalizationDebug?: {
        historicalRawLogsSeen: number
        historicalRawLogsDroppedNoTxHash: number
        historicalRawLogsDroppedNoTimestamp: number
        historicalRawLogsDroppedNoContract: number
        historicalRawLogsDroppedNoAmount: number
        historicalRawLogsDroppedNoWalletSide: number
        historicalRawLogsDroppedNonTargetToken: number
        historicalRawLogsDroppedDecodeFailed: number
        historicalRawLogsDroppedDuplicate: number
        historicalRawLogsNormalizedTransferEvents: number
        historicalRawLogsWalletSideTransferEvents: number
      }
    }
    walletHistoricalCandidateDebug?: {
      requested: boolean
      baseEvidenceEvents: number
      historicalNormalizedEvents: number
      historicalWalletSideEvents: number
      existingSwapCandidates: number
      historicalSwapCandidates: number
      newSwapCandidateEvents: number
      duplicateSwapCandidateEvents: number
      candidateTransactions: number
      newCandidateTransactions: number
      candidateTokens: number
      newCandidateTokens: number
      candidateTokenSymbols: string[]
      earliestCandidateAt: string | null
      latestCandidateAt: string | null
      sampleNewSwapCandidates: Array<{ txHash: string; contract: string; symbol: string; direction: string; timestamp: string | null; reason: string }>
      sampleDuplicateCandidates: Array<{ txHash: string; contract: string; symbol: string; direction: string }>
      skippedReasons: string[]
      reasons: string[]
    }
    walletHistoricalPricingPreviewDebug?: {
      requested: boolean
      newSwapCandidateEvents: number
      priceAttempts: number
      pricedHistoricalCandidates: number
      unpricedHistoricalCandidates: number
      stableLegPricedEvents: number
      wethLegPricedEvents: number
      historicalPricedEvents: number
      priceAttemptLimitReached: boolean
      samplePricedHistoricalCandidates: Array<{ txHash: string; contract: string; symbol: string; direction: string; priceUsd: number; source: string }>
      sampleUnpricedHistoricalCandidates: Array<{ txHash: string; contract: string; symbol: string; direction: string; reason: string }>
      skippedReasons: string[]
      reasons: string[]
    }
    walletHistoricalFifoPreviewDebug?: {
      requested: boolean
      baselinePricedEvents: number
      newPricedHistoricalEvents: number
      combinedPricedEvents: number
      baselineClosedLots: number
      previewClosedLots: number
      addedClosedLots: number
      baselineRealizedPnlUsd: number | null
      previewRealizedPnlUsd: number | null
      addedRealizedPnlUsd: number | null
      winningClosedLotsPreview: number
      losingClosedLotsPreview: number
      breakEvenClosedLotsPreview: number
      unmatchedBuysPreview: number
      unmatchedSellsPreview: number
      samplePreviewClosedLots: Array<{ tokenAddress: string; symbol: string; openedAt: string; closedAt: string; entryPriceUsd: number; exitPriceUsd: number; realizedPnlUsd: number; confidence: string }>
      sampleAddedClosedLots: Array<{ tokenAddress: string; symbol: string; openedAt: string; closedAt: string; entryPriceUsd: number; exitPriceUsd: number; realizedPnlUsd: number; confidence: string }>
      skippedReasons: string[]
      reasons: string[]
    }
    walletActivityFallbackDebug?: {
      primaryActivityAttempted: boolean
      primaryActivityFailed: boolean
      primaryActivityStatusCode: number | null
      primaryActivityErrorKind: string | null
      fallbackActivityAttempted: boolean
      fallbackActivityUsed: boolean
      fallbackActivityProvider: 'moralis' | null
      fallbackActivityStatusCode: number | null
      fallbackActivityRawCount: number
      fallbackActivityNormalizedEvents: number
      fallbackActivityReason: string
      finalEvidenceStatus: string
      fallbackNormalizationDebug: NormalizeMoralisDebug | null
      fallbackActivitySampleShape: { keys: string[]; sample: Record<string, unknown>[] } | null
      fallbackPagesAttempted: number
      fallbackPagesUsed: number
      fallbackCursorsSeen: number
      fallbackRawTotal: number
      fallbackNormalizedTotal: number
      fallbackDedupeRemoved: number
      fallbackPaginationReason: string
      fallbackPaginationStoppedReason: string
      fallbackClosedLotsAfterPage1: number
      fallbackClosedCostBasisAfterPage1: number | null
      fallbackRealizedPnlAfterPage1: number | null
      fallbackMeaningfulEvidenceReached: boolean
      fallbackMeaningfulEvidenceReason: string
    }
    walletBudgetDebug?: {
      eventsBefore: number
      eventsAfterDedup: number
      eventsAfterCap: number
      budgetCapped: boolean
      dedupRemoved: number
      capLimit: number
      // PHASE4-FIX-8/9 (items 3 & 6): additive capping-transparency + coverage reason fields.
      cappedCount?: number
      cappedProviders?: string[]
      reasons?: string[]
    }
    walletScanBudgetDebug?: Record<string, unknown>
    walletSwapEnrichmentDebug?: {
      skipped: boolean
      reason: string
      candidateTxCount: number
      receiptsFetched: number
      enrichedTxCount: number
      cacheHits: number
      errors: number
      enrichedTxHashes: string[]
    }
    ethSwapReconstructionDebug?: {
      attempted: boolean
      reason: string
      candidateTxCount: number
      walletInitiatedTxs: number
      txGroupsWithInboundToken: number
      knownRouterTxs: number
      receiptsFetched: number
      transactionsFetched?: number
      quoteLogsFound: number
      nativeEthValueMatches: number
      wethQuoteMatches: number
      usdcQuoteMatches: number
      usdtQuoteMatches: number
      daiQuoteMatches: number
      syntheticSwapEventsAdded: number
      pricedEventsBefore: number
      pricedEventsAfter: number
      swapCandidatesBefore: number
      swapCandidatesAfter: number
      closedLotsBefore: number
      closedLotsAfter: number
      sampleCandidateTxs: Array<{ txHash: string; inboundSymbols: string[]; txToKnownRouter: boolean; walletInitiated: boolean }>
      sampleQuoteMatches: Array<{ txHash: string; quoteSymbol: string; quoteType: string; amount: number }>
      sampleSyntheticEvents: Array<{ txHash: string; symbol: string; direction: string; source: string }>
      sampleStillUnmatched: Array<{ txHash: string; reason: string }>
      stopReason: string
      // Extended debug fields for ETH chain detection diagnosis
      ethEventsAvailable?: number
      candidateTxsChecked?: number
      wethUnknownLegsFound?: number
      inboundTokenLegsFound?: number
      syntheticEthSwapEventsAdded?: number
      pricedSyntheticEthEvents?: number
      openedLotsBefore?: number
      openedLotsAfter?: number
    }
    baseUnknownSwapReconstructionDebug?: {
      attempted: boolean
      reason: string
      triggerMatched: boolean
      evidenceEventsInputCount: number
      candidateTxsChecked: number
      candidateTxHashes: string[]
      includesProblemTx: boolean
      problemTxSeenInEvidence: boolean
      problemTxEventCount: number
      problemTxSymbols: string[]
      problemTxDirections: string[]
      problemTxChains: string[]
      mixedKnownUnknownTxs: number
      receiptsFetched: number
      decodedTransferLogs: number
      walletSideLegsFound: number
      quoteLegsFound: number
      tokenLegsFound: number
      wethLegsFound: number
      stableLegsFound: number
      syntheticSwapEventsAdded: number
      sampleTxs: Array<{ txHash: string; swapReason: string; walletInbound: number; walletOutbound: number; wethAnywhere: boolean; stableAnywhere: boolean; txFromIsWallet: boolean }>
      sampleSyntheticEvents: Array<{ txHash: string; symbol: string; direction: string }>
      skippedReasons: string[]
    }
    finalSummarySourceDebug?: {
      swapSummarySource: string
      priceSummarySource: string
      lotSummarySource: string
      tradeStatsSource: string
      reconstructedPricedEvents: number
      ethReconstructionApplied: boolean
      ethReconstructedSwapCandidates: number
      ethReconstructedPricedEvents: number
      finalPublicSwapCandidatesBefore: number
      finalPublicSwapCandidatesAfter: number
      finalPublicPricedEventsBefore: number
      finalPublicPricedEventsAfter: number
      finalOpenedLotsBefore: number
      finalOpenedLotsAfter: number
      finalClosedLotsBefore: number
      finalClosedLotsAfter: number
      finalPublicPricedEvents: number
      finalPublicSwapCandidates: number
      finalOpenedLots: number
      finalClosedLots: number
      summaryOverwriteApplied: boolean
      mismatchReason: string
    }
    baseUnknownSwapPricingDebug?: {
      attempted: boolean
      reconstructedEventsAvailable: boolean
      reconstructedSwapCandidatesInput: number
      staleSwapCandidatesBefore: number
      activeSwapCandidateSource: string
      finalSwapCandidateSymbols: string[]
      finalSwapCandidateTxHashes: string[]
      fireCandidatesFiltered: number
      quoteLegsAvailableForPricing: number
      pricedAfterReconstruction: number
      unpricedAfterReconstruction: number
      reasons: string[]
    }
    basePnlReconstructionDebug?: {
      attempted: boolean
      reason: string
      rpcSource?: 'alchemy' | 'public_base_rpc' | 'none'
      rpcConfigured?: boolean
      candidateTxCount: number
      receiptsFetched: number
      receiptCacheHits: number
      decodedTransferLogs: number
      walletInboundLegs: number
      walletOutboundLegs: number
      nativeEthPaymentMatches: number
      stablecoinMatches: number
      wethMatches: number
      routerMatches: number
      enrichedSwapEvents: number
      pricedEnrichedEvents: number
      closedLotsBefore: number
      closedLotsAfter: number
      realizedPnlBefore: number | null
      realizedPnlAfter: number | null
      skippedNoPaymentLeg: number
      skippedNoInboundToken: number
      skippedNoPriceEvidence: number
      skippedBudgetCap: number
      providerErrors: number
      sampleMatches: Array<{ txHash: string; direction: string; symbol: string; paymentType: string }>
      transactionsFetched?: number
      inboundTokenMatches?: number
      outboundTokenMatches?: number
      sampleUnpricedAfterReceipt?: Array<{ txHash: string; symbol: string; finalReason: string }>
    }
    baseFifoCoverageDebug?: {
      attempted: boolean
      reason: string
      extraPagesAttempted: number
      extraEventsFetched: number
      extraEventsNormalized: number
      candidateTxsQueued: number
      receiptsFetched: number
      transactionsFetched: number
      receiptCacheHits: number
      quoteLegsFound: number
      nativeEthQuoteLegs: number
      usdcQuoteLegs: number
      wethQuoteLegs: number
      syntheticSwapEventsAdded: number
      pricedEventsBefore: number
      pricedEventsAfter: number
      closedLotsBefore: number
      closedLotsAfter: number
      openedLotsAfter: number
      unmatchedBuysAfter: number
      unmatchedSellsAfter: number
      stopReason: string
      sampleTxsChecked: Array<{ txHash: string; symbol: string; direction: string }>
      sampleQuoteLegs: Array<{ txHash: string; symbol: string; quoteType: string }>
      sampleStillUnpriced: Array<{ txHash: string; symbol: string; finalReason: string }>
      sampleNoMatchReasons: string[]
      fallbackActivityUsed: boolean
      fallbackActivityEvents: number
      allowedBecauseFallbackHadEvents: boolean
      skippedReason: string | null
    }
    walletActivityRoutingDebug?: {
      deepActivityRequested: boolean
      chainMode: string
      requestedChain: string
      discoveredChains: Array<{ chain: string; usdValue: number }>
      activeChainsBeforeValueGate: string[]
      activeChainsAfterValueGate: string[]
      activeChainsUsedForActivity: string[]
      chainsDiscoveredNotScannedForActivity: string[]
      chainsExcludedByCap: string[]
      chainsExcludedByUnsupported: string[]
      chainsExcludedByProviderSafety: string[]
      minChainValueUsd: number
      skippedDustChains: string[]
      portfolioStatus: string
      holdingsCount: number
      totalValue: number
      activityAttempted: boolean
      activitySkippedReason: string | null
      ethActivityEligible: boolean
      ethActivitySkippedReason: string | null
      ethValueUsd: number
      ethActivityThresholdUsd: number
      lowBalanceOverrideUsed: boolean
      fallbackChainsUsed: string[]
      providerCallsPlanned: string[]
      providerCallsMade: string[]
      evidenceEvents: number
      finalEvidenceStatus: string
    }
    walletChainActivityMergeDebug?: {
      chainMode: string
      requestedChain: string
      portfolioValueByChain: { eth: number; base: number }
      activeChainsUsedForActivity: string[]
      ethActivityAttempted: boolean
      ethActivityEvents: number
      baseActivityAttempted: boolean
      baseActivityEvents: number
      mergedEventsBeforeCap: number
      mergedEventsAfterCap: number
      selectedPrimaryChain: string
      reasonPrimaryChainSelected: string
      baseOnlyActivityWouldBeMisleading: boolean
      ethSkippedReason: string | null
      baseSkippedReason: string | null
      sampleEthEvents: Array<{ txHash: string | null; symbol: string; direction: string; chain: string }>
      sampleBaseEvents: Array<{ txHash: string | null; symbol: string; direction: string; chain: string }>
      sampleMergedEvents: Array<{ txHash: string | null; symbol: string; direction: string; chain: string }>
    }
    walletEthNormalizationDebug?: {
      attempted: boolean
      rawCount: number
      normalizedCount: number
      transfersPath: boolean
      logEventsPath: boolean
      logEventCount: number
      logEventNormalizedCount: number
      skippedCounts: { zeroAmount: number; nonContractAddress: number; unknownDirection: number }
      rawShapeKeys: string[]
      sampleRawEvents: Array<Record<string, unknown>>
      sampleNormalizedEvents: Array<{ txHash: string | null; symbol: string; direction: string; contract: string; amount: number; chain: string }>
      sampleSkippedReasons: string[]
      goldrushEthSkippedReason?: string | null
      ethValueUsd?: number
      ethActivityThresholdUsd?: number
      ethActivityEligible?: boolean
      ethActivitySkippedReason?: string | null
    }
    walletFactsDebug?: {
      built: boolean
      eventCount: number
      groupedTxCount: number
      latestEventsCount: number
      receivedTokenCount: number
      sentTokenCount: number
      topCounterpartyCount: number
      classificationCounts: { swapLike: number; transferOnly: number; claimOrAirdrop: number; bridge: number; unknown: number }
      missingFields: string[]
      reason: string
    }
    apiAudit?: {
      moralis: { calls: number; endpoints: string[]; credits: number }
      goldrush: { calls: number; endpoints: string[]; credits: number }
      alchemy: { calls: number; endpoints: string[]; credits: number }
      duplicates: string[]
      warnings: string[]
      totalCredits: number
    }
    alchemyEnvDebug?: {
      checkedNames: string[]
      configuredNames: string[]
      baseKeyConfigured: boolean
      ethKeyConfigured: boolean
      selectedBaseKeyName: string | null
      selectedEthKeyName: string | null
      reason: string
    }
    tradeStatsInputDebug?: {
      closedLotsInputCount: number
      walletLotSummaryClosedLots: number
      source: string
      computedAfterSupplementalBackfill: boolean
      mismatchFixed: boolean
    }
    walletPerformanceDebug?: {
      totalDurationMs: number
      phaseDurations: Record<string, number>
      providerDurations: Record<string, number>
      parallelizedCalls: string[]
      reusedCachedActivity: boolean
      duplicateCallsAvoided: number
      timedOutModules: string[]
      modulesSkippedBecauseNotNeeded: string[]
      deepBudgetHit: boolean
      bottleneck: string | null
    }
  }
}

// Race a promise against a deadline; resolves with fallback if deadline fires first.
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const ZERION_KEY       = process.env.ZERION_KEY ?? ''

// ── Alchemy key resolution ────────────────────────────────────────────────────────────────────
// Support multiple env var names in priority order (server-only first, NEXT_PUBLIC last).
// Never log key values — only names and booleans.
const _ALCHEMY_ETH_NAMES = ['ALCHEMY_ETHEREUM_KEY', 'ALCHEMY_ETH_KEY', 'ALCHEMY_ETH_API_KEY', 'ALCHEMY_API_KEY']
const _ALCHEMY_BASE_NAMES = ['ALCHEMY_BASE_KEY', 'ALCHEMY_BASE_API_KEY', 'BASE_ALCHEMY_API_KEY', 'ALCHEMY_API_KEY', 'NEXT_PUBLIC_ALCHEMY_BASE_KEY']

function _resolveAlchemyKey(names: string[]): { key: string; name: string | null } {
  for (const name of names) {
    const val = process.env[name]
    if (val && val.trim().length > 0) return { key: val.trim(), name }
  }
  return { key: '', name: null }
}

const _ethKeyResolution  = _resolveAlchemyKey(_ALCHEMY_ETH_NAMES)
const _baseKeyResolution = _resolveAlchemyKey(_ALCHEMY_BASE_NAMES)
const ALCHEMY_ETH_KEY    = _ethKeyResolution.key
const ALCHEMY_BASE_KEY   = _baseKeyResolution.key

const _alchemyEnvDebug = {
  checkedNames: [..._ALCHEMY_ETH_NAMES, ..._ALCHEMY_BASE_NAMES],
  configuredNames: [
    ..._ALCHEMY_ETH_NAMES.filter(n => Boolean(process.env[n]?.trim())),
    ..._ALCHEMY_BASE_NAMES.filter(n => Boolean(process.env[n]?.trim())),
  ],
  baseKeyConfigured: Boolean(ALCHEMY_BASE_KEY),
  ethKeyConfigured: Boolean(ALCHEMY_ETH_KEY),
  selectedBaseKeyName: _baseKeyResolution.name,
  selectedEthKeyName: _ethKeyResolution.name,
  reason: !ALCHEMY_BASE_KEY && !ALCHEMY_ETH_KEY
    ? 'no_alchemy_key_found_in_any_checked_name'
    : !ALCHEMY_BASE_KEY
    ? 'base_key_not_found'
    : 'ok',
}

const PUBLIC_BASE_RPC  = 'https://mainnet.base.org'  // fallback for receipt-only calls when Alchemy is not configured
const GOLDRUSH_KEY     = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY ?? ''

const EXTENDED_DEX_ROUTERS = new Set<string>([
  // Uniswap
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
  '0xe592427a0aece92de3edee1f18e0157c05861564',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
  '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad',
  // 1inch
  '0x1111111254fb6c44bac0bed2854e76f90643097d',
  '0x1111111254eeb25477b68fb85ed929f73a960582',
  '0x111111125421ca6dc452d289314280a0f8842a65',
  // 0x Protocol
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
  '0x55dc0e69ec00debcebdc25fe6f7cad62e63c8f81',
  // Paraswap
  '0x216b4b4ba9f3e719726886d34a177484278bfcae',
  '0xdef171fe48cf0115b1d80b88dc8eab59176fee57',
  // SushiSwap
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f',
  '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506',
  // Aerodrome (Base)
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
  '0x6cb442acf35158d68425b2a89f7e7b02fb5e42d5',
  '0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5',
  // AlienBase (Base)
  '0x8c1a3cf8f83074169fe5d7ad50b978e1cd6b37c7',
  '0xb20c411fc84fbb27e78608c24d0056d974ea9411',
  // Virtuals Protocol (Base)
  '0xf8dd39c71a278fe9f4377d009d7627ef140f809e',
  // Balancer
  '0xba12222222228d8ba445958a75a0704d566bf2c8',
  // Curve
  '0x99a58482bd75cbab83b27ec03ca68ff489b5788f',
  '0xf0d4c12a5768d806021f80a262b4d39d26c58b8d',
  // BaseSwap
  '0x327df1e6de05895d2ab08513aadd9313fe505d86',
  // PHASE1-FIX-3: Permit2 — canonical singleton deployed at the same address on Ethereum,
  // Base, and most other EVM chains. Aggregators (1inch, Uniswap Universal Router, Odos,
  // etc.) route the approval/transfer leg through this contract, so its presence on a tx's
  // `to` is a strong router signal even though Permit2 itself isn't a DEX.
  '0x000000000022d473030f116ddee9f6b43ac78ba9',
  // PHASE1-FIX-3: LI.FI Diamond — canonical cross-chain aggregator proxy, same address on
  // Base as on Ethereum/most EVM chains.
  '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae',
  // NOTE: Odos, Bebop, and CoW Protocol router/settlement addresses are intentionally
  // omitted — this file's policy (see docs/audit-router-swap-candidates-0xe896.md) is to
  // never add a router address without independent on-chain verification. Add them here
  // once their Base-deployed addresses are confirmed; until then they fall back to the
  // inbound/outbound heuristics in buildSwapDetection() below.
])

const FIFO_QUOTE_ASSETS = new Set<string>([
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC ETH
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT ETH
  '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI ETH
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH ETH
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC Base
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI Base
  '0x4200000000000000000000000000000000000006', // WETH Base
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC Base
])

const CREDIT_TABLE: Record<string, number> = {
  'moralis:erc20_holdings': 1,
  'moralis:erc20_transfers': 1,
  'goldrush:balances_v2': 1,
  'goldrush:transactions_v3': 1,
  'goldrush:log_events_by_address': 1,
  'goldrush:historical_by_addresses_v2': 1,
  'alchemy:alchemy_getAssetTransfers': 0,
  'alchemy:eth_getTransactionCount': 0,
  'alchemy:eth_getTransactionReceipt': 0,
  'alchemy:eth_getTransactionByHash': 0,
  'alchemy:getFirstTx': 0,
  'alchemy:behavior_getAssetTransfers': 0,
}

type _ApiCallEntry = {
  provider: 'moralis' | 'goldrush' | 'alchemy'
  endpoint: string
  credits: number
  cacheHit: boolean
  duplicate: boolean
  dupKey: string
}

export type WalletSnapshotOptions = {
  refresh?: boolean
  chain?: 'eth' | 'base'
  deepScan?: boolean
  deepActivity?: boolean
  chainMode?: 'auto' | 'base' | 'eth' | 'base_eth' | 'all_supported'
  historicalCoverage?: boolean
  maxHistoricalPages?: number
  walletScanBudget?: {
    scanMode: string
    requestedHistoricalScan: boolean
    walletValueTier?: 'micro' | 'small' | 'standard' | 'high_value' | 'whale'
    totalCreditTarget: number
    totalCreditHardCap: number
    creditsUsed?: number
    budgetByPhase?: { portfolio: number; activity: number; pricing: number; historicalRecovery: number }
    adminOverrideUsed?: boolean
  }
  maxFallbackPages?: number
  debug?: boolean
  maxDebugTokens?: number
  historicalScan?: boolean
}

const SNAPSHOT_TTL_MS         = 5  * 60 * 1000
const SNAPSHOT_HISTORY_TTL_MS = 15 * 60 * 1000
const SNAPSHOT_SCHEMA_VERSION = 'v44'
type SnapshotCacheEntry = { snapshot: WalletSnapshot; cachedAt: number; ttlMs: number }
const snapshotMemCache = new Map<string, SnapshotCacheEntry>()

// Evidence-regression guard: keyed by address only (independent of the holdings/activity cache
// split above), so a normal scan can never silently overwrite the strongest trade/PnL evidence a
// prior deep/historical scan already verified for this wallet. Without this, a scan that hits a
// provider timeout or skips a fetch (fewer closed lots, downgraded confidence) would otherwise be
// scored as if that weaker result were the wallet's ground truth, producing score/grade drift
// across consecutive scans of an unchanged wallet. TTL is generous (matches the historical TTL)
// since verified trade evidence does not go stale as quickly as live holdings/prices.
const VERIFIED_EVIDENCE_TTL_MS = 60 * 60 * 1000
type VerifiedEvidenceEntry = {
  cachedAt: number
  closedLots: number
  estimatedPnlStatus: string | undefined
  walletLotSummary: WalletSnapshot['walletLotSummary']
  walletTradeStatsSummary: WalletSnapshot['walletTradeStatsSummary']
  estimatedPnl: WalletSnapshot['estimatedPnl']
  walletHistoricalCoverageSummary: WalletSnapshot['walletHistoricalCoverageSummary']
}
const verifiedEvidenceCache = new Map<string, VerifiedEvidenceEntry>()

const HISTORICAL_COVERAGE_TTL_MS = 24 * 60 * 60 * 1000
type WalletHistoricalCoverageOutput = {
  summary: WalletSnapshot['walletHistoricalCoverageSummary']
  debug: NonNullable<WalletSnapshot['_diagnostics']>['walletHistoricalCoverageDebug']
  events: PnlEvent[]
}

type UnmatchedSellBackfillReason =
  | 'not_eligible'
  | 'prior_buy_not_found_for_sold_token'
  | 'prior_buy_found_but_unpriced'
  | 'prior_buy_outside_checked_window'
  | 'provider_history_depth_insufficient'
  | 'token_contract_filter_unavailable'
  | 'base_provider_unavailable'
  | 'base_contract_filter_unavailable'
  | 'cost_budget_reached'
  | 'backfill_not_started_timeout'
  | 'backfill_budget_blocked'
  | 'backfill_provider_unavailable'
  | 'backfill_partial_timeout'
  | 'sell_before_first_indexed_buy'
  | 'prior_buy_found'

type UnmatchedSellBackfillTarget = {
  chain: string
  tokenContract: string
  symbol: string | null
  sellTxHash: string | null
  sellTimestamp: string | null
  sellAmount: number
  exitPriceUsd: number | null
  _metadataMissing?: boolean
}

type UnmatchedSellBackfillPerTargetResult = {
  chain: string
  tokenContract: string
  symbol: string | null
  attempted: boolean
  pagesAttempted: number
  rawEventsFetched: number
  normalizedEvents: number
  priorBuysFound: number
  priorBuysPriced: number
  eventsAddedToFifo: number
  reason: UnmatchedSellBackfillReason | string
}

type UnmatchedSellBackfillDebug = {
  attempted: boolean
  reason: UnmatchedSellBackfillReason | string
  unmatchedSellCount: number
  targetTokens: Array<{ chain: string; tokenContract: string; symbol: string | null }>
  inputSourceDebug?: {
    fifoUnmatchedSellKeysAvailable: string[]
    fifoSampleUnmatchedSellsAvailable: Array<{ txHash: string; tokenAddress: string; symbol: string }>
    keysPassedToTargetBuilder: string[]
    sampleSellsPassedToTargetBuilder: Array<{ txHash: string; tokenAddress: string; symbol: string }>
    sourceUsed: string
  }
  targetExtractionDebug?: {
    unmatchedSellKeysInput: string[]
    sampleUnmatchedSellsInput: Array<{ txHash: string; tokenAddress: string; symbol: string }>
    targetsFromSamples: string[]
    targetsFromKeys: string[]
    droppedTargets: string[]
    finalTargets: string[]
  }
  pagesAttempted: number
  rawEventsFetched: number
  normalizedEvents: number
  priorBuysFound: number
  priorBuysPriced: number
  eventsAddedToFifo: number
  closedLotsBefore: number
  closedLotsAfter: number
  realizedPnlBefore: number | null
  realizedPnlAfter: number | null
  stopReason: UnmatchedSellBackfillReason | string
  perTargetResults: UnmatchedSellBackfillPerTargetResult[]
  sampleTargets: UnmatchedSellBackfillTarget[]
  samplePriorBuys: Array<{ chain: string; tokenContract: string; symbol: string | null; txHash: string; timestamp: string; amount: number; priceUsd: number | null }>
  sampleStillUnmatched: string[]
  sampleSkippedReasons: Array<{ reason: string; chain?: string; tokenContract?: string; page?: number }>
}

type UnmatchedSellBackfillOutput = {
  events: PnlEvent[]
  targetBuyKeys: Set<string>
  debug: UnmatchedSellBackfillDebug
}

const UNMATCHED_SELL_BACKFILL_TTL_MS = 10 * 60 * 1000
const unmatchedSellBackfillCache = new Map<string, { data: { events: PnlEvent[]; targetBuyKeys: string[]; debug: UnmatchedSellBackfillDebug }; cachedAt: number }>()
const historicalCoverageCache = new Map<string, { data: WalletHistoricalCoverageOutput; cachedAt: number }>()
const historicalCoverageInFlight = new Map<string, Promise<WalletHistoricalCoverageOutput>>()

type WalletValueTier = 'micro' | 'small' | 'standard' | 'high_value' | 'whale'

function computeWalletValueTier(totalValue: number | null | undefined): WalletValueTier {
  const v = totalValue ?? 0
  if (v >= 1_000_000) return 'whale'
  if (v >= 2500) return 'high_value'
  if (v >= 500) return 'standard'
  if (v >= 100) return 'small'
  return 'micro'
}

const TIER_PRICE_BUDGET: Record<WalletValueTier, number> = {
  // Micro-wallets were capped at 4 attempts, but a single WETH-leg lookup that was already
  // cached (e.g. shared by a buy+sell pair in the same tx) used to silently burn one of
  // those 4 slots anyway (see isGoldrushPriceCached fix above). Now that cached lookups are
  // free, a small bump from 4 to 6 lets a typical micro-wallet price both legs of 2-3 swaps
  // instead of starving after the first one.
  micro: 6,
  small: 8,
  standard: 10,
  high_value: 12,
  whale: 12,
}

const KNOWN_STABLE_WETH_CONTRACTS: Record<string, string> = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH_ETH',
  '0x4200000000000000000000000000000000000006': 'WETH_BASE',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC_ETH',
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC_BASE',
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT_ETH',
  '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI_ETH',
}

const KNOWN_DEX_ROUTERS: Record<string, string> = {
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'UniswapV2Router',
  '0xe592427a0aece92de3edee1f18e0157c05861564': 'UniswapV3Router',
  '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b': 'UniswapUniversalRouter_ETH',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'UniswapUniversalRouter_ETH_CommandRouter',
  '0x198ef79f1f515f02dfe9e3115ed9fc07183f02fc': 'UniswapUniversalRouter_Base',
  '0x1111111254eeb25477b68fb85ed929f73a960582': 'OneInchRouter',
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff': 'ZeroExExchangeProxy',
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43': 'Aerodrome',
  // Previously only present in EXTENDED_DEX_ROUTERS (used by ETH-side reconstruction) and
  // therefore invisible to the Base wallet-side swap classifier below, which only ever
  // consulted this map directly (router-coverage audit).
  '0x6cb442acf35158d68425b2a89f7e7b02fb5e42d5': 'AerodromeSecondary',
  '0x327df1e6de05895d2ab08513aadd9313fe505d86': 'BaseSwap',
  '0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5': 'AerodromeSlipstream',
  '0x8c1a3cf8f83074169fe5d7ad50b978e1cd6b37c7': 'AlienBaseRouter',
  '0xb20c411fc84fbb27e78608c24d0056d974ea9411': 'AlienBaseV3SmartRouter',
  '0xf8dd39c71a278fe9f4377d009d7627ef140f809e': 'VirtualsProtocolSellOrderExecutor',
}

const SWAP_ENRICHMENT_TTL_MS = 45 * 60 * 1000
const swapEnrichmentReceiptCache = new Map<string, { data: { isSwap: boolean; reason: string }; exp: number }>()

const TARGETED_HISTORICAL_SCAN_TTL_MS = 24 * 60 * 60 * 1000  // 24h cache
const TARGETED_HISTORICAL_SCAN_VERSION = 'v1'
type TargetedHistoricalScanCache = {
  events: PnlEvent[]
  debug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletHistoricalScanDebug']>
  cachedAt: number
}
const targetedHistoricalScanCache = new Map<string, TargetedHistoricalScanCache>()

// Per-tier limits for targeted historical scan
const TIER_HISTORICAL_PAGES: Record<WalletValueTier, number> = { micro: 0, small: 1, standard: 2, high_value: 3, whale: 5 }
const TIER_HISTORICAL_MAX_TOKENS: Record<WalletValueTier, number> = { micro: 0, small: 2, standard: 3, high_value: 5, whale: 5 }

const BASE_PNL_RECON_TTL_MS = 50 * 60 * 1000

type BasePnlReceiptDecode = {
  txFrom: string | null
  txTo: string | null
  walletInbound: Array<{ contract: string; amountHex: string }>
  walletOutbound: Array<{ contract: string; amountHex: string }>
  allTransferContracts?: string[]
  isKnownRouter: boolean
  routerProtocol: string | null
  hasStableLeg: boolean
  hasWethLeg: boolean
  totalTransferLogs: number
  decodeStatus: 'ok' | 'no_receipt' | 'error'
  reason: string
}

const basePnlReceiptCache = new Map<string, { data: BasePnlReceiptDecode; exp: number }>()
const basePnlTxCache = new Map<string, { value: string; exp: number }>()

const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const STABLE_USD_CONTRACTS: Record<string, true> = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': true,  // USDC ETH
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': true,  // USDC Base
  '0xdac17f958d2ee523a2206206994597c13d831ec7': true,  // USDT ETH
  '0x6b175474e89094c44da98b954eedeac495271d0f': true,  // DAI ETH
  // BSC stablecoins (18 decimals on BSC)
  '0x55d398326f99059ff775485246999027b3197955': true,  // USDT BSC
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': true,  // USDC BSC
  '0xe9e7cea3dedca5984780bafc599bd69add087d56': true,  // BUSD BSC
  '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3': true,  // DAI BSC
  // PHASE2-FIX-3: these two were already verified canonical addresses elsewhere in this file
  // (FIFO_QUOTE_ASSETS) but missing from STABLE_USD_CONTRACTS, so quote-leg selection and
  // swap classification didn't treat them as stable — a real stablecoin misclassification gap.
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': true,  // USDbC Base (Coinbase-bridged USDC)
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': true,  // DAI Base
  // NOTE: USDC.e, axlUSDC, crvUSD, and GHO are intentionally omitted — same policy as
  // EXTENDED_DEX_ROUTERS (see docs/audit-router-swap-candidates-0xe896.md): never add a
  // token address to a pricing-critical set without independent on-chain verification of the
  // exact deployed address for the chains this file actually scans (Ethereum, Base, BSC).
  // Add them once verified; until then they fall back to historical/provider-derived pricing.
}

// PHASE2-FIX-4: this set is the canonical "wrappedNative" classification — every chain's
// wrapped-native token (WETH, WBNB, ...) is treated identically by every consumer (quote-leg
// selection, swap detection, FIFO_QUOTE_ASSETS) and always resolves to that chain's native
// price via the weth_leg pricing path below, regardless of symbol. WAVAX/WMATIC are
// intentionally omitted: Avalanche/Polygon aren't scanned anywhere else in this file
// (no normalizeChainForGoldrush entry, no FIFO_QUOTE_ASSETS coverage), so adding their
// addresses here would be dead, unverifiable-in-context data — add them together with full
// chain support if/when this file starts scanning those chains.
const WETH_CONTRACTS_PRICE: Record<string, true> = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': true,  // WETH ETH
  '0x4200000000000000000000000000000000000006': true,  // WETH Base
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': true,  // WBNB BSC
}

const STABLE_DECIMALS: Record<string, number> = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6,   // USDC ETH
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6,   // USDC Base
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 6,   // USDT ETH
  '0x6b175474e89094c44da98b954eedeac495271d0f': 18,  // DAI ETH
  '0x55d398326f99059ff775485246999027b3197955': 18,  // USDT BSC
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 18,  // USDC BSC
  '0xe9e7cea3dedca5984780bafc599bd69add087d56': 18,  // BUSD BSC
  '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3': 18,  // DAI BSC
  // PHASE2-FIX-3: keep in sync with the STABLE_USD_CONTRACTS additions above.
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 6,   // USDbC Base
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 18,  // DAI Base
}

const STABLE_SYMBOL: Record<string, string> = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
  '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
  '0x55d398326f99059ff775485246999027b3197955': 'USDT',
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC',
  '0xe9e7cea3dedca5984780bafc599bd69add087d56': 'BUSD',
  '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3': 'DAI',
  // PHASE2-FIX-3: keep in sync with the STABLE_USD_CONTRACTS additions above.
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USDbC',
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI',
}

const ETH_WETH_CONTRACT = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const ETH_QUOTE_ASSETS: Record<string, { symbol: 'WETH' | 'USDC' | 'USDT' | 'DAI'; decimals: number }> = {
  [ETH_WETH_CONTRACT]: { symbol: 'WETH', decimals: 18 },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 },
}

type EthRouterQuoteLog = {
  contract: string
  symbol: 'WETH' | 'USDC' | 'USDT' | 'DAI'
  amountHex: string
  amount: number
  from: string | null
  to: string | null
  walletSide: boolean
}

type EthRouterReceiptDecode = {
  txFrom: string | null
  txTo: string | null
  isKnownRouter: boolean
  routerProtocol: string | null
  quoteLogs: EthRouterQuoteLog[]
  totalTransferLogs: number
  decodeStatus: 'ok' | 'no_receipt' | 'error'
  reason: string
}

const ethRouterReceiptCache = new Map<string, { data: EthRouterReceiptDecode; exp: number }>()
const ethRouterTxValueCache = new Map<string, { value: string; exp: number }>()

function hexAmountToDecimal(amountHex: string, decimals: number): number {
  try {
    const hex = (amountHex ?? '').replace(/^0x/i, '').replace(/^0+/, '') || '0'
    if (hex === '0') return 0
    // Convert hex to decimal digit array via string arithmetic (no BigInt needed)
    const digits: number[] = [0]
    for (let i = 0; i < hex.length; i++) {
      const h = parseInt(hex[i], 16)
      if (isNaN(h)) return 0
      let carry = h
      for (let j = digits.length - 1; j >= 0; j--) {
        const v = digits[j] * 16 + carry
        digits[j] = v % 10
        carry = Math.floor(v / 10)
      }
      while (carry > 0) { digits.unshift(carry % 10); carry = Math.floor(carry / 10) }
    }
    const decLen = digits.length
    if (decimals >= decLen) {
      return parseFloat('0.' + Array(decimals - decLen).fill(0).concat(digits).join('')) || 0
    }
    return parseFloat(digits.slice(0, decLen - decimals).join('') + '.' + digits.slice(decLen - decimals).join('')) || 0
  } catch { return 0 }
}

const PRICE_AT_TIME_TTL_MS = 60 * 60 * 1000
const priceAtTimeMemCache = new Map<string, { exp: number; priceUsd: number | null }>()

function parseRawAmount(amountRaw: string | null, decimals: number | null): number | null {
  if (!amountRaw || decimals === null || decimals < 0) return null
  try {
    return parseFloat(amountRaw) / Math.pow(10, decimals)
  } catch { return null }
}

function zerionAuth(): string | null {
  if (!ZERION_KEY) return null
  return `Basic ${Buffer.from(`${ZERION_KEY}:`).toString('base64')}`
}

async function zerionGet(path: string, params: Record<string, string> = {}) {
  const auth = zerionAuth()
  if (!auth) throw new Error('Zerion key not configured')
  const url = new URL(`https://api.zerion.io/v1/${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json', Authorization: auth },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Zerion ${res.status} ${path}`)
  return res.json()
}

async function alchemyRpc(url: string, method: string, params: unknown[]) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
    cache: 'no-store',
    signal: AbortSignal.timeout(8_000),
  })
  const json = await res.json()
  return json.result ?? null
}

// Shared cross-pass receipt cache — same chain+txHash receipt is fetched at most once per scan/cache window,
// preventing duplicate eth_getTransactionReceipt calls across reconstruction passes.
const SHARED_RECEIPT_CACHE_TTL_MS = 15 * 60 * 1000
const sharedReceiptCache = new Map<string, { data: any; exp: number }>()
const sharedReceiptInFlight = new Map<string, Promise<any>>()
const sharedReceiptCacheCounters = {
  sharedReceiptCacheHits: 0,
  sharedReceiptCacheMisses: 0,
  sharedReceiptCallsSavedByCache: 0,
  sharedReceiptCallsSavedByDedupe: 0,
}

function sharedReceiptCacheKey(rpcUrl: string, txHash: string): string {
  return `${rpcUrl.slice(-12)}:${txHash.toLowerCase()}`
}

async function getSharedTxReceipt(rpcUrl: string, txHash: string): Promise<any> {
  const key = sharedReceiptCacheKey(rpcUrl, txHash)
  const now = Date.now()
  const cached = sharedReceiptCache.get(key)
  if (cached && cached.exp > now) {
    sharedReceiptCacheCounters.sharedReceiptCacheHits++
    sharedReceiptCacheCounters.sharedReceiptCallsSavedByCache++
    return cached.data
  }
  const inFlight = sharedReceiptInFlight.get(key)
  if (inFlight) {
    sharedReceiptCacheCounters.sharedReceiptCallsSavedByDedupe++
    return inFlight
  }
  sharedReceiptCacheCounters.sharedReceiptCacheMisses++
  const promise = (async () => {
    try {
      const receipt = await alchemyRpc(rpcUrl, 'eth_getTransactionReceipt', [txHash])
      sharedReceiptCache.set(key, { data: receipt, exp: Date.now() + SHARED_RECEIPT_CACHE_TTL_MS })
      return receipt
    } finally {
      sharedReceiptInFlight.delete(key)
    }
  })()
  sharedReceiptInFlight.set(key, promise)
  return promise
}

// Shared cross-pass tx-by-hash cache — mirrors getSharedTxReceipt to dedupe eth_getTransactionByHash calls.
const SHARED_TX_CACHE_TTL_MS = 15 * 60 * 1000
const sharedTxByHashCache = new Map<string, { data: any; exp: number }>()
const sharedTxByHashInFlight = new Map<string, Promise<any>>()
const sharedTxCacheCounters = {
  sharedTxCacheHits: 0,
  sharedTxCacheMisses: 0,
  sharedTxCallsSavedByCache: 0,
  sharedTxCallsSavedByDedupe: 0,
}

function sharedTxByHashCacheKey(rpcUrl: string, txHash: string): string {
  return `${rpcUrl.slice(-12)}:${txHash.toLowerCase()}`
}

async function getSharedTxByHash(rpcUrl: string, txHash: string): Promise<any> {
  const key = sharedTxByHashCacheKey(rpcUrl, txHash)
  const now = Date.now()
  const cached = sharedTxByHashCache.get(key)
  if (cached && cached.exp > now) {
    sharedTxCacheCounters.sharedTxCacheHits++
    sharedTxCacheCounters.sharedTxCallsSavedByCache++
    return cached.data
  }
  const inFlight = sharedTxByHashInFlight.get(key)
  if (inFlight) {
    sharedTxCacheCounters.sharedTxCallsSavedByDedupe++
    return inFlight
  }
  sharedTxCacheCounters.sharedTxCacheMisses++
  const promise = (async () => {
    try {
      const tx = await alchemyRpc(rpcUrl, 'eth_getTransactionByHash', [txHash])
      sharedTxByHashCache.set(key, { data: tx, exp: Date.now() + SHARED_TX_CACHE_TTL_MS })
      return tx
    } finally {
      sharedTxByHashInFlight.delete(key)
    }
  })()
  sharedTxByHashInFlight.set(key, promise)
  return promise
}

async function enrichSwapCandidatesFromReceipts(
  evidenceWithDetection: WalletTxEvidence[],
  walletAddress: string,
  alchemyUrl: string,
  activityRequested: boolean,
): Promise<{
  enrichedEvidence: WalletTxEvidence[]
  debug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletSwapEnrichmentDebug']>
}> {
  const emptyDebug = (reason: string) => ({
    skipped: true, reason,
    candidateTxCount: 0, receiptsFetched: 0, enrichedTxCount: 0, cacheHits: 0, errors: 0,
    enrichedTxHashes: [] as string[],
  })

  if (!activityRequested || !alchemyUrl) return { enrichedEvidence: evidenceWithDetection, debug: emptyDebug('activity_not_requested') }

  const existingSwapCount = evidenceWithDetection.filter(e => e.swapDetection?.isSwapCandidate === true).length
  if (existingSwapCount > 0) return { enrichedEvidence: evidenceWithDetection, debug: emptyDebug('swap_candidates_already_present') }

  const walletLower = walletAddress.toLowerCase()
  const seenTxHashes = new Set<string>()
  const candidateTxHashes: string[] = []
  for (const e of evidenceWithDetection) {
    if (!e.txHash || !e.txFromAddress) continue
    if (e.swapDetection?.isSwapCandidate === true) continue
    if (e.txFromAddress.toLowerCase() !== walletLower) continue
    if (e.direction !== 'buy' && e.direction !== 'unknown') continue
    if (seenTxHashes.has(e.txHash)) continue
    seenTxHashes.add(e.txHash)
    candidateTxHashes.push(e.txHash)
    if (candidateTxHashes.length >= 10) break
  }

  if (candidateTxHashes.length === 0) return { enrichedEvidence: evidenceWithDetection, debug: emptyDebug('no_wallet_initiated_candidates') }

  const toFetch = candidateTxHashes.slice(0, 8)
  const now = Date.now()
  let receiptsFetched = 0
  let cacheHits = 0
  let errors = 0
  const enrichedTxSet = new Set<string>()
  const urlSuffix = alchemyUrl.slice(-8)

  for (const txHash of toFetch) {
    const cacheKey = `${urlSuffix}:${txHash}`
    const cached = swapEnrichmentReceiptCache.get(cacheKey)
    if (cached && cached.exp > now) {
      cacheHits++
      if (cached.data.isSwap) enrichedTxSet.add(txHash)
      continue
    }
    try {
      const receipt = await getSharedTxReceipt(alchemyUrl, txHash)
      receiptsFetched++
      if (!receipt) {
        swapEnrichmentReceiptCache.set(cacheKey, { data: { isSwap: false, reason: 'no_receipt' }, exp: now + SWAP_ENRICHMENT_TTL_MS })
        continue
      }
      let isSwap = false
      let enrichReason = 'no_swap_evidence'
      const txTo = ((receipt.to as string) ?? '').toLowerCase()
      if (txTo && EXTENDED_DEX_ROUTERS.has(txTo)) {
        isSwap = true
        enrichReason = 'router_match:known_dex_router'
      }
      if (!isSwap && Array.isArray(receipt.logs)) {
        for (const log of receipt.logs as Array<{ topics?: string[]; address?: string }>) {
          if (!log.topics || log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue
          if (log.topics.length < 3) continue
          const fromPadded = log.topics[1]?.toLowerCase() ?? ''
          const fromAddr = '0x' + fromPadded.slice(-40)
          if (fromAddr === walletLower) {
            isSwap = true
            enrichReason = 'outbound_erc20_from_wallet_in_receipt'
            break
          }
        }
      }
      swapEnrichmentReceiptCache.set(cacheKey, { data: { isSwap, reason: enrichReason }, exp: now + SWAP_ENRICHMENT_TTL_MS })
      if (isSwap) enrichedTxSet.add(txHash)
    } catch {
      errors++
    }
  }

  if (enrichedTxSet.size === 0) {
    return {
      enrichedEvidence: evidenceWithDetection,
      debug: { skipped: false, reason: 'no_swap_evidence_found', candidateTxCount: toFetch.length, receiptsFetched, enrichedTxCount: 0, cacheHits, errors, enrichedTxHashes: [] },
    }
  }

  const enrichedTxHashes: string[] = []
  const enrichedEvidence: WalletTxEvidence[] = evidenceWithDetection.map(e => {
    if (!e.txHash || !enrichedTxSet.has(e.txHash)) return e
    if (e.swapDetection?.isSwapCandidate === true) return e
    if (!enrichedTxHashes.includes(e.txHash)) enrichedTxHashes.push(e.txHash)
    return {
      ...e,
      swapDetection: {
        isSwapCandidate: true,
        confidence: 'medium' as const,
        eventKind: 'swap_candidate' as const,
        reason: 'Receipt enrichment: router match or outbound ERC20 payment leg detected',
        matchedProtocol: e.txMatchedRouterProtocol ?? null,
        matchedAddress: null,
      } satisfies WalletSwapDetection,
    }
  })

  return {
    enrichedEvidence,
    debug: { skipped: false, reason: 'enriched', candidateTxCount: toFetch.length, receiptsFetched, enrichedTxCount: enrichedTxSet.size, cacheHits, errors, enrichedTxHashes },
  }
}

const FIRST_TX_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const firstTxOnChainCache = new Map<string, { date: Date | null; exp: number }>()

async function getFirstTxOnChain(address: string, alchemyUrl: string): Promise<Date | null> {
  // First-tx date is immutable — safe to cache long-term to avoid repeat alchemy_getAssetTransfers burns.
  const cacheKey = `${alchemyUrl.slice(-24)}:${address.toLowerCase()}`
  const cached = firstTxOnChainCache.get(cacheKey)
  if (cached && cached.exp > Date.now()) return cached.date
  const baseParams = {
    fromBlock: '0x0',
    category: ['external', 'internal', 'erc20'],
    withMetadata: true,
    maxCount: '0x1',
    order: 'asc',
  }
  const [sent, received] = await Promise.allSettled([
    alchemyRpc(alchemyUrl, 'alchemy_getAssetTransfers', [{ ...baseParams, fromAddress: address }]),
    alchemyRpc(alchemyUrl, 'alchemy_getAssetTransfers', [{ ...baseParams, toAddress: address }]),
  ])
  const dates: Date[] = []
  for (const r of [sent, received]) {
    const ts = r.status === 'fulfilled' && r.value?.transfers?.[0]?.metadata?.blockTimestamp
    if (ts) dates.push(new Date(ts as string))
  }
  const result = dates.length > 0 ? new Date(Math.min(...dates.map(d => d.getTime()))) : null
  firstTxOnChainCache.set(cacheKey, { date: result, exp: Date.now() + FIRST_TX_CACHE_TTL_MS })
  return result
}

async function fetchGoldrushBalances(address: string, chainName: string, apiKey: string): Promise<Holding[]> {
  try {
    const url = `https://api.covalenthq.com/v1/${chainName}/address/${address}/balances_v2/?no-spam=true&no-nft-fetch=true`
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const json = await res.json()
    if (json?.error) return []
    const items: unknown[] = Array.isArray(json?.data?.items) ? json.data.items : []
    const chainShort = chainName.replace(/-mainnet$/, '')
    return items
      .map((item) => {
        const it = item as Record<string, unknown>
        const decimals = typeof it.contract_decimals === 'number' ? it.contract_decimals : 18
        const rawBal = String(it.balance ?? '0')
        const balance = parseFloat(rawBal) / Math.pow(10, decimals)
        const value = typeof it.quote === 'number' ? it.quote : 0
        const price = typeof it.quote_rate === 'number' && it.quote_rate > 0 ? it.quote_rate : null
        const logo = typeof it.logo_url === 'string' && it.logo_url.startsWith('http') ? it.logo_url : null
        return {
          contract: typeof it.contract_address === 'string' ? it.contract_address.toLowerCase() : undefined,
          name: typeof it.contract_name === 'string' ? it.contract_name : 'Unknown',
          symbol: typeof it.contract_ticker_symbol === 'string' ? it.contract_ticker_symbol : '?',
          icon: logo,
          chain: chainShort,
          balance,
          value,
          price,
          change24h: null,
          verified: it.is_spam === false,
        } as Holding
      })
      .filter(h => h.value > 0.01)
  } catch {
    return []
  }
}

export type WalletSwapDetection = {
  isSwapCandidate: boolean
  confidence: 'high' | 'medium' | 'low'
  eventKind: 'swap_candidate' | 'transfer' | 'airdrop_candidate' | 'bridge_candidate' | 'contract_interaction' | 'unknown'
  reason: string
  matchedProtocol: string | null
  matchedAddress: string | null
  swapReconstructionConfidence?: 'high' | 'medium' | 'low'
}

export type WalletTxEvidence = {
  txHash: string
  timestamp: string | null
  fromAddress: string | null
  toAddress: string | null
  contract: string
  symbol: string
  amountRaw: string | null
  tokenDecimals: number | null
  amount: number
  usdValue: number | null
  direction: 'buy' | 'sell' | 'unknown'
  chain: string
  // transaction-level context (from tx item, not log event)
  txFromAddress?: string | null
  txToAddress?: string | null
  txSucceeded?: boolean | null
  txToKnownRouter?: boolean
  txMatchedRouterProtocol?: string | null
  swapDetection?: WalletSwapDetection
  priceAtTime?: PriceAtTimeEvidence
}

export type WalletLotOpen = {
  tokenAddress: string
  tokenSymbol?: string | null
  chain: string
  openedTxHash: string
  openedAt: string
  amountOpened: number
  amountRemaining: number
  entryPriceUsd: number
  entryValueUsd: number
  priceSource: string
  confidence: 'high' | 'medium' | 'low'
  // PHASE6-FIX-1: optional numeric/tier confidence score, additive alongside the existing
  // high/medium/low `confidence` field. Computed by lotConfidenceScore() wherever lots are
  // constructed; never required so existing consumers of WalletLotOpen are unaffected.
  confidenceScore?: number
  confidenceTier?: 'high' | 'medium' | 'low'
  // PHASE3-FIX-6: optional lot-level coverage/missing-reason metadata, additive alongside the
  // existing confidence fields. Only populated where a lot's data is genuinely incomplete
  // (e.g. synthetic backfilled lots); never required so existing consumers are unaffected.
  coveragePercent?: number
  missingReasons?: string[]
}

export type WalletClosedLot = {
  tokenAddress: string
  tokenSymbol?: string | null
  chain: string
  openedTxHash: string
  closedTxHash: string
  openedAt: string
  closedAt: string
  amountClosed: number
  entryPriceUsd: number
  exitPriceUsd: number
  costBasisUsd: number
  proceedsUsd: number
  realizedPnlUsd: number
  realizedPnlPercent: number | null
  holdingTimeSeconds: number | null
  confidence: 'high' | 'medium' | 'low'
  evidence: { entrySource: string; exitSource: string; method: 'fifo' }
  // PHASE6-FIX-1: see WalletLotOpen.confidenceScore/confidenceTier above — same additive pattern.
  confidenceScore?: number
  confidenceTier?: 'high' | 'medium' | 'low'
  // PHASE3-FIX-6: see WalletLotOpen.coveragePercent/missingReasons above — same additive pattern.
  coveragePercent?: number
  missingReasons?: string[]
}

export type PriceAtTimeEvidence = {
  status: 'priced' | 'open_check' | 'unavailable'
  tokenAddress: string
  tokenSymbol?: string | null
  timestamp: string
  priceUsd: number | null
  source: 'stable_leg' | 'weth_leg' | 'historical_price' | 'swap_derived' | 'provider_event_usd' | 'current_holding_price_open_lot_estimate' | 'eth_native_value_router_reconstruction' | 'current_price_fallback_not_used' | 'unavailable'
  confidence: 'high' | 'medium' | 'low' | 'open_check'
  reason: string
}

type StableQuoteLegSelection = {
  symbol: string
  amountUsd: number
  legsCount: number
  reason: string
}

function selectSameTxStableQuoteLeg(txGroup: WalletTxEvidence[], target: WalletTxEvidence): StableQuoteLegSelection | null {
  const stableLegs = txGroup
    .filter(ev => {
      const c = ev.contract?.toLowerCase() ?? ''
      // PHASE1-FIX-4: a stablecoin transfer that's its own airdrop_candidate (inbound-only,
      // no matching wallet-side outbound) isn't a swap quote leg — merging it in here would
      // let an unrelated rebate/airdrop set the derived price of a same-tx swap. Only legs
      // not already classified as their own airdrop count as quote legs.
      return Boolean(STABLE_USD_CONTRACTS[c]) && ev.direction !== 'unknown' && ev.direction !== target.direction
        && ev.swapDetection?.eventKind !== 'airdrop_candidate'
    })
    .map(ev => ({
      ev,
      amount: parseRawAmount(ev.amountRaw, ev.tokenDecimals) ?? ev.amount,
    }))
    .filter(({ amount }) => amount > 0 && isFinite(amount))

  if (stableLegs.length === 0) return null

  const totalAmount = stableLegs.reduce((sum, leg) => sum + leg.amount, 0)
  if (!(totalAmount > 0) || !isFinite(totalAmount)) return null

  const legsBySymbol = new Map<string, number>()
  for (const { ev, amount } of stableLegs) {
    const symbol = ev.symbol || STABLE_SYMBOL[ev.contract?.toLowerCase() ?? ''] || 'stable'
    legsBySymbol.set(symbol, (legsBySymbol.get(symbol) ?? 0) + amount)
  }
  const dominant = [...legsBySymbol.entries()].sort((a, b) => b[1] - a[1])[0]
  const symbol = dominant?.[0] ?? stableLegs[0]?.ev.symbol ?? 'stable'

  if (stableLegs.length === 1) {
    return {
      symbol,
      amountUsd: totalAmount,
      legsCount: 1,
      reason: `Derived from ${symbol} leg in same tx (${symbol} amount / token amount)`,
    }
  }

  const amountList = stableLegs
    .map(({ ev, amount }) => `${ev.symbol || STABLE_SYMBOL[ev.contract?.toLowerCase() ?? 'stable'] || 'stable'} ${amount.toFixed(6)}`)
    .join(' + ')

  return {
    symbol,
    amountUsd: totalAmount,
    legsCount: stableLegs.length,
    reason: `Derived from summed same-tx stable quote legs (${amountList} = ${totalAmount.toFixed(6)} USD / token amount); multiple quote legs present, summed same-direction stable legs to avoid dust-leg pricing`,
  }
}

type PnlEvent = {
  contract: string
  symbol: string
  direction: 'buy' | 'sell' | 'unknown'
  amount: number
  amountRaw: string | null
  tokenDecimals: number | null
  usdValue: number | null
  txHash: string | null
  // PHASE2-FIX-2: this is the single timestamp field used for every priceAtTime lookup in
  // the file. It's always populated from the provider's block timestamp at normalization
  // time (GoldRush block_signed_at / Alchemy metadata.blockTimestamp — see normalizeMoralis*
  // and the GoldRush/Alchemy event builders), so there is no separate blockTimestamp vs.
  // eventTimestamp split to standardize between — every consumer already reads this same
  // field, eliminating the mismatched-price-window risk the fix targets.
  timestamp: string | null
  fromAddress: string | null
  toAddress: string | null
  chain: string
  txFromAddress?: string | null
  txToAddress?: string | null
  txSucceeded?: boolean | null
  isSwapCandidate?: boolean
  // PHASE4-FIX-6: optional log-level position within its source page/transaction. Most providers
  // in this file (GoldRush, Alchemy, Moralis) don't expose a real log index, so this is either
  // the provider's real value (when available) or a synthetic per-page positional index assigned
  // at merge time (see assignSyntheticLogIndex) — additive/optional so no existing consumer of
  // PnlEvent is affected.
  logIndex?: number | null
}
type GoldrushHistoryDiag = {
  endpointKind: 'transfers_v2' | 'transactions_v3'
  chainUsed: string
  urlTemplate: string
  httpStatus: number | null
  fetchFailed: boolean
  failureStage: 'build_url' | 'fetch' | 'timeout' | 'empty_response' | 'no_items' | null
  rawItemCount: number
  normalizedEventCount: number
  firstEventShapeKeys: string[]
  transferArrayCount: number
  firstTransferKeys: string[]
  logEventCount?: number
  logEventNormalizedCount?: number
  reason: string
  fetchErrorKind?: 'invalid_url' | 'network' | 'timeout' | 'unknown' | null
  fetchErrorMessage?: string | null
  hasApiKey?: boolean
  requestHost?: string | null
  requestUrlValid?: boolean
  requestPathTemplate?: string
  authMode?: 'bearer' | 'basic' | 'query' | 'none'
  attemptedHosts?: Array<{
    requestHost: string
    requestUrlValid: boolean
    httpStatus: number | null
    fetchFailed: boolean
    failureStage: 'build_url' | 'fetch' | 'timeout' | 'empty_response' | 'no_items' | null
    fetchErrorKind?: 'invalid_url' | 'network' | 'timeout' | 'unknown' | null
    fetchErrorMessage?: string | null
  }>
}

function buildGoldrushTransfersRequest(chain: string, wallet: string, host: string) {
  const normalizedWallet = wallet.toLowerCase()
  const finalUrl = new URL(`https://${host}/v1/${chain}/address/${normalizedWallet}/transactions_v3/`)
  finalUrl.searchParams.set('page-size', '50')
  finalUrl.searchParams.set('page-number', '0')
  finalUrl.searchParams.set('with-logs', 'true')
  finalUrl.searchParams.set('no-spam', 'true')

  const requestUrl = finalUrl.toString()

  return {
    requestUrl,
    requestHost: finalUrl.hostname,
    requestUrlValid: true,
    requestPathTemplate: '/v1/{chain}/address/{wallet}/transactions_v3/',
    urlTemplate: `https://${host}/v1/${chain}/address/{wallet}/transactions_v3/?page-size=50&page-number=0&with-logs=true&no-spam=true`,
  }
}

async function fetchGoldrushPnlEvents(address: string, chainName: string, apiKey: string, debug = false): Promise<{ events: PnlEvent[]; diag: GoldrushHistoryDiag }> {
  const baseDiag = (chain: string): GoldrushHistoryDiag => ({ endpointKind: 'transactions_v3', chainUsed: chain, urlTemplate: `https://api.covalenthq.com/v1/${chain}/address/{wallet}/transactions_v3/?page-size=50&page-number=0&with-logs=true&no-spam=true`, httpStatus: null, fetchFailed: false, failureStage: null, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], transferArrayCount: 0, firstTransferKeys: [], reason: '', fetchErrorKind: null, fetchErrorMessage: null, hasApiKey: Boolean(apiKey), requestHost: 'api.covalenthq.com', requestUrlValid: true, requestPathTemplate: '/v1/{chain}/address/{wallet}/transactions_v3/', authMode: apiKey ? 'bearer' : 'none', attemptedHosts: [] })
  const hostCandidates = ['api.covalenthq.com', 'api.goldrush.dev'] as const
  const sanitizeMessage = (msg: string): string => {
    const shortAddr = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : ''
    return msg
      .replaceAll(apiKey, '[redacted-key]')
      .replace(new RegExp(address, 'ig'), shortAddr)
      .replace(/0x[a-fA-F0-9]{40}/g, (m) => `${m.slice(0, 6)}...${m.slice(-4)}`)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160)
  }
  const classifyFetchError = (err: unknown): { kind: 'invalid_url' | 'network' | 'timeout' | 'unknown'; message: string; isTimeout: boolean } => {
    const msg = err instanceof Error ? `${err.name} ${err.message}`.trim() : String(err ?? 'Unknown fetch error')
    const compact = sanitizeMessage(msg)
    const isTimeout = /timeout|aborted|aborterror/i.test(compact)
    if (/invalid url|failed to parse url|url is malformed|typeerror: fetch failed.*invalid/i.test(compact.toLowerCase())) return { kind: 'invalid_url', message: compact, isTimeout }
    if (isTimeout) return { kind: 'timeout', message: compact, isTimeout: true }
    if (/fetch failed|econn|enotfound|network|socket|connect|tls|certificate|dns/i.test(compact.toLowerCase())) return { kind: 'network', message: compact, isTimeout: false }
    return { kind: 'unknown', message: compact, isTimeout }
  }
  const devLog = (diag: GoldrushHistoryDiag) => {
    if (debug) {
      console.info('[goldrush-fetch]', { chainUsed: diag.chainUsed, requestHost: diag.requestHost ?? null, hasApiKey: diag.hasApiKey ?? false, urlTemplate: diag.urlTemplate, httpStatus: diag.httpStatus, fetchFailed: diag.fetchFailed, failureStage: diag.failureStage, fetchErrorKind: diag.fetchErrorKind ?? null })
    }
  }
  const finalizeDiag = (diag: GoldrushHistoryDiag): GoldrushHistoryDiag => {
    if (diag.requestUrlValid === true && diag.failureStage === 'build_url') {
      diag.failureStage = 'fetch'
    }
    if (diag.requestUrlValid === false) {
      diag.failureStage = 'build_url'
      if (!diag.reason) diag.reason = 'GoldRush wallet history URL could not be built.'
    }
    if (diag.fetchFailed === false && diag.httpStatus == null) {
      diag.fetchFailed = true
      diag.failureStage = diag.failureStage ?? 'fetch'
      diag.reason = diag.reason || 'GoldRush wallet history request did not expose an HTTP response.'
    }
    if (diag.fetchFailed === false && diag.httpStatus == null) {
      diag.fetchFailed = true
      diag.failureStage = diag.failureStage ?? 'fetch'
    }
    return diag
  }
  try {
    const chainCandidates = chainName === 'base-mainnet' ? ['base-mainnet', '8453'] : [chainName]
    let lastAttemptDiag: GoldrushHistoryDiag | null = null
    for (const chainUsed of chainCandidates) {
      const diag = baseDiag(chainUsed)
      const hasBuildInputs = Boolean(chainUsed && address && apiKey)
      if (!hasBuildInputs) {
        const out = finalizeDiag({ ...diag, fetchFailed: true, failureStage: 'build_url', fetchErrorKind: 'invalid_url', fetchErrorMessage: 'Missing required request inputs.', reason: 'GoldRush wallet history URL could not be built.' })
        devLog(out)
        return { events: [], diag: out }
      }
      let res: Response | null = null
      for (const host of hostCandidates) {
        let requestUrl = ''
        try {
          const built = buildGoldrushTransfersRequest(chainUsed, address, host)
          requestUrl = built.requestUrl
          diag.requestHost = built.requestHost
          diag.requestUrlValid = built.requestUrlValid
          diag.requestPathTemplate = built.requestPathTemplate
          diag.urlTemplate = built.urlTemplate
        } catch {
          diag.attemptedHosts?.push({ requestHost: host, requestUrlValid: false, httpStatus: null, fetchFailed: true, failureStage: 'build_url', fetchErrorKind: 'invalid_url', fetchErrorMessage: 'Failed to construct a valid GoldRush request URL.' })
          continue
        }
        try {
          res = await fetch(requestUrl, { cache: 'no-store', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) })
          diag.httpStatus = res.status
          diag.fetchFailed = false
          diag.attemptedHosts?.push({ requestHost: host, requestUrlValid: true, httpStatus: res.status, fetchFailed: false, failureStage: null, fetchErrorKind: null, fetchErrorMessage: null })
          break
        } catch (err) {
          const errInfo = classifyFetchError(err)
          diag.fetchFailed = true
          diag.failureStage = errInfo.isTimeout ? 'timeout' : 'fetch'
          diag.fetchErrorKind = errInfo.kind
          diag.fetchErrorMessage = errInfo.message
          diag.httpStatus = null
          diag.reason = 'GoldRush wallet history request failed before response.'
          diag.attemptedHosts?.push({ requestHost: host, requestUrlValid: true, httpStatus: null, fetchFailed: true, failureStage: diag.failureStage, fetchErrorKind: errInfo.kind, fetchErrorMessage: errInfo.message })
        }
      }
      if (!res) {
        const out = finalizeDiag(diag)
        lastAttemptDiag = out
        devLog(out)
        return { events: [], diag: out }
      }
      if (!res.ok) {
        let errHint = ''
        try {
          const errBody = await res.json()
          const m = errBody?.error_message ?? errBody?.message ?? errBody?.error ?? ''
          if (typeof m === 'string' && m) errHint = sanitizeMessage(m.slice(0, 100))
        } catch { /* ignore parse errors */ }
        diag.failureStage = 'empty_response'
        diag.reason = errHint
          ? `GoldRush returned HTTP ${res.status}: ${errHint}`
          : `GoldRush returned HTTP ${res.status}.`
        diag.fetchErrorMessage = errHint || null
        lastAttemptDiag = finalizeDiag(diag)
        devLog(lastAttemptDiag)
        continue
      }
      const json = await res.json()
      const items: unknown[] = Array.isArray(json?.data?.items) ? json.data.items.slice(0, 50) : []
      diag.rawItemCount = items.length
      diag.firstEventShapeKeys = items[0] && typeof items[0] === 'object' ? Object.keys(items[0] as Record<string, unknown>).slice(0, 12) : []
      if (items.length === 0) {
        diag.failureStage = 'no_items'
        diag.reason = 'No transactions found for this address in the checked window.'
        const out = finalizeDiag(diag)
        devLog(out)
        return { events: [], diag: out }
      }
      const lower = address.toLowerCase()
      const transferArrayCount = (items as unknown[]).reduce<number>((count, it) => {
        const tx = it as Record<string, unknown>
        return count + (Array.isArray(tx.transfers) ? tx.transfers.length : 0)
      }, 0)
      // Count total decoded Transfer entries across all log_events arrays
      let _logEventRawCount = 0
      let _logEventNormalizedCount = 0
      const firstTransferKeysCapture: string[] = []
      const events = items.flatMap((it) => {
        const t = it as Record<string, unknown>
        const txHash = String(t.tx_hash ?? '')
        const timestamp = String(t.block_signed_at ?? '')
        const txToAddress = String(t.to_address ?? '').toLowerCase()
        const txFromAddress = String(t.from_address ?? '').toLowerCase()
        const transfers: unknown[] = Array.isArray(t.transfers) ? t.transfers : []
        // Primary path: t.transfers (present on Base and some ETH API plans)
        if (transfers.length > 0) {
          return transfers.slice(0, 12).map((x) => {
            const tr = x as Record<string, unknown>
            const contract = String(tr.contract_address ?? '').toLowerCase()
            const symbol = String(tr.contract_ticker_symbol ?? '?')
            const decimals = typeof tr.contract_decimals === 'number' ? tr.contract_decimals : 18
            const delta = String(tr.delta ?? '0')
            const amount = Math.abs(parseFloat(delta) / Math.pow(10, decimals))
            const from = String(tr.from_address ?? '').toLowerCase()
            const to = String(tr.to_address ?? '').toLowerCase()
            const direction: 'buy' | 'sell' | 'unknown' = to === lower ? 'buy' : from === lower ? 'sell' : 'unknown'
            const quote = typeof tr.delta_quote === 'number' ? Math.abs(tr.delta_quote) : null
            return { contract, symbol, direction, amount, amountRaw: delta, tokenDecimals: decimals, usdValue: quote, txHash, timestamp, fromAddress: from, toAddress: to, txToAddress, txFromAddress, chain: chainUsed }
          })
        }
        // Fallback path: parse decoded Transfer events from log_events (ETH mainnet commonly returns
        // events here instead of the transfers array, especially on the standard API plan)
        const logEvents: unknown[] = Array.isArray(t.log_events) ? t.log_events : []
        const leResults: Array<{ contract: string; symbol: string; direction: 'buy' | 'sell' | 'unknown'; amount: number; amountRaw: string | null; tokenDecimals: number; usdValue: number | null; txHash: string; timestamp: string; fromAddress: string; toAddress: string; txToAddress: string; txFromAddress: string; chain: string }> = []
        for (const logEvent of logEvents.slice(0, 12)) {
          const le = logEvent as Record<string, unknown>
          const decoded = le.decoded as Record<string, unknown> | null | undefined
          if (!decoded || decoded.name !== 'Transfer') continue
          const params = Array.isArray(decoded.params) ? (decoded.params as Array<Record<string, unknown>>) : []
          const fromParam = params.find(p => p.name === 'from')
          const toParam = params.find(p => p.name === 'to')
          const valueParam = params.find(p => p.name === 'value')
          if (!fromParam || !toParam || !valueParam) continue
          _logEventRawCount++
          const contract = String(le.sender_address ?? '').toLowerCase()
          const symbol = String(le.sender_contract_ticker_symbol ?? '?')
          const decimals = typeof le.sender_contract_decimals === 'number' ? le.sender_contract_decimals : 18
          const from = String(fromParam.value ?? '').toLowerCase()
          const to = String(toParam.value ?? '').toLowerCase()
          const rawValue = String(valueParam.value ?? '0')
          const amount = Math.abs(parseFloat(rawValue) / Math.pow(10, decimals))
          const direction: 'buy' | 'sell' | 'unknown' = to === lower ? 'buy' : from === lower ? 'sell' : 'unknown'
          if (contract.startsWith('0x') && amount > 0) {
            leResults.push({ contract, symbol, direction, amount, amountRaw: rawValue !== '0' ? rawValue : null, tokenDecimals: decimals, usdValue: null, txHash, timestamp, fromAddress: from, toAddress: to, txToAddress, txFromAddress, chain: chainUsed })
            _logEventNormalizedCount++
          }
        }
        return leResults
      }).filter(e => e.contract.startsWith('0x') && e.amount > 0)
      diag.transferArrayCount = transferArrayCount
      diag.firstTransferKeys = firstTransferKeysCapture
      diag.logEventCount = _logEventRawCount
      diag.logEventNormalizedCount = _logEventNormalizedCount
      diag.normalizedEventCount = events.length
      if (items.length > 0 && transferArrayCount === 0 && _logEventRawCount === 0) {
        diag.reason = 'Transactions returned but no decoded ERC20 Transfer log events found (logs may be unavailable for this API plan).'
      } else if (items.length > 0 && transferArrayCount === 0 && _logEventNormalizedCount === 0 && _logEventRawCount > 0) {
        diag.reason = 'Decoded Transfer log events found but all filtered out (non-wallet-side, zero amount, or non-contract).'
      } else {
        diag.reason = events.length > 0 ? '' : 'Transfer events parsed but all filtered out (zero amount or non-contract addresses).'
      }
      const out = finalizeDiag(diag)
      devLog(out)
      return { events, diag: out }
    }
    if (lastAttemptDiag) return { events: [], diag: lastAttemptDiag }
    const fallbackChain = (chainName === 'base-mainnet' ? '8453' : chainName) || chainName
    const out = finalizeDiag({ ...baseDiag(fallbackChain), fetchFailed: true, failureStage: 'fetch', fetchErrorKind: 'unknown', fetchErrorMessage: 'No successful GoldRush response across chain candidates; check prior chain diagnostics for concrete HTTP/fetch failure details.', reason: 'GoldRush wallet history request failed before response.' })
    devLog(out)
    return { events: [], diag: out }
  } catch {
    const diag = baseDiag(chainName)
    const out = finalizeDiag({ ...diag, fetchFailed: true, failureStage: 'fetch', fetchErrorKind: 'unknown', fetchErrorMessage: 'Unexpected GoldRush wallet history handler failure.', reason: 'GoldRush wallet history request failed before response.' })
    devLog(out)
    return { events: [], diag: out }
  }
}

async function fetchAlchemyPnlEvents(address: string, baseUrl: string): Promise<PnlEvent[]> {
  try {
    const resp = await alchemyRpc(baseUrl, 'alchemy_getAssetTransfers', [{
      fromBlock: '0x0', category: ['erc20'], withMetadata: true, maxCount: '0x7d', order: 'desc', fromAddress: address,
    }])
    const recv = await alchemyRpc(baseUrl, 'alchemy_getAssetTransfers', [{
      fromBlock: '0x0', category: ['erc20'], withMetadata: true, maxCount: '0x7d', order: 'desc', toAddress: address,
    }])
    const mapTransfer = (t: Record<string, unknown>, dir: 'buy' | 'sell'): PnlEvent => {
      const meta = t.metadata as Record<string, unknown> | undefined
      return {
        contract: String(((t.rawContract as Record<string, unknown> | undefined)?.address) ?? '').toLowerCase(),
        symbol: String(t.asset ?? '?'),
        direction: dir,
        amount: Number(t.value ?? 0),
        amountRaw: String((t.rawContract as Record<string, unknown> | undefined)?.value ?? '') || null,
        tokenDecimals: null,
        usdValue: null,
        txHash: typeof t.hash === 'string' ? t.hash : null,
        timestamp: typeof meta?.blockTimestamp === 'string' ? meta.blockTimestamp : null,
        fromAddress: typeof t.from === 'string' ? t.from.toLowerCase() : null,
        toAddress: typeof t.to === 'string' ? (t.to as string).toLowerCase() : null,
        chain: 'base',
      }
    }
    const outgoing = (resp?.transfers ?? []).slice(0, 125).map((t: Record<string, unknown>) => mapTransfer(t, 'sell'))
    const incoming = (recv?.transfers ?? []).slice(0, 125).map((t: Record<string, unknown>) => mapTransfer(t, 'buy'))
    return [...outgoing, ...incoming].filter(e => e.contract.startsWith('0x') && Number.isFinite(e.amount) && e.amount > 0)
  } catch { return [] }
}

type FifoClosedLot = {
  contract: string; symbol: string
  buyTxHash: string; sellTxHash: string
  buyTimestamp: string; sellTimestamp: string
  buyAmount: number; sellAmount: number
  buyCostUsd: number; sellProceedsUsd: number
  realizedPnlUsd: number; chain: string
}

function buildFifoSwapDetection(events: PnlEvent[], walletAddr: string): PnlEvent[] {
  const lower = walletAddr.toLowerCase()
  const byTx = new Map<string, PnlEvent[]>()
  for (const e of events) {
    if (!e.txHash) continue
    const k = e.txHash.toLowerCase()
    if (!byTx.has(k)) byTx.set(k, [])
    byTx.get(k)!.push(e)
  }
  const swapHashes = new Set<string>()
  for (const [txHash, txEvents] of byTx) {
    const hasIn  = txEvents.some(e => e.direction === 'buy')
    const hasOut = txEvents.some(e => e.direction === 'sell')
    const toRouter   = txEvents.some(e => e.txToAddress   && EXTENDED_DEX_ROUTERS.has(e.txToAddress.toLowerCase()))
    const fromRouter = txEvents.some(e => e.txFromAddress && EXTENDED_DEX_ROUTERS.has(e.txFromAddress.toLowerCase()))
    // If tx touches a quote asset (stable/WETH) alongside another token, classify as swap
    const hasQuoteAsset    = txEvents.some(e => FIFO_QUOTE_ASSETS.has(e.contract.toLowerCase()))
    const hasNonQuoteAsset = txEvents.some(e => !FIFO_QUOTE_ASSETS.has(e.contract.toLowerCase()))
    const quoteSwap = hasQuoteAsset && hasNonQuoteAsset && (hasIn || hasOut)
    if ((hasIn && hasOut) || toRouter || fromRouter || quoteSwap) swapHashes.add(txHash)
  }
  void lower
  return events.map(e => ({ ...e, isSwapCandidate: e.txHash ? swapHashes.has(e.txHash.toLowerCase()) : false }))
}

function normalizeSingleLegs(events: PnlEvent[]): PnlEvent[] {
  const byTx = new Map<string, PnlEvent[]>()
  for (const e of events) {
    if (!e.txHash) continue
    const k = e.txHash.toLowerCase()
    if (!byTx.has(k)) byTx.set(k, [])
    byTx.get(k)!.push(e)
  }
  return events.map(e => {
    if (!e.txHash || (e.usdValue ?? 0) > 0) return e
    const txEvents = byTx.get(e.txHash.toLowerCase()) ?? []
    const partner = txEvents.find(p => p !== e && (p.usdValue ?? 0) > 0 && p.amount > 0)
    if (partner?.usdValue) return { ...e, usdValue: partner.usdValue }
    return e
  })
}

function normalizeMoralisTransfers(
  items: MoralisTransferItem[],
  address: string,
  chainName: string,
): { events: PnlEvent[]; debug: NormalizeMoralisDebug } {
  const lower = address.toLowerCase()
  const out: PnlEvent[] = []
  let skippedNotWalletSide = 0
  let skippedMissingHash = 0
  let skippedMissingTimestamp = 0
  let skippedMissingTokenAddress = 0
  let skippedMissingAmount = 0
  let skippedInvalidAmount = 0
  let skippedSpam = 0
  const skippedReasons: Array<{ reason: string; idx: number }> = []

  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx]
    if (it.possible_spam === true) {
      skippedSpam++
      if (skippedReasons.length < 5) skippedReasons.push({ reason: 'possible_spam', idx })
      continue
    }
    if (!it.transaction_hash) {
      skippedMissingHash++
      if (skippedReasons.length < 5) skippedReasons.push({ reason: 'missing_hash', idx })
      continue
    }
    if (!it.block_timestamp) {
      skippedMissingTimestamp++
      if (skippedReasons.length < 5) skippedReasons.push({ reason: 'missing_timestamp', idx })
      continue
    }
    if (!it.token_address) {
      skippedMissingTokenAddress++
      if (skippedReasons.length < 5) skippedReasons.push({ reason: 'missing_token_address', idx })
      continue
    }
    const contract = it.token_address.toLowerCase()
    if (!contract.startsWith('0x')) {
      skippedMissingTokenAddress++
      if (skippedReasons.length < 5) skippedReasons.push({ reason: 'invalid_token_address', idx })
      continue
    }
    const from = (it.from_address ?? '').toLowerCase()
    const to = (it.to_address ?? '').toLowerCase()
    const direction: 'buy' | 'sell' | 'unknown' = to === lower ? 'buy' : from === lower ? 'sell' : 'unknown'
    if (direction === 'unknown') { skippedNotWalletSide++; continue }

    // Amount: prefer value_decimal (pre-formatted by Moralis), fallback to raw/decimals
    let amount: number
    if (it.value_decimal != null && it.value_decimal !== '') {
      const parsed = parseFloat(it.value_decimal)
      if (!Number.isFinite(parsed)) {
        skippedInvalidAmount++
        if (skippedReasons.length < 5) skippedReasons.push({ reason: 'invalid_value_decimal', idx })
        continue
      }
      amount = Math.abs(parsed)
    } else if (it.value) {
      const decimals = it.token_decimals ? parseInt(it.token_decimals, 10) : 18
      const safeDecimals = Number.isFinite(decimals) ? decimals : 18
      const parsed = parseFloat(it.value) / Math.pow(10, safeDecimals)
      if (!Number.isFinite(parsed)) {
        skippedInvalidAmount++
        if (skippedReasons.length < 5) skippedReasons.push({ reason: 'invalid_amount_raw', idx })
        continue
      }
      amount = Math.abs(parsed)
    } else {
      skippedMissingAmount++
      if (skippedReasons.length < 5) skippedReasons.push({ reason: 'missing_value', idx })
      continue
    }
    if (amount <= 0) {
      skippedInvalidAmount++
      if (skippedReasons.length < 5) skippedReasons.push({ reason: 'zero_amount', idx })
      continue
    }
    const decimals = it.token_decimals ? parseInt(it.token_decimals, 10) : 18
    const safeDecimals = Number.isFinite(decimals) ? decimals : 18
    out.push({ contract, symbol: it.token_symbol ?? '?', direction, amount, amountRaw: it.value ?? null, tokenDecimals: safeDecimals, usdValue: null, txHash: it.transaction_hash, timestamp: it.block_timestamp, fromAddress: from || null, toAddress: to || null, chain: chainName, txFromAddress: null, txToAddress: null, txSucceeded: null })
  }
  const debug: NormalizeMoralisDebug = {
    rawCount: items.length, normalizedCount: out.length,
    skippedNotWalletSide, skippedMissingHash, skippedMissingTimestamp,
    skippedMissingTokenAddress, skippedMissingAmount, skippedInvalidAmount, skippedSpam,
    sampleNormalizedEvents: out.slice(0, 5).map(e => ({ contract: e.contract.slice(0, 10) + '…', symbol: e.symbol, direction: e.direction, amount: e.amount, txHash: e.txHash ? e.txHash.slice(0, 10) + '…' : null })),
    sampleSkippedReasons: skippedReasons.slice(0, 5),
  }
  return { events: out, debug }
}

async function fetchGoldrushHistoricalPage(
  address: string,
  chainName: string,
  apiKey: string,
  pageNum: number,
  pageSize: number = 50,
): Promise<{
  pageNum: number; chain: string; httpStatus: number | null; rawItems: number; transferLogs: number; events: PnlEvent[]; error: string | null; newestTimestamp: string | null
  dropCounts: { seen: number; noTxHash: number; noTimestamp: number; noContract: number; noAmount: number; decodeFailed: number }
}> {
  const result = {
    pageNum, chain: chainName, httpStatus: null as number | null, rawItems: 0, transferLogs: 0, events: [] as PnlEvent[], error: null as string | null, newestTimestamp: null as string | null,
    dropCounts: { seen: 0, noTxHash: 0, noTimestamp: 0, noContract: 0, noAmount: 0, decodeFailed: 0 },
  }
  try {
    const url = new URL(`https://api.covalenthq.com/v1/${chainName}/address/${address}/transactions_v3/`)
    url.searchParams.set('page-size', String(pageSize))
    url.searchParams.set('page-number', String(pageNum))
    url.searchParams.set('with-logs', 'true')
    url.searchParams.set('no-spam', 'true')
    const res = await fetch(url.toString(), { cache: 'no-store', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(12_000) })
    result.httpStatus = res.status
    if (!res.ok) { result.error = `HTTP ${res.status}`; return result }
    const json = await res.json()
    const items: unknown[] = Array.isArray(json?.data?.items) ? json.data.items : []
    result.rawItems = items.length
    if (items.length === 0) return result
    const lower = address.toLowerCase()
    for (const it of items) {
      const t = it as Record<string, unknown>
      const txHash = typeof t.tx_hash === 'string' ? t.tx_hash : null
      const timestamp = typeof t.block_signed_at === 'string' ? t.block_signed_at : null
      const txFromAddress = typeof t.from_address === 'string' ? t.from_address.toLowerCase() : null
      const txToAddress = typeof t.to_address === 'string' ? t.to_address.toLowerCase() : null
      const txSucceeded = typeof t.successful === 'boolean' ? t.successful : null
      if (timestamp && !result.newestTimestamp) result.newestTimestamp = timestamp
      const transfers: unknown[] = Array.isArray(t.transfers) ? t.transfers : []
      for (const transfer of transfers.slice(0, 24)) {
        const tr = transfer as Record<string, unknown>
        const contract = String(tr.contract_address ?? '').toLowerCase()
        const symbol = String(tr.contract_ticker_symbol ?? '?')
        const decimals = typeof tr.contract_decimals === 'number' ? tr.contract_decimals : 18
        const delta = String(tr.delta ?? '0')
        const amount = Math.abs(parseFloat(delta) / Math.pow(10, decimals))
        const from = String(tr.from_address ?? '').toLowerCase()
        const to = String(tr.to_address ?? '').toLowerCase()
        const direction: 'buy' | 'sell' | 'unknown' = to === lower ? 'buy' : from === lower ? 'sell' : 'unknown'
        const quote = typeof tr.delta_quote === 'number' ? Math.abs(tr.delta_quote) : null
        result.dropCounts.seen++
        if (!txHash) { result.dropCounts.noTxHash++; continue }
        if (!timestamp) { result.dropCounts.noTimestamp++; continue }
        if (!contract.startsWith('0x')) { result.dropCounts.noContract++; continue }
        if (!(amount > 0)) { result.dropCounts.noAmount++; continue }
        result.transferLogs++
        result.events.push({ contract, symbol, direction, amount, amountRaw: delta !== '0' ? delta : null, tokenDecimals: decimals, usdValue: quote, txHash, timestamp, fromAddress: from, toAddress: to, chain: chainName, txFromAddress, txToAddress, txSucceeded })
      }
      const logEvents: unknown[] = Array.isArray(t.log_events) ? t.log_events : []
      for (const logEvent of logEvents) {
        const le = logEvent as Record<string, unknown>
        const decoded = le.decoded as Record<string, unknown> | null | undefined
        if (!decoded || decoded.name !== 'Transfer') continue
        result.dropCounts.seen++
        const params = Array.isArray(decoded.params) ? (decoded.params as Record<string, unknown>[]) : []
        const fromParam = params.find(p => p.name === 'from')
        const toParam = params.find(p => p.name === 'to')
        const valueParam = params.find(p => p.name === 'value')
        if (!fromParam || !toParam || !valueParam) { result.dropCounts.decodeFailed++; continue }
        const contract = String(le.sender_address ?? '').toLowerCase()
        const symbol = String(le.sender_contract_ticker_symbol ?? '?')
        const decimals = typeof le.sender_contract_decimals === 'number' ? le.sender_contract_decimals : 18
        const from = String(fromParam.value ?? '').toLowerCase()
        const to = String(toParam.value ?? '').toLowerCase()
        const rawValue = String(valueParam.value ?? '0')
        const amount = Math.abs(parseFloat(rawValue) / Math.pow(10, decimals))
        const direction: 'buy' | 'sell' | 'unknown' = to === lower ? 'buy' : from === lower ? 'sell' : 'unknown'
        if (!txHash) { result.dropCounts.noTxHash++; continue }
        if (!timestamp) { result.dropCounts.noTimestamp++; continue }
        if (!contract.startsWith('0x')) { result.dropCounts.noContract++; continue }
        if (!(amount > 0)) { result.dropCounts.noAmount++; continue }
        result.transferLogs++
        result.events.push({ contract, symbol, direction, amount, amountRaw: rawValue !== '0' ? rawValue : null, tokenDecimals: decimals, usdValue: null, txHash, timestamp, fromAddress: from, toAddress: to, chain: chainName, txFromAddress, txToAddress, txSucceeded })
      }
    }
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.error = msg.replace(/key|secret|bearer/gi, '[redacted]').slice(0, 120)
    return result
  }
}

async function buildWalletHistoricalCoverage(
  address: string,
  apiKey: string,
  maxPages: number,
  matchedClosedLotsBefore: number,
  targetContracts?: Set<string>,
  startPage = 0,
  chainsOverride?: ReadonlyArray<'base-mainnet' | 'eth-mainnet'>,
): Promise<WalletHistoricalCoverageOutput> {
  const emptyDebug = (reason: string): WalletHistoricalCoverageOutput => ({
    summary: { status: 'open_check', requested: true, pagesAttempted: 0, maxPages, rawTransactions: 0, rawLogEvents: 0, normalizedEvents: 0, walletSideEvents: 0, swapLikeTransactions: 0, pricedSwapCandidates: null, matchedClosedLotsBefore, matchedClosedLotsAfter: null, addedClosedLots: null, coverageLevel: 'none', missing: ['provider_not_configured'], reason },
    debug: { requested: true, providersAttempted: [], pagesAttempted: 0, pageSize: 50, maxPages, cursorUsed: false, stoppedReason: reason, rawTransactions: 0, rawLogEvents: 0, decodedTransferLogs: 0, walletSideEvents: 0, candidateSwapTxs: 0, candidateSwapEvents: 0, duplicateTxHashes: 0, duplicateEvents: 0, oldestTimestamp: null, newestTimestamp: null, chainCoverage: {}, providerErrorSamples: [], skippedReasons: [reason], sampleTxHashes: [], sampleSwapLikeTransactions: [], moralisHistoricalConfigured: false, moralisHistoricalAttempted: false, moralisReason: 'moralis_history_not_wired_yet' },
    events: [],
  })
  if (!apiKey) return emptyDebug('goldrush_not_configured')

  const pageSize = 50
  const chains = chainsOverride && chainsOverride.length > 0 ? chainsOverride : (['base-mainnet', 'eth-mainnet'] as const)
  const chainCoverage: Record<string, { pages: number; transactions: number; events: number }> = {}
  const allEvents: PnlEvent[] = []
  const errorSamples: string[] = []
  let totalRawTx = 0
  let totalTransferLogs = 0
  let pagesAttempted = 0
  const _dropAgg = { seen: 0, noTxHash: 0, noTimestamp: 0, noContract: 0, noAmount: 0, decodeFailed: 0 }
  let stoppedReason = 'max_pages_reached'
  const newestTimestamps: string[] = []
  // PHASE4-FIX-7 (item 2): per-provider/chain pagination state. GoldRush's transactions_v3
  // endpoint never tells us pagesExpected up front (no total-count field), so it stays null;
  // earlyTermination distinguishes "stopped because a page errored/returned a short page before
  // maxPages was reached" from "ran all the way to maxPages" (which is a budget limit, not a
  // provider-side early stop).
  const paginationReasons: string[] = []

  for (const chain of chains) {
    chainCoverage[chain] = { pages: 0, transactions: 0, events: 0 }
    let _chainPagesFetched = 0
    let _chainEarlyTermination = false
    // PHASE4-FIX-3: GoldRush's transactions_v3 endpoint is offset/page-number paginated (no
    // opaque cursor token in the response), so we model the cursor as "next page index, or
    // null when exhausted" rather than blindly iterating page=0..maxPages-1. A page that
    // returns fewer than pageSize items (or errors) sets cursor=null and stops the loop, same
    // as a real nextCursor=null would. `_iterGuard` is an explicit infinite-loop guard,
    // independent of `maxPages`, in case maxPages is ever misconfigured to be unbounded.
    let cursor: number | null = startPage
    let _iterGuard = 0
    const _maxIterGuard = Math.max(maxPages, 1) * 2
    while (cursor !== null && _iterGuard < _maxIterGuard) {
      _iterGuard++
      if (cursor >= startPage + maxPages) break
      pagesAttempted++
      const r = await fetchGoldrushHistoricalPage(address, chain, apiKey, cursor)
      if (r.error) {
        errorSamples.push(`${chain} p${cursor}: ${r.error}`)
        stoppedReason = 'provider_error'
        _chainEarlyTermination = true
        cursor = null
        break
      }
      chainCoverage[chain].pages++
      _chainPagesFetched++
      chainCoverage[chain].transactions += r.rawItems
      chainCoverage[chain].events += r.events.length
      totalRawTx += r.rawItems
      totalTransferLogs += r.transferLogs
      _dropAgg.seen += r.dropCounts.seen
      _dropAgg.noTxHash += r.dropCounts.noTxHash
      _dropAgg.noTimestamp += r.dropCounts.noTimestamp
      _dropAgg.noContract += r.dropCounts.noContract
      _dropAgg.noAmount += r.dropCounts.noAmount
      _dropAgg.decodeFailed += r.dropCounts.decodeFailed
      // PHASE4-FIX-6 (item 5): assign a synthetic per-page logIndex to events GoldRush didn't
      // already tag with one, before they're merged with other pages/chains.
      const { events: _pageEventsWithLogIndex, syntheticCount: _pageSynthetic } = assignSyntheticLogIndex(r.events)
      if (_pageSynthetic > 0 && !paginationReasons.includes('synthetic_log_index')) paginationReasons.push('synthetic_log_index')
      allEvents.push(..._pageEventsWithLogIndex)
      if (r.newestTimestamp) newestTimestamps.push(r.newestTimestamp)
      if (r.rawItems < pageSize || r.rawItems === 0) { stoppedReason = 'page_partial_or_empty'; cursor = null; break }
      cursor = cursor + 1
    }
    // PHASE4-FIX-7 (item 2): a chain that stopped before exhausting maxPages because of a
    // provider error (not a clean "page came back short/empty") is an early termination, not
    // just normal pagination completion — flag it distinctly from a generic provider error so
    // a caller can tell "we hit the wallet's actual history end" from "the provider cut us off."
    if (_chainEarlyTermination && !paginationReasons.includes('provider_early_termination')) {
      paginationReasons.push('provider_early_termination')
    }
    // A chain that used every page slot up to maxPages without a clean stop signal may still
    // have more history we didn't fetch — surface that as incomplete pagination coverage.
    if (_chainPagesFetched >= maxPages && !_chainEarlyTermination && !paginationReasons.includes('provider_pagination_incomplete')) {
      paginationReasons.push('provider_pagination_incomplete')
    }
  }

  // Targeted historical recovery: keep exact contracts chosen by the budget planner.
  const preFilterEvents = targetContracts && targetContracts.size > 0
    ? allEvents.filter(ev => targetContracts.has((ev.contract ?? '').toLowerCase()))
    : allEvents

  // PHASE4-FIX-4: dedupe by chain+contract+from+to+amountRaw(+txHash) instead of a rounded
  // float amount, which previously let unrelated tokens collide when amountRaw/decimals were
  // missing. Direction is implied by from/to, so it no longer needs to be in the key.
  const seen = new Set<string>()
  let dupEvents = 0
  let uniqueEvents: PnlEvent[] = []
  for (const ev of preFilterEvents) {
    const k = pnlEventDedupeKey(ev)
    if (seen.has(k)) { dupEvents++; continue }
    seen.add(k)
    uniqueEvents.push(ev)
  }
  // PHASE4-FIX-5/PHASE4-FIX-3 (item 1): deterministic (timestamp, chainId, logIndex,
  // providerIndex) order for the merged multi-chain event set, so downstream FIFO/cost-basis
  // logic sees a consistent chronology across chains even when two chains' events share an
  // identical timestamp.
  uniqueEvents = deterministicEventOrder(uniqueEvents)
  const allTxHashes = new Set<string>(uniqueEvents.map(e => e.txHash).filter(Boolean) as string[])
  const walletSideEvents = uniqueEvents.filter(e => e.direction !== 'unknown').length

  // swap-like: tx with both buy and sell wallet events
  const txDirs = new Map<string, Set<string>>()
  for (const ev of uniqueEvents) {
    if (!ev.txHash || ev.direction === 'unknown') continue
    if (!txDirs.has(ev.txHash)) txDirs.set(ev.txHash, new Set())
    txDirs.get(ev.txHash)!.add(ev.direction)
  }
  const swapLikeTxs = [...txDirs.values()].filter(d => d.has('buy') && d.has('sell')).length
  const swapLikeEvents = uniqueEvents.filter(ev => ev.txHash && txDirs.get(ev.txHash)?.has('buy') && txDirs.get(ev.txHash)?.has('sell')).length

  const coverageLevel: 'none' | 'light' | 'medium' | 'deep' = uniqueEvents.length >= 200 ? 'deep' : uniqueEvents.length >= 80 ? 'medium' : uniqueEvents.length > 0 ? 'light' : 'none'
  const status: 'ok' | 'partial' | 'open_check' = uniqueEvents.length > 0 ? (errorSamples.length === 0 && stoppedReason !== 'provider_error' ? 'ok' : 'partial') : 'open_check'
  const newestTimestamp = newestTimestamps.length > 0 ? newestTimestamps[0] : null
  const oldestTimestamp = newestTimestamps.length > 1 ? newestTimestamps[newestTimestamps.length - 1] : newestTimestamp

  // PHASE4-FIX-7 (item 2): merge the pagination reason keys in alongside the existing
  // target-contract-filter skip reason — both are additive entries in the same string[] field,
  // so this doesn't change the debug object's shape.
  const _skippedReasons = [
    ...(targetContracts && targetContracts.size > 0 ? ['target_contract_filter_applied'] : []),
    ...paginationReasons,
  ]
  const _droppedNonTargetToken = targetContracts && targetContracts.size > 0 ? Math.max(0, allEvents.length - preFilterEvents.length) : 0
  const _droppedNoWalletSide = uniqueEvents.length - walletSideEvents
  const _logNormalizationDebug = {
    historicalRawLogsSeen: _dropAgg.seen,
    historicalRawLogsDroppedNoTxHash: _dropAgg.noTxHash,
    historicalRawLogsDroppedNoTimestamp: _dropAgg.noTimestamp,
    historicalRawLogsDroppedNoContract: _dropAgg.noContract,
    historicalRawLogsDroppedNoAmount: _dropAgg.noAmount,
    historicalRawLogsDroppedNoWalletSide: _droppedNoWalletSide,
    historicalRawLogsDroppedNonTargetToken: _droppedNonTargetToken,
    historicalRawLogsDroppedDecodeFailed: _dropAgg.decodeFailed,
    historicalRawLogsDroppedDuplicate: dupEvents,
    historicalRawLogsNormalizedTransferEvents: uniqueEvents.length,
    historicalRawLogsWalletSideTransferEvents: walletSideEvents,
  }
  return {
    summary: { status, requested: true, pagesAttempted, maxPages, rawTransactions: totalRawTx, rawLogEvents: totalTransferLogs, normalizedEvents: uniqueEvents.length, walletSideEvents, swapLikeTransactions: swapLikeTxs, pricedSwapCandidates: null, matchedClosedLotsBefore, matchedClosedLotsAfter: null, addedClosedLots: null, coverageLevel, missing: errorSamples.length > 0 ? ['provider_errors', ...paginationReasons] : [...paginationReasons], reason: errorSamples.length > 0 ? 'One or more provider pages failed.' : null },
    debug: { requested: true, providersAttempted: ['goldrush'], pagesAttempted, pageSize, maxPages, cursorUsed: true, stoppedReason, rawTransactions: totalRawTx, rawLogEvents: totalTransferLogs, decodedTransferLogs: totalTransferLogs, walletSideEvents, candidateSwapTxs: swapLikeTxs, candidateSwapEvents: swapLikeEvents, duplicateTxHashes: 0, duplicateEvents: dupEvents, oldestTimestamp, newestTimestamp, chainCoverage, providerErrorSamples: errorSamples.slice(0, 4), skippedReasons: _skippedReasons, sampleTxHashes: [...allTxHashes].slice(0, 5), sampleSwapLikeTransactions: [], moralisHistoricalConfigured: false, moralisHistoricalAttempted: false, moralisReason: 'moralis_history_not_wired_yet', logNormalizationDebug: _logNormalizationDebug },
    events: uniqueEvents,
  }
}


function parseUnmatchedSellTokenKey(key: string): { chain: string; tokenContract: string } | null {
  const [rawChain, rawContract] = key.split(/\s+/)[0]?.split(':') ?? []
  const chain = normalizeChain(rawChain ?? '')
  const tokenContract = (rawContract ?? '').toLowerCase()
  if (!chain || !/^0x[a-f0-9]{40}$/.test(tokenContract)) return null
  return { chain, tokenContract }
}

function buildUnmatchedSellBackfillTargets(
  pricedEvidence: WalletTxEvidence[],
  unmatchedSellTokenKeys: string[],
  sampleUnmatchedSells?: Array<{ txHash: string; tokenAddress: string; symbol: string; amount: number; exitPriceUsd: number }>,
): { targets: UnmatchedSellBackfillTarget[]; extractionDebug: NonNullable<UnmatchedSellBackfillDebug['targetExtractionDebug']> } {
  const orderedKeys: string[] = []
  const wanted = new Set<string>()
  for (const rawKey of unmatchedSellTokenKeys) {
    const parsed = parseUnmatchedSellTokenKey(rawKey)
    if (!parsed) continue
    const key = `${parsed.chain}:${parsed.tokenContract}`
    if (wanted.has(key)) continue
    wanted.add(key)
    orderedKeys.push(key)
  }

  // Source A: pricedEvidence — find sell metadata for wanted keys
  const sellMetadata = new Map<string, UnmatchedSellBackfillTarget>()
  for (const e of pricedEvidence) {
    if (e.direction !== 'sell' || !e.contract?.startsWith('0x')) continue
    const chain = normalizeChain(e.chain)
    const tokenContract = e.contract.toLowerCase()
    const key = `${chain}:${tokenContract}`
    if (!wanted.has(key)) continue
    if (!e.txHash || !e.timestamp) continue
    const amount = parseRawAmount(e.amountRaw, e.tokenDecimals) ?? e.amount
    if (!amount || amount <= 0) continue
    const candidate: UnmatchedSellBackfillTarget = { chain, tokenContract, symbol: e.symbol ?? null, sellTxHash: e.txHash, sellTimestamp: e.timestamp, sellAmount: amount, exitPriceUsd: e.priceAtTime?.priceUsd ?? null }
    const existing = sellMetadata.get(key)
    if (!existing || candidate.sellTimestamp! < existing.sellTimestamp!) sellMetadata.set(key, candidate)
  }

  // Source B: sampleUnmatchedSells — enrich symbol/amount for keys without pricedEvidence metadata
  const sampleByContract = new Map<string, { txHash: string; symbol: string; amount: number; exitPriceUsd: number }>()
  for (const s of sampleUnmatchedSells ?? []) {
    const addr = (s.tokenAddress ?? '').toLowerCase()
    if (!addr.startsWith('0x')) continue
    if (!sampleByContract.has(addr)) sampleByContract.set(addr, { txHash: s.txHash, symbol: s.symbol, amount: s.amount, exitPriceUsd: s.exitPriceUsd })
  }

  const targetsFromSamples: string[] = []
  const targetsFromKeys: string[] = [...orderedKeys]

  // Keep ALL ordered keys; enrich from samples when pricedEvidence metadata is missing
  const targets = orderedKeys.map((key): UnmatchedSellBackfillTarget => {
    const meta = sellMetadata.get(key)
    if (meta) return meta
    const colonIdx = key.indexOf(':')
    const chain = key.slice(0, colonIdx)
    const tokenContract = key.slice(colonIdx + 1)
    const sample = sampleByContract.get(tokenContract)
    if (sample) {
      targetsFromSamples.push(key)
      const validTxHash = typeof sample.txHash === 'string' && sample.txHash.startsWith('0x') && sample.txHash.length === 66 ? sample.txHash : null
      return { chain, tokenContract, symbol: sample.symbol ?? null, sellTxHash: validTxHash, sellTimestamp: null, sellAmount: sample.amount > 0 ? sample.amount : 0, exitPriceUsd: sample.exitPriceUsd > 0 ? sample.exitPriceUsd : null, _metadataMissing: true }
    }
    return { chain, tokenContract, symbol: null, sellTxHash: null, sellTimestamp: null, sellAmount: 0, exitPriceUsd: null, _metadataMissing: true }
  })

  const extractionDebug: NonNullable<UnmatchedSellBackfillDebug['targetExtractionDebug']> = {
    unmatchedSellKeysInput: unmatchedSellTokenKeys,
    sampleUnmatchedSellsInput: (sampleUnmatchedSells ?? []).map(s => ({ txHash: s.txHash, tokenAddress: s.tokenAddress, symbol: s.symbol })),
    targetsFromSamples,
    targetsFromKeys,
    droppedTargets: [],
    finalTargets: targets.map(t => `${t.chain}:${t.tokenContract}`),
  }

  return { targets, extractionDebug }
}

async function fetchAlchemyBasePriorBuysForToken(address: string, baseUrl: string, target: UnmatchedSellBackfillTarget): Promise<{ events: PnlEvent[]; raw: number; error: string | null }> {
  if (!ALCHEMY_BASE_KEY || !baseUrl) return { events: [], raw: 0, error: 'base_contract_filter_unavailable' }
  try {
    const result = await alchemyRpc(baseUrl, 'alchemy_getAssetTransfers', [{ fromBlock: '0x0', category: ['erc20'], withMetadata: true, maxCount: '0x64', order: 'desc', toAddress: address, contractAddresses: [target.tokenContract] }])
    const transfers: Record<string, unknown>[] = Array.isArray(result?.transfers) ? result.transfers : []
    const sellTime = target.sellTimestamp ? new Date(target.sellTimestamp).getTime() : null
    const lower = address.toLowerCase()
    const events = transfers.map((t): PnlEvent => {
      const meta = t.metadata as Record<string, unknown> | undefined
      const rawContract = t.rawContract as Record<string, unknown> | undefined
      const timestamp = typeof meta?.blockTimestamp === 'string' ? meta.blockTimestamp : null
      const contract = String(rawContract?.address ?? target.tokenContract).toLowerCase()
      const from = typeof t.from === 'string' ? t.from.toLowerCase() : null
      const to = typeof t.to === 'string' ? t.to.toLowerCase() : null
      return { contract, symbol: String(t.asset ?? target.symbol ?? '?'), direction: to === lower ? 'buy' : from === lower ? 'sell' : 'unknown', amount: Number(t.value ?? 0), amountRaw: String(rawContract?.value ?? '') || null, tokenDecimals: null, usdValue: null, txHash: typeof t.hash === 'string' ? t.hash : null, timestamp, fromAddress: from, toAddress: to, chain: 'base' }
    }).filter(e => {
      const ts = e.timestamp ? new Date(e.timestamp).getTime() : NaN
      const timeOk = sellTime === null ? true : (Number.isFinite(ts) && ts < sellTime)
      return normalizeChain(e.chain) === 'base' && e.contract.toLowerCase() === target.tokenContract && e.direction === 'buy' && e.txHash && timeOk && e.amount > 0
    })
    return { events, raw: transfers.length, error: null }
  } catch {
    return { events: [], raw: 0, error: 'base_contract_filter_unavailable' }
  }
}

async function runTargetedUnmatchedSellBackfill(address: string, targets: UnmatchedSellBackfillTarget[], apiKey: string, baseUrl: string, closedLotsBefore: number, realizedPnlBefore: number | null): Promise<UnmatchedSellBackfillOutput> {
  const makePerTarget = (target: UnmatchedSellBackfillTarget, attempted: boolean, reason: UnmatchedSellBackfillReason | string): UnmatchedSellBackfillPerTargetResult => ({
    chain: target.chain,
    tokenContract: target.tokenContract,
    symbol: target.symbol,
    attempted,
    pagesAttempted: 0,
    rawEventsFetched: 0,
    normalizedEvents: 0,
    priorBuysFound: 0,
    priorBuysPriced: 0,
    eventsAddedToFifo: 0,
    reason,
  })
  const empty = (attempted: boolean, reason: UnmatchedSellBackfillReason | string): UnmatchedSellBackfillOutput => ({
    events: [],
    targetBuyKeys: new Set<string>(),
    debug: {
      attempted,
      reason,
      unmatchedSellCount: targets.length,
      targetTokens: targets.map(t => ({ chain: t.chain, tokenContract: t.tokenContract, symbol: t.symbol })),
      pagesAttempted: 0,
      rawEventsFetched: 0,
      normalizedEvents: 0,
      priorBuysFound: 0,
      priorBuysPriced: 0,
      eventsAddedToFifo: 0,
      closedLotsBefore,
      closedLotsAfter: closedLotsBefore,
      realizedPnlBefore,
      realizedPnlAfter: realizedPnlBefore,
      stopReason: reason,
      perTargetResults: targets.map(t => makePerTarget(t, attempted, reason)),
      sampleTargets: targets.slice(0, 5),
      samplePriorBuys: [],
      sampleStillUnmatched: targets.map(t => `${t.chain}:${t.tokenContract}`).slice(0, 5),
      sampleSkippedReasons: [],
    },
  })
  if (targets.length === 0) return empty(false, 'not_eligible')
  const cacheKey = `${address.toLowerCase()}:${targets.map(t => `${t.chain}:${t.tokenContract}:${t.sellTimestamp}`).join('|')}:v3`
  const cached = unmatchedSellBackfillCache.get(cacheKey)
  if (cached && Date.now() - cached.cachedAt <= UNMATCHED_SELL_BACKFILL_TTL_MS) return { events: cached.data.events, targetBuyKeys: new Set(cached.data.targetBuyKeys), debug: { ...cached.data.debug, attempted: true, reason: cached.data.debug.reason || 'cache_hit' } }

  const debug = empty(true, 'prior_buy_not_found_for_sold_token').debug
  const perTarget = new Map<string, UnmatchedSellBackfillPerTargetResult>()
  for (const target of targets) perTarget.set(`${target.chain}:${target.tokenContract}`, makePerTarget(target, true, 'prior_buy_not_found_for_sold_token'))
  debug.perTargetResults = targets.map(t => perTarget.get(`${t.chain}:${t.tokenContract}`)!)

  const eventsToAdd: PnlEvent[] = []
  const targetBuyKeys = new Set<string>()
  const seenEvents = new Set<string>()
  const foundTargetKeys = new Set<string>()
  let stopReason: UnmatchedSellBackfillReason | string = 'prior_buy_not_found_for_sold_token'
  const maxPagesPerToken = 2
  const maxPagesTotal = 4

  const addEventsForTarget = (target: UnmatchedSellBackfillTarget, candidateEvents: PnlEvent[], priorBuys: PnlEvent[]) => {
    const targetKey = `${target.chain}:${target.tokenContract}`
    const result = perTarget.get(targetKey)
    if (!result || priorBuys.length === 0) return
    foundTargetKeys.add(targetKey)
    result.priorBuysFound += priorBuys.length
    debug.priorBuysFound += priorBuys.length
    const beforeCount = eventsToAdd.length
    const buyTxHashes = new Set(priorBuys.map(e => e.txHash).filter(Boolean) as string[])
    const txEvents = candidateEvents.filter(e => e.txHash && buyTxHashes.has(e.txHash))
    for (const ev of txEvents.length > 0 ? txEvents : priorBuys) {
      // PHASE4-FIX-4: shared dedupe key (chain+contract+from+to+amountRaw+txHash) instead of a
      // rounded-float amount, to avoid collisions between unrelated tokens.
      const k = pnlEventDedupeKey(ev)
      if (seenEvents.has(k)) continue
      seenEvents.add(k)
      eventsToAdd.push(ev)
      if (ev.direction === 'buy' && normalizeChain(ev.chain) === target.chain && ev.contract.toLowerCase() === target.tokenContract) {
        targetBuyKeys.add(`${ev.txHash}:${ev.contract.toLowerCase()}:buy`)
        if (debug.samplePriorBuys.length < 5) debug.samplePriorBuys.push({ chain: target.chain, tokenContract: target.tokenContract, symbol: ev.symbol ?? target.symbol, txHash: ev.txHash!, timestamp: ev.timestamp!, amount: ev.amount, priceUsd: ev.usdValue && ev.amount > 0 ? ev.usdValue / ev.amount : null })
      }
    }
    result.eventsAddedToFifo += eventsToAdd.length - beforeCount
    result.reason = 'prior_buy_found'
  }

  // PHASE5-FIX-3: GoldRush's transactions_v3 endpoint is page-number (not cursor) paginated —
  // same as buildWalletHistoricalCoverage's cursor adapter — so this loop is the page-number
  // side of that same adapter pattern. It already terminates safely via two independent bounds:
  // a per-token page cap (maxPagesPerToken) and a global page cap (maxPagesTotal via debug.pagesAttempted).
  for (let page = 0; page < maxPagesPerToken; page++) {
    for (const target of targets) {
      const targetKey = `${target.chain}:${target.tokenContract}`
      const result = perTarget.get(targetKey)!
      if (foundTargetKeys.has(targetKey)) continue
      if (debug.pagesAttempted >= maxPagesTotal) {
        if (result.reason !== 'prior_buy_found') result.reason = 'backfill_budget_blocked'
        debug.sampleSkippedReasons.push({ reason: 'backfill_budget_blocked', chain: target.chain, tokenContract: target.tokenContract, page })
        stopReason = 'backfill_budget_blocked'
        continue
      }
      const chainName = normalizeChainForGoldrush(target.chain)
      const sellTime = target.sellTimestamp ? new Date(target.sellTimestamp).getTime() : null
      result.attempted = true
      if (!apiKey) {
        const reason: UnmatchedSellBackfillReason = 'backfill_provider_unavailable'
        result.reason = reason
        debug.sampleSkippedReasons.push({ reason, chain: target.chain, tokenContract: target.tokenContract, page })
      } else {
        debug.pagesAttempted++
        result.pagesAttempted++
        const pageResult = await fetchGoldrushHistoricalPage(address, chainName, apiKey, page)
        if (pageResult.error) {
          const reason: UnmatchedSellBackfillReason = 'backfill_provider_unavailable'
          result.reason = reason
          debug.sampleSkippedReasons.push({ reason, chain: target.chain, tokenContract: target.tokenContract, page })
        } else {
          debug.rawEventsFetched += pageResult.rawItems
          debug.normalizedEvents += pageResult.events.length
          result.rawEventsFetched += pageResult.rawItems
          result.normalizedEvents += pageResult.events.length
          const older = sellTime === null ? pageResult.events : pageResult.events.filter(e => { const ts = e.timestamp ? new Date(e.timestamp).getTime() : NaN; return Number.isFinite(ts) && ts < sellTime })
          const priorBuys = older.filter(e => normalizeChain(e.chain) === target.chain && e.contract.toLowerCase() === target.tokenContract && e.direction === 'buy' && e.txHash && e.amount > 0)
          if (priorBuys.length > 0) addEventsForTarget(target, pageResult.events, priorBuys)
        }
      }
    }
  }

  for (const target of targets) {
    const targetKey = `${target.chain}:${target.tokenContract}`
    const result = perTarget.get(targetKey)!
    if (foundTargetKeys.has(targetKey) || target.chain !== 'base') continue
    const alchemy = await fetchAlchemyBasePriorBuysForToken(address, baseUrl, target)
    debug.rawEventsFetched += alchemy.raw
    debug.normalizedEvents += alchemy.events.length
    result.rawEventsFetched += alchemy.raw
    result.normalizedEvents += alchemy.events.length
    if (alchemy.error) {
      result.reason = result.reason === 'backfill_budget_blocked' ? 'backfill_budget_blocked' : 'base_contract_filter_unavailable'
      debug.sampleSkippedReasons.push({ reason: 'base_contract_filter_unavailable', chain: target.chain, tokenContract: target.tokenContract })
    } else if (alchemy.events.length === 0 && result.reason !== 'backfill_budget_blocked') {
      result.reason = 'prior_buy_not_found_for_sold_token'
    }
    if (alchemy.events.length > 0) addEventsForTarget(target, alchemy.events, alchemy.events)
  }

  // Moralis backfill for non-ETH/BASE chains (BSC, Polygon, etc.)
  // Page-1 is typically a cache hit from Phase 19; page-2 costs one extra call.
  const _moralisBkApiKey = process.env.MORALIS_API_KEY ?? ''
  const _supportedMoralisBackfillChains: string[] = ['bsc', 'polygon', 'arbitrum', 'optimism', 'avalanche', 'fantom', 'cronos', 'gnosis']
  // PHASE5-FIX-3: Moralis is the cursor-paginated side of the same adapter pattern noted above
  // GoldRush's page-number loop — fetchMoralisTransfers takes an opaque `cursor` string (not a
  // page index) and `moralisNextCursor` is threaded from each response into the next call. Do
  // not convert this to a page-number loop, and do not feed a GoldRush page index into it.
  if (_moralisBkApiKey) {
    for (const target of targets) {
      const targetKey = `${target.chain}:${target.tokenContract}`
      if (foundTargetKeys.has(targetKey)) continue
      if (!_supportedMoralisBackfillChains.includes(target.chain)) continue  // ETH/BASE handled above
      const result = perTarget.get(targetKey)!
      const sellTime = target.sellTimestamp ? new Date(target.sellTimestamp).getTime() : null
      let moralisBuysFound = false
      let moralisNextCursor: string | null = null
      for (let mp = 0; mp < 2 && !moralisBuysFound; mp++) {
        result.pagesAttempted++
        debug.pagesAttempted++
        const mResult = await fetchMoralisTransfers(address, target.chain as MoralisChain, 100, moralisNextCursor ?? undefined)
        if (!mResult.usable) {
          result.reason = 'provider_history_depth_insufficient'
          debug.sampleSkippedReasons.push({ reason: 'provider_history_depth_insufficient', chain: target.chain, tokenContract: target.tokenContract, page: mp })
          break
        }
        debug.rawEventsFetched += mResult.rawCount
        result.rawEventsFetched += mResult.rawCount
        moralisNextCursor = mResult.nextCursor
        if (!mResult.items.length) break
        const { events: mEvents } = normalizeMoralisTransfers(mResult.items, address, target.chain)
        debug.normalizedEvents += mEvents.length
        result.normalizedEvents += mEvents.length
        const olderBuys = mEvents.filter(e => {
          const ts = e.timestamp ? new Date(e.timestamp).getTime() : NaN
          const timeOk = sellTime === null || (Number.isFinite(ts) && ts < sellTime)
          return normalizeChain(e.chain) === normalizeChain(target.chain) &&
                 e.contract.toLowerCase() === target.tokenContract &&
                 e.direction === 'buy' && e.txHash && timeOk && e.amount > 0
        })
        if (olderBuys.length > 0) {
          addEventsForTarget(target, mEvents, olderBuys)
          moralisBuysFound = true
        } else if (!moralisNextCursor) {
          break
        }
      }
      if (!moralisBuysFound && result.reason !== 'backfill_budget_blocked') {
        result.reason = 'prior_buy_not_found_for_sold_token'
        debug.sampleSkippedReasons.push({ reason: 'prior_buy_not_found_for_sold_token', chain: target.chain, tokenContract: target.tokenContract })
      }
    }
  }

  for (const target of targets) {
    const targetKey = `${target.chain}:${target.tokenContract}`
    const result = perTarget.get(targetKey)!
    if (result.reason === 'prior_buy_found' || result.reason === 'backfill_budget_blocked'  || result.reason === 'base_provider_unavailable' || result.reason === 'base_contract_filter_unavailable' || result.reason === 'provider_history_depth_insufficient') continue
    result.reason = 'prior_buy_not_found_for_sold_token'
    debug.sampleSkippedReasons.push({ reason: 'prior_buy_not_found_for_sold_token', chain: target.chain, tokenContract: target.tokenContract })
  }

  debug.eventsAddedToFifo = eventsToAdd.length
  debug.stopReason = eventsToAdd.length > 0 ? 'prior_buy_found' : (debug.perTargetResults.find(r => r.reason === 'backfill_budget_blocked')?.reason ?? debug.perTargetResults[debug.perTargetResults.length - 1]?.reason ?? stopReason)
  debug.reason = eventsToAdd.length > 0 ? 'prior_buy_found' : debug.stopReason
  debug.sampleStillUnmatched = targets.filter(t => !foundTargetKeys.has(`${t.chain}:${t.tokenContract}`)).map(t => `${t.chain}:${t.tokenContract}`).slice(0, 5)
  unmatchedSellBackfillCache.set(cacheKey, { data: { events: eventsToAdd, targetBuyKeys: [...targetBuyKeys], debug }, cachedAt: Date.now() })
  return { events: eventsToAdd, targetBuyKeys, debug }
}

function buildHistoricalCandidateComparison(
  historicalPnlEvents: PnlEvent[],
  existingEvidenceWithDetection: WalletTxEvidence[],
  walletAddress: string,
): {
  summary: WalletSnapshot['walletHistoricalCandidateSummary']
  debug: NonNullable<WalletSnapshot['_diagnostics']>['walletHistoricalCandidateDebug']
  newCandidateEvidence: WalletTxEvidence[]
  allHistoricalEvidence: WalletTxEvidence[]
} {
  const notRequested = () => ({
    summary: { status: 'not_requested' as const, requested: false, baseEvidenceEvents: 0, historicalNormalizedEvents: 0, historicalWalletSideEvents: 0, existingSwapCandidates: 0, historicalSwapCandidates: 0, newSwapCandidateEvents: 0, duplicateSwapCandidateEvents: 0, candidateTransactions: 0, newCandidateTransactions: 0, candidateTokens: 0, newCandidateTokens: 0, earliestCandidateAt: null, latestCandidateAt: null, readyForHistoricalPricing: false, readyForHistoricalFifoPreview: false, missing: ['historical_coverage_not_requested'], reason: null },
    debug: { requested: false, baseEvidenceEvents: 0, historicalNormalizedEvents: 0, historicalWalletSideEvents: 0, existingSwapCandidates: 0, historicalSwapCandidates: 0, newSwapCandidateEvents: 0, duplicateSwapCandidateEvents: 0, candidateTransactions: 0, newCandidateTransactions: 0, candidateTokens: 0, newCandidateTokens: 0, candidateTokenSymbols: [], earliestCandidateAt: null, latestCandidateAt: null, sampleNewSwapCandidates: [], sampleDuplicateCandidates: [], skippedReasons: ['historical_coverage_not_requested'], reasons: [] },
    newCandidateEvidence: [] as WalletTxEvidence[],
    allHistoricalEvidence: [] as WalletTxEvidence[],
  })
  if (historicalPnlEvents.length === 0) return notRequested()

  // Build dedup set from existing base evidence (swap candidates only)
  const existingSwapKeys = new Set<string>()
  const existingSwapCandidateCount = existingEvidenceWithDetection.filter(e => e.swapDetection?.isSwapCandidate === true).length
  for (const e of existingEvidenceWithDetection) {
    if (e.swapDetection?.isSwapCandidate !== true) continue
    existingSwapKeys.add(`${e.txHash}|${e.contract}|${e.direction}|${Math.round(e.amount * 1e6)}`)
  }

  const historicalWalletSideEvents = historicalPnlEvents.filter(e => e.direction !== 'unknown').length

  // Run swap detection on historical events (same logic as base pipeline)
  const { evidenceList: histEvidenceList } = buildTxEvidenceFromEvents(historicalPnlEvents, true)
  const { evidenceWithDetection: histSwapEvidence } = buildSwapDetection(histEvidenceList, true, walletAddress)
  const historicalSwapCandidates = histSwapEvidence.filter(e => e.swapDetection?.isSwapCandidate === true).length

  // Compare historical swap candidates against existing base evidence
  const newSwapCandidateItems: Array<{ txHash: string; contract: string; symbol: string; direction: string; timestamp: string | null; reason: string }> = []
  const duplicateSwapCandidateItems: Array<{ txHash: string; contract: string; symbol: string; direction: string }> = []
  const newCandidateEvidence: WalletTxEvidence[] = []
  const newTxHashes = new Set<string>()
  const newContractSet = new Set<string>()
  const existingContractSet = new Set<string>(existingEvidenceWithDetection.filter(e => e.swapDetection?.isSwapCandidate === true).map(e => e.contract))

  for (const e of histSwapEvidence) {
    if (e.swapDetection?.isSwapCandidate !== true) continue
    const dedupKey = `${e.txHash}|${e.contract}|${e.direction}|${Math.round(e.amount * 1e6)}`
    if (existingSwapKeys.has(dedupKey)) {
      duplicateSwapCandidateItems.push({ txHash: e.txHash ?? '', contract: e.contract, symbol: e.symbol ?? '', direction: e.direction })
    } else {
      newSwapCandidateItems.push({ txHash: e.txHash ?? '', contract: e.contract, symbol: e.symbol ?? '', direction: e.direction, timestamp: e.timestamp ?? null, reason: 'historical_swap_candidate_not_in_base_evidence' })
      newCandidateEvidence.push(e)
      if (e.txHash) newTxHashes.add(e.txHash)
      newContractSet.add(e.contract)
    }
  }

  const allCandidateTxHashes = new Set<string>()
  const allCandidateContracts = new Set<string>()
  for (const e of histSwapEvidence) {
    if (e.swapDetection?.isSwapCandidate !== true) continue
    if (e.txHash) allCandidateTxHashes.add(e.txHash)
    allCandidateContracts.add(e.contract)
  }

  const timestamps = newSwapCandidateItems.map(e => e.timestamp).filter(Boolean) as string[]
  const sortedTs = timestamps.sort()
  const earliestCandidateAt = sortedTs[0] ?? null
  const latestCandidateAt = sortedTs[sortedTs.length - 1] ?? null

  const newSwapCandidateEvents = newSwapCandidateItems.length
  const duplicateSwapCandidateEvents = duplicateSwapCandidateItems.length
  const candidateTransactions = allCandidateTxHashes.size
  const newCandidateTransactions = newTxHashes.size
  const candidateTokens = allCandidateContracts.size
  const newCandidateTokens = newContractSet.size - [...newContractSet].filter(c => existingContractSet.has(c)).length

  const status: WalletSnapshot['walletHistoricalCandidateSummary']['status'] =
    historicalSwapCandidates === 0 ? 'open_check' :
    newSwapCandidateEvents > 0 ? 'ok' : 'partial'

  const newTokenSymbols = [...new Set(newSwapCandidateItems.map(e => e.symbol).filter(Boolean))]

  return {
    summary: { status, requested: true, baseEvidenceEvents: existingEvidenceWithDetection.length, historicalNormalizedEvents: historicalPnlEvents.length, historicalWalletSideEvents, existingSwapCandidates: existingSwapCandidateCount, historicalSwapCandidates, newSwapCandidateEvents, duplicateSwapCandidateEvents, candidateTransactions, newCandidateTransactions, candidateTokens, newCandidateTokens, earliestCandidateAt, latestCandidateAt, readyForHistoricalPricing: newSwapCandidateEvents > 0 && earliestCandidateAt !== null, readyForHistoricalFifoPreview: false, missing: newSwapCandidateEvents === 0 ? ['no_new_swap_candidates'] : [], reason: newSwapCandidateEvents === 0 ? 'No additional swap candidates found in historical coverage window.' : null },
    debug: { requested: true, baseEvidenceEvents: existingEvidenceWithDetection.length, historicalNormalizedEvents: historicalPnlEvents.length, historicalWalletSideEvents, existingSwapCandidates: existingSwapCandidateCount, historicalSwapCandidates, newSwapCandidateEvents, duplicateSwapCandidateEvents, candidateTransactions, newCandidateTransactions, candidateTokens, newCandidateTokens, candidateTokenSymbols: newTokenSymbols, earliestCandidateAt, latestCandidateAt, sampleNewSwapCandidates: newSwapCandidateItems.slice(0, 5), sampleDuplicateCandidates: duplicateSwapCandidateItems.slice(0, 5), skippedReasons: [], reasons: newSwapCandidateEvents > 0 ? ['historical_swap_candidates_found'] : ['no_new_swap_candidates'] },
    newCandidateEvidence,
    allHistoricalEvidence: histSwapEvidence,
  }
}

// SYNTH-RECOVERY-FIX-9: for synthetic FIFO-backfilled lots specifically, find a real prior buy by
// going directly to the normalized historical events for that exact target token contract — a
// wallet-side inbound transfer before the synthetic sell's timestamp — without requiring it to
// already look like a router-style swap (no counter-leg needed). Pool-to-pool or other-wallet
// transfers are excluded because PnlEvent.direction is only 'buy'/'sell' for the scanned wallet's
// own from/to address; everything else is 'unknown' and is never treated as wallet-side here.
function buildSyntheticTargetPriorBuyRecovery(
  hcEvents: PnlEvent[],
  syntheticClosedLots: WalletClosedLot[],
): {
  newCandidateEvidence: WalletTxEvidence[]
  debug: {
    syntheticTargetHistoricalRawLogs: number
    syntheticTargetHistoricalNormalizedEvents: number
    syntheticTargetHistoricalWalletInboundEvents: number
    syntheticTargetHistoricalWalletOutboundEvents: number
    syntheticTargetPriorBuysFound: number
    syntheticTargetDropBreakdown: Record<string, number>
    sampleSyntheticTargetPriorBuys: Array<{ txHash: string | null; contract: string; symbol: string; amount: number; timestamp: string | null }>
  }
} {
  const targetTokens = new Set(syntheticClosedLots.map(l => l.tokenAddress.toLowerCase()))
  const latestSellTimestampByToken = new Map<string, string>()
  for (const l of syntheticClosedLots) {
    const t = l.tokenAddress.toLowerCase()
    const existing = latestSellTimestampByToken.get(t)
    if (!existing || l.closedAt > existing) latestSellTimestampByToken.set(t, l.closedAt)
  }
  const dropBreakdown: Record<string, number> = { non_target_token: 0, no_timestamp: 0, not_before_sell: 0 }
  const targetEvents: PnlEvent[] = []
  for (const e of hcEvents) {
    if (!targetTokens.has((e.contract ?? '').toLowerCase())) { dropBreakdown.non_target_token++; continue }
    targetEvents.push(e)
  }
  const inboundEvents = targetEvents.filter(e => e.direction === 'buy')
  const outboundEvents = targetEvents.filter(e => e.direction === 'sell')
  const priorBuyEvents: PnlEvent[] = []
  for (const e of inboundEvents) {
    if (!e.timestamp) { dropBreakdown.no_timestamp++; continue }
    const sellTs = latestSellTimestampByToken.get((e.contract ?? '').toLowerCase())
    if (sellTs && e.timestamp >= sellTs) { dropBreakdown.not_before_sell++; continue }
    priorBuyEvents.push(e)
  }
  const { evidenceList } = buildTxEvidenceFromEvents(priorBuyEvents, true)
  const newCandidateEvidence: WalletTxEvidence[] = evidenceList.map(e => ({
    ...e,
    swapDetection: { isSwapCandidate: true, confidence: 'medium', eventKind: 'swap_candidate' as const, reason: 'synthetic_target_prior_buy_direct_recovery', matchedProtocol: null, matchedAddress: null },
  }))
  return {
    newCandidateEvidence,
    debug: {
      syntheticTargetHistoricalRawLogs: targetEvents.length,
      syntheticTargetHistoricalNormalizedEvents: targetEvents.length,
      syntheticTargetHistoricalWalletInboundEvents: inboundEvents.length,
      syntheticTargetHistoricalWalletOutboundEvents: outboundEvents.length,
      syntheticTargetPriorBuysFound: newCandidateEvidence.length,
      syntheticTargetDropBreakdown: dropBreakdown,
      sampleSyntheticTargetPriorBuys: newCandidateEvidence.slice(0, 5).map(e => ({ txHash: e.txHash, contract: e.contract, symbol: e.symbol, amount: e.amount, timestamp: e.timestamp })),
    },
  }
}

async function buildHistoricalPricingPreview(
  newCandidateEvidence: WalletTxEvidence[],
  allHistoricalEvidence: WalletTxEvidence[],
  reqCache?: Map<string, number | null>
): Promise<{
  summary: WalletSnapshot['walletHistoricalPricingPreviewSummary']
  debug: NonNullable<WalletSnapshot['_diagnostics']>['walletHistoricalPricingPreviewDebug']
  pricedEvidence: WalletTxEvidence[]
}> {
  const MAX_PRICE_ATTEMPTS = 10
  const abbr = (addr: string) => `${addr.slice(0, 8)}...${addr.slice(-6)}`

  const newSwapCandidateEvents = newCandidateEvidence.filter(e => e.swapDetection?.isSwapCandidate === true).length

  if (newSwapCandidateEvents === 0) {
    return {
      summary: { status: 'open_check', requested: true, newSwapCandidateEvents: 0, pricedHistoricalCandidates: 0, unpricedHistoricalCandidates: 0, stableLegPricedEvents: 0, wethLegPricedEvents: 0, historicalPricedEvents: 0, priceAttemptLimitReached: false, readyForHistoricalFifoPreview: false, missing: ['no_new_swap_candidates'], reason: 'No new swap candidates to price.' },
      debug: { requested: true, newSwapCandidateEvents: 0, priceAttempts: 0, pricedHistoricalCandidates: 0, unpricedHistoricalCandidates: 0, stableLegPricedEvents: 0, wethLegPricedEvents: 0, historicalPricedEvents: 0, priceAttemptLimitReached: false, samplePricedHistoricalCandidates: [], sampleUnpricedHistoricalCandidates: [], skippedReasons: ['no_new_swap_candidates'], reasons: [] },
      pricedEvidence: [],
    }
  }

  // Build tx-level lookup from ALL historical evidence so WETH/stable legs resolve correctly
  const allByTx = new Map<string, WalletTxEvidence[]>()
  for (const e of allHistoricalEvidence) {
    if (e.txHash) allByTx.set(e.txHash, [...(allByTx.get(e.txHash) ?? []), e])
  }

  let priceAttempts = 0
  let pricedHistoricalCandidates = 0
  let unpricedHistoricalCandidates = 0
  let stableLegPricedEvents = 0
  let wethLegPricedEvents = 0
  let historicalPricedEventsCount = 0
  let priceAttemptLimitReached = false
  const samplePricedRaw: Array<{ txHash: string; contract: string; symbol: string; direction: string; priceUsd: number; source: string }> = []
  const sampleUnpricedRaw: Array<{ txHash: string; contract: string; symbol: string; direction: string; reason: string }> = []
  const skippedReasons: string[] = []
  const pricedEvidenceItems: WalletTxEvidence[] = []

  const markPriced = (e: WalletTxEvidence, priceUsd: number, source: PriceAtTimeEvidence['source'], confidence: PriceAtTimeEvidence['confidence'], reason: string): WalletTxEvidence =>
    ({ ...e, priceAtTime: { status: 'priced' as const, tokenAddress: e.contract, tokenSymbol: e.symbol, timestamp: e.timestamp ?? '', priceUsd, source, confidence, reason } })

  for (const e of newCandidateEvidence) {
    if (e.swapDetection?.isSwapCandidate !== true) { skippedReasons.push('not_swap_candidate'); continue }

    if (!e.timestamp) {
      unpricedHistoricalCandidates++
      if (sampleUnpricedRaw.length < 5) sampleUnpricedRaw.push({ txHash: abbr(e.txHash), contract: abbr(e.contract), symbol: e.symbol, direction: e.direction, reason: 'no_timestamp' })
      continue
    }
    if (!e.contract || !e.contract.startsWith('0x')) {
      unpricedHistoricalCandidates++
      if (sampleUnpricedRaw.length < 5) sampleUnpricedRaw.push({ txHash: abbr(e.txHash), contract: e.contract, symbol: e.symbol, direction: e.direction, reason: 'no_contract' })
      continue
    }

    const contractLower = e.contract.toLowerCase()
    const isStable = Boolean(STABLE_USD_CONTRACTS[contractLower])
    const isWeth = Boolean(WETH_CONTRACTS_PRICE[contractLower])

    if (isStable) {
      pricedHistoricalCandidates++; stableLegPricedEvents++
      pricedEvidenceItems.push(markPriced(e, 1.0, 'stable_leg', 'high', 'Stablecoin — price is $1 USD by definition'))
      if (samplePricedRaw.length < 5) samplePricedRaw.push({ txHash: abbr(e.txHash), contract: abbr(e.contract), symbol: e.symbol, direction: e.direction, priceUsd: 1.0, source: 'stable_leg' })
      continue
    }

    const tokenAmount = parseRawAmount(e.amountRaw, e.tokenDecimals) ?? e.amount
    if (!tokenAmount || tokenAmount <= 0) {
      unpricedHistoricalCandidates++
      if (sampleUnpricedRaw.length < 5) sampleUnpricedRaw.push({ txHash: abbr(e.txHash), contract: abbr(e.contract), symbol: e.symbol, direction: e.direction, reason: 'zero_amount' })
      continue
    }

    const txGroup = allByTx.get(e.txHash) ?? []

    // Stable leg: use the full same-tx stable quote side. Aggregators can emit multiple
    // same-direction stable transfers for one swap; selecting stableLegs[0] lets tiny
    // dust legs set an artificially low token price.
    const stableQuote = selectSameTxStableQuoteLeg(txGroup, e)
    if (stableQuote) {
      const derivedPrice = stableQuote.amountUsd / tokenAmount
      if (derivedPrice > 0 && isFinite(derivedPrice)) {
        pricedHistoricalCandidates++; stableLegPricedEvents++
        pricedEvidenceItems.push(markPriced(e, derivedPrice, 'stable_leg', 'high', stableQuote.reason))
        if (samplePricedRaw.length < 5) samplePricedRaw.push({ txHash: abbr(e.txHash), contract: abbr(e.contract), symbol: e.symbol, direction: e.direction, priceUsd: derivedPrice, source: 'stable_leg' })
        continue
      }
    }

    // WETH leg: find WETH counterpart in same tx with opposite direction
    if (!isWeth) {
      const wethLegs = txGroup.filter(ev => Boolean(WETH_CONTRACTS_PRICE[ev.contract?.toLowerCase() ?? '']) && ev.direction !== 'unknown' && ev.direction !== e.direction)
      if (wethLegs.length > 0) {
        const wl = wethLegs[0]
        if (priceAttempts >= MAX_PRICE_ATTEMPTS) {
          priceAttemptLimitReached = true; unpricedHistoricalCandidates++
          if (sampleUnpricedRaw.length < 5) sampleUnpricedRaw.push({ txHash: abbr(e.txHash), contract: abbr(e.contract), symbol: e.symbol, direction: e.direction, reason: 'price_attempt_limit_reached' })
          continue
        }
        priceAttempts++
        const result = await fetchGoldrushHistoricalPrice(wl.chain, wl.contract, e.timestamp, reqCache)
        if (result.priceUsd !== null) {
          const wethAmt = parseRawAmount(wl.amountRaw, wl.tokenDecimals) ?? wl.amount
          if (wethAmt > 0) {
            const derivedPrice = (wethAmt * result.priceUsd) / tokenAmount
            if (derivedPrice > 0 && isFinite(derivedPrice)) {
              pricedHistoricalCandidates++; wethLegPricedEvents++
              pricedEvidenceItems.push(markPriced(e, derivedPrice, 'weth_leg', 'medium', `Derived from WETH leg`))
              if (samplePricedRaw.length < 5) samplePricedRaw.push({ txHash: abbr(e.txHash), contract: abbr(e.contract), symbol: e.symbol, direction: e.direction, priceUsd: derivedPrice, source: 'weth_leg' })
              continue
            }
          }
        }
      }
    }

    // Direct historical price lookup
    if (priceAttempts >= MAX_PRICE_ATTEMPTS) {
      priceAttemptLimitReached = true; unpricedHistoricalCandidates++
      if (sampleUnpricedRaw.length < 5) sampleUnpricedRaw.push({ txHash: abbr(e.txHash), contract: abbr(e.contract), symbol: e.symbol, direction: e.direction, reason: 'price_attempt_limit_reached' })
      continue
    }
    priceAttempts++
    const histResult = await fetchGoldrushHistoricalPrice(e.chain, e.contract, e.timestamp, reqCache)
    if (histResult.priceUsd !== null) {
      pricedHistoricalCandidates++; historicalPricedEventsCount++
      pricedEvidenceItems.push(markPriced(e, histResult.priceUsd, 'historical_price', 'medium', 'Historical token price from on-chain pricing data'))
      if (samplePricedRaw.length < 5) samplePricedRaw.push({ txHash: abbr(e.txHash), contract: abbr(e.contract), symbol: e.symbol, direction: e.direction, priceUsd: histResult.priceUsd, source: 'historical_price' })
      continue
    }

    unpricedHistoricalCandidates++
    if (sampleUnpricedRaw.length < 5) sampleUnpricedRaw.push({ txHash: abbr(e.txHash), contract: abbr(e.contract), symbol: e.symbol, direction: e.direction, reason: 'no_price_evidence' })
  }

  // Swap-derived pricing pass: 0 extra API credits.
  // For any unpriced historical swap candidate, derive price from an already-priced counterpart.
  {
    const LP_TAGS = ['LP', 'UNI-V2', 'SLP', 'BAL', 'CRV']
    const isLPSym = (s: string) => LP_TAGS.some(t => s.includes(t))
    const pricedByTx = new Map<string, WalletTxEvidence[]>()
    for (const ev of pricedEvidenceItems) {
      if (ev.txHash && ev.priceAtTime?.status === 'priced' && ev.priceAtTime.priceUsd) {
        pricedByTx.set(ev.txHash, [...(pricedByTx.get(ev.txHash) ?? []), ev])
      }
    }
    const alreadyPricedKeys = new Set(pricedEvidenceItems.map(p => `${p.txHash}:${p.contract}:${p.direction}`))
    for (const e of newCandidateEvidence) {
      if (e.swapDetection?.isSwapCandidate !== true) continue
      if (alreadyPricedKeys.has(`${e.txHash}:${e.contract}:${e.direction}`)) continue
      if (isLPSym(e.symbol ?? '')) continue
      const thisAmt = parseRawAmount(e.amountRaw, e.tokenDecimals) ?? e.amount
      if (!thisAmt || thisAmt <= 0) continue
      const cp = (pricedByTx.get(e.txHash) ?? []).find(c =>
        c.direction !== 'unknown' && c.direction !== e.direction && !isLPSym(c.symbol ?? '')
      )
      if (!cp?.priceAtTime?.priceUsd) continue
      const cpAmt = parseRawAmount(cp.amountRaw, cp.tokenDecimals) ?? cp.amount
      if (!cpAmt || cpAmt <= 0) continue
      const syntheticPrice = (cpAmt * cp.priceAtTime.priceUsd) / thisAmt
      if (syntheticPrice <= 0 || !isFinite(syntheticPrice)) continue
      pricedHistoricalCandidates++
      unpricedHistoricalCandidates--
      pricedEvidenceItems.push(markPriced(e, syntheticPrice, 'swap_derived', 'low',
        `Swap-derived from ${cp.symbol} leg (${cpAmt.toFixed(4)} × $${cp.priceAtTime.priceUsd.toFixed(4)} / ${thisAmt.toFixed(4)})`))
    }
  }

  const status: WalletSnapshot['walletHistoricalPricingPreviewSummary']['status'] =
    pricedHistoricalCandidates === 0 ? 'open_check'
    : pricedHistoricalCandidates >= newSwapCandidateEvents * 0.6 ? 'ok'
    : 'partial'

  const missing: string[] = []
  if (pricedHistoricalCandidates === 0) missing.push('no_price_evidence')
  if (priceAttemptLimitReached) missing.push('price_attempt_limit_reached')

  return {
    summary: { status, requested: true, newSwapCandidateEvents, pricedHistoricalCandidates, unpricedHistoricalCandidates, stableLegPricedEvents, wethLegPricedEvents, historicalPricedEvents: historicalPricedEventsCount, priceAttemptLimitReached, readyForHistoricalFifoPreview: pricedHistoricalCandidates > 0, missing, reason: missing.length > 0 ? missing.join('; ') : null },
    debug: { requested: true, newSwapCandidateEvents, priceAttempts, pricedHistoricalCandidates, unpricedHistoricalCandidates, stableLegPricedEvents, wethLegPricedEvents, historicalPricedEvents: historicalPricedEventsCount, priceAttemptLimitReached, samplePricedHistoricalCandidates: samplePricedRaw, sampleUnpricedHistoricalCandidates: sampleUnpricedRaw, skippedReasons, reasons: pricedHistoricalCandidates > 0 ? ['historical_candidates_priced'] : ['no_price_evidence'] },
    pricedEvidence: pricedEvidenceItems,
  }
}

function buildHistoricalFifoPreview(
  baselinePricedEvidence: WalletTxEvidence[],
  newHistoricalPricedEvidence: WalletTxEvidence[],
  baselineClosedLots: WalletClosedLot[],
  baselineRealizedPnlUsd: number | null,
  baselineRealizedPnlPercent: number | null,
  unpricedHistoricalCandidates: number,
): {
  summary: WalletSnapshot['walletHistoricalFifoPreviewSummary']
  debug: NonNullable<WalletSnapshot['_diagnostics']>['walletHistoricalFifoPreviewDebug']
  previewClosedLots: WalletClosedLot[]
} {
  const abbr = (addr: string) => `${addr.slice(0, 8)}...${addr.slice(-6)}`
  const BREAK_EVEN_EPSILON = 0.01

  const notRequested = () => ({
    summary: { status: 'not_requested' as const, requested: false, baselineClosedLots: 0, previewClosedLots: 0, addedClosedLots: 0, baselineRealizedPnlUsd: null, previewRealizedPnlUsd: null, addedRealizedPnlUsd: null, baselineRealizedPnlPercent: null, previewRealizedPnlPercent: null, winningClosedLotsPreview: 0, losingClosedLotsPreview: 0, breakEvenClosedLotsPreview: 0, uniqueTokensPreview: 0, previewConfidence: 'low' as const, readyForHistoricalTradeStatsPreview: false, safeToPromoteToPublicStats: false, missing: ['historical_pricing_not_requested'], reason: null },
    debug: undefined as NonNullable<WalletSnapshot['_diagnostics']>['walletHistoricalFifoPreviewDebug'],
    previewClosedLots: [] as WalletClosedLot[],
  })

  if (newHistoricalPricedEvidence.length === 0) return notRequested()

  // Dedup new historical evidence against baseline (same key as Phase 6B)
  const baselineKeys = new Set<string>()
  for (const e of baselinePricedEvidence) {
    if (e.swapDetection?.isSwapCandidate && e.priceAtTime?.status === 'priced') {
      baselineKeys.add(`${e.txHash}|${e.contract}|${e.direction}|${Math.round(e.amount * 1e6)}`)
    }
  }
  const dedupedNewEvidence = newHistoricalPricedEvidence.filter(e => {
    const k = `${e.txHash}|${e.contract}|${e.direction}|${Math.round(e.amount * 1e6)}`
    return !baselineKeys.has(k)
  })

  const baselinePricedEvents = baselinePricedEvidence.filter(e => e.swapDetection?.isSwapCandidate && e.priceAtTime?.status === 'priced').length
  const newPricedHistoricalEvents = dedupedNewEvidence.length

  if (newPricedHistoricalEvents === 0) {
    return {
      summary: { status: 'open_check', requested: true, baselineClosedLots: baselineClosedLots.length, previewClosedLots: baselineClosedLots.length, addedClosedLots: 0, baselineRealizedPnlUsd, previewRealizedPnlUsd: baselineRealizedPnlUsd, addedRealizedPnlUsd: null, baselineRealizedPnlPercent, previewRealizedPnlPercent: baselineRealizedPnlPercent, winningClosedLotsPreview: baselineClosedLots.filter(l => l.realizedPnlUsd > BREAK_EVEN_EPSILON).length, losingClosedLotsPreview: baselineClosedLots.filter(l => l.realizedPnlUsd < -BREAK_EVEN_EPSILON).length, breakEvenClosedLotsPreview: baselineClosedLots.filter(l => Math.abs(l.realizedPnlUsd) <= BREAK_EVEN_EPSILON).length, uniqueTokensPreview: new Set(baselineClosedLots.map(l => `${l.chain}:${l.tokenAddress}`)).size, previewConfidence: 'low', readyForHistoricalTradeStatsPreview: false, safeToPromoteToPublicStats: false, missing: ['no_new_priced_historical_events_after_dedup'], reason: 'Historical candidates priced, but did not create additional matched closed lots.' },
      debug: { requested: true, baselinePricedEvents, newPricedHistoricalEvents: 0, combinedPricedEvents: baselinePricedEvents, baselineClosedLots: baselineClosedLots.length, previewClosedLots: baselineClosedLots.length, addedClosedLots: 0, baselineRealizedPnlUsd, previewRealizedPnlUsd: baselineRealizedPnlUsd, addedRealizedPnlUsd: null, winningClosedLotsPreview: baselineClosedLots.filter(l => l.realizedPnlUsd > BREAK_EVEN_EPSILON).length, losingClosedLotsPreview: baselineClosedLots.filter(l => l.realizedPnlUsd < -BREAK_EVEN_EPSILON).length, breakEvenClosedLotsPreview: baselineClosedLots.filter(l => Math.abs(l.realizedPnlUsd) <= BREAK_EVEN_EPSILON).length, unmatchedBuysPreview: 0, unmatchedSellsPreview: 0, samplePreviewClosedLots: [], sampleAddedClosedLots: [], skippedReasons: ['no_deduped_new_events'], reasons: ['no_new_priced_historical_events_after_dedup'] },
      previewClosedLots: baselineClosedLots,
    }
  }

  // Run preview FIFO on combined evidence (baseline + deduped new)
  const combinedEvidence = [...baselinePricedEvidence, ...dedupedNewEvidence]
  const { closedLots: previewClosedLots, summary: previewFifoSummary } = buildFifoLotEngine(combinedEvidence, true)

  const previewRealizedPnlUsd = previewFifoSummary.realizedPnlUsd
  const previewRealizedPnlPercent = previewFifoSummary.realizedPnlPercent
  const addedClosedLots = previewClosedLots.length - baselineClosedLots.length
  const addedRealizedPnlUsd = previewRealizedPnlUsd !== null && baselineRealizedPnlUsd !== null
    ? previewRealizedPnlUsd - baselineRealizedPnlUsd : null

  // Identify added lots by finding lots not in baseline (by closedTxHash+contract pairing)
  const baselineTxContracts = new Set(baselineClosedLots.map(l => `${l.closedTxHash}|${l.tokenAddress}`))
  const addedLots = previewClosedLots.filter(l => !baselineTxContracts.has(`${l.closedTxHash}|${l.tokenAddress}`))

  const winningPreview = previewClosedLots.filter(l => l.realizedPnlUsd > BREAK_EVEN_EPSILON).length
  const losingPreview = previewClosedLots.filter(l => l.realizedPnlUsd < -BREAK_EVEN_EPSILON).length
  const breakEvenPreview = previewClosedLots.filter(l => Math.abs(l.realizedPnlUsd) <= BREAK_EVEN_EPSILON).length
  const uniqueTokensPreview = new Set(previewClosedLots.map(l => `${l.chain}:${l.tokenAddress}`)).size

  const n = previewClosedLots.length
  const previewConfidence: 'low' | 'medium' | 'high' = n >= 25 ? 'high' : n >= 10 ? 'medium' : 'low'

  // No current-price fallback used if all new priced items used stable/weth/historical sources
  const noCurrentPriceFallback = dedupedNewEvidence.every(e =>
    e.priceAtTime?.source !== 'current_price_fallback_not_used' && e.priceAtTime?.source !== 'unavailable'
  )

  const safeToPromoteToPublicStats =
    addedClosedLots > 0 &&
    previewClosedLots.length > baselineClosedLots.length &&
    previewRealizedPnlUsd !== null && isFinite(previewRealizedPnlUsd) &&
    unpricedHistoricalCandidates === 0 &&
    noCurrentPriceFallback

  const previewStatus: WalletSnapshot['walletHistoricalFifoPreviewSummary']['status'] =
    previewClosedLots.length === 0 ? 'open_check'
    : addedClosedLots === 0 ? 'partial'
    : 'ok'

  const missing: string[] = []
  if (addedClosedLots === 0) missing.push('no_additional_closed_lots')
  if (previewFifoSummary.unmatchedSells > 0) missing.push('unmatched_sells_in_preview')

  const sampleClosedLotFmt = (l: WalletClosedLot) => ({ tokenAddress: abbr(l.tokenAddress), symbol: l.tokenSymbol ?? '', openedAt: l.openedAt, closedAt: l.closedAt, entryPriceUsd: l.entryPriceUsd, exitPriceUsd: l.exitPriceUsd, realizedPnlUsd: l.realizedPnlUsd, confidence: l.confidence })

  return {
    summary: { status: previewStatus, requested: true, baselineClosedLots: baselineClosedLots.length, previewClosedLots: previewClosedLots.length, addedClosedLots, baselineRealizedPnlUsd, previewRealizedPnlUsd, addedRealizedPnlUsd, baselineRealizedPnlPercent, previewRealizedPnlPercent, winningClosedLotsPreview: winningPreview, losingClosedLotsPreview: losingPreview, breakEvenClosedLotsPreview: breakEvenPreview, uniqueTokensPreview, previewConfidence, readyForHistoricalTradeStatsPreview: previewClosedLots.length >= 1, safeToPromoteToPublicStats, missing, reason: addedClosedLots === 0 ? 'Historical candidates priced, but did not create additional matched closed lots.' : null },
    debug: { requested: true, baselinePricedEvents, newPricedHistoricalEvents, combinedPricedEvents: baselinePricedEvents + newPricedHistoricalEvents, baselineClosedLots: baselineClosedLots.length, previewClosedLots: previewClosedLots.length, addedClosedLots, baselineRealizedPnlUsd, previewRealizedPnlUsd, addedRealizedPnlUsd, winningClosedLotsPreview: winningPreview, losingClosedLotsPreview: losingPreview, breakEvenClosedLotsPreview: breakEvenPreview, unmatchedBuysPreview: previewFifoSummary.unmatchedBuys, unmatchedSellsPreview: previewFifoSummary.unmatchedSells, samplePreviewClosedLots: previewClosedLots.slice(0, 5).map(sampleClosedLotFmt), sampleAddedClosedLots: addedLots.slice(0, 5).map(sampleClosedLotFmt), skippedReasons: [], reasons: addedClosedLots > 0 ? ['preview_lots_added'] : ['no_additional_closed_lots'] },
    previewClosedLots,
  }
}

function buildTxEvidenceFromEvents(events: PnlEvent[], requested: boolean, providerUnavailable = false): {
  evidenceList: WalletTxEvidence[]
  summary: WalletSnapshot['walletEvidenceSummary']
  debug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletTxEvidenceDebug']>
} {
  if (!requested) {
    return {
      evidenceList: [],
      summary: { status: 'not_requested', totalEvents: 0, eventsWithHash: 0, eventsWithTimestamp: 0, hashCoverage: 0, timestampCoverage: 0, readyForSwapDetection: false, missing: ['deep_activity_not_requested'] },
      debug: { sourceProvider: 'none', totalRawEvents: 0, eventsWithHash: 0, eventsWithTimestamp: 0, sampleHashes: [], sampleTimestamps: [] },
    }
  }
  // PHASE1-FIX-1: real dedup of transfer legs, applied BEFORE swap detection runs (this
  // function's output feeds buildSwapDetection). Providers occasionally re-emit the same
  // on-chain transfer (log re-delivery, pagination overlap, multi-provider merge); without
  // this, the same leg is counted twice, inflating both swapCandidateEvents and downstream
  // FIFO volumes. Key on (txHash + contract + from + to + amountRaw); first occurrence wins.
  const _seenTransferKeys = new Set<string>()
  const _dedupedEvents = events.filter(e => {
    if (!e.txHash) return true
    const _key = `${e.txHash}:${(e.contract ?? '').toLowerCase()}:${(e.fromAddress ?? '').toLowerCase()}:${(e.toAddress ?? '').toLowerCase()}:${e.amountRaw ?? e.amount ?? ''}`
    if (_seenTransferKeys.has(_key)) return false
    _seenTransferKeys.add(_key)
    return true
  })
  const _duplicateTransfersRemoved = events.length - _dedupedEvents.length

  const evidenceList: WalletTxEvidence[] = _dedupedEvents
    .filter(e => Boolean(e.txHash))
    .map(e => {
      const txToLower = (e.txToAddress ?? '').toLowerCase()
      const routerMatch = KNOWN_DEX_ROUTERS[txToLower] ?? (EXTENDED_DEX_ROUTERS.has(txToLower) ? 'KnownDexRouter' : null)
      return {
        txHash: e.txHash!,
        timestamp: e.timestamp,
        fromAddress: e.fromAddress,
        toAddress: e.toAddress,
        contract: e.contract,
        symbol: e.symbol,
        amountRaw: e.amountRaw,
        tokenDecimals: e.tokenDecimals,
        amount: e.amount,
        usdValue: e.usdValue,
        direction: e.direction,
        chain: e.chain,
        txFromAddress: e.txFromAddress ?? null,
        txToAddress: e.txToAddress ?? null,
        txSucceeded: e.txSucceeded ?? null,
        txToKnownRouter: Boolean(routerMatch),
        txMatchedRouterProtocol: routerMatch,
      }
    })

  const totalEvents = _dedupedEvents.length
  const eventsWithHash = _dedupedEvents.filter(e => Boolean(e.txHash)).length
  const eventsWithTimestamp = _dedupedEvents.filter(e => Boolean(e.timestamp)).length
  const hashCoverage = totalEvents > 0 ? Math.round((eventsWithHash / totalEvents) * 100) : 0
  const timestampCoverage = totalEvents > 0 ? Math.round((eventsWithTimestamp / totalEvents) * 100) : 0
  const readyForSwapDetection = eventsWithHash > 0 && eventsWithTimestamp > 0

  const missing: string[] = []
  if (providerUnavailable && totalEvents === 0) {
    missing.push('activity_provider_unavailable')
  } else if (totalEvents === 0) {
    missing.push('no_transfer_events_indexed')
  } else {
    if (eventsWithHash < totalEvents) missing.push(`${totalEvents - eventsWithHash} events missing txHash`)
    if (eventsWithTimestamp < totalEvents) missing.push(`${totalEvents - eventsWithTimestamp} events missing timestamp`)
  }

  const status: WalletSnapshot['walletEvidenceSummary']['status'] =
    providerUnavailable && totalEvents === 0 ? 'provider_unavailable'
    : totalEvents === 0 ? 'no_events'
    : readyForSwapDetection ? 'ready'
    : eventsWithHash > 0 ? 'partial'
    : 'missing_hashes'

  const sourceProvider = _dedupedEvents.length > 0
    ? (_dedupedEvents[0].chain === 'base' && _dedupedEvents.some(e => Boolean(e.usdValue)) ? 'goldrush' : 'alchemy')
    : 'none'

  return {
    evidenceList,
    summary: { status, totalEvents, eventsWithHash, eventsWithTimestamp, hashCoverage, timestampCoverage, readyForSwapDetection, missing },
    debug: {
      sourceProvider: sourceProvider as 'goldrush' | 'alchemy' | 'none',
      totalRawEvents: events.length,
      duplicateTransfersRemoved: _duplicateTransfersRemoved,
      eventsWithHash,
      eventsWithTimestamp,
      sampleHashes: evidenceList.slice(0, 3).map(e => e.txHash),
      sampleTimestamps: evidenceList.slice(0, 3).map(e => e.timestamp ?? ''),
    },
  }
}

const UNKNOWN_REASON_BUCKETS: UnknownReasonBucket[] = [
  'unknown_direction', 'missing_wallet_side', 'missing_counterparty', 'router_not_detected',
  'no_quote_asset', 'failed_pairing', 'failed_stable_match', 'failed_weth_match',
  'failed_multi_token_match', 'failed_same_tx_match', 'pricing_unavailable', 'other',
]
function emptyUnknownReasonBucketCounts(): Record<UnknownReasonBucket, number> {
  return UNKNOWN_REASON_BUCKETS.reduce((acc, k) => { acc[k] = 0; return acc }, {} as Record<UnknownReasonBucket, number>)
}

function buildSwapDetection(evidenceList: WalletTxEvidence[], activityRequested: boolean, walletAddress: string): {
  evidenceWithDetection: WalletTxEvidence[]
  summary: WalletSnapshot['walletSwapSummary']
  debug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletSwapDetectionDebug']>
} {
  const walletLower = walletAddress.toLowerCase()
  const emptyDebug = (): NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletSwapDetectionDebug']> => ({
    totalEvidenceEvents: 0, usableEventCount: 0, groupedTxCount: 0, txWithMultipleTokenMovements: 0,
    txWithInboundOutboundMovement: 0, txToKnownRouterCount: 0, walletInitiatedTxCount: 0,
    walletInitiatedSwapLikeTxCount: 0, knownRouterMatchCount: 0, stableOrWethLegMatchCount: 0,
    swapCandidateEvents: 0, routerSwapCandidateEvents: 0, walletInitiatedSwapCandidateEvents: 0,
    sameTxInboundOutboundCandidates: 0, highConfidenceSwapCandidates: 0, mediumConfidenceSwapCandidates: 0,
    lowConfidenceSwapCandidates: 0, transferEvents: 0, airdropCandidateEvents: 0,
    bridgeCandidateEvents: 0, unknownEvents: 0, readyForPriceAtTime: false,
    directionCounts: { inbound: 0, outbound: 0, unknown: 0 },
    unknownReasonCounts: {},
    eventsMissingTokenAddress: 0, eventsMissingTxHash: 0, eventsMissingTimestamp: 0,
    eventsMissingFromTo: 0, duplicateEventCount: 0, zeroAmountEventCount: 0,
    sampleSwapCandidates: [], sampleUnknowns: [], sampleRouterMatches: [],
    sampleWalletInitiatedSwapLikeTxs: [], sampleGroupedTxs: [], reasons: [],
    unknownRouterEvents: 0, unknownDirectionEvents: 0, unknownCounterpartyEvents: 0,
    unknownPairingEvents: 0, unknownPricingEvents: 0,
    unknownReasonBucketCounts: emptyUnknownReasonBucketCounts(),
    unknownReasonBucketBreakdown: UNKNOWN_REASON_BUCKETS.map(bucket => ({ bucket, count: 0, distinctTxCount: 0, distinctTokenCount: 0 })),
    topUnknownReasonByCount: null, topUnknownReasonByTxCount: null, topUnknownReasonByTokenCount: null,
    reconstructedUnknownDirectionEvents: 0, reconstructedWalletSideUnknownEvents: 0,
    unknownDirectionUsedAsContextOnly: 0, unknownDirectionPromotedToSwapCandidate: 0,
    unknownDirectionRejectedNoWalletSide: 0, unknownDirectionRejectedLowConfidence: 0,
    sampleReconstructedUnknownDirectionEvents: [], sampleContextOnlyUnknownDirectionEvents: [],
    unknownTxToAddressCounts: {}, topUnknownTxToAddresses: [], topUnknownTxToAddressesWithSwapLikeContext: [],
  })
  const emptySummary = (missing: string[]): WalletSnapshot['walletSwapSummary'] => ({
    status: 'open_check', totalEvidenceEvents: 0, groupedTxCount: 0, swapCandidateEvents: 0,
    routerSwapCandidateEvents: 0, walletInitiatedSwapCandidateEvents: 0,
    sameTxInboundOutboundCandidates: 0,
    highConfidenceSwapCandidates: 0, mediumConfidenceSwapCandidates: 0, lowConfidenceSwapCandidates: 0,
    transferEvents: 0, airdropCandidateEvents: 0, bridgeCandidateEvents: 0, unknownEvents: 0,
    readyForPriceAtTime: false, missing,
  })

  if (!activityRequested) {
    return { evidenceWithDetection: [], summary: emptySummary(['deep_activity_not_requested']), debug: emptyDebug() }
  }

  if (evidenceList.length === 0) {
    return { evidenceWithDetection: [], summary: emptySummary(['no_evidence_events']), debug: emptyDebug() }
  }

  // ── Diagnostic counts on the full evidence list ──
  const totalEvidenceEvents = evidenceList.length
  const directionCounts = {
    inbound: evidenceList.filter(e => e.direction === 'buy').length,
    outbound: evidenceList.filter(e => e.direction === 'sell').length,
    unknown: evidenceList.filter(e => e.direction === 'unknown').length,
  }
  const eventsMissingTokenAddress = evidenceList.filter(e => !e.contract || !e.contract.startsWith('0x')).length
  const eventsMissingTxHash = evidenceList.filter(e => !e.txHash).length
  const eventsMissingTimestamp = evidenceList.filter(e => !e.timestamp).length
  const eventsMissingFromTo = evidenceList.filter(e => !e.fromAddress && !e.toAddress).length
  const zeroAmountEventCount = evidenceList.filter(e => !e.amount || e.amount <= 0).length

  // Deduplicate check: same txHash + contract + direction + amountRaw
  const dedupSeen = new Set<string>()
  let duplicateEventCount = 0
  for (const e of evidenceList) {
    const key = `${e.txHash}:${e.contract}:${e.direction}:${e.amountRaw ?? '0'}`
    if (dedupSeen.has(key)) duplicateEventCount++
    else dedupSeen.add(key)
  }

  // ── Filter to directly usable events for pricing/FIFO and context-only events for tx reconstruction ──
  // Unknown-direction events remain excluded from direct pricing/FIFO, but can provide tx-level context.
  const usableEvents = evidenceList.filter(e =>
    e.direction !== 'unknown' &&
    Boolean(e.contract) && e.contract.startsWith('0x') &&
    e.amount > 0
  )
  const contextEvents = evidenceList.filter(e =>
    Boolean(e.contract) && e.contract.startsWith('0x') &&
    e.amount > 0
  )
  const usableEventCount = usableEvents.length

  // ── Group context-capable events by txHash ──
  const byTx = new Map<string, WalletTxEvidence[]>()
  for (const e of contextEvents) {
    byTx.set(e.txHash, [...(byTx.get(e.txHash) ?? []), e])
  }

  // Also build a full-events-per-tx map for sampleGroupedTxs totals
  const allByTx = new Map<string, WalletTxEvidence[]>()
  for (const e of evidenceList) {
    allByTx.set(e.txHash, [...(allByTx.get(e.txHash) ?? []), e])
  }

  // ── Build per-tx context map (router, initiator) from usable groups ──
  type TxCtx = {
    txToAddr: string | null
    txFromAddr: string | null
    txRouterProtocol: string | null
    txToKnownRouter: boolean
    walletIsInitiator: boolean
    hasBuy: boolean
    hasSell: boolean
    hasInboundOutbound: boolean
    txHasStableOrWeth: boolean
    distinctContracts: Set<string>
    hasMultipleDistinctTokens: boolean
    group: WalletTxEvidence[]
  }
  // PHASE1-FIX-2: router/initiator majority vote. txTo/txFrom are tx-level metadata that
  // should be identical for every leg of the same txHash, but multi-page/multi-provider
  // merges can attach a stale or mismatched value to one leg depending on arrival order.
  // Picking group[0] made router validation depend on which leg happened to land first.
  // Instead take the majority (mode) value across the whole group — for router this is the
  // most frequent router-like txTo address, for initiator the most frequent txFrom address —
  // so a single outlier leg can't flip which router (or no router) gets credited.
  const _modeOf = (vals: Array<string | null>): string | null => {
    const counts = new Map<string, number>()
    for (const v of vals) { if (v) counts.set(v, (counts.get(v) ?? 0) + 1) }
    let best: string | null = null
    let bestCount = 0
    for (const [v, c] of counts.entries()) { if (c > bestCount) { best = v; bestCount = c } }
    return best
  }
  const txCtxMap = new Map<string, TxCtx>()
  for (const [txHash, group] of byTx.entries()) {
    const txToAddr = _modeOf(group.map(g => g.txToAddress?.toLowerCase() ?? null))
    const txFromAddr = _modeOf(group.map(g => g.txFromAddress?.toLowerCase() ?? null))
    // PHASE1-FIX-3: fall back to EXTENDED_DEX_ROUTERS (Balancer, Curve, SushiSwap, Paraswap,
    // Permit2, LI.FI Diamond, additional Uniswap/1inch/0x addresses) for any address known
    // elsewhere in this file but not yet given a friendly name in KNOWN_DEX_ROUTERS, so
    // Base wallet-side swap classification sees every verified router this file knows about.
    const txRouterProtocol = txToAddr
      ? (KNOWN_DEX_ROUTERS[txToAddr] ?? (EXTENDED_DEX_ROUTERS.has(txToAddr) ? 'KnownDexRouter' : null))
      : null
    const txToKnownRouter = Boolean(txRouterProtocol)
    const walletIsInitiator = Boolean(txFromAddr && txFromAddr === walletLower)
    const hasBuy = group.some(t => t.direction === 'buy')
    const hasSell = group.some(t => t.direction === 'sell')
    const hasInboundOutbound = hasBuy && hasSell
    const txHasStableOrWeth = group.some(t => Boolean(KNOWN_STABLE_WETH_CONTRACTS[t.contract?.toLowerCase() ?? '']))
    const distinctContracts = new Set(group.map(e => e.contract?.toLowerCase() ?? '').filter(Boolean))
    const hasMultipleDistinctTokens = distinctContracts.size > 1
    txCtxMap.set(txHash, { txToAddr, txFromAddr, txRouterProtocol, txToKnownRouter, walletIsInitiator, hasBuy, hasSell, hasInboundOutbound, txHasStableOrWeth, distinctContracts, hasMultipleDistinctTokens, group })
  }

  // ── TX-level diagnostics (from usable groups) ──
  let txWithMultipleTokenMovements = 0
  let txWithInboundOutboundMovement = 0
  let txToKnownRouterCount = 0
  let walletInitiatedTxCount = 0
  let walletInitiatedSwapLikeTxCount = 0
  let knownRouterMatchCount = 0
  let stableOrWethLegMatchCount = 0
  for (const ctx of txCtxMap.values()) {
    if (ctx.group.length > 1) txWithMultipleTokenMovements++
    if (ctx.hasInboundOutbound) txWithInboundOutboundMovement++
    if (ctx.txToKnownRouter) { txToKnownRouterCount++; knownRouterMatchCount++ }
    if (ctx.walletIsInitiator) walletInitiatedTxCount++
    if (ctx.walletIsInitiator && ctx.hasMultipleDistinctTokens && (ctx.hasBuy || ctx.hasSell)) walletInitiatedSwapLikeTxCount++
    if (ctx.txHasStableOrWeth) stableOrWethLegMatchCount++
  }

  // ── Classify ALL events ──
  let routerSwapCandidateEventsCount = 0
  let walletInitiatedSwapCandidateEventsCount = 0
  let sameTxInboundOutboundCandidatesCount = 0
  const sampleRouterMatches: Array<{ txHash: string; protocol: string; walletIsInitiator: boolean; tokens: string[] }> = []
  const sampleWalletInitiatedSwapLikeTxsMap = new Map<string, { txHash: string; inboundCount: number; outboundCount: number; tokens: string[]; hasStableOrWeth: boolean }>()

  // ── Direction Reconstruction V2 counters (debug-only; see walletSwapDetectionDebug) ──
  let reconstructedUnknownDirectionEventsCount = 0
  let reconstructedWalletSideUnknownEventsCount = 0
  let unknownDirectionUsedAsContextOnlyCount = 0
  let unknownDirectionPromotedToSwapCandidateCount = 0
  let unknownDirectionRejectedNoWalletSideCount = 0
  let unknownDirectionRejectedLowConfidenceCount = 0
  const sampleReconstructedUnknownDirectionEvents: WalletTxEvidence[] = []
  const sampleContextOnlyUnknownDirectionEvents: WalletTxEvidence[] = []
  const inferWalletSideDirection = (event: WalletTxEvidence): 'buy' | 'sell' | null => {
    const fromLower = event.fromAddress?.toLowerCase() ?? null
    const toLower = event.toAddress?.toLowerCase() ?? null
    if (fromLower === walletLower) return 'sell'
    if (toLower === walletLower) return 'buy'
    return null
  }
  // Unverified txTo addresses seen on unknown-direction events — never added to
  // KNOWN_DEX_ROUTERS without independent verification (see Task B).
  const unknownTxToAddressCounts = new Map<string, number>()
  const unknownTxToAddressSwapLikeContextCounts = new Map<string, number>()

  const evidenceWithDetection: WalletTxEvidence[] = evidenceList.map(e => {
    // Unknown-direction events: attempt Direction Reconstruction V2 using existing tx context
    // only (no new provider calls). Promotion to a swap candidate requires PROVEN wallet-side
    // direction (event's own fromAddress/toAddress matches the scanned wallet) AND either a
    // known router match or a same-tx opposite leg with a genuine stable/WETH quote leg.
    // Anything weaker stays out of FIFO — it can only ever improve tx-level context.
    if (e.direction === 'unknown') {
      const ctx = txCtxMap.get(e.txHash)
      const contractLower = e.contract?.toLowerCase() ?? ''
      const isQuote = Boolean(KNOWN_STABLE_WETH_CONTRACTS[contractLower])
      const hasNonQuote = Boolean(ctx && [...ctx.distinctContracts].some(c => !KNOWN_STABLE_WETH_CONTRACTS[c]))

      // Track unverified txTo addresses seen on unknown-direction events (Task B — debug-only,
      // never used to label or to add anything to KNOWN_DEX_ROUTERS without verification).
      if (ctx?.txToAddr && !ctx.txToKnownRouter) {
        unknownTxToAddressCounts.set(ctx.txToAddr, (unknownTxToAddressCounts.get(ctx.txToAddr) ?? 0) + 1)
        if (ctx.hasInboundOutbound || ctx.hasMultipleDistinctTokens || ctx.txHasStableOrWeth) {
          unknownTxToAddressSwapLikeContextCounts.set(ctx.txToAddr, (unknownTxToAddressSwapLikeContextCounts.get(ctx.txToAddr) ?? 0) + 1)
        }
      }

      // ── Direction Reconstruction V2 ──
      // Use the event's OWN fromAddress/toAddress (not the tx-level initiator) to prove
      // wallet-side direction directly. This is existing tx context already present on every
      // event — no new provider calls.
      const reconstructedDirection = inferWalletSideDirection(e)

      if (reconstructedDirection === null) {
        // Not provably wallet-side — keep out of FIFO entirely, but it already improved tx
        // context (grouping, router/quote-leg detection) via contextEvents/txCtxMap above.
        unknownDirectionRejectedNoWalletSideCount++
        unknownDirectionUsedAsContextOnlyCount++
        const contextOnlyEvent = { ...e, swapDetection: { isSwapCandidate: false, confidence: 'low' as const, eventKind: 'unknown' as const, reason: 'Transfer does not involve scanned wallet directly (pool-to-pool or third-party); retained as tx reconstruction context only', matchedProtocol: ctx?.txRouterProtocol ?? null, matchedAddress: ctx?.txToAddr ?? null, swapReconstructionConfidence: ctx?.txToKnownRouter || ctx?.txHasStableOrWeth || ctx?.hasInboundOutbound ? 'medium' as const : 'low' as const } }
        if (sampleContextOnlyUnknownDirectionEvents.length < 5) sampleContextOnlyUnknownDirectionEvents.push(contextOnlyEvent)
        return contextOnlyEvent
      }

      reconstructedUnknownDirectionEventsCount++
      const validAmount = Boolean(e.amount && e.amount > 0)
      const validContract = Boolean(e.contract && e.contract.startsWith('0x'))
      const hasOppositeLeg = Boolean(ctx && (reconstructedDirection === 'buy' ? ctx.hasSell : ctx.hasBuy))
      const strongRouterMatch = Boolean(ctx?.txToKnownRouter)
      const strongPairingMatch = Boolean(ctx && hasOppositeLeg && ctx.txHasStableOrWeth && ctx.hasMultipleDistinctTokens && (isQuote ? hasNonQuote : true))

      if (validAmount && validContract && (strongRouterMatch || strongPairingMatch)) {
        reconstructedWalletSideUnknownEventsCount++
        unknownDirectionPromotedToSwapCandidateCount++
        const matchedProtocol = strongRouterMatch ? (ctx!.txRouterProtocol) : (KNOWN_STABLE_WETH_CONTRACTS[contractLower] ?? null)
        const promotedEvent = {
          ...e, direction: reconstructedDirection,
          swapDetection: {
            isSwapCandidate: true, confidence: 'high' as const, eventKind: 'swap_candidate' as const,
            reason: strongRouterMatch
              ? `Direction reconstructed from wallet-side transfer participant + known router (${ctx!.txRouterProtocol})`
              : 'Direction reconstructed from wallet-side transfer participant + same-tx opposite leg with stable/WETH quote leg',
            matchedProtocol, matchedAddress: ctx?.txToAddr ?? null,
            swapReconstructionConfidence: 'high' as const,
          },
        }
        if (sampleReconstructedUnknownDirectionEvents.length < 5) sampleReconstructedUnknownDirectionEvents.push(promotedEvent)
        return promotedEvent
      }

      // Wallet-side direction is proven, but pairing/router evidence is too weak to promote —
      // per the hard limit, never push this into FIFO. Direction is reconstructed (useful for
      // tx context and future audits) but the event stays classified as unknown.
      reconstructedWalletSideUnknownEventsCount++
      unknownDirectionRejectedLowConfidenceCount++
      const reconstructedContextEvent = {
        ...e, direction: reconstructedDirection,
        swapDetection: {
          isSwapCandidate: false, confidence: 'low' as const, eventKind: 'unknown' as const,
          reason: 'Wallet-side direction reconstructed from transfer participant, but insufficient pairing/router evidence to promote to swap candidate',
          matchedProtocol: ctx?.txRouterProtocol ?? null, matchedAddress: ctx?.txToAddr ?? null,
          swapReconstructionConfidence: 'medium' as const,
        },
      }
      if (sampleReconstructedUnknownDirectionEvents.length < 5) sampleReconstructedUnknownDirectionEvents.push(reconstructedContextEvent)
      if (sampleContextOnlyUnknownDirectionEvents.length < 5) sampleContextOnlyUnknownDirectionEvents.push(reconstructedContextEvent)
      return reconstructedContextEvent
    }
    if (!e.amount || e.amount <= 0) {
      return { ...e, swapDetection: { isSwapCandidate: false, confidence: 'low' as const, eventKind: 'unknown' as const, reason: 'Zero or negligible amount — likely spam or dust transfer', matchedProtocol: null, matchedAddress: null } }
    }
    if (!e.contract || !e.contract.startsWith('0x')) {
      return { ...e, swapDetection: { isSwapCandidate: false, confidence: 'low' as const, eventKind: 'unknown' as const, reason: 'Missing token contract address', matchedProtocol: null, matchedAddress: null } }
    }

    const ctx = txCtxMap.get(e.txHash)
    if (!ctx) {
      return { ...e, swapDetection: { isSwapCandidate: false, confidence: 'low' as const, eventKind: 'unknown' as const, reason: 'No tx group context available', matchedProtocol: null, matchedAddress: null } }
    }

    const { txToKnownRouter, txRouterProtocol, walletIsInitiator, hasInboundOutbound, txHasStableOrWeth, hasMultipleDistinctTokens, hasBuy, hasSell } = ctx
    const thisContractLabel = KNOWN_STABLE_WETH_CONTRACTS[e.contract?.toLowerCase() ?? ''] ?? null

    let detection: WalletSwapDetection

    if (txToKnownRouter && walletIsInitiator) {
      // High confidence: wallet called a known swap router directly
      detection = {
        isSwapCandidate: true, confidence: 'high', eventKind: 'swap_candidate',
        reason: `Wallet transaction called known swap router (${txRouterProtocol})`,
        matchedProtocol: txRouterProtocol, matchedAddress: ctx.txToAddr,
      }
      routerSwapCandidateEventsCount++
      if (sampleRouterMatches.length < 5) {
        sampleRouterMatches.push({ txHash: e.txHash, protocol: txRouterProtocol!, walletIsInitiator: true, tokens: [...ctx.distinctContracts].slice(0, 5) })
      }
    } else if (txToKnownRouter && !walletIsInitiator) {
      // Medium confidence: known router was involved but wallet didn't initiate
      detection = {
        isSwapCandidate: true, confidence: 'medium', eventKind: 'swap_candidate',
        reason: `Known swap router involved in transaction (${txRouterProtocol}) — wallet not initiator`,
        matchedProtocol: txRouterProtocol, matchedAddress: ctx.txToAddr,
      }
      routerSwapCandidateEventsCount++
      if (sampleRouterMatches.length < 5) {
        sampleRouterMatches.push({ txHash: e.txHash, protocol: txRouterProtocol!, walletIsInitiator: false, tokens: [...ctx.distinctContracts].slice(0, 5) })
      }
    } else if (hasInboundOutbound && txHasStableOrWeth) {
      detection = { isSwapCandidate: true, confidence: 'medium', eventKind: 'swap_candidate', reason: 'Inbound+outbound in same tx with stable/WETH leg', matchedProtocol: thisContractLabel, matchedAddress: e.contract?.toLowerCase() ?? null }
      sameTxInboundOutboundCandidatesCount++
    } else if (hasInboundOutbound && hasMultipleDistinctTokens) {
      detection = { isSwapCandidate: true, confidence: 'medium', eventKind: 'swap_candidate', reason: 'Inbound+outbound token transfers in same tx', matchedProtocol: null, matchedAddress: null }
      sameTxInboundOutboundCandidatesCount++
    } else if (hasInboundOutbound) {
      // Same-token round-trip (e.g. rebasing/self-routing): same contract both in+out, no quote leg — not a swap
      detection = { isSwapCandidate: false, confidence: 'low', eventKind: 'unknown', reason: 'Inbound+outbound same contract with no quote leg — self-routing or rebasing', matchedProtocol: null, matchedAddress: null }
    } else if (walletIsInitiator && hasMultipleDistinctTokens && (hasBuy || hasSell) && txHasStableOrWeth) {
      // Medium confidence: wallet-initiated multi-token tx with stable/WETH — likely swap via aggregator or indirect router
      detection = {
        isSwapCandidate: true, confidence: 'medium', eventKind: 'swap_candidate',
        reason: 'Wallet-initiated transaction with multi-token movement including stable/WETH — swap-like pattern',
        matchedProtocol: thisContractLabel, matchedAddress: e.contract?.toLowerCase() ?? null,
      }
      walletInitiatedSwapCandidateEventsCount++
      if (!sampleWalletInitiatedSwapLikeTxsMap.has(e.txHash) && sampleWalletInitiatedSwapLikeTxsMap.size < 5) {
        sampleWalletInitiatedSwapLikeTxsMap.set(e.txHash, {
          txHash: e.txHash,
          inboundCount: ctx.group.filter(ev => ev.direction === 'buy').length,
          outboundCount: ctx.group.filter(ev => ev.direction === 'sell').length,
          tokens: [...ctx.distinctContracts].slice(0, 5),
          hasStableOrWeth: ctx.txHasStableOrWeth,
        })
      }
    } else if (e.direction === 'buy' && !hasSell) {
      detection = { isSwapCandidate: false, confidence: 'low', eventKind: 'airdrop_candidate', reason: 'Inbound-only transfer — no matching wallet-side outbound in tx', matchedProtocol: null, matchedAddress: null }
    } else if (e.direction === 'sell' && !hasBuy) {
      detection = { isSwapCandidate: false, confidence: 'low', eventKind: 'transfer', reason: 'Outbound-only transfer — no matching wallet-side inbound in tx', matchedProtocol: null, matchedAddress: null }
    } else {
      detection = { isSwapCandidate: false, confidence: 'low', eventKind: 'unknown', reason: 'Wallet-side transfer but no swap pattern detected', matchedProtocol: null, matchedAddress: null }
    }

    return { ...e, swapDetection: detection }
  })

  // ── Result counts ──
  const swapCandidateEvents = evidenceWithDetection.filter(e => e.swapDetection?.isSwapCandidate).length
  const routerSwapCandidateEvents = routerSwapCandidateEventsCount
  const walletInitiatedSwapCandidateEvents = walletInitiatedSwapCandidateEventsCount
  const sameTxInboundOutboundCandidates = sameTxInboundOutboundCandidatesCount
  const highConfidenceSwapCandidates = evidenceWithDetection.filter(e => e.swapDetection?.isSwapCandidate && e.swapDetection.confidence === 'high').length
  const mediumConfidenceSwapCandidates = evidenceWithDetection.filter(e => e.swapDetection?.isSwapCandidate && e.swapDetection.confidence === 'medium').length
  const lowConfidenceSwapCandidates = evidenceWithDetection.filter(e => e.swapDetection?.isSwapCandidate && e.swapDetection.confidence === 'low').length
  const transferEvents = evidenceWithDetection.filter(e => e.swapDetection?.eventKind === 'transfer').length
  const airdropCandidateEvents = evidenceWithDetection.filter(e => e.swapDetection?.eventKind === 'airdrop_candidate').length
  const bridgeCandidateEvents = evidenceWithDetection.filter(e => e.swapDetection?.eventKind === 'bridge_candidate').length
  const unknownEvents = evidenceWithDetection.filter(e => e.swapDetection?.eventKind === 'unknown').length
  const readyForPriceAtTime = swapCandidateEvents > 0 && evidenceWithDetection.some(e => e.swapDetection?.isSwapCandidate && Boolean(e.timestamp))
  const groupedTxCount = byTx.size
  const status: 'ok' | 'partial' | 'open_check' = swapCandidateEvents > 0 ? 'ok' : totalEvidenceEvents > 0 ? 'partial' : 'open_check'
  const missing: string[] = []
  if (swapCandidateEvents === 0 && totalEvidenceEvents > 0) missing.push('no_swap_candidates_detected')

  // ── Unknown reason breakdown ──
  const unknownReasonCounts: Record<string, number> = {}
  if (directionCounts.unknown > 0) unknownReasonCounts['not_wallet_side_transfer'] = directionCounts.unknown
  if (zeroAmountEventCount > 0) unknownReasonCounts['zero_amount'] = zeroAmountEventCount
  if (eventsMissingTokenAddress > 0) unknownReasonCounts['missing_contract'] = eventsMissingTokenAddress
  const walletSideUnclassified = evidenceWithDetection.filter(e => e.swapDetection?.eventKind === 'unknown' && e.direction !== 'unknown' && e.amount > 0).length
  if (walletSideUnclassified > 0) unknownReasonCounts['wallet_side_no_swap_pattern'] = walletSideUnclassified

  // ── TEMPORARY DEBUG (router-coverage / unknown-events audit) ──
  // Breaks unknownEvents down by which exclusion stage produced it, so a future router/
  // direction-resolution fix can be targeted at the highest-volume cause instead of guessing.
  const unknownDirectionEvents = directionCounts.unknown
  const unknownCounterpartyEvents = eventsMissingFromTo
  // Direction resolved + tx grouped, but no known router matched this tx's `to` address.
  const unknownRouterEvents = evidenceWithDetection.filter(e =>
    e.swapDetection?.eventKind === 'unknown' && e.direction !== 'unknown' &&
    !(txCtxMap.get(e.txHash)?.txToKnownRouter)).length
  // Direction resolved, tx grouped, but no opposite-direction leg in the same tx to pair against.
  const unknownPairingEvents = evidenceWithDetection.filter(e =>
    e.swapDetection?.eventKind === 'unknown' && e.direction !== 'unknown' &&
    !(txCtxMap.get(e.txHash)?.hasInboundOutbound)).length
  // Swap candidates that exist but have no timestamp, so price-at-time lookup downstream cannot run.
  const unknownPricingEvents = evidenceWithDetection.filter(e =>
    e.swapDetection?.isSwapCandidate && !e.timestamp).length

  const walletSwapReconstructionAudit = {
    unknownEventsSeen: directionCounts.unknown,
    unknownEventsUsedForContext: contextEvents.filter(e => e.direction === 'unknown' && Boolean(txCtxMap.get(e.txHash))).length,
    reconstructedCandidates: evidenceWithDetection.filter(e => e.swapDetection?.isSwapCandidate && e.swapDetection.swapReconstructionConfidence).length,
    reconstructedHighConfidence: evidenceWithDetection.filter(e => e.swapDetection?.swapReconstructionConfidence === 'high').length,
    routerMatchedTransactions: txToKnownRouterCount,
    routerCoverageProtocols: [...new Set([...txCtxMap.values()].map(ctx => ctx.txRouterProtocol).filter((p): p is string => Boolean(p)))].sort(),
  }

  // ── Unknown-event reason-bucket breakdown (debug-only diagnostics) ──
  // Assigns exactly one bucket per eventKind='unknown' event, in priority order, to explain
  // which specific structural condition kept it out of swap-candidate classification. This is
  // read-only instrumentation over the already-computed evidenceWithDetection/txCtxMap — it
  // does not alter classification, FIFO, or pricing in any way.
  function classifyUnknownReasonBucket(e: WalletTxEvidence): UnknownReasonBucket {
    if (e.direction === 'unknown') return 'unknown_direction'
    if (!e.fromAddress && !e.toAddress) return 'missing_wallet_side'
    const ctx = txCtxMap.get(e.txHash)
    if (!ctx || !ctx.txToAddr) return 'missing_counterparty'
    if (!ctx.hasInboundOutbound) return 'failed_pairing'
    if (!ctx.hasMultipleDistinctTokens) return 'failed_multi_token_match'
    const hasStable = [...ctx.distinctContracts].some(c => {
      const label = KNOWN_STABLE_WETH_CONTRACTS[c] ?? ''
      return label.startsWith('USDC') || label.startsWith('USDT') || label.startsWith('DAI')
    })
    const hasWeth = [...ctx.distinctContracts].some(c => (KNOWN_STABLE_WETH_CONTRACTS[c] ?? '').startsWith('WETH'))
    if (!hasStable && !hasWeth) return 'no_quote_asset'
    if (hasWeth && !hasStable) return 'failed_stable_match'
    if (hasStable && !hasWeth) return 'failed_weth_match'
    if (!ctx.txToKnownRouter) return 'router_not_detected'
    return 'failed_same_tx_match'
  }

  const unknownEventsForBuckets = evidenceWithDetection.filter(e => e.swapDetection?.eventKind === 'unknown')
  const unknownReasonBucketCounts = emptyUnknownReasonBucketCounts()
  const unknownReasonBucketTxSets: Record<UnknownReasonBucket, Set<string>> = UNKNOWN_REASON_BUCKETS.reduce((acc, k) => { acc[k] = new Set<string>(); return acc }, {} as Record<UnknownReasonBucket, Set<string>>)
  const unknownReasonBucketTokenSets: Record<UnknownReasonBucket, Set<string>> = UNKNOWN_REASON_BUCKETS.reduce((acc, k) => { acc[k] = new Set<string>(); return acc }, {} as Record<UnknownReasonBucket, Set<string>>)
  for (const e of unknownEventsForBuckets) {
    const bucket = classifyUnknownReasonBucket(e)
    unknownReasonBucketCounts[bucket]++
    if (e.txHash) unknownReasonBucketTxSets[bucket].add(e.txHash)
    if (e.contract) unknownReasonBucketTokenSets[bucket].add(e.contract.toLowerCase())
  }
  // pricing_unavailable describes priced-swap-candidate events missing a timestamp (cannot
  // price-at-time) — a different population than eventKind='unknown' — kept as its own bucket
  // for parity with the requested list; always 0 within the per-unknown-event loop above.
  unknownReasonBucketCounts.pricing_unavailable = evidenceWithDetection.filter(e => e.swapDetection?.isSwapCandidate && !e.timestamp).length

  const unknownReasonBucketBreakdown = UNKNOWN_REASON_BUCKETS.map(bucket => ({
    bucket,
    count: unknownReasonBucketCounts[bucket],
    distinctTxCount: unknownReasonBucketTxSets[bucket].size,
    distinctTokenCount: unknownReasonBucketTokenSets[bucket].size,
  }))
  const topUnknownReasonByCount = [...unknownReasonBucketBreakdown].sort((a, b) => b.count - a.count)[0] ?? null
  const topUnknownReasonByTxCount = [...unknownReasonBucketBreakdown].sort((a, b) => b.distinctTxCount - a.distinctTxCount)[0] ?? null
  const topUnknownReasonByTokenCount = [...unknownReasonBucketBreakdown].sort((a, b) => b.distinctTokenCount - a.distinctTokenCount)[0] ?? null

  // ── Task B: unverified txTo addresses seen on unknown-direction events (debug-only) ──
  const topUnknownTxToAddresses = [...unknownTxToAddressCounts.entries()]
    .map(([address, count]) => ({ address, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
  const topUnknownTxToAddressesWithSwapLikeContext = [...unknownTxToAddressSwapLikeContextCounts.entries()]
    .map(([address, count]) => ({ address, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  // ── Sample grouped txs (from context groups) ──
  const sampleGroupedTxs = Array.from(byTx.entries()).slice(0, 5).map(([txHash, group]) => ({
    txHash: `${txHash.slice(0, 10)}...${txHash.slice(-6)}`,
    walletEventCount: group.length,
    totalEventCount: allByTx.get(txHash)?.length ?? group.length,
    inboundCount: group.filter(e => e.direction === 'buy').length,
    outboundCount: group.filter(e => e.direction === 'sell').length,
    tokens: [...new Set(group.map(e => e.symbol))].slice(0, 5),
  }))

  return {
    evidenceWithDetection,
    summary: {
      status, totalEvidenceEvents, groupedTxCount, swapCandidateEvents,
      routerSwapCandidateEvents, walletInitiatedSwapCandidateEvents, sameTxInboundOutboundCandidates,
      highConfidenceSwapCandidates, mediumConfidenceSwapCandidates, lowConfidenceSwapCandidates,
      transferEvents, airdropCandidateEvents, bridgeCandidateEvents, unknownEvents,
      readyForPriceAtTime, missing,
    },
    debug: {
      totalEvidenceEvents, usableEventCount, groupedTxCount,
      txWithMultipleTokenMovements, txWithInboundOutboundMovement,
      txToKnownRouterCount, walletInitiatedTxCount, walletInitiatedSwapLikeTxCount,
      knownRouterMatchCount, stableOrWethLegMatchCount,
      swapCandidateEvents, routerSwapCandidateEvents, walletInitiatedSwapCandidateEvents, sameTxInboundOutboundCandidates,
      highConfidenceSwapCandidates, mediumConfidenceSwapCandidates, lowConfidenceSwapCandidates,
      transferEvents, airdropCandidateEvents, bridgeCandidateEvents, unknownEvents, readyForPriceAtTime,
      directionCounts, unknownReasonCounts,
      eventsMissingTokenAddress, eventsMissingTxHash, eventsMissingTimestamp,
      eventsMissingFromTo, duplicateEventCount, zeroAmountEventCount,
      sampleSwapCandidates: evidenceWithDetection.filter(e => e.swapDetection?.isSwapCandidate).slice(0, 5),
      sampleUnknowns: evidenceWithDetection.filter(e => e.swapDetection?.eventKind === 'unknown' && e.direction !== 'unknown').slice(0, 5),
      sampleRouterMatches: sampleRouterMatches.slice(0, 5),
      sampleWalletInitiatedSwapLikeTxs: Array.from(sampleWalletInitiatedSwapLikeTxsMap.values()).slice(0, 5),
      sampleGroupedTxs,
      unknownRouterEvents, unknownDirectionEvents, unknownCounterpartyEvents,
      unknownPairingEvents, unknownPricingEvents,
      unknownReasonBucketCounts, unknownReasonBucketBreakdown,
      topUnknownReasonByCount, topUnknownReasonByTxCount, topUnknownReasonByTokenCount,
      reconstructedUnknownDirectionEvents: reconstructedUnknownDirectionEventsCount,
      reconstructedWalletSideUnknownEvents: reconstructedWalletSideUnknownEventsCount,
      unknownDirectionUsedAsContextOnly: unknownDirectionUsedAsContextOnlyCount,
      unknownDirectionPromotedToSwapCandidate: unknownDirectionPromotedToSwapCandidateCount,
      unknownDirectionRejectedNoWalletSide: unknownDirectionRejectedNoWalletSideCount,
      unknownDirectionRejectedLowConfidence: unknownDirectionRejectedLowConfidenceCount,
      sampleReconstructedUnknownDirectionEvents,
      sampleContextOnlyUnknownDirectionEvents,
      unknownTxToAddressCounts: Object.fromEntries(unknownTxToAddressCounts),
      topUnknownTxToAddresses, topUnknownTxToAddressesWithSwapLikeContext,
      reasons: [],
    },
  }
}

function confidenceFromCoverage(c: number): 'high' | 'medium' | 'low' { return c >= 85 ? 'high' : c >= 60 ? 'medium' : 'low' }

// All contracts that are quote/USD-side assets — not tracked as the target PnL token
const QUOTE_ASSET_CONTRACTS: Record<string, true> = {
  ...STABLE_USD_CONTRACTS,
  ...WETH_CONTRACTS_PRICE,
}

// Normalize provider-specific chain identifiers to canonical short names for lot key stability.
// GoldRush emits 'base-mainnet' or '8453'; Alchemy emits 'base'; all map to 'base'.
function normalizeChain(chain: string): string {
  const c = (chain ?? '').toLowerCase()
  if (c === 'base-mainnet' || c === '8453' || c === 'base') return 'base'
  if (c === 'eth-mainnet' || c === '1' || c === 'eth' || c.includes('ethereum')) return 'eth'
  return c
}

// Normalize chain to GoldRush canonical chain IDs for API calls.
// Alchemy emits 'base'; GoldRush needs 'base-mainnet'. Same for ETH.
function normalizeChainForGoldrush(chain: string): string {
  const c = (chain ?? '').toLowerCase()
  if (c === 'base' || c === '8453') return 'base-mainnet'
  if (c === 'eth' || c === '1' || c === 'ethereum') return 'eth-mainnet'
  return c  // already canonical (e.g., 'base-mainnet', 'eth-mainnet') or unknown
}

// PHASE4-FIX-4: shared dedupe key for merging/deduping raw provider events. Keys on
// chain+contract+from+to+amountRaw+txHash so unrelated tokens never collide; when amountRaw
// (or decimals) is missing, falls back to a canonicalAmount+decimals composite instead of a
// bare rounded float, which previously caused unrelated low-decimal-precision tokens to collide.
function pnlEventDedupeKey(e: PnlEvent): string {
  const amountPart = e.amountRaw ?? `canon:${e.amount}:${e.tokenDecimals ?? 'NA'}`
  // PHASE4-FIX-4 (item 4): chain is already part of this key, which already prevents the
  // cross-chain txHash collision the spec describes (a bridge/L2-sequencer tx sharing a txHash
  // across two chains hashes to two different keys here because normalizeChain(e.chain) differs).
  // logIndex is appended as an additional differentiator (when present, real or synthetic — see
  // assignSyntheticLogIndex) so two distinct same-tx legs with identical contract/from/to/amount
  // (e.g. a repeated transfer in a loop) are no longer collapsed into one event.
  const logIndexPart = e.logIndex ?? ''
  return `${normalizeChain(e.chain)}:${e.contract.toLowerCase()}:${e.fromAddress ?? ''}:${e.toAddress ?? ''}:${amountPart}:${e.txHash ?? ''}:${logIndexPart}`
}

// PHASE4-FIX-6 (item 5): assigns a synthetic per-page logIndex to any event in a provider batch
// that doesn't already carry a real one, so downstream dedupe/sort have a stable tiebreaker even
// for providers (GoldRush, Alchemy, Moralis) that don't expose a true log index. Returns the
// patched events plus how many were synthesized, so callers can surface "synthetic_log_index".
function assignSyntheticLogIndex(events: PnlEvent[]): { events: PnlEvent[]; syntheticCount: number } {
  let syntheticCount = 0
  const patched = events.map((e, idx) => {
    if (e.logIndex !== undefined && e.logIndex !== null) return e
    syntheticCount++
    return { ...e, logIndex: idx }
  })
  return { events: patched, syntheticCount }
}

// PHASE4-FIX-3 (item 1): deterministic multi-provider/multi-chain sort comparator —
// (timestamp ASC, chainId ASC, logIndex ASC, providerIndex ASC). providerIndex is the event's
// position in the array passed in (stable per merge call), used only as the final tiebreaker
// when timestamp, chain, and logIndex are all equal.
function deterministicEventOrder(events: PnlEvent[]): PnlEvent[] {
  return events
    .map((e, providerIndex) => ({ e, providerIndex }))
    .sort((a, b) => {
      const tsCmp = (a.e.timestamp ? new Date(a.e.timestamp).getTime() : 0) - (b.e.timestamp ? new Date(b.e.timestamp).getTime() : 0)
      if (tsCmp !== 0) return tsCmp
      const chainCmp = normalizeChain(a.e.chain).localeCompare(normalizeChain(b.e.chain))
      if (chainCmp !== 0) return chainCmp
      const logIdxCmp = (a.e.logIndex ?? 0) - (b.e.logIndex ?? 0)
      if (logIdxCmp !== 0) return logIdxCmp
      return a.providerIndex - b.providerIndex
    })
    .map(({ e }) => e)
}

const LOT_EPSILON = 1e-9

// PHASE3-FIX-1: single canonical amount used by both pricing and FIFO. Pricing derives
// priceUsd as (legUsd / parseRawAmount(amountRaw, decimals)) when a raw amount is available,
// so FIFO must multiply that same priceUsd by the same canonical amount — not the provider's
// raw-normalized `e.amount` field, which can drift from the raw/decimals-derived value (wrong
// decimals upstream, lossy float normalization, etc.) and silently skew cost basis/lot size.
function canonicalFifoAmount(e: WalletTxEvidence): number {
  return parseRawAmount(e.amountRaw, e.tokenDecimals) ?? e.amount
}

// PHASE3-FIX-2: epsilon scales with lot size instead of a fixed 1e-9, which is too tight for
// large-decimal tokens (e.g. an amountOpened of 1e15 raw-derived units) and too loose for
// sub-unit tokens. A floating-point remainder under ~1e-6 of the original lot size is dust,
// not an open position, and should auto-close rather than linger as a phantom open lot.
function lotEpsilonFor(amountOpened: number): number {
  return Math.max(LOT_EPSILON, Math.abs(amountOpened) * 1e-6)
}

function lotConfidence(entrySource: string, exitSource: string): 'high' | 'medium' | 'low' {
  if (entrySource === 'stable_leg' && exitSource === 'stable_leg') return 'high'
  if (entrySource !== 'unavailable' && exitSource !== 'unavailable') return 'medium'
  return 'low'
}

// PHASE6-FIX-6: normalized reason-key vocabulary for all new Phase 6 confidence/completeness/
// integrity signals. These are appended ADDITIVELY to existing missing/missingReasons-style
// arrays elsewhere in the file — none of the existing string literals already used in those
// arrays (e.g. 'unmatched_sells', 'no_closed_lots', 'activity_provider_unavailable', etc.) are
// renamed or removed. Keep this list small and stable; Phase 6 code should only ever push one
// of these exact strings, never ad-hoc text, so downstream consumers can pattern-match on them.
const PHASE6_REASON_KEYS = {
  partialCoverage: 'partial_coverage',
  backfilledFromEstimateLots: 'backfilled_from_estimate_lots',
  dustAdjustedPnl: 'dust_adjusted_pnl',
  providerFailure: 'provider_failure',
  truncatedHistory: 'truncated_history',
  // PHASE6-FIX-6: already-snake_case keys introduced by earlier phases (Phase 2/3/4/5), listed
  // here so this vocabulary stays the single source of truth — they were already correctly
  // formatted at their original push sites and are not being renamed, just cross-referenced.
  priceMissingPrimary: 'price_missing_primary',
  priceMissingSecondary: 'price_missing_secondary',
  priceEstimated: 'price_estimated',
  syntheticLogIndex: 'synthetic_log_index',
  fifoBackfilledBuy: 'fifo_backfilled_buy',
  coverageValueWeightedLow: 'coverage_value_weighted_low',
  partialPnl: 'partial_pnl',
} as const

type Phase6ReasonKey = typeof PHASE6_REASON_KEYS[keyof typeof PHASE6_REASON_KEYS]

// PHASE6-FIX-1: numeric/tier confidence score for a single lot (open or closed), additive
// alongside the existing high/medium/low `confidence` field already set at construction time.
// Inputs are intentionally narrow (the same signals already available where lots are built):
//  - entrySource/exitSource: priceAtTime.source strings (real priced leg vs an estimate/derived leg)
//  - isEstimateLot: true when the lot was opened from 'current_holding_price_open_lot_estimate'
//    (i.e. backfilled from a current-price guess rather than a real historical price)
//  - partialCoverage: true when the wallet-level activity/chain coverage was already known to be
//    partial at the time this lot was built (e.g. priceAttemptLimitReached, provider partial)
// Returns a 0..1 score; tier is derived from the same thresholds used elsewhere in the file
// (>=0.85 high, >=0.5 medium, else low) so it stays consistent with existing confidence buckets.
function lotConfidenceScore(opts: {
  entrySource: string
  exitSource?: string
  isEstimateLot?: boolean
  partialCoverage?: boolean
  // PHASE6-FIX-1b: optional, additive signals — coveragePercent (0..100, this lot's evidence
  // coverage) and missingReasonsCount (size of this lot's missingReasons array, if any). Both are
  // optional so every existing call site without these signals keeps its prior score unchanged.
  coveragePercent?: number | null
  missingReasonsCount?: number
}): { score: number; tier: 'high' | 'medium' | 'low' } {
  const { entrySource, exitSource, isEstimateLot, partialCoverage, coveragePercent, missingReasonsCount } = opts
  let score = 1
  // Real priced legs (stable_leg / weth_leg / historical_price) keep full weight; derived/estimate
  // legs lose weight progressively.
  const sourceWeight = (s: string | undefined): number => {
    if (!s) return 0.85 // open lot with no exit leg yet — neutral, not penalized
    if (s === 'stable_leg' || s === 'weth_leg' || s === 'historical_price') return 1
    if (s === 'provider_event_usd' || s === 'swap_derived' || s === 'eth_native_value_router_reconstruction') return 0.75
    if (s === 'current_holding_price_open_lot_estimate') return 0.35
    return 0.5 // unavailable / unknown source
  }
  score = Math.min(score, sourceWeight(entrySource))
  if (exitSource !== undefined) score = Math.min(score, sourceWeight(exitSource))
  if (isEstimateLot) score = Math.min(score, 0.3)
  if (partialCoverage) score = score * 0.85
  // PHASE6-FIX-1b: factor this lot's own coveragePercent/missingReasons count (Phase 3 fields)
  // into the score when supplied, on top of the legacy boolean partialCoverage penalty above.
  if (typeof coveragePercent === 'number') {
    score = score * Math.max(0.5, Math.min(1, coveragePercent / 100))
  }
  if (typeof missingReasonsCount === 'number' && missingReasonsCount > 0) {
    score = score * Math.max(0.6, 1 - missingReasonsCount * 0.1)
  }
  score = Math.max(0, Math.min(1, score))
  // PHASE6-FIX-1a: medium-tier floor raised from 0.5 to 0.55 per Phase 6 spec.
  const tier: 'high' | 'medium' | 'low' = score >= 0.85 ? 'high' : score >= 0.55 ? 'medium' : 'low'
  return { score, tier }
}

// PHASE6-FIX-2: aggregates value-weighted lot confidence, coverage signals, unmatched-sell /
// estimate-backfill presence, and provider failures into a single wallet-level PnL confidence
// score+tier. Pure function over already-computed snapshot inputs — does not recompute lots.
function walletPnlConfidence(input: {
  closedLots: WalletClosedLot[]
  openLots: WalletLotOpen[]
  coveragePercent: number | null
  unmatchedSells: number
  unmatchedBuys: number
  providerFailures: boolean
  reasons: string[]
}): { score: number; tier: 'high' | 'medium' | 'low'; reasons: string[] } {
  const { closedLots, openLots, coveragePercent, unmatchedSells, unmatchedBuys, providerFailures } = input
  const reasons: string[] = [...input.reasons]

  // Value-weighted average of per-lot confidenceScore across closed + open lots, weighted by
  // each lot's USD size so a handful of large low-confidence lots can't hide behind many tiny
  // high-confidence ones (and vice versa).
  const weightedLots: Array<{ weight: number; score: number }> = [
    ...closedLots.map(l => ({ weight: Math.max(l.costBasisUsd, 0), score: l.confidenceScore ?? (l.confidence === 'high' ? 1 : l.confidence === 'medium' ? 0.65 : 0.35) })),
    ...openLots.map(l => ({ weight: Math.max(l.entryValueUsd, 0), score: l.confidenceScore ?? (l.confidence === 'high' ? 1 : l.confidence === 'medium' ? 0.65 : 0.35) })),
  ]
  const totalWeight = weightedLots.reduce((s, l) => s + l.weight, 0)
  const lotConfidenceWeighted = totalWeight > 0
    ? weightedLots.reduce((s, l) => s + l.weight * l.score, 0) / totalWeight
    : (weightedLots.length > 0 ? weightedLots.reduce((s, l) => s + l.score, 0) / weightedLots.length : 0.5)

  const coverageFactor = coveragePercent === null ? 0.5 : Math.max(0, Math.min(1, coveragePercent / 100))

  const estimateLotCount = [...closedLots.filter(l => l.evidence.entrySource === 'current_holding_price_open_lot_estimate' || l.evidence.exitSource === 'current_holding_price_open_lot_estimate'), ...openLots.filter(l => l.priceSource === 'current_holding_price_open_lot_estimate')].length
  if (estimateLotCount > 0) reasons.push(PHASE6_REASON_KEYS.backfilledFromEstimateLots)
  if (coveragePercent !== null && coveragePercent < 80) reasons.push(PHASE6_REASON_KEYS.partialCoverage)
  if (providerFailures) reasons.push(PHASE6_REASON_KEYS.providerFailure)

  let score = lotConfidenceWeighted * 0.6 + coverageFactor * 0.4
  if (unmatchedSells > 0) score *= 0.9
  if (unmatchedBuys > 0) score *= 0.95
  if (estimateLotCount > 0) score *= 0.9
  if (providerFailures) score *= 0.85
  score = Math.max(0, Math.min(1, score))

  // PHASE6-FIX-2b: tier thresholds aligned to lot-level thresholds (0.85/0.55) per spec item 2
  // ("Tier thresholds same as lot-level"). Weighting above is already by abs(valueUsd) — both
  // costBasisUsd and entryValueUsd are non-negative by construction, so Math.max(x, 0) === abs(x).
  const tier: 'high' | 'medium' | 'low' = score >= 0.85 ? 'high' : score >= 0.55 ? 'medium' : 'low'
  return { score, tier, reasons: Array.from(new Set(reasons)) }
}

// PHASE6-FIX-3a: completeness threshold below which isPnlPartial flips true, raised from 0.6 to
// 0.9 per the new Phase 6 spec ("isPnlPartial = true when completeness < 0.9").
const PHASE6_COMPLETENESS_PARTIAL_THRESHOLD = 0.9

// PHASE6-FIX-3: completeness score based on fraction of tokens with full buy/sell history,
// fraction of value covered, whether any event stream was truncated by a cap, and (PHASE6-FIX-3b,
// additive) the fraction of swap-candidate events that ended up unpriced ("missing price events")
// and the fraction of buy/sell legs that never matched into a closed lot ("missing swap legs").
function pnlCompletenessScore(input: {
  matchedTokenKeys: number
  buyTokenKeys: number
  sellTokenKeys: number
  coveragePercentValueWeighted: number | null
  truncated: boolean
  // PHASE6-FIX-3b: optional — swapCandidateEvents/pricedEvents from buildPriceAtTimeEvidence's
  // summary give the missing-price-events ratio; unmatchedBuys/unmatchedSells + matched lot count
  // from the FIFO engine give the missing-swap-legs ratio. Optional so existing callers without
  // these signals keep their prior score.
  missingPriceEventsRatio?: number | null
  missingSwapLegsRatio?: number | null
}): { score: number; isPartial: boolean; reasons: string[] } {
  const { matchedTokenKeys, buyTokenKeys, sellTokenKeys, coveragePercentValueWeighted, truncated, missingPriceEventsRatio, missingSwapLegsRatio } = input
  const reasons: string[] = []
  const totalTokenKeys = Math.max(buyTokenKeys, sellTokenKeys, 1)
  const tokenHistoryFraction = Math.max(0, Math.min(1, matchedTokenKeys / totalTokenKeys))
  const valueFraction = coveragePercentValueWeighted === null ? 0.5 : Math.max(0, Math.min(1, coveragePercentValueWeighted / 100))

  let score = tokenHistoryFraction * 0.5 + valueFraction * 0.5
  if (truncated) {
    score *= 0.8
    reasons.push(PHASE6_REASON_KEYS.truncatedHistory)
  }
  // PHASE6-FIX-3b: missing price events / missing swap legs each apply a proportional penalty
  // (capped) on top of the base score above.
  if (typeof missingPriceEventsRatio === 'number' && missingPriceEventsRatio > 0) {
    score *= Math.max(0.5, 1 - Math.min(1, missingPriceEventsRatio) * 0.5)
  }
  if (typeof missingSwapLegsRatio === 'number' && missingSwapLegsRatio > 0) {
    score *= Math.max(0.5, 1 - Math.min(1, missingSwapLegsRatio) * 0.5)
    reasons.push(PHASE6_REASON_KEYS.partialCoverage)
  }
  score = Math.max(0, Math.min(1, score))
  const isPartial = score < PHASE6_COMPLETENESS_PARTIAL_THRESHOLD
  // PHASE6-FIX-3a: push the new normalized partial_pnl key (in addition to the legacy
  // partial_coverage key) whenever completeness falls below the threshold.
  if (isPartial) reasons.push(PHASE6_REASON_KEYS.partialCoverage, PHASE6_REASON_KEYS.partialPnl)
  return { score, isPartial, reasons: Array.from(new Set(reasons)) }
}

// PHASE6-FIX-4: final integrity pass over the assembled snapshot's lot/PnL data. Read-only —
// never mutates lots or PnL numbers; only reports violations so the caller can downgrade
// pnlConfidenceTier and append normalized reason strings.
function integrityCheckPnl(input: {
  openLots: WalletLotOpen[]
  closedLots: WalletClosedLot[]
  realizedPnlUsd: number | null
  unrealizedPnlUsd: number | null
  portfolioDeltaUsd: number | null
  // PHASE6-FIX-4: optional, additive inputs feeding the new three-state `status` field below.
  // coveragePercent: overall wallet evidence coverage (0..100).
  // syntheticLotCount/totalLotCount: synthetic ("backfilled"/estimate) lots vs all lots, for ratio.
  // missingReasonsCount: size of the aggregated missingReasons/reasons set for this snapshot.
  // priceFailureRatio: fraction of priceAtTime attempts that did not resolve to a price.
  coveragePercent?: number | null
  syntheticLotCount?: number
  totalLotCount?: number
  missingReasonsCount?: number
  priceFailureRatio?: number | null
}): { ok: boolean; violations: string[]; status: 'ok' | 'suspicious' | 'invalid' } {
  const violations: string[] = []
  const EPS = 1e-6
  let hasNegativeBalance = false

  // No negative remaining balances.
  for (const lot of input.openLots) {
    if (lot.amountRemaining < -EPS) { violations.push('negative_remaining_balance'); hasNegativeBalance = true; break }
  }

  // No sells > total buys for a token, unless the lot chain is marked estimate/backfilled.
  const buysByToken = new Map<string, number>()
  for (const lot of input.openLots) {
    const key = `${lot.chain}:${lot.tokenAddress}`
    buysByToken.set(key, (buysByToken.get(key) ?? 0) + lot.amountOpened)
  }
  const sellsByToken = new Map<string, number>()
  for (const lot of input.closedLots) {
    if (lot.evidence.entrySource === 'current_holding_price_open_lot_estimate') continue
    const key = `${lot.chain}:${lot.tokenAddress}`
    sellsByToken.set(key, (sellsByToken.get(key) ?? 0) + lot.amountClosed)
    const boughtSoFar = buysByToken.get(key) ?? 0
    if ((sellsByToken.get(key) ?? 0) > boughtSoFar + EPS + (lot.amountClosed * 1e-6)) {
      violations.push('sells_exceed_buys')
      break
    }
  }

  // Realized + unrealized PnL should roughly match portfolio delta within a generous tolerance
  // (this is a sanity check, not a precise reconciliation — many legitimate factors like unpriced
  // transfers or airdrops can cause divergence, so the tolerance is intentionally wide).
  if (input.realizedPnlUsd !== null && input.unrealizedPnlUsd !== null && input.portfolioDeltaUsd !== null) {
    const computedTotal = input.realizedPnlUsd + input.unrealizedPnlUsd
    const tolerance = Math.max(50, Math.abs(input.portfolioDeltaUsd) * 0.25)
    if (Math.abs(computedTotal - input.portfolioDeltaUsd) > tolerance) {
      violations.push('pnl_portfolio_delta_mismatch')
    }
  }

  // PHASE6-FIX-4: derive the three-state status additively from the existing violations plus the
  // new optional inputs above. invalid takes precedence over suspicious; both default to 'ok'
  // when none of the thresholds are met (and the legacy `ok`/`violations` fields are unchanged).
  const syntheticLotRatio = input.totalLotCount && input.totalLotCount > 0
    ? Math.max(0, Math.min(1, (input.syntheticLotCount ?? 0) / input.totalLotCount))
    : 0
  const isInvalid =
    (typeof input.coveragePercent === 'number' && input.coveragePercent < 20) ||
    (typeof input.priceFailureRatio === 'number' && input.priceFailureRatio > 0.5)
  const isSuspicious =
    hasNegativeBalance ||
    syntheticLotRatio > 0.4 ||
    (input.missingReasonsCount ?? 0) > 5
  const status: 'ok' | 'suspicious' | 'invalid' = isInvalid ? 'invalid' : isSuspicious ? 'suspicious' : 'ok'

  // BUGFIX: `ok` must agree with `status` — previously `ok` was derived only from
  // `violations.length === 0` while `status` could independently be 'suspicious'/'invalid' from the
  // coverage/synthetic-lot/missingReasons/priceFailure checks above, producing contradictory output
  // like { ok: true, status: 'invalid', violations: [] }. ok is now true only when status is 'ok'.
  // Whenever status downgrades to suspicious/invalid for a reason not already in `violations`
  // (e.g. low coverage, high synthetic ratio, too many missing reasons, high price-failure ratio),
  // append a violation reason so the status is never unexplained.
  if (status !== 'ok') {
    if (isInvalid && typeof input.coveragePercent === 'number' && input.coveragePercent < 20 && !violations.includes('coverage_percent_below_threshold')) {
      violations.push('coverage_percent_below_threshold')
    }
    if (isInvalid && typeof input.priceFailureRatio === 'number' && input.priceFailureRatio > 0.5 && !violations.includes('price_failure_ratio_above_threshold')) {
      violations.push('price_failure_ratio_above_threshold')
    }
    if (status === 'suspicious') {
      if (syntheticLotRatio > 0.4 && !violations.includes('synthetic_lot_ratio_above_threshold')) {
        violations.push('synthetic_lot_ratio_above_threshold')
      }
      if ((input.missingReasonsCount ?? 0) > 5 && !violations.includes('missing_reasons_above_threshold')) {
        violations.push('missing_reasons_above_threshold')
      }
    }
  }

  return { ok: status === 'ok', violations, status }
}

// PHASE6-FIX-5: heuristic-only (no ML) wallet behavioral signal bundle, derived strictly from
// values already computed elsewhere in the snapshot (trade stats, lot summary, holdings value
// concentration). Every bucket is a simple threshold rule — no learned weights, no external data.
function deriveWalletProfileHints(input: {
  closedLotsCount: number
  walletAgeDays: number | null
  avgHoldingTimeSeconds: number | null
  winRatePercent: number | null
  meaningfulClosedLots: number
  dustClosedLots: number
  holdingsValueUsd: number[]
}): {
  tradeFrequency: 'low' | 'medium' | 'high'
  avgHoldTimeBucket: 'short' | 'mid' | 'long'
  realizedWinRateBucket: 'low' | 'medium' | 'high'
  riskProfileHint: 'concentrated' | 'diversified' | 'dust-heavy'
} {
  const tradesPerWeek = input.walletAgeDays && input.walletAgeDays > 0
    ? (input.closedLotsCount / input.walletAgeDays) * 7
    : input.closedLotsCount > 0 ? input.closedLotsCount : 0
  const tradeFrequency: 'low' | 'medium' | 'high' =
    tradesPerWeek >= 5 ? 'high' : tradesPerWeek >= 1 ? 'medium' : 'low'

  const holdSeconds = input.avgHoldingTimeSeconds ?? null
  const avgHoldTimeBucket: 'short' | 'mid' | 'long' =
    holdSeconds === null ? 'mid'
    : holdSeconds < 24 * 3600 ? 'short'
    : holdSeconds < 14 * 24 * 3600 ? 'mid'
    : 'long'

  const winRate = input.winRatePercent ?? null
  const realizedWinRateBucket: 'low' | 'medium' | 'high' =
    winRate === null ? 'medium'
    : winRate >= 60 ? 'high'
    : winRate >= 40 ? 'medium'
    : 'low'

  const totalValue = input.holdingsValueUsd.reduce((s, v) => s + v, 0)
  const sorted = [...input.holdingsValueUsd].sort((a, b) => b - a)
  const top1Share = totalValue > 0 && sorted.length > 0 ? sorted[0] / totalValue : 0
  const dustShare = input.meaningfulClosedLots + input.dustClosedLots > 0
    ? input.dustClosedLots / (input.meaningfulClosedLots + input.dustClosedLots)
    : 0
  const riskProfileHint: 'concentrated' | 'diversified' | 'dust-heavy' =
    dustShare >= 0.5 ? 'dust-heavy'
    : top1Share >= 0.7 ? 'concentrated'
    : 'diversified'

  return { tradeFrequency, avgHoldTimeBucket, realizedWinRateBucket, riskProfileHint }
}

// PHASE6-FIX-5: data-quality hint array, distinct from the existing `walletProfileHints` object
// (which is a behavioral-bucket bundle, not a string array — its shape predates this Phase 6 pass
// and is left untouched per "Do NOT change public API shapes"). Returns only the hints whose
// threshold is met; callers must append (never overwrite) onto any existing array.
function deriveWalletDataQualityHints(input: {
  coveragePercent: number | null
  syntheticLotRatio: number
  unstablePriceSourceCount: number
  totalPricedLegCount: number
  missingSwapLegsRatio: number
  isPnlPartial: boolean
}): string[] {
  const hints: string[] = []
  if (input.coveragePercent !== null && input.coveragePercent < 60) hints.push('low_coverage')
  if (input.syntheticLotRatio > 0.4) hints.push('high_synthetic_ratio')
  if (input.totalPricedLegCount > 0 && input.unstablePriceSourceCount / input.totalPricedLegCount > 0.3) hints.push('unstable_price_sources')
  if (input.missingSwapLegsRatio > 0.2) hints.push('missing_swap_legs')
  if (input.isPnlPartial) hints.push(PHASE6_REASON_KEYS.partialPnl)
  return hints
}

function buildFifoLotEngine(
  evidenceWithPricing: WalletTxEvidence[],
  activityRequested: boolean
): {
  summary: WalletSnapshot['walletLotSummary']
  debug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletLotEngineDebug']>
  closedLots: WalletClosedLot[]
  openLots: WalletLotOpen[]
} {
  const empty = (missing: string[]) => ({
    summary: {
      status: 'open_check' as const, pricedSwapEvents: 0, openedLots: 0, closedLots: 0,
      partiallyClosedLots: 0, unmatchedBuys: 0, unmatchedSells: 0,
      realizedPnlUsd: null, realizedPnlPercent: null,
      totalCostBasisClosedUsd: null, totalProceedsClosedUsd: null,
      readyForTradeStats: false, missing,
    },
    debug: {
      pricedSwapEvents: 0, buyEvents: 0, sellEvents: 0, openedLots: 0, closedLots: 0,
      partiallyClosedLots: 0, unmatchedBuys: 0, unmatchedSells: 0,
      skippedUnpricedEvents: 0, skippedUnknownSide: 0, skippedStableQuoteAssets: 0, skippedMissingFields: 0,
      uniqueBuyTokenKeys: 0, uniqueSellTokenKeys: 0, matchedTokenKeys: 0,
      unmatchedBuyTokenKeys: [] as string[], unmatchedSellTokenKeys: [] as string[],
      totalCostBasisClosedUsd: null, totalProceedsClosedUsd: null,
      realizedPnlUsd: null, realizedPnlPercent: null,
      sampleOpenLots: [], sampleClosedLots: [], sampleUnmatchedSells: [],
      sampleBuyEvents: [] as Array<{ tokenAddress: string; symbol: string; chain: string; amount: number; priceUsd: number }>,
      sampleSellEvents: [] as Array<{ tokenAddress: string; symbol: string; chain: string; amount: number; priceUsd: number }>,
      sampleUnmatchedReasons: [] as string[],
      reasons: missing,
    },
    closedLots: [] as WalletClosedLot[],
    openLots: [] as WalletLotOpen[],
  })

  if (!activityRequested) return empty(['activity_not_requested'])

  // ── Filter to eligible events ──
  let skippedUnpricedEvents = 0
  let skippedUnknownSide = 0
  let skippedStableQuoteAssets = 0
  let skippedMissingFields = 0

  let eligible: WalletTxEvidence[] = []
  for (const e of evidenceWithPricing) {
    // PHASE3-FIX-5: isSwapCandidate is already false for airdrop_candidate/transfer/bridge
    // events (see buildSwapDetection), so this gate already excludes non-swap legs from cost
    // basis. Kept as an explicit, named check (rather than relying only on the upstream flag)
    // so an airdrop/rebate leg can never enter FIFO even if eventKind classification changes.
    if (!e.swapDetection?.isSwapCandidate || e.swapDetection.eventKind === 'airdrop_candidate') continue
    if (e.direction === 'unknown') { skippedUnknownSide++; continue }
    if (e.priceAtTime?.status !== 'priced' || !e.priceAtTime.priceUsd || !isFinite(e.priceAtTime.priceUsd) || e.priceAtTime.priceUsd <= 0) { skippedUnpricedEvents++; continue }
    // PHASE3-FIX-1: validate the canonical (raw/decimals-derived) amount, not the provider's
    // possibly-drifted normalized `e.amount`, so a bad normalization doesn't silently pass
    // through as a zero/garbage lot later.
    const _canonicalAmount = canonicalFifoAmount(e)
    if (!e.txHash || !e.timestamp || !e.contract || !e.contract.startsWith('0x') || !_canonicalAmount || _canonicalAmount <= 0 || !isFinite(_canonicalAmount)) { skippedMissingFields++; continue }
    // PHASE3-FIX-8 (item 3): stablecoins are quote assets, never the matched FIFO asset —
    // QUOTE_ASSET_CONTRACTS already includes every address in STABLE_USD_CONTRACTS (see its
    // definition above: `...STABLE_USD_CONTRACTS, ...WETH_CONTRACTS_PRICE`), so a stablecoin
    // event never reaches the buy/sell loop below as the asset being lotted; it's only ever
    // consumed earlier as a priced quote leg. The literal "force costBasis = amount * 1.0 /
    // realizedPnlUsd = proceeds - costBasis" fix from the spec has no reachable call site to
    // attach to without removing this exclusion (which would be an architecture change, not a
    // fix) — so it is intentionally not implemented as dead code inside the loop below.
    if (QUOTE_ASSET_CONTRACTS[e.contract.toLowerCase()]) { skippedStableQuoteAssets++; continue }
    eligible.push(e)
  }

  const pricedSwapEvents = eligible.length
  if (pricedSwapEvents === 0) return empty(['no_priced_swap_events'])

  // PHASE3-FIX-7: deterministic multi-chain sort. Plain timestamp sort previously left equal
  // timestamps (common when merging events from multiple chains in the same second) ordered by
  // whatever order Array.sort's implementation happened to preserve for ties — i.e. raw
  // provider-arrival order. Now tie-break on normalized chain, then on original arrival index
  // (logIndexFallback; no logIndex is tracked on PnlEvent/WalletTxEvidence) so lot ordering is
  // reproducible across runs regardless of provider response ordering.
  eligible = eligible
    .map((e, idx) => ({ e, idx }))
    .sort((a, b) => {
      const tsCmp = (a.e.timestamp ?? '').localeCompare(b.e.timestamp ?? '')
      if (tsCmp !== 0) return tsCmp
      const chainCmp = normalizeChain(a.e.chain).localeCompare(normalizeChain(b.e.chain))
      if (chainCmp !== 0) return chainCmp
      return a.idx - b.idx // logIndexFallback
    })
    .map(({ e }) => e)

  const buyEvents = eligible.filter(e => e.direction === 'buy').length
  const sellEvents = eligible.filter(e => e.direction === 'sell').length

  // Open lots keyed by normalizedChain:contract (FIFO queue — oldest first)
  // Using normalizeChain() prevents base-mainnet/8453/base mismatches from breaking lot matching.
  const openLotsMap = new Map<string, WalletLotOpen[]>()
  // Estimate-only lots (current_holding_price_open_lot_estimate): counted in openedLots but NEVER matched against sells.
  const estimateLotsMap = new Map<string, WalletLotOpen[]>()
  const closedLots: WalletClosedLot[] = []
  let unmatchedBuys = 0
  let unmatchedSells = 0

  const buyTokenKeySet = new Set<string>()
  const sellTokenKeySet = new Set<string>()
  const sampleBuyEvents: Array<{ tokenAddress: string; symbol: string; chain: string; amount: number; priceUsd: number }> = []
  const sampleSellEvents: Array<{ tokenAddress: string; symbol: string; chain: string; amount: number; priceUsd: number }> = []
  const sampleUnmatchedReasons: string[] = []
  const _abbr = (addr: string) => `${addr.slice(0, 8)}...${addr.slice(-6)}`

  // PHASE3-FIX-3 bookkeeping: tracks which lotKeys have ever had a real (non-estimate) buy
  // discovered, so a sell that arrives before any real buy can later be reconciled against an
  // estimate lot instead of being left as a hard "no buy ever found" unmatched sell.
  let backfilledFromEstimateLots = 0
  // PHASE3-FIX-9 (items 1 & 5): counts sells where neither real nor estimate lots covered the
  // full sold amount, requiring a synthetic backfilled buy lot for the shortfall.
  let backfilledBuyLots = 0

  for (const e of eligible) {
    const normalChain = normalizeChain(e.chain)
    // PHASE3-FIX-6: token identity key now includes decimals (chain + contract + decimals).
    // Two events on the same contract address with different decimals can never be the same
    // token (a malformed/duplicate event with wrong decimals), so they must never share a
    // FIFO queue — keying on contract alone allowed them to collide.
    const lotKey = `${normalChain}:${e.contract.toLowerCase()}:${e.tokenDecimals ?? 'NA'}`
    const priceUsd = e.priceAtTime!.priceUsd!
    const priceSource = e.priceAtTime!.source
    // PHASE3-FIX-1: canonical amount, consistent with how priceUsd was derived upstream.
    const amount = canonicalFifoAmount(e)

    if (e.direction === 'buy') {
      buyTokenKeySet.add(lotKey)
      if (sampleBuyEvents.length < 5) sampleBuyEvents.push({ tokenAddress: _abbr(e.contract), symbol: e.symbol ?? '?', chain: normalChain, amount, priceUsd })
      // Open a new lot
      const _isEstimateLot = priceSource === 'current_holding_price_open_lot_estimate'
      // PHASE6-FIX-1: lot-level numeric confidence, computed from the same priceSource signal
      // already used for the existing high/medium/low `confidence` field above.
      const _lotConfScore = lotConfidenceScore({ entrySource: priceSource, isEstimateLot: _isEstimateLot })
      const lot: WalletLotOpen = {
        tokenAddress: e.contract.toLowerCase(),
        tokenSymbol: e.symbol ?? null,
        chain: normalChain,
        openedTxHash: e.txHash,
        openedAt: e.timestamp!,
        amountOpened: amount,
        amountRemaining: amount,
        entryPriceUsd: priceUsd,
        entryValueUsd: amount * priceUsd,
        priceSource,
        confidence: priceSource === 'stable_leg' ? 'high' : priceSource === 'current_holding_price_open_lot_estimate' ? 'low' : 'medium',
        confidenceScore: _lotConfScore.score,
        confidenceTier: _lotConfScore.tier,
        // PHASE3-FIX-11 (item 6): typed defaults so every open lot carries coverage/missing-
        // reason metadata rather than leaving it undefined. A real priced buy leg is full
        // coverage with no missing reasons; estimate lots are flagged as partial coverage.
        coveragePercent: _isEstimateLot ? 0 : 100,
        missingReasons: _isEstimateLot ? ['current_holding_price_open_lot_estimate'] : [],
      }
      if (priceSource === 'current_holding_price_open_lot_estimate') {
        // Estimate lots are open-position records only — never matched against sells to prevent fake realized PnL
        const estimateQueue = estimateLotsMap.get(lotKey) ?? []
        estimateQueue.push(lot)
        estimateLotsMap.set(lotKey, estimateQueue)
      } else {
        const queue = openLotsMap.get(lotKey) ?? []
        queue.push(lot)
        openLotsMap.set(lotKey, queue)
      }

    } else if (e.direction === 'sell') {
      sellTokenKeySet.add(lotKey)
      if (sampleSellEvents.length < 5) sampleSellEvents.push({ tokenAddress: _abbr(e.contract), symbol: e.symbol ?? '?', chain: normalChain, amount, priceUsd })
      let queue = openLotsMap.get(lotKey)
      // PHASE3-FIX-3: no real lot exists for this token, but an estimate lot (opened from a
      // current-holding-price guess) does — instead of declaring the position phantom, fall
      // back to closing against the estimate lot. The resulting closed lot inherits 'low'
      // confidence via lotConfidence() since entrySource is the estimate source, so it never
      // masquerades as a high-confidence realized trade.
      if (!queue || queue.length === 0) {
        const estimateQueue = estimateLotsMap.get(lotKey)
        if (estimateQueue && estimateQueue.length > 0) {
          queue = estimateQueue
          backfilledFromEstimateLots++
        }
      }
      if (!queue) queue = []

      let sellRemaining = amount
      // PHASE3-FIX-4: deterministic partial-lot allocation — close the minimum of the
      // remaining sell and the lot's remaining amount, update the lot precisely, and only
      // shift the lot off the queue once its remainder is within the lot-relative epsilon.
      // PHASE3-FIX-10 (item 2): partial-fill metadata propagation. A split here never copies the
      // parent lot into two separate objects — `lot` (priceSource, entryPriceUsd, confidence,
      // confidenceScore/confidenceTier) is mutated in place via `amountRemaining` only, so the
      // remaining-open "child" always carries every parent field by construction (no copy step
      // that could drop a field). The closed "child" below recomputes its own confidence from
      // both legs of the trade (lot.priceSource as entrySource, this sell's priceSource as
      // exitSource) rather than blindly copying the open lot's score, since a closed lot's
      // confidence legitimately depends on the exit leg too.
      while (sellRemaining > lotEpsilonFor(amount) && queue.length > 0) {
        const lot = queue[0]
        const closeAmount = Math.min(lot.amountRemaining, sellRemaining)
        const costBasisUsd = closeAmount * lot.entryPriceUsd
        const proceedsUsd = closeAmount * priceUsd
        const realizedPnlUsd = proceedsUsd - costBasisUsd
        const entryTs = new Date(lot.openedAt).getTime()
        const exitTs = new Date(e.timestamp!).getTime()
        const holdingTimeSeconds = isFinite(entryTs) && isFinite(exitTs) ? Math.max(0, Math.floor((exitTs - entryTs) / 1000)) : null

        // PHASE6-FIX-1: closed-lot numeric confidence, derived from both legs of the trade.
        const _closedConfScore = lotConfidenceScore({ entrySource: lot.priceSource, exitSource: priceSource })
        closedLots.push({
          tokenAddress: e.contract.toLowerCase(),
          tokenSymbol: e.symbol ?? null,
          chain: normalChain,
          openedTxHash: lot.openedTxHash,
          closedTxHash: e.txHash,
          openedAt: lot.openedAt,
          closedAt: e.timestamp!,
          amountClosed: closeAmount,
          entryPriceUsd: lot.entryPriceUsd,
          exitPriceUsd: priceUsd,
          costBasisUsd,
          proceedsUsd,
          realizedPnlUsd,
          realizedPnlPercent: costBasisUsd > 0 ? (realizedPnlUsd / costBasisUsd) * 100 : null,
          holdingTimeSeconds,
          confidence: lotConfidence(lot.priceSource, priceSource),
          evidence: { entrySource: lot.priceSource, exitSource: priceSource, method: 'fifo' },
          confidenceScore: _closedConfScore.score,
          confidenceTier: _closedConfScore.tier,
          // PHASE3-FIX-11 (item 6): typed defaults, consistent with the open-lot defaults above —
          // a real-lot close inherits the parent's coverage flag (missingReasons carries forward
          // only if the parent lot itself was already a partial/estimate lot).
          coveragePercent: lot.coveragePercent ?? 100,
          missingReasons: lot.missingReasons ?? [],
        })

        lot.amountRemaining -= closeAmount
        sellRemaining -= closeAmount
        if (lot.amountRemaining <= lotEpsilonFor(lot.amountOpened)) queue.shift()
      }

      // PHASE3-FIX-9 (items 1 & 5): negative-balance protection. Real + estimate lots could not
      // cover the full sell amount — multi-chain merges or missing historical buys can leave a
      // genuine negative balance — so backfill a synthetic buy lot for exactly the missing
      // amount instead of silently dropping cost basis. Priced at this sell's own priceAtTime
      // (the best available price for that timestamp/token), then immediately closed against
      // the same sell. Realized PnL on the backfilled portion is intentionally 0 (entry price
      // == exit price) since there is no real historical entry price to compute a gain/loss
      // against — the goal is completeness/visibility, not invented profit.
      if (sellRemaining > lotEpsilonFor(amount)) {
        const missingAmount = sellRemaining
        const _synthOpenConf = lotConfidenceScore({ entrySource: 'synthetic', isEstimateLot: true })
        const costBasisUsd = missingAmount * priceUsd
        const proceedsUsd = missingAmount * priceUsd
        backfilledBuyLots++
        closedLots.push({
          tokenAddress: e.contract.toLowerCase(),
          tokenSymbol: e.symbol ?? null,
          chain: normalChain,
          openedTxHash: e.txHash,
          closedTxHash: e.txHash,
          openedAt: e.timestamp!,
          closedAt: e.timestamp!,
          amountClosed: missingAmount,
          entryPriceUsd: priceUsd,
          exitPriceUsd: priceUsd,
          costBasisUsd,
          proceedsUsd,
          realizedPnlUsd: 0,
          realizedPnlPercent: 0,
          holdingTimeSeconds: 0,
          confidence: 'low',
          evidence: { entrySource: 'synthetic', exitSource: priceSource, method: 'fifo' },
          confidenceScore: _synthOpenConf.score,
          confidenceTier: _synthOpenConf.tier,
          coveragePercent: Math.max(0, Math.min(100, ((amount - missingAmount) / amount) * 100)),
          missingReasons: ['fifo_backfilled_buy', 'price_synthetic_fifo'],
        })
        sellRemaining = 0
        if (sampleUnmatchedReasons.length < 10) sampleUnmatchedReasons.push(`fifo_backfilled_buy:${_abbr(e.contract)}(${e.symbol ?? '?'})`)
      }
    }
    // direction === 'unknown' already filtered by eligible filter (swap candidates are buy/sell)
  }

  // Tally open lot stats
  let openedLots = 0
  let partiallyClosedLots = 0
  for (const queue of openLotsMap.values()) {
    for (const lot of queue) {
      openedLots++
      // PHASE3-FIX-2: lot-relative epsilon — a remainder that's dust relative to this lot's
      // own size no longer counts as "partially closed remaining open."
      if (lot.amountRemaining < lot.amountOpened - lotEpsilonFor(lot.amountOpened)) partiallyClosedLots++
    }
  }
  // Estimate lots count as opened positions but are never matched against sells
  for (const queue of estimateLotsMap.values()) {
    for (const _lot of queue) { openedLots++ }
  }
  unmatchedBuys = Array.from(openLotsMap.values()).flatMap(q => q).filter(lot => lot.amountRemaining >= lot.amountOpened - lotEpsilonFor(lot.amountOpened)).length

  const totalCostBasisClosedUsd = closedLots.length > 0 ? closedLots.reduce((s, l) => s + l.costBasisUsd, 0) : null
  const totalProceedsClosedUsd = closedLots.length > 0 ? closedLots.reduce((s, l) => s + l.proceedsUsd, 0) : null
  const realizedPnlUsd = closedLots.length > 0 ? closedLots.reduce((s, l) => s + l.realizedPnlUsd, 0) : null
  const realizedPnlPercent = totalCostBasisClosedUsd !== null && totalCostBasisClosedUsd > 0 && realizedPnlUsd !== null
    ? (realizedPnlUsd / totalCostBasisClosedUsd) * 100
    : null

  const summaryStatus: 'ok' | 'partial' | 'open_check' =
    closedLots.length > 0 ? 'ok'
    : pricedSwapEvents > 0 ? 'partial'
    : 'open_check'

  // ── Token key overlap analysis ──
  const matchedTokenKeySet = new Set<string>([...buyTokenKeySet].filter(k => sellTokenKeySet.has(k)))
  const unmatchedBuyTokenKeys = [...buyTokenKeySet].filter(k => !sellTokenKeySet.has(k)).slice(0, 10)
  const unmatchedSellTokenKeys = [...sellTokenKeySet].filter(k => !buyTokenKeySet.has(k)).slice(0, 10)

  // ── Enhanced reason when lots = 0 but events were priced ──
  const missing: string[] = []
  if (closedLots.length === 0 && pricedSwapEvents > 0) {
    if (buyEvents === 0 && sellEvents > 0) missing.push('priced_events_only_sells')
    else if (sellEvents === 0 && buyEvents > 0) missing.push('only_buys_found_no_sells')
    else if (matchedTokenKeySet.size === 0 && buyEvents > 0 && sellEvents > 0) missing.push('no_overlapping_buy_sell_tokens')
    else if (unmatchedSells > 0 && openedLots > 0 && closedLots.length === 0) missing.push('sell_before_buy')
    else missing.push('no_closed_lots')
  }
  if (unmatchedSells > 0) missing.push('unmatched_sells')
  if (unmatchedBuys > 0) missing.push('unmatched_buys')
  // PHASE3-FIX-9 (items 1 & 5): debug-visible count of sells that needed a synthetic backfilled
  // buy lot because real + estimate lots didn't cover the full sold amount. unmatchedSells can
  // no longer be incremented for this case (it's now backfilled+closed instead of dropped), so
  // this reason key is the only remaining signal that a negative-balance condition occurred.
  if (backfilledBuyLots > 0) missing.push(`fifo_backfilled_buy:${backfilledBuyLots}`)
  // PHASE3-FIX-3: debug-visible count of sells reconciled against estimate lots instead of
  // being left as a hard "no buy ever found" unmatched sell.
  if (backfilledFromEstimateLots > 0) missing.push(`backfilled_from_estimate_lots:${backfilledFromEstimateLots}`)

  const abbr = (addr: string) => `${addr.slice(0, 8)}...${addr.slice(-6)}`

  const allOpenLots = [
    ...Array.from(openLotsMap.values()).flatMap(q => q),
    ...Array.from(estimateLotsMap.values()).flatMap(q => q),
  ]

  return {
    summary: {
      status: summaryStatus,
      pricedSwapEvents,
      openedLots,
      closedLots: closedLots.length,
      partiallyClosedLots,
      unmatchedBuys,
      unmatchedSells,
      realizedPnlUsd,
      realizedPnlPercent,
      totalCostBasisClosedUsd,
      totalProceedsClosedUsd,
      readyForTradeStats: closedLots.length >= 1,
      missing,
    },
    debug: {
      pricedSwapEvents, buyEvents, sellEvents, openedLots,
      closedLots: closedLots.length, partiallyClosedLots, unmatchedBuys, unmatchedSells,
      skippedUnpricedEvents, skippedUnknownSide, skippedStableQuoteAssets, skippedMissingFields,
      uniqueBuyTokenKeys: buyTokenKeySet.size,
      uniqueSellTokenKeys: sellTokenKeySet.size,
      matchedTokenKeys: matchedTokenKeySet.size,
      unmatchedBuyTokenKeys,
      unmatchedSellTokenKeys,
      totalCostBasisClosedUsd, totalProceedsClosedUsd, realizedPnlUsd, realizedPnlPercent,
      sampleOpenLots: allOpenLots.slice(0, 5).map(l => ({
        tokenAddress: abbr(l.tokenAddress), symbol: l.tokenSymbol ?? '', chain: l.chain,
        openedAt: l.openedAt, amountRemaining: l.amountRemaining,
        entryPriceUsd: l.entryPriceUsd, confidence: l.confidence,
      })),
      sampleClosedLots: closedLots.slice(0, 5).map(l => ({
        tokenAddress: abbr(l.tokenAddress), symbol: l.tokenSymbol ?? '',
        openedAt: l.openedAt, closedAt: l.closedAt, amountClosed: l.amountClosed,
        entryPriceUsd: l.entryPriceUsd, exitPriceUsd: l.exitPriceUsd,
        realizedPnlUsd: l.realizedPnlUsd, confidence: l.confidence,
      })),
      sampleUnmatchedSells: eligible.filter(e => e.direction === 'sell').slice(0, 5).map(e => ({
        txHash: abbr(e.txHash), tokenAddress: abbr(e.contract),
        symbol: e.symbol, amount: e.amount, exitPriceUsd: e.priceAtTime!.priceUsd!,
      })),
      sampleBuyEvents,
      sampleSellEvents,
      sampleUnmatchedReasons,
      reasons: missing,
    },
    closedLots,
    openLots: allOpenLots,
  }
}

// normalizeSwapEventsForFifo: promotes outbound-only transfer events into swap candidates
// so the FIFO engine can match them against previously-opened lots and compute realized PnL.
// Runs AFTER all pricing passes (including swap_derived), BEFORE buildFifoLotEngine.
function normalizeSwapEventsForFifo(pricedEvidence: WalletTxEvidence[], debug = false): WalletTxEvidence[] {
  const LP_TAGS = ['LP', 'UNI-V2', 'SLP', 'BAL', 'CRV']
  const isLPSym = (s: string) => LP_TAGS.some(t => s.toUpperCase().includes(t))

  // Index priced events by txHash for same-tx counterpart lookup
  const pricedByTx = new Map<string, WalletTxEvidence[]>()
  // Track most-recently-priced event per chain:contract for cross-tx fallback
  const latestPricedByToken = new Map<string, WalletTxEvidence>()

  for (const ev of pricedEvidence) {
    if (ev.priceAtTime?.status !== 'priced' || !ev.priceAtTime.priceUsd) continue
    if (isLPSym(ev.symbol ?? '')) continue
    if (ev.txHash) {
      const existing = pricedByTx.get(ev.txHash) ?? []
      existing.push(ev)
      pricedByTx.set(ev.txHash, existing)
    }
    const tokenKey = `${normalizeChain(ev.chain)}:${ev.contract.toLowerCase()}`
    const prev = latestPricedByToken.get(tokenKey)
    if (!prev || (ev.timestamp ?? '') > (prev.timestamp ?? '')) {
      latestPricedByToken.set(tokenKey, ev)
    }
  }

  const synthetic: WalletTxEvidence[] = []

  for (const e of pricedEvidence) {
    // Only promote non-swap-candidate sells (outbound-only transfers)
    if (e.swapDetection?.isSwapCandidate) continue
    if (e.direction !== 'sell') continue
    if (isLPSym(e.symbol ?? '')) continue
    if (!e.contract || !e.contract.startsWith('0x')) continue
    if (!e.amount || e.amount <= 0) continue
    if (!e.txHash || !e.timestamp) continue
    if (QUOTE_ASSET_CONTRACTS[e.contract.toLowerCase()]) continue

    const tokenKey = `${normalizeChain(e.chain)}:${e.contract.toLowerCase()}`
    // Only promote if this token was previously bought via a swap (avoids promoting random withdrawals)
    if (!latestPricedByToken.has(tokenKey)) continue

    const thisAmt = parseRawAmount(e.amountRaw, e.tokenDecimals) ?? e.amount
    if (!thisAmt || thisAmt <= 0) continue

    let syntheticPriceUsd: number | null = null
    let priceReason = ''
    let cpSymbol: string | null = null
    let cpAmt: number | null = null

    // 1. Same-tx priced counterpart (opposite direction)
    const txPeers = (pricedByTx.get(e.txHash) ?? []).filter(cp =>
      cp.direction !== e.direction && cp.direction !== 'unknown' && !isLPSym(cp.symbol ?? '')
    )
    if (txPeers.length > 0) {
      const cp = txPeers[0]
      const peerAmt = parseRawAmount(cp.amountRaw, cp.tokenDecimals) ?? cp.amount
      if (peerAmt && peerAmt > 0 && cp.priceAtTime?.priceUsd) {
        syntheticPriceUsd = (peerAmt * cp.priceAtTime.priceUsd) / thisAmt
        priceReason = `Swap-derived from same-tx ${cp.symbol} leg`
        cpSymbol = cp.symbol
        cpAmt = peerAmt
      }
    }

    // 2. Cross-tx fallback: use latest priced event for same token
    if (!syntheticPriceUsd) {
      const latestForToken = latestPricedByToken.get(tokenKey)
      if (latestForToken?.priceAtTime?.priceUsd) {
        syntheticPriceUsd = latestForToken.priceAtTime.priceUsd
        priceReason = `Price proxy from nearest priced event for ${e.symbol}`
      }
    }

    if (!syntheticPriceUsd || !isFinite(syntheticPriceUsd) || syntheticPriceUsd <= 0) continue

    if (debug) console.log('swapToBuySellNormalization', {
      txHash: e.txHash,
      tokenIn: e.symbol,
      tokenOut: cpSymbol ?? 'NATIVE',
      amountIn: thisAmt,
      amountOut: cpAmt,
    })

    synthetic.push({
      ...e,
      swapDetection: {
        isSwapCandidate: true,
        confidence: 'low',
        eventKind: 'swap_candidate',
        reason: `Normalized outbound transfer → swap candidate (${priceReason})`,
        matchedProtocol: e.swapDetection?.matchedProtocol ?? null,
        matchedAddress: e.swapDetection?.matchedAddress ?? null,
      },
      priceAtTime: {
        status: 'priced',
        tokenAddress: e.contract,
        tokenSymbol: e.symbol,
        timestamp: e.timestamp ?? '',
        priceUsd: syntheticPriceUsd,
        source: 'swap_derived',
        confidence: 'low',
        reason: priceReason,
      },
    })
  }

  if (synthetic.length > 0) {
    if (debug) console.log(`normalizeSwapEventsForFifo: promoted ${synthetic.length} outbound transfers to swap candidates`)
  }

  return [...pricedEvidence, ...synthetic]
}

// normalizeSingleLegEventsForFifo: extends normalizeSwapEventsForFifo to also cover
// single-leg buys (ETH→TOKEN with no ERC20 outbound) and any remaining single-leg sells
// that the previous pass missed (e.g., events without a priced buy anywhere in history).
// Runs immediately after normalizeSwapEventsForFifo, before buildFifoLotEngine.
function normalizeSingleLegEventsForFifo(pricedEvidence: WalletTxEvidence[], debug = false): WalletTxEvidence[] {
  const LP_TAGS = ['LP', 'UNI-V2', 'SLP', 'BAL', 'CRV']
  const isLPSym = (s: string) => LP_TAGS.some(t => s.toUpperCase().includes(t))
  const STABLE_SYMS = new Set(['USDC', 'USDT', 'DAI', 'FDUSD', 'TUSD', 'USDE', 'USDS', 'BUSD', 'USDP', 'FRAX', 'LUSD', 'PYUSD'])

  // Track txHash:contract:direction combos that already have a swap candidate
  // (covers originals classified as swap candidates + synthetics from normalizeSwapEventsForFifo)
  const existingSwapKeys = new Set<string>()
  for (const ev of pricedEvidence) {
    if (ev.swapDetection?.isSwapCandidate) {
      existingSwapKeys.add(`${ev.txHash}:${ev.contract.toLowerCase()}:${ev.direction}`)
    }
  }

  // Index priced events by txHash for same-tx counterpart lookup
  const pricedByTx = new Map<string, WalletTxEvidence[]>()
  // Latest priced event per chain:contract for cross-tx price fallback
  const latestPricedByToken = new Map<string, WalletTxEvidence>()

  for (const ev of pricedEvidence) {
    if (ev.priceAtTime?.status !== 'priced' || !ev.priceAtTime.priceUsd) continue
    if (isLPSym(ev.symbol ?? '')) continue
    if (ev.txHash) {
      const arr = pricedByTx.get(ev.txHash) ?? []
      arr.push(ev)
      pricedByTx.set(ev.txHash, arr)
    }
    const tokenKey = `${normalizeChain(ev.chain)}:${ev.contract.toLowerCase()}`
    const prev = latestPricedByToken.get(tokenKey)
    if (!prev || (ev.timestamp ?? '') > (prev.timestamp ?? '')) {
      latestPricedByToken.set(tokenKey, ev)
    }
  }

  const synthetic: WalletTxEvidence[] = []

  for (const e of pricedEvidence) {
    if (e.swapDetection?.isSwapCandidate) continue
    if (e.direction !== 'sell' && e.direction !== 'buy') continue
    if (isLPSym(e.symbol ?? '')) continue
    // Skip events whose symbol looks like a known stablecoin BUT whose contract is NOT a known stable
    // (protects against Cyrillic/unicode spoofed symbols — if symbol matches but contract doesn't, skip)
    if (STABLE_SYMS.has((e.symbol ?? '').toUpperCase()) && !STABLE_USD_CONTRACTS[e.contract.toLowerCase()]) continue
    if (!e.contract || !e.contract.startsWith('0x')) continue
    if (!e.amount || e.amount <= 0) continue
    if (!e.txHash || !e.timestamp) continue
    if (QUOTE_ASSET_CONTRACTS[e.contract.toLowerCase()]) continue

    // Skip events already covered by normalizeSwapEventsForFifo or original swap detection
    const eventKey = `${e.txHash}:${e.contract.toLowerCase()}:${e.direction}`
    if (existingSwapKeys.has(eventKey)) continue

    const thisAmt = parseRawAmount(e.amountRaw, e.tokenDecimals) ?? e.amount
    if (!thisAmt || thisAmt <= 0) continue

    let syntheticPriceUsd: number | null = null
    let priceReason = ''
    let cpSymbol: string | null = null
    let cpAmt: number | null = null

    // 1. Same-tx priced counterpart (any direction, prefer opposite)
    const txPeers = (pricedByTx.get(e.txHash) ?? []).filter(cp => !isLPSym(cp.symbol ?? ''))
    const oppPeers = txPeers.filter(cp => cp.direction !== e.direction && cp.direction !== 'unknown')
    const peer = (oppPeers.length > 0 ? oppPeers : txPeers)[0]
    if (peer?.priceAtTime?.priceUsd) {
      const peerAmt = parseRawAmount(peer.amountRaw, peer.tokenDecimals) ?? peer.amount
      if (peerAmt && peerAmt > 0) {
        syntheticPriceUsd = (peerAmt * peer.priceAtTime.priceUsd) / thisAmt
        priceReason = `Single-leg derived from same-tx ${peer.symbol} leg`
        cpSymbol = peer.symbol
        cpAmt = peerAmt
      }
    }

    // 2. Cross-tx fallback: latest priced event for same token
    if (!syntheticPriceUsd) {
      const tokenKey = `${normalizeChain(e.chain)}:${e.contract.toLowerCase()}`
      const latestForToken = latestPricedByToken.get(tokenKey)
      if (latestForToken?.priceAtTime?.priceUsd) {
        syntheticPriceUsd = latestForToken.priceAtTime.priceUsd
        priceReason = `Price proxy from nearest priced event for ${e.symbol}`
      }
    }

    if (!syntheticPriceUsd || !isFinite(syntheticPriceUsd) || syntheticPriceUsd <= 0) continue

    if (debug) console.log('singleLegPromotion', {
      txHash: e.txHash,
      symbol: e.symbol,
      direction: e.direction,
      syntheticPrice: syntheticPriceUsd,
      counterpartSymbol: cpSymbol,
      counterpartAmount: cpAmt,
    })

    synthetic.push({
      ...e,
      swapDetection: {
        isSwapCandidate: true,
        confidence: 'low',
        eventKind: 'swap_candidate',
        reason: `Single-leg promotion: ${priceReason}`,
        matchedProtocol: e.swapDetection?.matchedProtocol ?? null,
        matchedAddress: e.swapDetection?.matchedAddress ?? null,
      },
      priceAtTime: {
        status: 'priced',
        tokenAddress: e.contract,
        tokenSymbol: e.symbol,
        timestamp: e.timestamp ?? '',
        priceUsd: syntheticPriceUsd,
        source: 'swap_derived',
        confidence: 'low',
        reason: priceReason,
      },
    })
  }

  if (synthetic.length > 0) {
    if (debug) console.log(`normalizeSingleLegEventsForFifo: promoted ${synthetic.length} single-leg events`)
  }

  return [...pricedEvidence, ...synthetic]
}

function numMedian(nums: number[]): number | null {
  if (nums.length === 0) return null
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m]
}

// ── PnL outlier quarantine ────────────────────────────────────────────────────
// Removes lots whose pricing is implausible before they reach trade-stats logic.
// Returns clean lots, quarantined lots, and reasons for audit.
function quarantinePnlOutliers(
  lots: WalletClosedLot[],
  walletTotalValueUsd: number | null,
): {
  cleanLots: WalletClosedLot[]
  quarantinedLots: WalletClosedLot[]
  quarantineReasons: string[]
  sampleQuarantinedLots: Array<{ symbol: string; realizedPnlUsd: number; realizedPnlPercent: number | null; reason: string }>
  maxReturnSeen: number | null
  maxPnlSeen: number | null
  publicStatsBlockedByOutliers: boolean
  scoreBlockedByOutliers: boolean
} {
  const MAX_RETURN_PCT = 10_000      // 100x = 10,000%
  const MAX_PRICE_RATIO = 500        // exit/entry or entry/exit
  // Large-PnL gate: block if |pnl| > max(walletValue * 100, $5M) per lot
  const PNL_USD_HARD_CAP = 5_000_000
  const walletValueCap = walletTotalValueUsd !== null && walletTotalValueUsd > 0
    ? walletTotalValueUsd * 100
    : PNL_USD_HARD_CAP

  const cleanLots: WalletClosedLot[] = []
  const quarantinedLots: WalletClosedLot[] = []
  const reasons: string[] = []
  const sampleQ: Array<{ symbol: string; realizedPnlUsd: number; realizedPnlPercent: number | null; reason: string }> = []

  let maxReturnSeen: number | null = null
  let maxPnlSeen: number | null = null

  for (const lot of lots) {
    const pnlAbs = Math.abs(lot.realizedPnlUsd)
    const retAbs = lot.realizedPnlPercent !== null ? Math.abs(lot.realizedPnlPercent) : null

    if (maxPnlSeen === null || pnlAbs > maxPnlSeen) maxPnlSeen = pnlAbs
    if (retAbs !== null && (maxReturnSeen === null || retAbs > maxReturnSeen)) maxReturnSeen = retAbs

    let reason: string | null = null

    if (lot.costBasisUsd <= 0)      reason = 'cost_basis_lte_zero'
    else if (lot.proceedsUsd <= 0)  reason = 'proceeds_lte_zero'
    else if (lot.entryPriceUsd <= 0) reason = 'entry_price_lte_zero'
    else if (lot.exitPriceUsd <= 0)  reason = 'exit_price_lte_zero'
    else if (lot.amountClosed <= 0)  reason = 'amount_closed_lte_zero'
    else if (retAbs !== null && retAbs > MAX_RETURN_PCT) reason = `return_pct_${Math.round(retAbs)}_exceeds_${MAX_RETURN_PCT}`
    else if (lot.exitPriceUsd / lot.entryPriceUsd > MAX_PRICE_RATIO) reason = `exit_entry_ratio_${(lot.exitPriceUsd / lot.entryPriceUsd).toFixed(0)}x_exceeds_${MAX_PRICE_RATIO}x`
    else if (lot.entryPriceUsd / lot.exitPriceUsd > MAX_PRICE_RATIO) reason = `entry_exit_ratio_${(lot.entryPriceUsd / lot.exitPriceUsd).toFixed(0)}x_exceeds_${MAX_PRICE_RATIO}x`
    else if (pnlAbs > Math.min(walletValueCap, PNL_USD_HARD_CAP)) reason = `pnl_usd_${Math.round(pnlAbs)}_exceeds_cap`

    if (reason) {
      quarantinedLots.push(lot)
      reasons.push(reason)
      if (sampleQ.length < 10) {
        sampleQ.push({ symbol: lot.tokenSymbol ?? lot.tokenAddress.slice(0, 8), realizedPnlUsd: lot.realizedPnlUsd, realizedPnlPercent: lot.realizedPnlPercent, reason })
      }
    } else {
      cleanLots.push(lot)
    }
  }

  // Block public stats if > 50% of lots quarantined (or at least 5 quarantined for small wallets)
  const quarantineFraction = lots.length > 0 ? quarantinedLots.length / lots.length : 0
  const publicStatsBlockedByOutliers = quarantinedLots.length >= 5 || quarantineFraction >= 0.5
  // Block score if any quarantined lots touched aggregate stats
  const scoreBlockedByOutliers = quarantinedLots.length > 0

  return { cleanLots, quarantinedLots, quarantineReasons: [...new Set(reasons)], sampleQuarantinedLots: sampleQ, maxReturnSeen, maxPnlSeen, publicStatsBlockedByOutliers, scoreBlockedByOutliers }
}

// PHASE5-FIX-4: dust threshold is relative to wallet size instead of a flat $25, which
// disproportionately penalized small/Base wallets where every trade is small in absolute USD.
// Scales with 1% of total wallet value, floored at $1 and capped at the old $25 default.
function dustThresholdUsdFor(walletTotalValueUsd: number | null | undefined): number {
  const v = walletTotalValueUsd ?? 0
  if (v <= 0) return 5
  return Math.max(1, Math.min(25, v * 0.01))
}

function buildTradeStatsSummary(
  closedLots: WalletClosedLot[],
  activityRequested: boolean,
  walletTotalValueUsd?: number | null,
): {
  summary: WalletSnapshot['walletTradeStatsSummary']
  debug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletTradeStatsDebug']>
  outlierDebug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletPnlOutlierDebug']>
  outlierNote: string | null
} {
  const WIN_RATE_THRESHOLD = 10
  const BREAK_EVEN_EPSILON = 0.01
  // PHASE5-FIX-4: lots below this USD cost basis are dust; threshold is now relative to
  // wallet size rather than a flat $25 (see dustThresholdUsdFor).
  const DUST_LOT_THRESHOLD = dustThresholdUsdFor(walletTotalValueUsd)

  const emptyResult = (missing: string[]) => ({
    summary: {
      status: 'open_check' as const, closedLots: 0, uniqueTokensTraded: 0,
      realizedPnlUsd: null, realizedPnlPercent: null,
      winningClosedLots: 0, losingClosedLots: 0, breakEvenClosedLots: 0, isBreakEvenOnly: false,
      winRatePercent: null, avgPnlUsdPerClosedLot: null,
      avgReturnPercentPerClosedLot: null, medianReturnPercentPerClosedLot: null,
      avgHoldingTimeSeconds: null, medianHoldingTimeSeconds: null,
      largestWinUsd: null, largestLossUsd: null,
      confidence: 'open_check' as const, sampleSizeLabel: 'insufficient' as const,
      readyForWalletScore: false, rawStatsAvailable: false, scoreUnlocked: false,
      confidenceLabel: 'open_check' as const, sampleWarning: null,
      meaningfulClosedLots: 0, dustClosedLots: 0, meaningfulCostBasisUsd: 0,
      avgCostBasisPerClosedLot: null,
      economicSignificance: 'open_check' as const, economicSignificanceReason: 'no_closed_lots',
      meaningfulRealizedPnlUsd: null, dustThresholdUsd: 0,
      missing,
    },
    debug: {
      closedLots: 0, uniqueTokensTraded: 0, winningClosedLots: 0, losingClosedLots: 0,
      breakEvenClosedLots: 0, winRateComputed: false, winRateThreshold: WIN_RATE_THRESHOLD,
      avgPnlUsdPerClosedLot: null, avgReturnPercentPerClosedLot: null,
      medianReturnPercentPerClosedLot: null, avgHoldingTimeSeconds: null,
      medianHoldingTimeSeconds: null, largestWinUsd: null, largestLossUsd: null,
      confidence: 'open_check', sampleSizeLabel: 'insufficient',
      sampleWinningLots: [], sampleLosingLots: [], reasons: missing,
      economicSignificance: {
        meaningfulClosedLots: 0, dustClosedLots: 0, meaningfulCostBasisUsd: 0,
        dustCostBasisUsd: 0, avgCostBasisPerClosedLot: null,
        economicallyMeaningful: false, reason: 'no_closed_lots',
      },
    },
    outlierDebug: {
      attempted: false, closedLotsBefore: 0, closedLotsAfter: 0, quarantinedLots: 0,
      quarantineReasons: [], sampleQuarantinedLots: [], maxReturnSeen: null, maxPnlSeen: null,
      scoreBlockedByOutliers: false, publicStatsBlockedByOutliers: false,
    },
    outlierNote: null,
  })

  if (!activityRequested) return emptyResult(['activity_not_requested'])
  if (closedLots.length === 0) return emptyResult(['no_closed_lots'])

  // ── Outlier quarantine ──
  const _oq = quarantinePnlOutliers(closedLots, walletTotalValueUsd ?? null)
  const _outlierDebug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletPnlOutlierDebug']> = {
    attempted: true,
    closedLotsBefore: closedLots.length,
    closedLotsAfter: _oq.cleanLots.length,
    quarantinedLots: _oq.quarantinedLots.length,
    quarantineReasons: _oq.quarantineReasons,
    sampleQuarantinedLots: _oq.sampleQuarantinedLots,
    maxReturnSeen: _oq.maxReturnSeen,
    maxPnlSeen: _oq.maxPnlSeen,
    scoreBlockedByOutliers: _oq.scoreBlockedByOutliers,
    publicStatsBlockedByOutliers: _oq.publicStatsBlockedByOutliers,
  }
  const _outlierNote: string | null = _oq.quarantinedLots.length > 0
    ? `CORTEX excluded ${_oq.quarantinedLots.length} trade lot${_oq.quarantinedLots.length !== 1 ? 's' : ''} because their pricing looked abnormal. Remaining stats reflect ${_oq.cleanLots.length} verified lot${_oq.cleanLots.length !== 1 ? 's' : ''}.`
    : null

  // If ALL lots are quarantined, return open_check with outlier info
  if (_oq.cleanLots.length === 0) {
    const r = emptyResult(['all_lots_quarantined_as_outliers'])
    return { ...r, outlierDebug: _outlierDebug, outlierNote: _outlierNote }
  }

  // Use only clean lots from here on
  const allLots = _oq.cleanLots

  const n = allLots.length

  // ── Per-lot classification ──
  const winning = allLots.filter(l => l.realizedPnlUsd > BREAK_EVEN_EPSILON)
  const losing  = allLots.filter(l => l.realizedPnlUsd < -BREAK_EVEN_EPSILON)
  const breakEven = allLots.filter(l => Math.abs(l.realizedPnlUsd) <= BREAK_EVEN_EPSILON)
  const uniqueTokensTraded = new Set(allLots.map(l => `${l.chain}:${l.tokenAddress}`)).size

  // ── Aggregates ──
  const totalRealizedPnl = allLots.reduce((s, l) => s + l.realizedPnlUsd, 0)
  const totalCostBasis = allLots.reduce((s, l) => s + l.costBasisUsd, 0)
  const realizedPnlPercent = totalCostBasis > 0 ? (totalRealizedPnl / totalCostBasis) * 100 : null
  const avgCostBasisPerClosedLot = n > 0 ? totalCostBasis / n : null

  // ── Economic significance ──
  // Lots with costBasis >= DUST_LOT_THRESHOLD are considered meaningful.
  // Status/confidence/winRate/score are gated on BOTH count AND economic significance.
  const meaningfulLots = allLots.filter(l => l.costBasisUsd >= DUST_LOT_THRESHOLD)
  const dustLots = allLots.filter(l => l.costBasisUsd < DUST_LOT_THRESHOLD)
  const meaningfulClosedLots = meaningfulLots.length
  const dustClosedLots = dustLots.length
  const meaningfulCostBasisUsd = meaningfulLots.reduce((s, l) => s + l.costBasisUsd, 0)
  const dustCostBasisUsd = dustLots.reduce((s, l) => s + l.costBasisUsd, 0)
  // PHASE5-FIX-4: realizedPnlUsd (below) intentionally still includes dust lots for API
  // back-compat, but meaningfulRealizedPnlUsd gives callers the dust-excluded figure that
  // matches the population used for confidence/win-rate, so the two no longer silently disagree.
  const meaningfulRealizedPnlUsd = meaningfulLots.reduce((s, l) => s + l.realizedPnlUsd, 0)

  let economicallyMeaningful = false
  let economicSignificanceReason = ''
  if (meaningfulClosedLots >= 5 && meaningfulCostBasisUsd >= 500) {
    economicallyMeaningful = true
    economicSignificanceReason = 'meaningful_lots_gte_5_and_basis_gte_500'
  } else if (totalCostBasis >= 1000 && meaningfulClosedLots >= 3) {
    economicallyMeaningful = true
    economicSignificanceReason = 'total_basis_gte_1000_and_meaningful_lots_gte_3'
  } else if (Math.abs(totalRealizedPnl) >= 50 && totalCostBasis >= 250) {
    economicallyMeaningful = true
    economicSignificanceReason = 'realized_pnl_gte_50_and_basis_gte_250'
  } else {
    economicSignificanceReason = meaningfulClosedLots === 0
      ? 'no_meaningful_lots'
      : `meaningful_lots_${meaningfulClosedLots}_basis_${Math.round(meaningfulCostBasisUsd)}`
  }

  const economicSignificance: 'meaningful' | 'micro_sample' | 'open_check' =
    economicallyMeaningful ? 'meaningful' : 'micro_sample'

  // ── Status / confidence / sampleSizeLabel ──
  // Requires BOTH count thresholds AND economic significance for high labels.
  type Status = 'ok' | 'partial' | 'open_check'
  type Confidence = 'high' | 'medium' | 'low' | 'open_check'
  type SampleLabel = 'insufficient' | 'very_small_sample' | 'small_sample' | 'early_confidence' | 'early' | 'developing' | 'strong' | 'micro_sample'
  let summaryStatus: Status
  let confidence: Confidence
  let sampleSizeLabel: SampleLabel
  if      (n >= 25 && economicallyMeaningful) { summaryStatus = 'ok';      confidence = 'high';   sampleSizeLabel = 'strong' }
  else if (n >= 10 && economicallyMeaningful) { summaryStatus = 'ok';      confidence = 'medium'; sampleSizeLabel = 'developing' }
  else if (n >= 5  && economicallyMeaningful) { summaryStatus = 'partial'; confidence = 'medium'; sampleSizeLabel = 'early' }
  else if (!economicallyMeaningful)           { summaryStatus = 'partial'; confidence = 'low';    sampleSizeLabel = 'micro_sample' }
  else                                        { summaryStatus = 'partial'; confidence = 'low';    sampleSizeLabel = 'insufficient' }

  // Sub-threshold labels for small-sample raw display
  type ConfidenceLabel = 'open_check' | 'break_even_only' | 'very_small_sample' | 'small_sample' | 'early_confidence' | 'developing' | 'high'
  let confidenceLabel: ConfidenceLabel
  let sampleWarning: string | null = null
  if (n >= 25 && economicallyMeaningful) {
    confidenceLabel = 'high'
  } else if (n >= 10 && economicallyMeaningful) {
    confidenceLabel = 'developing'
  } else if (n >= 5) {
    confidenceLabel = 'early_confidence'
    sampleWarning = `Only ${n} closed trades found. Use as early evidence — score unlocks after 10 closed lots.`
  } else if (n >= 3) {
    confidenceLabel = 'small_sample'
    sampleWarning = `Only ${n} closed trades found. Use as early evidence, not a full wallet score.`
    sampleSizeLabel = 'small_sample'
  } else {
    confidenceLabel = 'very_small_sample'
    sampleWarning = `Only ${n} closed trade${n === 1 ? '' : 's'} found. Use as early evidence, not a full wallet score.`
    sampleSizeLabel = 'very_small_sample'
  }

  // ── Win rate: raw rate always computed when n >= 1; official rate requires decisive lots ──
  const decisiveClosedLots = winning.length + losing.length
  const isBreakEvenOnly = n > 0 && decisiveClosedLots === 0 && breakEven.length === n
  const winRateComputed = n >= WIN_RATE_THRESHOLD && decisiveClosedLots >= 1 && !isBreakEvenOnly && economicallyMeaningful
  const winRatePercent = n >= 1 && decisiveClosedLots >= 1 ? (winning.length / n) * 100 : null
  const scoreUnlocked = winRateComputed
  const rawStatsAvailable = n >= 1
  if (isBreakEvenOnly) {
    confidenceLabel = 'break_even_only'
    sampleWarning = 'Closed lots reconstructed, but every matched lot is break-even. Score and official win rate need at least one decisive winning or losing closed lot.'
  }

  const avgPnlUsdPerClosedLot = totalRealizedPnl / n
  const returnPcts = allLots.map(l => l.realizedPnlPercent).filter((v): v is number => v !== null)
  const avgReturnPercentPerClosedLot = returnPcts.length > 0 ? returnPcts.reduce((s, v) => s + v, 0) / returnPcts.length : null
  const medianReturnPercentPerClosedLot = numMedian(returnPcts)

  const holdingTimes = allLots.map(l => l.holdingTimeSeconds).filter((v): v is number => v !== null)
  const avgHoldingTimeSeconds = holdingTimes.length > 0 ? holdingTimes.reduce((s, v) => s + v, 0) / holdingTimes.length : null
  const medianHoldingTimeSeconds = numMedian(holdingTimes)

  const largestWinUsd = winning.length > 0 ? Math.max(...winning.map(l => l.realizedPnlUsd)) : null
  const largestLossUsd = losing.length > 0 ? Math.min(...losing.map(l => l.realizedPnlUsd)) : null

  const missing: string[] = []
  if (!winRateComputed) {
    if (n < WIN_RATE_THRESHOLD) {
      missing.push('win_rate_locked_below_threshold')
      missing.push('sample_size_below_win_rate_threshold')
    }
    if (decisiveClosedLots === 0) {
      missing.push('no_decisive_closed_lots')
    }
    if (n >= WIN_RATE_THRESHOLD && decisiveClosedLots >= 1 && !economicallyMeaningful) {
      missing.push('economic_quality_gate_failed')
    }
  }
  if (breakEven.length > 0) missing.push('break_even_lots_excluded_from_win_rate')
  if (!economicallyMeaningful) missing.push('micro_trade_sample')
  if (returnPcts.length < n) missing.push('some_lots_missing_return_percent')
  if (holdingTimes.length < n) missing.push('some_lots_missing_holding_time')
  // PHASE5-FIX-6: surface the dust-inclusion mismatch explicitly when it's non-trivial — i.e.
  // realizedPnlUsd (all lots) and meaningfulRealizedPnlUsd (dust-excluded) actually disagree —
  // instead of leaving the contradiction implicit between fields.
  if (dustClosedLots > 0 && Math.abs(totalRealizedPnl - meaningfulRealizedPnlUsd) > 0.01) missing.push(`realized_pnl_includes_dust_lots:dust_adjusted=${meaningfulRealizedPnlUsd.toFixed(2)}`)
  // PHASE5-FIX-4: explicit reason key whenever the relative dust threshold (dustThresholdUsdFor)
  // actually excluded at least one lot, so a caller can tell "dust filtering ran and changed the
  // result" apart from "there was simply no dust in this wallet."
  if (dustClosedLots > 0) missing.push(`dust_threshold_applied:${DUST_LOT_THRESHOLD.toFixed(2)}`)

  const abbr = (addr: string) => `${addr.slice(0, 8)}...${addr.slice(-6)}`

  return {
    summary: {
      status: summaryStatus, closedLots: n, uniqueTokensTraded,
      realizedPnlUsd: totalRealizedPnl, realizedPnlPercent,
      winningClosedLots: winning.length, losingClosedLots: losing.length, breakEvenClosedLots: breakEven.length, isBreakEvenOnly,
      winRatePercent, avgPnlUsdPerClosedLot, avgReturnPercentPerClosedLot,
      medianReturnPercentPerClosedLot, avgHoldingTimeSeconds, medianHoldingTimeSeconds,
      largestWinUsd, largestLossUsd, confidence, sampleSizeLabel,
      readyForWalletScore: winRateComputed,
      rawStatsAvailable, scoreUnlocked,
      confidenceLabel, sampleWarning,
      meaningfulClosedLots, dustClosedLots, meaningfulCostBasisUsd,
      avgCostBasisPerClosedLot, economicSignificance, economicSignificanceReason,
      missing,
      meaningfulRealizedPnlUsd, dustThresholdUsd: DUST_LOT_THRESHOLD,
    },
    debug: {
      closedLots: n, uniqueTokensTraded, winningClosedLots: winning.length,
      losingClosedLots: losing.length, breakEvenClosedLots: breakEven.length,
      winRateComputed, winRateThreshold: WIN_RATE_THRESHOLD,
      avgPnlUsdPerClosedLot, avgReturnPercentPerClosedLot, medianReturnPercentPerClosedLot,
      avgHoldingTimeSeconds, medianHoldingTimeSeconds, largestWinUsd, largestLossUsd,
      confidence, sampleSizeLabel,
      sampleWinningLots: winning.slice(0, 5).map(l => ({
        tokenAddress: abbr(l.tokenAddress), symbol: l.tokenSymbol ?? '',
        realizedPnlUsd: l.realizedPnlUsd, realizedPnlPercent: l.realizedPnlPercent, confidence: l.confidence,
      })),
      sampleLosingLots: losing.slice(0, 5).map(l => ({
        tokenAddress: abbr(l.tokenAddress), symbol: l.tokenSymbol ?? '',
        realizedPnlUsd: l.realizedPnlUsd, realizedPnlPercent: l.realizedPnlPercent, confidence: l.confidence,
      })),
      reasons: missing,
      economicSignificance: {
        meaningfulClosedLots, dustClosedLots, meaningfulCostBasisUsd, dustCostBasisUsd,
        avgCostBasisPerClosedLot, economicallyMeaningful, reason: economicSignificanceReason,
      },
    },
    outlierDebug: _outlierDebug,
    outlierNote: _outlierNote,
  }
}

// buildPerSwapTradeStats: fallback trade stats when FIFO closedLots === 0.
// Groups priced events by txHash; treats every tx that has both a priced buy
// and a priced sell as a single closed "trade" and computes per-swap PnL.
function buildPerSwapTradeStats(
  pricedEvidence: WalletTxEvidence[],
  activityRequested: boolean,
  walletTotalValueUsd?: number | null,
): {
  summary: WalletSnapshot['walletTradeStatsSummary']
  debug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletTradeStatsDebug']>
} {
  const WIN_RATE_THRESHOLD = 10
  // PHASE5-FIX-4: relative dust threshold (see dustThresholdUsdFor), not a flat $25.
  const DUST_LOT_THRESHOLD = dustThresholdUsdFor(walletTotalValueUsd)
  const BREAK_EVEN_EPSILON = 0.01

  const emptyResult = (missing: string[]) => ({
    summary: {
      status: 'open_check' as const, closedLots: 0, uniqueTokensTraded: 0,
      realizedPnlUsd: null, realizedPnlPercent: null,
      winningClosedLots: 0, losingClosedLots: 0, breakEvenClosedLots: 0, isBreakEvenOnly: false,
      winRatePercent: null, avgPnlUsdPerClosedLot: null,
      avgReturnPercentPerClosedLot: null, medianReturnPercentPerClosedLot: null,
      avgHoldingTimeSeconds: null, medianHoldingTimeSeconds: null,
      largestWinUsd: null, largestLossUsd: null,
      confidence: 'open_check' as const, sampleSizeLabel: 'insufficient' as const,
      readyForWalletScore: false, rawStatsAvailable: false, scoreUnlocked: false,
      confidenceLabel: 'open_check' as const, sampleWarning: null,
      meaningfulClosedLots: 0, dustClosedLots: 0, meaningfulCostBasisUsd: 0,
      avgCostBasisPerClosedLot: null,
      economicSignificance: 'open_check' as const, economicSignificanceReason: 'no_closed_lots',
      meaningfulRealizedPnlUsd: null, dustThresholdUsd: 0,
      missing,
    },
    debug: {
      closedLots: 0, uniqueTokensTraded: 0, winningClosedLots: 0, losingClosedLots: 0,
      breakEvenClosedLots: 0, winRateComputed: false, winRateThreshold: WIN_RATE_THRESHOLD,
      avgPnlUsdPerClosedLot: null, avgReturnPercentPerClosedLot: null,
      medianReturnPercentPerClosedLot: null, avgHoldingTimeSeconds: null,
      medianHoldingTimeSeconds: null, largestWinUsd: null, largestLossUsd: null,
      confidence: 'open_check', sampleSizeLabel: 'insufficient',
      sampleWinningLots: [] as Array<{ tokenAddress: string; symbol: string; realizedPnlUsd: number; realizedPnlPercent: number | null; confidence: string }>,
      sampleLosingLots: [] as Array<{ tokenAddress: string; symbol: string; realizedPnlUsd: number; realizedPnlPercent: number | null; confidence: string }>,
      reasons: missing,
      economicSignificance: {
        meaningfulClosedLots: 0, dustClosedLots: 0, meaningfulCostBasisUsd: 0,
        dustCostBasisUsd: 0, avgCostBasisPerClosedLot: null,
        economicallyMeaningful: false, reason: 'no_closed_lots',
      },
    },
  })

  if (!activityRequested) return emptyResult(['activity_not_requested'])

  // Group priced events by txHash — skip quote assets as PnL-side tokens
  type TxBucket = { buys: WalletTxEvidence[]; sells: WalletTxEvidence[]; timestamp: string | null }
  const tradesByTx = new Map<string, TxBucket>()

  for (const e of pricedEvidence) {
    if (e.priceAtTime?.status !== 'priced' || !e.priceAtTime.priceUsd) continue
    if (!e.txHash) continue
    if (e.direction !== 'buy' && e.direction !== 'sell') continue
    if (QUOTE_ASSET_CONTRACTS[e.contract.toLowerCase()]) continue

    let bucket = tradesByTx.get(e.txHash)
    if (!bucket) {
      bucket = { buys: [], sells: [], timestamp: e.timestamp }
      tradesByTx.set(e.txHash, bucket)
    }
    if (!bucket.timestamp && e.timestamp) bucket.timestamp = e.timestamp
    if (e.direction === 'buy') bucket.buys.push(e)
    else bucket.sells.push(e)
  }

  type PerSwapTrade = {
    txHash: string
    pnlUsd: number
    costBasisUsd: number
    returnPercent: number | null
    timestamp: string | null
    symbols: string[]
  }

  const closedTrades: PerSwapTrade[] = []

  for (const [txHash, bucket] of tradesByTx) {
    if (bucket.buys.length === 0 || bucket.sells.length === 0) continue

    const buyUsd = bucket.buys.reduce((sum, e) => {
      const amt = parseRawAmount(e.amountRaw, e.tokenDecimals) ?? e.amount
      return sum + amt * e.priceAtTime!.priceUsd!
    }, 0)
    const sellUsd = bucket.sells.reduce((sum, e) => {
      const amt = parseRawAmount(e.amountRaw, e.tokenDecimals) ?? e.amount
      return sum + amt * e.priceAtTime!.priceUsd!
    }, 0)

    if (!isFinite(buyUsd) || !isFinite(sellUsd) || buyUsd <= 0) continue

    const pnlUsd = sellUsd - buyUsd
    const returnPercent = buyUsd > 0 ? (pnlUsd / buyUsd) * 100 : null
    const symbols = [...new Set([...bucket.buys.map(e => e.symbol), ...bucket.sells.map(e => e.symbol)])]
    closedTrades.push({ txHash, pnlUsd, costBasisUsd: buyUsd, returnPercent, timestamp: bucket.timestamp, symbols })
  }

  if (closedTrades.length === 0) return emptyResult(['no_per_swap_trades'])

  const n = closedTrades.length
  const winning = closedTrades.filter(t => t.pnlUsd > BREAK_EVEN_EPSILON)
  const losing  = closedTrades.filter(t => t.pnlUsd < -BREAK_EVEN_EPSILON)
  const breakEven = closedTrades.filter(t => Math.abs(t.pnlUsd) <= BREAK_EVEN_EPSILON)

  const totalRealizedPnl = closedTrades.reduce((s, t) => s + t.pnlUsd, 0)
  const totalCostBasis   = closedTrades.reduce((s, t) => s + t.costBasisUsd, 0)
  const realizedPnlPercent = totalCostBasis > 0 ? (totalRealizedPnl / totalCostBasis) * 100 : null
  const avgCostBasisPerClosedLot = n > 0 ? totalCostBasis / n : null

  const uniqueTokensTraded = new Set(closedTrades.flatMap(t => t.symbols)).size

  const meaningfulTrades = closedTrades.filter(t => t.costBasisUsd >= DUST_LOT_THRESHOLD)
  const dustTrades        = closedTrades.filter(t => t.costBasisUsd < DUST_LOT_THRESHOLD)
  const meaningfulClosedLots   = meaningfulTrades.length
  const dustClosedLots         = dustTrades.length
  const meaningfulCostBasisUsd = meaningfulTrades.reduce((s, t) => s + t.costBasisUsd, 0)
  const dustCostBasisUsd       = dustTrades.reduce((s, t) => s + t.costBasisUsd, 0)
  // PHASE5-FIX-4: dust-excluded realized PnL, mirroring buildTradeStatsSummary.
  const meaningfulRealizedPnlUsd = meaningfulTrades.reduce((s, t) => s + t.pnlUsd, 0)

  let economicallyMeaningful = false
  let economicSignificanceReason = ''
  if (meaningfulClosedLots >= 5 && meaningfulCostBasisUsd >= 500) {
    economicallyMeaningful = true; economicSignificanceReason = 'meaningful_lots_gte_5_and_basis_gte_500'
  } else if (totalCostBasis >= 1000 && meaningfulClosedLots >= 3) {
    economicallyMeaningful = true; economicSignificanceReason = 'total_basis_gte_1000_and_meaningful_lots_gte_3'
  } else if (Math.abs(totalRealizedPnl) >= 50 && totalCostBasis >= 250) {
    economicallyMeaningful = true; economicSignificanceReason = 'realized_pnl_gte_50_and_basis_gte_250'
  } else {
    economicSignificanceReason = meaningfulClosedLots === 0
      ? 'no_meaningful_lots'
      : `meaningful_lots_${meaningfulClosedLots}_basis_${Math.round(meaningfulCostBasisUsd)}`
  }

  const economicSignificance: 'meaningful' | 'micro_sample' | 'open_check' =
    economicallyMeaningful ? 'meaningful' : 'micro_sample'

  type Status = 'ok' | 'partial' | 'open_check'
  type Confidence = 'high' | 'medium' | 'low' | 'open_check'
  type SampleLabel = 'insufficient' | 'very_small_sample' | 'small_sample' | 'early_confidence' | 'early' | 'developing' | 'strong' | 'micro_sample'
  let summaryStatus: Status
  let confidence: Confidence
  let sampleSizeLabel: SampleLabel
  if      (n >= 25 && economicallyMeaningful) { summaryStatus = 'ok';      confidence = 'medium'; sampleSizeLabel = 'strong' }
  else if (n >= 10 && economicallyMeaningful) { summaryStatus = 'ok';      confidence = 'medium'; sampleSizeLabel = 'developing' }
  else if (n >= 5  && economicallyMeaningful) { summaryStatus = 'partial'; confidence = 'low';    sampleSizeLabel = 'early' }
  else if (!economicallyMeaningful)           { summaryStatus = 'partial'; confidence = 'low';    sampleSizeLabel = 'micro_sample' }
  else                                        { summaryStatus = 'partial'; confidence = 'low';    sampleSizeLabel = 'insufficient' }

  type ConfidenceLabel = 'open_check' | 'break_even_only' | 'very_small_sample' | 'small_sample' | 'early_confidence' | 'developing' | 'high'
  let confidenceLabel: ConfidenceLabel
  let sampleWarning: string | null = null
  if (n >= 10 && economicallyMeaningful) { confidenceLabel = 'developing' }
  else if (n >= 5) { confidenceLabel = 'early_confidence'; sampleWarning = `Only ${n} closed trades found. Use as early evidence — score unlocks after 10 closed lots.`; sampleSizeLabel = 'early_confidence' }
  else if (n >= 3) { confidenceLabel = 'small_sample'; sampleWarning = `Only ${n} closed trades found. Use as early evidence, not a full wallet score.`; sampleSizeLabel = 'small_sample' }
  else { confidenceLabel = 'very_small_sample'; sampleWarning = `Only ${n} closed trade${n === 1 ? '' : 's'} found. Use as early evidence, not a full wallet score.`; sampleSizeLabel = 'very_small_sample' }

  const decisiveClosedLots = winning.length + losing.length
  const isBreakEvenOnly = n > 0 && decisiveClosedLots === 0 && breakEven.length === n
  const winRateComputed = n >= WIN_RATE_THRESHOLD && decisiveClosedLots >= 1 && !isBreakEvenOnly && economicallyMeaningful
  const winRatePercent = n >= 1 && decisiveClosedLots >= 1 ? (winning.length / n) * 100 : null
  const scoreUnlocked = winRateComputed
  const rawStatsAvailable = n >= 1
  if (isBreakEvenOnly) {
    confidenceLabel = 'break_even_only'
    sampleWarning = 'Closed lots reconstructed, but every matched trade is break-even. Score and official win rate need at least one decisive winning or losing closed lot.'
  }
  const avgPnlUsdPerClosedLot = totalRealizedPnl / n

  const returnPcts = closedTrades.map(t => t.returnPercent).filter((v): v is number => v !== null)
  const avgReturnPercentPerClosedLot = returnPcts.length > 0 ? returnPcts.reduce((s, v) => s + v, 0) / returnPcts.length : null
  const medianReturnPercentPerClosedLot = numMedian(returnPcts)

  const largestWinUsd  = winning.length > 0 ? Math.max(...winning.map(t => t.pnlUsd)) : null
  const largestLossUsd = losing.length  > 0 ? Math.min(...losing.map(t => t.pnlUsd))  : null

  const missing: string[] = ['per_swap_fallback_mode']
  if (!winRateComputed) {
    if (n < WIN_RATE_THRESHOLD) {
      missing.push('win_rate_locked_below_threshold')
      missing.push('sample_size_below_win_rate_threshold')
    }
    if (decisiveClosedLots === 0) {
      missing.push('no_decisive_closed_lots')
    }
    if (n >= WIN_RATE_THRESHOLD && decisiveClosedLots >= 1 && !economicallyMeaningful) {
      missing.push('economic_quality_gate_failed')
    }
  }
  if (breakEven.length > 0) missing.push('break_even_lots_excluded_from_win_rate')
  if (!economicallyMeaningful)   missing.push('micro_trade_sample')
  // PHASE5-FIX-6: same dust-inclusion disclosure as buildTradeStatsSummary.
  if (dustClosedLots > 0 && Math.abs(totalRealizedPnl - meaningfulRealizedPnlUsd) > 0.01) missing.push(`realized_pnl_includes_dust_lots:dust_adjusted=${meaningfulRealizedPnlUsd.toFixed(2)}`)
  // PHASE5-FIX-4: same dust_threshold_applied disclosure as buildTradeStatsSummary.
  if (dustClosedLots > 0) missing.push(`dust_threshold_applied:${DUST_LOT_THRESHOLD.toFixed(2)}`)

  const abbr = (h: string) => `${h.slice(0, 8)}...${h.slice(-6)}`

  return {
    summary: {
      status: summaryStatus, closedLots: n, uniqueTokensTraded,
      realizedPnlUsd: totalRealizedPnl, realizedPnlPercent,
      winningClosedLots: winning.length, losingClosedLots: losing.length, breakEvenClosedLots: breakEven.length, isBreakEvenOnly,
      winRatePercent, avgPnlUsdPerClosedLot, avgReturnPercentPerClosedLot,
      medianReturnPercentPerClosedLot, avgHoldingTimeSeconds: null, medianHoldingTimeSeconds: null,
      largestWinUsd, largestLossUsd, confidence, sampleSizeLabel,
      readyForWalletScore: winRateComputed,
      rawStatsAvailable, scoreUnlocked,
      confidenceLabel, sampleWarning,
      meaningfulClosedLots, dustClosedLots, meaningfulCostBasisUsd,
      avgCostBasisPerClosedLot, economicSignificance, economicSignificanceReason,
      meaningfulRealizedPnlUsd, dustThresholdUsd: DUST_LOT_THRESHOLD,
      missing,
    },
    debug: {
      closedLots: n, uniqueTokensTraded,
      winningClosedLots: winning.length, losingClosedLots: losing.length, breakEvenClosedLots: breakEven.length,
      winRateComputed, winRateThreshold: WIN_RATE_THRESHOLD,
      avgPnlUsdPerClosedLot, avgReturnPercentPerClosedLot, medianReturnPercentPerClosedLot,
      avgHoldingTimeSeconds: null, medianHoldingTimeSeconds: null,
      largestWinUsd, largestLossUsd, confidence, sampleSizeLabel,
      sampleWinningLots: winning.slice(0, 5).map(t => ({
        tokenAddress: abbr(t.txHash), symbol: t.symbols.join('/'),
        realizedPnlUsd: t.pnlUsd, realizedPnlPercent: t.returnPercent, confidence,
      })),
      sampleLosingLots: losing.slice(0, 5).map(t => ({
        tokenAddress: abbr(t.txHash), symbol: t.symbols.join('/'),
        realizedPnlUsd: t.pnlUsd, realizedPnlPercent: t.returnPercent, confidence,
      })),
      reasons: missing,
      economicSignificance: {
        meaningfulClosedLots, dustClosedLots, meaningfulCostBasisUsd, dustCostBasisUsd,
        avgCostBasisPerClosedLot, economicallyMeaningful, reason: economicSignificanceReason,
      },
    },
  }
}

// Budget-accounting fix: peek whether a (chain, contract, date) lookup is already cached
// (request-local or process-level) before charging it against the price-attempt budget.
// Previously every WETH-leg lookup incremented priceAttempts even when it was the same
// leg already resolved earlier in the same request (e.g. a buy+sell pair sharing one WETH
// quote leg), silently starving the remaining swap candidates — most visible on
// micro-wallets where the budget is only a handful of attempts.
// PHASE2-FIX-6: cache key already includes timestamp (via dateStr below), not just
// tokenAddress — `pat:${grChain}:${contractAddress}:${dateStr}` keys on both. The bucket is
// calendar-day, not a 60-second window, because GoldRush's historical pricing endpoint
// itself only has daily resolution (`historical_by_addresses_v2` takes from/to dates, not
// timestamps) — a 60-second bucket would fragment the cache key far below the provider's
// actual granularity, multiplying redundant provider calls for the exact same priced day
// with zero precision benefit. Day-bucketing here is the correct granularity for this
// provider; a finer bucket would be a regression, not a fix.
function isGoldrushPriceCached(chain: string, contractAddress: string, timestamp: string, reqCache?: Map<string, number | null>): boolean {
  if (!contractAddress.startsWith('0x')) return false
  const dateStr = timestamp.slice(0, 10)
  if (!dateStr || dateStr.length !== 10) return false
  const grChain = normalizeChainForGoldrush(chain)
  const reqKey = `${grChain}:${contractAddress.toLowerCase()}:${dateStr}`
  if (reqCache?.has(reqKey)) return true
  const cacheKey = `pat:${grChain}:${contractAddress.toLowerCase()}:${dateStr}`
  const cached = priceAtTimeMemCache.get(cacheKey)
  return Boolean(cached && cached.exp > Date.now())
}

async function fetchGoldrushHistoricalPrice(chain: string, contractAddress: string, timestamp: string, reqCache?: Map<string, number | null>): Promise<{ priceUsd: number | null; cacheHit: boolean; providerAttempted: boolean; error: boolean }> {
  if (!GOLDRUSH_KEY || !contractAddress.startsWith('0x')) return { priceUsd: null, cacheHit: false, providerAttempted: false, error: false }
  const dateStr = timestamp.slice(0, 10)
  if (!dateStr || dateStr.length !== 10) return { priceUsd: null, cacheHit: false, providerAttempted: false, error: false }
  // Normalize chain for GoldRush API: Alchemy emits 'base', GoldRush needs 'base-mainnet'
  const grChain = normalizeChainForGoldrush(chain)
  const reqKey = `${grChain}:${contractAddress.toLowerCase()}:${dateStr}`
  if (reqCache?.has(reqKey)) return { priceUsd: reqCache.get(reqKey) ?? null, cacheHit: true, providerAttempted: false, error: false }
  const cacheKey = `pat:${grChain}:${contractAddress.toLowerCase()}:${dateStr}`
  const cached = priceAtTimeMemCache.get(cacheKey)
  if (cached && cached.exp > Date.now()) { reqCache?.set(reqKey, cached.priceUsd); return { priceUsd: cached.priceUsd, cacheHit: true, providerAttempted: false, error: false } }
  const toDate = new Date(new Date(dateStr).getTime() + 2 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const url = `https://api.covalenthq.com/v1/pricing/historical_by_addresses_v2/${grChain}/USD/${contractAddress.toLowerCase()}/?from=${dateStr}&to=${toDate}`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${GOLDRUSH_KEY}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(6_000),
    })
    if (!res.ok) {
      priceAtTimeMemCache.set(cacheKey, { exp: Date.now() + 5 * 60 * 1000, priceUsd: null })
      reqCache?.set(reqKey, null)
      return { priceUsd: null, cacheHit: false, providerAttempted: true, error: true }
    }
    const json = await res.json() as Record<string, unknown>
    const data = Array.isArray(json.data) ? json.data : []
    const tokenData = (data[0] ?? {}) as Record<string, unknown>
    const prices = Array.isArray(tokenData.prices) ? tokenData.prices : []
    // Fallback fix: prices[0] is whatever the provider happens to return first — not
    // necessarily the requested date, and on a short window it can be today's price. When
    // there's no exact date match, fall back to the entry with the smallest date distance
    // to the requested day instead of blindly taking index 0, so a missing bucket doesn't
    // silently substitute "current price" for a historical lookup.
    const targetMs = new Date(dateStr).getTime()
    let priceEntry: Record<string, unknown> | null = null
    let bestDeltaMs = Infinity
    for (const p of prices) {
      const rec = p as Record<string, unknown>
      const pDate = typeof rec.date === 'string' ? rec.date.slice(0, 10) : null
      if (!pDate) continue
      if (pDate === dateStr) { priceEntry = rec; break }
      const delta = Math.abs(new Date(pDate).getTime() - targetMs)
      if (delta < bestDeltaMs) { bestDeltaMs = delta; priceEntry = rec }
    }
    const rawPriceUsd = typeof priceEntry?.price === 'number' ? priceEntry.price as number : null
    // Sanity check: reject non-finite, zero, negative, or implausibly tiny values (a common
    // symptom of a decimals mismatch upstream) rather than letting them corrupt cost basis.
    const priceUsd = (rawPriceUsd != null && Number.isFinite(rawPriceUsd) && rawPriceUsd > 1e-12) ? rawPriceUsd : null
    priceAtTimeMemCache.set(cacheKey, { exp: Date.now() + PRICE_AT_TIME_TTL_MS, priceUsd })
    reqCache?.set(reqKey, priceUsd)
    return { priceUsd, cacheHit: false, providerAttempted: true, error: false }
  } catch {
    priceAtTimeMemCache.set(cacheKey, { exp: Date.now() + 5 * 60 * 1000, priceUsd: null })
    reqCache?.set(reqKey, null)
    return { priceUsd: null, cacheHit: false, providerAttempted: true, error: true }
  }
}

async function buildPriceAtTimeEvidence(
  evidenceWithDetection: WalletTxEvidence[],
  activityRequested: boolean,
  reqCache?: Map<string, number | null>,
  priceByContract?: Map<string, number>,
  totalValueUsd?: number | null,
  maxBudgetOverride?: number | null
): Promise<{
  evidenceWithPricing: WalletTxEvidence[]
  summary: WalletSnapshot['walletPriceEvidenceSummary']
  debug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletPriceAtTimeDebug']>
  budgetDebug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletPriceBudgetDebug']>
}> {
  // Tier-based budget: micro=4, small=8, standard=10, high_value=12, whale=12
  // maxBudgetOverride (numeric) takes priority; otherwise derive from totalValueUsd tier
  const _inferredTier = computeWalletValueTier(totalValueUsd)
  const _tierBudget = maxBudgetOverride != null ? maxBudgetOverride : TIER_PRICE_BUDGET[_inferredTier]
  const BASE_BUDGET     = Math.max(1, _tierBudget)
  const EXPANDED_BUDGET = Math.max(BASE_BUDGET + 1, parseInt(process.env.CHAINLENS_WALLET_PRICE_ATTEMPT_EXPANDED ?? '10', 10) || 10)
  const PUBLIC_MAX_PRICE_BUDGET = Math.max(EXPANDED_BUDGET + 1, parseInt(process.env.CHAINLENS_WALLET_PRICE_ATTEMPT_MAX  ?? '12', 10) || 12)
  const MAX_BUDGET      = Math.max(BASE_BUDGET, Math.min(PUBLIC_MAX_PRICE_BUDGET, maxBudgetOverride ?? PUBLIC_MAX_PRICE_BUDGET))
  let activeBudget = BASE_BUDGET  // raised between passes when expansion criteria met

  const _emptyBudgetDebug = (): NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletPriceBudgetDebug']> => ({
    baseBudget: BASE_BUDGET, expandedBudget: EXPANDED_BUDGET, maxBudget: MAX_BUDGET,
    initialCandidates: 0, prioritizedCandidates: 0,
    pass1Attempts: 0, pass1PricedEvents: 0, pass1ClosedLots: 0,
    expansionEligible: false, expansionReason: null,
    pass2Attempts: 0, pass2PricedEvents: 0,
    finalPriceAttempts: 0, finalPricedEvents: 0, finalClosedLots: 0,
    budgetCapHit: false, skippedBecauseEnoughEvidence: false,
    skippedBecauseDailyCap: false, estimatedExtraCredits: 0,
    samplePrioritizedCandidates: [],
  })

  const emptyResult = (missing: string[]) => ({
    evidenceWithPricing: evidenceWithDetection,
    summary: {
      status: 'open_check' as const, swapCandidateEvents: 0, pricedEvents: 0,
      openCheckEvents: 0, unavailableEvents: 0,
      stableLegPricedEvents: 0, wethLegPricedEvents: 0, historicalPricedEvents: 0,
      providerEventUsdPricedEvents: 0, currentHoldingPricedEvents: 0,
      priceAttemptLimitReached: false, readyForLotMatching: false, missing,
    },
    debug: {
      swapCandidateEvents: 0, priceAttempts: 0, pricedEvents: 0, openCheckEvents: 0,
      unavailableEvents: 0, stableLegPricedEvents: 0, wethLegPricedEvents: 0,
      historicalPricedEvents: 0, providerEventUsdAttempts: 0, providerEventUsdPricedEvents: 0,
      priceAttemptLimitReached: false,
      skippedNoTimestamp: 0, skippedNoTokenAddress: 0, skippedNoAmount: 0,
      skippedNoStableOrWethLeg: 0, skippedNoQuoteLeg: 0,
      skippedProviderUsdMissing: 0, skippedProviderUsdInvalid: 0, skippedHistoricalUnavailable: 0,
      currentHoldingPriceAttempts: 0, currentHoldingPriceOpenLotEvents: 0,
      skippedCurrentPriceNotAllowedForRealized: 0,
      historicalPriceAttempts: 0, historicalPricePricedEvents: 0,
      cacheHits: 0, cacheMisses: 0, providerAttempts: 0, providerErrors: 0,
      samplePricedEvents: [], sampleOpenCheckEvents: [], sampleUnpricedReasons: [], reasons: missing,
    },
    budgetDebug: _emptyBudgetDebug(),
  })

  if (!activityRequested) return emptyResult(['activity_not_requested'])

  const swapCandidateEvents = evidenceWithDetection.filter(e => e.swapDetection?.isSwapCandidate).length
  if (swapCandidateEvents === 0) return emptyResult(['no_swap_candidates'])

  // Group all events by txHash for stable/WETH leg lookup
  const allByTx = new Map<string, WalletTxEvidence[]>()
  for (const e of evidenceWithDetection) {
    if (e.txHash) allByTx.set(e.txHash, [...(allByTx.get(e.txHash) ?? []), e])
  }

  // Priority scorer: lower tier = processed first (cheap/reliable candidates first)
  // Tier 0: stablecoin (free, exact)
  // Tier 1: has stable quote leg in same tx (free, derived)
  // Tier 2: has WETH quote leg in same tx (1 credit, reliable)
  // Tier 3: has provider USD value (free, medium confidence)
  // Tier 4: currently held token — buy direction (free, open-lot only)
  // Tier 5: other (direct historical lookup, 1 credit, may fail)
  const getCandidatePriority = (e: WalletTxEvidence): [number, number] => {
    const cl = (e.contract ?? '').toLowerCase()
    if (Boolean(STABLE_USD_CONTRACTS[cl])) return [0, 0]
    const txGroup = allByTx.get(e.txHash) ?? []
    const hasStableLeg = txGroup.some(ev => {
      const c = (ev.contract ?? '').toLowerCase()
      return Boolean(STABLE_USD_CONTRACTS[c]) && ev.direction !== 'unknown' && ev.direction !== e.direction
        && ev.swapDetection?.eventKind !== 'airdrop_candidate'
    })
    if (hasStableLeg) return [1, -(e.usdValue ?? 0)]
    const hasWethLeg = txGroup.some(ev => {
      const c = (ev.contract ?? '').toLowerCase()
      return Boolean(WETH_CONTRACTS_PRICE[c]) && ev.direction !== 'unknown' && ev.direction !== e.direction
        && ev.swapDetection?.eventKind !== 'airdrop_candidate'
    })
    if (hasWethLeg) return [2, -(e.usdValue ?? 0)]
    if ((e.usdValue ?? 0) > 0) return [3, -(e.usdValue ?? 0)]
    if (priceByContract?.has(cl)) return [4, 0]
    return [5, -(e.usdValue ?? 0)]
  }

  let priceAttempts = 0
  let pricedEvents = 0
  let openCheckEvents = 0
  const unavailableEvents = 0
  let stableLegPricedEvents = 0
  let wethLegPricedEvents = 0
  let historicalPricedEvents = 0
  let providerEventUsdAttempts = 0
  let providerEventUsdPricedEvents = 0
  let priceAttemptLimitReached = false
  let skippedNoTimestamp = 0
  let skippedNoTokenAddress = 0
  let skippedNoAmount = 0
  let skippedNoStableOrWethLeg = 0
  let skippedNoQuoteLeg = 0
  let skippedProviderUsdMissing = 0
  let skippedProviderUsdInvalid = 0
  let skippedHistoricalUnavailable = 0
  let currentHoldingPriceAttempts = 0
  let currentHoldingPriceOpenLotEvents = 0
  let skippedCurrentPriceNotAllowedForRealized = 0
  let historicalPriceAttempts = 0
  let historicalPricePricedEvents = 0
  let cacheHits = 0
  let cacheMisses = 0
  let providerAttempts = 0
  let providerErrors = 0
  const samplePricedRaw: WalletTxEvidence[] = []
  const sampleOpenCheckRaw: WalletTxEvidence[] = []
  const sampleUnpricedRaw: Array<{
    txHash: string; direction: string; tokenSymbol: string; tokenContract: string; chain: string
    amount: number; hasProviderUsdValue: boolean; providerUsdValue: number | null; valueUsdKnown: boolean
    hasCurrentHoldingPrice: boolean; currentHoldingPrice: number | null; isCurrentlyHeld: boolean
    hasStableLeg: boolean; hasWethLeg: boolean; historicalAttempted: boolean; historicalPriceFound: boolean
    finalReason: string
  }> = []

  const openCheck = (e: WalletTxEvidence, reason: string): WalletTxEvidence => {
    const ev: WalletTxEvidence = { ...e, priceAtTime: { status: 'open_check', tokenAddress: e.contract, tokenSymbol: e.symbol, timestamp: e.timestamp ?? '', priceUsd: null, source: 'unavailable', confidence: 'open_check', reason } }
    openCheckEvents++
    if (sampleOpenCheckRaw.length < 5) sampleOpenCheckRaw.push(ev)
    return ev
  }

  const priced = (e: WalletTxEvidence, priceUsd: number, source: PriceAtTimeEvidence['source'], confidence: PriceAtTimeEvidence['confidence'], reason: string): WalletTxEvidence => {
    const ev: WalletTxEvidence = { ...e, priceAtTime: { status: 'priced', tokenAddress: e.contract, tokenSymbol: e.symbol, timestamp: e.timestamp ?? '', priceUsd, source, confidence, reason } }
    pricedEvents++
    if (source === 'stable_leg') stableLegPricedEvents++
    else if (source === 'weth_leg') wethLegPricedEvents++
    else if (source === 'historical_price') historicalPricedEvents++
    else if (source === 'provider_event_usd') providerEventUsdPricedEvents++
    if (samplePricedRaw.length < 5) samplePricedRaw.push(ev)
    return ev
  }

  // ── Candidate sorting: separate swap candidates, sort by pricing priority ──────────────────
  const _indexedCandidates = evidenceWithDetection
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.swapDetection?.isSwapCandidate)

  const _sortedCandidates = [..._indexedCandidates].sort((a, b) => {
    const [pa, sa] = getCandidatePriority(a.e)
    const [pb, sb] = getCandidatePriority(b.e)
    return pa !== pb ? pa - pb : sa - sb  // by tier, then by USD value desc
  })

  // PHASE2-FIX-1: deterministic price source priority. _priceOneCandidate below is a single
  // sequential function (not concurrent provider races), so source selection is already a
  // fixed-order waterfall rather than "whichever provider returns first": (1) stable_leg
  // ($1 by definition), (2) same-tx stable quote leg, (3) same-tx WETH/wrapped-native quote
  // leg (GoldRush historical price for the WETH leg), (4) provider_event_usd (the event's own
  // provider-supplied USD value), (5) historical_price (GoldRush historical price for the
  // token itself), (6) current_holding_price_open_lot_estimate (last-known/current price,
  // buy-side only, explicitly excluded from realized PnL), else open_check. This order is
  // fixed in code and never depends on which provider's events happened to merge in first.
  // Per-candidate pricing logic (extracted from the original flat loop)
  async function _priceOneCandidate(e: WalletTxEvidence): Promise<WalletTxEvidence> {
    if (!e.timestamp) { skippedNoTimestamp++; return openCheck(e, 'No timestamp available') }
    if (!e.contract || !e.contract.startsWith('0x')) { skippedNoTokenAddress++; return openCheck(e, 'Missing token contract address') }

    const contractLower = e.contract.toLowerCase()
    const isStable = Boolean(STABLE_USD_CONTRACTS[contractLower])
    const isWeth = Boolean(WETH_CONTRACTS_PRICE[contractLower])
    let _hadWethLeg = false

    if (isStable) return priced(e, 1.0, 'stable_leg', 'high', 'Stablecoin — price is $1 USD by definition')

    const tokenAmount = parseRawAmount(e.amountRaw, e.tokenDecimals) ?? e.amount
    if (!tokenAmount || tokenAmount <= 0) { skippedNoAmount++; return openCheck(e, 'Token amount is zero or unavailable') }

    const txGroup = allByTx.get(e.txHash) ?? []

    const stableQuote = selectSameTxStableQuoteLeg(txGroup, e)
    if (stableQuote) {
      const derivedPrice = stableQuote.amountUsd / tokenAmount
      if (derivedPrice > 0 && isFinite(derivedPrice)) {
        return priced(e, derivedPrice, 'stable_leg', 'high', stableQuote.reason)
      }
    }

    let _resolvedFromWethOrStable = Boolean(stableQuote)
    if (!isWeth) {
      const wethLegs = txGroup.filter(ev => {
        const c = ev.contract?.toLowerCase() ?? ''
        // PHASE1-FIX-4: same airdrop/rebate separation as selectSameTxStableQuoteLeg above —
        // exclude legs already classified as their own airdrop_candidate from quote selection.
        return Boolean(WETH_CONTRACTS_PRICE[c]) && ev.direction !== 'unknown' && ev.direction !== e.direction
          && ev.swapDetection?.eventKind !== 'airdrop_candidate'
      })
      if (wethLegs.length > 0) {
        _resolvedFromWethOrStable = true
        _hadWethLeg = true
        // PHASE1-FIX-5: picking wethLegs[0] made the derived price depend on raw provider
        // arrival order — out-of-order legs from multi-page/multi-provider merges could flip
        // which WETH leg priced the swap. amountRaw/timestamp don't carry an intra-tx ordinal
        // (no blockNumber/logIndex is tracked on PnlEvent), so instead of an arrival-order pick,
        // deterministically select the largest-amount WETH leg — same "dominant leg" principle
        // already used by selectSameTxStableQuoteLeg, independent of merge/arrival order.
        const wl = [...wethLegs].sort((a, b) => {
          const aAmt = parseRawAmount(a.amountRaw, a.tokenDecimals) ?? a.amount
          const bAmt = parseRawAmount(b.amountRaw, b.tokenDecimals) ?? b.amount
          return bAmt - aAmt
        })[0]
        const _wethAlreadyCached = isGoldrushPriceCached(wl.chain, wl.contract, e.timestamp, reqCache)
        if (!_wethAlreadyCached && priceAttempts >= activeBudget) {
          priceAttemptLimitReached = true
          return openCheck(e, 'price_attempt_limit_reached')
        }
        if (!_wethAlreadyCached) priceAttempts++
        const result = await fetchGoldrushHistoricalPrice(wl.chain, wl.contract, e.timestamp, reqCache)
        if (result.cacheHit) cacheHits++; else cacheMisses++
        if (result.providerAttempted) providerAttempts++
        if (result.error) providerErrors++
        if (result.priceUsd !== null) {
          const wethAmt = parseRawAmount(wl.amountRaw, wl.tokenDecimals) ?? wl.amount
          if (wethAmt > 0) {
            const derivedPrice = (wethAmt * result.priceUsd) / tokenAmount
            if (derivedPrice > 0 && isFinite(derivedPrice)) {
              return priced(e, derivedPrice, 'weth_leg', 'medium', `Derived from WETH leg (WETH×${result.priceUsd.toFixed(0)} × WETH amount / token amount)`)
            }
          }
        }
      }
    }
    if (!_resolvedFromWethOrStable) { skippedNoStableOrWethLeg++; skippedNoQuoteLeg++ }

    providerEventUsdAttempts++
    const _provUsd = e.usdValue
    if (_provUsd !== null && _provUsd !== undefined && !isFinite(_provUsd)) {
      skippedProviderUsdInvalid++
    } else if (_provUsd && _provUsd > 0 && isFinite(_provUsd) && tokenAmount > 0) {
      const _provDerivedPrice = _provUsd / tokenAmount
      if (_provDerivedPrice > 0 && isFinite(_provDerivedPrice) && _provDerivedPrice < 1_000_000) {
        return priced(e, _provDerivedPrice, 'provider_event_usd', 'medium',
          `Derived from provider event USD value ($${_provUsd.toFixed(4)} / ${tokenAmount.toFixed(6)} tokens)`)
      }
    } else {
      skippedProviderUsdMissing++
    }

    const _histAlreadyCached = isGoldrushPriceCached(e.chain, e.contract, e.timestamp, reqCache)
    if (!_histAlreadyCached && priceAttempts >= activeBudget) {
      priceAttemptLimitReached = true
      return openCheck(e, 'price_attempt_limit_reached')
    }
    if (!_histAlreadyCached) priceAttempts++
    historicalPriceAttempts++
    const histResult = await fetchGoldrushHistoricalPrice(e.chain, e.contract, e.timestamp, reqCache)
    if (histResult.cacheHit) cacheHits++; else cacheMisses++
    if (histResult.providerAttempted) providerAttempts++
    if (histResult.error) providerErrors++
    if (histResult.priceUsd !== null) {
      historicalPricePricedEvents++
      return priced(e, histResult.priceUsd, 'historical_price', 'medium', `Historical token price from on-chain pricing data`)
    }
    skippedHistoricalUnavailable++

    if (e.direction === 'buy' && priceByContract) {
      currentHoldingPriceAttempts++
      const currentPrice = priceByContract.get(contractLower)
      if (currentPrice && currentPrice > 0 && isFinite(currentPrice)) {
        currentHoldingPriceOpenLotEvents++
        return priced(e, currentPrice, 'current_holding_price_open_lot_estimate', 'low',
          `Current holding price ($${currentPrice.toFixed(4)}) — open-lot estimate only, not for realized PnL`)
      }
    } else if (e.direction === 'sell') {
      skippedCurrentPriceNotAllowedForRealized++
    }

    const _openCheckReason = !_resolvedFromWethOrStable
      ? (e.direction === 'sell' ? 'sell_candidate_missing_exit_price' : 'no_stable_or_weth_leg')
      : !_provUsd || _provUsd <= 0
        ? (e.direction === 'sell' ? 'sell_candidate_missing_exit_price' : 'provider_event_usd_missing')
        : histResult.error
          ? 'historical_price_unavailable'
          : 'no_reliable_price_evidence'
    if (sampleUnpricedRaw.length < 10) {
      const _chPrice = priceByContract?.get(contractLower) ?? null
      sampleUnpricedRaw.push({
        txHash: e.txHash.slice(0, 10) + '…', direction: e.direction,
        tokenSymbol: e.symbol ?? '?', tokenContract: contractLower,
        chain: e.chain, amount: tokenAmount,
        hasProviderUsdValue: (_provUsd ?? 0) > 0, providerUsdValue: _provUsd ?? null,
        valueUsdKnown: (_provUsd ?? 0) > 0,
        hasCurrentHoldingPrice: _chPrice !== null && _chPrice > 0,
        currentHoldingPrice: _chPrice,
        isCurrentlyHeld: _chPrice !== null && _chPrice > 0,
        hasStableLeg: Boolean(stableQuote), hasWethLeg: _hadWethLeg,
        historicalAttempted: true, historicalPriceFound: (histResult.priceUsd ?? null) !== null,
        finalReason: _openCheckReason,
      })
    }
    return openCheck(e, _openCheckReason)
  }

  // ── Pass 1: price sorted candidates up to BASE_BUDGET provider calls ─────────────────────
  activeBudget = BASE_BUDGET
  const _pass1ResultByIdx = new Map<number, WalletTxEvidence>()

  for (const { e, i } of _sortedCandidates) {
    if (priceAttempts >= BASE_BUDGET) break  // budget exhausted — stop and evaluate expansion
    const result = await _priceOneCandidate(e)
    _pass1ResultByIdx.set(i, result)
  }
  const _pass1Attempts = priceAttempts
  const _pass1Priced = pricedEvents

  // Lightweight FIFO preview using pass-1 results (no normalization — just for closed-lot count)
  const _pass1PreviewEvidence: WalletTxEvidence[] = evidenceWithDetection.map((ev, i) => {
    if (!ev.swapDetection?.isSwapCandidate) return ev
    const processed = _pass1ResultByIdx.get(i)
    if (processed) return processed
    return { ...ev, priceAtTime: { status: 'open_check' as const, tokenAddress: ev.contract, tokenSymbol: ev.symbol, timestamp: ev.timestamp ?? '', priceUsd: null, source: 'unavailable' as const, confidence: 'open_check' as const, reason: 'pending_pass2' } }
  })
  const _fifoPreview1 = buildFifoLotEngine(_pass1PreviewEvidence, true)
  const _pass1ClosedLots = _fifoPreview1.summary.closedLots ?? 0
  const _pass1UnmatchedSells = _fifoPreview1.debug.unmatchedSells ?? 0
  const _pass1OpenedLots = _fifoPreview1.debug.openedLots ?? 0

  // ── Dynamic expansion decision ────────────────────────────────────────────────────────────
  const _walletValue = totalValueUsd ?? 0
  const _enoughClosed = _pass1ClosedLots >= 5
  const _budgetExhausted = _pass1Attempts >= BASE_BUDGET
  const _unprocessedCount = _sortedCandidates.length - _pass1ResultByIdx.size
  let _finalBudget = BASE_BUDGET
  let _expansionEligible = false
  let _expansionReason: string | null = null
  let _skippedEnough = false

  if (_enoughClosed) {
    _skippedEnough = true  // already have enough closed lots — no need to expand
  } else if (_budgetExhausted && _unprocessedCount > 0) {
    // Basic expansion: active wallet with insufficient coverage
    if (swapCandidateEvents > 10 && (_pass1Priced < 4 || _pass1ClosedLots < 3) && _walletValue >= 500) {
      _expansionEligible = true
      _finalBudget = EXPANDED_BUDGET
      _expansionReason = `expand10:swaps=${swapCandidateEvents},priced1=${_pass1Priced},closed1=${_pass1ClosedLots},value=${Math.round(_walletValue)}`
      // Further expansion to MAX_BUDGET for high-value active wallets with open/unmatched activity
      if (_walletValue >= 2500 && swapCandidateEvents >= 20 && (_pass1UnmatchedSells > 0 || _pass1OpenedLots > 0) && _pass1ClosedLots < 5) {
        _finalBudget = MAX_BUDGET
        _expansionReason = `expand12:swaps=${swapCandidateEvents},unmatched=${_pass1UnmatchedSells},opened=${_pass1OpenedLots},value=${Math.round(_walletValue)}`
      }
    }
  }
  activeBudget = _finalBudget

  // ── Pass 2 (only when expansion eligible) ────────────────────────────────────────────────
  const _pass2ResultByIdx = new Map<number, WalletTxEvidence>()
  if (_expansionEligible) {
    for (const { e, i } of _sortedCandidates) {
      if (_pass1ResultByIdx.has(i)) continue  // already priced in pass 1
      if (priceAttempts >= _finalBudget) break
      const result = await _priceOneCandidate(e)
      _pass2ResultByIdx.set(i, result)
    }
  }
  const _pass2Attempts = priceAttempts - _pass1Attempts
  const _pass2Priced = pricedEvents - _pass1Priced

  // ── Assemble final evidence in original order ─────────────────────────────────────────────
  // Any remaining unprocessed swap candidates get open_check (budget exhausted)
  const evidenceWithPricing: WalletTxEvidence[] = evidenceWithDetection.map((e, i) => {
    if (!e.swapDetection?.isSwapCandidate) return e
    const r1 = _pass1ResultByIdx.get(i)
    if (r1) return r1
    const r2 = _pass2ResultByIdx.get(i)
    if (r2) return r2
    // Not processed — budget exhausted
    priceAttemptLimitReached = true
    return openCheck(e, 'price_attempt_limit_reached')
  })

  // Swap-derived pricing pass: 0 extra API credits.
  // For any open_check swap candidate, look for a counterpart in the same tx that was
  // priced in the main pass and back-derive this token's USD price from the swap ratio.
  {
    const LP_TAGS = ['LP', 'UNI-V2', 'SLP', 'BAL', 'CRV']
    const isLPSym = (s: string) => LP_TAGS.some(t => s.includes(t))
    const pricedByTx = new Map<string, WalletTxEvidence[]>()
    for (const ev of evidenceWithPricing) {
      if (ev.txHash && ev.priceAtTime?.status === 'priced' && ev.priceAtTime.priceUsd) {
        pricedByTx.set(ev.txHash, [...(pricedByTx.get(ev.txHash) ?? []), ev])
      }
    }
    for (let i = 0; i < evidenceWithPricing.length; i++) {
      const e = evidenceWithPricing[i]
      if (!e.swapDetection?.isSwapCandidate) continue
      if (e.priceAtTime?.status === 'priced') continue
      if (isLPSym(e.symbol ?? '')) continue
      const thisAmt = parseRawAmount(e.amountRaw, e.tokenDecimals) ?? e.amount
      if (!thisAmt || thisAmt <= 0) continue
      const cp = (pricedByTx.get(e.txHash) ?? []).find(c =>
        c.direction !== 'unknown' && c.direction !== e.direction && !isLPSym(c.symbol ?? '')
      )
      if (!cp?.priceAtTime?.priceUsd) continue
      const cpAmt = parseRawAmount(cp.amountRaw, cp.tokenDecimals) ?? cp.amount
      if (!cpAmt || cpAmt <= 0) continue
      const syntheticPrice = (cpAmt * cp.priceAtTime.priceUsd) / thisAmt
      if (syntheticPrice <= 0 || !isFinite(syntheticPrice)) continue
      if (e.priceAtTime?.status === 'open_check') openCheckEvents--
      evidenceWithPricing[i] = priced(
        e, syntheticPrice, 'swap_derived', 'low',
        `Swap-derived from ${cp.symbol} leg (${cpAmt.toFixed(4)} × $${cp.priceAtTime.priceUsd.toFixed(4)} / ${thisAmt.toFixed(4)})`
      )
    }
  }

  const pricedInbound = evidenceWithPricing.filter(e => e.swapDetection?.isSwapCandidate && e.priceAtTime?.status === 'priced' && e.direction === 'buy' && e.txHash && e.contract && e.amount > 0).length
  const pricedOutbound = evidenceWithPricing.filter(e => e.swapDetection?.isSwapCandidate && e.priceAtTime?.status === 'priced' && e.direction === 'sell' && e.txHash && e.contract && e.amount > 0).length
  const readyForLotMatching = pricedInbound >= 1 && pricedOutbound >= 1

  const summaryStatus: 'ok' | 'partial' | 'open_check' =
    swapCandidateEvents === 0 ? 'open_check'
    : pricedEvents === 0 ? 'open_check'
    : pricedEvents >= swapCandidateEvents * 0.6 ? 'ok'
    : 'partial'

  const missing: string[] = []
  if (pricedEvents === 0 && swapCandidateEvents > 0) missing.push(`${swapCandidateEvents}_swap_candidates_unpriced`)
  if (priceAttemptLimitReached) missing.push('price_attempt_limit_reached')
  if (!readyForLotMatching && pricedEvents > 0) missing.push(pricedInbound === 0 ? 'no_priced_inbound_swaps' : 'no_priced_outbound_swaps')
  // PHASE2-FIX-5: normalized, machine-readable reason keys for missing-price fallback
  // transparency, appended additively alongside the existing free-text `missing` strings above.
  if (skippedNoStableOrWethLeg > 0) missing.push('price_missing_primary')
  if (skippedHistoricalUnavailable > 0) missing.push('price_missing_secondary')
  if (currentHoldingPriceOpenLotEvents > 0) missing.push('price_estimated')

  const abbr = (addr: string) => `${addr.slice(0, 8)}...${addr.slice(-6)}`

  return {
    evidenceWithPricing,
    summary: {
      status: summaryStatus, swapCandidateEvents, pricedEvents, openCheckEvents, unavailableEvents,
      stableLegPricedEvents, wethLegPricedEvents, historicalPricedEvents, providerEventUsdPricedEvents,
      currentHoldingPricedEvents: currentHoldingPriceOpenLotEvents,
      priceAttemptLimitReached, readyForLotMatching, missing,
    },
    debug: {
      swapCandidateEvents, priceAttempts, pricedEvents, openCheckEvents, unavailableEvents,
      stableLegPricedEvents, wethLegPricedEvents, historicalPricedEvents,
      providerEventUsdAttempts, providerEventUsdPricedEvents,
      priceAttemptLimitReached,
      skippedNoTimestamp, skippedNoTokenAddress, skippedNoAmount,
      skippedNoStableOrWethLeg, skippedNoQuoteLeg,
      skippedProviderUsdMissing, skippedProviderUsdInvalid, skippedHistoricalUnavailable,
      currentHoldingPriceAttempts, currentHoldingPriceOpenLotEvents,
      skippedCurrentPriceNotAllowedForRealized,
      historicalPriceAttempts, historicalPricePricedEvents,
      cacheHits, cacheMisses, providerAttempts, providerErrors,
      samplePricedEvents: samplePricedRaw.slice(0, 5).map(ev => ({
        txHash: abbr(ev.txHash), contract: abbr(ev.contract), symbol: ev.symbol,
        direction: ev.direction, amount: ev.amount,
        priceUsd: ev.priceAtTime?.priceUsd ?? null,
        source: ev.priceAtTime?.source ?? 'unavailable',
        confidence: ev.priceAtTime?.confidence ?? 'open_check',
        reason: ev.priceAtTime?.reason ?? '',
      })),
      sampleOpenCheckEvents: sampleOpenCheckRaw.slice(0, 5).map(ev => ({
        txHash: abbr(ev.txHash), contract: abbr(ev.contract), symbol: ev.symbol,
        reason: ev.priceAtTime?.reason ?? '',
      })),
      sampleUnpricedReasons: sampleUnpricedRaw,
      reasons: missing,
    },
    budgetDebug: {
      baseBudget: BASE_BUDGET, expandedBudget: EXPANDED_BUDGET, maxBudget: MAX_BUDGET,
      initialCandidates: _indexedCandidates.length,
      prioritizedCandidates: _sortedCandidates.length,
      pass1Attempts: _pass1Attempts,
      pass1PricedEvents: _pass1Priced,
      pass1ClosedLots: _pass1ClosedLots,
      expansionEligible: _expansionEligible,
      expansionReason: _expansionReason,
      pass2Attempts: _pass2Attempts,
      pass2PricedEvents: _pass2Priced,
      finalPriceAttempts: priceAttempts,
      finalPricedEvents: pricedEvents,
      finalClosedLots: _fifoPreview1.summary.closedLots ?? 0,  // post-pass1 preview (pass2 will update downstream FIFO)
      budgetCapHit: priceAttemptLimitReached,
      skippedBecauseEnoughEvidence: _skippedEnough,
      skippedBecauseDailyCap: false,
      estimatedExtraCredits: _pass2Attempts,
      samplePrioritizedCandidates: _sortedCandidates.slice(0, 8).map(({ e }) => {
        const [tier] = getCandidatePriority(e)
        const cl = (e.contract ?? '').toLowerCase()
        const txGroup = allByTx.get(e.txHash) ?? []
        const hasSL = txGroup.some(ev => Boolean(STABLE_USD_CONTRACTS[(ev.contract ?? '').toLowerCase()]) && ev.direction !== 'unknown' && ev.direction !== e.direction)
        const hasWL = txGroup.some(ev => Boolean(WETH_CONTRACTS_PRICE[(ev.contract ?? '').toLowerCase()]) && ev.direction !== 'unknown' && ev.direction !== e.direction)
        return { symbol: e.symbol ?? null, priority: tier, hasStableLeg: hasSL, hasWethLeg: hasWL, usdValue: e.usdValue ?? null }
      }),
    },
  }
}

const BEHAVIOR_EMPTY: WalletBehavior = {
  status: 'unavailable', source: 'unavailable',
  txCount: null, activeDays: null, topTokens: [], topContracts: [],
  inboundCount: null, outboundCount: null, stablecoinActivity: false,
  recentActivitySummary: 'Activity data unavailable.', reason: '',
}


function buildWalletBehaviorFromPnlEvents(address: string, pnlEvents: PnlEvent[]): WalletBehavior {
  const addrLower = address.toLowerCase()
  const baseEvents = pnlEvents.filter((e) => String(e.chain ?? '').toLowerCase().includes('base'))
  const all = baseEvents.length > 0 ? baseEvents : pnlEvents
  if (all.length === 0) {
    return { ...BEHAVIOR_EMPTY, status: 'ok', source: 'activity_layer' as const, txCount: 0, activeDays: 0, recentActivitySummary: 'No recent Base activity found in the checked window.' }
  }
  const STABLES = /^(USDC|USDT|DAI|USDBC|EURC|LUSD)$/i
  const days = new Set(all.map(e => e.timestamp?.slice(0, 10)).filter(Boolean) as string[])
  const tokenFreq = new Map<string, number>()
  const contractFreq = new Map<string, number>()
  let inboundCount = 0
  let outboundCount = 0
  for (const e of all) {
    if (e.symbol && e.symbol !== 'ETH') tokenFreq.set(e.symbol, (tokenFreq.get(e.symbol) ?? 0) + 1)
    const from = (e.fromAddress ?? e.txFromAddress ?? '').toLowerCase()
    const to = (e.toAddress ?? e.txToAddress ?? '').toLowerCase()
    if (to === addrLower) inboundCount += 1
    if (from === addrLower) {
      outboundCount += 1
      const counterparty = to || (e.toAddress ?? e.txToAddress ?? '')
      if (counterparty && counterparty !== addrLower) contractFreq.set(counterparty, (contractFreq.get(counterparty) ?? 0) + 1)
    }
  }
  const topTokens = [...tokenFreq].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s]) => s)
  const topContracts = [...contractFreq].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([a]) => `${a.slice(0, 6)}…${a.slice(-4)}`)
  const stablecoinActivity = all.some(e => e.symbol && STABLES.test(e.symbol))
  return {
    status: 'ok', source: 'activity_layer' as const,
    txCount: all.length, activeDays: days.size,
    topTokens, topContracts,
    inboundCount, outboundCount,
    stablecoinActivity,
    recentActivitySummary: [
      `${all.length} recent transfers across ${days.size} active days on Base.`,
      topTokens.length ? `Top tokens: ${topTokens.slice(0, 3).join(', ')}.` : '',
      stablecoinActivity ? 'Includes stablecoin movement.' : '',
    ].filter(Boolean).join(' '),
    reason: 'wallet_behavior_reused_activity_events',
  }
}

async function fetchWalletBehavior(address: string, baseUrl: string): Promise<WalletBehavior> {
  if (!ALCHEMY_BASE_KEY) return { ...BEHAVIOR_EMPTY, reason: 'Base key not configured.' }
  try {
    const base = {
      fromBlock: '0x0', category: ['external', 'erc20'],
      withMetadata: true, maxCount: '0x32', order: 'desc',
    }
    const [sentRes, recvRes] = await Promise.allSettled([
      alchemyRpc(baseUrl, 'alchemy_getAssetTransfers', [{ ...base, fromAddress: address }]),
      alchemyRpc(baseUrl, 'alchemy_getAssetTransfers', [{ ...base, toAddress: address }]),
    ])
    type Tx = { to: string | null; asset: string | null; metadata?: { blockTimestamp?: string } }
    const sent: Tx[] = sentRes.status === 'fulfilled' ? (sentRes.value?.transfers ?? []) : []
    const recv: Tx[] = recvRes.status === 'fulfilled' ? (recvRes.value?.transfers ?? []) : []
    const all = [...sent, ...recv]
    if (all.length === 0) {
      return { ...BEHAVIOR_EMPTY, status: 'ok', source: 'activity_layer' as const, txCount: 0, activeDays: 0, recentActivitySummary: 'No recent Base activity found in the checked window.' }
    }
    const STABLES = /^(USDC|USDT|DAI|USDBC|EURC|LUSD)$/i
    const days = new Set(all.map(t => t.metadata?.blockTimestamp?.slice(0, 10)).filter(Boolean) as string[])
    const tokenFreq = new Map<string, number>()
    const contractFreq = new Map<string, number>()
    for (const t of all) {
      if (t.asset && t.asset !== 'ETH') tokenFreq.set(t.asset, (tokenFreq.get(t.asset) ?? 0) + 1)
    }
    for (const t of sent) {
      if (t.to && t.to.toLowerCase() !== address.toLowerCase()) {
        const k = t.to.toLowerCase()
        contractFreq.set(k, (contractFreq.get(k) ?? 0) + 1)
      }
    }
    const topTokens = [...tokenFreq].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s]) => s)
    const topContracts = [...contractFreq].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([a]) => `${a.slice(0, 6)}…${a.slice(-4)}`)
    const stablecoinActivity = all.some(t => t.asset && STABLES.test(t.asset))
    return {
      status: 'ok', source: 'activity_layer' as const,
      txCount: all.length, activeDays: days.size,
      topTokens, topContracts,
      inboundCount: recv.length, outboundCount: sent.length,
      stablecoinActivity,
      recentActivitySummary: [
        `${all.length} recent transfers across ${days.size} active days on Base.`,
        topTokens.length ? `Top tokens: ${topTokens.slice(0, 3).join(', ')}.` : '',
        stablecoinActivity ? 'Includes stablecoin movement.' : '',
      ].filter(Boolean).join(' '),
      reason: '',
    }
  } catch {
    return { ...BEHAVIOR_EMPTY, status: 'unavailable', reason: 'Behavior fetch failed.' }
  }
}

function buildWalletFacts(
  holdings: Holding[],
  totalValue: number,
  evidenceWithDetection: WalletTxEvidence[],
  walletAddress: string,
  closedLotCount: number,
): { facts: WalletFacts; debug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletFactsDebug']> } {
  const t0 = Date.now()

  const pricedHoldings = holdings.filter(h => h.value > 0)
  const totalVal = totalValue > 0 ? totalValue : pricedHoldings.reduce((s, h) => s + h.value, 0)

  // Chain exposure from holdings
  const chainValueMap: Record<string, number> = {}
  for (const h of pricedHoldings) {
    const c = (h.chain ?? 'unknown').replace(/-mainnet$/, '')
    chainValueMap[c] = (chainValueMap[c] ?? 0) + h.value
  }
  const chainExposure = Object.entries(chainValueMap)
    .sort((a, b) => b[1] - a[1])
    .map(([chain, valueUsd]) => ({
      chain,
      valueUsd: Math.round(valueUsd * 100) / 100,
      percent: totalVal > 0 ? Math.round((valueUsd / totalVal) * 1000) / 10 : 0,
    }))

  const sortedHoldings = [...pricedHoldings].sort((a, b) => b.value - a.value)
  const topHoldings = sortedHoldings.slice(0, 5).map(h => ({
    symbol: h.symbol,
    chain: (h.chain ?? 'unknown').replace(/-mainnet$/, ''),
    valueUsd: Math.round(h.value * 100) / 100,
    percent: totalVal > 0 ? Math.round((h.value / totalVal) * 1000) / 10 : 0,
  }))
  const largestHolding = sortedHoldings[0]?.symbol ?? null
  const topShare = topHoldings[0]?.percent ?? 0
  const concentrationLabel: WalletFacts['summary']['concentrationLabel'] =
    pricedHoldings.length === 0 ? 'none' : topShare >= 50 ? 'high' : topShare >= 25 ? 'medium' : 'balanced'

  const STABLE_SYMS = new Set(['USDC', 'USDT', 'DAI', 'BUSD', 'FRAX', 'LUSD', 'USDBC', 'USDE', 'USDC.E'])
  const NATIVE_SYMS = new Set(['ETH', 'WETH', 'CBETH', 'STETH', 'RETH'])
  const stableVal = pricedHoldings.filter(h => STABLE_SYMS.has(h.symbol.toUpperCase())).reduce((s, h) => s + h.value, 0)
  const nativeVal = pricedHoldings.filter(h => NATIVE_SYMS.has(h.symbol.toUpperCase())).reduce((s, h) => s + h.value, 0)
  const stablecoinExposurePercent = totalVal > 0 ? Math.round((stableVal / totalVal) * 1000) / 10 : 0
  const nativeExposurePercent = totalVal > 0 ? Math.round((nativeVal / totalVal) * 1000) / 10 : 0

  // Activity from evidence (soft cap at 500)
  // PHASE4-FIX-1: protect every event for a currently-held token from the cap, same rationale
  // as the main PnL pipeline's budget cap — only trim events for tokens with no open holding.
  const _factsHeldContracts = new Set(pricedHoldings.map(h => (h.contract ?? '').toLowerCase()).filter(Boolean))
  const _factsProtectedEvents = evidenceWithDetection.filter(e => _factsHeldContracts.has((e.contract ?? '').toLowerCase()))
  const _factsTrimmableEvents = evidenceWithDetection.filter(e => !_factsHeldContracts.has((e.contract ?? '').toLowerCase()))
  const _factsRemainingSlots = Math.max(0, 500 - _factsProtectedEvents.length)
  const events = [..._factsProtectedEvents, ..._factsTrimmableEvents.slice(0, _factsRemainingSlots)]
  const maxEventsUsed = events.length

  const txGroups = new Map<string, WalletTxEvidence[]>()
  for (const ev of events) {
    if (!ev.txHash) continue
    const arr = txGroups.get(ev.txHash) ?? []
    arr.push(ev)
    txGroups.set(ev.txHash, arr)
  }
  const groupedTxCount = txGroups.size

  const walletAddrLower = walletAddress.toLowerCase()
  let walletInitiatedTxCount = 0
  for (const [, txEvs] of txGroups) {
    if (txEvs.some(e => e.txFromAddress?.toLowerCase() === walletAddrLower)) walletInitiatedTxCount++
  }

  const inboundCount = events.filter(e => e.direction === 'buy').length
  const outboundCount = events.filter(e => e.direction === 'sell').length
  const unknownCount = events.filter(e => e.direction === 'unknown').length

  const timestamps = events.map(e => e.timestamp).filter(Boolean) as string[]
  const sortedTs = [...timestamps].sort()
  const firstSeenAt = sortedTs[0] ?? null
  const lastSeenAt = sortedTs[sortedTs.length - 1] ?? null
  const recentActivityWindowDays =
    firstSeenAt && lastSeenAt
      ? Math.round((new Date(lastSeenAt).getTime() - new Date(firstSeenAt).getTime()) / (1000 * 60 * 60 * 24))
      : null

  const latestEvents = events
    .filter(e => e.timestamp)
    .sort((a, b) => new Date(b.timestamp!).getTime() - new Date(a.timestamp!).getTime())
    .slice(0, 5)
    .map(e => ({
      timestamp: e.timestamp!,
      txHash: e.txHash,
      direction: e.direction,
      symbol: e.symbol,
      chain: e.chain,
      amount: e.amount,
      valueUsdKnown: e.usdValue !== null && e.usdValue !== undefined,
      counterparty: e.direction === 'buy' ? (e.fromAddress ?? null) : (e.toAddress ?? null),
    }))

  // Flow read
  const receivedMap: Record<string, { count: number; totalAmount: number; latestAt: string | null }> = {}
  const sentMap: Record<string, { count: number; totalAmount: number; latestAt: string | null }> = {}
  const counterpartyMap: Record<string, { direction: string; count: number; latestAt: string | null }> = {}

  for (const e of events) {
    if (e.direction === 'buy') {
      if (!receivedMap[e.symbol]) receivedMap[e.symbol] = { count: 0, totalAmount: 0, latestAt: null }
      receivedMap[e.symbol].count++
      receivedMap[e.symbol].totalAmount += e.amount
      if (e.timestamp && (!receivedMap[e.symbol].latestAt || e.timestamp > receivedMap[e.symbol].latestAt!))
        receivedMap[e.symbol].latestAt = e.timestamp
      const cp = e.fromAddress?.toLowerCase()
      if (cp && cp !== walletAddrLower) {
        if (!counterpartyMap[cp]) counterpartyMap[cp] = { direction: 'in', count: 0, latestAt: null }
        counterpartyMap[cp].count++
        if (e.timestamp && (!counterpartyMap[cp].latestAt || e.timestamp > counterpartyMap[cp].latestAt!))
          counterpartyMap[cp].latestAt = e.timestamp
      }
    } else if (e.direction === 'sell') {
      if (!sentMap[e.symbol]) sentMap[e.symbol] = { count: 0, totalAmount: 0, latestAt: null }
      sentMap[e.symbol].count++
      sentMap[e.symbol].totalAmount += e.amount
      if (e.timestamp && (!sentMap[e.symbol].latestAt || e.timestamp > sentMap[e.symbol].latestAt!))
        sentMap[e.symbol].latestAt = e.timestamp
      const cp = e.toAddress?.toLowerCase()
      if (cp && cp !== walletAddrLower) {
        if (!counterpartyMap[cp]) counterpartyMap[cp] = { direction: 'out', count: 0, latestAt: null }
        counterpartyMap[cp].count++
        if (e.timestamp && (!counterpartyMap[cp].latestAt || e.timestamp > counterpartyMap[cp].latestAt!))
          counterpartyMap[cp].latestAt = e.timestamp
      }
    }
  }

  const receivedTokens = Object.entries(receivedMap)
    .sort((a, b) => b[1].count - a[1].count).slice(0, 10)
    .map(([symbol, d]) => ({ symbol, count: d.count, totalAmountApprox: Math.round(d.totalAmount * 100) / 100, latestAt: d.latestAt }))
  const sentTokens = Object.entries(sentMap)
    .sort((a, b) => b[1].count - a[1].count).slice(0, 10)
    .map(([symbol, d]) => ({ symbol, count: d.count, totalAmountApprox: Math.round(d.totalAmount * 100) / 100, latestAt: d.latestAt }))
  const topCounterparties = Object.entries(counterpartyMap)
    .sort((a, b) => b[1].count - a[1].count).slice(0, 5)
    .map(([address, d]) => ({ address, direction: d.direction, count: d.count, latestAt: d.latestAt }))

  const accumulationSignals: string[] = []
  for (const [symbol, d] of Object.entries(receivedMap)) {
    if (d.count >= 2 && !sentMap[symbol]) accumulationSignals.push(`${symbol}: received ${d.count}x, not yet sold`)
  }
  const distributionSignals: string[] = []
  for (const [symbol, d] of Object.entries(sentMap)) {
    if (d.count >= 2) distributionSignals.push(`${symbol}: sent ${d.count}x`)
  }

  // Source classification by tx
  let swapLikeTxs = 0, transferOnlyTxs = 0, claimOrAirdropLikeTxs = 0, bridgeLikeTxs = 0, unknownTxs = 0
  const classificationNotes: string[] = []
  for (const [, txEvs] of txGroups) {
    const kinds = new Set(txEvs.map(e => e.swapDetection?.eventKind ?? 'unknown'))
    if (kinds.has('swap_candidate')) swapLikeTxs++
    else if (kinds.has('bridge_candidate')) bridgeLikeTxs++
    else if (kinds.has('airdrop_candidate')) claimOrAirdropLikeTxs++
    else if (kinds.has('transfer')) transferOnlyTxs++
    else unknownTxs++
  }
  if (swapLikeTxs > 0) classificationNotes.push(`${swapLikeTxs} tx(s) resemble swaps but no matched price pairs`)
  if (transferOnlyTxs > 0) classificationNotes.push(`${transferOnlyTxs} transfer-only tx(s)`)
  if (claimOrAirdropLikeTxs > 0) classificationNotes.push(`${claimOrAirdropLikeTxs} possible airdrop/claim tx(s)`)
  if (bridgeLikeTxs > 0) classificationNotes.push(`${bridgeLikeTxs} possible bridge tx(s)`)

  const hasPortfolio = pricedHoldings.length > 0
  const hasActivity = events.length > 0
  const status: WalletFacts['status'] = hasPortfolio && hasActivity ? 'ok' : hasPortfolio || hasActivity ? 'partial' : 'open_check'

  return {
    facts: {
      status,
      summary: {
        totalValueUsd: Math.round(totalVal * 100) / 100,
        holdingsCount: pricedHoldings.length,
        chainExposure,
        topHoldings,
        largestHolding,
        concentrationLabel,
        stablecoinExposurePercent,
        nativeExposurePercent,
      },
      activity: {
        eventCount: events.length,
        groupedTxCount,
        walletInitiatedTxCount,
        inboundCount,
        outboundCount,
        unknownCount,
        firstSeenAt,
        lastSeenAt,
        recentActivityWindowDays,
        latestEvents,
      },
      flowRead: {
        receivedTokens,
        sentTokens,
        topCounterparties,
        accumulationSignals: accumulationSignals.slice(0, 5),
        distributionSignals: distributionSignals.slice(0, 5),
      },
      sourceClassification: {
        swapLikeTxs,
        transferOnlyTxs,
        claimOrAirdropLikeTxs,
        bridgeLikeTxs,
        unknownTxs,
        notes: classificationNotes,
      },
      limits: {
        sampleBased: events.length < evidenceWithDetection.length,
        maxEventsUsed,
        noClosedLotPnL: closedLotCount === 0,
        reason: closedLotCount === 0
          ? 'No closed FIFO lots found. Portfolio and activity data only.'
          : `${closedLotCount} closed lot(s) available for PnL.`,
      },
      estimatedPnl: {
        method: 'average_cost_estimate',
        status: closedLotCount === 0 ? 'open_check' : 'ok',
        confidence: closedLotCount === 0 ? 'open_check' : 'medium',
        realizedPnlUsd: null,
        coveragePercent: closedLotCount === 0 ? 0 : 100,
      },
    },
    debug: {
      built: true,
      eventCount: maxEventsUsed,
      groupedTxCount,
      latestEventsCount: latestEvents.length,
      receivedTokenCount: receivedTokens.length,
      sentTokenCount: sentTokens.length,
      topCounterpartyCount: topCounterparties.length,
      classificationCounts: { swapLike: swapLikeTxs, transferOnly: transferOnlyTxs, claimOrAirdrop: claimOrAirdropLikeTxs, bridge: bridgeLikeTxs, unknown: unknownTxs },
      missingFields: [
        ...(pricedHoldings.length === 0 ? ['holdings'] : []),
        ...(events.length === 0 ? ['activity_events'] : []),
        ...(totalVal === 0 ? ['totalValueUsd'] : []),
      ],
      reason: `Built from ${pricedHoldings.length} holdings and ${maxEventsUsed} activity events`,
    },
  }
}


function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripUndefinedDeep(v)).filter((v) => v !== undefined) as T
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const current = (value as Record<string, unknown>)[key]
      if (current === undefined) {
        delete (value as Record<string, unknown>)[key]
      } else {
        ;(value as Record<string, unknown>)[key] = stripUndefinedDeep(current)
      }
    }
  }
  return value
}

export function validateWalletFactsShape(snapshot: WalletSnapshot): WalletSnapshot {
  const missingFields: string[] = []
  const noteMissing = (path: string) => { if (!missingFields.includes(path)) missingFields.push(path) }
  type MutableWalletFacts = Partial<WalletFacts> & Record<string, unknown>
  const snapAny = snapshot as Omit<WalletSnapshot, 'walletFacts'> & { walletFacts?: MutableWalletFacts }

  if (!snapAny.walletFacts || typeof snapAny.walletFacts !== 'object') {
    noteMissing('walletFacts')
    snapAny.walletFacts = {} as MutableWalletFacts
  }
  const walletFacts = snapAny.walletFacts as MutableWalletFacts
  const totalValueUsd = Number.isFinite(snapshot.totalValue) ? Math.round(snapshot.totalValue * 100) / 100 : 0
  const holdings = Array.isArray(snapshot.holdings) ? snapshot.holdings : []

  if (!walletFacts.summary || typeof walletFacts.summary !== 'object') {
    noteMissing('walletFacts.summary')
    walletFacts.summary = {
      totalValueUsd,
      holdingsCount: holdings.length,
      chainExposure: [],
      topHoldings: [],
      largestHolding: null,
      concentrationLabel: holdings.length > 0 ? 'balanced' : 'none',
      stablecoinExposurePercent: 0,
      nativeExposurePercent: 0,
    }
  }

  if (!walletFacts.activity || typeof walletFacts.activity !== 'object') {
    noteMissing('walletFacts.activity')
    walletFacts.activity = {
      eventCount: snapshot.walletEvidenceSummary?.totalEvents ?? 0,
      groupedTxCount: snapshot.walletSwapSummary?.groupedTxCount ?? 0,
      walletInitiatedTxCount: 0,
      inboundCount: 0,
      outboundCount: 0,
      unknownCount: snapshot.walletSwapSummary?.unknownEvents ?? 0,
      firstSeenAt: null,
      lastSeenAt: null,
      recentActivityWindowDays: null,
      latestEvents: [],
    }
  }
  const activity = walletFacts.activity as WalletFacts['activity'] & Record<string, unknown>
  const activityDefaults: WalletFacts['activity'] = {
    eventCount: snapshot.walletEvidenceSummary?.totalEvents ?? 0,
    groupedTxCount: snapshot.walletSwapSummary?.groupedTxCount ?? 0,
    walletInitiatedTxCount: 0,
    inboundCount: 0,
    outboundCount: 0,
    unknownCount: snapshot.walletSwapSummary?.unknownEvents ?? 0,
    firstSeenAt: null,
    lastSeenAt: null,
    recentActivityWindowDays: null,
    latestEvents: [],
  }
  for (const [key, fallback] of Object.entries(activityDefaults)) {
    if (activity[key] === undefined) { noteMissing(`walletFacts.activity.${key}`); activity[key] = fallback }
  }
  if (!Array.isArray(activity.latestEvents)) { noteMissing('walletFacts.activity.latestEvents'); activity.latestEvents = [] }

  if (!walletFacts.flowRead || typeof walletFacts.flowRead !== 'object') {
    noteMissing('walletFacts.flowRead')
    walletFacts.flowRead = { sentTokens: [], receivedTokens: [], topCounterparties: [], accumulationSignals: [], distributionSignals: [] }
  }
  const flowRead = walletFacts.flowRead as WalletFacts['flowRead'] & Record<string, unknown>
  const mergeArrayField = (targetKey: keyof WalletFacts['flowRead'], continuedKey: string) => {
    const base = Array.isArray(flowRead[targetKey]) ? flowRead[targetKey] as unknown[] : []
    const continued = Array.isArray(flowRead[continuedKey]) ? flowRead[continuedKey] as unknown[] : []
    if (!Array.isArray(flowRead[targetKey])) noteMissing(`walletFacts.flowRead.${String(targetKey)}`)
    if (continued.length > 0) noteMissing(`walletFacts.flowRead.${continuedKey}`)
    ;(flowRead as Record<string, unknown>)[targetKey] = [...base, ...continued]
    delete flowRead[continuedKey]
  }
  mergeArrayField('sentTokens', 'sentTokensContinued')
  mergeArrayField('receivedTokens', 'receivedTokensContinued')
  mergeArrayField('topCounterparties', 'topCounterpartiesContinued')
  mergeArrayField('accumulationSignals', 'accumulationSignalsContinued')
  mergeArrayField('distributionSignals', 'distributionSignalsContinued')

  if (!walletFacts.sourceClassification || typeof walletFacts.sourceClassification !== 'object') {
    noteMissing('walletFacts.sourceClassification')
    walletFacts.sourceClassification = { transferOnlyTxs: 0, claimOrAirdropLikeTxs: 0, swapLikeTxs: 0, bridgeLikeTxs: 0, unknownTxs: activity.unknownCount ?? 0, notes: [] }
  }
  const sourceClassification = walletFacts.sourceClassification as WalletFacts['sourceClassification'] & Record<string, unknown>
  const classificationDefaults: WalletFacts['sourceClassification'] = {
    transferOnlyTxs: 0,
    claimOrAirdropLikeTxs: 0,
    swapLikeTxs: 0,
    bridgeLikeTxs: 0,
    unknownTxs: typeof activity.unknownCount === 'number' ? activity.unknownCount : 0,
    notes: [],
  }
  for (const [key, fallback] of Object.entries(classificationDefaults)) {
    if (sourceClassification[key] === undefined) { noteMissing(`walletFacts.sourceClassification.${key}`); sourceClassification[key] = fallback }
  }
  if (!Array.isArray(sourceClassification.notes)) { noteMissing('walletFacts.sourceClassification.notes'); sourceClassification.notes = [] }

  if (!walletFacts.limits || typeof walletFacts.limits !== 'object') {
    noteMissing('walletFacts.limits')
    walletFacts.limits = { sampleBased: false, maxEventsUsed: activity.eventCount ?? 0, noClosedLotPnL: (snapshot.walletLotSummary?.closedLots ?? 0) === 0, reason: 'Wallet facts shape fallback applied.' }
  }

  if (!walletFacts.estimatedPnl || typeof walletFacts.estimatedPnl !== 'object') {
    noteMissing('walletFacts.estimatedPnl')
    walletFacts.estimatedPnl = { method: 'average_cost_estimate', status: 'open_check', confidence: 'open_check', realizedPnlUsd: null, coveragePercent: 0 }
  }
  const factsPnl = walletFacts.estimatedPnl as WalletFacts['estimatedPnl'] & Record<string, unknown>
  const hasSwapEvidence = (snapshot.walletSwapSummary?.swapCandidateEvents ?? 0) > 0 || (snapshot.walletPriceEvidenceSummary?.swapCandidateEvents ?? 0) > 0
  const pnlDefaults: WalletFacts['estimatedPnl'] = {
    method: 'average_cost_estimate',
    status: hasSwapEvidence ? (snapshot.estimatedPnl?.status ?? 'open_check') : 'open_check',
    confidence: hasSwapEvidence ? (snapshot.estimatedPnl?.confidence ?? 'open_check') : 'open_check',
    realizedPnlUsd: hasSwapEvidence ? (snapshot.estimatedPnl?.realizedPnlUsd ?? null) : null,
    coveragePercent: hasSwapEvidence ? (snapshot.estimatedPnl?.coveragePercent ?? 0) : 0,
  }
  for (const [key, fallback] of Object.entries(pnlDefaults)) {
    const shouldNormalizePnlValue = key === 'status' || key === 'confidence' || key === 'realizedPnlUsd' || key === 'coveragePercent'
    if (factsPnl[key] === undefined || shouldNormalizePnlValue) {
      if (factsPnl[key] === undefined) noteMissing(`walletFacts.estimatedPnl.${key}`)
      factsPnl[key] = fallback
    }
  }

  snapshot._debug = { ...(snapshot._debug ?? {}) }
  snapshot._debug.walletFactsShapeIssues = missingFields
  snapshot._debug.walletScannerDiagnostics = {
    swapCandidates: snapshot.walletSwapSummary?.swapCandidateEvents ?? 0,
    pricedEvents: snapshot.walletPriceEvidenceSummary?.pricedEvents ?? 0,
    closedLots: snapshot.walletLotSummary?.closedLots ?? 0,
    activityEvents: activity.eventCount ?? snapshot.walletEvidenceSummary?.totalEvents ?? 0,
    flowReadBuilt: Boolean(walletFacts.flowRead),
    classificationBuilt: Boolean(walletFacts.sourceClassification),
    pnlStatus: String(factsPnl.status ?? 'open_check'),
    missingFields,
  }
  const existingFactsDebug = snapshot._diagnostics?.walletFactsDebug
  if (existingFactsDebug) {
    existingFactsDebug.missingFields = Array.from(new Set([...(existingFactsDebug.missingFields ?? []), ...missingFields]))
  }

  stripUndefinedDeep(snapshot)
  return snapshot
}


function emptyEthSwapReconstructionDebug(
  reason: string,
  pricedEventsBefore: number,
  swapCandidatesBefore: number,
  closedLotsBefore: number,
  attempted = false,
): NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['ethSwapReconstructionDebug']> {
  return {
    attempted,
    reason,
    candidateTxCount: 0,
    walletInitiatedTxs: 0,
    txGroupsWithInboundToken: 0,
    knownRouterTxs: 0,
    receiptsFetched: 0,
    transactionsFetched: 0,
    quoteLogsFound: 0,
    nativeEthValueMatches: 0,
    wethQuoteMatches: 0,
    usdcQuoteMatches: 0,
    usdtQuoteMatches: 0,
    daiQuoteMatches: 0,
    syntheticSwapEventsAdded: 0,
    pricedEventsBefore,
    pricedEventsAfter: pricedEventsBefore,
    swapCandidatesBefore,
    swapCandidatesAfter: swapCandidatesBefore,
    closedLotsBefore,
    closedLotsAfter: closedLotsBefore,
    sampleCandidateTxs: [],
    sampleQuoteMatches: [],
    sampleSyntheticEvents: [],
    sampleStillUnmatched: [],
    stopReason: reason,
  }
}

async function buildEthRouterSwapReconstructionPass(
  evidenceWithDetection: WalletTxEvidence[],
  walletAddress: string,
  ethRpcUrl: string,
  activityRequested: boolean,
  pricedEventsBefore: number,
  swapCandidatesBefore: number,
  closedLotsBefore: number,
): Promise<{
  enrichedEvidence: WalletTxEvidence[]
  debug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['ethSwapReconstructionDebug']>
}> {
  const walletLower = walletAddress.toLowerCase()
  const emptyDebug = (reason: string, attempted = false) => emptyEthSwapReconstructionDebug(reason, pricedEventsBefore, swapCandidatesBefore, closedLotsBefore, attempted)
  if (!activityRequested) return { enrichedEvidence: evidenceWithDetection, debug: emptyDebug('activity_not_requested') }
  if (!ethRpcUrl) return { enrichedEvidence: evidenceWithDetection, debug: emptyDebug('eth_receipt_fetch_failed', true) }

  const ethEvents = evidenceWithDetection.filter(e => normalizeChain(e.chain ?? '') === 'eth' && e.txHash)
  if (ethEvents.length === 0) return { enrichedEvidence: evidenceWithDetection, debug: emptyDebug('no_eth_activity_events') }

  const byTx = new Map<string, WalletTxEvidence[]>()
  for (const e of ethEvents) byTx.set(e.txHash, [...(byTx.get(e.txHash) ?? []), e])

  let walletInitiatedTxs = 0
  let txGroupsWithInboundToken = 0
  let knownRouterTxs = 0
  const candidates: Array<{ txHash: string; group: WalletTxEvidence[]; inboundTargets: WalletTxEvidence[]; walletInitiated: boolean; txToKnownRouter: boolean; txFrom: string | null; txTo: string | null }> = []
  const sampleCandidateTxs: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['ethSwapReconstructionDebug']>['sampleCandidateTxs'] = []

  for (const [txHash, group] of byTx) {
    const txFrom = (group.find(e => e.txFromAddress)?.txFromAddress ?? group.find(e => e.fromAddress)?.fromAddress ?? null)?.toLowerCase() ?? null
    const txTo = (group.find(e => e.txToAddress)?.txToAddress ?? group.find(e => e.toAddress)?.toAddress ?? null)?.toLowerCase() ?? null
    const walletInitiated = txFrom === walletLower
    const txToKnownRouter = Boolean(txTo && EXTENDED_DEX_ROUTERS.has(txTo))
    const inboundTargets = group.filter(e => e.direction === 'buy' && e.toAddress?.toLowerCase() === walletLower && !ETH_QUOTE_ASSETS[e.contract.toLowerCase()] && e.amount > 0)
    const hasUnknownQuote = group.some(e => e.direction === 'unknown' && Boolean(ETH_QUOTE_ASSETS[e.contract.toLowerCase()]))
    if (walletInitiated) walletInitiatedTxs++
    if (inboundTargets.length > 0) txGroupsWithInboundToken++
    if (txToKnownRouter) knownRouterTxs++
    if (inboundTargets.length === 0) continue
    if (!walletInitiated && !txToKnownRouter) continue
    if (!hasUnknownQuote && !txToKnownRouter && !walletInitiated) continue
    candidates.push({ txHash, group, inboundTargets, walletInitiated, txToKnownRouter, txFrom, txTo })
    if (sampleCandidateTxs.length < 5) {
      sampleCandidateTxs.push({ txHash, inboundSymbols: inboundTargets.map(e => e.symbol).slice(0, 4), txToKnownRouter, walletInitiated })
    }
    if (candidates.length >= 10) break
  }

  if (candidates.length === 0) {
    const reason = walletInitiatedTxs === 0 ? 'eth_only_inbound_airdrop_like_transfers'
      : txGroupsWithInboundToken === 0 ? 'eth_wallet_initiated_but_no_token_receive'
      : 'eth_no_known_router_or_native_value'
    return { enrichedEvidence: evidenceWithDetection, debug: { ...emptyDebug(reason, true), walletInitiatedTxs, txGroupsWithInboundToken, knownRouterTxs, sampleCandidateTxs } }
  }

  const toFetch = candidates.slice(0, 8)
  const now = Date.now()
  let receiptsFetched = 0
  let transactionsFetched = 0
  let providerErrors = 0
  let quoteLogsFound = 0
  let nativeEthValueMatches = 0
  let wethQuoteMatches = 0
  let usdcQuoteMatches = 0
  let usdtQuoteMatches = 0
  let daiQuoteMatches = 0
  const receiptDecodes = new Map<string, EthRouterReceiptDecode>()
  const txNativeValues = new Map<string, string>()
  const sampleQuoteMatches: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['ethSwapReconstructionDebug']>['sampleQuoteMatches'] = []
  const sampleStillUnmatched: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['ethSwapReconstructionDebug']>['sampleStillUnmatched'] = []

  // Fetch all receipts AND tx values in parallel — up to 16 concurrent RPC calls instead of 16 sequential.
  await Promise.allSettled(toFetch.flatMap((cand) => {
    const receiptTask = (async () => {
      const cacheKey = `eth_router_recon:${cand.txHash}`
      const cached = ethRouterReceiptCache.get(cacheKey)
      if (cached && cached.exp > now) {
        receiptDecodes.set(cand.txHash, cached.data)
        return
      }
      try {
        const receipt = await getSharedTxReceipt(ethRpcUrl, cand.txHash)
        receiptsFetched++
        if (!receipt) {
          const d: EthRouterReceiptDecode = { txFrom: null, txTo: null, isKnownRouter: false, routerProtocol: null, quoteLogs: [], totalTransferLogs: 0, decodeStatus: 'no_receipt', reason: 'receipt_null' }
          ethRouterReceiptCache.set(cacheKey, { data: d, exp: now + BASE_PNL_RECON_TTL_MS })
          receiptDecodes.set(cand.txHash, d)
          return
        }
        const txFrom = typeof receipt.from === 'string' ? (receipt.from as string).toLowerCase() : cand.txFrom
        const txTo = typeof receipt.to === 'string' ? (receipt.to as string).toLowerCase() : cand.txTo
        const isKnownRouter = Boolean(txTo && EXTENDED_DEX_ROUTERS.has(txTo))
        const routerProtocol = txTo ? (KNOWN_DEX_ROUTERS[txTo] ?? (isKnownRouter ? 'known_dex_router' : null)) : null
        const logs: Array<{ topics?: string[]; address?: string; data?: string }> = Array.isArray(receipt.logs) ? receipt.logs : []
        const quoteLogs: EthRouterQuoteLog[] = []
        let totalTransferLogs = 0
        for (const log of logs) {
          if (!log.topics || log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue
          if (log.topics.length < 3) continue
          totalTransferLogs++
          const contract = (log.address ?? '').toLowerCase()
          const meta = ETH_QUOTE_ASSETS[contract]
          if (!meta) continue
          const amountHex = typeof log.data === 'string' ? log.data : '0x0'
          const amount = hexAmountToDecimal(amountHex, meta.decimals)
          if (!amount || amount <= 0) continue
          const fromAddr = '0x' + (log.topics[1]?.toLowerCase() ?? '').slice(-40)
          const toAddr = '0x' + (log.topics[2]?.toLowerCase() ?? '').slice(-40)
          const walletSide = fromAddr === walletLower || toAddr === walletLower
          quoteLogs.push({ contract, symbol: meta.symbol, amountHex, amount, from: fromAddr, to: toAddr, walletSide })
        }
        const d: EthRouterReceiptDecode = { txFrom, txTo, isKnownRouter, routerProtocol, quoteLogs, totalTransferLogs, decodeStatus: 'ok', reason: 'decoded' }
        ethRouterReceiptCache.set(cacheKey, { data: d, exp: now + BASE_PNL_RECON_TTL_MS })
        receiptDecodes.set(cand.txHash, d)
      } catch {
        providerErrors++
      }
    })()

    const txValueTask = (async () => {
      const txValueCacheKey = `eth_router_tx_value:${cand.txHash}`
      const cachedValue = ethRouterTxValueCache.get(txValueCacheKey)
      if (cachedValue && cachedValue.exp > now) {
        txNativeValues.set(cand.txHash, cachedValue.value)
        return
      }
      if (!cand.walletInitiated) return
      try {
        const tx = await getSharedTxByHash(ethRpcUrl, cand.txHash)
        transactionsFetched++
        const value = typeof tx?.value === 'string' ? tx.value : '0x0'
        ethRouterTxValueCache.set(txValueCacheKey, { value, exp: now + BASE_PNL_RECON_TTL_MS })
        txNativeValues.set(cand.txHash, value)
      } catch {
        providerErrors++
      }
    })()

    return [receiptTask, txValueTask]
  }))

  const syntheticEvents: WalletTxEvidence[] = []
  const sampleSyntheticEvents: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['ethSwapReconstructionDebug']>['sampleSyntheticEvents'] = []
  const existingKey = new Set(evidenceWithDetection.map(e => `${e.txHash}|${e.contract.toLowerCase()}|${e.direction}|${e.amountRaw ?? e.amount}`))

  for (const cand of toFetch) {
    const d = receiptDecodes.get(cand.txHash)
    const refEvent = cand.inboundTargets[0]
    const txFrom = d?.txFrom ?? cand.txFrom
    const txTo = d?.txTo ?? cand.txTo
    const isWalletInitiated = txFrom === walletLower || cand.walletInitiated
    const isKnownRouter = Boolean(d?.isKnownRouter || cand.txToKnownRouter)
    const routerProtocol = d?.routerProtocol ?? (txTo ? KNOWN_DEX_ROUTERS[txTo] ?? null : null)

    const nativeHex = txNativeValues.get(cand.txHash)
    const nativeAmount = nativeHex ? hexAmountToDecimal(nativeHex, 18) : 0
    if (isWalletInitiated && nativeAmount > 0) {
      const key = `${cand.txHash}|${ETH_WETH_CONTRACT}|sell|native:${nativeHex}`
      if (!existingKey.has(key)) {
        syntheticEvents.push({
          txHash: cand.txHash, timestamp: refEvent.timestamp, fromAddress: walletLower, toAddress: txTo,
          contract: ETH_WETH_CONTRACT, symbol: 'WETH', amountRaw: nativeHex ?? null, tokenDecimals: 18,
          amount: nativeAmount, usdValue: null, direction: 'sell', chain: 'eth', txFromAddress: txFrom, txToAddress: txTo,
          swapDetection: { isSwapCandidate: true, confidence: isKnownRouter ? 'high' : 'medium', eventKind: 'swap_candidate', reason: 'ETH router reconstruction: native tx.value quote leg for wallet-initiated token receipt', matchedProtocol: routerProtocol, matchedAddress: txTo },
          priceAtTime: { status: 'open_check', tokenAddress: ETH_WETH_CONTRACT, tokenSymbol: 'WETH', timestamp: refEvent.timestamp ?? '', priceUsd: null, source: 'eth_native_value_router_reconstruction', confidence: 'medium', reason: 'Synthetic native ETH quote leg from tx.value for router reconstruction' },
        })
        existingKey.add(key)
        nativeEthValueMatches++
        if (sampleQuoteMatches.length < 5) sampleQuoteMatches.push({ txHash: cand.txHash, quoteSymbol: 'WETH', quoteType: 'native_tx_value', amount: nativeAmount })
      }
    }

    const normalizedQuoteLegs = cand.group.filter(e => e.direction === 'unknown' && Boolean(ETH_QUOTE_ASSETS[e.contract.toLowerCase()]) && e.amount > 0)
    for (const nq of normalizedQuoteLegs) {
      const qContract = nq.contract.toLowerCase()
      const qMeta = ETH_QUOTE_ASSETS[qContract]
      const key = `${cand.txHash}|${qContract}|sell|normalized:${nq.amountRaw ?? nq.amount}`
      if (!qMeta || existingKey.has(key)) continue
      syntheticEvents.push({
        txHash: cand.txHash, timestamp: refEvent.timestamp, fromAddress: nq.fromAddress, toAddress: nq.toAddress,
        contract: qContract, symbol: qMeta.symbol, amountRaw: nq.amountRaw, tokenDecimals: nq.tokenDecimals ?? qMeta.decimals,
        amount: nq.amount, usdValue: STABLE_USD_CONTRACTS[qContract] ? nq.amount : null, direction: 'sell', chain: 'eth', txFromAddress: txFrom, txToAddress: txTo,
        swapDetection: { isSwapCandidate: true, confidence: 'medium', eventKind: 'swap_candidate', reason: 'ETH router reconstruction: normalized same-tx quote leg in wallet-initiated token receipt', matchedProtocol: routerProtocol, matchedAddress: txTo },
      })
      existingKey.add(key)
      quoteLogsFound++
      if (qMeta.symbol === 'WETH') wethQuoteMatches++
      else if (qMeta.symbol === 'USDC') usdcQuoteMatches++
      else if (qMeta.symbol === 'USDT') usdtQuoteMatches++
      else if (qMeta.symbol === 'DAI') daiQuoteMatches++
      if (sampleQuoteMatches.length < 5) sampleQuoteMatches.push({ txHash: cand.txHash, quoteSymbol: qMeta.symbol, quoteType: 'normalized_router_leg', amount: nq.amount })
    }

    const quoteLogs = d?.quoteLogs ?? []
    for (const q of quoteLogs) {
      quoteLogsFound++
      if (q.symbol === 'WETH') wethQuoteMatches++
      else if (q.symbol === 'USDC') usdcQuoteMatches++
      else if (q.symbol === 'USDT') usdtQuoteMatches++
      else if (q.symbol === 'DAI') daiQuoteMatches++
      if (!isKnownRouter && !isWalletInitiated) continue
      const quoteDirection: 'buy' | 'sell' = q.to === walletLower ? 'buy' : 'sell'
      const key = `${cand.txHash}|${q.contract}|${quoteDirection}|${q.amountHex}`
      if (existingKey.has(key)) continue
      syntheticEvents.push({
        txHash: cand.txHash, timestamp: refEvent.timestamp, fromAddress: q.from, toAddress: q.to,
        contract: q.contract, symbol: q.symbol, amountRaw: q.amountHex, tokenDecimals: ETH_QUOTE_ASSETS[q.contract].decimals,
        amount: q.amount, usdValue: STABLE_USD_CONTRACTS[q.contract] ? q.amount : null, direction: quoteDirection, chain: 'eth', txFromAddress: txFrom, txToAddress: txTo,
        swapDetection: { isSwapCandidate: true, confidence: q.walletSide ? 'high' : 'medium', eventKind: 'swap_candidate', reason: q.walletSide ? 'ETH router reconstruction: direct wallet-side quote transfer' : 'ETH router reconstruction: same-tx router quote evidence', matchedProtocol: routerProtocol, matchedAddress: txTo },
      })
      existingKey.add(key)
      if (sampleQuoteMatches.length < 5) sampleQuoteMatches.push({ txHash: cand.txHash, quoteSymbol: q.symbol, quoteType: q.walletSide ? 'wallet_side_log' : 'router_context_log', amount: q.amount })
    }

    const hasQuote = nativeAmount > 0 || quoteLogs.length > 0 || cand.group.some(e => e.direction === 'unknown' && Boolean(ETH_QUOTE_ASSETS[e.contract.toLowerCase()]))
    if (!hasQuote && sampleStillUnmatched.length < 5) sampleStillUnmatched.push({ txHash: cand.txHash, reason: d?.decodeStatus === 'no_receipt' ? 'eth_receipt_fetch_failed' : 'eth_router_quote_leg_not_found' })
  }

  let targetEventsMarked = 0
  const syntheticTxs = new Set(syntheticEvents.map(e => e.txHash))
  const enrichedEvidence = evidenceWithDetection.map(e => {
    if (!syntheticTxs.has(e.txHash)) return e
    if (normalizeChain(e.chain ?? '') !== 'eth') return e
    if (e.direction !== 'buy') return e
    if (ETH_QUOTE_ASSETS[e.contract.toLowerCase()]) return e
    targetEventsMarked++
    const confidence: 'high' | 'medium' = (e.txToAddress && EXTENDED_DEX_ROUTERS.has(e.txToAddress.toLowerCase())) ? 'high' : 'medium'
    return {
      ...e,
      swapDetection: { isSwapCandidate: true, confidence, eventKind: 'swap_candidate', reason: 'ETH router reconstruction: wallet received token in wallet-initiated router transaction with quote evidence', matchedProtocol: e.txToAddress ? (KNOWN_DEX_ROUTERS[e.txToAddress.toLowerCase()] ?? null) : null, matchedAddress: e.txToAddress ?? null } satisfies WalletSwapDetection,
    }
  })
  const mergedEvidence = syntheticEvents.length > 0 ? [...enrichedEvidence, ...syntheticEvents] : enrichedEvidence
  const syntheticSwapEventsAdded = syntheticEvents.length + targetEventsMarked
  for (const e of syntheticEvents.slice(0, 5)) sampleSyntheticEvents.push({ txHash: e.txHash, symbol: e.symbol, direction: e.direction, source: e.priceAtTime?.source ?? 'eth_router_quote_log' })

  let stopReason = 'reconstructed'
  if (syntheticSwapEventsAdded === 0) {
    stopReason = providerErrors > 0 && receiptsFetched === 0 ? 'eth_receipt_fetch_failed'
      : quoteLogsFound === 0 ? 'eth_router_quote_leg_not_found'
      : 'eth_quote_asset_logs_not_wallet_relevant'
  } else if (candidates.length > toFetch.length) {
    stopReason = 'eth_budget_cap_reached'
  }

  const swapCandidatesAfter = mergedEvidence.filter(e => e.swapDetection?.isSwapCandidate).length
  return {
    enrichedEvidence: mergedEvidence,
    debug: {
      attempted: true,
      reason: syntheticSwapEventsAdded > 0 ? 'eth_router_reconstruction_added_swap_evidence' : stopReason,
      candidateTxCount: toFetch.length,
      walletInitiatedTxs,
      txGroupsWithInboundToken,
      knownRouterTxs,
      receiptsFetched,
      transactionsFetched,
      quoteLogsFound,
      nativeEthValueMatches,
      wethQuoteMatches,
      usdcQuoteMatches,
      usdtQuoteMatches,
      daiQuoteMatches,
      syntheticSwapEventsAdded,
      pricedEventsBefore,
      pricedEventsAfter: pricedEventsBefore,
      swapCandidatesBefore,
      swapCandidatesAfter,
      closedLotsBefore,
      closedLotsAfter: closedLotsBefore,
      sampleCandidateTxs,
      sampleQuoteMatches,
      sampleSyntheticEvents,
      sampleStillUnmatched,
      stopReason,
    },
  }
}

async function buildBasePnlReconstructionPass(
  evidenceWithDetection: WalletTxEvidence[],
  walletAddress: string,
  alchemyBaseUrl: string,
  closedLotsBefore: number,
  realizedPnlBefore: number | null,
): Promise<{
  mergedEvidence: WalletTxEvidence[]
  debug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['basePnlReconstructionDebug']>
}> {
  const walletLower = walletAddress.toLowerCase()
  const emptyDebug = (reason: string, attempted = false): NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['basePnlReconstructionDebug']> => ({
    attempted, reason,
    candidateTxCount: 0, receiptsFetched: 0, receiptCacheHits: 0,
    decodedTransferLogs: 0, walletInboundLegs: 0, walletOutboundLegs: 0,
    nativeEthPaymentMatches: 0, stablecoinMatches: 0, wethMatches: 0, routerMatches: 0,
    enrichedSwapEvents: 0, pricedEnrichedEvents: 0,
    closedLotsBefore, closedLotsAfter: closedLotsBefore,
    realizedPnlBefore, realizedPnlAfter: realizedPnlBefore,
    skippedNoPaymentLeg: 0, skippedNoInboundToken: 0, skippedNoPriceEvidence: 0, skippedBudgetCap: 0,
    providerErrors: 0, sampleMatches: [],
  })

  if (!alchemyBaseUrl) return { mergedEvidence: evidenceWithDetection, debug: emptyDebug('no_alchemy_base_url') }

  // Already has swap candidates — no reconstruction needed
  const existingSwapCount = evidenceWithDetection.filter(e => e.swapDetection?.isSwapCandidate).length
  if (existingSwapCount > 0) return { mergedEvidence: evidenceWithDetection, debug: emptyDebug('swap_candidates_already_present') }

  // Collect candidate tx hashes: inbound-only (airdrop_candidate) transfers,
  // most-recent first, wallet must be tx initiator (txFromAddress = wallet)
  const seen = new Set<string>()
  const candidateTxHashes: string[] = []
  // Sort by timestamp descending to prefer recent txs
  const sorted = [...evidenceWithDetection].sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
  for (const e of sorted) {
    if (!e.txHash) continue
    if (seen.has(e.txHash)) continue
    // Include buy (inbound-only) events — these are the native ETH buy candidates
    // Also include sell-only events that might have a hidden stable/native leg
    if (e.direction !== 'buy' && e.direction !== 'sell') continue
    // Require txFromAddress = wallet OR be permissive for cases where it's not set
    if (e.txFromAddress && e.txFromAddress.toLowerCase() !== walletLower) continue
    seen.add(e.txHash)
    candidateTxHashes.push(e.txHash)
    if (candidateTxHashes.length >= 10) break
  }

  if (candidateTxHashes.length === 0) return { mergedEvidence: evidenceWithDetection, debug: emptyDebug('no_candidate_txs', true) }

  const toFetch = candidateTxHashes.slice(0, 8)
  const now = Date.now()
  let receiptsFetched = 0
  let receiptCacheHits = 0
  let providerErrors = 0
  let totalTransferLogs = 0
  let walletInboundLegs = 0
  let walletOutboundLegs = 0
  let nativeEthPaymentMatches = 0
  let stablecoinMatches = 0
  let wethMatches = 0
  let routerMatches = 0
  let skippedNoPaymentLeg = 0
  let skippedNoInboundToken = 0

  const txDecodes = new Map<string, BasePnlReceiptDecode>()

  // Fetch all receipts in parallel — safe because JS is single-threaded; counter increments
  // within async callbacks are interleaved via the microtask queue, never truly concurrent.
  await Promise.allSettled(toFetch.map(async (txHash) => {
    const cacheKey = `base_recon:${txHash}`
    const cached = basePnlReceiptCache.get(cacheKey)
    if (cached && cached.exp > now) {
      receiptCacheHits++
      txDecodes.set(txHash, cached.data)
      return
    }
    try {
      const receipt = await getSharedTxReceipt(alchemyBaseUrl, txHash)
      receiptsFetched++
      if (!receipt) {
        const d: BasePnlReceiptDecode = { txFrom: null, txTo: null, walletInbound: [], walletOutbound: [], isKnownRouter: false, routerProtocol: null, hasStableLeg: false, hasWethLeg: false, totalTransferLogs: 0, decodeStatus: 'no_receipt', reason: 'receipt_null' }
        basePnlReceiptCache.set(cacheKey, { data: d, exp: now + BASE_PNL_RECON_TTL_MS })
        txDecodes.set(txHash, d)
        return
      }
      const txFrom = typeof receipt.from === 'string' ? (receipt.from as string).toLowerCase() : null
      const txTo = typeof receipt.to === 'string' ? (receipt.to as string).toLowerCase() : null
      const isKnownRouter = Boolean(txTo && EXTENDED_DEX_ROUTERS.has(txTo))
      const routerProtocol = txTo ? (KNOWN_DEX_ROUTERS[txTo] ?? (isKnownRouter ? 'known_dex_router' : null)) : null
      const logs: Array<{ topics?: string[]; address?: string }> = Array.isArray(receipt.logs) ? receipt.logs : []
      const inbound: BasePnlReceiptDecode['walletInbound'] = []
      const outbound: BasePnlReceiptDecode['walletOutbound'] = []
      let hasStable = false
      let hasWeth = false
      let logCount = 0
      for (const log of logs) {
        if (!log.topics || log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue
        if (log.topics.length < 3) continue
        logCount++
        const fromAddr = '0x' + (log.topics[1]?.toLowerCase() ?? '').slice(-40)
        const toAddr = '0x' + (log.topics[2]?.toLowerCase() ?? '').slice(-40)
        const contractAddr = (log.address ?? '').toLowerCase()
        const amountHex = typeof (log as Record<string, unknown>).data === 'string' ? (log as Record<string, unknown>).data as string : '0x0'
        if (toAddr === walletLower) {
          inbound.push({ contract: contractAddr, amountHex })
          if (STABLE_USD_CONTRACTS[contractAddr]) hasStable = true
          if (WETH_CONTRACTS_PRICE[contractAddr]) hasWeth = true
        }
        if (fromAddr === walletLower) {
          outbound.push({ contract: contractAddr, amountHex })
          if (STABLE_USD_CONTRACTS[contractAddr]) hasStable = true
          if (WETH_CONTRACTS_PRICE[contractAddr]) hasWeth = true
        }
      }
      const d: BasePnlReceiptDecode = {
        txFrom, txTo, walletInbound: inbound, walletOutbound: outbound,
        isKnownRouter, routerProtocol, hasStableLeg: hasStable, hasWethLeg: hasWeth,
        totalTransferLogs: logCount, decodeStatus: 'ok', reason: 'decoded',
      }
      basePnlReceiptCache.set(cacheKey, { data: d, exp: now + BASE_PNL_RECON_TTL_MS })
      txDecodes.set(txHash, d)
      totalTransferLogs += logCount
      walletInboundLegs += inbound.length
      walletOutboundLegs += outbound.length
    } catch {
      providerErrors++
    }
  }))

  // Classify each decoded tx as swap or not
  const swapTxHashes = new Set<string>()
  const swapReasons = new Map<string, string>()
  const swapPaymentTypes = new Map<string, string>()

  for (const [txHash, d] of txDecodes) {
    if (d.decodeStatus !== 'ok') continue
    const txFromIsWallet = d.txFrom === walletLower
    const hasInboundToken = d.walletInbound.some(i => !STABLE_USD_CONTRACTS[i.contract] && !WETH_CONTRACTS_PRICE[i.contract])
    const hasInboundStableOrWeth = d.walletInbound.some(i => STABLE_USD_CONTRACTS[i.contract] || WETH_CONTRACTS_PRICE[i.contract])
    const hasOutboundToken = d.walletOutbound.some(o => !STABLE_USD_CONTRACTS[o.contract] && !WETH_CONTRACTS_PRICE[o.contract])
    const hasOutboundStableOrWeth = d.walletOutbound.some(o => STABLE_USD_CONTRACTS[o.contract] || WETH_CONTRACTS_PRICE[o.contract])

    if (d.isKnownRouter) {
      // Any tx through known router = swap
      swapTxHashes.add(txHash)
      swapReasons.set(txHash, `Known router: ${d.routerProtocol ?? d.txTo}`)
      swapPaymentTypes.set(txHash, 'router_match')
      routerMatches++
    } else if (hasInboundToken && txFromIsWallet && d.walletOutbound.length === 0) {
      // Native ETH payment: wallet initiated + received token + no ERC20 outbound
      swapTxHashes.add(txHash)
      swapReasons.set(txHash, 'Native ETH buy: wallet initiated + received token + no ERC20 outbound in receipt')
      swapPaymentTypes.set(txHash, 'native_eth_buy')
      nativeEthPaymentMatches++
    } else if (hasInboundToken && hasOutboundStableOrWeth) {
      // Token in, stable/WETH out = buy via stable/WETH payment
      swapTxHashes.add(txHash)
      swapReasons.set(txHash, 'Stable/WETH buy: received token, paid stable or WETH in same tx')
      swapPaymentTypes.set(txHash, 'stablecoin_buy')
      stablecoinMatches++
    } else if (hasOutboundToken && hasInboundStableOrWeth) {
      // Token out, stable/WETH in = sell
      swapTxHashes.add(txHash)
      swapReasons.set(txHash, 'Stable/WETH sell: sent token, received stable or WETH in same tx')
      swapPaymentTypes.set(txHash, 'stablecoin_sell')
      stablecoinMatches++
    } else if (hasInboundToken && hasOutboundToken) {
      // Token→token swap
      swapTxHashes.add(txHash)
      swapReasons.set(txHash, 'Token-to-token swap: inbound and outbound non-stable tokens in same tx')
      swapPaymentTypes.set(txHash, 'token_token_swap')
    } else if (d.walletInbound.length === 0) {
      skippedNoInboundToken++
    } else {
      skippedNoPaymentLeg++
    }
    if (d.hasStableLeg) stablecoinMatches = Math.max(stablecoinMatches, stablecoinMatches)
    if (d.hasWethLeg) wethMatches++
  }

  if (swapTxHashes.size === 0) {
    return {
      mergedEvidence: evidenceWithDetection,
      debug: {
        ...emptyDebug(`no_swap_txs_found_in_${toFetch.length}_receipts`, true),
        candidateTxCount: toFetch.length, receiptsFetched, receiptCacheHits, decodedTransferLogs: totalTransferLogs,
        walletInboundLegs, walletOutboundLegs, providerErrors, skippedNoPaymentLeg, skippedNoInboundToken,
      },
    }
  }

  // Merge: mark all evidence events in identified swap txs as swap candidates
  let enrichedSwapEvents = 0
  const sampleMatches: Array<{ txHash: string; direction: string; symbol: string; paymentType: string }> = []

  const mergedEvidence: WalletTxEvidence[] = evidenceWithDetection.map(e => {
    if (!e.txHash || !swapTxHashes.has(e.txHash)) return e
    if (e.swapDetection?.isSwapCandidate) return e
    if (e.direction === 'unknown') return e
    enrichedSwapEvents++
    const paymentType = swapPaymentTypes.get(e.txHash) ?? 'base_recon'
    const reason = swapReasons.get(e.txHash) ?? 'Base PnL reconstruction pass'
    if (sampleMatches.length < 5) {
      sampleMatches.push({ txHash: e.txHash.slice(0, 10) + '…', direction: e.direction, symbol: e.symbol, paymentType })
    }
    return {
      ...e,
      swapDetection: {
        isSwapCandidate: true,
        confidence: paymentType === 'router_match' ? 'high' : 'medium',
        eventKind: 'swap_candidate',
        reason: `Base reconstruction: ${reason}`,
        matchedProtocol: paymentType === 'router_match' ? (swapReasons.get(e.txHash) ?? null) : null,
        matchedAddress: null,
      } satisfies WalletSwapDetection,
    }
  })

  return {
    mergedEvidence,
    debug: {
      attempted: true,
      reason: `enriched_${swapTxHashes.size}_swap_txs`,
      candidateTxCount: toFetch.length,
      receiptsFetched,
      receiptCacheHits,
      decodedTransferLogs: totalTransferLogs,
      walletInboundLegs,
      walletOutboundLegs,
      nativeEthPaymentMatches,
      stablecoinMatches,
      wethMatches,
      routerMatches,
      enrichedSwapEvents,
      pricedEnrichedEvents: 0,
      closedLotsBefore,
      closedLotsAfter: closedLotsBefore,
      realizedPnlBefore,
      realizedPnlAfter: realizedPnlBefore,
      skippedNoPaymentLeg,
      skippedNoInboundToken,
      skippedNoPriceEvidence: 0,
      skippedBudgetCap: candidateTxHashes.length - toFetch.length,
      providerErrors,
      sampleMatches,
    },
  }
}

// ── Base Unknown-Direction Swap Reconstruction Pass ───────────────────────────────────────
// Handles two cases the primary recon misses:
// 1. ALL events are direction=unknown (primary recon finds zero candidates).
// 2. MIXED tx: token event is direction=buy/sell but WETH/stable co-movement is direction=unknown.
//    The primary recon classifies the tx but skips the unknown WETH event in the merge step.
//    Also handles relayer/aggregator txs where txFrom ≠ wallet but wallet still received token.
const BASE_UNKNOWN_RECON_PROBLEM_TX = '0x26c09179ce3649cac213ebbd56bafdee59d9520487fbff1b4a00809543dbf906'

async function buildBaseUnknownDirectionSwapReconstructionPass(
  evidenceWithDetection: WalletTxEvidence[],
  walletAddress: string,
  rpcUrl: string,
  rawEvidenceEvents: WalletTxEvidence[] = evidenceWithDetection,
): Promise<{
  enrichedEvidence: WalletTxEvidence[]
  debug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['baseUnknownSwapReconstructionDebug']>
}> {
  const walletLower = walletAddress.toLowerCase()
  const candidateInput = rawEvidenceEvents.length > 0 ? rawEvidenceEvents : evidenceWithDetection
  const problemTxEvents = candidateInput.filter(e => (e.txHash ?? '').toLowerCase() === BASE_UNKNOWN_RECON_PROBLEM_TX)
  const problemTxSeenInEvidence = problemTxEvents.length > 0
  const baseDebugProof = () => ({
    evidenceEventsInputCount: candidateInput.length,
    includesProblemTx: false,
    problemTxSeenInEvidence,
    problemTxEventCount: problemTxEvents.length,
    problemTxSymbols: [...new Set(problemTxEvents.map(e => e.symbol).filter(Boolean))],
    problemTxDirections: [...new Set(problemTxEvents.map(e => e.direction).filter(Boolean))],
    problemTxChains: [...new Set(problemTxEvents.map(e => e.chain).filter(Boolean))],
  })
  const emptyDebug = (reason: string, attempted = false, triggerMatched = false): NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['baseUnknownSwapReconstructionDebug']> => ({
    attempted, reason, triggerMatched, ...baseDebugProof(), candidateTxsChecked: 0, candidateTxHashes: [], mixedKnownUnknownTxs: 0,
    receiptsFetched: 0, decodedTransferLogs: 0, walletSideLegsFound: 0, quoteLegsFound: 0, tokenLegsFound: 0,
    wethLegsFound: 0, stableLegsFound: 0, syntheticSwapEventsAdded: 0, sampleTxs: [], sampleSyntheticEvents: [], skippedReasons: [],
  })

  if (!rpcUrl) return { enrichedEvidence: evidenceWithDetection, debug: emptyDebug('no_rpc_available') }
  const existingSwapCount = evidenceWithDetection.filter(e => e.swapDetection?.isSwapCandidate).length
  if (existingSwapCount > 0) return { enrichedEvidence: evidenceWithDetection, debug: emptyDebug('swap_candidates_already_present') }

  // Group raw normalized evidence by txHash so all-unknown multi-leg Base swaps survive
  // even when the main detector's usable-event grouping excludes unknown directions.
  const txGroups = new Map<string, WalletTxEvidence[]>()
  for (const e of candidateInput) {
    if (!e.txHash) continue
    const txHash = e.txHash.toLowerCase()
    if (!txGroups.has(txHash)) txGroups.set(txHash, [])
    txGroups.get(txHash)!.push(e)
  }

  // Determine eligible tx hashes from raw normalized evidence, not swap-detection groups:
  // - Base txs with WETH/stable + non-quote token, even when all directions are unknown.
  // - Base txs with 2+ token movements and at least one quote token.
  // - Mixed known token + unknown quote patterns.
  let mixedKnownUnknownTxs = 0
  const eligibleTxHashes = new Set<string>()
  const eligibilityReasons = new Map<string, string>()
  for (const [txHash, events] of txGroups) {
    const baseEvents = events.filter(e => (e.chain ?? '').toLowerCase().includes('base'))
    if (baseEvents.length === 0) continue
    const tokenContracts = new Set(baseEvents.map(e => (e.contract ?? '').toLowerCase()).filter(c => c.startsWith('0x')))
    const hasQuote = [...tokenContracts].some(c => Boolean(STABLE_USD_CONTRACTS[c] || WETH_CONTRACTS_PRICE[c]))
    const hasNonQuote = [...tokenContracts].some(c => !STABLE_USD_CONTRACTS[c] && !WETH_CONTRACTS_PRICE[c])
    const hasUnknown = baseEvents.some(e => e.direction === 'unknown')
    const hasKnownToken = baseEvents.some(e => (e.direction === 'buy' || e.direction === 'sell') && !STABLE_USD_CONTRACTS[(e.contract ?? '').toLowerCase()] && !WETH_CONTRACTS_PRICE[(e.contract ?? '').toLowerCase()])
    const hasUnknownQuote = baseEvents.some(e => e.direction === 'unknown' && (STABLE_USD_CONTRACTS[(e.contract ?? '').toLowerCase()] || WETH_CONTRACTS_PRICE[(e.contract ?? '').toLowerCase()]))
    const allUnknown = baseEvents.length > 0 && baseEvents.every(e => e.direction === 'unknown')
    const hasTwoPlusMovements = baseEvents.length >= 2 || tokenContracts.size >= 2
    let reason: string | null = null
    if (hasQuote && hasNonQuote && allUnknown) reason = 'raw_base_all_unknown_quote_plus_token'
    else if (hasTwoPlusMovements && hasQuote) reason = 'raw_base_multi_movement_with_quote'
    else if (hasUnknown && hasQuote && hasNonQuote) reason = 'raw_base_unknown_quote_plus_token'
    if (hasKnownToken && hasUnknownQuote) { mixedKnownUnknownTxs++; reason = reason ?? 'mixed_known_token_unknown_quote' }
    if (reason) { eligibleTxHashes.add(txHash); eligibilityReasons.set(txHash, reason) }
  }

  if (eligibleTxHashes.size === 0) return { enrichedEvidence: evidenceWithDetection, debug: emptyDebug('no_eligible_txs', true, true) }

  // Collect candidates newest-first
  const seen = new Set<string>()
  const candidateTxHashes: string[] = []
  const sorted = [...candidateInput].sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
  for (const e of sorted) {
    if (!e.txHash) continue
    const txHash = e.txHash.toLowerCase()
    if (seen.has(txHash)) continue
    if (!eligibleTxHashes.has(txHash)) continue
    seen.add(txHash)
    candidateTxHashes.push(txHash)
    if (candidateTxHashes.length >= 12) break
  }
  if (eligibleTxHashes.has(BASE_UNKNOWN_RECON_PROBLEM_TX) && !candidateTxHashes.includes(BASE_UNKNOWN_RECON_PROBLEM_TX)) {
    candidateTxHashes.pop()
    candidateTxHashes.push(BASE_UNKNOWN_RECON_PROBLEM_TX)
  }
  if (candidateTxHashes.length === 0) return { enrichedEvidence: evidenceWithDetection, debug: emptyDebug('no_candidate_txs', true, true) }

  const toFetch = candidateTxHashes.slice(0, 12)
  const now = Date.now()
  let receiptsFetched = 0
  let totalTransferLogs = 0
  let walletSideLegsFound = 0
  let quoteLegsFound = 0
  let tokenLegsFound = 0
  let wethLegsFound = 0
  let stableLegsFound = 0
  const skippedReasons: string[] = []

  // Extended decode: also track WETH/stable presence ANYWHERE in receipt (pool-internal flows)
  type ExtendedDecode = BasePnlReceiptDecode & { hasWethAnywhere: boolean; hasStableAnywhere: boolean }
  const txDecodes = new Map<string, ExtendedDecode>()

  await Promise.allSettled(toFetch.map(async (txHash) => {
    const cacheKey = `base_recon:${txHash}`
    const cached = basePnlReceiptCache.get(cacheKey)
    let base: BasePnlReceiptDecode | null = null
    if (cached && cached.exp > now) { base = cached.data }
    else {
      try {
        const receipt = await getSharedTxReceipt(rpcUrl, txHash)
        receiptsFetched++
        if (!receipt) {
          const d: BasePnlReceiptDecode = { txFrom: null, txTo: null, walletInbound: [], walletOutbound: [], isKnownRouter: false, routerProtocol: null, hasStableLeg: false, hasWethLeg: false, totalTransferLogs: 0, decodeStatus: 'no_receipt', reason: 'receipt_null' }
          basePnlReceiptCache.set(cacheKey, { data: d, exp: now + BASE_PNL_RECON_TTL_MS })
          base = d
        } else {
          const txFrom = typeof receipt.from === 'string' ? (receipt.from as string).toLowerCase() : null
          const txTo = typeof receipt.to === 'string' ? (receipt.to as string).toLowerCase() : null
          const isKnownRouter = Boolean(txTo && EXTENDED_DEX_ROUTERS.has(txTo))
          const routerProtocol = txTo ? (KNOWN_DEX_ROUTERS[txTo] ?? (isKnownRouter ? 'known_dex_router' : null)) : null
          const logs: Array<{ topics?: string[]; address?: string }> = Array.isArray(receipt.logs) ? receipt.logs : []
          const inbound: BasePnlReceiptDecode['walletInbound'] = []
          const outbound: BasePnlReceiptDecode['walletOutbound'] = []
          const allTransferContracts = new Set<string>()
          let hasStable = false
          let hasWeth = false
          let logCount = 0
          for (const log of logs) {
            if (!log.topics || log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue
            if (log.topics.length < 3) continue
            logCount++
            const fromAddr = '0x' + (log.topics[1]?.toLowerCase() ?? '').slice(-40)
            const toAddr = '0x' + (log.topics[2]?.toLowerCase() ?? '').slice(-40)
            const contractAddr = (log.address ?? '').toLowerCase()
            if (contractAddr.startsWith('0x')) allTransferContracts.add(contractAddr)
            const amountHex = typeof (log as Record<string, unknown>).data === 'string' ? (log as Record<string, unknown>).data as string : '0x0'
            if (toAddr === walletLower) {
              inbound.push({ contract: contractAddr, amountHex })
              if (STABLE_USD_CONTRACTS[contractAddr]) hasStable = true
              if (WETH_CONTRACTS_PRICE[contractAddr]) hasWeth = true
            }
            if (fromAddr === walletLower) {
              outbound.push({ contract: contractAddr, amountHex })
              if (STABLE_USD_CONTRACTS[contractAddr]) hasStable = true
              if (WETH_CONTRACTS_PRICE[contractAddr]) hasWeth = true
            }
          }
          const d: BasePnlReceiptDecode = {
            txFrom, txTo, walletInbound: inbound, walletOutbound: outbound, allTransferContracts: [...allTransferContracts],
            isKnownRouter, routerProtocol, hasStableLeg: hasStable, hasWethLeg: hasWeth,
            totalTransferLogs: logCount, decodeStatus: 'ok', reason: 'decoded',
          }
          basePnlReceiptCache.set(cacheKey, { data: d, exp: now + BASE_PNL_RECON_TTL_MS })
          base = d
          totalTransferLogs += logCount
          walletSideLegsFound += inbound.length + outbound.length
          if (hasWeth) wethLegsFound++
          if (hasStable) stableLegsFound++
        }
      } catch {
        skippedReasons.push(`receipt_error:${txHash.slice(0, 10)}`)
        return
      }
    }
    // Scan ALL receipt logs for WETH/stable presence (pool-internal flows, not just wallet-side)
    // This detects relayer/aggregator patterns where txFrom≠wallet but WETH moved through pools
    let hasWethAnywhere = base.hasWethLeg
    let hasStableAnywhere = base.hasStableLeg
    for (const contract of base.allTransferContracts ?? []) {
      if (WETH_CONTRACTS_PRICE[contract]) hasWethAnywhere = true
      if (STABLE_USD_CONTRACTS[contract]) hasStableAnywhere = true
    }
    if (!hasWethAnywhere || !hasStableAnywhere) {
      for (const leg of [...base.walletInbound, ...base.walletOutbound]) {
        if (WETH_CONTRACTS_PRICE[leg.contract]) hasWethAnywhere = true
        if (STABLE_USD_CONTRACTS[leg.contract]) hasStableAnywhere = true
      }
    }
    txDecodes.set(txHash, { ...base, hasWethAnywhere, hasStableAnywhere })
    quoteLegsFound += (hasWethAnywhere ? 1 : 0) + (hasStableAnywhere ? 1 : 0)
    tokenLegsFound += base.walletInbound.filter(i => !STABLE_USD_CONTRACTS[i.contract] && !WETH_CONTRACTS_PRICE[i.contract]).length
                    + base.walletOutbound.filter(o => !STABLE_USD_CONTRACTS[o.contract] && !WETH_CONTRACTS_PRICE[o.contract]).length
  }))

  // Classify each tx as swap or not
  const swapTxHashes = new Set<string>()
  const swapReasons = new Map<string, string>()
  type SampleTx = NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['baseUnknownSwapReconstructionDebug']>['sampleTxs'][number]
  const sampleTxs: SampleTx[] = []

  for (const [txHash, d] of txDecodes) {
    if (d.decodeStatus !== 'ok') { skippedReasons.push(`no_receipt:${txHash.slice(0, 10)}`); continue }
    const hasInboundToken = d.walletInbound.some(i => !STABLE_USD_CONTRACTS[i.contract] && !WETH_CONTRACTS_PRICE[i.contract])
    const hasInboundStableOrWeth = d.walletInbound.some(i => STABLE_USD_CONTRACTS[i.contract] || WETH_CONTRACTS_PRICE[i.contract])
    const hasOutboundToken = d.walletOutbound.some(o => !STABLE_USD_CONTRACTS[o.contract] && !WETH_CONTRACTS_PRICE[o.contract])
    const hasOutboundStableOrWeth = d.walletOutbound.some(o => STABLE_USD_CONTRACTS[o.contract] || WETH_CONTRACTS_PRICE[o.contract])
    const txFromIsWallet = d.txFrom === walletLower
    // Check if this is a mixed tx (provider already confirmed a buy/sell in the same tx)
    const txEvents = txGroups.get(txHash) ?? []
    const rawContracts = new Set(txEvents.map(e => (e.contract ?? '').toLowerCase()).filter(c => c.startsWith('0x')))
    const rawHasQuote = [...rawContracts].some(c => Boolean(STABLE_USD_CONTRACTS[c] || WETH_CONTRACTS_PRICE[c]))
    const rawHasNonQuote = [...rawContracts].some(c => !STABLE_USD_CONTRACTS[c] && !WETH_CONTRACTS_PRICE[c])
    const rawAllUnknown = txEvents.length > 0 && txEvents.every(e => e.direction === 'unknown')
    const receiptContracts = new Set(d.allTransferContracts ?? [])
    const receiptHasQuote = [...receiptContracts].some(c => Boolean(STABLE_USD_CONTRACTS[c] || WETH_CONTRACTS_PRICE[c])) || d.hasWethAnywhere || d.hasStableAnywhere
    const receiptHasRawNonQuote = [...rawContracts].some(c => receiptContracts.has(c) && !STABLE_USD_CONTRACTS[c] && !WETH_CONTRACTS_PRICE[c])
    const hasMixedKnownToken = txEvents.some(e => (e.direction === 'buy' || e.direction === 'sell') && !STABLE_USD_CONTRACTS[(e.contract ?? '').toLowerCase()] && !WETH_CONTRACTS_PRICE[(e.contract ?? '').toLowerCase()])

    let swapReason: string | null = null
    if (d.isKnownRouter) {
      swapReason = `router:${d.routerProtocol ?? d.txTo ?? 'unknown'}`
    } else if (hasInboundToken && hasOutboundStableOrWeth) {
      swapReason = 'token_in_stable_weth_out'
    } else if (hasOutboundToken && hasInboundStableOrWeth) {
      swapReason = 'token_out_stable_weth_in'
    } else if (hasInboundToken && (txFromIsWallet || hasMixedKnownToken) && d.walletOutbound.length === 0 && (d.hasWethAnywhere || d.hasStableAnywhere)) {
      // Token received, no ERC20 outbound from wallet, WETH/stable moved in tx (native ETH buy via DEX/aggregator)
      // Also fires when provider confirmed a buy event (hasMixedKnownToken) even if tx.from is relayer
      swapReason = txFromIsWallet ? 'native_eth_buy' : 'aggregator_eth_buy_weth_in_receipt'
    } else if (hasInboundToken && hasMixedKnownToken && d.walletOutbound.length === 0) {
      // Provider confirmed token buy in this tx even if no WETH/stable in wallet-side logs
      swapReason = 'provider_confirmed_buy_no_erc20_outbound'
    } else if (hasInboundToken && hasOutboundToken) {
      // Reject same-token round-trips (e.g. FIRE self-routing: same contract in and out)
      const inboundTokenContracts = new Set(d.walletInbound.filter(i => !STABLE_USD_CONTRACTS[i.contract] && !WETH_CONTRACTS_PRICE[i.contract]).map(i => i.contract))
      const outboundTokenContracts = new Set(d.walletOutbound.filter(o => !STABLE_USD_CONTRACTS[o.contract] && !WETH_CONTRACTS_PRICE[o.contract]).map(o => o.contract))
      const distinctIn = [...inboundTokenContracts].filter(c => !outboundTokenContracts.has(c))
      const distinctOut = [...outboundTokenContracts].filter(c => !inboundTokenContracts.has(c))
      if (distinctIn.length > 0 || distinctOut.length > 0) {
        swapReason = 'token_to_token_swap'
      } else {
        skippedReasons.push(`same_token_roundtrip(${txHash.slice(0, 10)})`)
      }
    } else if (rawHasQuote && rawHasNonQuote && receiptHasQuote && (receiptHasRawNonQuote || rawAllUnknown)) {
      // Raw normalized evidence/receipt both show quote + token in the same Base tx, even if all provider directions are unknown.
      swapReason = rawAllUnknown ? 'raw_all_unknown_quote_token_receipt_confirmed' : 'raw_quote_token_receipt_confirmed'
    } else if (hasMixedKnownToken && (d.hasWethAnywhere || d.hasStableAnywhere)) {
      // Mixed tx: provider-confirmed token event + WETH/stable somewhere in receipt
      swapReason = 'mixed_provider_token_weth_in_receipt'
    } else {
      const detail = `inT:${hasInboundToken} outT:${hasOutboundToken} inQ:${hasInboundStableOrWeth} outQ:${hasOutboundStableOrWeth} txFrom:${txFromIsWallet} mixed:${hasMixedKnownToken} rawQ:${rawHasQuote} rawT:${rawHasNonQuote} receiptQ:${receiptHasQuote} receiptRawT:${receiptHasRawNonQuote} wethAny:${d.hasWethAnywhere}`
      skippedReasons.push(`no_swap_pattern(${txHash}):${detail}`)
    }

    if (sampleTxs.length < 8) sampleTxs.push({ txHash: txHash.slice(0, 12) + '…', swapReason: swapReason ?? `rejected`, walletInbound: d.walletInbound.length, walletOutbound: d.walletOutbound.length, wethAnywhere: d.hasWethAnywhere, stableAnywhere: d.hasStableAnywhere, txFromIsWallet })
    if (swapReason !== null) { swapTxHashes.add(txHash); swapReasons.set(txHash, swapReason) }
  }

  if (swapTxHashes.size === 0) {
    return {
      enrichedEvidence: evidenceWithDetection,
      debug: {
        ...emptyDebug('no_swap_txs_found', true, true),
        candidateTxsChecked: toFetch.length, candidateTxHashes: toFetch, includesProblemTx: toFetch.includes(BASE_UNKNOWN_RECON_PROBLEM_TX), mixedKnownUnknownTxs,
        receiptsFetched, decodedTransferLogs: totalTransferLogs, walletSideLegsFound, quoteLegsFound, tokenLegsFound,
        wethLegsFound, stableLegsFound, sampleTxs, skippedReasons: skippedReasons.slice(0, 15),
      },
    }
  }

  // Promote events in confirmed swap txs:
  // - unknown-direction: determine buy/sell from per-contract receipt leg lookup; for WETH/stable in swap tx infer direction
  // - known buy/sell: mark as swap candidate (they're in a confirmed swap tx)
  let syntheticSwapEventsAdded = 0
  const sampleSyntheticEvents: Array<{ txHash: string; symbol: string; direction: string }> = []

  const enrichedEvidence: WalletTxEvidence[] = evidenceWithDetection.map(e => {
    const txHashLower = (e.txHash ?? '').toLowerCase()
    if (!txHashLower || !swapTxHashes.has(txHashLower)) return e
    if (e.swapDetection?.isSwapCandidate) return e
    const d = txDecodes.get(txHashLower)
    if (!d || d.decodeStatus !== 'ok') return e
    const contractLower = (e.contract ?? '').toLowerCase()
    const swapReason = swapReasons.get(txHashLower) ?? 'base_unknown_recon'
    const confidence: 'high' | 'medium' = d.isKnownRouter ? 'high' : 'medium'
    const swapReconstructionConfidence: 'high' | 'medium' = d.isKnownRouter ? 'high' : 'medium'

    if (e.direction !== 'unknown') {
      // Known buy/sell in a confirmed swap tx — mark as swap candidate, direction already correct
      syntheticSwapEventsAdded++
      if (sampleSyntheticEvents.length < 5) sampleSyntheticEvents.push({ txHash: e.txHash.slice(0, 12) + '…', symbol: e.symbol, direction: e.direction })
      return { ...e, swapDetection: { isSwapCandidate: true, confidence, eventKind: 'swap_candidate' as const, reason: `Base unknown-dir recon (known event in swap tx): ${swapReason}`, matchedProtocol: d.routerProtocol, matchedAddress: null, swapReconstructionConfidence } satisfies WalletSwapDetection }
    }

    // Unknown direction: determine from receipt logs
    const isInbound = d.walletInbound.some(leg => leg.contract === contractLower)
    const isOutbound = d.walletOutbound.some(leg => leg.contract === contractLower)
    let direction: 'buy' | 'sell' | null = isInbound ? 'buy' : isOutbound ? 'sell' : null

    // WETH/stable event in swap tx — infer direction from context when not directly wallet-side
    if (direction === null && (WETH_CONTRACTS_PRICE[contractLower] || STABLE_USD_CONTRACTS[contractLower])) {
      const hasInboundNonQuote = d.walletInbound.some(i => !STABLE_USD_CONTRACTS[i.contract] && !WETH_CONTRACTS_PRICE[i.contract])
      // Wallet received a token and WETH moved in the tx → wallet paid WETH (sell direction for quote leg)
      direction = hasInboundNonQuote ? 'sell' : null
    }

    // Router tx: infer from payment leg
    if (direction === null && d.isKnownRouter) {
      const hasOutboundPayment = d.walletOutbound.some(o => STABLE_USD_CONTRACTS[o.contract] || WETH_CONTRACTS_PRICE[o.contract])
      direction = hasOutboundPayment ? 'buy' : null
    }

    // Last-resort raw Base proof: same receipt/evidence tx has quote + non-quote legs, all provider
    // directions were unknown. Promote quote as payment and non-quote as acquired token.
    if (direction === null && swapReason.includes('raw_all_unknown_quote_token_receipt_confirmed')) {
      direction = (WETH_CONTRACTS_PRICE[contractLower] || STABLE_USD_CONTRACTS[contractLower]) ? 'sell' : 'buy'
    }

    if (swapReconstructionConfidence !== 'high') {
      return e
    }

    if (direction === null) {
      if (e.txHash.toLowerCase() === BASE_UNKNOWN_RECON_PROBLEM_TX) skippedReasons.push(`problem_tx_event_not_promoted:${contractLower}:${e.symbol}:no_direction_inferred`)
      return e
    }
    syntheticSwapEventsAdded++
    if (sampleSyntheticEvents.length < 5) sampleSyntheticEvents.push({ txHash: e.txHash.slice(0, 12) + '…', symbol: e.symbol, direction })
    return {
      ...e, direction,
      swapDetection: { isSwapCandidate: true, confidence, eventKind: 'swap_candidate' as const, reason: `Base unknown-dir recon: ${swapReason}`, matchedProtocol: d.routerProtocol, matchedAddress: null, swapReconstructionConfidence } satisfies WalletSwapDetection,
    }
  })

  return {
    enrichedEvidence,
    debug: {
      attempted: true,
      triggerMatched: true,
      ...baseDebugProof(),
      reason: syntheticSwapEventsAdded > 0 ? `promoted_${syntheticSwapEventsAdded}_from_${swapTxHashes.size}_swap_txs` : 'swap_txs_found_but_no_events_promoted',
      candidateTxsChecked: toFetch.length, candidateTxHashes: toFetch, includesProblemTx: toFetch.includes(BASE_UNKNOWN_RECON_PROBLEM_TX), mixedKnownUnknownTxs,
      receiptsFetched, decodedTransferLogs: totalTransferLogs, walletSideLegsFound, quoteLegsFound, tokenLegsFound,
      wethLegsFound, stableLegsFound, syntheticSwapEventsAdded, sampleTxs, sampleSyntheticEvents, skippedReasons: skippedReasons.slice(0, 15),
    },
  }
}

// ── Unpriced Candidate Receipt Pass ──────────────────────────────────────────────────────
// Runs AFTER buildPriceAtTimeEvidence when swap candidates exist but all are unpriced.
// Fetches receipts for those specific tx hashes to find WETH/USDC quote legs that were
// not present in the normalized activity feed (e.g. router internal legs, native ETH).
// Creates synthetic WalletTxEvidence legs so re-running buildPriceAtTimeEvidence can price them.
async function buildUnpricedCandidateReceiptPass(
  evidenceWithDetection: WalletTxEvidence[],
  unpricedTxHashes: string[],
  walletAddress: string,
  rpcUrl: string,
  rpcSource: 'alchemy' | 'public_base_rpc' | 'none',
  closedLotsBefore: number,
  realizedPnlBefore: number | null,
): Promise<{
  enrichedEvidence: WalletTxEvidence[]
  debug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['basePnlReconstructionDebug']>
}> {
  const walletLower = walletAddress.toLowerCase()
  const rpcConfigured = rpcSource !== 'none'
  const emptyDebug = (reason: string): NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['basePnlReconstructionDebug']> => ({
    attempted: true, reason, rpcSource, rpcConfigured,
    candidateTxCount: 0, receiptsFetched: 0, receiptCacheHits: 0, transactionsFetched: 0,
    decodedTransferLogs: 0, walletInboundLegs: 0, walletOutboundLegs: 0,
    inboundTokenMatches: 0, outboundTokenMatches: 0,
    nativeEthPaymentMatches: 0, stablecoinMatches: 0, wethMatches: 0, routerMatches: 0,
    enrichedSwapEvents: 0, pricedEnrichedEvents: 0,
    closedLotsBefore, closedLotsAfter: closedLotsBefore,
    realizedPnlBefore, realizedPnlAfter: realizedPnlBefore,
    skippedNoPaymentLeg: 0, skippedNoInboundToken: 0, skippedNoPriceEvidence: 0, skippedBudgetCap: 0,
    providerErrors: 0, sampleMatches: [], sampleUnpricedAfterReceipt: [],
  })

  if (!rpcUrl || rpcSource === 'none') return { enrichedEvidence: evidenceWithDetection, debug: emptyDebug('no_rpc_available') }
  if (unpricedTxHashes.length === 0) return { enrichedEvidence: evidenceWithDetection, debug: emptyDebug('no_unpriced_tx_hashes') }

  const toFetch = unpricedTxHashes.slice(0, 8)
  const now = Date.now()
  let receiptsFetched = 0
  let receiptCacheHits = 0
  let transactionsFetched = 0
  let providerErrors = 0
  let totalTransferLogs = 0
  let walletInboundLegs = 0
  let walletOutboundLegs = 0
  let nativeEthPaymentMatches = 0
  let stablecoinMatches = 0
  let wethMatches = 0
  let inboundTokenMatches = 0
  let outboundTokenMatches = 0
  const _rpcUrl = rpcUrl  // local alias to distinguish from buildBasePnlReconstructionPass scope

  const txDecodes = new Map<string, BasePnlReceiptDecode>()
  const txNativeValues = new Map<string, string>()  // txHash → raw hex tx.value

  // Fetch all receipts in parallel — reuse the same module-level cache as buildBasePnlReconstructionPass
  await Promise.allSettled(toFetch.map(async (txHash) => {
    const cacheKey = `base_recon:${txHash}`
    const cached = basePnlReceiptCache.get(cacheKey)
    if (cached && cached.exp > now) {
      receiptCacheHits++
      txDecodes.set(txHash, cached.data)
      return
    }
    try {
      const receipt = await getSharedTxReceipt(_rpcUrl, txHash)
      receiptsFetched++
      if (!receipt) {
        const d: BasePnlReceiptDecode = { txFrom: null, txTo: null, walletInbound: [], walletOutbound: [], isKnownRouter: false, routerProtocol: null, hasStableLeg: false, hasWethLeg: false, totalTransferLogs: 0, decodeStatus: 'no_receipt', reason: 'receipt_null' }
        basePnlReceiptCache.set(cacheKey, { data: d, exp: now + BASE_PNL_RECON_TTL_MS })
        txDecodes.set(txHash, d)
        return
      }
      const txFrom = typeof receipt.from === 'string' ? (receipt.from as string).toLowerCase() : null
      const txTo = typeof receipt.to === 'string' ? (receipt.to as string).toLowerCase() : null
      const isKnownRouter = Boolean(txTo && EXTENDED_DEX_ROUTERS.has(txTo))
      const routerProtocol = txTo ? (KNOWN_DEX_ROUTERS[txTo] ?? (isKnownRouter ? 'known_dex_router' : null)) : null
      const logs: Array<{ topics?: string[]; address?: string }> = Array.isArray(receipt.logs) ? receipt.logs : []
      const inbound: BasePnlReceiptDecode['walletInbound'] = []
      const outbound: BasePnlReceiptDecode['walletOutbound'] = []
      let hasStable = false
      let hasWeth = false
      let logCount = 0
      for (const log of logs) {
        if (!log.topics || log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue
        if (log.topics.length < 3) continue
        logCount++
        const fromAddr = '0x' + (log.topics[1]?.toLowerCase() ?? '').slice(-40)
        const toAddr = '0x' + (log.topics[2]?.toLowerCase() ?? '').slice(-40)
        const contractAddr = (log.address ?? '').toLowerCase()
        const amountHex = typeof (log as Record<string, unknown>).data === 'string' ? (log as Record<string, unknown>).data as string : '0x0'
        if (toAddr === walletLower) {
          inbound.push({ contract: contractAddr, amountHex })
          if (STABLE_USD_CONTRACTS[contractAddr]) hasStable = true
          if (WETH_CONTRACTS_PRICE[contractAddr]) hasWeth = true
        }
        if (fromAddr === walletLower) {
          outbound.push({ contract: contractAddr, amountHex })
          if (STABLE_USD_CONTRACTS[contractAddr]) hasStable = true
          if (WETH_CONTRACTS_PRICE[contractAddr]) hasWeth = true
        }
      }
      const d: BasePnlReceiptDecode = {
        txFrom, txTo, walletInbound: inbound, walletOutbound: outbound,
        isKnownRouter, routerProtocol, hasStableLeg: hasStable, hasWethLeg: hasWeth,
        totalTransferLogs: logCount, decodeStatus: 'ok', reason: 'decoded',
      }
      basePnlReceiptCache.set(cacheKey, { data: d, exp: now + BASE_PNL_RECON_TTL_MS })
      txDecodes.set(txHash, d)
      totalTransferLogs += logCount
      walletInboundLegs += inbound.length
      walletOutboundLegs += outbound.length
    } catch {
      providerErrors++
    }
  }))

  // Fetch tx.value for native-ETH-paid candidates in parallel
  await Promise.allSettled(toFetch.map(async (txHash) => {
    const d = txDecodes.get(txHash)
    if (!d || d.decodeStatus !== 'ok') return
    if (d.walletOutbound.some(o => WETH_CONTRACTS_PRICE[o.contract] || STABLE_USD_CONTRACTS[o.contract])) return
    if (d.txFrom !== walletLower) return
    const txCacheKey = `base_recon_tx:${txHash}`
    const txCached = basePnlTxCache.get(txCacheKey)
    if (txCached && txCached.exp > now) {
      if (txCached.value && txCached.value !== '0x0' && txCached.value !== '0x') {
        txNativeValues.set(txHash, txCached.value)
      }
      return
    }
    try {
      const txData = await getSharedTxByHash(_rpcUrl, txHash)
      transactionsFetched++
      const val: string = (txData && typeof txData.value === 'string') ? txData.value : '0x0'
      basePnlTxCache.set(txCacheKey, { value: val, exp: now + BASE_PNL_RECON_TTL_MS })
      if (val && val !== '0x0' && val !== '0x' && hexAmountToDecimal(val, 0) > 0) {
        txNativeValues.set(txHash, val)
      }
    } catch {
      providerErrors++
    }
  }))

  // Build synthetic evidence legs and per-tx receipt failure reasons
  const syntheticLegs: WalletTxEvidence[] = []
  const sampleMatches: Array<{ txHash: string; direction: string; symbol: string; paymentType: string }> = []
  const sampleUnpricedAfterReceipt: Array<{ txHash: string; symbol: string; finalReason: string }> = []

  for (const txHash of toFetch) {
    const d = txDecodes.get(txHash)
    const refEvent = evidenceWithDetection.find(e => e.txHash === txHash && e.swapDetection?.isSwapCandidate)
    const candidatesInTx = evidenceWithDetection.filter(e => e.txHash === txHash && e.swapDetection?.isSwapCandidate)
    if (!d || d.decodeStatus !== 'ok') {
      for (const cand of candidatesInTx) {
        sampleUnpricedAfterReceipt.push({ txHash: txHash.slice(0, 10) + '…', symbol: cand.symbol, finalReason: 'receipt_checked_no_quote_leg' })
      }
      continue
    }
    if (!refEvent) continue

    let addedAnyLeg = false

    // WETH inbound to wallet (e.g. wallet sold token and received WETH)
    for (const leg of d.walletInbound) {
      if (!WETH_CONTRACTS_PRICE[leg.contract]) continue
      const alreadyPresent = evidenceWithDetection.some(e => e.txHash === txHash && WETH_CONTRACTS_PRICE[e.contract.toLowerCase()] && e.direction === 'buy')
      if (alreadyPresent) continue
      const amt = hexAmountToDecimal(leg.amountHex, 18)
      if (!amt || amt <= 0) continue
      syntheticLegs.push({
        txHash, timestamp: refEvent.timestamp, fromAddress: d.txTo, toAddress: walletLower,
        contract: leg.contract, symbol: 'WETH', amountRaw: null, tokenDecimals: null,
        amount: amt, usdValue: null, direction: 'buy', chain: refEvent.chain ?? 'base',
      })
      wethMatches++; inboundTokenMatches++; addedAnyLeg = true
      if (sampleMatches.length < 5) sampleMatches.push({ txHash: txHash.slice(0, 10) + '…', direction: 'buy', symbol: 'WETH', paymentType: 'weth_inbound' })
    }

    // Stable inbound to wallet (e.g. wallet sold token and received USDC)
    for (const leg of d.walletInbound) {
      if (!STABLE_USD_CONTRACTS[leg.contract]) continue
      const alreadyPresent = evidenceWithDetection.some(e => e.txHash === txHash && STABLE_USD_CONTRACTS[e.contract.toLowerCase()] && e.direction === 'buy')
      if (alreadyPresent) continue
      const decimals = STABLE_DECIMALS[leg.contract] ?? 6
      const amt = hexAmountToDecimal(leg.amountHex, decimals)
      if (!amt || amt <= 0) continue
      const sym = STABLE_SYMBOL[leg.contract] ?? 'USDC'
      syntheticLegs.push({
        txHash, timestamp: refEvent.timestamp, fromAddress: d.txTo, toAddress: walletLower,
        contract: leg.contract, symbol: sym, amountRaw: null, tokenDecimals: null,
        amount: amt, usdValue: amt, direction: 'buy', chain: refEvent.chain ?? 'base',
      })
      stablecoinMatches++; inboundTokenMatches++; addedAnyLeg = true
      if (sampleMatches.length < 5) sampleMatches.push({ txHash: txHash.slice(0, 10) + '…', direction: 'buy', symbol: sym, paymentType: 'stable_inbound' })
    }

    // WETH outbound from wallet (e.g. wallet bought token by paying WETH)
    for (const leg of d.walletOutbound) {
      if (!WETH_CONTRACTS_PRICE[leg.contract]) continue
      const alreadyPresent = evidenceWithDetection.some(e => e.txHash === txHash && WETH_CONTRACTS_PRICE[e.contract.toLowerCase()] && e.direction === 'sell')
      if (alreadyPresent) continue
      const amt = hexAmountToDecimal(leg.amountHex, 18)
      if (!amt || amt <= 0) continue
      syntheticLegs.push({
        txHash, timestamp: refEvent.timestamp, fromAddress: walletLower, toAddress: d.txTo,
        contract: leg.contract, symbol: 'WETH', amountRaw: null, tokenDecimals: null,
        amount: amt, usdValue: null, direction: 'sell', chain: refEvent.chain ?? 'base',
      })
      wethMatches++; outboundTokenMatches++; addedAnyLeg = true
      if (sampleMatches.length < 5) sampleMatches.push({ txHash: txHash.slice(0, 10) + '…', direction: 'sell', symbol: 'WETH', paymentType: 'weth_outbound' })
    }

    // Stable outbound from wallet (e.g. wallet bought token by paying USDC)
    for (const leg of d.walletOutbound) {
      if (!STABLE_USD_CONTRACTS[leg.contract]) continue
      const alreadyPresent = evidenceWithDetection.some(e => e.txHash === txHash && STABLE_USD_CONTRACTS[e.contract.toLowerCase()] && e.direction === 'sell')
      if (alreadyPresent) continue
      const decimals = STABLE_DECIMALS[leg.contract] ?? 6
      const amt = hexAmountToDecimal(leg.amountHex, decimals)
      if (!amt || amt <= 0) continue
      const sym = STABLE_SYMBOL[leg.contract] ?? 'USDC'
      syntheticLegs.push({
        txHash, timestamp: refEvent.timestamp, fromAddress: walletLower, toAddress: d.txTo,
        contract: leg.contract, symbol: sym, amountRaw: null, tokenDecimals: null,
        amount: amt, usdValue: amt, direction: 'sell', chain: refEvent.chain ?? 'base',
      })
      stablecoinMatches++; outboundTokenMatches++; addedAnyLeg = true
      if (sampleMatches.length < 5) sampleMatches.push({ txHash: txHash.slice(0, 10) + '…', direction: 'sell', symbol: sym, paymentType: 'stable_outbound' })
    }

    // Native ETH payment (wallet paid native ETH when initiating a buy tx)
    const nativeValHex = txNativeValues.get(txHash)
    if (nativeValHex) {
      const BASE_WETH = '0x4200000000000000000000000000000000000006'
      const alreadyEthPresent = evidenceWithDetection.some(e => e.txHash === txHash && WETH_CONTRACTS_PRICE[e.contract.toLowerCase()] && e.direction === 'sell')
      const alreadySynthetic = syntheticLegs.some(e => e.txHash === txHash && WETH_CONTRACTS_PRICE[e.contract.toLowerCase()] && e.direction === 'sell')
      if (!alreadyEthPresent && !alreadySynthetic) {
        const ethAmt = hexAmountToDecimal(nativeValHex, 18)
        if (ethAmt > 0) {
          syntheticLegs.push({
            txHash, timestamp: refEvent.timestamp, fromAddress: walletLower, toAddress: d.txTo,
            contract: BASE_WETH, symbol: 'WETH', amountRaw: null, tokenDecimals: null,
            amount: ethAmt, usdValue: null, direction: 'sell', chain: refEvent.chain ?? 'base',
          })
          nativeEthPaymentMatches++; outboundTokenMatches++; addedAnyLeg = true
          if (sampleMatches.length < 5) sampleMatches.push({ txHash: txHash.slice(0, 10) + '…', direction: 'sell', symbol: 'ETH', paymentType: 'native_eth_payment' })
        }
      }
    }

    // If nothing added for this tx, record receipt-level failure reason
    if (!addedAnyLeg) {
      let receiptFailReason: string
      if (d.walletInbound.length === 0 && d.walletOutbound.length === 0) {
        receiptFailReason = 'receipt_checked_no_wallet_quote_transfer'
      } else if (!d.hasStableLeg && !d.hasWethLeg && !txNativeValues.get(txHash)) {
        receiptFailReason = 'receipt_checked_no_counter_asset'
      } else {
        receiptFailReason = 'receipt_checked_no_native_value'
      }
      for (const cand of candidatesInTx) {
        sampleUnpricedAfterReceipt.push({ txHash: txHash.slice(0, 10) + '…', symbol: cand.symbol, finalReason: receiptFailReason })
      }
    }
  }

  const enrichedSwapEvents = syntheticLegs.length
  const enrichedEvidence = enrichedSwapEvents > 0 ? [...evidenceWithDetection, ...syntheticLegs] : evidenceWithDetection

  return {
    enrichedEvidence,
    debug: {
      attempted: true,
      reason: 'unpriced_candidates_receipt_reconstruction',
      rpcSource,
      rpcConfigured,
      candidateTxCount: toFetch.length,
      receiptsFetched,
      receiptCacheHits,
      transactionsFetched,
      decodedTransferLogs: totalTransferLogs,
      walletInboundLegs,
      walletOutboundLegs,
      inboundTokenMatches,
      outboundTokenMatches,
      nativeEthPaymentMatches,
      stablecoinMatches,
      wethMatches,
      routerMatches: 0,
      enrichedSwapEvents,
      pricedEnrichedEvents: 0,
      closedLotsBefore,
      closedLotsAfter: closedLotsBefore,
      realizedPnlBefore,
      realizedPnlAfter: realizedPnlBefore,
      skippedNoPaymentLeg: 0,
      skippedNoInboundToken: 0,
      skippedNoPriceEvidence: 0,
      skippedBudgetCap: Math.max(0, unpricedTxHashes.length - toFetch.length),
      providerErrors,
      sampleMatches,
      sampleUnpricedAfterReceipt,
    },
  }
}

export async function fetchWalletSnapshot(address: string, options: WalletSnapshotOptions = {}): Promise<WalletSnapshot> {
  const { refresh = false, chain: requestedChain = 'base', deepScan = false, deepActivity = false, chainMode = 'auto', historicalCoverage = false, maxHistoricalPages: rawMaxHistoricalPages, maxFallbackPages: rawMaxFallbackPages, walletScanBudget, debug = false, maxDebugTokens = DEFAULT_MAX_DEBUG_TOKENS } = options
  const clampedMaxHistoricalPages = Math.max(1, Math.min(5, rawMaxHistoricalPages ?? 3))
  const MAX_MORALIS_FALLBACK_PAGES = 5
  const clampedMaxFallbackPages = Math.max(1, Math.min(MAX_MORALIS_FALLBACK_PAGES, rawMaxFallbackPages ?? 2))
  const tokenMeter = createTokenMeter(debug, maxDebugTokens)
  // Per-request price cache: prevents duplicate GoldRush historical price calls within a single scan
  // when the same contract/date appears in both base evidence and historical coverage pipelines.
  const _reqPriceCache = new Map<string, number | null>()

  // Per-request API call tracker — instrumented at each provider call site
  const _apiCallLog: _ApiCallEntry[] = []
  const _dupKeysSeen = new Set<string>()
  const _trackCall = (
    provider: 'moralis' | 'goldrush' | 'alchemy',
    endpoint: string,
    cacheHit: boolean,
    dupKey: string,
  ): boolean => {
    const duplicate = _dupKeysSeen.has(dupKey)
    if (!duplicate) _dupKeysSeen.add(dupKey)
    const credits = cacheHit || duplicate ? 0 : (CREDIT_TABLE[`${provider}:${endpoint}`] ?? 1)
    _apiCallLog.push({ provider, endpoint, credits, cacheHit, duplicate, dupKey })
    return duplicate
  }

  // Unified Alchemy dedup — tracks (method, address, chain) to catch redundant concurrent calls
  const _alchemyDedup = new Set<string>()
  // activityRequested: true when either deepScan (full holdings+activity) or deepActivity (activity-only) is set
  const activityRequested = deepScan || deepActivity
  // Separate address normalisation from cache key so regex validation always checks the address portion only
  const addrNorm = (address ?? '').trim().toLowerCase()
  const cacheKey = `${addrNorm}:${activityRequested ? 'activity' : 'holdings'}:${SNAPSHOT_SCHEMA_VERSION}`

  // Memory cache check — bypassed when refresh=true
  if (!refresh && /^0x[0-9a-fA-F]{40}$/i.test(addrNorm)) {
    const cached = snapshotMemCache.get(cacheKey)
    if (cached) {
      const ageMs = Date.now() - cached.cachedAt
      if (ageMs <= cached.ttlMs) {
        const cacheAgeSeconds = Math.floor(ageMs / 1000)
        const cachedSnapshot: WalletSnapshot = {
          ...cached.snapshot,
          dataFreshness: 'cached',
          cacheAgeSeconds,
          _diagnostics: cached.snapshot._diagnostics ? {
            ...cached.snapshot._diagnostics,
            snapshotCache: {
              memoryHit: true, persistentHit: false, providerFetchNeeded: false,
              refreshBypassedCache: false, cacheAgeSeconds, cacheTtlSeconds: cached.ttlMs / 1000,
              cacheVersion: SNAPSHOT_SCHEMA_VERSION, cacheBypassReason: null, debugFreshBypassedPersistentCache: false,
            },
          } : undefined,
          walletProfileDebug: cached.snapshot.walletProfileDebug ? {
            ...cached.snapshot.walletProfileDebug,
            cacheSource: 'memory_cache',
          } : undefined,
        }
        return validateWalletFactsShape(cachedSnapshot)
      }
      snapshotMemCache.delete(cacheKey)
    }
  }

  const startedAt = Date.now()
  const _perfPhaseTs: Record<string, number> = { start: startedAt }
  const _perfWalletTimings = { chainDiscoveryMs: 0, holdingsMs: 0, activityMs: 0, swapDetectionMs: 0, pricingMs: 0, fifoMs: 0, tradeStatsMs: 0, historicalMs: 0 }
  const _perfTimedOut: string[] = []
  const _perfSkipped: string[] = []
  const _perfParallelized: string[] = ['phase1_holdings_activity', 'receipt_fetches_base_recon', 'receipt_fetches_eth_router_recon', 'receipt_fetches_unpriced_pass', 'moralis_chain_balances', 'moralis_multichain_activity_supplement']
  const addr: string = (address ?? '').trim()
  if (!addr || !/^0x[0-9a-fA-F]{40}$/i.test(addr)) {
    throw new Error('Invalid wallet address')
  }

  const ethUrl  = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_ETH_KEY}`
  const baseUrl = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_BASE_KEY}`
  // Effective Base RPC for receipt-only calls: prefer Alchemy, fall back to public node
  const baseRpcUrl  = ALCHEMY_BASE_KEY ? baseUrl : PUBLIC_BASE_RPC
  const _baseRpcSource: 'alchemy' | 'public_base_rpc' | 'none' = ALCHEMY_BASE_KEY ? 'alchemy' : 'public_base_rpc'

  // ETH Alchemy calls only when explicitly requested — default is Base only
  const useEthAlchemy = requestedChain === 'eth' && Boolean(ALCHEMY_ETH_KEY)
  const nonceUrl = useEthAlchemy ? ethUrl : baseUrl
  // GoldRush ETH activity: gated on chain being ETH, NOT on Alchemy ETH key availability.
  // Previously tied to useEthAlchemy, which caused ETH wallets without ALCHEMY_ETH_KEY to silently
  // skip GoldRush ETH and rely solely on Moralis fallback for activity data.
  // Eager fetch only when ETH is explicitly the requested chain — base_eth/all_supported defer
  // until discovered chain holdings confirm meaningful ETH value, so Base-only wallets that
  // merely default to base_eth mode don't burn an extra GoldRush credit on ETH.
  const _shouldFetchGrEthEager = activityRequested && Boolean(GOLDRUSH_KEY) && (requestedChain === 'eth' || chainMode === 'eth')

  // Determine Moralis chain before Phase 1 so it can run in the parallel batch.
  const _moralisChain: 'eth' | 'base' = requestedChain === 'eth' ? 'eth' : 'base'

  tokenMeter.startTokenMeter('providerFetch')
  tokenMeter.measure('providerFetch', addr, requestedChain, chainMode, activityRequested ? 'activity' : 'holdings')

  // Phase 1 (parallel): Zerion portfolio value + Alchemy metadata + GoldRush activity.
  // Zerion positions are fetched in parallel as a fallback_layer. Moralis holdings run once later
  // in the multi-chain holdings phase; Alchemy activity is deferred until GoldRush returns empty.
  const [
    portfolioRes,    // Zerion: total portfolio value
    positionsRes,    // Zerion: token positions — fallback_layer only
    ethFirst,
    baseFirst,
    nonceRes,
    behaviorRes,
    grPnlEthRes,
    grPnlBaseRes,
  ] = await Promise.allSettled([
    ZERION_KEY
      ? zerionGet(`wallets/${addr}/portfolio/`, { currency: 'usd' })
      : Promise.reject(new Error('Zerion key not configured')),
    ZERION_KEY
      ? zerionGet(`wallets/${addr}/positions/`, {
          currency: 'usd',
          'filter[positions]': 'only_simple',
          'filter[trash]': 'only_non_trash',
          sort: '-value',
          'page[size]': '50',
        })
      : Promise.reject(new Error('Zerion key not configured')),
    useEthAlchemy ? getFirstTxOnChain(addr, ethUrl) : Promise.resolve(null),
    getFirstTxOnChain(addr, baseUrl),
    alchemyRpc(nonceUrl, 'eth_getTransactionCount', [addr, 'latest']),
    deepScan && !(activityRequested && Boolean(ALCHEMY_BASE_KEY)) ? fetchWalletBehavior(addr, baseUrl) : Promise.resolve(BEHAVIOR_EMPTY),
    // ETH mainnet PnL transfers only when activity is requested AND ETH chain is selected.
    // Default (base) scans skip this to avoid a wasted transactions_v3 call.
    _shouldFetchGrEthEager ? fetchGoldrushPnlEvents(addr, 'eth-mainnet', GOLDRUSH_KEY, tokenMeter.isDebugEnabled()) : Promise.resolve({ events: [] as PnlEvent[], diag: { endpointKind: 'transactions_v3' as const, chainUsed: 'eth-mainnet', urlTemplate: 'https://api.covalenthq.com/v1/eth-mainnet/address/{wallet}/transactions_v3/?page-size=50&page-number=0&with-logs=true&no-spam=true', httpStatus: null, fetchFailed: true, failureStage: 'build_url' as const, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], transferArrayCount: 0, firstTransferKeys: [], reason: activityRequested ? 'ETH chain not requested — skipped to reduce API usage.' : 'Activity scan not requested — skipped.' } }),
    activityRequested && GOLDRUSH_KEY ? fetchGoldrushPnlEvents(addr, 'base-mainnet', GOLDRUSH_KEY, tokenMeter.isDebugEnabled()) : Promise.resolve({ events: [] as PnlEvent[], diag: { endpointKind: 'transactions_v3' as const, chainUsed: 'base-mainnet', urlTemplate: 'https://api.covalenthq.com/v1/base-mainnet/address/{wallet}/transactions_v3/?page-size=50&page-number=0&with-logs=true&no-spam=true', httpStatus: null, fetchFailed: true, failureStage: 'build_url' as const, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], transferArrayCount: 0, firstTransferKeys: [], reason: activityRequested ? 'GoldRush activity fetch skipped — provider not configured.' : 'Activity scan not requested — skipped.' } }),
  ])

  _perfPhaseTs.phase1_done = Date.now()
  _perfWalletTimings.holdingsMs = _perfPhaseTs.phase1_done - startedAt
  // ── Tx / age / nonce ──
  const firstCandidates: Date[] = []
  if (ethFirst.status === 'fulfilled' && ethFirst.value) firstCandidates.push(ethFirst.value)
  if (baseFirst.status === 'fulfilled' && baseFirst.value) firstCandidates.push(baseFirst.value)
  const firstTxDate = firstCandidates.length > 0
    ? new Date(Math.min(...firstCandidates.map(d => d.getTime())))
    : null
  const walletAgeDays = firstTxDate
    ? Math.floor((Date.now() - firstTxDate.getTime()) / 86_400_000)
    : null
  const txCount = nonceRes.status === 'fulfilled' && nonceRes.value
    ? parseInt(nonceRes.value as string, 16)
    : null

  // ── Provider values extracted from Phase 1 results ──
  // Zerion portfolio total (for wallet value only — not for individual token positions)
  const _zerionPortfolioTotal: number | null = portfolioRes.status === 'fulfilled'
    ? (portfolioRes.value?.data?.attributes?.total?.positions ?? null)
    : null
  const _zerionValueUsable = typeof _zerionPortfolioTotal === 'number' && _zerionPortfolioTotal > 0

  // Zerion positions (fallback_layer only — lower priority than Moralis)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawPos: any[] = positionsRes.status === 'fulfilled' ? (positionsRes.value?.data ?? []) : []
  const _zerionPositionsUsable = rawPos.length > 0

  // Moralis holdings are fetched once in the multi-chain holdings phase below.
  const _moralisResult: MoralisFetchResult = { holdings: [], attempted: false, usable: false, cacheHit: false, reason: 'moralis_warmup_removed' }
  let _moralisHoldingsUsable = false

  // ── Track Phase 1 provider calls ──
  if (activityRequested && Boolean(GOLDRUSH_KEY)) _trackCall('goldrush', 'transactions_v3', false, `gr:tx3:base:${addrNorm}`)
  if (_shouldFetchGrEthEager) _trackCall('goldrush', 'transactions_v3', false, `gr:tx3:eth:${addrNorm}`)
  if (activityRequested && Boolean(ALCHEMY_BASE_KEY)) {
    // Alchemy Base activity is intentionally deferred until GoldRush returns no activity.
  }
  if (Boolean(ALCHEMY_BASE_KEY)) {
    const _ak3 = `alchemy:firstTx:base:${addrNorm}`; if (!_alchemyDedup.has(_ak3)) { _alchemyDedup.add(_ak3); _trackCall('alchemy', 'getFirstTx', false, _ak3) }
    _trackCall('alchemy', 'eth_getTransactionCount', false, `alchemy:nonce:${addrNorm}`)
  }
  if (useEthAlchemy) {
    const _ak4 = `alchemy:firstTx:eth:${addrNorm}`; if (!_alchemyDedup.has(_ak4)) { _alchemyDedup.add(_ak4); _trackCall('alchemy', 'getFirstTx', false, _ak4) }
  }
  if (deepScan && Boolean(ALCHEMY_BASE_KEY) && !activityRequested) {
    const _ak5 = `alchemy:behavior:from:base:${addrNorm}`; if (!_alchemyDedup.has(_ak5)) { _alchemyDedup.add(_ak5); _trackCall('alchemy', 'behavior_getAssetTransfers', false, _ak5) }
    const _ak6 = `alchemy:behavior:to:base:${addrNorm}`;   if (!_alchemyDedup.has(_ak6)) { _alchemyDedup.add(_ak6); _trackCall('alchemy', 'behavior_getAssetTransfers', false, _ak6) }
  }

  // ── Provider selection: Moralis (primary) → Zerion positions (fallback) → GoldRush ──
  let holdings: Holding[] = []
  let totalValue = 0
  let providerUsed: 'portfolio_layer' | 'holdings_layer' | 'fallback_layer' | 'unverified' | 'none' = 'none'
  let providerStatus: 'ok' | 'partial' | 'failed' = 'failed'
  let reason = ''

  if (_moralisHoldingsUsable) {
    // Moralis is primary — use its holdings with Zerion portfolio value when available
    holdings = _moralisResult.holdings as Holding[]
    totalValue = _zerionValueUsable
      ? _zerionPortfolioTotal!
      : holdings.reduce((s, h) => s + h.value, 0)
    providerUsed = _zerionValueUsable ? 'portfolio_layer' : 'holdings_layer'
    providerStatus = _zerionValueUsable ? 'ok' : 'partial'
    if (!_zerionValueUsable) reason = 'Portfolio value estimated from holdings — could not verify total.'
  } else if (_zerionPositionsUsable) {
    // Moralis failed — use Zerion positions as fallback_layer for holdings
    holdings = rawPos
      .map((pos) => {
        const a  = pos.attributes ?? {}
        const fi = a.fungible_info ?? {}
        return {
          contract: typeof fi.implementations?.[0]?.address === 'string' ? fi.implementations[0].address.toLowerCase() : undefined,
          name:      fi.name      ?? 'Unknown',
          symbol:    fi.symbol    ?? '?',
          icon:      fi.icon?.url ?? null,
          chain:     pos.relationships?.chain?.data?.id ?? null,
          balance:   a.quantity?.float   ?? 0,
          value:     a.value             ?? 0,
          price:     a.price             ?? null,
          change24h: a.changes?.percent_1d ?? null,
          verified:  fi.flags?.verified  ?? false,
        }
      })
      .filter(h => h.value > 0.01)
    totalValue = _zerionPortfolioTotal ?? holdings.reduce((s, h) => s + h.value, 0)
    providerUsed = 'fallback_layer'
    providerStatus = 'partial'
    reason = 'Holdings from fallback layer — data may be incomplete.'
  } else {
    reason = positionsRes.status === 'rejected'
      ? 'Portfolio layer and holdings layer both unavailable.'
      : 'No token balances found for this wallet.'
  }

  const minChainValueUsd = 1
  const maxChainsBasicScan = 5
  const supportedMoralisChains: MoralisChain[] = ['eth', 'base', 'polygon', 'bsc', 'arbitrum', 'optimism', 'avalanche', 'fantom', 'cronos', 'gnosis']
  const mapChain = (raw: string): MoralisChain | null => {
    // Strip common suffixes before matching so 'eth-mainnet', 'base-mainnet', etc. resolve correctly
    const c = raw.toLowerCase().replace(/-mainnet$/, '').replace(/-mainnet$/, '')
    if (c === 'eth' || c.includes('ethereum')) return 'eth'
    if (c === 'base' || c.includes('base')) return 'base'
    if (c.includes('polygon') || c === 'matic') return 'polygon'
    if (c.includes('binance') || c.includes('bsc')) return 'bsc'
    if (c.includes('arbitrum')) return 'arbitrum'
    if (c.includes('optimism')) return 'optimism'
    if (c.includes('avalanche')) return 'avalanche'
    if (c.includes('fantom')) return 'fantom'
    if (c.includes('cronos')) return 'cronos'
    if (c.includes('gnosis') || c.includes('xdai')) return 'gnosis'
    return null
  }
  const chainValueMap = new Map<MoralisChain, number>()
  for (const h of holdings) {
    const rawChain = String(h.chain ?? '').toLowerCase()
    const mapped = mapChain(rawChain)
    if (!mapped) continue
    chainValueMap.set(mapped, (chainValueMap.get(mapped) ?? 0) + (h.value ?? 0))
  }
  const discoveredChains = [...chainValueMap.entries()].map(([chain, usdValue]) => ({ chain, usdValue })).sort((a,b)=>b.usdValue-a.usdValue)
  const skippedDustChains = discoveredChains.filter(c => c.usdValue < minChainValueUsd).map(c => c.chain)
  let activeChains: MoralisChain[] = []
  if (chainMode === 'base') activeChains = ['base']
  else if (chainMode === 'eth') activeChains = ['eth']
  else if (chainMode === 'base_eth') activeChains = ['base','eth']
  else if (chainMode === 'all_supported' && deepScan) activeChains = [...supportedMoralisChains]
  else activeChains = discoveredChains.filter(c => c.usdValue >= minChainValueUsd).map(c => c.chain)
  if (activeChains.length === 0 && (requestedChain === 'base' || requestedChain === 'eth')) activeChains = [requestedChain]
  if (activeChains.length === 0) activeChains = ['base', 'eth']
  activeChains = activeChains.filter((c, i, a) => supportedMoralisChains.includes(c) && a.indexOf(c) === i).slice(0, chainMode === 'all_supported' && deepScan ? supportedMoralisChains.length : maxChainsBasicScan)
  _perfPhaseTs.chain_discovery_done = Date.now()
  _perfWalletTimings.chainDiscoveryMs = _perfPhaseTs.chain_discovery_done - _perfPhaseTs.phase1_done

  // Activity routing debug: capture chain selection state before and after value gate
  const _activeChainsBeforeValueGate: MoralisChain[] = (() => {
    if (chainMode === 'base') return ['base' as MoralisChain]
    if (chainMode === 'eth') return ['eth' as MoralisChain]
    if (chainMode === 'base_eth') return ['base' as MoralisChain, 'eth' as MoralisChain]
    if (chainMode === 'all_supported') return [...supportedMoralisChains]
    return discoveredChains.map(c => c.chain)
  })()
  const _activeChainsAfterValueGate: MoralisChain[] = (() => {
    if (chainMode !== 'auto') return _activeChainsBeforeValueGate
    return discoveredChains.filter(c => c.usdValue >= minChainValueUsd).map(c => c.chain)
  })()
  // lowBalanceOverrideUsed: auto mode fell through to requestedChain/base+eth fallback due to empty/dust holdings
  const _lowBalanceOverrideUsed = chainMode === 'auto' && _activeChainsAfterValueGate.length === 0
  const _fallbackChainsUsed: MoralisChain[] = _lowBalanceOverrideUsed ? [...activeChains] : []

  // Moralis holdings layer for active chains.
  let grEthRes: PromiseSettledResult<Holding[]>
  let grBaseRes: PromiseSettledResult<Holding[]>
  const _moralisByChain = new Map<MoralisChain, MoralisFetchResult>()
  let _moralisUsed = false
  if (Boolean(process.env.MORALIS_API_KEY)) {
    // Fetch all active chain balances in parallel instead of sequentially
    await Promise.allSettled(activeChains.map(async (c) => {
      const _mbRes = await fetchMoralisBalances(addr, c)
      _moralisByChain.set(c, _mbRes)
      _trackCall('moralis', 'erc20_holdings', _mbRes.cacheHit, `moralis:holdings:${c}:${addrNorm}`)
    }))
    const moralisHoldings = [..._moralisByChain.values()].flatMap((r) => r.holdings).sort((a, b) => b.value - a.value)

    if (moralisHoldings.length > 0) {
      holdings = moralisHoldings as Holding[]
      totalValue = holdings.reduce((s, h) => s + h.value, 0)
      providerUsed = _zerionValueUsable ? 'portfolio_layer' : 'holdings_layer'
      providerStatus = _zerionValueUsable ? 'ok' : 'partial'
      reason = !_zerionValueUsable ? 'Portfolio value estimated from holdings — could not verify total.' : ''
      _moralisUsed = true
      _moralisHoldingsUsable = true
    }
  }
  // GoldRush balances fallback only when Moralis has no usable holdings for active chains, or deepScan=true.
  const _goldrushBalancesSkipped = !deepScan && _moralisUsed
  const _goldrushSkippedReason = _goldrushBalancesSkipped ? 'moralis_holdings_available' : null
  if (_goldrushBalancesSkipped) {
    grEthRes = { status: 'fulfilled', value: [] }; grBaseRes = { status: 'fulfilled', value: [] }
  } else {
    ;[grEthRes, grBaseRes] = await Promise.allSettled([
      GOLDRUSH_KEY && (deepScan || !_moralisUsed) ? fetchGoldrushBalances(addr, 'eth-mainnet', GOLDRUSH_KEY) : Promise.resolve([] as Holding[]),
      GOLDRUSH_KEY && (deepScan || !_moralisUsed) ? fetchGoldrushBalances(addr, 'base-mainnet', GOLDRUSH_KEY) : Promise.resolve([] as Holding[]),
    ])
    if (Boolean(GOLDRUSH_KEY) && (deepScan || !_moralisUsed)) {
      _trackCall('goldrush', 'balances_v2', false, `gr:balances:eth:${addrNorm}`)
      _trackCall('goldrush', 'balances_v2', false, `gr:balances:base:${addrNorm}`)
    }
  }
  const _grPrimaryAttempted = Boolean(GOLDRUSH_KEY) && (deepScan || !_moralisUsed)
  const _preFallbackReason = reason
  const _grPrimaryUsable = false
  if (holdings.length === 0) {
    const grHoldings = [
      ...(grEthRes.status === 'fulfilled' ? grEthRes.value : []),
      ...(grBaseRes.status === 'fulfilled' ? grBaseRes.value : []),
    ].sort((a, b) => b.value - a.value)
    if (grHoldings.length > 0) {
      holdings = grHoldings
      totalValue = holdings.reduce((s, h) => s + h.value, 0)
      providerStatus = 'partial'
      reason = ''
    }
  }

  if (holdings.length === 0 && !reason) {
    reason = 'No token balances found on supported chains.'
  }

  // Compute wallet value tier early so pricing budget and historical scan can use it
  const _walletValueTier = computeWalletValueTier(totalValue)

  let grEth = grPnlEthRes.status === 'fulfilled' ? grPnlEthRes.value : { events: [] as PnlEvent[], diag: { endpointKind: 'transactions_v3' as const, chainUsed: 'eth-mainnet', urlTemplate: 'https://api.covalenthq.com/v1/eth-mainnet/address/{wallet}/transactions_v3/?page-size=50&page-number=0&with-logs=true&no-spam=true', httpStatus: null, fetchFailed: true, failureStage: 'fetch' as const, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], transferArrayCount: 0, firstTransferKeys: [], reason: 'GoldRush transaction history request failed before response.' } }
  // Deferred ETH GoldRush fetch — only when chainMode is ambiguous about ETH (base_eth/all_supported)
  // and discovered ETH holdings clear a meaningful activity threshold (not just dust). Skips the
  // credit burn for Base-heavy wallets that hold only a few dollars of ETH.
  let _goldrushEthSkippedReason: string | null = null
  const _ethDiscoveredValue = discoveredChains.find(c => c.chain === 'eth')?.usdValue ?? 0
  const _ethActivityThresholdUsd = Math.max(10, totalValue * 0.02)
  const _ethIsDominantChain = discoveredChains.length > 0 && discoveredChains[0].chain === 'eth'
  const _ethClearsActivityGate = _ethDiscoveredValue >= _ethActivityThresholdUsd || _ethIsDominantChain
  const _ethDeferredActivityCandidate = activityRequested && Boolean(GOLDRUSH_KEY) && !_shouldFetchGrEthEager
    && (chainMode === 'base_eth' || chainMode === 'all_supported')
  const _ethActivityEligible = _shouldFetchGrEthEager || (_ethDeferredActivityCandidate && _ethClearsActivityGate)
  const _ethActivitySkippedReason = _ethDeferredActivityCandidate && !_ethClearsActivityGate
    ? 'eth_below_activity_value_gate'
    : null
  const _grEthDeferredEligible = _ethDeferredActivityCandidate && _ethClearsActivityGate
  if (_grEthDeferredEligible) {
    _trackCall('goldrush', 'transactions_v3', false, `gr:tx3:eth:${addrNorm}`)
    try {
      grEth = await fetchGoldrushPnlEvents(addr, 'eth-mainnet', GOLDRUSH_KEY, tokenMeter.isDebugEnabled())
    } catch {
      // keep placeholder grEth on failure
    }
  } else if (_ethActivitySkippedReason) {
    _goldrushEthSkippedReason = _ethActivitySkippedReason
  }
  const _shouldFetchGrEth = _shouldFetchGrEthEager || _grEthDeferredEligible
  const grPnlBaseOut = grPnlBaseRes.status === 'fulfilled' ? grPnlBaseRes.value : { events: [] as PnlEvent[], diag: { endpointKind: 'transactions_v3' as const, chainUsed: 'base-mainnet', urlTemplate: 'https://api.covalenthq.com/v1/base-mainnet/address/{wallet}/transactions_v3/?page-size=50&page-number=0&with-logs=true&no-spam=true', httpStatus: null, fetchFailed: true, failureStage: 'fetch' as const, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], transferArrayCount: 0, firstTransferKeys: [], reason: 'GoldRush transaction history request failed before response.' } }
  const grBase = grPnlBaseOut
  const goldrushTransferDiags = [grEth.diag, grBase.diag]
  const baseTransferDiag = goldrushTransferDiags.find((d) => d.chainUsed === '8453' || d.chainUsed === 'base-mainnet') ?? goldrushTransferDiags[0]
  let grEvents = [...grEth.events, ...grBase.events]
  // ETH normalization debug: surface raw shape and parse results for the GoldRush ETH provider
  const _walletEthNormalizationDebug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletEthNormalizationDebug']> = (() => {
    const grEthDiag = grEth.diag as GoldrushHistoryDiag
    const _rawCount = grEthDiag.rawItemCount ?? 0
    const _normCount = grEthDiag.normalizedEventCount ?? 0
    const _logEvCount = grEthDiag.logEventCount ?? 0
    const _logEvNorm = grEthDiag.logEventNormalizedCount ?? 0
    const _usedLogPath = grEthDiag.transferArrayCount === 0 && _logEvCount > 0
    const _usedTransferPath = (grEthDiag.transferArrayCount ?? 0) > 0
    const _skippedReasons: string[] = []
    if (_rawCount > 0 && _normCount === 0 && _logEvCount === 0 && grEthDiag.transferArrayCount === 0) {
      _skippedReasons.push(`eth_raw_events_unparsed: ${grEthDiag.reason || 'no_transfers_and_no_log_events'}`)
    } else if (_rawCount > 0 && _normCount === 0 && _logEvCount > 0) {
      _skippedReasons.push(`eth_log_events_all_filtered: ${grEthDiag.reason || 'non_wallet_side_or_zero_amount'}`)
    }
    return {
      attempted: _shouldFetchGrEth,
      rawCount: _rawCount,
      normalizedCount: _normCount,
      transfersPath: _usedTransferPath,
      logEventsPath: _usedLogPath,
      logEventCount: _logEvCount,
      logEventNormalizedCount: _logEvNorm,
      skippedCounts: { zeroAmount: 0, nonContractAddress: 0, unknownDirection: 0 },
      rawShapeKeys: grEthDiag.firstEventShapeKeys ?? [],
      sampleRawEvents: [],
      sampleNormalizedEvents: grEth.events.slice(0, 3).map(e => ({ txHash: e.txHash, symbol: e.symbol, direction: e.direction, contract: e.contract, amount: e.amount, chain: e.chain })),
      sampleSkippedReasons: _skippedReasons,
      goldrushEthSkippedReason: _goldrushEthSkippedReason,
      ethValueUsd: _ethDiscoveredValue,
      ethActivityThresholdUsd: _ethActivityThresholdUsd,
      ethActivityEligible: _ethActivityEligible,
      ethActivitySkippedReason: _ethActivitySkippedReason,
    }
  })()
  let alchemyEvents: PnlEvent[] = []
  let _alchemyActivityFallbackAttempted = false
  // PHASE4-FIX-2: also supplement via Alchemy when GoldRush came back "partial" (a handful of
  // events for a wallet with real activity), not only when it returned nothing — otherwise a
  // thin GoldRush result silently starves the merge of Alchemy's fuller dataset below.
  const _GR_PARTIAL_EVENT_THRESHOLD = 5
  if (activityRequested && grEvents.length < _GR_PARTIAL_EVENT_THRESHOLD && Boolean(ALCHEMY_BASE_KEY)) {
    _alchemyActivityFallbackAttempted = true
    const _ak1 = `alchemy:transfers:from:base:${addrNorm}`; if (!_alchemyDedup.has(_ak1)) { _alchemyDedup.add(_ak1); _trackCall('alchemy', 'alchemy_getAssetTransfers', false, _ak1) }
    const _ak2 = `alchemy:transfers:to:base:${addrNorm}`;   if (!_alchemyDedup.has(_ak2)) { _alchemyDedup.add(_ak2); _trackCall('alchemy', 'alchemy_getAssetTransfers', false, _ak2) }
    try {
      alchemyEvents = await fetchAlchemyPnlEvents(addr, baseUrl)
    } catch {
      alchemyEvents = []
    }
  }
  let _walletBehaviorReusedActivityEvents = false
  let _walletBehaviorSkippedDuplicateAlchemy = false
  let behaviorValue: WalletBehavior = behaviorRes.status === 'fulfilled' ? behaviorRes.value : { ...BEHAVIOR_EMPTY, reason: 'Behavior fetch did not complete.' }
  if (deepScan && activityRequested && Boolean(ALCHEMY_BASE_KEY)) {
    if (alchemyEvents.length > 0) {
      behaviorValue = buildWalletBehaviorFromPnlEvents(addr, alchemyEvents)
      _walletBehaviorReusedActivityEvents = true
    } else {
      _walletBehaviorSkippedDuplicateAlchemy = true
    }
  }
  tokenMeter.measure('providerFetch', {
    portfolioRes,
    positionsRes,
    moralisResult: _moralisResult,
    moralisByChain: [..._moralisByChain.entries()],
    goldrushBalances: [grEthRes, grBaseRes],
    holdings,
    totalValue,
    providerUsed,
    providerStatus,
    reason,
    grEvents,
    alchemyEvents,
  })
  tokenMeter.endTokenMeter('providerFetch')
  _perfPhaseTs.provider_fetch_done = Date.now()
  _perfWalletTimings.activityMs = _perfPhaseTs.provider_fetch_done - (_perfPhaseTs.chain_discovery_done ?? _perfPhaseTs.phase1_done ?? startedAt)

  const primaryActivityAttempted = activityRequested && Boolean(GOLDRUSH_KEY)
  const primaryActivityStatusCode = primaryActivityAttempted ? (baseTransferDiag?.httpStatus ?? null) : null
  const primaryActivityErrorKind = primaryActivityAttempted
    ? ((baseTransferDiag as GoldrushHistoryDiag | undefined)?.fetchErrorKind ?? baseTransferDiag?.failureStage ?? null)
    : null
  const primaryActivityFailed = primaryActivityAttempted && Boolean(
    (baseTransferDiag as GoldrushHistoryDiag | undefined)?.fetchFailed && primaryActivityStatusCode === null
      || /fetch failed|network|timeout|before response|did not expose an HTTP response/i.test(`${(baseTransferDiag as GoldrushHistoryDiag | undefined)?.fetchErrorMessage ?? ''} ${baseTransferDiag?.reason ?? ''}`)
  )
  const valuedGrEvents = grEvents.filter((e) => (e.usdValue ?? 0) > 0)
  // PHASE4-FIX-2: union-merge GoldRush + Alchemy instead of "non-empty provider wins". A
  // partial GoldRush payload no longer discards a fuller Alchemy dataset (or vice versa) —
  // both are kept, deduped by the shared event key, preferring whichever copy of a duplicate
  // event carries richer fields (amountRaw/usdValue/decimals/timestamp present).
  const _pnlEventRichness = (e: PnlEvent) => Number(Boolean(e.amountRaw)) + Number(Boolean(e.usdValue)) + Number(e.tokenDecimals != null) + Number(Boolean(e.timestamp))
  // PHASE4-FIX-6 (item 5): assign a synthetic per-provider-batch logIndex to any event that
  // doesn't already carry one (GoldRush/Alchemy normalize their own raw responses upstream and
  // don't currently propagate a real log index), so the dedupe key (item 4) and the
  // deterministic sort (item 1) below both have a stable tiebreaker.
  let _synthLogIndexAssigned = 0
  const _grEventsIdx = assignSyntheticLogIndex(grEvents); grEvents = _grEventsIdx.events; _synthLogIndexAssigned += _grEventsIdx.syntheticCount
  const _alchemyEventsIdx = assignSyntheticLogIndex(alchemyEvents); alchemyEvents = _alchemyEventsIdx.events; _synthLogIndexAssigned += _alchemyEventsIdx.syntheticCount
  let events: PnlEvent[]
  if (grEvents.length > 0 && alchemyEvents.length > 0) {
    const _mergedByKey = new Map<string, PnlEvent>()
    for (const e of [...grEvents, ...alchemyEvents]) {
      const k = pnlEventDedupeKey(e)
      const existing = _mergedByKey.get(k)
      if (!existing || _pnlEventRichness(e) > _pnlEventRichness(existing)) _mergedByKey.set(k, e)
    }
    events = [..._mergedByKey.values()]
  } else {
    events = grEvents.length > 0 ? grEvents : alchemyEvents
  }
  // PHASE4-FIX-3 (item 1): deterministic (timestamp, chainId, logIndex, providerIndex) merge
  // order, replacing dependence on whichever provider's array happened to come first above.
  events = deterministicEventOrder(events)

  // Moralis activity fallback: runs only when deepActivity requested and all primary providers returned nothing.
  // One request max, cached 5 min, in-flight deduped inside fetchMoralisTransfers, 8 s timeout, no pagination.
  const _grBaseFetchFailed = !GOLDRUSH_KEY
    || Boolean((grBase.diag as GoldrushHistoryDiag).fetchFailed)
    || ((grBase.diag as GoldrushHistoryDiag).httpStatus != null && ((grBase.diag as GoldrushHistoryDiag).httpStatus as number) >= 400)
    || (grBase.diag as GoldrushHistoryDiag).failureStage === 'timeout'
  // Outer vars for Moralis fallback chain/cursor — needed by both page-1 block and multi-page loop
  // Prefer dominant chain by portfolio value for deep activity scans (ETH-heavy wallets get ETH activity).
  // Use same strip logic as walletFacts so 'eth-mainnet', 'ethereum', etc. all resolve to correct chain.
  let _fbEthValue = 0, _fbBaseValue = 0
  for (const h of holdings) {
    const _hc = (h.chain ?? '').toLowerCase().replace(/-mainnet$/, '')
    if (_hc === 'eth' || _hc.includes('ethereum')) _fbEthValue += h.value ?? 0
    else if (_hc === 'base' || _hc.includes('base')) _fbBaseValue += h.value ?? 0
  }
  // Deep activity scans: pick the highest-portfolio-value supported chain for Moralis transfers.
  // Normal scans: keep eth/base-only behavior. Explicit requestedChain always wins.
  const _fbChain: MoralisChain = requestedChain === 'eth' ? 'eth'
    : requestedChain === 'base' ? 'base'
    : deepActivity
      ? (() => {
          const topSupported = discoveredChains.find(c => supportedMoralisChains.includes(c.chain) && c.usdValue >= minChainValueUsd)
          return topSupported?.chain ?? (_fbEthValue > _fbBaseValue ? 'eth' : 'base')
        })()
      : (_fbEthValue > _fbBaseValue ? 'eth' : 'base')
  const _fbChainName: string = _fbChain === 'base' ? 'base-mainnet'
    : _fbChain === 'eth' ? 'eth-mainnet'
    : _fbChain
  let _fbNextCursor: string | null = null
  type _MoralisFbDebug = {
    primaryActivityAttempted: boolean; primaryActivityFailed: boolean; primaryActivityStatusCode: number | null
    primaryActivityErrorKind: string | null; fallbackActivityAttempted: boolean; fallbackActivityUsed: boolean
    fallbackActivityProvider: 'moralis' | null; fallbackActivityStatusCode: number | null
    fallbackActivityRawCount: number; fallbackActivityNormalizedEvents: number
    fallbackActivityReason: string; finalEvidenceStatus: string
    fallbackNormalizationDebug: NormalizeMoralisDebug | null
    fallbackActivitySampleShape: { keys: string[]; sample: Record<string, unknown>[] } | null
    fallbackPagesAttempted: number; fallbackPagesUsed: number; fallbackCursorsSeen: number
    fallbackRawTotal: number; fallbackNormalizedTotal: number; fallbackDedupeRemoved: number
    fallbackPaginationReason: string; fallbackPaginationStoppedReason: string
    fallbackClosedLotsAfterPage1: number; fallbackClosedCostBasisAfterPage1: number | null
    fallbackRealizedPnlAfterPage1: number | null
    fallbackMeaningfulEvidenceReached: boolean; fallbackMeaningfulEvidenceReason: string
  }
  const _grDiag = grBase.diag as GoldrushHistoryDiag
  let _moralisFbDebug: _MoralisFbDebug = {
    primaryActivityAttempted: activityRequested && Boolean(GOLDRUSH_KEY),
    primaryActivityFailed: _grBaseFetchFailed,
    primaryActivityStatusCode: _grDiag.httpStatus ?? null,
    primaryActivityErrorKind: !GOLDRUSH_KEY ? 'not_configured'
      : _grDiag.fetchFailed ? (_grDiag.fetchErrorKind ?? 'fetch_failed')
      : _grDiag.httpStatus != null && _grDiag.httpStatus >= 400 ? `http_${_grDiag.httpStatus}`
      : null,
    fallbackActivityAttempted: false,
    fallbackActivityUsed: false,
    fallbackActivityProvider: null,
    fallbackActivityStatusCode: null,
    fallbackActivityRawCount: 0,
    fallbackActivityNormalizedEvents: 0,
    fallbackActivityReason: events.length > 0 ? 'primary_ok' : !activityRequested ? 'not_requested' : 'not_attempted',
    finalEvidenceStatus: 'pending',
    fallbackNormalizationDebug: null,
    fallbackActivitySampleShape: null,
    fallbackPagesAttempted: 0, fallbackPagesUsed: 0, fallbackCursorsSeen: 0,
    fallbackRawTotal: 0, fallbackNormalizedTotal: 0, fallbackDedupeRemoved: 0,
    fallbackPaginationReason: 'not_attempted', fallbackPaginationStoppedReason: 'not_attempted',
    fallbackClosedLotsAfterPage1: 0, fallbackClosedCostBasisAfterPage1: null, fallbackRealizedPnlAfterPage1: null,
    fallbackMeaningfulEvidenceReached: false, fallbackMeaningfulEvidenceReason: 'not_attempted',
  }
  tokenMeter.startTokenMeter('fallbackEngine')
  tokenMeter.measure('fallbackEngine', { activityRequested, historicalCoverage, initialEventCount: events.length, fallbackChain: _fbChain, primaryActivityFailed })
  const _shouldTryMoralisFallback = activityRequested && !historicalCoverage && events.length === 0 && Boolean(process.env.MORALIS_API_KEY)
  if (_shouldTryMoralisFallback) {
    const fbResult = await fetchMoralisTransfers(addr, _fbChain, 100)
    _trackCall('moralis', 'erc20_transfers', fbResult.cacheHit, `moralis:transfers:p1:${_fbChain}:${addrNorm}`)
    _fbNextCursor = fbResult.nextCursor
    const { events: fbEvents, debug: fbNormDebug } = (fbResult.usable && fbResult.items.length > 0)
      ? normalizeMoralisTransfers(fbResult.items, addr, _fbChainName)
      : { events: [] as PnlEvent[], debug: { rawCount: 0, normalizedCount: 0, skippedNotWalletSide: 0, skippedMissingHash: 0, skippedMissingTimestamp: 0, skippedMissingTokenAddress: 0, skippedMissingAmount: 0, skippedInvalidAmount: 0, skippedSpam: 0, sampleNormalizedEvents: [], sampleSkippedReasons: [] } as NormalizeMoralisDebug }
    tokenMeter.measure('fallbackEngine', fbResult, fbEvents, fbNormDebug)
    const fbUsed = fbEvents.length > 0
    if (fbUsed) events = fbEvents
    // Build sanitized sample shape from raw API rows (keys + safe excerpts, no huge payloads)
    const fbSampleShape: _MoralisFbDebug['fallbackActivitySampleShape'] = fbResult.rawSample.length > 0
      ? (() => {
          const first = fbResult.rawSample[0] as Record<string, unknown>
          return {
            keys: Object.keys(first).slice(0, 25),
            sample: fbResult.rawSample.map(r => {
              const row = r as Record<string, unknown>
              const shorten = (v: unknown) => typeof v === 'string' ? (v.length > 20 ? v.slice(0, 12) + '…' : v) : v
              return {
                transaction_hash: shorten(row.transaction_hash) ?? null,
                block_timestamp: row.block_timestamp ?? null,
                address: shorten(row.address) ?? null,
                token_address: shorten(row.token_address) ?? null,
                from_address: shorten(row.from_address) ?? null,
                to_address: shorten(row.to_address) ?? null,
                value: typeof row.value === 'string' ? row.value.slice(0, 30) : null,
                value_decimal: row.value_decimal ?? null,
                possible_spam: row.possible_spam ?? null,
                verified_contract: row.verified_contract ?? null,
                symbol: row.symbol ?? row.token_symbol ?? null,
                name: row.name ?? row.token_name ?? null,
                decimals: row.decimals ?? row.token_decimals ?? null,
              } as Record<string, unknown>
            }),
          }
        })()
      : null
    const fbFailReason = fbNormDebug.skippedMissingTokenAddress > 0 ? 'normalization_failed_missing_token_address'
      : fbNormDebug.skippedInvalidAmount > 0 ? 'normalization_failed_invalid_amount'
      : fbNormDebug.skippedNotWalletSide > 0 && fbNormDebug.normalizedCount === 0 ? 'normalization_failed_not_wallet_side'
      : fbResult.reason || 'no_events_normalized'
    _moralisFbDebug = {
      ..._moralisFbDebug,
      fallbackActivityAttempted: fbResult.attempted || fbResult.cacheHit,
      fallbackActivityUsed: fbUsed,
      fallbackActivityProvider: 'moralis',
      fallbackActivityStatusCode: fbResult.httpStatus ?? null,
      fallbackActivityRawCount: fbResult.rawCount,
      fallbackActivityNormalizedEvents: fbEvents.length,
      fallbackActivityReason: fbUsed ? 'fallback_used' : fbFailReason,
      fallbackNormalizationDebug: fbNormDebug,
      fallbackActivitySampleShape: fbSampleShape,
      fallbackPagesAttempted: 1, fallbackPagesUsed: fbUsed ? 1 : 0,
      fallbackCursorsSeen: _fbNextCursor != null ? 1 : 0,
      fallbackRawTotal: fbResult.rawCount,
      fallbackNormalizedTotal: fbEvents.length,
      fallbackDedupeRemoved: 0,
      fallbackPaginationReason: 'page1_complete',
      fallbackPaginationStoppedReason: 'pending',
    }
  }

  // Phase 1.8: Cross-chain activity supplement — if Moralis fallback used one chain but the other
  // has significant holdings (> $1), fetch Moralis for the other chain and merge both.
  // Prevents ETH-heavy wallets from showing Base-only airdrop/claim activity when their real
  // trading history is on ETH, and vice versa for Base-heavy wallets with ETH exposure.
  type _Phase18Debug = {
    attempted: boolean; skippedReason: string | null
    supplementChain: string; supplementChainValue: number; primaryFbChain: string
    moralisSupplementRawCount: number; moralisSupplementNormalizedEvents: number
    mergeBaseEvents: number; mergeEthEvents: number; mergeTotal: number; mergeDeduped: number
    supplementCacheHit: boolean
  }
  const _p18SupplementChain: 'eth' | 'base' = _fbChain === 'eth' ? 'base'
    : _fbChain === 'base' ? 'eth'
    : (_fbEthValue >= _fbBaseValue ? 'eth' : 'base')
  const _p18SupplementChainName = _p18SupplementChain === 'eth' ? 'eth-mainnet' : 'base-mainnet'
  const _p18SupplementValue = chainValueMap.get(_p18SupplementChain as MoralisChain) ?? 0
  const _p18GrAlreadyCovered = _p18SupplementChain === 'eth' ? grEth.events.length > 0 : grBase.events.length > 0
  const _p18ShouldRun = (
    deepActivity && !historicalCoverage &&
    _moralisFbDebug.fallbackActivityUsed &&
    _p18SupplementValue > 1 &&
    !_p18GrAlreadyCovered &&
    Boolean(process.env.MORALIS_API_KEY)
  )
  let _phase18Debug: _Phase18Debug = {
    attempted: false, skippedReason: null,
    supplementChain: _p18SupplementChain, supplementChainValue: _p18SupplementValue,
    primaryFbChain: _fbChain,
    moralisSupplementRawCount: 0, moralisSupplementNormalizedEvents: 0,
    mergeBaseEvents: 0, mergeEthEvents: 0, mergeTotal: 0, mergeDeduped: 0,
    supplementCacheHit: false,
  }
  if (_p18ShouldRun) {
    _phase18Debug.attempted = true
    const p18Result = await fetchMoralisTransfers(addr, _p18SupplementChain, 100)
    _trackCall('moralis', 'erc20_transfers', p18Result.cacheHit, `moralis:transfers:p1:${_p18SupplementChain}:supplement:${addrNorm}`)
    _phase18Debug.supplementCacheHit = p18Result.cacheHit
    _phase18Debug.moralisSupplementRawCount = p18Result.rawCount
    const { events: p18Events } = (p18Result.usable && p18Result.items.length > 0)
      ? normalizeMoralisTransfers(p18Result.items, addr, _p18SupplementChainName)
      : { events: [] as PnlEvent[] }
    _phase18Debug.moralisSupplementNormalizedEvents = p18Events.length
    if (p18Events.length > 0) {
      const _p18BaseEvents = _fbChain === 'base' ? events : p18Events
      const _p18EthEvents = _fbChain === 'eth' ? events : p18Events
      _phase18Debug.mergeBaseEvents = _p18BaseEvents.length
      _phase18Debug.mergeEthEvents = _p18EthEvents.length
      const _p18All = [...events, ...p18Events]
      _phase18Debug.mergeTotal = _p18All.length
      const _p18SeenKeys = new Set<string>()
      const _p18Merged: PnlEvent[] = []
      for (const e of _p18All) {
        const mk = `${e.chain ?? ''}|${e.txHash ?? ''}|${e.contract}|${e.direction}|${e.amountRaw ?? String(e.amount)}`
        if (!_p18SeenKeys.has(mk)) { _p18SeenKeys.add(mk); _p18Merged.push(e) }
      }
      _p18Merged.sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0
        return tb - ta
      })
      _phase18Debug.mergeDeduped = _p18All.length - _p18Merged.length
      events = _p18Merged
    } else {
      _phase18Debug.skippedReason = 'supplement_returned_empty'
    }
  } else {
    _phase18Debug.skippedReason = !deepActivity ? 'basic_scan'
      : historicalCoverage ? 'historical_coverage_enabled'
      : !_moralisFbDebug.fallbackActivityUsed ? 'primary_activity_ok_no_supplement_needed'
      : _p18GrAlreadyCovered ? 'supplement_chain_already_covered_by_goldrush'
      : _p18SupplementValue <= 1 ? 'eth_activity_skipped_no_eth_holdings'
      : !Boolean(process.env.MORALIS_API_KEY) ? 'eth_activity_provider_unavailable'
      : 'not_triggered'
  }

  // Phase 19: deep-scan multi-chain supplement — scans high-value non-ETH/BASE chains via Moralis
  // independently of whether GoldRush found ETH/BASE events (unlike the Moralis fallback which only
  // runs when events.length === 0). Page-1 only (100 transfers max) for cost safety.
  type _Phase19ChainResult = { chain: string; rawCount: number; normalizedEvents: number; cacheHit: boolean; skippedReason: string | null }
  type _Phase19Debug = { attempted: boolean; skippedReason: string | null; chainsConsidered: Array<{ chain: string; usdValue: number }>; chainResults: _Phase19ChainResult[]; totalNewEvents: number; mergeTotal: number; mergeDeduped: number }
  const _p19MaxAdditionalChains = 2
  const _p19EligibleChains = discoveredChains.filter(c =>
    supportedMoralisChains.includes(c.chain) &&
    c.chain !== 'eth' && c.chain !== 'base' &&
    c.usdValue >= minChainValueUsd
  ).slice(0, _p19MaxAdditionalChains)
  const _p19ShouldRun = deepActivity && !historicalCoverage && _p19EligibleChains.length > 0 && Boolean(process.env.MORALIS_API_KEY)
  let _phase19Debug: _Phase19Debug = {
    attempted: _p19ShouldRun,
    skippedReason: _p19ShouldRun ? null
      : !deepActivity ? 'basic_scan'
      : historicalCoverage ? 'historical_coverage_enabled'
      : _p19EligibleChains.length === 0 ? 'no_eligible_non_eth_base_chains'
      : 'moralis_unavailable',
    chainsConsidered: _p19EligibleChains.map(c => ({ chain: c.chain as string, usdValue: c.usdValue })),
    chainResults: [], totalNewEvents: 0, mergeTotal: 0, mergeDeduped: 0,
  }
  const _p19ScannedChains: MoralisChain[] = []
  if (_p19ShouldRun) {
    let p19NewEvents: PnlEvent[] = []
    const p19Results = await Promise.allSettled(_p19EligibleChains.map(async (eligible) => {
      const p19ChainName = eligible.chain  // 'bsc', 'polygon', etc.
      const p19Result = await fetchMoralisTransfers(addr, eligible.chain, 100)
      _trackCall('moralis', 'erc20_transfers', p19Result.cacheHit, `moralis:transfers:p1:${eligible.chain}:p19:${addrNorm}`)
      const { events: p19ChainEvents } = (p19Result.usable && p19Result.items.length > 0)
        ? normalizeMoralisTransfers(p19Result.items, addr, p19ChainName)
        : { events: [] as PnlEvent[] }
      return { eligible, p19Result, p19ChainEvents }
    }))
    for (const settled of p19Results) {
      if (settled.status === 'rejected') continue
      const { eligible, p19Result, p19ChainEvents } = settled.value
      _phase19Debug.chainResults.push({
        chain: eligible.chain as string,
        rawCount: p19Result.rawCount,
        normalizedEvents: p19ChainEvents.length,
        cacheHit: p19Result.cacheHit,
        skippedReason: p19ChainEvents.length === 0 ? (p19Result.usable ? 'no_transfers_returned' : 'provider_error') : null,
      })
      if (p19ChainEvents.length > 0) {
        p19NewEvents = [...p19NewEvents, ...p19ChainEvents]
        _p19ScannedChains.push(eligible.chain)
      }
    }
    if (p19NewEvents.length > 0) {
      _phase19Debug.totalNewEvents = p19NewEvents.length
      const _p19All = [...events, ...p19NewEvents]
      _phase19Debug.mergeTotal = _p19All.length
      const _p19SeenKeys = new Set<string>()
      const _p19Merged: PnlEvent[] = []
      for (const e of _p19All) {
        // PHASE4-FIX-4: shared dedupe key
        const mk = pnlEventDedupeKey(e)
        if (!_p19SeenKeys.has(mk)) { _p19SeenKeys.add(mk); _p19Merged.push(e) }
      }
      // PHASE4-FIX-3 (item 1): deterministic (timestamp, chainId, logIndex, providerIndex) order.
      _phase19Debug.mergeDeduped = _p19All.length - _p19Merged.length
      events = deterministicEventOrder(_p19Merged)
    }
  }

  const _pnlSourceRaw: 'goldrush' | 'alchemy' | 'moralis_fallback' | 'none' =
    grEvents.length > 0 ? 'goldrush'
    : alchemyEvents.length > 0 ? 'alchemy'
    : _moralisFbDebug.fallbackActivityUsed ? 'moralis_fallback'
    : 'none'
  const pnlSource: 'activity_layer' | 'fallback_layer' | 'none' =
    _pnlSourceRaw === 'goldrush' ? 'activity_layer'
    : _pnlSourceRaw === 'none' ? 'none'
    : 'fallback_layer'
  const fallbackActivityAttempted = _moralisFbDebug.fallbackActivityAttempted
  const fallbackActivityUsed = _moralisFbDebug.fallbackActivityUsed
  const fallbackActivityReason = _moralisFbDebug.fallbackActivityReason
  const activityProviderUnavailable = activityRequested && primaryActivityFailed && events.length === 0
  tokenMeter.startTokenMeter('normalization')
  tokenMeter.measure('normalization', events, holdings)
  // Budget guard: dedup + cap events before pipeline to limit credit burn on large wallets
  const _ACTIVITY_MAX_EVENTS = 500
  const _budgetEventsBefore = events.length
  const _seenBudgetKeys = new Set<string>()
  const _dedupedBudgetEvents: PnlEvent[] = []
  for (const e of events) {
    // PHASE4-FIX-4: shared dedupe key
    const k = pnlEventDedupeKey(e)
    if (!_seenBudgetKeys.has(k)) { _seenBudgetKeys.add(k); _dedupedBudgetEvents.push(e) }
  }
  const _budgetEventsAfterDedup = _dedupedBudgetEvents.length
  const _budgetCapped = _dedupedBudgetEvents.length > _ACTIVITY_MAX_EVENTS
  // PHASE4-FIX-1: replace the destructive "keep newest 500, drop the rest" cap with a soft cap
  // that always protects every event for a token currently held (so the earliest buy needed for
  // that token's cost basis is never dropped). Only events for tokens with no current holding —
  // i.e. tokens that can no longer affect open/closed lot math — are trimmed to fit the budget.
  const _heldTokenContracts = new Set(holdings.map(h => (h.contract ?? '').toLowerCase()).filter(Boolean))
  const _protectedBudgetEvents = _dedupedBudgetEvents.filter(e => _heldTokenContracts.has(e.contract.toLowerCase()))
  const _trimmableBudgetEvents = _dedupedBudgetEvents.filter(e => !_heldTokenContracts.has(e.contract.toLowerCase()))
  const _remainingBudgetSlots = Math.max(0, _ACTIVITY_MAX_EVENTS - _protectedBudgetEvents.length)
  // PHASE4-FIX-8 (item 3): capping transparency — which events were actually dropped, and which
  // provider(s) they originated from, so a capped scan is visibly partial rather than silently
  // shorter. cappedCount/cappedProviders are surfaced via walletBudgetDebug below.
  const _droppedBudgetEvents = _trimmableBudgetEvents.slice(_remainingBudgetSlots)
  const _cappedCount = _droppedBudgetEvents.length
  const _grKeySet = new Set(grEvents.map(pnlEventDedupeKey))
  const _alchemyKeySet = new Set(alchemyEvents.map(pnlEventDedupeKey))
  const _cappedProviders = Array.from(new Set(_droppedBudgetEvents.map(e => {
    const k = pnlEventDedupeKey(e)
    if (_grKeySet.has(k)) return 'goldrush'
    if (_alchemyKeySet.has(k)) return 'alchemy'
    return 'other'
  })))
  events = [..._protectedBudgetEvents, ..._trimmableBudgetEvents.slice(0, _remainingBudgetSlots)]
  // PHASE4-FIX-3 (item 1): deterministic (timestamp, chainId, logIndex, providerIndex) order for
  // the final post-cap merged set, replacing the timestamp-only sort.
  events = deterministicEventOrder(events)
  const _budgetEventsAfterCap = events.length

  // Build a current-price map from holdings so events without usdValue can be enriched.
  // Using current price as a proxy is imprecise for historical trades but is consistent
  // with the average_cost_estimate method and prevents valid wallets from returning "unavailable".
  const priceByContract = new Map<string, number>()
  for (const h of holdings) {
    if (h.contract && h.price && h.price > 0) {
      priceByContract.set(h.contract.toLowerCase(), h.price)
    }
  }
  events = events.map(e => {
    if ((e.usdValue ?? 0) > 0) return e
    const cp = priceByContract.get(e.contract.toLowerCase())
    if (cp && cp > 0 && e.amount > 0) return { ...e, usdValue: e.amount * cp }
    return e
  })

  const byToken = new Map<string, PnlEvent[]>()
  for (const e of events.slice(0, 250)) byToken.set(e.contract, [...(byToken.get(e.contract) ?? []), e])
  const pnlTokens: WalletSnapshot['estimatedPnl']['tokens'] = []
  // PHASE5-FIX-5: value-weighted coverage accumulators alongside the existing unweighted ones.
  let realized = 0, unrealized = 0, coverageNum = 0, coverageWeightedNum = 0, coverageWeightTotal = 0
  for (const h of holdings.slice(0, 25)) {
    const tokenEvents = byToken.get((h.contract ?? '').toLowerCase()) ?? []
    const buys = tokenEvents.filter(e => e.direction === 'buy')
    const sells = tokenEvents.filter(e => e.direction === 'sell')
    const unexplained = tokenEvents.filter(e => e.direction === 'unknown').length
    const pricedBuys = buys.filter(b => (b.usdValue ?? 0) > 0)
    const buyQty = buys.reduce((s, e) => s + e.amount, 0)
    const sellQty = sells.reduce((s, e) => s + e.amount, 0)
    const buyCost = pricedBuys.reduce((s, e) => s + (e.usdValue ?? 0), 0)
    const avgCost = buyQty > 0 && buyCost > 0 ? buyCost / buyQty : null
    const estimatedCostBasisUsd = avgCost && h.balance > 0 ? avgCost * h.balance : null
    const estimatedUnrealized = estimatedCostBasisUsd !== null ? h.value - estimatedCostBasisUsd : null
    const realizedProceeds = sells.reduce((s, e) => s + (e.usdValue ?? 0), 0)
    const realizedCost = avgCost ? avgCost * Math.min(sellQty, buyQty) : 0
    const estimatedRealized = realizedProceeds > 0 && avgCost ? realizedProceeds - realizedCost : null
    const withUsd = tokenEvents.filter(e => (e.usdValue ?? 0) > 0).length
    const coverage = tokenEvents.length > 0 ? Math.max(0, Math.min(100, Math.round((withUsd / tokenEvents.length) * 100 - unexplained * 5))) : 0
    const conf = confidenceFromCoverage(coverage)
    const COV_THRESHOLD = 40
    if (estimatedUnrealized !== null && coverage >= COV_THRESHOLD) unrealized += estimatedUnrealized
    if (estimatedRealized !== null && coverage >= COV_THRESHOLD) realized += estimatedRealized
    coverageNum += coverage
    // PHASE5-FIX-5: weight this token's coverage contribution by its USD value.
    const _coverageWeight = Math.abs(h.value)
    coverageWeightedNum += coverage * _coverageWeight
    coverageWeightTotal += _coverageWeight
    pnlTokens.push({ symbol: h.symbol, contract: (h.contract ?? '').toLowerCase(), currentValueUsd: h.value, estimatedCostBasisUsd, estimatedUnrealizedPnlUsd: coverage >= COV_THRESHOLD ? estimatedUnrealized : null, estimatedRealizedPnlUsd: coverage >= COV_THRESHOLD ? estimatedRealized : null, buysDetected: buys.length, sellsDetected: sells.length, unexplainedTransfers: unexplained, coveragePercent: coverage, confidence: conf, reason: coverage < COV_THRESHOLD ? 'PnL partial/unavailable: historical cost basis coverage too low.' : 'Estimated from average-cost using indexed transfers.' })
  }
  const coveragePercent = pnlTokens.length ? Math.round(coverageNum / pnlTokens.length) : 0
  // PHASE5-FIX-5: coverageScore = sum(weight * coverage) / sum(weight), weight = abs(valueUsd).
  const coveragePercentValueWeighted = coverageWeightTotal > 0 ? Math.round(coverageWeightedNum / coverageWeightTotal) : coveragePercent
  // PHASE4-FIX-9 (item 6): flag when value-weighted coverage (computed from each token's
  // priced-event usdValue above, via coverageWeightedNum/coverageWeightTotal) is low even if
  // simple per-token-count coverage looks fine — i.e. the tokens that DO have full history are
  // small, and the wallet's real USD exposure is concentrated in poorly-covered tokens.
  const _COVERAGE_VALUE_WEIGHTED_LOW_THRESHOLD = 40
  const _coverageValueWeightedLow = coverageWeightTotal > 0 && coveragePercentValueWeighted < _COVERAGE_VALUE_WEIGHTED_LOW_THRESHOLD
  const status: WalletSnapshot['estimatedPnl']['status'] = pnlTokens.length === 0 || pnlSource === 'none' ? 'unavailable' : coveragePercent >= 40 ? 'ok' : 'partial'
  const filteredPnlTokens = pnlTokens.filter((t) => t.coveragePercent > 0).sort((a, b) => (b.currentValueUsd - a.currentValueUsd)).slice(0, 10)
  const pnlCoverageReason = status === 'unavailable'
    ? (activityProviderUnavailable ? 'Activity source did not return usable history. No PnL was calculated.' : pnlSource === 'none' ? 'Enable Deep Activity Scan for full transfer history and cost-basis estimation.' : 'Historical cost basis coverage is too low for a reliable estimate.')
    : 'Estimated from indexed transfer history with average-cost method.'
  const pnlSourcePublic: 'activity_layer' | 'fallback_layer' | 'unavailable' = pnlSource === 'none' ? 'unavailable' : pnlSource
  const estimatedPnl: WalletSnapshot['estimatedPnl'] = { status, confidence: status === 'unavailable' ? null : confidenceFromCoverage(coveragePercent), coveragePercent, coveragePercentValueWeighted, source: pnlSourcePublic === 'unavailable' ? 'none' : pnlSourcePublic, totalEstimatedPnlUsd: status === 'unavailable' ? null : realized + unrealized, unrealizedPnlUsd: status === 'unavailable' ? null : unrealized, realizedPnlUsd: status === 'unavailable' ? null : realized, method: 'average_cost_estimate', tokens: filteredPnlTokens, reason: status === 'unavailable' ? (activityProviderUnavailable ? 'Activity source did not return usable history. No PnL was calculated.' : 'PnL unavailable — historical cost basis coverage is too low.') : 'Estimated PnL Beta derived from indexed wallet transfer history.' }
  // PHASE4-FIX-10 (item 7): `events` here is already the final deterministically-merged,
  // deduped, sorted, and budget-capped set (every union-merge/cap/sort above reassigns the same
  // `events` variable in place) — buildTxEvidenceFromEvents/buildSwapDetection below always run
  // on that final list, never on a raw per-provider array. Later re-invocations of
  // buildSwapDetection further down this function (after ETH/Base synthetic-swap reconstruction
  // passes) re-run grouping on an updated evidenceList because those passes add new synthetic
  // legs to it — that's required re-grouping after new data, not a violation of "merge before
  // group," so it's left as-is.
  let { evidenceList, summary: walletEvidenceSummary, debug: _txEvidenceDebugBase } = buildTxEvidenceFromEvents(events, activityRequested, activityProviderUnavailable)
  tokenMeter.measure('normalization', { events, evidenceList, walletEvidenceSummary, txEvidenceDebug: _txEvidenceDebugBase, estimatedPnl })
  tokenMeter.endTokenMeter('normalization')

  tokenMeter.startTokenMeter('swapDetection')
  const _swapDetectionStartedAt = Date.now()
  tokenMeter.measure('swapDetection', evidenceList)
  let { evidenceWithDetection: _swapEvidenceWithDetection, summary: walletSwapSummary, debug: _swapDetectionDebug } = buildSwapDetection(evidenceList, activityRequested, addrNorm)
  // Receipt enrichment: runs only when swap detection found nothing and events exist
  const _shouldEnrich = activityRequested && walletSwapSummary.swapCandidateEvents === 0 && walletEvidenceSummary.totalEvents > 0
  const _enrichAlchemyUrl = useEthAlchemy ? ethUrl : baseUrl
  let _swapEnrichmentDebug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletSwapEnrichmentDebug']>
  if (_shouldEnrich) {
    const enrichResult = await enrichSwapCandidatesFromReceipts(_swapEvidenceWithDetection, addrNorm, _enrichAlchemyUrl, activityRequested)
    _swapEvidenceWithDetection = enrichResult.enrichedEvidence
    _swapEnrichmentDebug = enrichResult.debug
    tokenMeter.measure('swapDetection', enrichResult)
    // Track each live receipt fetch (excluding cache hits) via Alchemy dedup set
    const _liveReceipts = enrichResult.debug.receiptsFetched - enrichResult.debug.cacheHits
    for (let _ri = 0; _ri < _liveReceipts; _ri++) {
      const _rk = `alchemy:receipt:${enrichResult.debug.enrichedTxHashes[_ri] ?? _ri}:${addrNorm}`
      if (!_alchemyDedup.has(_rk)) { _alchemyDedup.add(_rk); _trackCall('alchemy', 'eth_getTransactionReceipt', false, _rk) }
      else _trackCall('alchemy', 'eth_getTransactionReceipt', false, _rk) // dedup records it
    }
    if (enrichResult.debug.enrichedTxCount > 0) {
      walletSwapSummary = { ...walletSwapSummary, swapCandidateEvents: walletSwapSummary.swapCandidateEvents + enrichResult.debug.enrichedTxCount, readyForPriceAtTime: true }
    }
  } else {
    const _skipReason = !activityRequested ? 'activity_not_requested' : walletSwapSummary.swapCandidateEvents > 0 ? 'swap_candidates_already_present' : 'no_events'
    _swapEnrichmentDebug = { skipped: true, reason: _skipReason, candidateTxCount: 0, receiptsFetched: 0, enrichedTxCount: 0, cacheHits: 0, errors: 0, enrichedTxHashes: [] }
  }
  tokenMeter.measure('swapDetection', _swapEvidenceWithDetection, walletSwapSummary, _swapDetectionDebug, _swapEnrichmentDebug)
  tokenMeter.endTokenMeter('swapDetection')
  _perfWalletTimings.swapDetectionMs += Date.now() - _swapDetectionStartedAt

  // ── Base PnL Reconstruction Pass ────────────────────────────────────────────────────────
  // Runs when: Base chain scan, activity requested, events exist, still 0 swap candidates.
  // Fetches up to 8 receipts from existing activity sample to detect native ETH buy patterns
  // (tx.from = wallet + received token + no ERC20 outbound) and stablecoin/router swaps.
  // Does NOT run on cached repeat scans (basePnlReceiptCache TTL handles that).
  // Does NOT fetch full history — only inspects txHashes already in evidence.
  // closedLotsBefore is 0 here because FIFO has not yet run at this point.
  const _closedLotsBeforeRecon = 0
  const _realizedPnlBeforeRecon: number | null = null
  let _basePnlReconDebug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['basePnlReconstructionDebug']> = {
    attempted: false, reason: 'not_attempted',
    candidateTxCount: 0, receiptsFetched: 0, receiptCacheHits: 0, decodedTransferLogs: 0,
    walletInboundLegs: 0, walletOutboundLegs: 0, nativeEthPaymentMatches: 0,
    stablecoinMatches: 0, wethMatches: 0, routerMatches: 0,
    enrichedSwapEvents: 0, pricedEnrichedEvents: 0,
    closedLotsBefore: _closedLotsBeforeRecon, closedLotsAfter: _closedLotsBeforeRecon,
    realizedPnlBefore: _realizedPnlBeforeRecon, realizedPnlAfter: _realizedPnlBeforeRecon,
    skippedNoPaymentLeg: 0, skippedNoInboundToken: 0, skippedNoPriceEvidence: 0, skippedBudgetCap: 0,
    providerErrors: 0, sampleMatches: [],
  }
  // Run Base recon when: (a) not using ETH Alchemy, OR (b) chainMode includes Base (base_eth/all_supported)
  // so that Base-leg events from multi-chain scans also get receipt-level swap detection.
  const _baseReconChainOk = !useEthAlchemy || chainMode === 'base_eth' || chainMode === 'all_supported'
  const _shouldRunBaseRecon = (
    activityRequested &&
    _baseReconChainOk &&
    walletSwapSummary.swapCandidateEvents === 0 &&
    walletEvidenceSummary.totalEvents > 0 &&
    Boolean(baseRpcUrl)
  )
  if (_shouldRunBaseRecon) {
    const reconResult = await buildBasePnlReconstructionPass(
      _swapEvidenceWithDetection,
      addrNorm,
      baseRpcUrl,
      _closedLotsBeforeRecon,
      _realizedPnlBeforeRecon,
    )
    _basePnlReconDebug = reconResult.debug
    tokenMeter.measure('swapDetection', reconResult)
    if (reconResult.debug.enrichedSwapEvents > 0) {
      _swapEvidenceWithDetection = reconResult.mergedEvidence
      const reconSwapCount = reconResult.mergedEvidence.filter(e => e.swapDetection?.isSwapCandidate).length
      walletSwapSummary = { ...walletSwapSummary, swapCandidateEvents: reconSwapCount, readyForPriceAtTime: reconSwapCount > 0 }
      // Track receipt calls in API audit
      const liveReceipts = reconResult.debug.receiptsFetched
      for (let _ri = 0; _ri < liveReceipts; _ri++) {
        const _rk = `alchemy:baserecon:receipt:${_ri}:${addrNorm}`
        if (!_alchemyDedup.has(_rk)) { _alchemyDedup.add(_rk); _trackCall('alchemy', 'eth_getTransactionReceipt', false, _rk) }
      }
    }
  } else if (!activityRequested) {
    _basePnlReconDebug = { ..._basePnlReconDebug, reason: 'activity_not_requested' }
  } else if (useEthAlchemy && !_baseReconChainOk) {
    _basePnlReconDebug = { ..._basePnlReconDebug, reason: 'eth_chain_skipped' }
  } else if (walletSwapSummary.swapCandidateEvents > 0) {
    _basePnlReconDebug = { ..._basePnlReconDebug, reason: 'swap_candidates_present' }
  } else if (walletEvidenceSummary.totalEvents === 0) {
    _basePnlReconDebug = { ..._basePnlReconDebug, reason: 'no_activity_events' }
  } else if (!baseRpcUrl) {
    _basePnlReconDebug = { ..._basePnlReconDebug, reason: 'no_rpc_available' }
  }
  // ── End Base PnL Reconstruction Pass ────────────────────────────────────────────────────

  // ── Base Unknown-Direction Swap Reconstruction Pass ──────────────────────────────────────
  // Runs when existing base recon found 0 swap candidates AND unknown-direction events exist.
  // The primary base recon skips unknown-direction events; this pass explicitly targets them.
  const _baseUnknownProblemTxEvents = evidenceList.filter(e => (e.txHash ?? '').toLowerCase() === BASE_UNKNOWN_RECON_PROBLEM_TX)
  let _baseUnknownSwapReconDebug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['baseUnknownSwapReconstructionDebug']> = {
    attempted: false, reason: 'not_attempted', triggerMatched: false,
    evidenceEventsInputCount: evidenceList.length,
    candidateTxsChecked: 0, candidateTxHashes: [], includesProblemTx: false,
    problemTxSeenInEvidence: _baseUnknownProblemTxEvents.length > 0,
    problemTxEventCount: _baseUnknownProblemTxEvents.length,
    problemTxSymbols: [...new Set(_baseUnknownProblemTxEvents.map(e => e.symbol).filter(Boolean))],
    problemTxDirections: [...new Set(_baseUnknownProblemTxEvents.map(e => e.direction).filter(Boolean))],
    problemTxChains: [...new Set(_baseUnknownProblemTxEvents.map(e => e.chain).filter(Boolean))],
    mixedKnownUnknownTxs: 0,
    receiptsFetched: 0, decodedTransferLogs: 0, walletSideLegsFound: 0, quoteLegsFound: 0, tokenLegsFound: 0,
    wethLegsFound: 0, stableLegsFound: 0, syntheticSwapEventsAdded: 0,
    sampleTxs: [], sampleSyntheticEvents: [], skippedReasons: [],
  }
  const _hasUnknownDirEvents = _swapEvidenceWithDetection.some(e => e.direction === 'unknown')
  const _shouldRunUnknownDirRecon = (
    activityRequested &&
    _baseReconChainOk &&
    walletSwapSummary.swapCandidateEvents === 0 &&
    _hasUnknownDirEvents &&
    Boolean(baseRpcUrl)
  )
  if (_shouldRunUnknownDirRecon) {
    const unknownReconResult = await buildBaseUnknownDirectionSwapReconstructionPass(
      _swapEvidenceWithDetection,
      addrNorm,
      baseRpcUrl,
      evidenceList,
    )
    _baseUnknownSwapReconDebug = unknownReconResult.debug
    tokenMeter.measure('swapDetection', unknownReconResult)
    if (unknownReconResult.debug.syntheticSwapEventsAdded > 0) {
      evidenceList = unknownReconResult.enrichedEvidence
      _swapEvidenceWithDetection = unknownReconResult.enrichedEvidence
      const reconSwapCount = _swapEvidenceWithDetection.filter(e => e.swapDetection?.isSwapCandidate).length
      walletSwapSummary = { ...walletSwapSummary, swapCandidateEvents: reconSwapCount, readyForPriceAtTime: reconSwapCount > 0 }
      tokenMeter.measure('swapDetection', _swapEvidenceWithDetection, walletSwapSummary)
      for (let _ri = 0; _ri < unknownReconResult.debug.receiptsFetched; _ri++) {
        const _rk = `alchemy:unknownrecon:receipt:${_ri}:${addrNorm}`
        if (!_alchemyDedup.has(_rk)) { _alchemyDedup.add(_rk); _trackCall('alchemy', 'eth_getTransactionReceipt', false, _rk) }
      }
    }
  } else if (!activityRequested) {
    _baseUnknownSwapReconDebug = { ..._baseUnknownSwapReconDebug, reason: 'activity_not_requested' }
  } else if (!_baseReconChainOk) {
    _baseUnknownSwapReconDebug = { ..._baseUnknownSwapReconDebug, reason: 'eth_chain_skipped' }
  } else if (walletSwapSummary.swapCandidateEvents > 0) {
    _baseUnknownSwapReconDebug = { ..._baseUnknownSwapReconDebug, reason: 'swap_candidates_present' }
  } else if (!_hasUnknownDirEvents) {
    _baseUnknownSwapReconDebug = { ..._baseUnknownSwapReconDebug, reason: 'no_unknown_direction_events' }
  } else if (!baseRpcUrl) {
    _baseUnknownSwapReconDebug = { ..._baseUnknownSwapReconDebug, reason: 'no_rpc_available' }
  }
  // ── End Base Unknown-Direction Swap Reconstruction Pass ──────────────────────────────────

  let _ethSwapReconstructionDebug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['ethSwapReconstructionDebug']> = emptyEthSwapReconstructionDebug(
    'not_attempted',
    0,
    walletSwapSummary.swapCandidateEvents,
    _closedLotsBeforeRecon,
    false,
  )
  const _ethReconChainOk = requestedChain === 'eth' || chainMode === 'eth' || chainMode === 'base_eth' || chainMode === 'all_supported'
  const _ethActivityEvents = _swapEvidenceWithDetection.filter(e => normalizeChain(e.chain ?? '') === 'eth').length
  // Check for inbound non-quote token to wallet on ETH — candidate for ETH swap reconstruction
  const _ethInboundTokenEvents = _swapEvidenceWithDetection.filter(e =>
    normalizeChain(e.chain ?? '') === 'eth' &&
    e.direction === 'buy' &&
    e.toAddress?.toLowerCase() === addrNorm &&
    !ETH_QUOTE_ASSETS[(e.contract ?? '').toLowerCase()] &&
    e.amount > 0
  )
  const _ethInboundTxHashes = new Set(_ethInboundTokenEvents.map(e => e.txHash))
  // Trigger recon if any inbound-token tx has: (a) wallet-initiated, (b) known router, or (c) same-tx WETH/ETH unknown leg
  const _ethHasWalletInitiatedOrRouterInbound = _ethInboundTokenEvents.length > 0 && _swapEvidenceWithDetection.some(e =>
    normalizeChain(e.chain ?? '') === 'eth' &&
    _ethInboundTxHashes.has(e.txHash) &&
    (e.txFromAddress?.toLowerCase() === addrNorm ||
     Boolean(e.txToAddress && EXTENDED_DEX_ROUTERS.has(e.txToAddress.toLowerCase())) ||
     Boolean(ETH_QUOTE_ASSETS[(e.contract ?? '').toLowerCase()])
    )
  )
  const _shouldRunEthRouterRecon = (
    activityRequested && deepActivity && _ethReconChainOk && _ethActivityEvents > 0 &&
    walletSwapSummary.swapCandidateEvents === 0 &&
    _ethHasWalletInitiatedOrRouterInbound
  )
  if (_shouldRunEthRouterRecon) {
    const ethReconResult = await buildEthRouterSwapReconstructionPass(
      _swapEvidenceWithDetection,
      addrNorm,
      ALCHEMY_ETH_KEY ? ethUrl : '',
      activityRequested,
      0,
      walletSwapSummary.swapCandidateEvents,
      _closedLotsBeforeRecon,
    )
    _ethSwapReconstructionDebug = ethReconResult.debug
    tokenMeter.measure('swapDetection', ethReconResult)
    for (let _ri = 0; _ri < ethReconResult.debug.receiptsFetched; _ri++) {
      const _rk = `alchemy:ethrouterrecon:receipt:${_ri}:${addrNorm}`
      if (!_alchemyDedup.has(_rk)) { _alchemyDedup.add(_rk); _trackCall('alchemy', 'eth_getTransactionReceipt', false, _rk) }
    }
    for (let _ti = 0; _ti < (ethReconResult.debug.transactionsFetched ?? 0); _ti++) {
      const _rk = `alchemy:ethrouterrecon:tx:${_ti}:${addrNorm}`
      if (!_alchemyDedup.has(_rk)) { _alchemyDedup.add(_rk); _trackCall('alchemy', 'eth_getTransactionByHash', false, _rk) }
    }
    // Populate extended debug fields
    _ethSwapReconstructionDebug = {
      ..._ethSwapReconstructionDebug,
      ethEventsAvailable: _ethActivityEvents,
      candidateTxsChecked: ethReconResult.debug.candidateTxCount,
      wethUnknownLegsFound: ethReconResult.debug.wethQuoteMatches,
      inboundTokenLegsFound: _ethInboundTokenEvents.length,
      syntheticEthSwapEventsAdded: ethReconResult.debug.syntheticSwapEventsAdded,
      openedLotsBefore: _closedLotsBeforeRecon,
    }
    if (ethReconResult.debug.syntheticSwapEventsAdded > 0) {
      evidenceList = ethReconResult.enrichedEvidence
      ;({ evidenceWithDetection: _swapEvidenceWithDetection, summary: walletSwapSummary, debug: _swapDetectionDebug } = buildSwapDetection(evidenceList, activityRequested, addrNorm))
      _ethSwapReconstructionDebug = {
        ..._ethSwapReconstructionDebug,
        swapCandidatesAfter: walletSwapSummary.swapCandidateEvents,
      }
      tokenMeter.measure('swapDetection', _swapEvidenceWithDetection, walletSwapSummary, _swapDetectionDebug)
    }
  } else if (!activityRequested) {
    _ethSwapReconstructionDebug = { ..._ethSwapReconstructionDebug, reason: 'activity_not_requested', stopReason: 'activity_not_requested', ethEventsAvailable: _ethActivityEvents }
  } else if (!deepActivity) {
    _ethSwapReconstructionDebug = { ..._ethSwapReconstructionDebug, reason: 'basic_scan', stopReason: 'basic_scan', ethEventsAvailable: _ethActivityEvents }
  } else if (!_ethReconChainOk) {
    _ethSwapReconstructionDebug = { ..._ethSwapReconstructionDebug, reason: 'eth_chain_not_requested', stopReason: 'eth_chain_not_requested', ethEventsAvailable: _ethActivityEvents }
  } else if (_ethActivityEvents === 0) {
    _ethSwapReconstructionDebug = { ..._ethSwapReconstructionDebug, reason: 'no_eth_activity_events', stopReason: 'no_eth_activity_events', ethEventsAvailable: 0 }
  } else if (walletSwapSummary.swapCandidateEvents > 0) {
    _ethSwapReconstructionDebug = { ..._ethSwapReconstructionDebug, reason: 'swap_candidates_present', stopReason: 'swap_candidates_present', ethEventsAvailable: _ethActivityEvents }
  } else if (!_ethHasWalletInitiatedOrRouterInbound) {
    _ethSwapReconstructionDebug = { ..._ethSwapReconstructionDebug, reason: 'eth_wallet_initiated_but_no_token_receive', stopReason: 'eth_wallet_initiated_but_no_token_receive', ethEventsAvailable: _ethActivityEvents, inboundTokenLegsFound: _ethInboundTokenEvents.length }
  }

  tokenMeter.startTokenMeter('priceInference')
  const _pricingStartedAt = Date.now()
  tokenMeter.measure('priceInference', _swapEvidenceWithDetection)
  let { evidenceWithPricing: _pricedEvidence, summary: walletPriceEvidenceSummary, debug: _priceAtTimeDebug, budgetDebug: _priceBudgetDebug } = await buildPriceAtTimeEvidence(_swapEvidenceWithDetection, activityRequested, _reqPriceCache, priceByContract, totalValue, historicalCoverage ? 6 : null)
  // Track base evidence historical price calls
  for (let _pp = 0; _pp < (_priceAtTimeDebug?.providerAttempts ?? 0); _pp++) {
    _trackCall('goldrush', 'historical_by_addresses_v2', false, `gr:price:base:${_pp}:${addrNorm}`)
  }
  tokenMeter.measure('priceInference', _pricedEvidence, walletPriceEvidenceSummary, _priceAtTimeDebug)
  tokenMeter.endTokenMeter('priceInference')
  _perfWalletTimings.pricingMs += Date.now() - _pricingStartedAt

  // Save ETH reconstruction results AFTER pricing so BFC/fallback phases cannot permanently wipe them.
  // Even when pricedEvents = 0 (all buys unpriced), we preserve swapCandidates so open-position
  // evidence is not lost when the pipeline re-runs buildSwapDetection on raw (non-synthetic) events.
  let _ethReconSavedSwapSummary: typeof walletSwapSummary | null = null
  let _ethReconSavedPriceSummary: typeof walletPriceEvidenceSummary | null = null
  let _ethReconSavedPricedEvidence: WalletTxEvidence[] | null = null
  if (_ethSwapReconstructionDebug.syntheticSwapEventsAdded > 0 && walletSwapSummary.swapCandidateEvents > 0) {
    _ethReconSavedSwapSummary = walletSwapSummary
    _ethReconSavedPriceSummary = walletPriceEvidenceSummary
    _ethReconSavedPricedEvidence = [..._pricedEvidence]
  }

  // ── Base Unknown Swap Pricing Debug ─────────────────────────────────────────────────────
  let _baseUnknownSwapPricingDebug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['baseUnknownSwapPricingDebug']> = {
    attempted: false, reconstructedEventsAvailable: false, reconstructedSwapCandidatesInput: 0,
    staleSwapCandidatesBefore: 0, activeSwapCandidateSource: 'original_swap_detection',
    finalSwapCandidateSymbols: [], finalSwapCandidateTxHashes: [], fireCandidatesFiltered: 0,
    quoteLegsAvailableForPricing: 0, pricedAfterReconstruction: 0, unpricedAfterReconstruction: 0, reasons: [],
  }
  if (_baseUnknownSwapReconDebug.syntheticSwapEventsAdded > 0) {
    const _reconCandidates = _swapEvidenceWithDetection.filter(e => e.swapDetection?.isSwapCandidate)
    const _reconQuoteLegs = _reconCandidates.filter(e => {
      const cl = (e.contract ?? '').toLowerCase()
      return Boolean(WETH_CONTRACTS_PRICE[cl]) || Boolean(STABLE_USD_CONTRACTS[cl])
    })
    const _reconUnpricedCount = _reconCandidates.filter(e => !e.priceAtTime?.priceUsd).length
    _baseUnknownSwapPricingDebug = {
      attempted: true, reconstructedEventsAvailable: true,
      reconstructedSwapCandidatesInput: _reconCandidates.length,
      staleSwapCandidatesBefore: _baseUnknownSwapReconDebug.syntheticSwapEventsAdded,
      activeSwapCandidateSource: 'base_unknown_reconstruction',
      finalSwapCandidateSymbols: [...new Set(_reconCandidates.map(e => e.symbol).filter(Boolean))].slice(0, 10) as string[],
      finalSwapCandidateTxHashes: [...new Set(_reconCandidates.map(e => e.txHash).filter(Boolean))].slice(0, 5).map(h => h.slice(0, 10) + '…'),
      fireCandidatesFiltered: 0,
      quoteLegsAvailableForPricing: _reconQuoteLegs.length,
      pricedAfterReconstruction: walletPriceEvidenceSummary.pricedEvents,
      unpricedAfterReconstruction: _reconUnpricedCount,
      reasons: walletPriceEvidenceSummary.pricedEvents > 0
        ? ['priced_ok']
        : _reconQuoteLegs.length > 0 ? ['quote_legs_present_but_unpriced'] : ['no_quote_legs_for_pricing'],
    }
  }

  // Save reconstruction state so later pipeline phases (BFC, fallback) cannot permanently
  // overwrite it. We restore it in the final summary overwrite step before snapshot build.
  let _reconSavedSwapSummary: typeof walletSwapSummary | null = null
  let _reconSavedPriceSummary: typeof walletPriceEvidenceSummary | null = null
  let _reconSavedPricedEvidence: WalletTxEvidence[] | null = null
  if (_baseUnknownSwapReconDebug.syntheticSwapEventsAdded > 0 && walletPriceEvidenceSummary.pricedEvents > 0) {
    _reconSavedSwapSummary = walletSwapSummary
    _reconSavedPriceSummary = walletPriceEvidenceSummary
    _reconSavedPricedEvidence = [..._pricedEvidence]
  }

  // ── Unpriced Candidate Receipt Pass ─────────────────────────────────────────────────────
  // When swap candidates exist but none were priced (no stable/WETH leg in activity feed,
  // historical price failed), fetch receipts for those exact tx hashes to find hidden quote
  // legs (WETH/USDC/native ETH not captured in normalized events). If found, re-run price evidence.
  {
    const _unpricedReasonSet = new Set(['no_stable_or_weth_leg', 'sell_candidate_missing_exit_price', 'historical_price_unavailable', 'provider_event_usd_missing'])
    const _hasUnpricedCandReasons = (_priceAtTimeDebug?.sampleUnpricedReasons ?? []).some(r => _unpricedReasonSet.has(r.finalReason))
    const _shouldRunUnpricedReceiptPass = (
      activityRequested &&
      _baseReconChainOk &&
      Boolean(baseRpcUrl) &&
      walletPriceEvidenceSummary.pricedEvents === 0 &&
      walletPriceEvidenceSummary.swapCandidateEvents > 0 &&
      _hasUnpricedCandReasons
    )
    if (_shouldRunUnpricedReceiptPass) {
      // Collect unpriced candidate tx hashes (prioritised: only swap candidates, deduplicated)
      const _unpricedTxSet = new Set<string>()
      const _unpricedCandTxHashes: string[] = []
      for (const e of _swapEvidenceWithDetection) {
        if (!e.swapDetection?.isSwapCandidate || !e.txHash) continue
        if (_unpricedTxSet.has(e.txHash)) continue
        _unpricedTxSet.add(e.txHash)
        _unpricedCandTxHashes.push(e.txHash)
        if (_unpricedCandTxHashes.length >= 10) break
      }
      const _unpricedReceiptResult = await buildUnpricedCandidateReceiptPass(
        _swapEvidenceWithDetection,
        _unpricedCandTxHashes,
        addrNorm,
        baseRpcUrl,
        _baseRpcSource,
        _closedLotsBeforeRecon,
        _realizedPnlBeforeRecon,
      )
      _basePnlReconDebug = _unpricedReceiptResult.debug
      // Track API calls
      for (let _ri = 0; _ri < _unpricedReceiptResult.debug.receiptsFetched; _ri++) {
        const _rk = `alchemy:unpricedrecon:receipt:${_ri}:${addrNorm}`
        if (!_alchemyDedup.has(_rk)) { _alchemyDedup.add(_rk); _trackCall('alchemy', 'eth_getTransactionReceipt', false, _rk) }
      }
      for (let _ri = 0; _ri < (_unpricedReceiptResult.debug.transactionsFetched ?? 0); _ri++) {
        const _rk = `alchemy:unpricedrecon:tx:${_ri}:${addrNorm}`
        if (!_alchemyDedup.has(_rk)) { _alchemyDedup.add(_rk); _trackCall('alchemy', 'eth_getTransactionByHash', false, _rk) }
      }
      tokenMeter.measure('priceInference', _unpricedReceiptResult)
      if (_unpricedReceiptResult.debug.enrichedSwapEvents > 0) {
        // Synthetic WETH/stable legs were injected — re-run price evidence to price the candidates
        _swapEvidenceWithDetection = _unpricedReceiptResult.enrichedEvidence
        tokenMeter.startTokenMeter('priceInference')
        tokenMeter.measure('priceInference', _swapEvidenceWithDetection)
        const _rePriceResult = await buildPriceAtTimeEvidence(_swapEvidenceWithDetection, activityRequested, _reqPriceCache, priceByContract, totalValue, historicalCoverage ? 6 : null)
        for (let _pp = 0; _pp < (_rePriceResult.debug?.providerAttempts ?? 0); _pp++) {
          _trackCall('goldrush', 'historical_by_addresses_v2', false, `gr:price:unpriced_recon:${_pp}:${addrNorm}`)
        }
        _pricedEvidence = _rePriceResult.evidenceWithPricing
        walletPriceEvidenceSummary = _rePriceResult.summary
        _priceAtTimeDebug = _rePriceResult.debug
        tokenMeter.measure('priceInference', _pricedEvidence, walletPriceEvidenceSummary, _priceAtTimeDebug)
        tokenMeter.endTokenMeter('priceInference')
      }
      // Capture post-receipt unpriced reasons (from re-run if synthetic legs were added, else from original)
      const _afterUnpricedReasons = (_priceAtTimeDebug?.sampleUnpricedReasons ?? []).map(r => ({
        txHash: r.txHash, symbol: r.tokenSymbol, finalReason: r.finalReason,
      }))
      // Merge with receipt-level reasons (receipt_checked_*) — receipt reasons go first
      const _existingReceiptReasons = _basePnlReconDebug.sampleUnpricedAfterReceipt ?? []
      _basePnlReconDebug = {
        ..._basePnlReconDebug,
        sampleUnpricedAfterReceipt: [
          ..._existingReceiptReasons,
          ..._afterUnpricedReasons.filter(r => !_existingReceiptReasons.some(er => er.txHash === r.txHash && er.symbol === r.symbol)),
        ],
      }
    }
  }
  // ── End Unpriced Candidate Receipt Pass ─────────────────────────────────────────────────

  tokenMeter.startTokenMeter('fifoEngine')
  const _fifoStartedAt = Date.now()
  _pricedEvidence = normalizeSwapEventsForFifo(_pricedEvidence, tokenMeter.isDebugEnabled())
  _pricedEvidence = normalizeSingleLegEventsForFifo(_pricedEvidence, tokenMeter.isDebugEnabled())
  tokenMeter.measure('fifoEngine', _pricedEvidence)
  const fifoResult = buildFifoLotEngine(_pricedEvidence, activityRequested)
  let walletLotSummary = fifoResult.summary
  let _lotEngineDebug = fifoResult.debug
  let _closedLots = fifoResult.closedLots
  _ethSwapReconstructionDebug = {
    ..._ethSwapReconstructionDebug,
    pricedEventsAfter: walletPriceEvidenceSummary.pricedEvents,
    closedLotsAfter: walletLotSummary.closedLots,
    openedLotsAfter: walletLotSummary.openedLots ?? 0,
    pricedSyntheticEthEvents: walletPriceEvidenceSummary.pricedEvents,
    swapCandidatesAfter: walletSwapSummary.swapCandidateEvents,
  }
  // Propagate swap_candidates_unpriced through FIFO and trade-stats missing reasons for better traceability
  if (walletPriceEvidenceSummary.missing.some(r => r.endsWith('_swap_candidates_unpriced')) && walletLotSummary.closedLots === 0) {
    walletLotSummary = { ...walletLotSummary, missing: [...walletLotSummary.missing, 'swap_candidates_unpriced_no_fifo'] }
  }
  let _unmatchedSellBackfillDebug: UnmatchedSellBackfillDebug = {
    attempted: false,
    reason: 'not_eligible',
    unmatchedSellCount: _lotEngineDebug.unmatchedSells,
    targetTokens: [],
    pagesAttempted: 0,
    rawEventsFetched: 0,
    normalizedEvents: 0,
    priorBuysFound: 0,
    priorBuysPriced: 0,
    eventsAddedToFifo: 0,
    closedLotsBefore: walletLotSummary.closedLots,
    closedLotsAfter: walletLotSummary.closedLots,
    realizedPnlBefore: walletLotSummary.realizedPnlUsd,
    realizedPnlAfter: walletLotSummary.realizedPnlUsd,
    stopReason: 'not_eligible',
    perTargetResults: [],
    sampleTargets: [],
    samplePriorBuys: [],
    sampleStillUnmatched: _lotEngineDebug.unmatchedSellTokenKeys.slice(0, 5),
    sampleSkippedReasons: [],
  }
  const _shouldRunUnmatchedSellBackfill =
    deepActivity === true &&
    historicalCoverage !== true &&
    walletLotSummary.closedLots < 10 &&
    walletLotSummary.unmatchedSells > 0 &&
    _lotEngineDebug.unmatchedSellTokenKeys.length > 0

  let _phase5dTargetedKeys = new Set<string>()
  if (_shouldRunUnmatchedSellBackfill) {
    const _initialFifoKeys = _lotEngineDebug.unmatchedSellTokenKeys
    const _initialFifoSamples = (_lotEngineDebug.sampleUnmatchedSells ?? []).map(s => ({ txHash: s.txHash, tokenAddress: s.tokenAddress, symbol: s.symbol }))
    const _buildResult = buildUnmatchedSellBackfillTargets(_pricedEvidence, _initialFifoKeys, _lotEngineDebug.sampleUnmatchedSells)
    // Prioritize by sell USD value descending, cap at 5 target tokens
    const _targets = _buildResult.targets
      .sort((a, b) => {
        const aV = (a.exitPriceUsd ?? 0) * a.sellAmount
        const bV = (b.exitPriceUsd ?? 0) * b.sellAmount
        return bV - aV
      })
      .slice(0, 5)
    for (const t of _targets) _phase5dTargetedKeys.add(`${t.chain}:${t.tokenContract}`)
    const _backfillTimeoutSentinel = Symbol('backfill_timeout')
    const _backfill = await (async () => {
      const result = await withTimeout<UnmatchedSellBackfillOutput | typeof _backfillTimeoutSentinel>(
        runTargetedUnmatchedSellBackfill(addrNorm, _targets, GOLDRUSH_KEY, baseUrl, walletLotSummary.closedLots, walletLotSummary.realizedPnlUsd),
        10000,
        _backfillTimeoutSentinel,
      )
      if (result === _backfillTimeoutSentinel) {
        _perfTimedOut.push('unmatched_sell_backfill')
        return {
          events: [] as PnlEvent[], targetBuyKeys: new Set<string>(),
          debug: { attempted: true, reason: 'backfill_not_started_timeout' as const, unmatchedSellCount: _initialFifoKeys.length, targetTokens: _targets.map(t => ({ chain: t.chain, tokenContract: t.tokenContract, symbol: t.symbol })), pagesAttempted: 0, rawEventsFetched: 0, normalizedEvents: 0, priorBuysFound: 0, priorBuysPriced: 0, eventsAddedToFifo: 0, closedLotsBefore: walletLotSummary.closedLots, closedLotsAfter: walletLotSummary.closedLots, realizedPnlBefore: walletLotSummary.realizedPnlUsd, realizedPnlAfter: walletLotSummary.realizedPnlUsd, stopReason: 'backfill_not_started_timeout' as const, perTargetResults: _targets.map(t => ({ chain: t.chain, tokenContract: t.tokenContract, symbol: t.symbol, attempted: true, pagesAttempted: 0, rawEventsFetched: 0, normalizedEvents: 0, priorBuysFound: 0, priorBuysPriced: 0, eventsAddedToFifo: 0, reason: 'backfill_not_started_timeout' as const })), sampleTargets: _targets.slice(0, 5), samplePriorBuys: [], sampleStillUnmatched: _initialFifoKeys.slice(0, 5), sampleSkippedReasons: [{ reason: 'backfill_not_started_timeout' }] },
        } as UnmatchedSellBackfillOutput
      }
      return result
    })()
    _unmatchedSellBackfillDebug = _backfill.debug
    _unmatchedSellBackfillDebug.targetExtractionDebug = _buildResult.extractionDebug
    _unmatchedSellBackfillDebug.inputSourceDebug = {
      fifoUnmatchedSellKeysAvailable: _initialFifoKeys,
      fifoSampleUnmatchedSellsAvailable: _initialFifoSamples,
      keysPassedToTargetBuilder: _initialFifoKeys,
      sampleSellsPassedToTargetBuilder: _initialFifoSamples,
      sourceUsed: 'initial_fifo',
    }
    if (_backfill.events.length > 0) {
      const _mergedBackfillEvents = [...events, ..._backfill.events]
      ;({ evidenceList, summary: walletEvidenceSummary, debug: _txEvidenceDebugBase } = buildTxEvidenceFromEvents(_mergedBackfillEvents, activityRequested, activityProviderUnavailable))
      ;({ evidenceWithDetection: _swapEvidenceWithDetection, summary: walletSwapSummary, debug: _swapDetectionDebug } = buildSwapDetection(evidenceList, activityRequested, addrNorm))
      if (_backfill.targetBuyKeys.size > 0) {
        _swapEvidenceWithDetection = _swapEvidenceWithDetection.map(ev => {
          const k = `${ev.txHash}:${ev.contract.toLowerCase()}:${ev.direction}`
          if (!_backfill.targetBuyKeys.has(k)) return ev
          return {
            ...ev,
            swapDetection: {
              ...(ev.swapDetection ?? { reason: '', confidence: 'medium' as const, isSwapCandidate: false, eventKind: 'unknown' as const, matchedProtocol: null, matchedAddress: null }),
              isSwapCandidate: true,
              confidence: ev.swapDetection?.confidence ?? 'medium',
              eventKind: 'swap_candidate' as const,
              reason: ev.swapDetection?.reason || 'targeted_unmatched_sell_prior_buy_backfill',
            },
          }
        })
      }
      ;({ evidenceWithPricing: _pricedEvidence, summary: walletPriceEvidenceSummary, debug: _priceAtTimeDebug } = await buildPriceAtTimeEvidence(_swapEvidenceWithDetection, activityRequested, _reqPriceCache, priceByContract, totalValue, historicalCoverage ? 6 : null))
      _pricedEvidence = normalizeSwapEventsForFifo(_pricedEvidence, tokenMeter.isDebugEnabled())
      _pricedEvidence = normalizeSingleLegEventsForFifo(_pricedEvidence, tokenMeter.isDebugEnabled())
      const _rerunFifo = buildFifoLotEngine(_pricedEvidence, activityRequested)
      walletLotSummary = _rerunFifo.summary
      _lotEngineDebug = _rerunFifo.debug
      _closedLots = _rerunFifo.closedLots
      _unmatchedSellBackfillDebug.priorBuysPriced = _pricedEvidence.filter(ev => {
        const k = `${ev.txHash}:${ev.contract.toLowerCase()}:${ev.direction}`
        return _backfill.targetBuyKeys.has(k) && ev.priceAtTime?.status === 'priced'
      }).length
      _unmatchedSellBackfillDebug.perTargetResults = _unmatchedSellBackfillDebug.perTargetResults.map(result => {
        const priorBuysPriced = _pricedEvidence.filter(ev => {
          const k = `${ev.txHash}:${ev.contract.toLowerCase()}:${ev.direction}`
          return _backfill.targetBuyKeys.has(k) && ev.direction === 'buy' && normalizeChain(ev.chain) === result.chain && ev.contract.toLowerCase() === result.tokenContract && ev.priceAtTime?.status === 'priced'
        }).length
        return {
          ...result,
          priorBuysPriced,
          reason: result.priorBuysFound > 0 && priorBuysPriced === 0 ? 'prior_buy_found_but_unpriced' : result.reason,
        }
      })
      if (walletLotSummary.closedLots === 0 && _unmatchedSellBackfillDebug.priorBuysFound > 0 && _unmatchedSellBackfillDebug.priorBuysPriced === 0) {
        _unmatchedSellBackfillDebug.reason = 'prior_buy_found_but_unpriced'
        _unmatchedSellBackfillDebug.stopReason = 'prior_buy_found_but_unpriced'
        walletLotSummary = { ...walletLotSummary, missing: Array.from(new Set([...walletLotSummary.missing, 'prior_buy_found_but_unpriced'])) }
      }
      _unmatchedSellBackfillDebug.closedLotsAfter = walletLotSummary.closedLots
      _unmatchedSellBackfillDebug.realizedPnlAfter = walletLotSummary.realizedPnlUsd
      _unmatchedSellBackfillDebug.sampleStillUnmatched = _lotEngineDebug.unmatchedSellTokenKeys.slice(0, 5)
      events = _mergedBackfillEvents
      tokenMeter.measure('fifoEngine', _unmatchedSellBackfillDebug, _closedLots)
    }
  }

  tokenMeter.measure('fifoEngine', walletLotSummary, _lotEngineDebug, _closedLots)
  tokenMeter.endTokenMeter('fifoEngine')
  _perfPhaseTs.fifo_done = Date.now()
  _perfWalletTimings.fifoMs += _perfPhaseTs.fifo_done - _fifoStartedAt

  tokenMeter.startTokenMeter('tradeStats')
  const _tradeStatsStartedAt = Date.now()
  tokenMeter.measure('tradeStats', _closedLots)
  const tradeStatsResult = buildTradeStatsSummary(_closedLots, activityRequested, totalValue)
  let walletTradeStatsSummary = tradeStatsResult.summary
  let _tradeStatsDebug = tradeStatsResult.debug
  let _outlierDebug = tradeStatsResult.outlierDebug
  let _outlierNote: string | null = tradeStatsResult.outlierNote
  if (walletLotSummary.missing.includes('swap_candidates_unpriced_no_fifo') && walletTradeStatsSummary.closedLots === 0) {
    walletTradeStatsSummary = { ...walletTradeStatsSummary, missing: [...walletTradeStatsSummary.missing, 'swap_candidates_unpriced_no_closed_lots'] }
  }
  if (_closedLots.length === 0 && activityRequested) {
    const _perSwap = buildPerSwapTradeStats(_pricedEvidence, activityRequested, totalValue)
    if (_perSwap.summary.closedLots > 0) {
      walletTradeStatsSummary = _perSwap.summary
      _tradeStatsDebug = _perSwap.debug
      tokenMeter.measure('tradeStats', _perSwap)
    }
  }
  tokenMeter.measure('tradeStats', walletTradeStatsSummary, _tradeStatsDebug)
  tokenMeter.endTokenMeter('tradeStats')
  _perfWalletTimings.tradeStatsMs += Date.now() - _tradeStatsStartedAt
  let _tradeStatsInputDebug: { closedLotsInputCount: number; walletLotSummaryClosedLots: number; source: string; computedAfterSupplementalBackfill: boolean; mismatchFixed: boolean } = {
    closedLotsInputCount: _closedLots.length,
    walletLotSummaryClosedLots: walletLotSummary.closedLots,
    source: 'initial_fifo',
    computedAfterSupplementalBackfill: false,
    mismatchFixed: false,
  }

  // Update Base recon debug with post-FIFO/trade-stats values
  if (_basePnlReconDebug.attempted && _basePnlReconDebug.enrichedSwapEvents > 0) {
    const _reconPricedCount = _pricedEvidence.filter(e => e.swapDetection?.isSwapCandidate && e.priceAtTime?.status === 'priced').length
    _basePnlReconDebug = {
      ..._basePnlReconDebug,
      pricedEnrichedEvents: _reconPricedCount,
      closedLotsAfter: walletLotSummary.closedLots,
      realizedPnlAfter: walletLotSummary.realizedPnlUsd,
    }
  }

  // Capture page-1 FIFO state for pagination debug telemetry
  if (_moralisFbDebug.fallbackActivityUsed) {
    _moralisFbDebug = {
      ..._moralisFbDebug,
      fallbackClosedLotsAfterPage1: walletLotSummary.closedLots,
      fallbackClosedCostBasisAfterPage1: walletLotSummary.totalCostBasisClosedUsd,
      fallbackRealizedPnlAfterPage1: walletLotSummary.realizedPnlUsd,
      fallbackMeaningfulEvidenceReached: false,
      fallbackMeaningfulEvidenceReason: 'not_evaluated',
    }
  }

  // Helper: true only when enough economically meaningful closed-lot evidence exists to stop pagination.
  // Uses the same economic significance rules as buildTradeStatsSummary — NOT count alone.
  const hasMeaningfulClosedLotEvidence = (
    lotSummary: WalletSnapshot['walletLotSummary'],
    lots: WalletClosedLot[],
  ): { result: boolean; reason: string } => {
    const c = lotSummary.closedLots
    const cb = lotSummary.totalCostBasisClosedUsd ?? 0
    const pnl = Math.abs(lotSummary.realizedPnlUsd ?? 0)
    // PHASE5-FIX-4: relative dust threshold, consistent with buildTradeStatsSummary.
    const DUST_THRESHOLD = dustThresholdUsdFor(totalValue)
    const meaningfulLots = lots.filter(l => l.costBasisUsd >= DUST_THRESHOLD)
    const meaningfulCount = meaningfulLots.length
    const meaningfulBasis = meaningfulLots.reduce((s, l) => s + l.costBasisUsd, 0)
    if (meaningfulCount >= 5 && meaningfulBasis >= 500) return { result: true, reason: 'meaningful_lots_gte_5_and_basis_gte_500' }
    if (cb >= 1000 && meaningfulCount >= 3) return { result: true, reason: 'total_basis_gte_1000_and_meaningful_lots_gte_3' }
    if (pnl >= 50 && cb >= 250) return { result: true, reason: 'realized_pnl_gte_50_and_basis_gte_250' }
    return { result: false, reason: c === 0 ? 'no_closed_lots' : 'dust_sample' }
  }

  // Phase 5B: Moralis multi-page fallback — continue paginating until meaningful evidence or budget exhausted.
  // Enters when: fallback was used, not meaningful yet, has some signal (closed or unmatched lots), cursor available.
  if (
    _moralisFbDebug.fallbackActivityUsed &&
    activityRequested &&
    !historicalCoverage &&
    !hasMeaningfulClosedLotEvidence(walletLotSummary, _closedLots).result &&
    (walletLotSummary.unmatchedSells > 0 || walletLotSummary.unmatchedBuys > 0 || walletLotSummary.closedLots > 0) &&
    _fbNextCursor != null
  ) {
    const maxFbPages = clampedMaxFallbackPages
    let fbCursor: string | null = _fbNextCursor
    let allFbEvents: PnlEvent[] = [...events]
    let fbPagesAttempted = _moralisFbDebug.fallbackPagesAttempted
    let fbPagesUsed = _moralisFbDebug.fallbackPagesUsed
    let fbCursorsSeen = _moralisFbDebug.fallbackCursorsSeen
    let fbRawTotal = _moralisFbDebug.fallbackRawTotal
    let fbNormalizedTotal = _moralisFbDebug.fallbackNormalizedTotal
    let fbDedupeRemoved = 0
    let fbPaginationStoppedReason = 'max_pages_reached'
    let fbMeaningfulEvidenceReached = false
    let fbMeaningfulEvidenceReason = 'not_reached'
    const seenKeys = new Set<string>(events.map(e => `${e.txHash ?? ''}|${e.contract}|${e.direction}|${e.amountRaw ?? String(e.amount)}`))

    while (fbPagesAttempted < maxFbPages && fbCursor != null) {
      fbPagesAttempted++
      fbCursorsSeen++
      const pageResult = await fetchMoralisTransfers(addr, _fbChain, 100, fbCursor)
      _trackCall('moralis', 'erc20_transfers', pageResult.cacheHit, `moralis:transfers:p${fbPagesAttempted}:${_fbChain}:${addrNorm}`)
      if (!pageResult.usable || pageResult.items.length === 0) {
        fbPaginationStoppedReason = pageResult.usable ? 'no_cursor' : 'provider_error_keep_existing'
        break
      }
      fbRawTotal += pageResult.rawCount
      const { events: pageEvents } = normalizeMoralisTransfers(pageResult.items, addr, _fbChainName)
      tokenMeter.measure('fallbackEngine', pageResult, pageEvents)
      fbNormalizedTotal += pageEvents.length
      const newEvents: PnlEvent[] = []
      for (const e of pageEvents) {
        const k = `${e.txHash ?? ''}|${e.contract}|${e.direction}|${e.amountRaw ?? String(e.amount)}`
        if (!seenKeys.has(k)) { seenKeys.add(k); newEvents.push(e) }
      }
      fbDedupeRemoved += pageEvents.length - newEvents.length
      if (newEvents.length === 0) { fbPaginationStoppedReason = 'no_new_normalized_events'; break }
      fbPagesUsed++
      allFbEvents = [...allFbEvents, ...newEvents]
      fbCursor = pageResult.nextCursor
      // Re-run pipeline on merged events
      ;({ evidenceList, summary: walletEvidenceSummary, debug: _txEvidenceDebugBase } = buildTxEvidenceFromEvents(allFbEvents, activityRequested, activityProviderUnavailable))
      tokenMeter.measure('normalization', allFbEvents, evidenceList, walletEvidenceSummary, _txEvidenceDebugBase)
      ;({ evidenceWithDetection: _swapEvidenceWithDetection, summary: walletSwapSummary, debug: _swapDetectionDebug } = buildSwapDetection(evidenceList, activityRequested, addrNorm))
      tokenMeter.measure('swapDetection', evidenceList, _swapEvidenceWithDetection, walletSwapSummary, _swapDetectionDebug)
      ;({ evidenceWithPricing: _pricedEvidence, summary: walletPriceEvidenceSummary, debug: _priceAtTimeDebug } = await buildPriceAtTimeEvidence(_swapEvidenceWithDetection, activityRequested, _reqPriceCache, priceByContract, totalValue, historicalCoverage ? 6 : null))
      tokenMeter.measure('priceInference', _swapEvidenceWithDetection, _pricedEvidence, walletPriceEvidenceSummary, _priceAtTimeDebug)
      _pricedEvidence = normalizeSwapEventsForFifo(_pricedEvidence, tokenMeter.isDebugEnabled())
      _pricedEvidence = normalizeSingleLegEventsForFifo(_pricedEvidence, tokenMeter.isDebugEnabled())
      const fifoPageResult = buildFifoLotEngine(_pricedEvidence, activityRequested)
      walletLotSummary = fifoPageResult.summary
      _lotEngineDebug = fifoPageResult.debug
      _closedLots = fifoPageResult.closedLots
      if (walletPriceEvidenceSummary.missing.some(r => r.endsWith('_swap_candidates_unpriced')) && walletLotSummary.closedLots === 0) {
        walletLotSummary = { ...walletLotSummary, missing: [...walletLotSummary.missing, 'swap_candidates_unpriced_no_fifo'] }
      }
      tokenMeter.measure('fifoEngine', _pricedEvidence, walletLotSummary, _lotEngineDebug, _closedLots)
      const tradeStatsPageResult = buildTradeStatsSummary(_closedLots, activityRequested, totalValue)
      walletTradeStatsSummary = tradeStatsPageResult.summary
      _tradeStatsDebug = tradeStatsPageResult.debug
      _outlierDebug = tradeStatsPageResult.outlierDebug
      _outlierNote = tradeStatsPageResult.outlierNote
      if (walletLotSummary.missing.includes('swap_candidates_unpriced_no_fifo') && walletTradeStatsSummary.closedLots === 0) {
        walletTradeStatsSummary = { ...walletTradeStatsSummary, missing: [...walletTradeStatsSummary.missing, 'swap_candidates_unpriced_no_closed_lots'] }
      }
      tokenMeter.measure('tradeStats', _closedLots, walletTradeStatsSummary, _tradeStatsDebug)
      if (_closedLots.length === 0 && activityRequested) {
        const _perSwap = buildPerSwapTradeStats(_pricedEvidence, activityRequested, totalValue)
        if (_perSwap.summary.closedLots > 0) {
          walletTradeStatsSummary = _perSwap.summary
          _tradeStatsDebug = _perSwap.debug
          tokenMeter.measure('tradeStats', _perSwap)
        }
      }
      const meaningfulCheck = hasMeaningfulClosedLotEvidence(walletLotSummary, _closedLots)
      if (meaningfulCheck.result) {
        fbPaginationStoppedReason = 'meaningful_closed_lot_evidence_found'
        fbMeaningfulEvidenceReason = meaningfulCheck.reason
        fbMeaningfulEvidenceReached = true
        break
      }
      if (fbCursor == null) { fbPaginationStoppedReason = 'no_cursor'; break }
    }
    events = allFbEvents
    _moralisFbDebug = {
      ..._moralisFbDebug,
      fallbackActivityNormalizedEvents: fbNormalizedTotal,
      fallbackPagesAttempted: fbPagesAttempted,
      fallbackPagesUsed: fbPagesUsed,
      fallbackCursorsSeen: fbCursorsSeen,
      fallbackRawTotal: fbRawTotal,
      fallbackNormalizedTotal: fbNormalizedTotal,
      fallbackDedupeRemoved: fbDedupeRemoved,
      fallbackPaginationReason: 'multi_page_attempted',
      fallbackPaginationStoppedReason: fbPaginationStoppedReason,
      fallbackMeaningfulEvidenceReached: fbMeaningfulEvidenceReached,
      fallbackMeaningfulEvidenceReason: fbMeaningfulEvidenceReason,
    }
  } else if (_moralisFbDebug.fallbackActivityUsed) {
    const p1Meaningful = hasMeaningfulClosedLotEvidence(walletLotSummary, _closedLots)
    const p1Reason = p1Meaningful.result ? 'meaningful_closed_lot_evidence_found'
      : _fbNextCursor == null ? 'no_cursor'
      : walletLotSummary.closedLots === 0 && walletLotSummary.unmatchedSells === 0 && walletLotSummary.unmatchedBuys === 0 ? 'no_unmatched_events'
      : 'max_pages_reached'
    _moralisFbDebug = {
      ..._moralisFbDebug,
      fallbackPaginationReason: 'page1_only',
      fallbackPaginationStoppedReason: p1Reason,
      fallbackMeaningfulEvidenceReached: p1Meaningful.result,
      fallbackMeaningfulEvidenceReason: p1Meaningful.result ? p1Meaningful.reason : 'not_reached',
    }
  }

  // ── Phase 5C: Base FIFO Coverage Pass ───────────────────────────────────────────────────
  // Runs when: deepActivity + Base chain + 0 closed lots after primary pipeline + swap candidates
  // exist + primary providers (GoldRush/Alchemy) were used (Moralis fallback not already tried).
  // Fetches up to 3 pages of older Moralis Base transfers to find historical BUY evidence for
  // tokens where only SELLs appeared in the sample window. Each page merges new unique events,
  // then re-runs evidence → swap detection → price evidence → FIFO → trade stats.
  // Hard budget: max 3 pages, stop when meaningful lots found or no cursor.
  // Does NOT run on basic scans, historical coverage mode, or when Moralis fallback already ran.
  const _BASE_FIFO_COVERAGE_MAX_PAGES = 3
  // If Moralis fallback was attempted but returned 0 events, Phase 5C can't improve the result.
  // If fallback was used AND returned events, Phase 5C is allowed — it fetches additional pages.
  const _bfcFallbackBlocked = _moralisFbDebug.fallbackActivityAttempted && _moralisFbDebug.fallbackActivityNormalizedEvents === 0
  const _bfcAllowedBecauseFallbackHadEvents = _moralisFbDebug.fallbackActivityUsed && !_bfcFallbackBlocked
  let _baseFifoCoverageDebug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['baseFifoCoverageDebug']> = {
    attempted: false,
    reason: 'not_attempted',
    extraPagesAttempted: 0,
    extraEventsFetched: 0,
    extraEventsNormalized: 0,
    candidateTxsQueued: walletSwapSummary.swapCandidateEvents,
    receiptsFetched: 0,
    transactionsFetched: 0,
    receiptCacheHits: 0,
    quoteLegsFound: 0,
    nativeEthQuoteLegs: 0,
    usdcQuoteLegs: 0,
    wethQuoteLegs: 0,
    syntheticSwapEventsAdded: 0,
    pricedEventsBefore: walletPriceEvidenceSummary.pricedEvents,
    pricedEventsAfter: walletPriceEvidenceSummary.pricedEvents,
    closedLotsBefore: walletLotSummary.closedLots,
    closedLotsAfter: walletLotSummary.closedLots,
    openedLotsAfter: walletLotSummary.openedLots ?? 0,
    unmatchedBuysAfter: walletLotSummary.unmatchedBuys ?? 0,
    unmatchedSellsAfter: walletLotSummary.unmatchedSells ?? 0,
    stopReason: 'not_attempted',
    sampleTxsChecked: [],
    sampleQuoteLegs: [],
    sampleStillUnpriced: [],
    sampleNoMatchReasons: [],
    fallbackActivityUsed: _moralisFbDebug.fallbackActivityUsed,
    fallbackActivityEvents: _moralisFbDebug.fallbackActivityNormalizedEvents,
    allowedBecauseFallbackHadEvents: _bfcAllowedBecauseFallbackHadEvents,
    skippedReason: null as string | null,
  }
  const _shouldRunBaseFifoCoverage = (
    deepActivity &&
    activityRequested &&
    _baseReconChainOk &&
    walletLotSummary.closedLots === 0 &&
    walletSwapSummary.swapCandidateEvents > 0 &&
    walletEvidenceSummary.totalEvents > 0 &&
    Boolean(process.env.MORALIS_API_KEY) &&
    !historicalCoverage &&
    !_bfcFallbackBlocked
  )
  if (_shouldRunBaseFifoCoverage) {
    _baseFifoCoverageDebug.attempted = true
    _baseFifoCoverageDebug.reason = 'triggered'
    let bfcPagesAttempted = 0
    let bfcCursor: string | null = null
    let bfcStopReason = 'max_pages_reached'
    const bfcSeenKeys = new Set<string>(events.map(e => `${e.txHash ?? ''}|${e.contract}|${e.direction}|${e.amountRaw ?? String(e.amount)}`))
    let bfcAllEvents: PnlEvent[] = [...events]

    while (bfcPagesAttempted < _BASE_FIFO_COVERAGE_MAX_PAGES) {
      bfcPagesAttempted++
      _baseFifoCoverageDebug.extraPagesAttempted = bfcPagesAttempted
      const bfcPageResult = await fetchMoralisTransfers(addr, 'base', 100, bfcCursor ?? undefined)
      _trackCall('moralis', 'erc20_transfers', bfcPageResult.cacheHit, `moralis:transfers:bfc_p${bfcPagesAttempted}:base:${addrNorm}`)
      if (!bfcPageResult.usable || bfcPageResult.items.length === 0) {
        bfcStopReason = bfcPageResult.usable ? 'no_more_pages' : 'provider_error'
        break
      }
      _baseFifoCoverageDebug.extraEventsFetched += bfcPageResult.rawCount
      const { events: bfcPageEvents } = normalizeMoralisTransfers(bfcPageResult.items, addr, 'base-mainnet')
      tokenMeter.measure('fallbackEngine', bfcPageResult, bfcPageEvents)
      _baseFifoCoverageDebug.extraEventsNormalized += bfcPageEvents.length
      const bfcNewEvents: PnlEvent[] = []
      for (const e of bfcPageEvents) {
        const k = `${e.txHash ?? ''}|${e.contract}|${e.direction}|${e.amountRaw ?? String(e.amount)}`
        if (!bfcSeenKeys.has(k)) { bfcSeenKeys.add(k); bfcNewEvents.push(e) }
      }
      bfcCursor = bfcPageResult.nextCursor
      // Page 1 often overlaps entirely with GoldRush — skip pipeline re-run but continue to page 2
      if (bfcNewEvents.length === 0) {
        if (bfcPagesAttempted >= 2 || bfcCursor == null) { bfcStopReason = 'no_new_events'; break }
        continue
      }
      bfcAllEvents = [...bfcAllEvents, ...bfcNewEvents]
      // Re-run pipeline on merged events
      ;({ evidenceList, summary: walletEvidenceSummary, debug: _txEvidenceDebugBase } = buildTxEvidenceFromEvents(bfcAllEvents, activityRequested, activityProviderUnavailable))
      tokenMeter.measure('normalization', bfcAllEvents, evidenceList, walletEvidenceSummary)
      ;({ evidenceWithDetection: _swapEvidenceWithDetection, summary: walletSwapSummary, debug: _swapDetectionDebug } = buildSwapDetection(evidenceList, activityRequested, addrNorm))
      tokenMeter.measure('swapDetection', _swapEvidenceWithDetection, walletSwapSummary)
      ;({ evidenceWithPricing: _pricedEvidence, summary: walletPriceEvidenceSummary, debug: _priceAtTimeDebug } = await buildPriceAtTimeEvidence(_swapEvidenceWithDetection, activityRequested, _reqPriceCache, priceByContract, totalValue, historicalCoverage ? 6 : null))
      tokenMeter.measure('priceInference', _pricedEvidence, walletPriceEvidenceSummary)
      for (let _pp = 0; _pp < (_priceAtTimeDebug?.providerAttempts ?? 0); _pp++) {
        _trackCall('goldrush', 'historical_by_addresses_v2', false, `gr:price:bfc:p${bfcPagesAttempted}_${_pp}:${addrNorm}`)
      }
      _pricedEvidence = normalizeSwapEventsForFifo(_pricedEvidence, tokenMeter.isDebugEnabled())
      _pricedEvidence = normalizeSingleLegEventsForFifo(_pricedEvidence, tokenMeter.isDebugEnabled())
      const bfcFifo = buildFifoLotEngine(_pricedEvidence, activityRequested)
      walletLotSummary = bfcFifo.summary
      _lotEngineDebug = bfcFifo.debug
      _closedLots = bfcFifo.closedLots
      if (walletPriceEvidenceSummary.missing.some(r => r.endsWith('_swap_candidates_unpriced')) && walletLotSummary.closedLots === 0) {
        walletLotSummary = { ...walletLotSummary, missing: [...walletLotSummary.missing, 'swap_candidates_unpriced_no_fifo'] }
      }
      tokenMeter.measure('fifoEngine', walletLotSummary, _lotEngineDebug)
      const bfcStats = buildTradeStatsSummary(_closedLots, activityRequested, totalValue)
      walletTradeStatsSummary = bfcStats.summary
      _tradeStatsDebug = bfcStats.debug
      _outlierDebug = bfcStats.outlierDebug
      _outlierNote = bfcStats.outlierNote
      if (walletLotSummary.missing.includes('swap_candidates_unpriced_no_fifo') && walletTradeStatsSummary.closedLots === 0) {
        walletTradeStatsSummary = { ...walletTradeStatsSummary, missing: [...walletTradeStatsSummary.missing, 'swap_candidates_unpriced_no_closed_lots'] }
      }
      if (_closedLots.length === 0 && activityRequested) {
        const _ps = buildPerSwapTradeStats(_pricedEvidence, activityRequested, totalValue)
        if (_ps.summary.closedLots > 0) { walletTradeStatsSummary = _ps.summary; _tradeStatsDebug = _ps.debug }
      }
      tokenMeter.measure('tradeStats', walletTradeStatsSummary)
      _baseFifoCoverageDebug.pricedEventsAfter = walletPriceEvidenceSummary.pricedEvents
      _baseFifoCoverageDebug.closedLotsAfter = walletLotSummary.closedLots
      _baseFifoCoverageDebug.openedLotsAfter = walletLotSummary.openedLots ?? 0
      _baseFifoCoverageDebug.unmatchedBuysAfter = walletLotSummary.unmatchedBuys ?? 0
      _baseFifoCoverageDebug.unmatchedSellsAfter = walletLotSummary.unmatchedSells ?? 0
      if (walletLotSummary.closedLots >= 10 || walletPriceEvidenceSummary.pricedEvents >= 20) {
        bfcStopReason = walletLotSummary.closedLots >= 10 ? 'closedLots_gte_10' : 'pricedEvents_gte_20'; break
      }
      if (bfcCursor == null) { bfcStopReason = 'no_cursor'; break }
      if (hasMeaningfulClosedLotEvidence(walletLotSummary, _closedLots).result) {
        bfcStopReason = 'meaningful_closed_lot_evidence'; break
      }
    }
    events = bfcAllEvents
    _baseFifoCoverageDebug.stopReason = bfcStopReason
    _baseFifoCoverageDebug.sampleNoMatchReasons = (_lotEngineDebug?.sampleUnmatchedReasons ?? []).slice(0, 5)
    _baseFifoCoverageDebug.sampleStillUnpriced = (_priceAtTimeDebug?.sampleUnpricedReasons ?? []).slice(0, 3).map(r => ({
      txHash: r.txHash, symbol: r.tokenSymbol, finalReason: r.finalReason,
    }))
    if (walletLotSummary.closedLots === 0) {
      const _uBuyKeys = _lotEngineDebug?.uniqueBuyTokenKeys ?? 0
      const _uSellKeys = _lotEngineDebug?.uniqueSellTokenKeys ?? 0
      const _mKeys = _lotEngineDebug?.matchedTokenKeys ?? 0
      if (_uSellKeys > 0 && _uBuyKeys === 0) _baseFifoCoverageDebug.reason = 'only_sells_found_no_prior_buys'
      else if (_uBuyKeys > 0 && _uSellKeys === 0) _baseFifoCoverageDebug.reason = 'only_buys_found_no_sells'
      else if (_uBuyKeys > 0 && _uSellKeys > 0 && _mKeys === 0) _baseFifoCoverageDebug.reason = 'token_key_no_overlap'
      else if (walletPriceEvidenceSummary.pricedEvents === 0 && walletSwapSummary.swapCandidateEvents > 0) _baseFifoCoverageDebug.reason = 'all_candidates_unpriced'
      else if (bfcStopReason === 'provider_error') _baseFifoCoverageDebug.reason = 'price_provider_unavailable'
      else if (bfcStopReason === 'max_pages_reached') _baseFifoCoverageDebug.reason = 'historical_depth_insufficient'
      else _baseFifoCoverageDebug.reason = 'historical_depth_insufficient'
    }
  } else {
    const _bfcSkipReason = !deepActivity ? 'basic_scan'
      : !activityRequested ? 'activity_not_requested'
      : !_baseReconChainOk ? 'eth_chain'
      : walletLotSummary.closedLots > 0 ? 'already_has_closed_lots'
      : walletSwapSummary.swapCandidateEvents === 0 ? 'no_swap_candidates'
      : walletEvidenceSummary.totalEvents === 0 ? 'no_activity_events'
      : !Boolean(process.env.MORALIS_API_KEY) ? 'moralis_not_configured'
      : historicalCoverage ? 'historical_coverage_enabled'
      : _bfcFallbackBlocked ? 'fallback_activity_returned_empty'
      : 'not_triggered'
    _baseFifoCoverageDebug.reason = _bfcSkipReason
    _baseFifoCoverageDebug.skippedReason = _bfcSkipReason
  }
  // ── End Phase 5C ─────────────────────────────────────────────────────────────────────────

  // Phase 5D-Supplemental: After 5B/5C may have surfaced new unmatched sell keys not seen at
  // initial FIFO time, run a targeted backfill for those new keys, pipeline found events through
  // pricing and FIFO rerun (same as the main Phase 5D block does), and merge all debug.
  if (_shouldRunUnmatchedSellBackfill && _unmatchedSellBackfillDebug.attempted) {
    const _finalKeys = _lotEngineDebug.unmatchedSellTokenKeys
    const _finalSamples = (_lotEngineDebug.sampleUnmatchedSells ?? []).map(s => ({ txHash: s.txHash, tokenAddress: s.tokenAddress, symbol: s.symbol }))
    const _newKeys = _finalKeys.filter(k => !_phase5dTargetedKeys.has(k))
    if (_newKeys.length > 0) {
      const _suppBuild = buildUnmatchedSellBackfillTargets(_pricedEvidence, _newKeys, _lotEngineDebug.sampleUnmatchedSells)
      const _suppBackfill = await runTargetedUnmatchedSellBackfill(addrNorm, _suppBuild.targets, GOLDRUSH_KEY, baseUrl, walletLotSummary.closedLots, walletLotSummary.realizedPnlUsd)

      // Merge debug metadata
      _unmatchedSellBackfillDebug.perTargetResults = [
        ..._unmatchedSellBackfillDebug.perTargetResults,
        ..._suppBackfill.debug.perTargetResults,
      ]
      _unmatchedSellBackfillDebug.targetTokens = [
        ..._unmatchedSellBackfillDebug.targetTokens,
        ..._suppBackfill.debug.targetTokens,
      ]
      _unmatchedSellBackfillDebug.priorBuysFound += _suppBackfill.debug.priorBuysFound
      _unmatchedSellBackfillDebug.rawEventsFetched += _suppBackfill.debug.rawEventsFetched
      if (_unmatchedSellBackfillDebug.targetExtractionDebug) {
        _unmatchedSellBackfillDebug.targetExtractionDebug = {
          ..._unmatchedSellBackfillDebug.targetExtractionDebug,
          unmatchedSellKeysInput: [..._unmatchedSellBackfillDebug.targetExtractionDebug.unmatchedSellKeysInput, ..._newKeys],
          finalTargets: [..._unmatchedSellBackfillDebug.targetExtractionDebug.finalTargets, ..._suppBuild.extractionDebug.finalTargets],
        }
      }
      _unmatchedSellBackfillDebug.inputSourceDebug = {
        fifoUnmatchedSellKeysAvailable: _finalKeys,
        fifoSampleUnmatchedSellsAvailable: _finalSamples,
        keysPassedToTargetBuilder: _finalKeys,
        sampleSellsPassedToTargetBuilder: _finalSamples,
        sourceUsed: 'supplemental_final_fifo',
      }

      // Pipeline found events through pricing + FIFO (same as Phase 5D main block)
      if (_suppBackfill.events.length > 0) {
        const _suppMergedEvents = [...events, ..._suppBackfill.events]
        ;({ evidenceList, summary: walletEvidenceSummary, debug: _txEvidenceDebugBase } = buildTxEvidenceFromEvents(_suppMergedEvents, activityRequested, activityProviderUnavailable))
        ;({ evidenceWithDetection: _swapEvidenceWithDetection, summary: walletSwapSummary, debug: _swapDetectionDebug } = buildSwapDetection(evidenceList, activityRequested, addrNorm))
        if (_suppBackfill.targetBuyKeys.size > 0) {
          _swapEvidenceWithDetection = _swapEvidenceWithDetection.map(ev => {
            const k = `${ev.txHash}:${ev.contract.toLowerCase()}:${ev.direction}`
            if (!_suppBackfill.targetBuyKeys.has(k)) return ev
            return {
              ...ev,
              swapDetection: {
                ...(ev.swapDetection ?? { reason: '', confidence: 'medium' as const, isSwapCandidate: false, eventKind: 'unknown' as const, matchedProtocol: null, matchedAddress: null }),
                isSwapCandidate: true,
                confidence: ev.swapDetection?.confidence ?? 'medium',
                eventKind: 'swap_candidate' as const,
                reason: ev.swapDetection?.reason || 'targeted_unmatched_sell_prior_buy_backfill',
              },
            }
          })
        }
        ;({ evidenceWithPricing: _pricedEvidence, summary: walletPriceEvidenceSummary, debug: _priceAtTimeDebug } = await buildPriceAtTimeEvidence(_swapEvidenceWithDetection, activityRequested, _reqPriceCache, priceByContract, totalValue, historicalCoverage ? 6 : null))
        _pricedEvidence = normalizeSwapEventsForFifo(_pricedEvidence, tokenMeter.isDebugEnabled())
        _pricedEvidence = normalizeSingleLegEventsForFifo(_pricedEvidence, tokenMeter.isDebugEnabled())
        const _suppRerunFifo = buildFifoLotEngine(_pricedEvidence, activityRequested)
        walletLotSummary = _suppRerunFifo.summary
        _lotEngineDebug = _suppRerunFifo.debug
        _closedLots = _suppRerunFifo.closedLots
        // Rebuild trade stats from the updated _closedLots — previous build used pre-supplemental lots
        const _suppTradeStats = buildTradeStatsSummary(_closedLots, activityRequested, totalValue)
        walletTradeStatsSummary = _suppTradeStats.summary
        _tradeStatsDebug = _suppTradeStats.debug
        _outlierDebug = _suppTradeStats.outlierDebug
        _outlierNote = _suppTradeStats.outlierNote
        if (walletLotSummary.missing.includes('swap_candidates_unpriced_no_fifo') && walletTradeStatsSummary.closedLots === 0) {
          walletTradeStatsSummary = { ...walletTradeStatsSummary, missing: [...walletTradeStatsSummary.missing, 'swap_candidates_unpriced_no_closed_lots'] }
        }
        if (_closedLots.length === 0 && activityRequested) {
          const _ps = buildPerSwapTradeStats(_pricedEvidence, activityRequested, totalValue)
          if (_ps.summary.closedLots > 0) { walletTradeStatsSummary = _ps.summary; _tradeStatsDebug = _ps.debug }
        }
        _tradeStatsInputDebug = {
          closedLotsInputCount: _closedLots.length,
          walletLotSummaryClosedLots: walletLotSummary.closedLots,
          source: 'supplemental_fifo_rerun',
          computedAfterSupplementalBackfill: true,
          mismatchFixed: true,
        }

        // Update pricing counts across all supplemental per-target results
        const _suppPriorBuysPriced = _pricedEvidence.filter(ev => {
          const k = `${ev.txHash}:${ev.contract.toLowerCase()}:${ev.direction}`
          return _suppBackfill.targetBuyKeys.has(k) && ev.priceAtTime?.status === 'priced'
        }).length
        _unmatchedSellBackfillDebug.priorBuysPriced = (_unmatchedSellBackfillDebug.priorBuysPriced ?? 0) + _suppPriorBuysPriced
        _unmatchedSellBackfillDebug.perTargetResults = _unmatchedSellBackfillDebug.perTargetResults.map(result => {
          if (!_suppBuild.targets.some(t => t.chain === result.chain && t.tokenContract === result.tokenContract)) return result
          const priorBuysPriced = _pricedEvidence.filter(ev => {
            const k = `${ev.txHash}:${ev.contract.toLowerCase()}:${ev.direction}`
            return _suppBackfill.targetBuyKeys.has(k) && ev.direction === 'buy' && normalizeChain(ev.chain) === result.chain && ev.contract.toLowerCase() === result.tokenContract && ev.priceAtTime?.status === 'priced'
          }).length
          return {
            ...result,
            priorBuysPriced,
            reason: result.priorBuysFound > 0 && priorBuysPriced === 0 ? 'prior_buy_found_but_unpriced' : result.reason,
          }
        })
        if (_unmatchedSellBackfillDebug.priorBuysFound > 0 && _unmatchedSellBackfillDebug.priorBuysPriced === 0) {
          _unmatchedSellBackfillDebug.reason = 'prior_buy_found_but_unpriced'
          _unmatchedSellBackfillDebug.stopReason = 'prior_buy_found_but_unpriced'
          walletLotSummary = { ...walletLotSummary, missing: Array.from(new Set([...walletLotSummary.missing, 'prior_buy_found_but_unpriced'])) }
        } else if (walletLotSummary.closedLots > 0) {
          _unmatchedSellBackfillDebug.reason = 'closed_lots_found_via_supplemental'
          _unmatchedSellBackfillDebug.stopReason = 'closed_lots_found_via_supplemental'
        }
        _unmatchedSellBackfillDebug.closedLotsAfter = walletLotSummary.closedLots
        _unmatchedSellBackfillDebug.realizedPnlAfter = walletLotSummary.realizedPnlUsd
        _unmatchedSellBackfillDebug.sampleStillUnmatched = _lotEngineDebug.unmatchedSellTokenKeys.slice(0, 5)
        events = _suppMergedEvents
      } else if (_suppBackfill.debug.priorBuysFound > 0) {
        // Events found but empty after dedup — still upgrade reason from generic timeout
        _unmatchedSellBackfillDebug.reason = 'prior_buy_found_but_unpriced'
        _unmatchedSellBackfillDebug.stopReason = 'prior_buy_found_but_unpriced'
      }
    } else if (_unmatchedSellBackfillDebug.inputSourceDebug) {
      // No new keys; update to reflect final FIFO was checked
      _unmatchedSellBackfillDebug.inputSourceDebug = {
        ..._unmatchedSellBackfillDebug.inputSourceDebug,
        fifoUnmatchedSellKeysAvailable: _finalKeys,
        fifoSampleUnmatchedSellsAvailable: _finalSamples,
      }
    }
  }

  tokenMeter.measure('fallbackEngine', _moralisFbDebug, events)
  tokenMeter.endTokenMeter('fallbackEngine')

  // SYNTH-RECOVERY-FIX-1: detect synthetic FIFO-backfilled lots before the eligibility gate below
  // is computed, so high/standard-value wallets with synthetic coverage can trigger targeted
  // historical recovery even when the caller didn't already pass historicalCoverage:true.
  // sells_exceed_buys is approximated via unmatchedSells>0, since pnlIntegrityCheck itself is only
  // computed later in the pipeline (after this point) and isn't available here yet.
  const _syntheticClosedLots = _closedLots.filter(
    l => l.evidence?.entrySource === 'synthetic' || (l.missingReasons ?? []).includes('fifo_backfilled_buy')
  )
  const _syntheticLotsDetected = _syntheticClosedLots.length > 0
  const _syntheticLotTokenTargets = Array.from(new Set(_syntheticClosedLots.map(l => l.tokenAddress.toLowerCase())))
  const _sellsExceedBuysSignal = (_lotEngineDebug.unmatchedSells ?? 0) > 0
  const _syntheticRecoveryTierEligible = _walletValueTier === 'high_value' || _walletValueTier === 'whale' || _walletValueTier === 'standard'
  const _syntheticLotsBeforeHistorical = _syntheticClosedLots.length

  // Phase 6A: Historical coverage diagnostics — capped, eligible, targeted recovery only.
  // _walletValueTier already computed earlier in the pipeline via computeWalletValueTier(totalValue)
  const _adminOverrideUsed = walletScanBudget?.adminOverrideUsed === true
  const _tierTarget = _walletValueTier === 'micro' ? 6 : _walletValueTier === 'small' ? 12 : 15
  const _totalCreditTarget = _adminOverrideUsed ? (walletScanBudget?.totalCreditTarget ?? 15) : Math.min(walletScanBudget?.totalCreditTarget ?? _tierTarget, _tierTarget)
  const _totalCreditHardCap = _adminOverrideUsed ? (walletScanBudget?.totalCreditHardCap ?? 18) : Math.min(walletScanBudget?.totalCreditHardCap ?? 18, _walletValueTier === 'micro' ? 6 : 18)
  const _pricingCreditsUsed = _priceBudgetDebug.finalPriceAttempts ?? _priceAtTimeDebug.priceAttempts ?? 0
  const _portfolioCreditsUsed = 1
  const _activityCreditsUsed = activityRequested ? 1 : 0
  const _creditsBeforeHistorical = _portfolioCreditsUsed + _activityCreditsUsed + _pricingCreditsUsed
  const _historicalPhaseBudget = Math.max(0, Math.min(6, _totalCreditHardCap - _creditsBeforeHistorical))
  const _defaultPagesByTier = _walletValueTier === 'micro' ? 0 : _walletValueTier === 'small' ? 1 : _walletValueTier === 'standard' ? 2 : _walletValueTier === 'high_value' ? 3 : 5
  const _pagesAllowed = _adminOverrideUsed
    ? Math.max(0, Math.min(clampedMaxHistoricalPages, _historicalPhaseBudget))
    : Math.max(0, Math.min(clampedMaxHistoricalPages, _defaultPagesByTier, _historicalPhaseBudget, _totalCreditHardCap - _creditsBeforeHistorical))

  const _rankedHistoricalTargets = (() => {
    const byContract = new Map<string, { contract: string; symbol: string; chain: string; score: number; reasons: string[]; estimatedUsd: number }>()
    const add = (contract: string | null | undefined, symbol: string | null | undefined, chain: string | null | undefined, score: number, reason: string, estimatedUsd = 0) => {
      const c = (contract ?? '').toLowerCase()
      if (!/^0x[a-f0-9]{40}$/.test(c)) return
      const cur = byContract.get(c) ?? { contract: c, symbol: symbol ?? 'TOKEN', chain: normalizeChain(chain ?? '') || 'unknown', score: 0, reasons: [], estimatedUsd: 0 }
      cur.score += score
      cur.estimatedUsd = Math.max(cur.estimatedUsd, estimatedUsd)
      if (!cur.reasons.includes(reason)) cur.reasons.push(reason)
      byContract.set(c, cur)
    }
    for (const s of _lotEngineDebug.sampleUnmatchedSells ?? []) add(s.tokenAddress, s.symbol, 'base', 1000 + Math.abs((s.amount ?? 0) * (s.exitPriceUsd ?? 0)), 'biggest_unmatched_sells', Math.abs((s.amount ?? 0) * (s.exitPriceUsd ?? 0)))
    for (const l of _lotEngineDebug.sampleOpenLots ?? []) add(l.tokenAddress, l.symbol, l.chain, 650 + Math.abs((l.amountRemaining ?? 0) * (l.entryPriceUsd ?? 0)), 'open_buys', Math.abs((l.amountRemaining ?? 0) * (l.entryPriceUsd ?? 0)))
    for (const h of holdings.slice().sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 8)) add(h.contract, h.symbol, h.chain, 500 + (h.value ?? 0) / 100, 'top_holdings_by_value', h.value ?? 0)
    for (const ev of _swapEvidenceWithDetection) {
      if (!ev.swapDetection?.isSwapCandidate) continue
      const c = (ev.contract ?? '').toLowerCase()
      const quoteBoost = STABLE_USD_CONTRACTS[c] || WETH_CONTRACTS_PRICE[c] ? 250 : 0
      add(ev.contract, ev.symbol, ev.chain, 300 + quoteBoost + ((ev.usdValue ?? 0) / 100), quoteBoost ? 'stablecoin_weth_eth_quote_leg_trades' : 'high_value_swap_candidates', ev.usdValue ?? 0)
    }
    // SYNTH-RECOVERY-FIX-2: synthetic-FIFO-backfilled lot tokens get top priority — these are
    // exactly the tokens with missing real entry prices that targeted recovery should fetch first.
    for (const l of _syntheticClosedLots) add(l.tokenAddress, l.tokenSymbol, l.chain, 5000, 'synthetic_fifo_lot_needs_real_buy', l.proceedsUsd ?? 0)
    const ranked = [...byContract.values()].sort((a, b) => b.score - a.score || b.estimatedUsd - a.estimatedUsd)
    const maxTokens = _walletValueTier === 'micro' ? 0 : _walletValueTier === 'small' ? 2 : _walletValueTier === 'standard' ? 3 : _walletValueTier === 'high_value' ? 4 : 5
    const baseTargets = ranked.slice(0, maxTokens)
    if (_syntheticLotsDetected && _syntheticRecoveryTierEligible) {
      const syntheticTargets = ranked.filter(r => _syntheticLotTokenTargets.includes(r.contract))
      const merged = [...syntheticTargets]
      for (const t of baseTargets) if (!merged.some(m => m.contract === t.contract)) merged.push(t)
      return merged.slice(0, Math.max(maxTokens, syntheticTargets.length))
    }
    return baseTargets
  })()
  const _targetContracts = new Set(_rankedHistoricalTargets.map(t => t.contract))
  const _eligibilityReasons: string[] = []
  const _skipReasons: string[] = []
  if (totalValue >= 100 || _adminOverrideUsed) _eligibilityReasons.push('wallet_value_meets_threshold'); else _skipReasons.push('wallet_value_below_100')
  if (deepActivity) _eligibilityReasons.push('deep_scan_requested'); else _skipReasons.push('deep_scan_not_requested')
  if (walletTradeStatsSummary.closedLots < 10) _eligibilityReasons.push('closed_lots_below_score_threshold'); else _skipReasons.push('already_has_10_closed_lots')
  if ((_lotEngineDebug.unmatchedSells ?? 0) > 0 || (_lotEngineDebug.openedLots ?? 0) > 0 || (walletSwapSummary.swapCandidateEvents ?? 0) > 0) _eligibilityReasons.push('fifo_or_swap_evidence_needs_recovery'); else _skipReasons.push('no_swap_or_lot_evidence')
  if (_targetContracts.size > 0) _eligibilityReasons.push('exact_token_contracts_known'); else _skipReasons.push('no_useful_token_contracts')
  if (_pagesAllowed > 0) _eligibilityReasons.push('scan_budget_has_room'); else _skipReasons.push('budget_remaining_too_low')
  if (GOLDRUSH_KEY) _eligibilityReasons.push('provider_daily_soft_cap_available'); else _skipReasons.push('provider_not_configured')
  // PHASE5-FIX-2: historical coverage previously only triggered off a hard closedLots<10 count,
  // which never fired for a wallet that already has >=10 closed lots but whose coverage is
  // still thin (e.g. coveragePercent/coveragePercentValueWeighted both low because most of those
  // lots are estimate-priced). Trigger on low coverage too, independent of the closed-lot count.
  const _HISTORICAL_COVERAGE_TRIGGER_THRESHOLD = 40
  const _coverageTriggersHistorical = coveragePercent < _HISTORICAL_COVERAGE_TRIGGER_THRESHOLD || coveragePercentValueWeighted < _HISTORICAL_COVERAGE_TRIGGER_THRESHOLD
  if (_coverageTriggersHistorical) _eligibilityReasons.push('coverage_historical_triggered'); else _skipReasons.push('coverage_above_threshold')
  // SYNTH-RECOVERY-FIX-3: synthetic FIFO-backfilled lots on a high/standard-value wallet are an
  // independent trigger for targeted historical recovery — it must not depend on the caller having
  // already passed historicalCoverage:true, since synthetic lots are only known once FIFO has run.
  const _syntheticLotRecoveryTrigger = Boolean(
    (_syntheticLotsDetected || _sellsExceedBuysSignal) &&
    _syntheticRecoveryTierEligible &&
    activityRequested &&
    _targetContracts.size > 0 &&
    _pagesAllowed > 0 &&
    GOLDRUSH_KEY
  )
  if (_syntheticLotRecoveryTrigger) _eligibilityReasons.push('synthetic_fifo_lots_need_real_buys')
  const _historicalEligible = Boolean(
    (historicalCoverage || _syntheticLotRecoveryTrigger) &&
    activityRequested &&
    (_adminOverrideUsed || totalValue >= 100) &&
    (walletTradeStatsSummary.closedLots < 10 || _coverageTriggersHistorical || _syntheticLotRecoveryTrigger) &&
    ((_lotEngineDebug.unmatchedSells ?? 0) > 0 || (_lotEngineDebug.openedLots ?? 0) > 0 || (walletSwapSummary.swapCandidateEvents ?? 0) > 0) &&
    _targetContracts.size > 0 &&
    _pagesAllowed > 0 &&
    GOLDRUSH_KEY
  )
  const _historicalTriggeredBySyntheticLots = _historicalEligible && !historicalCoverage && _syntheticLotRecoveryTrigger
  const _runHistoricalCoverage = _historicalEligible
  let walletHistoricalCoverageSummary: WalletSnapshot['walletHistoricalCoverageSummary']
  const _historicalStartedAt = Date.now()
  let _historicalCoverageDebug: NonNullable<WalletSnapshot['_diagnostics']>['walletHistoricalCoverageDebug']
  let _hcEvents: PnlEvent[] = []
  if (_runHistoricalCoverage) {
    const hcCacheKey = `wallet:historicalCoverage:v2:${addrNorm}:${chainMode}:${_walletValueTier}:${_rankedHistoricalTargets.map(t => t.contract).join(',')}:${_pagesAllowed}`
    const hcCached = historicalCoverageCache.get(hcCacheKey)
    if (hcCached && Date.now() - hcCached.cachedAt < HISTORICAL_COVERAGE_TTL_MS) {
      walletHistoricalCoverageSummary = hcCached.data.summary
      _historicalCoverageDebug = hcCached.data.debug
      _hcEvents = hcCached.data.events
    } else {
      const existingInFlight = historicalCoverageInFlight.get(hcCacheKey)
      let hcResult: WalletHistoricalCoverageOutput
      if (existingInFlight) {
        hcResult = await existingInFlight
      } else {
        const hcPromise = buildWalletHistoricalCoverage(addrNorm, GOLDRUSH_KEY, _pagesAllowed, walletTradeStatsSummary.closedLots, _targetContracts)
        historicalCoverageInFlight.set(hcCacheKey, hcPromise)
        try {
          hcResult = await hcPromise
          historicalCoverageCache.set(hcCacheKey, { data: hcResult, cachedAt: Date.now() })
        } finally {
          historicalCoverageInFlight.delete(hcCacheKey)
        }
      }
      walletHistoricalCoverageSummary = hcResult!.summary
      _historicalCoverageDebug = hcResult!.debug
      _hcEvents = hcResult!.events
      // Track historical coverage page calls (one entry per page per chain attempted)
      const _hcPages = _historicalCoverageDebug?.pagesAttempted ?? 0
      for (let _hp = 0; _hp < Math.min(_hcPages, Math.max(0, _totalCreditHardCap - _creditsBeforeHistorical)); _hp++) {
        _trackCall('goldrush', 'log_events_by_address', false, `gr:hc:p${_hp}:${addrNorm}`)
      }
    }
  } else {
    walletHistoricalCoverageSummary = { status: historicalCoverage ? 'open_check' : 'not_requested', requested: historicalCoverage, pagesAttempted: 0, maxPages: _pagesAllowed, rawTransactions: 0, rawLogEvents: 0, normalizedEvents: 0, walletSideEvents: 0, swapLikeTransactions: 0, pricedSwapCandidates: null, matchedClosedLotsBefore: null, matchedClosedLotsAfter: null, addedClosedLots: null, coverageLevel: 'none', missing: [], reason: historicalCoverage ? _skipReasons.join('; ') || 'not_eligible' : null }
    _historicalCoverageDebug = undefined
  }

  tokenMeter.measure('normalization', walletHistoricalCoverageSummary, _historicalCoverageDebug, _hcEvents)

  // Phase 6B: Historical candidate comparison — compare historical events against base swap candidates
  const { summary: walletHistoricalCandidateSummary, debug: _historicalCandidateDebug, newCandidateEvidence: _hcNewCandidateEvidence, allHistoricalEvidence: _hcAllHistoricalEvidence } =
    _runHistoricalCoverage && _hcEvents.length > 0
      ? buildHistoricalCandidateComparison(_hcEvents, _swapEvidenceWithDetection, addrNorm)
      : { summary: { status: 'not_requested' as const, requested: false, baseEvidenceEvents: 0, historicalNormalizedEvents: 0, historicalWalletSideEvents: 0, existingSwapCandidates: 0, historicalSwapCandidates: 0, newSwapCandidateEvents: 0, duplicateSwapCandidateEvents: 0, candidateTransactions: 0, newCandidateTransactions: 0, candidateTokens: 0, newCandidateTokens: 0, earliestCandidateAt: null, latestCandidateAt: null, readyForHistoricalPricing: false, readyForHistoricalFifoPreview: false, missing: ['historical_coverage_not_requested'], reason: null }, debug: undefined, newCandidateEvidence: [] as WalletTxEvidence[], allHistoricalEvidence: [] as WalletTxEvidence[] }

  tokenMeter.measure('swapDetection', walletHistoricalCandidateSummary, _historicalCandidateDebug, _hcNewCandidateEvidence, _hcAllHistoricalEvidence)

  // SYNTH-RECOVERY-FIX-8: the swap-candidate-only path above misses a target token's prior buy
  // when it's a standalone wallet-side inbound transfer (no matching counter-leg in the same tx —
  // e.g. an airdrop/claim/transfer-in rather than a router swap). For synthetic FIFO lots, go
  // straight to the normalized historical events for that exact target contract and pull any
  // wallet-side inbound transfer before the synthetic sell's timestamp, bypassing isSwapCandidate.
  const _syntheticTargetRecovery = _runHistoricalCoverage && _syntheticClosedLots.length > 0 && _hcEvents.length > 0
    ? buildSyntheticTargetPriorBuyRecovery(_hcEvents, _syntheticClosedLots)
    : null
  const _hcMergedCandidateEvidence = _syntheticTargetRecovery && _syntheticTargetRecovery.newCandidateEvidence.length > 0
    ? [
        ..._hcNewCandidateEvidence,
        ..._syntheticTargetRecovery.newCandidateEvidence.filter(
          se => !_hcNewCandidateEvidence.some(e => e.txHash === se.txHash && e.contract === se.contract && e.direction === se.direction)
        ),
      ]
    : _hcNewCandidateEvidence
  const _hcMergedAllHistoricalEvidence = _syntheticTargetRecovery && _syntheticTargetRecovery.newCandidateEvidence.length > 0
    ? [..._hcAllHistoricalEvidence, ..._syntheticTargetRecovery.newCandidateEvidence]
    : _hcAllHistoricalEvidence

  // SYNTH-RECOVERY-FIX-12: if synthetic lots still have zero real prior buys after the normal
  // historical pass, run a small targeted extra-page lookup for ONLY the synthetic lots' own
  // target tokens (max 2 tokens, max 2 extra pages, stopping the moment a real prior buy is
  // found). This does not broaden provider calls to other holdings and does not touch FIFO math —
  // it only feeds additional candidate evidence into the existing pricing/FIFO preview pipeline below.
  const _syntheticTargetExtraMaxTokens = 2
  const _syntheticTargetExtraMaxPages = 2
  const _syntheticHasRealBackedLotForTarget = (contract: string) =>
    _closedLots.some(
      l => l.tokenAddress.toLowerCase() === contract &&
        l.evidence?.entrySource !== 'synthetic' &&
        !(l.missingReasons ?? []).includes('fifo_backfilled_buy')
    )
  const _syntheticTargetExtraEligibleTokens = _syntheticLotTokenTargets
    .filter(c => !_syntheticHasRealBackedLotForTarget(c))
    .slice(0, _syntheticTargetExtraMaxTokens)
  const _syntheticTargetExtraPriorBuysFoundSoFar = _syntheticTargetRecovery?.debug.syntheticTargetPriorBuysFound ?? 0
  const _syntheticTargetExtraCreditsUsedSoFar = _historicalCoverageDebug?.pagesAttempted ?? 0
  const _syntheticTargetExtraBudgetRemaining = Math.max(0, _totalCreditHardCap - _creditsBeforeHistorical - _syntheticTargetExtraCreditsUsedSoFar)
  const _syntheticTargetExtraPagesAllowed = Math.max(0, Math.min(_syntheticTargetExtraMaxPages, _syntheticTargetExtraBudgetRemaining))

  let _syntheticTargetExtraSkippedReason: string | null = null
  if (!_syntheticLotsDetected) _syntheticTargetExtraSkippedReason = 'no_synthetic_lots'
  else if (!_syntheticRecoveryTierEligible) _syntheticTargetExtraSkippedReason = 'wallet_value_tier_not_eligible'
  else if (!_runHistoricalCoverage) _syntheticTargetExtraSkippedReason = 'historical_recovery_not_run'
  else if (!GOLDRUSH_KEY) _syntheticTargetExtraSkippedReason = 'provider_not_configured'
  else if (_syntheticLotTokenTargets.length === 0) _syntheticTargetExtraSkippedReason = 'no_synthetic_targets'
  else if (_syntheticTargetExtraEligibleTokens.length === 0) _syntheticTargetExtraSkippedReason = 'already_real_backed_lot_for_target'
  else if (_syntheticTargetExtraPriorBuysFoundSoFar > 0) _syntheticTargetExtraSkippedReason = 'prior_buy_already_found'
  else if (_syntheticTargetExtraPagesAllowed <= 0) _syntheticTargetExtraSkippedReason = 'budget_exhausted'

  const _syntheticTargetExtraRecoveryAttempted = _syntheticTargetExtraSkippedReason === null
  let _syntheticTargetExtraPagesAttempted = 0
  let _syntheticTargetExtraRawLogs = 0
  let _syntheticTargetExtraNormalizedEvents = 0
  let _syntheticTargetExtraInboundEvents = 0
  let _syntheticTargetExtraPriorBuysFound = 0
  let _syntheticTargetExtraCreditUsed = 0
  let _syntheticTargetExtraStopReason: string | null = null
  let _syntheticTargetExtraNewEvidence: WalletTxEvidence[] = []
  let _syntheticTargetExtraChainsAttempted: string[] = []
  let _syntheticTargetExtraSkippedChains: string[] = []
  let _syntheticTargetExtraPageCapHit = false
  let _syntheticTargetExtraNoInboundFound = false
  let _syntheticTargetMarkedUnrecoverable = false
  let _syntheticTargetUnrecoverableReason: string | null = null

  if (_syntheticTargetExtraRecoveryAttempted) {
    const _extraTargetContracts = new Set(_syntheticTargetExtraEligibleTokens)
    const _extraTargetSyntheticLots = _syntheticClosedLots.filter(l => _extraTargetContracts.has(l.tokenAddress.toLowerCase()))
    // SYNTH-RECOVERY-FIX-13: only query the chain(s) the eligible target tokens actually live on
    // (e.g. a Base-only token never queries eth-mainnet) — this is what kept the previous version
    // within its 2-page TOTAL cap instead of 2-pages-per-chain (up to 4 total).
    const _extraTargetOwnChains = new Set(_extraTargetSyntheticLots.map(l => normalizeChainForGoldrush(l.chain)))
    const _extraChainOrder: Array<'base-mainnet' | 'eth-mainnet'> = ['base-mainnet', 'eth-mainnet']
    const _extraChainsToTry = _extraChainOrder.filter(c => _extraTargetOwnChains.has(c))
    _syntheticTargetExtraSkippedChains = _extraChainOrder.filter(c => !_extraTargetOwnChains.has(c))

    let _extraEventsSoFar: PnlEvent[] = []
    let _pagesUsedTotal = 0
    outer: for (const _chain of _extraChainsToTry) {
      if (_pagesUsedTotal >= _syntheticTargetExtraPagesAllowed) { _syntheticTargetExtraPageCapHit = true; break }
      _syntheticTargetExtraChainsAttempted.push(_chain)
      while (_pagesUsedTotal < _syntheticTargetExtraPagesAllowed) {
        const _startPage = _pagesAllowed + _pagesUsedTotal
        const _extraResult = await buildWalletHistoricalCoverage(addrNorm, GOLDRUSH_KEY, 1, walletTradeStatsSummary.closedLots, _extraTargetContracts, _startPage, [_chain])
        _trackCall('goldrush', 'log_events_by_address', false, `gr:hc:synthExtra:${_chain}:p${_startPage}:${addrNorm}`)
        const _extraPagesThisCall = _extraResult.debug?.pagesAttempted ?? 0
        _pagesUsedTotal += _extraPagesThisCall
        _syntheticTargetExtraPagesAttempted += _extraPagesThisCall
        _syntheticTargetExtraCreditUsed += _extraPagesThisCall
        _syntheticTargetExtraRawLogs += _extraResult.debug?.rawLogEvents ?? 0

        // Stop immediately if no target-token logs were found at all on this extra page —
        // move on to the next eligible chain (if any) rather than burning more page budget here.
        if (_extraResult.events.length === 0) break
        _extraEventsSoFar = [..._extraEventsSoFar, ..._extraResult.events]

        const _extraRecovery = buildSyntheticTargetPriorBuyRecovery(_extraEventsSoFar, _extraTargetSyntheticLots)
        _syntheticTargetExtraNormalizedEvents = _extraRecovery.debug.syntheticTargetHistoricalNormalizedEvents
        _syntheticTargetExtraInboundEvents = _extraRecovery.debug.syntheticTargetHistoricalWalletInboundEvents
        _syntheticTargetExtraPriorBuysFound = _extraRecovery.debug.syntheticTargetPriorBuysFound
        _syntheticTargetExtraNewEvidence = _extraRecovery.newCandidateEvidence

        if (_syntheticTargetExtraPriorBuysFound > 0) {
          _syntheticTargetExtraStopReason = 'real_prior_buy_found'
          break outer
        }
        if (_extraPagesThisCall === 0) break // no more pages available on this chain
      }
    }
    if (_pagesUsedTotal >= _syntheticTargetExtraPagesAllowed) _syntheticTargetExtraPageCapHit = true

    if (!_syntheticTargetExtraStopReason) {
      _syntheticTargetExtraNoInboundFound = true
      _syntheticTargetExtraStopReason = 'no_prior_buy_found_after_targeted_pages'
      _syntheticTargetMarkedUnrecoverable = true
      _syntheticTargetUnrecoverableReason = 'no_inbound_target_token_found_after_capped_extra_recovery'
    }
  }

  const _finalCandidateEvidence = _syntheticTargetExtraNewEvidence.length > 0
    ? [
        ..._hcMergedCandidateEvidence,
        ..._syntheticTargetExtraNewEvidence.filter(
          se => !_hcMergedCandidateEvidence.some(e => e.txHash === se.txHash && e.contract === se.contract && e.direction === se.direction)
        ),
      ]
    : _hcMergedCandidateEvidence
  const _finalAllHistoricalEvidence = _syntheticTargetExtraNewEvidence.length > 0
    ? [..._hcMergedAllHistoricalEvidence, ..._syntheticTargetExtraNewEvidence]
    : _hcMergedAllHistoricalEvidence

  // Phase 6C: Historical pricing preview — price the Phase 6B new swap candidates plus any
  // synthetic-target direct-recovered prior buys merged in above (normal pass + targeted extra pages).
  const { summary: walletHistoricalPricingPreviewSummary, debug: _historicalPricingPreviewDebug, pricedEvidence: _hcNewPricedEvidence } =
    _runHistoricalCoverage && _finalCandidateEvidence.length > 0
      ? await buildHistoricalPricingPreview(_finalCandidateEvidence, _finalAllHistoricalEvidence, _reqPriceCache)
      : { summary: { status: 'not_requested' as const, requested: false, newSwapCandidateEvents: 0, pricedHistoricalCandidates: 0, unpricedHistoricalCandidates: 0, stableLegPricedEvents: 0, wethLegPricedEvents: 0, historicalPricedEvents: 0, priceAttemptLimitReached: false, readyForHistoricalFifoPreview: false, missing: ['historical_coverage_not_requested'], reason: null }, debug: undefined, pricedEvidence: [] as WalletTxEvidence[] }
  const _syntheticTargetPriorBuysPriced = _syntheticTargetRecovery
    ? _hcNewPricedEvidence.filter(e => _syntheticTargetRecovery!.newCandidateEvidence.some(se => se.txHash === e.txHash && se.contract === e.contract)).length
    : 0
  const _syntheticTargetExtraPriorBuysPriced = _syntheticTargetExtraNewEvidence.length > 0
    ? _hcNewPricedEvidence.filter(e => _syntheticTargetExtraNewEvidence.some(se => se.txHash === e.txHash && se.contract === e.contract)).length
    : 0
  tokenMeter.measure('priceInference', walletHistoricalPricingPreviewSummary, _historicalPricingPreviewDebug, _hcNewPricedEvidence)
  // Track historical pricing preview price calls
  for (let _hp2 = 0; _hp2 < (_historicalPricingPreviewDebug?.priceAttempts ?? 0); _hp2++) {
    _trackCall('goldrush', 'historical_by_addresses_v2', false, `gr:price:hc:${_hp2}:${addrNorm}`)
  }

  // Phase 6D: Historical FIFO preview — run FIFO on baseline + new priced historical candidates
  const { summary: walletHistoricalFifoPreviewSummary, debug: _historicalFifoPreviewDebug, previewClosedLots: _hcPreviewClosedLots } =
    _runHistoricalCoverage && _hcNewPricedEvidence.length > 0
      ? buildHistoricalFifoPreview(_pricedEvidence, _hcNewPricedEvidence, _closedLots, walletTradeStatsSummary.realizedPnlUsd, walletTradeStatsSummary.realizedPnlPercent ?? null, walletHistoricalPricingPreviewSummary.unpricedHistoricalCandidates)
      : { summary: { status: 'not_requested' as const, requested: false, baselineClosedLots: 0, previewClosedLots: 0, addedClosedLots: 0, baselineRealizedPnlUsd: null, previewRealizedPnlUsd: null, addedRealizedPnlUsd: null, baselineRealizedPnlPercent: null, previewRealizedPnlPercent: null, winningClosedLotsPreview: 0, losingClosedLotsPreview: 0, breakEvenClosedLotsPreview: 0, uniqueTokensPreview: 0, previewConfidence: 'low' as const, readyForHistoricalTradeStatsPreview: false, safeToPromoteToPublicStats: false, missing: ['historical_coverage_not_requested'], reason: null }, debug: undefined, previewClosedLots: [] as WalletClosedLot[] }

  tokenMeter.measure('fifoEngine', walletHistoricalFifoPreviewSummary, _historicalFifoPreviewDebug, _hcPreviewClosedLots)
  _perfWalletTimings.historicalMs += Date.now() - _historicalStartedAt

  // Phase 6E: Safe historical stats promotion
  const _shouldPromote =
    _runHistoricalCoverage &&
    walletHistoricalFifoPreviewSummary.safeToPromoteToPublicStats === true &&
    walletHistoricalFifoPreviewSummary.previewClosedLots > walletHistoricalFifoPreviewSummary.baselineClosedLots &&
    walletHistoricalFifoPreviewSummary.previewRealizedPnlUsd !== null &&
    isFinite(walletHistoricalFifoPreviewSummary.previewRealizedPnlUsd ?? NaN) &&
    walletHistoricalFifoPreviewSummary.addedClosedLots > 0

  const walletTradeStatsSource: WalletSnapshot['walletTradeStatsSource'] = _shouldPromote ? 'historical_promoted_preview' : 'base_sample'

  // ── Final Summary Overwrite: restore reconstruction results if later pipeline phases overwrote them ──
  // BFC (Phase 5C), fallback, and supplemental loops all re-run buildSwapDetection on raw provider
  // events, wiping the manually-promoted isSwapCandidate values from reconstruction passes.
  // If reconstruction produced better summaries than the final pipeline state, restore and re-run FIFO.
  const _preOverwriteSwapCandidates = walletSwapSummary.swapCandidateEvents
  const _preOverwritePricedEvents = walletPriceEvidenceSummary.pricedEvents
  const _preOverwriteOpenedLots = walletLotSummary.openedLots ?? 0
  const _preOverwriteClosedLots = walletLotSummary.closedLots

  // Base unknown reconstruction: saved at line ~7863
  const _baseReconOverwriteNeeded = (
    _reconSavedPricedEvidence !== null &&
    _baseUnknownSwapPricingDebug.pricedAfterReconstruction > 0 &&
    (walletSwapSummary.swapCandidateEvents === 0 || walletPriceEvidenceSummary.pricedEvents === 0)
  )
  // ETH router reconstruction: saved after primary pricing — overwrite needed if BFC/fallback wiped swap candidates
  const _ethReconOverwriteNeeded = (
    _ethReconSavedPricedEvidence !== null &&
    _ethSwapReconstructionDebug.syntheticSwapEventsAdded > 0 &&
    (_ethReconSavedSwapSummary?.swapCandidateEvents ?? 0) > walletSwapSummary.swapCandidateEvents
  )
  const _reconOverwriteNeeded = _baseReconOverwriteNeeded || _ethReconOverwriteNeeded

  // Prefer ETH recon when it has more priced events or more closed lots than base recon
  const _useEthRecon = _ethReconOverwriteNeeded && (
    !_baseReconOverwriteNeeded ||
    (_ethReconSavedPriceSummary?.pricedEvents ?? 0) >= _baseUnknownSwapPricingDebug.pricedAfterReconstruction
  )

  let _finalSummarySourceDebug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['finalSummarySourceDebug']> = {
    swapSummarySource: 'pipeline',
    priceSummarySource: 'pipeline',
    lotSummarySource: 'pipeline',
    tradeStatsSource: 'pipeline',
    reconstructedPricedEvents: _baseUnknownSwapPricingDebug.pricedAfterReconstruction,
    ethReconstructionApplied: false,
    ethReconstructedSwapCandidates: _ethSwapReconstructionDebug.syntheticSwapEventsAdded,
    ethReconstructedPricedEvents: _ethReconSavedPriceSummary?.pricedEvents ?? 0,
    finalPublicSwapCandidatesBefore: _preOverwriteSwapCandidates,
    finalPublicSwapCandidatesAfter: walletSwapSummary.swapCandidateEvents,
    finalPublicPricedEventsBefore: _preOverwritePricedEvents,
    finalPublicPricedEventsAfter: walletPriceEvidenceSummary.pricedEvents,
    finalOpenedLotsBefore: _preOverwriteOpenedLots,
    finalOpenedLotsAfter: walletLotSummary.openedLots ?? 0,
    finalClosedLotsBefore: _preOverwriteClosedLots,
    finalClosedLotsAfter: walletLotSummary.closedLots,
    finalPublicPricedEvents: walletPriceEvidenceSummary.pricedEvents,
    finalPublicSwapCandidates: walletSwapSummary.swapCandidateEvents,
    finalOpenedLots: walletLotSummary.openedLots ?? 0,
    finalClosedLots: walletLotSummary.closedLots,
    summaryOverwriteApplied: false,
    mismatchReason: _reconOverwriteNeeded ? 'pipeline_phase_overwrote_reconstruction' : 'none',
  }

  if (_reconOverwriteNeeded) {
    const _savedSwap = _useEthRecon ? _ethReconSavedSwapSummary! : _reconSavedSwapSummary!
    const _savedPrice = _useEthRecon ? _ethReconSavedPriceSummary! : _reconSavedPriceSummary!
    const _savedEvidence = _useEthRecon ? _ethReconSavedPricedEvidence! : _reconSavedPricedEvidence!
    const _reconSource = _useEthRecon ? 'eth_router_reconstruction' : 'base_unknown_reconstruction'

    walletSwapSummary = _savedSwap
    walletPriceEvidenceSummary = _savedPrice
    let _reconFifoEvidence = normalizeSwapEventsForFifo(_savedEvidence, tokenMeter.isDebugEnabled())
    _reconFifoEvidence = normalizeSingleLegEventsForFifo(_reconFifoEvidence, tokenMeter.isDebugEnabled())
    const _reconFifoResult = buildFifoLotEngine(_reconFifoEvidence, activityRequested)
    walletLotSummary = _reconFifoResult.summary
    _lotEngineDebug = _reconFifoResult.debug
    _closedLots = _reconFifoResult.closedLots
    const _reconTradeStats = buildTradeStatsSummary(_closedLots, activityRequested, totalValue)
    walletTradeStatsSummary = _reconTradeStats.summary
    _tradeStatsDebug = _reconTradeStats.debug
    _outlierDebug = _reconTradeStats.outlierDebug
    _outlierNote = _reconTradeStats.outlierNote
    _pricedEvidence = _reconFifoEvidence
    _finalSummarySourceDebug = {
      swapSummarySource: _reconSource,
      priceSummarySource: _reconSource,
      lotSummarySource: `${_reconSource}_fifo`,
      tradeStatsSource: `${_reconSource}_fifo`,
      reconstructedPricedEvents: _baseUnknownSwapPricingDebug.pricedAfterReconstruction,
      ethReconstructionApplied: _useEthRecon,
      ethReconstructedSwapCandidates: _ethSwapReconstructionDebug.syntheticSwapEventsAdded,
      ethReconstructedPricedEvents: _ethReconSavedPriceSummary?.pricedEvents ?? 0,
      finalPublicSwapCandidatesBefore: _preOverwriteSwapCandidates,
      finalPublicSwapCandidatesAfter: walletSwapSummary.swapCandidateEvents,
      finalPublicPricedEventsBefore: _preOverwritePricedEvents,
      finalPublicPricedEventsAfter: walletPriceEvidenceSummary.pricedEvents,
      finalOpenedLotsBefore: _preOverwriteOpenedLots,
      finalOpenedLotsAfter: walletLotSummary.openedLots ?? 0,
      finalClosedLotsBefore: _preOverwriteClosedLots,
      finalClosedLotsAfter: walletLotSummary.closedLots,
      finalPublicPricedEvents: walletPriceEvidenceSummary.pricedEvents,
      finalPublicSwapCandidates: walletSwapSummary.swapCandidateEvents,
      finalOpenedLots: walletLotSummary.openedLots ?? 0,
      finalClosedLots: walletLotSummary.closedLots,
      summaryOverwriteApplied: true,
      mismatchReason: 'pipeline_phase_overwrote_reconstruction',
    }
    // Update ETH recon debug to reflect final FIFO results
    if (_useEthRecon) {
      _ethSwapReconstructionDebug = {
        ..._ethSwapReconstructionDebug,
        pricedEventsAfter: walletPriceEvidenceSummary.pricedEvents,
        closedLotsAfter: walletLotSummary.closedLots,
        openedLotsAfter: walletLotSummary.openedLots ?? 0,
        swapCandidatesAfter: walletSwapSummary.swapCandidateEvents,
      }
    }
  }

  // ── Stale summary status cleanup ─────────────────────────────────────────────────────────
  // buildSwapDetection runs before reconstruction and may record status/missing from an empty
  // pre-reconstruction state. After the final summary overwrite, patch both summaries so they
  // reflect the actual final candidate counts rather than the stale pre-reconstruction values.
  if (walletSwapSummary.swapCandidateEvents > 0) {
    const _swapMissingClean = walletSwapSummary.missing.filter(m => m !== 'no_swap_candidates_detected')
    const _swapStatusClean: 'ok' | 'partial' | 'open_check' = 'ok'
    if (walletSwapSummary.status !== _swapStatusClean || _swapMissingClean.length !== walletSwapSummary.missing.length) {
      walletSwapSummary = { ...walletSwapSummary, status: _swapStatusClean, missing: _swapMissingClean }
    }
  }
  if (walletTradeStatsSummary.closedLots === 0 && (walletLotSummary.openedLots ?? 0) > 0) {
    const _tradeMissingClean = walletTradeStatsSummary.missing
      .filter(m => m !== 'no_closed_lots' && m !== 'activity_not_requested')
      .concat('no_closed_trades_yet')
    walletTradeStatsSummary = {
      ...walletTradeStatsSummary,
      status: 'partial',
      missing: _tradeMissingClean,
    }
  }

  let promotedLotSummary = walletLotSummary
  let promotedTradeStatsSummary = walletTradeStatsSummary
  if (_shouldPromote && _hcPreviewClosedLots.length > 0) {
    tokenMeter.startTokenMeter('tradeStats')
    tokenMeter.measure('tradeStats', _hcPreviewClosedLots)
    const { summary: previewTradeStats } = buildTradeStatsSummary(_hcPreviewClosedLots, activityRequested)
    // Fix 3: deduplicate missing — buildTradeStatsSummary already adds sample_size_below_win_rate_threshold
    const promotedMissing = Array.from(new Set([...(previewTradeStats.missing ?? []), 'sample_size_below_win_rate_threshold']))
    promotedTradeStatsSummary = {
      ...previewTradeStats,
      // Fix 2: confidence must match previewConfidence, not the raw lot-count-based value
      confidence: walletHistoricalFifoPreviewSummary.previewConfidence,
      winRatePercent: null,
      readyForWalletScore: false,
      missing: promotedMissing,
    }
    // Fix 1: compute preview totals from the actual preview closed lots
    const previewTotalCostBasisClosedUsd = _hcPreviewClosedLots.reduce((s, l) => s + l.costBasisUsd, 0)
    const previewTotalProceedsClosedUsd = _hcPreviewClosedLots.reduce((s, l) => s + l.proceedsUsd, 0)
    tokenMeter.measure('tradeStats', previewTradeStats)
    tokenMeter.endTokenMeter('tradeStats')
    promotedLotSummary = {
      ...walletLotSummary,
      closedLots: walletHistoricalFifoPreviewSummary.previewClosedLots,
      realizedPnlUsd: walletHistoricalFifoPreviewSummary.previewRealizedPnlUsd,
      realizedPnlPercent: walletHistoricalFifoPreviewSummary.previewRealizedPnlPercent,
      totalCostBasisClosedUsd: previewTotalCostBasisClosedUsd,
      totalProceedsClosedUsd: previewTotalProceedsClosedUsd,
      readyForTradeStats: true,
      status: 'ok' as const,
    }
  }

  // SYNTH-RECOVERY-FIX-4: after promotion, count how many synthetic lots remain and how many real
  // prior buys were recovered for the synthetic lots' own target tokens.
  const _syntheticLotsAfterSourceLots = _shouldPromote && _hcPreviewClosedLots.length > 0 ? _hcPreviewClosedLots : _closedLots
  const _syntheticLotsAfterHistorical = _syntheticLotsAfterSourceLots.filter(
    l => l.evidence?.entrySource === 'synthetic' || (l.missingReasons ?? []).includes('fifo_backfilled_buy')
  ).length
  const _realPriorBuysRecoveredForSyntheticLots = _runHistoricalCoverage
    ? Math.max(0, _syntheticLotsBeforeHistorical - _syntheticLotsAfterHistorical)
    : 0
  const _syntheticRecoverySkippedReason = !_syntheticLotsDetected
    ? null
    : !_runHistoricalCoverage
      ? (_skipReasons[0] ?? (!_syntheticRecoveryTierEligible ? 'wallet_value_tier_not_eligible' : 'synthetic_recovery_not_triggered'))
      : _realPriorBuysRecoveredForSyntheticLots > 0
        ? null
        : _syntheticTargetExtraRecoveryAttempted
          ? _syntheticTargetExtraStopReason
          : (Object.entries(_syntheticTargetRecovery?.debug.syntheticTargetDropBreakdown ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'no_prior_buy_found_in_window')
  const _syntheticLotRecoveryDebug = {
    syntheticLotsDetected: _syntheticLotsDetected,
    syntheticLotTokenTargets: _syntheticLotTokenTargets,
    historicalTriggeredBySyntheticLots: _historicalTriggeredBySyntheticLots,
    syntheticLotsBeforeHistorical: _syntheticLotsBeforeHistorical,
    syntheticLotsAfterHistorical: _syntheticLotsAfterHistorical,
    realPriorBuysRecoveredForSyntheticLots: _realPriorBuysRecoveredForSyntheticLots,
    syntheticRecoverySkippedReason: _syntheticRecoverySkippedReason,
    syntheticTargetHistoricalRawLogs: _syntheticTargetRecovery?.debug.syntheticTargetHistoricalRawLogs ?? 0,
    syntheticTargetHistoricalNormalizedEvents: _syntheticTargetRecovery?.debug.syntheticTargetHistoricalNormalizedEvents ?? 0,
    syntheticTargetHistoricalWalletInboundEvents: _syntheticTargetRecovery?.debug.syntheticTargetHistoricalWalletInboundEvents ?? 0,
    syntheticTargetHistoricalWalletOutboundEvents: _syntheticTargetRecovery?.debug.syntheticTargetHistoricalWalletOutboundEvents ?? 0,
    syntheticTargetPriorBuysFound: _syntheticTargetRecovery?.debug.syntheticTargetPriorBuysFound ?? 0,
    syntheticTargetPriorBuysPriced: _syntheticTargetPriorBuysPriced,
    syntheticTargetDropBreakdown: _syntheticTargetRecovery?.debug.syntheticTargetDropBreakdown ?? {},
    // SYNTH-RECOVERY-FIX-12: targeted extra-page recovery debug (synthetic lots' own target
    // tokens only, max 2 extra pages) — see block above where _syntheticTargetExtra* is computed.
    syntheticTargetExtraRecoveryAttempted: _syntheticTargetExtraRecoveryAttempted,
    syntheticTargetExtraPagesAllowed: _syntheticTargetExtraPagesAllowed,
    syntheticTargetExtraPagesAttempted: _syntheticTargetExtraPagesAttempted,
    syntheticTargetExtraRawLogs: _syntheticTargetExtraRawLogs,
    syntheticTargetExtraNormalizedEvents: _syntheticTargetExtraNormalizedEvents,
    syntheticTargetExtraInboundEvents: _syntheticTargetExtraInboundEvents,
    syntheticTargetExtraPriorBuysFound: _syntheticTargetExtraPriorBuysFound,
    syntheticTargetExtraPriorBuysPriced: _syntheticTargetExtraPriorBuysPriced,
    syntheticTargetExtraStopReason: _syntheticTargetExtraStopReason,
    syntheticTargetExtraCreditUsed: _syntheticTargetExtraCreditUsed,
    syntheticTargetExtraSkippedReason: _syntheticTargetExtraSkippedReason,
    syntheticTargetExtraChainsAttempted: _syntheticTargetExtraChainsAttempted,
    syntheticTargetExtraSkippedChains: _syntheticTargetExtraSkippedChains,
    syntheticTargetExtraPageCapHit: _syntheticTargetExtraPageCapHit,
    syntheticTargetExtraNoInboundFound: _syntheticTargetExtraNoInboundFound,
    syntheticTargetMarkedUnrecoverable: _syntheticTargetMarkedUnrecoverable,
    syntheticTargetUnrecoverableReason: _syntheticTargetUnrecoverableReason,
    sampleDroppedHistoricalLogs: _historicalCoverageDebug?.logNormalizationDebug
      ? [
          { reason: 'noTxHash', count: _historicalCoverageDebug.logNormalizationDebug.historicalRawLogsDroppedNoTxHash },
          { reason: 'noTimestamp', count: _historicalCoverageDebug.logNormalizationDebug.historicalRawLogsDroppedNoTimestamp },
          { reason: 'noContract', count: _historicalCoverageDebug.logNormalizationDebug.historicalRawLogsDroppedNoContract },
          { reason: 'noAmount', count: _historicalCoverageDebug.logNormalizationDebug.historicalRawLogsDroppedNoAmount },
          { reason: 'noWalletSide', count: _historicalCoverageDebug.logNormalizationDebug.historicalRawLogsDroppedNoWalletSide },
          { reason: 'nonTargetToken', count: _historicalCoverageDebug.logNormalizationDebug.historicalRawLogsDroppedNonTargetToken },
          { reason: 'decodeFailed', count: _historicalCoverageDebug.logNormalizationDebug.historicalRawLogsDroppedDecodeFailed },
          { reason: 'duplicate', count: _historicalCoverageDebug.logNormalizationDebug.historicalRawLogsDroppedDuplicate },
        ].sort((a, b) => b.count - a.count)
      : [],
    sampleSyntheticTargetPriorBuys: _syntheticTargetRecovery?.debug.sampleSyntheticTargetPriorBuys ?? [],
  }

  // Phase 6F/6G: Build public closed trade samples (max 5) with blockchain verification fields
  const _sampleSourceLots = _shouldPromote && _hcPreviewClosedLots.length > 0 ? _hcPreviewClosedLots : _closedLots
  const walletClosedTradeSamples: WalletSnapshot['walletClosedTradeSamples'] = _sampleSourceLots.slice(0, 5).map(l => {
    const entryTxHash = l.openedTxHash ?? null
    const exitTxHash = l.closedTxHash ?? null
    const verificationStatus: 'verifiable' | 'partial' | 'not_available' =
      entryTxHash && exitTxHash ? 'verifiable' : (entryTxHash || exitTxHash) ? 'partial' : 'not_available'
    return {
      tokenSymbol: l.tokenSymbol ?? l.tokenAddress.slice(0, 8),
      tokenAddress: l.tokenAddress,
      chain: l.chain,
      openedAt: l.openedAt,
      closedAt: l.closedAt,
      holdingTimeSeconds: l.holdingTimeSeconds,
      amountClosed: l.amountClosed,
      entryPriceUsd: l.entryPriceUsd,
      exitPriceUsd: l.exitPriceUsd,
      realizedPnlUsd: l.realizedPnlUsd,
      realizedPnlPercent: l.realizedPnlPercent,
      confidence: l.confidence,
      entryTxHash,
      exitTxHash,
      verificationStatus,
    }
  })

  const _grEthAttempted = _shouldFetchGrEth
  const _grBaseAttempted = activityRequested && Boolean(GOLDRUSH_KEY)
  const _alchemyAttempted = _alchemyActivityFallbackAttempted
  const _txSkippedReasons: string[] = []
  if (!activityRequested) {
    _txSkippedReasons.push('activity_not_requested')
  } else {
    if (!GOLDRUSH_KEY) _txSkippedReasons.push('goldrush_not_configured')
    if (_goldrushEthSkippedReason) _txSkippedReasons.push(_goldrushEthSkippedReason)
    else if (!_shouldFetchGrEth && Boolean(GOLDRUSH_KEY)) _txSkippedReasons.push('goldrush_eth_not_selected_for_activity')
    if (!ALCHEMY_BASE_KEY) _txSkippedReasons.push('alchemy_not_configured')
  }
  const _txProviderErrors: string[] = []
  const _grEthErrMsg = 'fetchErrorMessage' in grEth.diag ? (grEth.diag as GoldrushHistoryDiag).fetchErrorMessage : undefined
  const _grBaseErrMsg = 'fetchErrorMessage' in grBase.diag ? (grBase.diag as GoldrushHistoryDiag).fetchErrorMessage : undefined
  if (_grEthErrMsg) _txProviderErrors.push(`grEth: ${_grEthErrMsg}`)
  if (_grBaseErrMsg) _txProviderErrors.push(`grBase: ${_grBaseErrMsg}`)
  const _txEvidenceDebug = {
    ..._txEvidenceDebugBase,
    sourceProvider: _pnlSourceRaw,
    activityRequested,
    eventFetchAttempted: _grEthAttempted || _grBaseAttempted || _alchemyAttempted,
    goldrushEthAttempted: _grEthAttempted,
    goldrushBaseAttempted: _grBaseAttempted,
    alchemyAttempted: _alchemyAttempted,
    goldrushEthRawCount: grEth.diag.rawItemCount ?? 0,
    goldrushBaseRawCount: grBase.diag.rawItemCount ?? 0,
    alchemyRawCount: alchemyEvents.length,
    goldrushEthSkippedReason: _goldrushEthSkippedReason,
    ethValueUsd: _ethDiscoveredValue,
    ethActivityThresholdUsd: _ethActivityThresholdUsd,
    ethActivityEligible: _ethActivityEligible,
    ethActivitySkippedReason: _ethActivitySkippedReason,
    normalizedPnlEventCount: events.length,
    totalEvidenceEvents: _txEvidenceDebugBase.totalRawEvents,
    eventsWithTxHash: _txEvidenceDebugBase.eventsWithHash,
    missingHashCount: _txEvidenceDebugBase.totalRawEvents - _txEvidenceDebugBase.eventsWithHash,
    missingTimestampCount: _txEvidenceDebugBase.totalRawEvents - _txEvidenceDebugBase.eventsWithTimestamp,
    skippedReasons: _txSkippedReasons,
    providerErrorSamples: _txProviderErrors.slice(0, 3),
    // PHASE4-FIX-7: surface "one provider failed but we kept going" as a non-fatal partial
    // state instead of letting a single provider error collapse the whole scan. True only
    // when at least one provider errored AND at least one other provider still produced events.
    providerCoveragePartial: _txProviderErrors.length > 0 && events.length > 0,
  }
  const unpricedHoldingsCount = holdings.filter((h) => !h.price || h.price <= 0).length
  const hiddenDustCount = holdings.filter((h) => h.value <= 1).length
  const behaviorTxCount = behaviorValue.txCount ?? 0
  const hasHistoricalBaseActivity = grEvents.length > 0
  const walletBehavior = behaviorTxCount === 0 && hasHistoricalBaseActivity
    ? { ...behaviorValue, recentActivitySummary: 'Historical Base activity found, but no recent activity in checked window.' }
    : behaviorValue
  const goldrushConfigured = Boolean(GOLDRUSH_KEY)
  const goldrushReason = !goldrushConfigured
    ? 'History provider unavailable.'
    : activityProviderUnavailable
      ? 'Activity history unavailable from current checks.'
    : grEvents.length === 0
      ? 'No indexed wallet transfer history returned from current checks.'
      : valuedGrEvents.length === 0
        ? 'Transfer history returned but no valued events for cost-basis estimation.'
        : ''
  const alchemyConfigured = Boolean(ALCHEMY_BASE_KEY)
  const _zerionSucceeded = _zerionValueUsable || _zerionPositionsUsable
  if (process.env.NODE_ENV !== 'production' && tokenMeter.isDebugEnabled()) {
    console.log('[wallet-diag] route=/api/wallet deepScan=', deepScan, 'requestedChain=', requestedChain, 'zerionValueUsable=', _zerionValueUsable, 'zerionPositionsUsable=', _zerionPositionsUsable, 'moralisHoldingsUsable=', _moralisHoldingsUsable, 'goldrushBalancesSkipped=', _goldrushBalancesSkipped, 'goldrushEventsReturned=', grEvents.length, 'pnlSource=', pnlSource, 'providerUsed=', providerUsed, 'totalMs=', Date.now() - startedAt)
  }

  const alchemyBaseUsed = Boolean(ALCHEMY_BASE_KEY)
  const walletProviderRouting = {
    primaryProviders: [
      ...(ZERION_KEY ? ['zerion'] : []),
      ...(GOLDRUSH_KEY ? ['goldrush'] : []),
      ...(process.env.MORALIS_API_KEY ? ['moralis'] : []),
    ],
    alchemyUsed: alchemyBaseUsed,
    alchemyMethods: alchemyBaseUsed
      ? ['alchemy_getAssetTransfers', 'eth_getTransactionCount']
      : [],
    alchemyChainsUsed: [
      ...(useEthAlchemy ? ['eth'] : []),
      ...(alchemyBaseUsed ? ['base'] : []),
    ],
    alchemyReason: useEthAlchemy
      ? 'first_tx_both_chains_nonce_eth_plus_base_behavior'
      : 'base_first_tx_nonce_and_behavior_only',
    skippedAlchemyChains: useEthAlchemy ? [] : (ALCHEMY_ETH_KEY ? ['eth'] : []),
    pageLoadTriggered: false,
    zerionSucceeded: _zerionValueUsable || _zerionPositionsUsable,
    goldrushBalancesSkipped: _goldrushBalancesSkipped,
    deepScan,
  }

  const hasHistory = estimatedPnl.status !== 'unavailable'
  const snapshotTtlMs = hasHistory ? SNAPSHOT_HISTORY_TTL_MS : SNAPSHOT_TTL_MS
  const { facts: walletFacts, debug: _walletFactsDebug } = buildWalletFacts(holdings, totalValue, _swapEvidenceWithDetection, addrNorm, _closedLots.length)

  // Build unified apiAudit from the per-request _apiCallLog (instrumented at each provider call site)
  const _logByProvider = (p: 'moralis' | 'goldrush' | 'alchemy') => _apiCallLog.filter(e => e.provider === p)
  const _liveCalls = (p: 'moralis' | 'goldrush' | 'alchemy') => _logByProvider(p).filter(e => !e.cacheHit && !e.duplicate)
  const _dupEntries = _apiCallLog.filter(e => e.duplicate)
  // SYNTH-RECOVERY-FIX-13: keep base historical-recovery credits and synthetic-extra-recovery
  // credits as distinct counters — _historicalCreditsUsedFinal/_creditsUsedFinal below is the
  // TOTAL used for hard-cap enforcement, but the budget debug surfaces them separately so synthetic
  // extra pages are never mistaken for ordinary historical-recovery pages.
  const _historicalBaseCreditsUsed = _historicalCoverageDebug?.pagesAttempted ?? 0
  const _historicalCreditsUsedFinal = _historicalBaseCreditsUsed + _syntheticTargetExtraCreditUsed
  // SYNTH-RECOVERY-FIX-11: buildWalletHistoricalCoverage's `maxPages` argument (passed in as
  // _pagesAllowed) is a PER-CHAIN page cap — it fetches up to maxPages pages from base-mainnet AND
  // up to maxPages pages from eth-mainnet, so pagesAttempted (their sum) can legitimately be up to
  // 2x _pagesAllowed. Comparing the total pagesAttempted against the per-chain _pagesAllowed (as
  // the old budgetCapHit check did) produced a false "cap hit" whenever a single chain returned
  // exactly its own per-chain allowance. Compare against the correct total (_pagesAllowed * chain
  // count) instead — informational only, does not change how many pages are actually fetched.
  const _historicalChainCount = 2 // chains fetched inside buildWalletHistoricalCoverage: base-mainnet + eth-mainnet
  const _historicalMaxPagesPerChain = _pagesAllowed
  const _historicalMaxPagesTotal = _pagesAllowed * _historicalChainCount
  const _creditsUsedFinal = _portfolioCreditsUsed + _activityCreditsUsed + (_priceBudgetDebug.finalPriceAttempts ?? 0) + _historicalCreditsUsedFinal
  const _historicalBudgetCapHit = _runHistoricalCoverage && _historicalCreditsUsedFinal >= _historicalMaxPagesTotal && walletHistoricalCoverageSummary.coverageLevel !== 'none'
  const _historicalBudgetCapReason = _historicalBudgetCapHit ? 'historical_phase_cap_reached_total_pages' : null
  const _budgetCapHitFinal = _creditsUsedFinal >= _totalCreditHardCap || _historicalBudgetCapHit
  const _walletScanBudgetDebug = {
    scanMode: historicalCoverage ? 'historical' : activityRequested ? 'deep' : 'basic',
    requestedHistoricalScan: historicalCoverage,
    walletValueTier: _walletValueTier,
    totalCreditTarget: _totalCreditTarget,
    totalCreditHardCap: _totalCreditHardCap,
    creditsUsed: _creditsUsedFinal,
    creditsRemaining: Math.max(0, _totalCreditHardCap - _creditsUsedFinal),
    budgetByPhase: { portfolio: 2, activity: 3, pricing: historicalCoverage ? 6 : (_priceBudgetDebug.maxBudget ?? 12), historicalRecovery: 6 },
    portfolioCreditsUsed: _portfolioCreditsUsed,
    activityCreditsUsed: _activityCreditsUsed,
    pricingCreditsUsed: _priceBudgetDebug.finalPriceAttempts ?? 0,
    historicalCreditsUsed: _historicalBaseCreditsUsed,
    syntheticTargetExtraCreditUsed: _syntheticTargetExtraCreditUsed,
    budgetCapHit: _budgetCapHitFinal,
    budgetCapReason: _creditsUsedFinal >= _totalCreditHardCap ? 'total_hard_cap_reached' : _historicalBudgetCapReason,
    callsSkippedAfterBudgetCap: Math.max(0, clampedMaxHistoricalPages - _pagesAllowed),
    estimatedCreditsSavedByCache: 0,
    whalePrioritisationUsed: _walletValueTier === 'whale',
    adminOverrideUsed: _adminOverrideUsed,
  }
  const _walletHistoricalScanDebug = {
    requested: historicalCoverage,
    eligible: _historicalEligible,
    eligibilityReasons: _eligibilityReasons,
    walletValueTier: _walletValueTier,
    targetTokens: _rankedHistoricalTargets.map(t => t.contract),
    targetTokenRankingReason: _rankedHistoricalTargets.map(t => ({ contract: t.contract, symbol: t.symbol, reasons: t.reasons, estimatedUsd: t.estimatedUsd })),
    pagesAllowed: _pagesAllowed,
    pagesAttempted: _historicalCoverageDebug?.pagesAttempted ?? 0,
    // SYNTH-RECOVERY-FIX-11: pagesAllowed/pagesAttempted above are ambiguous about whether the
    // figure is per-chain or total (buildWalletHistoricalCoverage applies maxPages PER chain across
    // base-mainnet + eth-mainnet). These explicit fields disambiguate the unit without changing fetch behavior.
    historicalMaxPagesPerChain: _historicalMaxPagesPerChain,
    historicalMaxPagesTotal: _historicalMaxPagesTotal,
    historicalPagesAttemptedTotal: _historicalCoverageDebug?.pagesAttempted ?? 0,
    historicalPagesAttemptedByChain: Object.fromEntries(
      Object.entries(_historicalCoverageDebug?.chainCoverage ?? {}).map(([chain, c]) => [chain, c.pages])
    ),
    historicalCreditBudget: _historicalMaxPagesTotal,
    historicalCreditsUsed: _historicalBaseCreditsUsed,
    syntheticTargetExtraCreditUsed: _syntheticTargetExtraCreditUsed,
    historicalBudgetCapHit: _historicalBudgetCapHit,
    historicalBudgetCapReason: _historicalBudgetCapReason,
    rawEventsFetched: _historicalCoverageDebug?.rawLogEvents ?? 0,
    normalizedEvents: walletHistoricalCoverageSummary.normalizedEvents ?? 0,
    priorBuysFound: (_historicalCandidateDebug?.sampleNewSwapCandidates ?? []).filter(e => e.direction === 'buy').length,
    priorSellsFound: (_historicalCandidateDebug?.sampleNewSwapCandidates ?? []).filter(e => e.direction === 'sell').length,
    closedLotsBefore: walletHistoricalFifoPreviewSummary.baselineClosedLots ?? walletTradeStatsSummary.closedLots,
    closedLotsAfter: walletHistoricalFifoPreviewSummary.previewClosedLots ?? walletTradeStatsSummary.closedLots,
    openedLotsBefore: _lotEngineDebug.openedLots ?? 0,
    openedLotsAfter: walletLotSummary.openedLots ?? 0,
    realizedPnlBefore: walletHistoricalFifoPreviewSummary.baselineRealizedPnlUsd ?? walletTradeStatsSummary.realizedPnlUsd,
    realizedPnlAfter: walletHistoricalFifoPreviewSummary.previewRealizedPnlUsd ?? walletTradeStatsSummary.realizedPnlUsd,
    addedClosedLots: walletHistoricalFifoPreviewSummary.addedClosedLots ?? 0,
    addedOpenedLots: Math.max(0, (walletLotSummary.openedLots ?? 0) - (_lotEngineDebug.openedLots ?? 0)),
    estimatedCreditUnits: _historicalCreditsUsedFinal,
    cacheHit: false,
    budgetCapHit: _walletScanBudgetDebug.budgetCapHit,
    stopReason: _historicalCoverageDebug?.stoppedReason ?? (_skipReasons[0] ?? null),
    skippedReasons: _skipReasons,
    sampleTargets: _rankedHistoricalTargets.slice(0, 5),
    sampleRecoveredEvents: _historicalCandidateDebug?.sampleNewSwapCandidates ?? [],
  }

  const _apiTotalCredits = _apiCallLog.reduce((s, e) => s + e.credits, 0)
  const _apiWarnings: string[] = []
  if (activityRequested && Boolean(ALCHEMY_BASE_KEY)) _apiWarnings.push('alchemy_base_activity_deferred_until_goldrush_empty')
  if (_walletBehaviorReusedActivityEvents) _apiWarnings.push('wallet_behavior_reused_activity_events')
  if (_walletBehaviorSkippedDuplicateAlchemy) _apiWarnings.push('wallet_behavior_skipped_duplicate_alchemy')
  _apiWarnings.push('moralis_warmup_removed')
  const _moralisLiveCount = _liveCalls('moralis').length
  const _grLiveCount = _liveCalls('goldrush').length
  const _alchemyCount = _logByProvider('alchemy').length
  if (_apiTotalCredits > 5) _apiWarnings.push(`total_credits_${_apiTotalCredits}_exceeds_target_5`)
  if (_moralisLiveCount > 3) _apiWarnings.push(`moralis_${_moralisLiveCount}_calls_expected_3`)
  if (_grLiveCount > 4) _apiWarnings.push(`goldrush_${_grLiveCount}_calls_expected_4`)
  if (_alchemyCount > 8) _apiWarnings.push(`alchemy_${_alchemyCount}_calls_expected_8`)
  if (_dupEntries.length > 0) _apiWarnings.push(`${_dupEntries.length}_duplicate_call(s)_detected`)
  const _apiAudit = {
    moralis: {
      calls: _moralisLiveCount,
      endpoints: _liveCalls('moralis').map(e => e.endpoint),
      credits: _logByProvider('moralis').reduce((s, e) => s + e.credits, 0),
    },
    goldrush: {
      calls: _grLiveCount,
      endpoints: _liveCalls('goldrush').map(e => e.endpoint),
      credits: _logByProvider('goldrush').reduce((s, e) => s + e.credits, 0),
    },
    alchemy: {
      calls: _alchemyCount,
      endpoints: _logByProvider('alchemy').map(e => e.endpoint),
      credits: 0,
    },
    duplicates: _dupEntries.map(e => `${e.provider}:${e.endpoint}:${e.dupKey}`),
    warnings: _apiWarnings,
    totalCredits: _apiTotalCredits,
  }
  // Activity routing debug: summarises all chain/activity routing decisions for observability
  const _walletActivityRoutingDebug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletActivityRoutingDebug']> = (() => {
    const _actChainsUsed: MoralisChain[] = []
    if (_grEthAttempted) _actChainsUsed.push('eth')
    if (_grBaseAttempted && !_actChainsUsed.includes('base')) _actChainsUsed.push('base')
    if (_alchemyAttempted && !_actChainsUsed.includes('base')) _actChainsUsed.push('base')
    if (_moralisFbDebug.fallbackActivityAttempted && !_actChainsUsed.includes(_fbChain as MoralisChain)) _actChainsUsed.push(_fbChain as MoralisChain)
    for (const c of _p19ScannedChains) { if (!(_actChainsUsed as string[]).includes(c as string)) _actChainsUsed.push(c) }
    const _actSkipReason = !activityRequested
      ? 'deep_activity_not_requested'
      : !Boolean(GOLDRUSH_KEY) && !Boolean(ALCHEMY_BASE_KEY) && !Boolean(process.env.MORALIS_API_KEY)
      ? 'provider_unavailable'
      : walletEvidenceSummary.totalEvents === 0 && activityProviderUnavailable
      ? 'activity_provider_returned_empty'
      : null
    // Chains discovered with significant value but no activity provider covers them
    const _activityOnlyChains = new Set(['eth', 'base'])  // chains with dedicated activity providers
    const _significantDiscovered = discoveredChains.filter(c => c.usdValue >= minChainValueUsd)
    const _unsupported = _significantDiscovered.filter(c => !supportedMoralisChains.includes(c.chain)).map(c => c.chain as string)
    // Supported chains cut by the activeChains cap (chains that were in discoveredChains but not in activeChains)
    const _excByCap = _significantDiscovered.filter(c => supportedMoralisChains.includes(c.chain) && !activeChains.includes(c.chain)).map(c => c.chain as string)
    // Supported, in activeChains for portfolio, but no dedicated activity provider and not scanned in any phase
    const _excByProviderSafety = _significantDiscovered.filter(c =>
      supportedMoralisChains.includes(c.chain) && !_activityOnlyChains.has(c.chain) &&
      c.chain !== _fbChain && !(_p19ScannedChains as string[]).includes(c.chain as string)
    ).map(c => c.chain as string)
    const _notScannedForActivity = _significantDiscovered.filter(c => !(_actChainsUsed as string[]).includes(c.chain as string)).map(c => c.chain as string)
    return {
      deepActivityRequested: deepActivity,
      chainMode,
      requestedChain,
      discoveredChains: discoveredChains.slice(0, 10).map(c => ({ chain: c.chain as string, usdValue: c.usdValue })),
      activeChainsBeforeValueGate: _activeChainsBeforeValueGate as string[],
      activeChainsAfterValueGate: _activeChainsAfterValueGate as string[],
      activeChainsUsedForActivity: _actChainsUsed as string[],
      chainsDiscoveredNotScannedForActivity: _notScannedForActivity,
      chainsExcludedByCap: _excByCap,
      chainsExcludedByUnsupported: _unsupported,
      chainsExcludedByProviderSafety: _excByProviderSafety,
      minChainValueUsd,
      skippedDustChains: skippedDustChains as string[],
      portfolioStatus: providerStatus,
      holdingsCount: holdings.length,
      totalValue,
      activityAttempted: activityRequested,
      activitySkippedReason: _actSkipReason,
      ethActivityEligible: _ethActivityEligible,
      ethActivitySkippedReason: _ethActivitySkippedReason,
      ethValueUsd: _ethDiscoveredValue,
      ethActivityThresholdUsd: _ethActivityThresholdUsd,
      lowBalanceOverrideUsed: _lowBalanceOverrideUsed,
      fallbackChainsUsed: _fallbackChainsUsed as string[],
      providerCallsPlanned: [
        ...(_shouldFetchGrEth ? ['goldrush:eth'] : []),
        ...(_grBaseAttempted ? ['goldrush:base'] : []),
        ...(_alchemyAttempted ? ['alchemy:base'] : []),
        ...(activityRequested && Boolean(process.env.MORALIS_API_KEY) ? [`moralis:${_fbChain}_if_primary_empty`] : []),
        ...(_p18ShouldRun ? [`moralis:${_p18SupplementChain}_supplement`] : []),
        ...(_p19ShouldRun ? _p19EligibleChains.map(c => `moralis:${c.chain}_p19_supplement`) : []),
      ],
      providerCallsMade: [
        ...(_grEthAttempted ? ['goldrush:eth'] : []),
        ...(_grBaseAttempted ? ['goldrush:base'] : []),
        ...(_alchemyAttempted ? ['alchemy:base'] : []),
        ...(_moralisFbDebug.fallbackActivityAttempted ? [`moralis:${_fbChain}`] : []),
        ...(_phase18Debug.attempted ? [`moralis:${_p18SupplementChain}_supplement`] : []),
        ..._p19ScannedChains.map(c => `moralis:${c}_p19`),
      ],
      evidenceEvents: walletEvidenceSummary.totalEvents,
      finalEvidenceStatus: walletEvidenceSummary.status,
    }
  })()

  // Chain activity merge debug: captures the full story of how multi-chain activity was selected/merged
  const _walletChainActivityMergeDebug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletChainActivityMergeDebug']> = (() => {
    const _ethEvCount = grEth.events.length > 0 ? grEth.events.length
      : (_fbChain === 'eth' && _moralisFbDebug.fallbackActivityUsed) ? _moralisFbDebug.fallbackActivityNormalizedEvents
      : (_phase18Debug.attempted && _p18SupplementChain === 'eth') ? _phase18Debug.moralisSupplementNormalizedEvents
      : 0
    const _baseEvCount = grBase.events.length > 0 ? grBase.events.length
      : (_fbChain === 'base' && _moralisFbDebug.fallbackActivityUsed) ? _moralisFbDebug.fallbackActivityNormalizedEvents
      : (_phase18Debug.attempted && _p18SupplementChain === 'base') ? _phase18Debug.moralisSupplementNormalizedEvents
      : alchemyEvents.length > 0 ? alchemyEvents.length
      : 0
    const _ethAttempted = _grEthAttempted || (_fbChain === 'eth' && _moralisFbDebug.fallbackActivityAttempted) || (_phase18Debug.attempted && _p18SupplementChain === 'eth')
    const _baseAttempted = _grBaseAttempted || _alchemyAttempted || (_fbChain === 'base' && _moralisFbDebug.fallbackActivityAttempted) || (_phase18Debug.attempted && _p18SupplementChain === 'base')
    const _actChainsForMerge: string[] = []
    if (_ethAttempted) _actChainsForMerge.push('eth')
    if (_baseAttempted) _actChainsForMerge.push('base')
    // Compute portfolio value by chain directly from holdings using the same strip logic as walletFacts
    // so 'eth-mainnet' → 'eth', 'ethereum' → 'eth', etc. — avoids mapChain returning null for some formats
    let _ethTotalValue = 0, _baseTotalValue = 0
    for (const h of holdings) {
      const _hc = (h.chain ?? '').toLowerCase().replace(/-mainnet$/, '')
      if (_hc === 'eth' || _hc.includes('ethereum')) _ethTotalValue += h.value ?? 0
      else if (_hc === 'base' || _hc.includes('base')) _baseTotalValue += h.value ?? 0
    }
    const _primaryChain = _ethTotalValue > _baseTotalValue ? 'eth' : 'base'
    const _baseOnlyMisleading = _ethTotalValue > 1 && _baseEvCount > 0 && _ethEvCount === 0
      && (_ethTotalValue / Math.max(_ethTotalValue + _baseTotalValue, 1)) > 0.5
    const _ethGateSkippedReason = (
      _ethActivitySkippedReason === 'eth_below_activity_value_gate' ||
      _goldrushEthSkippedReason === 'eth_below_activity_value_gate'
    )
      ? 'eth_below_activity_value_gate'
      : null
    const _ethSkipReason = !_ethAttempted
      ? (
        _ethGateSkippedReason ??
        _ethActivitySkippedReason ??
        _goldrushEthSkippedReason ??
        (_ethTotalValue <= 1 ? 'eth_activity_skipped_no_eth_holdings' : 'eth_activity_provider_unavailable')
      )
      : _ethEvCount === 0 ? 'eth_activity_provider_returned_empty'
      : null
    const _baseSkipReason = !_baseAttempted
      ? 'base_activity_skipped_no_base_holdings'
      : _baseEvCount === 0 ? 'base_activity_provider_returned_empty'
      : null
    const _reasonPrimary = _ethTotalValue > _baseTotalValue
      ? `eth_value_${Math.round(_ethTotalValue)}_dominates_base_value_${Math.round(_baseTotalValue)}`
      : `base_value_${Math.round(_baseTotalValue)}_dominates_eth_value_${Math.round(_ethTotalValue)}`
    const _allEvents = walletEvidenceSummary ? [] as PnlEvent[] : [] as PnlEvent[] // placeholder — merge happened earlier
    const _sampleEth = grEth.events.length > 0 ? grEth.events : (_fbChain === 'eth' ? [] : (_phase18Debug.attempted && _p18SupplementChain === 'eth' ? [] : []))
    const _sampleBase = grBase.events.length > 0 ? grBase.events : (_fbChain === 'base' ? [] : (_phase18Debug.attempted && _p18SupplementChain === 'base' ? [] : []))
    const _toSample = (evs: PnlEvent[]) => evs.slice(0, 3).map(e => ({ txHash: e.txHash, symbol: e.symbol, direction: e.direction, chain: e.chain }))
    return {
      chainMode,
      requestedChain,
      portfolioValueByChain: { eth: _ethTotalValue, base: _baseTotalValue },
      activeChainsUsedForActivity: _actChainsForMerge,
      ethActivityAttempted: _ethAttempted,
      ethActivityEvents: _ethEvCount,
      baseActivityAttempted: _baseAttempted,
      baseActivityEvents: _baseEvCount,
      mergedEventsBeforeCap: _budgetEventsBefore,
      mergedEventsAfterCap: _budgetEventsAfterCap,
      selectedPrimaryChain: _primaryChain,
      reasonPrimaryChainSelected: _reasonPrimary,
      baseOnlyActivityWouldBeMisleading: _baseOnlyMisleading,
      ethSkippedReason: _ethSkipReason,
      baseSkippedReason: _baseSkipReason,
      sampleEthEvents: _toSample(_sampleEth),
      sampleBaseEvents: _toSample(_sampleBase),
      sampleMergedEvents: events.slice(0, 3).map(e => ({ txHash: e.txHash, symbol: e.symbol, direction: e.direction, chain: e.chain })),
    }
  })()

  const snapshot: WalletSnapshot = {
    address: addr,
    totalValue,
    holdings,
    txCount,
    firstTxDate: firstTxDate?.toISOString() ?? null,
    walletAgeDays,
    providerUsed,
    portfolioSource: providerUsed,
    providerStatus,
    holdingsCount: holdings.length,
    totalUsdAvailable: totalValue > 0,
    reason,
    behaviorSource: walletBehavior.source,
    behaviorChain: 'base',
    pnlSource: pnlSourcePublic,
    pnlCoverageReason,
    hiddenDustCount,
    unpricedHoldingsCount,
    walletBehavior,
    estimatedPnl,
    walletEvidenceSummary,
    walletSwapSummary,
    walletPriceEvidenceSummary,
    walletLotSummary: promotedLotSummary,
    walletTradeStatsSummary: promotedTradeStatsSummary,
    walletTradeStatsSource,
    tokenUsage: EMPTY_TOKEN_USAGE(),
    walletClosedTradeSamples,
    walletClosedLotsAll: _sampleSourceLots,
    walletHistoricalCoverageSummary,
    walletHistoricalCandidateSummary,
    walletHistoricalPricingPreviewSummary,
    walletHistoricalFifoPreviewSummary,
    walletFacts,
    dataFreshness: 'live',
    cacheAgeSeconds: null,
    _diagnostics: {
      syntheticLotRecoveryDebug: _syntheticLotRecoveryDebug,
      providers: {
        zerion: { configured: Boolean(ZERION_KEY), attempted: true, succeeded: _zerionValueUsable || _zerionPositionsUsable },
        goldrush: {
          configured: goldrushConfigured,
          balancesAttempted: !_goldrushBalancesSkipped && goldrushConfigured,
          transactionsAttempted: activityRequested && goldrushConfigured,
          transfersAttempted: activityRequested && goldrushConfigured,
          eventsReturned: grEvents.length,
          valuedEventsReturned: valuedGrEvents.length,
          pnlEventsUsable: filteredPnlTokens.length,
          reason: goldrushReason,
          endpointKind: grBase.diag?.endpointKind,
          chainUsed: grBase.diag?.chainUsed,
          httpStatus: grBase.diag?.httpStatus ?? null,
          rawItemCount: grBase.diag?.rawItemCount,
          normalizedEventCount: grBase.diag?.normalizedEventCount,
          firstEventShapeKeys: grBase.diag?.firstEventShapeKeys,
          transferArrayCount: (grBase.diag as GoldrushHistoryDiag | undefined)?.transferArrayCount ?? 0,
        },
        alchemy: {
          configured: alchemyConfigured,
          behaviorAttempted: alchemyConfigured,
          transfersReturned: behaviorTxCount,
          reason: walletBehavior.reason,
        },
        moralis: {
          configured: Boolean(process.env.MORALIS_API_KEY),
          attempted: [..._moralisByChain.values()].some((r) => r.attempted),
          usable: [..._moralisByChain.values()].some((r) => r.usable),
          holdingsReturned: [..._moralisByChain.values()].reduce((n, r) => n + r.holdings.length, 0),
          cacheHit: [..._moralisByChain.values()].some((r) => r.cacheHit),
          reason: [..._moralisByChain.values()].map((r) => r.reason).find(Boolean) || '',
        },
      },
      walletProviderFieldsPresent: {
        holdings: holdings.length > 0,
        totalValue: totalValue > 0,
        txCount: txCount !== null,
        walletAgeDays: walletAgeDays !== null,
      },
      missingReasons: [
        holdings.length === 0 ? `holdings: ${reason}` : '',
        totalValue === 0 ? 'totalValue: no priced holdings found' : '',
        txCount === null ? 'txCount: Alchemy nonce unavailable' : '',
        walletAgeDays === null ? 'walletAgeDays: no first-tx on ETH or Base' : '',
      ].filter(Boolean),
      goldrushTransferDiags: [grEth.diag, grBase.diag],
      snapshotCache: {
        memoryHit: false, persistentHit: false, providerFetchNeeded: true,
        refreshBypassedCache: refresh, cacheAgeSeconds: null, cacheTtlSeconds: snapshotTtlMs / 1000,
        cacheVersion: SNAPSHOT_SCHEMA_VERSION, cacheBypassReason: refresh ? 'refresh' : null, debugFreshBypassedPersistentCache: false,
      },
      providerFallback: {
        primaryAttempted: _grPrimaryAttempted,
        primaryUsable: _grPrimaryUsable,
        fallbackAttempted: [..._moralisByChain.values()].some((r) => r.attempted),
        fallbackUsed: _moralisUsed,
        tertiaryAttempted: _grPrimaryAttempted,
        tertiaryUsed: !_moralisUsed && _grPrimaryUsable,
        fallbackReason: _preFallbackReason,
        cacheHit: [..._moralisByChain.values()].some((r) => r.cacheHit),
        reason: _moralisUsed
          ? 'moralis_holdings_used'
          : holdings.length > 0
          ? 'primary_ok'
          : 'all_providers_empty',
      },
      moralisUsage: {
        attempted: [..._moralisByChain.values()].some((r) => r.attempted),
        endpointNames: ['erc20_holdings'],
        requestedChain: activeChains[0] ?? requestedChain,
        callCount: [..._moralisByChain.values()].filter((r) => r.attempted).length,
        cacheHit: [..._moralisByChain.values()].some((r) => r.cacheHit),
        deduped: false,
        durationMs: Date.now() - startedAt,
        skippedReason: [..._moralisByChain.values()].length === 0 ? 'fallback_not_needed' : null,
      },
      providerFlow: {
        chainMode,
        supportedChains: supportedMoralisChains,
        minChainValueUsd,
        discoveredChains,
        activeChains,
        skippedDustChains,
        maxChainsBasicScan,
        moralisChainsAttempted: [..._moralisByChain.entries()].filter(([,r]) => r.attempted).map(([c]) => c),
        moralisCallCount: [..._moralisByChain.values()].filter((r) => r.attempted).length,
        cacheHits: [..._moralisByChain.values()].filter((r) => r.cacheHit).length,
        dedupedCalls: 0,
        partialFailures: [..._moralisByChain.values()].filter((r) => r.attempted && !r.usable).length,
        goldrushAttempted: _grPrimaryAttempted,
        goldrushSkippedReason: _grPrimaryAttempted ? null : (_moralisUsed ? 'moralis_holdings_available' : 'not_required'),
      },
      chainUsage: {
        requestedChain,
        chainMode,
        activeChains,
        alchemyChainsAttempted: [
          ...(useEthAlchemy ? ['eth'] : []),
          'base',
        ],
        skippedChains: supportedMoralisChains.filter((c) => !activeChains.includes(c)),
        reason: chainMode === 'all_supported' && !deepScan
          ? 'all_supported_requires_deep_scan; reverted to discovered or fallback chains'
          : activeChains.length > 0
          ? 'active_chain_gating_applied'
          : 'fallback_base_eth',
      },
      walletProviderRouting,
      walletActivityRequestDebug: {
        primaryActivityAttempted,
        primaryActivityFailed,
        primaryActivityStatusCode,
        primaryActivityErrorKind,
        fallbackActivityAttempted,
        fallbackActivityUsed,
        fallbackActivityReason,
        finalEvidenceStatus: walletEvidenceSummary.status,
      },
      walletTxEvidenceDebug: _txEvidenceDebug,
      walletSwapDetectionDebug: _swapDetectionDebug,
      walletPriceAtTimeDebug: _priceAtTimeDebug,
      walletPriceBudgetDebug: _priceBudgetDebug,
      walletScanBudgetDebug: _walletScanBudgetDebug,
      walletHistoricalScanDebug: _walletHistoricalScanDebug,
      unmatchedSellBackfillDebug: _unmatchedSellBackfillDebug,
      walletLotEngineDebug: _lotEngineDebug,
      walletPnlOutlierDebug: _outlierDebug,
      walletTradeStatsDebug: _tradeStatsDebug,
      walletHistoricalCoverageDebug: _historicalCoverageDebug,
      walletHistoricalCandidateDebug: _historicalCandidateDebug,
      walletHistoricalPricingPreviewDebug: _historicalPricingPreviewDebug,
      walletHistoricalFifoPreviewDebug: _historicalFifoPreviewDebug,
      walletActivityFallbackDebug: { ..._moralisFbDebug, finalEvidenceStatus: walletEvidenceSummary.status },
      walletBudgetDebug: {
        eventsBefore: _budgetEventsBefore,
        eventsAfterDedup: _budgetEventsAfterDedup,
        eventsAfterCap: _budgetEventsAfterCap,
        budgetCapped: _budgetCapped,
        dedupRemoved: _budgetEventsBefore - _budgetEventsAfterDedup,
        capLimit: _ACTIVITY_MAX_EVENTS,
        // PHASE4-FIX-8 (item 3): structured event-cap transparency, additive on this already-
        // diagnostics-only object — cappedCount/cappedProviders plus reason keys for whichever
        // cap(s) were actually hit (the soft per-token cap above, vs. a hard provider-side cap).
        cappedCount: _cappedCount,
        cappedProviders: _cappedProviders,
        reasons: [
          ...(_budgetCapped ? ['event_cap_hit'] : []),
          ...(_cappedProviders.length > 0 ? ['provider_event_cap_hit'] : []),
          // PHASE4-FIX-9 (item 6): coverage_value_weighted_low, computed above near coveragePercentValueWeighted.
          ...(_coverageValueWeightedLow ? ['coverage_value_weighted_low'] : []),
        ],
      },
      walletSwapEnrichmentDebug: _swapEnrichmentDebug,
      ethSwapReconstructionDebug: _ethSwapReconstructionDebug,
      basePnlReconstructionDebug: _basePnlReconDebug,
      baseUnknownSwapReconstructionDebug: _baseUnknownSwapReconDebug,
      baseUnknownSwapPricingDebug: _baseUnknownSwapPricingDebug,
      finalSummarySourceDebug: _finalSummarySourceDebug,
      baseFifoCoverageDebug: _baseFifoCoverageDebug,
      walletActivityRoutingDebug: _walletActivityRoutingDebug,
      walletChainActivityMergeDebug: _walletChainActivityMergeDebug,
      walletEthNormalizationDebug: _walletEthNormalizationDebug,
      walletFactsDebug: _walletFactsDebug,
      apiAudit: _apiAudit,
      alchemyEnvDebug: _alchemyEnvDebug,
      tradeStatsInputDebug: _tradeStatsInputDebug,
      walletPerformanceDebug: (() => {
        const now = Date.now()
        _perfPhaseTs.total_end = now
        const phaseDurations: Record<string, number> = {}
        const keys = Object.keys(_perfPhaseTs)
        for (let i = 1; i < keys.length; i++) {
          const label = keys[i].replace(/_done$|_end$/, '')
          phaseDurations[label] = (_perfPhaseTs[keys[i]] ?? now) - (_perfPhaseTs[keys[i - 1]] ?? startedAt)
        }
        const totalDurationMs = now - startedAt
        const bottleneckEntry = Object.entries(phaseDurations).sort((a, b) => b[1] - a[1])[0]
        return {
          totalDurationMs,
          chainDiscoveryMs: _perfWalletTimings.chainDiscoveryMs,
          holdingsMs: _perfWalletTimings.holdingsMs,
          portfolioMs: _perfWalletTimings.holdingsMs,
          activityMs: _perfWalletTimings.activityMs,
          swapDetectionMs: _perfWalletTimings.swapDetectionMs,
          pricingMs: _perfWalletTimings.pricingMs,
          fifoMs: _perfWalletTimings.fifoMs,
          tradeStatsMs: _perfWalletTimings.tradeStatsMs,
          historicalMs: _perfWalletTimings.historicalMs,
          phaseDurations,
          providerDurations: {
            phase1_providers: (_perfPhaseTs.phase1_done ?? now) - startedAt,
            chain_discovery: _perfWalletTimings.chainDiscoveryMs,
            activity_fetch: _perfWalletTimings.activityMs,
          },
          parallelizedCalls: _perfParallelized,
          reusedCachedActivity: false,
          duplicateCallsAvoided: 0,
          timedOutModules: _perfTimedOut,
          modulesSkippedBecauseNotNeeded: _perfSkipped,
          deepBudgetHit: totalDurationMs > 20000,
          bottleneck: bottleneckEntry ? `${bottleneckEntry[0]}: ${bottleneckEntry[1]}ms` : null,
        }
      })(),
    },
  }
  // Attach Phase 19 debug (typed as any — not in the strict diagnostics type)
  if (snapshot._diagnostics) (snapshot._diagnostics as Record<string, unknown>).phase19MultiChainSupplementDebug = _phase19Debug
  tokenMeter.startTokenMeter('debugLogging')
  tokenMeter.measure('debugLogging', snapshot._debug, snapshot._diagnostics, walletFacts)
  tokenMeter.endTokenMeter('debugLogging')
  if (tokenMeter.wasDebugAutoDisabled()) snapshot.debugAutoDisabled = true
  snapshot.tokenUsage = tokenMeter.snapshot()

  // Public activity coverage note: surface when meaningful chains were discovered but not scanned
  const _chainDisplayName: Partial<Record<MoralisChain, string>> = {
    bsc: 'BNB Smart Chain', polygon: 'Polygon', arbitrum: 'Arbitrum',
    optimism: 'Optimism', avalanche: 'Avalanche', fantom: 'Fantom',
    cronos: 'Cronos', gnosis: 'Gnosis',
  }
  const _actRoutingDbg = snapshot._diagnostics?.walletActivityRoutingDebug
  if (_actRoutingDbg && activityRequested) {
    const _notScanned = (_actRoutingDbg.chainsDiscoveredNotScannedForActivity ?? []).filter(c => c !== 'eth' && c !== 'base')
    if (_notScanned.length > 0) {
      const _scannedNames = (_actRoutingDbg.activeChainsUsedForActivity ?? []).map(c => {
        if (c === 'eth') return 'ETH'
        if (c === 'base') return 'Base'
        return _chainDisplayName[c as MoralisChain] ?? c.toUpperCase()
      })
      const _skippedNames = _notScanned.map(c => _chainDisplayName[c as MoralisChain] ?? c.toUpperCase())
      const _scannedStr = _scannedNames.length > 0 ? _scannedNames.join(' and ') : 'detected chains'
      snapshot.walletActivityCoverageNote = `Trading evidence covers ${_scannedStr} activity. ${_skippedNames.join(', ')} activity was detected but not included in this scan — trade stats may be incomplete.`
    }
  }

  // Outlier note: surface if any lots were quarantined
  if (_outlierNote) snapshot.walletPnlOutlierNote = _outlierNote

  // Pricing coverage note: show when budget cap limited coverage or expansion improved results
  if (_priceBudgetDebug) {
    if (_priceBudgetDebug.budgetCapHit && (_priceBudgetDebug.finalPriceAttempts ?? 0) > 0) {
      snapshot.walletPricingCoverageNote = `Some older or lower-confidence trades were left unpriced to keep the scan cost-safe.`
    }
    if (_priceBudgetDebug.expansionEligible && _priceBudgetDebug.pass2PricedEvents > 0) {
      snapshot.walletPricingCoverageNote = `Extra pricing pass recovered ${_priceBudgetDebug.pass2PricedEvents} additional matched lot${_priceBudgetDebug.pass2PricedEvents !== 1 ? 's' : ''}.`
    }
  }

  // Set wallet value tier on snapshot
  snapshot.walletValueTier = _walletValueTier

  // Set historical scan note
  if (!historicalCoverage || !activityRequested) {
    if (_walletValueTier !== 'micro' && activityRequested) {
      snapshot.walletHistoricalScanNote = 'Recent activity sample only — deeper history available on request.'
    }
  } else if (!_historicalEligible) {
    snapshot.walletHistoricalScanNote = 'Historical scan skipped — ' + (_skipReasons[0]?.replace(/_/g, ' ') ?? 'not eligible') + '.'
  } else if (_walletHistoricalScanDebug.addedClosedLots > 0) {
    const added = _walletHistoricalScanDebug.addedClosedLots
    snapshot.walletHistoricalScanNote = `Older entries recovered — ${added} additional lot${added !== 1 ? 's' : ''} matched from historical scan.`
  } else if (_walletHistoricalScanDebug.budgetCapHit) {
    snapshot.walletHistoricalScanNote = 'Deep history capped for cost safety — recent activity sample shown.'
  } else if (_walletHistoricalScanDebug.pagesAttempted === 0) {
    snapshot.walletHistoricalScanNote = 'Historical scan checked — no target tokens identified.'
  } else {
    snapshot.walletHistoricalScanNote = 'Historical scan checked — no extra history needed.'
  }

  // Requirement 8: validate audit before returning — if unhealthy, surface warnings prominently
  if (_apiAudit.warnings.length > 0 && snapshot._diagnostics?.apiAudit) {
    snapshot._diagnostics.apiAudit.warnings = _apiAudit.warnings
  }

  // PHASE6-FIX-2/3/4/5: Confidence / Completeness / PnL Integrity pass. Runs last, after the
  // snapshot object is fully assembled, so it can read the final promoted lot/trade-stats
  // summaries without affecting any of the existing fields above. Entirely additive — every
  // field it sets is new and optional on WalletSnapshot.
  try {
    const _p6OpenLots = fifoResult.openLots ?? []
    const _p6ClosedLots = snapshot.walletClosedLotsAll ?? []
    const _p6CoveragePercent = snapshot.estimatedPnl?.coveragePercent ?? null
    const _p6ProviderFailures = _txProviderErrors.length > 0

    const _p6Confidence = walletPnlConfidence({
      closedLots: _p6ClosedLots,
      openLots: _p6OpenLots,
      coveragePercent: _p6CoveragePercent,
      unmatchedSells: promotedLotSummary.unmatchedSells ?? 0,
      unmatchedBuys: promotedLotSummary.unmatchedBuys ?? 0,
      providerFailures: _p6ProviderFailures,
      reasons: [],
    })

    // PHASE6-FIX-3b: missing-price-events ratio from the price-at-time pass summary, and
    // missing-swap-legs ratio from the FIFO engine's unmatched buy/sell counts vs total lots.
    const _p6SwapCandidateEvents = walletPriceEvidenceSummary?.swapCandidateEvents ?? 0
    const _p6PricedEvents = walletPriceEvidenceSummary?.pricedEvents ?? 0
    const _p6MissingPriceEventsRatio = _p6SwapCandidateEvents > 0
      ? Math.max(0, Math.min(1, (_p6SwapCandidateEvents - _p6PricedEvents) / _p6SwapCandidateEvents))
      : 0
    const _p6UnmatchedLegs = (promotedLotSummary.unmatchedBuys ?? 0) + (promotedLotSummary.unmatchedSells ?? 0)
    const _p6TotalLegs = _p6UnmatchedLegs + _p6OpenLots.length + _p6ClosedLots.length
    const _p6MissingSwapLegsRatio = _p6TotalLegs > 0 ? Math.max(0, Math.min(1, _p6UnmatchedLegs / _p6TotalLegs)) : 0

    const _p6Completeness = pnlCompletenessScore({
      matchedTokenKeys: _lotEngineDebug?.matchedTokenKeys ?? 0,
      buyTokenKeys: _lotEngineDebug?.uniqueBuyTokenKeys ?? 0,
      sellTokenKeys: _lotEngineDebug?.uniqueSellTokenKeys ?? 0,
      coveragePercentValueWeighted: _p6CoveragePercent,
      truncated: Boolean(_priceBudgetDebug?.budgetCapHit) || Boolean(_walletHistoricalScanDebug?.budgetCapHit),
      missingPriceEventsRatio: _p6MissingPriceEventsRatio,
      missingSwapLegsRatio: _p6MissingSwapLegsRatio,
    })

    // PHASE6-FIX-4: synthetic-lot ratio and missing-reasons count feeding the new integrity status.
    const _p6SyntheticLotCount = [
      ..._p6ClosedLots.filter(l => l.evidence.entrySource === 'current_holding_price_open_lot_estimate' || l.evidence.exitSource === 'current_holding_price_open_lot_estimate'),
      ..._p6OpenLots.filter(l => l.priceSource === 'current_holding_price_open_lot_estimate'),
    ].length
    const _p6TotalLotCount = _p6OpenLots.length + _p6ClosedLots.length
    const _p6MissingReasonsCount = snapshot._diagnostics?.missingReasons?.length ?? 0
    const _p6PriceFailureRatio = _p6SwapCandidateEvents > 0 ? _p6MissingPriceEventsRatio : null

    const _p6PortfolioDeltaUsd = snapshot.estimatedPnl?.totalEstimatedPnlUsd ?? null
    const _p6Integrity = integrityCheckPnl({
      openLots: _p6OpenLots,
      closedLots: _p6ClosedLots,
      realizedPnlUsd: promotedLotSummary.realizedPnlUsd ?? null,
      unrealizedPnlUsd: snapshot.estimatedPnl?.unrealizedPnlUsd ?? null,
      portfolioDeltaUsd: _p6PortfolioDeltaUsd,
      coveragePercent: _p6CoveragePercent,
      syntheticLotCount: _p6SyntheticLotCount,
      totalLotCount: _p6TotalLotCount,
      missingReasonsCount: _p6MissingReasonsCount,
      priceFailureRatio: _p6PriceFailureRatio,
    })

    // PHASE5-FIX-6: every reasons/missing array in this file (this Set-deduped spread pattern,
    // and the `missing.push(...)` calls throughout buildTradeStatsSummary/buildFifoLotEngine/
    // buildWalletHistoricalCoverage/walletBudgetDebug.reasons etc.) is append-only — there is no
    // site in this file that replaces an existing missing/missingReasons/reasons/skippedReasons
    // array with a literal `= [...]` overwrite. On integrity violations: downgrade the
    // confidence tier and append normalized reasons — never mutate the underlying PnL numbers
    // themselves.
    let _p6FinalTier = _p6Confidence.tier
    let _p6Reasons = _p6Confidence.reasons
    if (!_p6Integrity.ok) {
      _p6FinalTier = _p6FinalTier === 'high' ? 'medium' : 'low'
      _p6Reasons = Array.from(new Set([...(_p6Reasons ?? []), PHASE6_REASON_KEYS.partialCoverage]))
    }
    if (_p6Completeness.reasons.length > 0) {
      _p6Reasons = Array.from(new Set([...(_p6Reasons ?? []), ..._p6Completeness.reasons]))
    }

    snapshot.pnlConfidenceScore = _p6Confidence.score
    snapshot.pnlConfidenceTier = _p6FinalTier
    snapshot.pnlCompletenessScore = _p6Completeness.score
    snapshot.isPnlPartial = _p6Completeness.isPartial
    snapshot.pnlIntegrityCheck = { ok: _p6Integrity.ok, violations: _p6Integrity.violations, status: _p6Integrity.status }

    // Append new normalized Phase 6 reason keys to the existing _diagnostics.missingReasons
    // array additively — existing entries are preserved untouched.
    if (snapshot._diagnostics && _p6Reasons.length > 0) {
      snapshot._diagnostics.missingReasons = Array.from(new Set([...(snapshot._diagnostics.missingReasons ?? []), ..._p6Reasons]))
    }

    snapshot.walletProfileHints = deriveWalletProfileHints({
      closedLotsCount: promotedTradeStatsSummary.closedLots ?? 0,
      walletAgeDays: snapshot.walletAgeDays,
      avgHoldingTimeSeconds: promotedTradeStatsSummary.avgHoldingTimeSeconds ?? null,
      winRatePercent: promotedTradeStatsSummary.winRatePercent ?? null,
      meaningfulClosedLots: promotedTradeStatsSummary.meaningfulClosedLots ?? 0,
      dustClosedLots: promotedTradeStatsSummary.dustClosedLots ?? 0,
      holdingsValueUsd: holdings.map(h => h.value ?? 0),
    })
    if ((promotedTradeStatsSummary.dustClosedLots ?? 0) > 0 && snapshot._diagnostics) {
      snapshot._diagnostics.missingReasons = Array.from(new Set([...(snapshot._diagnostics.missingReasons ?? []), PHASE6_REASON_KEYS.dustAdjustedPnl]))
    }

    // PHASE6-FIX-5b: data-quality hint array — additive field, computed from the same signals
    // already gathered above. Appended (never overwriting) onto any pre-existing array.
    const _p6UnstablePriceSourceCount = [..._p6ClosedLots.filter(l => l.evidence.entrySource === 'provider_event_usd' || l.evidence.exitSource === 'provider_event_usd'), ..._p6OpenLots.filter(l => l.priceSource === 'provider_event_usd')].length
    const _p6NewDataQualityHints = deriveWalletDataQualityHints({
      coveragePercent: _p6CoveragePercent,
      syntheticLotRatio: _p6TotalLotCount > 0 ? _p6SyntheticLotCount / _p6TotalLotCount : 0,
      unstablePriceSourceCount: _p6UnstablePriceSourceCount,
      totalPricedLegCount: _p6TotalLotCount,
      missingSwapLegsRatio: _p6MissingSwapLegsRatio,
      isPnlPartial: _p6Completeness.isPartial,
    })
    if (_p6NewDataQualityHints.length > 0) {
      snapshot.walletDataQualityHints = Array.from(new Set([...(snapshot.walletDataQualityHints ?? []), ..._p6NewDataQualityHints]))
    }
  } catch {
    // PHASE6: confidence/completeness/integrity signals are best-effort diagnostics — never let
    // a failure here block returning the otherwise-valid snapshot.
  }

  validateWalletFactsShape(snapshot)

  // Evidence-regression guard: never let a transient/partial fetch (provider timeout, skipped
  // backfill on a normal scan, pagination cut short, etc.) score weaker than the strongest
  // trade/PnL evidence already verified for this address. Compare against the address-keyed
  // verifiedEvidenceCache (independent of the holdings/activity cacheKey split above) and restore
  // the prior verified fields onto this snapshot if the live result regressed.
  let evidenceCacheSource: 'live' | 'evidence_guard_restored' = 'live'
  if (/^0x[0-9a-fA-F]{40}$/i.test(addrNorm)) {
    const liveClosedLots = snapshot.walletTradeStatsSummary?.closedLots ?? snapshot.walletLotSummary?.closedLots ?? 0
    const livePnlStatus = snapshot.estimatedPnl?.status
    const verified = verifiedEvidenceCache.get(addrNorm)
    const verifiedFresh = verified && (Date.now() - verified.cachedAt) <= VERIFIED_EVIDENCE_TTL_MS
    const livePnlIsWorse = (status: string | undefined) => status === 'unavailable' || status === 'error'
    const regressed = verifiedFresh && (
      liveClosedLots < verified.closedLots ||
      (livePnlIsWorse(livePnlStatus) && !livePnlIsWorse(verified.estimatedPnlStatus))
    )
    if (regressed && verified) {
      snapshot.walletLotSummary = verified.walletLotSummary
      snapshot.walletTradeStatsSummary = verified.walletTradeStatsSummary
      snapshot.estimatedPnl = verified.estimatedPnl
      snapshot.walletHistoricalCoverageSummary = verified.walletHistoricalCoverageSummary
      evidenceCacheSource = 'evidence_guard_restored'
    } else {
      const closedLotsForCache = evidenceCacheSource === 'live' ? liveClosedLots : verified?.closedLots ?? liveClosedLots
      verifiedEvidenceCache.set(addrNorm, {
        cachedAt: Date.now(),
        closedLots: closedLotsForCache,
        estimatedPnlStatus: livePnlStatus,
        walletLotSummary: snapshot.walletLotSummary,
        walletTradeStatsSummary: snapshot.walletTradeStatsSummary,
        estimatedPnl: snapshot.estimatedPnl,
        walletHistoricalCoverageSummary: snapshot.walletHistoricalCoverageSummary,
      })
    }
  }

  snapshot.walletProfile = computeWalletProfile(snapshot)

  const debugFacts = snapshot.walletFacts
  const debugSummary = debugFacts?.summary
  const debugChainExposure = debugSummary?.chainExposure ?? []
  const debugHoldings = Array.isArray(snapshot.holdings) ? snapshot.holdings : []
  snapshot.walletProfileDebug = {
    scoreInputs: {
      totalValueUsd: Number.isFinite(snapshot.totalValue) ? snapshot.totalValue : 0,
      holdingsCount: debugHoldings.length,
      chainCount: debugChainExposure.length || new Set(debugHoldings.map((h) => h.chain).filter(Boolean)).size,
      concentrationLabel: debugSummary?.concentrationLabel ?? null,
      closedLots: snapshot.walletTradeStatsSummary?.closedLots ?? snapshot.walletLotSummary?.closedLots ?? 0,
      winRatePercent: snapshot.walletTradeStatsSummary?.winRatePercent ?? null,
      economicSignificance: snapshot.walletTradeStatsSummary?.economicSignificance ?? null,
      estimatedPnlStatus: snapshot.estimatedPnl?.status ?? null,
      estimatedPnlConfidence: snapshot.estimatedPnl?.confidence ?? null,
    },
    evidenceCoverage: snapshot.walletProfile?.evidenceCoverage ?? 0,
    cacheSource: evidenceCacheSource,
    profileVersion: SNAPSHOT_SCHEMA_VERSION,
  }

  if (/^0x[0-9a-fA-F]{40}$/i.test(addrNorm)) snapshotMemCache.set(cacheKey, { snapshot, cachedAt: Date.now(), ttlMs: snapshotTtlMs })
  return snapshot
}
