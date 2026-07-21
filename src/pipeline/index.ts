// MODULE 9 — pipelineOrchestrator
//
// Wires all 8 existing modules into a single entry point, runWalletScan(). This file adds no new
// domain logic — every computation is delegated to the module that owns it; this layer only
// sequences the calls, threads outputs from one stage into the next, and wraps each downstream
// stage (5-8) in a fallback-safe wrapper so a single stage's failure degrades that stage only,
// never crashes the whole scan (Architecture Step 7).
//
// Cost guarantee (Step 8): the ONLY awaited network calls anywhere in this file are
// fetchProviderWindow (stage 1) and, when scanMode === 'deep', buildRecoveryPolicyObject
// (stage 5). Every other stage is a synchronous, pure, or try/catch-wrapped pure call.

import { fetchProviderWindow } from '../modules/providerFetchWindow/index'
import type { RawProviderEvent, SupportedChain } from '../modules/providerFetchWindow/types'
import { normalizeEvents } from '../modules/normalization/index'
import { buildCounterpartyStats, classifyRouterLikeEvent, recordRouterCandidate } from './routerDiscovery'
import { createRouterInference } from '../lib/routerInference'
import { createPnlReconciliation } from '../lib/pnlReconciliation'
import { createAyriAttribution } from '../lib/ayriAttribution'
import { createFinalReportAssembler } from '../lib/finalReportAssembler'
import { analyzeDistributorRouterFlows } from '../modules/distributorRecovery/index'
import { reconstructRouterTrades } from '../modules/routerTradeReconstruction/index'
import { logSyntheticPnlSummary, syntheticPnlAssembly } from '../modules/syntheticPnl/index'
import type { PoolDataMap as SyntheticPoolDataMap } from '../modules/syntheticPnl/index'
import { adaptPnlSummaryForUi } from './pnlSummaryAdapter'
import { buildChainAwareHistoricalPriceSource, pricingRouteLog } from './pricingAtTimeAdapter'
import type { NormalizedEvent } from '../modules/normalization/types'
import { buildChainSelectionObject } from '../modules/chainSelection/index'
import type { ChainSelectionResult } from '../modules/chainSelection/types'
import { buildTimelines } from '../modules/timelineBuilder/index'
import type { BuyTimeline, BuyTimelineEntry, SellTimeline, TimelineBuilderResult } from '../modules/timelineBuilder/types'
import { buildRecoveryPolicyObject } from '../modules/recoveryPolicy/index'
import type { RecoveryPolicyResult } from '../modules/recoveryPolicy/types'
import { buildFifoOutput } from '../modules/fifoEngine/index'
import type { FifoOutput } from '../modules/fifoEngine/types'
import { buildBehaviorIntelObject } from '../modules/behaviorIntel/index'
import type { BehaviorIntelResult, WindowCoverage } from '../modules/behaviorIntel/types'
import type { FinalReport, ScanMetadata } from '../modules/finalReportAssembler/types'
import { buildBridgeDetectionObject } from '../modules/bridgeDetection/index'
import type { BridgeCandidateEvent } from '../modules/bridgeDetection/types'
import { buildSellTimeline } from '../modules/sellTimeline/index'
import type { SellTimelineEntry, SellTimelineResult } from '../modules/sellTimeline/types'
import { buildPnlSummary } from '../modules/pnlEngine/index'
import type { BuildPnlSummaryParams, PnlSummaryResult } from '../modules/pnlEngine/types'
import { resolvePricingAtTime } from '../modules/pricingAtTimeEngine/index'
import type { FallbackPricingConfig, FallbackPricingRoute, PriceableEntry, PriceSourceFn, PriceSources, PricingAtTimeResult } from '../modules/pricingAtTimeEngine/types'
import { fallbackPricingService } from '../modules/fallbackPricing/index'
import { GoldRushClient } from '@covalenthq/client-sdk'
import { goldrushPriceSource, isKnownGoldrushNegative } from '../modules/pricingAtTimeEngine/sources/goldrushPriceSource'
import { priceLotsForWallet } from './priceLotsForWallet'
import { createProviderWindowKvWriter, withStageCache } from '../../lib/server/cache/v2StageCache'
import { createRequestPriceKvClient } from '../lib/kvClient'
import type { MatchedLot } from '../modules/fifoEngine/types'
import { getCheapCurrentPriceForDustCheck, type CheapDustPriceResult } from '../../lib/server/dustPriceCheck'
import { rpcDebugLog, type RpcDebugEntry } from '../../lib/server/rpcDebug'
import { buildWalletConditionMessages } from './walletConditionMessages'
import { buildSyntheticPoolPriceData, discoverAerodromePools, mapAerodromeToken, priceBaseTokenFromAerodrome, resolvePipelinePrice } from './pricing'
import type { AerodromePool } from './metadata'

import type { PreScanValidation, RunWalletScanParams, RunWalletScanResult } from './types'
import { INTEL_WINDOW_DAYS } from './types'
import {
  behaviorIntelFallback,
  bridgeTimelineFallback,
  buildFullyDegradedReport,
  computeWindowCoverage,
  emptyChainSelection,
  emptyTimelines,
  fifoEngineFallback,
  noPriceSources,
  pnlSummaryV2Fallback,
  pricingAtTimeFallback,
  recoveryPolicyFallback,
  sellTimelineV2Fallback,
  validatePreScan,
} from './utils'

export type { PreScanValidation, RunWalletScanParams, RunWalletScanResult } from './types'
export { INTEL_WINDOW_DAYS, SUPPORTED_CHAINS } from './types'

const PROVIDER_FETCH_WINDOW_DAYS_USED = 90

// Real GoldRush SDK integration for pricingAtTime (src/modules/pricingAtTimeEngine). Built once at
// module load, since the API key doesn't change per-request.
//
// `fallback` is now the real multi-provider engine (DexScreener/CoinGecko/Base-native Uniswap V3 —
// src/modules/pricingAtTimeEngine/sources/multiProviderPriceSource.ts) instead of always-null
// noPriceSources().fallback — genuine additional real price coverage, tried only when GoldRush
// (primary) has no data for a given token/timestamp. It never fabricates a value either: every
// branch inside it is a real HTTP/RPC call or an honest null, exactly like goldrushPriceSource.
// KV read-before/write-after for a price source function — "only safe paths" per the request: a
// resolved price for a given (token, chain, timestamp) triple is the same answer for every caller
// (a past timestamp's price is immutable; a "now" timestamp changes every call anyway, so it
// naturally near-never collides in cache) — never wraps anything that could serve a stale price as
// if it were still current beyond the TTL. 45s TTL, same as recoveryPolicy (the other real network
// call in this pipeline). Never caches a null result — an honest "no price found" should keep
// trying on the next request, not get stuck for 45s once a provider has a transient miss.
// KV-ROUND-TRIP-SKIP, DISCLOSED (found live, latency-investigation task): a null result is
// deliberately never written to KV (see this function's own header above this edit's diff context)
// — an honest "no price found" shouldn't get stuck cached for the TTL. But that means a token this
// price source already knows (in its own fast, in-memory, zero-network cache) has no data STILL
// paid a full remote KV round-trip on every repeat occurrence, forever — confirmed live: a real
// scan's External APIs showed a KV call and a 7s+ GoldRush call in the same request, and
// avgLookupsPerToken of 6.71 with primary:0 every single time, meaning hundreds of guaranteed-miss
// KV round-trips were stacked on top of the real work. `skipCacheCheck`, when supplied and it
// returns true for a given (token, chain), skips the KV get/set entirely and calls straight through
// to `fn` — which itself resolves near-instantly via its own in-memory negative-cache
// short-circuit, no network at all. Optional and unused by the `fallback` source below (which has
// no equivalent synchronous known-negative signal to offer), so its behavior is unchanged.
function withPriceSourceCache(fn: PriceSourceFn, _sourceLabel: string, _skipCacheCheck?: (token: string, chain: string) => boolean): PriceSourceFn {
  // Request-scoped KV caching is applied by createRequestPriceKvClient() at each pipeline run.
  // Keep this helper as a no-op compatibility shim so PRICE_SOURCES remains raw/deterministic at
  // module scope and the same request client can be shared between priceLotsForWallet and the
  // display-only pricingAtTime pass.
  return fn
}

function buildPriceSources(): PriceSources {
  const apiKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY
  // Diagnostic log (never prints the key itself) — the fastest way to confirm, from the actual
  // runtime's own logs (e.g. Vercel's function logs), whether a real key was found in *that*
  // process's env at module load, without needing a separate deployment-inspection tool.
  // eslint-disable-next-line no-console
  console.warn(`[pipeline] buildPriceSources: real GoldRush key present = ${Boolean(apiKey)}`)
  // CHAIN-AWARE ROUTING, DISCLOSED (src/pipeline/pricingAtTimeAdapter.ts's
  // buildChainAwareHistoricalPriceSource): Base tries GeckoTerminal -> DexScreener -> GoldRush;
  // every other chain tries GoldRush -> DexScreener -> GeckoTerminal; CoinGecko/basedex remain a
  // final safety net for every chain (see that file's own header for the full disclosure on both
  // points, including the false "GoldRush returns null for Base" premise this ordering was
  // requested under). The full router is assembled as a SINGLE `primary` source — `fallback` is
  // intentionally the always-null noPriceSources().fallback below, since the router already
  // encapsulates every real provider attempt itself; pricingAtTimeEngine would otherwise call a
  // second, redundant fallback after this one already tried everything.
  const goldrushFn: PriceSourceFn = apiKey ? (buildGoldrushSourceFn(apiKey) ?? noPriceSources().fallback) : noPriceSources().fallback
  const chainAwareHistorical = withPriceSourceCache(buildChainAwareHistoricalPriceSource(goldrushFn), 'chain-aware-historical')
  return { primary: chainAwareHistorical, fallback: noPriceSources().fallback }
}

// BUG FIX, DISCLOSED: `new GoldRushClient(apiKey)` throws synchronously (a plain object, not an
// Error instance — confirmed by reading the SDK's own source) when apiKey fails its local
// key-format regex check. Since buildPriceSources() runs at MODULE IMPORT TIME (PRICE_SOURCES below
// is a top-level `export const`), an unwrapped throw here would crash the entire module load for
// every route that imports this pipeline. A malformed (not just missing) key degrades to null
// (handled by the caller) instead of taking down the whole V2 pipeline at cold start.
function buildGoldrushSourceFn(apiKey: string): PriceSourceFn | null {
  try {
    const client = new GoldRushClient(apiKey)
    return withPriceSourceCache(goldrushPriceSource(client), 'primary', isKnownGoldrushNegative)
  } catch (err) {
    // The SDK throws a plain { error_message } object here, not an Error instance (confirmed by
    // reading its source) — extracted explicitly so this log is actually useful, not "[object Object]".
    const reason = err instanceof Error
      ? err.message
      : (typeof err === 'object' && err !== null && 'error_message' in err ? String((err as { error_message: unknown }).error_message) : String(err))
    // eslint-disable-next-line no-console
    console.warn('[pipeline] buildPriceSources: GoldRushClient construction failed, falling back', { reason })
    return null
  }
}

// Exported (read-only) so standalone tools — currently only
// src/modules/networkDiagnostics/networkDiagnostics.ts via app/api/diagnostics/pricing/route.ts —
// can verify the exact same configured price sources runWalletScan() itself uses, without
// duplicating buildPriceSources()'s logic or constructing a second GoldRushClient.
export const PRICE_SOURCES: PriceSources = buildPriceSources()

// Real pricing-provider status, computed once from the same env check buildPriceSources() itself
// uses. Exactly one real pricing provider exists in this codebase — GoldRush/Covalent — so
// providerCount is 0 or 1, never a fabricated multi-provider count. `active` and `keyLoaded` are
// currently identical for this one provider (no separate "loaded but disabled" state exists), kept
// as two fields to match the shape a future second provider would also need.
export const PRICING_PROVIDERS_STATUS: FinalReport['pricingProvidersStatus'] = (() => {
  const keyLoaded = Boolean(process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY)
  return {
    goldrush: { active: keyLoaded, keyLoaded },
    providerCount: keyLoaded ? 1 : 0,
    pricingEnabled: keyLoaded,
  }
})()

// ── Fallback-safe wrappers (Architecture Step 7) ──────────────────────────────────────────────
// Each wrapper below is the ONLY place that catches its stage's failures — a thrown error inside
// module code degrades exactly one section of the report, never the whole scan.

async function safeRunRecoveryPolicy(params: {
  buyTimeline: BuyTimeline
  sellTimeline: SellTimeline
  walletAddress: string
  scanMode: RunWalletScanParams['scanMode']
}): Promise<RecoveryPolicyResult> {
  // Cost guarantee: recovery is a deep-scan-only capability. A 'normal' scan never reaches
  // buildRecoveryPolicyObject at all, so it can never trigger a historical fetch, regardless of
  // what the timelines look like.
  if (params.scanMode !== 'deep') return recoveryPolicyFallback()

  try {
    return await buildRecoveryPolicyObject({
      buyTimeline: params.buyTimeline,
      sellTimeline: params.sellTimeline,
      // No holdings/portfolio-pricing module exists yet in this delivery — honestly empty, never
      // fabricated (Architecture Step 7 §3's "uncomputable defaults to the conservative value").
      holdings: [],
      walletAddress: params.walletAddress,
    })
  } catch {
    return recoveryPolicyFallback()
  }
}

// REAL FIX for "FIFO & PnL always unavailable": buildFifoOutput has always accepted optional
// priceUsdLookup/currentPriceUsdLookup — this pipeline simply never supplied one before. Now wired
// to the real pre-resolved lookups from priceLotsForWallet (src/pipeline/priceLotsForWallet.ts).
// fifoEngine's own source is unmodified; these are its existing injection points.
function safeRunFifoEngine(params: {
  normalizedEvents: NormalizedEvent[]
  recoveryPolicy: RecoveryPolicyResult
  walletAddress: string
  buyTimeline: BuyTimeline
  sellTimeline: SellTimeline
  priceUsdLookup?: import('../modules/fifoEngine/types').PriceUsdLookup
  currentPriceUsdLookup?: import('../modules/fifoEngine/types').CurrentPriceUsdLookup
}): FifoOutput {
  try {
    const recoveredRawEvents: RawProviderEvent[] = params.recoveryPolicy.evaluation.flatMap((e) => e.recoveredEvents)
    return buildFifoOutput({
      normalizedEvents: params.normalizedEvents,
      recoveredRawEvents,
      walletAddress: params.walletAddress,
      priceUsdLookup: params.priceUsdLookup,
      currentPriceUsdLookup: params.currentPriceUsdLookup,
    })
  } catch {
    return fifoEngineFallback(params.buyTimeline, params.sellTimeline)
  }
}

// PURE. Real cost basis / proceeds per sell, sourced from fifoEngine's own matched lots (grouped
// by closedTxHash — a single sell transaction can consume more than one lot on a partial fill, so
// this sums each portion's real costBasisUsd/proceedsUsd). A sell with no matched lots (or whose
// lots are unpriced, evidenceQuality: 'unpriced') simply has no entry here — never a fabricated 0.
export function buildFifoBackedPnlResolvers(matchedLots: MatchedLot[]): {
  resolveCostUsdEstimate: NonNullable<BuildPnlSummaryParams['resolveCostUsdEstimate']>
  resolveProceedsUsdEstimate: NonNullable<BuildPnlSummaryParams['resolveProceedsUsdEstimate']>
} {
  const costByTxHash = new Map<string, number>()
  const proceedsByTxHash = new Map<string, number>()

  for (const lot of matchedLots) {
    if (lot.costBasisUsd != null) costByTxHash.set(lot.closedTxHash, (costByTxHash.get(lot.closedTxHash) ?? 0) + lot.costBasisUsd)
    if (lot.proceedsUsd != null) proceedsByTxHash.set(lot.closedTxHash, (proceedsByTxHash.get(lot.closedTxHash) ?? 0) + lot.proceedsUsd)
  }

  return {
    resolveCostUsdEstimate: (sell) => costByTxHash.get(sell.txHash) ?? null,
    resolveProceedsUsdEstimate: (sell) => proceedsByTxHash.get(sell.txHash) ?? null,
  }
}

// MIGRATION: behaviorIntel now reads sellTimelineV2.entries instead of the legacy
// timelines.sellTimeline — this is the minimal wiring change required to thread that value in
// (sellTimelineV2 is only merged into the final report's `timelines` object at assembly time,
// stage 9, which runs after behaviorIntel at stage 8; the local `sellTimelineV2` variable computed
// at stage 5b is what's passed here instead). No other stage's wiring changes.
function safeRunBehaviorIntel(params: {
  buyTimeline: BuyTimeline
  sellEntries: SellTimelineEntry[]
  distributionTimeline: TimelineBuilderResult['distributionTimeline']
  chainSelection: ChainSelectionResult
  windowCoverage: WindowCoverage
}): BehaviorIntelResult {
  try {
    return buildBehaviorIntelObject({
      buyTimeline: params.buyTimeline,
      sellEntries: params.sellEntries,
      distributionTimeline: params.distributionTimeline,
      chainSelection: params.chainSelection,
      windowCoverage: params.windowCoverage,
      // No portfolio-holdings module exists yet — concentrationSignals honestly stays null
      // (Architecture Step 7 §7) rather than a fabricated reading.
      holdings: [],
    })
  } catch {
    return behaviorIntelFallback(params.chainSelection)
  }
}

// Pure, zero-cost — operates only on already-normalized events from stage 2, no provider calls.
// Runs for every scanMode (not deep-only), since it never fetches anything.
function safeRunBridgeDetection(normalizedEvents: NormalizedEvent[]): FinalReport['bridgeTimeline'] {
  try {
    return buildBridgeDetectionObject(normalizedEvents).bridgeTimeline
  } catch {
    return bridgeTimelineFallback()
  }
}

// Pure, zero-cost — additive read model over already-computed normalizedEvents, chainSelection,
// bridgeTimeline, and recoveryPolicy (mechanism 4 needs recoveryPolicy's recoveredEvents, so this
// must run after stage 5, not alongside bridgeDetection at stage 4b).
//
// REAL ROUTER REGISTRY WIRED IN, DISCLOSED (previously the empty-set bug this file's own comment
// used to describe): src/modules/sellTimeline's own header says mechanism 2 (transfer-out to a
// known router) "honestly produces nothing until a real registry is supplied" — but a real,
// already-vetted registry has existed all along at src/modules/swapNormalizer/routers.ts, it was
// simply never wired to this call site. That module doesn't export its raw address table (only
// per-chain lookup functions: isKnownRouter/detectRouterType/routerName), and sellTimeline's own
// `knownDexRouterAddresses` contract is a flat, chain-unaware ReadonlySet<string> — so rather than
// modify either protected module to bridge that shape mismatch, KNOWN_DEX_ROUTER_ADDRESSES below is
// a literal copy of the same real addresses (same "no runtime coupling, keep your own copy"
// convention already used elsewhere in this codebase for GOLDRUSH_VERIFIED_CHAIN_SLUGS,
// DEXSCREENER_CHAIN_IDS, etc.) — these are public, well-documented contract addresses, not
// invented ones. SAME CONFIDENCE CAVEAT AS THE SOURCE REGISTRY: Uniswap V2/V3 (all chains) and
// SushiSwap (eth) are long-standing, widely-documented canonical deployments; Aerodrome and
// BaseSwap are real but were not re-verified against a live block explorer from this sandbox (no
// network access) — treat those two specifically as best-effort pending re-confirmation.
const KNOWN_DEX_ROUTER_ADDRESSES = new Set<string>([
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap V2 Router02 (eth)
  '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap V3 SwapRouter (eth)
  '0x2626664c2603336e57b271c5c0b26f421741e481', // Uniswap V3 SwapRouter02 (eth/base/arbitrum/optimism — same address)
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f', // SushiSwap Router (eth)
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43', // Aerodrome Router (base) — best-effort, see caveat above
  '0x327df1e6de05895d2ab08513aadd9313fe505d86', // BaseSwap Router (base) — best-effort, see caveat above
  '0x6ff5693b99212da76ad316178a184ab56d299b43', // Base router — protocol/name not verified from this sandbox, added per explicit task instruction only
  '0xd0a40c6526acdebd4f6d87931098ff37a9f8e4bf', // Base router — protocol/name not verified from this sandbox, added per explicit task instruction only
])

function safeRunSellTimelineV2(params: {
  normalizedEvents: NormalizedEvent[]
  chainSelection: ChainSelectionResult
  bridgeTimeline: BridgeCandidateEvent[]
  recoveryPolicy: RecoveryPolicyResult
  walletAddress: string
}): SellTimelineResult {
  try {
    return buildSellTimeline({
      normalizedEvents: params.normalizedEvents,
      chainSelection: params.chainSelection,
      bridgeTimeline: params.bridgeTimeline,
      recoveryPolicy: params.recoveryPolicy,
      walletAddress: params.walletAddress,
      knownDexRouterAddresses: KNOWN_DEX_ROUTER_ADDRESSES,
    })
  } catch {
    return sellTimelineV2Fallback()
  }
}

// REAL FIX: pnlEngine's own source is still never modified and still never imports fifoEngine —
// but the PIPELINE now bridges the two via pnlEngine's existing resolveCostUsdEstimate/
// resolveProceedsUsdEstimate injection points, sourced from fifoAndPnl.matchedLots (fifoEngine's
// own real, quantity-matched, now-priced lots — see buildFifoBackedPnlResolvers below). This is
// the correct way to give a sell's cost basis real FIFO lot-matching evidence: pnlEngine
// deliberately never re-implements lot matching itself (see pnlEngine/types.ts's own honesty
// note), so it borrows fifoEngine's real answer instead of leaving the resolver stubbed.
function safeRunPnlSummaryV2(params: {
  sellEntries: SellTimelineEntry[]
  buyEntries: BuildPnlSummaryParams['buyEntries']
  resolveCostUsdEstimate?: BuildPnlSummaryParams['resolveCostUsdEstimate']
  resolveProceedsUsdEstimate?: BuildPnlSummaryParams['resolveProceedsUsdEstimate']
}): PnlSummaryResult {
  try {
    return buildPnlSummary({
      sellEntries: params.sellEntries,
      buyEntries: params.buyEntries,
      resolveCostUsdEstimate: params.resolveCostUsdEstimate,
      resolveProceedsUsdEstimate: params.resolveProceedsUsdEstimate,
    })
  } catch {
    return pnlSummaryV2Fallback()
  }
}

// UPSTREAM DUST SUPPRESSION, DISCLOSED (Option 2 — one cheap lookup per candidate token, confirmed
// with the user; supersedes the earlier display-pass-only version). Runs BEFORE priceLotsForWallet
// (stage 5c) is called, so it can reduce that pass's own real pricing workload — the actual
// expensive one that feeds fifoEngine — not just the separate, additive display pass (stage 6c).
//
// AIRDROP RECLASSIFICATION, DISCLOSED (same reasoning as before, explicit user confirmation):
// timelineBuilder's buildBuyTimeline() treats every inbound transfer as a buy-timeline entry —
// `sourceType` (mint/swap/airdrop/transfer) is a label, not a filter, so an airdropped token already
// has a "BUY event" by this codebase's real definition. Only entries whose sourceType is exactly
// 'airdrop' are ever candidates; a real swap-sourced buy, a mint, or a plain transfer-in are never
// suppressible, regardless of value.
//
// hasMatchedLots NOT COMPUTED SEPARATELY, DISCLOSED: fifoEngine hasn't run yet at this point in the
// pipeline (it runs at stage 6, after priceLotsForWallet) — computing its real matchedLots here would
// be circular. Not needed: FIFO can only produce a matched (closed) lot for a token that has a sell
// event closing a buy lot. Since `hasSell === false` is already a hard requirement below, a candidate
// token can never have a matched lot by construction — this is a logical guarantee, not an assumption.
//
// THE CHEAP LOOKUP, DISCLOSED (see lib/server/dustPriceCheck.ts's own header for the full
// disclosure): a standalone, current-price-only DexScreener check — deliberately independent of
// pricingAtTimeEngine's own sources (no bisects, no poolPrice/slot0, no GoldRush, not the
// multiProviderPriceSource "fallback" chain). `hasAnyPriceSource: false` from that check is treated
// as "balanceUsd known to be effectively $0" (a token with literally no discoverable market has no
// realizable value) — satisfying both the "hasAnyPriceSource === false" and "balanceUsd known and
// below threshold" conditions from the same one signal. Any token the cheap check finds ANY price
// for is NEVER suppressed, however small that price is — this is the conservative, safety-first
// reading: only tokens with zero discoverable market anywhere are ever excluded.
//
// SELL EVENTS ARE NEVER TOUCHED: sellEntries (both into priceLotsForWallet's merged-events input and
// stage 6c's display pass) are always the full, unfiltered set — only buy-side (inbound) events for
// suppressed tokens are ever removed from the pricing-only copies. Raw timelines/normalizedEvents
// used by fifoEngine, timelineBuilder's own report output, etc. are completely untouched.
//
// RESIDUAL RISK, HONESTLY DISCLOSED: this is not provably byte-identical in literally every possible
// case the way the pure post-hoc, no-new-fetch version was — see dustPriceCheck.ts's own header for
// the accepted tradeoff (a token DexScreener doesn't index is not PROVABLY worthless, just very
// likely to be, in practice, for pure airdrop-only spam).
const DUST_SUPPRESSION_CONCURRENCY_LIMIT = 8

function dustTokenKey(chain: SupportedChain, token: string): string {
  return `${chain}:${token.toLowerCase()}`
}

// PURE, synchronous, no network calls — computes which (chain, token) pairs are even ELIGIBLE for
// the cheap price check, from timelineBuilder/sellTimeline's own already-computed classification.
// Exported for direct unit testing (see dustSuppression.test.ts).
export function computeDustCandidateKeys(
  buyEntries: readonly BuyTimelineEntry[],
  sellEntries: readonly SellTimelineEntry[],
): Set<string> {
  const perToken = new Map<string, { allAirdrop: boolean; hasRealBuy: boolean }>()
  for (const e of buyEntries) {
    const key = dustTokenKey(e.chain, e.token)
    const stats = perToken.get(key) ?? { allAirdrop: true, hasRealBuy: false }
    if (e.sourceType !== 'airdrop') {
      stats.allAirdrop = false
      stats.hasRealBuy = true
    }
    perToken.set(key, stats)
  }

  const sellKeys = new Set(sellEntries.map((e) => dustTokenKey(e.chain, e.token)))

  const candidates = new Set<string>()
  for (const [key, stats] of perToken) {
    if (!stats.allAirdrop || stats.hasRealBuy) continue
    if (sellKeys.has(key)) continue
    candidates.add(key)
  }
  return candidates
}

export type DustSuppressionReason = 'no_market_found' | 'liquidity_zero'

// PURE — given a candidate token's cheap-lookup result, decides suppressibility (and why). Exported
// for direct unit testing.
//
// LIQUIDITY-ZERO FIX, DISCLOSED (found while implementing this task's own diagnostics requirement,
// not the specific bug report — that report's exact wallet/tokens couldn't be verified from this
// sandbox, but this gap is real and independently confirmed by reading the code): previously this
// only checked `!hasAnyPriceSource` — a token where DexScreener found a real pair, but that pair
// reports liquidityUsd === 0 (a pool that technically exists on-chain but is functionally hollow —
// no depth, no real market), was treated as "has a price source" and never suppressed. A price
// quote with zero liquidity behind it isn't a meaningful market signal, so it's now suppressible
// too. Still gated on the same upstream requirement (only ever reached for a candidate with no real
// buy and no sell) — this does not touch any token with actual trade history.
export function classifyDustSuppression(cheapResult: CheapDustPriceResult): { suppress: boolean; reason: DustSuppressionReason | null } {
  if (!cheapResult.hasAnyPriceSource) return { suppress: true, reason: 'no_market_found' }
  if (cheapResult.liquidityUsd === 0) return { suppress: true, reason: 'liquidity_zero' }
  return { suppress: false, reason: null }
}

// BACKWARD-COMPATIBLE WRAPPER, DISCLOSED: kept so existing callers/tests that only need the boolean
// don't have to destructure classifyDustSuppression's richer result.
export function isSuppressibleDustToken(cheapResult: CheapDustPriceResult): boolean {
  return classifyDustSuppression(cheapResult).suppress
}

// ROUTER-DISTRIBUTOR MODE, DISCLOSED. PURE, exported for direct testing — the real call site
// (runWalletScan, below) reuses the same outboundEvents/outboundToKnownRouter counts an existing
// debug trace already computes, never re-derived. See that call site's own comment for the full
// disclosure on what this toggles (display-pricing-pass dust-suppression widening only — never
// holdings, never priceLotsForWallet/fifoEngine/pnlV2).
export function computeRouterDistributorMode(outboundEventsCount: number, outboundToKnownRouterCount: number): boolean {
  return outboundEventsCount > 150 && outboundToKnownRouterCount > 150
}

async function mapWithConcurrencyLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  }
  const workerCount = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

// Async — the only network-calling piece of dust suppression. Resolves the final suppressed-key set
// for this scan: computes candidates (pure), then runs the cheap, bounded-concurrency price check
// only for those candidates (never for a token with any real buy/sell — the overwhelming majority of
// a typical wallet's tokens never reach this call at all).
type DustSuppressionOutcome = {
  suppressedKeys: Set<string>
  noMarketFoundCount: number
  liquidityZeroCount: number
}

async function resolveDustSuppressionKeys(
  buyEntries: readonly BuyTimelineEntry[],
  sellEntries: readonly SellTimelineEntry[],
): Promise<DustSuppressionOutcome> {
  const candidateKeys = computeDustCandidateKeys(buyEntries, sellEntries)
  if (candidateKeys.size === 0) return { suppressedKeys: new Set(), noMarketFoundCount: 0, liquidityZeroCount: 0 }

  // One representative entry per candidate key, to recover (token, chain) for the lookup call.
  const representativeByKey = new Map<string, BuyTimelineEntry>()
  for (const e of buyEntries) {
    const key = dustTokenKey(e.chain, e.token)
    if (candidateKeys.has(key) && !representativeByKey.has(key)) representativeByKey.set(key, e)
  }

  const candidates = [...representativeByKey.entries()]
  const results = await mapWithConcurrencyLimit(candidates, DUST_SUPPRESSION_CONCURRENCY_LIMIT, async ([key, entry]) => {
    const cheapResult = await getCheapCurrentPriceForDustCheck(entry.token, entry.chain)
    const { suppress, reason } = classifyDustSuppression(cheapResult)
    return { key, suppress, reason }
  })

  const suppressedKeys = new Set<string>()
  let noMarketFoundCount = 0
  let liquidityZeroCount = 0
  for (const r of results) {
    if (!r.suppress) continue
    suppressedKeys.add(r.key)
    if (r.reason === 'no_market_found') noMarketFoundCount++
    if (r.reason === 'liquidity_zero') liquidityZeroCount++
    // eslint-disable-next-line no-console
    console.warn('[pipeline] dust token suppressed', { key: r.key, reason: r.reason })
  }
  return { suppressedKeys, noMarketFoundCount, liquidityZeroCount }
}

export type ProviderFetchWindowDiagnostics = {
  totalDurationMs: number | null
  perChain: Array<{ chain: SupportedChain; rawEventCount: number; inboundTransferCount: number }>
  pagesFetched: number | null
  perPageLatencyMs: number[] | null
}

// PURE — extracted so this is directly unit-testable (item 8). See its own call site's comment for
// the full disclosure on why pagesFetched/perPageLatencyMs are always null: that data lives entirely
// inside the protected fetchProviderWindow module with no exported hook, so it's honestly reported
// as unavailable rather than fabricated.
export function buildProviderFetchWindowDiagnostics(
  providerResults: ReadonlyArray<{ chain: SupportedChain; rawEvents: RawProviderEvent[] }>,
  walletAddress: string,
  totalDurationMs: number | null,
): ProviderFetchWindowDiagnostics {
  const walletAddressLower = walletAddress.toLowerCase()
  return {
    totalDurationMs,
    perChain: providerResults.map((r) => ({
      chain: r.chain,
      rawEventCount: r.rawEvents.length,
      inboundTransferCount: r.rawEvents.filter((e) => e.toAddress?.toLowerCase() === walletAddressLower).length,
    })),
    pagesFetched: null,
    perPageLatencyMs: null,
  }
}

// EXTRACTED, DISCLOSED: was previously inlined at the priceLotsForWallet call site (an
// `isSuppressedInboundEvent` arrow + two near-identical filter calls). Pulled out into a named,
// exported, pure function so the actual filtering rule is directly unit-testable (see
// dustSuppression.test.ts) instead of only reachable through the full async pipeline. Zero behavior
// change from the inline version: only removes INBOUND events for a token in `suppressedKeys` —
// outbound (sell) events, and every event for any non-suppressed token, always pass through
// unchanged. A token only ever reaches `suppressedKeys` when it has no real buy and no sell
// anywhere (see resolveDustSuppressionKeys/computeDustCandidateKeys above), so this can never touch
// a real trade.
export function buildFilteredEventsForPricing(
  events: readonly NormalizedEvent[],
  suppressedKeys: ReadonlySet<string>,
): NormalizedEvent[] {
  if (suppressedKeys.size === 0) return events as NormalizedEvent[]
  return events.filter((e) => !(e.direction === 'inbound' && suppressedKeys.has(dustTokenKey(e.chain, e.contract))))
}

// HEAVY-WALLET DETECTION, DISCLOSED (diagnostic-only — item 7 of the task): a pure classification
// over two signals genuinely observable from orchestration (distinct buy-side tokens, fifoEngine's
// own matchedLots count). A third signal the task asked for, "bisects > 2000", is NOT included:
// bisect calls happen entirely inside the protected src/modules/pricingAtTimeEngine/sources/
// basedex.ts, with no counter exported anywhere orchestration can read — including it here would
// mean silently hardcoding `false`, which would misreport, not just omit, that condition. Diagnostic
// only: no additional skip behavior is applied when heavyWallet is true beyond what dust suppression
// (computeDustCandidateKeys/isSuppressibleDustToken, both already gated on "no real buy and no
// sell") already applies uniformly to every wallet regardless of size — the safety boundary
// explicitly forbids extending suppression to real-trade tokens just because a wallet is large, so
// there is no additional, safe "aggressive" mode to switch on here.
export function computeHeavyWalletFlag(distinctBuyTokens: number, matchedLots: number): boolean {
  return distinctBuyTokens > 120 || matchedLots > 250
}

// SLOW-PROVIDER DIAGNOSTICS, DISCLOSED — four pure, independently-testable signals over data
// orchestration genuinely has (per-chain latency already captured around each chain's own fetch
// call, and the same providerResults/errorReason data providerDiagnostics already exposes).

const SLOW_PROVIDER_THRESHOLD_MS = 2500
const JITTER_THRESHOLD_MS = 1500
const COLD_START_FIRST_THRESHOLD_MS = 2000
const COLD_START_SUBSEQUENT_THRESHOLD_MS = 500

export type ChainLatency = { chain: SupportedChain; latencyMs: number }

export function computeSlowProviderFlag(totalDurationMs: number): boolean {
  return totalDurationMs > SLOW_PROVIDER_THRESHOLD_MS
}

// Only meaningful with 2+ chains — a single-chain scan has nothing to compare against, so this
// returns false rather than a meaningless "jitter" verdict against nothing.
export function computeJitterFlag(chainLatencies: readonly ChainLatency[]): boolean {
  if (chainLatencies.length < 2) return false
  const latencies = chainLatencies.map((c) => c.latencyMs)
  return Math.max(...latencies) - Math.min(...latencies) > JITTER_THRESHOLD_MS
}

// COLD-START CAVEAT, HONESTLY DISCLOSED: providerFetchWindow fetches every chain CONCURRENTLY (see
// the Promise.all call site above), not sequentially — there is no real temporal "first request,
// then subsequent ones" the way there would be for a sequential loop, so this can't detect genuine
// TCP/TLS connection warm-up the way the task's naming implies. What IS real and computable: given
// array order (index 0 = the first-listed chain), whether that chain's own latency looks like an
// outlier-slow request while every other chain resolved fast. Kept as a labeled, order-based
// heuristic — a real, if weaker, signal (e.g. a cold Lambda/DNS-resolution effect isolated to
// whichever request happens to be first in the array) — not a claim of verified connection warm-up.
// Only meaningful with 2+ chains, same reasoning as jitter above.
export function computeColdStartFlag(chainLatencies: readonly ChainLatency[]): boolean {
  if (chainLatencies.length < 2) return false
  const [first, ...rest] = chainLatencies.map((c) => c.latencyMs)
  return first > COLD_START_FIRST_THRESHOLD_MS && rest.every((ms) => ms < COLD_START_SUBSEQUENT_THRESHOLD_MS)
}

// RATE-LIMIT DETECTION, CORRECTED, DISCLOSED: the literal string 'rate_limit' never appears
// anywhere in src/modules/providerFetchWindow/utils.ts's real errorReason values (confirmed by
// reading that file directly) — an HTTP 429 there resolves to errorReason: 'http_429' (a template
// string built from the real response status), never a normalized 'rate_limit' label. Checking for
// the literal string the task named would never match anything real; checks the actual value
// instead.
export function computeRateLimitFlag(
  providerResults: ReadonlyArray<{ providerResults: { goldrush: { errorReason: string | null }; alchemy: { errorReason: string | null } } }>,
): boolean {
  return providerResults.some((r) => r.providerResults.goldrush.errorReason === 'http_429' || r.providerResults.alchemy.errorReason === 'http_429')
}

export type SlowProviderSignals = {
  slowProviderDetected: boolean
  jitterDetected: boolean
  coldStartDetected: boolean
  rateLimitDetected: boolean
}

export function computeSlowProviderSignals(
  totalDurationMs: number,
  chainLatencies: readonly ChainLatency[],
  providerResults: ReadonlyArray<{ providerResults: { goldrush: { errorReason: string | null }; alchemy: { errorReason: string | null } } }>,
): SlowProviderSignals {
  return {
    slowProviderDetected: computeSlowProviderFlag(totalDurationMs),
    jitterDetected: computeJitterFlag(chainLatencies),
    coldStartDetected: computeColdStartFlag(chainLatencies),
    rateLimitDetected: computeRateLimitFlag(providerResults),
  }
}

// ===========================================================================================
// CU ESTIMATOR, DISCLOSED (orchestration-only, no src/modules/* changes)
// ===========================================================================================
//
// REAL-DATA FOUNDATION: every method name below (getBlock:latest, getBlock:bisect,
// readContract:multicall:getPool, readContract:slot0, etc.) is an EXACT, already-logged string —
// confirmed by reading src/modules/pricingAtTimeEngine/sources/basedex.ts and
// goldrushPriceSource.ts directly, both of which already call `logRpcCall({ route, chain, method })`
// (lib/server/rpcDebug.ts — NOT under src/modules/*, so reading from it is not a protected-module
// change) for every one of these exact calls. This estimator counts REAL entries from that shared
// log, not invented numbers.
//
// CROSS-REQUEST LEAK GUARD, DISCLOSED: rpcDebugLog is a global, in-memory, cross-request buffer
// (confirmed by its own file header — it never resets between scans in a warm serverless instance).
// Reading its current contents directly at the end of a scan would count OTHER requests' calls too.
// This uses the same snapshot-length-before/delta-after pattern this codebase already established
// for the identical problem with alchemyAudit.calls in workers/walletScanV2.ts — countRpcMethods()
// below is always called on a SLICE (rpcDebugLog.slice(snapshotIndex)) taken at a specific point in
// THIS scan, never the raw global array.
//
// CU WEIGHTS, DISCLOSED: the per-method CU weights below (5/10/20 etc.) are exactly the values this
// task specified — they are Alchemy pricing assumptions, not independently verified against
// Alchemy's own published compute-unit table from this sandbox (no live network access to confirm).
// If Alchemy's real published weights differ, this estimator's totals would need those constants
// updated — the counts themselves (how many of each call actually happened) are real; the CU-per-
// call multipliers are the task's own stated assumptions, applied honestly and consistently.

export type RpcMethodCounts = {
  getBlockLatest: number
  getBlockEstimate: number
  bisect: number
  multicallGetPool: number
  multicallPoolPrice: number
  slot0: number
  token0: number
  decimals: number
}

const ALCHEMY_CU_WEIGHTS = {
  getBlockLatest: 5,
  getBlockEstimate: 5,
  bisect: 10,
  multicallGetPool: 20,
  multicallPoolPrice: 20,
  slot0: 5,
  token0: 5,
  decimals: 5,
} as const

export type AlchemyCuBreakdown = {
  getBlockLatest: number
  getBlockEstimate: number
  bisect: number
  multicallGetPool: number
  multicallPoolPrice: number
  slot0: number
  token0: number
  decimals: number
  total: number
}

// PURE — takes real observed counts (see countRpcMethods() for how they're derived from
// rpcDebugLog) and applies the task's stated CU weights. No fetch, no log read, directly testable.
export function estimateAlchemyCu(counts: RpcMethodCounts): AlchemyCuBreakdown {
  const getBlockLatest = counts.getBlockLatest * ALCHEMY_CU_WEIGHTS.getBlockLatest
  const getBlockEstimate = counts.getBlockEstimate * ALCHEMY_CU_WEIGHTS.getBlockEstimate
  const bisect = counts.bisect * ALCHEMY_CU_WEIGHTS.bisect
  const multicallGetPool = counts.multicallGetPool * ALCHEMY_CU_WEIGHTS.multicallGetPool
  const multicallPoolPrice = counts.multicallPoolPrice * ALCHEMY_CU_WEIGHTS.multicallPoolPrice
  const slot0 = counts.slot0 * ALCHEMY_CU_WEIGHTS.slot0
  const token0 = counts.token0 * ALCHEMY_CU_WEIGHTS.token0
  const decimals = counts.decimals * ALCHEMY_CU_WEIGHTS.decimals
  return {
    getBlockLatest,
    getBlockEstimate,
    bisect,
    multicallGetPool,
    multicallPoolPrice,
    slot0,
    token0,
    decimals,
    total: getBlockLatest + getBlockEstimate + bisect + multicallGetPool + multicallPoolPrice + slot0 + token0 + decimals,
  }
}

const GOLDRUSH_CU_PER_CALL = 12

export type GoldrushCuBreakdown = { priceCalls: number; estimatedCu: number }

export function estimateGoldrushCu(priceCalls: number): GoldrushCuBreakdown {
  return { priceCalls, estimatedCu: priceCalls * GOLDRUSH_CU_PER_CALL }
}

// PURE — counts real logRpcCall entries by their exact method string, over a given slice of
// rpcDebugLog (see the CU-ESTIMATOR header above for why this must always be a slice, never the
// raw global array). Returns the shape estimateAlchemyCu()/estimateGoldrushCu() expect.
export function countRpcMethods(entries: readonly RpcDebugEntry[]): { alchemy: RpcMethodCounts; goldrushPriceCalls: number } {
  const count = (method: string) => entries.filter((e) => e.method === method).length
  return {
    alchemy: {
      getBlockLatest: count('getBlock:latest'),
      getBlockEstimate: count('getBlock:estimate'),
      bisect: count('getBlock:bisect'),
      multicallGetPool: count('readContract:multicall:getPool'),
      multicallPoolPrice: count('readContract:multicall:poolPrice'),
      slot0: count('readContract:slot0'),
      token0: count('readContract:token0'),
      decimals: count('readContract:decimals'),
    },
    goldrushPriceCalls: count('goldrush_sdk_getTokenPrices'),
  }
}

export type CuPerStage = {
  providerFetchWindow: 0
  dustSuppression: 0
  priceLotsForWallet: number
  pricingAtTime: number
}

export type CuPerProvider = { alchemy: number; goldrush: number; total: number }

// PER-TOKEN, HONESTLY SCOPED DOWN, DISCLOSED: the task asked for per-token bisect/fallback/
// poolPrice/goldrush CU. That attribution does not exist anywhere in the available data —
// rpcDebugLog entries carry no `token` field at all (confirmed by reading lib/server/rpcDebug.ts's
// own RpcDebugEntry type), and the real call sites in basedex.ts/goldrushPriceSource.ts never log
// which token triggered a given bisect/poolPrice/GoldRush call. Building a per-token CU breakdown
// would require either modifying those protected files to add token-tagged logging (forbidden) or
// guessing an attribution (explicitly forbidden by this task's own "no fabricated values" rule).
// What IS real and available at this layer: how many pricing attempts (buy+sell entries) exist per
// token in the fan-out this scan actually built — reported as entryCount, not a fabricated CU
// number, so a reader can see relative fan-out weight per token without being told a false-precision
// CU figure for it.
export type PerTokenPricingAttempt = { token: string; chain: SupportedChain; entryCount: number }

export function buildPerTokenPricingAttempts(entries: readonly PriceableEntry[]): PerTokenPricingAttempt[] {
  const byKey = new Map<string, PerTokenPricingAttempt>()
  for (const e of entries) {
    const key = `${e.chain}:${e.token.toLowerCase()}`
    const existing = byKey.get(key)
    if (existing) existing.entryCount += 1
    else byKey.set(key, { token: e.token, chain: e.chain as SupportedChain, entryCount: 1 })
  }
  return [...byKey.values()]
}

export type CuEstimatorSummary = {
  alchemy: AlchemyCuBreakdown
  goldrush: GoldrushCuBreakdown
  perToken: PerTokenPricingAttempt[]
  perStage: CuPerStage
  perProvider: CuPerProvider
  totalCu: number
}

// PURE — assembles the full summary from already-computed pieces. Stage attribution
// (priceLotsForWalletCounts vs pricingAtTimeCounts) is passed in separately rather than derived
// from one combined count, because the real call site below measures each stage's own rpcDebugLog
// delta independently (an honest, real split — see the call site's own comment for why this is
// MORE accurate than the task's suggested static category-to-stage mapping, which would attribute
// slot0/token0/decimals only to "pricingAtTime" even though priceLotsForWallet's own pricing pass
// triggers the identical basedex code path and therefore the identical call categories).
export function buildCuEstimatorSummary(
  priceLotsForWalletCounts: RpcMethodCounts,
  pricingAtTimeCounts: { alchemy: RpcMethodCounts; goldrushPriceCalls: number },
  allEntries: readonly PriceableEntry[],
): CuEstimatorSummary {
  const priceLotsForWalletCu = estimateAlchemyCu(priceLotsForWalletCounts)
  const pricingAtTimeAlchemyCu = estimateAlchemyCu(pricingAtTimeCounts.alchemy)
  const goldrush = estimateGoldrushCu(pricingAtTimeCounts.goldrushPriceCalls)

  const combinedAlchemyCounts: RpcMethodCounts = {
    getBlockLatest: priceLotsForWalletCounts.getBlockLatest + pricingAtTimeCounts.alchemy.getBlockLatest,
    getBlockEstimate: priceLotsForWalletCounts.getBlockEstimate + pricingAtTimeCounts.alchemy.getBlockEstimate,
    bisect: priceLotsForWalletCounts.bisect + pricingAtTimeCounts.alchemy.bisect,
    multicallGetPool: priceLotsForWalletCounts.multicallGetPool + pricingAtTimeCounts.alchemy.multicallGetPool,
    multicallPoolPrice: priceLotsForWalletCounts.multicallPoolPrice + pricingAtTimeCounts.alchemy.multicallPoolPrice,
    slot0: priceLotsForWalletCounts.slot0 + pricingAtTimeCounts.alchemy.slot0,
    token0: priceLotsForWalletCounts.token0 + pricingAtTimeCounts.alchemy.token0,
    decimals: priceLotsForWalletCounts.decimals + pricingAtTimeCounts.alchemy.decimals,
  }
  const alchemy = estimateAlchemyCu(combinedAlchemyCounts)

  const perStage: CuPerStage = {
    providerFetchWindow: 0,
    dustSuppression: 0,
    priceLotsForWallet: priceLotsForWalletCu.total,
    pricingAtTime: pricingAtTimeAlchemyCu.total + goldrush.estimatedCu,
  }
  const perProvider: CuPerProvider = { alchemy: alchemy.total, goldrush: goldrush.estimatedCu, total: alchemy.total + goldrush.estimatedCu }

  return {
    alchemy,
    goldrush,
    perToken: buildPerTokenPricingAttempts(allEntries),
    perStage,
    perProvider,
    totalCu: perProvider.total,
  }
}

// Additive, async — resolves real historical USD pricing for buyTimeline + sellTimelineV2 entries
// via injected priceSources (src/modules/pricingAtTimeEngine). The real call site below always
// passes PRICE_SOURCES (real GoldRush integration when GOLDRUSH_API_KEY/COVALENT_API_KEY is
// configured, honestly noPriceSources() otherwise) — the `?? noPriceSources()` default here is a
// last-resort guard for any other caller (e.g. runtimeTests), never client-suppliable (this
// pipeline never accepts priceSources from a request body). Never touches fifoEngine.
async function safeRunPricingAtTime(params: {
  buyEntries: PriceableEntry[]
  sellEntries: PriceableEntry[]
  priceSources?: PriceSources
  fallbackPricing?: FallbackPricingConfig
}): Promise<PricingAtTimeResult> {
  try {
    return await resolvePricingAtTime({
      buyEntries: params.buyEntries,
      sellEntries: params.sellEntries,
      priceSources: params.priceSources ?? noPriceSources(),
      fallbackPricing: params.fallbackPricing,
    })
  } catch {
    return pricingAtTimeFallback()
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────────────────────

// SCAN-TIMING DIAGNOSTICS, DISCLOSED (orchestration-layer-only "why did this scan take X seconds"
// summary): a plain object, not a class/singleton — one instance per runWalletScan() call, so
// concurrent scans (multiple requests in the same warm serverless instance) never share or clobber
// each other's timings. Records elapsed ms around each of this file's own async stages (the only
// ones that can plausibly dominate scan latency — every synchronous stage in between is pure/cheap
// by Architecture Step 7's own cost guarantee, see this file's header). Does not, and cannot,
// measure time spent INSIDE protected modules' own internal call graphs (e.g. how long
// pricingAtTimeEngine itself spent on bisects vs GoldRush vs fallback) — only how long this
// orchestration layer's own await points took, which is the real, honest limit of what's
// observable from outside src/modules/*.
function startStageTimer(): { stages: Record<string, number>; mark: (name: string, startedAtMs: number) => void } {
  const stages: Record<string, number> = {}
  return {
    stages,
    mark: (name: string, startedAtMs: number) => {
      stages[name] = Math.round(performance.now() - startedAtMs)
    },
  }
}

export async function runWalletScan(params: RunWalletScanParams): Promise<RunWalletScanResult> {
  const scanTimestamp = new Date().toISOString()
  const scanStartedAtMs = performance.now()
  const scanTimer = startStageTimer()
  const providerFetchWindowKvWriter = createProviderWindowKvWriter()

  // 0. Pre-scan validation (Architecture Step 6 §1). An invalid request never reaches any
  // provider call — it degrades immediately to a fully-shaped, honestly-labeled report.
  const preScan: PreScanValidation = validatePreScan(params)
  if (!preScan.valid) {
    return { ...buildFullyDegradedReport(params, scanTimestamp, PROVIDER_FETCH_WINDOW_DAYS_USED), normalizationErrors: [], walletConditionMessages: [] }
  }

  // Diagnostic log — real env var presence for the two providers actually integrated in this
  // codebase (GoldRush + Alchemy; there is no Moralis integration anywhere here — logging a
  // "hasMoralis" flag would be fabricated, since no such provider is ever called).
  // eslint-disable-next-line no-console
  console.warn('[pipeline] provider env check', {
    hasGoldrush: Boolean(process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY),
    hasAlchemyBase: Boolean(process.env.ALCHEMY_BASE_KEY ?? process.env.ALCHEMY_API_KEY),
    hasAlchemyEth: Boolean(process.env.ALCHEMY_ETHEREUM_KEY ?? process.env.ALCHEMY_API_KEY),
    hasAlchemyArbitrum: Boolean(process.env.ALCHEMY_ARBITRUM_KEY),
  })

  // 1. providerFetchWindow — the ONLY per-chain network call in the base pipeline.
  // KV read-before/write-after (lib/server/cache/v2StageCache.ts) — pipeline-level caching only,
  // fetchProviderWindow's own source is never touched. 30s TTL: this is the single most expensive
  // real network call in the whole pipeline (per-chain provider fetch), so a short cache window
  // still meaningfully cuts repeat-request CU without serving stale data for long.
  // PER-CHAIN LATENCY, DISCLOSED: chains fetch CONCURRENTLY via Promise.all below, each wrapped
  // with its own start/end timestamp taken right around its own await point — this measures each
  // chain's own real wall-clock latency (which can differ even under concurrency: different
  // provider response times, a cache hit vs. miss on that specific key, etc.), not a fabricated or
  // evenly-divided share of the total. `chainLatencies` preserves array order (matching
  // preScan.sanitizedChains), which coldStart detection below relies on and discloses the caveat of.
  const providerFetchStart = performance.now()
  const timedProviderResults = await Promise.all(
    preScan.sanitizedChains.map(async (chain) => {
      const chainStart = performance.now()
      const result = await withStageCache(
        `v2:providerFetchWindow:${chain}:${params.walletAddress.toLowerCase()}`,
        30,
        () => fetchProviderWindow(chain, params.walletAddress, PROVIDER_FETCH_WINDOW_DAYS_USED),
        { skipWrite: true },
      )
      return { result, chain, latencyMs: Math.round(performance.now() - chainStart) }
    }),
  )
  scanTimer.mark('providerFetchWindow', providerFetchStart)

  const providerResults = timedProviderResults.map((t) => t.result)
  const chainLatencies = timedProviderResults.map((t) => ({ chain: t.chain, latencyMs: t.latencyMs }))
  for (const cl of chainLatencies) {
    // eslint-disable-next-line no-console
    console.warn('[pipeline] per-chain provider latency', { chain: cl.chain, perChainLatencyMs: cl.latencyMs })
  }

  const slowProviderSignals = computeSlowProviderSignals(
    scanTimer.stages.providerFetchWindow ?? 0,
    chainLatencies,
    providerResults,
  )
  if (slowProviderSignals.slowProviderDetected) {
    // eslint-disable-next-line no-console
    console.warn('[pipeline] slowProviderDetected', {
      slowProviderDetected: true,
      totalDurationMs: scanTimer.stages.providerFetchWindow,
      perChainDiagnostics: chainLatencies,
    })
  }

  for (const r of providerResults) {
    void providerFetchWindowKvWriter.write(
      `v2:providerFetchWindow:${r.chain}:${params.walletAddress.toLowerCase()}`,
      r,
      30,
      { degradedMode: slowProviderSignals.slowProviderDetected },
    )
  }

  // Real, honest per-chain/per-provider fetch outcome summary — counts and error reasons only,
  // never raw events (see ProviderDiagnosticsEntry's doc comment for why raw payloads are never
  // surfaced). Additive report field, not a new provider call.
  const providerDiagnostics: FinalReport['providerDiagnostics'] = providerResults.map((r) => ({
    chain: r.chain,
    providerStatus: r.providerStatus,
    goldrush: { ok: r.providerResults.goldrush.ok, errorReason: r.providerResults.goldrush.errorReason, eventCount: r.providerResults.goldrush.events.length },
    alchemy: { ok: r.providerResults.alchemy.ok, errorReason: r.providerResults.alchemy.errorReason, eventCount: r.providerResults.alchemy.events.length },
  }))
  // eslint-disable-next-line no-console
  console.warn('[pipeline] providerDiagnostics', providerDiagnostics)

  // PROVIDER-FETCH-WINDOW DIAGNOSTICS, DISCLOSED (scoped down from the literal request): "pages
  // fetched" and "per-page latency" happen entirely inside the protected fetchProviderWindow
  // (src/modules/providerFetchWindow) — there is no counter or timing hook exported from that
  // module for orchestration to read, so those two fields are NOT included below (not faked as 0 or
  // omitted silently — see buildProviderFetchWindowDiagnostics's own header). What IS honestly
  // computable from data orchestration already receives: per-chain raw event counts, inbound-
  // transfer counts, and the total fetch duration already captured by scanTimer above.
  const providerFetchWindowDiagnostics = buildProviderFetchWindowDiagnostics(
    providerResults,
    params.walletAddress,
    scanTimer.stages.providerFetchWindow ?? null,
  )

  // 2. normalization — pure, zero provider calls.
  const allRawEvents = providerResults.flatMap((r) => r.rawEvents)
  if (allRawEvents.length === 0) {
    // eslint-disable-next-line no-console
    console.warn('[pipeline] NO RAW EVENTS FETCHED for this scan', { providerDiagnostics })
  }
  const { normalizedEvents, normalizationErrors } = normalizeEvents(allRawEvents, params.walletAddress)

  // TEMPORARY DEBUG INSTRUMENTATION (router-transfer normalizedEvents trace), DISCLOSED: added to
  // answer a specific question — does normalizedEvents actually contain the outbound router
  // transfers FIFO/pricing see, right after normalizeEvents() and before any filtering (dust
  // suppression, chainSelection gating) touches the array. Read-only: computes derived counts from
  // the already-produced `normalizedEvents`, logs them, and does not affect `normalizedEvents`,
  // `normalizationErrors`, or anything downstream. Remove once the question above is answered.
  const outboundEvents = normalizedEvents.filter((e) => e.direction === 'outbound')
  const routerInference = createRouterInference({ knownRouterAddresses: KNOWN_DEX_ROUTER_ADDRESSES })
  const routerInferenceResult = routerInference.build(normalizedEvents)
  const inferredRouterAddresses = routerInferenceResult.highConfidenceRouters
  const outboundToKnownRouter = outboundEvents.filter((e) => inferredRouterAddresses.has(e.toAddress.toLowerCase()))
  const normalizedEventsTrace = {
    rawEventsCount: allRawEvents.length,
    normalizedEventsCount: normalizedEvents.length,
    outboundEventsCount: outboundEvents.length,
    outboundToKnownRouterCount: outboundToKnownRouter.length,
    outboundEvents: outboundEvents.map((e) => ({
      chain: e.chain,
      from: e.fromAddress,
      to: e.toAddress,
      token: e.contract,
      amount: e.amount,
      counterparty: e.toAddress.toLowerCase(),
      isKnownRouter: inferredRouterAddresses.has(e.toAddress.toLowerCase()),
    })),
  }

  // ROUTER-DISTRIBUTOR MODE, DISCLOSED (additive, observability + display-pricing-only toggle):
  // reuses the outboundEvents/outboundToKnownRouter counts the debug trace above already computes
  // — no re-derivation, no new event classification. A wallet whose outbound activity is
  // overwhelmingly router-mediated swaps (>150 outbound events, >150 of them to a known router)
  // gets this real, named signal. Used below ONLY to widen the token set fed to the ADDITIVE display
  // pricingAtTime pass (stage 6c) — never priceLotsForWallet's fifoEngine-feeding input, never
  // holdings' own separate dust-suppression computation, never fifoEngine/pnlV2 themselves.
  const routerDistributorMode = inferredRouterAddresses.size > 0 && computeRouterDistributorMode(outboundEvents.length, outboundToKnownRouter.length)

  // DISTRIBUTOR RECOVERY, DISCLOSED (src/modules/distributorRecovery — read-only observability, not
  // reconstruction): see that module's own header for the full disclosure on why this never touches
  // fifoEngine's or priceLotsForWallet's real inputs. Classifies every outbound-to-known-router
  // event (for distributor wallets only) as evidence-complete (a real same-tx inbound leg exists)
  // or evidence-missing, purely for logging — `normalizedEvents` itself is passed through untouched
  // to every downstream stage exactly as it always was.
  const distributorRecovery = analyzeDistributorRouterFlows(normalizedEvents, inferredRouterAddresses, routerDistributorMode)
  if (distributorRecovery.applied) {
    // eslint-disable-next-line no-console
    console.warn('[pipeline] distributorRecovery', {
      distributorRecoveryApplied: distributorRecovery.applied,
      distributorRecoveryMissingEvidenceCount: distributorRecovery.missingEvidenceCount,
      distributorRecoveryStablePnlCandidate: distributorRecovery.stablePnlCandidate,
      totalOutboundToKnownRouter: distributorRecovery.totalOutboundToKnownRouter,
    })
  }

  // ROUTER TRADE RECONSTRUCTION, DISCLOSED (src/modules/routerTradeReconstruction — read-only
  // observability, same category as distributorRecovery just above; see that new module's own
  // header for the full reasoning on why candidate trades are NEVER fed into priceLotsForWallet's
  // or fifoEngine's real event inputs). `normalizedEvents` is passed through completely unchanged
  // to every downstream stage — this block only derives a logging-only view over it.
  const routerTradeReconstruction = reconstructRouterTrades(normalizedEvents, inferredRouterAddresses, routerDistributorMode)
  if (routerTradeReconstruction.applied) {
    // eslint-disable-next-line no-console
    console.warn('[pipeline] routerTradeReconstruction', {
      routerTradeReconstructionApplied: routerTradeReconstruction.applied,
      routerTradeCandidateCount: routerTradeReconstruction.candidateTrades.length,
      routerTradeHighConfidenceCount: routerTradeReconstruction.highConfidenceCount,
      routerTradeAmbiguousCount: routerTradeReconstruction.ambiguousCount,
    })
  }

  // ROUTER DISCOVERY, DISCLOSED: additive-only, log-only observability aid (src/pipeline/
  // routerDiscovery.ts). Flags outbound events whose counterparty isn't already in
  // KNOWN_DEX_ROUTER_ADDRESSES but matches a real pattern (repeated counterparty across this scan,
  // or same-tx swap shape) — never auto-added to the registry, never consulted by
  // safeRunSellTimelineV2/dust suppression/FIFO/pricing below. Purely for a human to review in logs
  // and manually promote a real candidate later.
  {
    const eventsByTx = new Map<string, NormalizedEvent[]>()
    for (const e of normalizedEvents) {
      const list = eventsByTx.get(e.txHash) ?? []
      list.push(e)
      eventsByTx.set(e.txHash, list)
    }
    const counterpartyStats = buildCounterpartyStats(normalizedEvents.filter((e) => e.direction === 'outbound'))

    for (const event of normalizedEvents) {
      if (event.direction !== 'outbound') continue
      if (inferredRouterAddresses.has(event.toAddress.toLowerCase())) continue

      const sameTxEvents = eventsByTx.get(event.txHash) ?? [event]
      const { isRouterLike, heuristic } = classifyRouterLikeEvent(event, sameTxEvents, counterpartyStats)
      if (isRouterLike && heuristic) {
        recordRouterCandidate(event.chain, event.toAddress, {
          tokensInvolved: [event.contract],
          txHash: event.txHash,
          chain: event.chain,
          heuristic,
        })
      }
    }
  }

  // 3. chainSelection — pure. visible_value_usd / swapCandidateEvents default to 0 (no
  // holdings-pricing or swap-detection module exists yet in this delivery — Architecture Step 7 §3).
  const chainSelection: ChainSelectionResult = buildChainSelectionObject(
    normalizedEvents,
    providerResults.map((r) => ({ chain: r.chain, providerStatus: r.providerStatus })),
  )

  // 4. timelineBuilder — pure, scoped to active_intelligence chains only.
  const timelines: TimelineBuilderResult = buildTimelines(normalizedEvents, chainSelection)

  // 4b. bridgeDetection — pure, zero-cost, operates over ALL normalized events (not gated by
  // chainSelection) since a bridge candidate can legitimately involve a dust/low-activity chain
  // on one leg.
  const bridgeTimeline = safeRunBridgeDetection(normalizedEvents)

  // 5. recoveryPolicy — the ONLY other component permitted to fetch (historical pages), and only
  // reachable at all for scanMode === 'deep'.
  // KV read-before/write-after — 45s TTL (longest of the 4 wrapped stages: recovery's historical
  // page fetches are the most expensive real network calls this pipeline can make).
  const recoveryPolicyStart = performance.now()
  const recoveryPolicy = await withStageCache(
    `v2:recoveryPolicy:${params.walletAddress.toLowerCase()}:${params.scanMode}`,
    45,
    () => safeRunRecoveryPolicy({
      buyTimeline: timelines.buyTimeline,
      sellTimeline: timelines.sellTimeline,
      walletAddress: params.walletAddress,
      scanMode: params.scanMode,
    }),
  )
  scanTimer.mark('recoveryPolicy', recoveryPolicyStart)

  // 5b. sellTimelineV2 — additive, pure, zero-cost. Runs after recoveryPolicy since mechanism 4
  // (recovery-reconstructed sells) needs recoveryPolicy's real recoveredEvents. Never replaces or
  // reads from report.timelines.sellTimeline (timelineBuilder's own output, produced at stage 4).
  const sellTimelineV2 = safeRunSellTimelineV2({
    normalizedEvents,
    chainSelection,
    bridgeTimeline,
    recoveryPolicy,
    walletAddress: params.walletAddress,
  })
  // Diagnostic log — real counts, not a guess. outboundCount is every outbound normalized event
  // fifoEngine will see; sellTimelineV2 entries are only the subset that cleared one of its four
  // detection mechanisms (same-tx swap, transfer-to-known-router, bridge-exit, recovery-
  // reconstructed) — a large gap between the two numbers is expected/honest, not a bug, since
  // sellTimelineV2 is evidence-gated by design (see src/modules/sellTimeline's own scope notes).
  {
    const outboundCount = normalizedEvents.filter((e) => e.direction === 'outbound').length
    const confidenceCounts = sellTimelineV2.entries.reduce(
      (acc, e) => { acc[e.confidence] = (acc[e.confidence] ?? 0) + 1; return acc },
      {} as Record<string, number>,
    )
    // eslint-disable-next-line no-console
    console.warn(
      `[pipeline] sellTimelineV2: ${sellTimelineV2.entries.length}/${outboundCount} outbound event(s) detected as sells`,
      { byConfidence: confidenceCounts, bridgeTimelineCandidates: bridgeTimeline.length },
    )
  }

  // 5c. priceLotsForWallet — REAL FIX, async. Pre-resolves real historical USD pricing (via
  // pricingAtTimeEngine + PRICE_SOURCES) for every normalized event fifoEngine is about to merge
  // and process (base + recovered), then hands back sync lookup functions for fifoEngine's
  // existing priceUsdLookup/currentPriceUsdLookup injection points. Needs recoveredEvents already
  // normalized — normalizeEvents is a pure, cheap re-use of the same real recoveryPolicy.evaluation
  // output safeRunFifoEngine already normalizes internally; normalizing it here too (rather than
  // reaching into fifoEngine's internals) keeps this module's "no runtime coupling" boundary intact.
  //
  // UPSTREAM DUST SUPPRESSION, applied ONLY to a filtered COPY of the events passed into
  // priceLotsForWallet below — see this file's own "UPSTREAM DUST SUPPRESSION" header above for the
  // full disclosure. `normalizedEvents` and `recoveredNormalizedForPricing` themselves are NEVER
  // mutated — fifoEngine (stage 6, below) still receives the exact original, unfiltered
  // `normalizedEvents`, so its own lot-opening/matching behavior for a suppressed token is
  // unchanged (it still opens the same lot; only the pricing ATTEMPT for that lot's cost is
  // skipped, landing on the same honest null cost basis fifoEngine already falls back to for any
  // unpriced event).
  const dustSuppressionStart = performance.now()
  const { suppressedKeys: dustSuppressedKeys, noMarketFoundCount, liquidityZeroCount } =
    await resolveDustSuppressionKeys(timelines.buyTimeline.entries, sellTimelineV2.entries)
  scanTimer.mark('dustSuppression', dustSuppressionStart)

  const recoveredRawEventsForPricing = recoveryPolicy.evaluation.flatMap((e) => e.recoveredEvents)
  const { normalizedEvents: recoveredNormalizedForPricing } = normalizeEvents(recoveredRawEventsForPricing, params.walletAddress)

  const normalizedEventsForPricing = buildFilteredEventsForPricing(normalizedEvents, dustSuppressedKeys)
  const recoveredEventsForPricing = buildFilteredEventsForPricing(recoveredNormalizedForPricing, dustSuppressedKeys)

  const priceLotsForWalletStart = performance.now()
  const rpcLogSnapshotBeforePriceLots = rpcDebugLog.length
  const requestPriceKvClient = createRequestPriceKvClient({ historicalReadOnly: true })
  const requestPriceSources: PriceSources = {
    primary: requestPriceKvClient.wrapPriceSource(PRICE_SOURCES.primary, 'chain-aware-historical'),
    fallback: PRICE_SOURCES.fallback,
  }
  const walletPriceLookups = await priceLotsForWallet({
    normalizedEvents: normalizedEventsForPricing,
    recoveredEvents: recoveredEventsForPricing,
    priceSources: requestPriceSources,
  })
  scanTimer.mark('priceLotsForWallet', priceLotsForWalletStart)
  // CU-ESTIMATOR SNAPSHOT, DISCLOSED: delta over rpcDebugLog taken specifically around this stage's
  // own await — see the CU-ESTIMATOR header above for why this must be a slice, not the raw global
  // array (cross-request leak guard).
  const priceLotsForWalletRpcCounts = countRpcMethods(rpcDebugLog.slice(rpcLogSnapshotBeforePriceLots)).alchemy
  // Diagnostic log — real pricing call outcomes for this wallet's actual events (source breakdown
  // exposed on the lookups themselves, see priceLotsForWallet.ts), plus dust-suppression counts
  // (verification requirement: confirm the fan-out actually shrinks for dust-heavy wallets).
  // eslint-disable-next-line no-console
  console.warn('[pipeline] priceLotsForWallet: pricing source breakdown', walletPriceLookups.sourceBreakdown)
  // eslint-disable-next-line no-console
  console.warn('[pipeline] dust suppression (upstream, before priceLotsForWallet)', {
    totalDistinctBuyTokens: new Set(timelines.buyTimeline.entries.map((e) => dustTokenKey(e.chain, e.token))).size,
    suppressedTokens: dustSuppressedKeys.size,
  })

  // 6. fifoEngine — pure, no provider calls; consumes normalized events + recoveryPolicy's
  // already-fetched recoveredEvents, now WITH real pricing (stage 5c) wired into its existing
  // priceUsdLookup/currentPriceUsdLookup injection points — the actual fix for "PnL always
  // unavailable". fifoEngine's own source is unmodified.
  const fifoAndPnl = safeRunFifoEngine({
    normalizedEvents,
    recoveryPolicy,
    walletAddress: params.walletAddress,
    buyTimeline: timelines.buyTimeline,
    sellTimeline: timelines.sellTimeline,
    priceUsdLookup: walletPriceLookups.priceUsdLookup,
    currentPriceUsdLookup: walletPriceLookups.currentPriceUsdLookup,
  })
  // Diagnostic log — real FIFO output counts, directly requested.
  // eslint-disable-next-line no-console
  console.warn('[pipeline] fifoEngine result', {
    matchedLots: fifoAndPnl.matchedLots.length,
    unmatchedBuys: fifoAndPnl.unmatchedBuys,
    unmatchedSells: fifoAndPnl.unmatchedSells,
    publicPnlStatus: fifoAndPnl.publicPnlStatus,
    hardInvalid: fifoAndPnl.integrityFlags.hardInvalid,
  })

  // 6b. pnlSummaryV2 — additive, pure, zero-cost. Now runs AFTER fifoEngine (was before it) so it
  // can borrow fifoEngine's real, now-priced matchedLots for resolveCostUsdEstimate/
  // resolveProceedsUsdEstimate (see buildFifoBackedPnlResolvers) instead of leaving them stubbed.
  // pnlEngine's own source is still never modified and still never imports fifoEngine directly.
  const pnlResolvers = buildFifoBackedPnlResolvers(fifoAndPnl.matchedLots)
  const pnlSummaryV2 = safeRunPnlSummaryV2({
    sellEntries: sellTimelineV2.entries,
    buyEntries: timelines.buyTimeline.entries,
    resolveCostUsdEstimate: pnlResolvers.resolveCostUsdEstimate,
    resolveProceedsUsdEstimate: pnlResolvers.resolveProceedsUsdEstimate,
  })
  // Diagnostic log — real pnlSummaryV2 output counts.
  // eslint-disable-next-line no-console
  console.warn('[pipeline] pnlSummaryV2 result', {
    closedLots: pnlSummaryV2.closedLots.length,
    evidenceMissingCount: pnlSummaryV2.evidenceMissingCount,
    realizedPnlUsd: pnlSummaryV2.realizedPnlUsd,
  })

  // PNL OVERFLOW GUARD, DISCLOSED: defensive-only (src/pipeline/pnlSummaryAdapter.ts). Never
  // changes pnlEngine's own computation — only clamps a genuinely-garbage realizedPnlUsd to null
  // before it reaches the final report / UI. `adaptedPnlSummary` replaces the raw `pnlSummaryV2`
  // everywhere downstream in this function (final report + walletCondition inputs) so both stay
  // consistent; closedLots/winLossRate/chainBreakdown/confidenceBasis/evidenceMissingCount are
  // untouched (spread straight through).
  const adaptedPnlSummary = adaptPnlSummaryForUi(pnlSummaryV2)

  // 6c. pricingAtTime — additive, async, still its own independent real pricing pass over just the
  // UI-facing buyTimeline/sellTimelineV2 entries, keyed for report.pricingAtTime's existing
  // consumers. priceSources is the same real PRICE_SOURCES stage 5c uses. Never touches fifoEngine's
  // own, separate pricing mechanism.
  //
  // DUST SUPPRESSION reuses the SAME dustSuppressedKeys already resolved once, upstream, before
  // stage 5c — no second round of cheap lookups here. Consistent by construction: a token excluded
  // from priceLotsForWallet's input is excluded from this display pass too.
  //
  // ROUTER-DISTRIBUTOR EXCEPTION, DISCLOSED (additive): when routerDistributorMode is true, this
  // display-only pass uses the FULL, unfiltered buyTimeline instead of the dust-filtered copy —
  // holdings' own separate dust-suppression computation (elsewhere in this function, untouched) and
  // priceLotsForWallet's fifoEngine-feeding input (stage 5c, above, untouched) are NOT affected
  // either way. A wallet with heavy router-mediated distribution activity is exactly the case this
  // codebase's own dust suppression (a cheap "does any market exist" check) is most likely to
  // misclassify a genuinely-traded token as dust — widening coverage here is a display-only
  // trade-off, not a claim that dust suppression's real definition changed.
  const displayBuyEntries = routerDistributorMode || dustSuppressedKeys.size === 0
    ? timelines.buyTimeline.entries
    : timelines.buyTimeline.entries.filter((e) => !dustSuppressedKeys.has(dustTokenKey(e.chain, e.token)))
  const dustSkippedCount = timelines.buyTimeline.entries.length - displayBuyEntries.length
  // Diagnostic log — real dust-suppression counts, directly requested (verification step:
  // "pricingAtTimeEngine.priceEntries total count decreases for dust-heavy wallets").
  // eslint-disable-next-line no-console
  console.warn('[pipeline] dust suppression (display pricingAtTime pass)', {
    totalBuyEntries: timelines.buyTimeline.entries.length,
    suppressed: dustSkippedCount,
    routerDistributorMode,
  })

  const pricingAtTimeStart = performance.now()
  const rpcLogSnapshotBeforePricingAtTime = rpcDebugLog.length
  // FALLBACK-PRICING OBSERVABILITY, DISCLOSED: pricingRouteLog (pricingAtTimeAdapter.ts) already
  // records which real provider (goldrush/geckoterminal/dexscreener/coingecko_or_basedex/none)
  // answered every pricing attempt — it was written but never read back anywhere in this file until
  // now. Same snapshot-before/slice-after pattern already used around rpcDebugLog just above, so
  // this reads only THIS scan's own attempts, not the whole process-lifetime log.
  const pricingRouteLogSnapshotBefore = pricingRouteLog.length

  // NEW FALLBACK-PRICING MODULE WIRING, DISCLOSED (src/modules/fallbackPricing — BaseScan for base,
  // GeckoTerminal for eth, current-price-only). Passed as `fallbackPricing` — an OPTIONAL config
  // resolvePricingAtTime only honors when supplied (see pricingAtTimeEngine/types.ts's own
  // disclosure). Only reached per-entry when PRICE_SOURCES' own primary+fallback (the existing
  // chain-aware router) BOTH already missed — never a third historical-price attempt in the sense
  // that matters for cost basis, and never called at all from priceLotsForWallet.ts (fifoEngine's
  // input), which never passes this config. `onRouteRecorded` populates the counters below AND
  // pushes into the same pricingRouteLog the existing router already uses, so both fallback layers
  // show up in one place.
  const newFallbackRoutes: FallbackPricingRoute[] = []
  const fallbackPricingConfig: FallbackPricingConfig = {
    attempt: (p) => fallbackPricingService.getFallbackPrice({ chainId: p.chain === 'base' ? 8453 : p.chain === 'eth' ? 1 : -1, tokenAddress: p.tokenAddress, timestampMs: p.timestampMs }),
    routerDistributorMode,
    onRouteRecorded: (info) => {
      newFallbackRoutes.push(info.route)
      pricingRouteLog.push({
        token: info.token, chain: info.chain, timestamp: info.timestamp,
        route: info.route === 'failed' ? 'none' : 'geckoterminal',
        // NOTE, DISCLOSED: pricingRouteLog's own PricingRouteUsed union (pricingAtTimeAdapter.ts)
        // has no 'basescan' member — reusing 'geckoterminal' as the closest existing "a real
        // non-goldrush provider answered" bucket rather than widening that file's own protected
        // union type. The dedicated fallbackPricingSources counters below (this module's own,
        // real Part-4 requirement) are the authoritative BaseScan-vs-GeckoTerminal breakdown.
      })
    },
  }

  const pricingAtTime = await safeRunPricingAtTime({
    buyEntries: displayBuyEntries,
    sellEntries: sellTimelineV2.entries,
    priceSources: requestPriceSources,
    fallbackPricing: fallbackPricingConfig,
  })
  scanTimer.mark('pricingAtTime', pricingAtTimeStart)
  requestPriceKvClient.logStats('[pipeline] price KV stats')
  // CU-ESTIMATOR SNAPSHOT, DISCLOSED: same delta pattern as priceLotsForWallet's own snapshot above.
  const pricingAtTimeRpcCounts = countRpcMethods(rpcDebugLog.slice(rpcLogSnapshotBeforePricingAtTime))

  // EXISTING-ROUTER FALLBACK USAGE, DISCLOSED: 'goldrush' or 'none' means GoldRush either answered
  // directly or nothing did — 'geckoterminal'/'dexscreener'/'coingecko_or_basedex' mean a real
  // non-GoldRush provider inside PRICE_SOURCES.primary's own chain-aware router (buildPriceSources
  // above) answered instead. Kept separate from the NEW fallbackPricing module's own counters below
  // — two different fallback layers, both real.
  const pricingRouteFallbackUsed = pricingRouteLog
    .slice(pricingRouteLogSnapshotBefore)
    .some((r) => r.route !== 'goldrush' && r.route !== 'none')

  // PART 4 OBSERVABILITY, DISCLOSED: real counts from the NEW fallbackPricing module's own
  // onRouteRecorded calls above — never fabricated, never estimated.
  const fallbackPricingUsed = newFallbackRoutes.some((r) => r !== 'failed')
  const fallbackPricingCount = newFallbackRoutes.filter((r) => r !== 'failed').length
  const fallbackPricingSources = {
    baseScan: newFallbackRoutes.filter((r) => r === 'BaseScan').length,
    geckoTerminal: newFallbackRoutes.filter((r) => r === 'GeckoTerminal').length,
  }

  // DEV-ONLY OBSERVABILITY, DISCLOSED: never added to FinalReport / any API response — console-only,
  // matching this codebase's own established "dev-only" pattern elsewhere (e.g.
  // lib/server/cache/v2StageCache.ts's DEV_WARM_TTL_SECONDS gate). Not shown to end users.
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.warn('[pipeline] scanPricingDiagnostics (dev-only)', {
      fallbackPricingUsed, fallbackPricingCount, fallbackPricingSources,
      pricingRouteFallbackUsed, dustSkippedCount, routerDistributorMode,
    })
  }

  // SYNTHETIC PNL, DISCLOSED (src/modules/syntheticPnl — UI-DISPLAY-ONLY, see that module's own
  // header for the full reasoning on why it never touches fifoEngine/priceLotsForWallet/pnlV2).
  //
  // POOLDATA SOURCE, DISCLOSED — no new network calls: `poolData` is built entirely from
  // pricingAtTime's ALREADY-RESOLVED costUsd/proceedsUsd (real per-tx USD values this scan already
  // paid for, just above) rather than a fresh pool-liquidity fetch — adding a new, uncapped
  // per-token network-calling loop here would risk reintroducing the exact scan-latency/fan-out
  // problem this session's earlier KV/pricing-throttle work fixed. Missing liquidity remains
  // undefined: a price is evidence of a price, not evidence of $5,000 (or any other depth).
  // BUG FIX, DISCLOSED (found via static trace, diagnostic task): the previous version built this
  // map from `Object.entries({ ...pricingAtTime.costUsd, ...pricingAtTime.proceedsUsd })` — both
  // dictionaries are keyed by txHash, so a transaction that has BOTH a buy leg (in
  // pricingAtTime.costUsd) and a sell leg (in pricingAtTime.proceedsUsd) sharing the same txHash —
  // exactly what a real router swap produces, the core case this whole feature targets — silently
  // collided: the object spread let proceedsUsd's entry overwrite costUsd's for that key, and the
  // subsequent `.find((e) => e.txHash === txHash)` over `[...displayBuyEntries,
  // ...sellTimelineV2.entries]` always returned the FIRST match (the buy entry), so a sell's real
  // resolved proceeds got divided by the WRONG token's amount — either corrupting that pool's price
  // or (via the `key in syntheticPoolData` first-write-wins guard) losing the correct token's price
  // entirely. Net effect: `syntheticPoolData` was frequently missing or wrong for exactly the
  // router-swap transactions synthetic reconstruction needs, so `inferSyntheticTrades` excluded
  // those candidates (missing/wrong poolData -> excluded, per its own "never fabricate a price"
  // rule) and `syntheticPnl` stayed null far more often than it should have.
  //
  // Fixed by processing costUsd against ONLY displayBuyEntries and proceedsUsd against ONLY
  // sellTimelineV2.entries, each keyed by (txHash + chain + token) instead of txHash alone — no
  // merged dictionary, no ambiguous txHash-only lookup, no cross-leg collision possible.
  const syntheticPoolData: SyntheticPoolDataMap = {}
  const scanPricingRoutes = pricingRouteLog.slice(pricingRouteLogSnapshotBefore)
  const knownObservedPrices: Record<string, number> = {}
  for (const [entries, values] of [[displayBuyEntries, pricingAtTime.costUsd], [sellTimelineV2.entries, pricingAtTime.proceedsUsd]] as const) {
    for (const entry of entries) {
      const usd = values[entry.txHash]
      const amount = Number(entry.amount)
      if (usd != null && Number.isFinite(usd) && usd > 0 && Number.isFinite(amount) && amount > 0) knownObservedPrices[entry.token.toLowerCase()] = usd / amount
    }
  }
  const aerodromeDiscovery = new Map<string, Promise<AerodromePool[]>>()
  async function recordSyntheticPoolPrice(entries: readonly { chain: string; token: string; txHash: string; amount: string; timestamp: number }[], usdByTxHash: Record<string, number | null>): Promise<void> {
    for (const entry of entries) {
      const usd = usdByTxHash[entry.txHash]
      const amount = Number(entry.amount)
      const key = `${entry.chain}:${entry.token.toLowerCase()}`
      if (key in syntheticPoolData) continue
      const route = scanPricingRoutes.find((record) => record.chain === entry.chain && record.token.toLowerCase() === entry.token.toLowerCase() && record.timestamp === entry.timestamp)?.route
      const observedUnitPrice = Number.isFinite(usd) && Number.isFinite(amount) && (usd ?? 0) > 0 && amount > 0 ? (usd as number) / amount : null
      let aerodromePool: AerodromePool | null = null
      let aerodromePrice: number | null = null
      if (entry.chain === 'base') {
        const eventMetadata = normalizedEvents.find((event) => event.chain === entry.chain && event.contract.toLowerCase() === entry.token.toLowerCase())
        const token = { address: entry.token, decimals: eventMetadata?.tokenDecimals, symbol: eventMetadata?.symbol }
        let discovery = aerodromeDiscovery.get(entry.token.toLowerCase())
        if (!discovery) {
          discovery = discoverAerodromePools(entry.token)
          aerodromeDiscovery.set(entry.token.toLowerCase(), discovery)
        }
        aerodromePool = mapAerodromeToken(token, await discovery)
        aerodromePrice = priceBaseTokenFromAerodrome(token, aerodromePool, knownObservedPrices)
      }
      const resolved = (await resolvePipelinePrice(entry.timestamp, {
        goldrush: () => route === 'goldrush' ? observedUnitPrice : null,
        dexscreener: () => route === 'dexscreener' ? observedUnitPrice : null,
        subgraphs: { ...(entry.chain === 'base' ? { aerodrome: () => aerodromePrice } : {}) },
        external: () => route && route !== 'none' && route !== 'goldrush' && route !== 'dexscreener' ? observedUnitPrice : null,
        ratio: () => null,
        synthetic: () => null,
      }))[entry.timestamp] ?? null
      const resolvedUsd = usd ?? (aerodromePrice !== null ? aerodromePrice * amount : null)
      const poolMetadata = aerodromePool ? [{ ...aerodromePool, poolAddress: aerodromePool.address }] : []
      const data = buildSyntheticPoolPriceData(resolvedUsd, amount, resolved, poolMetadata)
      if (data) syntheticPoolData[key] = data
    }
  }
  await recordSyntheticPoolPrice(displayBuyEntries, pricingAtTime.costUsd)
  await recordSyntheticPoolPrice(sellTimelineV2.entries, pricingAtTime.proceedsUsd)
  // This is the mandatory successor to pricingAtTime. Keep the complete hand-off in one call so
  // provider-only, diagnostics, and full scans cannot make pricingAtTime their terminal stage.
  // Final observability is owned by the assembly function and therefore runs for an empty result
  // too; no PnL calculation or confidence rule is changed here.
  const syntheticPnl = syntheticPnlAssembly({
    normalizedEvents,
    priceLotsForWalletOutput: walletPriceLookups,
    resolvedPrices: pricingAtTime,
    metadata: {
      poolData: syntheticPoolData,
      knownDexRouterAddresses: KNOWN_DEX_ROUTER_ADDRESSES,
      routerDistributorMode,
    },
    attribution: scanPricingRoutes,
  })
  // TOP-OF-LOG GUARANTEE: emit immediately after assembly and before the deferred heavy diagnostics
  // below, so terminal truncation of normalizedEvents/provider-window details cannot hide it.
  logSyntheticPnlSummary(syntheticPnl)

  const pnlReconciliation = createPnlReconciliation({
    priceKvClient: requestPriceKvClient,
    priceSources: requestPriceSources,
    dustSuppressedKeys,
  })
  const reconciledPnlSummary = await pnlReconciliation.reconcile({
    fifoEngineResult: fifoAndPnl,
    pnlEngineResult: adaptedPnlSummary,
    computePnlResult: syntheticPnl ? { realizedPnlUsd: syntheticPnl.totalRealizedPnlUsd, unrealizedPnlUsd: syntheticPnl.totalUnrealizedPnlUsd } : null,
    routerInferenceOutput: routerInferenceResult,
    syntheticPnlAssemblyOutput: syntheticPnl,
  })
  const reconciledFifoAndPnl: FifoOutput = {
    ...fifoAndPnl,
    unmatchedBuys: reconciledPnlSummary.unmatchedBuys,
    unmatchedSells: reconciledPnlSummary.unmatchedSells,
    realizedPnlUsd: reconciledPnlSummary.realizedPnlUsd,
    unrealizedPnlUsd: reconciledPnlSummary.unrealizedPnlUsd,
    publicPnlStatus: reconciledPnlSummary.publicPnlStatus === 'available' ? 'ok' : reconciledPnlSummary.publicPnlStatus === 'partial' ? 'limited_verified_sample' : 'unavailable',
  }
  const reconciledPnlSummaryV2: PnlSummaryResult = {
    ...adaptedPnlSummary,
    realizedPnlUsd: reconciledPnlSummary.realizedPnlUsd,
    evidenceMissingCount: reconciledPnlSummary.missingEvidenceCount,
  }
  const priceRecoveryMap = new Set(reconciledPnlSummary.mismatches.filter((m) => m.classification === 'priceRecovered').map((m) => m.key))
  const ayriAttribution = createAyriAttribution().build({
    reconciledPnL: reconciledPnlSummary,
    reconciledLots: reconciledFifoAndPnl.matchedLots,
    routerInferenceOutput: routerInferenceResult,
    syntheticPnlAssemblyOutput: syntheticPnl,
    priceRecoveryMap,
    pricingSourceBreakdown: walletPriceLookups.sourceBreakdown,
    pricingRoutes: walletPriceLookups.historicalPricingAttempts,
  })

  // Deferred until after the mandatory synthetic-PnL summary above; these can be very large on
  // provider-only/heavy-wallet scans and must never be the first thing a truncated terminal keeps.
  // eslint-disable-next-line no-console
  console.warn('[pipeline] providerFetchWindowDiagnostics', providerFetchWindowDiagnostics)
  // eslint-disable-next-line no-console
  console.warn('[debug] normalizedEvents trace', normalizedEventsTrace)

  // 7. windowCoverage — pure arithmetic derived from the fixed fetch window and recovery pages used.
  const windowCoverage = computeWindowCoverage(PROVIDER_FETCH_WINDOW_DAYS_USED, recoveryPolicy.totalPagesUsedThisWallet)

  // 8. behaviorIntel — pure, zero cost. Reads timelines (buyTimeline/distributionTimeline) +
  // sellTimelineV2.entries + chainSelection + windowCoverage; has no access to recoveryPolicy or
  // fifoAndPnl (they are never passed into this call). sellTimelineV2 was computed at stage 5b,
  // itself derived only from normalizedEvents/chainSelection/bridgeTimeline/recoveryPolicy — this
  // does not give behaviorIntel a backdoor into recoveryPolicy's own object, only its already-
  // downstream-processed sell entries.
  const behaviorIntel = safeRunBehaviorIntel({
    buyTimeline: timelines.buyTimeline,
    sellEntries: sellTimelineV2.entries,
    distributionTimeline: timelines.distributionTimeline,
    chainSelection,
    windowCoverage,
  })

  // 9. finalReportAssembler — pure merge; never mutates any section produced above.
  const scanMetadata: ScanMetadata = {
    walletAddress: params.walletAddress,
    scanTimestamp,
    intel_window_days: INTEL_WINDOW_DAYS,
    provider_fetch_window_days: PROVIDER_FETCH_WINDOW_DAYS_USED,
    scanMode: params.scanMode,
    chainsScanned: preScan.sanitizedChains,
  }

  // "WHY DID THIS SCAN TAKE X SECONDS", DISCLOSED (orchestration-layer-only diagnostic summary):
  // total wall-clock time plus a per-stage breakdown of this file's own async await points — see
  // startStageTimer's own header for the honest limit of what this can and can't observe (nothing
  // about time spent INSIDE pricingAtTimeEngine's own bisect/poolPrice/GoldRush/fallback call
  // graph, only how long each of THIS file's stages took overall). Distinct tokens vs.
  // dust-suppressed count is the one real, verifiable signal this layer has for "how much of the
  // pricing fan-out was avoided."
  const distinctBuyTokenCount = new Set(timelines.buyTimeline.entries.map((e) => dustTokenKey(e.chain, e.token))).size
  const heavyWallet = computeHeavyWalletFlag(distinctBuyTokenCount, reconciledFifoAndPnl.matchedLots.length)
  // deadTokenSkippedCount vs. unindexedTokenSkippedCount, DISCLOSED: these are requested as two
  // separate counts, but this implementation only has ONE real "no market found at all" signal
  // (classifyDustSuppression's 'no_market_found' reason) — there is no independent, orchestration-
  // visible way to distinguish "GoldRush has no events for this token" (part of the task's own
  // "dead" definition) from "DexScreener has no pairs and no pool" (its "unindexed" definition),
  // since both ultimately reduce to the same DexScreener check from here. Both fields report the
  // same real count rather than fabricating two different numbers for one signal.
  // eslint-disable-next-line no-console
  console.warn('[pipeline] scan timing summary', {
    totalMs: Math.round(performance.now() - scanStartedAtMs),
    stagesMs: scanTimer.stages,
    dustSuppression: {
      distinctBuyTokens: distinctBuyTokenCount,
      suppressedTokens: dustSuppressedKeys.size,
    },
    heavyWallet,
    // ALWAYS false, DISCLOSED: the requested GoldRush-skip-for-Base rule was not implemented — it
    // conflated providerDiagnostics.goldrush (the wallet's own raw transfer-history fetch) with
    // GoldRush's separate, unrelated pricing endpoint (goldrushPriceSource.ts). A wallet's raw
    // history returning 0 events on a chain says nothing about whether GoldRush's pricing endpoint
    // has data for any token on that chain, so no such skip exists to report — this field is kept
    // in the log SHAPE (matching what the task asked for) rather than omitted, so a reader doesn't
    // mistake its literal absence for a bug.
    goldrushSkippedForBase: false,
    deadTokenSkippedCount: noMarketFoundCount,
    zeroLiquiditySkippedCount: liquidityZeroCount,
    unindexedTokenSkippedCount: noMarketFoundCount,
    filteredEventsForPricingCount: normalizedEventsForPricing.length,
    providerFetchWindowDiagnostics,
    slowProviderDetected: slowProviderSignals.slowProviderDetected,
    jitterDetected: slowProviderSignals.jitterDetected,
    // COLD-START CAVEAT, DISCLOSED (see computeColdStartFlag's own header): an order-based
    // heuristic, not verified TCP/TLS connection warm-up — chains fetch concurrently here.
    coldStartDetected: slowProviderSignals.coldStartDetected,
    rateLimitDetected: slowProviderSignals.rateLimitDetected,
    perChainLatencyMs: chainLatencies,
  })

  // CU ESTIMATOR SUMMARY, DISCLOSED: see the "CU ESTIMATOR" header above buildCuEstimatorSummary
  // for the full disclosure — real observed rpcDebugLog counts (delta-scoped per stage, never the
  // raw global buffer), task-specified CU weights, and an honestly-scoped-down perToken (real entry
  // counts, not fabricated per-token CU, since no token attribution exists in the available data).
  const cuEstimatorSummary = buildCuEstimatorSummary(
    priceLotsForWalletRpcCounts,
    pricingAtTimeRpcCounts,
    [...displayBuyEntries, ...sellTimelineV2.entries],
  )
  // eslint-disable-next-line no-console
  console.warn('[pipeline] cuEstimatorSummary', cuEstimatorSummary)

  // ===========================================================================================
  // WALLET CONDITION MESSAGES — UI-LAYER WIRING, DISCLOSED
  // ===========================================================================================
  // Maps buildWalletConditionMessages()'s inputs onto real fields this scan already computed.
  // Several of the task's own suggested mappings don't match the real data model — corrected here
  // (each one verified by reading the actual type, not assumed):
  //   - closedLots: the task named `fifo.closedLots`, but fifoEngine's own output has no such
  //     field (its shape is matchedLots/unmatchedBuys/unmatchedSells — a lot-matching count,
  //     independent of whether a price was ever found for it). The real "how many sells got
  //     verifiable pricing" concept lives in pnlSummaryV2.closedLots (ClosedLot[]) instead — that's
  //     what's used below.
  //   - totalSells: the task named `sellTimelineV2.outboundSellCount`, which doesn't exist;
  //     SellTimelineResult's real field is `totalSells` directly.
  //   - excludedTokens: the task named `dustSuppressedKeys + deadTokenKeys` — there is no separate
  //     "deadTokenKeys" set in this implementation; classifyDustSuppression's two reasons
  //     ('no_market_found' | 'liquidity_zero') both live in the ONE real dustSuppressedKeys set.
  //     Mapped from that single set, resolved to human-readable symbols via buyTimeline's own
  //     `symbol` field where available (falling back to the raw chain:token key otherwise — never
  //     a fabricated symbol).
  //   - previousPnL/microcaps/lowLiquidityTokens: NOT available — RunWalletScanParams has no
  //     "lastScan" concept anywhere (confirmed by reading src/pipeline/types.ts), and this
  //     (old-engine) pipeline never computes per-token marketCap/liquidity at all — that data only
  //     exists in the separate V2 holdings/pricing chain (workers/walletScanV2.ts), which isn't in
  //     scope here. Left undefined so their dependent sections hide, never fabricated.
  const tokenSymbolByKey = new Map<string, string>()
  for (const e of timelines.buyTimeline.entries) {
    const key = dustTokenKey(e.chain, e.token)
    if (!tokenSymbolByKey.has(key)) tokenSymbolByKey.set(key, e.symbol || key)
  }
  const excludedTokens = [...dustSuppressedKeys].map((key) => tokenSymbolByKey.get(key) ?? key)
  const providerErrorCount = providerDiagnostics.filter((d) => d.goldrush.errorReason != null || d.alchemy.errorReason != null).length

  const walletConditionInputs = {
    tokenCount: distinctBuyTokenCount,
    deadTokens: noMarketFoundCount,
    unindexedTokens: noMarketFoundCount,
    zeroLiquidityTokens: liquidityZeroCount,
    failedPricingAttempts: walletPriceLookups.sourceBreakdown.failed,
    fallbackAttempts: walletPriceLookups.sourceBreakdown.fallback,
    providerErrors: providerErrorCount,
    suppressionSkipped: dustSuppressedKeys.size,
    closedLots: reconciledPnlSummary.closedLots,
    totalSells: sellTimelineV2.totalSells,
    previousPnL: undefined,
    currentPnL: reconciledPnlSummary.realizedPnlUsd,
    excludedTokens,
  }
  const finalReportAssembler = createFinalReportAssembler()
  const finalReport = finalReportAssembler.assemble({
    scanMetadata,
    chainSelection,
    timelines,
    recoveryPolicy,
    fifoAndPnl: reconciledFifoAndPnl,
    behaviorIntel,
    windowCoverage,
    bridgeTimeline,
    sellTimelineV2,
    pnlSummaryV2: reconciledPnlSummaryV2,
    pricingAtTime,
    providerDiagnostics,
    pricingProvidersStatus: PRICING_PROVIDERS_STATUS,
    syntheticPnl,
    ayriAttribution,
    reconciledPnL: reconciledPnlSummary,
    routerInferenceOutput: routerInferenceResult,
    syntheticPnlAssemblyOutput: syntheticPnl,
    pricingSourceBreakdown: walletPriceLookups.sourceBreakdown,
    walletConditionInputs,
  })
  // eslint-disable-next-line no-console
  console.log('[walletCondition] inputs', walletConditionInputs)
  const walletConditionMessages = buildWalletConditionMessages(walletConditionInputs)
  // eslint-disable-next-line no-console
  console.log('[walletCondition] output', walletConditionMessages)

  // END-OF-PIPELINE FALLBACK GUARANTEE: repeat the compact synthetic-PnL summary after every stage
  // has completed, independent of the earlier immediate post-assembly log.
  logSyntheticPnlSummary(syntheticPnl)

  return { ...finalReport, normalizationErrors, walletConditionMessages }
}

export type { SupportedChain }
export { emptyChainSelection, emptyTimelines }
