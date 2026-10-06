// Robinhood PnL V1 acquisition recovery: a verified sell the FIFO left unmatched searches backward (bounded)
// for earlier inbounds of the exact sold token. Only a wallet-funded, connected route is a buy.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import { computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest, RH_NATIVE, RH_WETH, RH_V4_POSITION_MANAGER, V4_SWAP_TOPIC0, ERC20_TRANSFER_TOPIC0, ROBINHOOD_ACQUISITION_RECOVERY_LIMITS, type RhRpc, type RobinhoodPnlV1Deps, type RhEthUsdPoint } from '../lib/server/robinhoodPnlV1.ts'
import { V2_SWAP_TOPIC0, V3_SWAP_TOPIC0, WETH_WITHDRAWAL_TOPIC0, type RhNativeTransfer } from '../lib/server/robinhoodMixedRouteForensics.ts'

const TS = 1790155166 // production 53353d… sell
const OUT_WEI = BigInt('32288571310109712')
const SELL_RAW = BigInt('346664315894013353')
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

const RELAYER = '0x7777777777777777777777777777777777777777'
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
const P5 = '0x5000000000000000000000000000000000000005'
const P6 = '0x6000000000000000000000000000000000000006'

// Sell of `aIn` A through A → V4 → B → V3 → C → V3 → WETH → unwrap → native ETH to the wallet (53353d… shape).
function sellShape(aIn: bigint, ethOut: bigint) {
  return new Tx()
    .xfer(A, WALLET, PM, aIn).v4(A, B, aIn, n(80)).xfer(B, PM, ROUTER, n(80))
    .xfer(B, ROUTER, P3, n(80)).v3(P3, n(80), n(25)).xfer(C, P3, P3b, n(25))
    .v3(P3b, n(25), ethOut).xfer(RH_WETH, P3b, ROUTER, ethOut).unwrap(ROUTER, ethOut)
    .paysWallet(ethOut)
}
// Relayed buy: the wallet's WETH (transferFrom by the router) → V3 → A delivered to the wallet; tx sent by a relayer.
function relayedBuy(weth: bigint, aOut: bigint, ts = TS - 86_400) {
  const tx = new Tx().xfer(RH_WETH, WALLET, ROUTER, weth).xfer(RH_WETH, ROUTER, P5, weth).v3(P5, weth, aOut).xfer(A, P5, WALLET, aOut)
  tx.sender = RELAYER
  tx.trace = null
  return tx.at(ts)
}
const relayed = (tx: Tx, ts = TS - 86_400) => { tx.sender = RELAYER; tx.trace = null; return tx.at(ts) }
const dayStart = (ts: number) => Math.floor(ts * 1000 / 86_400_000) * 86_400_000
const ethAt = (price: number) => async (ts: number): Promise<RhEthUsdPoint | null> => ({ priceUsd: price, provider: 'chainlens_native_price_resolver:goldrush_historical', endpoint: null, pointMs: dayStart(ts), gapMs: ts * 1000 - dayStart(ts), maxAllowedGapMs: 86_400_000 })

/** txs[0..] get hashes; `candidates` are the indexes in the 20-receipt sample; every other tx is only reachable as an inbound activity row. */
async function run(txs: Tx[], opts: { candidates?: number[]; inbound?: Array<{ i: number; raw: bigint | null; token?: string }> } = {}, over: Partial<RobinhoodPnlV1Deps> = {}) {
  __resetRobinhoodPnlV1CachesForTest() // hashes repeat across runs; receipts are cached by hash
  const hashes = txs.map((_, i) => `0x${(0xacc0 + i).toString(16).padStart(64, '0')}`)
  const byHash = new Map(hashes.map((h, i) => [h, { tx: txs[i], block: 1000 + i * 10 }]))
  const byBlock = new Map([...byHash.values()].map((v) => [v.block, v]))
  let receiptCalls = 0
  const rpc: RhRpc = async (calls) => calls.map(({ method, params }) => {
    const p = params as any[]
    if (method === 'eth_getTransactionReceipt') { receiptCalls += 1; const e = byHash.get(p[0]); return e ? { status: '0x1', from: e.tx.sender, to: ROUTER, blockNumber: hex(e.block), gasUsed: '0x1', effectiveGasPrice: '0x1', logs: e.tx.logs } : null }
    if (method === 'eth_getTransactionByHash') { const e = byHash.get(p[0]); return e ? { value: hex(e.tx.txValue) } : null }
    if (method === 'eth_getBalance') return hex(BigInt(10) * E18)
    if (method === 'eth_getTransactionCount') return byBlock.has(Number(p[1])) && byBlock.get(Number(p[1]))!.tx.sender === WALLET ? '0x2' : '0x1'
    if (method === 'eth_call' && p[0].to === RH_V4_POSITION_MANAGER) return [...POOLS.entries()].find(([id]) => id.slice(2, 52) === String(p[0].data).slice(10, 60))?.[1] ?? null
    if (method === 'eth_call' && p[0].data === '0x313ce567') return hex(18)
    return null
  })
  const cand = opts.candidates ?? [0]
  const lines: Array<[string, any]> = []
  const w = console.warn
  console.warn = (tag: unknown, body: unknown) => { lines.push([String(tag), body]) }
  try {
    const r = await computeRobinhoodPnlV1({
      wallet: WALLET, candidates: cand.map((i) => ({ txHash: hashes[i], timestampMs: txs[i].ts * 1000, hasSwapLog: true })),
      transactionCount: txs.length, transferCount: txs.length, activityUnavailableReason: null,
      inboundTokenTransfers: (opts.inbound ?? []).map(({ i, raw, token }) => ({ txHash: hashes[i], timestampMs: txs[i].ts * 1000, token: token ?? A, rawAmount: raw?.toString() ?? null })),
      deps: {
        rpc, now: Date.now, tokenHistoricalUsd: async () => null, ethUsdAt: ethAt(2600),
        ethUsdRange: async () => null,
        nativeTransfersForTx: async (h) => byHash.get(h)?.tx.trace ?? null,
        ...over,
      },
    })
    return {
      r, hashes, receiptCalls,
      rec: lines.filter(([tag]) => tag === '[robinhood-acquisition-recovery-audit]').map(([, b]) => b),
      accept: lines.filter(([tag]) => tag === '[robinhood-mixed-route-acceptance-audit]').map(([, b]) => b),
    }
  } finally { console.warn = w }
}

beforeEach(() => { __resetRobinhoodPnlV1CachesForTest() })

test('1. a plain inbound transfer is not a buy (and the lane is bounded)', async () => {
  const sell = sellShape(n(1000), n(1.5))
  const plain = relayed(new Tx().xfer(A, OTHER, WALLET, n(10)))
  const { r, rec } = await run([sell, plain], { inbound: [{ i: 1, raw: n(10) }] })
  assert.equal(rec.length, 1)
  assert.equal(rec[0].classification, 'transfer_in')
  assert.equal(rec[0].routeProven, false)
  assert.equal(rec[0].fifoIncluded, false)
  assert.equal(r.acquisitionRecovery!.recoveredBuyCount, 0)
  assert.equal(r.acquisitionRecovery!.unmatchedSellRawAfter, n(1000).toString())
  assert.equal(r.structuralClosedLots, 0)
  assert.equal(r.unmatchedSellCount, 1)
  // cap: 10 earlier inbounds → at most 8 attempted; later-than-sell rows are never candidates
  const many = Array.from({ length: 10 }, (_, k) => relayed(new Tx().xfer(A, OTHER, WALLET, n(1)), TS - 1000 - k))
  const after = relayed(new Tx().xfer(A, OTHER, WALLET, n(1)), TS + 10)
  const capped = await run([sell, ...many, after], { inbound: [...many.map((_, k) => ({ i: k + 1, raw: n(1) })), { i: 11, raw: n(1) }] })
  assert.equal(capped.r.acquisitionRecovery!.candidatesFound, 10)
  assert.equal(capped.r.acquisitionRecovery!.candidatesAttempted, ROBINHOOD_ACQUISITION_RECOVERY_LIMITS.maxCandidatesPerSell)
  assert.ok(capped.rec.every((x) => x.candidateTxHash !== capped.hashes[11]))
})

test('2. a distribution / claim stays a non-trade', async () => {
  const sell = sellShape(n(1000), n(1.5))
  const mint = relayed(new Tx().xfer(A, ZERO_ADDR, WALLET, n(50)))
  const airdrop = relayed(new Tx().xfer(A, OTHER, WALLET, n(5)).xfer(A, OTHER, D, n(5)), TS - 3600)
  const { r, rec } = await run([sell, mint, airdrop], { inbound: [{ i: 1, raw: n(50) }, { i: 2, raw: n(5) }] })
  assert.deepEqual(rec.map((x) => x.classification), ['distribution_or_claim', 'distribution_or_claim'])
  assert.equal(r.acquisitionRecovery!.recoveredBuyCount, 0)
  assert.equal(r.structuralClosedLots, 0)
})

test('3. a relayed swap with exact wallet funding and exact target output becomes a verified buy', async () => {
  const sell = sellShape(n(1000), n(1.5))
  const buy = relayedBuy(n(1), n(1000))
  const { r, rec } = await run([sell, buy], { inbound: [{ i: 1, raw: n(1000) }] })
  assert.equal(rec[0].classification, 'verified_buy')
  assert.deepEqual([rec[0].walletFundingToken, rec[0].walletFundingRaw, rec[0].inboundRaw, rec[0].routeProven, rec[0].ownershipProven, rec[0].fifoIncluded, rec[0].priceEvidenceStatus], [RH_WETH, n(1).toString(), n(1000).toString(), true, true, true, 'both_legs_priced'])
  assert.equal(r.acquisitionRecovery!.recoveredBuyCount, 1)
  assert.equal(r.acquisitionRecovery!.closedLotsAdded, 1)
  assert.equal(r.acquisitionRecovery!.unmatchedSellRawAfter, '0')
  assert.equal(r.verifiedClosedLots, 1)
  assert.equal(r.realizedPnlUsd, 1300) // 1.5 ETH − 1 ETH at $2,600
  assert.equal(r.unmatchedSellCount, 0)
})

test('4. a competing payer rejects (another address funds the input, or the relayer attaches ETH)', async () => {
  const sell = sellShape(n(1000), n(1.5))
  const shared = relayed(new Tx().xfer(RH_WETH, WALLET, ROUTER, n(0.5)).xfer(RH_WETH, OTHER, ROUTER, n(0.5)).xfer(RH_WETH, ROUTER, P5, n(1)).v3(P5, n(1), n(1000)).xfer(A, P5, WALLET, n(1000)))
  const { r, rec } = await run([sell, shared], { inbound: [{ i: 1, raw: n(1000) }] })
  assert.equal(rec[0].classification, 'ambiguous')
  assert.match(rec[0].rejectionReason, /^competing_payer/)
  assert.equal(r.acquisitionRecovery!.recoveredBuyCount, 0)
  const valued = relayedBuy(n(1), n(1000))
  valued.txValue = n(0.1)
  const v = await run([sell, valued], { inbound: [{ i: 1, raw: n(1000) }] })
  assert.match(v.rec[0].rejectionReason, /^competing_payer: tx sender/)
})

test('5. outside funding rejects', async () => {
  const sell = sellShape(n(1000), n(1.5))
  const tx = relayed(new Tx()
    .xfer(RH_WETH, WALLET, ROUTER, n(1)).xfer(RH_WETH, ROUTER, P5, n(1)).v3(P5, n(1), n(10)).xfer(B, P5, ROUTER, n(10))
    .xfer(B, OTHER, ROUTER, n(5)).xfer(B, ROUTER, P6, n(15)).v3(P6, n(15), n(1000)).xfer(A, P6, WALLET, n(1000)))
  const { r, rec } = await run([sell, tx], { inbound: [{ i: 1, raw: n(1000) }] })
  assert.equal(rec[0].classification, 'ambiguous')
  assert.match(rec[0].rejectionReason, /^outside_funding/)
  assert.equal(r.acquisitionRecovery!.recoveredBuyCount, 0)
})

test('6. an unrelated second action rejects (extra wallet flow, or a swap off the route)', async () => {
  const sell = sellShape(n(1000), n(1.5))
  const extraFlow = relayedBuy(n(1), n(1000)).xfer(D, WALLET, OTHER, n(3))
  const a = await run([sell, extraFlow], { inbound: [{ i: 1, raw: n(1000) }] })
  assert.equal(a.rec[0].classification, 'ambiguous')
  assert.match(a.rec[0].rejectionReason, /^unrelated_second_action/)
  const offRoute = relayedBuy(n(1), n(1000)).xfer(D, OTHER, P6, n(2)).v2(P6, n(2), n(7)).xfer(C, P6, OTHER, n(7))
  const b = await run([sell, offRoute], { inbound: [{ i: 1, raw: n(1000) }] })
  assert.equal(b.rec[0].classification, 'ambiguous')
  assert.match(b.rec[0].rejectionReason, /^unrelated_second_action/)
  assert.equal(b.r.acquisitionRecovery!.recoveredBuyCount, 0)
})

test('7. a partial recovered buy closes only the provable quantity', async () => {
  const sell = sellShape(n(1000), n(1.5))   // $3,900 proceeds for 1,000 A
  const buy = relayedBuy(n(0.4), n(400))     // $1,040 cost for 400 A
  const { r } = await run([sell, buy], { inbound: [{ i: 1, raw: n(400) }] })
  assert.equal(r.acquisitionRecovery!.unmatchedSellRawBefore, n(1000).toString())
  assert.equal(r.acquisitionRecovery!.unmatchedSellRawAfter, n(600).toString())
  assert.equal(r.verifiedClosedLots, 1)
  assert.equal(r.realizedPnlUsd, 520) // 0.4 × 3,900 − 1,040
  assert.equal(r.unmatchedSellCount, 1) // the remaining 600 A stays unmatched
})

test('8. a verified buy + the production-shaped 53353 sell closes a FIFO lot (buy already in the receipt sample)', async () => {
  const sell = sellShape(SELL_RAW, OUT_WEI)
  const buy = relayedBuy(n(0.03), SELL_RAW, 1789983697)
  const { r, rec, accept } = await run([sell, buy], { candidates: [0, 1] })
  assert.equal(r.ingestionAudit.rejectionReasons.wallet_not_tx_sender, 1) // the normal lane still rejects it
  assert.equal(accept[0].classification, 'direct_mixed_route_proven')
  assert.equal(rec[0].classification, 'verified_buy')
  assert.equal(rec[0].candidateTimestamp, 1789983697)
  assert.equal(r.acquisitionRecovery!.sellTxHash, r.priceEvidence[0].swapTxHash)
  assert.equal(r.acquisitionRecovery!.token, A)
  assert.equal(r.acquisitionRecovery!.unmatchedSellRawBefore, SELL_RAW.toString())
  assert.equal(r.acquisitionRecovery!.unmatchedSellRawAfter, '0')
  assert.equal(r.structuralClosedLots, 1)
  assert.equal(r.verifiedClosedLots, 1)
  assert.ok(Math.abs(r.realizedPnlUsd! - (0.032288571310109712 - 0.03) * 2600) < 0.01)
})

test('9. historical pricing failure leaves the acquisition structurally proven but unpriced', async () => {
  const sell = sellShape(n(1000), n(1.5))
  const buy = relayedBuy(n(1), n(1000))
  const { r, rec } = await run([sell, buy], { inbound: [{ i: 1, raw: n(1000) }] }, { ethUsdAt: async () => null, ethUsdRange: async () => null })
  assert.equal(rec[0].classification, 'verified_buy')
  assert.equal(rec[0].fifoIncluded, true)
  assert.notEqual(rec[0].priceEvidenceStatus, 'both_legs_priced')
  assert.equal(r.structuralClosedLots, 1)
  assert.equal(r.verifiedClosedLots, 0)
  assert.equal(r.realizedPnlUsd, null)
})

test('10. direct V4 and mixed-route acceptance are unchanged', async () => {
  // A verified direct-V4 buy in the sample: no unmatched sell, the lane does not run.
  const { r, accept } = await run([directBuy(n(1), n(1000)), sellShape(n(1000), n(1.5))], { candidates: [0, 1] })
  assert.equal(r.ingestionAudit.directV4VerifiedSwapCount, 1)
  assert.equal(r.ingestionAudit.mixedRouteVerifiedSwapCount, 1)
  assert.equal(accept[0].accepted, true)
  assert.equal(r.acquisitionRecovery!.acquisitionRecoveryAttempted, false)
  assert.equal(r.realizedPnlUsd, 1300)
  // A wallet-sent buy outside the sample is verified by the existing direct-V4 lane, not the relayed proof.
  const buy = directBuy(n(1), n(1000)).at(TS - 3600)
  const out = await run([sellShape(n(1000), n(1.5)), buy], { inbound: [{ i: 1, raw: n(1000) }] })
  assert.equal(out.rec[0].classification, 'verified_buy')
  assert.equal(out.r.ingestionAudit.directV4VerifiedSwapCount, 0)
  assert.equal(out.r.verifiedClosedLots, 1)
  // Without inbound evidence nothing is invented.
  const none = await run([sellShape(n(1000), n(1.5))])
  assert.equal(none.r.acquisitionRecovery!.acquisitionRecoveryAttempted, true)
  assert.equal(none.r.acquisitionRecovery!.candidatesFound, 0)
  assert.equal(none.rec[0].rejectionReason, 'no_earlier_inbound_of_sold_token')
  assert.equal(none.r.structuralClosedLots, 0)
})
