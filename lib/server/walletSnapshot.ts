import { fetchMoralisBalances, type MoralisFetchResult, type MoralisChain } from './moralis'

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
    status: 'ready' | 'partial' | 'missing_hashes' | 'no_events' | 'not_requested'
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
    sampleSizeLabel: 'insufficient' | 'early' | 'developing' | 'strong'
    readyForWalletScore: boolean
    missing: string[]
  }
  walletTradeStatsSource: 'base_sample' | 'historical_promoted_preview'
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
    walletTxEvidenceDebug?: {
      sourceProvider: 'goldrush' | 'alchemy' | 'none'
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
  }
}

const ZERION_KEY       = process.env.ZERION_KEY ?? ''
const ALCHEMY_ETH_KEY  = process.env.ALCHEMY_ETHEREUM_KEY!
const ALCHEMY_BASE_KEY = process.env.ALCHEMY_BASE_KEY!
const GOLDRUSH_KEY     = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY ?? ''

export type WalletSnapshotOptions = { refresh?: boolean; chain?: 'eth' | 'base'; deepScan?: boolean; deepActivity?: boolean; chainMode?: 'auto' | 'base' | 'eth' | 'base_eth' | 'all_supported'; historicalCoverage?: boolean; maxHistoricalPages?: number }

const SNAPSHOT_TTL_MS         = 5  * 60 * 1000
const SNAPSHOT_HISTORY_TTL_MS = 15 * 60 * 1000
const SNAPSHOT_SCHEMA_VERSION = 'v7'
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
  source: 'stable_leg' | 'weth_leg' | 'historical_price' | 'current_price_fallback_not_used' | 'unavailable'
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

async function fetchGoldrushPnlEvents(address: string, chainName: string, apiKey: string): Promise<{ events: PnlEvent[]; diag: GoldrushHistoryDiag }> {
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
    if (process.env.NODE_ENV !== 'production') {
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
      let transferArrayCount = 0
      const firstTransferKeysCapture: string[] = []
      const events = items.flatMap((it) => {
        const t = it as Record<string, unknown>
        const txHash = typeof t.tx_hash === 'string' ? t.tx_hash : null
        const timestamp = typeof t.block_signed_at === 'string' ? t.block_signed_at : null
        // Transaction-level fields: who initiated the tx and which contract was called
        const txFromAddress = typeof t.from_address === 'string' ? t.from_address.toLowerCase() : null
        const txToAddress = typeof t.to_address === 'string' ? t.to_address.toLowerCase() : null
        const txSucceeded = typeof t.successful === 'boolean' ? t.successful : null
        const logEvents: unknown[] = Array.isArray(t.log_events) ? t.log_events : []
        return logEvents.flatMap((logEvent) => {
          const le = logEvent as Record<string, unknown>
          const decoded = le.decoded as Record<string, unknown> | null | undefined
          if (!decoded || decoded.name !== 'Transfer') return []
          const params = Array.isArray(decoded.params) ? (decoded.params as Record<string, unknown>[]) : []
          const fromParam = params.find(p => p.name === 'from')
          const toParam = params.find(p => p.name === 'to')
          const valueParam = params.find(p => p.name === 'value')
          if (!fromParam || !toParam || !valueParam) return []
          transferArrayCount++
          if (firstTransferKeysCapture.length === 0) {
            firstTransferKeysCapture.push(...Object.keys(le).slice(0, 12))
          }
          const contract = String(le.sender_address ?? '').toLowerCase()
          const symbol = String(le.sender_contract_ticker_symbol ?? '?')
          const decimals = typeof le.sender_contract_decimals === 'number' ? le.sender_contract_decimals : 18
          const from = String(fromParam.value ?? '').toLowerCase()
          const to = String(toParam.value ?? '').toLowerCase()
          const rawValue = String(valueParam.value ?? '0')
          const amount = Math.abs(parseFloat(rawValue) / Math.pow(10, decimals))
          const direction: 'buy' | 'sell' | 'unknown' = to === lower ? 'buy' : from === lower ? 'sell' : 'unknown'
          return [{ contract, symbol, direction, amount, amountRaw: rawValue !== '0' ? rawValue : null, tokenDecimals: decimals, usdValue: null, txHash, timestamp, fromAddress: from, toAddress: to, chain: chainName, txFromAddress, txToAddress, txSucceeded }]
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
        const result = await fetchGoldrushHistoricalPrice(wl.chain, wl.contract, e.timestamp)
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
    const histResult = await fetchGoldrushHistoricalPrice(e.chain, e.contract, e.timestamp)
    if (histResult.priceUsd !== null) {
      pricedHistoricalCandidates++; historicalPricedEventsCount++
      pricedEvidenceItems.push(markPriced(e, histResult.priceUsd, 'historical_price', 'medium', 'Historical token price from on-chain pricing data'))
      if (samplePricedRaw.length < 5) samplePricedRaw.push({ txHash: abbr(e.txHash), contract: abbr(e.contract), symbol: e.symbol, direction: e.direction, priceUsd: histResult.priceUsd, source: 'historical_price' })
      continue
    }

    unpricedHistoricalCandidates++
    if (sampleUnpricedRaw.length < 5) sampleUnpricedRaw.push({ txHash: abbr(e.txHash), contract: abbr(e.contract), symbol: e.symbol, direction: e.direction, reason: 'no_price_evidence' })
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

function buildTxEvidenceFromEvents(events: PnlEvent[], requested: boolean): {
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
  if (totalEvents === 0) {
    missing.push('no_transfer_events_indexed')
  } else {
    if (eventsWithHash < totalEvents) missing.push(`${totalEvents - eventsWithHash} events missing txHash`)
    if (eventsWithTimestamp < totalEvents) missing.push(`${totalEvents - eventsWithTimestamp} events missing timestamp`)
  }

  const status: WalletSnapshot['walletEvidenceSummary']['status'] =
    totalEvents === 0 ? 'no_events'
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
      readyForWalletScore: false, missing,
    },
    debug: {
      closedLots: 0, uniqueTokensTraded: 0, winningClosedLots: 0, losingClosedLots: 0,
      breakEvenClosedLots: 0, winRateComputed: false, winRateThreshold: WIN_RATE_THRESHOLD,
      avgPnlUsdPerClosedLot: null, avgReturnPercentPerClosedLot: null,
      medianReturnPercentPerClosedLot: null, avgHoldingTimeSeconds: null,
      medianHoldingTimeSeconds: null, largestWinUsd: null, largestLossUsd: null,
      confidence: 'open_check', sampleSizeLabel: 'insufficient',
      sampleWinningLots: [], sampleLosingLots: [], reasons: missing,
    },
  })

  if (!activityRequested) return emptyResult(['activity_not_requested'])
  if (closedLots.length === 0) return emptyResult(['no_closed_lots'])

  const n = closedLots.length

  // ── Status / confidence / sampleSizeLabel gates ──
  type Status = 'ok' | 'partial' | 'open_check'
  type Confidence = 'high' | 'medium' | 'low' | 'open_check'
  type SampleLabel = 'insufficient' | 'early' | 'developing' | 'strong'
  let summaryStatus: Status
  let confidence: Confidence
  let sampleSizeLabel: SampleLabel
  if (n >= 25)      { summaryStatus = 'ok';      confidence = 'high';   sampleSizeLabel = 'strong' }
  else if (n >= 10) { summaryStatus = 'ok';      confidence = 'medium'; sampleSizeLabel = 'developing' }
  else if (n >= 5)  { summaryStatus = 'partial'; confidence = 'medium'; sampleSizeLabel = 'early' }
  else              { summaryStatus = 'partial'; confidence = 'low';    sampleSizeLabel = 'insufficient' }

  // ── Per-lot classification ──
  const winning = closedLots.filter(l => l.realizedPnlUsd > BREAK_EVEN_EPSILON)
  const losing  = closedLots.filter(l => l.realizedPnlUsd < -BREAK_EVEN_EPSILON)
  const breakEven = closedLots.filter(l => Math.abs(l.realizedPnlUsd) <= BREAK_EVEN_EPSILON)
  const uniqueTokensTraded = new Set(closedLots.map(l => `${l.chain}:${l.tokenAddress}`)).size

  // ── Aggregates ──
  const totalRealizedPnl = closedLots.reduce((s, l) => s + l.realizedPnlUsd, 0)
  const totalCostBasis = closedLots.reduce((s, l) => s + l.costBasisUsd, 0)
  const realizedPnlPercent = totalCostBasis > 0 ? (totalRealizedPnl / totalCostBasis) * 100 : null

  const winRateComputed = n >= WIN_RATE_THRESHOLD
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
      readyForWalletScore: n >= WIN_RATE_THRESHOLD, missing,
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
    },
  }
}

async function fetchGoldrushHistoricalPrice(chain: string, contractAddress: string, timestamp: string): Promise<{ priceUsd: number | null; cacheHit: boolean; providerAttempted: boolean; error: boolean }> {
  if (!GOLDRUSH_KEY || !contractAddress.startsWith('0x')) return { priceUsd: null, cacheHit: false, providerAttempted: false, error: false }
  const dateStr = timestamp.slice(0, 10)
  if (!dateStr || dateStr.length !== 10) return { priceUsd: null, cacheHit: false, providerAttempted: false, error: false }
  const cacheKey = `pat:${chain}:${contractAddress.toLowerCase()}:${dateStr}`
  const cached = priceAtTimeMemCache.get(cacheKey)
  if (cached && cached.exp > Date.now()) return { priceUsd: cached.priceUsd, cacheHit: true, providerAttempted: false, error: false }
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
      return { priceUsd: null, cacheHit: false, providerAttempted: true, error: true }
    }
    const json = await res.json() as Record<string, unknown>
    const data = Array.isArray(json.data) ? json.data : []
    const tokenData = (data[0] ?? {}) as Record<string, unknown>
    const prices = Array.isArray(tokenData.prices) ? tokenData.prices : []
    const priceEntry = prices.find((p: unknown) => typeof (p as Record<string, unknown>).date === 'string' && ((p as Record<string, unknown>).date as string).slice(0, 10) === dateStr) ?? prices[0]
    const priceUsd = typeof (priceEntry as Record<string, unknown>)?.price === 'number' ? (priceEntry as Record<string, unknown>).price as number : null
    priceAtTimeMemCache.set(cacheKey, { exp: Date.now() + PRICE_AT_TIME_TTL_MS, priceUsd })
    return { priceUsd, cacheHit: false, providerAttempted: true, error: false }
  } catch {
    priceAtTimeMemCache.set(cacheKey, { exp: Date.now() + 5 * 60 * 1000, priceUsd: null })
    return { priceUsd: null, cacheHit: false, providerAttempted: true, error: true }
  }
}

async function buildPriceAtTimeEvidence(
  evidenceWithDetection: WalletTxEvidence[],
  activityRequested: boolean
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
  let unavailableEvents = 0
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
        const result = await fetchGoldrushHistoricalPrice(wl.chain, wl.contract, e.timestamp)
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
    const histResult = await fetchGoldrushHistoricalPrice(e.chain, e.contract, e.timestamp)
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

export async function fetchWalletSnapshot(address: string, options: WalletSnapshotOptions = {}): Promise<WalletSnapshot> {
  const { refresh = false, chain: requestedChain = 'base', deepScan = false, deepActivity = false, chainMode = 'auto', historicalCoverage = false, maxHistoricalPages: rawMaxHistoricalPages } = options
  const clampedMaxHistoricalPages = Math.max(1, Math.min(5, rawMaxHistoricalPages ?? 3))
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
        return {
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
    activityRequested && GOLDRUSH_KEY && useEthAlchemy ? fetchGoldrushPnlEvents(addr, 'eth-mainnet', GOLDRUSH_KEY) : Promise.resolve({ events: [] as PnlEvent[], diag: { endpointKind: 'transactions_v3' as const, chainUsed: 'eth-mainnet', urlTemplate: 'https://api.covalenthq.com/v1/eth-mainnet/address/{wallet}/transactions_v3/?page-size=50&page-number=0&with-logs=true&no-spam=true', httpStatus: null, fetchFailed: true, failureStage: 'build_url' as const, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], transferArrayCount: 0, firstTransferKeys: [], reason: activityRequested ? 'ETH chain not requested — skipped to reduce API usage.' : 'Activity scan not requested — skipped.' } }),
    activityRequested && GOLDRUSH_KEY ? fetchGoldrushPnlEvents(addr, 'base-mainnet', GOLDRUSH_KEY) : Promise.resolve({ events: [] as PnlEvent[], diag: { endpointKind: 'transactions_v3' as const, chainUsed: 'base-mainnet', urlTemplate: 'https://api.covalenthq.com/v1/base-mainnet/address/{wallet}/transactions_v3/?page-size=50&page-number=0&with-logs=true&no-spam=true', httpStatus: null, fetchFailed: true, failureStage: 'build_url' as const, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], transferArrayCount: 0, firstTransferKeys: [], reason: activityRequested ? 'GoldRush activity fetch skipped — provider not configured.' : 'Activity scan not requested — skipped.' } }),
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
    for (const c of activeChains) _moralisByChain.set(c, await fetchMoralisBalances(addr, c))
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
  const valuedGrEvents = grEvents.filter((e) => (e.usdValue ?? 0) > 0)
  const events = grEvents.length > 0 ? grEvents : alchemyEvents
  const _pnlSourceRaw: 'goldrush' | 'alchemy' | 'none' = grEvents.length > 0 ? 'goldrush' : alchemyEvents.length > 0 ? 'alchemy' : 'none'
  const pnlSource: 'activity_layer' | 'fallback_layer' | 'none' = _pnlSourceRaw === 'goldrush' ? 'activity_layer' : _pnlSourceRaw === 'alchemy' ? 'fallback_layer' : 'none'
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
    if (estimatedUnrealized !== null && coverage >= 60) unrealized += estimatedUnrealized
    if (estimatedRealized !== null && coverage >= 60) realized += estimatedRealized
    coverageNum += coverage
    pnlTokens.push({ symbol: h.symbol, contract: (h.contract ?? '').toLowerCase(), currentValueUsd: h.value, estimatedCostBasisUsd, estimatedUnrealizedPnlUsd: coverage >= 60 ? estimatedUnrealized : null, estimatedRealizedPnlUsd: coverage >= 60 ? estimatedRealized : null, buysDetected: buys.length, sellsDetected: sells.length, unexplainedTransfers: unexplained, coveragePercent: coverage, confidence: conf, reason: coverage < 60 ? 'PnL partial/unavailable: historical cost basis coverage too low.' : 'Estimated from average-cost using indexed transfers.' })
  }
  const coveragePercent = pnlTokens.length ? Math.round(coverageNum / pnlTokens.length) : 0
  const status: WalletSnapshot['estimatedPnl']['status'] = pnlTokens.length === 0 || pnlSource === 'none' ? 'unavailable' : coveragePercent >= 60 ? 'ok' : 'partial'
  const filteredPnlTokens = pnlTokens.filter((t) => t.coveragePercent > 0).sort((a, b) => (b.currentValueUsd - a.currentValueUsd)).slice(0, 10)
  const pnlCoverageReason = status === 'unavailable'
    ? (pnlSource === 'none' ? 'Enable Deep Activity Scan for full transfer history and cost-basis estimation.' : 'Historical cost basis coverage is too low for a reliable estimate.')
    : 'Estimated from indexed transfer history with average-cost method.'
  const pnlSourcePublic: 'activity_layer' | 'fallback_layer' | 'unavailable' = pnlSource === 'none' ? 'unavailable' : pnlSource
  const estimatedPnl: WalletSnapshot['estimatedPnl'] = { status, confidence: status === 'unavailable' ? null : confidenceFromCoverage(coveragePercent), coveragePercent, source: pnlSourcePublic === 'unavailable' ? 'none' : pnlSourcePublic, totalEstimatedPnlUsd: status === 'unavailable' ? null : realized + unrealized, unrealizedPnlUsd: status === 'unavailable' ? null : unrealized, realizedPnlUsd: status === 'unavailable' ? null : realized, method: 'average_cost_estimate', tokens: filteredPnlTokens, reason: status === 'unavailable' ? 'PnL unavailable — historical cost basis coverage is too low.' : 'Estimated PnL Beta derived from indexed wallet transfer history.' }
  const { evidenceList, summary: walletEvidenceSummary, debug: _txEvidenceDebugBase } = buildTxEvidenceFromEvents(events, activityRequested)
  const { evidenceWithDetection: _swapEvidenceWithDetection, summary: walletSwapSummary, debug: _swapDetectionDebug } = buildSwapDetection(evidenceList, activityRequested, addrNorm)
  const { evidenceWithPricing: _pricedEvidence, summary: walletPriceEvidenceSummary, debug: _priceAtTimeDebug } = await buildPriceAtTimeEvidence(_swapEvidenceWithDetection, activityRequested)
  const { summary: walletLotSummary, debug: _lotEngineDebug, closedLots: _closedLots } = buildFifoLotEngine(_pricedEvidence, activityRequested)
  const { summary: walletTradeStatsSummary, debug: _tradeStatsDebug } = buildTradeStatsSummary(_closedLots, activityRequested)

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
    }
  } else {
    walletHistoricalCoverageSummary = { status: 'not_requested', requested: false, pagesAttempted: 0, maxPages: 0, rawTransactions: 0, rawLogEvents: 0, normalizedEvents: 0, walletSideEvents: 0, swapLikeTransactions: 0, pricedSwapCandidates: null, matchedClosedLotsBefore: null, matchedClosedLotsAfter: null, addedClosedLots: null, coverageLevel: 'none', missing: [], reason: null }
    _historicalCoverageDebug = undefined
  }

  // Phase 6B: Historical candidate comparison — compare historical events against base swap candidates
  const { summary: walletHistoricalCandidateSummary, debug: _historicalCandidateDebug, newCandidateEvidence: _hcNewCandidateEvidence, allHistoricalEvidence: _hcAllHistoricalEvidence } =
    _runHistoricalCoverage && _hcEvents.length > 0
      ? buildHistoricalCandidateComparison(_hcEvents, _swapEvidenceWithDetection, addrNorm)
      : { summary: { status: 'not_requested' as const, requested: false, baseEvidenceEvents: 0, historicalNormalizedEvents: 0, historicalWalletSideEvents: 0, existingSwapCandidates: 0, historicalSwapCandidates: 0, newSwapCandidateEvents: 0, duplicateSwapCandidateEvents: 0, candidateTransactions: 0, newCandidateTransactions: 0, candidateTokens: 0, newCandidateTokens: 0, earliestCandidateAt: null, latestCandidateAt: null, readyForHistoricalPricing: false, readyForHistoricalFifoPreview: false, missing: ['historical_coverage_not_requested'], reason: null }, debug: undefined, newCandidateEvidence: [] as WalletTxEvidence[], allHistoricalEvidence: [] as WalletTxEvidence[] }

  // Phase 6C: Historical pricing preview — price only the Phase 6B new swap candidates
  const { summary: walletHistoricalPricingPreviewSummary, debug: _historicalPricingPreviewDebug, pricedEvidence: _hcNewPricedEvidence } =
    _runHistoricalCoverage && _hcNewCandidateEvidence.length > 0
      ? await buildHistoricalPricingPreview(_hcNewCandidateEvidence, _hcAllHistoricalEvidence)
      : { summary: { status: 'not_requested' as const, requested: false, newSwapCandidateEvents: 0, pricedHistoricalCandidates: 0, unpricedHistoricalCandidates: 0, stableLegPricedEvents: 0, wethLegPricedEvents: 0, historicalPricedEvents: 0, priceAttemptLimitReached: false, readyForHistoricalFifoPreview: false, missing: ['historical_coverage_not_requested'], reason: null }, debug: undefined, pricedEvidence: [] as WalletTxEvidence[] }

  // Phase 6D: Historical FIFO preview — run FIFO on baseline + new priced historical candidates
  const { summary: walletHistoricalFifoPreviewSummary, debug: _historicalFifoPreviewDebug, previewClosedLots: _hcPreviewClosedLots } =
    _runHistoricalCoverage && _hcNewPricedEvidence.length > 0
      ? buildHistoricalFifoPreview(_pricedEvidence, _hcNewPricedEvidence, _closedLots, walletTradeStatsSummary.realizedPnlUsd, walletTradeStatsSummary.realizedPnlPercent ?? null, walletHistoricalPricingPreviewSummary.unpricedHistoricalCandidates)
      : { summary: { status: 'not_requested' as const, requested: false, baselineClosedLots: 0, previewClosedLots: 0, addedClosedLots: 0, baselineRealizedPnlUsd: null, previewRealizedPnlUsd: null, addedRealizedPnlUsd: null, baselineRealizedPnlPercent: null, previewRealizedPnlPercent: null, winningClosedLotsPreview: 0, losingClosedLotsPreview: 0, breakEvenClosedLotsPreview: 0, uniqueTokensPreview: 0, previewConfidence: 'low' as const, readyForHistoricalTradeStatsPreview: false, safeToPromoteToPublicStats: false, missing: ['historical_coverage_not_requested'], reason: null }, debug: undefined, previewClosedLots: [] as WalletClosedLot[] }

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

  // Phase 6F: Build public closed trade samples (max 5, no tx hashes, no provider names)
  const _sampleSourceLots = _shouldPromote && _hcPreviewClosedLots.length > 0 ? _hcPreviewClosedLots : _closedLots
  const walletClosedTradeSamples: WalletSnapshot['walletClosedTradeSamples'] = _sampleSourceLots.slice(0, 5).map(l => ({
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
  }))

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
    : grEvents.length === 0
      ? 'No indexed wallet transfer history returned from current checks.'
      : valuedGrEvents.length === 0
        ? 'Transfer history returned but no valued events for cost-basis estimation.'
        : ''
  const alchemyConfigured = Boolean(ALCHEMY_BASE_KEY)
  const _zerionSucceeded = _zerionValueUsable || _zerionPositionsUsable
  if (process.env.NODE_ENV !== 'production') {
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
    walletClosedTradeSamples,
    walletHistoricalCoverageSummary,
    walletHistoricalCandidateSummary,
    walletHistoricalPricingPreviewSummary,
    walletHistoricalFifoPreviewSummary,
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
      walletTxEvidenceDebug: _txEvidenceDebug,
      walletSwapDetectionDebug: _swapDetectionDebug,
      walletPriceAtTimeDebug: _priceAtTimeDebug,
      walletLotEngineDebug: _lotEngineDebug,
      walletTradeStatsDebug: _tradeStatsDebug,
      walletHistoricalCoverageDebug: _historicalCoverageDebug,
      walletHistoricalCandidateDebug: _historicalCandidateDebug,
      walletHistoricalPricingPreviewDebug: _historicalPricingPreviewDebug,
      walletHistoricalFifoPreviewDebug: _historicalFifoPreviewDebug,
    },
  }
  if (/^0x[0-9a-fA-F]{40}$/i.test(addrNorm)) snapshotMemCache.set(cacheKey, { snapshot, cachedAt: Date.now(), ttlMs: snapshotTtlMs })
  return snapshot
}
