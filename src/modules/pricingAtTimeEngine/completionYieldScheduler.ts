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
import {
  estimateRouteSuccess, observedFailureReasonsForAsset, isPermanentlyMissingAsset,
  type SourceSuccessEvidence, type PricingAssetClass, type PricingRequirementType, type PricingSourceName,
} from './sourceSuccessEvidence'

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
  // BUG FIX, DISCLOSED (found in audit): a structural lot's own `token` is the TRADED asset (e.g. a
  // memecoin) — never the quote currency actually used to buy/sell it. The original implementation
  // checked `isVerifiedStablecoinAddress(lot.chain, lot.token)` etc. directly on the lot's own
  // token, which is a category error: it asks "is the thing being traded itself a stablecoin",
  // almost always false, rather than "did the OPPOSITE transaction actually pay/receive in a
  // verified stablecoin/native/WETH quote leg". That made Tier 1 (immediate lot completion) nearly
  // unreachable in practice — the scheduler could barely ever detect its own best case. Fixed by
  // passing in the real, already-computed per-transaction quote-leg evidence (the SAME
  // isVerifiedQuoteLegAddress check used everywhere else in this pipeline, applied to the OPPOSITE
  // transaction's own real swap legs — never to the lot's traded-asset identity).
  verifiedQuoteTxHashes: ReadonlySet<string>
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
    // The opposite side is verified when EVERY affected lot's opposite TRANSACTION either already
    // has a real same-tx verified stablecoin/native/WETH quote leg, or was already resolved by an
    // earlier round of this same pass.
    oppositeSideVerified = lots.every((lot) => {
      const oppositeTxHash = list === 'buy' ? lot.closedTxHash : lot.openedTxHash
      const oppositeKey = `${lot.chain}:${lot.token.toLowerCase()}:${oppositeTxHash.toLowerCase()}:${list === 'buy' ? 'sell' : 'buy'}`
      if (params.alreadyResolvedKeys.has(oppositeKey)) return true
      return params.verifiedQuoteTxHashes.has(`${lot.chain}:${oppositeTxHash.toLowerCase()}`)
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

// ============================================================================================
// SUCCESS-WEIGHTED SCHEDULING, DISCLOSED — see sourceSuccessEvidence.ts's own header for the
// evidence model. Production baseline with the completion-yield scheduler enabled: verified lots
// 30/216 (13.89%), 210 requirements selected but only 66 resolved and 145 unresolved; native 53
// selected / 4 priced / 49 provider misses; GeckoTerminal still 429; many Base DEX paths returning
// no_pool / blockResolutionFailure. Structural completion yield alone cannot see any of that — it
// ranks a requirement identically whether its sources answer 90% of the time or 3% of the time.
//
// This layer multiplies the EXISTING structural yield by a real, observed, source-specific success
// probability and divides by the real estimated cost:
//
//     score = expectedLotsCompleted x sourceSuccessProbability / estimatedCost
//
// BUDGETS, PROVIDERS, FIFO, THE PUBLIC GATE AND THE FAIRNESS CAP ARE ALL UNCHANGED, DISCLOSED: this
// selects a DIFFERENT subset of the same size from the same pool, using the same
// FAIRNESS_FLOOR_PER_TOKEN, the same providers in the same order, and never touches FIFO matching or
// any public coverage threshold. It makes no provider call of its own.
// ============================================================================================

// Structural precedence is preserved ahead of the score, per this task's explicit "verified
// immediate-completion requirements remain highest-value structurally" rule: a requirement whose
// opposite side is already verified and which really does complete at least one lot is in bucket 0
// and can never be outranked by a merely-probable one. The score orders WITHIN a bucket, it does not
// override the structural tier.
function structuralBucketOf(req: SchedulerRequirement): 0 | 1 | 2 {
  if (req.oppositeSideVerified && req.lotIds.length > 0) return 0
  if (req.lotIds.length > 0) return 1
  return 2
}

export type SuccessWeightedRequirement = {
  requirement: SchedulerRequirement
  // Distinct structural lots this requirement would complete outright if it prices — real, and
  // already known before any call: only a requirement whose opposite side is verified/resolved can
  // complete a lot by itself.
  expectedLotsCompleted: number
  sourceSuccessProbability: number
  primarySource: PricingSourceName
  estimatedCalls: number
  estimatedCu: number
  score: number
  // Real, observed typed reasons for this exact asset — the evidence behind any discount applied.
  // Empty when nothing has ever been observed (an unseen requirement is discounted by nothing, it
  // simply receives the deterministic fallback probability).
  observedFailureReasons: ReadonlyMap<string, number>
  // A provider positively asserted this asset does not exist (token_not_found), or a live permanent
  // negative-cache entry covers it. Never selected, never retried — reported, not silently dropped.
  isHardFailure: boolean
}

function assetClassOf(req: SchedulerRequirement): PricingAssetClass {
  if (isNativePseudoAddress(req.entry.token) || isCanonicalWethAddress(req.entry.chain, req.entry.token)) return 'native'
  if (isVerifiedStablecoinAddress(req.entry.chain, req.entry.token)) return 'stable'
  return 'other'
}

function requirementTypeOf(req: SchedulerRequirement): PricingRequirementType {
  return req.missingSide ?? 'unranked'
}

// Minimum cost divisor — guards the score against a degenerate zero-cost estimate. Never reached
// with the real ESTIMATED_CU_BY_SOURCE table (every entry is positive); present so a future table
// edit can never produce a division by zero that would silently rank everything equal.
const MIN_ESTIMATED_CU = 1

// PURE, DETERMINISTIC. Attaches the real success/cost terms to one already-annotated structural
// requirement. Makes no provider call.
export function annotateSuccessWeighting(
  req: SchedulerRequirement,
  evidence: SourceSuccessEvidence,
): SuccessWeightedRequirement {
  const assetClass = assetClassOf(req)
  const requirementType = requirementTypeOf(req)
  const route = estimateRouteSuccess(evidence, {
    chain: req.entry.chain,
    token: req.entry.token,
    assetClass,
    requirementType,
  })

  const expectedLots = req.oppositeSideVerified ? req.lotIds.length : 0
  const observedFailureReasons = observedFailureReasonsForAsset(evidence, req.entry.chain, req.entry.token)
  // Both real permanent signals, kept distinct in the comment but equivalent in effect: a provider's
  // own token_not_found assertion, and the GoldRush permanent negative cache the structural
  // annotation already recorded.
  const isHardFailure =
    isPermanentlyMissingAsset(evidence, req.entry.chain, req.entry.token) || req.hasPriorNegativeCacheHit

  const cost = Math.max(route.estimatedCu, MIN_ESTIMATED_CU)
  // A requirement that completes no lot outright still has real value (it advances a lot toward
  // completion, and every 'both'-sided lot needs its first side priced before its second can ever
  // complete one). It is scored on the same axes at a deliberately reduced structural weight rather
  // than being zeroed out, which would starve every both-sides-missing lot forever.
  const structuralWeight = expectedLots > 0 ? expectedLots : req.lotIds.length > 0 ? 0.5 : 0.1
  const score = (structuralWeight * route.probability) / cost

  return {
    requirement: req,
    expectedLotsCompleted: expectedLots,
    sourceSuccessProbability: route.probability,
    primarySource: route.primarySource,
    estimatedCalls: route.estimatedCalls,
    estimatedCu: route.estimatedCu,
    score,
    observedFailureReasons,
    isHardFailure,
  }
}

export type SuccessWeightedSelection = {
  selected: SuccessWeightedRequirement[]
  skippedHardFailures: SuccessWeightedRequirement[]
  skippedByFairnessCap: SuccessWeightedRequirement[]
  skippedOther: SuccessWeightedRequirement[]
}

// PURE, DETERMINISTIC. Same total budget, same fairness cap, same pool — reordered by
// expectedLotsCompleted x sourceSuccessProbability / estimatedCost, with structural precedence
// preserved ahead of the score and hard failures skipped outright.
export function selectBySuccessWeightedYield(
  requirements: readonly SchedulerRequirement[],
  totalBudget: number,
  evidence: SourceSuccessEvidence,
): SuccessWeightedSelection {
  const weighted = requirements.map((r) => annotateSuccessWeighting(r, evidence))

  const skippedHardFailures = weighted.filter((w) => w.isHardFailure)
  const eligible = weighted.filter((w) => !w.isHardFailure)

  const ranked = [...eligible].sort((a, b) => {
    const bucketA = structuralBucketOf(a.requirement)
    const bucketB = structuralBucketOf(b.requirement)
    if (bucketA !== bucketB) return bucketA - bucketB
    if (a.score !== b.score) return b.score - a.score
    // Fully deterministic tie-break — the SAME comparator ordering the unweighted scheduler already
    // uses for its final tiers, so equal-score requirements keep a stable, reproducible order.
    if (a.requirement.entry.chain !== b.requirement.entry.chain) {
      return a.requirement.entry.chain.localeCompare(b.requirement.entry.chain)
    }
    const tokenCompare = a.requirement.entry.token.toLowerCase().localeCompare(b.requirement.entry.token.toLowerCase())
    if (tokenCompare !== 0) return tokenCompare
    if (a.requirement.entry.timestamp !== b.requirement.entry.timestamp) {
      return a.requirement.entry.timestamp - b.requirement.entry.timestamp
    }
    return requirementKeyOf(a.requirement).localeCompare(requirementKeyOf(b.requirement))
  })

  const selected: SuccessWeightedRequirement[] = []
  const skippedByFairnessCap: SuccessWeightedRequirement[] = []
  const lookupCountByToken = new Map<string, number>()

  for (const w of ranked) {
    if (selected.length >= totalBudget) break
    const tokenKey = tokenKeyOf(w.requirement.entry)
    const count = lookupCountByToken.get(tokenKey) ?? 0
    // UNCHANGED FAIRNESS CAP, DISCLOSED: the exact same FAIRNESS_FLOOR_PER_TOKEN the unweighted
    // scheduler enforces — success weighting never raises or lowers it.
    if (count >= FAIRNESS_FLOOR_PER_TOKEN) {
      skippedByFairnessCap.push(w)
      continue
    }
    lookupCountByToken.set(tokenKey, count + 1)
    selected.push(w)
  }

  const accountedKeys = new Set([
    ...selected.map((w) => requirementKeyOf(w.requirement)),
    ...skippedByFairnessCap.map((w) => requirementKeyOf(w.requirement)),
    ...skippedHardFailures.map((w) => requirementKeyOf(w.requirement)),
  ])
  const skippedOther = weighted.filter((w) => !accountedKeys.has(requirementKeyOf(w.requirement)))

  return { selected, skippedHardFailures, skippedByFairnessCap, skippedOther }
}

export type SuccessWeightedShadowComparison = {
  baselineSelected: number
  weightedSelected: number
  overlap: number
  // Structural expectation, undiscounted — how many distinct lots each selection would complete if
  // every dispatched requirement actually returned a price.
  baselineExpectedLots: number
  weightedExpectedLots: number
  // The same expectation DISCOUNTED by real observed source success probability — the honest
  // estimate of how many lots each selection will actually complete. This is the number the whole
  // change exists to improve, and the one to read first.
  baselineExpectedResolvedLots: number
  weightedExpectedResolvedLots: number
  selectedBySource: Record<string, number>
  discountedByFailureReason: Record<string, number>
  skippedHardFailures: number
  estimatedCalls: number
  estimatedCu: number
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

// Expected lots completed, discounted by each contributing requirement's own real success
// probability. A lot completed by a single requirement contributes that requirement's probability; a
// lot reachable via several selected requirements contributes the probability that AT LEAST ONE of
// them lands — never a sum that could exceed 1 for a single lot.
function expectedResolvedLots(selected: readonly SuccessWeightedRequirement[]): number {
  const missProbabilityByLot = new Map<string, number>()
  for (const w of selected) {
    if (w.expectedLotsCompleted === 0) continue
    for (const lotId of w.requirement.lotIds) {
      const prior = missProbabilityByLot.get(lotId) ?? 1
      missProbabilityByLot.set(lotId, prior * (1 - w.sourceSuccessProbability))
    }
  }
  let total = 0
  for (const miss of missProbabilityByLot.values()) total += 1 - miss
  return total
}

// PURE. The shadow comparison for this task — computes the EXISTING (unweighted completion-yield)
// selection and the new success-weighted selection over the same pool at the same budget, and
// reports the difference. Makes no provider call and changes nothing about what actually gets
// priced unless the caller explicitly applies the weighted selection.
export function computeSuccessWeightedComparison(
  requirements: readonly SchedulerRequirement[],
  totalBudget: number,
  evidence: SourceSuccessEvidence,
): { weightedSelection: SuccessWeightedSelection; comparison: SuccessWeightedShadowComparison } {
  const baseline = selectByCompletionYield(requirements, totalBudget)
  const weightedSelection = selectBySuccessWeightedYield(requirements, totalBudget, evidence)

  const baselineWeighted = baseline.selected.map((r) => annotateSuccessWeighting(r, evidence))

  const baselineKeys = new Set(baseline.selected.map(requirementKeyOf))
  let overlap = 0
  for (const w of weightedSelection.selected) {
    if (baselineKeys.has(requirementKeyOf(w.requirement))) overlap += 1
  }

  const selectedBySource: Record<string, number> = {}
  for (const w of weightedSelection.selected) {
    selectedBySource[w.primarySource] = (selectedBySource[w.primarySource] ?? 0) + 1
  }

  // Every real, observed typed reason that contributed to a discount on a requirement this pass
  // considered — reported exactly as the providers returned it, never re-labelled.
  const discountedByFailureReason: Record<string, number> = {}
  for (const w of [...weightedSelection.selected, ...weightedSelection.skippedOther, ...weightedSelection.skippedHardFailures]) {
    for (const [reason, count] of w.observedFailureReasons) {
      discountedByFailureReason[reason] = (discountedByFailureReason[reason] ?? 0) + count
    }
  }

  const comparison: SuccessWeightedShadowComparison = {
    baselineSelected: baseline.selected.length,
    weightedSelected: weightedSelection.selected.length,
    overlap,
    baselineExpectedLots: expectedLotsCompleted(baseline.selected),
    weightedExpectedLots: expectedLotsCompleted(weightedSelection.selected.map((w) => w.requirement)),
    baselineExpectedResolvedLots: round2(expectedResolvedLots(baselineWeighted)),
    weightedExpectedResolvedLots: round2(expectedResolvedLots(weightedSelection.selected)),
    selectedBySource,
    discountedByFailureReason,
    skippedHardFailures: weightedSelection.skippedHardFailures.length,
    estimatedCalls: round2(weightedSelection.selected.reduce((sum, w) => sum + w.estimatedCalls, 0)),
    estimatedCu: round2(weightedSelection.selected.reduce((sum, w) => sum + w.estimatedCu, 0)),
  }

  return { weightedSelection, comparison }
}
