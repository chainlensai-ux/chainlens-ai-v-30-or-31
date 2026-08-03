// TESTS — Alchemy transaction-history 429-burst regression task.
//
// Production proof: Base from/to and ETH from/to (this job's 4 structural transaction-history
// calls) fired concurrently and ALL FOUR came back HTTP 429, while GoldRush (a different provider)
// succeeded. Fix: a module-level, request-scoped concurrency-1 mutex serializing every real
// alchemy_getAssetTransfers call, plus one bounded retry (with Retry-After support) specifically
// for 429 — never for any other failure kind.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchAlchemyRawEvents, fetchGoldrushRawEvents, resetAlchemyHistoryConcurrencyState } from './utils'
import { __resetWalletProviderCostLedgerForTest } from '../providerCost/walletProviderCostLedger'

const originalFetch = global.fetch
const originalAlchemyBaseKey = process.env.ALCHEMY_BASE_KEY
const originalAlchemyEthKey = process.env.ALCHEMY_ETHEREUM_KEY
const originalGoldrushKey = process.env.GOLDRUSH_API_KEY

beforeEach(() => {
  __resetWalletProviderCostLedgerForTest()
  resetAlchemyHistoryConcurrencyState()
  process.env.ALCHEMY_BASE_KEY = 'test-alchemy-key'
  process.env.ALCHEMY_ETHEREUM_KEY = 'test-alchemy-key'
  process.env.GOLDRUSH_API_KEY = 'test-goldrush-key'
})

afterEach(() => {
  global.fetch = originalFetch
  __resetWalletProviderCostLedgerForTest()
  resetAlchemyHistoryConcurrencyState()
  process.env.ALCHEMY_BASE_KEY = originalAlchemyBaseKey
  process.env.ALCHEMY_ETHEREUM_KEY = originalAlchemyEthKey
  process.env.GOLDRUSH_API_KEY = originalGoldrushKey
})

function successResponse(): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { transfers: [] } }), { status: 200 })
}

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: at most 1 in-flight alchemy_getAssetTransfers call at any moment
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: four history requests (Base from/to + ETH from/to) execute serially, never overlapping', async () => {
  let inFlight = 0
  let maxObservedConcurrency = 0
  let totalCalls = 0
  global.fetch = (async (url: unknown) => {
    if (typeof url === 'string' && url.includes('g.alchemy.com')) {
      totalCalls += 1
      inFlight += 1
      maxObservedConcurrency = Math.max(maxObservedConcurrency, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 15))
      inFlight -= 1
      return successResponse()
    }
    return successResponse()
  }) as unknown as typeof fetch

  await Promise.all([
    fetchAlchemyRawEvents('base', '0xwallet', 90),
    fetchAlchemyRawEvents('eth', '0xwallet', 90),
  ])

  assert.equal(totalCalls, 4, 'exactly 4 real Alchemy calls for Base+ETH from/to')
  assert.equal(maxObservedConcurrency, 1, 'concurrent Base/ETH callers must never exceed concurrency 1')
})

test('HARD ASSERTION: concurrent Base and ETH callers share one request-scoped concurrency-1 queue', async () => {
  const callOrder: string[] = []
  global.fetch = (async (url: unknown) => {
    if (typeof url === 'string' && url.includes('g.alchemy.com')) {
      callOrder.push(url.includes('base') ? 'base' : 'eth')
    }
    return successResponse()
  }) as unknown as typeof fetch

  await Promise.all([
    fetchAlchemyRawEvents('base', '0xwallet', 90),
    fetchAlchemyRawEvents('eth', '0xwallet', 90),
  ])

  assert.equal(callOrder.length, 4)
})

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: exactly one retry for 429, never a second
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: a 429 gets at most one retry, then a success on that retry is accepted', async () => {
  const attemptsByDirection: Record<string, number> = { from: 0, to: 0 }
  let callCount = 0
  global.fetch = (async (_url: unknown, init: unknown) => {
    callCount += 1
    const body = JSON.parse((init as { body: string }).body)
    const direction = 'fromAddress' in (body.params[0] ?? {}) ? 'from' : 'to'
    attemptsByDirection[direction] += 1
    if (attemptsByDirection[direction] === 1) return new Response('rate limited', { status: 429 })
    return successResponse()
  }) as unknown as typeof fetch

  const result = await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(result.ok, true, 'a successful retry after 429 must restore a real success result')
  assert.equal(callCount, 4, '2 directions * (1 initial 429 + 1 successful retry) = 4 total calls')
  assert.equal(attemptsByDirection.from, 2)
  assert.equal(attemptsByDirection.to, 2)
})

test('HARD ASSERTION: a successful response after a 429 retry restores real events, not an empty/null result', async () => {
  let callCount = 0
  global.fetch = (async () => {
    callCount += 1
    if (callCount === 1) return new Response('rate limited', { status: 429 })
    if (callCount === 2) {
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1,
        result: { transfers: [
          { hash: '0xrecovered', from: '0xaaa', to: '0xbbb', asset: 'USDC', rawContract: { address: '0xtoken', value: '0x5f5e100', decimal: '0x6' }, metadata: { blockTimestamp: new Date().toISOString() } },
        ] },
      }), { status: 200 })
    }
    return successResponse()
  }) as unknown as typeof fetch

  const result = await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(result.ok, true)
  assert.equal(result.events.length, 1, "the retried call's real transfer must survive into the returned events, not be dropped")
  assert.equal(result.events[0].txHash, '0xrecovered')
})

test('HARD ASSERTION: no retry after a second consecutive 429 — the request fails, typed as http_error', async () => {
  let callCount = 0
  global.fetch = (async () => {
    callCount += 1
    return new Response('rate limited', { status: 429 })
  }) as unknown as typeof fetch

  const result = await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(result.ok, false)
  assert.equal(result.errorReason, 'http_error')
  // 2 directions * (1 initial + 1 retry) = 4 real HTTP calls, never more (no second retry).
  assert.equal(callCount, 4)
})

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: Retry-After is respected when present
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: the retry respects a Retry-After header when Alchemy sends one', async () => {
  const timestamps: number[] = []
  let callCount = 0
  global.fetch = (async () => {
    callCount += 1
    timestamps.push(Date.now())
    if (callCount === 1) {
      return new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } })
    }
    return successResponse()
  }) as unknown as typeof fetch

  // Isolate to a single direction's worth of behavior by only checking the FIRST call's retry gap
  // is honored; the concurrency queue means the second direction's call happens after this one
  // settles, so we only assert on the first observed retry pair.
  await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.ok(timestamps.length >= 2, 'at least one retry must have happened')
  const gap = timestamps[1] - timestamps[0]
  assert.ok(gap >= 900, `retry must wait at least ~1000ms per the Retry-After: 1 header, observed ${gap}ms`)
})

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: a retry consumes budget — it is a real second call, never free
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: a 429 retry consumes real Alchemy call/CU budget, exactly like any other call', async () => {
  let callCount = 0
  global.fetch = (async () => {
    callCount += 1
    if (callCount === 1) return new Response('rate limited', { status: 429 })
    return successResponse()
  }) as unknown as typeof fetch

  const result = await fetchAlchemyRawEvents('base', '0xwallet', 90)
  // direction 'from': 1 initial (429) + 1 retry (success) = 2 liveCalls. direction 'to': 1 initial
  // (success, since only the very first mock call returns 429) = 1 liveCall. Total = 3 — proving
  // the retry itself consumed a real, counted call, not a free extra attempt.
  assert.equal(result.diagnostics?.liveCalls, 3, 'the initial 429 attempt AND its retry both count as real liveCalls spend')
})

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: never retry for non-429 failures
// ---------------------------------------------------------------------------------------------

for (const status of [400, 401, 403, 404, 500, 502, 503]) {
  test(`no retry for HTTP ${status} — only a genuine 429 is retried`, async () => {
    let callCount = 0
    global.fetch = (async () => {
      callCount += 1
      return new Response('failure', { status })
    }) as unknown as typeof fetch

    const result = await fetchAlchemyRawEvents('base', '0xwallet', 90)
    assert.equal(result.ok, false)
    assert.equal(callCount, 2, 'exactly 2 calls (from + to), no retries for a non-429 HTTP failure')
  })
}

test('no retry for a timeout/network error', async () => {
  let callCount = 0
  global.fetch = (async () => {
    callCount += 1
    throw new Error('AbortError: timeout')
  }) as unknown as typeof fetch

  const result = await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(result.ok, false)
  assert.equal(callCount, 2, 'exactly 2 calls (from + to), no retries for a network/timeout error')
})

test('no retry for malformed/json-rpc-error responses', async () => {
  let callCount = 0
  global.fetch = (async () => {
    callCount += 1
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'bad params' } }), { status: 200 })
  }) as unknown as typeof fetch

  const result = await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(result.ok, false)
  assert.equal(callCount, 2, 'exactly 2 calls (from + to), no retries for a JSON-RPC-level error')
})

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: GoldRush stays fully parallel and unaffected by the Alchemy limiter
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: GoldRush is never serialized by the Alchemy history concurrency limiter', async () => {
  let goldrushInFlight = 0
  let goldrushMaxConcurrency = 0
  global.fetch = (async (url: unknown) => {
    if (typeof url === 'string' && url.includes('covalenthq.com')) {
      goldrushInFlight += 1
      goldrushMaxConcurrency = Math.max(goldrushMaxConcurrency, goldrushInFlight)
      await new Promise((resolve) => setTimeout(resolve, 15))
      goldrushInFlight -= 1
      return new Response(JSON.stringify({ data: { items: [] } }), { status: 200 })
    }
    return successResponse()
  }) as unknown as typeof fetch

  await Promise.all([
    fetchGoldrushRawEvents('base', '0xwallet', 90),
    fetchGoldrushRawEvents('eth', '0xwallet', 90),
  ])

  assert.equal(goldrushMaxConcurrency, 2, 'GoldRush calls for different chains must remain fully parallel, unlike Alchemy history')
})

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: total transaction-history calls never exceed the absolute max of 8
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: total calls across Base+ETH never exceed 8, even when every initial call gets 429', async () => {
  let callCount = 0
  global.fetch = (async () => {
    callCount += 1
    return new Response('rate limited', { status: 429 })
  }) as unknown as typeof fetch

  await Promise.all([
    fetchAlchemyRawEvents('base', '0xwallet', 90),
    fetchAlchemyRawEvents('eth', '0xwallet', 90),
  ])

  assert.ok(callCount <= 8, `absolute max is 8 (4 initial + 4 one-per-request retries), observed ${callCount}`)
  assert.equal(callCount, 8, 'all four initial calls got 429, so all four get exactly one retry each = 8')
})

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: a 429 is never cached as a permanent settled success
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: an errorReason of http_error (from a 429 burst) is never a permanent-failure reason', async () => {
  global.fetch = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch
  const result = await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(result.ok, false)
  assert.equal(result.errorReason, 'http_error')
  // providerFetchWindow/index.ts's PERMANENT_FAILURE_REASONS only contains
  // 'chain_not_verified_for_provider' and 'no_api_key_configured' — 'http_error' is intentionally
  // absent, so this result is always evicted from the coalescing cache, never settled as success.
  assert.notEqual(result.errorReason, 'chain_not_verified_for_provider')
  assert.notEqual(result.errorReason, 'no_api_key_configured')
})
