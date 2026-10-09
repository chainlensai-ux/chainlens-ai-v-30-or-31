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
} from '../lib/server/robinhoodBlockscoutEvidence.ts'
import { blockscoutNativeTraceSource } from '../lib/server/robinhoodNativeTrace.ts'
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
type ServerTx = { items: Item[]; pending?: boolean }
function blockscout(txs: Map<string, ServerTx>, opts: { honorsFilter?: boolean; rejectsFilter?: boolean; latencyMs?: number } = {}) {
  const urls: string[] = []
  const fn = async (url: string): Promise<Response> => {
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

async function scan(txs: Tx[], opts: { honorsFilter?: boolean; latencyMs?: number; extension?: boolean } = {}) {
  __resetRobinhoodPnlV1CachesForTest()
  const byHash = new Map(txs.map((tx, i) => [hashN(100 + i), { tx, i, block: 1000 + i * 10 }]))
  const server = blockscout(new Map([...byHash].map(([h, e]) => [h, { items: e.tx.items }])), { honorsFilter: opts.honorsFilter, latencyMs: opts.latencyMs })
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
        nativeTransfersForTx: source.transfersForTx,
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
