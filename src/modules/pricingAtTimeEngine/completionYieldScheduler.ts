// MODULE — pricingAtTimeEngine: completion-yield historical-pricing scheduler.
//
// GOAL, DISCLOSED: production baseline — 219 structural lots, 11 verified (5.02%), the public gate
// needs 110 (50%); ~500 total pricing requirements, ~293 capped, 312 of them "priority" (pairRank-
// assigned, i.e. real closed-lot requirements) yet 226 of THOSE priority requirements were STILL
// capped. Root cause: pricingAtTimeEngine/index.ts's priceAllEntries enforces one FLAT rule —
// `maxLookupsPerToken` (2, resolveMaxLookupsPerToken) — regardless of how many DIFFERENT lots a given
// token's requirements could complete. A token with 5 real closed lots (10 requirements: 5 entries +
// 5 exits) gets the exact same 2-request budget as a token with 1 lot needing only its exit priced —
// even though the second case can complete a lot with ONE more request and the first cannot complete
// any additional lot without several more.
//
// THIS MODULE NEVER FETCHES A PRICE, DISCLOSED: pure, deterministic, offline. It only decides WHICH
// already-built PriceableEntry requirements get dispatched to the real price sources, and in what
// order — replacing the flat per-token counter with a request ranked by real, already-known
// structural evidence (which lots a requirement affects, whether its lot's opposite side is already
// resolved, whether it's a verified quote leg). SAME TOTAL BUDGET: the yield-based selection is
// computed to select AT MOST as many requirements as the flat rule would have dispatched for this
// exact requirement pool — this redistributes an existing budget, it never grows one.
//
// SHADOW FIRST, DISCLOSED: computeSchedulerComparison runs BOTH the existing flat selection and the
// new yield selection over the same pool and reports the difference, with zero effect on what
// actually gets priced, until HISTORICAL_PRICING_YIELD_SCHEDULER_ENABLED is explicitly set.

import type { SupportedChain } from '../providerFetchWindow/types'
import type { PriceableEntry } from './types'
import {
  isVerifiedStablecoinAddress, isNativePseudoAddress, isCanonicalWethAddress,
} from '../quoteLegPricing/index'
import { isKnownGoldrushNegative } from './sources/goldrushPriceSource'

// FAIRNESS FLOOR, DISCLOSED — this task's explicit "retain a fairness floor so one dense token cannot
// consume the full budget" requirement. A real cap, just no longer the FLAT default (2) regardless of
// how many distinct lots that token could complete — a token whose real, structural lot-completion
// count justifies more requests may use up to this many, never unbounded.
export const FAIRNESS_FLOOR_PER_TOKEN = 8

export type SchedulerLotRef = {
  lotId: string
  chain: SupportedChain
  token: string
  openedTxHash: string
  closedTxHash: string
}

// One already-built PriceableEntry, annotated with the real structural facts this scheduler ranks on
// — every field here is derived from data the caller (priceLotsForWallet.ts) already computed from
// the price-free structural FIFO pre-pass; nothing here is invented or looked up.
export type SchedulerRequirement = {
  entry: PriceableEntry
  list: 'buy' | 'sell'
  // Distinct structural lots whose OPEN (for a 'buy' entry) or CLOSE (for a 'sell' entry) this exact
  // (chain, token, txHash) requirement would resolve if priced. Usually 0 or 1; more than 1 only when
  // several lots genuinely share the same open/close transaction (a real, if rare, structural fact).
  lotIds: string[]
  // Whether THIS requirement's own lot(s) still need only this side ('entry' or 'exit'), or both
  // sides remain unresolved. null when this requirement is not tied to any structural lot at all
  // (unranked — e.g. an open position with no matching sell yet).
  missingSide: 'entry' | 'exit' | 'both' | null
  // Real, pre-fetch evidence: the OPPOSITE side of this requirement's own lot is either a verified
  // stablecoin/native/WETH quote (deterministic, effectively free) or was already marked resolved by
  // an earlier stage of this same scheduling pass (see markResolved in selectByCompletionYield).
  oppositeSideVerified: boolean
  // A real, address-based signal — never inferred from amount/timestamp — that this requirement's own
  // token is itself a native/WETH/stablecoin quote asset with a verified resolver route.
  isNativeWethOrStableRequirement: boolean
  // Real negative-cache history (GoldRush's own already-existing negative cache — see
  // goldrushPriceSource.ts). A requirement with confirmed prior failure history for this exact
  // (chain, token) is never preferentially selected, and is reported separately when skipped.
  hasPriorNegativeCacheHit: boolean
}

export type ScheduledSelection = {
  selected: SchedulerRequirement[]
  skippedByFairnessCap: SchedulerRequirement[]
  skippedByNegativeCache: SchedulerRequirement[]
  skippedOther: SchedulerRequirement[]
}

function tokenKeyOf(entry: PriceableEntry): string {
  return `${entry.chain}:${entry.token.toLowerCase()}`
}

function requirementKeyOf(req: SchedulerRequirement): string {
  return `${req.entry.chain}:${req.entry.token.toLowerCase()}:${req.entry.txHash.toLowerCase()}:${req.list}`
}

// PURE. Builds the real structural annotations for one PriceableEntry, given the structural lots it
// might belong to and the (chain,token) pairs already known deterministically resolvable (verified
// stablecoin/native/WETH — checked directly by address, never guessed) or already resolved by a prior
// stage of this same pass.
export function annotateRequirement(params: {
  entry: PriceableEntry
  list: 'buy' | 'sell'
  lotsByOpenKey: ReadonlyMap<string, SchedulerLotRef[]>
  lotsByCloseKey: ReadonlyMap<string, SchedulerLotRef[]>
  alreadyResolvedKeys: ReadonlySet<string>
}): SchedulerRequirement {
  const { entry, list } = params
  const key = `${entry.chain}:${entry.txHash.toLowerCase()}`
  const openLots = params.lotsByOpenKey.get(key) ?? []
  const closeLots = params.lotsByCloseKey.get(key) ?? []
  const lots = list === 'buy' ? openLots : closeLots
  const lotIds = lots.map((l) => l.lotId)

  let missingSide: SchedulerRequirement['missingSide'] = null
  let oppositeSideVerified = false
  if (lots.length > 0) {
    missingSide = list === 'buy' ? 'entry' : 'exit'
    // The opposite side is verified when EVERY affected lot's opposite leg is either a verified
    // stablecoin/native/WETH quote or already resolved by an earlier round of this same pass.
    oppositeSideVerified = lots.every((lot) => {
      const oppositeTxHash = list === 'buy' ? lot.closedTxHash : lot.openedTxHash
      const oppositeKey = `${lot.chain}:${lot.token.toLowerCase()}:${oppositeTxHash.toLowerCase()}:${list === 'buy' ? 'sell' : 'buy'}`
      if (params.alreadyResolvedKeys.has(oppositeKey)) return true
      return isVerifiedStablecoinAddress(lot.chain, lot.token) || isNativePseudoAddress(lot.token) || isCanonicalWethAddress(lot.chain, lot.token)
    })
    // "Both sides missing" is real when neither this requirement's opposite verification holds AND
    // this SAME lot also appears in neither already-resolved set — a conservative, honest default:
    // if we can't prove the opposite is already handled, treat the lot as still needing both, never
    // assume the friendlier case.
    if (!oppositeSideVerified) missingSide = 'both'
  }

  const isNativeWethOrStableRequirement =
    isVerifiedStablecoinAddress(entry.chain, entry.token) || isNativePseudoAddress(entry.token) || isCanonicalWethAddress(entry.chain, entry.token)
  const hasPriorNegativeCacheHit = isKnownGoldrushNegative(entry.token, entry.chain)

  return { entry, list, lotIds, missingSide, oppositeSideVerified, isNativeWethOrStableRequirement, hasPriorNegativeCacheHit }
}

// PURE. Replicates pricingAtTimeEngine/index.ts's real, existing flat-cap selection (pairRank order,
// then a flat per-token counter) WITHOUT making any provider call — used only to (a) discover how
// many requirements the flat rule would dispatch, so the yield scheduler can be handed the SAME total
// budget, and (b) build the shadow-comparison diagnostic.
export function selectByFlatCap(requirements: readonly SchedulerRequirement[], maxLookupsPerToken: number): SchedulerRequirement[] {
  const UNRANKED = Number.MAX_SAFE_INTEGER
  const ordered = [...requirements].sort((a, b) => (a.entry.pairRank ?? UNRANKED) - (b.entry.pairRank ?? UNRANKED))
  const lookupCountByToken = new Map<string, number>()
  const selected: SchedulerRequirement[] = []
  for (const req of ordered) {
    const tokenKey = tokenKeyOf(req.entry)
    const count = lookupCountByToken.get(tokenKey) ?? 0
    if (count >= maxLookupsPerToken) continue
    lookupCountByToken.set(tokenKey, count + 1)
    selected.push(req)
  }
  return selected
}

// PURE. The real priority comparator — exactly this task's six tiers, in order. Never uses amount or
// any pricing-derived value (nothing here has been priced yet).
function compareByCompletionYield(a: SchedulerRequirement, b: SchedulerRequirement, sharedGroupSize: (r: SchedulerRequirement) => number): number {
  // Tier 1 — immediate completion (opposite side already verified/resolved), most lots first.
  const aImmediate = a.oppositeSideVerified && a.lotIds.length > 0
  const bImmediate = b.oppositeSideVerified && b.lotIds.length > 0
  if (aImmediate !== bImmediate) return aImmediate ? -1 : 1
  if (a.lotIds.length !== b.lotIds.length) return b.lotIds.length - a.lotIds.length

  // Tier 2 — one-side-missing before both-sides-missing.
  const aOneSided = a.missingSide === 'entry' || a.missingSide === 'exit'
  const bOneSided = b.missingSide === 'entry' || b.missingSide === 'exit'
  if (aOneSided !== bOneSided) return aOneSided ? -1 : 1

  // Tier 3 — shared timestamp/token requirements that complete multiple lots: a larger "how many
  // OTHER requirements share this (chain,token,timestamp) and are themselves lot-affecting" group
  // ranks first — real evidence this token/time cluster is worth a shared resolution.
  const aGroup = sharedGroupSize(a)
  const bGroup = sharedGroupSize(b)
  if (aGroup !== bGroup) return bGroup - aGroup

  // Tier 4 — native/WETH/stable requirements with verified resolver eligibility.
  if (a.isNativeWethOrStableRequirement !== b.isNativeWethOrStableRequirement) return a.isNativeWethOrStableRequirement ? -1 : 1

  // Tier 5 — previously successful assets/sources: absence of a known negative-cache hit is the real,
  // available proxy for "this asset/source has not already proven itself unable to answer".
  if (a.hasPriorNegativeCacheHit !== b.hasPriorNegativeCacheHit) return a.hasPriorNegativeCacheHit ? 1 : -1

  // Tier 6 — deterministic chain, token, timestamp tie-breakers.
  if (a.entry.chain !== b.entry.chain) return a.entry.chain.localeCompare(b.entry.chain)
  const tokenCompare = a.entry.token.toLowerCase().localeCompare(b.entry.token.toLowerCase())
  if (tokenCompare !== 0) return tokenCompare
  if (a.entry.timestamp !== b.entry.timestamp) return a.entry.timestamp - b.entry.timestamp
  return requirementKeyOf(a).localeCompare(requirementKeyOf(b))
}

// PURE, DETERMINISTIC. Selects up to `totalBudget` requirements from `requirements`, ranked by real
// completion yield, subject to FAIRNESS_FLOOR_PER_TOKEN. Never selects a requirement whose
// hasPriorNegativeCacheHit is true while any real (non-negative-cache) candidate remains available —
// negative-cache requirements are only ever selected once nothing else is left, exactly mirroring
// "negative-cache token_not_found and typed failures remain respected. no retries."
export function selectByCompletionYield(requirements: readonly SchedulerRequirement[], totalBudget: number): ScheduledSelection {
  // Requirements affecting more than one distinct token share a "group" only within the SAME
  // (chain, token, timestamp) triple — computed once, up front, real and structural.
  const groupSizeByKey = new Map<string, number>()
  for (const req of requirements) {
    if (req.lotIds.length === 0) continue // only lot-affecting requirements count toward a real group
    const key = `${req.entry.chain}:${req.entry.token.toLowerCase()}:${req.entry.timestamp}`
    groupSizeByKey.set(key, (groupSizeByKey.get(key) ?? 0) + 1)
  }
  const sharedGroupSize = (req: SchedulerRequirement): number => {
    if (req.lotIds.length === 0) return 0
    const key = `${req.entry.chain}:${req.entry.token.toLowerCase()}:${req.entry.timestamp}`
    return groupSizeByKey.get(key) ?? 0
  }

  const real = requirements.filter((r) => !r.hasPriorNegativeCacheHit)
  const negative = requirements.filter((r) => r.hasPriorNegativeCacheHit)

  const rankedReal = [...real].sort((a, b) => compareByCompletionYield(a, b, sharedGroupSize))
  const rankedNegative = [...negative].sort((a, b) => compareByCompletionYield(a, b, sharedGroupSize))

  const selected: SchedulerRequirement[] = []
  const skippedByFairnessCap: SchedulerRequirement[] = []
  const skippedByNegativeCache: SchedulerRequirement[] = []
  const lookupCountByToken = new Map<string, number>()

  function tryTake(req: SchedulerRequirement): 'selected' | 'fairness_capped' | 'budget_exhausted' {
    if (selected.length >= totalBudget) return 'budget_exhausted'
    const tokenKey = tokenKeyOf(req.entry)
    const count = lookupCountByToken.get(tokenKey) ?? 0
    if (count >= FAIRNESS_FLOOR_PER_TOKEN) return 'fairness_capped'
    lookupCountByToken.set(tokenKey, count + 1)
    selected.push(req)
    return 'selected'
  }

  for (const req of rankedReal) {
    const outcome = tryTake(req)
    if (outcome === 'fairness_capped') skippedByFairnessCap.push(req)
    if (outcome === 'budget_exhausted') break
  }
  // Negative-cache requirements are only ever considered once every real candidate has been tried —
  // and even then, they are reported as skipped rather than silently selected, since a KNOWN prior
  // failure is real evidence a real provider call would fail closed again. Never retried.
  for (const req of rankedNegative) {
    skippedByNegativeCache.push(req)
  }

  const selectedKeys = new Set(selected.map(requirementKeyOf))
  const fairnessKeys = new Set(skippedByFairnessCap.map(requirementKeyOf))
  const negativeKeys = new Set(skippedByNegativeCache.map(requirementKeyOf))
  const skippedOther = requirements.filter((r) => {
    const k = requirementKeyOf(r)
    return !selectedKeys.has(k) && !fairnessKeys.has(k) && !negativeKeys.has(k)
  })

  return { selected, skippedByFairnessCap, skippedByNegativeCache, skippedOther }
}

export type SchedulerShadowComparison = {
  existingSelectedCount: number
  yieldSelectedCount: number
  overlapCount: number
  existingExpectedLotsCompleted: number
  yieldExpectedLotsCompleted: number
  oneSideMissingSelected: number
  bothSidesMissingSelected: number
  selectedByToken: Record<string, number>
  skippedByFairnessCap: number
  skippedByNegativeCache: number
  // Uniform per-requirement proxy — this scheduler makes no assumption about which real source will
  // eventually answer a given requirement (unknowable ahead of time, and this codebase never invents
  // per-provider cost estimates for a call that hasn't happened) — one real dispatch attempt is
  // counted as one estimated call, matching the real 1:1 relationship between a selected requirement
  // and the one resolvePriceForEntry attempt it will receive.
  estimatedCalls: number
  estimatedCu: number
}

function expectedLotsCompleted(selected: readonly SchedulerRequirement[]): number {
  const completedLotIds = new Set<string>()
  for (const req of selected) {
    if (!req.oppositeSideVerified) continue
    for (const lotId of req.lotIds) completedLotIds.add(lotId)
  }
  return completedLotIds.size
}

// PURE. The shadow comparison — computes BOTH selections and reports the difference. Makes no
// provider call, changes nothing about what actually gets priced.
export function computeSchedulerComparison(
  requirements: readonly SchedulerRequirement[],
  maxLookupsPerToken: number,
): { existing: SchedulerRequirement[]; yieldSelection: ScheduledSelection; comparison: SchedulerShadowComparison } {
  const existing = selectByFlatCap(requirements, maxLookupsPerToken)
  const yieldSelection = selectByCompletionYield(requirements, existing.length)

  const existingKeys = new Set(existing.map(requirementKeyOf))
  const yieldKeys = new Set(yieldSelection.selected.map(requirementKeyOf))
  let overlapCount = 0
  for (const k of existingKeys) if (yieldKeys.has(k)) overlapCount += 1

  const selectedByToken: Record<string, number> = {}
  for (const req of yieldSelection.selected) {
    const key = tokenKeyOf(req.entry)
    selectedByToken[key] = (selectedByToken[key] ?? 0) + 1
  }

  const comparison: SchedulerShadowComparison = {
    existingSelectedCount: existing.length,
    yieldSelectedCount: yieldSelection.selected.length,
    overlapCount,
    existingExpectedLotsCompleted: expectedLotsCompleted(existing),
    yieldExpectedLotsCompleted: expectedLotsCompleted(yieldSelection.selected),
    oneSideMissingSelected: yieldSelection.selected.filter((r) => r.missingSide === 'entry' || r.missingSide === 'exit').length,
    bothSidesMissingSelected: yieldSelection.selected.filter((r) => r.missingSide === 'both').length,
    selectedByToken,
    skippedByFairnessCap: yieldSelection.skippedByFairnessCap.length,
    skippedByNegativeCache: yieldSelection.skippedByNegativeCache.length,
    estimatedCalls: yieldSelection.selected.length,
    estimatedCu: yieldSelection.selected.length,
  }

  return { existing, yieldSelection, comparison }
}
