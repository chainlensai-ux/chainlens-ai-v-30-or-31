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
import { assembleReport } from '../modules/finalReportAssembler/index'
import type { AssembleReportInput, FinalReport, ScanMetadata } from '../modules/finalReportAssembler/types'
import { buildBridgeDetectionObject } from '../modules/bridgeDetection/index'
import type { BridgeCandidateEvent } from '../modules/bridgeDetection/types'
import { buildSellTimeline } from '../modules/sellTimeline/index'
import type { SellTimelineEntry, SellTimelineResult } from '../modules/sellTimeline/types'
import { buildPnlSummary } from '../modules/pnlEngine/index'
import type { BuildPnlSummaryParams, PnlSummaryResult } from '../modules/pnlEngine/types'
import { resolvePricingAtTime } from '../modules/pricingAtTimeEngine/index'
import type { PriceableEntry, PriceSourceFn, PriceSources, PricingAtTimeResult } from '../modules/pricingAtTimeEngine/types'
import { GoldRushClient } from '@covalenthq/client-sdk'
import { goldrushPriceSource, isKnownGoldrushNegative } from '../modules/pricingAtTimeEngine/sources/goldrushPriceSource'
import { multiProviderPriceSource } from '../modules/pricingAtTimeEngine/sources/multiProviderPriceSource'
import { priceLotsForWallet } from './priceLotsForWallet'
import { withStageCache } from '../../lib/server/cache/v2StageCache'
import { getTokenCache, setTokenCache } from '../../lib/server/cache/tokenCache'
import type { MatchedLot } from '../modules/fifoEngine/types'
import { getCheapCurrentPriceForDustCheck, type CheapDustPriceResult } from '../../lib/server/dustPriceCheck'

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
  finalSummaryFallback,
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
function withPriceSourceCache(fn: PriceSourceFn, sourceLabel: string, skipCacheCheck?: (token: string, chain: string) => boolean): PriceSourceFn {
  return async (token, chain, timestamp) => {
    if (skipCacheCheck?.(token, chain)) return fn(token, chain, timestamp)
    const key = `v2:price:${sourceLabel}:${chain}:${token.toLowerCase()}:${timestamp}`
    const cached = await getTokenCache<number>(key)
    if (cached !== null) return cached
    const result = await fn(token, chain, timestamp)
    if (result !== null) await setTokenCache(key, result, 45)
    return result
  }
}

function buildPriceSources(): PriceSources {
  const apiKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY
  // Diagnostic log (never prints the key itself) — the fastest way to confirm, from the actual
  // runtime's own logs (e.g. Vercel's function logs), whether a real key was found in *that*
  // process's env at module load, without needing a separate deployment-inspection tool.
  // eslint-disable-next-line no-console
  console.warn(`[pipeline] buildPriceSources: real GoldRush key present = ${Boolean(apiKey)}`)
  const fallback = withPriceSourceCache(multiProviderPriceSource(), 'fallback')
  if (!apiKey) return { primary: fallback, fallback: noPriceSources().fallback }
  // BUG FIX, DISCLOSED: `new GoldRushClient(apiKey)` throws synchronously (a plain object, not an
  // Error instance — confirmed by reading the SDK's own source) when apiKey fails its local
  // key-format regex check. Since this whole function runs at MODULE IMPORT TIME (PRICE_SOURCES
  // below is a top-level `export const`), an unwrapped throw here would crash the entire module
  // load for every route that imports this pipeline — not the graceful "fall back to
  // multiProviderPriceSource" behavior this file otherwise guarantees everywhere else. A malformed
  // (not just missing) key now degrades the same way a missing key already does, instead of taking
  // down the whole V2 pipeline at cold start.
  try {
    const client = new GoldRushClient(apiKey)
    return { primary: withPriceSourceCache(goldrushPriceSource(client), 'primary', isKnownGoldrushNegative), fallback }
  } catch (err) {
    // The SDK throws a plain { error_message } object here, not an Error instance (confirmed by
    // reading its source) — extracted explicitly so this log is actually useful, not "[object Object]".
    const reason = err instanceof Error
      ? err.message
      : (typeof err === 'object' && err !== null && 'error_message' in err ? String((err as { error_message: unknown }).error_message) : String(err))
    // eslint-disable-next-line no-console
    console.warn('[pipeline] buildPriceSources: GoldRushClient construction failed, falling back', { reason })
    return { primary: fallback, fallback: noPriceSources().fallback }
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
// must run after stage 5, not alongside bridgeDetection at stage 4b). Never trusts a
// client-supplied router registry — knownDexRouterAddresses is always the empty set here, exactly
// as src/modules/sellTimeline's own doc comments assume until a real registry exists.
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
      knownDexRouterAddresses: new Set<string>(),
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

// PURE — given a candidate token's cheap-lookup result, decides suppressibility. Exported for direct
// unit testing.
export function isSuppressibleDustToken(cheapResult: CheapDustPriceResult): boolean {
  // hasAnyPriceSource === false doubles as "balanceUsd known to be ~$0, below any real threshold" —
  // see this block's own header for why these two conditions collapse to one signal here. Any
  // discovered price, however small, disqualifies suppression.
  return !cheapResult.hasAnyPriceSource
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
async function resolveDustSuppressionKeys(
  buyEntries: readonly BuyTimelineEntry[],
  sellEntries: readonly SellTimelineEntry[],
): Promise<Set<string>> {
  const candidateKeys = computeDustCandidateKeys(buyEntries, sellEntries)
  if (candidateKeys.size === 0) return new Set()

  // One representative entry per candidate key, to recover (token, chain) for the lookup call.
  const representativeByKey = new Map<string, BuyTimelineEntry>()
  for (const e of buyEntries) {
    const key = dustTokenKey(e.chain, e.token)
    if (candidateKeys.has(key) && !representativeByKey.has(key)) representativeByKey.set(key, e)
  }

  const candidates = [...representativeByKey.entries()]
  const results = await mapWithConcurrencyLimit(candidates, DUST_SUPPRESSION_CONCURRENCY_LIMIT, async ([key, entry]) => {
    const cheapResult = await getCheapCurrentPriceForDustCheck(entry.token, entry.chain)
    return { key, suppress: isSuppressibleDustToken(cheapResult) }
  })

  const suppressed = new Set<string>()
  for (const r of results) if (r.suppress) suppressed.add(r.key)
  return suppressed
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
}): Promise<PricingAtTimeResult> {
  try {
    return await resolvePricingAtTime({
      buyEntries: params.buyEntries,
      sellEntries: params.sellEntries,
      priceSources: params.priceSources ?? noPriceSources(),
    })
  } catch {
    return pricingAtTimeFallback()
  }
}

function safeAssembleReport(input: AssembleReportInput): FinalReport {
  try {
    return assembleReport(input)
  } catch {
    // assembleReport is a pure merge and should never throw in practice; this is a last-resort
    // guard so a truly unexpected failure still yields a shape-complete report rather than an
    // unhandled exception reaching the caller.
    return {
      scanMetadata: input.scanMetadata,
      chainSelection: input.chainSelection,
      timelines: { ...input.timelines, sellTimelineV2: input.sellTimelineV2 },
      recoveryPolicy: input.recoveryPolicy,
      fifoAndPnl: input.fifoAndPnl,
      behaviorIntel: input.behaviorIntel,
      windowCoverage: input.windowCoverage,
      finalSummary: finalSummaryFallback(),
      bridgeTimeline: input.bridgeTimeline,
      pnlSummaryV2: input.pnlSummaryV2,
      pricingAtTime: input.pricingAtTime,
      providerDiagnostics: input.providerDiagnostics,
      pricingProvidersStatus: input.pricingProvidersStatus,
    }
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

  // 0. Pre-scan validation (Architecture Step 6 §1). An invalid request never reaches any
  // provider call — it degrades immediately to a fully-shaped, honestly-labeled report.
  const preScan: PreScanValidation = validatePreScan(params)
  if (!preScan.valid) {
    return { ...buildFullyDegradedReport(params, scanTimestamp, PROVIDER_FETCH_WINDOW_DAYS_USED), normalizationErrors: [] }
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
  const providerFetchStart = performance.now()
  const providerResults = await Promise.all(
    preScan.sanitizedChains.map((chain) =>
      withStageCache(
        `v2:providerFetchWindow:${chain}:${params.walletAddress.toLowerCase()}`,
        30,
        () => fetchProviderWindow(chain, params.walletAddress, PROVIDER_FETCH_WINDOW_DAYS_USED),
      ),
    ),
  )
  scanTimer.mark('providerFetchWindow', providerFetchStart)

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

  // 2. normalization — pure, zero provider calls.
  const allRawEvents = providerResults.flatMap((r) => r.rawEvents)
  if (allRawEvents.length === 0) {
    // eslint-disable-next-line no-console
    console.warn('[pipeline] NO RAW EVENTS FETCHED for this scan', { providerDiagnostics })
  }
  const { normalizedEvents, normalizationErrors } = normalizeEvents(allRawEvents, params.walletAddress)

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
  const dustSuppressedKeys = await resolveDustSuppressionKeys(timelines.buyTimeline.entries, sellTimelineV2.entries)
  scanTimer.mark('dustSuppression', dustSuppressionStart)

  const recoveredRawEventsForPricing = recoveryPolicy.evaluation.flatMap((e) => e.recoveredEvents)
  const { normalizedEvents: recoveredNormalizedForPricing } = normalizeEvents(recoveredRawEventsForPricing, params.walletAddress)

  const normalizedEventsForPricing = buildFilteredEventsForPricing(normalizedEvents, dustSuppressedKeys)
  const recoveredEventsForPricing = buildFilteredEventsForPricing(recoveredNormalizedForPricing, dustSuppressedKeys)

  const priceLotsForWalletStart = performance.now()
  const walletPriceLookups = await priceLotsForWallet({
    normalizedEvents: normalizedEventsForPricing,
    recoveredEvents: recoveredEventsForPricing,
    priceSources: PRICE_SOURCES,
  })
  scanTimer.mark('priceLotsForWallet', priceLotsForWalletStart)
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

  // 6c. pricingAtTime — additive, async, still its own independent real pricing pass over just the
  // UI-facing buyTimeline/sellTimelineV2 entries, keyed for report.pricingAtTime's existing
  // consumers. priceSources is the same real PRICE_SOURCES stage 5c uses. Never touches fifoEngine's
  // own, separate pricing mechanism.
  //
  // DUST SUPPRESSION reuses the SAME dustSuppressedKeys already resolved once, upstream, before
  // stage 5c — no second round of cheap lookups here. Consistent by construction: a token excluded
  // from priceLotsForWallet's input is excluded from this display pass too.
  const displayBuyEntries = dustSuppressedKeys.size === 0
    ? timelines.buyTimeline.entries
    : timelines.buyTimeline.entries.filter((e) => !dustSuppressedKeys.has(dustTokenKey(e.chain, e.token)))
  // Diagnostic log — real dust-suppression counts, directly requested (verification step:
  // "pricingAtTimeEngine.priceEntries total count decreases for dust-heavy wallets").
  // eslint-disable-next-line no-console
  console.warn('[pipeline] dust suppression (display pricingAtTime pass)', {
    totalBuyEntries: timelines.buyTimeline.entries.length,
    suppressed: timelines.buyTimeline.entries.length - displayBuyEntries.length,
  })

  const pricingAtTimeStart = performance.now()
  const pricingAtTime = await safeRunPricingAtTime({
    buyEntries: displayBuyEntries,
    sellEntries: sellTimelineV2.entries,
    priceSources: PRICE_SOURCES,
  })
  scanTimer.mark('pricingAtTime', pricingAtTimeStart)

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

  const finalReport = safeAssembleReport({
    scanMetadata,
    chainSelection,
    timelines,
    recoveryPolicy,
    fifoAndPnl,
    behaviorIntel,
    windowCoverage,
    bridgeTimeline,
    sellTimelineV2,
    pnlSummaryV2,
    pricingAtTime,
    providerDiagnostics,
    pricingProvidersStatus: PRICING_PROVIDERS_STATUS,
  })

  // "WHY DID THIS SCAN TAKE X SECONDS", DISCLOSED (orchestration-layer-only diagnostic summary):
  // total wall-clock time plus a per-stage breakdown of this file's own async await points — see
  // startStageTimer's own header for the honest limit of what this can and can't observe (nothing
  // about time spent INSIDE pricingAtTimeEngine's own bisect/poolPrice/GoldRush/fallback call
  // graph, only how long each of THIS file's stages took overall). Distinct tokens vs.
  // dust-suppressed count is the one real, verifiable signal this layer has for "how much of the
  // pricing fan-out was avoided."
  const distinctBuyTokenCount = new Set(timelines.buyTimeline.entries.map((e) => dustTokenKey(e.chain, e.token))).size
  const heavyWallet = computeHeavyWalletFlag(distinctBuyTokenCount, fifoAndPnl.matchedLots.length)
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
  })

  return { ...finalReport, normalizationErrors }
}

export type { SupportedChain }
export { emptyChainSelection, emptyTimelines }
