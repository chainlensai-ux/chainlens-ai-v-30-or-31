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

export type FinalReport = {
  scanMetadata: ScanMetadata
  chainSelection: ChainSelectionResult
  timelines: TimelineBuilderResult
  recoveryPolicy: RecoveryPolicyResult
  fifoAndPnl: FifoOutput
  behaviorIntel: BehaviorIntelResult
  windowCoverage: WindowCoverage
  finalSummary: FinalSummary
  // Additive section — cross-chain bridge candidates (src/modules/bridgeDetection). Never
  // required by any other section above; a caller that ignores this field sees the exact same
  // report shape the engine produced before this field existed.
  bridgeTimeline: BridgeCandidateEvent[]
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
}
