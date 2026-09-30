// LIVE BUG (Base, Uniswap V4, ~1,343 txns / 24h): the chart said "Alternate pool" with 6 x 5M candles.
// Root cause: V4 PoolIds are unproven for provider OHLCV (V4_POOL_ID_OHLCV_SUPPORT all false), so the
// market pool was skipped with 0 calls, the ladder moved to ALTERNATE pools, accepted the first thin one,
// and the V4 swap-event lane — which reads the market pool's real Swap logs — never ran.
// Fix: the V4 market pool's own swaps are charted before any alternate (lib/evmChartCandles.ts Phase 2).
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem'
import { V4_INITIALIZE_TOPIC0, V4_POOL_MANAGER_ABI, type RawEvmLog } from '../lib/v4SwapCandles.ts'
import { loadV4SwapCandles, resetV4SwapCandleCache, type V4SwapDeps } from '../lib/server/v4SwapCandlesRpc.ts'
import { buildChartMarketDiagnostics, runEvmCandleLadder, type LadderDeps, type LadderFetchResult, type LadderPool } from '../lib/evmChartCandles.ts'
import { buildChartTimeframes, normalizeChartCandles } from '../lib/priceChartCandles.ts'
import { assessTimeframeSet, isPresentationUsable, resolveCoverageWindow, selectPresentationTimeframe } from '../lib/chartQuality.ts'
import { scaleCandlesToMarketCap } from '../lib/chartMarketCap.ts'

const POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b'
const V4_POOL = ('0x' + '9f3c'.repeat(16)) as Hex
const ALT_A = '0x' + '7a'.repeat(20)
const ALT_B = '0x' + '7b'.repeat(20)
const NATIVE = '0x0000000000000000000000000000000000000000'
const TOKEN = '0x1bc0c42215582d5a085795f4badbac3ff36d1bcb'
const WETH = '0x4200000000000000000000000000000000000006'
const LATEST = 30_000_000
const LATEST_TS = 1_800_000_000
const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`
const sqrtX96 = (p: number) => BigInt(Math.round(Math.sqrt(p) * 2 ** 96))
const initLog = (block: number): RawEvmLog => ({
  address: POOL_MANAGER,
  topics: encodeEventTopics({ abi: V4_POOL_MANAGER_ABI, eventName: 'Initialize', args: { id: V4_POOL, currency0: NATIVE as Hex, currency1: TOKEN as Hex } }) as string[],
  data: encodeAbiParameters([{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }], [10000, 200, NATIVE, BigInt(2) ** BigInt(96), 0]),
  blockNumber: hex(block), logIndex: '0x0',
})
// Token = currency1 vs native ETH; price drifts so candles are real OHLC, not flat.
const swapLog = (block: number, i: number): RawEvmLog => ({
  address: POOL_MANAGER,
  topics: encodeEventTopics({ abi: V4_POOL_MANAGER_ABI, eventName: 'Swap', args: { id: V4_POOL, sender: '0x000000000000000000000000000000000000beef' } }) as string[],
  data: encodeAbiParameters([{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }], [BigInt(-1e16), BigInt(1e19), sqrtX96(1000 * (1 + 0.02 * Math.sin(i / 17))), BigInt(1e18), 0, 10000]),
  blockNumber: hex(block), logIndex: hex(i % 7),
  // Exact per-log block time (the RPC carries it): 5M buckets.
  blockTimestamp: hex(LATEST_TS - (LATEST - block) * 2),
} as RawEvmLog)
// ~1,100 real swaps over 24h in this pool: one every 39 blocks (78s).
function activeChain() {
  const calls: string[] = []
  const deps: V4SwapDeps = {
    now: () => LATEST_TS * 1000,
    rpc: async (method, params) => {
      calls.push(method)
      if (method === 'eth_getBlockByNumber') return { result: { number: hex(LATEST), timestamp: hex(LATEST_TS) }, error: false }
      const f = params[0] as { topics: string[]; fromBlock: string; toBlock: string }
      if (f.topics[0] === V4_INITIALIZE_TOPIC0) return { result: [initLog(LATEST - 60 * 43_200)], error: false }
      const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock))
      const out: RawEvmLog[] = []
      for (let b = Math.ceil(from / 39) * 39; b <= to; b += 39) out.push(swapLog(b, b / 39))
      return { result: out, error: false }
    },
    ethUsdSeries: async () => ({ points: Array.from({ length: 300 }, (_, i) => [(LATEST_TS - 24 * 3600 + i * 300) * 1000, 3000] as [number, number]), cacheHit: false }),
  }
  return { deps, calls }
}
const rel = (net: string) => ({ base_token: { data: { id: `${net}_${TOKEN}` } }, quote_token: { data: { id: `${net}_${WETH}` } } })
const pool = (address: string): LadderPool => ({ poolId: `base_${address}`, address, name: 'TKN / WETH', liquidityUsd: 1e5, pool: { id: `base_${address}`, relationships: rel('base') } })
// The thin alternate that production charted: 6 x 15m rows.
const thin: LadderFetchResult = { httpStatus: 200, json: { data: { attributes: { ohlcv_list: Array.from({ length: 6 }, (_, i) => [LATEST_TS - i * 3 * 3600, 3, 3.1, 2.9, 3.05, 5]) } } } }

function ladderDeps(chainDeps: V4SwapDeps, providerCalls: string[], v4Code?: string): LadderDeps {
  return {
    fetchCoingeckoPoolOhlcv: async (a) => { providerCalls.push(`cg:${a}`); return { httpStatus: 404, json: null } },
    fetchPoolOhlcv: async (a) => { providerCalls.push(`gt:${a}`); return thin },
    fetchTrades: async (a) => { providerCalls.push(`trades:${a}`); return { httpStatus: 200, json: { data: [] } } },
    fetchV4SwapCandles: async (_p, budget) => (v4Code
      ? { ok: false, code: v4Code as never, poolManager: POOL_MANAGER, logsFound: 0, candles: [], intervalSec: 300, timeResolution: null, callsUsed: 3, pagesFetched: 0, budgetStopReason: null }
      : loadV4SwapCandles({ chain: 'base', poolId: V4_POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 3 }, chainDeps, budget)),
  }
}
beforeEach(() => resetV4SwapCandleCache())

test('ACCEPTANCE: active V4 market pool is charted from its own swaps — not an alternate; dense 5M/15M candles', async () => {
  const chain = activeChain()
  const providerCalls: string[] = []
  const r = await runEvmCandleLadder({ pools: [pool(V4_POOL), pool(ALT_A), pool(ALT_B)], contract: TOKEN, networkId: 'base', coingeckoNetworkId: 'base', currentPriceUsd: 3, nowSec: LATEST_TS }, ladderDeps(chain.deps, providerCalls))
  assert.equal(r.candleProvider, 'v4_swap_events')
  assert.equal(r.selectedPool?.address, V4_POOL, 'the market PoolId, not an alternate')
  assert.equal(r.alternatePoolUsed, false)
  assert.deepEqual(providerCalls, [], 'no alternate (or unproven-provider) read happened')
  assert.equal(r.chartCandles?.tokenSide ?? 'base', 'base')
  const p = r.v4Swap!.pipeline!
  assert.ok(p.exactPoolSwaps >= 1100, `${p.exactPoolSwaps} swaps`)
  assert.equal(p.timestampValidSwaps, p.exactPoolSwaps)
  assert.equal(p.usdPricedSwaps, p.exactPoolSwaps)
  const d = buildChartMarketDiagnostics({ marketPoolId: V4_POOL, marketTxns24h: 1343, ladder: r })
  assert.ok(d.fiveMinuteBuckets >= 280, `${d.fiveMinuteBuckets} x 5M buckets`)
  assert.ok(d.fifteenMinuteBuckets >= 95, `${d.fifteenMinuteBuckets} x 15M buckets`)
  assert.deepEqual([d.samePool, d.alternatePoolUsed, d.warnings], [true, false, []])
  assert.ok(d.swapToTxnRatio! > 0.5)
  // Presentation: good candles by default (no sparse line fallback), volume on every candle.
  const set = buildChartTimeframes(normalizeChartCandles(r.chartCandles!.points), r.chartCandles!.intervalSec)
  const q = assessTimeframeSet(set, { coverageFor: () => resolveCoverageWindow(r.chartCandles!.coverage ?? null), referenceMs: LATEST_TS * 1000 })
  const sel = selectPresentationTimeframe(q)
  assert.equal(sel.key, '5M')
  assert.equal(sel.quality, 'good')
  assert.ok(isPresentationUsable(q['15M']!.quality))
  assert.ok(set.timeframes.find((t) => t.key === '5M')!.candles.every((k) => (k.volume ?? 0) > 0))
  // PRICE / MCAP: same timestamps.
  const mc = scaleCandlesToMarketCap(set.timeframes.find((t) => t.key === '5M')!.candles, 1e9)
  assert.deepEqual(mc.map((k) => k.t), set.timeframes.find((t) => t.key === '5M')!.candles.map((k) => k.t))
  assert.ok(r.totalHttpCalls <= 10)
})

test('market V4 lane fails -> alternate is last resort, with the exact reason and a debug warning', async () => {
  const providerCalls: string[] = []
  const r = await runEvmCandleLadder({ pools: [pool(V4_POOL), pool(ALT_A)], contract: TOKEN, networkId: 'base', coingeckoNetworkId: 'base', currentPriceUsd: 3, nowSec: LATEST_TS }, ladderDeps(activeChain().deps, providerCalls, 'quote_usd_price_unproven'))
  assert.equal(r.selectedPool?.address, ALT_A)
  assert.deepEqual([r.alternatePoolUsed, r.alternateReason, r.primaryChartFailureReason], [true, 'quote_usd_price_unproven', 'quote_usd_price_unproven'])
  const d = buildChartMarketDiagnostics({ marketPoolId: V4_POOL, marketTxns24h: 1343, ladder: r })
  assert.equal(d.samePool, false)
  assert.deepEqual(d.warnings, ['chart_pool_differs_from_market_pool', 'alternate_pool_charted_while_market_pool_active'])
  assert.equal(r.attempts.filter((a) => a.route === 'v4_swaps').length, 1, 'the V4 lane is not re-run after the alternates')
})

test('severe txns-vs-swaps gap is a debug warning (never assumed 1:1)', () => {
  const d = buildChartMarketDiagnostics({ marketPoolId: V4_POOL, marketTxns24h: 1343, ladder: { selectedPool: { address: V4_POOL, name: null }, chartCandles: null, v4Swap: { pipeline: { logsReturned: 8, exactPoolSwaps: 8, timestampValidSwaps: 8, usdPricedSwaps: 8, candles: 6 } } as never, primaryChartFailureReason: null, alternatePoolUsed: false, alternateReason: null } })
  assert.equal(d.swapToTxnRatio, 0.006)
  assert.deepEqual(d.warnings, ['chart_swaps_far_below_market_txns'])
})

test('normal (20-byte) market pools are unchanged: provider OHLCV first, V4 lane never touched', async () => {
  const providerCalls: string[] = []
  let v4 = 0
  const deps = ladderDeps(activeChain().deps, providerCalls)
  const r = await runEvmCandleLadder({ pools: [pool(ALT_A)], contract: TOKEN, networkId: 'base', coingeckoNetworkId: 'base', currentPriceUsd: 3, nowSec: LATEST_TS }, { ...deps, fetchV4SwapCandles: async (...a) => { v4++; return deps.fetchV4SwapCandles!(...a) } })
  assert.equal(r.selectedPool?.address, ALT_A)
  assert.equal(v4, 0)
  assert.equal(r.alternatePoolUsed, false)
})
