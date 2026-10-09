// Robinhood live native-trace cap 3 → 5. Only the cap changes: the same deterministic priority (native-out sells, then
// relayed buys, fewer hops first, older first), stored proofs take no live slot, a failed trace costs at most one slot,
// no tx is traced twice, and externally funded routes stay rejected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import {
  computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest, ROBINHOOD_NATIVE_TRACE_LIVE_CAP,
  RH_NATIVE, RH_V4_POSITION_MANAGER, V4_SWAP_TOPIC0, ERC20_TRANSFER_TOPIC0, type RhRpc, type RhEthUsdPoint, type RobinhoodPnlV1,
} from '../lib/server/robinhoodPnlV1.ts'
import { NATIVE_TRACE_MAX_LOOKUPS } from '../lib/server/robinhoodBlockscoutEvidence.ts'
import type { RhNativeTransfer } from '../lib/server/robinhoodMixedRouteForensics.ts'

delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

const TS = 1790155166
const WALLET = '0x9d69b5ffb22608d8003508b9c6bd9f6b458d4184'
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const ROUTER = '0x248a454a0000000000000000000000000000beef'
const RELAYER = '0x7777777777777777777777777777777777777777'
const OTHER = '0x3333333333333333333333333333333333333333'
const TOKENS = Array.from({ length: 12 }, (_, i) => `0x${(0xaa00 + i).toString(16)}${'0'.repeat(36)}`)
const E18 = BigInt(10) ** BigInt(18)
const n = (x: number) => BigInt(Math.round(x * 1000)) * E18 / BigInt(1000)
const pad = (h: string) => h.replace(/^0x/, '').padStart(64, '0')
const t = (a: string) => `0x${pad(a)}`
const int256 = (v: bigint) => pad((v < BigInt(0) ? (BigInt(1) << BigInt(256)) + v : v).toString(16))
const uint = (v: bigint) => pad(v.toString(16))
const hex = (v: number | bigint) => `0x${BigInt(v).toString(16)}`
const hashN = (i: number) => `0x${(0xcab0000 + i).toString(16).padStart(64, '0')}`

const POOLS = new Map<string, string>()
function poolId(x: string, y: string) {
  const [c0, c1] = [x, y].sort((p, q) => (BigInt(p) < BigInt(q) ? -1 : 1))
  const types = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const
  const args = [c0 as Hex, c1 as Hex, 3000, 60, RH_NATIVE as Hex] as const
  const id = keccak256(encodeAbiParameters(types, args)).toLowerCase()
  POOLS.set(id, encodeAbiParameters(types, args))
  return { id, c0, c1 }
}
export class Tx {
  logs: Array<{ address: string; topics: string[]; data: string; logIndex: string; blockTimestamp: string }> = []
  trace: RhNativeTransfer[] | null = []
  sender = RELAYER
  to: string = ROUTER
  stored = false
  private i = 0
  constructor(public ts = TS) {}
  private push(address: string, topics: string[], data: string) { this.logs.push({ address, topics, data, logIndex: hex(this.i++), blockTimestamp: hex(this.ts) }); return this }
  xfer(token: string, from: string, to: string, amt: bigint) { return this.push(token, [ERC20_TRANSFER_TOPIC0, t(from), t(to)], `0x${uint(amt)}`) }
  v4(inTok: string, outTok: string, inAmt: bigint, outAmt: bigint) {
    const p = poolId(inTok, outTok)
    const d: Record<string, bigint> = { [inTok]: -inAmt, [outTok]: outAmt }
    return this.push(PM, [V4_SWAP_TOPIC0, p.id, t(ROUTER)], `0x${int256(d[p.c0])}${int256(d[p.c1])}${'0'.repeat(256)}`)
  }
  traced(...rows: Array<[string, string, bigint]>) { this.trace = rows.map(([from, to, value]) => ({ from, to, value, success: true })); return this }
}
// Relayed ETH → token buy / token → ETH sell (the shapes production now marks pending_trace).
export const buy = (k: number, ts: number) => new Tx(ts).v4(RH_NATIVE, TOKENS[k], n(0.01), n(100 + k)).xfer(TOKENS[k], PM, WALLET, n(100 + k)).traced([WALLET, ROUTER, n(0.01)], [ROUTER, PM, n(0.01)])
export const sell = (k: number, ts: number) => new Tx(ts).xfer(TOKENS[k], WALLET, PM, n(100 + k)).v4(TOKENS[k], RH_NATIVE, n(100 + k), n(0.02)).traced([PM, ROUTER, n(0.02)], [ROUTER, WALLET, n(0.02)])
export const externallyFunded = (k: number, ts: number) => new Tx(ts).v4(RH_NATIVE, TOKENS[k], n(0.01), n(100 + k)).xfer(TOKENS[k], PM, WALLET, n(100 + k)).traced([OTHER, ROUTER, n(0.01)], [ROUTER, PM, n(0.01)])

const ethAt = async (ts: number): Promise<RhEthUsdPoint | null> => ({ priceUsd: 2600, provider: 'x', endpoint: null, pointMs: Math.floor(ts / 86_400) * 86_400_000, gapMs: (ts % 86_400) * 1000, maxAllowedGapMs: 86_400_000 })

export async function runCap(txs: Tx[], opts: { cap?: number; traceDelayMs?: number; failing?: number[]; duplicateCandidates?: boolean } = {}) {
  __resetRobinhoodPnlV1CachesForTest()
  const byHash = new Map(txs.map((tx, i) => [hashN(i), { tx, i, block: 1000 + i * 10 }]))
  const live: number[] = []
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
  const candidates = txs.map((tx, i) => ({ txHash: hashN(i), timestampMs: tx.ts * 1000, hasSwapLog: true }))
  const started = Date.now()
  let r: RobinhoodPnlV1
  try {
    r = await computeRobinhoodPnlV1({
      wallet: WALLET, candidates: opts.duplicateCandidates ? [...candidates, ...candidates] : candidates,
      transactionCount: txs.length, transferCount: txs.length, activityUnavailableReason: null,
      deps: {
        rpc, now: Date.now, tokenHistoricalUsd: async () => null, ethUsdAt: ethAt, ethUsdRange: async () => null,
        ...(opts.cap != null ? { nativeTraceLiveCap: opts.cap } : {}),
        nativeTransfersForTx: async (h) => {
          const e = byHash.get(h)!
          live.push(e.i)
          if (opts.traceDelayMs) await new Promise((res) => setTimeout(res, opts.traceDelayMs))
          return opts.failing?.includes(e.i) ? null : e.tx.trace
        },
        nativeTraceCached: async (h) => { const e = byHash.get(h); return e?.tx.stored && e.tx.trace ? { transfers: e.tx.trace, audit: null } : null },
      },
    })
  } finally { console.warn = w }
  const sel = lines.filter(([tag, b]) => tag === '[robinhood-native-trace-selection-audit]' && b.candidateTxHash).map(([, b]) => ({ ...b, i: byHash.get(b.candidateTxHash)?.i }))
  return { r, live, rpcCalls, elapsedMs: Date.now() - started, sel }
}

test('1. the live cap is 5 and equals the Blockscout native_trace lane cap', () => {
  assert.equal(ROBINHOOD_NATIVE_TRACE_LIVE_CAP, 5)
  assert.equal(NATIVE_TRACE_MAX_LOOKUPS, ROBINHOOD_NATIVE_TRACE_LIVE_CAP)
})

// Seven eligible: 2 relayed sells (newest) and 5 relayed buys (older → newer).
const seven = () => [buy(0, TS - 700), buy(1, TS - 600), buy(2, TS - 500), buy(3, TS - 400), buy(4, TS - 300), sell(5, TS - 200), sell(6, TS - 100)]

test('2+3+4. same priority: the two sells, then the three oldest buys run live; the 6th/7th are live_budget_exhausted', async () => {
  const { r, live, sel } = await runCap(seven())
  assert.equal(live.length, 5)
  assert.deepEqual(live.slice().sort(), [0, 1, 2, 5, 6])
  assert.deepEqual(live.slice(0, 2).sort(), [5, 6], 'native-out sells are traced first')
  const byI = new Map(sel.map((s) => [s.i, s]))
  assert.deepEqual([byI.get(5).priorityClass, byI.get(0).priorityClass], ['p1_native_out_sell', 'p2_relayed_buy'])
  assert.deepEqual([3, 4].map((i) => byI.get(i).skippedReason), ['live_budget_exhausted', 'live_budget_exhausted'])
  assert.equal(r.swapsVerified, 5)
  assert.deepEqual([r.ingestionAudit.normalizedBuyCount, r.ingestionAudit.normalizedSellCount], [3, 2])
  assert.equal(r.ingestionAudit.nativeTraceGlobalBudget?.totalLiveUsed, 5)
})

test('2b. with cap 3 the same order holds: the two sells, then the oldest buy', async () => {
  const { live } = await runCap(seven(), { cap: 3 })
  assert.deepEqual(live.slice().sort(), [0, 5, 6])
})

test('5. stored proof hits take no live slot', async () => {
  const txs = seven()
  for (const i of [5, 6, 0]) txs[i].stored = true
  const { r, live } = await runCap(txs)
  assert.deepEqual(live.slice().sort(), [1, 2, 3, 4], 'the 4 non-stored eligible receipts all fit in the 5 live slots')
  assert.equal(r.swapsVerified, 7)
  assert.equal(r.ingestionAudit.nativeTraceGlobalBudget?.storedProofHitsMain, 3)
})

test('6. a failed trace costs at most one slot and fails closed', async () => {
  const { r, live } = await runCap(seven(), { failing: [5] })
  assert.equal(live.filter((i) => i === 5).length, 1)
  assert.equal(live.length, 5)
  assert.equal(r.swapsVerified, 4, 'the failed sell is not promoted; the other four traced routes are')
})

test('7. no tx is traced twice (duplicate candidates, shared selection + relayed lane + reserve release)', async () => {
  const { live } = await runCap(seven(), { duplicateCandidates: true })
  assert.equal(new Set(live).size, live.length)
  assert.ok(live.length <= ROBINHOOD_NATIVE_TRACE_LIVE_CAP)
})

test('8. externally funded routes stay rejected with the larger cap', async () => {
  // Another address pays the whole input; and a route the wallet and another address co-fund.
  const coFunded = new Tx(TS - 250).v4(RH_NATIVE, TOKENS[3], n(0.01), n(103)).xfer(TOKENS[3], PM, WALLET, n(103)).traced([WALLET, ROUTER, n(0.005)], [OTHER, ROUTER, n(0.005)], [ROUTER, PM, n(0.01)])
  const { r, live } = await runCap([externallyFunded(0, TS - 300), coFunded, sell(1, TS - 200), buy(2, TS - 100)])
  assert.ok(live.includes(0) && live.includes(1), 'both traced')
  assert.equal(r.swapsVerified, 2)
  assert.deepEqual(r.ingestionAudit.relayedWalletRejectedReasons, { no_wallet_native_debit: 1, externally_funded_route: 1 })
})
