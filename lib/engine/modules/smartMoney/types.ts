// lib/engine/modules/smartMoney/types.ts — shared types for the Smart Money Score module.
//
// REBUILT, DISCLOSED (this task's own audit + rebuild): the previous shape (SmartMoneyScoreComponents
// with pnlScore/behaviorScore/personalityScore/chainActivityScore/riskScore/signalsScore, weighted
// 30/25/20/15/10/10) mixed real verified-performance evidence with purely descriptive fields
// (personality archetype, chain activity level, generic signal counts) that don't independently
// prove trading skill — see computeSmartMoneyScore.ts's own header for the full audit trail. This
// file's shapes now match the REQUIRED official model this task specifies: six performance/behavior
// categories, a SEPARATE evidence-confidence model, and an explicit not-yet-rated gate so a thin
// verified sample never gets dressed up as a confident numeric score.

export type SmartMoneyPerformanceBreakdown = {
  // Each is 0-100 or null — null means THIS category's own real inputs were unavailable (never a
  // fabricated 0/50 default; see computeSmartMoneyScore.ts's own combine logic).
  verifiedProfitability: number | null
  verifiedWinQuality: number | null
  riskAdjustedPerformance: number | null
  timingQuality: number | null
  consistency: number | null
  // The ONE allowed non-performance category (10% weight cap) — real BehaviorV2 fields, never
  // personality/activity/chain-count/wallet-age.
  behaviorQuality: number | null
}

export type SmartMoneyEvidenceConfidenceLevel = 'low' | 'medium' | 'high'

export type SmartMoneyEvidenceConfidence = {
  value: number // 0-1
  level: SmartMoneyEvidenceConfidenceLevel
  fullyPricedTradeCount: number
  // CANONICAL-UNAVAILABLE FIX, DISCLOSED (this task's own explicit rule): `null` when the
  // canonical FIFO result itself was unavailable this scan — NEVER fabricated as 0. `0` is a real,
  // distinct outcome meaning FIFO ran and genuinely found zero closed lots. See
  // adaptFifoMatchedLots.ts's own header for the full trace of where this distinction is made.
  totalMatchedLotCount: number | null
  verifiedCoveragePercent: number | null // 0-100 — fullyPricedTradeCount / totalMatchedLotCount
  historyDays: number | null
}

export type SmartMoneyScoreStatus = 'official' | 'not_yet_rated'

export type SmartMoneyScore = {
  status: SmartMoneyScoreStatus
  // 0-100, or null when status === 'not_yet_rated' — an official score is NEVER published below
  // the verified-evidence gate (see MIN_VERIFIED_TRADES_FOR_OFFICIAL/MIN_COVERAGE_FOR_OFFICIAL).
  officialScore: number | null
  // Optional, clearly separate from officialScore — the SAME weighted-average combine the official
  // score itself uses (combineBreakdown), computed over whatever breakdown categories this wallet's
  // real evidence already supports, BEFORE the verified-evidence gate is checked. Only meaningful
  // when status === 'not_yet_rated'; null only when every breakdown category is null (no real data
  // at all yet — see computeSmartMoneyScore.ts's own header for the full trace of this widening).
  // NEVER presented as, or substituted for, the official Smart Money Score — UI callers must label
  // it "provisional"/"not official" wherever shown.
  provisionalBehaviorScore: number | null
  evidenceConfidence: SmartMoneyEvidenceConfidence
  breakdown: SmartMoneyPerformanceBreakdown
  notes: string[]
  // Human-readable reason the gate wasn't cleared — null when status === 'official'.
  reasonNotRated: string | null
}
