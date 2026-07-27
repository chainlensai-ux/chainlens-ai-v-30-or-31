import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectBaseReceiptCandidates, type CandidateTxEvidence } from './candidateSelector'

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
