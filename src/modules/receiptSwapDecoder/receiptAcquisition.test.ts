import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  acquireReceiptsForCandidates, createReceiptRequestScopeCache, receiptCacheKey,
  type ReceiptFetcher, type ReceiptFetchOutcome,
} from './receiptAcquisition'
import type { SelectedCandidate } from './candidateSelector'
import type { RawReceiptLog } from './types'
import { transferLog, slipstreamSwapLog, POOL_A, WALLET, TOKEN_X } from './fixtures.test-helpers'

function candidate(
  txHash: string, priorityTier: 1 | 2 | 3 | 4 | 5 = 2,
  tokenIn = '0xaaa', tokenOut = '0xbbb',
): SelectedCandidate {
  return {
    chain: 'base',
    txHash,
    priorityTier,
    priorityReason: 'existing_one_leg_swap_candidate',
    inferredTokenIn: tokenIn,
    inferredTokenOut: tokenOut,
    inferredMissingSide: 'none',
    economicValueUsd: null,
  }
}

const WETH = '0x4200000000000000000000000000000000000006'

function plainTransferLogs(): RawReceiptLog[] {
  return [transferLog(0, WETH, WALLET, '0x9999999999999999999999999999999999999999', BigInt('1000000000000000000'))]
}

function realSwapLogs(): RawReceiptLog[] {
  return [
    transferLog(0, WETH, WALLET, POOL_A, BigInt('1000000000000000000')),
    slipstreamSwapLog(1, POOL_A, WALLET, WALLET, BigInt('1000000000000000000'), BigInt('-100000000000000000000')),
    transferLog(2, TOKEN_X, POOL_A, WALLET, BigInt('100000000000000000000')),
  ]
}

function countingFetcher(outcomeFor: (txHash: string) => ReceiptFetchOutcome, calls: string[]): ReceiptFetcher {
  return async (_chain, txHash) => {
    calls.push(txHash)
    return outcomeFor(txHash)
  }
}

test('caps live receipt calls at maxLiveCalls (default 10) even with more eligible candidates', async () => {
  const candidates = Array.from({ length: 25 }, (_, i) => candidate(`0x${i}`))
  const calls: string[] = []
  const result = await acquireReceiptsForCandidates({
    candidates,
    fetcher: countingFetcher(() => ({ status: 'missing' }), calls),
    requestScope: createReceiptRequestScopeCache(),
  })
  assert.equal(result.counters.receiptCandidatesTotal, 25)
  assert.equal(result.counters.receiptCandidatesSelected, 10)
  assert.equal(result.counters.receiptCandidatesCapped, 15)
  assert.equal(result.counters.receiptLiveCalls, 10)
  assert.equal(result.counters.receiptProviderCalls, 10)
  assert.equal(calls.length, 10)
})

test('deterministic selection: the first N candidates by priority order are the ones fetched', async () => {
  const candidates = [candidate('0xhigh', 1), candidate('0xmed', 3), candidate('0xlow', 5)]
  const calls: string[] = []
  await acquireReceiptsForCandidates({
    candidates,
    fetcher: countingFetcher(() => ({ status: 'missing' }), calls),
    requestScope: createReceiptRequestScopeCache(),
    maxLiveCalls: 2,
  })
  assert.deepEqual(calls, ['0xhigh', '0xmed'])
})

test('request-scoped cache: a pre-seeded receipt is reused, never triggers a live call', async () => {
  const requestScope = createReceiptRequestScopeCache()
  requestScope.cache.set(receiptCacheKey('base', '0x1'), {
    status: 'ok',
    logs: [{ logIndex: 0, address: '0xpool', topics: ['0xtopic'], data: '0x' }],
  })
  const calls: string[] = []
  const result = await acquireReceiptsForCandidates({
    candidates: [candidate('0x1')],
    fetcher: countingFetcher(() => ({ status: 'missing' }), calls),
    requestScope,
  })
  assert.equal(calls.length, 0)
  assert.equal(result.counters.receiptCacheHits, 1)
  assert.equal(result.counters.receiptLiveCalls, 0)
  assert.equal(result.counters.receiptProviderCalls, 0)
  assert.ok(result.logsByTxHash.has('0x1'))
})

test('singleflight: two candidates sharing the same chain:txHash key only trigger one live call', async () => {
  let liveCallCount = 0
  let resolveFetch: ((outcome: ReceiptFetchOutcome) => void) | null = null
  const fetcher: ReceiptFetcher = async () => {
    liveCallCount += 1
    return new Promise((resolve) => { resolveFetch = resolve })
  }
  const requestScope = createReceiptRequestScopeCache()
  const resultPromise = acquireReceiptsForCandidates({
    candidates: [candidate('0xdup'), candidate('0xdup')],
    fetcher,
    requestScope,
    concurrency: 3,
  })
  // Let both processOne() calls start before resolving the single in-flight fetch.
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(liveCallCount, 1)
  resolveFetch!({ status: 'ok', logs: [] })
  const result = await resultPromise
  assert.equal(result.counters.receiptLiveCalls, 1)
  assert.equal(result.counters.receiptSingleflightHits, 1)
  assert.equal(result.counters.receiptProviderCalls, 1)
})

test('per-call timeout: a fetch that never resolves in time is counted as a timeout, not a live success', async () => {
  const fetcher: ReceiptFetcher = () => new Promise(() => {}) // never resolves
  const result = await acquireReceiptsForCandidates({
    candidates: [candidate('0xslow')],
    fetcher,
    requestScope: createReceiptRequestScopeCache(),
    timeoutMs: 20,
  })
  assert.equal(result.counters.receiptTimeouts, 1)
  assert.equal(result.logsByTxHash.has('0xslow'), false)
})

test('malformed receipt (fetcher throws) fails closed as malformed, never surfaces as available', async () => {
  const fetcher: ReceiptFetcher = async () => { throw new Error('boom') }
  const result = await acquireReceiptsForCandidates({
    candidates: [candidate('0xbad')],
    fetcher,
    requestScope: createReceiptRequestScopeCache(),
  })
  assert.equal(result.counters.receiptMalformed, 1)
  assert.equal(result.logsByTxHash.has('0xbad'), false)
})

test('reverted receipt is counted separately and never treated as available', async () => {
  const result = await acquireReceiptsForCandidates({
    candidates: [candidate('0xreverted')],
    fetcher: async () => ({ status: 'reverted' }),
    requestScope: createReceiptRequestScopeCache(),
  })
  assert.equal(result.counters.receiptReverted, 1)
  assert.equal(result.logsByTxHash.has('0xreverted'), false)
})

test('missing receipt is counted separately and never treated as available', async () => {
  const result = await acquireReceiptsForCandidates({
    candidates: [candidate('0xmissing')],
    fetcher: async () => ({ status: 'missing' }),
    requestScope: createReceiptRequestScopeCache(),
  })
  assert.equal(result.counters.receiptMissingResults, 1)
})

test('no retries: a timed-out or errored fetch is attempted exactly once, never called twice for the same key', async () => {
  const calls: string[] = []
  const fetcher: ReceiptFetcher = async (_chain, txHash) => { calls.push(txHash); throw new Error('boom') }
  await acquireReceiptsForCandidates({
    candidates: [candidate('0x1')],
    fetcher,
    requestScope: createReceiptRequestScopeCache(),
  })
  assert.equal(calls.length, 1)
})

test('a successful receipt passes its logs through into logsByTxHash for the decoder', async () => {
  const logs = [{ logIndex: 0, address: '0xpool', topics: ['0xtopic'], data: '0xdata' }]
  const result = await acquireReceiptsForCandidates({
    candidates: [candidate('0x1')],
    fetcher: async () => ({ status: 'ok', logs }),
    requestScope: createReceiptRequestScopeCache(),
  })
  assert.deepEqual(result.logsByTxHash.get('0x1'), logs)
})

test('concurrency is bounded: no more than `concurrency` fetches are in flight at once', async () => {
  let concurrentCount = 0
  let maxConcurrent = 0
  const fetcher: ReceiptFetcher = async () => {
    concurrentCount += 1
    maxConcurrent = Math.max(maxConcurrent, concurrentCount)
    await new Promise((r) => setTimeout(r, 15))
    concurrentCount -= 1
    return { status: 'missing' }
  }
  const candidates = Array.from({ length: 9 }, (_, i) => candidate(`0x${i}`))
  await acquireReceiptsForCandidates({
    candidates,
    fetcher,
    requestScope: createReceiptRequestScopeCache(),
    concurrency: 3,
  })
  assert.ok(maxConcurrent <= 3, `expected max concurrency <= 3, got ${maxConcurrent}`)
})

test('deterministic output: identical input produces the same counters across repeated calls', async () => {
  const candidates = [candidate('0x1'), candidate('0x2')]
  const run = () => acquireReceiptsForCandidates({
    candidates,
    fetcher: async () => ({ status: 'missing' }),
    requestScope: createReceiptRequestScopeCache(),
  })
  const r1 = await run()
  const r2 = await run()
  assert.deepEqual(r1.counters, r2.counters)
})

test('zero canonical-output mutation: input candidates array is never mutated by acquisition', async () => {
  const candidates = [candidate('0x1'), candidate('0x2')]
  const snapshot = JSON.parse(JSON.stringify(candidates))
  await acquireReceiptsForCandidates({
    candidates,
    fetcher: async () => ({ status: 'ok', logs: [{ logIndex: 0, address: '0xpool', topics: ['0xtopic'], data: '0x' }] }),
    requestScope: createReceiptRequestScopeCache(),
  })
  assert.deepEqual(candidates, snapshot)
})

// NEGATIVE-EVIDENCE SUBSTITUTION, DISCLOSED (production proof: 25 eligible, 10 fetched, 8/10 ended
// plain_transfer_no_swap_event, 0 exact swaps). These tests prove a proven-bad token-pair pattern,
// discovered from an EARLIER batch this same scan, causes a not-yet-fetched, quota-selected slot
// sharing that pattern to be swapped out for a capped candidate instead — never a retry, never
// exceeding the original call budget.

test('a candidate sharing a token pair already proven plain-transfer is substituted with a capped candidate', async () => {
  const badPairA = candidate('0xbad-a', 2, '0xtoken1', '0xtoken2')
  const badPairB = candidate('0xbad-b', 2, '0xtoken1', '0xtoken2') // same pair as badPairA, batch 2
  const goodCapped = candidate('0xcapped-good', 5, '0xtoken3', '0xtoken4')
  const candidates = [badPairA, badPairB, goodCapped]
  const calls: string[] = []
  const result = await acquireReceiptsForCandidates({
    candidates,
    fetcher: countingFetcher((txHash) => {
      calls.push(txHash)
      if (txHash === '0xbad-a') return { status: 'ok', logs: plainTransferLogs() }
      return { status: 'ok', logs: [] }
    }, []),
    requestScope: createReceiptRequestScopeCache(),
    maxLiveCalls: 2,
    concurrency: 1, // force sequential batches so badPairA's negative evidence lands before badPairB's batch
  })
  assert.deepEqual(calls, ['0xbad-a', '0xcapped-good'])
  assert.equal(result.counters.receiptQuotaSubstitutions, 1)
  assert.equal(result.counters.receiptCandidatesSelected, 2)
})

test('a proven-good (real swap) token pair is never substituted, even if it repeats', async () => {
  const goodA = candidate('0xgood-a', 2, '0xtoken1', '0xtoken2')
  const goodB = candidate('0xgood-b', 2, '0xtoken1', '0xtoken2')
  const calls: string[] = []
  const result = await acquireReceiptsForCandidates({
    candidates: [goodA, goodB],
    fetcher: countingFetcher((txHash) => { calls.push(txHash); return { status: 'ok', logs: realSwapLogs() } }, []),
    requestScope: createReceiptRequestScopeCache(),
    maxLiveCalls: 2,
    concurrency: 1,
  })
  assert.deepEqual(calls, ['0xgood-a', '0xgood-b'])
  assert.equal(result.counters.receiptQuotaSubstitutions, 0)
})

test('substitution never increases total live provider calls beyond the original budget', async () => {
  const badPairA = candidate('0xbad-a', 2, '0xtoken1', '0xtoken2')
  const badPairB = candidate('0xbad-b', 2, '0xtoken1', '0xtoken2')
  const goodCapped = candidate('0xcapped-good', 5, '0xtoken3', '0xtoken4')
  const result = await acquireReceiptsForCandidates({
    candidates: [badPairA, badPairB, goodCapped],
    fetcher: countingFetcher((txHash) => (txHash === '0xbad-a' ? { status: 'ok', logs: plainTransferLogs() } : { status: 'ok', logs: [] }), []),
    requestScope: createReceiptRequestScopeCache(),
    maxLiveCalls: 2,
    concurrency: 1,
  })
  assert.equal(result.counters.receiptLiveCalls, 2)
  assert.equal(result.counters.receiptProviderCalls, 2)
})

test('a capped candidate that ALSO matches known-negative evidence is skipped as a replacement, never selected', async () => {
  const badPairA = candidate('0xbad-a', 2, '0xtoken1', '0xtoken2')
  const badPairB = candidate('0xbad-b', 2, '0xtoken1', '0xtoken2')
  const alsoBadCapped = candidate('0xcapped-also-bad', 5, '0xtoken1', '0xtoken2') // same bad pair
  const goodCapped = candidate('0xcapped-good', 5, '0xtoken3', '0xtoken4')
  const calls: string[] = []
  const result = await acquireReceiptsForCandidates({
    candidates: [badPairA, badPairB, alsoBadCapped, goodCapped],
    fetcher: countingFetcher((txHash) => {
      calls.push(txHash)
      return txHash === '0xbad-a' ? { status: 'ok', logs: plainTransferLogs() } : { status: 'ok', logs: [] }
    }, []),
    requestScope: createReceiptRequestScopeCache(),
    maxLiveCalls: 2,
    concurrency: 1,
  })
  assert.equal(calls.includes('0xcapped-also-bad'), false)
  assert.deepEqual(calls, ['0xbad-a', '0xcapped-good'])
  assert.equal(result.counters.receiptCandidatesSelected, 2)
})

test('no reserve candidates available: a negatively-evidenced slot with nothing to substitute stays as-is (no crash, no extra call)', async () => {
  const badPairA = candidate('0xbad-a', 2, '0xtoken1', '0xtoken2')
  const badPairB = candidate('0xbad-b', 2, '0xtoken1', '0xtoken2')
  const calls: string[] = []
  const result = await acquireReceiptsForCandidates({
    candidates: [badPairA, badPairB], // no reserve/capped candidates exist at all
    fetcher: countingFetcher((txHash) => {
      calls.push(txHash)
      return txHash === '0xbad-a' ? { status: 'ok', logs: plainTransferLogs() } : { status: 'ok', logs: [] }
    }, []),
    requestScope: createReceiptRequestScopeCache(),
    maxLiveCalls: 2,
    concurrency: 1,
  })
  assert.deepEqual(calls, ['0xbad-a', '0xbad-b'])
  assert.equal(result.counters.receiptQuotaSubstitutions, 0)
  assert.equal(result.counters.receiptLiveCalls, 2)
})

// ROOT-CAUSE REGRESSION, DISCLOSED: production proof — a real scan's receiptQuotaSubstitutions
// stayed 0 even though 8/10 fetched receipts were plain_transfer_no_swap_event, because those
// candidates qualified via candidateSelector's own `legs.length === 1 && hasRouterLikeCounterparty`
// path — exactly the single-leg case where inferredTokenOut (or inferredTokenIn) is null. The old
// tokenPairKey required BOTH sides non-null, so it silently returned null for this dominant
// real-world pattern, meaning negative evidence was never recorded AND never matched against.
test('single-leg candidates (one side null) record and match negative evidence via a single-token key', async () => {
  const badSingleA = candidate('0xbad-a', 4, '0xrepeat-token', null as unknown as string) // missing tokenOut, tier 4 router-touch shape
  const badSingleB = candidate('0xbad-b', 4, '0xrepeat-token', null as unknown as string)
  const goodCapped = candidate('0xcapped-good', 5, '0xtoken3', '0xtoken4')
  const calls: string[] = []
  const result = await acquireReceiptsForCandidates({
    candidates: [badSingleA, badSingleB, goodCapped],
    fetcher: countingFetcher((txHash) => {
      calls.push(txHash)
      return txHash === '0xbad-a' ? { status: 'ok', logs: plainTransferLogs() } : { status: 'ok', logs: [] }
    }, []),
    requestScope: createReceiptRequestScopeCache(),
    maxLiveCalls: 2,
    concurrency: 1,
  })
  assert.deepEqual(calls, ['0xbad-a', '0xcapped-good'])
  assert.equal(result.counters.receiptQuotaSubstitutions, 1)
})

test('single-leg candidates with different known tokens are never conflated into the same negative-evidence key', async () => {
  const badSingleA = candidate('0xbad-a', 4, '0xtoken-a', null as unknown as string)
  const differentTokenSingle = candidate('0xdifferent', 4, '0xtoken-b', null as unknown as string)
  const calls: string[] = []
  const result = await acquireReceiptsForCandidates({
    candidates: [badSingleA, differentTokenSingle],
    fetcher: countingFetcher((txHash) => {
      calls.push(txHash)
      return txHash === '0xbad-a' ? { status: 'ok', logs: plainTransferLogs() } : { status: 'ok', logs: realSwapLogs() }
    }, []),
    requestScope: createReceiptRequestScopeCache(),
    maxLiveCalls: 2,
    concurrency: 1,
  })
  assert.deepEqual(calls, ['0xbad-a', '0xdifferent'])
  assert.equal(result.counters.receiptQuotaSubstitutions, 0)
})
