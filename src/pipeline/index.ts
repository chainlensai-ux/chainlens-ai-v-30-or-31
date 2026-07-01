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
  pnlSummaryV2Fallback,
  recoveryPolicyFallback,
  sellTimelineV2Fallback,
  validatePreScan,
} from './utils'

export type { PreScanValidation, RunWalletScanParams, RunWalletScanResult } from './types'
export { INTEL_WINDOW_DAYS, SUPPORTED_CHAINS } from './types'

const PROVIDER_FETCH_WINDOW_DAYS_USED = 90

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

function safeRunFifoEngine(params: {
  normalizedEvents: NormalizedEvent[]
  recoveryPolicy: RecoveryPolicyResult
  walletAddress: string
  buyTimeline: BuyTimeline
  sellTimeline: SellTimeline
}): FifoOutput {
  try {
    const recoveredRawEvents: RawProviderEvent[] = params.recoveryPolicy.evaluation.flatMap((e) => e.recoveredEvents)
    return buildFifoOutput({
      normalizedEvents: params.normalizedEvents,
      recoveredRawEvents,
      walletAddress: params.walletAddress,
    })
  } catch {
    return fifoEngineFallback(params.buyTimeline, params.sellTimeline)
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

// Additive, pure, zero-cost — read model over real sellTimelineV2.entries + buyTimeline.entries
// (src/modules/pnlEngine). Never touches fifoEngine/fifoAndPnl (the real, existing PnL engine) at
// all. Pricing resolvers default to undefined here, which buildPnlSummary itself treats as "read
// each entry's own real (always-null today) field" — never a fabricated cost/proceeds value.
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

  // 1. providerFetchWindow — the ONLY per-chain network call in the base pipeline.
  const providerResults = await Promise.all(
    preScan.sanitizedChains.map((chain) => fetchProviderWindow(chain, params.walletAddress, PROVIDER_FETCH_WINDOW_DAYS_USED)),
  )

  // 2. normalization — pure, zero provider calls.
  const allRawEvents = providerResults.flatMap((r) => r.rawEvents)
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

  // 5c. pnlSummaryV2 — additive, pure, zero-cost. Runs after sellTimelineV2 (stage 5b) and
  // recoveryPolicy (stage 5), before behaviorIntel and final assembly. Pricing resolvers are left
  // undefined (buildPnlSummary's own default: read each entry's real, always-null field) — never
  // a client-suppliable or fabricated value. Never touches fifoEngine/fifoAndPnl below.
  const pnlSummaryV2 = safeRunPnlSummaryV2({
    sellEntries: sellTimelineV2.entries,
    buyEntries: timelines.buyTimeline.entries,
  })

  // 6. fifoEngine — pure, no provider calls; consumes normalized events + recoveryPolicy's
  // already-fetched recoveredEvents only.
  const fifoAndPnl = safeRunFifoEngine({
    normalizedEvents,
    recoveryPolicy,
    walletAddress: params.walletAddress,
    buyTimeline: timelines.buyTimeline,
    sellTimeline: timelines.sellTimeline,
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
  })

  return { ...finalReport, normalizationErrors }
}

export type { SupportedChain }
export { emptyChainSelection, emptyTimelines }
