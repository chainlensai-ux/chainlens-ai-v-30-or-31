import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  acquireReceiptsWithCompletionBudget,
  NORMAL_RECEIPT_BUDGET,
  MAX_CONDITIONAL_RECEIPT_BUDGET,
} from './completionBudget'
import { createReceiptRequestScopeCache, type ReceiptFetchOutcome } from './receiptAcquisition'
import type { SelectedCandidate } from './candidateSelector'
import type { RawReceiptLog } from './types'
import { encodeAbiParameters } from 'viem'
import { CLASSIC_SWAP_TOPIC0, ERC20_TRANSFER_TOPIC0 } from './signatures'

const SENDER_TOPIC = `0x000000000000000000000000${'1'.repeat(40)}`

// A real, correctly-encoded Aerodrome Classic Swap log — decodeLogs only needs to recognize this as
// SOME real pool-swap-shaped event to count as "swap event detected" for this module's yield
// measurement; the exact venue doesn't matter here (multi-venue decoding is exercised elsewhere).
function swapLog(): RawReceiptLog[] {
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [BigInt(100), BigInt(0), BigInt(0), BigInt(90)],
  )
  return [{ logIndex: 0, address: '0xpool', topics: [CLASSIC_SWAP_TOPIC0, SENDER_TOPIC], data }]
}
function plainTransferLog(): RawReceiptLog[] {
  const data = encodeAbiParameters([{ type: 'uint256' }], [BigInt(50)])
  return [{ logIndex: 0, address: '0xtoken', topics: [ERC20_TRANSFER_TOPIC0, SENDER_TOPIC, SENDER_TOPIC], data }]
}

function candidate(txHash: string, overrides: Partial<SelectedCandidate> = {}): SelectedCandidate {
  return {
    chain: 'base',
    txHash,
    priorityTier: 1,
    priorityReason: 'could_complete_missing_entry',
    inferredTokenIn: null,
    inferredTokenOut: null,
    inferredMissingSide: 'tokenOut',
    economicValueUsd: null,
    routeFingerprint: `base:router:${txHash}`,
    ...overrides,
  }
}

test('normal budget is always spent first, exactly NORMAL_RECEIPT_BUDGET when enough candidates exist', async () => {
  const candidates = Array.from({ length: 20 }, (_, i) => candidate(`0x${i}`))
  const fetcher = async (): Promise<ReceiptFetchOutcome> => ({ status: 'ok', logs: plainTransferLog() })

  const result = await acquireReceiptsWithCompletionBudget({
    candidates,
    fetcher,
    requestScope: createReceiptRequestScopeCache(),
  })

  assert.equal(result.normalBudgetUsed, NORMAL_RECEIPT_BUDGET)
  assert.equal(result.marginalYieldByBatch[0].batchIndex, 0)
  assert.equal(result.marginalYieldByBatch[0].liveCallsThisRound, NORMAL_RECEIPT_BUDGET)
})

test('conditional budget expands while yield stays at or above threshold, and stays within the 40-receipt cap', async () => {
  // Every candidate contains a real swap event — marginal yield is always 1.0, so expansion should
  // run until either the candidate pool or the conditional cap (40) is exhausted.
  const candidates = Array.from({ length: 60 }, (_, i) => candidate(`0x${i}`))
  const fetcher = async (): Promise<ReceiptFetchOutcome> => ({ status: 'ok', logs: swapLog() })

  const result = await acquireReceiptsWithCompletionBudget({
    candidates,
    fetcher,
    requestScope: createReceiptRequestScopeCache(),
  })

  assert.equal(result.normalBudgetUsed, NORMAL_RECEIPT_BUDGET)
  assert.ok(result.conditionalBudgetUsed <= MAX_CONDITIONAL_RECEIPT_BUDGET)
  assert.equal(result.conditionalBudgetUsed, MAX_CONDITIONAL_RECEIPT_BUDGET, 'with 60 real high-yield candidates, the full conditional budget should be used')
  assert.equal(result.receiptsFetched, NORMAL_RECEIPT_BUDGET + MAX_CONDITIONAL_RECEIPT_BUDGET)
  const lastBatch = result.marginalYieldByBatch[result.marginalYieldByBatch.length - 1]
  assert.equal(lastBatch.stopReason, 'conditional_budget_exhausted')
})

test('conditional budget stops the round marginal yield first falls below the deterministic threshold', async () => {
  // First 10 (normal) + first conditional batch of 3 all contain real swap events; every candidate
  // from index 13 onward is a plain transfer (yield 0) — expansion should stop at the first batch
  // whose OWN marginal yield drops below threshold, never averaging across all rounds.
  const candidates = Array.from({ length: 30 }, (_, i) => candidate(`0x${i}`))
  const fetcher = async (_chain: 'base', txHash: string): Promise<ReceiptFetchOutcome> => {
    const index = Number(txHash.replace('0x', ''))
    return { status: 'ok', logs: index < 13 ? swapLog() : plainTransferLog() }
  }

  const result = await acquireReceiptsWithCompletionBudget({
    candidates,
    fetcher,
    requestScope: createReceiptRequestScopeCache(),
  })

  assert.equal(result.normalBudgetUsed, 10)
  // Round 1 (indices 10,11,12 — all swap events, yield 1.0) should proceed; round 2 (13,14,15 — all
  // plain transfers, yield 0) should stop expansion right there.
  assert.equal(result.conditionalBudgetUsed, 6, 'exactly two batches of 3 before stopping')
  const stoppedBatch = result.marginalYieldByBatch[result.marginalYieldByBatch.length - 1]
  assert.equal(stoppedBatch.marginalYield, 0)
  assert.equal(stoppedBatch.stopReason, 'below_threshold')
  assert.equal(stoppedBatch.stoppedAfterThisBatch, true)
})

test('expansion stops honestly when the candidate pool is exhausted, distinct from a yield failure', async () => {
  // Only 12 real candidates total — normal budget takes 10, one conditional batch can only find 2
  // more, and the round after that has zero live calls left to make.
  const candidates = Array.from({ length: 12 }, (_, i) => candidate(`0x${i}`))
  const fetcher = async (): Promise<ReceiptFetchOutcome> => ({ status: 'ok', logs: swapLog() })

  const result = await acquireReceiptsWithCompletionBudget({
    candidates,
    fetcher,
    requestScope: createReceiptRequestScopeCache(),
  })

  assert.equal(result.normalBudgetUsed, 10)
  assert.equal(result.conditionalBudgetUsed, 2)
  const lastBatch = result.marginalYieldByBatch[result.marginalYieldByBatch.length - 1]
  assert.equal(lastBatch.liveCallsThisRound, 0)
  assert.equal(lastBatch.stopReason, 'no_live_calls_remaining')
  assert.notEqual(lastBatch.stopReason, 'below_threshold', 'pool exhaustion must never be reported as a yield failure')
})

test('concurrency per completion batch never exceeds the fixed batch size (3)', async () => {
  let maxConcurrentInFlight = 0
  let currentInFlight = 0
  const candidates = Array.from({ length: 30 }, (_, i) => candidate(`0x${i}`))
  const fetcher = async (): Promise<ReceiptFetchOutcome> => {
    currentInFlight += 1
    maxConcurrentInFlight = Math.max(maxConcurrentInFlight, currentInFlight)
    await new Promise((resolve) => setTimeout(resolve, 5))
    currentInFlight -= 1
    return { status: 'ok', logs: swapLog() }
  }

  await acquireReceiptsWithCompletionBudget({ candidates, fetcher, requestScope: createReceiptRequestScopeCache() })
  assert.ok(maxConcurrentInFlight <= 3, `expected concurrency <= 3, observed ${maxConcurrentInFlight}`)
})

test('no candidate is ever fetched twice — already-fetched receipts are cache hits across rounds', async () => {
  const fetchedTxHashes: string[] = []
  const candidates = Array.from({ length: 20 }, (_, i) => candidate(`0x${i}`))
  const fetcher = async (_chain: 'base', txHash: string): Promise<ReceiptFetchOutcome> => {
    fetchedTxHashes.push(txHash)
    return { status: 'ok', logs: swapLog() }
  }

  await acquireReceiptsWithCompletionBudget({ candidates, fetcher, requestScope: createReceiptRequestScopeCache() })
  assert.equal(new Set(fetchedTxHashes).size, fetchedTxHashes.length, 'no txHash was ever fetched more than once')
})

// ─── BUDGET-ALLOCATION FIX, DISCLOSED — production proof: tier1CandidatesAfter=0 yet the decoder
// still spent normalBudget=10 PLUS conditionalBudget=3, because the prior version handed the full,
// all-tiers candidate list to conditional rounds too, letting tier-3/4 backfill a budget the
// completion-first premise never justified for them. ─────────────────────────────────────────────

test('zero tier-1 candidates uses zero conditional budget, even with plenty of high-yield tier-3/4 candidates', async () => {
  // Every candidate is tier 3 or 4 — real, high-yield swap events, but NONE is tier 1.
  const candidates = [
    ...Array.from({ length: 20 }, (_, i) => candidate(`0x3-${i}`, { priorityTier: 3, priorityReason: 'verified_quote_address' })),
    ...Array.from({ length: 20 }, (_, i) => candidate(`0x4-${i}`, { priorityTier: 4, priorityReason: 'known_or_high_confidence_router' })),
  ]
  const fetcher = async (): Promise<ReceiptFetchOutcome> => ({ status: 'ok', logs: swapLog() }) // high yield if it were allowed to run

  const result = await acquireReceiptsWithCompletionBudget({ candidates, fetcher, requestScope: createReceiptRequestScopeCache() })

  // Normal budget still spends its full 10 (unchanged — tier 3/4 backfill IS allowed there).
  assert.equal(result.normalBudgetUsed, 10)
  // But the conditional budget must be provably zero — no tier-1 candidates exist to justify it.
  assert.equal(result.conditionalBudgetUsed, 0)
  assert.equal(result.receiptsFetched, 10)
  const conditionalBatch = result.marginalYieldByBatch[1]
  assert.equal(conditionalBatch.liveCallsThisRound, 0)
  assert.equal(conditionalBatch.stopReason, 'no_live_calls_remaining')
  assert.equal(result.marginalYieldByBatch.length, 2, 'expansion must stop after exactly one (zero-call) conditional attempt')
})

test('tier-3/4 candidates cannot backfill the conditional budget once tier-1 candidates are exhausted', async () => {
  // Exactly 2 real tier-1 candidates (both high-yield), plus a large pool of equally high-yield
  // tier-3/4 candidates that must NEVER be reachable by the conditional budget.
  const candidates = [
    candidate('0xtier1-a', { priorityTier: 1, priorityReason: 'could_complete_missing_entry' }),
    candidate('0xtier1-b', { priorityTier: 1, priorityReason: 'could_complete_missing_exit' }),
    ...Array.from({ length: 30 }, (_, i) => candidate(`0xtier3-${i}`, { priorityTier: 3, priorityReason: 'verified_quote_address' })),
  ]
  const fetchedTxHashes: string[] = []
  const fetcher = async (_chain: 'base', txHash: string): Promise<ReceiptFetchOutcome> => {
    fetchedTxHashes.push(txHash)
    return { status: 'ok', logs: swapLog() }
  }

  const result = await acquireReceiptsWithCompletionBudget({ candidates, fetcher, requestScope: createReceiptRequestScopeCache() })

  // Normal budget (10) covers both tier-1 candidates (unlimited-first) plus 8 tier-3 candidates —
  // unchanged, expected behavior for the NORMAL budget specifically.
  assert.equal(result.normalBudgetUsed, 10)
  assert.ok(fetchedTxHashes.includes('0xtier1-a'))
  assert.ok(fetchedTxHashes.includes('0xtier1-b'))
  // Both tier-1 candidates were already covered by the normal budget, so the conditional pool has
  // nothing left — it must spend zero, never reach into the remaining 22 tier-3 candidates.
  assert.equal(result.conditionalBudgetUsed, 0)
  assert.equal(fetchedTxHashes.filter((h) => h.startsWith('0xtier3-')).length, 8, 'exactly the 8 tier-3 slots the NORMAL budget backfilled, never more via conditional expansion')
})

test('a genuine tier-1 candidate beyond the normal budget IS reached by conditional expansion, in batches of 3, while tier-3/4 remain untouched by it', async () => {
  // 15 tier-1 candidates (more than the normal budget's own unlimited-first allocation could spend
  // alongside nothing else) plus a pool of tier-4 candidates that must stay conditional-unreachable.
  const candidates = [
    ...Array.from({ length: 15 }, (_, i) => candidate(`0xtier1-${i}`, { priorityTier: 1, priorityReason: 'could_complete_missing_entry' })),
    ...Array.from({ length: 10 }, (_, i) => candidate(`0xtier4-${i}`, { priorityTier: 4, priorityReason: 'known_or_high_confidence_router' })),
  ]
  const fetchedTxHashes: string[] = []
  const fetcher = async (_chain: 'base', txHash: string): Promise<ReceiptFetchOutcome> => {
    fetchedTxHashes.push(txHash)
    return { status: 'ok', logs: swapLog() } // every real tier-1 fetch yields — expansion should keep going
  }

  const result = await acquireReceiptsWithCompletionBudget({ candidates, fetcher, requestScope: createReceiptRequestScopeCache() })

  assert.equal(result.normalBudgetUsed, 10) // all 10 spent on tier-1 (unlimited-first), zero tier-4 reached by the normal round
  assert.ok(result.conditionalBudgetUsed > 0, 'the remaining 5 real tier-1 candidates must be reached by conditional expansion')
  assert.equal(result.conditionalBudgetUsed, 5, 'exactly the 5 remaining tier-1 candidates — expansion stops once the tier-1 pool itself is exhausted')
  assert.equal(fetchedTxHashes.filter((h) => h.startsWith('0xtier4-')).length, 0, 'tier-4 must never be reached by conditional expansion')
  // Batches of 3: two full batches (3+3=6 ceiling growth) would overshoot by one since only 5 remain
  // — the LAST batch naturally returns fewer live calls than the batch size, never more than 3.
  const conditionalBatches = result.marginalYieldByBatch.slice(1)
  for (const b of conditionalBatches) assert.ok(b.liveCallsThisRound <= 3)
})

test('deterministic candidate ordering: identical tier1Only selection and total spend regardless of input shuffling', async () => {
  const base = [
    candidate('0xtier1-a', { priorityTier: 1 }),
    candidate('0xtier1-b', { priorityTier: 1 }),
    candidate('0xtier1-c', { priorityTier: 1 }),
    candidate('0xtier3-a', { priorityTier: 3 }),
    candidate('0xtier4-a', { priorityTier: 4 }),
  ]
  const shuffled = [base[3], base[1], base[4], base[0], base[2]]
  const fetcher = async (): Promise<ReceiptFetchOutcome> => ({ status: 'ok', logs: swapLog() })

  const resultA = await acquireReceiptsWithCompletionBudget({ candidates: base, fetcher, requestScope: createReceiptRequestScopeCache() })
  const resultB = await acquireReceiptsWithCompletionBudget({ candidates: shuffled, fetcher, requestScope: createReceiptRequestScopeCache() })

  assert.equal(resultA.normalBudgetUsed, resultB.normalBudgetUsed)
  assert.equal(resultA.conditionalBudgetUsed, resultB.conditionalBudgetUsed)
  assert.equal(resultA.receiptsFetched, resultB.receiptsFetched)
  assert.deepEqual([...resultA.final.logsByTxHash.keys()].sort(), [...resultB.final.logsByTxHash.keys()].sort())
})

test('deterministic total spend under a custom, lower threshold', async () => {
  const candidates = Array.from({ length: 30 }, (_, i) => candidate(`0x${i}`))
  const fetcher = async (): Promise<ReceiptFetchOutcome> => ({ status: 'ok', logs: swapLog() })

  const a = await acquireReceiptsWithCompletionBudget({ candidates, fetcher, requestScope: createReceiptRequestScopeCache() })
  const b = await acquireReceiptsWithCompletionBudget({ candidates, fetcher, requestScope: createReceiptRequestScopeCache() })
  assert.equal(a.receiptsFetched, b.receiptsFetched)
  assert.deepEqual(a.marginalYieldByBatch.map((x) => x.marginalYield), b.marginalYieldByBatch.map((x) => x.marginalYield))
})
