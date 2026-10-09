// Robinhood partial native-trace progress across scans (job cc6ad1dc: 0x8aac…9310 / 0xe603…7e7e fetched pages 1–2,
// timed out on page 3 twice and lost the progress at scan end). A partial record is NEVER evidence: it only lets the
// next scan continue at the exact stored cursor. Each "scan" here is a fresh trace source + empty process memory, so
// the record really comes back from the (fake) KV.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { __resetRobinhoodBlockscoutRateLimitForTest, __resetNativeTraceFilterCapabilityForTest } from '../lib/server/robinhoodBlockscoutEvidence.ts'
import { blockscoutNativeTraceSource, storedRobinhoodNativeTrace } from '../lib/server/robinhoodNativeTrace.ts'
import { __resetMemoryFallbackForTest } from '../lib/server/cache/tokenCache.ts'
import { __resetRobinhoodNativeTraceMemoryForTest, __setRobinhoodNativeTraceKvForTest, readRobinhoodNativeTraceMemory } from '../lib/server/robinhoodNativeTracePersistence.ts'
import {
  __resetRobinhoodPartialTraceMemoryForTest, __setRobinhoodPartialTraceKvForTest, readPartialTrace, robinhoodPartialTraceKey,
  writePartialTrace, partialTraceChecksum, ROBINHOOD_PARTIAL_TRACE_TTL_MS, type RobinhoodPartialNativeTraceRecord,
} from '../lib/server/robinhoodPartialNativeTrace.ts'

process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
process.env.BLOCKSCOUT_API_KEY = 'proapi_SECRET_partial_key'
delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

const WALLET = '0x9d69b5ffb22608d8003508b9c6bd9f6b458d4184'
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const ROUTER = '0x248a454a0000000000000000000000000000beef'
const OTHER = '0x3333333333333333333333333333333333333333'
const E16 = BigInt(10) ** BigInt(16)
const hashN = (i: number) => `0x${(0xfab0000 + i).toString(16).padStart(64, '0')}`
const BLOCK_HASH = `0x${'ab'.repeat(32)}`
const ID = { blockNumber: 4_200_000, blockHash: BLOCK_HASH, txStatus: 1 }

type Item = { index: number; from: { hash: string }; to: { hash: string }; value: string; success: boolean; type: string }
/** `n` zero-value frames with the sell's native rows at the end (pages 5 for 230 items). */
function items(n: number, extra: Item[] = []): Item[] {
  const zero: Item[] = Array.from({ length: n - 2 }, () => ({ index: 0, from: { hash: ROUTER }, to: { hash: PM }, value: '0', success: true, type: 'staticcall' }))
  const native: Item[] = [
    { index: 0, from: { hash: PM }, to: { hash: ROUTER }, value: (BigInt(2) * E16).toString(), success: true, type: 'call' },
    { index: 0, from: { hash: ROUTER }, to: { hash: WALLET }, value: (BigInt(2) * E16).toString(), success: true, type: 'call' },
  ]
  return [...zero, ...extra, ...native].map((it, i) => ({ ...it, index: i + 1 }))
}
type Fault = 'timeout' | 500
function blockscout(txs: Map<string, { items: Item[]; faults?: Record<number, Fault[]> }>) {
  const urls: string[] = []
  const fn = async (url: string): Promise<Response> => {
    urls.push(url)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const u = new URL(url)
    const m = u.pathname.match(/\/transactions\/(0x[0-9a-f]{64})\/internal-transactions$/)
    const tx = m ? txs.get(m[1]) : undefined
    if (!tx) return json({ message: 'Not found' }, 404)
    if (u.searchParams.get('include_zero_value') === 'false') return json({ errors: [{ title: 'Invalid value' }] }, 422) // production
    const after = u.searchParams.has('index') ? Number(u.searchParams.get('index')) : 0
    const rest = tx.items.filter((it) => it.index > after)
    const pageNo = Math.floor((tx.items.length - rest.length) / 50) + 1
    const fault = tx.faults?.[pageNo]?.shift()
    if (fault === 'timeout') { const e = new Error('t'); e.name = 'TimeoutError'; throw e }
    if (fault === 500) return json({ message: 'boom' }, 500)
    const page = rest.slice(0, 50)
    const next = rest.length > 50 ? { block_number: 4_200_000, index: page[page.length - 1].index, items_count: 50, transaction_index: 3 } : null
    return json({ items: page, next_page_params: next, meta: { status: 1, message: null } })
  }
  const pageOf = (url: string) => { const q = new URL(url).searchParams; return q.has('index') ? Number(q.get('index')) / 50 + 1 : 1 }
  return { fn, urls, pages: () => urls.filter((x) => !x.includes('include_zero_value')).map(pageOf) }
}

/** Fake KV (shared across "scans"); `store` is inspectable. */
function fakeKv() {
  const store = new Map<string, unknown>()
  return {
    store,
    client: {
      get: async (k: string) => (store.has(k) ? structuredClone(store.get(k)) : null),
      set: async (k: string, v: unknown) => { store.set(k, structuredClone(v)); return 'OK' },
      del: async (k: string) => { store.delete(k); return 1 },
    },
  }
}
let kv = fakeKv()
/** A new scan: fresh source, fresh process memory (KV survives), fresh lane window. */
function newScan(s: ReturnType<typeof blockscout>) {
  __resetRobinhoodPartialTraceMemoryForTest()
  __resetRobinhoodNativeTraceMemoryForTest()
  __resetMemoryFallbackForTest()
  __resetRobinhoodBlockscoutRateLimitForTest()
  return blockscoutNativeTraceSource(s.fn)
}
const opts = () => ({ deadlineAt: Date.now() + 20_000, reserveRetry: true, identity: ID })
const toWallet = (t: Array<{ to: string; value: bigint; success: boolean }> | null) => (t ?? []).filter((x) => x.success && x.to === WALLET).reduce((a, x) => a + x.value, BigInt(0))

beforeEach(() => {
  kv = fakeKv()
  __setRobinhoodPartialTraceKvForTest(kv.client)
  __setRobinhoodNativeTraceKvForTest(null)
  __resetNativeTraceFilterCapabilityForTest()
})

test('A+B+C. scan 1 stores pages 1–2 (not proven); scan 2 resumes at page 3, never refetches 1–2, completes once, deletes the partial', async () => {
  const H = hashN(1)
  const s = blockscout(new Map([[H, { items: items(230), faults: { 3: ['timeout', 'timeout'] } }]]))
  // Scan 1 (production shape): pages 1–2 succeed, page 3 times out on the attempt and on the retry.
  const r1 = await newScan(s).transfersForTx(H, opts())
  assert.equal(r1.transfers, null)
  assert.equal(r1.audit?.result, 'transport_failed')
  assert.equal(r1.audit?.partialWritten, true)
  const key = robinhoodPartialTraceKey(H)
  const stored = kv.store.get(key) as RobinhoodPartialNativeTraceRecord
  assert.deepEqual([stored.completedPages, stored.itemCount, stored.paginationComplete], [2, 100, false])
  assert.ok(!('result' in stored) && !('transfers' in stored), 'never shaped like a proven trace')
  assert.equal(readRobinhoodNativeTraceMemory(H), null)
  assert.equal(await storedRobinhoodNativeTrace(H), null, 'I: a partial never satisfies a proven-trace read')
  // Scan 2: resumes at the stored page-3 cursor.
  const before = s.urls.length
  const r2 = await newScan(s).transfersForTx(H, opts())
  const scan2Pages = s.urls.slice(before).filter((x) => !x.includes('include_zero_value')).map((u) => { const q = new URL(u).searchParams; return Number(q.get('index')) / 50 + 1 })
  assert.deepEqual(scan2Pages, [3, 4, 5], 'pages 1–2 never requested again')
  assert.ok(s.urls.slice(before).every((u) => !u.includes('include_zero_value')), 'unfiltered cursor, no filter probe')
  assert.equal(r2.audit?.result, 'proven')
  assert.deepEqual([r2.audit?.partialTraceHit, r2.audit?.resumedFromPage, r2.audit?.resumedItemCount, r2.audit?.pagesRefetched], [true, 3, 100, 0])
  assert.equal(r2.audit?.totalItemCount, 230)
  assert.equal(toWallet(r2.transfers), BigInt(2) * E16)
  assert.equal(kv.store.has(key), false, 'partial deleted once complete')
  assert.notEqual(readRobinhoodNativeTraceMemory(H), null, 'proven trace persisted')
  // Scan 3: the proven trace serves it with zero Blockscout calls.
  const n = s.urls.length
  __resetRobinhoodPartialTraceMemoryForTest()
  const r3 = await blockscoutNativeTraceSource(s.fn).transfersForTx(H, opts())
  assert.equal(r3.audit?.result, 'proven')
  assert.equal(s.urls.length, n)
})

test('D (source level). a competing payer on the resumed page is part of the completed trace (PnL rejects it)', async () => {
  const H = hashN(2)
  const payer: Item = { index: 0, from: { hash: OTHER }, to: { hash: ROUTER }, value: E16.toString(), success: true, type: 'call' }
  const all = items(230)
  all.splice(160, 0, { ...payer }) // page 4
  const s = blockscout(new Map([[H, { items: all.map((it, i) => ({ ...it, index: i + 1 })), faults: { 3: ['timeout', 'timeout'] } }]]))
  await newScan(s).transfersForTx(H, opts())
  const r = await newScan(s).transfersForTx(H, opts())
  assert.equal(r.audit?.partialTraceHit, true)
  assert.ok(r.transfers!.some((t) => t.from === OTHER && t.value === E16), 'the resumed page\'s payer is in the payer universe')
})

test('E. a corrupted partial is discarded (deleted) and the lookup starts fresh at page 1', async () => {
  const H = hashN(3)
  const s = blockscout(new Map([[H, { items: items(120) }]]))
  kv.store.set(robinhoodPartialTraceKey(H), { kind: 'robinhood_partial_native_trace', garbage: true })
  const r = await newScan(s).transfersForTx(H, opts())
  assert.equal(r.audit?.result, 'proven')
  assert.equal(r.audit?.partialTraceHit, false)
  assert.deepEqual(s.pages(), [1, 2, 3])
  assert.equal(kv.store.has(robinhoodPartialTraceKey(H)), false)
})

async function seedPartial(H: string, s: ReturnType<typeof blockscout>) {
  const tx = blockscout(new Map([[H, { items: items(230), faults: { 3: ['timeout', 'timeout'] } }]]))
  await newScan(tx).transfersForTx(H, opts())
  void s
  return kv.store.get(robinhoodPartialTraceKey(H)) as RobinhoodPartialNativeTraceRecord
}
const reseal = (r: RobinhoodPartialNativeTraceRecord): RobinhoodPartialNativeTraceRecord => {
  const { checksum: _c, ...rest } = r
  void _c
  return { ...rest, checksum: partialTraceChecksum(rest) }
}

test('F. methodology version mismatch → discarded, fresh lookup', async () => {
  const H = hashN(4)
  const s = blockscout(new Map([[H, { items: items(230) }]]))
  const rec = await seedPartial(H, s)
  kv.store.set(robinhoodPartialTraceKey(H), reseal({ ...rec, methodologyVersion: 999 }))
  const r = await newScan(s).transfersForTx(H, opts())
  assert.equal(r.audit?.partialTraceHit, false)
  assert.deepEqual(s.pages(), [1, 2, 3, 4], 'fresh from page 1 (normal 4-page lookup)')
})

test('G. an expired partial is discarded', async () => {
  const H = hashN(5)
  const s = blockscout(new Map([[H, { items: items(120) }]]))
  const rec = await seedPartial(H, s)
  kv.store.set(robinhoodPartialTraceKey(H), reseal({ ...rec, expiresAt: Date.now() - 1 }))
  __resetRobinhoodPartialTraceMemoryForTest() // a new instance: the record comes from KV
  const v = await readPartialTrace(H)
  assert.deepEqual([v.record, v.reason], [null, 'expired'])
  assert.ok(rec.expiresAt - rec.updatedAt === ROBINHOOD_PARTIAL_TRACE_TTL_MS)
  assert.equal(kv.store.has(robinhoodPartialTraceKey(H)), false, 'an expired record is deleted')
  const r = await newScan(s).transfersForTx(H, opts())
  assert.deepEqual([r.audit?.partialTraceHit, s.pages()[0]], [false, 1])
})

test('G2. block identity changed (reorg) or a filtered cursor after the filter is known unsupported → discarded', async () => {
  const H = hashN(6)
  const s = blockscout(new Map([[H, { items: items(120) }]]))
  await seedPartial(H, s)
  const r = await newScan(s).transfersForTx(H, { ...opts(), identity: { ...ID, blockHash: `0x${'cd'.repeat(32)}` } })
  assert.equal(r.audit?.partialTraceHit, false)
  assert.deepEqual(s.pages(), [1, 2, 3])
  assert.equal(r.audit?.result, 'proven')
})

test('H. a newer partial is never overwritten by less progress (monotonic)', async () => {
  const H = hashN(7)
  const rec = await seedPartial(H, blockscout(new Map()))
  const three = { ...rec, completedPages: 3, nextCursor: 'block_number=4200000&index=150&items_count=50&transaction_index=3', cursors: [...rec.cursors, 'block_number=4200000&index=150&items_count=50&transaction_index=3'], items: [...rec.items, ...rec.items.slice(0, 50).map((it, i) => ({ ...it, index: 101 + i }))] }
  const w3 = await writePartialTrace({ txHash: H, completedPages: 3, nextCursor: three.nextCursor, cursors: three.cursors, items: three.items, filter: rec.filter, zeroValueFilter: rec.zeroValueFilter, sourceHost: rec.sourceHost, useGateway: rec.useGateway, identity: rec.identity })
  assert.equal(w3.written, true)
  const w2 = await writePartialTrace({ txHash: H, completedPages: 2, nextCursor: rec.nextCursor, cursors: rec.cursors, items: rec.items, filter: rec.filter, zeroValueFilter: rec.zeroValueFilter, sourceHost: rec.sourceHost, useGateway: rec.useGateway, identity: rec.identity })
  assert.deepEqual([w2.written, w2.reason], [false, 'not_more_progress'])
  assert.equal((kv.store.get(robinhoodPartialTraceKey(H)) as RobinhoodPartialNativeTraceRecord).completedPages, 3)
})

test('I. failures never produce transfers; a partial alone never yields a proven read', async () => {
  const H = hashN(8)
  const s = blockscout(new Map([[H, { items: items(230), faults: { 3: ['timeout', 'timeout'] } }]]))
  const r = await newScan(s).transfersForTx(H, opts())
  assert.equal(r.transfers, null)
  assert.equal(await storedRobinhoodNativeTrace(H), null)
  assert.equal(readRobinhoodNativeTraceMemory(H), null)
})

test('J. repeated failures advance monotonically: 2 → 4 pages → complete in 3 scans, no page refetched', async () => {
  const H = hashN(9)
  const s = blockscout(new Map([[H, { items: items(320), faults: { 3: ['timeout', 'timeout'], 5: ['timeout', 'timeout'] } }]]))
  const k = robinhoodPartialTraceKey(H)
  const r1 = await newScan(s).transfersForTx(H, opts())
  assert.equal((kv.store.get(k) as RobinhoodPartialNativeTraceRecord).completedPages, 2)
  const r2 = await newScan(s).transfersForTx(H, opts())
  assert.equal((kv.store.get(k) as RobinhoodPartialNativeTraceRecord).completedPages, 4)
  const r3 = await newScan(s).transfersForTx(H, opts())
  assert.deepEqual([r1.audit?.result, r2.audit?.result, r3.audit?.result], ['transport_failed', 'transport_failed', 'proven'])
  assert.equal(kv.store.has(k), false)
  // Successful pages each requested once; only the failing attempts (page 3 ×2, page 5 ×2) repeat.
  const counts = new Map<number, number>()
  for (const p of s.pages()) counts.set(p, (counts.get(p) ?? 0) + 1)
  assert.deepEqual([...counts.entries()].sort((a, b) => a[0] - b[0]), [[1, 1], [2, 1], [3, 3], [4, 1], [5, 3], [6, 1], [7, 1]])
})

test('no partial for: zero successful pages, malformed / indexing_pending responses', async () => {
  const H = hashN(10)
  const s = blockscout(new Map([[H, { items: items(230), faults: { 1: ['timeout', 'timeout'] } }]]))
  const r = await newScan(s).transfersForTx(H, opts())
  assert.equal(r.audit?.partialWritten, false)
  assert.equal(kv.store.has(robinhoodPartialTraceKey(H)), false)
})
