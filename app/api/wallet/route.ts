import { NextResponse } from 'next/server'
import { fetchWalletSnapshot, type WalletSnapshotOptions } from '@/lib/server/walletSnapshot'
import { computeWalletPersonality, computeWindowedPnl, computeBotScore } from '@/lib/server/walletIntelligence'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import {
  walletScanPersistentCacheAvailable,
  readPersistentWalletCache,
  readStalePersistentWalletCache,
  writePersistentWalletCache,
  readPersistentCooldown,
  writePersistentCooldown,
} from '@/lib/server/walletScanPersistentCache'

// BUGFIX: nested debug fields baked into a snapshot at live-fetch time (e.g.
// walletProfileDebug.cacheSource) stay 'live' forever once that payload is persisted, even after
// it's served back out as a cache hit — only the top-level dataFreshness was being corrected to
// 'cached'. Normalize the nested field too whenever a cached payload is about to be returned, so
// public dataFreshness and walletProfileDebug.cacheSource never contradict each other. Uses the
// existing 'memory_cache' literal already in WalletSnapshot['walletProfileDebug']['cacheSource']
// — no public shape change.
function normalizeCachedFreshness(cp: any): any {
  if (cp && typeof cp === 'object' && cp.walletProfileDebug && typeof cp.walletProfileDebug === 'object') {
    cp.walletProfileDebug = { ...cp.walletProfileDebug, cacheSource: 'memory_cache' }
  }
  // HOLDINGS-PROVIDER-ROUTING-HONESTY: a cached snapshot already carries the holdings provider that
  // was actually selected when it was live-fetched (providerUsed/portfolioSource/
  // walletHoldingsProviderRoutingDebug.selectedProvider) — preserve those as-is, just make sure
  // walletModuleCoverageRaw.portfolioProvider (re-derived per request in this route file, not stored
  // verbatim) can't disagree with the cached selection by falling back to a "configured" guess.
  if (cp && typeof cp === 'object' && cp.walletModuleCoverageRaw && typeof cp.walletModuleCoverageRaw === 'object') {
    const _cachedSelected = cp._diagnostics?.walletHoldingsProviderRoutingDebug?.selectedProvider
    if (_cachedSelected) {
      cp.walletModuleCoverageRaw = { ...cp.walletModuleCoverageRaw, portfolioProvider: _cachedSelected }
    }
  }
  return cp
}

// FIX-2: a cached/recovered payload can carry a stale walletTradeStatsSummary.publicPnlStatus
// computed before an earlier fix, or copied verbatim from cache without re-derivation. Re-assert
// the safety net at the response boundary: no verified closed lots means publicPnlStatus can
// never read 'ok', regardless of where the payload came from.
// FIX-4: slim/persistent cache payloads don't store the full swap-reconstruction diagnostics, so
// the field falls through to null. Surface an explicit "not available from cache" placeholder
// instead of a bare null — without running any new receipt fetches.
const SWAP_RECONSTRUCTION_V1_DEBUG_UNAVAILABLE_FROM_CACHE = {
  swapReconstructionV1Attempted: false,
  swapReconstructionV1Reason: 'not_available_from_cached_snapshot',
  swapReconstructionCandidateTxCount: 0,
  swapReconstructionReceiptsFetched: 0,
  swapReconstructionEventsBuilt: 0,
  swapReconstructionEventsPromoted: 0,
  swapReconstructionEventsRejected: 0,
  sampleReconstructedSwaps: [],
}

function normalizePublicPnlStatus(cp: any): any {
  const ts = cp?.walletTradeStatsSummary
  if (ts && typeof ts === 'object') {
    const noVerifiedClosedLots = ts.status === 'open_check' || (ts.closedLotsForStats ?? 0) === 0 || (ts.verifiedClosedLots ?? 0) === 0
    if (noVerifiedClosedLots) {
      cp.walletTradeStatsSummary = {
        ...ts,
        closedLots: ts.closedLotsForStats ?? 0,
        winningClosedLots: 0,
        losingClosedLots: 0,
        breakEvenClosedLots: 0,
        publicPnlStatus: 'open_check',
      }
    }
  }
  return cp
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {}
  if (origin && origin.endsWith('.vercel.app')) {
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    headers['Access-Control-Max-Age'] = '86400'
  }
  return headers
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get('origin')
  return new Response(null, { status: 200, headers: corsHeaders(origin) })
}

const WALLET_BASIC_CACHE_TTL_MS  = 5  * 60 * 1000  // 5 min for basic scans
const WALLET_DEEP_CACHE_TTL_MS   = 60 * 60 * 1000  // 60 min for deep scans — reduces repeat GoldRush burns
const WALLET_HISTORICAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24h for full historical scan cache
const WALLET_DEEP_COOLDOWN_MS    = 30 * 60 * 1000  // 30 min cooldown per wallet after deep live scan

// Credit-saving env flags
// CHAINLENS_WALLET_TEST_CACHE_ONLY=true — blocks all live GoldRush calls (dev/testing only)
const WALLET_TEST_CACHE_ONLY = process.env.CHAINLENS_WALLET_TEST_CACHE_ONLY === 'true'
// CHAINLENS_GOLDRUSH_DAILY_SOFT_CAP — daily credit soft cap (informational, logged when exceeded)
const GOLDRUSH_DAILY_SOFT_CAP = parseInt(process.env.CHAINLENS_GOLDRUSH_DAILY_SOFT_CAP ?? '0', 10) || 0
const WALLET_ADMIN_FORENSIC_SCAN = process.env.CHAINLENS_WALLET_ADMIN_FORENSIC_SCAN === 'true'
const WALLET_ADMIN_HISTORICAL_HARD_CAP = parseInt(process.env.CHAINLENS_WALLET_ADMIN_HISTORICAL_HARD_CAP ?? '50', 10) || 50
let _goldrushDailyCreditsUsed = 0
let _goldrushDailyCreditsResetAt = 0
const WALLET_SNAPSHOT_SCHEMA_VERSION = 'v46'
const walletCache = new Map<string, { exp: number; payload: unknown; cachedAt: number }>()
const walletRate = new Map<string, { count: number; resetAt: number }>()
const WALLET_RATE_BY_PLAN: Record<string, number> = { free: 20, pro: 60, elite: 180 }

// Cost safety — historical cooldown, deep cooldown, cost hints, in-flight dedup
const WALLET_HC_COOLDOWN_MS  = 10 * 60 * 1000  // 10 min cooldown per wallet after historical live scan
const WALLET_COST_HINT_TTL_MS = 60 * 60 * 1000  // retain cost hints 1 hour
const walletHistoricalCooldown = new Map<string, number>()    // cooldownKey -> expiry timestamp
const walletDeepCooldown = new Map<string, number>()          // cacheKey -> expiry timestamp for deep scans
const walletCostHints = new Map<string, { rawLogEvents: number; requestDurationMs: number; cachedAt: number }>()
const walletDeepInFlight = new Map<string, Promise<unknown>>() // inFlightKey -> live scan promise

const WALLET_DEEP_DEBUG_ENABLED = process.env.WALLET_DEEP_DEBUG_ENABLED === 'true'

type WalletDeepScanTimings = {
  totalMs: number
  chainDiscoveryMs: number
  holdingsMs: number
  activityMs: number
  swapDetectionMs: number
  priceEvidenceMs: number
  lotEngineMs: number
  tradeStatsMs: number
  cacheHit: boolean
  dedupeHit: boolean
  chainsAttempted: number
  chainsSkipped: number
}

type LegacyWalletDeepScanTiming = WalletDeepScanTimings & {
  portfolioMs: number
  pricingMs: number
  fifoMs: number
  historicalMs: number
  cacheReadMs: number
  cacheWriteMs: number
}

const zeroWalletDeepScanTiming = (): LegacyWalletDeepScanTiming => ({
  totalMs: 0, chainDiscoveryMs: 0, holdingsMs: 0, activityMs: 0, swapDetectionMs: 0, priceEvidenceMs: 0, lotEngineMs: 0, tradeStatsMs: 0,
  cacheHit: false, dedupeHit: false, chainsAttempted: 0, chainsSkipped: 0,
  portfolioMs: 0, pricingMs: 0, fifoMs: 0, historicalMs: 0, cacheReadMs: 0, cacheWriteMs: 0,
})

function buildWalletDeepScanTiming(snapshot: any, startedAt: number, cacheReadMs: number, cacheWriteMs: number, opts: { totalOverrideMs?: number; cacheHit?: boolean; dedupeHit?: boolean } = {}): LegacyWalletDeepScanTiming {
  const perf = snapshot?._diagnostics?.walletPerformanceDebug ?? snapshot?._debug?.walletPerformanceDebug ?? null
  const phases = perf?.phaseDurations ?? {}
  const provider = perf?.providerDurations ?? {}
  const routing = snapshot?._diagnostics?.walletActivityRoutingDebug ?? snapshot?._debug?.walletActivityRoutingDebug ?? null
  const flow = routing?.providerFlow ?? {}
  const chainUsage = routing?.chainUsage ?? {}
  const chainsAttempted = Array.isArray(routing?.activeChainsUsedForActivity) ? routing.activeChainsUsedForActivity.length
    : Array.isArray(flow?.moralisChainsAttempted) ? flow.moralisChainsAttempted.length
    : Array.isArray(chainUsage?.activeChains) ? chainUsage.activeChains.length
    : 0
  const chainsSkipped = [
    ...(Array.isArray(routing?.chainsDiscoveredNotScannedForActivity) ? routing.chainsDiscoveredNotScannedForActivity : []),
    ...(Array.isArray(routing?.skippedDustChains) ? routing.skippedDustChains : []),
    ...(Array.isArray(routing?.chainsExcludedByCap) ? routing.chainsExcludedByCap : []),
    ...(Array.isArray(routing?.chainsExcludedByUnsupported) ? routing.chainsExcludedByUnsupported : []),
    ...(Array.isArray(routing?.chainsExcludedByProviderSafety) ? routing.chainsExcludedByProviderSafety : []),
  ].filter((v, i, a) => typeof v === 'string' && a.indexOf(v) === i).length
  const routeTotal = Math.max(0, opts.totalOverrideMs ?? Date.now() - startedAt)
  const chainDiscoveryMs = Math.max(0, Number(perf?.chainDiscoveryMs ?? provider?.chain_discovery ?? phases?.chain_discovery ?? 0) || 0)
  const holdingsMs = Math.max(0, Number(perf?.holdingsMs ?? perf?.portfolioMs ?? provider?.phase1_providers ?? phases?.phase1 ?? 0) || 0)
  const priceEvidenceMs = Math.max(0, Number(perf?.pricingMs ?? phases?.pricing ?? phases?.priceInference ?? 0) || 0)
  const lotEngineMs = Math.max(0, Number(perf?.fifoMs ?? phases?.fifo ?? phases?.fifoEngine ?? 0) || 0)
  return {
    totalMs: routeTotal,
    chainDiscoveryMs,
    holdingsMs,
    activityMs: Math.max(0, Number(perf?.activityMs ?? provider?.activity_fetch ?? phases?.activity ?? phases?.normalization ?? 0) || 0),
    swapDetectionMs: Math.max(0, Number(perf?.swapDetectionMs ?? phases?.swapDetection ?? 0) || 0),
    priceEvidenceMs,
    lotEngineMs,
    tradeStatsMs: Math.max(0, Number(perf?.tradeStatsMs ?? phases?.tradeStats ?? 0) || 0),
    cacheHit: Boolean(opts.cacheHit),
    dedupeHit: Boolean(opts.dedupeHit),
    chainsAttempted,
    chainsSkipped,
    portfolioMs: holdingsMs,
    pricingMs: priceEvidenceMs,
    fifoMs: lotEngineMs,
    historicalMs: Math.max(0, Number(perf?.historicalMs ?? phases?.historical ?? 0) || 0),
    cacheReadMs: Math.max(0, cacheReadMs),
    cacheWriteMs: Math.max(0, cacheWriteMs),
  }
}

function attachWalletDeepScanTiming(payload: any, timing: LegacyWalletDeepScanTiming, debug: boolean) {
  if (!payload || typeof payload !== 'object') return
  const publicTiming = { portfolioMs: timing.portfolioMs, holdingsMs: timing.holdingsMs, activityFetchMs: timing.activityMs, activityMs: timing.activityMs, normalizationMs: timing.activityMs, mergeMs: 0, swapDetectionMs: timing.swapDetectionMs, pricingMs: timing.pricingMs, fifoMs: timing.fifoMs, integrityMs: timing.tradeStatsMs, tradeStatsMs: timing.tradeStatsMs, recoveryMs: timing.historicalMs, historicalMs: timing.historicalMs, totalMs: timing.totalMs, cacheReadMs: timing.cacheReadMs, cacheWriteMs: timing.cacheWriteMs }
  payload.walletDeepScanTiming = publicTiming
  if (debug) {
    const { portfolioMs: _portfolioMs, pricingMs: _pricingMs, fifoMs: _fifoMs, historicalMs: _historicalMs, cacheReadMs: _cacheReadMs, cacheWriteMs: _cacheWriteMs, ...walletDeepScanTimings } = timing
    payload._debug = { ...(payload._debug ?? {}), walletDeepScanTiming: publicTiming, walletDeepScanTimings }
  }
}



type WalletLoadStage = 'portfolio' | 'holdings' | 'activity' | 'pricing' | 'fifo' | 'recovery' | 'final'

function attachWalletDeepScanStaging(payload: any, opts: { mode: 'standard' | 'deep'; cacheHit?: boolean; dedupeHit?: boolean; inFlightDeduped?: boolean; debug?: boolean }) {
  if (!payload || typeof payload !== 'object') return
  const moduleCoverage = payload.walletModuleCoverage ?? buildWalletModuleCoverage(payload)
  const holdingsReady = Array.isArray(payload.holdings) || Number(payload.holdingsCount ?? 0) > 0 || Number(payload.totalValue ?? 0) >= 0
  const portfolioReady = Boolean(moduleCoverage?.portfolio?.status && moduleCoverage.portfolio.status !== 'open_check') || holdingsReady
  const activityReady = Boolean(moduleCoverage?.activity?.status && !['open_check', 'not_requested'].includes(moduleCoverage.activity.status)) || Number(payload.walletEvidenceSummary?.totalEvents ?? 0) > 0
  const tradeBehaviorReady = Boolean(payload.tradeIntelligence && payload.tradeIntelligence.status !== 'open_check') || Boolean(moduleCoverage?.tradeIntelligence?.status && moduleCoverage.tradeIntelligence.status !== 'open_check') || Boolean(moduleCoverage?.behavior?.status && moduleCoverage.behavior.status !== 'open_check')
  const pnlIntegrity = payload.walletPnlIntegrity?.status ?? payload.walletTradeStatsSummary?.pnlIntegrityStatus ?? payload.walletPnlBlockerSummary?.status ?? null
  const integrityReady = Boolean(pnlIntegrity) || Boolean(payload.publicPnlStatus) || Boolean(payload.walletPnlRead)
  const pnlReady = Boolean(integrityReady && !['invalid', 'locked', 'open_check_integrity_invalid'].includes(String(pnlIntegrity ?? payload.publicPnlStatus ?? '')))
  const recoveryStatus = payload.walletHistoricalRecoveryStatus ?? (payload.walletHistoricalCoverage?.checked ? 'attempted' : null)
  const recoveryReady = opts.mode === 'standard' || Boolean(recoveryStatus)
  const heavyModulesPending: string[] = []
  if (!activityReady && opts.mode === 'deep') heavyModulesPending.push('activity')
  if (!tradeBehaviorReady && opts.mode === 'deep') heavyModulesPending.push('trade_reconstruction')
  if (!integrityReady && opts.mode === 'deep') heavyModulesPending.push('pnl_integrity')
  if (!recoveryReady && opts.mode === 'deep') heavyModulesPending.push('historical_recovery')
  let stage: WalletLoadStage = !portfolioReady ? 'portfolio'
    : !holdingsReady ? 'holdings'
    : !activityReady && opts.mode === 'deep' ? 'activity'
    : !tradeBehaviorReady && opts.mode === 'deep' ? 'fifo'
    : !integrityReady && opts.mode === 'deep' ? 'pricing'
    : !recoveryReady && opts.mode === 'deep' ? 'recovery'
    : 'final'
  // NON-TRADER-EARLY-EXIT-3: walletNoPnlReason === 'non_trader_address_type' means the engine
  // already reached its final verdict (PnL not applicable) without needing the heavy recovery
  // modules — load state must report 'final' with nothing pending instead of looking stuck mid-scan.
  const nonTraderEarlyExit = payload.walletNoPnlReason === 'non_trader_address_type'
  let finalPnlReady = pnlReady
  let finalRecoveryReady = recoveryReady
  let finalHeavyModulesPending = heavyModulesPending
  if (nonTraderEarlyExit) {
    stage = 'final'
    finalPnlReady = false
    finalRecoveryReady = true
    finalHeavyModulesPending = []
  }
  payload.walletLoadState = {
    mode: opts.mode,
    stage,
    portfolioReady,
    holdingsReady,
    activityReady,
    tradeBehaviorReady: nonTraderEarlyExit ? Boolean(payload.walletFacts?.sourceClassification) || tradeBehaviorReady : tradeBehaviorReady,
    pnlReady: finalPnlReady,
    recoveryReady: finalRecoveryReady,
    integrityReady,
    partialResponseSafe: portfolioReady && holdingsReady,
    heavyModulesPending: finalHeavyModulesPending,
    ...(nonTraderEarlyExit ? { skippedReason: 'non_trader_address_type: trade reconstruction and historical recovery were skipped because this address does not show trader behavior.' } : {}),
    lastUpdatedAt: new Date().toISOString(),
  }
  const timing = payload.walletDeepScanTiming ?? {}
  const audit = payload.apiAudit ?? payload._diagnostics?.walletApiAuditDebug ?? {}
  const priceDebug = payload._diagnostics?.walletPriceAtTimeDebug ?? payload._debug?.walletPriceAtTimeDebug ?? {}
  const duplicateEventsRemoved = Number(payload._diagnostics?.walletChainActivityMergeDebug?.duplicateEventsRemoved ?? payload._debug?.walletChainActivityMergeDebug?.duplicateEventsRemoved ?? 0) || 0
  payload.walletDeepScanOptimizationDebug = {
    cacheHitStages: opts.cacheHit ? ['snapshot', 'normalized_events', 'merged_events', 'price_evidence', 'matched_lots_summary'] : [],
    reusedEvidenceStages: [opts.dedupeHit || opts.inFlightDeduped ? 'in_flight_scan' : null, opts.cacheHit ? 'route_cache' : null].filter(Boolean),
    duplicatePriceRequestsAvoided: Math.max(0, Number(priceDebug.duplicateRequestsAvoided ?? priceDebug.cacheHits ?? 0) || 0),
    duplicateEventsRemoved,
    parallelStagesUsed: opts.mode === 'deep' ? ['portfolio_holdings_vs_activity', 'independent_chain_activity_fetches', 'batched_price_evidence'] : ['portfolio_holdings'],
    heavyModulesDeferred: heavyModulesPending,
    noExtraProviderCalls: true,
    providerCallCountUnchanged: true,
    liveProviderCalls: Number(audit?.totals?.liveProviderCalls ?? 0) || undefined,
  }
  if (opts.debug) payload._debug = { ...(payload._debug ?? {}), walletLoadState: payload.walletLoadState, walletDeepScanOptimizationDebug: payload.walletDeepScanOptimizationDebug }
}

function stripUndefinedInPlace(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      if (value[i] === undefined) value.splice(i, 1)
      else stripUndefinedInPlace(value[i])
    }
    return value
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const current = (value as Record<string, unknown>)[key]
      if (current === undefined) delete (value as Record<string, unknown>)[key]
      else stripUndefinedInPlace(current)
    }
  }
  return value
}

function pruneWalletScannerDebug(payload: any, debug: boolean) {
  if (!payload || typeof payload !== 'object') return
  if (!debug) {
    const walletScannerDiagnostics = payload._debug?.walletScannerDiagnostics
    const walletFactsShapeIssues = payload._debug?.walletFactsShapeIssues
    if (walletScannerDiagnostics || walletFactsShapeIssues) {
      payload._debug = {
        ...(walletFactsShapeIssues ? { walletFactsShapeIssues } : {}),
        ...(walletScannerDiagnostics ? { walletScannerDiagnostics } : {}),
      }
    } else {
      delete payload._debug
    }
  }
  delete payload._diagnostics
  delete payload._cachedDiagnosticsSlim  // slim debug is surfaced in _debug if debug=true; always remove from payload
  stripUndefinedInPlace(payload)
}

type WalletValueTier = 'micro' | 'small' | 'standard' | 'high_value' | 'whale'
type PnlCacheQuality = 'complete' | 'partial_needs_historical' | 'stale_low_coverage' | 'partial_public_performance' | 'partial_invalid_integrity' | 'limited_verified_sample'

function getWalletValueTier(totalValueUsd: number): WalletValueTier {
  if (totalValueUsd >= 1_000_000) return 'whale'
  if (totalValueUsd >= 2_500) return 'high_value'
  if (totalValueUsd >= 500) return 'standard'
  if (totalValueUsd >= 100) return 'small'
  return 'micro'
}

function buildPublicWalletScanBudget(scanMode: string, requestedHistoricalScan: boolean, walletValueTier: WalletValueTier, adminOverrideUsed = false) {
  const target = adminOverrideUsed ? 15 : walletValueTier === 'micro' ? 6 : walletValueTier === 'small' ? 12 : 15
  const hardCap = adminOverrideUsed ? WALLET_ADMIN_HISTORICAL_HARD_CAP : walletValueTier === 'micro' ? 6 : 18
  return {
    scanMode,
    requestedHistoricalScan,
    walletValueTier,
    totalCreditTarget: target,
    totalCreditHardCap: hardCap,
    creditsUsed: 0,
    creditsRemaining: hardCap,
    budgetByPhase: { portfolio: 2, activity: 3, pricing: 6, historicalRecovery: 6 },
    budgetCapHit: false,
    budgetCapReason: null as string | null,
    skippedAfterBudgetCap: 0,
    estimatedCreditsSavedByCache: 0,
    estimatedCreditsUsed: 0,
    actualCreditsUsed: 0,
  }
}

function getWalletPnlRecoverySignals(snap: any) {
  const totalValue = Number(snap?.totalValue ?? 0) || 0
  const walletValueTier = getWalletValueTier(totalValue)
  // PHASE5-FIX-1: read the fields that actually exist on WalletSnapshot — estimatedPnl has
  // coveragePercent (and now coveragePercentValueWeighted), not `coverage`; closedLots lives on
  // walletLotSummary/walletTradeStatsSummary, not on estimatedPnl. Each read has an explicit
  // typed fallback (0 / {} / 'not_requested') rather than silently resolving to null/undefined.
  const estimatedCoverage = Number(snap?.estimatedPnl?.coveragePercent ?? 0) || 0
  const estimatedCoverageValueWeighted = Number(snap?.estimatedPnl?.coveragePercentValueWeighted ?? estimatedCoverage) || 0
  const lot = snap?.walletLotSummary ?? {}
  const stats = snap?.walletTradeStatsSummary ?? {}
  const historical = snap?.walletHistoricalCoverageSummary ?? {}
  const backfill = snap?._diagnostics?.unmatchedSellBackfillDebug ?? snap?._debug?.unmatchedSellBackfillDebug ?? snap?._cachedDiagnosticsSlim?.unmatchedSellBackfillDebug ?? {}
  const closedLots = Number(lot.closedLots ?? stats.closedLots ?? 0) || 0
  const openedLots = Number(lot.openedLots ?? stats.openedLots ?? 0) || 0
  const unmatchedSells = Number(lot.unmatchedSells ?? backfill.unmatchedSellCount ?? 0) || 0
  const unmatchedBuys = Number(lot.unmatchedBuys ?? 0) || 0
  const historicalStatus = typeof historical.status === 'string' ? historical.status : 'not_requested'
  const historicalRequested = historical.requested === true
  const backfillReason = String(backfill.reason ?? backfill.stopReason ?? '')
  const backfillTimedOut = backfillReason.includes('timeout')
  // PHASE4-FIX-6: the historical-coverage flag was only ever flipped on by coverage/unmatched-lot
  // signals, never by the raw shape of the activity itself — so a wallet spanning multiple chains
  // or with a large event count, but otherwise-"fine-looking" lot stats, never tripped recovery.
  const chainCount = Array.isArray(snap?.walletFacts?.summary?.chainExposure) ? snap.walletFacts.summary.chainExposure.length : 0
  const totalEvents = Number(snap?.walletEvidenceSummary?.totalEvents ?? 0) || 0
  const multiChain = chainCount > 1
  const highEventVolume = totalEvents > 200
  // COST-GUARD-FIX: closedLots above is the RAW FIFO count (can include synthetic lots), so
  // historicalStatus === 'not_requested' alone used to force needsHistorical=true even when
  // walletSnapshot already found real-backed closed lots and explicitly recommended against
  // recovery (walletRecoveryRecommendation.reason === 'closed_lots_already_found') — running a
  // second, expensive historical scan (historical_by_addresses_v2/log_events_by_address) for no
  // reason. Real-backed closed lots already found means there is nothing left to recover.
  const closedLotsForStats = Number(lot.closedLotsForStats ?? lot.realClosedLots ?? stats.closedLotsForStats ?? stats.verifiedClosedLots ?? 0) || 0
  const recoveryAlreadyFound = snap?.walletRecoveryRecommendation?.recommended === false
    && snap?.walletRecoveryRecommendation?.reason === 'closed_lots_already_found'
    && closedLotsForStats > 0
  return {
    walletValueTier,
    coveragePercent: estimatedCoverage,
    coveragePercentValueWeighted: estimatedCoverageValueWeighted,
    closedLots,
    closedLotsForStats,
    recoveryAlreadyFound,
    openedLots,
    unmatchedSells,
    unmatchedBuys,
    tradeStatus: typeof stats.status === 'string' ? stats.status : null,
    historicalStatus,
    historicalRequested,
    backfillTimedOut,
    chainCount,
    totalEvents,
    // PHASE5-FIX-5: a wallet can look "fine" on unweighted coverage while its highest-value
    // holdings are poorly covered (or vice versa) — checking both keeps recovery from being
    // skipped just because the tx-count average happened to clear the threshold.
    needsHistorical: !recoveryAlreadyFound && (walletValueTier === 'high_value' || walletValueTier === 'whale' || estimatedCoverage < 60 || estimatedCoverageValueWeighted < 60 || unmatchedSells > 0 || unmatchedBuys > 0 || closedLots < 10 || stats.status === 'partial' || historicalStatus === 'not_requested' || (multiChain && highEventVolume) || (multiChain && (unmatchedSells > 0 || closedLots === 0))),
  }
}

function getPnlCacheQuality(snap: any): PnlCacheQuality {
  const s = getWalletPnlRecoverySignals(snap)
  const ts = snap?.walletTradeStatsSummary ?? {}
  const rawClosedLots = Number(ts.rawClosedLots ?? snap?.rawClosedLots ?? 0)
  const performanceClosedLots = Number(ts.performanceClosedLots ?? snap?.performanceClosedLots ?? s.closedLotsForStats ?? 0)
  const hasExcludedLots = Number(ts.syntheticClosedLotsExcluded ?? snap?.syntheticClosedLotsExcluded ?? 0) > 0 || Number(ts.estimateOnlyClosedLots ?? snap?.estimateOnlyClosedLots ?? 0) > 0 || Number(ts.flatPriceClosedLotsExcluded ?? snap?.flatPriceClosedLotsExcluded ?? 0) > 0
  if (snap?.pnlIntegrityCheck?.status === 'invalid') return 'partial_invalid_integrity'
  if (snap?.isPnlPartial === true || hasExcludedLots || (rawClosedLots > 0 && performanceClosedLots > 0 && performanceClosedLots < rawClosedLots)) return performanceClosedLots > 0 && performanceClosedLots < 10 ? 'limited_verified_sample' : 'partial_public_performance'
  const lowCoverage = s.coveragePercent < 60 || s.closedLots < 10
  if (s.backfillTimedOut && lowCoverage) return 'stale_low_coverage'
  if (!s.historicalRequested && (lowCoverage || s.unmatchedSells > 0 || s.unmatchedBuys > 0)) return 'partial_needs_historical'
  return 'complete'
}

function annotatePnlCacheQuality(payload: any, quality: PnlCacheQuality) {
  if (!payload || typeof payload !== 'object') return
  payload.pnlCacheQuality = quality
  if (quality !== 'complete') {
    payload.walletScanCacheNote = 'Cached wallet snapshot loaded, but historical PnL recovery is still needed for fuller trade stats.'
    payload.walletPnlRecoveryCta = 'Run historical recovery / Retry deep scan when budget allows'
  }
}

function buildWalletModuleCoverage(snap: any) {
  const ev = snap.walletEvidenceSummary
  const sw = snap.walletSwapSummary
  const pr = snap.walletPriceEvidenceSummary
  const ls = snap.walletLotSummary
  const ts = snap.walletTradeStatsSummary
  const bh = snap.walletBehavior
  const holdingsCount: number = snap.holdingsCount ?? (snap.holdings?.length ?? 0)
  const totalUsdAvailable: boolean = snap.totalUsdAvailable !== false && (snap.totalValue ?? 0) > 0

  // Portfolio
  const portStatus = holdingsCount > 0 && totalUsdAvailable ? 'ok' : holdingsCount > 0 ? 'partial' : 'open_check'

  // Activity
  const totalEvents: number = ev?.totalEvents ?? 0
  const eventsWithHash: number = ev?.eventsWithHash ?? 0
  const eventsWithTs: number = ev?.eventsWithTimestamp ?? 0
  const hashCov = totalEvents > 0 ? eventsWithHash / totalEvents : 0
  const tsCov = totalEvents > 0 ? eventsWithTs / totalEvents : 0
  const actUnavailable = ev?.status === 'provider_unavailable' || ev?.missing?.includes('activity_provider_unavailable')
  const actStatus = actUnavailable ? 'open_check' : totalEvents > 0 && hashCov >= 0.8 && tsCov >= 0.8 ? 'ok' : totalEvents > 0 ? 'partial' : 'open_check'
  const actReason = actUnavailable ? 'provider_unavailable' : totalEvents === 0 ? 'no_activity_events' : actStatus === 'partial' ? `${totalEvents}_events_low_hash_coverage` : `${totalEvents}_events_indexed`

  // Swap detection
  const swapCandidates: number = sw?.swapCandidateCount ?? pr?.swapCandidateEvents ?? 0
  const swapStatus = swapCandidates > 0 ? (sw?.status === 'open_check' ? 'open_check' : 'ok') : totalEvents > 0 ? 'open_check' : 'open_check'
  const swapReason = swapCandidates > 0 ? `${swapCandidates}_swap_candidates_found` : totalEvents > 0 ? 'activity_found_no_swap_patterns' : 'no_activity_events'

  // Price evidence
  const pricedEvents: number = pr?.pricedEvents ?? 0
  const swapCandidateEvents: number = pr?.swapCandidateEvents ?? swapCandidates
  const priceStatus = pricedEvents > 0 ? (pr?.status ?? 'ok') : swapCandidateEvents > 0 ? 'open_check' : 'open_check'
  const priceReason = pricedEvents > 0 ? `${pricedEvents}_events_priced` : swapCandidateEvents > 0 ? 'swap_candidates_not_priced' : 'no_swap_candidates_to_price'

  // FIFO PnL — public fields use real-backed closed lots only; raw closedLots stays available in debug.
  const rawClosedLots: number = ls?.closedLots ?? 0
  const costBasisMissing = ls?.pnlUnavailableReason === 'missing_cost_basis'
  const closedLots: number = rawClosedLots
  const pricedSwapEvents: number = ls?.pricedSwapEvents ?? pricedEvents
  const openedLots: number = ls?.openedLots ?? 0
  // Open-position evidence also covers the estimatedPnl-derived fallback (unsold buy-side tokens),
  // so fifoPnL doesn't claim "no evidence" when a cost-basis-only open position was found.
  const _estPnlOpenCandidateCount = ((snap.estimatedPnl?.tokens ?? []) as Array<{ buysDetected: number; sellsDetected: number; estimatedCostBasisUsd: number | null }>)
    .filter(t => t.buysDetected > 0 && t.sellsDetected === 0 && (t.estimatedCostBasisUsd ?? 0) > 0).length
  const _hasOpenPositionEvidence = openedLots > 0 || _estPnlOpenCandidateCount > 0
  const fifoStatus = costBasisMissing ? 'open_check' : closedLots > 0 ? (ls?.status ?? 'ok') : pricedSwapEvents > 0 ? 'open_check' : 'open_check'
  const fifoReason = costBasisMissing ? 'sell_side_found_cost_basis_missing' : closedLots > 0 ? `${closedLots}_matched_lots_raw` : pricedSwapEvents > 0 ? 'priced_events_found_no_matched_lots' : _hasOpenPositionEvidence ? 'open_position_evidence_no_closed_trades' : 'no_priced_swap_events'

  // Trade stats — public count mirrors closedLotsForStats so synthetic lots don't read as real trades.
  const rawTradeClosedLots: number = ts?.closedLots ?? 0
  const tsCostBasisMissing = ts?.pnlUnavailableReason === 'missing_cost_basis' || ts?.publicPnlStatus === 'open_check'
  const tradeClosedLots: number = ts?.verifiedClosedLots ?? ts?.closedLotsForStats ?? (tsCostBasisMissing ? 0 : rawTradeClosedLots)
  const estimateOnlyClosedLots: number = ts?.estimateOnlyClosedLots ?? 0
  const syntheticClosedLotsExcluded: number = ts?.syntheticClosedLotsExcluded ?? ls?.syntheticLotsExcludedFromStats ?? 0
  const rawStatsClosedLots: number = ts?.rawClosedLots ?? rawTradeClosedLots
  const excludedLots: number = estimateOnlyClosedLots + syntheticClosedLotsExcluded
  const readyForWinRate = tradeClosedLots >= 10 && ts?.economicSignificance === 'meaningful'
  const tradeStatus = tsCostBasisMissing ? 'open_check' : readyForWinRate ? (ts?.status ?? 'ok') : tradeClosedLots > 0 ? 'partial' : openedLots > 0 ? 'partial' : 'open_check'
  const tradeReason = tradeClosedLots > 0
    ? `${tradeClosedLots}_verified_lots_ready_${excludedLots}_excluded`
    : excludedLots > 0
      ? `verified_stats_locked_${excludedLots}_excluded`
      : tsCostBasisMissing ? 'missing_cost_basis' : openedLots > 0 ? 'open_lots_tracked_no_verified_trades' : 'no_verified_closed_lots'

  // Open position summary — derived from FIFO debug sampleOpenLots (up to 5 lots).
  // Fallback: when FIFO produced zero opened lots but the average-cost estimate layer
  // (estimatedPnl.tokens) found buy-side evidence with no matching sells, surface that
  // as a cost-basis-only open-position read instead of showing "no evidence".
  type _OpenPosToken = {
    contract: string; symbol: string; chain: string; openLots: number
    totalAmount: number; avgEntryPriceUsd: number | null; totalCostBasisUsd: number
    firstOpenedAt: string | null; latestOpenedAt: string | null
  }
  const _sampleOpenLots = (snap._diagnostics?.walletLotEngineDebug?.sampleOpenLots ?? []) as Array<{ tokenAddress: string; symbol: string; chain: string; openedAt: string; amountRemaining: number; entryPriceUsd: number; confidence: string }>
  const _snapHoldings: Array<{ contract?: string; symbol?: string; chain?: string | null; price?: number | null; value?: number; balance?: number }> =
    snap.holdings ?? []
  let walletOpenPositionSummary: { status: 'partial'; openLots: number; uniqueTokens: number; totalOpenCostBasisUsd: number | null; tokens: _OpenPosToken[]; missing: string[]; reason: string } | null =
    openedLots > 0 ? (() => {
    const tokenMap = new Map<string, { contract: string; symbol: string; chain: string; openLots: number; totalAmount: number; totalCostBasis: number; firstOpenedAt: string; latestOpenedAt: string }>()
    for (const lot of _sampleOpenLots) {
      const key = lot.tokenAddress.toLowerCase()
      const existing = tokenMap.get(key)
      const costBasis = lot.amountRemaining * lot.entryPriceUsd
      if (existing) {
        existing.openLots++
        existing.totalAmount += lot.amountRemaining
        existing.totalCostBasis += costBasis
        if (lot.openedAt < existing.firstOpenedAt) existing.firstOpenedAt = lot.openedAt
        if (lot.openedAt > existing.latestOpenedAt) existing.latestOpenedAt = lot.openedAt
      } else {
        tokenMap.set(key, { contract: key, symbol: lot.symbol, chain: lot.chain, openLots: 1, totalAmount: lot.amountRemaining, totalCostBasis: costBasis, firstOpenedAt: lot.openedAt, latestOpenedAt: lot.openedAt })
      }
    }
    const tokens: _OpenPosToken[] = Array.from(tokenMap.values()).map(t => ({
      contract: t.contract, symbol: t.symbol, chain: t.chain, openLots: t.openLots,
      totalAmount: t.totalAmount,
      avgEntryPriceUsd: t.totalAmount > 0 ? t.totalCostBasis / t.totalAmount : null,
      totalCostBasisUsd: t.totalCostBasis,
      firstOpenedAt: t.firstOpenedAt, latestOpenedAt: t.latestOpenedAt,
    }))
    const totalOpenCostBasisUsd = tokens.reduce((s, t) => s + t.totalCostBasisUsd, 0)
    const uniqueTokens = tokenMap.size
    return {
      status: 'partial' as const,
      openLots: openedLots, uniqueTokens,
      totalOpenCostBasisUsd: totalOpenCostBasisUsd > 0 ? totalOpenCostBasisUsd : null,
      tokens, missing: [], reason: (snap?.rawClosedLots ?? ts?.rawClosedLots ?? 0) > 0 ? 'open_lots_tracked_public_pnl_partial' : 'open_lots_tracked_no_closed_trades',
    }
  })() : null

  // Fallback path — no FIFO open lots, but average-cost estimate layer found unsold buy-side evidence
  if (!walletOpenPositionSummary) {
    const _estTokens = (snap.estimatedPnl?.tokens ?? []) as Array<{ symbol: string; contract: string; estimatedCostBasisUsd: number | null; buysDetected: number; sellsDetected: number }>
    const _estCandidates = _estTokens.filter(t => t.buysDetected > 0 && t.sellsDetected === 0 && (t.estimatedCostBasisUsd ?? 0) > 0)
    if (_estCandidates.length > 0) {
      const tokens: _OpenPosToken[] = _estCandidates.map(t => {
        const holding = _snapHoldings.find(h => (h.contract ?? '').toLowerCase() === t.contract.toLowerCase())
        const totalAmount = holding?.balance ?? 0
        const costBasis = t.estimatedCostBasisUsd ?? 0
        return {
          contract: t.contract, symbol: t.symbol, chain: (holding?.chain ?? '').toLowerCase(),
          openLots: t.buysDetected, totalAmount,
          avgEntryPriceUsd: totalAmount > 0 ? costBasis / totalAmount : null,
          totalCostBasisUsd: costBasis,
          firstOpenedAt: null, latestOpenedAt: null,
        }
      })
      const totalOpenCostBasisUsd = tokens.reduce((s, t) => s + t.totalCostBasisUsd, 0)
      walletOpenPositionSummary = {
        status: 'partial',
        openLots: tokens.reduce((s, t) => s + t.openLots, 0),
        uniqueTokens: tokens.length,
        totalOpenCostBasisUsd: totalOpenCostBasisUsd > 0 ? totalOpenCostBasisUsd : null,
        tokens,
        missing: ['fifo_lot_confirmation'],
        reason: (snap?.rawClosedLots ?? ts?.rawClosedLots ?? 0) > 0 ? 'open_lots_tracked_public_pnl_partial' : 'open_lots_tracked_no_closed_trades',
      }
    }
  }

  // Open position performance — compute unrealized PnL only when open-lot contract + chain exactly match a priced current holding
  const openPositionPerformanceSummary = walletOpenPositionSummary ? (() => {
    type PerfToken = {
      contract: string; symbol: string; chain: string; openLots: number
      amountRemaining: number
      avgEntryPriceUsd: number | null
      currentPriceUsd: number | null
      currentValueUsd: number | null
      costBasisUsd: number
      unrealizedPnlUsd: number | null
      unrealizedPnlPercent: number | null
      // OPEN-POSITION-PNL-HONESTY: when current price just reuses the entry/provider estimate
      // (current ≈ entry), unrealized PnL is a flat estimate, not an independent public read.
      priceEstimateOnly: boolean
      rawUnrealizedPnlUsd: number | null
      rawUnrealizedPnlPercent: number | null
    }
    const perfTokens: PerfToken[] = walletOpenPositionSummary.tokens.map(t => {
      const tokenContract = t.contract.toLowerCase()
      const tokenChain = (t.chain ?? '').toLowerCase()
      const matchedHolding = _snapHoldings.find(h => {
        if (!h?.contract) return false
        const hChain = (h.chain ?? '').toLowerCase()
        return h.contract.toLowerCase() === tokenContract && hChain === tokenChain
      })
      const currentPriceUsd = matchedHolding?.price ?? null
      const currentValueUsd = currentPriceUsd !== null ? t.totalAmount * currentPriceUsd : null
      const costBasisUsd = t.totalCostBasisUsd
      const rawUnrealizedPnlUsd = currentValueUsd !== null ? currentValueUsd - costBasisUsd : null
      const rawUnrealizedPnlPercent = rawUnrealizedPnlUsd !== null && costBasisUsd > 0 ? (rawUnrealizedPnlUsd / costBasisUsd) * 100 : null
      // Flat-estimate detection: current price within epsilon of the avg entry price means the
      // "current value" is just the entry estimate echoed back — a fake 0% unrealized read.
      const priceEstimateOnly = currentPriceUsd !== null && t.avgEntryPriceUsd !== null && t.avgEntryPriceUsd !== 0
        && Math.abs(currentPriceUsd - t.avgEntryPriceUsd) <= Math.max(1, Math.abs(t.avgEntryPriceUsd)) * 1e-6
      // Public-facing unrealized PnL is null when it is not independent (flat estimate); the raw
      // value stays available for debug only.
      const unrealizedPnlUsd = priceEstimateOnly ? null : rawUnrealizedPnlUsd
      const unrealizedPnlPercent = priceEstimateOnly ? null : rawUnrealizedPnlPercent
      return {
        contract: t.contract, symbol: t.symbol, chain: t.chain, openLots: t.openLots,
        amountRemaining: t.totalAmount,
        avgEntryPriceUsd: t.avgEntryPriceUsd,
        currentPriceUsd, currentValueUsd, costBasisUsd,
        unrealizedPnlUsd, unrealizedPnlPercent,
        priceEstimateOnly, rawUnrealizedPnlUsd, rawUnrealizedPnlPercent,
      }
    })
    const totalCostBasis = perfTokens.reduce((s, t) => s + t.costBasisUsd, 0)
    const matchedTokens = perfTokens.filter(t => t.currentValueUsd !== null)
    const unmatchedTokens = perfTokens.filter(t => t.currentValueUsd === null)
    const matchedTokenCount = matchedTokens.length
    const unmatchedTokenCount = unmatchedTokens.length

    // Full-coverage totals — only set when every token is matched
    const totalCurrentValueUsd = matchedTokenCount === perfTokens.length
      ? matchedTokens.reduce((s, t) => s + (t.currentValueUsd ?? 0), 0)
      : null
    const totalUnrealizedPnlUsd = totalCurrentValueUsd !== null ? totalCurrentValueUsd - totalCostBasis : null
    const totalUnrealizedPnlPercent = totalUnrealizedPnlUsd !== null && totalCostBasis > 0
      ? (totalUnrealizedPnlUsd / totalCostBasis) * 100
      : null

    // Partial-coverage matched-only aggregates
    const matchedOpenCostBasisUsd = matchedTokens.reduce((s, t) => s + t.costBasisUsd, 0)
    const matchedCurrentOpenValueUsd = matchedTokenCount > 0
      ? matchedTokens.reduce((s, t) => s + (t.currentValueUsd ?? 0), 0)
      : null
    const matchedUnrealizedPnlUsd = matchedCurrentOpenValueUsd !== null
      ? matchedCurrentOpenValueUsd - matchedOpenCostBasisUsd
      : null
    const matchedUnrealizedPnlPercent = matchedUnrealizedPnlUsd !== null && matchedOpenCostBasisUsd > 0
      ? (matchedUnrealizedPnlUsd / matchedOpenCostBasisUsd) * 100
      : null

    const coverageLabel: 'full' | 'partial' | 'cost_basis_only' =
      matchedTokenCount === perfTokens.length && perfTokens.length > 0 ? 'full'
      : matchedTokenCount > 0 ? 'partial'
      : 'cost_basis_only'

    const unmatchedSymbols = unmatchedTokens.map(t => t.symbol)

    // OPEN-POSITION-PNL-HONESTY: if every matched token is priced from a flat/estimate-only source
    // (current ≈ entry), the unrealized PnL is not public-grade — do not present $0/0% as a real
    // break-even. Null the public unrealized aggregates and surface a clear estimate_only status,
    // keeping the raw aggregates for debug.
    const _matchedIndependentTokens = matchedTokens.filter(t => !t.priceEstimateOnly)
    const _allMatchedEstimateOnly = matchedTokenCount > 0 && _matchedIndependentTokens.length === 0
    const openPositionPnlStatus: 'priced' | 'estimate_only' | 'cost_basis_only' =
      matchedTokenCount === 0 ? 'cost_basis_only' : _allMatchedEstimateOnly ? 'estimate_only' : 'priced'
    const openPositionPnlReason = openPositionPnlStatus === 'estimate_only'
      ? 'Current value reuses estimate-only pricing; unrealized PnL is not public-grade.'
      : openPositionPnlStatus === 'cost_basis_only'
        ? 'No independent current price matched to open lots; only cost basis is known.'
        : null

    return {
      status: 'partial' as const,
      openLots: walletOpenPositionSummary.openLots,
      uniqueTokens: walletOpenPositionSummary.uniqueTokens,
      totalOpenCostBasisUsd: totalCostBasis > 0 ? totalCostBasis : null,
      totalCurrentValueUsd,
      totalUnrealizedPnlUsd: _allMatchedEstimateOnly ? null : totalUnrealizedPnlUsd,
      totalUnrealizedPnlPercent: _allMatchedEstimateOnly ? null : totalUnrealizedPnlPercent,
      allTokensMatched: matchedTokenCount === perfTokens.length,
      matchedTokenCount,
      unmatchedTokenCount,
      matchedOpenCostBasisUsd: matchedOpenCostBasisUsd > 0 ? matchedOpenCostBasisUsd : null,
      matchedCurrentOpenValueUsd,
      matchedUnrealizedPnlUsd: _allMatchedEstimateOnly ? null : matchedUnrealizedPnlUsd,
      matchedUnrealizedPnlPercent: _allMatchedEstimateOnly ? null : matchedUnrealizedPnlPercent,
      openPositionPnlStatus,
      openPositionPnlReason,
      rawTotalUnrealizedPnlUsd: totalUnrealizedPnlUsd,
      rawMatchedUnrealizedPnlUsd: matchedUnrealizedPnlUsd,
      coverageLabel,
      unmatchedSymbols,
      tokens: perfTokens,
    }
  })() : null

  // Behavior
  const txCount: number = bh?.txCount ?? 0
  const bhStatus = bh?.status === 'ok' && txCount > 0 ? 'ok' : bh?.status === 'ok' || bh?.status === 'partial' ? 'partial' : 'open_check'

  // Trade intelligence — separate from fifoPnL/tradeStats: behavior evidence (rotation, hold
  // time) can be useful even when too few lots pass the strict public-performance bar.
  const ti = snap.tradeIntelligence
  const tradeIntelLots: number = ti?.tradeIntelLots ?? 0
  const tradeIntelStatus: 'ready' | 'partial' | 'open_check' = ti?.status ?? 'open_check'
  const tradeIntelReason = ti
    ? tradeIntelStatus === 'ready' ? `${tradeIntelLots}_verified_behavior_lots_ready`
      : tradeIntelStatus === 'partial' ? `${tradeIntelLots}_verified_behavior_lots_profit_skill_locked`
      : 'insufficient_verified_lots_for_behavior_classification'
    : 'no_trade_intelligence_evidence'

  return {
    portfolio: { status: portStatus, evidence: holdingsCount > 0 ? ['holdings', ...(totalUsdAvailable ? ['total_value'] : [])] : [], reason: portStatus === 'ok' ? `${holdingsCount}_holdings_loaded` : portStatus === 'partial' ? 'holdings_loaded_value_incomplete' : 'no_holdings_found' },
    activity: { status: actStatus, evidence: totalEvents > 0 ? ['transfer_events', ...(hashCov >= 0.8 ? ['tx_hashes'] : []), ...(tsCov >= 0.8 ? ['timestamps'] : [])] : [], eventCount: totalEvents, reason: actReason },
    swapDetection: { status: swapStatus, evidence: swapCandidates > 0 ? ['same_tx_in_out', 'router_match', 'wallet_initiated_multi_token'] : [], candidateCount: swapCandidates, reason: swapReason },
    priceEvidence: { status: priceStatus, pricedEvents, reason: priceReason },
    fifoPnL: { status: fifoStatus, closedLots, reason: fifoReason },
    tradeStats: { status: tradeStatus, closedLots: tradeClosedLots, rawClosedLots: rawStatsClosedLots, excludedLots, estimateOnlyClosedLots, syntheticClosedLotsExcluded, openedLots, readyForWinRate, reason: tradeReason },
    tradeIntelligence: { status: tradeIntelStatus, tradeIntelLots, reason: tradeIntelReason },
    // BEHAVIOR-COVERAGE: trade intelligence is real behavior evidence — never report
    // no_activity_data when it exists. Fall back to the legacy activity-layer read otherwise.
    behavior: tradeIntelStatus === 'ready'
      ? { status: 'ready', reason: 'trade_intelligence_ready', evidence: ['trade_intelligence', 'swap_candidates', 'verified_behavior_lots'], tradeIntelLots, primaryStyle: ti?.primaryStyle ?? null }
      : tradeIntelStatus === 'partial'
        ? { status: 'partial', reason: 'trade_intelligence_available_profit_skill_limited', evidence: ['trade_intelligence', 'verified_behavior_lots'], tradeIntelLots, primaryStyle: ti?.primaryStyle ?? null }
        : { status: bhStatus, reason: bhStatus === 'ok' ? 'activity_detected' : bhStatus === 'partial' ? 'limited_activity_signal' : 'no_activity_data' },
    walletOpenPositionSummary,
    openPositionPerformanceSummary,
  }
}

async function walletPlan(req: Request): Promise<'free' | 'pro' | 'elite'> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return 'free'
  try {
    const result = await getCurrentUserPlanFromBearerToken(token)
    const { plan, userId, settingsRowFound } = result
    console.log("planCheck", { userId, plan })
    // Defensive fallback: authenticated user with no settings row yet → treat as elite for this request
    // This prevents false-negatives for newly-subscribed users whose row hasn't propagated yet.
    if (userId && !settingsRowFound) return 'elite'
    return plan
  } catch { return 'free' }
}
function walletIp(req: Request): string { return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown' }
async function walletAllowed(req: Request): Promise<boolean> { const plan=await walletPlan(req); const key=`${plan}:${walletIp(req)}`; const now=Date.now(); const cur=walletRate.get(key); const lim=WALLET_RATE_BY_PLAN[plan]; if(!cur||cur.resetAt<=now){walletRate.set(key,{count:1,resetAt:now+60000}); return true} if(cur.count>=lim)return false; cur.count+=1; return true }

export async function POST(req: Request) {
  const _origin = req.headers.get('origin')
  const json = (data: unknown, init?: { status?: number }): Response => {
    return new Response(JSON.stringify(data), {
      status: init?.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(_origin) },
    })
  }
  // Dev-only auth bypass: NODE_ENV check guarantees this NEVER activates in production.
  // In production NODE_ENV is always 'production' so _devBypass evaluates to false unconditionally.
  const _devBypass = process.env.NODE_ENV !== 'production' && req.headers.get('x-dev-test') === 'chainlens-local'
  const plan = _devBypass ? 'elite' : await walletPlan(req)
  if (plan === 'free') return json({ error: 'Included in Pro and Elite.' }, { status: 403 })
  if (!_devBypass && !(await walletAllowed(req))) return json({ error: "Rate limit reached. Try again shortly." }, { status: 429 })
  try {
    const startedAt = Date.now()
    const requestUrl = new URL(req.url)
    const debugRequested = requestUrl.searchParams.get('debug') === 'true'
    const debugAllowed = debugRequested && (plan === 'pro' || plan === 'elite')
    let debug = debugAllowed
    const body = await req.json()
    const address = body?.address
    // BUGFIX: refresh must accept query-string `?refresh=true` the same way debug/debugFresh do —
    // previously body-only, so refresh requests sent as query params silently fell through to
    // memory/persistent cache instead of bypassing it.
    const refresh = requestUrl.searchParams.get('refresh') === 'true' || body?.refresh === true || body?.refresh === 'true'
    const freshRequested = requestUrl.searchParams.get('debugFresh') === 'true' || requestUrl.searchParams.get('bypassCache') === 'true' || body?.debugFresh === true || body?.debugFresh === 'true' || body?.bypassCache === true || body?.bypassCache === 'true'
    const noCacheWriteRequested = requestUrl.searchParams.get('noCacheWrite') === 'true' || body?.noCacheWrite === true || body?.noCacheWrite === 'true'
    const chain = body?.chain === 'eth' ? 'eth' : 'base'
    const deepScan = body?.deepScan === true || body?.deepScan === 'true'
    const deepActivityFlag = body?.deepActivity === true || body?.deepActivity === 'true'
    const includeActivityFlag = body?.includeActivity === true || body?.includeActivity === 'true'
    const deepActivity = deepScan || deepActivityFlag || includeActivityFlag
    const cacheMode: 'activity' | 'holdings' = (deepScan || deepActivity) ? 'activity' : 'holdings'
    const chainMode = body?.chainMode === 'base' || body?.chainMode === 'eth' || body?.chainMode === 'base_eth' || body?.chainMode === 'all_supported' ? body.chainMode : 'auto'

    // Historical coverage: ONLY when explicitly requested — debug=true no longer auto-triggers it
    const explicitHistoricalCoverageRequested = (body?.historicalCoverage === true || body?.historicalCoverage === 'true' || body?.historicalScan === true || body?.historicalScan === 'true') && deepActivity
    let historicalCoverageRequested = explicitHistoricalCoverageRequested
    const adminOverrideRequested = WALLET_ADMIN_FORENSIC_SCAN && (body?.adminForensicScan === true || body?.adminForensicScan === 'true') && debugAllowed

    // Production page cap: max 2 in prod unless WALLET_DEEP_DEBUG_ENABLED=true, default 1
    const isProd = process.env.NODE_ENV === 'production'
    const hcPageLimit = adminOverrideRequested ? Math.max(5, WALLET_ADMIN_HISTORICAL_HARD_CAP) : (!isProd || WALLET_DEEP_DEBUG_ENABLED) ? 5 : 3
    const maxHistoricalPages = Math.max(1, Math.min(hcPageLimit, Number(body?.maxHistoricalPages ?? (historicalCoverageRequested ? 3 : 1)) || 1))
    const maxFallbackPages = debug ? Math.max(1, Math.min(3, Number(body?.maxFallbackPages ?? 2) || 2)) : 2

    const rawCacheBust = typeof body?.cacheBust === 'string' ? body.cacheBust : requestUrl.searchParams.get('cacheBust')
    const cacheBust = rawCacheBust && /^[a-zA-Z0-9_-]{1,80}$/.test(rawCacheBust) ? rawCacheBust : null
    const debugFreshAllowed = freshRequested && (debugAllowed || _devBypass || process.env.NODE_ENV !== 'production')
    if (debugFreshAllowed) debug = true
    const noCacheWrite = debugFreshAllowed && noCacheWriteRequested
    const cacheBypassReason: 'refresh' | 'debug_fresh_requested' | 'debug_fresh_no_cache_write' | null = debugFreshAllowed ? (noCacheWrite ? 'debug_fresh_no_cache_write' : 'debug_fresh_requested') : refresh ? 'refresh' : null
    const debugFreshBypassedPersistentCache = debugFreshAllowed
    const hcSuffix = historicalCoverageRequested ? `:hcv2p${maxHistoricalPages}:budget15` : ''
    const key = String(address ?? '').toLowerCase()
    if (!/^0x[a-fA-F0-9]{40}$/.test(key)) {
      return json({ error: 'Invalid wallet address' }, { status: 400 })
    }

    // ETH scan gating: only upgrade to 'base_eth' for debug or explicit ETH scans.
    // Do NOT auto-upgrade every deep scan — that fires GR ETH transactions for Base-only wallets,
    // burning 1 extra credit per scan. deepActivity alone does NOT trigger the upgrade.
    const resolvedChainMode: typeof chainMode =
      debug && (chainMode === 'auto' || chainMode === 'base')
        ? 'base_eth'
        : chainMode

    // Historical cooldown — 10 min per wallet after a live historical scan
    const hcCooldownKey = `${key}:historical:${plan}`
    let cooldownActive = !cacheBypassReason && historicalCoverageRequested && (walletHistoricalCooldown.get(hcCooldownKey) ?? 0) > Date.now()
    // prevents cold-start re-burn of historical scans — fall back to persistent cooldown if memory was reset
    if (!cacheBypassReason && historicalCoverageRequested && !cooldownActive && walletScanPersistentCacheAvailable()) {
      const persHcCooldown = await readPersistentCooldown(hcCooldownKey)
      if (persHcCooldown && persHcCooldown.expiresAt.getTime() > Date.now()) {
        walletHistoricalCooldown.set(hcCooldownKey, persHcCooldown.expiresAt.getTime())
        cooldownActive = true
      }
    }

    // Cost guard — skip live re-run if previous scan was very expensive
    const costHintKey = `${key}:${cacheMode}`  // cacheMode kept for costHints (separate map)
    const costHint = walletCostHints.get(costHintKey)
    const costGuardHit = !cacheBypassReason && historicalCoverageRequested && !cooldownActive
      && Boolean(costHint)
      && (costHint!.rawLogEvents > 100_000 || costHint!.requestDurationMs > 25_000)
      && (Date.now() - costHint!.cachedAt < WALLET_COST_HINT_TTL_MS)

    // Effective historical coverage: only run live when not blocked by cooldown/cost guard
    const effectiveHistoricalCoverage = historicalCoverageRequested && !cooldownActive && !costGuardHit

    // Deep scan cooldown — prevents rapid repeat deep scans from burning credits
    const deepCooldownKey = `${key}:deep:${plan}`
    const deepCooldownActive = !cacheBypassReason && deepActivity && !effectiveHistoricalCoverage && (walletDeepCooldown.get(deepCooldownKey) ?? 0) > Date.now()

    // Stable, deterministic cache key: address + logical scan mode + chain + schema version
    // Does NOT include volatile fields (debug, refresh, request id, body order)
    const scanModeKey = effectiveHistoricalCoverage ? 'historical' : deepActivity ? 'deep' : 'basic'
    const chainKey = resolvedChainMode !== 'auto' ? resolvedChainMode : chain
    const cacheKey = `${key}:${scanModeKey}:${chainKey}:${WALLET_SNAPSHOT_SCHEMA_VERSION}${hcSuffix}${debugFreshAllowed && cacheBust ? `:debug:${cacheBust}` : ''}`

    // Cache bypass: explicit refresh/debugFresh bypass both memory and persistent cache reads.
    const _cacheReadAttempted = !cacheBypassReason
    const _cacheReadStartedAt = Date.now()
    const cachedRaw = _cacheReadAttempted ? walletCache.get(cacheKey) : null
    let _cacheReadMs = Date.now() - _cacheReadStartedAt
    let _cacheWriteMs = 0
    // Simplified validation: cache key includes schema version (v7), so stale-schema entries
    // have different keys and need no aggressive field-based invalidation that could delete good entries
    const cached = cachedRaw ?? null

    // Determine cost mode
    type WalletScanCostMode = 'basic' | 'basic_cached' | 'deep_cached' | 'deep_live' | 'historical_cached' | 'historical_live' | 'blocked_by_cooldown' | 'blocked_by_cost_guard' | 'cached_preview_only'
    // FIFO-RECON-FIX-9: a recovered snapshot that made zero live historical provider calls
    // (e.g. it hit its own internal cache) must never be labeled historical_live/attempted —
    // that previously misled callers into thinking a live recovery pass actually ran.
    const _hadLiveHistoricalCalls = (recovered: any): boolean => {
      const audit = recovered?.apiAudit ?? {}
      const providerCalls = (audit.moralis?.calls ?? 0) + (audit.goldrush?.calls ?? 0) + (audit.alchemy?.calls ?? 0)
      const liveProviderCalls = recovered?.walletScanBudget?.creditsUsed ?? providerCalls
      const providerFetchNeeded = providerCalls > 0
      const pagesAttempted = recovered?.walletHistoricalCoverageSummary?.pagesAttempted ?? 0
      const historicalMs = recovered?._diagnostics?.walletPerformanceDebug?.historicalMs ?? recovered?._debug?.walletPerformanceDebug?.historicalMs ?? 0
      if (!providerFetchNeeded) return false
      if (providerCalls === 0) return false
      if (liveProviderCalls === 0) return false
      if (historicalMs === 0 && pagesAttempted === 0) return false
      return true
    }
    const _normalizeHistoricalRecoveryLabel = (payload: any) => {
      const pagesAttempted = Number(payload?.walletHistoricalCoverageSummary?.pagesAttempted ?? payload?._diagnostics?.walletHistoricalScanDebug?.pagesAttempted ?? 0)
      const requested = Boolean(payload?.walletHistoricalCoverageSummary?.requested ?? payload?._diagnostics?.walletHistoricalScanDebug?.requested)
      const cacheHit = Boolean(payload?.walletHistoricalCoverage?.cacheHit ?? payload?._diagnostics?.walletHistoricalScanDebug?.cacheHit ?? false)
      const targetedAttempted = Boolean(payload?._diagnostics?.syntheticLotRecoveryDebug?.syntheticTargetExtraRecoveryAttempted ?? payload?._debug?.syntheticLotRecoveryDebug?.syntheticTargetExtraRecoveryAttempted)
      if (!cacheHit && (pagesAttempted > 0 || targetedAttempted || requested)) {
        const historicalCapHit = Boolean(payload?._diagnostics?.walletScanBudgetDebug?.historicalBudgetCapHit)
        // HISTORICAL-REASON-CONSISTENCY: only claim "candidates priced, no new closed lots" when the
        // candidate/pricing summaries actually ran (normalized events were produced). A page-attempt
        // that returned a provider error / zero normalized events is a provider failure, not a priced
        // candidate run.
        const cov = payload?.walletHistoricalCoverageSummary
        const normalizedEvents = Number(cov?.normalizedEvents ?? 0)
        const pricingRan = cov?.pricedSwapCandidates != null && normalizedEvents > 0
        const providerFailed = (typeof cov?.reason === 'string' && /provider.*fail|attempted_provider_failed/i.test(cov.reason)) || (pagesAttempted > 0 && normalizedEvents === 0)
        payload.walletHistoricalRecoveryStatus = historicalCapHit ? 'attempted_capped' : 'attempted_light'
        payload.walletHistoricalRecoveryReason = targetedAttempted
          ? 'targeted_recovery_attempted_no_prior_buy_found'
          : historicalCapHit
            ? 'historical_phase_cap_reached_total_pages'
            : providerFailed
              ? 'historical_provider_failed_or_no_new_closed_lots'
              : pricingRan
                ? 'historical_candidates_priced_no_new_closed_lots'
                : 'historical_provider_failed_or_no_new_closed_lots'
      } else if (payload?.walletHistoricalRecoveryReason === 'no_live_provider_calls_cache_hit' && !cacheHit) {
        payload.walletHistoricalRecoveryReason = 'historical_not_requested'
      }
    }
    const getCostMode = (fromCache: boolean): WalletScanCostMode => {
      if (cooldownActive) return 'blocked_by_cooldown'
      if (costGuardHit) return 'blocked_by_cost_guard'
      if (effectiveHistoricalCoverage) return fromCache ? 'historical_cached' : 'historical_live'
      if (deepActivity) return fromCache ? 'deep_cached' : 'deep_live'
      return fromCache ? 'basic_cached' : 'basic'
    }
    const getCacheNote = (mode: WalletScanCostMode, cacheAgeSeconds?: number): string | undefined => {
      if (mode === 'basic') return 'Basic scan — no deep history used.'
      if (mode === 'basic_cached') return `Basic scan served from cache${cacheAgeSeconds != null ? ` (${cacheAgeSeconds}s ago)` : ''}.`
      if (mode === 'deep_cached') return `Deep result served from cache${cacheAgeSeconds != null ? ` (${cacheAgeSeconds}s ago)` : ''}.`
      if (mode === 'historical_cached') return `Historical scan served from cache to protect API usage${cacheAgeSeconds != null ? ` (${cacheAgeSeconds}s ago)` : ''}.`
      if (mode === 'blocked_by_cooldown') return 'Enhanced scan cooling down. Try again later.'
      if (mode === 'blocked_by_cost_guard') return 'Historical scan cached due to cost guard — wallet has heavy history.'
      return undefined
    }
    // CACHE-FAST-PATH-1: a true route-level cache hit must never re-run the full snapshot pipeline
    // (FIFO, swap detection, activity normalization, historical recovery) just to discover that it
    // would have made zero live provider calls — that CPU-bound recompute was the actual cost of a
    // "cached" response taking ~13s despite a ~600ms cache read. On a genuine cache hit we only do
    // cheap, in-memory decoration (quality/status annotation) and never attempt live recovery.
    let _lastCacheDecorationSkippedRecovery = false
    const recoverHistoricalFromCachedPayload = (cachedPayload: any, cacheAgeSeconds: number, _cacheBackend: 'memory' | 'persistent') => {
      const quality = getPnlCacheQuality(cachedPayload)
      annotatePnlCacheQuality(cachedPayload, quality)
      const signals = getWalletPnlRecoverySignals(cachedPayload)
      const wouldHaveTriedHistorical = deepActivity && quality !== 'complete' && !signals.historicalRequested && !cooldownActive && !costGuardHit
      _lastCacheDecorationSkippedRecovery = wouldHaveTriedHistorical
      cachedPayload.cacheAgeSeconds = cacheAgeSeconds
      return normalizePublicPnlStatus(cachedPayload)
    }

    if (cached && cached.exp > Date.now()) {
      const _postCacheDecorationStartedAt = Date.now()
      const cacheAgeSeconds = Math.floor((Date.now() - cached.cachedAt) / 1000)
      let cp: any = normalizeCachedFreshness(typeof cached.payload === 'object' && cached.payload ? { ...(cached.payload as any), dataFreshness: 'cached', cacheAgeSeconds } : cached.payload)
      if (cp && typeof cp === 'object') {
        const costMode = getCostMode(true)
        cp.walletScanCostMode = costMode
        if (cp.walletScanBudget) { const savedCredits = cp.walletScanBudget.creditsUsed ?? 0; cp.walletScanBudget = { ...cp.walletScanBudget, creditsUsed: 0, creditsRemaining: cp.walletScanBudget.totalCreditHardCap ?? 18, estimatedCreditsSavedByCache: savedCredits } }
        if (cp.walletHistoricalCoverage) cp.walletHistoricalCoverage = { ...cp.walletHistoricalCoverage, cacheHit: true }
        const note = getCacheNote(costMode, cacheAgeSeconds)
        if (note) cp.walletScanCacheNote = note
        cp = recoverHistoricalFromCachedPayload(cp, cacheAgeSeconds, 'memory')
      }
      const _postCacheDecorationMs = Date.now() - _postCacheDecorationStartedAt
      const _providerCallsSkippedBecauseCacheHit = _lastCacheDecorationSkippedRecovery ? 1 : 0
      const _deepCooldownExpiry = walletDeepCooldown.get(deepCooldownKey) ?? 0
      const _cooldownExpiresInSeconds = _deepCooldownExpiry > Date.now() ? Math.floor((_deepCooldownExpiry - Date.now()) / 1000) : null
      if (cp && typeof cp === 'object' && debug) cp._debug = {
        routeName: '/api/wallet', cacheHit: true, cacheMode,
        requestDurationMs: Date.now() - startedAt,
        cacheHitEarlyReturn: true,
        postCacheDecorationMs: _postCacheDecorationMs,
        providerCallsSkippedBecauseCacheHit: _providerCallsSkippedBecauseCacheHit,
        walletSnapshotCache: { memoryHit: !cacheBypassReason, memoryPresent: true, memoryBypassed: Boolean(cacheBypassReason), servedFromMemory: !cacheBypassReason, persistentHit: false, providerFetchNeeded: false, refreshBypassedCache: Boolean(cacheBypassReason), cacheAgeSeconds, cacheTtlSeconds: (effectiveHistoricalCoverage ? WALLET_HISTORICAL_CACHE_TTL_MS : deepActivity ? WALLET_DEEP_CACHE_TTL_MS : WALLET_BASIC_CACHE_TTL_MS) / 1000, cacheVersion: WALLET_SNAPSHOT_SCHEMA_VERSION, cacheBypassReason, debugFreshBypassedPersistentCache },
        providerFlow: null,
        walletScanBudgetDebug: cp?._cachedDiagnosticsSlim?.walletScanBudgetDebug ?? null,
        walletHistoricalScanDebug: cp?._cachedDiagnosticsSlim?.walletHistoricalScanDebug ?? null,
        syntheticLotRecoveryDebug: cp?._cachedDiagnosticsSlim?.syntheticLotRecoveryDebug ?? null,
        swapReconstructionV1Debug: cp?._cachedDiagnosticsSlim?.swapReconstructionV1Debug ?? SWAP_RECONSTRUCTION_V1_DEBUG_UNAVAILABLE_FROM_CACHE,
        walletCostGuardDebug: {
          requestedDeepActivity: deepActivity,
          requestedHistoricalCoverage: historicalCoverageRequested,
          requestedMaxHistoricalPages: body?.maxHistoricalPages ?? null,
          effectiveMaxHistoricalPages: maxHistoricalPages,
          cacheKey,
          cacheHit: true,
          cooldownHit: cooldownActive,
          costGuardHit,
          inFlightDeduped: false,
          reason: 'route_cache_hit',
        },
        walletActivityRequestDebug: {
          deepActivityRequested: deepScan || deepActivity,
          deepActivityFlagSent: deepActivityFlag,
          includeActivityFlagSent: includeActivityFlag,
          deepScanFlagSent: deepScan,
          cacheMode,
          cacheKey,
          cacheKeyIncludesDeepActivity: cacheMode === 'activity',
          cacheHit: true,
          cacheAgeSeconds,
          routeAllowed: true,
          plan,
          reason: 'cache_hit',
          evidenceStatus: (cp as any).walletEvidenceSummary?.status ?? 'unknown',
          primaryActivityAttempted: false,
          primaryActivityFailed: false,
          primaryActivityStatusCode: null,
          primaryActivityErrorKind: null,
          fallbackActivityAttempted: false,
          fallbackActivityUsed: false,
          fallbackActivityReason: 'cache_hit',
          finalEvidenceStatus: (cp as any).walletEvidenceSummary?.status ?? 'unknown',
        },
        walletScanCostDebug: {
          scanId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          address: key,
          requestedDeepActivity: deepActivity,
          requestedHistoricalCoverage: historicalCoverageRequested,
          requestedMaxHistoricalPages: body?.maxHistoricalPages ?? null,
          effectiveMaxHistoricalPages: maxHistoricalPages,
          scanMode: scanModeKey,
          dataFreshness: 'cached' as const,
          cacheKey,
          cacheReadAttempted: _cacheReadAttempted,
          cacheWriteAttempted: false,
          cacheWriteSucceeded: false,
          cooldownKey: deepCooldownKey,
          cooldownHit: deepCooldownActive,
          cooldownExpiresInSeconds: _cooldownExpiresInSeconds,
          cacheBackend: 'memory' as const,
          persistentCacheReadAttempted: false,
          persistentCacheHit: false,
          persistentCacheWriteAttempted: false,
          persistentCacheWriteSucceeded: false,
          persistentCooldownReadAttempted: false,
          persistentCooldownHit: false,
          cacheMissReason: null,
          cacheVersion: WALLET_SNAPSHOT_SCHEMA_VERSION,
          cacheBypassReason,
          debugFreshBypassedPersistentCache,
          providerFetchNeeded: false,
          servedFromCacheReason: 'route_cache_hit',
          blockedLiveFetchReason: 'cache_hit',
          cacheHit: true,
          inFlightDeduped: false,
          providerCalls: [],
          totals: {
            liveProviderCalls: 0,
            cachedProviderCalls: 1,
            pagesFetched: 0,
            rawItems: 0,
            rawLogEvents: 0,
            normalizedEvents: 0,
            estimatedCreditUnits: 0,
            durationMs: Date.now() - startedAt,
          },
          reason: 'route_cache_hit',
        },
      }
      attachWalletDeepScanTiming(cp, { ...zeroWalletDeepScanTiming(), totalMs: Date.now() - startedAt, cacheHit: true, cacheReadMs: _cacheReadMs }, debug)
      attachWalletDeepScanStaging(cp, { mode: deepActivity ? 'deep' : 'standard', cacheHit: true, debug })
      pruneWalletScannerDebug(cp, debug)
      return json(cp)
    }

    // Blocked by cooldown — try to serve stale cache or return a safe blocked response
    if (cooldownActive) {
      const stale = walletCache.get(cacheKey)
      if (stale) {
        const cacheAgeSeconds = Math.floor((Date.now() - stale.cachedAt) / 1000)
        const cp: any = normalizeCachedFreshness(typeof stale.payload === 'object' && stale.payload ? { ...(stale.payload as any), dataFreshness: 'cached', cacheAgeSeconds } : stale.payload)
        if (cp && typeof cp === 'object') {
          cp.walletScanCostMode = 'blocked_by_cooldown'
          cp.walletScanCacheNote = 'Enhanced scan cooling down. Try again later.'
        }
        pruneWalletScannerDebug(cp, debug)
        return json(cp)
      }
      return json({ error: 'Enhanced historical scan is cooling down. Try again in a few minutes.', walletScanCostMode: 'blocked_by_cooldown' }, { status: 429 })
    }

    // Blocked by cost guard — serve from cache if available
    if (costGuardHit) {
      const stale = walletCache.get(cacheKey)
      if (stale) {
        const cacheAgeSeconds = Math.floor((Date.now() - stale.cachedAt) / 1000)
        const cp: any = normalizeCachedFreshness(typeof stale.payload === 'object' && stale.payload ? { ...(stale.payload as any), dataFreshness: 'cached', cacheAgeSeconds } : stale.payload)
        if (cp && typeof cp === 'object') {
          cp.walletScanCostMode = 'blocked_by_cost_guard'
          cp.walletScanCacheNote = 'Historical scan served from cache — wallet has heavy history.'
        }
        pruneWalletScannerDebug(cp, debug)
        return json(cp)
      }
      // No cache available — fall through to live scan without historical
    }

    // Memory deep cooldown — serve stale memory cache if available, else fall through to persistent check
    if (deepCooldownActive) {
      const stale = walletCache.get(cacheKey)
      if (stale) {
        const cacheAgeSeconds = Math.floor((Date.now() - stale.cachedAt) / 1000)
        const cp: any = normalizeCachedFreshness(typeof stale.payload === 'object' && stale.payload ? { ...(stale.payload as any), dataFreshness: 'cached', cacheAgeSeconds } : stale.payload)
        if (cp && typeof cp === 'object') {
          cp.walletScanCostMode = 'deep_cached'
          cp.walletScanCacheNote = 'Deep scan cooling down — serving recent result to protect API budget.'
        }
        pruneWalletScannerDebug(cp, debug)
        return json(cp)
      }
      // No memory stale — fall through to persistent cooldown check below
    }

    // Persistent cache + cooldown checks (cross-instance, survives serverless cold-starts)
    // Tracks: did we read/write the persistent store, and what happened?
    let _persistentAvailable = false
    let _persistentCacheReadAttempted = false
    let _persistentCacheHit = false
    let _persistentCooldownReadAttempted = false
    let _persistentCooldownHit = false
    let _persistentCooldownExpiresInSeconds: number | null = null
    let _persistentCacheWriteAttempted = false
    let _persistentCacheWriteSucceeded = false
    let _cacheBackend: 'memory' | 'persistent' | 'none' = 'none'
    let _cacheMissReason: string | null = null

    if (deepActivity && !cooldownActive && !costGuardHit) {
      _persistentAvailable = walletScanPersistentCacheAvailable()

      // --- Persistent cache read (same bypass rules as memory cache: skip for refresh/debugFresh) ---
      if (_cacheReadAttempted) {
        _persistentCacheReadAttempted = _persistentAvailable
        const _persistentCacheReadStartedAt = Date.now()
        const persCache = _persistentAvailable ? await readPersistentWalletCache(cacheKey) : null
        _cacheReadMs += Date.now() - _persistentCacheReadStartedAt

        if (persCache) {
          _persistentCacheHit = true
          _cacheBackend = 'persistent'
          // Repopulate in-memory cache + cooldown so same instance reuses them without another DB hit
          walletCache.set(cacheKey, { exp: persCache.expiresAt.getTime(), payload: persCache.payload, cachedAt: persCache.createdAt.getTime() })
          if (!deepCooldownActive) walletDeepCooldown.set(deepCooldownKey, persCache.createdAt.getTime() + WALLET_DEEP_COOLDOWN_MS)

          const _postCacheDecorationStartedAt = Date.now()
          const cacheAgeSeconds = Math.floor((Date.now() - persCache.createdAt.getTime()) / 1000)
          let cp: any = normalizeCachedFreshness(typeof persCache.payload === 'object' && persCache.payload
            ? { ...(persCache.payload as any), dataFreshness: 'cached', cacheAgeSeconds }
            : persCache.payload)
          if (cp && typeof cp === 'object') {
            const costMode = getCostMode(true)
            cp.walletScanCostMode = costMode
            const note = getCacheNote(costMode, cacheAgeSeconds)
            if (note) cp.walletScanCacheNote = note
            cp = recoverHistoricalFromCachedPayload(cp, cacheAgeSeconds, 'persistent')
          }
          const _postCacheDecorationMs = Date.now() - _postCacheDecorationStartedAt
          const _providerCallsSkippedBecauseCacheHit = _lastCacheDecorationSkippedRecovery ? 1 : 0
          const _dce = walletDeepCooldown.get(deepCooldownKey) ?? 0
          const _dces = _dce > Date.now() ? Math.floor((_dce - Date.now()) / 1000) : null
          if (cp && typeof cp === 'object' && debug) {
            const _slim: any = cp._cachedDiagnosticsSlim ?? {}
            cp._debug = {
              routeName: '/api/wallet', cacheHit: true, cacheMode,
              requestDurationMs: Date.now() - startedAt,
              cacheHitEarlyReturn: true,
              postCacheDecorationMs: _postCacheDecorationMs,
              providerCallsSkippedBecauseCacheHit: _providerCallsSkippedBecauseCacheHit,
              walletSnapshotCache: { memoryHit: false, persistentHit: true, providerFetchNeeded: false, refreshBypassedCache: Boolean(cacheBypassReason), cacheAgeSeconds, cacheTtlSeconds: WALLET_DEEP_CACHE_TTL_MS / 1000, cacheVersion: WALLET_SNAPSHOT_SCHEMA_VERSION, cacheBypassReason, debugFreshBypassedPersistentCache },
              providerFlow: null,
              walletScanCostDebug: {
                scanId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                address: key, scanMode: scanModeKey, dataFreshness: 'cached' as const,
                cacheKey, cacheVersion: WALLET_SNAPSHOT_SCHEMA_VERSION, cacheBypassReason, debugFreshBypassedPersistentCache, cacheReadAttempted: _cacheReadAttempted,
                cacheWriteAttempted: false, cacheWriteSucceeded: false,
                cooldownKey: deepCooldownKey, cooldownHit: deepCooldownActive,
                cooldownExpiresInSeconds: _dces,
                cacheBackend: 'persistent' as const,
                persistentCacheReadAttempted: true, persistentCacheHit: true,
                persistentCacheWriteAttempted: false, persistentCacheWriteSucceeded: false,
                persistentCooldownReadAttempted: false, persistentCooldownHit: false,
                cacheMissReason: null,
                providerFetchNeeded: false,
                servedFromCacheReason: 'persistent_cache_hit', blockedLiveFetchReason: 'persistent_cache_hit',
                cacheHit: true, inFlightDeduped: false, providerCalls: [],
                totals: { liveProviderCalls: 0, cachedProviderCalls: 1, pagesFetched: 0, rawItems: 0, rawLogEvents: 0, normalizedEvents: 0, estimatedCreditUnits: 0, durationMs: Date.now() - startedAt },
                reason: 'persistent_cache_hit',
              },
              walletPriceAtTimeDebug: _slim.walletPriceAtTimeDebug ?? null,
              unmatchedSellBackfillDebug: _slim.unmatchedSellBackfillDebug ?? null,
              ethSwapReconstructionDebug: _slim.ethSwapReconstructionDebug ?? null,
              basePnlReconstructionDebug: _slim.basePnlReconstructionDebug ?? null,
              baseFifoCoverageDebug: _slim.baseFifoCoverageDebug ?? null,
              walletActivityRoutingDebug: _slim.walletActivityRoutingDebug ?? null,
              walletChainActivityMergeDebug: _slim.walletChainActivityMergeDebug ?? null,
              walletEthNormalizationDebug: _slim.walletEthNormalizationDebug ?? null,
              syntheticLotRecoveryDebug: _slim.syntheticLotRecoveryDebug ?? null,
              swapReconstructionV1Debug: _slim.swapReconstructionV1Debug ?? SWAP_RECONSTRUCTION_V1_DEBUG_UNAVAILABLE_FROM_CACHE,
              baseFifoMatchDebug: _slim.baseFifoMatchDebug ?? null,
              walletCacheQualityDebug: _slim.walletCacheQualityDebug ?? null,
            }
          }
          attachWalletDeepScanTiming(cp, { ...zeroWalletDeepScanTiming(), totalMs: Date.now() - startedAt, cacheHit: true, cacheReadMs: _cacheReadMs }, debug)
          attachWalletDeepScanStaging(cp, { mode: deepActivity ? 'deep' : 'standard', cacheHit: true, debug })
          pruneWalletScannerDebug(cp, debug)
          return json(cp)
        }
      }

      // --- Persistent cooldown check (bypassed by refresh/debugFresh so explicit fresh scans can run) ---
      _persistentCooldownReadAttempted = !cacheBypassReason && _persistentAvailable
      const persCooldown = _persistentCooldownReadAttempted ? await readPersistentCooldown(deepCooldownKey) : null
      if (persCooldown) {
        _persistentCooldownHit = true
        _persistentCooldownExpiresInSeconds = Math.floor((persCooldown.expiresAt.getTime() - Date.now()) / 1000)
        // Repopulate in-memory cooldown
        walletDeepCooldown.set(deepCooldownKey, persCooldown.expiresAt.getTime())
        // Try stale persistent cache for graceful response
        const stale = await readStalePersistentWalletCache(cacheKey)
        if (stale) {
          const cacheAgeSeconds = Math.floor((Date.now() - stale.createdAt.getTime()) / 1000)
          const cp: any = normalizeCachedFreshness(typeof stale.payload === 'object' && stale.payload
            ? { ...(stale.payload as any), dataFreshness: 'cached', cacheAgeSeconds }
            : stale.payload)
          if (cp && typeof cp === 'object') {
            cp.walletScanCostMode = 'deep_cached'
            cp.walletScanCacheNote = 'Deep scan cooling down — serving recent result to protect API budget.'
          }
          attachWalletDeepScanTiming(cp, { ...zeroWalletDeepScanTiming(), totalMs: Date.now() - startedAt, cacheHit: true, cacheReadMs: _cacheReadMs }, debug)
          attachWalletDeepScanStaging(cp, { mode: deepActivity ? 'deep' : 'standard', cacheHit: true, debug })
          pruneWalletScannerDebug(cp, debug)
          return json(cp)
        }
        return json({ error: 'Deep scan is cooling down. Try again in a few minutes.', walletScanCostMode: 'deep_cached' }, { status: 429 })
      }

      _cacheMissReason = _persistentAvailable ? 'persistent_cache_miss' : 'persistent_cache_unavailable'

      // Hard block for cache-only test mode
      if (WALLET_TEST_CACHE_ONLY) {
        return json({ error: 'No cached result available (CHAINLENS_WALLET_TEST_CACHE_ONLY=true — live GoldRush calls blocked)', walletScanCostMode: 'deep_cached' }, { status: 503 })
      }
    } else if (deepCooldownActive) {
      // Fell through memory cooldown with no memory stale — final 429 guard
      return json({ error: 'Deep scan is cooling down. Try again in a few minutes.', walletScanCostMode: 'deep_cached' }, { status: 429 })
    }

    // In-flight dedup for deep/historical scans
    let inFlightDeduped = false
    const inFlightKey = deepActivity ? `${key}:${scanModeKey}:${chainKey}${effectiveHistoricalCoverage ? `:hc${maxHistoricalPages}` : ''}` : ''
    let rawSnapshot: any

    const existingInFlight = inFlightKey && !debugFreshAllowed ? walletDeepInFlight.get(inFlightKey) : undefined
    if (existingInFlight) {
      inFlightDeduped = true
      rawSnapshot = { ...(await existingInFlight as any) }
    } else {
      const scanPromise: Promise<unknown> = fetchWalletSnapshot(address ?? '', {
        refresh,
        chain,
        deepScan,
        deepActivity,
        chainMode: resolvedChainMode,
        historicalCoverage: effectiveHistoricalCoverage,
        maxHistoricalPages,
        maxFallbackPages,
        walletScanBudget: buildPublicWalletScanBudget(scanModeKey, historicalCoverageRequested, 'standard', adminOverrideRequested),
      } satisfies WalletSnapshotOptions)
      if (inFlightKey && !debugFreshAllowed) walletDeepInFlight.set(inFlightKey, scanPromise)
      try {
        rawSnapshot = { ...(await scanPromise as any) }
      } finally {
        if (inFlightKey && !debugFreshAllowed) walletDeepInFlight.delete(inFlightKey)
      }
    }

    let snapshot: any = rawSnapshot
    // PNL-RECOVERY-FIX-7: fetchWalletSnapshot's own internal memory cache (a provider-level
    // optimization, separate from this route's persistent wallet cache) can mark a freshly-served
    // snapshot dataFreshness:'cached' even though THIS request never hit the persistent cache
    // (cacheHit=false at the route level). The top-level dataFreshness must reflect the route's
    // own cache outcome, not an internal provider cache detail.
    snapshot.dataFreshness = 'live'
    const _initialRecoverySignals = getWalletPnlRecoverySignals(snapshot)
    const _shouldAutoRequestHistoricalRecovery =
      deepActivity &&
      !effectiveHistoricalCoverage &&
      !explicitHistoricalCoverageRequested &&
      !cooldownActive &&
      !costGuardHit &&
      _initialRecoverySignals.needsHistorical
    if (_shouldAutoRequestHistoricalRecovery) {
      historicalCoverageRequested = true
      const _autoBudget = buildPublicWalletScanBudget('historical', true, _initialRecoverySignals.walletValueTier, adminOverrideRequested)
      if (_autoBudget.totalCreditHardCap > 0) {
        const _historicalSnapshot: any = await fetchWalletSnapshot(address ?? '', {
          refresh,
          chain,
          deepScan: true,
          deepActivity: true,
          chainMode: resolvedChainMode,
          historicalCoverage: true,
          maxHistoricalPages,
          maxFallbackPages,
          walletScanBudget: _autoBudget,
        } satisfies WalletSnapshotOptions)
        snapshot = { ..._historicalSnapshot }
        _normalizeHistoricalRecoveryLabel(snapshot)
      } else {
        snapshot.walletHistoricalRecoveryStatus = 'blocked'
        snapshot.walletHistoricalRecoveryReason = 'budget_hard_cap_blocks_recovery'
      }
    } else if (_initialRecoverySignals.recoveryAlreadyFound) {
      // COST-GUARD-FIX: real-backed closed lots were already found on the default scan — do not
      // run (or claim to have run) broad historical recovery just because historicalStatus
      // happened to be 'not_requested'.
      // HISTORICAL-LABEL-FIX: but if this same scan call DID actually request/attempt historical
      // pages (e.g. historicalCoverage was explicitly requested on the first call), "not_attempted"
      // would directly contradict walletHistoricalCoverageSummary.requested/pagesAttempted — label
      // it by the real page result instead.
      const _pagesAttemptedThisScan = Number(snapshot.walletHistoricalCoverageSummary?.pagesAttempted ?? 0)
      const _historicalRequestedThisScan = Boolean(snapshot.walletHistoricalCoverageSummary?.requested) || effectiveHistoricalCoverage
      if (_historicalRequestedThisScan || _pagesAttemptedThisScan > 0) {
        const _hadLive = _hadLiveHistoricalCalls(snapshot)
        snapshot.walletHistoricalRecoveryStatus = _hadLive ? 'attempted_recovered' : 'attempted_no_recovery'
        snapshot.walletHistoricalRecoveryReason = _hadLive ? 'closed_lots_already_found_with_historical_pages' : 'historical_provider_failed_or_no_new_closed_lots'
      } else {
        snapshot.walletHistoricalRecoveryStatus = 'not_attempted'
        snapshot.walletHistoricalRecoveryReason = 'closed_lots_already_found'
      }
    }
    _normalizeHistoricalRecoveryLabel(snapshot)
    snapshot.pnlCacheQuality = getPnlCacheQuality(snapshot)
    normalizePublicPnlStatus(snapshot)
    const providers: any = snapshot._diagnostics?.providers ?? {}
    const snapshotCacheDebug = {
      ...(snapshot._diagnostics?.snapshotCache ?? {}),
      cacheVersion: WALLET_SNAPSHOT_SCHEMA_VERSION,
      cacheBypassReason,
      debugFreshBypassedPersistentCache,
      persistentHit: _persistentCacheHit,
      providerFetchNeeded: true,
      refreshBypassedCache: Boolean(cacheBypassReason),
    }

    // Daily credit soft cap tracking (in-memory, resets at midnight UTC)
    if (GOLDRUSH_DAILY_SOFT_CAP > 0 && !inFlightDeduped) {
      const nowUtcDay = Math.floor(Date.now() / 86_400_000)
      if (_goldrushDailyCreditsResetAt !== nowUtcDay) {
        _goldrushDailyCreditsUsed = 0
        _goldrushDailyCreditsResetAt = nowUtcDay
      }
      // Each deep scan costs ~2-6 GR credits (1 balances + 1 tx + up to 6 price calls)
      _goldrushDailyCreditsUsed += deepActivity ? 3 : 1
      if (_goldrushDailyCreditsUsed > GOLDRUSH_DAILY_SOFT_CAP) {
        console.warn(`[wallet-route] GOLDRUSH DAILY SOFT CAP EXCEEDED: ${_goldrushDailyCreditsUsed}/${GOLDRUSH_DAILY_SOFT_CAP} credits used today`)
      }
    }

    // Capture cost hints from diagnostics before they're deleted
    const diagRawLogEvents: number = snapshot._diagnostics?.walletHistoricalCoverageDebug?.rawLogEvents
      ?? snapshot._diagnostics?.providers?.goldrush?.rawItemCount
      ?? 0
    const diagRequestDurationMs: number = Date.now() - startedAt
    if (deepActivity && diagRawLogEvents >= 0) {
      walletCostHints.set(costHintKey, { rawLogEvents: diagRawLogEvents, requestDurationMs: diagRequestDurationMs, cachedAt: Date.now() })
    }

    // Set cooldown after a live historical scan
    if (effectiveHistoricalCoverage && !noCacheWrite) {
      walletHistoricalCooldown.set(hcCooldownKey, Date.now() + WALLET_HC_COOLDOWN_MS)
      // prevents cold-start re-burn of historical scans — persist so cooldown survives Vercel cold starts
      if (_persistentAvailable) {
        void writePersistentCooldown(hcCooldownKey, key, chainKey, WALLET_HC_COOLDOWN_MS)
      }
    }
    // Set deep scan cooldown after a live deep scan
    if (deepActivity && !effectiveHistoricalCoverage && !inFlightDeduped && !noCacheWrite) {
      walletDeepCooldown.set(deepCooldownKey, Date.now() + WALLET_DEEP_COOLDOWN_MS)
    }

    const costMode = getCostMode(false)
    const cacheNote = getCacheNote(costMode)
    snapshot.walletScanCostMode = costMode
    if (cacheNote) snapshot.walletScanCacheNote = cacheNote

    // Pre-compute cache write decision for debug observability (Map.set is synchronous, always succeeds)
    const _cacheTtlMs = effectiveHistoricalCoverage ? WALLET_HISTORICAL_CACHE_TTL_MS : deepActivity ? WALLET_DEEP_CACHE_TTL_MS : WALLET_BASIC_CACHE_TTL_MS
    const _cacheWriteAttempted = !noCacheWrite  // write after every live scan unless debug no-cache-write is requested
    const _deepCooldownExpiry = walletDeepCooldown.get(deepCooldownKey) ?? 0
    const _cooldownExpiresInSeconds = _deepCooldownExpiry > Date.now() ? Math.floor((_deepCooldownExpiry - Date.now()) / 1000) : null

    // Build module coverage from public snapshot fields (always, not just debug)
    const walletModuleCoverage = buildWalletModuleCoverage(snapshot)
    snapshot.walletModuleCoverage = walletModuleCoverage
    if (walletModuleCoverage.walletOpenPositionSummary) {
      snapshot.walletOpenPositionSummary = walletModuleCoverage.walletOpenPositionSummary
    }
    if (walletModuleCoverage.openPositionPerformanceSummary) {
      snapshot.openPositionPerformanceSummary = walletModuleCoverage.openPositionPerformanceSummary
    }

    // Wallet personality classification, time-windowed PnL, and bot detection — derived purely
    // from existing FIFO closed-lot data and behavior summaries (additive, no scoring changes).
    const _closedLotsForIntelligence = (snapshot as any).walletClosedLotsAll ?? []
    const _realBackedLotsForIntelligence = _closedLotsForIntelligence.filter((l: any) =>
      l?.evidence?.entrySource !== 'synthetic' &&
      !(l?.missingReasons ?? []).includes('fifo_backfilled_buy') &&
      !(l?.missingReasons ?? []).includes('price_synthetic_fifo') &&
      l?.coveragePercent !== 0
    )
    const _performanceLotsForIntelligence = _closedLotsForIntelligence.filter((l: any) =>
      l?.pnlDisplayStatus === 'verified_pnl' &&
      l?.pnlDecisive === true &&
      l?.costBasisUsd >= Math.max(5, Math.min(25, Number(snapshot.totalValue ?? 0) * 0.00002)) &&
      Math.abs(Number(l?.realizedPnlUsd ?? 0)) >= Math.max(0.05, Number(l?.costBasisUsd ?? 0) * 0.0005) &&
      !(l?.evidence?.entrySource === 'synthetic') &&
      !(l?.missingReasons ?? []).includes('fifo_backfilled_buy') &&
      !(l?.missingReasons ?? []).includes('price_synthetic_fifo') &&
      l?.coveragePercent !== 0
    )
    const _missingCostBasisForIntelligence = snapshot.walletTradeStatsSummary?.pnlUnavailableReason === 'missing_cost_basis' || snapshot.walletLotSummary?.pnlUnavailableReason === 'missing_cost_basis'
    // BEHAVIOR-ONLY-PERSONALITY: computeBotScore runs first so its classification can feed the
    // wallet personality's bot-like-rotator label below — both reads must agree on automation.
    snapshot.walletBotScore = computeBotScore(
      _performanceLotsForIntelligence,
      (snapshot as any).walletBehavior ?? null,
      { ...((snapshot as any).walletTradeStatsSummary ?? {}), pnlIntegrityStatus: snapshot.pnlIntegrityCheck?.status } as any,
      {
        walletSideTransactions: snapshot.walletActivitySummary?.walletSideTransactions ?? snapshot.walletTradeReconstructionFunnel?.walletSideTransactions ?? 0,
        swapLikeWalletTransactions: snapshot.walletActivitySummary?.swapLikeWalletTransactions ?? 0,
        tradeIntelLots: snapshot.tradeIntelligence?.tradeIntelLots ?? 0,
        uniqueTokensTraded: snapshot.tradeIntelligence?.signals?.uniqueTokensTraded ?? snapshot.walletTradeStatsSummary?.uniqueTokensTraded ?? null,
        avgHoldingTimeSeconds: snapshot.tradeIntelligence?.signals?.avgHoldingTimeSeconds ?? snapshot.walletTradeStatsSummary?.avgHoldingTimeSeconds ?? null,
        repeatedTokenPatterns: snapshot.tradeIntelligence?.repeatedTokenPatterns ?? [],
        sameTxInboundOutboundCandidates: snapshot.walletSwapSummary?.sameTxInboundOutboundCandidates ?? 0,
        topCounterparties: snapshot.walletFacts?.flowRead?.topCounterparties ?? [],
        activityWindowDays: snapshot.walletActivitySummary?.trueActivityWindowDays ?? null,
      }
    )
    snapshot.walletPersonality = computeWalletPersonality(
      _missingCostBasisForIntelligence || snapshot.publicPnlStatus === 'near_flat_verified_sample' || (snapshot.performanceClosedLots ?? 0) < 5 ? [] : _performanceLotsForIntelligence,
      (snapshot as any).walletBehavior ?? null,
      { ...((snapshot as any).walletTradeStatsSummary ?? {}), pnlIntegrityStatus: snapshot.pnlIntegrityCheck?.status } as any,
      {
        tradeIntelStatus: snapshot.tradeIntelligence?.status ?? null,
        tradeIntelLots: snapshot.tradeIntelligence?.tradeIntelLots ?? 0,
        walletSideTransactions: snapshot.walletActivitySummary?.walletSideTransactions ?? snapshot.walletTradeReconstructionFunnel?.walletSideTransactions ?? 0,
        swapLikeWalletTransactions: snapshot.walletActivitySummary?.swapLikeWalletTransactions ?? 0,
        uniqueTokensTraded: snapshot.tradeIntelligence?.signals?.uniqueTokensTraded ?? snapshot.walletTradeStatsSummary?.uniqueTokensTraded ?? null,
        repeatedTokenPatterns: snapshot.tradeIntelligence?.repeatedTokenPatterns ?? [],
        primaryStyle: snapshot.tradeIntelligence?.primaryStyle ?? null,
        botClassification: snapshot.walletBotScore?.classification ?? null,
      }
    )
    if ((snapshot as any).walletNoPnlReason === 'non_trader_address_type' && snapshot.walletPersonality) {
      snapshot.walletPersonality.profitSkillStatus = 'not_applicable'
      snapshot.walletPersonality.summary = 'Trader PnL not applicable — this wallet looks like a holder/distributor/treasury address, not an active trading wallet.'
      snapshot.walletPersonality.limitations = ['Trader PnL not applicable for this address type.']
    }
    // Windowed PnL is public-facing, so it must exclude synthetic/cost-basis-missing lots —
    // a synthetic break-even lot showing $0 PnL would otherwise look like a verified real result.
    const _realBackedLotsForWindows = _performanceLotsForIntelligence
    snapshot.walletPnlWindows = computeWindowedPnl(_realBackedLotsForWindows, new Date(), {
      scoreUnlocked: snapshot.walletTradeStatsSummary?.scoreUnlocked === true,
      publicPnlStatus: snapshot.publicPnlStatus,
      rawMatchedClosedLots: snapshot.rawMatchedClosedLots ?? snapshot.rawClosedLots ?? 0,
      integrityInvalid: snapshot.publicPnlStatus === 'open_check_integrity_invalid' || snapshot.pnlIntegrityCheck?.status === 'invalid',
    })
    if (snapshot.walletTradeStatsSummary?.pnlUnavailableReason === 'missing_cost_basis' || snapshot.walletLotSummary?.pnlUnavailableReason === 'missing_cost_basis') {
      for (const key of ['3d', '7d', '30d'] as const) {
        const w = snapshot.walletPnlWindows[key]
        if (w && w.closedLots === 0 && 'fallback' in w) {
          (w as any).fallback = 'PnL open check — cost basis missing for closed sells.'
          ;(w as any).reason = 'missing_cost_basis'
        }
      }
    }
    const _scanBudgetDebug = snapshot._diagnostics?.walletScanBudgetDebug ?? null
    const _walletValueTier = getWalletValueTier(Number(snapshot.totalValue ?? 0))
    const _publicBudget: any = buildPublicWalletScanBudget(scanModeKey, historicalCoverageRequested, _scanBudgetDebug?.walletValueTier ?? _walletValueTier, adminOverrideRequested)
    // BUDGET-HONESTY-FIX: the budget-debug counter only tallies credits at specific check sites
    // and can under-count relative to the real per-call audit log (apiAudit.totalCredits). Expose
    // both numbers instead of silently reporting the lower, estimated one as "creditsUsed".
    const _estimatedCreditsUsed = Number(_scanBudgetDebug?.creditsUsed ?? 0)
    const _actualCreditsUsed = Number(snapshot._diagnostics?.apiAudit?.totalCredits ?? _estimatedCreditsUsed)
    _publicBudget.estimatedCreditsUsed = _estimatedCreditsUsed
    _publicBudget.actualCreditsUsed = _actualCreditsUsed
    _publicBudget.creditsUsed = _actualCreditsUsed
    // BUDGET-NAMING-FIX: the legacy creditsUsed/estimatedCreditsUsed names were ambiguous (planning
    // estimate vs. real billed credits vs. alchemy load vs. historical page units). Expose
    // unmistakable, source-of-truth names so no two numbers labelled "creditsUsed" mean different
    // things. The public card reads actualProviderCreditsUsed (= apiAudit.totalCredits) only.
    const _apiAuditForBudget: any = snapshot._diagnostics?.apiAudit ?? null
    _publicBudget.actualProviderCreditsUsed = _actualCreditsUsed
    _publicBudget.estimatedPlanningCreditsUsed = _estimatedCreditsUsed
    _publicBudget.historicalPageUnitsUsed = Number(_apiAuditForBudget?.costByPurpose?.historical_recovery ?? 0)
    _publicBudget.alchemyLoadUnitsUsed = Number(_apiAuditForBudget?.alchemy?.loadUnits ?? _apiAuditForBudget?.alchemy?.calls ?? 0)
    _publicBudget.creditsRemaining = Math.max(0, _publicBudget.totalCreditHardCap - _actualCreditsUsed)
    _publicBudget.targetExceeded = _actualCreditsUsed > _publicBudget.totalCreditTarget
    _publicBudget.hardCapHit = _actualCreditsUsed > _publicBudget.totalCreditHardCap
    _publicBudget.totalBudgetCapHit = _publicBudget.hardCapHit
    _publicBudget.historicalPhaseCapHit = Boolean(_scanBudgetDebug?.historicalBudgetCapHit)
    _publicBudget.budgetCapHit = _publicBudget.totalBudgetCapHit
    _publicBudget.budgetCapReason = _publicBudget.hardCapHit ? 'total_hard_cap_reached' : null
    _publicBudget.historicalBudgetCapReason = _scanBudgetDebug?.historicalBudgetCapReason ?? null
    _publicBudget.skippedAfterBudgetCap = Number(_scanBudgetDebug?.callsSkippedAfterBudgetCap ?? 0)
    snapshot.walletScanBudget = _publicBudget
    if (snapshot.walletHistoricalCoverageSummary) {
      snapshot.walletHistoricalCoverage = {
        checked: Boolean(snapshot.walletHistoricalCoverageSummary.requested),
        olderEntriesRecovered: Number(snapshot.walletHistoricalCoverageSummary.normalizedEvents ?? 0),
        cappedForCostSafety: _publicBudget.historicalPhaseCapHit || historicalCoverageRequested,
        highValueWalletPrioritised: (_scanBudgetDebug?.walletValueTier ?? _walletValueTier) === 'whale',
        coverageLevel: snapshot.walletHistoricalCoverageSummary.coverageLevel ?? 'none',
        reason: snapshot.walletHistoricalRecoveryReason === 'closed_lots_already_found'
          ? 'closed_lots_already_found'
          : snapshot.walletHistoricalRecoveryReason === 'historical_provider_failed_or_no_new_closed_lots'
            ? 'provider page failed'
            : snapshot.walletHistoricalCoverageSummary.reason ?? null,
      }
    }

    // Cache quality gate — block writes when portfolio clearly failed while activity succeeded
    const _snapHoldingsCount = (snapshot as any).holdings?.length ?? (snapshot as any).holdingsCount ?? 0
    const _snapTotalValue = (snapshot as any).totalValue ?? 0
    const _snapActivityEvents = (snapshot as any).walletEvidenceSummary?.totalEvents ?? 0
    const _snapProviderStatus = (snapshot as any).providerStatus ?? null
    let _cacheQuality: 'good' | 'portfolio_failed' | 'activity_only' = 'good'
    let _cacheWriteBlocked = false
    let _blockedWriteReason: string | null = null
    if (_snapHoldingsCount === 0 && _snapTotalValue === 0 && _snapActivityEvents > 0) {
      _cacheQuality = 'portfolio_failed'
      _cacheWriteBlocked = true
      _blockedWriteReason = `portfolio_empty_with_${_snapActivityEvents}_activity_events`
    } else if (_snapHoldingsCount === 0 && _snapTotalValue === 0 && (_snapProviderStatus === 'failed' || _snapProviderStatus === 'partial')) {
      _cacheQuality = 'portfolio_failed'
      _cacheWriteBlocked = true
      _blockedWriteReason = `portfolio_provider_${_snapProviderStatus}`
    }

    // Persistent cache + cooldown writes — cross-instance, survives Vercel cold-starts
    // Historical scans now persist under their own 'historical' scanMode/cacheKey + WALLET_HISTORICAL_CACHE_TTL_MS
    // (via cacheKey/_cacheTtlMs, which already resolve to the historical variants when effectiveHistoricalCoverage
    // is true) so expensive historical scans can be served from persistent cache instead of rerunning live.
    if (_cacheWriteAttempted && deepActivity && !inFlightDeduped && _persistentAvailable && !_cacheWriteBlocked) {
      _persistentCacheWriteAttempted = true
      const _ppayload: any = { ...snapshot }
      // Extract slim diagnostics before pruning so cached responses can surface them with debug=true
      const _lotDbgForSlim = snapshot._diagnostics?.walletLotEngineDebug ?? null
      const _priceDbgForSlim = snapshot._diagnostics?.walletPriceAtTimeDebug ?? null
      const _slimDiag: Record<string, unknown> = {
        walletPriceAtTimeDebug: _priceDbgForSlim,
        walletPriceBudgetDebug: snapshot._diagnostics?.walletPriceBudgetDebug ?? null,
        unmatchedSellBackfillDebug: snapshot._diagnostics?.unmatchedSellBackfillDebug ?? null,
        ethSwapReconstructionDebug: snapshot._diagnostics?.ethSwapReconstructionDebug ?? null,
        basePnlReconstructionDebug: snapshot._diagnostics?.basePnlReconstructionDebug ?? null,
        baseUnknownSwapReconstructionDebug: snapshot._diagnostics?.baseUnknownSwapReconstructionDebug ?? null,
        baseUnknownSwapPricingDebug: snapshot._diagnostics?.baseUnknownSwapPricingDebug ?? null,
        finalSummarySourceDebug: snapshot._diagnostics?.finalSummarySourceDebug ?? null,
        baseFifoCoverageDebug: snapshot._diagnostics?.baseFifoCoverageDebug ?? null,
        walletActivityRoutingDebug: snapshot._diagnostics?.walletActivityRoutingDebug ?? null,
        walletChainActivityMergeDebug: snapshot._diagnostics?.walletChainActivityMergeDebug ?? null,
        walletEthNormalizationDebug: snapshot._diagnostics?.walletEthNormalizationDebug ?? null,
        syntheticLotRecoveryDebug: snapshot._diagnostics?.syntheticLotRecoveryDebug ?? null,
        swapReconstructionV1Debug: snapshot._diagnostics?.swapReconstructionV1Debug ?? null,
        walletCacheQualityDebug: {
          cacheQuality: _cacheQuality, writeAllowed: !_cacheWriteBlocked,
          blockedWriteReason: _blockedWriteReason, holdingsCount: _snapHoldingsCount,
          totalValue: _snapTotalValue, activityEvents: _snapActivityEvents,
          providerStatus: _snapProviderStatus,
        },
        baseFifoMatchDebug: (_lotDbgForSlim || _priceDbgForSlim) ? {
          baseCandidateEvents: snapshot.walletSwapSummary?.swapCandidateEvents ?? 0,
          pricedEvents: snapshot.walletPriceEvidenceSummary?.pricedEvents ?? 0,
          fifoBuyEvents: _lotDbgForSlim?.buyEvents ?? 0,
          fifoSellEvents: _lotDbgForSlim?.sellEvents ?? 0,
          closedLots: _lotDbgForSlim?.closedLots ?? 0,
          openedLots: _lotDbgForSlim?.openedLots ?? 0,
          unmatchedBuys: _lotDbgForSlim?.unmatchedBuys ?? 0,
          unmatchedSells: _lotDbgForSlim?.unmatchedSells ?? 0,
          skippedUnpriced: _lotDbgForSlim?.skippedUnpricedEvents ?? 0,
          sampleUnpricedReasons: _priceDbgForSlim?.sampleUnpricedReasons ?? [],
          priceAtTimeReasons: _priceDbgForSlim?.reasons ?? [],
          fifoReasons: _lotDbgForSlim?.reasons ?? [],
        } : null,
      }
      pruneWalletScannerDebug(_ppayload, false)
      _ppayload._cachedDiagnosticsSlim = _slimDiag
      const _persistentCacheWriteStartedAt = Date.now()
      // Deep cooldown persistence is scoped to non-historical deep scans only — historical scans
      // already persist their own cooldown via writePersistentCooldown(hcCooldownKey, ...) above.
      const _persistentWrites: Promise<unknown>[] = [writePersistentWalletCache(cacheKey, key, scanModeKey, chainKey, _ppayload, _cacheTtlMs)]
      if (!effectiveHistoricalCoverage) {
        _persistentWrites.push(writePersistentCooldown(deepCooldownKey, key, chainKey, WALLET_DEEP_COOLDOWN_MS))
      }
      const [cacheResult] = await Promise.allSettled(_persistentWrites)
      _cacheWriteMs += Date.now() - _persistentCacheWriteStartedAt
      _persistentCacheWriteSucceeded = cacheResult.status === 'fulfilled' && cacheResult.value === true
    }

    if (debug) {
      ;snapshot._debug = {
        routeName: '/api/wallet',
        cacheHit: false,
        goldrushUsage: {
          endpointName: 'balances_v2 + transactions_v3',
          feature: 'wallet-scanner',
          trigger: 'scan_button',
          attempted: Boolean(providers.goldrush?.configured),
          cacheHit: Boolean(snapshot._diagnostics?.snapshotCache?.memoryHit),
          deduped: false,
          statusCode: providers.goldrush?.httpStatus ?? null,
          durationMs: Date.now() - startedAt,
          failureStage: providers.goldrush?.reason || null,
          reason: providers.goldrush?.reason || null,
        },
        alchemyConfigured: Boolean(providers.alchemy?.configured),
        alchemyCallsAttempted: providers.alchemy?.behaviorAttempted ? 1 : 0,
        alchemyCallsSucceeded: Number(providers.alchemy?.transfersReturned ?? 0) > 0 ? 1 : 0,
        alchemyCallsFailed: providers.alchemy?.behaviorAttempted && Number(providers.alchemy?.transfersReturned ?? 0) === 0 ? 1 : 0,
        rpcMethodsUsed: providers.alchemy?.behaviorAttempted ? ['alchemy_getAssetTransfers'] : [],
        skippedReason: providers.alchemy?.behaviorAttempted ? null : 'alchemy_not_configured',
        requestDurationMs: Date.now() - startedAt,
        walletSnapshotCache: snapshotCacheDebug,
        providerFallback: snapshot._diagnostics?.providerFallback ?? null,
        walletProviderRouting: snapshot._diagnostics?.walletProviderRouting ?? null,
        moralisUsage: snapshot._diagnostics?.moralisUsage ?? null,
        providerFlow: snapshot._diagnostics?.providerFlow ?? null,
        chainUsage: snapshot._diagnostics?.chainUsage ?? null,
        walletTxEvidenceDebug: snapshot._diagnostics?.walletTxEvidenceDebug ?? null,
        walletSwapDetectionDebug: snapshot._diagnostics?.walletSwapDetectionDebug ?? null,
        walletPriceAtTimeDebug: snapshot._diagnostics?.walletPriceAtTimeDebug ?? null,
        unmatchedSellBackfillDebug: snapshot._diagnostics?.unmatchedSellBackfillDebug ?? null,
        walletLotEngineDebug: snapshot._diagnostics?.walletLotEngineDebug ?? null,
        walletTradeStatsDebug: snapshot._diagnostics?.walletTradeStatsDebug ?? null,
        ethSwapReconstructionDebug: snapshot._diagnostics?.ethSwapReconstructionDebug ?? null,
        basePnlReconstructionDebug: snapshot._diagnostics?.basePnlReconstructionDebug ?? null,
        baseUnknownSwapReconstructionDebug: snapshot._diagnostics?.baseUnknownSwapReconstructionDebug ?? null,
        baseUnknownSwapPricingDebug: snapshot._diagnostics?.baseUnknownSwapPricingDebug ?? null,
        finalSummarySourceDebug: snapshot._diagnostics?.finalSummarySourceDebug ?? null,
        baseFifoCoverageDebug: snapshot._diagnostics?.baseFifoCoverageDebug ?? null,
        walletActivityRoutingDebug: snapshot._diagnostics?.walletActivityRoutingDebug ?? null,
        walletChainActivityMergeDebug: snapshot._diagnostics?.walletChainActivityMergeDebug ?? null,
        walletEthNormalizationDebug: snapshot._diagnostics?.walletEthNormalizationDebug ?? null,
        walletHistoricalCoverageDebug: snapshot._diagnostics?.walletHistoricalCoverageDebug ?? null,
        walletHistoricalCandidateDebug: snapshot._diagnostics?.walletHistoricalCandidateDebug ?? null,
        walletHistoricalPricingPreviewDebug: snapshot._diagnostics?.walletHistoricalPricingPreviewDebug ?? null,
        walletHistoricalFifoPreviewDebug: snapshot._diagnostics?.walletHistoricalFifoPreviewDebug ?? null,
        syntheticLotRecoveryDebug: snapshot._diagnostics?.syntheticLotRecoveryDebug ?? null,
        swapReconstructionV1Debug: snapshot._diagnostics?.swapReconstructionV1Debug ?? null,
        walletBudgetDebug: snapshot._diagnostics?.walletBudgetDebug ?? null,
        walletFactsDebug: snapshot._diagnostics?.walletFactsDebug ?? null,
        baseFifoMatchDebug: (() => {
          const lotDbg = snapshot._diagnostics?.walletLotEngineDebug ?? null
          const priceDbg = snapshot._diagnostics?.walletPriceAtTimeDebug ?? null
          return {
            baseCandidateEvents: snapshot.walletSwapSummary?.swapCandidateEvents ?? 0,
            pricedEvents: snapshot.walletPriceEvidenceSummary?.pricedEvents ?? 0,
            fifoBuyEvents: lotDbg?.buyEvents ?? 0,
            fifoSellEvents: lotDbg?.sellEvents ?? 0,
            closedLots: lotDbg?.closedLots ?? 0,
            openedLots: lotDbg?.openedLots ?? 0,
            unmatchedBuys: lotDbg?.unmatchedBuys ?? 0,
            unmatchedSells: lotDbg?.unmatchedSells ?? 0,
            uniqueBuyTokenKeys: lotDbg?.uniqueBuyTokenKeys ?? 0,
            uniqueSellTokenKeys: lotDbg?.uniqueSellTokenKeys ?? 0,
            matchedTokenKeys: lotDbg?.matchedTokenKeys ?? 0,
            unmatchedBuyTokenKeys: lotDbg?.unmatchedBuyTokenKeys ?? [],
            unmatchedSellTokenKeys: lotDbg?.unmatchedSellTokenKeys ?? [],
            skippedUnknownSide: lotDbg?.skippedUnknownSide ?? 0,
            skippedMissingTokenKey: lotDbg?.skippedMissingFields ?? 0,
            skippedQuoteAssetOnly: lotDbg?.skippedStableQuoteAssets ?? 0,
            skippedUnpriced: lotDbg?.skippedUnpricedEvents ?? 0,
            samplePricedEvents: priceDbg?.samplePricedEvents ?? [],
            sampleBuyEvents: lotDbg?.sampleBuyEvents ?? [],
            sampleSellEvents: lotDbg?.sampleSellEvents ?? [],
            sampleClosedLots: lotDbg?.sampleClosedLots ?? [],
            sampleUnmatchedReasons: lotDbg?.sampleUnmatchedReasons ?? [],
            fifoReasons: lotDbg?.reasons ?? [],
            priceAtTimeReasons: priceDbg?.reasons ?? [],
          }
        })(),
        walletCacheQualityDebug: {
          cacheQuality: _cacheQuality,
          writeAllowed: !_cacheWriteBlocked,
          blockedWriteReason: _blockedWriteReason,
          holdingsCount: _snapHoldingsCount,
          totalValue: _snapTotalValue,
          activityEvents: _snapActivityEvents,
          providerStatus: _snapProviderStatus,
        },
        apiAudit: snapshot._diagnostics?.apiAudit ?? null,
        walletModuleCoverageRaw: {
          // Reflects the holdings provider actually selected this scan (walletHoldingsProviderRoutingDebug),
          // not just which providers are configured — "configured" doesn't mean "used".
          portfolioProvider: snapshot._diagnostics?.walletHoldingsProviderRoutingDebug?.selectedProvider
            ?? (providers.goldrush?.configured ? 'goldrush' : providers.zerion?.configured ? 'zerion' : 'none'),
          activityProvider: snapshot._diagnostics?.walletActivityFallbackDebug?.fallbackActivityProvider ?? (providers.goldrush?.configured ? 'goldrush' : 'none'),
          swapDetectionSource: 'wallet_snapshot_engine',
          priceSource: 'price_at_time_cache',
          fifoSource: 'fifo_lot_engine',
          coverage: walletModuleCoverage,
        },
        walletScanBudgetDebug: snapshot._diagnostics?.walletScanBudgetDebug ?? null,
        walletHistoricalScanDebug: snapshot._diagnostics?.walletHistoricalScanDebug ?? null,
        walletCostGuardDebug: {
          requestedDeepActivity: deepActivity,
          requestedHistoricalCoverage: historicalCoverageRequested,
          requestedMaxHistoricalPages: body?.maxHistoricalPages ?? null,
          effectiveMaxHistoricalPages: maxHistoricalPages,
          effectiveHistoricalCoverage,
          cacheKey,
          cacheHit: false,
          cooldownHit: cooldownActive,
          costGuardHit,
          inFlightDeduped,
          previousCostHint: costHint ? { rawLogEvents: costHint.rawLogEvents, requestDurationMs: costHint.requestDurationMs } : null,
          reason: costGuardHit ? 'historical_scan_cached_due_to_cost_guard' : cooldownActive ? 'historical_scan_cached_due_to_cooldown' : null,
        },
        walletActivityRequestDebug: {
          deepActivityRequested: deepActivity || deepScan,
          deepActivityFlagSent: deepActivityFlag,
          includeActivityFlagSent: includeActivityFlag,
          deepScanFlagSent: deepScan,
          cacheMode,
          cacheKey,
          cacheKeyIncludesDeepActivity: cacheMode === 'activity',
          cacheHit: false,
          cacheAgeSeconds: null,
          deepActivityAllowed: true,
          routeAllowed: true,
          plan,
          routeMethod: 'POST /api/wallet',
          fetchedPnlEvents: snapshot.walletEvidenceSummary?.totalEvents ?? 0,
          fetchedEvidenceEvents: snapshot.walletEvidenceSummary?.eventsWithHash ?? 0,
          evidenceStatus: snapshot.walletEvidenceSummary?.status ?? 'unknown',
          primaryActivityAttempted: snapshot._diagnostics?.walletActivityRequestDebug?.primaryActivityAttempted ?? false,
          primaryActivityFailed: snapshot._diagnostics?.walletActivityRequestDebug?.primaryActivityFailed ?? false,
          primaryActivityStatusCode: snapshot._diagnostics?.walletActivityRequestDebug?.primaryActivityStatusCode ?? null,
          primaryActivityErrorKind: snapshot._diagnostics?.walletActivityRequestDebug?.primaryActivityErrorKind ?? null,
          fallbackActivityAttempted: snapshot._diagnostics?.walletActivityRequestDebug?.fallbackActivityAttempted ?? false,
          fallbackActivityUsed: snapshot._diagnostics?.walletActivityRequestDebug?.fallbackActivityUsed ?? false,
          fallbackActivityReason: snapshot._diagnostics?.walletActivityRequestDebug?.fallbackActivityReason ?? 'not_wired',
          finalEvidenceStatus: snapshot._diagnostics?.walletActivityRequestDebug?.finalEvidenceStatus ?? snapshot.walletEvidenceSummary?.status ?? 'unknown',
          reason: (deepActivity || deepScan) ? null : 'deep_activity_not_requested',
          // Activity fallback telemetry (populated when primary providers returned nothing)
          ...(() => {
            const fb = snapshot._diagnostics?.walletActivityFallbackDebug
            if (!fb) return {}
            return {
              primaryActivityAttempted: fb.primaryActivityAttempted,
              primaryActivityFailed: fb.primaryActivityFailed,
              primaryActivityStatusCode: fb.primaryActivityStatusCode,
              primaryActivityErrorKind: fb.primaryActivityErrorKind,
              fallbackActivityAttempted: fb.fallbackActivityAttempted,
              fallbackActivityUsed: fb.fallbackActivityUsed,
              fallbackActivityProvider: fb.fallbackActivityProvider,
              fallbackActivityStatusCode: fb.fallbackActivityStatusCode,
              fallbackActivityRawCount: fb.fallbackActivityRawCount,
              fallbackActivityNormalizedEvents: fb.fallbackActivityNormalizedEvents,
              fallbackActivityReason: fb.fallbackActivityReason,
              finalEvidenceStatus: fb.finalEvidenceStatus,
              fallbackActivitySampleShape: fb.fallbackActivitySampleShape ?? null,
              fallbackNormalizationDebug: fb.fallbackNormalizationDebug ?? null,
              fallbackPagesAttempted: fb.fallbackPagesAttempted,
              fallbackPagesUsed: fb.fallbackPagesUsed,
              fallbackCursorsSeen: fb.fallbackCursorsSeen,
              fallbackRawTotal: fb.fallbackRawTotal,
              fallbackNormalizedTotal: fb.fallbackNormalizedTotal,
              fallbackDedupeRemoved: fb.fallbackDedupeRemoved,
              fallbackPaginationReason: fb.fallbackPaginationReason,
              fallbackPaginationStoppedReason: fb.fallbackPaginationStoppedReason,
              fallbackClosedLotsAfterPage1: fb.fallbackClosedLotsAfterPage1,
              fallbackClosedCostBasisAfterPage1: fb.fallbackClosedCostBasisAfterPage1 ?? null,
              fallbackRealizedPnlAfterPage1: fb.fallbackRealizedPnlAfterPage1 ?? null,
              fallbackMeaningfulEvidenceReached: fb.fallbackMeaningfulEvidenceReached,
              fallbackMeaningfulEvidenceReason: fb.fallbackMeaningfulEvidenceReason,
            }
          })(),
        },
        walletScanCostDebug: (() => {
          const hcDbg = snapshot._diagnostics?.walletHistoricalCoverageDebug ?? null
          const hcSum = snapshot.walletHistoricalCoverageSummary ?? null
          const grConf = Boolean(providers.goldrush?.configured)
          const grCache = Boolean(snapshotCacheDebug?.memoryHit)
          const alchAtt = Boolean(providers.alchemy?.behaviorAttempted)
          const txPg: number = hcSum?.pagesAttempted ?? (deepActivity ? 1 : 0)
          type PC = { provider: string; endpointName: string; attempted: boolean; cacheHit: boolean; statusCode?: number | null; durationMs?: number | null; pagesFetched?: number | null; rawItems?: number | null; rawLogEvents?: number | null; normalizedEvents?: number | null; estimatedCreditUnits?: number | null; failureKind?: string | null; reason?: string | null }
          const calls: PC[] = []
          const activityDbg = snapshot._diagnostics?.walletActivityRequestDebug ?? null
          const grFailureKind = activityDbg?.primaryActivityFailed ? activityDbg.primaryActivityErrorKind ?? 'fetch_failed' : null
          const grReason = activityDbg?.primaryActivityFailed ? 'primary_activity_failed' : null
          const grStatusCode = activityDbg?.primaryActivityFailed ? null : providers.goldrush?.httpStatus ?? null
          const grCredits = (inFlightDeduped || grCache) ? 0 : activityDbg?.primaryActivityFailed ? 1 : grConf ? (1 + (deepActivity ? txPg : 0)) : 0
          calls.push({ provider: 'goldrush', endpointName: deepActivity ? 'balances_v2 + transactions_v3' : 'balances_v2', attempted: grConf, cacheHit: grCache, statusCode: grStatusCode, durationMs: null, pagesFetched: deepActivity ? txPg : null, rawItems: providers.goldrush?.rawItemCount ?? null, rawLogEvents: null, normalizedEvents: providers.goldrush?.normalizedEventCount ?? null, estimatedCreditUnits: grCredits, failureKind: grFailureKind, reason: grReason })
          if (effectiveHistoricalCoverage) {
            const hcPg: number = hcSum?.pagesAttempted ?? maxHistoricalPages
            calls.push({ provider: 'goldrush', endpointName: 'log_events_by_address (historical)', attempted: true, cacheHit: false, statusCode: null, durationMs: null, pagesFetched: hcPg, rawItems: null, rawLogEvents: hcDbg?.rawLogEvents ?? hcSum?.rawLogEvents ?? null, normalizedEvents: hcDbg?.normalizedEvents ?? hcSum?.normalizedEvents ?? null, estimatedCreditUnits: inFlightDeduped ? 0 : hcPg })
          }
          if (alchAtt) {
            calls.push({ provider: 'alchemy', endpointName: 'alchemy_getAssetTransfers', attempted: true, cacheHit: false, statusCode: null, durationMs: null, pagesFetched: null, rawItems: providers.alchemy?.transfersReturned ?? null, rawLogEvents: null, normalizedEvents: null, estimatedCreditUnits: inFlightDeduped ? 0 : 1 })
          }
          // Moralis activity fallback calls — one entry per page attempted
          const fbDbg = snapshot._diagnostics?.walletActivityFallbackDebug ?? null
          if (fbDbg?.fallbackActivityAttempted && fbDbg.fallbackActivityProvider === 'moralis') {
            const fbPages: number = (fbDbg as any).fallbackPagesAttempted ?? 1
            for (let pg = 1; pg <= fbPages; pg++) {
              const isPage1 = pg === 1
              const pgRaw = isPage1 ? fbDbg.fallbackActivityRawCount : null
              const pgNorm = isPage1 ? fbDbg.fallbackActivityNormalizedEvents : null
              const pgCache = isPage1 ? (fbDbg.fallbackActivityStatusCode === null && fbDbg.fallbackActivityRawCount > 0) : false
              calls.push({ provider: 'activity_fallback', endpointName: `erc20_transfers_page${pg}`, attempted: true, cacheHit: pgCache, statusCode: isPage1 ? fbDbg.fallbackActivityStatusCode : null, durationMs: null, pagesFetched: 1, rawItems: pgRaw, rawLogEvents: null, normalizedEvents: pgNorm, estimatedCreditUnits: inFlightDeduped || pgCache ? 0 : 1 })
            }
          }
          const totalCu = calls.reduce((s, c) => s + (c.estimatedCreditUnits ?? 0), 0)
          const liveCalls = inFlightDeduped ? 0 : calls.filter(c => c.attempted && !c.cacheHit).length
          const cachedCalls = calls.filter(c => c.cacheHit).length
          const _budgetDbgForCost = snapshot._diagnostics?.walletPriceBudgetDebug ?? null
          const _priceAttemptsUsed = _budgetDbgForCost?.finalPriceAttempts ?? snapshot._diagnostics?.walletPriceAtTimeDebug?.priceAttempts ?? 0
          const _priceAttemptsPlanned = _budgetDbgForCost?.maxBudget ?? 12
          return {
            scanId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            address: key,
            requestedDeepActivity: deepActivity,
            requestedHistoricalCoverage: historicalCoverageRequested,
            requestedMaxHistoricalPages: body?.maxHistoricalPages ?? null,
            effectiveMaxHistoricalPages: maxHistoricalPages,
            scanMode: scanModeKey,
            resolvedChainMode,
            testCacheOnly: WALLET_TEST_CACHE_ONLY,
            goldrushDailyCreditsUsed: GOLDRUSH_DAILY_SOFT_CAP > 0 ? _goldrushDailyCreditsUsed : null,
            goldrushDailySoftCap: GOLDRUSH_DAILY_SOFT_CAP > 0 ? GOLDRUSH_DAILY_SOFT_CAP : null,
            dataFreshness: 'live' as const,
            cacheKey,
            cacheVersion: WALLET_SNAPSHOT_SCHEMA_VERSION,
            cacheBypassReason,
            debugFreshBypassedPersistentCache,
            debugFreshAllowed,
            debugFreshRejected: freshRequested && !debugFreshAllowed,
            noCacheWrite,
            cacheReadAttempted: _cacheReadAttempted,
            cacheWriteAttempted: _cacheWriteAttempted,
            cacheWriteSucceeded: _cacheWriteAttempted && (_persistentCacheWriteSucceeded || !_persistentAvailable),
            cooldownKey: deepCooldownKey,
            cooldownHit: deepCooldownActive,
            cooldownExpiresInSeconds: _cooldownExpiresInSeconds,
            cacheBackend: _cacheBackend,
            persistentCacheReadAttempted: _persistentCacheReadAttempted,
            persistentCacheHit: _persistentCacheHit,
            persistentCacheWriteAttempted: _persistentCacheWriteAttempted,
            persistentCacheWriteSucceeded: _persistentCacheWriteSucceeded,
            persistentCooldownReadAttempted: _persistentCooldownReadAttempted,
            persistentCooldownHit: _persistentCooldownHit,
            cacheMissReason: _cacheMissReason,
            providerFetchNeeded: true,
            servedFromCacheReason: null,
            blockedLiveFetchReason: null,
            cacheHit: false,
            inFlightDeduped,
            providerCalls: calls,
            priceAttemptsPlanned: _priceAttemptsPlanned,
            priceAttemptsUsed: _priceAttemptsUsed,
            priceAttemptsSavedByBudget: Math.max(0, _priceAttemptsPlanned - _priceAttemptsUsed),
            priceBudgetExpanded: (_budgetDbgForCost?.expansionEligible) ?? false,
            priceBudgetExpansionReason: (_budgetDbgForCost?.expansionReason) ?? null,
            historicalScanRequested: historicalCoverageRequested,
            // SYNTH-RECOVERY-FIX-11: maxPages is applied PER CHAIN inside buildWalletHistoricalCoverage
            // (base-mainnet + eth-mainnet), so these fields disambiguate per-chain vs total units instead
            // of conflating "pagesAllowed" (per-chain) with "pagesAttempted" (total) as before.
            historicalMaxPagesTotal: (snapshot as any)?._diagnostics?.walletHistoricalScanDebug?.historicalMaxPagesTotal ?? 0,
            historicalMaxPagesPerChain: (snapshot as any)?._diagnostics?.walletHistoricalScanDebug?.historicalMaxPagesPerChain ?? 0,
            historicalPagesAttemptedTotal: (snapshot as any)?._diagnostics?.walletHistoricalScanDebug?.historicalPagesAttemptedTotal ?? 0,
            historicalPagesAttemptedByChain: (snapshot as any)?._diagnostics?.walletHistoricalScanDebug?.historicalPagesAttemptedByChain ?? {},
            historicalCreditBudget: (snapshot as any)?._diagnostics?.walletHistoricalScanDebug?.historicalCreditBudget ?? 0,
            historicalCreditsUsed: (snapshot as any)?._diagnostics?.walletHistoricalScanDebug?.historicalCreditsUsed ?? 0,
            syntheticTargetExtraCreditUsed: (snapshot as any)?._diagnostics?.walletHistoricalScanDebug?.syntheticTargetExtraCreditUsed ?? 0,
            historicalCreditsSavedByCache: (snapshot as any)?._diagnostics?.walletHistoricalScanDebug?.cacheHit ? ((snapshot as any)?._diagnostics?.walletHistoricalScanDebug?.historicalCreditBudget ?? 0) : 0,
            historicalBudgetCapHit: (snapshot as any)?._diagnostics?.walletHistoricalScanDebug?.historicalBudgetCapHit ?? false,
            historicalBudgetCapReason: (snapshot as any)?._diagnostics?.walletHistoricalScanDebug?.historicalBudgetCapReason ?? null,
            historicalSkippedReason: (snapshot as any)?._diagnostics?.walletHistoricalScanDebug?.stopReason ?? null,
            totals: {
              liveProviderCalls: liveCalls,
              cachedProviderCalls: cachedCalls,
              pagesFetched: calls.reduce((s, c) => s + (c.pagesFetched ?? 0), 0),
              rawItems: calls.reduce((s, c) => s + (c.rawItems ?? 0), 0),
              rawLogEvents: calls.reduce((s, c) => s + (c.rawLogEvents ?? 0), 0),
              normalizedEvents: calls.reduce((s, c) => s + (c.normalizedEvents ?? 0), 0),
              estimatedCreditUnits: totalCu,
              durationMs: Date.now() - startedAt,
            },
            reason: null,
          }
        })(),
      }
    }
    if (!debug) {
      // HOLDINGS-PROVIDER-ROUTING-HONESTY: previously this forced providerUsed/portfolioSource to the
      // literal 'holdings_layer'/'portfolio_layer' on every non-debug response, even when the actual
      // selected provider was the Zerion or GoldRush fallback layer — preserve the real values computed
      // in walletSnapshot.ts instead of overwriting them with a provider-agnostic guess.
      ;snapshot.behaviorSource = snapshot.behaviorSource === 'unavailable' ? 'unavailable' : 'activity_layer'
      ;snapshot.pnlSource = snapshot.pnlSource === 'unavailable' ? 'unavailable' : 'activity_layer'
    }
    const _budgetDbg = (snapshot._diagnostics as any)?.walletBudgetDebug
    if (_budgetDbg?.budgetCapped) {
      snapshot.walletScanBudgetNote = `Activity scan capped at ${_budgetDbg.capLimit} events (${_budgetDbg.dedupRemoved} duplicates removed from ${_budgetDbg.eventsBefore} raw).`
    }
    // Write to cache after every live scan (including refresh=true) so subsequent normal requests benefit.
    // Only allowDebugFresh (explicit admin override) or a poisoned result skips the write.
    if (_cacheWriteAttempted && !_cacheWriteBlocked) {
      const _memoryCacheWriteStartedAt = Date.now()
      walletCache.set(cacheKey, { exp: Date.now() + _cacheTtlMs, payload: snapshot, cachedAt: Date.now() })
      _cacheWriteMs += Date.now() - _memoryCacheWriteStartedAt
    }
    if (snapshot._debug && typeof snapshot._debug === 'object' && (snapshot._debug as any).cacheHit === false) {
      snapshot.dataFreshness = 'live'
      snapshot.cacheAgeSeconds = null
    }
    attachWalletDeepScanTiming(snapshot, buildWalletDeepScanTiming(snapshot, startedAt, _cacheReadMs, _cacheWriteMs, { cacheHit: false, dedupeHit: inFlightDeduped }), debug)
    attachWalletDeepScanStaging(snapshot, { mode: deepActivity ? 'deep' : 'standard', cacheHit: false, dedupeHit: inFlightDeduped, inFlightDeduped, debug })
    pruneWalletScannerDebug(snapshot, debug)
    return json(snapshot)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Wallet scan failed'
    const status = msg === 'Invalid wallet address' ? 400 : 500
    return json({ error: status === 400 ? 'Invalid wallet address' : 'Wallet scan unavailable right now.' }, { status })
  }
}
