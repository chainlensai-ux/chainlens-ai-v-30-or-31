// Robinhood PnL V1: historical ETH/USD for accepted swaps. Primary: the shared ChainLens historical-native
// resolver (injected as ethUsdAt). Fallback: hourly range, nearest point within the gap. Never a current price.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import { computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest, RH_NATIVE, RH_WETH, RH_V4_POSITION_MANAGER, V4_SWAP_TOPIC0, ERC20_TRANSFER_TOPIC0, type RhRpc, type RobinhoodPnlV1Deps, type RhEthUsdPoint } from '../lib/server/robinhoodPnlV1.ts'
import { V2_SWAP_TOPIC0, V3_SWAP_TOPIC0, WETH_WITHDRAWAL_TOPIC0, type RhNativeTransfer } from '../lib/server/robinhoodMixedRouteForensics.ts'
import { sharedHistoricalEthUsdAt } from '../lib/server/robinhoodWalletScanner.ts'
import { __seedAcceptedNativePriceForTest, __resetNativePriceResolverForTest } from '../src/modules/nativePriceResolver/index.ts'

const TS = 1790155166 // production 53353d… swap timestamp (2026-09-23T09:19:26Z)
const DAY_START_MS = Math.floor(TS * 1000 / 86_400_000) * 86_400_000
const OUT_WEI = BigInt('32288571310109712') // production 53353d… native output
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
      wallet: WALLET, candidates: hashes.map((h, i) => ({ txHash: h, timestampMs: TS * 1000 + i, hasSwapLog: true })),
      transactionCount: txs.length, transferCount: txs.length, activityUnavailableReason: null,
      deps: {
        rpc, now: Date.now, tokenHistoricalUsd: async () => null,
        ethUsdRange: async () => { throw new Error('range must not be called') },
        nativeTransfersForTx: async (h) => byHash.get(h)?.tx.trace ?? null,
        ...over,
      },
    })
    return { r, accept: lines.filter(([tag]) => tag === '[robinhood-mixed-route-acceptance-audit]').map(([, b]) => b), eth: lines.filter(([tag]) => tag === '[robinhood-eth-history-audit]').map(([, b]) => b) }
  } finally { console.warn = w }
}

beforeEach(() => { __resetRobinhoodPnlV1CachesForTest(); __resetNativePriceResolverForTest() })

const resolverAt = (price: number, calls: number[] = []) => async (ts: number): Promise<RhEthUsdPoint | null> => {
  calls.push(ts)
  return { priceUsd: price, provider: 'chainlens_native_price_resolver:goldrush_historical', endpoint: null, pointMs: DAY_START_MS, gapMs: ts * 1000 - DAY_START_MS, maxAllowedGapMs: 86_400_000 }
}
const rangeWith = (pts: Array<[number, number]>) => async () => ({ points: pts, httpStatus: 200, failure: null })

test('1. ts 1790155166 with a resolver point inside its day bucket -> priced, audited', async () => {
  const calls: number[] = []
  const { r, eth } = await run([shape53353(OUT_WEI)], { ethUsdAt: resolverAt(2600, calls) })
  assert.deepEqual(calls, [TS])
  assert.equal(r.priceEvidence[0].outputPriceUsd, 2600)
  assert.equal(r.priceEvidence[0].outputSource, 'native_historical_eth_usd')
  assert.equal(eth.length, 1)
  assert.equal(eth[0].requestedTimestampSec, TS)
  assert.equal(eth[0].priceUsd, 2600)
  assert.equal(eth[0].rejectionReason, null)
  assert.equal(eth[0].nearestGapMs, TS * 1000 - DAY_START_MS)
})

test('Robinhood ETH history audit identifies persistent accepted evidence', async () => {
  const { r, eth } = await run([shape53353(OUT_WEI)], {
    ethUsdAt: async (ts) => ({
      priceUsd: 2752.629093198004,
      provider: 'chainlens_native_price_resolver:coingecko_native_coin_history',
      endpoint: null, pointMs: DAY_START_MS, gapMs: ts * 1000 - DAY_START_MS,
      maxAllowedGapMs: 86_400_000, persistentCacheHit: true,
    }),
  })
  assert.equal(r.priceEvidence[0].outputPriceUsd, 2752.629093198004)
  assert.equal(eth[0].persistentCacheHit, true)
  assert.equal(eth[0].rejectionReason, null)
})

test('2. seconds -> ms conversion through the shared resolver is correct', async () => {
  __seedAcceptedNativePriceForTest(TS * 1000, 2600, 'goldrush_historical')
  const p = await sharedHistoricalEthUsdAt(TS)
  assert.ok(p)
  assert.equal(p.priceUsd, 2600)
  assert.equal(p.pointMs, DAY_START_MS)
  assert.equal(p.gapMs, 33_566_000) // 09:19:26 into the UTC day
  assert.equal(p.maxAllowedGapMs, 86_400_000)
  assert.equal(p.provider, 'chainlens_native_price_resolver:goldrush_historical')
  // a seconds value mistaken for ms would land in 1970 and must not find the seeded price
  assert.equal(await sharedHistoricalEthUsdAt(TS / 1000), null)
})

test('3. range fallback: a nearby point within the 45-minute gap is accepted', async () => {
  const { r, eth } = await run([shape53353(OUT_WEI)], { ethUsdRange: rangeWith([[(TS - 1800) * 1000, 2550]]) })
  assert.equal(r.priceEvidence[0].outputPriceUsd, 2550)
  assert.equal(eth[0].provider, 'coingecko_market_chart_range')
  assert.deepEqual([eth[0].requestedFromSec, eth[0].requestedToSec, eth[0].pointsReturned, eth[0].nearestGapMs, eth[0].httpStatus], [TS - 3600, TS + 3600, 1, 1_800_000, 200])
})

test('4. range fallback: a point outside the max gap is rejected', async () => {
  const { r, eth } = await run([shape53353(OUT_WEI)], { ethUsdRange: rangeWith([[(TS - 3 * 3600) * 1000, 2550], [(TS + 3 * 3600) * 1000, 2560]]) })
  assert.equal(r.swapsBothLegsPriced, 0)
  assert.equal(r.priceEvidence[0].outputPriceUsd, null)
  assert.equal(eth[0].rejectionReason, 'range_nearest_point_outside_gap')
  const notCovered = await run([shape53353(OUT_WEI)], { ethUsdRange: rangeWith([[(TS - 5 * 3600) * 1000, 2550]]) })
  assert.equal(notCovered.eth[0].rejectionReason, 'range_timestamp_not_covered')
})

test('5. provider empty -> unpriced (resolver none, range empty)', async () => {
  const { r, eth } = await run([shape53353(OUT_WEI)], { ethUsdAt: async () => null, ethUsdRange: async () => ({ points: [], httpStatus: 200, failure: 'empty' }) })
  assert.equal(r.swapsBothLegsPriced, 0)
  assert.equal(eth[0].rejectionReason, 'resolver_no_verified_price; range_empty')
})

test('6. provider failure -> unpriced, failure kind recorded (rate limit / throw)', async () => {
  const limited = await run([shape53353(OUT_WEI)], { ethUsdAt: async () => { throw new Error('down') }, ethUsdRange: async () => ({ points: null, httpStatus: 429, failure: 'rate_limited' }) })
  assert.equal(limited.r.swapsBothLegsPriced, 0)
  assert.equal(limited.eth[0].httpStatus, 429)
  assert.equal(limited.eth[0].rejectionReason, 'resolver_no_verified_price; range_rate_limited')
  __resetRobinhoodPnlV1CachesForTest()
  const threw = await run([shape53353(OUT_WEI)], { ethUsdRange: async () => { throw new Error('boom') } })
  assert.equal(threw.r.swapsBothLegsPriced, 0)
  assert.equal(threw.eth[0].rejectionReason, 'range_provider_threw')
})

test('7. no current/spot ETH fallback anywhere in the Robinhood pricing path', async () => {
  const src = readFileSync(new URL('../lib/server/robinhoodPnlV1.ts', import.meta.url), 'utf8')
  for (const banned of ['fetchCoingeckoEthUsdRecent', 'ethUsdLatest', 'EthUsdLatest', 'simple/price']) assert.ok(!src.includes(banned), banned)
  assert.equal(src.match(/currentPrice\w*/g)?.join(), 'currentPriceUsdLookup')
  assert.ok(src.includes('currentPriceUsdLookup: () => null'))
  // a resolver point outside the swap's day is refused, not used
  const { r, eth } = await run([shape53353(OUT_WEI)], { ethUsdAt: async () => ({ priceUsd: 4000, provider: 'x', endpoint: null, pointMs: Date.now(), gapMs: 90 * 86_400_000, maxAllowedGapMs: 86_400_000 }), ethUsdRange: async () => null })
  assert.equal(r.swapsBothLegsPriced, 0)
  assert.match(eth[0].rejectionReason, /^resolver_point_outside_day/)
})

test('8. the 53353 shape becomes both-leg priced', async () => {
  const { r, accept } = await run([shape53353(OUT_WEI)], { ethUsdAt: resolverAt(2600) })
  assert.equal(r.swapsBothLegsPriced, 1)
  assert.equal(accept[0].priceEvidenceStatus, 'both_legs_priced')
  assert.equal(accept[0].nativeProofStatus, 'proven_target_tx_native_transfer')
  assert.ok(Math.abs(r.priceEvidence[0].outputAmount * r.priceEvidence[0].outputPriceUsd! - 0.032288571310109712 * 2600) < 1e-9)
})

test('9. FIFO receives the verified USD sell value', async () => {
  const buy = directBuy(n(1), n(1000)); buy.ts = TS - 3600 // same UTC day: $2,600 cost
  const sell = shape53353(n(1.5))                         // $3,900 proceeds
  const { r } = await run([buy, sell], { ethUsdAt: resolverAt(2600) })
  assert.equal(r.verifiedClosedLots, 1)
  assert.equal(r.realizedPnlUsd, 1300)
  assert.equal(r.realizedRoiPct, 50)
})

test('10. route verification and mixed acceptance are unchanged', async () => {
  const priced = await run([shape53353(OUT_WEI)], { ethUsdAt: resolverAt(2600) })
  const unpriced = await run([shape53353(OUT_WEI)], { ethUsdAt: async () => null, ethUsdRange: async () => null })
  for (const { r, accept } of [priced, unpriced]) {
    assert.equal(r.swapsVerified, 1)
    assert.equal(r.ingestionAudit.mixedRouteVerifiedSwapCount, 1)
    assert.equal(accept[0].classification, 'direct_mixed_route_proven')
    assert.equal(accept[0].accepted, true)
    assert.equal(accept[0].outputRaw, OUT_WEI.toString())
  }
})
