// Robinhood native trace: bounded SAME-PAGE retry for transient failures (timeout / network / 429 / 5xx) inside
// the 12s trace window. Full-trace proof is unchanged: never a partial prefix, one native_trace slot per tx.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  getBlockscoutTransactionInternalTransactions, blockscoutLaneRemaining, NATIVE_TRACE_PAGINATION, NATIVE_TRACE_MAX_LOOKUPS,
  NATIVE_TRACE_MAX_RETRIES_PER_PAGE, __resetRobinhoodBlockscoutRateLimitForTest,
} from '../lib/server/robinhoodBlockscoutEvidence.ts'
import { blockscoutNativeTransfersForTx } from '../lib/server/robinhoodNativeTrace.ts'
import { __resetMemoryFallbackForTest } from '../lib/server/cache/tokenCache.ts'
import { __setRobinhoodNativeTraceKvForTest, __resetRobinhoodNativeTraceMemoryForTest, robinhoodNativeTracePersistenceKey } from '../lib/server/robinhoodNativeTracePersistence.ts'

process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
process.env.BLOCKSCOUT_API_KEY = 'proapi_SECRET_trace_key'
delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

const WALLET = '0xf5f78000639614f204a18bfa6eb0435bf9b9b4b1'
const ROUTER = '0x248a454a0000000000000000000000000000beef'
const POOL = '0x3000000000000000000000000000000000000003'
const TX = '0x0b437cc91cbc86aedf680fd78119f3a24598ee25fba38fdae9b34ab1bcf6801b'
const CURSOR = { block_number: 70483888, index: 50, transaction_hash: TX }
const item1 = { from: { hash: POOL }, to: { hash: ROUTER }, value: '5000', success: true, type: 'call', index: 1 }
const item2 = { from: { hash: ROUTER }, to: { hash: WALLET }, value: '4990', success: true, type: 'call', index: 2 }

type Step = 'ok' | 'timeout' | 'network' | 'hang' | 500 | 502 | 429 | 401 | 'auth403' | 'badjson' | 'repeat_cursor' | 'nested_cursor'
function server(page2: Step[], page1: Step = 'ok') {
  const calls: Array<{ url: string; host: string; page: number; auth: string | null }> = []
  let p2 = 0
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    const host = new URL(url).host
    const page = url.includes('?') ? 2 : 1
    calls.push({ url, host, page, auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? null })
    if (!url.includes('/internal-transactions')) return json({ items: [] })
    if (host !== 'api.blockscout.com') return json({ message: 'Forbidden' }, 403) // community host refuses (production)
    const step: Step = page === 1 ? page1 : (page2[p2++] ?? 'ok')
    const fail = (name: string) => { const e = new Error(name); e.name = name; throw e }
    if (step === 'timeout') fail('TimeoutError')
    if (step === 'network') throw new TypeError('fetch failed')
    if (step === 'hang') return new Promise<Response>((_, reject) => {
      const keepAlive = setInterval(() => {}, 1_000) // AbortSignal.timeout timers are unref'd; keep the test loop alive
      init?.signal?.addEventListener('abort', () => { clearInterval(keepAlive); reject(init.signal!.reason) })
    })
    if (typeof step === 'number') return json({ message: 'nope' }, step)
    if (step === 'auth403') return json({ message: 'Invalid API key' }, 403)
    if (step === 'badjson') return new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } })
    if (page === 1) return json({ items: [item1], next_page_params: step === 'nested_cursor' ? { cursor: { a: 1 } } : CURSOR })
    if (step === 'repeat_cursor') return json({ items: [item2], next_page_params: CURSOR })
    return json({ items: [item2], next_page_params: null })
  }
  return { fn, calls, page2Calls: () => calls.filter((c) => c.page === 2) }
}

beforeEach(() => {
  __resetRobinhoodBlockscoutRateLimitForTest()
  __resetMemoryFallbackForTest()
  __resetRobinhoodNativeTraceMemoryForTest()
  __setRobinhoodNativeTraceKvForTest(null)
})

test('limits: 12s trace window, 4 pages, 200 items, one retry per page, 5 lookups', () => {
  assert.deepEqual({ ...NATIVE_TRACE_PAGINATION }, { maxPages: 4, maxItems: 200, maxTotalMs: 12_000 })
  assert.equal(NATIVE_TRACE_MAX_RETRIES_PER_PAGE, 1)
  assert.equal(NATIVE_TRACE_MAX_LOOKUPS, 5)
})

test('1. production shape: page1 gateway 200 → page2 timeout → page2 retry 200 → complete, exact combined trace', async () => {
  const s = server(['timeout', 'ok'])
  const t = await getBlockscoutTransactionInternalTransactions(TX, s.fn)
  assert.equal(t.status, 'complete')
  assert.equal(t.paginationComplete, true)
  assert.equal(t.paginationCapHit, false)
  assert.deepEqual(t.items, [item1, item2])
  assert.equal(t.pagesRequested, 2) // logical pages, not retries
  assert.equal(t.pagesSucceeded, 2)
  assert.equal(t.transportAttemptsTotal, 4)
  assert.equal(t.pageRetryCount, 1)
  assert.deepEqual(t.pagesRetried, [2])
  assert.deepEqual(t.transientFailureCounts, { timeout: 1, network_error: 0, rate_limited: 0, http_5xx: 0 })
  assert.deepEqual(t.pageTransportAttempts.map((a) => [a.page, a.attempt, a.requestHost, a.authMode, a.httpStatus, a.failureClass]), [
    [1, 1, 'robinhoodchain.blockscout.com', 'none', 403, 'forbidden_host_policy'],
    [1, 2, 'api.blockscout.com', 'gateway', 200, null],
    [2, 1, 'api.blockscout.com', 'gateway', null, 'timeout'],
    [2, 2, 'api.blockscout.com', 'gateway', 200, null],
  ])
})

test('2. the retry uses the identical page-2 cursor / path, host and auth (never back to community)', async () => {
  const s = server(['timeout', 'ok'])
  await getBlockscoutTransactionInternalTransactions(TX, s.fn)
  const [a, b] = s.page2Calls()
  assert.equal(a.url, b.url)
  assert.ok(a.url.includes('block_number=70483888') && a.url.includes('index=50'))
  assert.deepEqual([a.host, b.host], ['api.blockscout.com', 'api.blockscout.com'])
  assert.equal(a.auth, b.auth)
  assert.equal(s.calls.filter((c) => c.host !== 'api.blockscout.com').length, 1) // only the original page-1 community try
})

test('3. page2 timeout twice → full trace unavailable, no partial items', async () => {
  const s = server(['timeout', 'timeout', 'ok'])
  const t = await getBlockscoutTransactionInternalTransactions(TX, s.fn)
  assert.equal(t.status, 'transport_failed')
  assert.equal(t.items, null)
  assert.equal(t.paginationComplete, false)
  assert.equal(s.page2Calls().length, 2) // initial + exactly one retry
  assert.equal(t.transientFailureCounts.timeout, 2)
  const r = await blockscoutNativeTransfersForTx(server(['timeout', 'timeout']).fn)(`0x${'1'.repeat(64)}`)
  assert.equal(r.transfers, null)
  assert.equal(r.audit?.result, 'transport_failed')
})

test('4/5. page2 500 / 502 / 429 / network error → one retry → 200 completes', async () => {
  for (const [step, kind] of [[500, 'http_5xx'], [502, 'http_5xx'], [429, 'rate_limited'], ['network', 'network_error']] as const) {
    __resetRobinhoodBlockscoutRateLimitForTest(); __resetMemoryFallbackForTest()
    const s = server([step, 'ok'])
    const t = await getBlockscoutTransactionInternalTransactions(TX, s.fn)
    assert.equal(t.status, 'complete', String(step))
    assert.deepEqual(t.items, [item1, item2])
    assert.equal(t.transientFailureCounts[kind], 1)
    assert.equal(t.pageRetryCount, 1)
  }
})

test('6. malformed JSON is not retried', async () => {
  const s = server(['badjson', 'ok'])
  const t = await getBlockscoutTransactionInternalTransactions(TX, s.fn)
  assert.equal(t.status, 'malformed')
  assert.equal(t.items, null)
  assert.equal(s.page2Calls().length, 1)
  assert.equal(t.pageRetryCount, 0)
})

test('7. gateway auth failure is not retried', async () => {
  for (const step of [401, 'auth403'] as const) {
    __resetRobinhoodBlockscoutRateLimitForTest(); __resetMemoryFallbackForTest()
    const s = server([step, 'ok'])
    const t = await getBlockscoutTransactionInternalTransactions(TX, s.fn)
    assert.equal(t.status, 'transport_failed')
    assert.equal(t.last.failureClass, 'forbidden_invalid_auth')
    assert.equal(s.page2Calls().length, 1)
    assert.equal(t.items, null)
  }
})

test('8. repeated or malformed cursors still fail closed (no retry)', async () => {
  const rep = server(['repeat_cursor', 'ok'])
  const a = await getBlockscoutTransactionInternalTransactions(TX, rep.fn)
  assert.equal(a.status, 'inconsistent_pagination')
  assert.equal(a.items, null)
  assert.equal(a.pageRetryCount, 0)
  __resetRobinhoodBlockscoutRateLimitForTest(); __resetMemoryFallbackForTest()
  const nested = server([], 'nested_cursor')
  const b = await getBlockscoutTransactionInternalTransactions(TX, nested.fn)
  assert.equal(b.status, 'inconsistent_pagination')
  assert.equal(nested.page2Calls().length, 0)
})

test('9. retries never push elapsed time past the 12s trace window (page 2 hangs twice)', async () => {
  const s = server(['hang', 'hang', 'ok'])
  const started = Date.now()
  const t = await getBlockscoutTransactionInternalTransactions(TX, s.fn)
  const elapsed = Date.now() - started
  assert.equal(t.status, 'transport_failed')
  assert.equal(t.items, null)
  assert.ok(elapsed <= NATIVE_TRACE_PAGINATION.maxTotalMs + 300, `elapsed ${elapsed}ms`)
  assert.ok(s.page2Calls().length <= 2)
  // a tight window leaves no room for a retry at all: fail closed instead of overrunning
  __resetRobinhoodBlockscoutRateLimitForTest(); __resetMemoryFallbackForTest()
  const tight = server(['hang', 'ok'])
  const t0 = Date.now()
  const small = await getBlockscoutTransactionInternalTransactions(TX, tight.fn, { maxPages: 4, maxItems: 200, maxTotalMs: 800 })
  assert.equal(small.status, 'transport_failed')
  assert.equal(tight.page2Calls().length, 1)
  assert.ok(Date.now() - t0 <= 800 + 300)
})

test('10. retries and the gateway switch consume exactly one native_trace budget slot', async () => {
  const before = blockscoutLaneRemaining('native_trace')
  const t = await getBlockscoutTransactionInternalTransactions(TX, server([500, 'ok']).fn)
  assert.equal(t.status, 'complete')
  assert.equal(t.transportAttemptsTotal, 4)
  assert.equal(blockscoutLaneRemaining('native_trace'), before - 1)
})

class FakeKv {
  store = new Map<string, unknown>()
  async get<T>(k: string): Promise<T | null> { return (this.store.has(k) ? structuredClone(this.store.get(k)) : null) as T | null }
  async set(k: string, v: unknown, opts?: { nx?: boolean }): Promise<'OK' | null> { if (opts?.nx && this.store.has(k)) return null; this.store.set(k, structuredClone(v)); return 'OK' }
}

test('11/12. a retried complete trace is persisted; a later scan on a new instance makes zero Blockscout calls', async () => {
  const kv = new FakeKv()
  __setRobinhoodNativeTraceKvForTest(kv as never)
  const first = server(['timeout', 'ok'])
  const r1 = await blockscoutNativeTransfersForTx(first.fn)(TX)
  assert.equal(r1.audit?.result, 'proven')
  assert.equal(r1.audit?.pageRetryCount, 1)
  assert.deepEqual(r1.audit?.pagesRetried, [2])
  assert.deepEqual(r1.transfers, [
    { from: POOL, to: ROUTER, value: BigInt(5000), success: true },
    { from: ROUTER, to: WALLET, value: BigInt(4990), success: true },
  ])
  const row = kv.store.get(robinhoodNativeTracePersistenceKey(TX)) as Record<string, unknown>
  assert.equal(row.result, 'proven')
  assert.equal(row.paginationComplete, true)
  assert.equal('pageRetryCount' in row || 'transportAttempts' in row, false) // retries themselves are never persisted
  // new instance: memory + short Blockscout cache gone; Blockscout now fails everything
  __resetRobinhoodNativeTraceMemoryForTest(); __resetMemoryFallbackForTest(); __resetRobinhoodBlockscoutRateLimitForTest()
  const down = server(['timeout', 'timeout'], 'timeout')
  const r2 = await blockscoutNativeTransfersForTx(down.fn)(TX)
  assert.equal(down.calls.length, 0)
  assert.deepEqual(r2.transfers, r1.transfers)
  assert.equal(r2.audit?.result, 'proven')
})

test('a failed retried trace is never persisted', async () => {
  const kv = new FakeKv()
  __setRobinhoodNativeTraceKvForTest(kv as never)
  const r = await blockscoutNativeTransfersForTx(server(['timeout', 'timeout']).fn)(TX)
  assert.equal(r.transfers, null)
  assert.equal(kv.store.size, 0)
})
