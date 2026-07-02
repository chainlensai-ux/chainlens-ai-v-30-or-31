// MODULE 8 — finalReportAssembler: type definitions.
//
// Pure merge — combines every upstream section into the Step 5 unified report shape. This module
// MUST NOT modify any upstream section (Architecture Step 9 §1/§7); every section type below is
// imported verbatim from its producing module, never redefined or reshaped here.

import type { ChainSelectionResult } from '../chainSelection/types'
import type { FifoOutput } from '../fifoEngine/types'
import type { RecoveryPolicyResult } from '../recoveryPolicy/types'
import type { BehaviorIntelResult, WindowCoverage } from '../behaviorIntel/types'
import type { SupportedChain } from '../providerFetchWindow/types'
import type { TimelineBuilderResult } from '../timelineBuilder/types'
import type { BridgeCandidateEvent } from '../bridgeDetection/types'
import type { SellTimelineResult } from '../sellTimeline/types'
import type { PnlSummaryResult } from '../pnlEngine/types'
import type { PricingAtTimeResult } from '../pricingAtTimeEngine/types'
import type { ProviderFetchWindowResult } from '../providerFetchWindow/types'

export type ScanMode = 'normal' | 'deep'

export type ScanMetadata = {
  walletAddress: string
  scanTimestamp: string
  intel_window_days: number
  provider_fetch_window_days: number
  scanMode: ScanMode
  chainsScanned: SupportedChain[]
}

export type FinancialStatusSummary = {
  officialPnlStatus: FifoOutput['publicPnlStatus']
  headline: string
}

export type BehavioralStatusSummary = {
  riskOnOff: BehaviorIntelResult['riskOnOff']['value']
  rotationStyle: BehaviorIntelResult['rotationStyle']['value']
}

export type FinalSummary = {
  walletPersonality: string
  financialStatus: FinancialStatusSummary
  behavioralStatus: BehavioralStatusSummary
  chainParticipationSummary: string
  recoverySummary: string
}

// timelineBuilder's own output (buyTimeline/sellTimeline/distributionTimeline) PLUS the additive
// sellTimelineV2 field (src/modules/sellTimeline) grafted on alongside it. timelineBuilder itself
// is never modified or made aware of sellTimeline — this type only exists at the report-assembly
// layer, so `timelines.sellTimeline` (existing, still consumed by fifoEngine/behaviorIntel/UI)
// stays byte-for-byte identical to what timelineBuilder produces.
export type ReportTimelines = TimelineBuilderResult & {
  sellTimelineV2: SellTimelineResult
}

export type FinalReport = {
  scanMetadata: ScanMetadata
  chainSelection: ChainSelectionResult
  timelines: ReportTimelines
  recoveryPolicy: RecoveryPolicyResult
  fifoAndPnl: FifoOutput
  behaviorIntel: BehaviorIntelResult
  windowCoverage: WindowCoverage
  finalSummary: FinalSummary
  // Additive section — cross-chain bridge candidates (src/modules/bridgeDetection). Never
  // required by any other section above; a caller that ignores this field sees the exact same
  // report shape the engine produced before this field existed.
  bridgeTimeline: BridgeCandidateEvent[]
  // Additive section — real closedLots/winLossRate/chainBreakdown read model over sellTimelineV2 +
  // buyTimeline entries (src/modules/pnlEngine). Does NOT replace or read from fifoAndPnl above
  // (the real, existing FIFO PnL engine) — see pnlEngine/types.ts for the full rationale. A caller
  // that ignores this field sees the exact same report shape the engine produced before it existed.
  pnlSummaryV2: PnlSummaryResult
  // Additive section — real historical USD pricing for buyTimeline/sellTimelineV2 entries, keyed
  // by txHash (src/modules/pricingAtTimeEngine). Does NOT modify fifoEngine's own separate pricing
  // mechanism. A caller that ignores this field sees the exact same report shape the engine
  // produced before it existed.
  pricingAtTime: PricingAtTimeResult
  // Additive section — real, honest summary of stage 1's per-chain provider fetch outcomes
  // (ok/errorReason/event count for GoldRush and Alchemy independently). Never includes raw
  // provider payloads (see ProviderDiagnosticsEntry's own doc comment) — this is a status/count
  // summary only, for verifying "did the provider calls actually run", not a data dump.
  providerDiagnostics: ProviderDiagnosticsEntry[]
  // Additive section — real status of the pricing source(s) actually wired up in this codebase.
  // There is exactly ONE real pricing provider today (GoldRush/Covalent — same API key, either
  // env var name), used as pricingAtTimeEngine's `primary` source; `fallback` is always
  // noPriceSources()'s honest no-op (see pipeline/index.ts buildPriceSources()). This deliberately
  // does NOT report an "alchemy" pricing provider — Alchemy is never used for pricing anywhere in
  // this codebase (only for raw event fetching in providerFetchWindow/recoveryPolicy); reporting
  // it here would be a fabricated capability claim.
  pricingProvidersStatus: PricingProvidersStatus
}

export type PricingProvidersStatus = {
  goldrush: { active: boolean; keyLoaded: boolean }
  providerCount: number
  pricingEnabled: boolean
}

// Real per-provider fetch outcome for one chain — ok/errorReason/count only, deliberately never the
// raw events themselves (raw provider payloads are never returned to a client anywhere in this
// codebase; recoveryPolicy's own response already strips recoveredEvents down to a count for the
// same reason).
export type ProviderCallDiagnostics = {
  ok: boolean
  errorReason: string | null
  eventCount: number
}

export type ProviderDiagnosticsEntry = {
  chain: SupportedChain
  providerStatus: ProviderFetchWindowResult['providerStatus']
  goldrush: ProviderCallDiagnostics
  alchemy: ProviderCallDiagnostics
}

export type AssembleReportInput = {
  scanMetadata: ScanMetadata
  chainSelection: ChainSelectionResult
  timelines: TimelineBuilderResult
  recoveryPolicy: RecoveryPolicyResult
  fifoAndPnl: FifoOutput
  behaviorIntel: BehaviorIntelResult
  windowCoverage: WindowCoverage
  bridgeTimeline: BridgeCandidateEvent[]
  // Additive — see ReportTimelines. Grafted onto `timelines` by assembleReport, never merged into
  // or read by timelineBuilder's own TimelineBuilderResult.
  sellTimelineV2: SellTimelineResult
  // Additive — see FinalReport.pnlSummaryV2 above.
  pnlSummaryV2: PnlSummaryResult
  // Additive — see FinalReport.pricingAtTime above.
  pricingAtTime: PricingAtTimeResult
  // Additive — see FinalReport.providerDiagnostics above.
  providerDiagnostics: ProviderDiagnosticsEntry[]
  // Additive — see FinalReport.pricingProvidersStatus above.
  pricingProvidersStatus: PricingProvidersStatus
}
