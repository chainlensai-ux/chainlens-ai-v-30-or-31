// Robinhood native trace lane: target-tx internal-transaction lookups run on their own small Blockscout budget
// (not the per-tx `/logs` evidence lane) and every lookup reports exactly why it did or did not produce proof.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import { getBlockscoutTransactionLogs, blockscoutLaneRemaining, NATIVE_TRACE_MAX_LOOKUPS, __resetRobinhoodBlockscoutRateLimitForTest } from '../lib/server/robinhoodBlockscoutEvidence.ts'
import { blockscoutNativeTransfersForTx } from '../lib/server/robinhoodNativeTrace.ts'
import { computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest, RH_NATIVE, RH_WETH, RH_V4_POSITION_MANAGER, V4_SWAP_TOPIC0, ERC20_TRANSFER_TOPIC0, type RhRpc } from '../lib/server/robinhoodPnlV1.ts'
import { WETH_WITHDRAWAL_TOPIC0 } from '../lib/server/robinhoodMixedRouteForensics.ts'

process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
process.env.BLOCKSCOUT_API_KEY = 'proapi_SECRET_trace_key'
delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

const WALLET = '0x343f5a0bd465f8ffec69cf2e90152c80397470b9'
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const ROUTER = '0x248a454a0000000000000000000000000000beef'
const TOKEN_A = '0xaaaa000000000000000000000000000000000001'
const TOKEN_B = '0xbbbb000000000000000000000000000000000002'
const V3_POOL = '0x3000000000000000000000000000000000000003'
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const E18 = BigInt(10) ** BigInt(18)
let seq = 0
const nextHash = () => `0x${(0xc0ffee00 + ++seq).toString(16).padStart(64, '0')}`

type Reply = 'ok' | 'empty' | 'paged' | 'nosuccess' | 'cf403' | 429 | 'timeout'
function blockscout(reply: { community: Reply; gateway?: Reply }, payout = E18) {
  const urls: string[] = []
  const fn = async (url: string): Promise<Response> => {
    urls.push(url)
    const r = url.startsWith('https://api.blockscout.com/') ? (reply.gateway ?? 'ok') : reply.community
    const json = (body: unknown, status = 200, headers: Record<string, string> = { 'content-type': 'application/json' }) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
    if (r === 'timeout') { const e = new Error('t'); e.name = 'TimeoutError'; throw e }
    if (r === 429) return json({ message: 'Too Many Requests' }, 429)
    if (r === 'cf403') return json('<html>Just a moment... Cloudflare Ray ID</html>', 403, { 'content-type': 'text/html', server: 'cloudflare' })
    if (url.includes('/logs')) return json({ items: [] })
    if (r === 'empty') return json({ items: [], next_page_params: null })
    if (r === 'paged') return json({ items: [], next_page_params: { index: 50 } })
    const item: Record<string, unknown> = { from: { hash: ROUTER }, to: { hash: WALLET }, value: payout.toString(), type: 'call' }
    if (r !== 'nosuccess') item.success = true
    return json({ items: [item], next_page_params: null })
  }
  return { fn, urls, traceCalls: () => urls.filter((u) => u.includes('/internal-transactions')).length }
}

beforeEach(() => { __resetRobinhoodBlockscoutRateLimitForTest(); __resetRobinhoodPnlV1CachesForTest() })

test('1. evidence lane exhausted by per-tx /logs lookups -> the native_trace lane still executes', async () => {
  const b = blockscout({ community: 'ok' })
  for (let i = 0; i < 8; i++) await getBlockscoutTransactionLogs(nextHash(), b.fn)
  assert.equal(blockscoutLaneRemaining('evidence'), 0)
  const r = await blockscoutNativeTransfersForTx(b.fn)(nextHash())
  assert.equal(r.audit?.result, 'proven')
  assert.equal(r.audit?.attempted, true)
  assert.equal(r.audit?.budgetLane, 'native_trace')
  assert.equal(r.transfers?.[0].value, E18)
})

test('2. the native_trace budget is bounded independently (and never touches the evidence lane)', async () => {
  const b = blockscout({ community: 'ok' })
  const results = []
  for (let i = 0; i < NATIVE_TRACE_MAX_LOOKUPS + 2; i++) results.push(await blockscoutNativeTransfersForTx(b.fn)(nextHash()))
  assert.deepEqual(results.map((r) => r.audit?.result), ['proven', 'proven', 'proven', 'budget_exhausted', 'budget_exhausted'])
  assert.equal(results[3].audit?.attempted, false)
  assert.equal(b.traceCalls(), NATIVE_TRACE_MAX_LOOKUPS)
  assert.equal(blockscoutLaneRemaining('evidence'), 4, 'evidence budget untouched')
})

test('3. community 403 -> PRO gateway 200 within ONE lookup (key only as a Bearer header, never in a URL)', async () => {
  const b = blockscout({ community: 'cf403', gateway: 'ok' })
  const r = await blockscoutNativeTransfersForTx(b.fn)(nextHash())
  assert.equal(r.audit?.result, 'proven')
  assert.deepEqual(r.audit?.transportAttempts.map((t) => [t.requestHost, t.authMode, t.httpStatus, t.failureClass]), [
    ['robinhoodchain.blockscout.com', 'none', 403, 'cloudflare_forbidden'],
    ['api.blockscout.com', 'gateway', 200, null],
  ])
  assert.equal(blockscoutLaneRemaining('native_trace'), NATIVE_TRACE_MAX_LOOKUPS - 1, 'the gateway alternate does not cost a second lookup')
  assert.ok(b.urls.every((u) => !u.includes('SECRET')))
  assert.ok(!JSON.stringify(r.audit).includes('SECRET'))
})

test('4. missing success field -> unknown_execution_status, no transfers', async () => {
  const r = await blockscoutNativeTransfersForTx(blockscout({ community: 'nosuccess' }).fn)(nextHash())
  assert.deepEqual([r.transfers, r.audit?.result, r.audit?.missingSuccessStatus], [null, 'unknown_execution_status', true])
})

test('5. a trace whose cursor never advances (same next_page_params every page) -> unavailable', async () => {
  const r = await blockscoutNativeTransfersForTx(blockscout({ community: 'paged' }).fn)(nextHash())
  assert.deepEqual([r.transfers, r.audit?.result, r.audit?.paginationComplete, r.audit?.pagesRequested], [null, 'malformed', false, 2])
})

test('6. empty successful trace -> empty (a complete trace with no native transfers)', async () => {
  const r = await blockscoutNativeTransfersForTx(blockscout({ community: 'empty' }).fn)(nextHash())
  assert.deepEqual([r.transfers, r.audit?.result, r.audit?.itemCount], [[], 'empty', 0])
})

test('7. timeout and Blockscout 429 are transport failures, never budget_exhausted', async () => {
  const t = await blockscoutNativeTransfersForTx(blockscout({ community: 'timeout' }).fn)(nextHash())
  assert.deepEqual([t.audit?.result, t.audit?.failureClass, t.audit?.attempted], ['transport_failed', 'timeout', true])
  const rl = await blockscoutNativeTransfersForTx(blockscout({ community: 429 }).fn)(nextHash())
  assert.deepEqual([rl.audit?.result, rl.audit?.failureClass, rl.audit?.httpStatus], ['transport_failed', 'rate_limited', 429])
})

// ── 8/9: through PnL V1 with production-shaped mixed receipts ──────────────────────────────────
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
async function runMixed(count: number, reply: { community: Reply; gateway?: Reply }) {
  const hashes = Array.from({ length: count }, () => nextHash())
  const rcpts = new Map(hashes.map((h, i) => [h, mixedReceipt(1000 + i * 10)]))
  const rpc: RhRpc = async (calls) => calls.map(({ method, params }) => {
    const p = params as any[]
    if (method === 'eth_getTransactionReceipt') return rcpts.get(p[0]) ?? null
    if (method === 'eth_call' && p[0].to === RH_V4_POSITION_MANAGER) return key.encoded
    if (method === 'eth_getBalance') return '0x8ac7230489e80000'
    if (method === 'eth_getTransactionCount') return Number(p[1]) % 10 === 0 ? '0x2' : '0x1'
    if (method === 'eth_getTransactionByHash') return { value: '0x0' }
    return null
  })
  const b = blockscout(reply)
  const lines: Array<[string, any]> = []
  const w = console.warn
  console.warn = (tag: unknown, body: unknown) => { lines.push([String(tag), body]) }
  try {
    const r = await computeRobinhoodPnlV1({
      wallet: WALLET, candidates: hashes.map((h) => ({ txHash: h, timestampMs: null, hasSwapLog: true })), transactionCount: count, transferCount: count, activityUnavailableReason: null,
      deps: { rpc, ethUsdRange: async () => null, tokenHistoricalUsd: async () => null, now: Date.now, nativeTransfersForTx: blockscoutNativeTransfersForTx(b.fn) },
    })
    return { r, b, audits: lines.filter(([t]) => t === '[robinhood-native-trace-audit]').map(([, x]) => x) }
  } finally { console.warn = w }
}

test('8. exactly 3 mixed txs trigger at most 3 trace lookups (<= 2 HTTP each via the 403 -> gateway path); a 4th is budget_exhausted', async () => {
  const three = await runMixed(3, { community: 'cf403', gateway: 'ok' })
  assert.equal(three.audits.length, 3, 'one [robinhood-native-trace-audit] line per mixed tx')
  assert.ok(three.audits.every((a) => a.result === 'proven' && a.nativeToWalletRaw === E18.toString()))
  assert.ok(three.b.traceCalls() <= 6)
  assert.equal(three.r.metrics.nativeTraceLookups, 3)
  __resetRobinhoodBlockscoutRateLimitForTest()
  const four = await runMixed(4, { community: 'ok' })
  assert.equal(four.b.traceCalls(), 3)
  assert.deepEqual(four.audits.map((a) => a.result).sort(), ['budget_exhausted', 'proven', 'proven', 'proven'])
})

test('9. unproven mixed routes stay rejected even when the trace proves a payout', async () => {
  const { r, audits } = await runMixed(3, { community: 'ok' })
  assert.ok(audits.every((a) => a.result === 'proven'))
  assert.equal(r.swapsVerified, 0)
  assert.deepEqual(r.ingestionAudit.rejectionReasons, { other_venue_swap_in_tx: 3 })
})
