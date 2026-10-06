// Robinhood native-trace positive-proof persistence: a complete, verified target-tx trace (proven / empty) is
// immutable evidence and is reused across instances (memory → persistent KV → live Blockscout). Nothing that
// failed the native-trace rules is ever stored, and a persistent hit makes zero Blockscout trace calls.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import { computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest, RH_NATIVE, RH_WETH, RH_V4_POSITION_MANAGER, V4_SWAP_TOPIC0, ERC20_TRANSFER_TOPIC0, type RhRpc, type RhEthUsdPoint } from '../lib/server/robinhoodPnlV1.ts'
import { V2_SWAP_TOPIC0, V3_SWAP_TOPIC0, WETH_WITHDRAWAL_TOPIC0, type RhNativeTransfer } from '../lib/server/robinhoodMixedRouteForensics.ts'
import { blockscoutNativeTransfersForTx } from '../lib/server/robinhoodNativeTrace.ts'
import { __resetRobinhoodBlockscoutRateLimitForTest } from '../lib/server/robinhoodBlockscoutEvidence.ts'
import { __resetMemoryFallbackForTest } from '../lib/server/cache/tokenCache.ts'
import {
  __setRobinhoodNativeTraceKvForTest, __resetRobinhoodNativeTraceMemoryForTest, robinhoodNativeTracePersistenceKey,
  validateRobinhoodNativeTraceRecord, ROBINHOOD_NATIVE_TRACE_SCHEMA_VERSION,
} from '../lib/server/robinhoodNativeTracePersistence.ts'

process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
process.env.BLOCKSCOUT_API_KEY = 'proapi_SECRET_trace_key'
const TS = 1790155166
delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

const WALLET = '0x343f5a0bd465f8ffec69cf2e90152c80397470b9'
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const ROUTER = '0x248a454a0000000000000000000000000000beef'
const OTHER = '0x2222222222222222222222222222222222222222'
const A = '0xaaaa000000000000000000000000000000000001'
const B = '0xbbbb000000000000000000000000000000000002'
const C = '0xcccc000000000000000000000000000000000003'
const D = '0xdddd000000000000000000000000000000000004'
const P3 = '0x3000000000000000000000000000000000000003'
const P3b = '0x3000000000000000000000000000000000000004'
const P9 = '0x9000000000000000000000000000000000000009'
const E18 = BigInt(10) ** BigInt(18)
const n = (x: number) => BigInt(Math.round(x * 1000)) * E18 / BigInt(1000)
const pad = (h: string) => h.replace(/^0x/, '').padStart(64, '0')
const t = (a: string) => `0x${pad(a)}`
const int256 = (v: bigint) => pad((v < BigInt(0) ? (BigInt(1) << BigInt(256)) + v : v).toString(16))
const uint = (v: bigint) => pad(v.toString(16))
const hex = (v: number | bigint) => `0x${BigInt(v).toString(16)}`

const POOLS = new Map<string, string>() // poolId -> encoded PoolKey
function poolId(x: string, y: string) {
  const [c0, c1] = [x, y].sort((p, q) => (BigInt(p) < BigInt(q) ? -1 : 1))
  const types = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const
  const args = [c0 as Hex, c1 as Hex, 3000, 60, RH_NATIVE as Hex] as const
  const id = keccak256(encodeAbiParameters(types, args)).toLowerCase()
  POOLS.set(id, encodeAbiParameters(types, args))
  return { id, c0, c1 }
}

class Tx {
  logs: unknown[] = []
  txValue = BigInt(0)
  trace: RhNativeTransfer[] | null = []
  ts = TS
  private i = 0
  private push(address: string, topics: string[], data: string) { this.logs.push({ address, topics, data, logIndex: hex(this.i++), blockTimestamp: hex(this.ts) }); return this }
  xfer(token: string, from: string, to: string, amt: bigint) { return this.push(token, [ERC20_TRANSFER_TOPIC0, t(from), t(to)], `0x${uint(amt)}`) }
  v4(inTok: string, outTok: string, inAmt: bigint, outAmt: bigint) {
    const p = poolId(inTok, outTok)
    const d: Record<string, bigint> = { [inTok]: -inAmt, [outTok]: outAmt }
    return this.push(PM, [V4_SWAP_TOPIC0, p.id, t(ROUTER)], `0x${int256(d[p.c0])}${int256(d[p.c1])}${'0'.repeat(256)}`)
  }
  v3(pool: string, inAmt: bigint, outAmt: bigint) { return this.push(pool, [V3_SWAP_TOPIC0, t(ROUTER), t(ROUTER)], `0x${int256(inAmt)}${int256(-outAmt)}${'0'.repeat(192)}`) }
  v2(pool: string, inAmt: bigint, outAmt: bigint) { return this.push(pool, [V2_SWAP_TOPIC0, t(ROUTER), t(ROUTER)], `0x${uint(inAmt)}${uint(BigInt(0))}${uint(BigInt(0))}${uint(outAmt)}`) }
  unwrap(holder: string, amt: bigint) { return this.push(RH_WETH, [WETH_WITHDRAWAL_TOPIC0, t(holder)], `0x${uint(amt)}`) }
  paysWallet(amt: bigint) { this.trace = [{ from: ROUTER, to: WALLET, value: amt, success: true }]; return this }
}

// A → V4 → B → V3 → C → V3 → WETH → unwrap → native ETH to the wallet (the production 53353d… shape).
function shape53353(ethOut = n(0.032)) {
  return new Tx()
    .xfer(A, WALLET, PM, n(1000)).v4(A, B, n(1000), n(80)).xfer(B, PM, ROUTER, n(80))
    .xfer(B, ROUTER, P3, n(80)).v3(P3, n(80), n(25)).xfer(C, P3, P3b, n(25))
    .v3(P3b, n(25), ethOut).xfer(RH_WETH, P3b, ROUTER, ethOut).unwrap(ROUTER, ethOut)
    .paysWallet(ethOut)
}
// native ETH → V4 → A (direct V4 buy)
function directBuy(eth: bigint, tokens: bigint) {
  const tx = new Tx().v4(RH_NATIVE, A, eth, tokens).xfer(A, PM, WALLET, tokens)
  tx.txValue = eth
  return tx
}


// ── Fake persistent KV (SET NX semantics) and Blockscout ─────────────────────────────────────────────
class FakeKv {
  store = new Map<string, unknown>()
  gets = 0
  sets = 0
  failSet = false
  async get<T>(k: string): Promise<T | null> { this.gets++; return (this.store.has(k) ? structuredClone(this.store.get(k)) : null) as T | null }
  async set(k: string, v: unknown, opts?: { nx?: boolean }): Promise<'OK' | null> {
    this.sets++
    if (this.failSet) throw new Error('kv down')
    if (opts?.nx && this.store.has(k)) return null
    this.store.set(k, structuredClone(v)); return 'OK'
  }
}
type Reply = 'ok' | 'empty' | 'paged' | 'nosuccess' | 'malformed' | 'timeout' | 429
function blockscout(reply: Reply, items: Array<Record<string, unknown>> = [{ from: { hash: ROUTER }, to: { hash: WALLET }, value: '2000', success: true, type: 'call' }]) {
  const urls: string[] = []
  const fn = async (url: string): Promise<Response> => {
    urls.push(url)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (reply === 'timeout') { const e = new Error('t'); e.name = 'TimeoutError'; throw e }
    if (reply === 429) return json({ message: 'Too Many Requests' }, 429)
    if (reply === 'empty') return json({ items: [], next_page_params: null })
    if (reply === 'paged') return json({ items: [], next_page_params: { index: urls.length } })
    if (reply === 'malformed') return json({ items: [{ ...items[0], value: 'not-a-number' }], next_page_params: null })
    if (reply === 'nosuccess') return json({ items: items.map(({ success: _s, ...rest }) => rest), next_page_params: null })
    return json({ items, next_page_params: null })
  }
  return { fn, traceCalls: () => urls.filter((u) => u.includes('/internal-transactions')).length }
}
let kv: FakeKv
const newInstance = () => { __resetRobinhoodNativeTraceMemoryForTest(); __resetMemoryFallbackForTest(); __resetRobinhoodBlockscoutRateLimitForTest() }
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
async function trace(txHash: string, b: ReturnType<typeof blockscout>) {
  const lines: any[] = []
  const w = console.warn
  console.warn = (tag: unknown, body: unknown) => { if (tag === '[robinhood-native-trace-persistence-audit]') lines.push(body) }
  try { return { r: await blockscoutNativeTransfersForTx(b.fn)(txHash), audit: lines[0] } } finally { console.warn = w }
}

beforeEach(() => {
  kv = new FakeKv()
  __setRobinhoodNativeTraceKvForTest(kv as never)
  newInstance()
  __resetRobinhoodPnlV1CachesForTest()
})

test('critical: a persisted proven trace survives a new instance while Blockscout times out — zero live calls', async () => {
  const tx = h(0x53353)
  const first = await trace(tx, blockscout('ok'))
  assert.equal(first.r.audit?.result, 'proven')
  assert.deepEqual([first.audit.liveAttempted, first.audit.persisted, first.audit.persistentHit, first.audit.memoryHit], [true, true, false, false])
  assert.deepEqual(kv.store.get(robinhoodNativeTracePersistenceKey(tx)), {
    schemaVersion: 1, chain: 'robinhood', txHash: tx, transfers: [{ from: ROUTER, to: WALLET, value: '2000', success: true }], result: 'proven', paginationComplete: true,
  })
  newInstance()
  const down = blockscout('timeout')
  const second = await trace(tx, down)
  assert.equal(down.traceCalls(), 0, 'no live Blockscout native-trace request after a persistent hit')
  assert.deepEqual(second.r.transfers, [{ from: ROUTER, to: WALLET, value: BigInt(2000), success: true }])
  assert.deepEqual(second.r.transfers, first.r.transfers)
  assert.equal(second.r.audit?.result, 'proven')
  assert.equal(second.r.audit?.paginationComplete, true)
  assert.deepEqual([second.audit.persistentHit, second.audit.liveAttempted, second.audit.transferCount, second.audit.result], [true, false, 1, 'proven'])
  // same instance again: process memory, not even a KV read
  const gets = kv.gets
  const third = await trace(tx, down)
  assert.equal(third.audit.memoryHit, true)
  assert.equal(kv.gets, gets)
})

test('incomplete (pagination-capped) trace is never persisted', async () => {
  const r = await trace(h(1), blockscout('paged'))
  assert.equal(r.r.audit?.result, 'pagination_cap_exhausted')
  assert.equal(r.audit.persisted, false)
  assert.equal(kv.store.size, 0)
})

test('malformed trace is never persisted', async () => {
  const r = await trace(h(2), blockscout('malformed'))
  assert.equal(r.r.audit?.result, 'malformed')
  assert.equal(kv.store.size, 0)
})

test('missing `success` is never persisted', async () => {
  const r = await trace(h(3), blockscout('nosuccess'))
  assert.equal(r.r.audit?.result, 'unknown_execution_status')
  assert.equal(kv.store.size, 0)
})

test('timeout and rate-limit results are never persisted, and are retried live next time', async () => {
  for (const reply of ['timeout', 429] as const) {
    const tx = h(reply === 'timeout' ? 4 : 5)
    const r = await trace(tx, blockscout(reply))
    assert.equal(r.r.transfers, null)
    assert.equal(kv.store.size, 0)
    newInstance()
    const again = blockscout('ok')
    const retry = await trace(tx, again)
    assert.equal(again.traceCalls(), 1)
    assert.equal(retry.r.audit?.result, 'proven')
    kv.store.clear()
  }
})

test('a complete empty trace is persisted as verified empty and reused', async () => {
  const tx = h(6)
  const first = await trace(tx, blockscout('empty'))
  assert.equal(first.r.audit?.result, 'empty')
  assert.equal(first.audit.persisted, true)
  newInstance()
  const down = blockscout('timeout')
  const second = await trace(tx, down)
  assert.equal(down.traceCalls(), 0)
  assert.deepEqual(second.r.transfers, [])
  assert.equal(second.r.audit?.result, 'empty')
})

test('tx-hash mismatch, malformed schema/version rows and other chains are ignored (live lookup instead)', async () => {
  const tx = h(7)
  const good = { schemaVersion: 1, chain: 'robinhood', txHash: tx, transfers: [{ from: ROUTER, to: WALLET, value: '9', success: true }], result: 'proven', paginationComplete: true }
  const bad: unknown[] = [
    { ...good, txHash: h(8) }, { ...good, schemaVersion: 2 }, { ...good, chain: 'base' }, { ...good, paginationComplete: false },
    { ...good, result: 'empty' }, { ...good, result: 'transport_failed' }, { ...good, transfers: [{ ...good.transfers[0], value: '-1' }] },
    { ...good, transfers: [{ ...good.transfers[0], value: 9 }] }, { ...good, transfers: [{ ...good.transfers[0], success: 'true' }] },
    { ...good, transfers: [{ ...good.transfers[0], to: 'nope' }] }, { ...good, transfers: 'x' }, 'string', null, [good],
  ]
  for (const row of bad) {
    assert.equal(validateRobinhoodNativeTraceRecord(row, tx), null, JSON.stringify(row))
    newInstance()
    kv.store.clear()
    if (row != null) kv.store.set(robinhoodNativeTracePersistenceKey(tx), row)
    const live = blockscout('ok')
    const r = await trace(tx, live)
    assert.equal(r.audit.persistentHit, false)
    assert.equal(live.traceCalls(), 1)
    assert.equal(r.r.transfers?.[0].value, BigInt(2000)) // live evidence, not the stored row
  }
  assert.ok(validateRobinhoodNativeTraceRecord(good, tx))
  assert.equal(validateRobinhoodNativeTraceRecord(good, h(8)), null) // no cross-tx reuse
  assert.equal(robinhoodNativeTracePersistenceKey(tx.toUpperCase().replace('0X', '0x')), `robinhood:native-trace:v1:${tx}`)
  assert.equal(ROBINHOOD_NATIVE_TRACE_SCHEMA_VERSION, 1)
})

test('one tx\'s persisted proof is never served for another tx', async () => {
  await trace(h(9), blockscout('ok'))
  newInstance()
  const live = blockscout('empty')
  const other = await trace(h(10), live)
  assert.equal(live.traceCalls(), 1)
  assert.equal(other.r.audit?.result, 'empty')
})

test('a persistent write failure is reported; process memory still reuses the verified proof', async () => {
  kv.failSet = true
  const tx = h(11)
  const first = await trace(tx, blockscout('ok'))
  assert.deepEqual([first.audit.persisted, first.audit.persistenceWriteFailed], [false, true])
  const down = blockscout('timeout')
  const second = await trace(tx, down)
  assert.equal(second.audit.memoryHit, true)
  assert.equal(down.traceCalls(), 0)
})

// ── Through PnL V1: the 53353-shaped mixed route classifies identically from a persisted trace ───────
const ethAt = async (ts: number): Promise<RhEthUsdPoint | null> => ({ priceUsd: 2600, provider: 'x', endpoint: null, pointMs: Math.floor(ts / 86_400) * 86_400_000, gapMs: (ts % 86_400) * 1000, maxAllowedGapMs: 86_400_000 })
async function runPnl(tx: Tx, b: ReturnType<typeof blockscout>) {
  const hash = h(0x5335)
  const rpc: RhRpc = async (calls) => calls.map(({ method, params }) => {
    const p = params as any[]
    if (method === 'eth_getTransactionReceipt') return p[0] === hash ? { status: '0x1', from: WALLET, to: ROUTER, blockNumber: hex(1000), gasUsed: '0x1', effectiveGasPrice: '0x1', logs: tx.logs } : null
    if (method === 'eth_getTransactionByHash') return { value: hex(tx.txValue) }
    if (method === 'eth_getBalance') return hex(BigInt(10) * E18)
    if (method === 'eth_getTransactionCount') return Number(p[1]) === 1000 ? '0x2' : '0x1'
    if (method === 'eth_call' && p[0].to === RH_V4_POSITION_MANAGER) return [...POOLS.entries()].find(([id]) => id.slice(2, 52) === String(p[0].data).slice(10, 60))?.[1] ?? null
    if (method === 'eth_call' && p[0].data === '0x313ce567') return hex(18)
    return null
  })
  const acc: any[] = []
  const w = console.warn
  console.warn = (tag: unknown, body: unknown) => { if (tag === '[robinhood-mixed-route-acceptance-audit]') acc.push(body) }
  try {
    const r = await computeRobinhoodPnlV1({
      wallet: WALLET, candidates: [{ txHash: hash, timestampMs: TS * 1000, hasSwapLog: true }], transactionCount: 1, transferCount: 1, activityUnavailableReason: null,
      deps: { rpc, now: Date.now, tokenHistoricalUsd: async () => null, ethUsdAt: ethAt, ethUsdRange: async () => null, nativeTransfersForTx: blockscoutNativeTransfersForTx(b.fn) },
    })
    return { r, acc }
  } finally { console.warn = w }
}

test('mixed-route classification is unchanged when the native proof comes from persistence', async () => {
  const OUT = BigInt('32288571310109712')
  const items = [{ from: { hash: ROUTER }, to: { hash: WALLET }, value: OUT.toString(), success: true, type: 'call' }]
  const live = await runPnl(shape53353(OUT), blockscout('ok', items))
  newInstance()
  __resetRobinhoodPnlV1CachesForTest()
  const down = blockscout('timeout', items)
  const persisted = await runPnl(shape53353(OUT), down)
  assert.equal(down.traceCalls(), 0)
  for (const { r, acc } of [live, persisted]) {
    assert.equal(r.swapsVerified, 1)
    assert.deepEqual([acc[0].classification, acc[0].accepted, acc[0].nativeProofStatus, acc[0].outputRaw], ['direct_mixed_route_proven', true, 'proven_target_tx_native_transfer', OUT.toString()])
  }
  assert.deepEqual(persisted.acc, live.acc)
  assert.deepEqual(persisted.r.priceEvidence, live.r.priceEvidence)
})
