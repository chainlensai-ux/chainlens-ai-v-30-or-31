// Robinhood native-trace selection: live native_trace slots go only to receipts where proven native flow can
// change the outcome, in deterministic priority order; stored proofs never take a slot; acceptance is unchanged.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import { computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest, ROBINHOOD_NATIVE_TRACE_LIVE_CAP, RH_NATIVE, RH_WETH, RH_V4_POSITION_MANAGER, V4_SWAP_TOPIC0, V4_MODIFY_LIQUIDITY_TOPIC0, ERC20_TRANSFER_TOPIC0, type RhRpc, type RhEthUsdPoint, type RobinhoodPnlV1Deps } from '../lib/server/robinhoodPnlV1.ts'
import { V2_SWAP_TOPIC0, V3_SWAP_TOPIC0, WETH_WITHDRAWAL_TOPIC0, type RhNativeTransfer } from '../lib/server/robinhoodMixedRouteForensics.ts'
import { NATIVE_TRACE_MAX_LOOKUPS } from '../lib/server/robinhoodBlockscoutEvidence.ts'

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
  sender = WALLET
  at(ts: number) { this.ts = ts; for (const l of this.logs as Array<{ blockTimestamp: string }>) l.blockTimestamp = hex(ts); return this }
  liquidity() { return this.push(PM, [V4_MODIFY_LIQUIDITY_TOPIC0, t(OTHER), t(ROUTER)], `0x${'0'.repeat(256)}`) }
  private i = 0
  push(address: string, topics: string[], data: string) { this.logs.push({ address, topics, data, logIndex: hex(this.i++), blockTimestamp: hex(this.ts) }); return this }
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


const ethAt = async (ts: number): Promise<RhEthUsdPoint | null> => ({ priceUsd: 2600, provider: 'x', endpoint: null, pointMs: Math.floor(ts / 86_400) * 86_400_000, gapMs: (ts % 86_400) * 1000, maxAllowedGapMs: 86_400_000 })

// Production-shaped candidates (oldest first, so the OLD in-order lookup gave the first slots to A).
const candA = () => new Tx().xfer(A_TOKEN, WALLET, PM, n(1000)).v4(A_TOKEN, RH_NATIVE, n(500), n(1)).paysWallet(n(1)).at(TS - 500) // token side never reproduced
const candB = () => directBuy(n(1), n(1000)).liquidity().at(TS - 400)            // liquidity event
const candC = () => { const tx = directBuy(n(1), n(1000)).at(TS - 300); tx.sender = OTHER; return tx } // wallet not tx sender
const candF = () => new Tx().xfer(A_TOKEN, WALLET, PM, n(1000)).v4(A_TOKEN, B_TOKEN, n(1000), n(80)).xfer(B_TOKEN, PM, P3, n(80)).v3(P3, n(80), n(7)).at(TS - 250) // mixed, V3 hop unresolvable
const candD = () => new Tx().xfer(A_TOKEN, WALLET, PM, n(1000)).v4(A_TOKEN, RH_NATIVE, n(1000), n(1)).paysWallet(n(1)).at(TS - 200) // token in → native out
const candE = () => directBuy(n(1), n(1000)).at(TS - 100)                                                                              // native in → token out

async function run(txs: Array<[string, Tx]>, over: Partial<RobinhoodPnlV1Deps> = {}) {
  __resetRobinhoodPnlV1CachesForTest()
  const hashOf = new Map(txs.map(([name], i) => [name, `0x${(0x5e83 + i).toString(16).padStart(64, '0')}`]))
  const byHash = new Map(txs.map(([name, tx], i) => [hashOf.get(name)!, { name, tx, block: 1000 + i * 10 }]))
  const byBlock = new Map([...byHash.values()].map((v) => [v.block, v]))
  const rpc: RhRpc = async (calls) => calls.map(({ method, params }) => {
    const p = params as any[]
    if (method === 'eth_getTransactionReceipt') { const e = byHash.get(p[0]); return e ? { status: '0x1', from: e.tx.sender, to: ROUTER, blockNumber: hex(e.block), gasUsed: '0x1', effectiveGasPrice: '0x1', logs: e.tx.logs } : null }
    if (method === 'eth_getTransactionByHash') { const e = byHash.get(p[0]); return e ? { value: hex(e.tx.txValue) } : null }
    if (method === 'eth_getBalance') return hex(BigInt(10) * E18)
    if (method === 'eth_getTransactionCount') return byBlock.get(Number(p[1]))?.tx.sender === WALLET ? '0x2' : '0x1'
    if (method === 'eth_call' && p[0].to === RH_V4_POSITION_MANAGER) return [...POOLS.entries()].find(([id]) => id.slice(2, 52) === String(p[0].data).slice(10, 60))?.[1] ?? null
    if (method === 'eth_call' && p[0].data === '0x313ce567') return hex(18)
    return null
  })
  const traceCalls: string[] = []
  const lines: Array<[string, any]> = []
  const w = console.warn
  console.warn = (tag: unknown, body: unknown) => { lines.push([String(tag), body]) }
  try {
    const r = await computeRobinhoodPnlV1({
      wallet: WALLET, candidates: [...hashOf.values()].map((h) => ({ txHash: h, timestampMs: byHash.get(h)!.tx.ts * 1000, hasSwapLog: true })),
      transactionCount: txs.length, transferCount: txs.length, activityUnavailableReason: null,
      deps: {
        rpc, now: Date.now, tokenHistoricalUsd: async () => null, ethUsdAt: ethAt, ethUsdRange: async () => null, nativeTraceLiveCap: 2,
        nativeTransfersForTx: async (h) => { traceCalls.push(byHash.get(h)!.name); return byHash.get(h)!.tx.trace },
        ...over,
      },
    })
    const name = (h: string) => byHash.get(h)?.name
    const sel = lines.filter(([t, b]) => t === '[robinhood-native-trace-selection-audit]' && !b.summary).map(([, b]) => ({ ...b, name: name(b.candidateTxHash) }))
    const summary = lines.find(([t, b]) => t === '[robinhood-native-trace-selection-audit]' && b.summary)?.[1].summary
    const traceAudits = lines.filter(([t]) => t === '[robinhood-native-trace-audit]').map(([, b]) => ({ ...b, name: name(b.txHash) }))
    const verified = r.priceEvidence.map((e) => name(e.swapTxHash)).sort()
    return { r, traceCalls, sel, summary, traceAudits, verified, hashOf, byHash }
  } finally { console.warn = w }
}
const A_TOKEN = '0xaaaa000000000000000000000000000000000001'
const B_TOKEN = '0xbbbb000000000000000000000000000000000002'
const production = (): Array<[string, Tx]> => [['A', candA()], ['B', candB()], ['C', candC()], ['F', candF()], ['D', candD()], ['E', candE()]]

beforeEach(() => { __resetRobinhoodPnlV1CachesForTest() })

test('the live cap is unchanged (= the Blockscout native_trace lane cap)', () => {
  assert.equal(ROBINHOOD_NATIVE_TRACE_LIVE_CAP, NATIVE_TRACE_MAX_LOOKUPS)
  assert.equal(ROBINHOOD_NATIVE_TRACE_LIVE_CAP, 3)
})

test('production shape, live cap 2: A/B/C/F take no slot; D and E each get one live trace and are accepted by the normal classifier', async () => {
  const { r, traceCalls, sel, summary, verified } = await run(production())
  assert.deepEqual(traceCalls.slice().sort(), ['D', 'E'])
  assert.deepEqual(verified, ['D', 'E'])
  assert.equal(r.swapsVerified, 2)
  assert.deepEqual(r.ingestionAudit.rejectionReasons, { route_does_not_match_wallet_amounts: 1, liquidity_event_in_tx: 1, wallet_not_tx_sender: 1, other_venue_swap_in_tx: 1 })
  const by = Object.fromEntries(sel.map((s) => [s.name, s]))
  assert.deepEqual([by.A.traceEligible, by.A.terminalWithoutNativeTrace, by.A.preTraceClassification, by.A.skippedReason], [false, true, 'route_does_not_match_wallet_amounts', 'terminal_without_native_trace'])
  assert.deepEqual([by.B.traceEligible, by.B.skippedReason], [false, 'no_native_dependency'])
  assert.deepEqual([by.C.traceEligible, by.C.skippedReason], [false, 'no_native_dependency'])
  assert.deepEqual([by.F.traceEligible, by.F.terminalWithoutNativeTrace], [false, true])
  assert.deepEqual([by.D.selectedForLiveTrace, by.D.liveBudgetOrdinal, by.D.priorityClass, by.D.nativeProofCouldChangeOutcome], [true, 1, 'p2_single_hop_v4_one_erc20_side', true])
  assert.deepEqual([by.E.selectedForLiveTrace, by.E.liveBudgetOrdinal, by.E.priorityClass], [true, 2, 'p2_single_hop_v4_one_erc20_side'])
  assert.deepEqual(summary, {
    receiptCandidates: 6, terminalRejectedBeforeTrace: 4, nativeTraceEligible: 2, cacheSatisfied: 0, selectedForLiveTrace: 2,
    liveBudgetCap: 2, liveBudgetExhaustedEligibleCount: 0, tracesAvoidedByStructuralPrefilter: 2,
  })
  assert.equal(r.ingestionAudit.nativeTraceSelection?.selectedForLiveTrace, 2)
})

test('budget_exhausted only hits eligible receipts after higher-priority ones used the slots (cap 1)', async () => {
  const { r, traceCalls, sel, traceAudits, verified } = await run(production(), { nativeTraceLiveCap: 1 })
  assert.deepEqual(traceCalls, ['D']) // oldest eligible wins; A (older still) never competes
  assert.deepEqual(verified, ['D'])
  const e = sel.find((s) => s.name === 'E')
  assert.deepEqual([e.traceEligible, e.selectedForLiveTrace, e.skippedReason], [true, false, 'live_budget_exhausted'])
  assert.deepEqual(traceAudits.filter((a) => a.name === 'E').map((a) => [a.result, a.attempted]), [['budget_exhausted', false]])
  assert.equal(r.ingestionAudit.rejectionReasons.native_flow_unprovable, 1)
})

test('priority: single-hop one-ERC20-side before multi-hop, then timestamp, then txHash — independent of input order', async () => {
  const multi = new Tx().xfer(A_TOKEN, WALLET, PM, n(1000)).v4(A_TOKEN, B_TOKEN, n(1000), n(80)).v4(B_TOKEN, RH_NATIVE, n(80), n(1)).paysWallet(n(1)).at(TS - 900)
  const one = await run([['M', multi], ['D', candD()], ['E', candE()]], { nativeTraceLiveCap: 2 })
  assert.deepEqual(one.traceCalls.slice().sort(), ['D', 'E']) // the older multi-hop route waits behind the single-hop ones
  assert.equal(one.sel.find((s) => s.name === 'M').priorityClass, 'p4_complex_multi_hop')
  const two = await run([['E', candE()], ['D', candD()], ['M', multi]], { nativeTraceLiveCap: 2 })
  assert.deepEqual(two.sel.filter((s) => s.selectedForLiveTrace).map((s) => [s.name, s.liveBudgetOrdinal]).sort(), [['D', 1], ['E', 2]])
})

test('a stored (persistent / memory) proof consumes zero live slots', async () => {
  const d = candD()
  const { traceCalls, sel, summary, verified } = await run([['A', candA()], ['D', d], ['E', candE()]], {
    nativeTraceLiveCap: 1,
    nativeTraceCached: async (h) => {
      // D's proof is already stored
      return h.endsWith((0x5e83 + 1).toString(16)) ? { transfers: d.trace!, audit: null } : null
    },
  })
  assert.deepEqual(traceCalls, ['E']) // the single live slot goes to E
  assert.deepEqual(verified, ['D', 'E'])
  const dd = sel.find((s) => s.name === 'D')
  assert.deepEqual([dd.persistentOrMemoryHit, dd.selectedForLiveTrace, dd.priorityClass, dd.liveBudgetOrdinal], [true, false, 'p1_stored_proof', null])
  assert.equal(summary.cacheSatisfied, 1)
  assert.equal(summary.selectedForLiveTrace, 1)
})

test('a transport failure still fails closed', async () => {
  const d = candD()
  d.trace = null
  const { r, traceCalls, verified } = await run([['D', d], ['E', candE()]])
  assert.deepEqual(traceCalls.slice().sort(), ['D', 'E'])
  assert.deepEqual(verified, ['E'])
  assert.equal(r.ingestionAudit.rejectionReasons.native_flow_unprovable, 1)
})

test('no receipt is accepted merely because it was prioritized (the real trace must reproduce the route)', async () => {
  const e = candE()
  e.trace = [{ from: ROUTER, to: WALLET, value: n(0.5), success: true }] // refund makes the wallet's native net −0.5 ETH ≠ the 1 ETH hop
  const d = candD()
  d.trace = [{ from: ROUTER, to: WALLET, value: n(0.4), success: true }] // paid far less than the hop produced
  const { r, traceCalls } = await run([['D', d], ['E', e]])
  assert.deepEqual(traceCalls.slice().sort(), ['D', 'E'])
  assert.equal(r.swapsVerified, 0)
})

test('with native evidence for every eligible receipt, results match the unprioritized classifier', async () => {
  const capped = await run(production(), { nativeTraceLiveCap: 2 })
  const all = await run(production(), { nativeTraceLiveCap: 50 })
  assert.deepEqual(all.verified, capped.verified)
  assert.deepEqual(all.r.ingestionAudit.rejectionReasons, capped.r.ingestionAudit.rejectionReasons)
  assert.deepEqual(all.r.priceEvidence, capped.r.priceEvidence)
  // A is rejected for the same structural reason a real trace would have exposed
  const traced = await run([['A', candA()]], { nativeTraceLiveCap: 0 })
  assert.deepEqual(traced.r.ingestionAudit.rejectionReasons, { route_does_not_match_wallet_amounts: 1 })
})
