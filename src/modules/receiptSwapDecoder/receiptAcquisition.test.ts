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
  routeFingerprint?: string,
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
    // Defaults to a fingerprint DERIVED from the token pair purely so this file's many pre-existing
    // token-pair-based tests (written before the route-fingerprint fix) keep exercising distinct
    // substitution groups without every call site needing an explicit override. Tests that actually
    // exercise route-fingerprint matching pass routeFingerprint explicitly.
    routeFingerprint: routeFingerprint ?? `base:router:${tokenIn ?? 'none'}:${tokenOut ?? 'none'}`,
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

// ROOT-CAUSE REGRESSION, DISCLOSED (round 2 — the real production trace): receiptQuotaSubstitutions
// stayed 0 even though the 8 dominant plain-transfer candidates were NOT single-leg —
// pairingStrength=1, inboundLegCount=1, outboundLegCount=1, distinctTokenCount=2 on every one.
// Exact token-pair matching never matched any of the 15 capped candidates because those 8
// candidates each touched a DIFFERENT token pair through the SAME router/route shape. This fixture
// reproduces exactly that: two candidates with fully-paired legs and DISTINCT token pairs, sharing
// only the same routeFingerprint (same router/counterparty + same leg-direction shape) — proving
// substitution now matches on the broader, proven-correct signal instead of the too-narrow pair key.
test('candidates with fully-paired legs but DISTINCT token pairs still substitute when they share the same route fingerprint', async () => {
  const sameRouteA = candidate('0xbad-a', 4, '0xtoken1', '0xtoken2', 'base:0xrouter:1i1ow')
  const sameRouteB = candidate('0xbad-b', 4, '0xtoken3', '0xtoken4', 'base:0xrouter:1i1ow') // different pair, same route fingerprint
  const goodCapped = candidate('0xcapped-good', 5, '0xtoken5', '0xtoken6', 'base:0xotherrouter:1i1ow')
  const calls: string[] = []
  const result = await acquireReceiptsForCandidates({
    candidates: [sameRouteA, sameRouteB, goodCapped],
    fetcher: countingFetcher((txHash) => {
      calls.push(txHash)
      return txHash === '0xbad-a' ? { status: 'ok', logs: plainTransferLogs() } : { status: 'ok', logs: realSwapLogs() }
    }, []),
    requestScope: createReceiptRequestScopeCache(),
    maxLiveCalls: 2,
    concurrency: 1,
  })
  assert.deepEqual(calls, ['0xbad-a', '0xcapped-good'])
  assert.equal(result.counters.receiptQuotaSubstitutions, 1)
  assert.equal(result.counters.receiptNegativeFingerprintsRecorded, 1)
  assert.equal(result.counters.receiptSubstitutionAttempts, 1)
  assert.deepEqual(result.negativeFingerprintSamples, [{ routeFingerprint: 'base:0xrouter:1i1ow', fromTxHash: '0xbad-a' }])
})

test('two candidates that happen to share a token pair but touch different routers are never conflated', async () => {
  const badA = candidate('0xbad-a', 2, '0xtoken1', '0xtoken2', 'base:0xrouterA:1i1ow')
  const differentRouterSamePair = candidate('0xdifferent', 2, '0xtoken1', '0xtoken2', 'base:0xrouterB:1i1ow')
  const calls: string[] = []
  const result = await acquireReceiptsForCandidates({
    candidates: [badA, differentRouterSamePair],
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

test('a candidate with STRONGER evidence (already selected ahead by tier/ranking) is never displaced by substitution — only capped reserve candidates are ever pulled in', async () => {
  const badA = candidate('0xbad-a', 4, '0xtoken1', '0xtoken2', 'base:0xrouter:1i1ow')
  const strongerAlreadySelected = candidate('0xstrong', 1, '0xtoken3', '0xtoken4', 'base:0xrouter:1i1ow') // same route fingerprint, but tier 1 (already selected, not reserve)
  const calls: string[] = []
  const result = await acquireReceiptsForCandidates({
    candidates: [strongerAlreadySelected, badA],
    fetcher: countingFetcher((txHash) => {
      calls.push(txHash)
      return { status: 'ok', logs: txHash === '0xstrong' ? realSwapLogs() : plainTransferLogs() }
    }, []),
    requestScope: createReceiptRequestScopeCache(),
    maxLiveCalls: 2,
    concurrency: 1,
  })
  // Both already fit within budget (maxLiveCalls 2, 2 candidates) — nothing to substitute FROM
  // reserve (empty), so both are fetched exactly as selected; the stronger candidate is untouched.
  assert.deepEqual(calls, ['0xstrong', '0xbad-a'])
  assert.equal(result.counters.receiptQuotaSubstitutions, 0)
})
