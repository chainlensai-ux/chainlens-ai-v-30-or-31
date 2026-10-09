// Robinhood oversized native traces (production: relayed sells 0x8aac…9310 / 0xe603…7e7e stopped at 4 pages / 200
// items → pagination_cap_exhausted). The real Blockscout pager + trace source run against a Blockscout-shaped server
// (50 items per page, `next_page_params` cursor, `include_zero_value=false` honoured or ignored, `meta.status`).
// Proof still needs the COMPLETE payer universe: no partial-page promotion, incomplete / ambiguous / externally funded
// stay rejected, each page is requested once, and extra pages come only from a small per-scan oversized budget.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import {
  computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest, ROBINHOOD_OVERSIZED_TRACE_BUDGET,
  RH_NATIVE, RH_V4_POSITION_MANAGER, V4_SWAP_TOPIC0, ERC20_TRANSFER_TOPIC0, type RhRpc, type RhEthUsdPoint,
} from '../lib/server/robinhoodPnlV1.ts'
import {
  NATIVE_TRACE_PAGINATION, NATIVE_TRACE_EXTENDED_MAX_ITEMS, __resetRobinhoodBlockscoutRateLimitForTest, blockscoutLaneRemaining,
  __resetNativeTraceFilterCapabilityForTest,
} from '../lib/server/robinhoodBlockscoutEvidence.ts'
import { blockscoutNativeTraceSource } from '../lib/server/robinhoodNativeTrace.ts'
import { getBlockscoutTransactionInternalTransactions } from '../lib/server/robinhoodBlockscoutEvidence.ts'
import { readRobinhoodNativeTraceMemory } from '../lib/server/robinhoodNativeTracePersistence.ts'
import { __resetRobinhoodPartialTraceMemoryForTest, __setRobinhoodPartialTraceKvForTest, partialTraceProgress } from '../lib/server/robinhoodPartialNativeTrace.ts'
import { __resetMemoryFallbackForTest } from '../lib/server/cache/tokenCache.ts'
import { __resetRobinhoodNativeTraceMemoryForTest, __setRobinhoodNativeTraceKvForTest } from '../lib/server/robinhoodNativeTracePersistence.ts'

process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
process.env.BLOCKSCOUT_API_KEY = 'proapi_SECRET_oversized_key'
delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

const TS = 1790155166
const WALLET = '0x9d69b5ffb22608d8003508b9c6bd9f6b458d4184'
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const ROUTER = '0x248a454a0000000000000000000000000000beef'
const RELAYER = '0x7777777777777777777777777777777777777777'
const OTHER = '0x3333333333333333333333333333333333333333'
const ENTRY = '0x0000000071727de22e5e9d8baf0edac6f37da032'
const TOKENS = Array.from({ length: 8 }, (_, i) => `0x${(0xbb00 + i).toString(16)}${'0'.repeat(36)}`)
const E18 = BigInt(10) ** BigInt(18)
const n = (x: number) => BigInt(Math.round(x * 1000)) * E18 / BigInt(1000)
const pad = (h: string) => h.replace(/^0x/, '').padStart(64, '0')
const t = (a: string) => `0x${pad(a)}`
const int256 = (v: bigint) => pad((v < BigInt(0) ? (BigInt(1) << BigInt(256)) + v : v).toString(16))
const uint = (v: bigint) => pad(v.toString(16))
const hex = (v: number | bigint) => `0x${BigInt(v).toString(16)}`
const hashN = (i: number) => `0x${(0xdea0000 + i).toString(16).padStart(64, '0')}`

// ── Blockscout-shaped internal-transactions server ─────────────────────────────────────────────────────
type Item = { index: number; from: { hash: string }; to: { hash: string }; value: string; success?: boolean; type: string }
type Row = [from: string, to: string, value: bigint]
/**
 * A relayed tx's internal transactions as Blockscout lists them: `zeroFrames` economically empty frames (ERC-4337
 * validation static calls, proxy delegate calls, token transfer() calls — value 0), then the native rows at
 * `nativeAt` (default: after the zero-value frames, i.e. past item 200 for an oversized trace).
 */
function blockscoutItems(rows: Row[], zeroFrames: number, nativeAt = zeroFrames): Item[] {
  const zero: Item[] = Array.from({ length: zeroFrames }, (_, i) => ({
    index: 0, from: { hash: i % 3 === 0 ? ENTRY : ROUTER }, to: { hash: i % 3 === 2 ? TOKENS[0] : PM }, value: '0', success: true,
    type: i % 3 === 0 ? 'staticcall' : i % 3 === 1 ? 'delegatecall' : 'call',
  }))
  const native: Item[] = rows.map(([from, to, value]) => ({ index: 0, from: { hash: from }, to: { hash: to }, value: value.toString(), success: true, type: 'call' }))
  const all = [...zero.slice(0, nativeAt), ...native, ...zero.slice(nativeAt)]
  return all.map((it, i) => ({ ...it, index: i + 1 }))
}
/** Transport faults for one tx page, consumed one per attempt: then the page answers normally. */
type Fault = 'timeout' | 'hang' | 500 | 503 | 429 | 'network'
type ServerTx = { items: Item[]; pending?: boolean; faults?: Record<number, Fault[]> }
function blockscout(txs: Map<string, ServerTx>, opts: { honorsFilter?: boolean; rejectsFilter?: boolean; latencyMs?: number } = {}) {
  const urls: string[] = []
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    urls.push(url)
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs))
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const u = new URL(url)
    const m = u.pathname.match(/\/transactions\/(0x[0-9a-f]{64})\/internal-transactions$/)
    if (!m) return json({ items: [], next_page_params: null })
    const tx = txs.get(m[1])
    if (!tx) return json({ message: 'Not found' }, 404)
    const filtered = u.searchParams.get('include_zero_value') === 'false'
    if (filtered && opts.rejectsFilter) return json({ errors: [{ title: 'Invalid value', source: { pointer: '/include_zero_value' } }] }, 422)
    const after = u.searchParams.has('index') ? Number(u.searchParams.get('index')) : 0
    const visible = tx.items.filter((it) => !(filtered && opts.honorsFilter && it.value === '0' && ['call', 'delegatecall', 'staticcall', 'callcode'].includes(it.type)))
    const rest = visible.filter((it) => it.index > after)
    const pageNo = Math.floor((visible.length - rest.length) / 50) + 1
    const fault = tx.faults?.[pageNo]?.shift()
    if (fault === 'timeout') { const e = new Error('t'); e.name = 'TimeoutError'; throw e }
    if (fault === 'network') throw new TypeError('fetch failed')
    if (fault === 'hang') return new Promise<Response>((_, reject) => {
      const keepAlive = setInterval(() => {}, 1_000) // AbortSignal.timeout timers are unref'd
      init?.signal?.addEventListener('abort', () => { clearInterval(keepAlive); reject(init.signal!.reason) })
    })
    if (typeof fault === 'number') return json({ message: 'upstream' }, fault)
    const page = rest.slice(0, 50)
    const next = rest.length > 50 ? { block_number: 4_200_000, index: page[page.length - 1].index, items_count: 50, transaction_index: 3, ...(filtered ? { include_zero_value: false } : {}) } : null
    return json({ items: page, next_page_params: next, meta: { status: tx.pending ? 2 : 1, message: null } })
  }
  const traceUrls = () => urls.filter((x) => x.includes('/internal-transactions'))
  return { fn, urls, traceUrls }
}

const SELL_ROWS: Row[] = [[PM, ROUTER, n(0.02)], [ROUTER, WALLET, n(0.02)]]
const BUY_ROWS: Row[] = [[WALLET, ROUTER, n(0.01)], [ROUTER, PM, n(0.01)]]
const toWallet = (tr: Array<{ to: string; value: bigint; success: boolean }> | null) => (tr ?? []).filter((x) => x.success && x.to === WALLET).reduce((a, x) => a + x.value, BigInt(0))

beforeEach(() => {
  __resetRobinhoodPartialTraceMemoryForTest()
  __setRobinhoodPartialTraceKvForTest(null)
  __resetNativeTraceFilterCapabilityForTest() // the 422 capability cache is per runtime
  __resetRobinhoodBlockscoutRateLimitForTest()
  __resetMemoryFallbackForTest()
  __resetRobinhoodNativeTraceMemoryForTest()
  __setRobinhoodNativeTraceKvForTest(null)
  __resetRobinhoodPnlV1CachesForTest()
})

// ── Trace source (adapter) level ───────────────────────────────────────────────────────────────────────
test('A1. root cause: a 262-item relayed sell is 260 zero-value frames + 2 native rows; capped at 4 pages / 200 items', async () => {
  const H = hashN(1)
  const s = blockscout(new Map([[H, { items: blockscoutItems(SELL_ROWS, 260) }]])) // server ignores include_zero_value
  const src = blockscoutNativeTraceSource(s.fn)
  const r = await src.transfersForTx(H)
  assert.equal(r.audit?.result, 'pagination_cap_exhausted')
  assert.equal(r.transfers, null, 'no partial-page proof')
  assert.deepEqual([r.audit?.pagesRequested, r.audit?.totalItemCount, r.audit?.paginationComplete, r.audit?.paginationCapHit], [4, 200, false, true])
  assert.equal(r.audit?.zeroValueFilter, 'ignored_by_server')
  const c = r.audit!.itemCategories!
  assert.equal(c.valueBearing, 0, 'none of the first 200 items moves native value')
  assert.equal(c.staticcall + c.delegatecall + c.callZeroValue, 200)
})

test('A2. Blockscout honouring include_zero_value=false returns the complete native payer universe in ONE page', async () => {
  const H = hashN(2)
  const s = blockscout(new Map([[H, { items: blockscoutItems(SELL_ROWS, 260) }]]), { honorsFilter: true })
  const r = await blockscoutNativeTraceSource(s.fn).transfersForTx(H)
  assert.equal(r.audit?.result, 'proven')
  assert.deepEqual([r.audit?.pagesRequested, r.audit?.totalItemCount, r.audit?.paginationComplete], [1, 2, true])
  assert.equal(r.audit?.zeroValueFilter, 'applied')
  assert.equal(toWallet(r.transfers), n(0.02))
  assert.equal(new URL(s.traceUrls()[0]).searchParams.get('include_zero_value'), 'false')
})

test('A3. complete extended trace: continues from page 5 (no page requested twice), proven only at next_page_params null', async () => {
  const H = hashN(3)
  const s = blockscout(new Map([[H, { items: blockscoutItems(SELL_ROWS, 260) }]]))
  const src = blockscoutNativeTraceSource(s.fn)
  await src.transfersForTx(H)
  const ext = await src.extendOversized(H, { maxExtraPages: 8, maxTotalMs: 8_000, priority: 'p1_native_out_sell' })
  assert.equal(ext?.audit?.result, 'proven')
  assert.deepEqual([ext?.audit?.pagesRequested, ext?.audit?.totalItemCount, ext?.audit?.paginationComplete, ext?.audit?.paginationCapHit], [6, 262, true, false])
  assert.deepEqual([ext?.audit?.extension?.pagesRequested, ext?.audit?.extension?.transportAttempts], [2, 2])
  assert.equal(toWallet(ext!.transfers), n(0.02))
  assert.equal(new Set(s.traceUrls()).size, s.traceUrls().length, 'no duplicate page request')
  assert.equal(s.traceUrls().length, 6)
  assert.equal(await src.extendOversized(H, { maxExtraPages: 8, maxTotalMs: 8_000, priority: 'p1_native_out_sell' }), null, 'one continuation per tx')
  // Complete → persisted: a later lookup is a stored hit with zero Blockscout calls.
  const before = s.urls.length
  const again = await blockscoutNativeTraceSource(s.fn).transfersForTx(H)
  assert.equal(again.audit?.result, 'proven')
  assert.equal(s.urls.length, before)
})

test('A4. first 200 look safe, page 5 invalidates (unknown execution status) → whole trace unavailable, nothing stored', async () => {
  const H = hashN(4)
  const items = blockscoutItems(SELL_ROWS, 260, 10) // the native rows sit on page 1
  delete items[230].success
  const s = blockscout(new Map([[H, { items }]]))
  const src = blockscoutNativeTraceSource(s.fn)
  const first = await src.transfersForTx(H)
  assert.equal(first.audit?.result, 'pagination_cap_exhausted', 'a page-1 wallet credit is never early success')
  const ext = await src.extendOversized(H, { maxExtraPages: 8, maxTotalMs: 8_000, priority: 'p1_native_out_sell' })
  assert.equal(ext?.audit?.result, 'unknown_execution_status')
  assert.equal(ext?.transfers, null)
  const later = await blockscoutNativeTraceSource(s.fn).transfersForTx(H)
  assert.notEqual(later.audit?.cacheHit && later.transfers != null, true)
})

test('A5. an oversized trace that exhausts the extended budget stays rejected (no partial proof, not stored)', async () => {
  const H = hashN(5)
  const s = blockscout(new Map([[H, { items: blockscoutItems(SELL_ROWS, 1000) }]]))
  const src = blockscoutNativeTraceSource(s.fn)
  await src.transfersForTx(H)
  const ext = await src.extendOversized(H, { maxExtraPages: 8, maxTotalMs: 8_000, priority: 'p1_native_out_sell' })
  assert.equal(ext?.audit?.result, 'pagination_cap_exhausted')
  assert.equal(ext?.transfers, null)
  assert.equal(ext?.audit?.totalItemCount, NATIVE_TRACE_EXTENDED_MAX_ITEMS)
  assert.equal(ext?.audit?.extension?.pagesRequested, 8)
  assert.equal(s.traceUrls().length, 12)
  assert.equal(new Set(s.traceUrls()).size, 12)
})

test('A6. filter rejected (HTTP 422) → same lookup re-requests page 1 unfiltered; one native_trace slot', async () => {
  const H = hashN(6)
  const s = blockscout(new Map([[H, { items: blockscoutItems(SELL_ROWS, 40) }]]), { rejectsFilter: true })
  const before = blockscoutLaneRemaining('native_trace')
  const r = await blockscoutNativeTraceSource(s.fn).transfersForTx(H)
  assert.equal(r.audit?.result, 'proven')
  assert.equal(r.audit?.zeroValueFilter, 'rejected_fallback_unfiltered')
  assert.equal(blockscoutLaneRemaining('native_trace'), before - 1)
  assert.equal(s.traceUrls().length, 2)
})

test('A7. Blockscout meta.status 2 (internal transactions still indexing) is never a complete / empty trace', async () => {
  const H = hashN(7)
  const s = blockscout(new Map([[H, { items: [], pending: true }]]), { honorsFilter: true })
  const r = await blockscoutNativeTraceSource(s.fn).transfersForTx(H)
  assert.equal(r.audit?.result, 'indexing_pending')
  assert.equal(r.transfers, null)
})

test('A8. normal caps are unchanged', () => {
  assert.deepEqual({ ...NATIVE_TRACE_PAGINATION }, { maxPages: 4, maxItems: 200, maxTotalMs: 12_000 })
  assert.deepEqual({ ...ROBINHOOD_OVERSIZED_TRACE_BUDGET }, { maxTxPerScan: 2, maxExtraPagesPerScan: 8, maxMsPerTx: 8_000 })
  assert.equal(NATIVE_TRACE_EXTENDED_MAX_ITEMS, NATIVE_TRACE_PAGINATION.maxItems + ROBINHOOD_OVERSIZED_TRACE_BUDGET.maxExtraPagesPerScan * 50)
})

// ── PnL level: relayed receipts + the real trace source over the Blockscout-shaped server ───────────────
const POOLS = new Map<string, string>()
function poolId(x: string, y: string) {
  const [c0, c1] = [x, y].sort((p, q) => (BigInt(p) < BigInt(q) ? -1 : 1))
  const types = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const
  const args = [c0 as Hex, c1 as Hex, 3000, 60, RH_NATIVE as Hex] as const
  const id = keccak256(encodeAbiParameters(types, args)).toLowerCase()
  POOLS.set(id, encodeAbiParameters(types, args))
  return { id, c0, c1 }
}
class Tx {
  logs: Array<{ address: string; topics: string[]; data: string; logIndex: string; blockTimestamp: string }> = []
  items: Item[] = []
  faults: Record<number, Fault[]> | undefined
  private i = 0
  constructor(public ts = TS) {}
  private push(address: string, topics: string[], data: string) { this.logs.push({ address, topics, data, logIndex: hex(this.i++), blockTimestamp: hex(this.ts) }); return this }
  xfer(token: string, from: string, to: string, amt: bigint) { return this.push(token, [ERC20_TRANSFER_TOPIC0, t(from), t(to)], `0x${uint(amt)}`) }
  v4(inTok: string, outTok: string, inAmt: bigint, outAmt: bigint) {
    const p = poolId(inTok, outTok)
    const d: Record<string, bigint> = { [inTok]: -inAmt, [outTok]: outAmt }
    return this.push(PM, [V4_SWAP_TOPIC0, p.id, t(ROUTER)], `0x${int256(d[p.c0])}${int256(d[p.c1])}${'0'.repeat(256)}`)
  }
  trace(rows: Row[], zeroFrames = 0, nativeAt = zeroFrames) { this.items = blockscoutItems(rows, zeroFrames, nativeAt); return this }
}
const sellTx = (k: number, ts: number) => new Tx(ts).xfer(TOKENS[k], WALLET, PM, n(100 + k)).v4(TOKENS[k], RH_NATIVE, n(100 + k), n(0.02))
const buyTx = (k: number, ts: number) => new Tx(ts).v4(RH_NATIVE, TOKENS[k], n(0.01), n(100 + k)).xfer(TOKENS[k], PM, WALLET, n(100 + k))
const ethAt = async (ts: number): Promise<RhEthUsdPoint | null> => ({ priceUsd: 2600, provider: 'x', endpoint: null, pointMs: Math.floor(ts / 86_400) * 86_400_000, gapMs: (ts % 86_400) * 1000, maxAllowedGapMs: 86_400_000 })

async function scan(txs: Tx[], opts: { honorsFilter?: boolean; rejectsFilter?: boolean; latencyMs?: number; extension?: boolean; concurrency?: number; wrapTrace?: (inner: ReturnType<typeof blockscoutNativeTraceSource>['transfersForTx']) => ReturnType<typeof blockscoutNativeTraceSource>['transfersForTx'] } = {}) {
  __resetRobinhoodPnlV1CachesForTest()
  const byHash = new Map(txs.map((tx, i) => [hashN(100 + i), { tx, i, block: 1000 + i * 10 }]))
  const server = blockscout(new Map([...byHash].map(([h, e]) => [h, { items: e.tx.items, faults: e.tx.faults }])), { honorsFilter: opts.honorsFilter, rejectsFilter: opts.rejectsFilter, latencyMs: opts.latencyMs })
  const source = blockscoutNativeTraceSource(server.fn)
  let rpcCalls = 0
  const rpc: RhRpc = async (calls) => calls.map(({ method, params }) => {
    rpcCalls += 1
    const p = params as any[]
    if (method === 'eth_getTransactionReceipt') { const e = byHash.get(p[0]); return e ? { status: '0x1', from: RELAYER, to: ROUTER, blockNumber: hex(e.block), gasUsed: '0x1', effectiveGasPrice: '0x1', logs: e.tx.logs } : null }
    if (method === 'eth_getTransactionByHash') return byHash.has(p[0]) ? { value: '0x0' } : null
    if (method === 'eth_getBalance') return hex(BigInt(10) * E18)
    if (method === 'eth_getTransactionCount') return '0x1'
    if (method === 'eth_getBlockByNumber') return { timestamp: hex(TS) }
    if (method === 'eth_call' && p[0].to === RH_V4_POSITION_MANAGER) return [...POOLS.entries()].find(([id]) => id.slice(2, 52) === String(p[0].data).slice(10, 60))?.[1] ?? null
    if (method === 'eth_call' && p[0].data === '0x313ce567') return hex(18)
    return null
  })
  const lines: Array<[string, any]> = []
  const w = console.warn
  console.warn = (tag: unknown, body: unknown) => { lines.push([String(tag), body]) }
  const started = Date.now()
  try {
    const r = await computeRobinhoodPnlV1({
      wallet: WALLET, candidates: txs.map((tx, i) => ({ txHash: hashN(100 + i), timestampMs: tx.ts * 1000, hasSwapLog: true })),
      transactionCount: txs.length, transferCount: txs.length, activityUnavailableReason: null,
      deps: {
        rpc, now: Date.now, tokenHistoricalUsd: async () => null, ethUsdAt: ethAt, ethUsdRange: async () => null,
        nativeTransfersForTx: opts.wrapTrace ? opts.wrapTrace(source.transfersForTx) : source.transfersForTx,
        ...(opts.concurrency != null ? { nativeTraceConcurrency: opts.concurrency } : {}),
        nativeTracePartialProgress: partialTraceProgress,
        ...(opts.extension === false ? {} : { extendNativeTraceForTx: source.extendOversized }),
      },
    })
    return { r, server, rpcCalls, elapsedMs: Date.now() - started, lines, idx: (h: string) => byHash.get(h)?.i }
  } finally { console.warn = w }
}

test('P1. >200-item relayed sell with a valid wallet route: rejected without the extension, promoted with it', async () => {
  const txs = () => [buyTx(0, TS - 300).trace(BUY_ROWS, 10), sellTx(0, TS - 100).trace(SELL_ROWS, 260)]
  const before = await scan(txs(), { extension: false })
  assert.equal(before.r.swapsVerified, 1)
  assert.equal(before.r.ingestionAudit.relayedWalletRejectedReasons?.ambiguous_trace, 1)
  __resetRobinhoodPartialTraceMemoryForTest() // this test is about the in-scan extension, not cross-scan progress
  const after = await scan(txs())
  assert.equal(after.r.swapsVerified, 2)
  assert.deepEqual([after.r.ingestionAudit.normalizedBuyCount, after.r.ingestionAudit.normalizedSellCount], [1, 1])
  const o = after.r.ingestionAudit.oversizedTraceBudget!
  assert.deepEqual([o.oversizedSeen, o.extendedTx, o.completedByExtension, o.extraPagesUsed], [1, 1, 1, 2])
  assert.equal(o.perTx[0].priority, 'p1_native_out_sell')
  assert.equal(new Set(after.server.traceUrls()).size, after.server.traceUrls().length, 'no duplicate page requests')
})

test('P2. competing payer appearing after item 200 → the complete extended trace rejects it (externally funded)', async () => {
  const rows: Row[] = [[WALLET, ROUTER, n(0.005)], [OTHER, ROUTER, n(0.005)], [ROUTER, PM, n(0.01)]]
  const tx = buyTx(1, TS - 100)
  tx.items = blockscoutItems(rows, 250, 5).map((it) => it) // wallet debit on page 1 …
  const otherRow = tx.items.find((it) => it.from.hash === OTHER)!
  tx.items = tx.items.filter((it) => it !== otherRow)
  tx.items.splice(230, 0, otherRow) // … and the co-payer at item ~231 (page 5)
  tx.items = tx.items.map((it, i) => ({ ...it, index: i + 1 }))
  const { r } = await scan([tx])
  assert.equal(r.swapsVerified, 0)
  assert.equal(r.ingestionAudit.oversizedTraceBudget?.completedByExtension, 1)
  assert.deepEqual(r.ingestionAudit.relayedWalletRejectedReasons, { externally_funded_route: 1 })
})

test('P3. sell whose first 200 items look safe but page 5 shows a wallet native debit → not promoted', async () => {
  const tx = sellTx(2, TS - 100)
  tx.items = blockscoutItems(SELL_ROWS, 250, 3)
  tx.items.splice(240, 0, { index: 0, from: { hash: WALLET }, to: { hash: OTHER }, value: n(0.05).toString(), success: true, type: 'call' })
  tx.items = tx.items.map((it, i) => ({ ...it, index: i + 1 }))
  const { r } = await scan([tx])
  assert.equal(r.ingestionAudit.oversizedTraceBudget?.completedByExtension, 1)
  assert.equal(r.swapsVerified, 0)
  // Complete trace, wallet paid native (traceNativeFromWallet > 0): the native-out verdict refuses it (control: P1).
  assert.deepEqual(r.ingestionAudit.relayedWalletRejectedReasons, { ambiguous_trace: 1 })
})

test('P4. the per-scan oversized budget: sells first, at most 2 tx / 8 extra pages; the buy stays rejected', async () => {
  const txs = [buyTx(3, TS - 400).trace(BUY_ROWS, 260), sellTx(4, TS - 300).trace(SELL_ROWS, 260), sellTx(5, TS - 200).trace(SELL_ROWS, 260)]
  const { r, server } = await scan(txs)
  const o = r.ingestionAudit.oversizedTraceBudget!
  assert.equal(o.extendedTx, 2)
  assert.ok(o.extraPagesUsed <= ROBINHOOD_OVERSIZED_TRACE_BUDGET.maxExtraPagesPerScan)
  assert.deepEqual(o.perTx.filter((p) => p.outcome === 'proven').map((p) => p.priority), ['p1_native_out_sell', 'p1_native_out_sell'])
  assert.deepEqual(o.perTx.filter((p) => p.outcome === 'skipped_oversized_budget_exhausted').map((p) => p.priority), ['p3_relayed_buy_or_other'])
  assert.equal(r.swapsVerified, 2)
  assert.equal(r.ingestionAudit.normalizedSellCount, 2)
  assert.equal(new Set(server.traceUrls()).size, server.traceUrls().length)
  assert.equal(server.traceUrls().length, 3 * 4 + 2 * 2)
})

test('P5. with the zero-value filter honoured the same oversized txs need no extension at all (1 page each)', async () => {
  const txs = [buyTx(3, TS - 400).trace(BUY_ROWS, 260), sellTx(4, TS - 300).trace(SELL_ROWS, 260), sellTx(5, TS - 200).trace(SELL_ROWS, 260)]
  const { r, server } = await scan(txs, { honorsFilter: true })
  assert.equal(r.swapsVerified, 3)
  assert.equal(r.ingestionAudit.oversizedTraceBudget?.oversizedSeen, 0)
  assert.equal(server.traceUrls().length, 3)
})

// ── Transport reliability of a started oversized trace (production job 100ad3b6: 0x8aac…9310 / 0xe603…7e7e —
// filter 422 → unfiltered, pages 1–3 ok, page 4 timed out, pageRetryCount 0, transport_failed) ─────────────────────
const pageOf = (url: string) => new URL(url).searchParams.get('index') ?? 'p1'
const big = (faults?: Record<number, Fault[]>): ServerTx => ({ items: blockscoutItems(SELL_ROWS, 230), faults }) // 5 pages
const SLOW_WINDOW = { maxPages: 6, maxItems: 600, maxTotalMs: 1_200 }

test('R0. the bug: a hung page 4 eats the rest of the lookup window → no time for its retry (pageRetryCount 0)', async () => {
  const H = hashN(200)
  const s = blockscout(new Map([[H, big({ 4: ['hang'] })]]), { rejectsFilter: true })
  const t = await getBlockscoutTransactionInternalTransactions(H, s.fn, SLOW_WINDOW) // no scan deadline: old rule
  assert.equal(t.status, 'transport_failed')
  assert.deepEqual([t.pagesSucceeded, t.totalItemCount, t.pageRetryCount, t.transientFailureCounts.timeout], [3, 150, 0, 1])
  assert.equal(t.items, null)
})

test('R1. page 4 timeout → same-cursor retry inside the scan deadline → complete, proof valid', async () => {
  const H = hashN(201)
  const s = blockscout(new Map([[H, big({ 4: ['hang'] })]]), { rejectsFilter: true })
  const t = await getBlockscoutTransactionInternalTransactions(H, s.fn, SLOW_WINDOW, { deadlineAt: Date.now() + 6_000 })
  assert.equal(t.status, 'pagination_cap_exhausted', 'the retry used the scan time; the lookup window is spent')
  assert.ok(t.resume, 'page 5 continues from its cursor')
  assert.deepEqual([t.pagesSucceeded, t.pageRetryCount, t.pagesRetried], [4, 1, [4]])
  const done = await (await import('../lib/server/robinhoodBlockscoutEvidence.ts')).continueBlockscoutTransactionInternalTransactions(t.resume!, s.fn, { maxExtraPages: 2, maxItems: 600, maxTotalMs: 2_000 })
  assert.equal(done.status, 'complete')
  assert.equal(done.items!.length, 232)
  const pages = s.traceUrls().map(pageOf)
  // Repeats: page 1 (the 422 filter probe, then unfiltered) and page 4 (its one retry). Nothing else.
  assert.deepEqual(pages.filter((p) => pages.indexOf(p) !== pages.lastIndexOf(p)), ['p1', 'p1', '150', '150'])
  assert.equal(pages.length, 5 + 2)
})

test('R2. page 4 times out twice → fail closed (no items), resumable cursor kept, nothing stored', async () => {
  const H = hashN(202)
  const s = blockscout(new Map([[H, big({ 4: ['timeout', 'timeout'] })]]))
  const src = blockscoutNativeTraceSource(s.fn)
  const r = await src.transfersForTx(H, { deadlineAt: Date.now() + 20_000 })
  assert.equal(r.audit?.result, 'transport_failed')
  assert.equal(r.transfers, null)
  assert.deepEqual([r.audit?.pagesSucceeded, r.audit?.pageRetryCount, r.audit?.paginationComplete], [3, 1, false])
  assert.equal(readRobinhoodNativeTraceMemory(H), null, 'an incomplete trace is never persisted')
})

test('R3. page 3 HTTP 500 → one retry on the same cursor → complete', async () => {
  const H = hashN(203)
  const items = blockscoutItems(SELL_ROWS, 150) // 4 pages
  const s = blockscout(new Map([[H, { items, faults: { 3: [500] } }]]))
  const r = await blockscoutNativeTraceSource(s.fn).transfersForTx(H, { deadlineAt: Date.now() + 20_000 })
  assert.equal(r.audit?.result, 'proven')
  assert.deepEqual([r.audit?.pageRetryCount, r.audit?.pagesRetried, r.audit?.totalItemCount], [1, [3], 152])
  assert.equal(toWallet(r.transfers), n(0.02))
  assert.equal(s.traceUrls().length, 5, 'pages 1, 2, 3, 3 (retry), 4 — no other page refetched')
})

test('R4. a 422 filter rejection is cached: later lookups skip the probe; the entry expires', async () => {
  const s = blockscout(new Map([[hashN(204), { items: blockscoutItems(SELL_ROWS, 10) }], [hashN(205), { items: blockscoutItems(SELL_ROWS, 10) }], [hashN(206), { items: blockscoutItems(SELL_ROWS, 10) }]]), { rejectsFilter: true })
  const src = blockscoutNativeTraceSource(s.fn)
  const a = await src.transfersForTx(hashN(204))
  assert.deepEqual([a.audit?.zeroValueFilter, a.audit?.filterProbes], ['rejected_fallback_unfiltered', 1])
  const b = await src.transfersForTx(hashN(205))
  assert.deepEqual([b.audit?.zeroValueFilter, b.audit?.filterProbes, b.audit?.result], ['skipped_known_unsupported', 0, 'proven'])
  assert.equal(s.traceUrls().filter((u) => u.includes('include_zero_value')).length, 1, 'one probe for the runtime window')
  const realNow = Date.now
  try {
    Date.now = () => realNow() + 31 * 60_000 // past the capability TTL: probe again
    const c = await src.transfersForTx(hashN(206))
    assert.equal(c.audit?.filterProbes, 1)
  } finally { Date.now = realNow }
})

test('R5. scan deadline too close for a retry → fail closed without retrying', async () => {
  const H = hashN(207)
  const s = blockscout(new Map([[H, big({ 2: ['timeout'] })]]))
  // Room for a first attempt (≥ 1 s of scan after the margin) but not for a retry (≥ 1.5 s + delay).
  const r = await blockscoutNativeTraceSource(s.fn).transfersForTx(H, { deadlineAt: Date.now() + 2_000 })
  assert.equal(r.audit?.result, 'transport_failed')
  assert.equal(r.audit?.pageRetryCount, 0)
  assert.equal(r.audit?.retrySkippedForDeadline, true)
  assert.equal(r.transfers, null)
})

test('R6. a started trace that failed on transport resumes at the failed page (pages 1–3 never refetched) → proven', async () => {
  const H = hashN(208)
  const s = blockscout(new Map([[H, big({ 4: ['timeout', 'timeout'] })]]))
  const src = blockscoutNativeTraceSource(s.fn)
  await src.transfersForTx(H, { deadlineAt: Date.now() + 20_000 })
  const before = s.traceUrls().length
  const ext = await src.extendOversized(H, { maxExtraPages: 8, maxTotalMs: 5_000, priority: 'p1_native_out_sell', deadlineAt: Date.now() + 20_000 })
  assert.equal(ext?.audit?.result, 'proven')
  const after = s.traceUrls().slice(before).map(pageOf)
  assert.equal(after.length, 2, 'page 4 (exact cursor) and page 5 only')
  assert.equal(after[0], pageOf(s.traceUrls()[before - 1]), 'resumed on the failed page cursor')
  assert.equal(toWallet(ext!.transfers), n(0.02))
})

test('R7. PnL: production shape (422 + page 4 timeout once) — relayed sell promoted only on the complete trace', async () => {
  const tx = sellTx(6, TS - 100).trace(SELL_ROWS, 160) // 4 pages, native rows on page 4
  tx.faults = { 4: ['timeout'] }
  const { r, server } = await scan([tx], { rejectsFilter: true })
  assert.equal(r.swapsVerified, 1)
  const pages = server.traceUrls().map(pageOf)
  assert.equal(pages.length - new Set(pages).size, 2, 'duplicates: page 1 (422 probe → unfiltered) and page 4 (retry) only')
})

test('R8. PnL: competing payer on the retried final page still rejects (externally funded)', async () => {
  const rows: Row[] = [[WALLET, ROUTER, n(0.005)], [OTHER, ROUTER, n(0.005)], [ROUTER, PM, n(0.01)]]
  const tx = buyTx(7, TS - 100)
  tx.items = blockscoutItems(rows, 160, 158) // all three native rows on page 4
  tx.faults = { 4: [503] }
  const { r } = await scan([tx], { rejectsFilter: true })
  assert.equal(r.swapsVerified, 0)
  assert.deepEqual(r.ingestionAudit.relayedWalletRejectedReasons, { externally_funded_route: 1 })
})

// ── Trace contention (job c7618df3): concurrent traces probed the filter together and a sell's first attempt could
// leave no time for its retry; selected traces ran 3 at a time regardless of priority ─────────────────────────────
test('S1. filter probe singleflight: 3 concurrent lookups → ONE 422 probe; the others wait, then go unfiltered', async () => {
  const hs = [hashN(300), hashN(301), hashN(302)]
  const s = blockscout(new Map(hs.map((h) => [h, { items: blockscoutItems(SELL_ROWS, 10) }])), { rejectsFilter: true, latencyMs: 40 })
  const src = blockscoutNativeTraceSource(s.fn)
  const rs = await Promise.all(hs.map((h) => src.transfersForTx(h)))
  assert.deepEqual(rs.map((r) => r.audit?.result), ['proven', 'proven', 'proven'])
  assert.equal(rs.reduce((t, r) => t + (r.audit?.filterProbes ?? 0), 0), 1)
  assert.equal(s.traceUrls().filter((u) => u.includes('include_zero_value')).length, 1, 'no duplicate 422 probes')
  assert.deepEqual(rs.map((r) => r.audit?.filterCapabilityWaitMs != null), [false, true, true])
  assert.deepEqual(rs.slice(1).map((r) => r.audit?.zeroValueFilter), ['skipped_known_unsupported', 'skipped_known_unsupported'])
})

test('S2. a probe that fails transiently settles nothing: a waiter probes next (never stuck), still one 422 in total', async () => {
  const hs = [hashN(303), hashN(304)]
  const s = blockscout(new Map([[hs[0], { items: blockscoutItems(SELL_ROWS, 10), faults: { 1: [500, 500] } }], [hs[1], { items: blockscoutItems(SELL_ROWS, 10) }]]), { latencyMs: 20 })
  const src = blockscoutNativeTraceSource(s.fn)
  const [a, b] = await Promise.all(hs.map((h) => src.transfersForTx(h, { deadlineAt: Date.now() + 20_000 })))
  assert.equal(a.audit?.result, 'transport_failed')
  assert.equal(b.audit?.result, 'proven')
  assert.notEqual(b.audit?.filterCapabilityWaitMs, null)
})

test('S3. retry headroom: a high-priority first attempt leaves room for its retry; without the reserve it does not', async () => {
  const run = async (reserveRetry: boolean, h: string) => {
    const s = blockscout(new Map([[h, { items: blockscoutItems(SELL_ROWS, 60), faults: { 2: ['hang'] } }]]))
    return blockscoutNativeTraceSource(s.fn).transfersForTx(h, { deadlineAt: Date.now() + 4_500, reserveRetry })
  }
  const without = await run(false, hashN(305))
  assert.deepEqual([without.audit?.result, without.audit?.pageRetryCount], ['transport_failed', 0])
  __resetRobinhoodBlockscoutRateLimitForTest()
  const withReserve = await run(true, hashN(306))
  assert.deepEqual([withReserve.audit?.result, withReserve.audit?.pageRetryCount, withReserve.audit?.pagesRetried], ['proven', 1, [2]])
})

test('S4. not enough scan time for a meaningful first attempt + reserve → no page is launched (fail closed)', async () => {
  const H = hashN(307)
  const s = blockscout(new Map([[H, { items: blockscoutItems(SELL_ROWS, 10) }]]))
  const r = await blockscoutNativeTraceSource(s.fn).transfersForTx(H, { deadlineAt: Date.now() + 3_000, reserveRetry: true })
  assert.equal(r.audit?.result, 'not_attempted_deadline')
  assert.equal(r.transfers, null)
  assert.equal(s.traceUrls().length, 0)
})

test('S5. the reserve is per attempt, not held: a 4-page high-priority trace completes with the deadline just above one reserve', async () => {
  const H = hashN(308)
  const s = blockscout(new Map([[H, { items: blockscoutItems(SELL_ROWS, 160) }]]), { latencyMs: 30 })
  const r = await blockscoutNativeTraceSource(s.fn).transfersForTx(H, { deadlineAt: Date.now() + 4_000, reserveRetry: true })
  assert.deepEqual([r.audit?.result, r.audit?.pagesSucceeded], ['proven', 4])
})

test('S6. scheduler: concurrency 2, sells first (wave 1), buys start only when a slot frees; proof unchanged', async () => {
  const txs = [buyTx(0, TS - 400).trace(BUY_ROWS, 60), buyTx(1, TS - 300).trace(BUY_ROWS, 60), sellTx(2, TS - 200).trace(SELL_ROWS, 120), sellTx(3, TS - 100).trace(SELL_ROWS, 120)]
  const { r, lines, idx } = await scan(txs, { latencyMs: 30 })
  const rows = lines.filter(([t, b]) => t === '[robinhood-trace-scheduler-audit]' && b.txHash).map(([, b]) => ({ ...b, i: idx(b.txHash) }))
  const summary = lines.find(([t, b]) => t === '[robinhood-trace-scheduler-audit]' && b.summary)![1].summary
  assert.deepEqual(rows.slice(0, 2).map((x) => x.priorityClass), ['p1_native_out_sell', 'p1_native_out_sell'])
  assert.deepEqual(rows.map((x) => x.wave), [1, 1, 2, 2])
  assert.equal(summary.peakConcurrency, 2)
  assert.equal(summary.concurrencyLimit, 2)
  const firstFinish = Math.min(...rows.slice(0, 2).map((x) => x.finishedAtMs))
  assert.ok(rows.slice(2).every((x) => x.startedAtMs >= firstFinish), 'no buy overlaps both sells')
  assert.deepEqual(rows.slice(0, 2).map((x) => x.retryReserveMs), [2250, 2250])
  assert.equal(summary.completedLiveTraces, 4)
  assert.equal(r.swapsVerified, 4)
  assert.equal(r.ingestionAudit.traceScheduler?.peakConcurrency, 2)
  assert.deepEqual(summary.outcomes, { completed: 4, transport_failed: 0, not_attempted_deadline: 0, retry_exhausted: 0, pagination_incomplete: 0 })
  // [robinhood-fifo-coverage-audit] is emitted once per verified sell plus a summary (diagnostic only).
  const fifo = lines.filter(([t]) => t === '[robinhood-fifo-coverage-audit]').map(([, b]) => b)
  assert.equal(fifo.filter((b) => b.sellTxHash).length, 2)
  assert.equal(fifo.find((b) => b.summary)?.summary.verifiedSellCount, 2)
  assert.equal(r.ingestionAudit.fifoCoverage?.verifiedSwapCount, 4)
  assert.equal(summary.deadlineOverruns, 0)
})

// ── Admission (job 6c3736d5: wave-2 buys started with ~0.5 s left and ran ~12 s past the lane) ───────────────────
test('T1. a p2 buy with 500 ms of scan left is not started: zero requests, not_attempted_deadline, nothing stored', async () => {
  const realNow = Date.now
  let offset = 0
  const t0 = realNow()
  Date.now = () => realNow() + offset
  try {
    const txs = [buyTx(4, TS - 300).trace(BUY_ROWS, 10), sellTx(5, TS - 100).trace(SELL_ROWS, 10)]
    const { r, server, lines } = await scan(txs, {
      concurrency: 1,
      // The sell (wave 1) "takes" the lane: when it returns, 500 ms of the 15 s scan deadline remain.
      wrapTrace: (inner) => async (h, o) => { const res = await inner(h, o); if (h === hashN(101)) offset = t0 + 15_000 - 500 - realNow(); return res },
    })
    const buyHash = hashN(100)
    assert.equal(server.traceUrls().filter((u) => u.includes(buyHash)).length, 0, 'no provider request for the buy')
    const rows = lines.filter(([t, b]) => t === '[robinhood-trace-scheduler-audit]' && b.txHash).map(([, b]) => b)
    const buy = rows.find((b) => b.txHash === buyHash)!
    assert.deepEqual([buy.outcome, buy.timeouts, buy.pageRetryCount, buy.http429], ['not_attempted_deadline', 0, 0, 0])
    assert.ok(buy.remainingScanMsAtStart < 600)
    const summary = lines.find(([t, b]) => t === '[robinhood-trace-scheduler-audit]' && b.summary)![1].summary
    assert.equal(summary.skippedInsufficientDeadline, 1)
    assert.equal(summary.outcomes.transport_failed, 0)
    assert.equal(readRobinhoodNativeTraceMemory(buyHash), null)
    assert.equal(r.ingestionAudit.normalizedBuyCount, 0, 'an untraced relayed buy never promotes')
  } finally { Date.now = realNow }
})

test('T2. every first attempt is bounded by the scan deadline: a hung low-priority page ends before it', async () => {
  const H = hashN(320)
  const s = blockscout(new Map([[H, { items: blockscoutItems(SELL_ROWS, 60), faults: { 1: ['hang'] } }]]))
  const started = Date.now()
  const r = await blockscoutNativeTraceSource(s.fn).transfersForTx(H, { deadlineAt: started + 3_000 })
  assert.ok(Date.now() - started < 3_000, `ended at ${Date.now() - started} ms`)
  assert.equal(r.transfers, null)
  const a = r.audit!.pageTransportAttempts[0]
  assert.ok(a.timeoutBudgetMs! <= 2_500 && a.scanRemainingMs! <= 3_000)
})

// ── Cross-scan partial progress at the PnL level (job cc6ad1dc) ──────────────────────────────────────────────────
test('P-D. relayed buy: scan 1 stores pages 1–2 (no promotion); scan 2 resumes and the payer on the resumed page rejects it', async () => {
  const rows: Row[] = [[WALLET, ROUTER, n(0.005)], [OTHER, ROUTER, n(0.005)], [ROUTER, PM, n(0.01)]]
  const tx = buyTx(6, TS - 100)
  tx.items = blockscoutItems(rows, 170, 3) // wallet debit on page 1 …
  const co = tx.items.find((it) => it.from.hash === OTHER)!
  tx.items = tx.items.filter((it) => it !== co)
  tx.items.splice(160, 0, co) // … the co-payer on page 4 (never fetched in scan 1)
  tx.items = tx.items.map((it, i) => ({ ...it, index: i + 1 }))
  tx.faults = { 3: ['timeout', 'timeout', 'timeout', 'timeout'] } // lookup + retry, in-scan continuation + retry
  const s1 = await scan([tx], { rejectsFilter: true })
  assert.equal(s1.r.swapsVerified, 0, 'I: partial progress never promotes')
  assert.equal(s1.r.ingestionAudit.relayedWalletRejectedReasons?.trace_unavailable, 1)
  const partialLine = s1.lines.find(([t, b]) => t === '[robinhood-partial-trace-audit]' && b.writeSucceeded)
  assert.ok(partialLine, 'progress stored')
  const s2 = await scan([tx], { rejectsFilter: true })
  const resumed = s2.lines.find(([t, b]) => t === '[robinhood-partial-trace-audit]' && b.hit)![1]
  assert.deepEqual([resumed.completedPagesBefore, resumed.pagesRefetched], [2, 0])
  assert.equal(s2.r.swapsVerified, 0)
  assert.deepEqual(s2.r.ingestionAudit.relayedWalletRejectedReasons, { externally_funded_route: 1 })
})

test('P-O. a p1 sell with partial progress is traced before a brand-new p1 sell (p0_partial_resume_sell)', async () => {
  const fresh = sellTx(6, TS - 500).trace(SELL_ROWS, 120)   // older: would normally go first
  const resumable = sellTx(7, TS - 100).trace(SELL_ROWS, 120)
  resumable.faults = { 2: ['timeout', 'timeout', 'timeout', 'timeout'] } // lookup + retry, in-scan continuation + retry
  await scan([fresh, resumable], { concurrency: 1 }) // scan 1: resumable stores page 1
  const { r, lines, idx } = await scan([fresh, resumable], { concurrency: 1 })
  const rows = lines.filter(([t, b]) => t === '[robinhood-trace-scheduler-audit]' && b.txHash).map(([, b]) => b)
  if (rows.length === 1) {
    // The fresh sell was proven in scan 1 already (stored proof, no live slot): only the resumable one runs live.
    assert.equal(rows[0].priorityClass, 'p0_partial_resume_sell')
  } else {
    assert.deepEqual(rows.map((b) => [idx(b.txHash), b.priorityClass]), [[1, 'p0_partial_resume_sell'], [0, 'p1_native_out_sell']])
  }
  assert.equal(r.swapsVerified, 2)
})
