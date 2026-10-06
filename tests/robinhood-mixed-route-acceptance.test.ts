// Robinhood PnL V1: only `direct_mixed_route_proven` mixed-venue receipts are promoted to verified swaps.
// Everything else stays `other_venue_swap_in_tx`. Native endpoints only from the target tx's own trace.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import { computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest, RH_NATIVE, RH_WETH, RH_V4_POSITION_MANAGER, V4_SWAP_TOPIC0, ERC20_TRANSFER_TOPIC0, type RhRpc, type RobinhoodPnlV1Deps } from '../lib/server/robinhoodPnlV1.ts'
import { V2_SWAP_TOPIC0, V3_SWAP_TOPIC0, WETH_WITHDRAWAL_TOPIC0, type RhNativeTransfer } from '../lib/server/robinhoodMixedRouteForensics.ts'

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
  private i = 0
  private push(address: string, topics: string[], data: string) { this.logs.push({ address, topics, data, logIndex: hex(this.i++), blockTimestamp: hex(1_760_000_000) }); return this }
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

async function run(txs: Tx[], over: Partial<RobinhoodPnlV1Deps> = {}) {
  const hashes = txs.map((_, i) => `0x${(0x5335 + i).toString(16).padStart(64, '0')}`)
  const byHash = new Map(hashes.map((h, i) => [h, { tx: txs[i], block: 1000 + i * 10 }]))
  const byBlock = new Map([...byHash.values()].map((v) => [v.block, v]))
  const rpc: RhRpc = async (calls) => calls.map(({ method, params }) => {
    const p = params as any[]
    if (method === 'eth_getTransactionReceipt') { const e = byHash.get(p[0]); return e ? { status: '0x1', from: WALLET, to: ROUTER, blockNumber: hex(e.block), gasUsed: '0x1', effectiveGasPrice: '0x1', logs: e.tx.logs } : null }
    if (method === 'eth_getTransactionByHash') { const e = byHash.get(p[0]); return e ? { value: hex(e.tx.txValue) } : null }
    if (method === 'eth_getBalance') return hex(BigInt(10) * E18)
    if (method === 'eth_getTransactionCount') return byBlock.has(Number(p[1])) ? '0x2' : '0x1'
    if (method === 'eth_call' && p[0].to === RH_V4_POSITION_MANAGER) return [...POOLS.entries()].find(([id]) => id.slice(2, 52) === String(p[0].data).slice(10, 60))?.[1] ?? null
    if (method === 'eth_call' && p[0].data === '0x313ce567') return hex(18)
    return null
  })
  const lines: Array<[string, any]> = []
  const w = console.warn
  console.warn = (tag: unknown, body: unknown) => { lines.push([String(tag), body]) }
  try {
    const r = await computeRobinhoodPnlV1({
      wallet: WALLET, candidates: hashes.map((h, i) => ({ txHash: h, timestampMs: 1_760_000_000_000 + i, hasSwapLog: true })),
      transactionCount: txs.length, transferCount: txs.length, activityUnavailableReason: null,
      deps: {
        rpc, now: Date.now, tokenHistoricalUsd: async () => null,
        ethUsdRange: async (f, to) => { const pts: Array<[number, number]> = []; for (let s = f - 7200; s <= to + 7200; s += 3600) pts.push([s * 1000, 2000]); return pts },
        nativeTransfersForTx: async (h) => byHash.get(h)?.tx.trace ?? null,
        ...over,
      },
    })
    return { r, accept: lines.filter(([tag]) => tag === '[robinhood-mixed-route-acceptance-audit]').map(([, b]) => b) }
  } finally { console.warn = w }
}

beforeEach(() => { __resetRobinhoodPnlV1CachesForTest() })

test('1/2. production-shaped 53353d… (V4 -> V3 -> V3 -> native, trace-proven) is accepted as a verified swap', async () => {
  const { r, accept } = await run([shape53353()])
  assert.equal(r.swapsVerified, 1)
  assert.equal(r.ingestionAudit.mixedRouteVerifiedSwapCount, 1)
  assert.equal(r.ingestionAudit.directV4VerifiedSwapCount, 0)
  assert.deepEqual(r.ingestionAudit.rejectionReasons, {})
  const a = accept[0]
  assert.deepEqual([a.classification, a.accepted, a.inputToken, a.inputRaw, a.outputToken, a.outputRaw, a.nativeProofStatus], ['direct_mixed_route_proven', true, A, n(1000).toString(), RH_NATIVE, n(0.032).toString(), 'proven_target_tx_native_transfer'])
  assert.equal(a.priceEvidenceStatus, 'both_legs_priced')
  assert.equal(a.fifoIncluded, true)
  assert.equal(r.priceEvidence[0].outputPriceUsd, 2000)
})

test('3. 8980c1…-shaped route with value diverted to another address -> rejected', async () => {
  const diverted = shape53353().xfer(RH_WETH, ROUTER, OTHER, n(0.01))
  const { r, accept } = await run([diverted])
  assert.equal(r.swapsVerified, 0)
  assert.deepEqual(r.ingestionAudit.rejectionReasons, { other_venue_swap_in_tx: 1 })
  assert.equal(accept[0].accepted, false)
  assert.notEqual(accept[0].classification, 'direct_mixed_route_proven')
})

test('4. e78c51…-shaped route with an externally funded second swap -> rejected (independent_second_action)', async () => {
  const funded = shape53353().xfer(D, OTHER, P9, n(1)).v2(P9, n(1), n(9)).xfer(C, P9, OTHER, n(9))
  const { r, accept } = await run([funded])
  assert.equal(r.swapsVerified, 0)
  assert.equal(accept[0].classification, 'independent_second_action')
  assert.deepEqual(r.ingestionAudit.mixedRouteRejectedReasons, { independent_second_action: 1 })
})

test('5. an ambiguous route (a V3 hop not resolvable from transfers) -> rejected', async () => {
  const tx = new Tx().xfer(A, WALLET, PM, n(1000)).v4(A, B, n(1000), n(80)).xfer(B, PM, ROUTER, n(80)).v3(P3, n(80), n(1)).paysWallet(n(1))
  const { r, accept } = await run([tx])
  assert.equal(r.swapsVerified, 0)
  assert.equal(accept[0].classification, 'ambiguous')
})

test('6. missing native trace (block balance delta only) -> rejected', async () => {
  const tx = shape53353()
  tx.trace = null
  const { r, accept } = await run([tx])
  assert.equal(r.swapsVerified, 0)
  assert.equal(accept[0].accepted, false)
  assert.equal(accept[0].nativeProofStatus, 'block_balance_delta_only')
})

test('7. historical pricing failure -> structurally verified, but unpriced (no lot value)', async () => {
  const { r, accept } = await run([shape53353()], { ethUsdRange: async () => null })
  assert.equal(r.swapsVerified, 1)
  assert.equal(r.swapsBothLegsPriced, 0)
  assert.equal(r.realizedPnlUsd, null)
  assert.notEqual(accept[0].priceEvidenceStatus, 'both_legs_priced')
})

test('8. a verified mixed sell reaches FIFO and closes the direct-V4 buy lot', async () => {
  const buy = directBuy(n(1), n(1000))   // $2,000 cost
  const sell = shape53353(n(1.5))        // $3,000 proceeds
  const { r } = await run([buy, sell])
  assert.equal(r.swapsVerified, 2)
  assert.equal(r.ingestionAudit.directV4VerifiedSwapCount, 1)
  assert.equal(r.ingestionAudit.mixedRouteVerifiedSwapCount, 1)
  assert.equal(r.structuralClosedLots, 1)
  assert.equal(r.verifiedClosedLots, 1)
  assert.equal(r.realizedPnlUsd, 1000)
  assert.equal(r.realizedRoiPct, 50)
  assert.equal(r.status, 'verified_bounded_sample')
})

test('9. repeated scans are deterministic', async () => {
  const strip = (x: Awaited<ReturnType<typeof run>>['r']) => ({ ...x, metrics: null })
  const first = await run([directBuy(n(1), n(1000)), shape53353(n(1.5))])
  const second = await run([directBuy(n(1), n(1000)), shape53353(n(1.5))])
  assert.deepEqual(strip(second.r), strip(first.r))
})

test('10. direct V4 behaviour unchanged (direct buy verified via the direct lane, no mixed audit line)', async () => {
  const { r, accept } = await run([directBuy(n(1), n(1000))])
  assert.equal(r.swapsVerified, 1)
  assert.equal(r.ingestionAudit.directV4VerifiedSwapCount, 1)
  assert.equal(r.ingestionAudit.mixedRouteVerifiedSwapCount, 0)
  assert.equal(accept.length, 0)
})
