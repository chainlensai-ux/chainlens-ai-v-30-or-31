// MODULE — receiptSwapDecoder: Base candidate selector.
//
// GOAL, DISCLOSED: the previous shadow-mode wiring (walletScanShadowWiring.ts's original pipeline
// call) sourced its candidates ONLY from routerTradeReconstruction.candidateTrades — a set that is
// only ever non-empty when routerDistributorMode is true (a rare, high-router-activity condition).
// Production proof from this task: a real scan with 415 swap-lookup transactions (351 one-leg
// groups, 65 with a verified quote address — the SAME real per-tx leg grouping already computed by
// src/modules/quoteLegPricing/index.ts's groupSwapLegsByTransaction, reused here rather than
// reimplemented) still logged baseSwapCandidates: 0, because routerDistributorMode was false for
// that wallet. This module selects candidates from that same richer, already-computed evidence
// instead, without requiring routerDistributorMode at all.
//
// PURE, DETERMINISTIC, READ-ONLY: takes evidence the caller has already computed from real pipeline
// stages (leg grouping, router inference, bridge detection, verified-quote-address check,
// routerTradeReconstruction's own candidates, closed-lot pairing) and returns a selection — it
// never fetches anything, never mutates FIFO/pricing/canonical events, never touches the router
// registry.

export type CandidateLeg = {
  contract: string
  direction: 'inbound' | 'outbound' | 'unknown'
  amount: number
}

export type RouterConfidence = 'high' | 'medium' | 'low' | null

export type CandidateTxEvidence = {
  chain: string
  txHash: string
  legs: CandidateLeg[]
  // At least one leg directly involves the scanned wallet as from/to (never a router-to-pool leg
  // that never touches the wallet).
  walletInvolved: boolean
  isKnownRouter: boolean
  routerConfidence: RouterConfidence
  hasVerifiedQuoteAddress: boolean
  // A real, already-computed "this looks like a swap" signal from elsewhere in the pipeline (e.g.
  // routerTradeReconstruction already paired this tx, or a future swapDetection.isSwapCandidate-
  // shaped signal) — never derived from scratch by this module.
  isExistingSwapCandidate: boolean
  // Real bridgeDetection.bridgeTimeline match (txHashFrom/txHashTo) — always excluded.
  isBridgeCandidate: boolean
  // Real, caller-classified non-swap category (LP add/remove, staking, burn) — always excluded.
  // null/false means "not classified as one of these", never "confirmed swap".
  isLpStakingOrBurn: boolean
  // A real closed-lot entry/exit pairing (fifoEngine/priceLotsForWallet's own structural match) that
  // is still missing its opposite priced side — null when no such requirement exists or is not
  // available at this pipeline stage.
  missingClosedLotSide: 'entry' | 'exit' | null
  // Best-known USD magnitude, tie-break only — never a pricing input.
  economicValueUsd: number | null
}

export type RejectReason =
  | 'unsupported_chain'
  | 'wallet_not_involved'
  | 'no_legs'
  | 'bridge_candidate'
  | 'lp_staking_or_burn'
  | 'ordinary_transfer'

export type SelectedCandidate = {
  chain: string
  txHash: string
  priorityTier: 1 | 2 | 3 | 4 | 5
  priorityReason: string
  inferredTokenIn: string | null
  inferredTokenOut: string | null
  inferredMissingSide: 'none' | 'tokenIn' | 'tokenOut'
  economicValueUsd: number | null
}

export type RejectedSample = {
  chain: string
  txHash: string
  reason: RejectReason
}

// ORDERING-TRACE INSTRUMENTATION, DISCLOSED: one row per ELIGIBLE candidate (bounded to
// MAX_SELECTED, same 25-candidate ceiling `selected` itself already has — never a second, larger
// dump), capturing every input the ranking/quota stages actually consume plus the position each
// candidate lands in after sorting. Exists purely to let a real production log prove exactly where
// an expected reordering was or wasn't produced, without needing to re-derive it after the fact.
export type CandidateOrderingTrace = {
  chain: string
  txHash: string
  tier: 1 | 2 | 3 | 4 | 5
  originalIndex: number
  pairingStrength: 0 | 1
  inboundLegCount: number
  outboundLegCount: number
  distinctTokenCount: number
  hasVerifiedQuoteAddress: boolean
  routerSignal: RouterConfidence
  isKnownRouter: boolean
  economicValueUsd: number | null
  finalSortedPosition: number
}

export type CandidateSelectionResult = {
  selectorTransactionsConsidered: number
  selectorEligibleCandidates: number
  selectorRejectedCandidates: number
  selectorReasonCounts: Record<RejectReason, number>
  baseSwapCandidates: number
  candidatePriorityBreakdown: Record<1 | 2 | 3 | 4 | 5, number>
  selected: SelectedCandidate[]
  rejectedSamples: RejectedSample[]
  orderingTrace: CandidateOrderingTrace[]
}

// DEPLOYMENT VERIFICATION, DISCLOSED: bump this string whenever selectBaseReceiptCandidates's
// ordering/eligibility logic changes. Logged unconditionally by walletScanShadowWiring.ts's shadow
// payload so a real production log can prove which build actually ran, without depending on commit
// SHA plumbing this module has no access to.
export const RECEIPT_SELECTOR_ALGORITHM_VERSION = 'receipt-selector-v3-single-leg-key-fix'

const MAX_SELECTED = 25
const MAX_REJECTED_SAMPLES = 10

function hasOppositeDirectionLegs(legs: CandidateLeg[]): boolean {
  const inbound = legs.some((l) => l.direction === 'inbound')
  const outbound = legs.some((l) => l.direction === 'outbound')
  return inbound && outbound
}

function hasRouterLikeCounterparty(evidence: CandidateTxEvidence): boolean {
  return evidence.isKnownRouter || evidence.routerConfidence === 'high' || evidence.routerConfidence === 'medium'
}

// Eligibility per this task's spec: Base only, wallet directly involved, not a clear bridge/LP/
// staking/burn/ordinary-transfer, and at least one positive swap-candidate signal.
function evaluateEligibility(evidence: CandidateTxEvidence): { eligible: boolean; reason?: RejectReason } {
  if (evidence.chain !== 'base') return { eligible: false, reason: 'unsupported_chain' }
  if (!evidence.walletInvolved) return { eligible: false, reason: 'wallet_not_involved' }
  if (evidence.legs.length === 0) return { eligible: false, reason: 'no_legs' }
  if (evidence.isBridgeCandidate) return { eligible: false, reason: 'bridge_candidate' }
  if (evidence.isLpStakingOrBurn) return { eligible: false, reason: 'lp_staking_or_burn' }

  const positiveSignal =
    evidence.isExistingSwapCandidate
    || hasRouterLikeCounterparty(evidence)
    || hasOppositeDirectionLegs(evidence.legs)
    || (evidence.legs.length === 1 && hasRouterLikeCounterparty(evidence))
    || evidence.missingClosedLotSide !== null

  if (!positiveSignal) return { eligible: false, reason: 'ordinary_transfer' }
  return { eligible: true }
}

// Priority per this task's exact ordering (1 = highest).
function priorityFor(evidence: CandidateTxEvidence): { tier: 1 | 2 | 3 | 4 | 5; reason: string } {
  if (evidence.missingClosedLotSide !== null) return { tier: 1, reason: `could_complete_missing_${evidence.missingClosedLotSide}` }
  if (evidence.isExistingSwapCandidate) return { tier: 2, reason: 'existing_one_leg_swap_candidate' }
  if (evidence.hasVerifiedQuoteAddress) return { tier: 3, reason: 'verified_quote_address' }
  if (evidence.isKnownRouter || evidence.routerConfidence === 'high') return { tier: 4, reason: 'known_or_high_confidence_router' }
  return { tier: 5, reason: 'economic_value_signal' }
}

function inferTokensFromLegs(legs: CandidateLeg[]): { tokenIn: string | null; tokenOut: string | null; missingSide: 'none' | 'tokenIn' | 'tokenOut' } {
  const outboundLeg = legs.find((l) => l.direction === 'outbound')
  const inboundLeg = legs.find((l) => l.direction === 'inbound')
  if (outboundLeg && inboundLeg) return { tokenIn: outboundLeg.contract, tokenOut: inboundLeg.contract, missingSide: 'none' }
  if (outboundLeg && !inboundLeg) return { tokenIn: outboundLeg.contract, tokenOut: null, missingSide: 'tokenOut' }
  if (!outboundLeg && inboundLeg) return { tokenIn: null, tokenOut: inboundLeg.contract, missingSide: 'tokenIn' }
  return { tokenIn: null, tokenOut: null, missingSide: 'tokenOut' }
}

function dedupeKey(evidence: CandidateTxEvidence): string {
  return `${evidence.chain}:${evidence.txHash.toLowerCase()}`
}

// PURE. Deterministic: identical input (including input order) always produces an identical
// selection — sorting uses only fields carried on the evidence itself, tie-broken by chain+txHash.
export function selectBaseReceiptCandidates(evidenceList: readonly CandidateTxEvidence[]): CandidateSelectionResult {
  const selectorReasonCounts: Record<RejectReason, number> = {
    unsupported_chain: 0,
    wallet_not_involved: 0,
    no_legs: 0,
    bridge_candidate: 0,
    lp_staking_or_burn: 0,
    ordinary_transfer: 0,
  }
  const rejectedSamples: RejectedSample[] = []

  // Dedupe by chain:txHash — first occurrence wins, matching this task's explicit requirement.
  const seen = new Set<string>()
  const deduped: CandidateTxEvidence[] = []
  for (const evidence of evidenceList) {
    const key = dedupeKey(evidence)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(evidence)
  }

  const originalIndexByKey = new Map<string, number>()
  evidenceList.forEach((evidence, index) => {
    const key = dedupeKey(evidence)
    if (!originalIndexByKey.has(key)) originalIndexByKey.set(key, index)
  })

  const eligible: CandidateTxEvidence[] = []
  for (const evidence of deduped) {
    const { eligible: isEligible, reason } = evaluateEligibility(evidence)
    if (!isEligible) {
      selectorReasonCounts[reason!] += 1
      if (rejectedSamples.length < MAX_REJECTED_SAMPLES) {
        rejectedSamples.push({ chain: evidence.chain, txHash: evidence.txHash, reason: reason! })
      }
      continue
    }
    eligible.push(evidence)
  }

  // WITHIN-TIER LEG-PAIRING RANKING FIX, DISCLOSED (production proof: 25 eligible, 10 fetched,
  // 8/10 ended plain_transfer_no_swap_event, 0 exact swaps recovered). Tiers 3/4's own eligibility
  // path lets a transaction with only ONE recorded leg qualify purely because it touched a known/
  // high-confidence router (`legs.length === 1 && hasRouterLikeCounterparty`) — a real, but WEAK,
  // pre-fetch signal: no concrete evidence of BOTH token flows a real swap always produces, just
  // "this tx touched a router". A candidate that already shows OPPOSITE-DIRECTION legs (both an
  // inbound and an outbound transfer already recorded) is much stronger pre-fetch evidence a real,
  // decodable pool swap is actually in that receipt — the exact in+out shape decodeReceiptSwap's own
  // resolvePoolLeg/resolveClassicMultiTransferLeg require. This never changes WHICH tier a candidate
  // lands in (deterministic tier quotas are unchanged) — it only reorders candidates WITHIN the same
  // tier, before the existing economicValueUsd tie-break, so a fixed receipt budget is spent on the
  // strongest-evidence candidates within whichever tier the quota draws from.
  const legPairingStrength = (evidence: CandidateTxEvidence): number => (hasOppositeDirectionLegs(evidence.legs) ? 1 : 0)

  const ranked = eligible
    .map((evidence) => ({ evidence, priority: priorityFor(evidence) }))
    .sort((a, b) => {
      if (a.priority.tier !== b.priority.tier) return a.priority.tier - b.priority.tier
      const aPairing = legPairingStrength(a.evidence)
      const bPairing = legPairingStrength(b.evidence)
      if (aPairing !== bPairing) return bPairing - aPairing
      const aValue = a.evidence.economicValueUsd ?? -Infinity
      const bValue = b.evidence.economicValueUsd ?? -Infinity
      if (aValue !== bValue) return bValue - aValue
      return dedupeKey(a.evidence).localeCompare(dedupeKey(b.evidence))
    })

  // ORDERING TRACE, DISCLOSED: built from `ranked` (post-sort, pre-slice) so `finalSortedPosition`
  // reflects every eligible candidate's true position, including the ones the MAX_SELECTED slice
  // below cuts off. Bounded to MAX_SELECTED entries — a real audit only ever needs to see as many
  // rows as `selected` itself can contain.
  const orderingTrace: CandidateOrderingTrace[] = ranked.slice(0, MAX_SELECTED).map(({ evidence, priority }, position) => {
    const inboundLegCount = evidence.legs.filter((l) => l.direction === 'inbound').length
    const outboundLegCount = evidence.legs.filter((l) => l.direction === 'outbound').length
    const distinctTokenCount = new Set(evidence.legs.map((l) => l.contract.toLowerCase())).size
    return {
      chain: evidence.chain,
      txHash: evidence.txHash,
      tier: priority.tier,
      originalIndex: originalIndexByKey.get(dedupeKey(evidence)) ?? -1,
      pairingStrength: legPairingStrength(evidence) as 0 | 1,
      inboundLegCount,
      outboundLegCount,
      distinctTokenCount,
      hasVerifiedQuoteAddress: evidence.hasVerifiedQuoteAddress,
      routerSignal: evidence.routerConfidence,
      isKnownRouter: evidence.isKnownRouter,
      economicValueUsd: evidence.economicValueUsd,
      finalSortedPosition: position,
    }
  })

  const selectedRanked = ranked.slice(0, MAX_SELECTED)
  const candidatePriorityBreakdown: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  const selected: SelectedCandidate[] = selectedRanked.map(({ evidence, priority }) => {
    candidatePriorityBreakdown[priority.tier] += 1
    const inferred = inferTokensFromLegs(evidence.legs)
    return {
      chain: evidence.chain,
      txHash: evidence.txHash,
      priorityTier: priority.tier,
      priorityReason: priority.reason,
      inferredTokenIn: inferred.tokenIn,
      inferredTokenOut: inferred.tokenOut,
      inferredMissingSide: inferred.missingSide,
      economicValueUsd: evidence.economicValueUsd,
    }
  })

  return {
    selectorTransactionsConsidered: evidenceList.length,
    selectorEligibleCandidates: eligible.length,
    selectorRejectedCandidates: deduped.length - eligible.length,
    selectorReasonCounts,
    baseSwapCandidates: selected.length,
    candidatePriorityBreakdown,
    selected,
    rejectedSamples,
    orderingTrace,
  }
}
