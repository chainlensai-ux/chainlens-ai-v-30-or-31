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
  // ROUTE-FINGERPRINT INPUT, DISCLOSED (this task) — the actual router/counterparty ADDRESS this
  // tx's wallet-facing leg touched, when known. Real, already-computed pipeline evidence (the same
  // counterparty address src/pipeline/index.ts's routerInfoByTx already derives to set
  // isKnownRouter/routerConfidence, just not previously threaded through) — never guessed here.
  // null when no single counterparty was identifiable (e.g. multiple legs touching different
  // addresses, or the address couldn't be resolved).
  routerOrCounterpartyAddress: string | null
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
  // ROUTE FINGERPRINT, DISCLOSED (this task — see routeFingerprintFor's own header): deterministic,
  // pre-fetch-only identity for "this candidate's route shape", used by receiptAcquisition.ts's
  // negative-evidence substitution as the PRIMARY match key — never token pair alone (see
  // receiptAcquisition.ts for the full production-proof disclosure of why token pair alone was too
  // narrow).
  routeFingerprint: string
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
  routeFingerprint: string
  routerOrCounterpartyAddress: string | null
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
export const RECEIPT_SELECTOR_ALGORITHM_VERSION = 'receipt-selector-v6-completion-requires-independent-signal'

const MAX_SELECTED = 25
const MAX_REJECTED_SAMPLES = 10
const NATIVE_WRAP_ADDRESS_BASE = '0x4200000000000000000000000000000000000006'

function hasOppositeDirectionLegs(legs: CandidateLeg[]): boolean {
  const inbound = legs.some((l) => l.direction === 'inbound')
  const outbound = legs.some((l) => l.direction === 'outbound')
  return inbound && outbound
}

// ROUTE FINGERPRINT, DISCLOSED (this task — production proof: a real scan whose 8 plain-transfer
// receipts were NOT single-leg — pairingStrength=1, inboundLegCount=1, outboundLegCount=1,
// distinctTokenCount=2 on every one of them — so the prior single:<token>/pair:<a>:<b> key never
// matched, because those 8 candidates each touched a DIFFERENT token pair through the SAME
// router/route shape. Exact token-pair matching was proven too narrow for this real pattern.
//
// Built ENTIRELY from evidence already available before the next fetch — chain, the actual
// router/counterparty address this tx's wallet-facing leg touched (real, threaded through from
// pipeline/index.ts's own routerInfoByTx — never guessed), and a structural "route shape" (leg
// direction counts + whether a canonical native-wrap contract appears among the legs). Token pair
// is deliberately NOT part of this fingerprint — receiptAcquisition.ts's negative-evidence matching
// uses this as the sole match key, treating token pair only as an optional stronger-specificity
// SIGNAL callers may log alongside it, never as a requirement for a match. Never infers protocol
// from an unsupported topic (this function never sees receipt logs at all — only pre-fetch
// evidence) and never varies by amount, so two structurally-identical repeated router calls always
// fingerprint identically, regardless of which specific token they moved.
function routeFingerprintFor(evidence: CandidateTxEvidence): string {
  const inboundLegCount = evidence.legs.filter((l) => l.direction === 'inbound').length
  const outboundLegCount = evidence.legs.filter((l) => l.direction === 'outbound').length
  const hasNativeWrapLeg = evidence.legs.some((l) => l.contract.toLowerCase() === NATIVE_WRAP_ADDRESS_BASE)
  const routeShape = `${inboundLegCount}i${outboundLegCount}o${hasNativeWrapLeg ? 'w' : 'n'}`
  const counterparty = evidence.routerOrCounterpartyAddress ? evidence.routerOrCounterpartyAddress.toLowerCase() : 'no-counterparty'
  return `${evidence.chain}:${counterparty}:${routeShape}`
}

function hasRouterLikeCounterparty(evidence: CandidateTxEvidence): boolean {
  return evidence.isKnownRouter || evidence.routerConfidence === 'high' || evidence.routerConfidence === 'medium'
}

// SELECTION CORRECTION, DISCLOSED (Phase 2 forensics follow-up — production proof: 25 tier-1
// candidates selected on structural-completion grounds alone, 13 receipts fetched, 0 recognized swap
// events, 11 explicitly `plain_transfer_no_swap_event`, one candidate that should have been rejected
// pre-fetch as an ordinary transfer). FIFO boundary membership (missingClosedLotSide !== null) means
// "this transaction is the open/close side of a real structural lot whose opposite leg is absent from
// provider events" — that is real evidence a LEG IS MISSING, but it is NOT evidence that this specific
// transaction is itself a swap rather than an ordinary wallet transfer that merely happens to sit at a
// lot boundary (e.g. a plain deposit into a wallet later sold, or a plain withdrawal after a purchase).
// Structural completion is therefore NECESSARY but not SUFFICIENT for tier 1: it must now be paired
// with at least one INDEPENDENT swap signal — see hasIndependentSwapSignal below — before a receipt is
// spent chasing it. "Independent" is used strictly: the four signals below are computable BEFORE any
// receipt is fetched, from evidence this pipeline already has for unrelated reasons (router inference,
// quote-address verification, opposite-direction leg presence) — never derived from the completion
// signal itself.
function hasIndependentSwapSignal(evidence: CandidateTxEvidence): boolean {
  return (
    // Known/high-confidence router — real routerInfoByTx evidence (src/pipeline/index.ts), never
    // guessed here.
    hasRouterLikeCounterparty(evidence)
    // A verified quote leg — the existing recorded side is itself a real stablecoin/native/WETH
    // address (quoteLegPricing's own allowlist), the same signal tier 3 already trusts on its own.
    || evidence.hasVerifiedQuoteAddress
    // Multi-token opposing wallet flow — BOTH an inbound and an outbound leg already recorded, the
    // real in+out shape a swap always produces (never a lone transfer that merely touches a lot
    // boundary).
    || hasOppositeDirectionLegs(evidence.legs)
    // RESERVED, DISCLOSED: "recognized swap-like input selector" is deliberately NOT evaluated here.
    // A transaction's calldata selector requires eth_getTransactionByHash (the transaction object),
    // never returned by eth_getTransactionReceipt (the ONLY per-tx call this pipeline stage makes,
    // via receiptAcquisition.ts) — there is no real selector data available at THIS pre-fetch
    // decision point to check honestly. Adding a fabricated/guessed check here would violate this
    // codebase's own "never infer from data that was never fetched" rule; this OR-branch is a wiring
    // point for a future stage that actually has calldata, not a signal this function can supply
    // today.
  )
}

// PROVEN ROUTE FINGERPRINT, DISCLOSED: a pure, same-call cross-reference — never external state,
// never persisted across scans. If ANY candidate sharing a given route fingerprint already carries an
// independent swap signal (see above), every OTHER candidate sharing that exact fingerprint may treat
// it as "a previously proven route" — the same router/route-shape has already shown real swap
// evidence elsewhere in this same evidence list, which is real (if indirect) proof this route
// genuinely transacts swaps, not merely a repeated guess.
function computeProvenRouteFingerprints(evidenceList: readonly CandidateTxEvidence[]): ReadonlySet<string> {
  const proven = new Set<string>()
  for (const evidence of evidenceList) {
    if (hasIndependentSwapSignal(evidence)) proven.add(routeFingerprintFor(evidence))
  }
  return proven
}

function qualifiesForCompletionTier(evidence: CandidateTxEvidence, provenFingerprints: ReadonlySet<string>): boolean {
  if (evidence.missingClosedLotSide === null) return false
  return hasIndependentSwapSignal(evidence) || provenFingerprints.has(routeFingerprintFor(evidence))
}

// Eligibility per this task's spec: Base only, wallet directly involved, not a clear bridge/LP/
// staking/burn/ordinary-transfer, and at least one positive swap-candidate signal.
function evaluateEligibility(
  evidence: CandidateTxEvidence,
  provenFingerprints: ReadonlySet<string>,
): { eligible: boolean; reason?: RejectReason } {
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
    // CORRECTED, DISCLOSED: structural completion (missingClosedLotSide !== null) no longer counts
    // on its own — see qualifiesForCompletionTier's own header above.
    || qualifiesForCompletionTier(evidence, provenFingerprints)

  if (!positiveSignal) return { eligible: false, reason: 'ordinary_transfer' }
  return { eligible: true }
}

// Priority per this task's exact ordering (1 = highest).
function priorityFor(
  evidence: CandidateTxEvidence,
  provenFingerprints: ReadonlySet<string>,
): { tier: 1 | 2 | 3 | 4 | 5; reason: string } {
  if (qualifiesForCompletionTier(evidence, provenFingerprints)) {
    return { tier: 1, reason: `could_complete_missing_${evidence.missingClosedLotSide}` }
  }
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

  // Computed once, over the FULL deduped evidence set, before any per-candidate eligibility/tier
  // decision — see computeProvenRouteFingerprints' own header.
  const provenFingerprints = computeProvenRouteFingerprints(deduped)

  const eligible: CandidateTxEvidence[] = []
  for (const evidence of deduped) {
    const { eligible: isEligible, reason } = evaluateEligibility(evidence, provenFingerprints)
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

  // COMPLETION-FIRST OPPOSITE-SIDE TIE-BREAK, DISCLOSED (Phase 2 — this task's explicit "prioritize
  // transactions where the existing side is stablecoin, ETH or WETH" requirement). Placed WITHIN a
  // tier, ahead of leg-pairing strength: a one-leg candidate whose already-recorded side is a
  // verified stablecoin/native/WETH leg (evidence.hasVerifiedQuoteAddress — the same real signal
  // priorityFor's own tier 3 already uses, computed by quoteLegPricing's own address allowlist, never
  // guessed here) is real evidence the receipt only needs to recover ONE unknown-value leg to
  // complete a lot — the strongest, cheapest-to-verify completion shape a receipt can resolve. This
  // never changes WHICH tier a candidate lands in (tier assignment is unchanged) — it only reorders
  // candidates WITHIN the same tier, before the existing leg-pairing/economic-value tie-breaks.
  const oppositeSideVerified = (evidence: CandidateTxEvidence): number => (evidence.hasVerifiedQuoteAddress ? 1 : 0)

  const ranked = eligible
    .map((evidence) => ({ evidence, priority: priorityFor(evidence, provenFingerprints) }))
    .sort((a, b) => {
      if (a.priority.tier !== b.priority.tier) return a.priority.tier - b.priority.tier
      const aVerified = oppositeSideVerified(a.evidence)
      const bVerified = oppositeSideVerified(b.evidence)
      if (aVerified !== bVerified) return bVerified - aVerified
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
      routeFingerprint: routeFingerprintFor(evidence),
      routerOrCounterpartyAddress: evidence.routerOrCounterpartyAddress,
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
      routeFingerprint: routeFingerprintFor(evidence),
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
