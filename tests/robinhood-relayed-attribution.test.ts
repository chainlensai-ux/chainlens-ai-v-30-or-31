// Relayed (wallet_not_tx_sender) attribution: relayed route readings share the one trace budget (sells first) instead
// of only leftover capacity; WETH-pool routes the router wraps / unwraps are readable; gas mechanics (relayer
// compensation, ERC-4337 prefund) and router pass-throughs are never competing payers; every remaining rejection is
// classified A–I. Fixtures mirror the production shapes (relayer-sent V4 buys / sells, native and WETH pools).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import {
  computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest, robinhoodRelayedDiagnosticVerdict, relayedSwapNativeTransfers,
  RH_NATIVE, RH_WETH, RH_V4_POSITION_MANAGER, V4_SWAP_TOPIC0, ERC20_TRANSFER_TOPIC0, ROBINHOOD_NATIVE_TRACE_LIVE_CAP,
  type RhRpc, type RhEthUsdPoint, type RobinhoodPnlV1, type RhReceipt,
} from '../lib/server/robinhoodPnlV1.ts'
import type { RhNativeTransfer } from '../lib/server/robinhoodMixedRouteForensics.ts'

delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

const TS = 1790155166
const WALLET = '0x9d69b5ffb22608d8003508b9c6bd9f6b458d4184'
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const ROUTER = '0x248a454a0000000000000000000000000000beef'
const RELAYER = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'
const ENTRY_POINT = '0x0000000071727de22e5e9d8baf0edac6f37da032'
const PRIORS = '0xaaaa000000000000000000000000000000000001'
const GOOD = '0xbbbb000000000000000000000000000000000002'
const AIRDROP = '0xcccc000000000000000000000000000000000003'
const E18 = BigInt(10) ** BigInt(18)
const n = (x: number) => BigInt(Math.round(x * 1000)) * E18 / BigInt(1000)
const pad = (h: string) => h.replace(/^0x/, '').padStart(64, '0')
const t = (a: string) => `0x${pad(a)}`
const int256 = (v: bigint) => pad((v < BigInt(0) ? (BigInt(1) << BigInt(256)) + v : v).toString(16))
const uint = (v: bigint) => pad(v.toString(16))
const hex = (v: number | bigint) => `0x${BigInt(v).toString(16)}`
const hashN = (i: number) => `0x${(0xa77b0000 + i).toString(16).padStart(64, '0')}`

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
  trace: RhNativeTransfer[] | null = []
  sender = RELAYER
  to: string = ROUTER
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
// ETH → PRIORS on a native V4 pool, relayed; the wallet's own native pays the router.
const relayedBuy = (token: string, eth: bigint, amount: bigint, ts = TS) =>
  new Tx(ts).v4(RH_NATIVE, token, eth, amount).xfer(token, PM, WALLET, amount).traced([WALLET, ROUTER, eth], [ROUTER, PM, eth])
// PRIORS → ETH on a native V4 pool, relayed; the router forwards the ETH to the wallet.
const relayedSell = (token: string, amount: bigint, eth: bigint, ts = TS) =>
  new Tx(ts).xfer(token, WALLET, PM, amount).v4(token, RH_NATIVE, amount, eth).traced([PM, ROUTER, eth], [ROUTER, WALLET, eth])
// PRIORS → WETH (V4) → unwrap → ETH to the wallet.
const relayedWethSell = (token: string, amount: bigint, eth: bigint, ts = TS) =>
  new Tx(ts).xfer(token, WALLET, PM, amount).v4(token, RH_WETH, amount, eth).xfer(RH_WETH, PM, ROUTER, eth).traced([RH_WETH, ROUTER, eth], [ROUTER, WALLET, eth])
// ETH → wrap → WETH (V4) → GOOD.
const relayedWethBuy = (token: string, eth: bigint, amount: bigint, ts = TS) =>
  new Tx(ts).xfer(RH_WETH, ROUTER, PM, eth).v4(RH_WETH, token, eth, amount).xfer(token, PM, WALLET, amount).traced([WALLET, ROUTER, eth], [ROUTER, RH_WETH, eth])
// A wallet-sent native-dependent receipt that also needs a trace (competes for the same slots).
const walletSentBuy = (token: string, eth: bigint, amount: bigint, ts = TS) => {
  const tx = new Tx(ts).v4(RH_NATIVE, token, eth, amount).xfer(token, PM, WALLET, amount).traced([WALLET, ROUTER, eth], [ROUTER, PM, eth])
  tx.sender = WALLET
  return tx
}

const ethAt = async (ts: number): Promise<RhEthUsdPoint | null> => ({ priceUsd: 2600, provider: 'x', endpoint: null, pointMs: Math.floor(ts / 86_400) * 86_400_000, gapMs: (ts % 86_400) * 1000, maxAllowedGapMs: 86_400_000 })
const receiptOf = (tx: Tx, block = 1000): RhReceipt => ({
  status: 1, from: tx.sender, to: tx.to, blockNumber: block, gasUsed: BigInt(1), effectiveGasPrice: BigInt(1),
  logs: tx.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: Number(l.logIndex), blockTimestamp: Number(l.blockTimestamp) })),
} as unknown as RhReceipt)

async function run(txs: Tx[]) {
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
    if (method === 'eth_getTransactionCount') return byHash.get(p[0]) ? '0x1' : '0x1'
    if (method === 'eth_call' && p[0].to === RH_V4_POSITION_MANAGER) return [...POOLS.entries()].find(([id]) => id.slice(2, 52) === String(p[0].data).slice(10, 60))?.[1] ?? null
    if (method === 'eth_call' && p[0].data === '0x313ce567') return hex(18)
    return null
  })
  const lines: Array<[string, any]> = []
  const w = console.warn
  console.warn = (tag: unknown, body: unknown) => { lines.push([String(tag), body]) }
  let r: RobinhoodPnlV1
  try {
    r = await computeRobinhoodPnlV1({
      wallet: WALLET, candidates: txs.map((tx, i) => ({ txHash: hashN(i), timestampMs: tx.ts * 1000, hasSwapLog: true })),
      transactionCount: txs.length, transferCount: txs.length, activityUnavailableReason: null,
      deps: { rpc, now: Date.now, tokenHistoricalUsd: async () => null, ethUsdAt: ethAt, ethUsdRange: async () => null, nativeTransfersForTx: async (h) => { live.push(h); return byHash.get(h)?.tx.trace ?? null } },
    })
  } finally { console.warn = w }
  const rows = lines.filter(([tag, b]) => tag === '[robinhood-relayed-attribution-audit]' && b.txHash).map(([, b]) => b)
  return { r, live, rpcCalls, rows, idx: (h: string) => Number(BigInt(h) - BigInt(hashN(0))) }
}

test('genuine relayed ETH → token buy is verified once', async () => {
  const { r } = await run([relayedBuy(PRIORS, n(0.01), n(100))])
  assert.equal(r.swapsVerified, 1)
  assert.equal(r.ingestionAudit.normalizedBuyCount, 1)
  assert.equal(r.ingestionAudit.relayedWalletVerifiedSwapCount, 1)
})

test('genuine relayed token → ETH sell (native pool) is verified once and normalizes as a sell', async () => {
  const { r } = await run([relayedSell(PRIORS, n(100), n(0.02))])
  assert.equal(r.swapsVerified, 1)
  assert.equal(r.ingestionAudit.normalizedSellCount, 1)
  assert.equal(r.verificationCoverage?.verifiedSells, 1)
})

test('ERC20 → V4 → WETH → unwrap → wallet sell, and ETH → wrap → WETH → V4 buy, are both proven', async () => {
  const { r } = await run([relayedWethBuy(GOOD, n(0.01), n(500), TS - 100), relayedWethSell(GOOD, n(500), n(0.03), TS)])
  assert.equal(r.swapsVerified, 2)
  assert.equal(r.ingestionAudit.normalizedBuyCount, 1)
  assert.equal(r.ingestionAudit.normalizedSellCount, 1)
  assert.equal(r.structuralClosedLots, 1, 'a real verified buy and sell close one FIFO lot')
})

test('externally funded relayed route stays rejected and is class F', async () => {
  const tx = new Tx().v4(RH_NATIVE, PRIORS, n(0.01), n(100)).xfer(PRIORS, PM, WALLET, n(100)).traced([OTHER, ROUTER, n(0.01)], [ROUTER, PM, n(0.01)])
  const { r, rows } = await run([tx])
  assert.equal(r.swapsVerified, 0)
  assert.equal(r.ingestionAudit.rejectionReasons.wallet_not_tx_sender, 1)
  assert.equal(rows[0].attributionClass, 'F_competing_payer')
  assert.deepEqual(rows[0].competingPayers, [OTHER])
  assert.equal(rows[0].walletNativeDebitRaw, '0')
})

test('an unrelated wallet transfer inside another user\'s V4 swap stays rejected and is class G', async () => {
  const tx = new Tx().xfer(PRIORS, OTHER, PM, n(100)).v4(PRIORS, RH_NATIVE, n(100), n(0.02)).xfer(AIRDROP, OTHER, WALLET, n(1)).traced([PM, ROUTER, n(0.02)], [ROUTER, OTHER, n(0.02)])
  const { r, rows } = await run([tx])
  assert.equal(r.swapsVerified, 0)
  assert.equal(rows[0].attributionClass, 'G_unrelated_transfer_in_other_swap')
})

test('router pass-through and ERC-4337 gas mechanics are not competing payers; a genuine third payer is', () => {
  const tx = relayedBuy(PRIORS, n(0.01), n(100))
  tx.to = ENTRY_POINT
  const receipt = receiptOf(tx)
  const poolKeys = new Map([[tx.logs[0].topics[1], { currency0: RH_NATIVE, currency1: PRIORS }]])
  const mechanics = [
    { from: WALLET, to: ENTRY_POINT, value: n(0.001), success: true }, // gas prefund
    { from: ENTRY_POINT, to: RELAYER, value: n(0.0009), success: true }, // bundler compensation
    { from: WALLET, to: ROUTER, value: n(0.01), success: true }, { from: ROUTER, to: PM, value: n(0.01), success: true }, // swap
  ]
  assert.equal(relayedSwapNativeTransfers(mechanics, receipt, WALLET).length, 2)
  const ok = robinhoodRelayedDiagnosticVerdict({ wallet: WALLET, receipt, poolKeys, txValue: BigInt(0), routeInputNativeRaw: n(0.01), trace: { transfers: mechanics, audit: null } })
  assert.equal(ok.verdict, 'wallet_funded_route_candidate')
  assert.deepEqual(ok.competingNativePayers, [])
  const third = robinhoodRelayedDiagnosticVerdict({ wallet: WALLET, receipt, poolKeys, txValue: BigInt(0), routeInputNativeRaw: n(0.01), trace: { transfers: [...mechanics, { from: OTHER, to: ROUTER, value: n(0.002), success: true }, { from: ROUTER, to: OTHER, value: n(0.001), success: true }], audit: null } })
  assert.equal(third.verdict, 'externally_funded_route')
  assert.deepEqual(third.competingNativePayers, [OTHER])
})

test('the one trace budget goes to relayed sells first, then buys — not to leftover capacity only', async () => {
  const txs = [
    walletSentBuy(GOOD, n(0.01), n(10), TS - 500), walletSentBuy(GOOD, n(0.01), n(11), TS - 499), walletSentBuy(GOOD, n(0.01), n(12), TS - 498),
    relayedBuy(PRIORS, n(0.01), n(100), TS - 300), relayedSell(PRIORS, n(100), n(0.02), TS),
  ]
  const { r, live } = await run(txs)
  assert.ok(live.length <= ROBINHOOD_NATIVE_TRACE_LIVE_CAP, `live traces ${live.length}`)
  assert.equal(new Set(live).size, live.length, 'no trace fetched twice')
  assert.ok(live.includes(hashN(4)), 'the relayed sell got a slot')
  assert.equal(r.ingestionAudit.normalizedSellCount, 1)
})

test('every wallet_not_tx_sender rejection is classified; route readings without a trace are A/B, not terminal', async () => {
  const noTrace = (tx: Tx) => { tx.trace = null; return tx }
  const txs = [
    noTrace(relayedBuy(PRIORS, n(0.01), n(100))), // A (trace unavailable)
    noTrace(relayedSell(PRIORS, n(100), n(0.02))), // B (trace unavailable)
    new Tx().xfer(PRIORS, WALLET, PM, n(50)).v4(PRIORS, GOOD, n(50), n(20)).xfer(GOOD, PM, WALLET, n(15)), // C (output skimmed)
    new Tx().xfer(PRIORS, WALLET, PM, n(50)).v4(PRIORS, GOOD, n(50), n(20)).xfer(GOOD, PM, OTHER, n(20)), // E (input only)
    new Tx().xfer(AIRDROP, OTHER, WALLET, n(1)).xfer(PRIORS, OTHER, PM, n(50)).v4(PRIORS, GOOD, n(50), n(20)).xfer(GOOD, PM, OTHER, n(20)), // G
  ]
  const { rows, r } = await run(txs)
  const byIdx = new Map(rows.map((x) => [Number(BigInt(x.txHash) - BigInt(hashN(0))), x.attributionClass]))
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => byIdx.get(i)), ['A_native_in_token_out', 'B_token_in_native_out', 'C_token_in_token_out', 'E_input_only_no_provable_output', 'G_unrelated_transfer_in_other_swap'])
  const a = r.ingestionAudit.relayedAttribution!
  assert.equal(a.routeReadingAwaitingTrace, 2)
  assert.equal(a.classes.A_native_in_token_out + a.classes.B_token_in_native_out + a.classes.C_token_in_token_out + a.classes.E_input_only_no_provable_output + a.classes.G_unrelated_transfer_in_other_swap, 5)
  const row0 = rows.find((x) => x.txHash === hashN(0))!
  for (const k of ['txFrom', 'txTo', 'timestampSec', 'v4SwapLogs', 'walletErc20In', 'walletErc20Out', 'walletNativeDebitRaw', 'walletNativeCreditRaw', 'routeInput', 'routeOutput', 'settlement', 'outputRecipients', 'inputPayers', 'competingPayers', 'traceAvailable', 'traceComplete', 'rejectionBranch']) assert.ok(k in row0, k)
})
