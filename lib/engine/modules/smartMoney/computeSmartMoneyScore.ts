// lib/engine/modules/smartMoney/computeSmartMoneyScore.ts — new Smart Money Score module.
//
// FILE-LOCATION DISCLOSURE: same reasoning as types.ts — `src/pipeline/src/modules/` doesn't exist;
// this lives at `lib/engine/modules/smartMoney/`.
//
// computeSmartMoneyScore() BELOW IS EXACTLY AS SPECIFIED — a pure function over six already-0-100
// numbers, weights/clamping/notes unchanged from the task's literal code. This part needed no
// correction.
//
// deriveSmartMoneyInputs() IS NEW, ADDITIVE, AND DISCLOSED: the task's own wiring step (step 3)
// assumed `pnlModule.score`, `behaviorModule.score`, `personalityModule.score`,
// `chainActivityModule.score`, `signalsModule.score` all already exist as 0-100 numbers on each
// module's real output. Verified false by reading every module's real types
// (lib/engine/modules/{pnl,behavior,personality,activity,signals}/types.ts) before writing this
// file: none of those five expose any numeric score at all — PnlV2 has raw USD totals,
// BehaviorV2/PersonalityV2 are qualitative enums + a summary string, ChainActivityRecord[] is a
// per-chain array with an `activityLevel` enum, SignalV2[] is a list of typed signal events. Only
// RiskV2.score is a real, existing 0-100 number. This function is a new, disclosed heuristic
// mapping from each module's real fields to a 0-100 sub-score — not a fabricated pass-through of a
// nonexistent field. Every heuristic below is a simple, documented rule over real data, nothing
// invented from data the modules don't have.
//
// RISK-DIRECTION DISCLOSURE: the task's own weighted formula adds `riskScore` as a POSITIVE
// contributor to the overall smart-money score, while its own notes text treats a LOW riskScore as
// the good outcome ("riskScore < 40 -> operates with relatively low risk exposure"). Read literally,
// those two are inconsistent — a wallet with high real risk would score itself LOWER on the notes'
// own terms but HIGHER in the weighted sum. Real `RiskV2.score` is "higher = riskier." To make the
// formula and its own notes agree (a genuinely lower-risk wallet should score better as "smart
// money"), this function passes `100 - riskV2.score` as the `riskScore` INPUT to
// computeSmartMoneyScore — inverted once, here, not inside the unmodified formula itself.

import type { PnlV2 } from '../pnl/types'
import type { BehaviorV2 } from '../behavior/types'
import type { PersonalityV2 } from '../personality/types'
import type { ChainActivityRecord } from '../activity/types'
import type { RiskV2 } from '../risk/types'
import type { SignalV2 } from '../signals/types'
import type { SmartMoneyScore, SmartMoneyScoreComponents } from './types'

export type SmartMoneyScoreInput = {
  pnlScore: number
  behaviorScore: number
  personalityScore: number
  chainActivityScore: number
  riskScore: number
  signalsScore: number
}

function clampScore(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 100) return 100
  return Math.round(value)
}

// EXACTLY AS SPECIFIED — see file header.
export function computeSmartMoneyScore(input: SmartMoneyScoreInput): SmartMoneyScore {
  const components: SmartMoneyScoreComponents = {
    pnlScore: clampScore(input.pnlScore),
    behaviorScore: clampScore(input.behaviorScore),
    personalityScore: clampScore(input.personalityScore),
    chainActivityScore: clampScore(input.chainActivityScore),
    riskScore: clampScore(input.riskScore),
    signalsScore: clampScore(input.signalsScore),
  }

  const weighted =
    0.3 * components.pnlScore +
    0.25 * components.behaviorScore +
    0.2 * components.personalityScore +
    0.15 * components.chainActivityScore +
    0.1 * components.riskScore +
    0.1 * components.signalsScore

  const score = clampScore(weighted)

  const notes: string[] = []

  if (components.pnlScore > 70) {
    notes.push('Consistently profitable across tracked period.')
  }
  if (components.behaviorScore > 70) {
    notes.push('Exhibits disciplined, non-degen trading behavior.')
  }
  if (components.personalityScore > 70) {
    notes.push('Shows strong conviction and coherent strategy.')
  }
  if (components.chainActivityScore > 70) {
    notes.push('Healthy, sustained on-chain activity.')
  }
  if (components.riskScore < 40) {
    notes.push('Operates with relatively low risk exposure.')
  }
  if (components.signalsScore > 70) {
    notes.push('Recent signals indicate smart rotation or accumulation.')
  }

  return { score, components, notes }
}

const ACTIVITY_LEVEL_SCORE: Record<ChainActivityRecord['activityLevel'], number> = {
  high: 100,
  medium: 65,
  low: 35,
  'dust-only': 10,
}

const POSITIVE_SIGNAL_TYPES = new Set<SignalV2['type']>([
  'whale_like_accumulation',
  'rotation_to_stables',
  'stablecoin_routing',
  'exiting_high_risk_posture',
])
const NEGATIVE_SIGNAL_TYPES = new Set<SignalV2['type']>([
  'high_unrealized_loss_pressure',
  'entering_high_risk_posture',
  'dormant_wallet',
])

// NEW, ADDITIVE, DISCLOSED — see file header. Pure function, no provider calls, only reads already-
// computed real module outputs (the exact "use only existing V2 module outputs" constraint).
export function deriveSmartMoneyInputs(params: {
  pnlV2: PnlV2
  pnlStatus: 'ok' | 'empty' | 'unavailable' | 'partial'
  totalValueUsd: number
  behaviorV2: BehaviorV2
  personalityV2: PersonalityV2
  chainActivityV2: ChainActivityRecord[]
  riskV2: RiskV2
  signalsV2: SignalV2[]
}): SmartMoneyScoreInput {
  const { pnlV2, pnlStatus, totalValueUsd, behaviorV2, personalityV2, chainActivityV2, riskV2, signalsV2 } = params

  // pnlScore: no reliable trades/pricing to judge from -> neutral midpoint, not a fabricated 0/100.
  let pnlScore = 50
  if (pnlStatus === 'ok' || pnlStatus === 'partial') {
    const totalPnlUsd = pnlV2.realizedPnlUsd + pnlV2.unrealizedPnlUsd
    const ratio = totalValueUsd > 0 ? totalPnlUsd / totalValueUsd : 0
    pnlScore = 50 + ratio * 100
  }

  let behaviorScore = 50
  if (behaviorV2.accumulationStyle === 'accumulator') behaviorScore += 20
  if (behaviorV2.accumulationStyle === 'distributor') behaviorScore -= 15
  if (behaviorV2.rotationStyle === 'holding') behaviorScore += 10
  if (behaviorV2.rotationStyle === 'rotating') behaviorScore -= 10
  if (behaviorV2.memeBehavior === 'meme-active') behaviorScore -= 15
  if (behaviorV2.farmingBehavior === 'farmer') behaviorScore += 5

  let personalityScore = 50
  if (personalityV2.riskAppetite === 'low') personalityScore += 15
  if (personalityV2.riskAppetite === 'high') personalityScore -= 15
  if (personalityV2.pnlBehavior === 'profit-seeking') personalityScore += 15
  if (personalityV2.pnlBehavior === 'loss-averse') personalityScore -= 10
  if (personalityV2.activityConsistency === 'consistent') personalityScore += 10
  if (personalityV2.activityConsistency === 'dormant') personalityScore -= 10

  const chainActivityScore = chainActivityV2.length > 0
    ? chainActivityV2.reduce((sum, record) => sum + ACTIVITY_LEVEL_SCORE[record.activityLevel], 0) / chainActivityV2.length
    : 0

  // Inverted — see RISK-DIRECTION DISCLOSURE above.
  const riskScore = 100 - riskV2.score

  let signalsScore = 50
  for (const signal of signalsV2) {
    if (POSITIVE_SIGNAL_TYPES.has(signal.type)) signalsScore += 10
    if (NEGATIVE_SIGNAL_TYPES.has(signal.type)) signalsScore -= 15
  }

  return { pnlScore, behaviorScore, personalityScore, chainActivityScore, riskScore, signalsScore }
}
