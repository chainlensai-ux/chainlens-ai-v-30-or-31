// Robinhood native trace: ONE request-scoped live budget (cap 3) shared by main verification, acquisition recovery and
// deep acquisition. Main takes at most 2 up front; the reserved slot goes to the best eligible recovery candidate, or
// back to main when recovery does not need it. Stored proofs are free. Acceptance rules are unchanged.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import { computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest, ROBINHOOD_NATIVE_TRACE_LIVE_CAP, RH_NATIVE, RH_WETH, RH_V4_POSITION_MANAGER, V4_SWAP_TOPIC0, ERC20_TRANSFER_TOPIC0, type RhRpc, type RhEthUsdPoint, type RobinhoodPnlV1Deps } from '../lib/server/robinhoodPnlV1.ts'
import { V2_SWAP_TOPIC0, V3_SWAP_TOPIC0, WETH_WITHDRAWAL_TOPIC0, type RhNativeTransfer } from '../lib/server/robinhoodMixedRouteForensics.ts'

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
  at(ts: number) { this.ts = ts; for (const l of this.logs as Array<{ blockTimestamp: string }>) l.blockTimestamp = hex(ts); return this }
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


const ethAt = async (ts: number): Promise<RhEthUsdPoint | null> => ({ priceUsd: 2600, provider: 'x', endpoint: null, pointMs: Math.floor(ts / 86_400) * 86_400_000, gapMs: (ts % 86_400) * 1000, maxAllowedGapMs: 86_400_000 })
const sell = (token: string, amount: bigint, ethOut: bigint, ts: number) => new Tx().xfer(token, WALLET, PM, amount).v4(token, RH_NATIVE, amount, ethOut).paysWallet(ethOut).at(ts)
const buy = (token: string, eth: bigint, amount: bigint, ts: number) => { const tx = new Tx().v4(RH_NATIVE, token, eth, amount).xfer(token, PM, WALLET, amount).at(ts); tx.txValue = eth; return tx }
const selfCallBuy = (token: string, eth: bigint, amount: bigint, ts: number) => { const tx = buy(token, eth, amount, ts); tx.to = WALLET; tx.trace = [{ from: WALLET, to: ROUTER, value: eth, success: true }]; return tx }
const mismatchBuy = (token: string, eth: bigint, amount: bigint, ts: number) => { const tx = new Tx().v4(RH_NATIVE, token, eth, amount).xfer(token, PM, WALLET, amount * BigInt(3)).at(ts); tx.txValue = eth; return tx } // wallet credit never reproduced

type Spec = { name: string; tx: Tx; main?: boolean; stored?: boolean; historical?: boolean; traceDelayMs?: number }
async function run(specs: Spec[], extra: Partial<RobinhoodPnlV1Deps> = {}) {
  __resetRobinhoodPnlV1CachesForTest()
  const hashOf = new Map(specs.map((s, i) => [s.name, `0x${(0x5e83 + i).toString(16).padStart(64, '0')}`]))
  const byHash = new Map(specs.map((s, i) => [hashOf.get(s.name)!, { ...s, block: 1000 + i * 10 }]))
  const byBlock = new Map([...byHash.values()].map((v) => [v.block, v]))
  const rpc: RhRpc = async (calls) => calls.map(({ method, params }) => {
    const p = params as any[]
    if (method === 'eth_getTransactionReceipt') { const e = byHash.get(p[0]); return e ? { status: '0x1', from: e.tx.sender, to: e.tx.to, blockNumber: hex(e.block), gasUsed: '0x1', effectiveGasPrice: '0x1', logs: e.tx.logs } : null }
    if (method === 'eth_getTransactionByHash') { const e = byHash.get(p[0]); return e ? { value: hex(e.tx.txValue) } : null }
    if (method === 'eth_getBalance') return hex(BigInt(10) * E18)
    if (method === 'eth_getTransactionCount') return byBlock.get(Number(p[1]))?.tx.sender === WALLET ? '0x2' : '0x1'
    if (method === 'eth_call' && p[0].to === RH_V4_POSITION_MANAGER) return [...POOLS.entries()].find(([id]) => id.slice(2, 52) === String(p[0].data).slice(10, 60))?.[1] ?? null
    if (method === 'eth_call' && p[0].data === '0x313ce567') return hex(18)
    return null
  })
  const liveCalls: string[] = []
  const lines: Array<[string, any]> = []
  const name = (h: string) => byHash.get(h)?.name
  const historicalRows = specs.filter((s) => s.historical).map((s) => ({ txHash: hashOf.get(s.name)!, timestampMs: s.tx.ts * 1000, token: A, rawAmount: '1' }))
  const w = console.warn
  console.warn = (tag: unknown, body: unknown) => { lines.push([String(tag), body]) }
  try {
    const r = await computeRobinhoodPnlV1({
      wallet: WALLET, candidates: specs.filter((s) => s.main).map((s) => ({ txHash: hashOf.get(s.name)!, timestampMs: s.tx.ts * 1000, hasSwapLog: true })),
      transactionCount: specs.length, transferCount: specs.length, activityUnavailableReason: null,
      deps: {
        rpc, now: Date.now, tokenHistoricalUsd: async () => null, ethUsdAt: ethAt, ethUsdRange: async () => null,
        nativeTransfersForTx: async (h) => {
          const e = byHash.get(h)!
          liveCalls.push(e.name)
          if (e.traceDelayMs) await new Promise((res) => setTimeout(res, e.traceDelayMs))
          return e.tx.trace
        },
        // These scenarios exercise allocator mechanics with three slots (2 main + 1 recovery reserve); production uses
        // ROBINHOOD_NATIVE_TRACE_LIVE_CAP (5), covered by tests/robinhood-native-trace-cap.test.ts.
        nativeTraceLiveCap: 3,
        nativeTraceCached: async (h) => { const e = byHash.get(h); return e?.stored && e.tx.trace ? { transfers: e.tx.trace, audit: null } : null },
        historicalTokenInbounds: historicalRows.length ? async () => ({
          rows: historicalRows, pagesRequested: 1, pagesSucceeded: 1, olderInboundRowsFound: historicalRows.length,
          historicalRangeStart: null, historicalRangeEnd: null, stopReason: 'history_exhausted',
        }) : undefined,
        ...extra,
      },
    })
    const global = lines.filter(([t]) => t === '[robinhood-native-trace-global-budget-audit]').map(([, b]) => b)
    const recoverySel = lines.filter(([t]) => t === '[robinhood-native-trace-recovery-selection-audit]').map(([, b]) => ({ ...b, name: name(b.candidateTxHash) }))
    const traceAudits = lines.filter(([t]) => t === '[robinhood-native-trace-audit]').map(([, b]) => ({ ...b, name: name(b.txHash) }))
    return { r, liveCalls, global: global[global.length - 1], recoverySel, traceAudits, name }
  } finally { console.warn = w }
}

// Production 0x5e83… shape: 4 stored main proofs, 3 live-eligible main receipts, a verified sell of A that stays
// FIFO-unmatched, and 8 historical wallet-sent candidates found by deep acquisition (none in the main sample).
const C_TOKEN = '0xcccc000000000000000000000000000000000003'
function production(opts: { recoveryStored?: boolean; recoveryTerminal?: boolean; recoveryFails?: boolean; delays?: number[] } = {}): Spec[] {
  const specs: Spec[] = [
    { name: 'SELL', tx: sell(A, n(1000), n(2), TS), main: true, stored: true },
    { name: 'S1', tx: buy(B, n(0.1), n(10), TS - 50), main: true, stored: true },
    { name: 'S2', tx: buy(B, n(0.2), n(20), TS - 60), main: true, stored: true },
    { name: 'S3', tx: buy(B, n(0.3), n(30), TS - 70), main: true, stored: true },
    { name: 'M1', tx: buy(C_TOKEN, n(0.01), n(1), TS - 300), main: true, traceDelayMs: opts.delays?.[0] },
    { name: 'M2', tx: buy(C_TOKEN, n(0.02), n(2), TS - 200), main: true, traceDelayMs: opts.delays?.[1] },
    { name: 'M3', tx: buy(C_TOKEN, n(0.03), n(3), TS - 100), main: true, traceDelayMs: opts.delays?.[2] },
  ]
  // H0 is the newest historical candidate (and buys all 1000 A); H1..H7 are older wallet-sent buys of A.
  const h0 = opts.recoveryTerminal ? mismatchBuy(A, n(1), n(1000), TS - 10_000) : selfCallBuy(A, n(1), n(1000), TS - 10_000)
  if (opts.recoveryFails) h0.trace = null
  specs.push({ name: 'H0', tx: h0, historical: true, stored: opts.recoveryStored, traceDelayMs: opts.delays?.[3] })
  for (let k = 1; k < 8; k++) specs.push({ name: `H${k}`, tx: buy(A, n(0.01), n(5), TS - 10_000 - k * 100), historical: true })
  return specs
}

beforeEach(() => { __resetRobinhoodPnlV1CachesForTest() })

test('production shape: main live 2 + recovery live 1 = 3; the historical self-call buy is proven and closes the sell', async () => {
  const { r, liveCalls, global, recoverySel, traceAudits } = await run(production())
  assert.equal(ROBINHOOD_NATIVE_TRACE_LIVE_CAP, 5) // production cap; this scenario pins 3 slots
  assert.deepEqual(liveCalls.slice().sort(), ['H0', 'M1', 'M2'])
  assert.deepEqual([global.totalCap, global.mainLiveUsed, global.recoveryLiveUsed, global.totalLiveUsed], [3, 2, 1, 3])
  assert.deepEqual([global.storedProofHitsMain, global.mainEligibleDeferredForRecovery, global.recoverySelected, global.reservedSlotReleasedToMain], [4, 1, 1, false])
  assert.ok(global.recoveryEligible >= 1)
  // no recovery trace was refused by an exhausted provider lane
  assert.equal(traceAudits.filter((a) => a.name?.startsWith('H') && a.result === 'budget_exhausted').length, 0)
  const h0 = recoverySel.find((s) => s.name === 'H0')
  assert.deepEqual([h0.phase, h0.traceEligible, h0.storedProofHit, h0.selectedForLiveTrace, h0.globalLiveOrdinal, h0.skippedReason], ['deep_acquisition', true, false, true, 3, null])
  // the recovered buy went through the unchanged verifier with self-call accounting (input = the traced 1 ETH)
  assert.equal(r.deepAcquisition?.verifiedBuysRecovered, 1)
  assert.equal(r.deepAcquisition?.unmatchedSellRawAfter, '0')
  assert.equal(r.priceEvidence.find((e) => e.outputToken === A && e.inputToken === RH_NATIVE)?.inputAmount, 1)
  assert.equal(r.verifiedClosedLots, 1)
  // M3 (the deferred main receipt) made no provider call
  assert.ok(!liveCalls.includes('M3'))
  assert.equal(r.ingestionAudit.nativeTraceGlobalBudget?.totalLiveUsed, 3)
})

test('no unmatched sell → the reserved slot is released to the next main receipt', async () => {
  const specs = production().filter((s) => s.name !== 'SELL' && !s.historical)
  const { r, liveCalls, global } = await run(specs)
  assert.deepEqual(liveCalls.slice().sort(), ['M1', 'M2', 'M3'])
  assert.deepEqual([global.mainLiveUsed, global.recoveryLiveUsed, global.totalLiveUsed, global.reservedSlotReleasedToMain], [3, 0, 3, true])
  assert.equal(r.swapsVerified, 6)
})

test('a recovery candidate with a stored proof uses no live slot, and the reserved slot returns to main', async () => {
  const { r, liveCalls, global, recoverySel } = await run(production({ recoveryStored: true }))
  assert.deepEqual(liveCalls.slice().sort(), ['M1', 'M2', 'M3'])
  assert.deepEqual([global.mainLiveUsed, global.recoveryLiveUsed, global.storedProofHitsRecovery, global.reservedSlotReleasedToMain], [3, 0, 1, true])
  assert.equal(recoverySel.find((s) => s.name === 'H0').storedProofHit, true)
  assert.equal(r.deepAcquisition?.verifiedBuysRecovered, 1)
})

test('a structurally terminal recovery candidate takes no slot (it goes to the best eligible one, else back to main)', async () => {
  const { liveCalls, global, recoverySel } = await run(production({ recoveryTerminal: true }))
  const h0 = recoverySel.find((s) => s.name === 'H0')
  assert.deepEqual([h0.traceEligible, h0.selectedForLiveTrace, h0.skippedReason], [false, false, 'terminal_without_native_trace'])
  assert.ok(!liveCalls.includes('H0'))
  assert.ok(global.totalLiveUsed <= 3)
  assert.equal(liveCalls.length, global.totalLiveUsed)
})

test('a recovery trace transport failure fails closed', async () => {
  const { r, liveCalls, global } = await run(production({ recoveryFails: true }))
  assert.ok(liveCalls.includes('H0'))
  assert.equal(global.totalLiveUsed, 3)
  assert.ok((r.deepAcquisition?.verifiedBuysRecovered ?? 0) === 0 || !r.priceEvidence.some((e) => e.swapTxHash && e.inputAmount === 1 && e.outputToken === A))
  assert.equal(r.verifiedClosedLots, 0)
})

test('total live provider calls never exceed 3, and allocation is deterministic whatever order traces complete in', async () => {
  const a = await run(production({ delays: [30, 5, 1, 20] }))
  const b = await run(production({ delays: [1, 30, 20, 5] }))
  for (const x of [a, b]) {
    assert.ok(x.liveCalls.length <= 3)
    assert.equal(x.global.totalLiveUsed, x.liveCalls.length)
  }
  assert.deepEqual(a.liveCalls.slice().sort(), b.liveCalls.slice().sort())
  assert.deepEqual(a.global, b.global)
  assert.deepEqual(a.recoverySel.map((s) => [s.name, s.selectedForLiveTrace, s.globalLiveOrdinal]), b.recoverySel.map((s) => [s.name, s.selectedForLiveTrace, s.globalLiveOrdinal]))
  assert.deepEqual(a.r.priceEvidence, b.r.priceEvidence)
})
