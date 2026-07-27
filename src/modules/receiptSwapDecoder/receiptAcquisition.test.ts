import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  acquireReceiptsForCandidates, createReceiptRequestScopeCache, receiptCacheKey,
  type ReceiptFetcher, type ReceiptFetchOutcome,
} from './receiptAcquisition'
import type { SelectedCandidate } from './candidateSelector'

function candidate(txHash: string, priorityTier: 1 | 2 | 3 | 4 | 5 = 2): SelectedCandidate {
  return {
    chain: 'base',
    txHash,
    priorityTier,
    priorityReason: 'existing_one_leg_swap_candidate',
    inferredTokenIn: '0xaaa',
    inferredTokenOut: '0xbbb',
    inferredMissingSide: 'none',
    economicValueUsd: null,
  }
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
