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

test('deterministic total spend under a custom, lower threshold', async () => {
  const candidates = Array.from({ length: 30 }, (_, i) => candidate(`0x${i}`))
  const fetcher = async (): Promise<ReceiptFetchOutcome> => ({ status: 'ok', logs: swapLog() })

  const a = await acquireReceiptsWithCompletionBudget({ candidates, fetcher, requestScope: createReceiptRequestScopeCache() })
  const b = await acquireReceiptsWithCompletionBudget({ candidates, fetcher, requestScope: createReceiptRequestScopeCache() })
  assert.equal(a.receiptsFetched, b.receiptsFetched)
  assert.deepEqual(a.marginalYieldByBatch.map((x) => x.marginalYield), b.marginalYieldByBatch.map((x) => x.marginalYield))
})
