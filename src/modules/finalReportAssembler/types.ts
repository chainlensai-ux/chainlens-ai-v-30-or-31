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
}
