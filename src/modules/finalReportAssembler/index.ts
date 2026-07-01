// MODULE 8 — finalReportAssembler
//
// Pure merge — combines every upstream section into the Step 5 unified report shape. This module
// MUST NOT modify any upstream section: every field below is either spread verbatim from its
// producing module's output, or (finalSummary only) a strict, traceable restatement of one —
// never a new fabricated value, never a hidden gap, never an inflated confidence claim
// (Architecture Step 6 §8, Step 9 §1/§7/§8).

import type { AssembleReportInput, FinalReport, FinalSummary } from './types'
import {
  buildChainParticipationSummary,
  buildFinancialStatusHeadline,
  buildRecoverySummary,
  buildWalletPersonality,
} from './utils'

export type {
  AssembleReportInput,
  BehavioralStatusSummary,
  FinalReport,
  FinalSummary,
  FinancialStatusSummary,
  ScanMetadata,
  ScanMode,
} from './types'

function buildFinalSummary(input: AssembleReportInput): FinalSummary {
  return {
    walletPersonality: buildWalletPersonality(input.behaviorIntel),
    financialStatus: {
      officialPnlStatus: input.fifoAndPnl.publicPnlStatus,
      headline: buildFinancialStatusHeadline(input.fifoAndPnl),
    },
    behavioralStatus: {
      riskOnOff: input.behaviorIntel.riskOnOff.value,
      rotationStyle: input.behaviorIntel.rotationStyle.value,
    },
    chainParticipationSummary: buildChainParticipationSummary(input.chainSelection),
    recoverySummary: buildRecoverySummary(input.recoveryPolicy),
  }
}

// PURE. Assembles the final unified report. Every upstream section is passed through unchanged —
// this function never edits scanMetadata, chainSelection, timelines, recoveryPolicy, fifoAndPnl,
// or behaviorIntel; it only reads them to derive the new, clearly-separate finalSummary section.
export function assembleReport(input: AssembleReportInput): FinalReport {
  return {
    scanMetadata: input.scanMetadata,
    chainSelection: input.chainSelection,
    // Existing timelineBuilder output spread through untouched, with sellTimelineV2 grafted on
    // alongside it — report.timelines.sellTimeline (and buyTimeline/distributionTimeline) remain
    // byte-for-byte what timelineBuilder produced; nothing here reshapes or reads them.
    timelines: { ...input.timelines, sellTimelineV2: input.sellTimelineV2 },
    recoveryPolicy: input.recoveryPolicy,
    fifoAndPnl: input.fifoAndPnl,
    behaviorIntel: input.behaviorIntel,
    windowCoverage: input.windowCoverage,
    finalSummary: buildFinalSummary(input),
    bridgeTimeline: input.bridgeTimeline,
    pnlSummaryV2: input.pnlSummaryV2,
    pricingAtTime: input.pricingAtTime,
  }
}
