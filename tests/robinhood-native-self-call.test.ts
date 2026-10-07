// Robinhood native attribution: the top-level tx.value is attributed by destination. A wallet→wallet self-call's
// outer value has no net wallet effect; the target-tx trace already carries the real payment (never counted twice).
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import { computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest, RH_NATIVE, RH_WETH, RH_V4_POSITION_MANAGER, V4_SWAP_TOPIC0, ERC20_TRANSFER_TOPIC0, type RhRpc, type RhEthUsdPoint } from '../lib/server/robinhoodPnlV1.ts'
import { V2_SWAP_TOPIC0, V3_SWAP_TOPIC0, WETH_WITHDRAWAL_TOPIC0, deriveRhNativeEvidence, type RhNativeTransfer } from '../lib/server/robinhoodMixedRouteForensics.ts'

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
  to: string = ROUTER
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


const GAS = BigInt(21_000)
const ETH = E18
const ev = (o: { isSender?: boolean; txFrom?: string | null; txTo?: string | null; txValue: bigint | null; trace: RhNativeTransfer[] | null }) => deriveRhNativeEvidence({
  wallet: WALLET, isSender: o.isSender ?? true, gasPaid: GAS, txValue: o.txValue, balanceBefore: null, balanceAfter: null,
  nonceBefore: null, nonceAfter: null, trace: o.trace, txFrom: o.txFrom ?? (o.isSender ?? true ? WALLET : OTHER), ...('txTo' in o ? { txTo: o.txTo } : {}),
})
const pay = (from: string, to: string, value: bigint, success = true): RhNativeTransfer => ({ from, to, value, success })

beforeEach(() => { __resetRobinhoodPnlV1CachesForTest() })

test('1. wallet → external contract, tx.value 1 ETH, no root transfer in the trace → −1 ETH', () => {
  const e = ev({ txTo: ROUTER, txValue: ETH, trace: [pay(ROUTER, OTHER, ETH)] })
  assert.equal(e.status, 'proven_target_tx_native_transfer')
  assert.equal(e.nativeNetExGas, -ETH)
  assert.deepEqual([e.txFrom, e.txTo, e.topLevelNativeNet, e.traceIncludesTopLevelTransfer], [WALLET, ROUTER, (-ETH).toString(), false])
})

test('2. wallet → wallet self-call, tx.value 1 ETH, trace shows the wallet paying 1 ETH internally → −1 ETH, not −2 ETH', () => {
  const e = ev({ txTo: WALLET, txValue: ETH, trace: [pay(WALLET, ROUTER, ETH)] })
  assert.equal(e.nativeNetExGas, -ETH)
  assert.equal(e.topLevelNativeNet, '0')
  assert.equal(e.traceNativeFromWallet, ETH.toString())
  assert.match(e.nativeNetComposition!, /self-call/)
})

test('3. self-call with no internal native movement → 0', () => {
  assert.equal(ev({ txTo: WALLET, txValue: ETH, trace: [] }).nativeNetExGas, BigInt(0))
  assert.equal(ev({ txTo: WALLET, txValue: BigInt(0), trace: [] }).nativeNetExGas, BigInt(0))
})

test('4. an external sender paying the wallet at top level → +value (fails closed when tx.value is unknown)', () => {
  const e = ev({ isSender: false, txFrom: OTHER, txTo: WALLET, txValue: ETH, trace: [] })
  assert.equal(e.status, 'proven_target_tx_native_transfer')
  assert.equal(e.nativeNetExGas, ETH)
  const unknown = ev({ isSender: false, txFrom: OTHER, txTo: WALLET, txValue: null, trace: [] })
  assert.notEqual(unknown.status, 'proven_target_tx_native_transfer')
  assert.equal(unknown.nativeNetExGas, null)
  // a foreign tx that does not touch the wallet at top level needs no tx.value (unchanged)
  assert.equal(ev({ isSender: false, txFrom: OTHER, txTo: ROUTER, txValue: null, trace: [pay(ROUTER, WALLET, ETH)] }).nativeNetExGas, ETH)
})

test('5. a trace that also lists the top-level transfer counts it once', () => {
  const ext = ev({ txTo: ROUTER, txValue: ETH, trace: [pay(WALLET, ROUTER, ETH), pay(ROUTER, OTHER, ETH)] })
  assert.equal(ext.nativeNetExGas, -ETH)
  assert.equal(ext.traceIncludesTopLevelTransfer, true)
  const self = ev({ txTo: WALLET, txValue: ETH, trace: [pay(WALLET, WALLET, ETH), pay(WALLET, ROUTER, ETH)] })
  assert.equal(self.nativeNetExGas, -ETH)
  const incoming = ev({ isSender: false, txFrom: OTHER, txTo: WALLET, txValue: ETH, trace: [pay(OTHER, WALLET, ETH)] })
  assert.equal(incoming.nativeNetExGas, ETH)
  // only an exact (from, to, value) match is the root; a different internal payment still counts
  assert.equal(ev({ txTo: ROUTER, txValue: ETH, trace: [pay(WALLET, ROUTER, ETH / BigInt(2))] }).nativeNetExGas, -ETH - ETH / BigInt(2))
})

test('6. a failed / missing trace stays unverified; failed internal calls move nothing', () => {
  const none = ev({ txTo: WALLET, txValue: ETH, trace: null })
  assert.notEqual(none.status, 'proven_target_tx_native_transfer')
  assert.equal(none.nativeNetExGas, null)
  assert.equal(ev({ txTo: WALLET, txValue: null, trace: [] }).nativeNetExGas, null) // wallet-sent value unknown
  assert.equal(ev({ txTo: WALLET, txValue: ETH, trace: [pay(WALLET, ROUTER, ETH, false)] }).nativeNetExGas, BigInt(0))
})

test('legacy callers (no txTo) keep the previous reading exactly', () => {
  assert.equal(ev({ txValue: ETH, trace: [] }).nativeNetExGas, -ETH)
  assert.equal(ev({ txValue: ETH, trace: [pay(ROUTER, WALLET, ETH / BigInt(4))] }).nativeNetExGas, -ETH + ETH / BigInt(4))
})

// ── 8. production ae3cee / e78711 / f45d8c (wallet 0x5e83…): self-call native-in V4 buys ─────────────────────
const PRODUCTION = [
  ['ae3cee', BigInt('86921999831588739'), BigInt('173843999663177478')],
  ['e78711', BigInt('65190697200666554'), BigInt('130381394401333108')],
  ['f45d8c', BigInt('97784473147681832'), BigInt('195568946295363664')],
] as const

test('8a. production amounts: the pre-fix arithmetic is exactly 2×; the destination-aware net is the trace payment', () => {
  for (const [name, paid, reportedBefore] of PRODUCTION) {
    const trace = [pay(WALLET, ROUTER, paid)]
    const legacy = ev({ txValue: paid, trace }) // pre-fix: tx.value subtracted again on top of the trace
    assert.equal(legacy.nativeNetExGas, -reportedBefore, name)
    assert.equal(reportedBefore, paid * BigInt(2), name)
    const fixed = ev({ txTo: WALLET, txValue: paid, trace })
    assert.equal(fixed.nativeNetExGas, -paid, name)
    assert.equal(fixed.traceNativeFromWallet, paid.toString())
  }
})

const ethAt = async (ts: number): Promise<RhEthUsdPoint | null> => ({ priceUsd: 2600, provider: 'x', endpoint: null, pointMs: Math.floor(ts / 86_400) * 86_400_000, gapMs: (ts % 86_400) * 1000, maxAllowedGapMs: 86_400_000 })
async function runPnl(txs: Tx[]) {
  __resetRobinhoodPnlV1CachesForTest()
  const hashes = txs.map((_, i) => `0x${(0xae3c + i).toString(16).padStart(64, '0')}`)
  const byHash = new Map(hashes.map((h, i) => [h, { tx: txs[i], block: 1000 + i * 10 }]))
  const byBlock = new Map([...byHash.values()].map((v) => [v.block, v]))
  const rpc: RhRpc = async (calls) => calls.map(({ method, params }) => {
    const p = params as any[]
    if (method === 'eth_getTransactionReceipt') { const e = byHash.get(p[0]); return e ? { status: '0x1', from: e.tx.sender, to: e.tx.to, blockNumber: hex(e.block), gasUsed: '0x1', effectiveGasPrice: '0x1', logs: e.tx.logs } : null }
    if (method === 'eth_getTransactionByHash') { const e = byHash.get(p[0]); return e ? { value: hex(e.tx.txValue) } : null }
    if (method === 'eth_getBalance') return hex(BigInt(10) * E18)
    if (method === 'eth_getTransactionCount') return byBlock.has(Number(p[1])) ? '0x2' : '0x1'
    if (method === 'eth_call' && p[0].to === RH_V4_POSITION_MANAGER) return [...POOLS.entries()].find(([id]) => id.slice(2, 52) === String(p[0].data).slice(10, 60))?.[1] ?? null
    if (method === 'eth_call' && p[0].data === '0x313ce567') return hex(18)
    return null
  })
  const w = console.warn
  const forensics: any[] = []
  console.warn = (tag: unknown, body: unknown) => { if (tag === '[robinhood-swap-verification-forensics]') forensics.push(body) }
  try {
    const r = await computeRobinhoodPnlV1({
      wallet: WALLET, candidates: hashes.map((h, i) => ({ txHash: h, timestampMs: TS * 1000 + i, hasSwapLog: true })),
      transactionCount: txs.length, transferCount: txs.length, activityUnavailableReason: null,
      deps: { rpc, now: Date.now, tokenHistoricalUsd: async () => null, ethUsdAt: ethAt, ethUsdRange: async () => null, nativeTransfersForTx: async (h) => byHash.get(h)?.tx.trace ?? null },
    })
    return { r, forensics }
  } finally { console.warn = w }
}

test('8b. production-shaped self-call V4 buys are now verified with the exact traced native input', async () => {
  const txs = PRODUCTION.map(([, paid]) => {
    const tx = directBuy(paid, n(1000))
    tx.to = WALLET // wallet → wallet self-call (the wallet's own code executes the swap)
    tx.trace = [pay(WALLET, ROUTER, paid)]
    return tx
  })
  const { r } = await runPnl(txs)
  assert.equal(r.swapsVerified, 3)
  assert.deepEqual(r.ingestionAudit.rejectionReasons, {})
  const inputs = r.priceEvidence.map((e) => e.inputAmount).sort((a, b) => a - b)
  const paid = PRODUCTION.map(([, v]) => Number(v) / 1e18).sort((a, b) => a - b)
  inputs.forEach((x, i) => assert.ok(Math.abs(x - paid[i]) < 1e-12, `${x} vs ${paid[i]}`))
})

test('a non-self-call native buy is unchanged (wallet → router, value paid at top level)', async () => {
  const { r } = await runPnl([directBuy(n(1), n(1000))])
  assert.equal(r.swapsVerified, 1)
  assert.equal(r.priceEvidence[0].inputAmount, 1)
})
