// Token Scanner risk inputs that used to be scored too generously (app/api/token/route.ts risk block):
//
// 1. Concentrated-liquidity pools (V3 / V4 / Slipstream). LP lock/burn proof does not apply, but the position
//    ownership proof does. A pool used to score as a "protocol-managed liquidity" VERIFIED signal (+3) whatever
//    that proof found, so a single wallet owning the liquidity — the classic pull-the-LP setup, and the common
//    Robinhood V4 shape — never raised risk. Now the proven owner decides; unproven ownership is an open check.
// 2. "Low visible risk" without any sell check. When no buy/sell simulation produced a verdict (unsupported
//    venue, timeout, unavailable), the score cannot clear a token as low risk: the label floor is "watch".

import type { ConcentratedOwnershipStatus } from './lpProof'

/** Share of full-pool liquidity at or above which the top position owner controls the pool. */
export const LP_POSITION_DOMINANT_SHARE_PCT = 50

export type LpProofStatus = 'not_applicable' | 'verified' | 'partial' | 'inferred'

export type ConcentratedLpRisk = {
  kind: 'protocol' | 'burned_or_locked' | 'team_dominant' | 'team_minority' | 'controller_unproven' | 'ownership_unproven'
  scoreDelta: number
  verifiedSignal: string | null
  riskDriver: string | null
  openCheck: string | null
  lpProofStatus: LpProofStatus
  /** True when LP control is still unknown (counts toward the major-missing evidence tally). */
  lpEvidenceMissing: boolean
}

/** PURE. Only for lpState 'concentrated_liquidity' / 'protocol'. */
export function classifyConcentratedLpRisk(input: {
  lpState: string
  proof: { ownershipStatus: ConcentratedOwnershipStatus; topPositionSharePercent: number | null } | null
}): ConcentratedLpRisk {
  const own = input.proof?.ownershipStatus ?? null
  const share = input.proof?.topPositionSharePercent ?? null
  const shareTxt = share != null ? ` (${share.toFixed(1)}% of pool liquidity)` : ''
  // A plain 'protocol' pool with no position proof keeps its existing treatment.
  if (own === 'ownership_verified_protocol' || (input.lpState === 'protocol' && input.proof == null)) {
    return { kind: 'protocol', scoreDelta: 3, verifiedSignal: 'LP Control indicates protocol-managed liquidity structure.', riskDriver: null, openCheck: null, lpProofStatus: 'not_applicable', lpEvidenceMissing: false }
  }
  if (own === 'ownership_verified_team') {
    return share == null || share >= LP_POSITION_DOMINANT_SHARE_PCT
      ? { kind: 'team_dominant', scoreDelta: 28, verifiedSignal: null, riskDriver: `LP Control: the largest liquidity position is owned by a single wallet${shareTxt} — it can be withdrawn at any time.`, openCheck: null, lpProofStatus: 'partial', lpEvidenceMissing: false }
      : { kind: 'team_minority', scoreDelta: 10, verifiedSignal: null, riskDriver: `LP Control: the largest liquidity position is owned by a single wallet${shareTxt}.`, openCheck: null, lpProofStatus: 'partial', lpEvidenceMissing: false }
  }
  if ((own === 'ownership_verified_burned' || own === 'ownership_verified_locked') && share != null && share >= LP_POSITION_DOMINANT_SHARE_PCT) {
    return { kind: 'burned_or_locked', scoreDelta: -12, verifiedSignal: `LP Control: the largest liquidity position is ${own === 'ownership_verified_burned' ? 'burned' : 'locked'}${shareTxt}.`, riskDriver: null, openCheck: null, lpProofStatus: 'verified', lpEvidenceMissing: false }
  }
  if (own != null && own.startsWith('ownership_verified')) {
    // Owner resolved (contract / multisig / minority lock or burn) but withdrawal is not proven blocked.
    return { kind: 'controller_unproven', scoreDelta: 5, verifiedSignal: null, riskDriver: null, openCheck: `LP Control: liquidity position owner resolved${shareTxt}, but it is not proven burned or locked — withdrawal risk should be assumed.`, lpProofStatus: 'partial', lpEvidenceMissing: false }
  }
  return { kind: 'ownership_unproven', scoreDelta: 10, verifiedSignal: null, riskDriver: null, openCheck: 'LP Control: liquidity position ownership not proven — liquidity exit risk should be assumed.', lpProofStatus: 'inferred', lpEvidenceMissing: true }
}

export const NO_SELL_CHECK_OPEN_CHECK = 'Trading simulation: no buy/sell check produced a result — "low visible risk" is withheld until a sell path is tested.'

/** PURE. Whether any trading check produced a verdict (a provider result, or a sellable/blocked simulation). */
export function sellCheckRan(hp: { ok: boolean; honeypot: boolean | null }): boolean {
  return hp.ok === true || hp.honeypot != null
}

/** PURE. "Low visible risk" requires a sell check; without one the floor is "watch". */
export function applySellCheckLabelFloor<L extends string>(label: L | 'watch', ran: boolean): { label: L | 'watch'; floored: boolean } {
  return label === 'low_visible_risk' && !ran ? { label: 'watch', floored: true } : { label, floored: false }
}
