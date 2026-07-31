import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectBaseReceiptCandidates, RECEIPT_SELECTOR_ALGORITHM_VERSION, type CandidateTxEvidence } from './candidateSelector'

const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const TOKEN_X = '0x5555555555555555555555555555555555555555'
const LP_TOKEN = '0x6666666666666666666666666666666666666666'

function baseEvidence(overrides: Partial<CandidateTxEvidence> & { txHash: string }): CandidateTxEvidence {
  return {
    chain: 'base',
    legs: [],
    walletInvolved: true,
    isKnownRouter: false,
    routerConfidence: null,
    routerOrCounterpartyAddress: null,
    hasVerifiedQuoteAddress: false,
    isExistingSwapCandidate: false,
    isBridgeCandidate: false,
    isLpStakingOrBurn: false,
    missingClosedLotSide: null,
    economicValueUsd: null,
    ...overrides,
  }
}

test('two-leg (opposite-direction) transaction is eligible via the opposite-direction-legs signal', () => {
  const evidence = baseEvidence({
    txHash: '0x1',
    legs: [
      { contract: WETH, direction: 'outbound', amount: 1 },
      { contract: TOKEN_X, direction: 'inbound', amount: 500 },
    ],
  })
  const result = selectBaseReceiptCandidates([evidence])
  assert.equal(result.selectorEligibleCandidates, 1)
  assert.equal(result.baseSwapCandidates, 1)
  assert.equal(result.selected[0].inferredTokenIn, WETH)
  assert.equal(result.selected[0].inferredTokenOut, TOKEN_X)
  assert.equal(result.selected[0].inferredMissingSide, 'none')
})

test('one-leg outbound transaction with a router-like counterparty is eligible', () => {
  const evidence = baseEvidence({
    txHash: '0x1',
    legs: [{ contract: WETH, direction: 'outbound', amount: 1 }],
    routerConfidence: 'medium',
  })
  const result = selectBaseReceiptCandidates([evidence])
  assert.equal(result.selectorEligibleCandidates, 1)
  assert.equal(result.selected[0].inferredMissingSide, 'tokenOut')
})

test('one-leg transaction with NO router-like counterparty and no other signal is rejected as an ordinary transfer', () => {
  const evidence = baseEvidence({
    txHash: '0x1',
    legs: [{ contract: WETH, direction: 'outbound', amount: 1 }],
  })
  const result = selectBaseReceiptCandidates([evidence])
  assert.equal(result.selectorEligibleCandidates, 0)
  assert.equal(result.selectorReasonCounts.ordinary_transfer, 1)
  assert.equal(result.rejectedSamples[0].reason, 'ordinary_transfer')
})

test('known/high-confidence router transaction is eligible', () => {
  const evidence = baseEvidence({
    txHash: '0x1',
    legs: [{ contract: WETH, direction: 'outbound', amount: 1 }],
    isKnownRouter: true,
  })
  const result = selectBaseReceiptCandidates([evidence])
  assert.equal(result.selectorEligibleCandidates, 1)
  assert.equal(result.candidatePriorityBreakdown[4], 1)
})

test('a real closed-lot requirement missing its opposite side is eligible and gets top priority', () => {
  const evidence = baseEvidence({
    txHash: '0x1',
    legs: [{ contract: WETH, direction: 'outbound', amount: 1 }],
    missingClosedLotSide: 'exit',
  })
  const result = selectBaseReceiptCandidates([evidence])
  assert.equal(result.selectorEligibleCandidates, 1)
  assert.equal(result.candidatePriorityBreakdown[1], 1)
  assert.equal(result.selected[0].priorityTier, 1)
})

test('plain ordinary wallet transfer (single leg, no signal at all) is rejected', () => {
  const evidence = baseEvidence({
    txHash: '0x1',
    legs: [{ contract: USDC, direction: 'outbound', amount: 100 }],
  })
  const result = selectBaseReceiptCandidates([evidence])
  assert.equal(result.selectorEligibleCandidates, 0)
  assert.equal(result.selectorReasonCounts.ordinary_transfer, 1)
})

test('LP add/remove is excluded outright, even with an otherwise-eligible two-leg shape', () => {
  const evidence = baseEvidence({
    txHash: '0x1',
    legs: [
      { contract: WETH, direction: 'outbound', amount: 1 },
      { contract: LP_TOKEN, direction: 'inbound', amount: 1 },
    ],
    isLpStakingOrBurn: true,
  })
  const result = selectBaseReceiptCandidates([evidence])
  assert.equal(result.selectorEligibleCandidates, 0)
  assert.equal(result.selectorReasonCounts.lp_staking_or_burn, 1)
})

test('a clear bridge candidate is excluded outright', () => {
  const evidence = baseEvidence({
    txHash: '0x1',
    legs: [{ contract: WETH, direction: 'outbound', amount: 1 }, { contract: WETH, direction: 'unknown', amount: 1 }],
    isBridgeCandidate: true,
    isExistingSwapCandidate: true, // even a strong swap-like signal never overrides a bridge exclusion
  })
  const result = selectBaseReceiptCandidates([evidence])
  assert.equal(result.selectorEligibleCandidates, 0)
  assert.equal(result.selectorReasonCounts.bridge_candidate, 1)
})

test('non-base chain is excluded regardless of any other signal', () => {
  const evidence = baseEvidence({ txHash: '0x1', chain: 'eth', isExistingSwapCandidate: true })
  const result = selectBaseReceiptCandidates([evidence])
  assert.equal(result.selectorEligibleCandidates, 0)
  assert.equal(result.selectorReasonCounts.unsupported_chain, 1)
})

test('a transaction not involving the wallet directly is excluded', () => {
  const evidence = baseEvidence({
    txHash: '0x1',
    walletInvolved: false,
    legs: [{ contract: WETH, direction: 'unknown', amount: 1 }],
    isExistingSwapCandidate: true,
  })
  const result = selectBaseReceiptCandidates([evidence])
  assert.equal(result.selectorEligibleCandidates, 0)
  assert.equal(result.selectorReasonCounts.wallet_not_involved, 1)
})

test('priority ordering: missing-closed-lot-side ranks above existing-swap-candidate ranks above verified-quote ranks above router ranks above economic-value-only', () => {
  const evidence: CandidateTxEvidence[] = [
    baseEvidence({ txHash: '0x5', legs: [{ contract: WETH, direction: 'outbound', amount: 1 }], isKnownRouter: true }),
    baseEvidence({ txHash: '0x1', legs: [{ contract: WETH, direction: 'outbound', amount: 1 }], missingClosedLotSide: 'entry' }),
    baseEvidence({ txHash: '0x3', legs: [{ contract: WETH, direction: 'outbound', amount: 1 }], hasVerifiedQuoteAddress: true, isKnownRouter: true }),
    baseEvidence({ txHash: '0x2', legs: [{ contract: WETH, direction: 'outbound', amount: 1 }], isExistingSwapCandidate: true }),
    baseEvidence({ txHash: '0x4', legs: [{ contract: WETH, direction: 'outbound', amount: 1 }, { contract: TOKEN_X, direction: 'inbound', amount: 1 }] }),
  ]
  const result = selectBaseReceiptCandidates(evidence)
  assert.deepEqual(result.selected.map((s) => s.txHash), ['0x1', '0x2', '0x3', '0x5', '0x4'])
  assert.deepEqual(result.selected.map((s) => s.priorityTier), [1, 2, 3, 4, 5])
})

test('Phase 2: within tier 1, a one-side-missing candidate whose existing leg is stable/ETH/WETH-verified outranks one that is not', () => {
  const evidence: CandidateTxEvidence[] = [
    // Tier 1, but the existing leg is an unverified token — weaker completion evidence.
    baseEvidence({ txHash: '0xweak', legs: [{ contract: TOKEN_X, direction: 'outbound', amount: 1 }], missingClosedLotSide: 'entry' }),
    // Tier 1 AND the existing leg is a verified stablecoin/ETH/WETH quote — the strongest, cheapest
    // completion shape a receipt can resolve (this task's explicit "prioritize transactions where
    // the existing side is stablecoin, ETH or WETH" requirement).
    baseEvidence({ txHash: '0xstrong', legs: [{ contract: WETH, direction: 'outbound', amount: 1 }], missingClosedLotSide: 'exit', hasVerifiedQuoteAddress: true }),
  ]
  const result = selectBaseReceiptCandidates(evidence)
  assert.deepEqual(result.selected.map((s) => s.txHash), ['0xstrong', '0xweak'])
  // Both remain tier 1 — this only reorders WITHIN the tier, never changes tier assignment.
  assert.deepEqual(result.selected.map((s) => s.priorityTier), [1, 1])
})

test('Phase 2: a completion-first (tier 1) candidate outranks a generic known-router (tier 4) transaction', () => {
  const evidence: CandidateTxEvidence[] = [
    baseEvidence({ txHash: '0xrouter', legs: [{ contract: WETH, direction: 'outbound', amount: 1 }], isKnownRouter: true }),
    baseEvidence({ txHash: '0xcompletion', legs: [{ contract: WETH, direction: 'outbound', amount: 1 }], missingClosedLotSide: 'entry' }),
  ]
  const result = selectBaseReceiptCandidates(evidence)
  assert.deepEqual(result.selected.map((s) => s.txHash), ['0xcompletion', '0xrouter'])
})

test('deterministic chain+txHash tie-break within the same priority tier', () => {
  const evidence: CandidateTxEvidence[] = [
    baseEvidence({ txHash: '0xbbb', legs: [{ contract: WETH, direction: 'outbound', amount: 1 }], isExistingSwapCandidate: true }),
    baseEvidence({ txHash: '0xaaa', legs: [{ contract: WETH, direction: 'outbound', amount: 1 }], isExistingSwapCandidate: true }),
  ]
  const result = selectBaseReceiptCandidates(evidence)
  assert.deepEqual(result.selected.map((s) => s.txHash), ['0xaaa', '0xbbb'])
})

test('dedupe by chain:txHash — a duplicate evidence entry for the same tx counts once', () => {
  const evidence: CandidateTxEvidence[] = [
    baseEvidence({ txHash: '0x1', legs: [{ contract: WETH, direction: 'outbound', amount: 1 }], isExistingSwapCandidate: true }),
    baseEvidence({ txHash: '0x1', legs: [{ contract: WETH, direction: 'outbound', amount: 1 }], isExistingSwapCandidate: true }),
  ]
  const result = selectBaseReceiptCandidates(evidence)
  assert.equal(result.selectorEligibleCandidates, 1)
  assert.equal(result.baseSwapCandidates, 1)
})

test('selection is bounded to 25 even with many eligible candidates', () => {
  const evidence: CandidateTxEvidence[] = Array.from({ length: 40 }, (_, i) =>
    baseEvidence({ txHash: `0x${i.toString().padStart(3, '0')}`, legs: [{ contract: WETH, direction: 'outbound', amount: 1 }], isExistingSwapCandidate: true }))
  const result = selectBaseReceiptCandidates(evidence)
  assert.equal(result.selectorEligibleCandidates, 40)
  assert.equal(result.baseSwapCandidates, 25)
  assert.equal(result.selected.length, 25)
})

test('rejected samples are bounded to 10 even with many rejections', () => {
  const evidence: CandidateTxEvidence[] = Array.from({ length: 20 }, (_, i) =>
    baseEvidence({ txHash: `0x${i}`, legs: [{ contract: WETH, direction: 'outbound', amount: 1 }] }))
  const result = selectBaseReceiptCandidates(evidence)
  assert.equal(result.selectorReasonCounts.ordinary_transfer, 20)
  assert.equal(result.rejectedSamples.length, 10)
})

test('selectorTransactionsConsidered reflects the full input, including duplicates and rejections', () => {
  const evidence: CandidateTxEvidence[] = [
    baseEvidence({ txHash: '0x1', legs: [{ contract: WETH, direction: 'outbound', amount: 1 }], isExistingSwapCandidate: true }),
    baseEvidence({ txHash: '0x1', legs: [{ contract: WETH, direction: 'outbound', amount: 1 }], isExistingSwapCandidate: true }),
    baseEvidence({ txHash: '0x2', legs: [{ contract: WETH, direction: 'outbound', amount: 1 }] }),
  ]
  const result = selectBaseReceiptCandidates(evidence)
  assert.equal(result.selectorTransactionsConsidered, 3)
})

test('deterministic output: identical input produces byte-identical results across repeated calls', () => {
  const evidence: CandidateTxEvidence[] = [
    baseEvidence({ txHash: '0x1', legs: [{ contract: WETH, direction: 'outbound', amount: 1 }, { contract: TOKEN_X, direction: 'inbound', amount: 1 }] }),
    baseEvidence({ txHash: '0x2', legs: [{ contract: WETH, direction: 'outbound', amount: 1 }] }),
  ]
  const r1 = selectBaseReceiptCandidates(evidence)
  const r2 = selectBaseReceiptCandidates(evidence)
  assert.deepEqual(r1, r2)
})

// WITHIN-TIER LEG-PAIRING RANKING FIX, DISCLOSED (production proof: 25 eligible, 10 fetched, 8/10
// ended plain_transfer_no_swap_event, 0 exact swaps). A candidate with both an inbound AND an
// outbound leg already recorded is much stronger pre-fetch evidence of a real, decodable swap than
// a single-leg candidate that only qualified via a router touch -- these tests prove that ordering
// within a tier, without changing which tier either candidate lands in.
test('within tier 4 (known/high-confidence router), a two-leg (paired) candidate is selected before a one-leg (router-touch-only) candidate, despite lower economic value', () => {
  const paired = baseEvidence({
    txHash: '0xpaired',
    legs: [{ contract: WETH, direction: 'outbound', amount: 1 }, { contract: TOKEN_X, direction: 'inbound', amount: 1 }],
    routerConfidence: 'high',
    economicValueUsd: 10,
  })
  const singleLeg = baseEvidence({
    txHash: '0xsingle',
    legs: [{ contract: WETH, direction: 'outbound', amount: 1 }],
    routerConfidence: 'high',
    economicValueUsd: 1000,
  })
  const result = selectBaseReceiptCandidates([singleLeg, paired])
  assert.equal(result.selected[0].txHash, '0xpaired')
  assert.equal(result.selected[1].txHash, '0xsingle')
  // Both still land in tier 4 -- this is a within-tier reorder, never a tier change.
  assert.equal(result.selected[0].priorityTier, 4)
  assert.equal(result.selected[1].priorityTier, 4)
})

test('within tier 3 (verified quote address), paired-leg candidates outrank single-leg candidates before the economic-value tie-break applies', () => {
  const paired = baseEvidence({
    txHash: '0xpaired',
    legs: [{ contract: WETH, direction: 'outbound', amount: 1 }, { contract: TOKEN_X, direction: 'inbound', amount: 1 }],
    hasVerifiedQuoteAddress: true,
    routerConfidence: 'medium',
    economicValueUsd: null,
  })
  const singleLeg = baseEvidence({
    txHash: '0xsingle',
    legs: [{ contract: WETH, direction: 'outbound', amount: 1 }],
    hasVerifiedQuoteAddress: true,
    routerConfidence: 'medium',
    economicValueUsd: 5000,
  })
  const result = selectBaseReceiptCandidates([singleLeg, paired])
  assert.equal(result.selected[0].txHash, '0xpaired')
  assert.equal(result.selected[0].priorityTier, 3)
})

test('among two paired-leg candidates in the same tier, economic value still tie-breaks as before', () => {
  const higherValue = baseEvidence({
    txHash: '0xhigh',
    legs: [{ contract: WETH, direction: 'outbound', amount: 1 }, { contract: TOKEN_X, direction: 'inbound', amount: 1 }],
    routerConfidence: 'high',
    economicValueUsd: 500,
  })
  const lowerValue = baseEvidence({
    txHash: '0xlow',
    legs: [{ contract: WETH, direction: 'outbound', amount: 1 }, { contract: USDC, direction: 'inbound', amount: 1 }],
    routerConfidence: 'high',
    economicValueUsd: 10,
  })
  const result = selectBaseReceiptCandidates([lowerValue, higherValue])
  assert.equal(result.selected[0].txHash, '0xhigh')
  assert.equal(result.selected[1].txHash, '0xlow')
})

test('RECEIPT_SELECTOR_ALGORITHM_VERSION is a non-empty string, present for deployment verification', () => {
  assert.equal(typeof RECEIPT_SELECTOR_ALGORITHM_VERSION, 'string')
  assert.ok(RECEIPT_SELECTOR_ALGORITHM_VERSION.length > 0)
})

test('orderingTrace reports pairingStrength, leg counts, tier, and final sorted position matching selected order', () => {
  const paired = baseEvidence({
    txHash: '0xpaired',
    legs: [{ contract: WETH, direction: 'outbound', amount: 1 }, { contract: TOKEN_X, direction: 'inbound', amount: 1 }],
    routerConfidence: 'high',
    economicValueUsd: 100,
  })
  const single = baseEvidence({
    txHash: '0xsingle',
    legs: [{ contract: WETH, direction: 'outbound', amount: 1 }],
    routerConfidence: 'high',
    economicValueUsd: 5000,
  })
  const result = selectBaseReceiptCandidates([single, paired])
  assert.equal(result.orderingTrace.length, 2)
  const pairedTrace = result.orderingTrace.find((t) => t.txHash === '0xpaired')
  const singleTrace = result.orderingTrace.find((t) => t.txHash === '0xsingle')
  assert.ok(pairedTrace)
  assert.ok(singleTrace)
  assert.equal(pairedTrace?.pairingStrength, 1)
  assert.equal(pairedTrace?.inboundLegCount, 1)
  assert.equal(pairedTrace?.outboundLegCount, 1)
  assert.equal(pairedTrace?.distinctTokenCount, 2)
  assert.equal(singleTrace?.pairingStrength, 0)
  assert.equal(singleTrace?.finalSortedPosition, 1)
  assert.equal(pairedTrace?.finalSortedPosition, 0)
  assert.deepEqual(result.orderingTrace.map((t) => t.txHash), result.selected.map((s) => s.txHash))
})

test('orderingTrace.originalIndex reflects position in the raw input list, independent of final sort order', () => {
  const evidenceList = [
    baseEvidence({ txHash: '0xfirst', legs: [{ contract: WETH, direction: 'outbound', amount: 1 }], routerConfidence: 'high', economicValueUsd: 1 }),
    baseEvidence({
      txHash: '0xsecond',
      legs: [{ contract: WETH, direction: 'outbound', amount: 1 }, { contract: TOKEN_X, direction: 'inbound', amount: 1 }],
      routerConfidence: 'high',
      economicValueUsd: 1,
    }),
  ]
  const result = selectBaseReceiptCandidates(evidenceList)
  const first = result.orderingTrace.find((t) => t.txHash === '0xfirst')
  const second = result.orderingTrace.find((t) => t.txHash === '0xsecond')
  assert.equal(first?.originalIndex, 0)
  assert.equal(second?.originalIndex, 1)
  // Paired candidate ('0xsecond') outranks single-leg ('0xfirst') despite arriving second in input.
  assert.equal(result.selected[0].txHash, '0xsecond')
})
