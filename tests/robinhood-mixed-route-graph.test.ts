// Robinhood mixed-route graph audit + `independent_second_action` (job 0774d22c: 0x8aac…9310 swap 6, 0xe603…7e7e swaps
// 1,2,3,5,6 "not on the wallet's route"). A swap is connected only by deterministic token reachability; an excluded
// swap is never a required intermediate leg. These fixtures reconstruct the SHAPES the production rejections imply
// (the exact receipts are not reachable from the test environment) and pin that the rejection stays.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import { analyzeRobinhoodMixedRoute, robinhoodMixedRouteGraph, V2_SWAP_TOPIC0, V3_SWAP_TOPIC0, WETH_WITHDRAWAL_TOPIC0, WETH_DEPOSIT_TOPIC0, type RhNativeEvidence } from '../lib/server/robinhoodMixedRouteForensics.ts'
import { RH_WETH, type RhPoolKey, type RhReceipt } from '../lib/server/robinhoodPnlV1.ts'

const WALLET = '0x343f5a0bd465f8ffec69cf2e90152c80397470b9'
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const ROUTER = '0x3333333333333333333333333333333333333333'
const OTHER = '0x2222222222222222222222222222222222222222'
const NATIVE = '0x0000000000000000000000000000000000000000'
const A = '0xaaaa000000000000000000000000000000000001'
const B = '0xbbbb000000000000000000000000000000000002'
const C = '0xcccc000000000000000000000000000000000003'
const D = '0xdddd000000000000000000000000000000000004'
const P2 = '0x2000000000000000000000000000000000000002'
const P3 = '0x3000000000000000000000000000000000000003'
const SWAP4 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const MODIFY = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec'
const E18 = BigInt(10) ** BigInt(18)
const n = (x: number) => BigInt(x) * E18

const pad = (h: string) => h.replace(/^0x/, '').padStart(64, '0')
const t = (a: string) => `0x${pad(a)}`
const int256 = (v: bigint) => pad((v < BigInt(0) ? (BigInt(1) << BigInt(256)) + v : v).toString(16))
const uint = (v: bigint) => pad(v.toString(16))

function poolKey(x: string, y: string) {
  const [c0, c1] = [x, y].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
  const types = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const
  const args = [c0 as Hex, c1 as Hex, 3000, 60, NATIVE as Hex] as const
  return { id: keccak256(encodeAbiParameters(types, args)).toLowerCase(), c0, c1, encoded: encodeAbiParameters(types, args) }
}

class Rx {
  logs: RhReceipt['logs'] = []
  keys = new Map<string, RhPoolKey>()
  encoded = new Map<string, string>()
  private i = 0
  private push(l: Omit<RhReceipt['logs'][number], 'logIndex' | 'blockTimestamp'>) { this.logs.push({ ...l, logIndex: this.i++, blockTimestamp: 1_760_000_000 }); return this }
  xfer(token: string, from: string, to: string, amt: bigint) { return this.push({ address: token, topics: [TRANSFER, t(from), t(to)], data: `0x${uint(amt)}` }) }
  /** V4: swapper perspective — `inTok` paid in (negative), `outTok` taken out (positive). */
  v4(inTok: string, outTok: string, inAmt: bigint, outAmt: bigint) {
    const k = poolKey(inTok, outTok)
    this.keys.set(k.id, { currency0: k.c0, currency1: k.c1 })
    this.encoded.set(k.id, k.encoded)
    const d: Record<string, bigint> = { [inTok]: -inAmt, [outTok]: outAmt }
    return this.push({ address: PM, topics: [SWAP4, k.id, t(ROUTER)], data: `0x${int256(d[k.c0])}${int256(d[k.c1])}${'0'.repeat(256)}` })
  }
  /** V3: pool perspective — in positive, out negative (token0/token1 order irrelevant to the analyzer). */
  v3(pool: string, inAmt: bigint, outAmt: bigint) { return this.push({ address: pool, topics: [V3_SWAP_TOPIC0, t(ROUTER), t(ROUTER)], data: `0x${int256(inAmt)}${int256(-outAmt)}${'0'.repeat(192)}` }) }
  v2(pool: string, inAmt: bigint, outAmt: bigint) { return this.push({ address: pool, topics: [V2_SWAP_TOPIC0, t(ROUTER), t(ROUTER)], data: `0x${uint(inAmt)}${uint(BigInt(0))}${uint(BigInt(0))}${uint(outAmt)}` }) }
  unwrap(holder: string, amt: bigint) { return this.push({ address: RH_WETH, topics: [WETH_WITHDRAWAL_TOPIC0, t(holder)], data: `0x${uint(amt)}` }) }
  wrap(holder: string, amt: bigint) { return this.push({ address: RH_WETH, topics: [WETH_DEPOSIT_TOPIC0, t(holder)], data: `0x${uint(amt)}` }) }
  liquidity() { return this.push({ address: PM, topics: [MODIFY, t(ROUTER)], data: '0x' }) }
  receipt(from = WALLET): RhReceipt { return { status: 1, from, to: ROUTER, blockNumber: 500, gasUsed: BigInt(100_000), effectiveGasPrice: BigInt(1_000_000_000), logs: this.logs } }
}
/** Native leg proven by the target tx's own trace (the only evidence that may feed a route). */
const nativeProven = (net: bigint): RhNativeEvidence => ({ walletBalanceBefore: n(5).toString(), walletBalanceAfter: (n(5) + net - BigInt(100_000) * BigInt(1_000_000_000)).toString(), gasPaid: (BigInt(100_000) * BigInt(1_000_000_000)).toString(), txValue: net < BigInt(0) ? (-net).toString() : '0', walletTxsInBlock: 1, blockBalanceDeltaExGas: net.toString(), traceSource: 'blockscout_internal_transactions', traceNativeToWallet: (net > BigInt(0) ? net : BigInt(0)).toString(), traceNativeFromWallet: '0', nativeNetExGas: net, status: 'proven_target_tx_native_transfer' })
const nativeNone: RhNativeEvidence = { walletBalanceBefore: null, walletBalanceAfter: null, gasPaid: '0', txValue: null, walletTxsInBlock: null, blockBalanceDeltaExGas: null, traceSource: null, traceNativeToWallet: null, traceNativeFromWallet: null, nativeNetExGas: null, status: 'unavailable_no_balance_evidence' }


const RELAYER = '0x7777777777777777777777777777777777777777'
const USER2 = '0x9999999999999999999999999999999999999999'
const X = '0xdee52f2ab639b6942b0d0f0565400b93b7a0fbe5' // 0x8aac's wallet token
const Y = '0xedbf91223639800bcd5756815caf908df3b890be' // 0xe603's wallet token
const T = ['0x1100000000000000000000000000000000000001', '0x1100000000000000000000000000000000000002', '0x1100000000000000000000000000000000000003', '0x1100000000000000000000000000000000000004', '0x1100000000000000000000000000000000000005']
const F = ['0x2200000000000000000000000000000000000001', '0x2200000000000000000000000000000000000002', '0x2200000000000000000000000000000000000003']
const ETH_8AAC = BigInt('612973348436214280')
const ETH_E603 = BigInt('1725135499030843309')
const relayed = (rx: Rx, native: RhNativeEvidence) => analyzeRobinhoodMixedRoute({ wallet: WALLET, txHash: '0xfeed', receipt: rx.receipt(RELAYER), poolManager: PM, v4PoolKeys: rx.keys, native, relayed: true })
const graph = (rx: Rx, m: ReturnType<typeof relayed>) => robinhoodMixedRouteGraph({ wallet: WALLET, receipt: rx.receipt(RELAYER), poolManager: PM, forensics: m })

/** 0x8aac shape: wallet X → 6 connected V4 legs → native to the wallet; ordinal 6: USER2 sells F0 → native for itself. */
function shape8aac() {
  const rx = new Rx().xfer(X, WALLET, PM, n(1000))
  const path = [X, ...T, RH_WETH]
  for (let i = 0; i < 6; i++) rx.v4(path[i], path[i + 1], i === 0 ? n(1000) : n(900 - i), i === 5 ? ETH_8AAC : n(900 - i - 1))
  return rx.xfer(F[0], USER2, PM, n(77)).v4(F[0], RH_WETH, n(77), n(1))
}
/** 0xe603 shape: ordinals 0 and 4 are the wallet route Y → T0 → native; 1,2,3,5,6 are other orders in the batch. */
function shapeE603() {
  return new Rx()
    .xfer(Y, WALLET, PM, n(500)).v4(Y, T[0], n(500), n(40))                 // 0: wallet leg
    .xfer(F[0], USER2, PM, n(10)).v4(F[0], RH_WETH, n(10), n(3))            // 1: another order → native
    .xfer(F[1], USER2, PM, n(20)).v4(F[1], F[2], n(20), n(5))               // 2: disjoint order
    .v4(F[2], RH_WETH, n(5), n(2))                                           // 3: its continuation → native
    .v4(T[0], RH_WETH, n(40), ETH_E603)                                      // 4: wallet leg → native
    .v4(RH_WETH, T[1], n(1), n(9))                                           // 5: native → foreign token (route value leaving or another order)
    .xfer(T[2], USER2, PM, n(4)).v4(T[2], T[3], n(4), n(4))                  // 6: disjoint
}

test('1. 0x8aac shape: rejected independent_second_action, swap 6 excluded; graph shows a foreign input into the route asset', () => {
  const rx = shape8aac()
  const m = relayed(rx, nativeProven(ETH_8AAC))
  assert.equal(m.finalClassification, 'independent_second_action')
  assert.deepEqual(m.excludedSwapIndexes, [6])
  assert.match(m.reason, /swap\(s\) 6 are not on the wallet's 0xdee52f2ab639b6942b0d0f0565400b93b7a0fbe5 → native route/)
  const g = graph(rx, m)
  assert.deepEqual(g.connectedActions, [0, 1, 2, 3, 4, 5])
  assert.deepEqual(g.independentActions, [6])
  const six = g.edges.find((e) => e.ordinal === 6)!
  assert.deepEqual([six.kind, six.payer, six.walletTouched], ['input_off_route_into_route', USER2, false])
  assert.equal(g.ancestryChecks.available, false)
})

test('2. 0xe603 shape: rejected, swaps 1,2,3,5,6 excluded; each classified structurally (never a required leg)', () => {
  const rx = shapeE603()
  const m = relayed(rx, nativeProven(ETH_E603))
  assert.equal(m.finalClassification, 'independent_second_action')
  assert.deepEqual(m.excludedSwapIndexes, [1, 2, 3, 5, 6])
  const g = graph(rx, m)
  const kind = Object.fromEntries(g.edges.map((e) => [e.ordinal, e.kind]))
  // 2 (F1 → F2) feeds 3 (F2 → native): a foreign chain INTO the route asset, not an isolated swap.
  assert.deepEqual(kind, { 0: 'connected', 1: 'input_off_route_into_route', 2: 'input_off_route_into_route', 3: 'input_off_route_into_route', 4: 'connected', 5: 'route_value_leaving', 6: 'disjoint' })
})

test('3. multi-user batch: wallet route + another user\'s swaps → independent, never proven', () => {
  const rx = new Rx().xfer(A, WALLET, PM, n(100)).v4(A, RH_WETH, n(100), n(2)).xfer(C, USER2, PM, n(5)).v4(C, D, n(5), n(5)).xfer(D, PM, USER2, n(5))
  const m = relayed(rx, nativeProven(n(2)))
  assert.notEqual(m.finalClassification, 'direct_mixed_route_proven')
  assert.equal(graph(rx, m).edges[1].kind, 'disjoint')
})

test('4. aggregator A → B → WETH → native with exact continuity: every leg connected, proven', () => {
  const rx = new Rx().xfer(A, WALLET, PM, n(100)).v4(A, B, n(100), n(50)).xfer(B, PM, ROUTER, n(50)).xfer(B, ROUTER, P3, n(50)).v3(P3, n(50), n(2)).xfer(RH_WETH, P3, ROUTER, n(2)).unwrap(ROUTER, n(2))
  const m = relayed(rx, nativeProven(n(2)))
  assert.equal(m.finalClassification, 'direct_mixed_route_proven')
  const g = graph(rx, m)
  assert.deepEqual(g.connectedActions, [0, 1])
  assert.ok(g.amountContinuityChecks.every((c) => c.exact), JSON.stringify(g.amountContinuityChecks))
})

test('5. same router, no amount continuity (extra A → native leg paid from outside) → not connected into a proof', () => {
  const rx = new Rx().xfer(A, WALLET, PM, n(100)).v4(A, RH_WETH, n(100), n(2)).xfer(A, ROUTER, PM, n(30)).v4(A, RH_WETH, n(30), n(1))
  const m = relayed(rx, nativeProven(n(2)))
  assert.notEqual(m.finalClassification, 'direct_mixed_route_proven')
})

test('6. same token pair, different payer → rejected (outside funding of the route asset)', () => {
  const rx = new Rx().xfer(A, WALLET, PM, n(100)).v4(A, RH_WETH, n(100), n(2)).xfer(A, USER2, PM, n(100)).v4(A, RH_WETH, n(100), n(2))
  const m = relayed(rx, nativeProven(n(2)))
  assert.equal(m.finalClassification, 'independent_second_action')
})

test('7. router-held intermediate with exact amount continuity → proven (router custody is a pass-through)', () => {
  const rx = new Rx().xfer(A, WALLET, ROUTER, n(100)).xfer(A, ROUTER, PM, n(100)).v4(A, B, n(100), n(50)).xfer(B, PM, ROUTER, n(50)).xfer(B, ROUTER, PM, n(50)).v4(B, RH_WETH, n(50), n(2))
  const m = relayed(rx, nativeProven(n(2)))
  assert.equal(m.finalClassification, 'direct_mixed_route_proven')
  assert.ok(graph(rx, m).amountContinuityChecks.every((c) => c.exact))
})

test('8. a foreign payer of a route asset → rejected (outside funding)', () => {
  const rx = new Rx().xfer(A, WALLET, P2, n(100)).v2(P2, n(100), n(50)).xfer(B, P2, ROUTER, n(50)).xfer(B, OTHER, P3, n(10)).xfer(B, ROUTER, P3, n(50)).v3(P3, n(60), n(3)).xfer(RH_WETH, P3, ROUTER, n(3)).unwrap(ROUTER, n(3))
  const m = relayed(rx, nativeProven(n(3)))
  assert.notEqual(m.finalClassification, 'direct_mixed_route_proven')
})

test('9. complete trace but an unresolvable branch → ambiguous', () => {
  const rx = new Rx().xfer(A, WALLET, PM, n(100)).v4(A, RH_WETH, n(100), n(2)).v3(P3, n(7), n(1))
  const m = relayed(rx, nativeProven(n(2)))
  assert.equal(m.finalClassification, 'ambiguous')
})

test('10. no complete-trace native leg (incomplete / partial trace) → never proven', () => {
  const rx = new Rx().xfer(A, WALLET, PM, n(100)).v4(A, RH_WETH, n(100), n(2))
  assert.notEqual(relayed(rx, nativeNone).finalClassification, 'direct_mixed_route_proven')
})
