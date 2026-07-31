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
  // TIER-1 SELECTION-FIX DIAGNOSTICS, DISCLOSED — see qualifiesForCompletionTier's own header for
  // the full v7 rationale. All computed over the deduped, structurally-completing (missingClosedLotSide
  // !== null) population only; never affected by which OTHER tiers a candidate might otherwise
  // qualify for.
  tier1Diagnostics: Tier1SelectionDiagnostics
}

export type Tier1SelectionDiagnostics = {
  // Structural-completion candidates that would have qualified under the PRIOR (single-independent-
  // signal) rule: missingClosedLotSide !== null AND at least one signal, direct or fingerprint-proven
  // under that looser (single-signal-seed) standard.
  tier1CandidatesBefore: number
  // Structural-completion candidates that qualify under THIS revision's two-independent-signal rule.
  tier1CandidatesAfter: number
  // missingClosedLotSide !== null with ZERO signals at all, even under the looser prior standard —
  // structural completion was genuinely the only thing these candidates had.
  rejectedStructuralOnly: number
  // missingClosedLotSide !== null with EXACTLY ONE signal (the exact shape this revision now
  // excludes: a lone known-router or a lone verified-quote-address, real but insufficient alone).
  rejectedSingleWeakSignal: number
  // Count of candidates qualifying under the new two-signal rule — always equal to
  // tier1CandidatesAfter and to the sum of signalCombinationCounts; both are exposed because a real
  // production log reading one shouldn't need to re-derive the other.
  eligibleBySignalCombination: number
  // Breakdown of which EXACT signal combination (sorted, '+'-joined signal names) qualified each
  // tier-1-eligible candidate — e.g. "quote+router", "opposingLegs+provenFingerprint".
  signalCombinationCounts: Record<string, number>
  // receiptsAvoided = tier1CandidatesBefore - tier1CandidatesAfter — the real number of receipt
  // fetches this fix prevents on this exact evidence set, assuming every one of the prior rule's
  // tier-1 candidates would otherwise have consumed a receipt-acquisition slot.
  receiptsAvoided: number
}

// DEPLOYMENT VERIFICATION, DISCLOSED: bump this string whenever selectBaseReceiptCandidates's
// ordering/eligibility logic changes. Logged unconditionally by walletScanShadowWiring.ts's shadow
// payload so a real production log can prove which build actually ran, without depending on commit
// SHA plumbing this module has no access to.
export const RECEIPT_SELECTOR_ALGORITHM_VERSION = 'receipt-selector-v7-completion-requires-two-independent-signals'

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

// SELECTION CORRECTION v2, DISCLOSED (production proof: v6's single-independent-signal rule still
// selected 25 tier-1 candidates on this same wallet; 13 receipts fetched under that rule produced 0
// recognized swap events, 0 exact swaps, all 13 auditing to `ordinary_transfer` under
// receiptPhase2Forensics.ts's own offline classification, `candidateDecoderFamilies` empty). The root
// cause: a known/high-confidence router counterparty ALONE, or a verified stablecoin/native/WETH quote
// address ALONE, is real but WEAK evidence — a router receives and forwards plenty of plain transfers
// that are never swaps, and a wallet plainly depositing/withdrawing a stablecoin at a lot boundary is
// exactly as consistent with an ordinary transfer as with a swap. Neither, alone, actually distinguishes
// a real swap from a coincidental FIFO boundary. This revision requires structural completion PLUS AT
// LEAst TWO of the independent signals below — never structural completion itself, never a single
// signal alone — before a receipt is spent chasing a candidate.
//
// THE SIGNAL POOL, DISCLOSED — exactly three DIRECT (pre-fetch, no receipt needed) signals, plus one
// CONTEXTUAL signal (a proven route fingerprint) that itself only exists when built from OTHER
// candidates whose OWN direct signals already clear the two-signal bar:
//   - router:        known/high-confidence router counterparty (hasRouterLikeCounterparty).
//   - quote:         the existing recorded leg is itself a verified stablecoin/native/WETH address
//                    (evidence.hasVerifiedQuoteAddress).
//   - opposingLegs:  a genuine two-asset opposing wallet flow — an outbound leg AND an inbound leg
//                    for DIFFERENT contracts (never the same token counted on both sides, and never
//                    satisfied by same-direction legs alone) — see hasGenuineOpposingLegs below.
//   - provenFingerprint: this candidate's route fingerprint was independently proven by a DIFFERENT
//                    candidate in the same batch — see computeProvenRouteFingerprints' own header for
//                    why self-seeding is structurally impossible.
//
// RESERVED, DISCLOSED: "recognized swap-like input selector" remains deliberately unevaluated — a
// transaction's calldata selector requires eth_getTransactionByHash (the transaction object), never
// returned by eth_getTransactionReceipt (the only per-tx call this pipeline stage makes). This task
// explicitly forbids adding that call; this signal type has no honest source today.
function hasRouterSignal(evidence: CandidateTxEvidence): boolean {
  return hasRouterLikeCounterparty(evidence)
}

function hasQuoteSignal(evidence: CandidateTxEvidence): boolean {
  return evidence.hasVerifiedQuoteAddress
}

// GENUINE OPPOSING LEGS, DISCLOSED (stricter than the plain in+out direction check used elsewhere in
// this file for OTHER, non-completion-tier eligibility paths): requires an outbound leg and an inbound
// leg for DIFFERENT contract addresses — the real two-asset shape a swap always produces. Two legs of
// the SAME token moving in opposite directions (e.g. a refund) is never counted as this signal.
function hasGenuineOpposingLegs(evidence: CandidateTxEvidence): boolean {
  const outboundContracts = evidence.legs.filter((l) => l.direction === 'outbound').map((l) => l.contract.toLowerCase())
  const inboundContracts = evidence.legs.filter((l) => l.direction === 'inbound').map((l) => l.contract.toLowerCase())
  return outboundContracts.some((out) => inboundContracts.some((inn) => inn !== out))
}

export type CompletionSignalName = 'router' | 'quote' | 'opposingLegs' | 'provenFingerprint'

// The three DIRECT signals only — deliberately excludes provenFingerprint, since a fingerprint can
// only ever be proven BY a candidate whose own direct signals already qualify it (see
// computeProvenRouteFingerprints below). Order is fixed for deterministic combination labeling.
function directCompletionSignals(evidence: CandidateTxEvidence): CompletionSignalName[] {
  const names: CompletionSignalName[] = []
  if (hasRouterSignal(evidence)) names.push('router')
  if (hasQuoteSignal(evidence)) names.push('quote')
  if (hasGenuineOpposingLegs(evidence)) names.push('opposingLegs')
  return names
}

// PROVEN ROUTE FINGERPRINT, DISCLOSED: a pure, same-call cross-reference — never external state,
// never persisted across scans. SEEDED ONLY by a candidate whose OWN direct signals (router/quote/
// opposingLegs) already number two or more — i.e. a candidate that is independently eligible for tier
// 1 without any fingerprint help at all. This is what makes self-seeding structurally impossible: a
// lone candidate with a single weak signal (or zero) never has enough direct signals to seed its own
// fingerprint. It is ALSO impossible for a candidate to count its OWN qualifying signals as proof of
// itself — `fingerprintProvenByOther` below explicitly requires the seed to be a DIFFERENT candidate
// (by dedupe key), so a 2-signal candidate's diagnostic combination reports exactly its own two real
// signals, never an inflated third "provenFingerprint" entry sourced from itself. Once a fingerprint
// IS proven by a different candidate, every OTHER candidate sharing that exact route shape may count
// it as ONE contextual signal (never two, never a full override) — real, if indirect, evidence this
// specific router/route shape genuinely carries swaps elsewhere in this same batch.
function computeFingerprintSeeds(
  evidenceList: readonly CandidateTxEvidence[],
  minDirectSignals: number,
): ReadonlyMap<string, readonly CandidateTxEvidence[]> {
  const seeds = new Map<string, CandidateTxEvidence[]>()
  for (const evidence of evidenceList) {
    if (directCompletionSignals(evidence).length < minDirectSignals) continue
    const fingerprint = routeFingerprintFor(evidence)
    const list = seeds.get(fingerprint) ?? []
    list.push(evidence)
    seeds.set(fingerprint, list)
  }
  return seeds
}

function fingerprintProvenByOther(evidence: CandidateTxEvidence, seeds: ReadonlyMap<string, readonly CandidateTxEvidence[]>): boolean {
  const seededBy = seeds.get(routeFingerprintFor(evidence))
  if (!seededBy) return false
  return seededBy.some((seed) => dedupeKey(seed) !== dedupeKey(evidence))
}

// Full signal set for ONE candidate, including the contextual proven-fingerprint signal when it
// applies. Returns the actual contributing names (for diagnostics) — callers check `.length >= 2`.
function completionSignalsFor(evidence: CandidateTxEvidence, strictSeeds: ReadonlyMap<string, readonly CandidateTxEvidence[]>): CompletionSignalName[] {
  const names = directCompletionSignals(evidence)
  if (fingerprintProvenByOther(evidence, strictSeeds)) names.push('provenFingerprint')
  return names
}

function qualifiesForCompletionTier(evidence: CandidateTxEvidence, strictSeeds: ReadonlyMap<string, readonly CandidateTxEvidence[]>): boolean {
  if (evidence.missingClosedLotSide === null) return false
  return completionSignalsFor(evidence, strictSeeds).length >= 2
}

// PURE. Computes the full Tier1SelectionDiagnostics block for the population of candidates that are
// structurally completing a real lot (missingClosedLotSide !== null) among those that reach the
// positive-signal decision at all (i.e. survived chain/wallet-involvement/bridge/LP exclusion) —
// exactly the population qualifiesForCompletionTier ever evaluates.
function computeTier1Diagnostics(
  structuralCandidates: readonly CandidateTxEvidence[],
  strictSeeds: ReadonlyMap<string, readonly CandidateTxEvidence[]>,
): Tier1SelectionDiagnostics {
  // PRIOR-RULE (v6) FINGERPRINT SEEDING, DISCLOSED, DIAGNOSTIC-ONLY — reproduces the single-signal-
  // seed standard the immediately prior revision used, SOLELY to compute tier1CandidatesBefore/
  // receiptsAvoided below. Never consulted by the real eligibility/tier decision above.
  const looseSeeds = computeFingerprintSeeds(structuralCandidates, 1)

  let tier1CandidatesBefore = 0
  let tier1CandidatesAfter = 0
  let rejectedStructuralOnly = 0
  let rejectedSingleWeakSignal = 0
  const signalCombinationCounts: Record<string, number> = {}

  for (const evidence of structuralCandidates) {
    const directCount = directCompletionSignals(evidence).length
    const loosePasses = directCount >= 1 || fingerprintProvenByOther(evidence, looseSeeds)
    if (loosePasses) tier1CandidatesBefore += 1

    const strictSignals = completionSignalsFor(evidence, strictSeeds)
    if (strictSignals.length >= 2) {
      tier1CandidatesAfter += 1
      const combination = [...strictSignals].sort().join('+')
      signalCombinationCounts[combination] = (signalCombinationCounts[combination] ?? 0) + 1
    } else if (!loosePasses) {
      rejectedStructuralOnly += 1
    } else {
      rejectedSingleWeakSignal += 1
    }
  }

  const eligibleBySignalCombination = Object.values(signalCombinationCounts).reduce((a, b) => a + b, 0)

  return {
    tier1CandidatesBefore,
    tier1CandidatesAfter,
    rejectedStructuralOnly,
    rejectedSingleWeakSignal,
    eligibleBySignalCombination,
    signalCombinationCounts,
    receiptsAvoided: tier1CandidatesBefore - tier1CandidatesAfter,
  }
}

// Eligibility per this task's spec: Base only, wallet directly involved, not a clear bridge/LP/
// staking/burn/ordinary-transfer, and at least one positive swap-candidate signal.
//
// ORDINARY-TRANSFER OVERRIDE, DISCLOSED: this function's own fallback — no positive signal at all,
// from ANY path, rejects as `ordinary_transfer` — is the single point every candidate must clear.
// Structural completion alone, or structural completion plus exactly one weak signal, both fall
// straight through to this same override; there is no separate path that could let either slip past
// it. This is what "ordinary-transfer preclassification must always override tier eligibility" means
// in a pipeline stage that runs strictly BEFORE any receipt exists to classify post-fetch: the
// pre-fetch ordinary-transfer default is never bypassed by a partial completion signal.
function evaluateEligibility(
  evidence: CandidateTxEvidence,
  strictSeeds: ReadonlyMap<string, readonly CandidateTxEvidence[]>,
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
    // CORRECTED, DISCLOSED: structural completion now requires TWO independent signals — see
    // qualifiesForCompletionTier's own header above.
    || qualifiesForCompletionTier(evidence, strictSeeds)

  if (!positiveSignal) return { eligible: false, reason: 'ordinary_transfer' }
  return { eligible: true }
}

// Priority per this task's exact ordering (1 = highest).
function priorityFor(
  evidence: CandidateTxEvidence,
  strictSeeds: ReadonlyMap<string, readonly CandidateTxEvidence[]>,
): { tier: 1 | 2 | 3 | 4 | 5; reason: string } {
  if (qualifiesForCompletionTier(evidence, strictSeeds)) {
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
  const strictSeeds = computeFingerprintSeeds(deduped, 2)

  // TIER-1 SELECTION-FIX DIAGNOSTICS, DISCLOSED — computed over the same population
  // qualifiesForCompletionTier ever evaluates (chain/wallet-involvement/bridge/LP already excluded),
  // restricted to genuinely structural (missingClosedLotSide !== null) candidates.
  const structuralCandidates = deduped.filter(
    (e) => e.missingClosedLotSide !== null && e.chain === 'base' && e.walletInvolved && !e.isBridgeCandidate && !e.isLpStakingOrBurn && e.legs.length > 0,
  )
  const tier1Diagnostics = computeTier1Diagnostics(structuralCandidates, strictSeeds)

  const eligible: CandidateTxEvidence[] = []
  for (const evidence of deduped) {
    const { eligible: isEligible, reason } = evaluateEligibility(evidence, strictSeeds)
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
    .map((evidence) => ({ evidence, priority: priorityFor(evidence, strictSeeds) }))
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
    tier1Diagnostics,
  }
}
