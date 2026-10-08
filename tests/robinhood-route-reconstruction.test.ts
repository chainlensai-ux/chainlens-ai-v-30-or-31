// Relayed route construction: relayed mixed (V4 + V2/V3) routes and relayer-batched V4 receipts are reconstructed by
// the flow proof instead of dying before trace; recovery can prove relayed historical buys; competing payers and true
// ambiguity stay rejected. Fixtures mirror production shapes (amounts of the 0x0d1ec4c6… sell are the real ones).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import {
  computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest,
  RH_NATIVE, RH_WETH, RH_V4_POSITION_MANAGER, V4_SWAP_TOPIC0, ERC20_TRANSFER_TOPIC0, ROBINHOOD_NATIVE_TRACE_LIVE_CAP,
  type RhRpc, type RhEthUsdPoint, type RobinhoodPnlV1, type RhInboundTokenTransfer,
} from '../lib/server/robinhoodPnlV1.ts'
import { V3_SWAP_TOPIC0, WETH_WITHDRAWAL_TOPIC0, type RhNativeTransfer } from '../lib/server/robinhoodMixedRouteForensics.ts'

delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

const TS = 1790155166
const WALLET = '0x9d69b5ffb22608d8003508b9c6bd9f6b458d4184'
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const ROUTER = '0x248a454a0000000000000000000000000000beef'
const RELAYER = '0x7777777777777777777777777777777777777777'
const OTHER = '0x3333333333333333333333333333333333333333'
const V3POOL = '0x5000000000000000000000000000000000000005'
const PRIORS = '0xaaaa000000000000000000000000000000000001'
const GOOD = '0xbbbb000000000000000000000000000000000002'
const SWAPPY = '0xcccc000000000000000000000000000000000003'
const E18 = BigInt(10) ** BigInt(18)
const n = (x: number) => BigInt(Math.round(x * 1000)) * E18 / BigInt(1000)
const pad = (h: string) => h.replace(/^0x/, '').padStart(64, '0')
const t = (a: string) => `0x${pad(a)}`
const int256 = (v: bigint) => pad((v < BigInt(0) ? (BigInt(1) << BigInt(256)) + v : v).toString(16))
const uint = (v: bigint) => pad(v.toString(16))
const hex = (v: number | bigint) => `0x${BigInt(v).toString(16)}`
const hashN = (i: number) => `0x${(0xb0c0000 + i).toString(16).padStart(64, '0')}`

const POOLS = new Map<string, string>()
function poolId(x: string, y: string, fee = 3000) {
  const [c0, c1] = [x, y].sort((p, q) => (BigInt(p) < BigInt(q) ? -1 : 1))
  const types = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const
  const args = [c0 as Hex, c1 as Hex, fee, 60, RH_NATIVE as Hex] as const
  const id = keccak256(encodeAbiParameters(types, args)).toLowerCase()
  POOLS.set(id, encodeAbiParameters(types, args))
  return { id, c0, c1 }
}
class Tx {
  logs: Array<{ address: string; topics: string[]; data: string; logIndex: string; blockTimestamp: string }> = []
  trace: RhNativeTransfer[] | null = []
  sender = RELAYER
  to: string = ROUTER
  private i = 0
  constructor(public ts = TS) {}
  private push(address: string, topics: string[], data: string) { this.logs.push({ address, topics, data, logIndex: hex(this.i++), blockTimestamp: hex(this.ts) }); return this }
  xfer(token: string, from: string, to: string, amt: bigint) { return this.push(token, [ERC20_TRANSFER_TOPIC0, t(from), t(to)], `0x${uint(amt)}`) }
  v4(inTok: string, outTok: string, inAmt: bigint, outAmt: bigint, fee = 3000) {
    const p = poolId(inTok, outTok, fee)
    const d: Record<string, bigint> = { [inTok]: -inAmt, [outTok]: outAmt }
    return this.push(PM, [V4_SWAP_TOPIC0, p.id, t(ROUTER)], `0x${int256(d[p.c0])}${int256(d[p.c1])}${'0'.repeat(256)}`)
  }
  v3(pool: string, inAmt: bigint, outAmt: bigint) { return this.push(pool, [V3_SWAP_TOPIC0, t(ROUTER), t(ROUTER)], `0x${int256(inAmt)}${int256(-outAmt)}${'0'.repeat(192)}`) }
  unwrap(holder: string, amt: bigint) { return this.push(RH_WETH, [WETH_WITHDRAWAL_TOPIC0, t(holder)], `0x${uint(amt)}`) }
  traced(...rows: Array<[string, string, bigint]>) { this.trace = rows.map(([from, to, value]) => ({ from, to, value, success: true })); return this }
}

// 0x0d1ec4c6… shape: relayed single-hop TOKEN → ETH, the wallet credited 0.355089710063636165 ETH.
const ETH_0D1E = BigInt('355089710063636165')
const sell0d1e = (ts = TS) => new Tx(ts).xfer(PRIORS, WALLET, PM, n(250_000)).v4(PRIORS, RH_NATIVE, n(250_000), ETH_0D1E).traced([PM, ROUTER, ETH_0D1E], [ROUTER, WALLET, ETH_0D1E])
// Class E shape: wallet ERC-20 out, V4 → V3 WETH pool → unwrap → ETH to the wallet (no ERC-20 credit in the receipt).
const mixedSell = (ts = TS) => new Tx(ts)
  .xfer(GOOD, WALLET, PM, n(500)).v4(GOOD, SWAPPY, n(500), n(80)).xfer(SWAPPY, PM, V3POOL, n(80))
  .v3(V3POOL, n(80), n(0.04)).xfer(RH_WETH, V3POOL, ROUTER, n(0.04)).unwrap(ROUTER, n(0.04))
  .traced([RH_WETH, ROUTER, n(0.04)], [ROUTER, WALLET, n(0.04)])
// Class I shape: wallet ERC-20 in, ETH → V4 → SWAPPY → V3 → PRIORS (no ERC-20 debit in the receipt).
const mixedBuy = (ts = TS) => new Tx(ts)
  .v4(RH_NATIVE, SWAPPY, n(0.02), n(90)).xfer(SWAPPY, PM, V3POOL, n(90)).v3(V3POOL, n(90), n(1200)).xfer(PRIORS, V3POOL, WALLET, n(1200))
  .traced([WALLET, ROUTER, n(0.02)], [ROUTER, PM, n(0.02)])

const ethAt = async (ts: number): Promise<RhEthUsdPoint | null> => ({ priceUsd: 2600, provider: 'x', endpoint: null, pointMs: Math.floor(ts / 86_400) * 86_400_000, gapMs: (ts % 86_400) * 1000, maxAllowedGapMs: 86_400_000 })

async function run(txs: Tx[], opts: { candidates?: number[]; inbound?: (h: (i: number) => string) => RhInboundTokenTransfer[] } = {}) {
  __resetRobinhoodPnlV1CachesForTest()
  const byHash = new Map(txs.map((tx, i) => [hashN(i), { tx, block: 1000 + i * 10 }]))
  const live: string[] = []
  let rpcCalls = 0
  const rpc: RhRpc = async (calls) => calls.map(({ method, params }) => {
    rpcCalls += 1
    const p = params as any[]
    if (method === 'eth_getTransactionReceipt') { const e = byHash.get(p[0]); return e ? { status: '0x1', from: e.tx.sender, to: e.tx.to, blockNumber: hex(e.block), gasUsed: '0x1', effectiveGasPrice: '0x1', logs: e.tx.logs } : null }
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
  const idx = opts.candidates ?? txs.map((_, i) => i)
  let r: RobinhoodPnlV1
  try {
    r = await computeRobinhoodPnlV1({
      wallet: WALLET, candidates: idx.map((i) => ({ txHash: hashN(i), timestampMs: txs[i].ts * 1000, hasSwapLog: true })),
      transactionCount: idx.length, transferCount: idx.length, activityUnavailableReason: null,
      inboundTokenTransfers: opts.inbound?.(hashN) ?? [],
      deps: { rpc, now: Date.now, tokenHistoricalUsd: async () => null, ethUsdAt: ethAt, ethUsdRange: async () => null, nativeTransfersForTx: async (h) => { live.push(h); return byHash.get(h)?.tx.trace ?? null } },
    })
  } finally { console.warn = w }
  const rows = lines.filter(([tag, b]) => tag === '[robinhood-relayed-attribution-audit]' && b.txHash).map(([, b]) => b)
  return { r, live, rpcCalls, rows }
}

test('0x0d1ec4c6… sell path stays accepted: relayed TOKEN → ETH, exact 0.355089710063636165 ETH credit', async () => {
  const { r } = await run([sell0d1e()])
  assert.equal(r.swapsVerified, 1)
  assert.equal(r.ingestionAudit.normalizedSellCount, 1)
  assert.equal(r.verificationCoverage?.verifiedSells, 1)
  assert.equal(r.ingestionAudit.relayedWalletVerifiedSwapCount, 1)
})

test('class E (wallet token out + V4 + V3 WETH unwrap → ETH) is reconstructed: trace-eligible, then proven as a sell', async () => {
  const noTrace = mixedSell()
  noTrace.trace = null
  const pending = await run([noTrace])
  assert.equal(pending.r.swapsVerified, 0)
  assert.deepEqual([pending.rows[0].attributionClass, pending.rows[0].terminalReason], ['B_token_in_native_out', 'trace_eligible'])
  const { r, live } = await run([mixedSell()])
  assert.equal(live.length, 1)
  assert.equal(r.swapsVerified, 1)
  assert.equal(r.ingestionAudit.normalizedSellCount, 1)
})

test('class I (wallet token in + ETH → V4 → V3) is reconstructed: trace-eligible, then proven as a buy', async () => {
  const noTrace = mixedBuy()
  noTrace.trace = null
  const pending = await run([noTrace])
  assert.deepEqual([pending.rows[0].attributionClass, pending.rows[0].terminalReason], ['A_native_in_token_out', 'trace_eligible'])
  const { r } = await run([mixedBuy()])
  assert.equal(r.swapsVerified, 1)
  assert.equal(r.ingestionAudit.normalizedBuyCount, 1)
})

test('class F: a competing payer stays rejected (plain V4 and mixed)', async () => {
  const v4 = new Tx().v4(RH_NATIVE, PRIORS, n(0.01), n(100)).xfer(PRIORS, PM, WALLET, n(100)).traced([WALLET, ROUTER, n(0.005)], [OTHER, ROUTER, n(0.005)], [ROUTER, PM, n(0.01)])
  const mixed = mixedBuy()
  mixed.traced([WALLET, ROUTER, n(0.01)], [OTHER, ROUTER, n(0.01)], [ROUTER, PM, n(0.02)])
  const { r, rows } = await run([v4, mixed])
  assert.equal(r.swapsVerified, 0)
  assert.deepEqual(rows.map((x) => x.attributionClass).sort(), ['F_competing_payer', 'F_competing_payer'])
})

test('relayer-batched receipt: another user\'s V4 swap in the same tx no longer blocks the wallet\'s uniquely reconstructed route', async () => {
  // The wallet's PRIORS → ETH sell plus another user's unrelated GOOD buy in one relayed tx.
  const batch = new Tx()
    .xfer(PRIORS, WALLET, PM, n(1000)).v4(PRIORS, RH_NATIVE, n(1000), n(0.05))
    .v4(RH_NATIVE, GOOD, n(0.3), n(700)).xfer(GOOD, PM, OTHER, n(700))
    .traced([PM, ROUTER, n(0.05)], [ROUTER, WALLET, n(0.05)], [OTHER, ROUTER, n(0.3)], [ROUTER, PM, n(0.3)])
  const { r } = await run([batch])
  assert.equal(r.swapsVerified, 1, 'the wallet route is proven; the other user\'s swap is not attributed to it')
  assert.equal(r.ingestionAudit.normalizedSellCount, 1)
  assert.equal(r.ingestionAudit.normalizedBuyCount, 0)
})

test('truly ambiguous: two connected paths reproduce the wallet trade → rejected, terminal multi_hop_ambiguity', async () => {
  const twice = new Tx().v4(RH_NATIVE, PRIORS, n(0.01), n(1000)).v4(RH_NATIVE, PRIORS, n(0.01), n(1000), 500).xfer(PRIORS, PM, WALLET, n(1000)).traced([WALLET, ROUTER, n(0.01)])
  const { r, rows } = await run([twice])
  assert.equal(r.swapsVerified, 0)
  assert.equal(rows[0].terminalReason, 'multi_hop_ambiguity')
})

test('recovery proves a relayed historical buy (formerly dropped as not_wallet_sent) and the sell closes a FIFO lot', async () => {
  const oldBuy = new Tx(TS - 5000).v4(RH_NATIVE, PRIORS, n(0.2), n(250_000)).xfer(PRIORS, PM, WALLET, n(250_000)).traced([WALLET, ROUTER, n(0.2)], [ROUTER, PM, n(0.2)])
  const { r, live } = await run([sell0d1e(), oldBuy], {
    candidates: [0],
    inbound: (h) => [{ txHash: h(1), timestampMs: (TS - 5000) * 1000, token: PRIORS, rawAmount: n(250_000).toString() }],
  })
  assert.ok(live.length <= ROBINHOOD_NATIVE_TRACE_LIVE_CAP)
  assert.equal(r.acquisitionRecovery?.recoveredBuyCount, 1)
  assert.equal(r.acquisitionRecovery?.unmatchedSellRawAfter, '0')
  assert.equal(r.structuralClosedLots, 1)
})

test('terminal reasons are counted for every remaining relayed rejection', async () => {
  const unrelatedVenue = new Tx().xfer(GOOD, WALLET, PM, n(10)).v4(GOOD, SWAPPY, n(10), n(5)).xfer(SWAPPY, PM, OTHER, n(5)).xfer(PRIORS, OTHER, V3POOL, n(7)).v3(V3POOL, n(7), n(3)).xfer(GOOD, V3POOL, OTHER, n(3))
  const { r } = await run([unrelatedVenue])
  const a = r.ingestionAudit.relayedAttribution!
  assert.equal(Object.values(a.terminalReasons ?? {}).reduce((x, y) => x + (y ?? 0), 0), 1)
  assert.equal(a.walletOutWithV4, 1)
})
