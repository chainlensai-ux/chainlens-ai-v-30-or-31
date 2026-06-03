import { fetchMoralisBalances, fetchMoralisTransfers, type MoralisFetchResult, type MoralisChain, type MoralisTransferItem } from './moralis'


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
  estimatedPnl: {
    status: 'ok' | 'partial' | 'unavailable' | 'error'
    confidence: 'high' | 'medium' | 'low' | null
    coveragePercent: number
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
  walletFacts?: WalletFacts
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
      normalizedPnlEventCount?: number
      totalEvidenceEvents?: number
      eventsWithTxHash?: number
      missingHashCount?: number
      missingTimestampCount?: number
      skippedReasons?: string[]
      providerErrorSamples?: string[]
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
      priceAttemptLimitReached: boolean
      skippedNoTimestamp: number
      skippedNoTokenAddress: number
      skippedNoAmount: number
      cacheHits: number
      cacheMisses: number
      providerAttempts: number
      providerErrors: number
      samplePricedEvents: Array<{ txHash: string; contract: string; symbol: string; direction: string; amount: number; priceUsd: number | null; source: string; confidence: string; reason: string }>
      sampleOpenCheckEvents: Array<{ txHash: string; contract: string; symbol: string; reason: string }>
      reasons: string[]
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
      skippedStableQuoteAssets: number
      skippedMissingFields: number
      totalCostBasisClosedUsd: number | null
      totalProceedsClosedUsd: number | null
      realizedPnlUsd: number | null
      realizedPnlPercent: number | null
      sampleOpenLots: Array<{ tokenAddress: string; symbol: string; chain: string; openedAt: string; amountRemaining: number; entryPriceUsd: number; confidence: string }>
      sampleClosedLots: Array<{ tokenAddress: string; symbol: string; openedAt: string; closedAt: string; amountClosed: number; entryPriceUsd: number; exitPriceUsd: number; realizedPnlUsd: number; confidence: string }>
      sampleUnmatchedSells: Array<{ txHash: string; tokenAddress: string; symbol: string; amount: number; exitPriceUsd: number }>
      reasons: string[]
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
    }
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
  }
}

const ZERION_KEY       = process.env.ZERION_KEY ?? ''
const ALCHEMY_ETH_KEY  = process.env.ALCHEMY_ETHEREUM_KEY!
const ALCHEMY_BASE_KEY = process.env.ALCHEMY_BASE_KEY!
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
  // Balancer
  '0xba12222222228d8ba445958a75a0704d566bf2c8',
  // Curve
  '0x99a58482bd75cbab83b27ec03ca68ff489b5788f',
  '0xf0d4c12a5768d806021f80a262b4d39d26c58b8d',
  // BaseSwap
  '0x327df1e6de05895d2ab08513aadd9313fe505d86',
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
  maxFallbackPages?: number
  debug?: boolean
  maxDebugTokens?: number
}

const SNAPSHOT_TTL_MS         = 5  * 60 * 1000
const SNAPSHOT_HISTORY_TTL_MS = 15 * 60 * 1000
const SNAPSHOT_SCHEMA_VERSION = 'v8'
type SnapshotCacheEntry = { snapshot: WalletSnapshot; cachedAt: number; ttlMs: number }
const snapshotMemCache = new Map<string, SnapshotCacheEntry>()

const HISTORICAL_COVERAGE_TTL_MS = 10 * 60 * 1000
type WalletHistoricalCoverageOutput = {
  summary: WalletSnapshot['walletHistoricalCoverageSummary']
  debug: NonNullable<WalletSnapshot['_diagnostics']>['walletHistoricalCoverageDebug']
  events: PnlEvent[]
}
const historicalCoverageCache = new Map<string, { data: WalletHistoricalCoverageOutput; cachedAt: number }>()
const historicalCoverageInFlight = new Map<string, Promise<WalletHistoricalCoverageOutput>>()

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
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'UniswapUniversalRouter_ETH',
  '0x198ef79f1f515f02dfe9e3115ed9fc07183f02fc': 'UniswapUniversalRouter_Base',
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43': 'Aerodrome',
}

const SWAP_ENRICHMENT_TTL_MS = 45 * 60 * 1000
const swapEnrichmentReceiptCache = new Map<string, { data: { isSwap: boolean; reason: string }; exp: number }>()

const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const STABLE_USD_CONTRACTS: Record<string, true> = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': true,
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': true,
  '0xdac17f958d2ee523a2206206994597c13d831ec7': true,
  '0x6b175474e89094c44da98b954eedeac495271d0f': true,
}

const WETH_CONTRACTS_PRICE: Record<string, true> = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': true,
  '0x4200000000000000000000000000000000000006': true,
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
      const receipt = await alchemyRpc(alchemyUrl, 'eth_getTransactionReceipt', [txHash])
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

async function getFirstTxOnChain(address: string, alchemyUrl: string): Promise<Date | null> {
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
  return dates.length > 0 ? new Date(Math.min(...dates.map(d => d.getTime()))) : null
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
}

export type PriceAtTimeEvidence = {
  status: 'priced' | 'open_check' | 'unavailable'
  tokenAddress: string
  tokenSymbol?: string | null
  timestamp: string
  priceUsd: number | null
  source: 'stable_leg' | 'weth_leg' | 'historical_price' | 'swap_derived' | 'current_price_fallback_not_used' | 'unavailable'
  confidence: 'high' | 'medium' | 'low' | 'open_check'
  reason: string
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
  timestamp: string | null
  fromAddress: string | null
  toAddress: string | null
  chain: string
  txFromAddress?: string | null
  txToAddress?: string | null
  txSucceeded?: boolean | null
  isSwapCandidate?: boolean
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
      const firstTransferKeysCapture: string[] = []
      const events = items.flatMap((it) => {
        const t = it as Record<string, unknown>
        const txHash = String(t.tx_hash ?? '')
        const timestamp = String(t.block_signed_at ?? '')
        const txToAddress = String(t.to_address ?? '').toLowerCase()
        const txFromAddress = String(t.from_address ?? '').toLowerCase()
        const transfers: unknown[] = Array.isArray(t.transfers) ? t.transfers : []
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
      }).filter(e => e.contract.startsWith('0x') && e.amount > 0)
      diag.transferArrayCount = transferArrayCount
      diag.firstTransferKeys = firstTransferKeysCapture
      diag.normalizedEventCount = events.length
      if (items.length > 0 && transferArrayCount === 0) {
        diag.reason = 'Transactions returned but no decoded ERC20 Transfer log events found (logs may be unavailable for this API plan).'
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
): Promise<{ pageNum: number; chain: string; httpStatus: number | null; rawItems: number; transferLogs: number; events: PnlEvent[]; error: string | null; newestTimestamp: string | null }> {
  const result = { pageNum, chain: chainName, httpStatus: null as number | null, rawItems: 0, transferLogs: 0, events: [] as PnlEvent[], error: null as string | null, newestTimestamp: null as string | null }
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
      const logEvents: unknown[] = Array.isArray(t.log_events) ? t.log_events : []
      for (const logEvent of logEvents) {
        const le = logEvent as Record<string, unknown>
        const decoded = le.decoded as Record<string, unknown> | null | undefined
        if (!decoded || decoded.name !== 'Transfer') continue
        const params = Array.isArray(decoded.params) ? (decoded.params as Record<string, unknown>[]) : []
        const fromParam = params.find(p => p.name === 'from')
        const toParam = params.find(p => p.name === 'to')
        const valueParam = params.find(p => p.name === 'value')
        if (!fromParam || !toParam || !valueParam) continue
        result.transferLogs++
        const contract = String(le.sender_address ?? '').toLowerCase()
        const symbol = String(le.sender_contract_ticker_symbol ?? '?')
        const decimals = typeof le.sender_contract_decimals === 'number' ? le.sender_contract_decimals : 18
        const from = String(fromParam.value ?? '').toLowerCase()
        const to = String(toParam.value ?? '').toLowerCase()
        const rawValue = String(valueParam.value ?? '0')
        const amount = Math.abs(parseFloat(rawValue) / Math.pow(10, decimals))
        const direction: 'buy' | 'sell' | 'unknown' = to === lower ? 'buy' : from === lower ? 'sell' : 'unknown'
        if (contract.startsWith('0x') && amount > 0) {
          result.events.push({ contract, symbol, direction, amount, amountRaw: rawValue !== '0' ? rawValue : null, tokenDecimals: decimals, usdValue: null, txHash, timestamp, fromAddress: from, toAddress: to, chain: chainName, txFromAddress, txToAddress, txSucceeded })
        }
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
): Promise<WalletHistoricalCoverageOutput> {
  const emptyDebug = (reason: string): WalletHistoricalCoverageOutput => ({
    summary: { status: 'open_check', requested: true, pagesAttempted: 0, maxPages, rawTransactions: 0, rawLogEvents: 0, normalizedEvents: 0, walletSideEvents: 0, swapLikeTransactions: 0, pricedSwapCandidates: null, matchedClosedLotsBefore, matchedClosedLotsAfter: null, addedClosedLots: null, coverageLevel: 'none', missing: ['provider_not_configured'], reason },
    debug: { requested: true, providersAttempted: [], pagesAttempted: 0, pageSize: 50, maxPages, cursorUsed: false, stoppedReason: reason, rawTransactions: 0, rawLogEvents: 0, decodedTransferLogs: 0, walletSideEvents: 0, candidateSwapTxs: 0, candidateSwapEvents: 0, duplicateTxHashes: 0, duplicateEvents: 0, oldestTimestamp: null, newestTimestamp: null, chainCoverage: {}, providerErrorSamples: [], skippedReasons: [reason], sampleTxHashes: [], sampleSwapLikeTransactions: [], moralisHistoricalConfigured: false, moralisHistoricalAttempted: false, moralisReason: 'moralis_history_not_wired_yet' },
    events: [],
  })
  if (!apiKey) return emptyDebug('goldrush_not_configured')

  const pageSize = 50
  const chains = ['base-mainnet', 'eth-mainnet'] as const
  const chainCoverage: Record<string, { pages: number; transactions: number; events: number }> = {}
  const allEvents: PnlEvent[] = []
  const errorSamples: string[] = []
  let totalRawTx = 0
  let totalTransferLogs = 0
  let pagesAttempted = 0
  let stoppedReason = 'max_pages_reached'
  const newestTimestamps: string[] = []

  for (const chain of chains) {
    chainCoverage[chain] = { pages: 0, transactions: 0, events: 0 }
    for (let page = 0; page < maxPages; page++) {
      pagesAttempted++
      const r = await fetchGoldrushHistoricalPage(address, chain, apiKey, page)
      if (r.error) { errorSamples.push(`${chain} p${page}: ${r.error}`); stoppedReason = 'provider_error'; break }
      chainCoverage[chain].pages++
      chainCoverage[chain].transactions += r.rawItems
      chainCoverage[chain].events += r.events.length
      totalRawTx += r.rawItems
      totalTransferLogs += r.transferLogs
      allEvents.push(...r.events)
      if (r.newestTimestamp) newestTimestamps.push(r.newestTimestamp)
      if (r.rawItems < pageSize || r.rawItems === 0) { stoppedReason = 'page_partial_or_empty'; break }
    }
  }

  // Deduplicate by txHash+contract+direction+rounded-amount
  const seen = new Set<string>()
  let dupEvents = 0
  const uniqueEvents: PnlEvent[] = []
  for (const ev of allEvents) {
    const k = `${ev.txHash}|${ev.contract}|${ev.direction}|${Math.round(ev.amount * 1e6)}`
    if (seen.has(k)) { dupEvents++; continue }
    seen.add(k)
    uniqueEvents.push(ev)
  }
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

  return {
    summary: { status, requested: true, pagesAttempted, maxPages, rawTransactions: totalRawTx, rawLogEvents: totalTransferLogs, normalizedEvents: uniqueEvents.length, walletSideEvents, swapLikeTransactions: swapLikeTxs, pricedSwapCandidates: null, matchedClosedLotsBefore, matchedClosedLotsAfter: null, addedClosedLots: null, coverageLevel, missing: errorSamples.length > 0 ? ['provider_errors'] : [], reason: errorSamples.length > 0 ? 'One or more provider pages failed.' : null },
    debug: { requested: true, providersAttempted: ['goldrush'], pagesAttempted, pageSize, maxPages, cursorUsed: false, stoppedReason, rawTransactions: totalRawTx, rawLogEvents: totalTransferLogs, decodedTransferLogs: totalTransferLogs, walletSideEvents, candidateSwapTxs: swapLikeTxs, candidateSwapEvents: swapLikeEvents, duplicateTxHashes: 0, duplicateEvents: dupEvents, oldestTimestamp, newestTimestamp, chainCoverage, providerErrorSamples: errorSamples.slice(0, 4), skippedReasons: [], sampleTxHashes: [...allTxHashes].slice(0, 5), sampleSwapLikeTransactions: [], moralisHistoricalConfigured: false, moralisHistoricalAttempted: false, moralisReason: 'moralis_history_not_wired_yet' },
    events: uniqueEvents,
  }
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

    // Stable leg: find a stable counterpart in same tx with opposite direction
    const stableLegs = txGroup.filter(ev => Boolean(STABLE_USD_CONTRACTS[ev.contract?.toLowerCase() ?? '']) && ev.direction !== 'unknown' && ev.direction !== e.direction)
    if (stableLegs.length > 0) {
      const sl = stableLegs[0]
      const stableAmt = parseRawAmount(sl.amountRaw, sl.tokenDecimals) ?? sl.amount
      if (stableAmt > 0) {
        const derivedPrice = stableAmt / tokenAmount
        if (derivedPrice > 0 && isFinite(derivedPrice)) {
          pricedHistoricalCandidates++; stableLegPricedEvents++
          pricedEvidenceItems.push(markPriced(e, derivedPrice, 'stable_leg', 'high', `Derived from ${sl.symbol} leg in same tx`))
          if (samplePricedRaw.length < 5) samplePricedRaw.push({ txHash: abbr(e.txHash), contract: abbr(e.contract), symbol: e.symbol, direction: e.direction, priceUsd: derivedPrice, source: 'stable_leg' })
          continue
        }
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
  const evidenceList: WalletTxEvidence[] = events
    .filter(e => Boolean(e.txHash))
    .map(e => {
      const txToLower = (e.txToAddress ?? '').toLowerCase()
      const routerMatch = KNOWN_DEX_ROUTERS[txToLower] ?? null
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

  const totalEvents = events.length
  const eventsWithHash = events.filter(e => Boolean(e.txHash)).length
  const eventsWithTimestamp = events.filter(e => Boolean(e.timestamp)).length
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

  const sourceProvider = events.length > 0
    ? (events[0].chain === 'base' && events.some(e => Boolean(e.usdValue)) ? 'goldrush' : 'alchemy')
    : 'none'

  return {
    evidenceList,
    summary: { status, totalEvents, eventsWithHash, eventsWithTimestamp, hashCoverage, timestampCoverage, readyForSwapDetection, missing },
    debug: {
      sourceProvider: sourceProvider as 'goldrush' | 'alchemy' | 'none',
      totalRawEvents: totalEvents,
      eventsWithHash,
      eventsWithTimestamp,
      sampleHashes: evidenceList.slice(0, 3).map(e => e.txHash),
      sampleTimestamps: evidenceList.slice(0, 3).map(e => e.timestamp ?? ''),
    },
  }
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

  // ── Filter to usable events for swap-group analysis ──
  // Excludes: non-wallet-side transfers (direction=unknown), missing contract, zero amount
  const usableEvents = evidenceList.filter(e =>
    e.direction !== 'unknown' &&
    Boolean(e.contract) && e.contract.startsWith('0x') &&
    e.amount > 0
  )
  const usableEventCount = usableEvents.length

  // ── Group ONLY usable events by txHash ──
  const byTx = new Map<string, WalletTxEvidence[]>()
  for (const e of usableEvents) {
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
  const txCtxMap = new Map<string, TxCtx>()
  for (const [txHash, group] of byTx.entries()) {
    const first = group[0]
    const txToAddr = first.txToAddress?.toLowerCase() ?? null
    const txFromAddr = first.txFromAddress?.toLowerCase() ?? null
    const txRouterProtocol = txToAddr ? (KNOWN_DEX_ROUTERS[txToAddr] ?? null) : null
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

  const evidenceWithDetection: WalletTxEvidence[] = evidenceList.map(e => {
    // Non-wallet-side transfer — explain clearly
    if (e.direction === 'unknown') {
      return { ...e, swapDetection: { isSwapCandidate: false, confidence: 'low' as const, eventKind: 'unknown' as const, reason: 'Transfer does not involve scanned wallet directly (pool-to-pool or third-party)', matchedProtocol: null, matchedAddress: null } }
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
    } else if (hasInboundOutbound) {
      detection = { isSwapCandidate: true, confidence: 'medium', eventKind: 'swap_candidate', reason: 'Inbound+outbound token transfers in same tx', matchedProtocol: null, matchedAddress: null }
      sameTxInboundOutboundCandidatesCount++
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

  // ── Sample grouped txs (from usable groups) ──
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

const LOT_EPSILON = 1e-9

function lotConfidence(entrySource: string, exitSource: string): 'high' | 'medium' | 'low' {
  if (entrySource === 'stable_leg' && exitSource === 'stable_leg') return 'high'
  if (entrySource !== 'unavailable' && exitSource !== 'unavailable') return 'medium'
  return 'low'
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
      skippedUnpricedEvents: 0, skippedStableQuoteAssets: 0, skippedMissingFields: 0,
      totalCostBasisClosedUsd: null, totalProceedsClosedUsd: null,
      realizedPnlUsd: null, realizedPnlPercent: null,
      sampleOpenLots: [], sampleClosedLots: [], sampleUnmatchedSells: [], reasons: missing,
    },
    closedLots: [] as WalletClosedLot[],
    openLots: [] as WalletLotOpen[],
  })

  if (!activityRequested) return empty(['activity_not_requested'])

  // ── Filter to eligible events ──
  let skippedUnpricedEvents = 0
  let skippedStableQuoteAssets = 0
  let skippedMissingFields = 0

  const eligible: WalletTxEvidence[] = []
  for (const e of evidenceWithPricing) {
    if (!e.swapDetection?.isSwapCandidate) continue
    if (e.priceAtTime?.status !== 'priced' || !e.priceAtTime.priceUsd || !isFinite(e.priceAtTime.priceUsd) || e.priceAtTime.priceUsd <= 0) { skippedUnpricedEvents++; continue }
    if (!e.txHash || !e.timestamp || !e.contract || !e.contract.startsWith('0x') || !e.amount || e.amount <= 0) { skippedMissingFields++; continue }
    if (QUOTE_ASSET_CONTRACTS[e.contract.toLowerCase()]) { skippedStableQuoteAssets++; continue }
    eligible.push(e)
  }

  const pricedSwapEvents = eligible.length
  if (pricedSwapEvents === 0) return empty(['no_priced_swap_events'])

  // Sort ascending by timestamp
  eligible.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))

  const buyEvents = eligible.filter(e => e.direction === 'buy').length
  const sellEvents = eligible.filter(e => e.direction === 'sell').length

  // Open lots keyed by chain:contract (FIFO queue — oldest first)
  const openLotsMap = new Map<string, WalletLotOpen[]>()
  const closedLots: WalletClosedLot[] = []
  let unmatchedBuys = 0
  let unmatchedSells = 0

  for (const e of eligible) {
    const lotKey = `${e.chain}:${e.contract.toLowerCase()}`
    const priceUsd = e.priceAtTime!.priceUsd!
    const priceSource = e.priceAtTime!.source

    if (e.direction === 'buy') {
      // Open a new lot
      const lot: WalletLotOpen = {
        tokenAddress: e.contract.toLowerCase(),
        tokenSymbol: e.symbol ?? null,
        chain: e.chain,
        openedTxHash: e.txHash,
        openedAt: e.timestamp!,
        amountOpened: e.amount,
        amountRemaining: e.amount,
        entryPriceUsd: priceUsd,
        entryValueUsd: e.amount * priceUsd,
        priceSource,
        confidence: priceSource === 'stable_leg' ? 'high' : 'medium',
      }
      const queue = openLotsMap.get(lotKey) ?? []
      queue.push(lot)
      openLotsMap.set(lotKey, queue)

    } else if (e.direction === 'sell') {
      const queue = openLotsMap.get(lotKey)
      if (!queue || queue.length === 0) { unmatchedSells++; continue }

      let sellRemaining = e.amount
      while (sellRemaining > LOT_EPSILON && queue.length > 0) {
        const lot = queue[0]
        const closeAmount = Math.min(lot.amountRemaining, sellRemaining)
        const costBasisUsd = closeAmount * lot.entryPriceUsd
        const proceedsUsd = closeAmount * priceUsd
        const realizedPnlUsd = proceedsUsd - costBasisUsd
        const entryTs = new Date(lot.openedAt).getTime()
        const exitTs = new Date(e.timestamp!).getTime()
        const holdingTimeSeconds = isFinite(entryTs) && isFinite(exitTs) ? Math.max(0, Math.floor((exitTs - entryTs) / 1000)) : null

        closedLots.push({
          tokenAddress: e.contract.toLowerCase(),
          tokenSymbol: e.symbol ?? null,
          chain: e.chain,
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
        })

        lot.amountRemaining -= closeAmount
        sellRemaining -= closeAmount
        if (lot.amountRemaining <= LOT_EPSILON) queue.shift()
      }

      if (sellRemaining > LOT_EPSILON) unmatchedSells++
    }
    // direction === 'unknown' already filtered by eligible filter (swap candidates are buy/sell)
  }

  // Tally open lot stats
  let openedLots = 0
  let partiallyClosedLots = 0
  for (const queue of openLotsMap.values()) {
    for (const lot of queue) {
      openedLots++
      if (lot.amountRemaining < lot.amountOpened - LOT_EPSILON) partiallyClosedLots++
    }
  }
  unmatchedBuys = Array.from(openLotsMap.values()).flatMap(q => q).filter(lot => lot.amountRemaining >= lot.amountOpened - LOT_EPSILON).length

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

  const missing: string[] = []
  if (closedLots.length === 0 && pricedSwapEvents > 0) missing.push('no_closed_lots')
  if (unmatchedSells > 0) missing.push('unmatched_sells')
  if (unmatchedBuys > 0) missing.push('unmatched_buys')

  const abbr = (addr: string) => `${addr.slice(0, 8)}...${addr.slice(-6)}`

  const allOpenLots = Array.from(openLotsMap.values()).flatMap(q => q)

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
      skippedUnpricedEvents, skippedStableQuoteAssets, skippedMissingFields,
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
    const tokenKey = `${ev.chain}:${ev.contract.toLowerCase()}`
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

    const tokenKey = `${e.chain}:${e.contract.toLowerCase()}`
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
    const tokenKey = `${ev.chain}:${ev.contract.toLowerCase()}`
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
    if (STABLE_SYMS.has((e.symbol ?? '').toUpperCase())) continue
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
      const tokenKey = `${e.chain}:${e.contract.toLowerCase()}`
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

function buildTradeStatsSummary(
  closedLots: WalletClosedLot[],
  activityRequested: boolean
): {
  summary: WalletSnapshot['walletTradeStatsSummary']
  debug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletTradeStatsDebug']>
} {
  const WIN_RATE_THRESHOLD = 10
  const BREAK_EVEN_EPSILON = 0.01
  // Lots below this USD cost basis are considered economically insignificant (dust)
  const DUST_LOT_THRESHOLD = 25

  const emptyResult = (missing: string[]) => ({
    summary: {
      status: 'open_check' as const, closedLots: 0, uniqueTokensTraded: 0,
      realizedPnlUsd: null, realizedPnlPercent: null,
      winningClosedLots: 0, losingClosedLots: 0, breakEvenClosedLots: 0,
      winRatePercent: null, avgPnlUsdPerClosedLot: null,
      avgReturnPercentPerClosedLot: null, medianReturnPercentPerClosedLot: null,
      avgHoldingTimeSeconds: null, medianHoldingTimeSeconds: null,
      largestWinUsd: null, largestLossUsd: null,
      confidence: 'open_check' as const, sampleSizeLabel: 'insufficient' as const,
      readyForWalletScore: false,
      meaningfulClosedLots: 0, dustClosedLots: 0, meaningfulCostBasisUsd: 0,
      avgCostBasisPerClosedLot: null,
      economicSignificance: 'open_check' as const, economicSignificanceReason: 'no_closed_lots',
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
  })

  if (!activityRequested) return emptyResult(['activity_not_requested'])
  if (closedLots.length === 0) return emptyResult(['no_closed_lots'])

  const n = closedLots.length

  // ── Per-lot classification ──
  const winning = closedLots.filter(l => l.realizedPnlUsd > BREAK_EVEN_EPSILON)
  const losing  = closedLots.filter(l => l.realizedPnlUsd < -BREAK_EVEN_EPSILON)
  const breakEven = closedLots.filter(l => Math.abs(l.realizedPnlUsd) <= BREAK_EVEN_EPSILON)
  const uniqueTokensTraded = new Set(closedLots.map(l => `${l.chain}:${l.tokenAddress}`)).size

  // ── Aggregates ──
  const totalRealizedPnl = closedLots.reduce((s, l) => s + l.realizedPnlUsd, 0)
  const totalCostBasis = closedLots.reduce((s, l) => s + l.costBasisUsd, 0)
  const realizedPnlPercent = totalCostBasis > 0 ? (totalRealizedPnl / totalCostBasis) * 100 : null
  const avgCostBasisPerClosedLot = n > 0 ? totalCostBasis / n : null

  // ── Economic significance ──
  // Lots with costBasis >= DUST_LOT_THRESHOLD are considered meaningful.
  // Status/confidence/winRate/score are gated on BOTH count AND economic significance.
  const meaningfulLots = closedLots.filter(l => l.costBasisUsd >= DUST_LOT_THRESHOLD)
  const dustLots = closedLots.filter(l => l.costBasisUsd < DUST_LOT_THRESHOLD)
  const meaningfulClosedLots = meaningfulLots.length
  const dustClosedLots = dustLots.length
  const meaningfulCostBasisUsd = meaningfulLots.reduce((s, l) => s + l.costBasisUsd, 0)
  const dustCostBasisUsd = dustLots.reduce((s, l) => s + l.costBasisUsd, 0)

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
  type SampleLabel = 'insufficient' | 'early' | 'developing' | 'strong' | 'micro_sample'
  let summaryStatus: Status
  let confidence: Confidence
  let sampleSizeLabel: SampleLabel
  if      (n >= 25 && economicallyMeaningful) { summaryStatus = 'ok';      confidence = 'high';   sampleSizeLabel = 'strong' }
  else if (n >= 10 && economicallyMeaningful) { summaryStatus = 'ok';      confidence = 'medium'; sampleSizeLabel = 'developing' }
  else if (n >= 5  && economicallyMeaningful) { summaryStatus = 'partial'; confidence = 'medium'; sampleSizeLabel = 'early' }
  else if (!economicallyMeaningful)           { summaryStatus = 'partial'; confidence = 'low';    sampleSizeLabel = 'micro_sample' }
  else                                        { summaryStatus = 'partial'; confidence = 'low';    sampleSizeLabel = 'insufficient' }

  // ── Win rate: requires count AND economic significance ──
  const winRateComputed = n >= WIN_RATE_THRESHOLD && economicallyMeaningful
  const winRatePercent = winRateComputed ? (winning.length / n) * 100 : null

  const avgPnlUsdPerClosedLot = totalRealizedPnl / n
  const returnPcts = closedLots.map(l => l.realizedPnlPercent).filter((v): v is number => v !== null)
  const avgReturnPercentPerClosedLot = returnPcts.length > 0 ? returnPcts.reduce((s, v) => s + v, 0) / returnPcts.length : null
  const medianReturnPercentPerClosedLot = numMedian(returnPcts)

  const holdingTimes = closedLots.map(l => l.holdingTimeSeconds).filter((v): v is number => v !== null)
  const avgHoldingTimeSeconds = holdingTimes.length > 0 ? holdingTimes.reduce((s, v) => s + v, 0) / holdingTimes.length : null
  const medianHoldingTimeSeconds = numMedian(holdingTimes)

  const largestWinUsd = winning.length > 0 ? Math.max(...winning.map(l => l.realizedPnlUsd)) : null
  const largestLossUsd = losing.length > 0 ? Math.min(...losing.map(l => l.realizedPnlUsd)) : null

  const missing: string[] = []
  if (!winRateComputed) missing.push('sample_size_below_win_rate_threshold')
  if (!economicallyMeaningful) missing.push('micro_trade_sample')
  if (returnPcts.length < n) missing.push('some_lots_missing_return_percent')
  if (holdingTimes.length < n) missing.push('some_lots_missing_holding_time')

  const abbr = (addr: string) => `${addr.slice(0, 8)}...${addr.slice(-6)}`

  return {
    summary: {
      status: summaryStatus, closedLots: n, uniqueTokensTraded,
      realizedPnlUsd: totalRealizedPnl, realizedPnlPercent,
      winningClosedLots: winning.length, losingClosedLots: losing.length, breakEvenClosedLots: breakEven.length,
      winRatePercent, avgPnlUsdPerClosedLot, avgReturnPercentPerClosedLot,
      medianReturnPercentPerClosedLot, avgHoldingTimeSeconds, medianHoldingTimeSeconds,
      largestWinUsd, largestLossUsd, confidence, sampleSizeLabel,
      readyForWalletScore: n >= WIN_RATE_THRESHOLD && economicallyMeaningful,
      meaningfulClosedLots, dustClosedLots, meaningfulCostBasisUsd,
      avgCostBasisPerClosedLot, economicSignificance, economicSignificanceReason,
      missing,
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
  }
}

// buildPerSwapTradeStats: fallback trade stats when FIFO closedLots === 0.
// Groups priced events by txHash; treats every tx that has both a priced buy
// and a priced sell as a single closed "trade" and computes per-swap PnL.
function buildPerSwapTradeStats(
  pricedEvidence: WalletTxEvidence[],
  activityRequested: boolean
): {
  summary: WalletSnapshot['walletTradeStatsSummary']
  debug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletTradeStatsDebug']>
} {
  const WIN_RATE_THRESHOLD = 10
  const DUST_LOT_THRESHOLD = 25
  const BREAK_EVEN_EPSILON = 0.01

  const emptyResult = (missing: string[]) => ({
    summary: {
      status: 'open_check' as const, closedLots: 0, uniqueTokensTraded: 0,
      realizedPnlUsd: null, realizedPnlPercent: null,
      winningClosedLots: 0, losingClosedLots: 0, breakEvenClosedLots: 0,
      winRatePercent: null, avgPnlUsdPerClosedLot: null,
      avgReturnPercentPerClosedLot: null, medianReturnPercentPerClosedLot: null,
      avgHoldingTimeSeconds: null, medianHoldingTimeSeconds: null,
      largestWinUsd: null, largestLossUsd: null,
      confidence: 'open_check' as const, sampleSizeLabel: 'insufficient' as const,
      readyForWalletScore: false,
      meaningfulClosedLots: 0, dustClosedLots: 0, meaningfulCostBasisUsd: 0,
      avgCostBasisPerClosedLot: null,
      economicSignificance: 'open_check' as const, economicSignificanceReason: 'no_closed_lots',
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
  type SampleLabel = 'insufficient' | 'early' | 'developing' | 'strong' | 'micro_sample'
  let summaryStatus: Status
  let confidence: Confidence
  let sampleSizeLabel: SampleLabel
  if      (n >= 25 && economicallyMeaningful) { summaryStatus = 'ok';      confidence = 'medium'; sampleSizeLabel = 'strong' }
  else if (n >= 10 && economicallyMeaningful) { summaryStatus = 'ok';      confidence = 'medium'; sampleSizeLabel = 'developing' }
  else if (n >= 5  && economicallyMeaningful) { summaryStatus = 'partial'; confidence = 'low';    sampleSizeLabel = 'early' }
  else if (!economicallyMeaningful)           { summaryStatus = 'partial'; confidence = 'low';    sampleSizeLabel = 'micro_sample' }
  else                                        { summaryStatus = 'partial'; confidence = 'low';    sampleSizeLabel = 'insufficient' }

  const winRateComputed = n >= WIN_RATE_THRESHOLD && economicallyMeaningful
  const winRatePercent = winRateComputed ? (winning.length / n) * 100 : null
  const avgPnlUsdPerClosedLot = totalRealizedPnl / n

  const returnPcts = closedTrades.map(t => t.returnPercent).filter((v): v is number => v !== null)
  const avgReturnPercentPerClosedLot = returnPcts.length > 0 ? returnPcts.reduce((s, v) => s + v, 0) / returnPcts.length : null
  const medianReturnPercentPerClosedLot = numMedian(returnPcts)

  const largestWinUsd  = winning.length > 0 ? Math.max(...winning.map(t => t.pnlUsd)) : null
  const largestLossUsd = losing.length  > 0 ? Math.min(...losing.map(t => t.pnlUsd))  : null

  const missing: string[] = ['per_swap_fallback_mode']
  if (!winRateComputed)          missing.push('sample_size_below_win_rate_threshold')
  if (!economicallyMeaningful)   missing.push('micro_trade_sample')

  const abbr = (h: string) => `${h.slice(0, 8)}...${h.slice(-6)}`

  return {
    summary: {
      status: summaryStatus, closedLots: n, uniqueTokensTraded,
      realizedPnlUsd: totalRealizedPnl, realizedPnlPercent,
      winningClosedLots: winning.length, losingClosedLots: losing.length, breakEvenClosedLots: breakEven.length,
      winRatePercent, avgPnlUsdPerClosedLot, avgReturnPercentPerClosedLot,
      medianReturnPercentPerClosedLot, avgHoldingTimeSeconds: null, medianHoldingTimeSeconds: null,
      largestWinUsd, largestLossUsd, confidence, sampleSizeLabel,
      readyForWalletScore: n >= WIN_RATE_THRESHOLD && economicallyMeaningful,
      meaningfulClosedLots, dustClosedLots, meaningfulCostBasisUsd,
      avgCostBasisPerClosedLot, economicSignificance, economicSignificanceReason,
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

async function fetchGoldrushHistoricalPrice(chain: string, contractAddress: string, timestamp: string, reqCache?: Map<string, number | null>): Promise<{ priceUsd: number | null; cacheHit: boolean; providerAttempted: boolean; error: boolean }> {
  if (!GOLDRUSH_KEY || !contractAddress.startsWith('0x')) return { priceUsd: null, cacheHit: false, providerAttempted: false, error: false }
  const dateStr = timestamp.slice(0, 10)
  if (!dateStr || dateStr.length !== 10) return { priceUsd: null, cacheHit: false, providerAttempted: false, error: false }
  const reqKey = `${chain}:${contractAddress.toLowerCase()}:${dateStr}`
  if (reqCache?.has(reqKey)) return { priceUsd: reqCache.get(reqKey) ?? null, cacheHit: true, providerAttempted: false, error: false }
  const cacheKey = `pat:${chain}:${contractAddress.toLowerCase()}:${dateStr}`
  const cached = priceAtTimeMemCache.get(cacheKey)
  if (cached && cached.exp > Date.now()) { reqCache?.set(reqKey, cached.priceUsd); return { priceUsd: cached.priceUsd, cacheHit: true, providerAttempted: false, error: false } }
  const toDate = new Date(new Date(dateStr).getTime() + 2 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const url = `https://api.covalenthq.com/v1/pricing/historical_by_addresses_v2/${chain}/USD/${contractAddress.toLowerCase()}/?from=${dateStr}&to=${toDate}`
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
    const priceEntry = prices.find((p: unknown) => typeof (p as Record<string, unknown>).date === 'string' && ((p as Record<string, unknown>).date as string).slice(0, 10) === dateStr) ?? prices[0]
    const priceUsd = typeof (priceEntry as Record<string, unknown>)?.price === 'number' ? (priceEntry as Record<string, unknown>).price as number : null
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
  reqCache?: Map<string, number | null>
): Promise<{
  evidenceWithPricing: WalletTxEvidence[]
  summary: WalletSnapshot['walletPriceEvidenceSummary']
  debug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletPriceAtTimeDebug']>
}> {
  const MAX_PRICE_ATTEMPTS = 25

  const emptyResult = (missing: string[]) => ({
    evidenceWithPricing: evidenceWithDetection,
    summary: {
      status: 'open_check' as const, swapCandidateEvents: 0, pricedEvents: 0,
      openCheckEvents: 0, unavailableEvents: 0,
      stableLegPricedEvents: 0, wethLegPricedEvents: 0, historicalPricedEvents: 0,
      priceAttemptLimitReached: false, readyForLotMatching: false, missing,
    },
    debug: {
      swapCandidateEvents: 0, priceAttempts: 0, pricedEvents: 0, openCheckEvents: 0,
      unavailableEvents: 0, stableLegPricedEvents: 0, wethLegPricedEvents: 0,
      historicalPricedEvents: 0, priceAttemptLimitReached: false,
      skippedNoTimestamp: 0, skippedNoTokenAddress: 0, skippedNoAmount: 0,
      cacheHits: 0, cacheMisses: 0, providerAttempts: 0, providerErrors: 0,
      samplePricedEvents: [], sampleOpenCheckEvents: [], reasons: missing,
    },
  })

  if (!activityRequested) return emptyResult(['activity_not_requested'])

  const swapCandidateEvents = evidenceWithDetection.filter(e => e.swapDetection?.isSwapCandidate).length
  if (swapCandidateEvents === 0) return emptyResult(['no_swap_candidates'])

  // Group all events by txHash for stable/WETH leg lookup
  const allByTx = new Map<string, WalletTxEvidence[]>()
  for (const e of evidenceWithDetection) {
    if (e.txHash) allByTx.set(e.txHash, [...(allByTx.get(e.txHash) ?? []), e])
  }

  let priceAttempts = 0
  let pricedEvents = 0
  let openCheckEvents = 0
  const unavailableEvents = 0
  let stableLegPricedEvents = 0
  let wethLegPricedEvents = 0
  let historicalPricedEvents = 0
  let priceAttemptLimitReached = false
  let skippedNoTimestamp = 0
  let skippedNoTokenAddress = 0
  let skippedNoAmount = 0
  let cacheHits = 0
  let cacheMisses = 0
  let providerAttempts = 0
  let providerErrors = 0
  const samplePricedRaw: WalletTxEvidence[] = []
  const sampleOpenCheckRaw: WalletTxEvidence[] = []

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
    if (samplePricedRaw.length < 5) samplePricedRaw.push(ev)
    return ev
  }

  const evidenceWithPricing: WalletTxEvidence[] = []

  for (const e of evidenceWithDetection) {
    // Only price swap candidates
    if (!e.swapDetection?.isSwapCandidate) { evidenceWithPricing.push(e); continue }

    if (!e.timestamp) { skippedNoTimestamp++; evidenceWithPricing.push(openCheck(e, 'No timestamp available')); continue }
    if (!e.contract || !e.contract.startsWith('0x')) { skippedNoTokenAddress++; evidenceWithPricing.push(openCheck(e, 'Missing token contract address')); continue }

    const contractLower = e.contract.toLowerCase()
    const isStable = Boolean(STABLE_USD_CONTRACTS[contractLower])
    const isWeth = Boolean(WETH_CONTRACTS_PRICE[contractLower])

    // Stablecoins are $1 by definition
    if (isStable) {
      evidenceWithPricing.push(priced(e, 1.0, 'stable_leg', 'high', 'Stablecoin — price is $1 USD by definition'))
      continue
    }

    const tokenAmount = parseRawAmount(e.amountRaw, e.tokenDecimals) ?? e.amount
    if (!tokenAmount || tokenAmount <= 0) { skippedNoAmount++; evidenceWithPricing.push(openCheck(e, 'Token amount is zero or unavailable')); continue }

    const txGroup = allByTx.get(e.txHash) ?? []

    // Try stable leg: find a stable movement in same tx with opposite direction
    const stableLegs = txGroup.filter(ev => {
      const c = ev.contract?.toLowerCase() ?? ''
      return Boolean(STABLE_USD_CONTRACTS[c]) && ev.direction !== 'unknown' && ev.direction !== e.direction
    })
    if (stableLegs.length > 0) {
      const sl = stableLegs[0]
      const stableAmt = parseRawAmount(sl.amountRaw, sl.tokenDecimals) ?? sl.amount
      if (stableAmt > 0) {
        const derivedPrice = stableAmt / tokenAmount
        if (derivedPrice > 0 && isFinite(derivedPrice)) {
          evidenceWithPricing.push(priced(e, derivedPrice, 'stable_leg', 'high', `Derived from ${sl.symbol} leg in same tx (${sl.symbol} amount / token amount)`))
          continue
        }
      }
    }

    // Try WETH leg: find WETH movement in same tx with opposite direction
    if (!isWeth) {
      const wethLegs = txGroup.filter(ev => {
        const c = ev.contract?.toLowerCase() ?? ''
        return Boolean(WETH_CONTRACTS_PRICE[c]) && ev.direction !== 'unknown' && ev.direction !== e.direction
      })
      if (wethLegs.length > 0) {
        const wl = wethLegs[0]
        // Need WETH's USD price at this timestamp
        if (priceAttempts >= MAX_PRICE_ATTEMPTS) {
          priceAttemptLimitReached = true
          evidenceWithPricing.push(openCheck(e, 'price_attempt_limit_reached'))
          continue
        }
        priceAttempts++
        const result = await fetchGoldrushHistoricalPrice(wl.chain, wl.contract, e.timestamp, reqCache)
        if (result.cacheHit) cacheHits++; else cacheMisses++
        if (result.providerAttempted) providerAttempts++
        if (result.error) providerErrors++
        if (result.priceUsd !== null) {
          const wethAmt = parseRawAmount(wl.amountRaw, wl.tokenDecimals) ?? wl.amount
          if (wethAmt > 0) {
            const derivedPrice = (wethAmt * result.priceUsd) / tokenAmount
            if (derivedPrice > 0 && isFinite(derivedPrice)) {
              evidenceWithPricing.push(priced(e, derivedPrice, 'weth_leg', 'medium', `Derived from WETH leg (WETH×${result.priceUsd.toFixed(0)} × WETH amount / token amount)`))
              continue
            }
          }
        }
      }
    }

    // Try direct historical price via GoldRush
    if (priceAttempts >= MAX_PRICE_ATTEMPTS) {
      priceAttemptLimitReached = true
      evidenceWithPricing.push(openCheck(e, 'price_attempt_limit_reached'))
      continue
    }
    priceAttempts++
    const histResult = await fetchGoldrushHistoricalPrice(e.chain, e.contract, e.timestamp, reqCache)
    if (histResult.cacheHit) cacheHits++; else cacheMisses++
    if (histResult.providerAttempted) providerAttempts++
    if (histResult.error) providerErrors++
    if (histResult.priceUsd !== null) {
      evidenceWithPricing.push(priced(e, histResult.priceUsd, 'historical_price', 'medium', `Historical token price from on-chain pricing data`))
      continue
    }

    // No price evidence found
    evidenceWithPricing.push(openCheck(e, 'No reliable price-at-time evidence available'))
  }

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
  if (pricedEvents === 0 && swapCandidateEvents > 0) missing.push('no_price_evidence')
  if (priceAttemptLimitReached) missing.push('price_attempt_limit_reached')
  if (!readyForLotMatching && pricedEvents > 0) missing.push(pricedInbound === 0 ? 'no_priced_inbound_swaps' : 'no_priced_outbound_swaps')

  const abbr = (addr: string) => `${addr.slice(0, 8)}...${addr.slice(-6)}`

  return {
    evidenceWithPricing,
    summary: {
      status: summaryStatus, swapCandidateEvents, pricedEvents, openCheckEvents, unavailableEvents,
      stableLegPricedEvents, wethLegPricedEvents, historicalPricedEvents,
      priceAttemptLimitReached, readyForLotMatching, missing,
    },
    debug: {
      swapCandidateEvents, priceAttempts, pricedEvents, openCheckEvents, unavailableEvents,
      stableLegPricedEvents, wethLegPricedEvents, historicalPricedEvents, priceAttemptLimitReached,
      skippedNoTimestamp, skippedNoTokenAddress, skippedNoAmount,
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
      reasons: missing,
    },
  }
}

const BEHAVIOR_EMPTY: WalletBehavior = {
  status: 'unavailable', source: 'unavailable',
  txCount: null, activeDays: null, topTokens: [], topContracts: [],
  inboundCount: null, outboundCount: null, stablecoinActivity: false,
  recentActivitySummary: 'Activity data unavailable.', reason: '',
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

  // Activity from evidence (cap at 500)
  const events = evidenceWithDetection.slice(0, 500)
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

export async function fetchWalletSnapshot(address: string, options: WalletSnapshotOptions = {}): Promise<WalletSnapshot> {
  const { refresh = false, chain: requestedChain = 'base', deepScan = false, deepActivity = false, chainMode = 'auto', historicalCoverage = false, maxHistoricalPages: rawMaxHistoricalPages, maxFallbackPages: rawMaxFallbackPages, debug = false, maxDebugTokens = DEFAULT_MAX_DEBUG_TOKENS } = options
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
            },
          } : undefined,
        }
        return validateWalletFactsShape(cachedSnapshot)
      }
      snapshotMemCache.delete(cacheKey)
    }
  }

  const startedAt = Date.now()
  const addr: string = (address ?? '').trim()
  if (!addr || !/^0x[0-9a-fA-F]{40}$/i.test(addr)) {
    throw new Error('Invalid wallet address')
  }

  const ethUrl  = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_ETH_KEY}`
  const baseUrl = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_BASE_KEY}`

  // ETH Alchemy calls only when explicitly requested — default is Base only
  const useEthAlchemy = requestedChain === 'eth' && Boolean(ALCHEMY_ETH_KEY)
  const nonceUrl = useEthAlchemy ? ethUrl : baseUrl

  // Determine Moralis chain before Phase 1 so it can run in the parallel batch.
  const _moralisChain: 'eth' | 'base' = requestedChain === 'eth' ? 'eth' : 'base'

  tokenMeter.startTokenMeter('providerFetch')
  tokenMeter.measure('providerFetch', addr, requestedChain, chainMode, activityRequested ? 'activity' : 'holdings')

  // Phase 1 (parallel): Zerion portfolio value + Moralis holdings (primary) + Alchemy metadata.
  // Zerion positions are fetched in parallel as a fallback_layer — used only if Moralis fails.
  // GoldRush excluded — runs only in Phase 3 (both primary/fallback fail) or deepScan=true.
  const [
    portfolioRes,    // Zerion: total portfolio value
    positionsRes,    // Zerion: token positions — fallback_layer only
    moralisRes,      // Moralis: primary holdings source
    ethFirst,
    baseFirst,
    nonceRes,
    behaviorRes,
    grPnlEthRes,
    grPnlBaseRes,
    alchemyPnlRes,
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
    fetchMoralisBalances(addr, _moralisChain),  // handles not-configured internally
    useEthAlchemy ? getFirstTxOnChain(addr, ethUrl) : Promise.resolve(null),
    getFirstTxOnChain(addr, baseUrl),
    alchemyRpc(nonceUrl, 'eth_getTransactionCount', [addr, 'latest']),
    deepScan ? fetchWalletBehavior(addr, baseUrl) : Promise.resolve(BEHAVIOR_EMPTY),
    // ETH mainnet PnL transfers only when activity is requested AND ETH chain is selected.
    // Default (base) scans skip this to avoid a wasted transactions_v3 call.
    activityRequested && GOLDRUSH_KEY && useEthAlchemy ? fetchGoldrushPnlEvents(addr, 'eth-mainnet', GOLDRUSH_KEY, tokenMeter.isDebugEnabled()) : Promise.resolve({ events: [] as PnlEvent[], diag: { endpointKind: 'transactions_v3' as const, chainUsed: 'eth-mainnet', urlTemplate: 'https://api.covalenthq.com/v1/eth-mainnet/address/{wallet}/transactions_v3/?page-size=50&page-number=0&with-logs=true&no-spam=true', httpStatus: null, fetchFailed: true, failureStage: 'build_url' as const, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], transferArrayCount: 0, firstTransferKeys: [], reason: activityRequested ? 'ETH chain not requested — skipped to reduce API usage.' : 'Activity scan not requested — skipped.' } }),
    activityRequested && GOLDRUSH_KEY ? fetchGoldrushPnlEvents(addr, 'base-mainnet', GOLDRUSH_KEY, tokenMeter.isDebugEnabled()) : Promise.resolve({ events: [] as PnlEvent[], diag: { endpointKind: 'transactions_v3' as const, chainUsed: 'base-mainnet', urlTemplate: 'https://api.covalenthq.com/v1/base-mainnet/address/{wallet}/transactions_v3/?page-size=50&page-number=0&with-logs=true&no-spam=true', httpStatus: null, fetchFailed: true, failureStage: 'build_url' as const, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], transferArrayCount: 0, firstTransferKeys: [], reason: activityRequested ? 'GoldRush activity fetch skipped — provider not configured.' : 'Activity scan not requested — skipped.' } }),
    activityRequested && Boolean(ALCHEMY_BASE_KEY) ? fetchAlchemyPnlEvents(addr, baseUrl) : Promise.resolve([] as PnlEvent[]),
  ])

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

  // Moralis holdings (primary source)
  const _moralisResult: MoralisFetchResult = moralisRes.status === 'fulfilled'
    ? moralisRes.value
    : { holdings: [], attempted: true, usable: false, cacheHit: false, reason: 'fetch_error' }
  const _moralisHoldingsUsable = _moralisResult.usable && _moralisResult.holdings.length > 0
  const _moralisAttempted = Boolean(process.env.MORALIS_API_KEY)

  // ── Track Phase 1 provider calls ──
  if (_moralisAttempted) _trackCall('moralis', 'erc20_holdings', _moralisResult.cacheHit, `moralis:holdings:${_moralisChain}:${addrNorm}`)
  if (activityRequested && Boolean(GOLDRUSH_KEY)) _trackCall('goldrush', 'transactions_v3', false, `gr:tx3:base:${addrNorm}`)
  if (activityRequested && Boolean(GOLDRUSH_KEY) && useEthAlchemy) _trackCall('goldrush', 'transactions_v3', false, `gr:tx3:eth:${addrNorm}`)
  if (activityRequested && Boolean(ALCHEMY_BASE_KEY)) {
    const _ak1 = `alchemy:transfers:from:base:${addrNorm}`; if (!_alchemyDedup.has(_ak1)) { _alchemyDedup.add(_ak1); _trackCall('alchemy', 'alchemy_getAssetTransfers', false, _ak1) }
    const _ak2 = `alchemy:transfers:to:base:${addrNorm}`;   if (!_alchemyDedup.has(_ak2)) { _alchemyDedup.add(_ak2); _trackCall('alchemy', 'alchemy_getAssetTransfers', false, _ak2) }
  }
  if (Boolean(ALCHEMY_BASE_KEY)) {
    const _ak3 = `alchemy:firstTx:base:${addrNorm}`; if (!_alchemyDedup.has(_ak3)) { _alchemyDedup.add(_ak3); _trackCall('alchemy', 'getFirstTx', false, _ak3) }
    _trackCall('alchemy', 'eth_getTransactionCount', false, `alchemy:nonce:${addrNorm}`)
  }
  if (useEthAlchemy) {
    const _ak4 = `alchemy:firstTx:eth:${addrNorm}`; if (!_alchemyDedup.has(_ak4)) { _alchemyDedup.add(_ak4); _trackCall('alchemy', 'getFirstTx', false, _ak4) }
  }
  if (deepScan && Boolean(ALCHEMY_BASE_KEY)) {
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
    reason = positionsRes.status === 'rejected' && moralisRes.status === 'rejected'
      ? 'Portfolio layer and holdings layer both unavailable.'
      : 'No token balances found for this wallet.'
  }

  const minChainValueUsd = 1
  const maxChainsBasicScan = 5
  const supportedMoralisChains: MoralisChain[] = ['eth', 'base', 'polygon', 'bsc', 'arbitrum', 'optimism', 'avalanche', 'fantom', 'cronos', 'gnosis']
  const mapChain = (raw: string): MoralisChain | null => {
    const c = raw.toLowerCase()
    if (c === 'eth' || c.includes('ethereum')) return 'eth'
    if (c.includes('base')) return 'base'
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

  // Moralis holdings layer for active chains.
  let grEthRes: PromiseSettledResult<Holding[]>
  let grBaseRes: PromiseSettledResult<Holding[]>
  const _moralisByChain = new Map<MoralisChain, MoralisFetchResult>()
  let _moralisUsed = false
  if (Boolean(process.env.MORALIS_API_KEY)) {
    for (const c of activeChains) {
      const _mbRes = await fetchMoralisBalances(addr, c)
      _moralisByChain.set(c, _mbRes)
      // Skip tracking if this chain was already tracked in Phase 1
      if (c !== _moralisChain) _trackCall('moralis', 'erc20_holdings', _mbRes.cacheHit, `moralis:holdings:${c}:${addrNorm}`)
    }
    const moralisHoldings = [..._moralisByChain.values()].flatMap((r) => r.holdings).sort((a, b) => b.value - a.value)

    if (moralisHoldings.length > 0) {
      holdings = moralisHoldings as Holding[]
      totalValue = holdings.reduce((s, h) => s + h.value, 0)
      providerStatus = 'partial'
      reason = ''
      _moralisUsed = true
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

  const grEth = grPnlEthRes.status === 'fulfilled' ? grPnlEthRes.value : { events: [] as PnlEvent[], diag: { endpointKind: 'transactions_v3' as const, chainUsed: 'eth-mainnet', urlTemplate: 'https://api.covalenthq.com/v1/eth-mainnet/address/{wallet}/transactions_v3/?page-size=50&page-number=0&with-logs=true&no-spam=true', httpStatus: null, fetchFailed: true, failureStage: 'fetch' as const, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], transferArrayCount: 0, firstTransferKeys: [], reason: 'GoldRush transaction history request failed before response.' } }
  const grPnlBaseOut = grPnlBaseRes.status === 'fulfilled' ? grPnlBaseRes.value : { events: [] as PnlEvent[], diag: { endpointKind: 'transactions_v3' as const, chainUsed: 'base-mainnet', urlTemplate: 'https://api.covalenthq.com/v1/base-mainnet/address/{wallet}/transactions_v3/?page-size=50&page-number=0&with-logs=true&no-spam=true', httpStatus: null, fetchFailed: true, failureStage: 'fetch' as const, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], transferArrayCount: 0, firstTransferKeys: [], reason: 'GoldRush transaction history request failed before response.' } }
  const grBase = grPnlBaseOut
  const goldrushTransferDiags = [grEth.diag, grBase.diag]
  const baseTransferDiag = goldrushTransferDiags.find((d) => d.chainUsed === '8453' || d.chainUsed === 'base-mainnet') ?? goldrushTransferDiags[0]
  const grEvents = [...grEth.events, ...grBase.events]
  const alchemyEvents = alchemyPnlRes.status === 'fulfilled' ? alchemyPnlRes.value : []
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
  let events: PnlEvent[] = grEvents.length > 0 ? grEvents : alchemyEvents

  // Moralis activity fallback: runs only when deepActivity requested and all primary providers returned nothing.
  // One request max, cached 5 min, in-flight deduped inside fetchMoralisTransfers, 8 s timeout, no pagination.
  const _grBaseFetchFailed = !GOLDRUSH_KEY
    || Boolean((grBase.diag as GoldrushHistoryDiag).fetchFailed)
    || ((grBase.diag as GoldrushHistoryDiag).httpStatus != null && ((grBase.diag as GoldrushHistoryDiag).httpStatus as number) >= 400)
    || (grBase.diag as GoldrushHistoryDiag).failureStage === 'timeout'
  // Outer vars for Moralis fallback chain/cursor — needed by both page-1 block and multi-page loop
  const _fbChain: 'eth' | 'base' = requestedChain === 'eth' ? 'eth' : 'base'
  const _fbChainName: string = _fbChain === 'base' ? 'base-mainnet' : 'eth-mainnet'
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
    const k = `${e.txHash ?? ''}|${e.contract}|${e.direction}|${e.amountRaw ?? String(e.amount)}`
    if (!_seenBudgetKeys.has(k)) { _seenBudgetKeys.add(k); _dedupedBudgetEvents.push(e) }
  }
  const _budgetEventsAfterDedup = _dedupedBudgetEvents.length
  const _budgetCapped = _dedupedBudgetEvents.length > _ACTIVITY_MAX_EVENTS
  events = _dedupedBudgetEvents.slice(0, _ACTIVITY_MAX_EVENTS)
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
  let realized = 0, unrealized = 0, coverageNum = 0
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
    pnlTokens.push({ symbol: h.symbol, contract: (h.contract ?? '').toLowerCase(), currentValueUsd: h.value, estimatedCostBasisUsd, estimatedUnrealizedPnlUsd: coverage >= COV_THRESHOLD ? estimatedUnrealized : null, estimatedRealizedPnlUsd: coverage >= COV_THRESHOLD ? estimatedRealized : null, buysDetected: buys.length, sellsDetected: sells.length, unexplainedTransfers: unexplained, coveragePercent: coverage, confidence: conf, reason: coverage < COV_THRESHOLD ? 'PnL partial/unavailable: historical cost basis coverage too low.' : 'Estimated from average-cost using indexed transfers.' })
  }
  const coveragePercent = pnlTokens.length ? Math.round(coverageNum / pnlTokens.length) : 0
  const status: WalletSnapshot['estimatedPnl']['status'] = pnlTokens.length === 0 || pnlSource === 'none' ? 'unavailable' : coveragePercent >= 40 ? 'ok' : 'partial'
  const filteredPnlTokens = pnlTokens.filter((t) => t.coveragePercent > 0).sort((a, b) => (b.currentValueUsd - a.currentValueUsd)).slice(0, 10)
  const pnlCoverageReason = status === 'unavailable'
    ? (activityProviderUnavailable ? 'Activity source did not return usable history. No PnL was calculated.' : pnlSource === 'none' ? 'Enable Deep Activity Scan for full transfer history and cost-basis estimation.' : 'Historical cost basis coverage is too low for a reliable estimate.')
    : 'Estimated from indexed transfer history with average-cost method.'
  const pnlSourcePublic: 'activity_layer' | 'fallback_layer' | 'unavailable' = pnlSource === 'none' ? 'unavailable' : pnlSource
  const estimatedPnl: WalletSnapshot['estimatedPnl'] = { status, confidence: status === 'unavailable' ? null : confidenceFromCoverage(coveragePercent), coveragePercent, source: pnlSourcePublic === 'unavailable' ? 'none' : pnlSourcePublic, totalEstimatedPnlUsd: status === 'unavailable' ? null : realized + unrealized, unrealizedPnlUsd: status === 'unavailable' ? null : unrealized, realizedPnlUsd: status === 'unavailable' ? null : realized, method: 'average_cost_estimate', tokens: filteredPnlTokens, reason: status === 'unavailable' ? (activityProviderUnavailable ? 'Activity source did not return usable history. No PnL was calculated.' : 'PnL unavailable — historical cost basis coverage is too low.') : 'Estimated PnL Beta derived from indexed wallet transfer history.' }
  let { evidenceList, summary: walletEvidenceSummary, debug: _txEvidenceDebugBase } = buildTxEvidenceFromEvents(events, activityRequested, activityProviderUnavailable)
  tokenMeter.measure('normalization', { events, evidenceList, walletEvidenceSummary, txEvidenceDebug: _txEvidenceDebugBase, estimatedPnl })
  tokenMeter.endTokenMeter('normalization')

  tokenMeter.startTokenMeter('swapDetection')
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

  tokenMeter.startTokenMeter('priceInference')
  tokenMeter.measure('priceInference', _swapEvidenceWithDetection)
  let { evidenceWithPricing: _pricedEvidence, summary: walletPriceEvidenceSummary, debug: _priceAtTimeDebug } = await buildPriceAtTimeEvidence(_swapEvidenceWithDetection, activityRequested, _reqPriceCache)
  // Track base evidence historical price calls
  for (let _pp = 0; _pp < (_priceAtTimeDebug?.providerAttempts ?? 0); _pp++) {
    _trackCall('goldrush', 'historical_by_addresses_v2', false, `gr:price:base:${_pp}:${addrNorm}`)
  }
  tokenMeter.measure('priceInference', _pricedEvidence, walletPriceEvidenceSummary, _priceAtTimeDebug)
  tokenMeter.endTokenMeter('priceInference')

  tokenMeter.startTokenMeter('fifoEngine')
  _pricedEvidence = normalizeSwapEventsForFifo(_pricedEvidence, tokenMeter.isDebugEnabled())
  _pricedEvidence = normalizeSingleLegEventsForFifo(_pricedEvidence, tokenMeter.isDebugEnabled())
  tokenMeter.measure('fifoEngine', _pricedEvidence)
  const fifoResult = buildFifoLotEngine(_pricedEvidence, activityRequested)
  let walletLotSummary = fifoResult.summary
  let _lotEngineDebug = fifoResult.debug
  let _closedLots = fifoResult.closedLots
  tokenMeter.measure('fifoEngine', walletLotSummary, _lotEngineDebug, _closedLots)
  tokenMeter.endTokenMeter('fifoEngine')

  tokenMeter.startTokenMeter('tradeStats')
  tokenMeter.measure('tradeStats', _closedLots)
  const tradeStatsResult = buildTradeStatsSummary(_closedLots, activityRequested)
  let walletTradeStatsSummary = tradeStatsResult.summary
  let _tradeStatsDebug = tradeStatsResult.debug
  if (_closedLots.length === 0 && activityRequested) {
    const _perSwap = buildPerSwapTradeStats(_pricedEvidence, activityRequested)
    if (_perSwap.summary.closedLots > 0) {
      walletTradeStatsSummary = _perSwap.summary
      _tradeStatsDebug = _perSwap.debug
      tokenMeter.measure('tradeStats', _perSwap)
    }
  }
  tokenMeter.measure('tradeStats', walletTradeStatsSummary, _tradeStatsDebug)
  tokenMeter.endTokenMeter('tradeStats')

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
    const DUST_THRESHOLD = 25
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
      ;({ evidenceWithPricing: _pricedEvidence, summary: walletPriceEvidenceSummary, debug: _priceAtTimeDebug } = await buildPriceAtTimeEvidence(_swapEvidenceWithDetection, activityRequested, _reqPriceCache))
      tokenMeter.measure('priceInference', _swapEvidenceWithDetection, _pricedEvidence, walletPriceEvidenceSummary, _priceAtTimeDebug)
      _pricedEvidence = normalizeSwapEventsForFifo(_pricedEvidence, tokenMeter.isDebugEnabled())
      _pricedEvidence = normalizeSingleLegEventsForFifo(_pricedEvidence, tokenMeter.isDebugEnabled())
      const fifoPageResult = buildFifoLotEngine(_pricedEvidence, activityRequested)
      walletLotSummary = fifoPageResult.summary
      _lotEngineDebug = fifoPageResult.debug
      _closedLots = fifoPageResult.closedLots
      tokenMeter.measure('fifoEngine', _pricedEvidence, walletLotSummary, _lotEngineDebug, _closedLots)
      const tradeStatsPageResult = buildTradeStatsSummary(_closedLots, activityRequested)
      walletTradeStatsSummary = tradeStatsPageResult.summary
      _tradeStatsDebug = tradeStatsPageResult.debug
      tokenMeter.measure('tradeStats', _closedLots, walletTradeStatsSummary, _tradeStatsDebug)
      if (_closedLots.length === 0 && activityRequested) {
        const _perSwap = buildPerSwapTradeStats(_pricedEvidence, activityRequested)
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

  tokenMeter.measure('fallbackEngine', _moralisFbDebug, events)
  tokenMeter.endTokenMeter('fallbackEngine')

  // Phase 6A: Historical coverage diagnostics — runs only when activityRequested + historicalCoverage requested
  const _runHistoricalCoverage = activityRequested && historicalCoverage
  let walletHistoricalCoverageSummary: WalletSnapshot['walletHistoricalCoverageSummary']
  let _historicalCoverageDebug: NonNullable<WalletSnapshot['_diagnostics']>['walletHistoricalCoverageDebug']
  let _hcEvents: PnlEvent[] = []
  if (_runHistoricalCoverage) {
    const hcCacheKey = `wallet:historicalCoverage:v1:${addrNorm}:${clampedMaxHistoricalPages}`
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
        const hcPromise = buildWalletHistoricalCoverage(addrNorm, GOLDRUSH_KEY, clampedMaxHistoricalPages, walletTradeStatsSummary.closedLots)
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
      for (let _hp = 0; _hp < _hcPages; _hp++) {
        _trackCall('goldrush', 'log_events_by_address', false, `gr:hc:p${_hp}:${addrNorm}`)
      }
    }
  } else {
    walletHistoricalCoverageSummary = { status: 'not_requested', requested: false, pagesAttempted: 0, maxPages: 0, rawTransactions: 0, rawLogEvents: 0, normalizedEvents: 0, walletSideEvents: 0, swapLikeTransactions: 0, pricedSwapCandidates: null, matchedClosedLotsBefore: null, matchedClosedLotsAfter: null, addedClosedLots: null, coverageLevel: 'none', missing: [], reason: null }
    _historicalCoverageDebug = undefined
  }

  tokenMeter.measure('normalization', walletHistoricalCoverageSummary, _historicalCoverageDebug, _hcEvents)

  // Phase 6B: Historical candidate comparison — compare historical events against base swap candidates
  const { summary: walletHistoricalCandidateSummary, debug: _historicalCandidateDebug, newCandidateEvidence: _hcNewCandidateEvidence, allHistoricalEvidence: _hcAllHistoricalEvidence } =
    _runHistoricalCoverage && _hcEvents.length > 0
      ? buildHistoricalCandidateComparison(_hcEvents, _swapEvidenceWithDetection, addrNorm)
      : { summary: { status: 'not_requested' as const, requested: false, baseEvidenceEvents: 0, historicalNormalizedEvents: 0, historicalWalletSideEvents: 0, existingSwapCandidates: 0, historicalSwapCandidates: 0, newSwapCandidateEvents: 0, duplicateSwapCandidateEvents: 0, candidateTransactions: 0, newCandidateTransactions: 0, candidateTokens: 0, newCandidateTokens: 0, earliestCandidateAt: null, latestCandidateAt: null, readyForHistoricalPricing: false, readyForHistoricalFifoPreview: false, missing: ['historical_coverage_not_requested'], reason: null }, debug: undefined, newCandidateEvidence: [] as WalletTxEvidence[], allHistoricalEvidence: [] as WalletTxEvidence[] }

  tokenMeter.measure('swapDetection', walletHistoricalCandidateSummary, _historicalCandidateDebug, _hcNewCandidateEvidence, _hcAllHistoricalEvidence)

  // Phase 6C: Historical pricing preview — price only the Phase 6B new swap candidates
  const { summary: walletHistoricalPricingPreviewSummary, debug: _historicalPricingPreviewDebug, pricedEvidence: _hcNewPricedEvidence } =
    _runHistoricalCoverage && _hcNewCandidateEvidence.length > 0
      ? await buildHistoricalPricingPreview(_hcNewCandidateEvidence, _hcAllHistoricalEvidence, _reqPriceCache)
      : { summary: { status: 'not_requested' as const, requested: false, newSwapCandidateEvents: 0, pricedHistoricalCandidates: 0, unpricedHistoricalCandidates: 0, stableLegPricedEvents: 0, wethLegPricedEvents: 0, historicalPricedEvents: 0, priceAttemptLimitReached: false, readyForHistoricalFifoPreview: false, missing: ['historical_coverage_not_requested'], reason: null }, debug: undefined, pricedEvidence: [] as WalletTxEvidence[] }
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

  // Phase 6E: Safe historical stats promotion
  const _shouldPromote =
    _runHistoricalCoverage &&
    walletHistoricalFifoPreviewSummary.safeToPromoteToPublicStats === true &&
    walletHistoricalFifoPreviewSummary.previewClosedLots > walletHistoricalFifoPreviewSummary.baselineClosedLots &&
    walletHistoricalFifoPreviewSummary.previewRealizedPnlUsd !== null &&
    isFinite(walletHistoricalFifoPreviewSummary.previewRealizedPnlUsd ?? NaN) &&
    walletHistoricalFifoPreviewSummary.addedClosedLots > 0

  const walletTradeStatsSource: WalletSnapshot['walletTradeStatsSource'] = _shouldPromote ? 'historical_promoted_preview' : 'base_sample'

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

  const _grEthAttempted = activityRequested && Boolean(GOLDRUSH_KEY) && useEthAlchemy
  const _grBaseAttempted = activityRequested && Boolean(GOLDRUSH_KEY)
  const _alchemyAttempted = activityRequested && Boolean(ALCHEMY_BASE_KEY)
  const _txSkippedReasons: string[] = []
  if (!activityRequested) {
    _txSkippedReasons.push('activity_not_requested')
  } else {
    if (!GOLDRUSH_KEY) _txSkippedReasons.push('goldrush_not_configured')
    if (!useEthAlchemy) _txSkippedReasons.push('goldrush_eth_skipped_chain_not_eth')
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
    normalizedPnlEventCount: events.length,
    totalEvidenceEvents: _txEvidenceDebugBase.totalRawEvents,
    eventsWithTxHash: _txEvidenceDebugBase.eventsWithHash,
    missingHashCount: _txEvidenceDebugBase.totalRawEvents - _txEvidenceDebugBase.eventsWithHash,
    missingTimestampCount: _txEvidenceDebugBase.totalRawEvents - _txEvidenceDebugBase.eventsWithTimestamp,
    skippedReasons: _txSkippedReasons,
    providerErrorSamples: _txProviderErrors.slice(0, 3),
  }
  const unpricedHoldingsCount = holdings.filter((h) => !h.price || h.price <= 0).length
  const hiddenDustCount = holdings.filter((h) => h.value <= 1).length
  const behaviorTxCount = behaviorRes.status === 'fulfilled' ? (behaviorRes.value.txCount ?? 0) : 0
  const hasHistoricalBaseActivity = grEvents.length > 0
  const walletBehavior = behaviorRes.status === 'fulfilled'
    ? (behaviorTxCount === 0 && hasHistoricalBaseActivity
      ? { ...behaviorRes.value, recentActivitySummary: 'Historical Base activity found, but no recent activity in checked window.' }
      : behaviorRes.value)
    : { ...BEHAVIOR_EMPTY, reason: 'Behavior fetch did not complete.' }
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
  const _apiTotalCredits = _apiCallLog.reduce((s, e) => s + e.credits, 0)
  const _apiWarnings: string[] = []
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
    behaviorSource: behaviorRes.status === 'fulfilled' ? behaviorRes.value.source : 'unavailable',
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
    walletHistoricalCoverageSummary,
    walletHistoricalCandidateSummary,
    walletHistoricalPricingPreviewSummary,
    walletHistoricalFifoPreviewSummary,
    walletFacts,
    dataFreshness: 'live',
    cacheAgeSeconds: null,
    _diagnostics: {
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
          reason: behaviorRes.status === 'fulfilled' ? '' : 'Behavior check unavailable from current checks.',
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
      walletLotEngineDebug: _lotEngineDebug,
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
      },
      walletSwapEnrichmentDebug: _swapEnrichmentDebug,
      walletFactsDebug: _walletFactsDebug,
      apiAudit: _apiAudit,
    },
  }
  tokenMeter.startTokenMeter('debugLogging')
  tokenMeter.measure('debugLogging', snapshot._debug, snapshot._diagnostics, walletFacts)
  tokenMeter.endTokenMeter('debugLogging')
  if (tokenMeter.wasDebugAutoDisabled()) snapshot.debugAutoDisabled = true
  snapshot.tokenUsage = tokenMeter.snapshot()

  // Requirement 8: validate audit before returning — if unhealthy, surface warnings prominently
  if (_apiAudit.warnings.length > 0 && snapshot._diagnostics?.apiAudit) {
    snapshot._diagnostics.apiAudit.warnings = _apiAudit.warnings
  }
  validateWalletFactsShape(snapshot)
  if (/^0x[0-9a-fA-F]{40}$/i.test(addrNorm)) snapshotMemCache.set(cacheKey, { snapshot, cachedAt: Date.now(), ttlMs: snapshotTtlMs })
  return snapshot
}
