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

export type CandidateSelectionResult = {
  selectorTransactionsConsidered: number
  selectorEligibleCandidates: number
  selectorRejectedCandidates: number
  selectorReasonCounts: Record<RejectReason, number>
  baseSwapCandidates: number
  candidatePriorityBreakdown: Record<1 | 2 | 3 | 4 | 5, number>
  selected: SelectedCandidate[]
  rejectedSamples: RejectedSample[]
}

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

  const ranked = eligible
    .map((evidence) => ({ evidence, priority: priorityFor(evidence) }))
    .sort((a, b) => {
      if (a.priority.tier !== b.priority.tier) return a.priority.tier - b.priority.tier
      const aValue = a.evidence.economicValueUsd ?? -Infinity
      const bValue = b.evidence.economicValueUsd ?? -Infinity
      if (aValue !== bValue) return bValue - aValue
      return dedupeKey(a.evidence).localeCompare(dedupeKey(b.evidence))
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
  }
}
