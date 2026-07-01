// MODULE 9 — pipelineOrchestrator: pure helper functions.

import type { ChainSelectionResult } from '../modules/chainSelection/types'
import type { BehaviorIntelResult, WindowCoverage } from '../modules/behaviorIntel/types'
import type { FifoOutput } from '../modules/fifoEngine/types'
import type { RecoveryPolicyResult } from '../modules/recoveryPolicy/types'
import type { BuyTimeline, DistributionTimeline, SellTimeline, TimelineBuilderResult } from '../modules/timelineBuilder/types'
import type { FinalReport, FinalSummary, ScanMetadata } from '../modules/finalReportAssembler/types'
import { DEFAULT_RECOVERY_CAPS, DEFAULT_TRIGGER_RECOVERY_WHEN } from '../modules/recoveryPolicy/types'
import type { SellTimelineResult } from '../modules/sellTimeline/types'
import type { PnlSummaryResult } from '../modules/pnlEngine/types'
import type { PreScanValidation, RunWalletScanParams } from './types'
import { APPROX_DAYS_COVERED_PER_RECOVERED_PAGE, INTEL_WINDOW_DAYS, SUPPORTED_CHAINS } from './types'

const ADDRESS_RE = /^0x[a-f0-9]{40}$/i

// PURE. Architecture Step 6 §1 pre-scan validation. Never throws — always returns a result object
// the orchestrator can act on, degrading safely (Step 7) rather than crashing on a bad request.
export function validatePreScan(params: RunWalletScanParams): PreScanValidation {
  const errors: string[] = []

  if (!params.walletAddress || !ADDRESS_RE.test(params.walletAddress)) {
    errors.push('walletAddress must be a structurally valid address')
  }
  if (!Array.isArray(params.chains) || params.chains.length === 0) {
    errors.push('chains must be a non-empty array')
  }
  if (params.scanMode !== 'normal' && params.scanMode !== 'deep') {
    errors.push("scanMode must be exactly 'normal' or 'deep'")
  }

  const sanitizedChains = (Array.isArray(params.chains) ? params.chains : [])
    .filter((c): c is (typeof SUPPORTED_CHAINS)[number] => SUPPORTED_CHAINS.includes(c as (typeof SUPPORTED_CHAINS)[number]))

  if (Array.isArray(params.chains) && params.chains.length > 0 && sanitizedChains.length === 0) {
    errors.push('none of the requested chains are supported')
  }

  return { valid: errors.length === 0 && sanitizedChains.length > 0, errors, sanitizedChains }
}

// PURE. Architecture Step 1 / Step 7 §8: realDataDays + inferredDays + recoveredExtraDays must
// always equal intel_window_days exactly. recoveredExtraDays is a conservative, capped estimate —
// it can never exceed how much of the window was still inferred before recovery ran.
export function computeWindowCoverage(providerFetchWindowDays: number, totalPagesUsedThisWallet: number): WindowCoverage {
  const realDataDays = providerFetchWindowDays
  const inferrableRemainder = Math.max(0, INTEL_WINDOW_DAYS - realDataDays)
  const recoveredExtraDays = Math.min(inferrableRemainder, totalPagesUsedThisWallet * APPROX_DAYS_COVERED_PER_RECOVERED_PAGE)
  const inferredDays = INTEL_WINDOW_DAYS - realDataDays - recoveredExtraDays

  const coverageBasis: WindowCoverage['coverageBasis'] = inferredDays === 0
    ? 'full_window'
    : recoveredExtraDays > 0
      ? 'partial_window_plus_targeted_recovery'
      : 'partial_window'

  return { realDataDays, inferredDays, recoveredExtraDays, coverageBasis }
}

// Architecture Step 7 §5 fallback shape — recoveryPolicy skip mode.
export function recoveryPolicyFallback(): RecoveryPolicyResult {
  return {
    triggerRecoveryWhen: DEFAULT_TRIGGER_RECOVERY_WHEN,
    caps: DEFAULT_RECOVERY_CAPS,
    evaluation: [],
    totalPagesUsedThisWallet: 0,
  }
}

// Architecture Step 7 §6 fallback shape — fifoEngine degraded mode.
export function fifoEngineFallback(buyTimeline: BuyTimeline, sellTimeline: SellTimeline): FifoOutput {
  return {
    matchedLots: [],
    unmatchedBuys: buyTimeline.totalBuys,
    unmatchedSells: sellTimeline.totalSells,
    realizedPnlUsd: null,
    unrealizedPnlUsd: null,
    costBasisUsd: null,
    publicPnlStatus: 'unavailable',
    integrityFlags: { hardInvalid: true, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 },
  }
}

// Architecture Step 7 §7 fallback shape — behaviorIntel unknown mode.
export function behaviorIntelFallback(chainSelection: ChainSelectionResult): BehaviorIntelResult {
  return {
    rotationStyle: { value: 'unknown', basis: { buyCount: 0, sellCount: 0, distributionCount: 0, distinctTokensTraded: 0 } },
    riskOnOff: { value: 'unknown', basis: 'behaviorIntel could not be computed' },
    multiChainParticipation: {
      activeChains: chainSelection.chains.filter((c) => c.status === 'active_intelligence').map((c) => c.chain),
      primaryChain: null,
      chainSelectionRef: { activeChainCount: chainSelection.activeChainCount, dustChainCount: chainSelection.dustChainCount },
      chainsWithRealSells: [],
      chainsPendingSellEvidence: [],
    },
    concentrationSignals: null,
    automationSignals: { suspectedBot: false, signals: [] },
    confidence: 'low',
    confidenceBasis: { chainSelectionFactor: 'unavailable', windowCoverageFactor: 'unavailable', sellEvidenceFactor: 'unavailable' },
    exitVelocity: { medianMsBetweenSells: null, basis: 'behaviorIntel could not be computed' },
    convictionScore: { value: 'unknown', basis: 'behaviorIntel could not be computed' },
  }
}

// Architecture Step 7 §4 — empty timelines are a valid, always-present, zero-cost outcome.
export function emptyTimelines(): TimelineBuilderResult {
  const chainContext = { includedChains: [], excludedChains: [] }
  return {
    buyTimeline: { totalBuys: 0, chainContext, entries: [] },
    sellTimeline: { totalSells: 0, chainContext, entries: [] },
    distributionTimeline: { totalDistributions: 0, chainContext, entries: [] },
  }
}

export function emptyChainSelection(): ChainSelectionResult {
  return { chains: [], activeChainCount: 0, dustChainCount: 0 }
}

// Additive fallback shape — bridgeDetection unavailable/degraded mode. An empty candidate list is
// always a valid, honest outcome (it means "no cross-chain pair matched the heuristic", never
// "bridging did not happen").
export function bridgeTimelineFallback(): FinalReport['bridgeTimeline'] {
  return []
}

// Additive fallback shape — sellTimelineV2 unavailable/degraded mode. Same honesty rule: an empty
// entries list means "no evidence found for a sell via any of the four mechanisms", never "no
// sells happened".
export function sellTimelineV2Fallback(): SellTimelineResult {
  return { totalSells: 0, chainContext: { includedChains: [], excludedChains: [] }, entries: [] }
}

// Additive fallback shape — pnlSummaryV2 unavailable/degraded mode. Empty closedLots + null
// realizedPnlUsd is the same honest "no evidence" outcome buildPnlSummary itself produces when
// given zero sellEntries — never a fabricated 0.
export function pnlSummaryV2Fallback(): PnlSummaryResult {
  return {
    realizedPnlUsd: null,
    closedLots: [],
    winLossRate: { wins: 0, losses: 0, evaluated: 0, rate: null },
    chainBreakdown: [],
    confidenceBasis: { high: 0, medium: 0, low: 0, aggregate: 'unavailable' },
    evidenceMissingCount: 0,
  }
}

// Architecture Step 7 §9 fallback strings — used only when assembly itself cannot run (e.g. an
// invalid pre-scan request). Fixed, non-committal language, never a fabricated narrative.
export function finalSummaryFallback(): FinalSummary {
  return {
    walletPersonality: 'Insufficient data to classify wallet behavior.',
    financialStatus: { officialPnlStatus: 'unavailable', headline: 'PnL unavailable due to missing evidence.' },
    behavioralStatus: { riskOnOff: 'unknown', rotationStyle: 'unknown' },
    chainParticipationSummary: 'Some chains unavailable due to provider errors.',
    recoverySummary: 'No recovery attempted.',
  }
}

// Builds a fully-degraded but shape-complete report — used only when pre-scan validation fails or
// an unrecoverable error occurs before any section could be produced. Every field is an explicit
// Step 7 fallback value; nothing here is fabricated or guessed.
export function buildFullyDegradedReport(
  params: RunWalletScanParams,
  scanTimestamp: string,
  providerFetchWindowDays: number,
): FinalReport {
  const chainSelection = emptyChainSelection()
  const scanMetadata: ScanMetadata = {
    walletAddress: params.walletAddress,
    scanTimestamp,
    intel_window_days: INTEL_WINDOW_DAYS,
    provider_fetch_window_days: providerFetchWindowDays,
    scanMode: params.scanMode === 'deep' ? 'deep' : 'normal',
    chainsScanned: [],
  }
  return {
    scanMetadata,
    chainSelection,
    timelines: { ...emptyTimelines(), sellTimelineV2: sellTimelineV2Fallback() },
    recoveryPolicy: recoveryPolicyFallback(),
    fifoAndPnl: fifoEngineFallback(emptyTimelines().buyTimeline, emptyTimelines().sellTimeline),
    behaviorIntel: behaviorIntelFallback(chainSelection),
    windowCoverage: computeWindowCoverage(providerFetchWindowDays, 0),
    finalSummary: finalSummaryFallback(),
    bridgeTimeline: bridgeTimelineFallback(),
    pnlSummaryV2: pnlSummaryV2Fallback(),
  }
}
