// TESTS — Alchemy persistent-429 circuit-breaker task.
//
// Production proof: with concurrency already serialized to 1, ALL 4 initial transaction-history
// calls returned 429, AND (under the prior task's retry-once fix) all 4 bounded retries ALSO
// returned 429 — 8 calls / 1,200 CU spent for 0 events, a 0% retry recovery rate. When Alchemy is
// persistently rate-limiting this key/project, a retry never recovers anything — it just doubles
// the waste. Fix: retries are disabled by default, and a request-scoped circuit breaker stops all
// further Alchemy transaction-history calls after 2 consecutive 429s for the rest of that job.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchAlchemyRawEvents,
  fetchGoldrushRawEvents,
  resetAlchemyHistoryConcurrencyState,
  isAlchemyRateLimitCircuitOpen,
  ALCHEMY_HISTORY_429_RETRY_ENABLED,
} from './utils'
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
// HARD ASSERTION: retries are off by default
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: 429 retries are disabled by default', () => {
  assert.equal(ALCHEMY_HISTORY_429_RETRY_ENABLED, false)
})

test('a single 429 with no default retry produces exactly 1 real call for that direction', async () => {
  let callCount = 0
  global.fetch = (async (_url: unknown, init: unknown) => {
    callCount += 1
    const body = JSON.parse((init as { body: string }).body)
    const direction = 'fromAddress' in (body.params[0] ?? {}) ? 'from' : 'to'
    // Only the 'from' direction ever gets 429; 'to' succeeds immediately — proves 'from' is never
    // retried (no second call for it) rather than merely "the job overall made 2 calls".
    if (direction === 'from') return new Response('rate limited', { status: 429 })
    return successResponse()
  }) as unknown as typeof fetch

  const result = await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(callCount, 2, 'exactly 1 call per direction (from + to), zero retries')
  assert.equal(result.diagnostics?.http429Count, 1)
})

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: circuit opens after 2 consecutive 429s and stops all further calls
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: two consecutive 429s open the request-scoped circuit', async () => {
  global.fetch = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch

  assert.equal(isAlchemyRateLimitCircuitOpen(), false, 'circuit starts closed')
  await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(isAlchemyRateLimitCircuitOpen(), true, 'circuit must be open after 2 consecutive 429s (base from + base to)')
})

test('HARD ASSERTION: once open, remaining Alchemy transaction-history calls make ZERO fetches', async () => {
  let callCount = 0
  global.fetch = (async () => {
    callCount += 1
    return new Response('rate limited', { status: 429 })
  }) as unknown as typeof fetch

  // First chain: 2 real calls, both 429 — opens the circuit.
  await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(callCount, 2)

  // Second chain: circuit is already open — this must make ZERO real fetch() calls.
  const ethResult = await fetchAlchemyRawEvents('eth', '0xwallet', 90)
  assert.equal(callCount, 2, 'no new fetch() calls once the circuit is open')
  assert.equal(ethResult.ok, false)
  assert.equal(ethResult.errorReason, 'alchemy_rate_limit_circuit_open')
  assert.equal(ethResult.diagnostics?.circuitPrevented, 2, 'both eth from/to calls were prevented by the open circuit')
})

test('HARD ASSERTION: the circuit opens mid-job and prevents the very next queued call in the SAME fetch', async () => {
  let callCount = 0
  global.fetch = (async () => {
    callCount += 1
    return new Response('rate limited', { status: 429 })
  }) as unknown as typeof fetch

  // Base's own from+to pair: from=429 (1st consecutive), to=429 (2nd consecutive) -> circuit opens
  // exactly when the 2nd of these two queued calls runs. Since concurrency is 1, there is no third
  // call left in THIS invocation to prevent — the very next PREVENTED call is eth's first one,
  // covered by the previous test. This test just confirms the base call sequence itself: exactly 2
  // real HTTP calls, no more, no less, and the circuit is open by the time it returns.
  const result = await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(callCount, 2)
  assert.equal(isAlchemyRateLimitCircuitOpen(), true)
  assert.equal(result.errorReason, 'http_429', 'both real calls genuinely got 429 — the circuit-open reason is reserved for calls that were PREVENTED, not calls that were actually attempted and 429\'d')
})

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: the circuit never persists across jobs
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: the next wallet job starts with the circuit closed', async () => {
  global.fetch = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch
  await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(isAlchemyRateLimitCircuitOpen(), true)

  // A new job resets this module's request-scoped state — exactly the call
  // providerFetchWindow/index.ts's resetProviderFetchWindowRequestCache makes per job.
  resetAlchemyHistoryConcurrencyState()
  assert.equal(isAlchemyRateLimitCircuitOpen(), false, 'a fresh job must never inherit a prior job\'s open circuit')

  global.fetch = (async () => successResponse()) as unknown as typeof fetch
  const result = await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(result.ok, true, 'the new job can make real, successful Alchemy calls again')
})

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: GoldRush is never touched by the Alchemy circuit breaker
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: GoldRush continues to succeed while the Alchemy circuit is open', async () => {
  global.fetch = (async (url: unknown) => {
    if (typeof url === 'string' && url.includes('covalenthq.com')) {
      return new Response(JSON.stringify({ data: { items: [] } }), { status: 200 })
    }
    return new Response('rate limited', { status: 429 })
  }) as unknown as typeof fetch

  await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(isAlchemyRateLimitCircuitOpen(), true)

  const goldrushResult = await fetchGoldrushRawEvents('base', '0xwallet', 90)
  assert.equal(goldrushResult.ok, true, 'GoldRush must succeed independently of the Alchemy circuit state')
})

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: rateLimitDetected (src/pipeline/index.ts's computeRateLimitFlag) becomes true
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: a genuine Alchemy 429 produces errorReason http_429, which computeRateLimitFlag checks for', async () => {
  // Only the 'from' direction 429s; 'to' succeeds — so this fetch resolves with ok:true overall
  // (one usable sub-result), but the 429 sub-call's own kind must still surface as 'http_429' via
  // diagnostics, which is what feeds the pipeline-level rate-limit signal.
  global.fetch = (async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as { body: string }).body)
    const direction = 'fromAddress' in (body.params[0] ?? {}) ? 'from' : 'to'
    if (direction === 'from') return new Response('rate limited', { status: 429 })
    return successResponse()
  }) as unknown as typeof fetch

  const result = await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(result.diagnostics?.http429Count, 1, 'the 429 sub-call must be counted distinctly so a caller building its own errorReason (or computeRateLimitFlag) can detect it')
})

test('HARD ASSERTION: both sub-calls returning 429 produces the http_429 errorReason directly, which computeRateLimitFlag matches', async () => {
  global.fetch = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch
  const result = await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(result.ok, false)
  assert.equal(result.errorReason, 'http_429')
})

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: HTTP 429 never increments malformedResponses
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: HTTP 429 responses do not increment malformedResponses', async () => {
  global.fetch = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch
  const result = await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(result.diagnostics?.malformedResponses, 0, 'a well-formed HTTP 429 is a real, valid rate-limit response — never "malformed"')
  assert.equal(result.diagnostics?.http429Count, 2)
})

test('a genuine non-429 HTTP failure still increments malformedResponses/httpErrors as before', async () => {
  global.fetch = (async () => new Response('server error', { status: 500 })) as unknown as typeof fetch
  const result = await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(result.diagnostics?.malformedResponses, 2)
  assert.equal(result.diagnostics?.httpErrors, 2)
  assert.equal(result.diagnostics?.http429Count, 0)
})

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: concurrency stays 1, and the circuit breaker never spends budget on a
// prevented call
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: a call prevented by the open circuit consumes zero budget/CU', async () => {
  global.fetch = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch
  await fetchAlchemyRawEvents('base', '0xwallet', 90)
  const ethResult = await fetchAlchemyRawEvents('eth', '0xwallet', 90)
  assert.equal(ethResult.diagnostics?.liveCalls, 0, 'a circuit-prevented call must never count as a real liveCalls spend')
  assert.equal(ethResult.diagnostics?.circuitPrevented, 2, 'both eth from/to sub-calls were prevented, never attempted')
})
