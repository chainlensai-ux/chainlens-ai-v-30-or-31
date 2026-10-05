// Robinhood mixed-venue route forensics (lib/server/robinhoodMixedRouteForensics.ts). Diagnostic only:
// PnL V1 still rejects every mixed receipt as other_venue_swap_in_tx in this commit.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import { analyzeRobinhoodMixedRoute, V2_SWAP_TOPIC0, V3_SWAP_TOPIC0, WETH_WITHDRAWAL_TOPIC0, WETH_DEPOSIT_TOPIC0, type RhNativeEvidence } from '../lib/server/robinhoodMixedRouteForensics.ts'
import { computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest, RH_V4_POSITION_MANAGER, RH_WETH, type RhPoolKey, type RhReceipt, type RhRpc } from '../lib/server/robinhoodPnlV1.ts'

const WALLET = '0x343f5a0bd465f8ffec69cf2e90152c80397470b9'
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const ROUTER = '0x3333333333333333333333333333333333333333'
const OTHER = '0x2222222222222222222222222222222222222222'
const FEE = '0x5555555555555555555555555555555555555555'
const NATIVE = '0x0000000000000000000000000000000000000000'
const A = '0xaaaa000000000000000000000000000000000001'
const B = '0xbbbb000000000000000000000000000000000002'
const C = '0xcccc000000000000000000000000000000000003'
const D = '0xdddd000000000000000000000000000000000004'
const E = '0xeeee000000000000000000000000000000000005'
const P2 = '0x2000000000000000000000000000000000000002'
const P3 = '0x3000000000000000000000000000000000000003'
const P3b = '0x3000000000000000000000000000000000000004'
const P3c = '0x3000000000000000000000000000000000000005'
const P2b = '0x2000000000000000000000000000000000000006'
const P9 = '0x9000000000000000000000000000000000000009'
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
const nativeProven = (net: bigint): RhNativeEvidence => ({ walletBalanceBefore: n(5).toString(), walletBalanceAfter: (n(5) + net - BigInt(100_000) * BigInt(1_000_000_000)).toString(), gasPaid: (BigInt(100_000) * BigInt(1_000_000_000)).toString(), txValue: '0', walletTxsInBlock: 1, nativeNetExGas: net, status: 'proven' })
const nativeNone: RhNativeEvidence = { walletBalanceBefore: null, walletBalanceAfter: null, gasPaid: '0', txValue: null, walletTxsInBlock: null, nativeNetExGas: null, status: 'unavailable_no_balance_evidence' }
const nativeZero = nativeProven(BigInt(0))
const run = (rx: Rx, native: RhNativeEvidence, from = WALLET) => analyzeRobinhoodMixedRoute({ wallet: WALLET, txHash: '0xfeed', receipt: rx.receipt(from), poolManager: PM, v4PoolKeys: rx.keys, native })

// token A → V4 → B → V3 → WETH → unwrap → native ETH to the wallet
function sellToEthViaV4V3(ethOut = n(2)) {
  return new Rx()
    .xfer(A, WALLET, PM, n(100)).v4(A, B, n(100), n(50)).xfer(B, PM, ROUTER, n(50))
    .xfer(B, ROUTER, P3, n(50)).v3(P3, n(50), ethOut).xfer(RH_WETH, P3, ROUTER, ethOut).unwrap(ROUTER, ethOut)
}

test('1. wallet token -> V4 -> V3 -> native ETH -> wallet: proven with the exact balance proof', () => {
  const r = run(sellToEthViaV4V3(), nativeProven(n(2)))
  assert.equal(r.finalClassification, 'direct_mixed_route_proven', r.reason)
  assert.deepEqual(r.venuesInOrder, ['v4', 'v3'])
  assert.deepEqual([r.walletInputToken, r.walletInputRaw, r.walletOutputToken, r.walletNativeOutputRaw], [A, n(100).toString(), 'native', n(2).toString()])
  assert.deepEqual(r.connectedSwapIndexes, [0, 1])
  assert.equal(r.singleConnectedEconomicRoute && r.amountConservationPassed && r.ownershipProven, true)
  assert.equal(r.v4SignReading, 'negative_is_input')
})

test('2. wallet token -> V3 -> V4 -> token -> wallet', () => {
  const rx = new Rx().xfer(A, WALLET, P3, n(10)).v3(P3, n(10), n(30)).xfer(B, P3, ROUTER, n(30)).xfer(B, ROUTER, PM, n(30)).v4(B, C, n(30), n(7)).xfer(C, PM, WALLET, n(7))
  const r = run(rx, nativeZero)
  assert.equal(r.finalClassification, 'direct_mixed_route_proven', r.reason)
  assert.deepEqual([r.walletOutputToken, r.walletOutputRaw], [C, n(7).toString()])
})

test('3. wallet token -> V4 -> V2 -> V3 -> wallet', () => {
  const rx = new Rx().xfer(A, WALLET, PM, n(10)).v4(A, B, n(10), n(20)).xfer(B, PM, P2, n(20)).v2(P2, n(20), n(40)).xfer(C, P2, P3, n(40)).v3(P3, n(40), n(3)).xfer(D, P3, WALLET, n(3))
  const r = run(rx, nativeZero)
  assert.equal(r.finalClassification, 'direct_mixed_route_proven', r.reason)
  assert.deepEqual(r.venuesInOrder, ['v4', 'v2', 'v3'])
})

test('4. multi-venue route with a bounded protocol fee', () => {
  const rx = new Rx().xfer(A, WALLET, P3, n(10)).v3(P3, n(10), n(30)).xfer(B, P3, ROUTER, n(30)).xfer(B, ROUTER, PM, n(30)).v4(B, C, n(30), n(1000))
    .xfer(C, PM, ROUTER, n(1000)).xfer(C, ROUTER, WALLET, n(995)).xfer(C, ROUTER, FEE, n(5))
  const r = run(rx, nativeZero)
  assert.equal(r.finalClassification, 'direct_mixed_route_proven', r.reason)
  assert.ok(r.retainedFeeFlows.some((f) => f.holder === FEE && f.raw === n(5).toString()))
})

test('5. an independent second swap funded externally -> independent_second_action', () => {
  const rx = sellToEthViaV4V3().xfer(D, OTHER, P9, n(1)).v3(P9, n(1), n(9)).xfer(E, P9, OTHER, n(9))
  const r = run(rx, nativeProven(n(2)))
  assert.equal(r.finalClassification, 'independent_second_action')
  assert.deepEqual(r.excludedSwapIndexes, [2])
})

test('6. a second branch funded from the wallet -> independent_second_action', () => {
  const rx = sellToEthViaV4V3().xfer(D, WALLET, P9, n(1)).v3(P9, n(1), n(9)).xfer(E, P9, OTHER, n(9))
  const r = run(rx, nativeProven(n(2)))
  assert.equal(r.finalClassification, 'independent_second_action')
  assert.match(r.reason, /wallet paid 2 different assets/)
})

test('7. no provable final wallet output (native unproven) -> ambiguous', () => {
  const r = run(sellToEthViaV4V3(), nativeNone)
  assert.equal(r.finalClassification, 'ambiguous')
  assert.match(r.reason, /no provable final wallet output/)
  assert.equal(r.nativeAttributionStatus, 'unavailable_no_balance_evidence')
})

test('8. native payout not uniquely attributable (another wallet tx in the block) -> ambiguous', () => {
  const multi: RhNativeEvidence = { ...nativeProven(n(2)), walletTxsInBlock: 2, nativeNetExGas: null, status: 'unavailable_multiple_wallet_txs_in_block' }
  const r = run(sellToEthViaV4V3(), multi)
  assert.equal(r.finalClassification, 'ambiguous')
  assert.equal(r.nativeAttributionStatus, 'unavailable_multiple_wallet_txs_in_block')
  // and a native credit that does not match the route output fails conservation instead of being accepted.
  const off = run(sellToEthViaV4V3(n(2)), nativeProven(n(3)))
  assert.notEqual(off.finalClassification, 'direct_mixed_route_proven')
})

test('9. a liquidity event mixed into the route -> rejected', () => {
  const r = run(sellToEthViaV4V3().liquidity(), nativeProven(n(2)))
  assert.equal(r.finalClassification, 'independent_second_action')
  assert.match(r.reason, /liquidity/)
})

test('buy with native ETH wrapped by the router is not mistaken for outside funding', () => {
  const rx = new Rx().wrap(ROUTER, n(1)).xfer(RH_WETH, ROUTER, P3, n(1)).v3(P3, n(1), n(40)).xfer(B, P3, PM, n(40)).v4(B, C, n(40), n(9)).xfer(C, PM, WALLET, n(9))
  const r = run(rx, nativeProven(-n(1)))
  assert.equal(r.finalClassification, 'direct_mixed_route_proven', r.reason)
  assert.deepEqual(r.outsideFundingFlows, [])
})

test('a mixed route from a tx the wallet did not send is never proven here', () => {
  assert.equal(run(sellToEthViaV4V3(), nativeProven(n(2)), OTHER).finalClassification, 'ambiguous')
})

// ── 10. Production-shaped fixtures ───────────────────────────────────────────────────────────────
// 53353d07… / 8980c1f1…: wallet sender, 1 canonical V4 swap + 2 V3-style swaps, wallet token outflow, no ERC-20 output.
function shape53353() {
  return new Rx()
    .xfer(A, WALLET, PM, n(1000)).v4(A, B, n(1000), n(80)).xfer(B, PM, ROUTER, n(80))
    .xfer(B, ROUTER, P3, n(80)).v3(P3, n(80), n(25)).xfer(C, P3, P3b, n(25))
    .v3(P3b, n(25), n(3)).xfer(RH_WETH, P3b, ROUTER, n(3)).unwrap(ROUTER, n(3))
}
// e78c513d…: wallet sender, 2 canonical V4 swaps + 5 V2/V3-style swaps (split + merged legs), no ERC-20 output.
function shapeE78c() {
  return new Rx()
    .xfer(A, WALLET, PM, n(600)).v4(A, B, n(600), n(60)).xfer(B, PM, ROUTER, n(60))
    .xfer(B, ROUTER, P3, n(40)).v3(P3, n(40), n(20)).xfer(C, P3, ROUTER, n(20))
    .xfer(B, ROUTER, P2, n(20)).v2(P2, n(20), n(10)).xfer(C, P2, ROUTER, n(10))
    .xfer(C, ROUTER, PM, n(18)).v4(C, D, n(18), n(9)).xfer(D, PM, ROUTER, n(9))
    .xfer(C, ROUTER, P3c, n(12)).v3(P3c, n(12), n(1)).xfer(RH_WETH, P3c, ROUTER, n(1))
    .xfer(D, ROUTER, P3b, n(6)).v3(P3b, n(6), n(2)).xfer(RH_WETH, P3b, ROUTER, n(2))
    .xfer(D, ROUTER, P2b, n(3)).v2(P2b, n(3), n(1)).xfer(RH_WETH, P2b, ROUTER, n(1))
    .unwrap(ROUTER, n(4))
}

test('10a. 53353/8980-shaped: one V4 + two V3, token -> native: proven only with the exact native proof', () => {
  const withProof = run(shape53353(), nativeProven(n(3)))
  assert.equal(withProof.finalClassification, 'direct_mixed_route_proven', withProof.reason)
  assert.deepEqual(withProof.venuesInOrder, ['v4', 'v3', 'v3'])
  assert.deepEqual(withProof.connectedSwapIndexes, [0, 1, 2])
  const withoutProof = run(shape53353(), nativeNone)
  assert.equal(withoutProof.finalClassification, 'ambiguous', 'what production saw: no output leg without the balance proof')
})

test('10b. e78c-shaped: two V4 + five V2/V3 split route, token -> native', () => {
  const r = run(shapeE78c(), nativeProven(n(4)))
  assert.equal(r.finalClassification, 'direct_mixed_route_proven', r.reason)
  assert.equal(r.venuesInOrder.filter((v) => v === 'v4').length, 2)
  assert.equal(r.venuesInOrder.filter((v) => v !== 'v4').length, 5)
  assert.deepEqual(r.excludedSwapIndexes, [])
  assert.equal(run(shapeE78c(), nativeNone).finalClassification, 'ambiguous')
  // the same receipt with one leg diverted to another address is not the wallet's route
  const diverted = shapeE78c().xfer(RH_WETH, ROUTER, OTHER, n(1))
  assert.notEqual(run(diverted, nativeProven(n(3))).finalClassification, 'direct_mixed_route_proven')
})

// ── End-to-end: production-shaped receipt through PnL V1 — acceptance unchanged, forensics logged ──
beforeEach(() => { __resetRobinhoodPnlV1CachesForTest() })

test('PnL V1 still rejects the mixed receipt (other_venue_swap_in_tx) and logs it as direct_mixed_route_proven', async () => {
  const rx = shape53353()
  const hash = `0x${'53'.repeat(32)}`
  const rcpt = { status: '0x1', from: WALLET, to: ROUTER, blockNumber: '0x1f4', gasUsed: '0x186a0', effectiveGasPrice: '0x3b9aca00', logs: rx.logs.map((l) => ({ ...l, logIndex: `0x${l.logIndex.toString(16)}`, blockTimestamp: '0x68e7c000' })) }
  const gas = BigInt(100_000) * BigInt(1_000_000_000)
  const rpc: RhRpc = async (calls) => calls.map(({ method, params }) => {
    const p = params as any[]
    if (method === 'eth_getTransactionReceipt') return p[0] === hash ? rcpt : null
    if (method === 'eth_call' && p[0].to === RH_V4_POSITION_MANAGER) return [...rx.encoded.entries()].find(([id]) => id.slice(2, 52) === String(p[0].data).slice(10, 60))?.[1] ?? null
    if (method === 'eth_getBalance') return `0x${(Number(p[1]) === 499 ? n(5) : n(5) + n(3) - gas).toString(16)}`
    if (method === 'eth_getTransactionCount') return Number(p[1]) === 499 ? '0x7' : '0x8'
    if (method === 'eth_getTransactionByHash') return { value: '0x0' }
    return null
  })
  const lines: Array<[string, any]> = []
  const w = console.warn
  console.warn = (tag: unknown, body: unknown) => { lines.push([String(tag), body]) }
  let r
  try {
    r = await computeRobinhoodPnlV1({ wallet: WALLET, candidates: [{ txHash: hash, timestampMs: null, hasSwapLog: true }], transactionCount: 1, transferCount: 1, activityUnavailableReason: null, deps: { rpc, ethUsdRange: async () => null, tokenHistoricalUsd: async () => null, now: Date.now } })
  } finally { console.warn = w }
  assert.equal(r.swapsVerified, 0, 'acceptance unchanged in this commit')
  assert.deepEqual(r.ingestionAudit.rejectionReasons, { other_venue_swap_in_tx: 1 })
  assert.equal(r.ingestionAudit.mixedRouteClasses?.direct_mixed_route_proven, 1)
  const row = lines.find(([tag]) => tag === '[robinhood-mixed-route-forensics]')?.[1]
  assert.equal(row?.finalClassification, 'direct_mixed_route_proven')
  assert.equal(row?.nativeAttributionStatus, 'proven')
  assert.equal(row?.walletNativeOutputRaw, n(3).toString())
  assert.equal(row?.nativeEvidence.walletTxsInBlock, 1)
})
