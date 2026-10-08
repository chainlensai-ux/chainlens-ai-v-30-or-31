// Robinhood relayed V4 native-input candidates: lowest-priority native trace (unused live capacity of the request
// allocator). Only an exact-trace wallet_funded_route_candidate that replays through the unchanged V4 verifier becomes
// relayed_wallet_swap_proven; every other verdict stays wallet_not_tx_sender.
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
    if (method === 'eth_getTransactionByHash') {
      const e = byHash.get(p[0])
      const override = (e?.tx as unknown as { txResponse?: unknown } | undefined)?.txResponse
      if (override === 'throw') throw new Error('rpc down')
      return e ? (override !== undefined ? override : { value: hex(e.tx.txValue) }) : null
    }
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
    const relayed = lines.filter(([t]) => t === '[robinhood-relayed-native-trace-audit]').map(([, b]) => b)
    return { r, liveCalls, global: global[global.length - 1], recoverySel, traceAudits, name, relayed }
  } finally { console.warn = w }
}


const RELAYER = '0x7777777777777777777777777777777777777777'
// A relayed V4 buy delivering `amount` A to the wallet for `eth` native, sent by a relayer.
function relayedBuy(eth: bigint, amount: bigint, ts: number, trace: RhNativeTransfer[] | null, opts: { to?: string; value?: bigint } = {}) {
  const tx = new Tx().v4(RH_NATIVE, A, eth, amount).xfer(A, PM, WALLET, amount).at(ts)
  tx.sender = RELAYER
  tx.to = opts.to ?? ROUTER
  tx.txValue = opts.value ?? BigInt(0)
  tx.trace = trace
  return tx
}
const pay = (from: string, to: string, value: bigint): RhNativeTransfer => ({ from, to, value, success: true })

async function scan(specs: Array<{ name: string; tx: Tx; traceResult?: unknown }>, extra: Partial<RobinhoodPnlV1Deps> = {}) {
  return run(specs.map((s) => ({ name: s.name, tx: s.tx, main: true })), {
    nativeTransfersForTx: async (h) => {
      const i = Number(BigInt(h) - BigInt(0x5e83))
      const s = specs[i]
      calls.push(s.name)
      return (s.traceResult as never) ?? s.tx.trace
    },
    ...extra,
  }).then((x) => ({ ...x, calls: calls.splice(0) }))
}
const calls: string[] = []
const relayedAudit = (lines: Awaited<ReturnType<typeof run>>, name: string) => lines.relayed.find((a) => lines.name(a.txHash) === name)

beforeEach(() => { __resetRobinhoodPnlV1CachesForTest(); calls.length = 0 })

test('1. relayed V4-only buy, trace shows the wallet paying exactly the route input → promoted relayed_wallet_swap_proven', async () => {
  const eth = BigInt('27834402594801934')
  const x = await scan([{ name: 'R', tx: relayedBuy(eth, n(1000), TS, [pay(WALLET, ROUTER, eth), pay(ROUTER, PM, eth)]) }])
  const a = relayedAudit(x, 'R')
  assert.equal(a.diagnosticVerdict, 'wallet_funded_route_candidate')
  assert.deepEqual([a.txFrom, a.txTo, a.routeInputNativeRaw, a.routeOutputToken, a.routeOutputRaw], [RELAYER, ROUTER, eth.toString(), A, n(1000).toString()])
  assert.deepEqual([a.selectedForDiagnosticTrace, a.liveBudgetOrdinal, a.traceComplete, a.traceNativeFromWalletRaw, a.tracedWalletNetRaw, a.walletNativeDebitMatchesRoute, a.competingNativePayers, a.topLevelValueIntoWallet],
    [true, 1, true, eth.toString(), (-eth).toString(), true, [], '0'])
  assert.deepEqual([a.promotedTo, a.acceptance], ['relayed_wallet_swap_proven', 'relayed_v4'])
  assert.equal(x.r.swapsVerified, 1)
  assert.deepEqual(x.r.ingestionAudit.rejectionReasons, {})
  assert.equal(x.r.ingestionAudit.relayedNativeTraceDiagnostics?.verdicts.wallet_funded_route_candidate, 1)
})

test('2. the relayer funds the wallet at top level and the wallet forwards the same value → externally_funded_route', async () => {
  const eth = n(1)
  const x = await scan([{ name: 'R', tx: relayedBuy(eth, n(1000), TS, [pay(WALLET, ROUTER, eth), pay(ROUTER, PM, eth)], { to: WALLET, value: eth }) }])
  const a = relayedAudit(x, 'R')
  assert.deepEqual([a.diagnosticVerdict, a.tracedWalletNetRaw, a.topLevelValueIntoWallet, a.competingNativePayers], ['externally_funded_route', '0', eth.toString(), [RELAYER]])
  assert.equal(x.r.swapsVerified, 0)
})

test('3. no native transfer from the wallet (somebody else paid) → no_wallet_native_debit', async () => {
  const eth = n(1)
  const x = await scan([{ name: 'R', tx: relayedBuy(eth, n(1000), TS, [pay(ROUTER, PM, eth)], { value: eth }) }])
  const a = relayedAudit(x, 'R')
  assert.equal(a.diagnosticVerdict, 'no_wallet_native_debit')
  assert.equal(a.traceNativeFromWalletRaw, '0')
})

test('4. an incomplete / malformed trace → ambiguous_trace; a transport failure → trace_unavailable', async () => {
  const eth = n(1)
  for (const [result, verdict] of [['pagination_cap_exhausted', 'ambiguous_trace'], ['malformed', 'ambiguous_trace'], ['transport_failed', 'trace_unavailable']] as const) {
    __resetRobinhoodPnlV1CachesForTest()
    const x = await scan([{ name: 'R', tx: relayedBuy(eth, n(1000), TS, null), traceResult: { transfers: null, audit: { result } } }])
    assert.equal(relayedAudit(x, 'R').diagnosticVerdict, verdict, result)
    assert.equal(relayedAudit(x, 'R').traceComplete, false)
  }
})

// POLICY (relayed route construction): a relayed mixed (V4 + V3) route whose only missing wallet side is native is
// trace-eligible; the mixed-route flow proof (ownership from economic flows) then promotes it with the exact trace.
test('5. a relayed mixed-route buy is trace-eligible and, with the wallet\'s exact native debit, proven once', async () => {
  const mixed = new Tx().v4(RH_NATIVE, B, n(1), n(80)).xfer(B, PM, P3, n(80)).v3(P3, n(80), n(25)).xfer(C, P3, WALLET, n(25)).at(TS)
  mixed.sender = RELAYER
  mixed.trace = [pay(WALLET, ROUTER, n(1))]
  const x = await scan([{ name: 'M', tx: mixed }])
  assert.deepEqual(x.calls, ['M'])
  assert.equal(relayedAudit(x, 'M').promotedTo, 'relayed_wallet_swap_proven')
  assert.equal(x.r.swapsVerified, 1)
  assert.equal(x.r.ingestionAudit.normalizedBuyCount, 1)
})

test('6. a relayed tx with an unrelated wallet token flow gets no diagnostic trace', async () => {
  const tx = relayedBuy(n(1), n(1000), TS, [pay(WALLET, ROUTER, n(1))]).xfer(D, WALLET, OTHER, n(3))
  const x = await scan([{ name: 'U', tx }])
  assert.equal(x.relayed.length, 0)
  assert.deepEqual(x.calls, [])
})

test('7/8. direct wallet-sent candidates keep priority; total live trace calls stay <= 3', async () => {
  const direct = (k: number) => { const t = new Tx().v4(RH_NATIVE, B, n(0.01 * (k + 1)), n(k + 1)).xfer(B, PM, WALLET, n(k + 1)).at(TS - 100 * (k + 1)); t.txValue = n(0.01 * (k + 1)); return t }
  const relayed = relayedBuy(n(1), n(1000), TS - 50, [pay(WALLET, ROUTER, n(1))])
  const x = await scan([{ name: 'D0', tx: direct(0) }, { name: 'D1', tx: direct(1) }, { name: 'D2', tx: direct(2) }, { name: 'R', tx: relayed }])
  assert.deepEqual(x.calls.slice().sort(), ['D0', 'D1', 'D2'])
  assert.equal(x.r.swapsVerified, 3)
  const a = relayedAudit(x, 'R')
  assert.deepEqual([a.selectedForDiagnosticTrace, a.diagnosticVerdict, a.skippedReason], [false, 'trace_unavailable', 'no_unused_live_capacity'])
  // only unused capacity: one direct receipt + three relayed → 1 main, then the relayed fill the rest, never beyond the cap
  __resetRobinhoodPnlV1CachesForTest()
  const y = await scan([{ name: 'D0', tx: direct(0) },
    { name: 'R1', tx: relayedBuy(n(1), n(1000), TS - 40, [pay(WALLET, ROUTER, n(1))]) },
    { name: 'R2', tx: relayedBuy(n(1), n(1000), TS - 30, [pay(WALLET, ROUTER, n(1))]) },
    { name: 'R3', tx: relayedBuy(n(1), n(1000), TS - 20, [pay(WALLET, ROUTER, n(1))]) }])
  assert.ok(y.calls.length <= ROBINHOOD_NATIVE_TRACE_LIVE_CAP)
  assert.deepEqual(y.calls, ['D0', 'R1', 'R2'])
  assert.equal(y.global.totalLiveUsed, 3)
  assert.equal(y.global.relayedDiagnosticLiveUsed, 2)
  assert.equal(relayedAudit(y, 'R3').diagnosticVerdict, 'trace_unavailable')
  assert.equal(y.r.swapsVerified, 3) // D0 direct + R1 / R2 relayed; R3 had no slot and stays wallet_not_tx_sender
  assert.deepEqual(y.r.ingestionAudit.rejectionReasons, { wallet_not_tx_sender: 1 })
  assert.equal(y.r.ingestionAudit.relayedWalletRejectedReasons?.trace_unavailable, 1)
})

// ── Promotion: production d861… geometry and the rejections ──────────────────────────────────────────────────
test('production d861… shape: wallet internally pays the exact native input → one relayed_wallet_swap_proven buy', async () => {
  const eth = BigInt('41050538212203691')
  const out = BigInt('292180306497565869468771')
  const x = await scan([{ name: 'D861', tx: relayedBuy(eth, out, TS, [pay(WALLET, ROUTER, eth), pay(ROUTER, PM, eth)]) }])
  const a = relayedAudit(x, 'D861')
  assert.deepEqual([a.routeInputNativeRaw, a.traceNativeFromWalletRaw, a.traceNativeToWalletRaw, a.tracedWalletNetRaw, a.walletNativeDebitMatchesRoute, a.competingNativePayers, a.topLevelValueIntoWallet, a.traceComplete, a.diagnosticVerdict],
    [eth.toString(), eth.toString(), '0', (-eth).toString(), true, [], '0', true, 'wallet_funded_route_candidate'])
  const ia = x.r.ingestionAudit
  assert.equal(ia.verifiedSwapTxCount, 1)
  assert.equal(ia.normalizedBuyCount, 1)
  assert.equal(ia.directV4VerifiedSwapCount, 0)
  assert.equal(ia.relayedWalletVerifiedSwapCount, 1)
  assert.equal(ia.relayedWalletRejectedCount, 0)
  assert.equal(ia.v4AttributionClasses?.relayed_wallet_swap_proven, 1)
  const e = x.r.priceEvidence[0]
  assert.deepEqual([e.inputToken, e.outputToken], [RH_NATIVE, A])
  assert.ok(Math.abs(e.inputAmount - Number(eth) / 1e18) < 1e-12)
})

async function rejected(tx: Tx, reason: RegExp | string) {
  __resetRobinhoodPnlV1CachesForTest()
  const x = await scan([{ name: 'X', tx }])
  assert.equal(x.r.swapsVerified, 0)
  assert.equal(x.r.ingestionAudit.relayedWalletVerifiedSwapCount ?? 0, 0)
  assert.deepEqual(x.r.ingestionAudit.rejectionReasons, { wallet_not_tx_sender: 1 })
  const a = relayedAudit(x, 'X')
  if (reason === 'not_a_candidate') { assert.equal(a, undefined); return }
  assert.equal(a.promotedTo, null)
  assert.match(a.promotionRejectionReason, reason instanceof RegExp ? reason : new RegExp(`^${reason}$`))
}

test('rejections: somebody else pays / relayer funds-and-forwards / competing payer / bad trace / debit mismatch', async () => {
  const eth = n(1)
  await rejected(relayedBuy(eth, n(1000), TS, [pay(ROUTER, PM, eth)], { value: eth }), 'no_wallet_native_debit') // somebody else's swap paying the wallet
  await rejected(relayedBuy(eth, n(1000), TS, [pay(WALLET, ROUTER, eth), pay(ROUTER, PM, eth)], { to: WALLET, value: eth }), 'externally_funded_route')
  await rejected(relayedBuy(eth, n(1000), TS, [pay(WALLET, ROUTER, eth / BigInt(2)), pay(OTHER, ROUTER, eth / BigInt(2)), pay(ROUTER, PM, eth)]), 'externally_funded_route')
  await rejected(relayedBuy(eth, n(1000), TS, [pay(WALLET, ROUTER, eth / BigInt(2))]), 'ambiguous_trace') // wallet debit does not reproduce the route input
  for (const result of ['pagination_cap_exhausted', 'malformed', 'unknown_execution_status']) {
    __resetRobinhoodPnlV1CachesForTest()
    const x = await scan([{ name: 'X', tx: relayedBuy(eth, n(1000), TS, null), traceResult: { transfers: null, audit: { result } } }])
    assert.equal(x.r.swapsVerified, 0, result)
    assert.equal(relayedAudit(x, 'X').promotionRejectionReason, 'ambiguous_trace')
  }
})

test('rejections: unrelated token transfer, co-funded mixed route, multiple-V4-route ambiguity never become relayed swaps', async () => {
  const eth = n(1)
  await rejected(relayedBuy(eth, n(1000), TS, [pay(WALLET, ROUTER, eth)]).xfer(D, WALLET, OTHER, n(3)), 'not_a_candidate')
  // a relayed mixed route another address co-funds natively stays rejected (competing payer)
  const mixed = new Tx().v4(RH_NATIVE, B, eth, n(80)).xfer(B, PM, P3, n(80)).v3(P3, n(80), n(25)).xfer(C, P3, WALLET, n(25)).at(TS)
  mixed.sender = RELAYER
  mixed.trace = [pay(WALLET, ROUTER, eth / BigInt(2)), pay(OTHER, ROUTER, eth / BigInt(2))]
  await rejected(mixed, 'externally_funded_route')
  // two identical native → A hops, one wallet credit: two paths reproduce it — ambiguous, not one connected route
  const twice = new Tx().v4(RH_NATIVE, A, eth, n(1000)).v4(RH_NATIVE, A, eth, n(1000)).xfer(A, PM, WALLET, n(1000)).at(TS)
  twice.sender = RELAYER
  twice.trace = [pay(WALLET, ROUTER, eth)]
  await rejected(twice, 'not_a_candidate')
})

// ── Top-level tx.value must be known exactly; a nonzero top-level value always enters the payer analysis ─────────
test('unknown top-level tx.value (lookup failed / malformed) → diagnostic may look wallet-funded, but promotion fails closed', async () => {
  const eth = n(1)
  for (const resp of [null, { value: 'zz' }, {}, 'throw']) {
    __resetRobinhoodPnlV1CachesForTest()
    const tx = relayedBuy(eth, n(1000), TS, [pay(WALLET, ROUTER, eth), pay(ROUTER, PM, eth)])
    ;(tx as unknown as { txResponse: unknown }).txResponse = resp
    const x = await scan([{ name: 'X', tx }])
    const a = relayedAudit(x, 'X')
    assert.equal(a.diagnosticVerdict, 'wallet_funded_route_candidate', JSON.stringify(resp))
    assert.deepEqual([a.txValueKnown, a.txValueRaw, a.promotedTo, a.promotionRejectionReason], [false, null, null, 'top_level_tx_value_unavailable'])
    assert.equal(x.r.ingestionAudit.verifiedSwapTxCount, 0)
    assert.deepEqual(x.r.ingestionAudit.rejectionReasons, { wallet_not_tx_sender: 1 })
    assert.equal(x.r.ingestionAudit.relayedWalletRejectedReasons?.top_level_tx_value_unavailable, 1)
  }
})

test('a relayer sending nonzero top-level value to the router while the wallet also pays → competing payer, no promotion', async () => {
  const eth = n(1)
  const x = await scan([{ name: 'X', tx: relayedBuy(eth, n(1000), TS, [pay(WALLET, ROUTER, eth), pay(ROUTER, PM, eth)], { to: ROUTER, value: eth / BigInt(2) }) }])
  const a = relayedAudit(x, 'X')
  assert.deepEqual([a.txValueKnown, a.txValueRaw, a.competingNativePayers, a.diagnosticVerdict, a.promotedTo], [true, (eth / BigInt(2)).toString(), [RELAYER], 'externally_funded_route', null])
  assert.equal(x.r.swapsVerified, 0)
  // the same top-level transfer also listed in the trace is counted once (still the relayer's funding)
  __resetRobinhoodPnlV1CachesForTest()
  const y = await scan([{ name: 'X', tx: relayedBuy(eth, n(1000), TS, [pay(RELAYER, ROUTER, eth / BigInt(2)), pay(WALLET, ROUTER, eth), pay(ROUTER, PM, eth)], { to: ROUTER, value: eth / BigInt(2) }) }])
  assert.deepEqual(relayedAudit(y, 'X').competingNativePayers, [RELAYER])
  assert.equal(y.r.swapsVerified, 0)
})

test('a nonzero top-level value that is fully returned to the relayer is accounted for and does not block wallet-alone funding', async () => {
  const eth = n(1)
  const refund = eth / BigInt(10)
  const x = await scan([{ name: 'X', tx: relayedBuy(eth, n(1000), TS, [pay(WALLET, ROUTER, eth), pay(ROUTER, PM, eth), pay(ROUTER, RELAYER, refund)], { to: ROUTER, value: refund }) }])
  const a = relayedAudit(x, 'X')
  assert.deepEqual([a.txValueKnown, a.txValueRaw, a.competingNativePayers, a.diagnosticVerdict, a.promotedTo], [true, refund.toString(), [], 'wallet_funded_route_candidate', 'relayed_wallet_swap_proven'])
  assert.equal(x.r.swapsVerified, 1)
})
