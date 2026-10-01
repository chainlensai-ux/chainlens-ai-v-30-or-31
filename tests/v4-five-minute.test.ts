// Token Scanner V4 5M: an exact bytes32 Uniswap V4 PoolId's 5M chip is served by the pool's OWN on-chain
// Swap events (lib/server/v4SwapCandlesRpc.ts loadV4SwapFiveMinuteWindow), never by provider PoolId OHLCV.
// Real 300s buckets only when every swap log carries its exact timestamp; never derived from 15M.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem'
import { V4_INITIALIZE_TOPIC0, V4_POOL_MANAGER_ABI, type RawEvmLog } from '../lib/v4SwapCandles.ts'
import {
  V4_EXACT_INTERVAL_SEC, V4_FIVE_MINUTE_NOT_EXACT_MESSAGE, V4_INFERRED_INTERVAL_SEC, V4_SWAP_MAX_CALLS,
  loadV4SwapCandles, loadV4SwapFiveMinuteWindow, resetV4SwapCandleCache, type V4SwapDeps,
} from '../lib/server/v4SwapCandlesRpc.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b'
const POOL = ('0x' + '9f3c'.repeat(16)) as Hex
const OTHER_POOL = ('0x' + '51ab'.repeat(16)) as Hex
const NATIVE = '0x0000000000000000000000000000000000000000'
const TOKEN = '0x1bc0c42215582d5a085795f4badbac3ff36d1bcb'
const STRANGER = '0x2222222222222222222222222222222222222222'
const SENDER = '0x000000000000000000000000000000000000beef'
const Q96 = BigInt(2) ** BigInt(96)
const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`
const LATEST = 30_000_000
const LATEST_TS = 1_800_000_000
const sqrtX96 = (p: number) => BigInt(Math.round(Math.sqrt(p) * 2 ** 96))

function initLog(poolId: Hex, currency0: string, currency1: string, block: number): RawEvmLog {
  const topics = encodeEventTopics({ abi: V4_POOL_MANAGER_ABI, eventName: 'Initialize', args: { id: poolId, currency0: currency0 as Hex, currency1: currency1 as Hex } })
  const data = encodeAbiParameters([{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }], [10000, 200, NATIVE, Q96, 0])
  return { address: POOL_MANAGER, topics: topics as string[], data, blockNumber: hex(block), logIndex: '0x0' }
}
function swapLog(poolId: Hex, block: number, pricePerEth: number, exactTs: boolean): RawEvmLog {
  const topics = encodeEventTopics({ abi: V4_POOL_MANAGER_ABI, eventName: 'Swap', args: { id: poolId, sender: SENDER } })
  const data = encodeAbiParameters([{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }], [BigInt(-1e16), BigInt(1e19), sqrtX96(pricePerEth), BigInt(1e18), 0, 10000])
  return { address: POOL_MANAGER, topics: topics as string[], data, blockNumber: hex(block), logIndex: '0x0', ...(exactTs ? { blockTimestamp: hex(LATEST_TS - (LATEST - block) * 2) } : {}) }
}
const tsOf = (block: number) => LATEST_TS - (LATEST - block) * 2

type Call = { method: string; params: unknown[] }
// Base V4 pool: native ETH currency0, scanned token currency1, one swap every 60 blocks (2 min), token $3.
function chain(opts: { exactTs: boolean; currency1?: string; withOtherPool?: boolean }) {
  const calls: Call[] = []
  const providerCalls: string[] = []
  const swapBlocks: number[] = []
  const deps: V4SwapDeps = {
    now: () => LATEST_TS * 1000,
    rpc: async (method, params) => {
      calls.push({ method, params })
      if (method === 'eth_getBlockByNumber') return { result: { number: hex(LATEST), timestamp: hex(LATEST_TS) }, error: false }
      if (method === 'eth_call') return { result: hex(18), error: false }
      const f = params[0] as { topics: string[]; fromBlock: string; toBlock: string }
      if (f.topics[0] === V4_INITIALIZE_TOPIC0) return { result: [initLog(POOL, NATIVE, opts.currency1 ?? TOKEN, LATEST - 50_000)], error: false }
      const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock))
      const out: RawEvmLog[] = []
      for (let b = Math.ceil(from / 60) * 60; b <= to; b += 60) { out.push(swapLog(POOL, b, 1000, opts.exactTs)); swapBlocks.push(b) }
      if (opts.withOtherPool) out.push(swapLog(OTHER_POOL, to, 1, opts.exactTs))
      return { result: out, error: false }
    },
    ethUsdSeries: async () => {
      providerCalls.push('eth_usd')
      return { points: Array.from({ length: 300 }, (_, i) => [(LATEST_TS - 24 * 3600 + i * 300) * 1000, 3000] as [number, number]), cacheHit: false }
    },
    quoteUsd: async () => { providerCalls.push('quote_usd'); throw new Error('not used for a native pair') },
  }
  return { deps, calls, providerCalls, swapBlocks }
}

test('bytes32 Uniswap V4 + exact timestamps: 5M succeeds from real swaps (intervalSec 300, source v4_swap_events)', async () => {
  resetV4SwapCandleCache()
  const c = chain({ exactTs: true })
  const r = await loadV4SwapFiveMinuteWindow({ chain: 'base', poolId: POOL, token: TOKEN }, c.deps)
  assert.equal(r.ok, true, String(r.code))
  assert.equal(r.intervalSec, 300)
  assert.equal(r.intervalSec, V4_EXACT_INTERVAL_SEC)
  assert.equal(r.source, 'v4_swap_events')
  assert.equal(r.timeResolution, 'exact_log_timestamps')
  assert.ok(r.candles.length >= 200, String(r.candles.length))
  assert.equal(r.windowProven, true, 'the full 24h window was read')
  // Bounded: 1 decimals read + the scan pipeline's own caps.
  assert.ok(r.callsUsed <= V4_SWAP_MAX_CALLS + 1, String(r.callsUsed))
  assert.equal(c.calls.filter((x) => x.method === 'eth_call').length, 1)
  assert.ok(r.candles.every((k) => Math.abs(k.close - 3) < 1e-6), 'USD price from real ETH/USD evidence')
})

test('returned buckets are exactly 300s and each holds at least one real swap (no interpolated candle)', async () => {
  resetV4SwapCandleCache()
  const c = chain({ exactTs: true })
  const r = await loadV4SwapFiveMinuteWindow({ chain: 'base', poolId: POOL, token: TOKEN }, c.deps)
  const realBuckets = new Set(c.swapBlocks.map((b) => Math.floor(tsOf(b) / 300) * 300))
  const secs = r.candles.map((k) => Date.parse(k.timestamp) / 1000)
  for (let i = 0; i < secs.length; i++) {
    assert.equal(secs[i] % 300, 0, 'aligned to a 5-minute boundary')
    assert.ok(realBuckets.has(secs[i]), 'every candle is a bucket of real swaps')
    if (i > 0) assert.ok(secs[i] - secs[i - 1] >= 300 && (secs[i] - secs[i - 1]) % 300 === 0, 'ascending 300s steps')
  }
})

test('provider PoolId unsupported does NOT block the V4 RPC 5M path: no provider OHLCV, route branch precedes it', async () => {
  resetV4SwapCandleCache()
  const c = chain({ exactTs: true })
  const r = await loadV4SwapFiveMinuteWindow({ chain: 'base', poolId: POOL, token: TOKEN }, c.deps)
  assert.equal(r.ok, true)
  assert.deepEqual(c.providerCalls, ['eth_usd'], 'only the quote USD evidence — never a pool OHLCV provider')
  assert.ok(c.calls.every((x) => x.method.startsWith('eth_')), 'every other call is a JSON-RPC read')
  const route = read('app/api/token/chart-candles/route.ts')
  const v4At = route.indexOf("if ((tfParam === '5m' || tfParam === '1m') && isV4Pool)")
  const providerAt = route.indexOf('const { result } = await loadOnDemandCandles(')
  assert.ok(v4At > 0 && providerAt > v4At, 'the bytes32 V4 5M branch runs before (and instead of) provider pool OHLCV')
  assert.match(route, /loadV4SwapIntradayWindow\(\{ chain: fiveChain, poolId: fivePool, token: url\.searchParams\.get\('token'\) \?\? '', intervalSec: tfParam === '1m' \? 60 : 300 \}, deps\)/)
  assert.match(route, /source: 'v4_swap_events'/)
})

test('inferred / non-exact V4 timestamps: 5M unavailable with the exact reason; the scan keeps its 15M', async () => {
  resetV4SwapCandleCache()
  const c = chain({ exactTs: false })
  const r = await loadV4SwapFiveMinuteWindow({ chain: 'base', poolId: POOL, token: TOKEN }, c.deps)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'v4_timestamps_not_exact')
  assert.equal(r.timeResolution, 'inferred_block_time')
  assert.deepEqual(r.candles, [], 'never 5-minute cuts of inferred times')
  assert.match(V4_FIVE_MINUTE_NOT_EXACT_MESSAGE, /^exact swap timestamps are not available for this V4 pool/)
  assert.match(V4_FIVE_MINUTE_NOT_EXACT_MESSAGE, /15M stays available/)
  const route = read('app/api/token/chart-candles/route.ts')
  assert.match(route, /if \(code === 'v4_timestamps_not_exact'\) return label === '1M' \? V4_ONE_MINUTE_NOT_EXACT_MESSAGE : V4_FIVE_MINUTE_NOT_EXACT_MESSAGE/)
  // The scan's own read of the same pool still charts at 15M.
  resetV4SwapCandleCache()
  const scan = await loadV4SwapCandles({ chain: 'base', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 3 }, chain({ exactTs: false }).deps)
  assert.equal(scan.ok, true)
  assert.equal(scan.intervalSec, V4_INFERRED_INTERVAL_SEC)
  // ...and the 5M answer from that cached scan is the same precise reason, with zero calls.
  const again = chain({ exactTs: false })
  const f = await loadV4SwapFiveMinuteWindow({ chain: 'base', poolId: POOL, token: TOKEN }, again.deps)
  assert.deepEqual([f.code, f.callsUsed, again.calls.length, f.cache.scanResult], ['v4_timestamps_not_exact', 0, 0, true])
})

test('wrong PoolId / token identity rejected; another pool on the same manager never leaks in', async () => {
  resetV4SwapCandleCache()
  const wrongToken = await loadV4SwapFiveMinuteWindow({ chain: 'base', poolId: POOL, token: STRANGER }, chain({ exactTs: true }).deps)
  assert.equal(wrongToken.ok, false)
  assert.equal(wrongToken.code, 'token_side_unresolved', 'the scanned token must be a currency of exactly this PoolId (Initialize)')
  const pool20 = await loadV4SwapFiveMinuteWindow({ chain: 'base', poolId: '0x' + 'ab'.repeat(20), token: TOKEN }, chain({ exactTs: true }).deps)
  assert.equal(pool20.code, 'invalid_request')
  const unsupported = await loadV4SwapFiveMinuteWindow({ chain: 'arbitrum', poolId: POOL, token: TOKEN }, chain({ exactTs: true }).deps)
  assert.equal(unsupported.code, 'v4_chain_not_supported')
  resetV4SwapCandleCache()
  const mixed = chain({ exactTs: true, withOtherPool: true })
  const r = await loadV4SwapFiveMinuteWindow({ chain: 'base', poolId: POOL, token: TOKEN }, mixed.deps)
  assert.equal(r.ok, true)
  assert.ok(r.candles.every((k) => Math.abs(k.low - 3) < 1e-6), "the other pool's 1:1 price never leaked in")
})

test('20-byte pool 5M path unchanged: provider pool OHLCV via loadOnDemandCandles', () => {
  const route = read('app/api/token/chart-candles/route.ts')
  // The V4 branch only takes a bytes32 PoolId on a V4-configured chain; everything else falls through unchanged.
  assert.match(route, /const isV4Pool = \/\^0x\[a-fA-F0-9\]\{64\}\$\/\.test\(fivePool\) && Boolean\(V4_SWAP_CHAIN_CONFIG\[fiveChain\]\)/)
  assert.match(route, /const \{ result \} = await loadOnDemandCandles\(\s*\{\s*chain: url\.searchParams\.get\('chain'\),\s*token: url\.searchParams\.get\('token'\),\s*pool: url\.searchParams\.get\('pool'\),\s*timeframe: url\.searchParams\.get\('timeframe'\),/)
})

test('no 5M calls during a normal scan: the 5M lane is only reachable from the on-demand endpoint', () => {
  const scanRoute = read('app/api/token/route.ts')
  assert.doesNotMatch(scanRoute, /loadV4SwapFiveMinuteWindow|makeV4FiveMinuteDeps|timeframe=5m/)
  assert.doesNotMatch(read('lib/evmChartCandles.ts'), /loadV4SwapFiveMinuteWindow/)
  const page = read('app/terminal/token-scanner/page.tsx')
  // The page only builds a loader; the panel calls it when the user clicks 5M.
  assert.match(page, /loadFiveMinute=\{makeFiveMinuteLoader\(result\.chain, result\.contract, result\.chartCandles\?\.poolAddress\)\}/)
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.equal((panel.match(/await loadFiveMinute\(\)/g) ?? []).length, 1)
  assert.match(panel, /const requestFive = async \(\) => \{/)
})

test('cache hit adds zero calls: the scan\'s cached exact read, then this lane\'s own cache; on-demand never pollutes the scan cache', async () => {
  resetV4SwapCandleCache()
  const scan = await loadV4SwapCandles({ chain: 'base', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 3 }, chain({ exactTs: true }).deps)
  assert.equal(scan.intervalSec, 300)
  const viaScan = chain({ exactTs: true })
  const a = await loadV4SwapFiveMinuteWindow({ chain: 'base', poolId: POOL, token: TOKEN }, viaScan.deps)
  assert.equal(a.ok, true)
  assert.deepEqual([a.callsUsed, viaScan.calls.length, viaScan.providerCalls.length, a.cache.scanResult], [0, 0, 0, true])
  assert.deepEqual(a.candles, scan.candles)

  resetV4SwapCandleCache()
  const cold = chain({ exactTs: true })
  const first = await loadV4SwapFiveMinuteWindow({ chain: 'base', poolId: POOL, token: TOKEN }, cold.deps)
  assert.ok(first.callsUsed > 0)
  const warm = chain({ exactTs: true })
  const second = await loadV4SwapFiveMinuteWindow({ chain: 'base', poolId: POOL, token: TOKEN }, warm.deps)
  assert.deepEqual([second.callsUsed, warm.calls.length, second.cache.fiveMinute], [0, 0, true])
  // Concurrent identical clicks share one read.
  resetV4SwapCandleCache()
  const shared = chain({ exactTs: true })
  const [x, y] = await Promise.all([1, 2].map(() => loadV4SwapFiveMinuteWindow({ chain: 'base', poolId: POOL, token: TOKEN }, shared.deps)))
  assert.deepEqual(x, y)
  assert.equal(shared.calls.filter((k) => k.method === 'eth_call').length, 1)
  // The on-demand read (no live price) was never written into the scan cache: a scan still reads its own.
  const scanAfter = chain({ exactTs: true })
  const s2 = await loadV4SwapCandles({ chain: 'base', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 3 }, scanAfter.deps)
  assert.equal(s2.cache.result, false)
  assert.ok(scanAfter.calls.length > 0)
})

test('UI: clicking 5M on an eligible V4 pool loads it and activates the returned V4 candles', () => {
  const page = read('app/terminal/token-scanner/page.tsx')
  // Loadable on every V4-configured chain; the bytes32 PoolId is sent as `pool` (served by the V4 lane).
  assert.match(page, /const ON_DEMAND_5M_CHAINS = new Set\(\['eth', 'base', 'bnb', 'robinhood'\]\)/)
  for (const c of ['eth', 'base', 'bnb', 'robinhood']) assert.match(read('lib/server/v4SwapCandlesRpc.ts'), new RegExp(`\\n  ${c}: \\{\\n    chain: '${c}'`))
  assert.match(page, /function makeFiveMinuteLoader\(chain: string \| null \| undefined, token: string \| null \| undefined, pool: string \| null \| undefined, timeframe: '5m' \| '1m' = '5m'\)/)
  assert.match(page, /const qs = new URLSearchParams\(\{ chain, token, pool, timeframe \}\)/)
  assert.match(page, /if \(json\?\.ok && Array\.isArray\(json\.points\)\) return \{ ok: true, intervalSec: json\.intervalSec \?\? \(timeframe === '1m' \? 60 : 300\), points: json\.points, coverage: json\.coverage \?\? null \}/)
  const route = read('app/api/token/chart-candles/route.ts')
  assert.match(route, /return NextResponse\.json\(\{ ok: true, timeframe: tfParam, intervalSec: f\.intervalSec, points: f\.candles, coverage, timeResolution: f\.timeResolution, source: 'v4_swap_events' \}\)/)
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  // 15M V4 (non-exact) scan: native 5M absent, so the chip is loadable via the loader...
  assert.match(panel, /const fiveLoadable = !nativeFive\.available && loadFiveMinute != null && \(tfSet\.nativeSec \?\? 0\) > FIVE_MIN_SEC/)
  // ...a ready response with >= 2 real candles selects 5M and draws exactly those candles.
  assert.match(panel, /if \(next\.status === 'ready' && next\.candles\.length >= 2\) \{\s*setChipNotice\(null\)\s*setPicked\('5M'\)/)
  assert.match(panel, /const fiveActive = !oneActive && picked === '5M' && fiveLoadable && five\.status === 'ready' && five\.candles\.length >= 2/)
  assert.match(panel, /const priceSeries: ChartCandle\[\] = oneActive && one\.status === 'ready' \? one\.candles : fiveActive && five\.status === 'ready' \? five\.candles :/)
  // A failure shows its precise reason and leaves the other timeframes as they are.
  assert.match(panel, /`5M unavailable — \$\{next\.message\}`/)
})
