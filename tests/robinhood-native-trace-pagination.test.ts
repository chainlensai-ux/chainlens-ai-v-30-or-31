// Robinhood native trace pagination: one target tx = one native_trace slot; pages follow Blockscout's own
// next_page_params exactly, bounded per lookup; the trace is proof only when complete (next_page_params null).
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import { blockscoutLaneRemaining, NATIVE_TRACE_MAX_LOOKUPS, NATIVE_TRACE_PAGINATION, __resetRobinhoodBlockscoutRateLimitForTest } from '../lib/server/robinhoodBlockscoutEvidence.ts'
import { blockscoutNativeTransfersForTx } from '../lib/server/robinhoodNativeTrace.ts'
import { computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest, RH_NATIVE, RH_WETH, RH_V4_POSITION_MANAGER, V4_SWAP_TOPIC0, ERC20_TRANSFER_TOPIC0, type RhRpc } from '../lib/server/robinhoodPnlV1.ts'
import { WETH_WITHDRAWAL_TOPIC0 } from '../lib/server/robinhoodMixedRouteForensics.ts'

process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
process.env.BLOCKSCOUT_API_KEY = 'proapi_SECRET_page_key'
delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

const WALLET = '0x343f5a0bd465f8ffec69cf2e90152c80397470b9'
const ROUTER = '0x248a454a0000000000000000000000000000beef'
const OTHER = '0x9999999999999999999999999999999999999999'
const E18 = BigInt(10) ** BigInt(18)
let seq = 0
const nextHash = () => `0x${(0xbabe0000 + ++seq).toString(16).padStart(64, '0')}`

type Item = Record<string, unknown>
const filler = (page: number, i: number): Item => ({ index: page * 1000 + i, from: { hash: ROUTER }, to: { hash: OTHER }, value: '1', success: true, type: 'call' })
const payout = (index: number, value = E18, extra: Item = {}): Item => ({ index, from: { hash: ROUTER }, to: { hash: WALLET }, value: value.toString(), success: true, type: 'call', ...extra })
/** Blockscout-shaped cursor for page n (1-based) → page n+1: exactly what the gateway returns, passed through untouched. */
const cursor = (n: number) => ({ block_number: 4_200_000, index: n * 50, items_count: 50, transaction_index: 3 })

type PageSpec = { items: Item[]; fail?: 'timeout' | 500 | 'cf403' }
function server(pages: PageSpec[], opts: { communityForbidden?: boolean; endless?: boolean } = {}) {
  const urls: string[] = []
  const fn = async (url: string): Promise<Response> => {
    urls.push(url)
    const json = (body: unknown, status = 200, headers: Record<string, string> = { 'content-type': 'application/json' }) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
    const gateway = url.startsWith('https://api.blockscout.com/')
    if (opts.communityForbidden && !gateway) return json('<html>Just a moment... Cloudflare Ray ID</html>', 403, { 'content-type': 'text/html', server: 'cloudflare' })
    const q = new URL(url).searchParams
    const page = q.has('index') ? Number(q.get('index')) / 50 + 1 : 1
    const spec = pages[page - 1] ?? (opts.endless ? { items: [filler(page, 0)] } : undefined)
    if (!spec) return json({ message: 'not found' }, 404)
    if (spec.fail === 'timeout') { const e = new Error('t'); e.name = 'TimeoutError'; throw e }
    if (spec.fail === 500) return json({ message: 'boom' }, 500)
    const last = !opts.endless && page === pages.length
    return json({ items: spec.items, next_page_params: last ? null : cursor(page) })
  }
  return { fn, urls, traceUrls: () => urls.filter((u) => u.includes('/internal-transactions')) }
}
const lookup = (s: ReturnType<typeof server>) => blockscoutNativeTransfersForTx(s.fn)(nextHash())
const toWallet = (t: Array<{ to: string; value: bigint; success: boolean }> | null) => (t ?? []).filter((x) => x.success && x.to === WALLET).reduce((a, x) => a + x.value, BigInt(0))

beforeEach(() => { __resetRobinhoodBlockscoutRateLimitForTest(); __resetRobinhoodPnlV1CachesForTest() })

test('1. a 2-page trace completes and proves the payout (cursor passed through exactly as returned)', async () => {
  const s = server([{ items: [filler(1, 0), filler(1, 1)] }, { items: [payout(7)] }])
  const r = await lookup(s)
  assert.equal(r.audit?.result, 'proven')
  assert.deepEqual([r.audit?.pagesRequested, r.audit?.pagesSucceeded, r.audit?.totalItemCount, r.audit?.paginationComplete], [2, 2, 3, true])
  assert.equal(toWallet(r.transfers), E18)
  // Blockscout's cursor untouched, plus the zero-value filter every page carries.
  assert.equal(new URL(s.traceUrls()[0]).search, '?include_zero_value=false')
  assert.equal(new URL(s.traceUrls()[1]).search, '?block_number=4200000&index=50&items_count=50&transaction_index=3&include_zero_value=false')
})

test('2. a 4-page trace completes', async () => {
  const s = server([{ items: [filler(1, 0)] }, { items: [filler(2, 0)] }, { items: [filler(3, 0)] }, { items: [payout(9)] }])
  const r = await lookup(s)
  assert.deepEqual([r.audit?.result, r.audit?.pagesRequested, r.audit?.paginationCapHit], ['proven', 4, false])
  assert.equal(toWallet(r.transfers), E18)
})

test('3. page 1 community 403 -> gateway 200; page 2 also succeeds (on the gateway)', async () => {
  const s = server([{ items: [filler(1, 0)] }, { items: [payout(5)] }], { communityForbidden: true })
  const r = await lookup(s)
  assert.equal(r.audit?.result, 'proven')
  assert.deepEqual(r.audit?.pageTransportAttempts.map((a) => [a.page, a.requestHost, a.authMode, a.httpStatus, a.failureClass]), [
    [1, 'robinhoodchain.blockscout.com', 'none', 403, 'cloudflare_forbidden'],
    [1, 'api.blockscout.com', 'gateway', 200, null],
    [2, 'api.blockscout.com', 'gateway', 200, null],
  ])
  assert.ok(s.urls.every((u) => !u.includes('SECRET')))
})

test('4. pagination does not consume extra native_trace slots', async () => {
  await lookup(server([{ items: [filler(1, 0)] }, { items: [filler(2, 0)] }, { items: [filler(3, 0)] }, { items: [payout(1)] }], { communityForbidden: true }))
  assert.equal(blockscoutLaneRemaining('native_trace'), NATIVE_TRACE_MAX_LOOKUPS - 1)
})

test('5. a duplicate internal tx across pages counts once', async () => {
  const dup = payout(42)
  const r = await lookup(server([{ items: [filler(1, 0), dup] }, { items: [dup, filler(2, 0)] }]))
  assert.equal(r.audit?.result, 'proven')
  assert.equal(r.transfers?.length, 3)
  assert.equal(toWallet(r.transfers), E18)
})

test('6. page 2 timeout -> the whole trace is unavailable (no partial prefix)', async () => {
  const r = await lookup(server([{ items: [payout(1)] }, { items: [], fail: 'timeout' }]))
  assert.deepEqual([r.transfers, r.audit?.result, r.audit?.failureClass, r.audit?.pagesSucceeded], [null, 'transport_failed', 'timeout', 1])
  const http = await lookup(server([{ items: [payout(1)] }, { items: [], fail: 500 }]))
  assert.deepEqual([http.transfers, http.audit?.result, http.audit?.httpStatus], [null, 'transport_failed', 500])
})

test('7. page 2 entry with missing success -> the whole trace is unavailable', async () => {
  const noStatus = payout(3)
  delete noStatus.success
  const r = await lookup(server([{ items: [payout(1)] }, { items: [noStatus] }]))
  assert.deepEqual([r.transfers, r.audit?.result, r.audit?.missingSuccessStatus], [null, 'unknown_execution_status', true])
})

test('8. pagination caps hit -> pagination_cap_exhausted, no proof', async () => {
  const pages = await lookup(server([], { endless: true }))
  assert.deepEqual([pages.transfers, pages.audit?.result, pages.audit?.paginationCapHit, pages.audit?.pagesRequested], [null, 'pagination_cap_exhausted', true, NATIVE_TRACE_PAGINATION.maxPages])
  const many = (p: number) => Array.from({ length: 100 }, (_, i) => filler(p, i))
  const items = await lookup(server([{ items: many(1) }, { items: many(2) }, { items: [payout(1)] }]))
  assert.deepEqual([items.transfers, items.audit?.result, items.audit?.pagesRequested], [null, 'pagination_cap_exhausted', 2])
})

// ── 9/10 through PnL V1 with production-shaped mixed receipts and multi-page traces ─────────────────
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const TOKEN_A = '0xaaaa000000000000000000000000000000000001'
const TOKEN_B = '0xbbbb000000000000000000000000000000000002'
const V3_POOL = '0x3000000000000000000000000000000000000003'
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const key = (() => {
  const [c0, c1] = [TOKEN_A, TOKEN_B].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1))
  const types = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const
  const args = [c0 as Hex, c1 as Hex, 3000, 60, RH_NATIVE as Hex] as const
  return { id: keccak256(encodeAbiParameters(types, args)).toLowerCase(), c0, c1, encoded: encodeAbiParameters(types, args) }
})()
const pad = (h: string) => h.replace(/^0x/, '').padStart(64, '0')
const tp = (a: string) => `0x${pad(a)}`
const int256 = (v: bigint) => pad((v < BigInt(0) ? (BigInt(1) << BigInt(256)) + v : v).toString(16))
function mixedReceipt(block: number) {
  const d: Record<string, bigint> = { [TOKEN_A]: -E18, [TOKEN_B]: E18 }
  return {
    status: '0x1', from: WALLET, to: ROUTER, blockNumber: `0x${block.toString(16)}`, gasUsed: '0x1', effectiveGasPrice: '0x1',
    logs: [
      { address: TOKEN_A, topics: [ERC20_TRANSFER_TOPIC0, tp(WALLET), tp(PM)], data: `0x${pad(E18.toString(16))}`, logIndex: '0x0', blockTimestamp: '0x68e7c000' },
      { address: PM, topics: [V4_SWAP_TOPIC0, key.id, tp(ROUTER)], data: `0x${int256(d[key.c0])}${int256(d[key.c1])}${'0'.repeat(256)}`, logIndex: '0x1', blockTimestamp: '0x68e7c000' },
      { address: TOKEN_B, topics: [ERC20_TRANSFER_TOPIC0, tp(PM), tp(V3_POOL)], data: `0x${pad(E18.toString(16))}`, logIndex: '0x2', blockTimestamp: '0x68e7c000' },
      // B -> V3 -> WETH (2 ETH) -> unwrapped by the router: the wallet's native proceeds need the target-tx trace
      // (so these receipts are trace-eligible); the trace pays the wallet only 1 ETH, so the route still fails.
      { address: V3_POOL, topics: [V3_SWAP, tp(ROUTER), tp(ROUTER)], data: `0x${int256(E18)}${int256(-E18 * BigInt(2))}${'0'.repeat(192)}`, logIndex: '0x3', blockTimestamp: '0x68e7c000' },
      { address: RH_WETH, topics: [ERC20_TRANSFER_TOPIC0, tp(V3_POOL), tp(ROUTER)], data: `0x${pad((E18 * BigInt(2)).toString(16))}`, logIndex: '0x4', blockTimestamp: '0x68e7c000' },
      { address: RH_WETH, topics: [WETH_WITHDRAWAL_TOPIC0, tp(ROUTER)], data: `0x${pad((E18 * BigInt(2)).toString(16))}`, logIndex: '0x5', blockTimestamp: '0x68e7c000' },
    ],
  }
}

test('9/10. lane-cap + 1 production-shaped mixed txs with multi-page traces: lane-cap logical slots, all proven, routes still rejected', async () => {
  const hashes = Array.from({ length: NATIVE_TRACE_MAX_LOOKUPS + 1 }, () => nextHash())
  const rcpts = new Map(hashes.map((h, i) => [h, mixedReceipt(2000 + i * 10)]))
  const rpc: RhRpc = async (calls) => calls.map(({ method, params }) => {
    const p = params as any[]
    if (method === 'eth_getTransactionReceipt') return rcpts.get(p[0]) ?? null
    if (method === 'eth_call' && p[0].to === RH_V4_POSITION_MANAGER) return key.encoded
    if (method === 'eth_getBalance') return '0x8ac7230489e80000'
    if (method === 'eth_getTransactionCount') return Number(p[1]) % 10 === 0 ? '0x2' : '0x1'
    if (method === 'eth_getTransactionByHash') return { value: '0x0' }
    return null
  })
  const s = server([{ items: [filler(1, 0)] }, { items: [filler(2, 0)] }, { items: [payout(1)] }], { communityForbidden: true })
  const lines: Array<[string, any]> = []
  const w = console.warn
  console.warn = (tag: unknown, body: unknown) => { lines.push([String(tag), body]) }
  let r
  try {
    r = await computeRobinhoodPnlV1({
      wallet: WALLET, candidates: hashes.map((h) => ({ txHash: h, timestampMs: null, hasSwapLog: true })), transactionCount: hashes.length, transferCount: hashes.length, activityUnavailableReason: null,
      deps: { rpc, ethUsdRange: async () => null, tokenHistoricalUsd: async () => null, now: Date.now, nativeTransfersForTx: blockscoutNativeTransfersForTx(s.fn) },
    })
  } finally { console.warn = w }
  const audits = lines.filter(([t]) => t === '[robinhood-native-trace-audit]').map(([, x]) => x)
  assert.equal(audits.length, hashes.length)
  const proven = audits.filter((a) => a.result === 'proven')
  assert.equal(proven.length, NATIVE_TRACE_MAX_LOOKUPS, 'only lane-cap logical trace slots, however many pages each needed')
  assert.ok(proven.every((a) => a.pagesRequested === 3 && a.paginationComplete && a.nativeToWalletRaw === E18.toString()))
  assert.deepEqual(audits.filter((a) => a.result !== 'proven').map((a) => [a.result, a.attempted]), [['budget_exhausted', false]])
  // 10. these fixture routes are not proven (the wallet receives nothing the route produces), so they stay rejected
  assert.equal(r.swapsVerified, 0)
  assert.deepEqual(r.ingestionAudit.rejectionReasons, { other_venue_swap_in_tx: hashes.length })
})
