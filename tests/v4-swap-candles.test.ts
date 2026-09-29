// Uniswap V4 candles from on-chain Swap events (lib/v4SwapCandles.ts + lib/server/v4SwapCandlesRpc.ts),
// the call budget, timestamp policy, shared ETH/USD series, the ladder/route wiring, a live-shaped
// Base PoolManager fixture, and young-token timeframe availability. Logs are ABI-encoded with viem
// exactly as PoolManager emits them; the fake RPC checks the real filter params and bounds.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { encodeAbiParameters, encodeEventTopics, toEventSelector, type Hex } from 'viem'
import {
  V4_INITIALIZE_TOPIC0,
  V4_POOL_MANAGER_ABI,
  V4_SWAP_TOPIC0,
  buildV4SwapCandles,
  decodeV4Initialize,
  decodeV4Swap,
  nearestPriceAt,
  v4TokenPriceInCounter,
  type RawEvmLog,
} from '../lib/v4SwapCandles.ts'
import { V4_SWAP_MAX_CALLS, V4_SWAP_MAX_LOGS, V4_SWAP_MAX_PAGES, V4_SWAP_PAGE_BLOCKS, V4_SWAP_PAGE_PLAN, V4_SWAP_TARGET_WINDOW_SEC, loadV4SwapCandles, resetV4SwapCandleCache, type V4SwapDeps } from '../lib/server/v4SwapCandlesRpc.ts'
import { buildEvmChartDebugInfo, closeMatchesLivePrice, runEvmCandleLadder, type LadderDeps, type LadderPool, type LadderV4SwapResult } from '../lib/evmChartCandles.ts'
import { buildChartTimeframes, normalizeChartCandles, pickDefaultTimeframe, type ChartCandleInput } from '../lib/priceChartCandles.ts'
import { ETH_USD_SERIES_SLOT_SEC, ETH_USD_SERIES_WINDOW_SEC, fetchCoingeckoEthUsdRecent, resetEthUsdSeriesCache } from '../lib/server/coingeckoOnchainOhlcv.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b'
const POOL = ('0x' + '9f3c'.repeat(16)) as Hex
const OTHER_POOL = ('0x' + '51ab'.repeat(16)) as Hex
const NATIVE = '0x0000000000000000000000000000000000000000'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const TOKEN = '0x1bc0c42215582d5a085795f4badbac3ff36d1bcb'
const SENDER = '0x000000000000000000000000000000000000beef'
const Q96 = BigInt(2) ** BigInt(96)
const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`

/** sqrtPriceX96 for a human price of currency0 quoted in currency1. */
function sqrtX96(price0in1Human: number, dec0: number, dec1: number): bigint {
  const raw = price0in1Human * 10 ** (dec1 - dec0)
  return BigInt(Math.round(Math.sqrt(raw) * 2 ** 96))
}

function initLog(poolId: Hex, currency0: string, currency1: string, block: number): RawEvmLog {
  const topics = encodeEventTopics({ abi: V4_POOL_MANAGER_ABI, eventName: 'Initialize', args: { id: poolId, currency0: currency0 as Hex, currency1: currency1 as Hex } })
  const data = encodeAbiParameters([{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }], [10000, 200, NATIVE, Q96, 0])
  return { address: POOL_MANAGER, topics: topics as string[], data, blockNumber: hex(block), logIndex: '0x0' }
}

function swapLog(poolId: Hex, block: number, sqrtP: bigint, amount0: bigint, amount1: bigint, logIndex = 0): RawEvmLog {
  const topics = encodeEventTopics({ abi: V4_POOL_MANAGER_ABI, eventName: 'Swap', args: { id: poolId, sender: SENDER } })
  const data = encodeAbiParameters([{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }], [amount0, amount1, sqrtP, BigInt(1e18), 0, 10000])
  return { address: POOL_MANAGER, topics: topics as string[], data, blockNumber: hex(block), logIndex: hex(logIndex) }
}

// ── Event identity ───────────────────────────────────────────────────────────────────────────────
test('topic0 derivation matches the repo\'s live-verified V4 ModifyLiquidity topic (same method, same PoolManager ABI)', () => {
  const src = read('lib/server/uniswapV4BaseRpc.ts')
  const verified = src.match(/MODIFY_LIQUIDITY_TOPIC0 = '(0x[0-9a-f]{64})'/)![1]
  assert.equal(toEventSelector('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)'), verified)
  assert.equal(V4_SWAP_TOPIC0, toEventSelector('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'))
  assert.equal(V4_INITIALIZE_TOPIC0, toEventSelector('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'))
  assert.match(src, new RegExp(POOL_MANAGER, 'i'), 'same verified Base PoolManager')
})

test('exact bytes32 PoolId: a Swap/Initialize from another pool on the same PoolManager never decodes', () => {
  assert.ok(decodeV4Swap(swapLog(POOL, 10, sqrtX96(1, 18, 18), BigInt(-1), BigInt(1)), POOL))
  assert.equal(decodeV4Swap(swapLog(OTHER_POOL, 10, sqrtX96(1, 18, 18), BigInt(-1), BigInt(1)), POOL), null)
  assert.ok(decodeV4Initialize(initLog(POOL, NATIVE, TOKEN, 5), POOL))
  assert.equal(decodeV4Initialize(initLog(OTHER_POOL, NATIVE, TOKEN, 5), POOL), null)
  const k = decodeV4Initialize(initLog(POOL, NATIVE, TOKEN, 5), POOL)!
  assert.deepEqual([k.currency0, k.currency1, k.initBlock], [NATIVE, TOKEN, 5])
})

// ── Price math: side, direction, decimals ───────────────────────────────────────────────────────
test('token as currency1 vs native ETH currency0: 1000 tokens per ETH => 0.001 ETH per token', () => {
  const p = v4TokenPriceInCounter(sqrtX96(1000, 18, 18), false, 18, 18)!
  assert.ok(Math.abs(p - 0.001) / 0.001 < 1e-9, String(p))
})

test('token as currency0 vs USDC currency1 (18 vs 6 decimals): $0.5 exactly, not inverted', () => {
  const p = v4TokenPriceInCounter(sqrtX96(0.5, 18, 6), true, 18, 6)!
  assert.ok(Math.abs(p - 0.5) / 0.5 < 1e-9, String(p))
  const wrongSide = v4TokenPriceInCounter(sqrtX96(0.5, 18, 6), false, 18, 6)!
  assert.ok(Math.abs(wrongSide - 2) < 1e-9, 'the wrong side is the exact inverse…')
  const k = [{ timestamp: '2026-01-01T00:00:00Z', open: wrongSide, high: wrongSide, low: wrongSide, close: wrongSide, volume: null, priceUsd: wrongSide }]
  assert.equal(closeMatchesLivePrice(k, 0.5), false, '…which the live-price identity check rejects')
})

test('candles: first/max/min/last real trade price, summed real volume, no empty bucket invented', () => {
  const t0 = 1_800_000_000 - (1_800_000_000 % 300)
  const s = (sec: number, price: number, counter: number, i: number) => ({ blockNumber: i, logIndex: 0, amount0: BigInt(-Math.round(counter * 1e6)), amount1: BigInt(1), sqrtPriceX96: sqrtX96(price, 6, 18), blockTimestamp: null, timestampSec: sec })
  // Token is currency1 against USDC as currency0 (dec 6/18): token price in USDC = 1/price0in1.
  const swaps = [s(t0 + 10, 1 / 2, 100, 1), s(t0 + 50, 1 / 3, 50, 2), s(t0 + 200, 1 / 1.5, 25, 3), s(t0 + 1500, 1 / 2.5, 10, 4)]
  const out = buildV4SwapCandles({ swaps, tokenIsCurrency0: false, decimals0: 6, decimals1: 18, counterUsdAt: () => 1 })
  assert.equal(out.candles.length, 2, 'bucket t0 and t0+1500 only — the 4 empty 5m periods between stay absent')
  const [a, b] = out.candles
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-9
  assert.ok(near(a.open, 2) && near(a.high, 3) && near(a.low, 1.5) && near(a.close, 1.5))
  assert.ok(near(a.volume!, 175), String(a.volume))
  assert.equal(Date.parse(b.timestamp) / 1000, t0 + 1500)
  assert.ok(near(b.open, 2.5) && near(b.close, 2.5) && near(b.volume!, 10))
})

test('a trade whose counter USD price cannot be proven is dropped, never guessed', () => {
  const swaps = [1, 2, 3].map((i) => ({ blockNumber: i, logIndex: 0, amount0: BigInt(-1e15), amount1: BigInt(1e18), sqrtPriceX96: sqrtX96(1000, 18, 18), blockTimestamp: null, timestampSec: 1_800_000_000 + i * 400 }))
  const out = buildV4SwapCandles({ swaps, tokenIsCurrency0: false, decimals0: 18, decimals1: 18, counterUsdAt: (ms) => (ms < (1_800_000_000 + 1000) * 1000 ? 3000 : null) })
  assert.equal(out.tradesUsed, 2)
  assert.equal(out.tradesDropped, 1)
})

test('nearestPriceAt only answers within the allowed gap', () => {
  const series: Array<[number, number]> = [[0, 1], [300_000, 2], [600_000, 3]]
  assert.equal(nearestPriceAt(series, 290_000, 60_000), 2)
  assert.equal(nearestPriceAt(series, 5_000_000, 60_000), null)
})

// ── RPC loader: filters, bounds, caps, budget, gaps, cache ───────────────────────────────────────
const LATEST = 30_000_000
const LATEST_TS = 1_800_000_000
type RpcCall = { method: string; params: unknown[] }

function fakeChain(opts: {
  initBlock?: number
  currency0?: string
  currency1?: string
  swapsPerPage?: (from: number, to: number) => RawEvmLog[]
  failSwapPage?: boolean
  ethPoints?: Array<[number, number]> | null
  ethCached?: boolean
}) {
  const calls: RpcCall[] = []
  let ethCalls = 0
  const deps: V4SwapDeps = {
    now: () => LATEST_TS * 1000,
    rpc: async (method, params) => {
      calls.push({ method, params })
      if (method === 'eth_getBlockByNumber') return { result: { number: hex(LATEST), timestamp: hex(LATEST_TS) }, error: false }
      const f = params[0] as { address: string; topics: string[]; fromBlock: string; toBlock: string }
      if (f.topics[0] === V4_INITIALIZE_TOPIC0) return { result: [initLog(POOL, opts.currency0 ?? NATIVE, opts.currency1 ?? TOKEN, opts.initBlock ?? LATEST - 50_000)], error: false }
      if (opts.failSwapPage) return { result: null, error: true }
      return { result: (opts.swapsPerPage ?? (() => []))(Number(BigInt(f.fromBlock)), Number(BigInt(f.toBlock))), error: false }
    },
    ethUsdSeries: async () => {
      ethCalls++
      const points: Array<[number, number]> | null = opts.ethPoints === undefined ? Array.from({ length: 300 }, (_, i) => [(LATEST_TS - 24 * 3600 + i * 300) * 1000, 3000]) : opts.ethPoints
      return { points, cacheHit: opts.ethCached === true }
    },
  }
  return { deps, calls, ethCalls: () => ethCalls }
}
const swapPages = (calls: RpcCall[]) => calls.filter((x) => x.method === 'eth_getLogs' && (x.params[0] as { topics: string[] }).topics[0] === V4_SWAP_TOPIC0)

// Token (currency1) at 0.001 ETH = $3 with ETH at $3000; one swap every 60 blocks (2 min).
const tokenSwaps = (from: number, to: number, pricePerEth = 1000) => {
  const out: RawEvmLog[] = []
  for (let b = Math.ceil(from / 60) * 60; b <= to; b += 60) out.push(swapLog(POOL, b, sqrtX96(pricePerEth, 18, 18), BigInt(-1e16), BigInt(1e19)))
  return out
}
const withTs = (logs: RawEvmLog[]) => logs.map((l) => ({ ...l, blockTimestamp: hex(LATEST_TS - (LATEST - Number(BigInt(l.blockNumber!))) * 2) }))
const base = { chain: 'base', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 3 }

test('loader: exact PoolManager + [Swap topic, PoolId] filter; USD candles from real swaps; token side from Initialize', async () => {
  resetV4SwapCandleCache()
  const c = fakeChain({ swapsPerPage: (f, t) => [...tokenSwaps(f, t), swapLog(OTHER_POOL, t, sqrtX96(1, 18, 18), BigInt(-1), BigInt(1))] })
  const r = await loadV4SwapCandles(base, c.deps)
  assert.equal(r.ok, true, String(r.code))
  assert.equal(r.tokenCurrencyIndex, 1)
  assert.equal(r.counterAsset, 'eth')
  for (const sc of swapPages(c.calls)) {
    const f = sc.params[0] as { address: string; topics: string[] }
    assert.equal(f.address, POOL_MANAGER)
    assert.deepEqual(f.topics, [V4_SWAP_TOPIC0, POOL])
  }
  assert.ok(r.candles.every((k) => Math.abs(k.close - 3) < 1e-6), 'the other pool\'s price (1:1) never leaked in')
})

test('normal Base V4 scan (46-day-old pool): 24h of real swaps in 1 header + 1 Initialize + 3 pages + 1 ETH/USD = 6 calls', async () => {
  resetV4SwapCandleCache()
  const c = fakeChain({ initBlock: LATEST - 46 * 43_200, swapsPerPage: tokenSwaps })
  const r = await loadV4SwapCandles(base, c.deps)
  assert.equal(r.ok, true)
  const pages = swapPages(c.calls).map((p) => p.params[0] as { fromBlock: string; toBlock: string }).map((f) => [Number(BigInt(f.fromBlock)), Number(BigInt(f.toBlock))])
  assert.deepEqual(pages.map(([f, t]) => t - f + 1), [...V4_SWAP_PAGE_PLAN], '4h + 8h + 12h pages, newest first')
  for (let i = 1; i < pages.length; i++) assert.equal(pages[i][1], pages[i - 1][0] - 1, 'contiguous: no block skipped between pages')
  assert.equal(LATEST - pages[pages.length - 1][0] + 1, V4_SWAP_TARGET_WINDOW_SEC / 2, 'exactly 24h of Base blocks, never older')
  assert.equal(r.budgetStopReason, 'target_window')
  assert.deepEqual([r.callsUsed, r.rpcCalls, r.providerCalls], [6, 5, 1])
  // One swap per 2 min over 24h, inferred times => 15M candles spanning ~24h (was ~17 x 15M from a single 4h page).
  const span = (Date.parse(r.candles[r.candles.length - 1].timestamp) - Date.parse(r.candles[0].timestamp)) / 3_600_000
  assert.ok(r.candles.length >= 95 && span >= 23.5, `${r.candles.length} candles over ${span}h`)
  const set = buildChartTimeframes(normalizeChartCandles(r.candles.map((k) => ({ ...k }))), r.intervalSec)
  assert.ok(set.timeframes.find((t) => t.key === '15M')!.candles.length >= 95)
  assert.ok(set.timeframes.find((t) => t.key === '1H')!.candles.length >= 24)
})

test('warm scan: Initialize cached per PoolId and ETH/USD shared => 2 calls; result cache hit => 0 calls', async () => {
  resetV4SwapCandleCache()
  await loadV4SwapCandles(base, fakeChain({ swapsPerPage: tokenSwaps }).deps)
  const other = fakeChain({ swapsPerPage: tokenSwaps, ethCached: true })
  const r2 = await loadV4SwapCandles({ ...base, token: TOKEN.replace('1b', '1c') }, other.deps) // different token key, same PoolId
  assert.equal(r2.cache.initialize, true)
  assert.equal(other.calls.filter((x) => (x.params[0] as { topics?: string[] })?.topics?.[0] === V4_INITIALIZE_TOPIC0).length, 0)
  const again = fakeChain({ swapsPerPage: tokenSwaps })
  const r3 = await loadV4SwapCandles(base, again.deps)
  assert.equal(again.calls.length, 0)
  assert.equal(again.ethCalls(), 0)
  assert.deepEqual([r3.callsUsed, r3.cache.result], [0, true])
})

test('bounds: <= 3 pages covering <= 24h, never before the pool\'s creation block, <= 6,000 logs (newest kept)', async () => {
  resetV4SwapCandleCache()
  const sparse = (f: number, t: number) => [swapLog(POOL, t, sqrtX96(1000, 18, 18), BigInt(-1e16), BigInt(1e19))]
  const c = fakeChain({ swapsPerPage: sparse })
  const r = await loadV4SwapCandles(base, c.deps)
  const pages = swapPages(c.calls)
  assert.ok(pages.length <= V4_SWAP_MAX_PAGES)
  for (const p of pages) {
    const f = p.params[0] as { fromBlock: string; toBlock: string }
    assert.ok(Number(BigInt(f.fromBlock)) >= LATEST - V4_SWAP_TARGET_WINDOW_SEC / 2 + 1, 'no normal scan crawls past 24h')
  }
  assert.ok(r.callsUsed <= V4_SWAP_MAX_CALLS)
  // Young token (< 6h: 750 blocks = 25 min): one page from its creation block — all of its history.
  resetV4SwapCandleCache()
  const young = fakeChain({ initBlock: LATEST - 750, swapsPerPage: tokenSwaps })
  const yr = await loadV4SwapCandles(base, young.deps)
  const yp = swapPages(young.calls)
  assert.equal(yp.length, 1)
  assert.equal(Number(BigInt((yp[0].params[0] as { fromBlock: string }).fromBlock)), LATEST - 750)
  assert.equal(yr.budgetStopReason, null, 'reached pool creation')
  // 10h-old token: two pages reach creation — the full available history, no third page.
  resetV4SwapCandleCache()
  const tenH = fakeChain({ initBlock: LATEST - 18_000, swapsPerPage: tokenSwaps })
  const tr = await loadV4SwapCandles(base, tenH.deps)
  assert.equal(swapPages(tenH.calls).length, 2)
  assert.equal(Number(BigInt((swapPages(tenH.calls)[1].params[0] as { fromBlock: string }).fromBlock)), LATEST - 18_000)
  assert.ok(Date.parse(tr.candles[0].timestamp) / 1000 <= LATEST_TS - 9.5 * 3600, 'candles start near creation')
  // Busy pool: a 5,000-log first page keeps later pages at 4h; the 6,000-log cap stops paging.
  resetV4SwapCandleCache()
  const many = (f: number, t: number) => Array.from({ length: 5_000 }, (_, i) => swapLog(POOL, t - (i % 100), sqrtX96(1000, 18, 18), BigInt(-1e16), BigInt(1e19), i))
  const busy = fakeChain({ swapsPerPage: many })
  const capped = await loadV4SwapCandles(base, busy.deps)
  assert.equal(capped.logsFound, V4_SWAP_MAX_LOGS)
  assert.equal(capped.budgetStopReason, 'log_cap')
  const bp = swapPages(busy.calls).map((p) => p.params[0] as { fromBlock: string; toBlock: string })
  assert.equal(Number(BigInt(bp[1].toBlock)) - Number(BigInt(bp[1].fromBlock)) + 1, V4_SWAP_PAGE_BLOCKS)
})

test('log cap keeps the NEWEST swaps (no gap near now) and drops the partial oldest bucket', async () => {
  resetV4SwapCandleCache()
  // One page, returned oldest-first like the RPC does, with more logs than the cap.
  const dense = (f: number, t: number) => {
    const out: RawEvmLog[] = []
    for (let b = Math.max(f, t - 7_199); b <= t; b++) out.push(swapLog(POOL, b, sqrtX96(1000, 18, 18), BigInt(-1e16), BigInt(1e19)))
    return out
  }
  const r = await loadV4SwapCandles(base, fakeChain({ swapsPerPage: dense }).deps)
  assert.equal(r.ok, true, String(r.code))
  const newest = Date.parse(r.candles[r.candles.length - 1].timestamp) / 1000
  assert.equal(newest, Math.floor(LATEST_TS / 900) * 900, 'the latest bucket (now) is present')
  const oldestKeptBlock = LATEST - V4_SWAP_MAX_LOGS + 1
  const oldestBucket = Math.floor((LATEST_TS - (LATEST - oldestKeptBlock) * 2) / 900) * 900
  assert.ok(Date.parse(r.candles[0].timestamp) / 1000 > oldestBucket, 'the possibly-partial oldest bucket is dropped')
})

test('budget: the read never exceeds the remaining budget, reserves the ETH/USD call, and stops honestly', async () => {
  for (const budget of [0, 1, 2, 3]) {
    resetV4SwapCandleCache()
    const c = fakeChain({ swapsPerPage: tokenSwaps })
    const r = await loadV4SwapCandles(base, c.deps, budget)
    assert.ok(r.callsUsed <= budget, `budget ${budget}: used ${r.callsUsed}`)
    assert.equal(r.code, 'call_budget_exhausted', `budget ${budget}`)
    assert.equal(r.budgetStopReason, 'call_budget')
  }
  resetV4SwapCandleCache()
  const four = await loadV4SwapCandles(base, fakeChain({ swapsPerPage: tokenSwaps }).deps, 4)
  assert.equal(four.ok, true, 'a tight budget still returns the newest 4h page')
  assert.equal(four.callsUsed, 4)
  resetV4SwapCandleCache()
  const stable = await loadV4SwapCandles({ ...base, livePriceUsd: 0.5 }, fakeChain({ currency0: TOKEN, currency1: USDC, swapsPerPage: (f, t) => tokenSwaps(f, t).map((l) => swapLog(POOL, Number(BigInt(l.blockNumber!)), sqrtX96(0.5, 18, 6), BigInt(1e18), BigInt(-5e5))) }).deps, 3)
  assert.equal(stable.ok, true, 'a USDC pool needs no ETH/USD call, so 3 calls suffice')
  assert.equal(stable.callsUsed, 3)
})

test('timestamps: exact 5M only when every log carries its own blockTimestamp; otherwise inferred and 15M', async () => {
  resetV4SwapCandleCache()
  const inferred = await loadV4SwapCandles(base, fakeChain({ swapsPerPage: tokenSwaps }).deps)
  assert.deepEqual([inferred.timeResolution, inferred.intervalSec], ['inferred_block_time', 900])
  resetV4SwapCandleCache()
  const exact = await loadV4SwapCandles(base, fakeChain({ swapsPerPage: (f, t) => withTs(tokenSwaps(f, t)) }).deps)
  assert.deepEqual([exact.timeResolution, exact.intervalSec], ['exact_log_timestamps', 300])
  resetV4SwapCandleCache()
  const mixed = await loadV4SwapCandles(base, fakeChain({ swapsPerPage: (f, t) => { const l = tokenSwaps(f, t); return [...withTs(l.slice(0, 5)), ...l.slice(5)] } }).deps)
  assert.equal(mixed.timeResolution, 'inferred_block_time', 'one missing timestamp => the whole series is inferred')
  for (const k of inferred.candles) assert.equal(Date.parse(k.timestamp) / 1000 % 900, 0)
})

test('loader: an RPC error stops paging with zero retries and an honest gap; reorged logs are ignored', async () => {
  resetV4SwapCandleCache()
  const c = fakeChain({ failSwapPage: true })
  const r = await loadV4SwapCandles(base, c.deps)
  assert.equal(r.code, 'v4_swap_logs_unavailable')
  assert.equal(swapPages(c.calls).length, 1)
  resetV4SwapCandleCache()
  const reorg = await loadV4SwapCandles(base, fakeChain({ swapsPerPage: (f, t) => [...tokenSwaps(f, t), { ...swapLog(POOL, t, sqrtX96(1, 18, 18), BigInt(-1), BigInt(1)), removed: true }] }).deps)
  assert.ok(reorg.candles.every((k) => Math.abs(k.close - 3) < 1e-6), 'a removed (reorged) swap never counts')
})

test('loader gaps: token not in the pool, unproven counter asset, missing ETH/USD, wrong-price identity', async () => {
  resetV4SwapCandleCache()
  assert.equal((await loadV4SwapCandles(base, fakeChain({ currency0: NATIVE, currency1: '0x' + '44'.repeat(20) }).deps)).code, 'token_side_unresolved')
  resetV4SwapCandleCache()
  assert.equal((await loadV4SwapCandles(base, fakeChain({ currency0: '0x' + '01'.repeat(20), currency1: TOKEN, swapsPerPage: tokenSwaps }).deps)).code, 'quote_usd_price_unproven')
  resetV4SwapCandleCache()
  assert.equal((await loadV4SwapCandles(base, fakeChain({ swapsPerPage: tokenSwaps, ethPoints: null }).deps)).code, 'quote_usd_price_unproven')
  resetV4SwapCandleCache()
  assert.equal((await loadV4SwapCandles({ ...base, livePriceUsd: 300 }, fakeChain({ swapsPerPage: tokenSwaps }).deps)).code, 'token_identity_unverified')
})

test('loader: a chain with no V4 configuration returns v4_chain_not_supported with zero calls (ETH / BNB / Robinhood are configured — tests/v4-cross-chain.test.ts)', async () => {
  for (const chain of ['polygon', 'solana', 'avalanche']) {
    const c = fakeChain({})
    const r = await loadV4SwapCandles({ ...base, chain }, c.deps)
    assert.equal(r.code, 'v4_chain_not_supported', chain)
    assert.equal(c.calls.length + c.ethCalls(), 0)
  }
})

// ── Live-readiness fixture: Base V4 PoolManager, Initialize + Swap + Swap + Swap ─────────────────
// Mirrors the exact shape Alchemy returns for eth_getLogs on Base (all standard log fields), for a
// Clanker-style 18-decimal token paired with native ETH (currency0 = 0x0, token = currency1), with a
// swap from ANOTHER PoolId on the same PoolManager interleaved in the same block range.
const LIVE_POOL = '0x' + 'c7a3f2e19d0b84566e21fa0a9e3d7c51b2f40e6d8a1c93b7e5f20d4c6a8b1e37' as Hex
const LIVE_TOKEN = '0xb7f1a0c9d2e34f5a6b7c8d9e0f1a2b3c4d5e6f70'
const alchemyLog = (l: RawEvmLog, block: number, logIndex: number, withTimestamp: boolean) => ({
  ...l,
  blockNumber: hex(block),
  logIndex: hex(logIndex),
  transactionHash: '0x' + (block * 1000 + logIndex).toString(16).padStart(64, '0'),
  transactionIndex: '0x3',
  blockHash: '0x' + block.toString(16).padStart(64, 'a'),
  removed: false,
  ...(withTimestamp ? { blockTimestamp: hex(LATEST_TS - (LATEST - block) * 2) } : {}),
})
// Token priced 0.0000125, 0.0000130, 0.0000120 ETH (80,000 / 76,923.08 / 83,333.33 tokens per ETH).
const LIVE_SWAPS = [
  { block: LATEST - 600, perEth: 80_000, ethIn: 0.5, tokensOut: 40_000 },
  { block: LATEST - 450, perEth: 1 / 0.000013, ethIn: 0.25, tokensOut: 19_500 },
  { block: LATEST - 30, perEth: 1 / 0.000012, ethIn: 0.1, tokensOut: 8_300 },
]
function liveChain(withTimestamp: boolean) {
  const calls: RpcCall[] = []
  const deps: V4SwapDeps = {
    now: () => LATEST_TS * 1000,
    rpc: async (method, params) => {
      calls.push({ method, params })
      if (method === 'eth_getBlockByNumber') return { result: { number: hex(LATEST), timestamp: hex(LATEST_TS), hash: '0x' + '1'.repeat(64) }, error: false }
      const f = params[0] as { topics: string[] }
      if (f.topics[0] === V4_INITIALIZE_TOPIC0) return { result: [alchemyLog(initLog(LIVE_POOL, NATIVE, LIVE_TOKEN, LATEST - 700), LATEST - 700, 12, withTimestamp)], error: false }
      return {
        result: [
          alchemyLog(swapLog(LIVE_POOL, 0, sqrtX96(LIVE_SWAPS[0].perEth, 18, 18), BigInt(-LIVE_SWAPS[0].ethIn * 1e18), BigInt(LIVE_SWAPS[0].tokensOut) * BigInt(1e18)), LIVE_SWAPS[0].block, 40, withTimestamp),
          alchemyLog(swapLog(OTHER_POOL, 0, sqrtX96(5, 18, 18), BigInt(-9e18), BigInt(45e18)), LIVE_SWAPS[0].block, 41, withTimestamp),
          alchemyLog(swapLog(LIVE_POOL, 0, sqrtX96(LIVE_SWAPS[1].perEth, 18, 18), BigInt(-LIVE_SWAPS[1].ethIn * 1e18), BigInt(LIVE_SWAPS[1].tokensOut) * BigInt(1e18)), LIVE_SWAPS[1].block, 7, withTimestamp),
          alchemyLog(swapLog(LIVE_POOL, 0, sqrtX96(LIVE_SWAPS[2].perEth, 18, 18), BigInt(-LIVE_SWAPS[2].ethIn * 1e18), BigInt(LIVE_SWAPS[2].tokensOut) * BigInt(1e18)), LIVE_SWAPS[2].block, 2, withTimestamp),
        ],
        error: false,
      }
    },
    ethUsdSeries: async () => ({ points: Array.from({ length: 160 }, (_, i) => [(LATEST_TS - 13 * 3600 + i * 300) * 1000, 3200] as [number, number]), cacheHit: false }),
  }
  return { deps, calls }
}

test('live-readiness fixture: exact PoolId only, price direction, exact OHLC and volume, 4 calls', async () => {
  resetV4SwapCandleCache()
  const c = liveChain(true)
  const r = await loadV4SwapCandles({ chain: 'base', poolId: LIVE_POOL, token: LIVE_TOKEN, tokenDecimals: 18, livePriceUsd: 0.0384 }, c.deps)
  assert.equal(r.ok, true, String(r.code))
  assert.equal(r.logsFound, 3, 'the other PoolId\'s swap in the same response was ignored')
  assert.equal(r.tokenCurrencyIndex, 1)
  assert.equal(r.timeResolution, 'exact_log_timestamps')
  assert.equal(r.callsUsed, 4)
  const usd = (ethPerToken: number) => ethPerToken * 3200
  const near = (a: number, b: number) => Math.abs(a - b) / b < 1e-9
  // Swap times: -1200s, -900s, -60s from LATEST_TS. 5m buckets: first two share none (-1200 and -900
  // fall in different 5m buckets only if they straddle a boundary) — compute the expected buckets.
  const times = LIVE_SWAPS.map((s) => LATEST_TS - (LATEST - s.block) * 2)
  const bucketOf = (t: number) => Math.floor(t / 300) * 300
  const expected = new Map<number, number[]>()
  LIVE_SWAPS.forEach((s, i) => { const b = bucketOf(times[i]); expected.set(b, [...(expected.get(b) ?? []), i]) })
  assert.equal(r.candles.length, expected.size)
  for (const k of r.candles) {
    const idx = expected.get(Date.parse(k.timestamp) / 1000)!
    const prices = idx.map((i) => usd(1 / LIVE_SWAPS[i].perEth))
    assert.ok(near(k.open, prices[0]) && near(k.close, prices[prices.length - 1]))
    assert.ok(near(k.high, Math.max(...prices)) && near(k.low, Math.min(...prices)))
    assert.ok(near(k.volume!, idx.reduce((sum, i) => sum + LIVE_SWAPS[i].ethIn * 3200, 0)), `volume ${k.volume}`)
  }
  assert.ok(near(r.candles[r.candles.length - 1].close, 0.0384), 'latest close = 0.000012 ETH x $3200 = $0.0384')
})

test('live-readiness fixture: budget stop + cache hit', async () => {
  resetV4SwapCandleCache()
  const tight = liveChain(true)
  const stopped = await loadV4SwapCandles({ chain: 'base', poolId: LIVE_POOL, token: LIVE_TOKEN, tokenDecimals: 18, livePriceUsd: 0.0384 }, tight.deps, 2)
  assert.deepEqual([stopped.ok, stopped.code, stopped.budgetStopReason], [false, 'call_budget_exhausted', 'call_budget'])
  assert.ok(stopped.callsUsed <= 2)
  const full = liveChain(true)
  await loadV4SwapCandles({ chain: 'base', poolId: LIVE_POOL, token: LIVE_TOKEN, tokenDecimals: 18, livePriceUsd: 0.0384 }, full.deps)
  const warm = liveChain(true)
  const hit = await loadV4SwapCandles({ chain: 'base', poolId: LIVE_POOL, token: LIVE_TOKEN, tokenDecimals: 18, livePriceUsd: 0.0384 }, warm.deps)
  assert.equal(warm.calls.length, 0)
  assert.deepEqual([hit.ok, hit.callsUsed, hit.cache.result], [true, 0, true])
})

// ── Ladder / route / debug wiring ────────────────────────────────────────────────────────────────
const rel = { base_token: { data: { id: `base_${TOKEN}` } }, quote_token: { data: { id: `base_0x4200000000000000000000000000000000000006` } } }
const lpool = (id: string): LadderPool => ({ poolId: `base_${id}`, address: id, name: 'TKN / WETH', liquidityUsd: 1e5, pool: { id: `base_${id}`, relationships: rel } })
const v4ok = (n: number, callsUsed = 4): LadderV4SwapResult => ({ ok: true, code: null, poolManager: POOL_MANAGER, logsFound: n * 3, candles: Array.from({ length: n }, (_, i) => ({ timestamp: new Date((LATEST_TS - (n - i) * 300) * 1000).toISOString(), open: 3, high: 3.1, low: 2.9, close: 3, volume: 10, priceUsd: 3 })), intervalSec: 300, timeResolution: 'exact_log_timestamps', callsUsed, pagesFetched: 1, budgetStopReason: 'target_window' })

function ladderDeps(v4: LadderV4SwapResult | null, calls: string[], budgets: number[] = []): LadderDeps {
  return {
    fetchCoingeckoPoolOhlcv: async (a) => { calls.push(`CG ${a}`); return { httpStatus: 404, json: null } },
    fetchPoolOhlcv: async (a) => { calls.push(`GT ${a}`); return { httpStatus: 404, json: null } },
    fetchTrades: async (a) => { calls.push(`trades ${a}`); return { httpStatus: 200, json: { data: [] } } },
    ...(v4 ? { fetchV4SwapCandles: async (p: LadderPool, budget: number) => { calls.push(`V4 ${p.address}`); budgets.push(budget); return v4 } } : {}),
  }
}

test('ladder: V4 calls count inside the 10-call cap; exposes used / remaining / stop reason', async () => {
  const calls: string[] = []
  const budgets: number[] = []
  const r = await runEvmCandleLadder({ pools: [lpool(POOL)], contract: TOKEN, networkId: 'base', coingeckoNetworkId: 'base', currentPriceUsd: 3 }, ladderDeps(v4ok(30), calls, budgets))
  assert.deepEqual(calls, [`V4 ${POOL}`])
  assert.deepEqual(budgets, [10], 'the V4 read is handed the whole remaining budget')
  assert.equal(r.totalHttpCalls, 4)
  assert.deepEqual(r.callBudget, { max: 10, used: 4, remaining: 6, stopReason: null })
  assert.equal(r.candleProvider, 'v4_swap_events')
  const d = buildEvmChartDebugInfo({ chain: 'base', network: 'base', scannedToken: TOKEN, attempts: r.attempts, candleFailure: r.candleFailure, selectedPoolAddress: POOL, tokenSide: 'base', rateLimited: false, usedEstimatedTrend: false, source: 'v4_swap_events', finalCandleCount: 30, v4Swap: r.v4Swap, callBudget: r.callBudget })
  assert.equal(d.finalSource, 'v4_swap_events')
  assert.deepEqual(d.callBudget, { callsUsed: 4, callsRemaining: 6, budgetStopReason: null })
  assert.deepEqual([d.v4?.poolId, d.v4?.poolManager, d.v4?.timeResolution, d.v4?.callsUsed], [POOL, POOL_MANAGER, 'exact_log_timestamps', 4])
})

test('ladder: V4 read only gets what V3 alternates left; an exhausted budget stops honestly with 0 extra calls', async () => {
  const v3a = '0x' + '7a'.repeat(20)
  const v3b = '0x' + '7b'.repeat(20)
  const budgets: number[] = []
  await runEvmCandleLadder({ pools: [lpool(POOL), lpool(v3a), lpool(v3b)], contract: TOKEN, networkId: 'base', coingeckoNetworkId: 'base', currentPriceUsd: 3 }, ladderDeps(v4ok(30), [], budgets))
  assert.deepEqual(budgets, [8], '2 GeckoTerminal alternate reads already used')
  const calls: string[] = []
  const r = await runEvmCandleLadder({ pools: [lpool(POOL), lpool(v3a), lpool(v3b)], contract: TOKEN, networkId: 'base', coingeckoNetworkId: 'base', currentPriceUsd: 3, maxOhlcvCalls: 2 }, ladderDeps(v4ok(30), calls))
  assert.ok(!calls.some((c) => c.startsWith('V4')), 'no budget left => the V4 read is not even started')
  assert.equal(r.v4Swap?.code, 'call_budget_exhausted')
  assert.ok(r.totalHttpCalls <= 2)
  assert.ok(r.callBudget.stopReason)
})

test('ladder: worst case for the whole candle path stays <= 10 with V4 included', async () => {
  const calls: string[] = []
  const heavy: LadderV4SwapResult = { ...v4ok(0, 6), ok: false, code: 'v4_swap_history_empty', candles: [] }
  const r = await runEvmCandleLadder({ pools: [lpool(POOL), lpool('0x' + '7a'.repeat(20)), lpool('0x' + '7b'.repeat(20))], contract: TOKEN, networkId: 'base', coingeckoNetworkId: 'base', currentPriceUsd: 3 }, ladderDeps(heavy, calls))
  assert.ok(r.totalHttpCalls <= 10, String(r.totalHttpCalls))
  assert.ok(r.callBudget.used <= 10 && r.callBudget.remaining >= 0)
})

test('ladder: V4 fallback failure keeps the honest reason; V3 pools never touch the V4 path', async () => {
  const fail: LadderV4SwapResult = { ...v4ok(0, 3), ok: false, code: 'quote_usd_price_unproven', candles: [] }
  const r = await runEvmCandleLadder({ pools: [lpool(POOL)], contract: TOKEN, networkId: 'base', coingeckoNetworkId: 'base', currentPriceUsd: 3 }, ladderDeps(fail, []))
  assert.equal(r.priceChart, null, 'route then shows the estimated trend, labelled with this reason')
  assert.equal(r.candleFailure?.code, 'quote_usd_price_unproven')
  const v3 = '0x' + '7a'.repeat(20)
  const calls3: string[] = []
  await runEvmCandleLadder({ pools: [lpool(v3)], contract: TOKEN, networkId: 'base', coingeckoNetworkId: 'base', currentPriceUsd: 3 }, ladderDeps(v4ok(30), calls3))
  assert.ok(!calls3.some((c) => c.startsWith('V4')), 'V3 pool: unchanged CoinGecko -> GeckoTerminal -> trades ladder')
  assert.equal(calls3[0], `CG ${v3}`)
})

test('route + page wiring: budget handed to the V4 loader, shared ETH series, v4_swap_events is a real chart source', () => {
  const route = read('app/api/token/route.ts')
  assert.match(route, /fetchV4SwapCandles: async \(pool, budget\) =>/)
  assert.match(route, /ethUsdSeries: \(timeoutMs\) => fetchCoingeckoEthUsdRecent\(timeoutMs\),/)
  assert.match(route, /\}\),\s*\},\s*budget,\s*\)/, 'the remaining candle budget is handed to the V4 loader')
  assert.match(route, /chartCandleProvider === 'v4_swap_events' \? 'v4_swap_events' :/)
  const page = read('app/terminal/token-scanner/page.tsx')
  assert.match(page, /const _REAL_SOURCES = new Set\(\['pool_ohlcv', 'token_level_ohlcv', 'dexscreener_ohlcv', 'trade_reconstructed', 'v4_swap_events'\]\)/)
  assert.match(page, /Pool model: Uniswap V4/)
  assert.match(page, /inferred from block number — not exact 5M/)
})

// ── ETH/USD quote series (one shared, cached request) ────────────────────────────────────────────
test('ETH/USD series: one request per 10-minute slot shared by every scan; key only in a header', async () => {
  const KEY = 'CG-eth-series-secret'
  const prev = process.env.COINGECKO_API_KEY
  process.env.COINGECKO_API_KEY = KEY
  resetEthUsdSeriesCache()
  try {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const f = async (url: string, init: { headers: Record<string, string> }) => { seen.push({ url, headers: init.headers }); return { status: 200, ok: true, json: async () => ({ prices: [[2000, 3001], [1000, 3000]], market_caps: [], total_volumes: [] }) } }
    const t = 1_800_000_000_000
    const out = await fetchCoingeckoEthUsdRecent(3000, f, () => t)
    assert.deepEqual(out.points, [[1000, 3000], [2000, 3001]])
    assert.match(seen[0].url, new RegExp(`/coins/ethereum/market_chart/range\\?vs_currency=usd&from=${1_800_000_000 + 600 - ETH_USD_SERIES_WINDOW_SEC}&to=${1_800_000_000 + 600}$`))
    assert.equal(seen[0].headers['x-cg-demo-api-key'], KEY)
    assert.doesNotMatch(JSON.stringify(out) + seen[0].url, new RegExp(KEY))
    const sameSlot = await fetchCoingeckoEthUsdRecent(3000, f, () => t + 500_000)
    assert.equal(sameSlot.cacheHit, true)
    assert.equal(seen.length, 1)
    const nextSlot = await fetchCoingeckoEthUsdRecent(3000, f, () => t + ETH_USD_SERIES_SLOT_SEC * 1000)
    assert.equal(nextSlot.cacheHit, false)
    assert.equal(seen.length, 2)
  } finally {
    if (prev === undefined) delete process.env.COINGECKO_API_KEY
    else process.env.COINGECKO_API_KEY = prev
  }
})

// ── Young-token timeframe availability ───────────────────────────────────────────────────────────
const H4 = 14_400
const start = 1_800_000_000 - (1_800_000_000 % 86_400) // a day (and 4H) boundary
const fiveMinCandles = (minutes: number, from = start): ChartCandleInput[] =>
  Array.from({ length: Math.floor(minutes / 5) }, (_, i) => ({ timestamp: from + i * 300, open: 1, high: 1.1, low: 0.9, close: 1, volume: 1 }))
const tf = (minutes: number, from = start) => buildChartTimeframes(normalizeChartCandles(fiveMinCandles(minutes, from)), 300)
const avail = (set: ReturnType<typeof tf>) => Object.fromEntries(set.timeframes.map((t) => [t.key, t.available]))

test('25-minute token: real 5M and 15M work, 1H/4H/1D stay off; defaults to 15M', () => {
  const set = tf(25)
  assert.deepEqual(avail(set), { '5M': true, '15M': true, '1H': false, '4H': false, '1D': false })
  assert.equal(pickDefaultTimeframe(set), '15M')
})

test('10-minute token (one 15m bucket): only 5M, and it is picked', () => {
  const set = tf(10)
  assert.deepEqual(avail(set), { '5M': true, '15M': false, '1H': false, '4H': false, '1D': false })
  assert.equal(pickDefaultTimeframe(set), '5M')
})

test('2.5h token: 5M / 15M / 1H; 6h token also gets 4H (2 real buckets); 1D off with one daily bucket', () => {
  assert.deepEqual(avail(tf(150)), { '5M': true, '15M': true, '1H': true, '4H': false, '1D': false })
  const six = tf(360)
  assert.deepEqual(avail(six), { '5M': true, '15M': true, '1H': true, '4H': true, '1D': false })
  assert.equal(six.timeframes.find((t) => t.key === '4H')!.candles.length, 2)
  assert.ok(six.timeframes.find((t) => t.key === '1D')!.unavailableReason)
  assert.equal(H4, 4 * 3600)
})

test('no missing period is filled: a trading gap stays a gap in every timeframe', () => {
  const candles = [...fiveMinCandles(15), ...fiveMinCandles(15, start + 7200)]
  const set = buildChartTimeframes(normalizeChartCandles(candles), 300)
  const oneH = set.timeframes.find((t) => t.key === '1H')!
  assert.equal(oneH.candles.length, 2, 'hours 0 and 2 only — hour 1 had no trades and is not invented')
  assert.equal(set.timeframes.find((t) => t.key === '5M')!.candles.length, 6)
})
