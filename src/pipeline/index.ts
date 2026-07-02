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
import type { BuyTimeline, SellTimeline, TimelineBuilderResult } from '../modules/timelineBuilder/types'
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
import type { PriceableEntry, PriceSources, PricingAtTimeResult } from '../modules/pricingAtTimeEngine/types'
import { GoldRushClient } from '@covalenthq/client-sdk'
import { goldrushPriceSource } from '../modules/pricingAtTimeEngine/sources/goldrushPriceSource'
import { priceLotsForWallet } from './priceLotsForWallet'
import type { MatchedLot } from '../modules/fifoEngine/types'

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
// module load, since the API key doesn't change per-request. Falls back to noPriceSources()
// (honestly always null) when no real key is configured — this environment has no
// GOLDRUSH_API_KEY/COVALENT_API_KEY set, so every real scan run here will honestly resolve every
// price as null via this exact fallback, never a fabricated one. `fallback` stays noPriceSources()
// always — no second real price provider is wired up in this codebase.
function buildPriceSources(): PriceSources {
  const apiKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY
  // Diagnostic log (never prints the key itself) — the fastest way to confirm, from the actual
  // runtime's own logs (e.g. Vercel's function logs), whether a real key was found in *that*
  // process's env at module load, without needing a separate deployment-inspection tool.
  // eslint-disable-next-line no-console
  console.warn(`[pipeline] buildPriceSources: real GoldRush key present = ${Boolean(apiKey)}`)
  if (!apiKey) return noPriceSources()
  const client = new GoldRushClient(apiKey)
  return { primary: goldrushPriceSource(client), fallback: noPriceSources().fallback }
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

export async function runWalletScan(params: RunWalletScanParams): Promise<RunWalletScanResult> {
  const scanTimestamp = new Date().toISOString()

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
  const providerResults = await Promise.all(
    preScan.sanitizedChains.map((chain) => fetchProviderWindow(chain, params.walletAddress, PROVIDER_FETCH_WINDOW_DAYS_USED)),
  )

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
  const recoveryPolicy = await safeRunRecoveryPolicy({
    buyTimeline: timelines.buyTimeline,
    sellTimeline: timelines.sellTimeline,
    walletAddress: params.walletAddress,
    scanMode: params.scanMode,
  })

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
  const recoveredRawEventsForPricing = recoveryPolicy.evaluation.flatMap((e) => e.recoveredEvents)
  const { normalizedEvents: recoveredNormalizedForPricing } = normalizeEvents(recoveredRawEventsForPricing, params.walletAddress)
  const walletPriceLookups = await priceLotsForWallet({
    normalizedEvents,
    recoveredEvents: recoveredNormalizedForPricing,
    priceSources: PRICE_SOURCES,
  })
  // Diagnostic log — real pricing call outcomes for this wallet's actual events (source breakdown
  // exposed on the lookups themselves, see priceLotsForWallet.ts).
  // eslint-disable-next-line no-console
  console.warn('[pipeline] priceLotsForWallet: pricing source breakdown', walletPriceLookups.sourceBreakdown)

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

  // 6c. pricingAtTime — additive, async, unchanged from before (still its own independent real
  // pricing pass over just the UI-facing buyTimeline/sellTimelineV2 entries, keyed for
  // report.pricingAtTime's existing consumers). priceSources is the same real PRICE_SOURCES stage
  // 5c uses. Never touches fifoEngine's own, separate pricing mechanism.
  const pricingAtTime = await safeRunPricingAtTime({
    buyEntries: timelines.buyTimeline.entries,
    sellEntries: sellTimelineV2.entries,
    priceSources: PRICE_SOURCES,
  })

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

  return { ...finalReport, normalizationErrors }
}

export type { SupportedChain }
export { emptyChainSelection, emptyTimelines }
