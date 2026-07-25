// app/frontend/lib/walletScannerDiagnosticsSelector.ts — pure summary-count selector for the V3
// "Advanced Diagnostics" section (WalletScannerDiagnosticsV3.tsx).
//
// HONESTY NOTE, DISCLOSED (Wallet Scanner V3 layout task, explicit "do not invent" requirement): the
// approved visual reference showed fabricated-looking tiles ("Scan Health 20/100", "Evidence 117%
// Confidence", "Risk Posture") that do not correspond to any real field this engine computes. Rather
// than invent a scoring formula to match that appearance, this selector reports only REAL, already-
// computed counts — how many wallet-condition notes exist, how many recovery evaluations were
// triggered vs attempted, the real window-coverage basis string, and how many modules fell back —
// so the collapsed summary line is always a plain restatement of real data, never a fabricated score.

import type { WalletConditionSection } from '@/src/pipeline/walletConditionMessages'
import type { RecoveryPolicyResult } from '@/src/modules/recoveryPolicy/types'
import type { WindowCoverage } from '@/src/modules/behaviorIntel/types'

export type DiagnosticsSummary = {
  walletConditionCount: number
  recoveryTriggeredCount: number
  recoveryEvaluatedCount: number
  windowCoverageBasis: string | null
  moduleErrorCount: number
}

export function selectDiagnosticsSummary(params: {
  walletConditionMessages?: WalletConditionSection[] | null
  recoveryPolicy?: RecoveryPolicyResult | null
  windowCoverage?: WindowCoverage | null
  moduleErrors?: Record<string, string> | null
}): DiagnosticsSummary {
  const evaluation = Array.isArray(params.recoveryPolicy?.evaluation) ? params.recoveryPolicy!.evaluation : []
  return {
    walletConditionCount: Array.isArray(params.walletConditionMessages) ? params.walletConditionMessages.length : 0,
    recoveryTriggeredCount: evaluation.filter((e) => e.recoveryTriggered).length,
    recoveryEvaluatedCount: evaluation.length,
    windowCoverageBasis: params.windowCoverage?.coverageBasis ?? null,
    moduleErrorCount: params.moduleErrors ? Object.keys(params.moduleErrors).length : 0,
  }
}
