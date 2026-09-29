// On-demand Uniswap V4 chart history (lib/server/v4SwapCandlesRpc.ts loadV4SwapHistoryWindow + the
// chart-candles endpoint), the windowed quote-USD lanes, and the client merge (lib/chartHistory.ts +
// PriceChartPanel wiring). Logs are ABI-encoded with viem exactly as PoolManager emits them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem'
import { V4_INITIALIZE_TOPIC0, V4_POOL_MANAGER_ABI, V4_SWAP_TOPIC0, type RawEvmLog } from '../lib/v4SwapCandles.ts'
import {
  V4_HISTORY_FIRST_PAGE_BLOCKS,
  V4_HISTORY_MAX_AGE_SEC,
  V4_HISTORY_MAX_CALLS,
  V4_HISTORY_MAX_LOGS,
  V4_HISTORY_MAX_PAGES,
  V4_HISTORY_MIN_PAGE_BLOCKS,
  loadV4SwapCandles,
  loadV4SwapHistoryWindow,
  resetV4SwapCandleCache,
  type V4HistoryDeps,
} from '../lib/server/v4SwapCandlesRpc.ts'
import { resolveIndependentQuoteUsdWindow, resetQuoteUsdCache } from '../lib/server/v4QuoteUsd.ts'
import { coingeckoOnchainOhlcvPath, fetchCoingeckoEthUsdRange, resetEthUsdRangeCache } from '../lib/server/coingeckoOnchainOhlcv.ts'
import { HISTORY_TARGET_SPAN_SEC, historyCutoffMs, loadedSpanLabel, mergeHistoryCandles, withHistory } from '../lib/chartHistory.ts'
import { buildChartTimeframes, type ChartCandle } from '../lib/priceChartCandles.ts'
import { runEvmCandleLadder, type LadderPool, type LadderV4SwapResult } from '../lib/evmChartCandles.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b'
const POOL = ('0x' + '9f3c'.repeat(16)) as Hex
const OTHER_POOL = ('0x' + '51ab'.repeat(16)) as Hex
const NATIVE = '0x0000000000000000000000000000000000000000'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const WETH = '0x4200000000000000000000000000000000000006'
const BNKR = '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b'
const TOKEN = '0x1bc0c42215582d5a085795f4badbac3ff36d1bcb'
const SENDER = '0x000000000000000000000000000000000000beef'
const Q96 = BigInt(2) ** BigInt(96)
const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`
const LATEST = 30_000_000
const LATEST_TS = 1_800_000_000 - (1_800_000_000 % 3600) + 1800 // mid-hour
const DAY_BLOCKS = 43_200

function sqrtX96(price0in1Human: number, dec0: number, dec1: number): bigint {
  return BigInt(Math.round(Math.sqrt(price0in1Human * 10 ** (dec1 - dec0)) * 2 ** 96))
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
const blockTs = (b: number) => LATEST_TS - (LATEST - b) * 2
const tsBlock = (ts: number) => LATEST - Math.ceil((LATEST_TS - ts) / 2)

type Call = { method: string; params: unknown[] }
function fakeHistory(opts: {
  initBlock?: number
  currency0?: string
  currency1?: string
  swaps?: (from: number, to: number) => RawEvmLog[]
  maxRangeBlocks?: number
  ethPoints?: Array<[number, number]> | null
  decimalsKnown?: boolean
}) {
  const calls: Call[] = []
  const ethWindows: Array<[number, number]> = []
  const deps: V4HistoryDeps = {
    now: () => LATEST_TS * 1000,
    rpc: async (method, params) => {
      calls.push({ method, params })
      if (method === 'eth_getBlockByNumber') return { result: { number: hex(LATEST), timestamp: hex(LATEST_TS) }, error: false }
      if (method === 'eth_call') return { result: hex(18), error: false }
      const f = params[0] as { topics: string[]; fromBlock: string; toBlock: string }
      if (f.topics[0] === V4_INITIALIZE_TOPIC0) return { result: [initLog(POOL, opts.currency0 ?? NATIVE, opts.currency1 ?? TOKEN, opts.initBlock ?? LATEST - 46 * DAY_BLOCKS)], error: false }
      const from = Number(BigInt(f.fromBlock))
      const to = Number(BigInt(f.toBlock))
      if (opts.maxRangeBlocks != null && to - from + 1 > opts.maxRangeBlocks) return { result: null, error: true }
      return { result: (opts.swaps ?? (() => []))(from, to), error: false }
    },
    ethUsdRange: async (fromSec, toSec) => {
      ethWindows.push([fromSec, toSec])
      const pts: Array<[number, number]> = []
      for (let t = Math.floor(fromSec / 3600) * 3600; t <= toSec; t += 3600) pts.push([t * 1000, 3000])
      return { points: opts.ethPoints === undefined ? pts : opts.ethPoints, cacheHit: false }
    },
  }
  return { deps, calls, ethWindows }
}
const swapPages = (calls: Call[]) => calls.filter((c) => c.method === 'eth_getLogs' && (c.params[0] as { topics: string[] }).topics[0] === V4_SWAP_TOPIC0)
const range = (c: Call) => { const f = c.params[0] as { fromBlock: string; toBlock: string }; return [Number(BigInt(f.fromBlock)), Number(BigInt(f.toBlock))] }
// Token (currency1) at 0.001 ETH = $3 with ETH at $3000; one swap every 600 blocks (20 min).
const every = (step: number, poolId: Hex = POOL, pricePerEth = 1000) => (from: number, to: number) => {
  const out: RawEvmLog[] = []
  for (let b = Math.ceil(from / step) * step; b <= to; b += step) out.push(swapLog(poolId, b, sqrtX96(pricePerEth, 18, 18), BigInt(-1e16), BigInt(1e19)))
  return out
}
const H = (sec: number) => Math.floor(sec / 3600) * 3600
const scanCutoffSec = H(LATEST_TS - 24 * 3600) + 3600

// ── Server: bounded, exact-PoolId history windows ────────────────────────────────────────────────
test('history window: exact PoolManager + [Swap, PoolId] filter, strictly before the cursor, genuine hourly candles', async () => {
  resetV4SwapCandleCache()
  const h = fakeHistory({ swaps: (f, t) => [...every(600)(f, t), ...every(600, OTHER_POOL, 1)(f, t)] })
  const r = await loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: scanCutoffSec }, h.deps)
  assert.equal(r.ok, true, String(r.code))
  for (const p of swapPages(h.calls)) {
    const f = p.params[0] as { address: string; topics: string[] }
    assert.equal(f.address, POOL_MANAGER)
    assert.deepEqual(f.topics, [V4_SWAP_TOPIC0, POOL])
    assert.ok(range(p)[1] < tsBlock(scanCutoffSec), 'never reads at/after the cursor')
  }
  assert.equal(r.intervalSec, 3600)
  assert.ok(r.candles.length > 24)
  assert.ok(r.candles.every((k) => Math.abs(k.close - 3) < 1e-6), 'no cross-pool leakage (the other pool trades 1:1)')
  assert.ok(r.candles.every((k) => Date.parse(k.timestamp) / 1000 < scanCutoffSec && (Date.parse(k.timestamp) / 1000) % 3600 === 0))
  assert.equal(r.hasMore, true)
  assert.ok(r.nextBeforeSec! < scanCutoffSec && r.nextBeforeSec! % 3600 === 0)
  assert.equal(Date.parse(r.candles[0].timestamp) / 1000 >= r.nextBeforeSec!, true, 'the cursor is at/before the oldest returned hour')
})

test('history window is bounded: <= 3 pages, <= 8 calls, adaptive pages grow only while the pool is quiet', async () => {
  resetV4SwapCandleCache()
  const h = fakeHistory({ swaps: every(600) }) // 72 swaps/day: quiet
  const r = await loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: scanCutoffSec }, h.deps)
  const pages = swapPages(h.calls)
  assert.equal(pages.length, V4_HISTORY_MAX_PAGES)
  assert.deepEqual(pages.map((p) => range(p)[1] - range(p)[0] + 1), [V4_HISTORY_FIRST_PAGE_BLOCKS, 2 * V4_HISTORY_FIRST_PAGE_BLOCKS, 4 * V4_HISTORY_FIRST_PAGE_BLOCKS])
  for (let i = 1; i < pages.length; i++) assert.equal(range(pages[i])[1], range(pages[i - 1])[0] - 1, 'contiguous, no skipped blocks')
  assert.ok(r.callsUsed <= V4_HISTORY_MAX_CALLS)
  assert.equal(r.stopReason, 'page_cap')
  // header + Initialize + decimals + 3 pages + ETH window = 7 on a cold instance.
  assert.equal(r.callsUsed, 7)
  assert.equal(h.ethWindows.length, 1)
  assert.ok(h.ethWindows[0][1] - h.ethWindows[0][0] <= 8 * 86_400, 'one bounded ETH/USD window for the returned swaps only')
})

test('history: a page too wide for the node shrinks once to a smaller page — never a retry loop', async () => {
  resetV4SwapCandleCache()
  const h = fakeHistory({ swaps: every(600), maxRangeBlocks: 20_000 })
  const r = await loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: scanCutoffSec }, h.deps)
  const pages = swapPages(h.calls)
  assert.ok(pages.length <= V4_HISTORY_MAX_PAGES)
  assert.equal(range(pages[1])[1] - range(pages[1])[0] + 1, Math.max(V4_HISTORY_MIN_PAGE_BLOCKS, V4_HISTORY_FIRST_PAGE_BLOCKS / 4))
  assert.equal(r.ok, true)
  resetV4SwapCandleCache()
  const dead = fakeHistory({ swaps: every(600), maxRangeBlocks: 10 })
  const d = await loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: scanCutoffSec }, dead.deps)
  assert.equal(d.ok, false)
  assert.equal(d.code, 'v4_swap_logs_unavailable')
  assert.ok(swapPages(dead.calls).length <= V4_HISTORY_MAX_PAGES)
})

test('history: reaching the pool\'s creation block ends paging (hasMore=false); a cursor before creation costs no log page', async () => {
  resetV4SwapCandleCache()
  const initBlock = tsBlock(scanCutoffSec) - 30_000 // ~16.7h of older history
  const h = fakeHistory({ initBlock, swaps: every(600) })
  const r = await loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: scanCutoffSec }, h.deps)
  assert.equal(r.ok, true)
  assert.equal(r.hasMore, false)
  assert.equal(r.nextBeforeSec, null)
  assert.equal(swapPages(h.calls).length, 1)
  assert.equal(range(swapPages(h.calls)[0])[0], initBlock)
  resetV4SwapCandleCache()
  const pre = fakeHistory({ initBlock, swaps: every(600) })
  const p = await loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: blockTs(initBlock) - 7200 }, pre.deps)
  assert.deepEqual([p.ok, p.hasMore, swapPages(pre.calls).length], [true, false, 0])
})

test('history log cap: newest kept, the partial oldest hour dropped, cursor resumes exactly there (no gap, no double count)', async () => {
  resetV4SwapCandleCache()
  const h = fakeHistory({ swaps: every(5) }) // 8,640 swaps in the first 24h page
  const r = await loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: scanCutoffSec }, h.deps)
  assert.equal(r.ok, true)
  assert.equal(r.stopReason, 'log_cap')
  assert.equal(r.logsFound, V4_HISTORY_MAX_LOGS)
  const oldest = Date.parse(r.candles[0].timestamp) / 1000
  assert.equal(r.nextBeforeSec, oldest, 'next request starts at the first complete hour, re-reading the dropped partial hour')
  assert.equal(Date.parse(r.candles[r.candles.length - 1].timestamp) / 1000, scanCutoffSec - 3600, 'the newest hour before the cursor is present')
  for (let i = 1; i < r.candles.length; i++) assert.equal(Date.parse(r.candles[i].timestamp) - Date.parse(r.candles[i - 1].timestamp), 3_600_000)
})

test('history cache: the same window is served from cache with 0 calls; concurrent identical requests share one read', async () => {
  resetV4SwapCandleCache()
  const h = fakeHistory({ swaps: every(600) })
  const [a, b] = await Promise.all([
    loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: scanCutoffSec }, h.deps),
    loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: scanCutoffSec + 59 }, h.deps), // same hour cursor
  ])
  assert.deepEqual(a.candles, b.candles)
  const first = h.calls.length
  const again = await loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: scanCutoffSec }, h.deps)
  assert.equal(h.calls.length, first, 'no new RPC call')
  assert.deepEqual([again.callsUsed, again.cache.result], [0, true])
  // The next (older) window reuses header, Initialize and decimals: log pages + ETH window only.
  const before = h.calls.length
  await loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: a.nextBeforeSec! }, h.deps)
  assert.deepEqual([...new Set(h.calls.slice(before).map((c) => c.method))], ['eth_getLogs'])
})

test('history: decimals from the scan\'s own value when known (no eth_call); USDC pools need no quote call', async () => {
  resetV4SwapCandleCache()
  // The scan loader remembers the decimals it was given.
  const scanRpc: V4HistoryDeps['rpc'] = async (method, params) => {
    if (method === 'eth_getBlockByNumber') return { result: { number: hex(LATEST), timestamp: hex(LATEST_TS) }, error: false }
    const f = params[0] as { topics: string[]; fromBlock: string; toBlock: string }
    if (f.topics[0] === V4_INITIALIZE_TOPIC0) return { result: [initLog(POOL, TOKEN, USDC, LATEST - 46 * DAY_BLOCKS)], error: false }
    return { result: [], error: false }
  }
  await loadV4SwapCandles({ chain: 'base', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 0.5 }, { rpc: scanRpc, ethUsdSeries: async () => ({ points: null, cacheHit: true }), now: () => LATEST_TS * 1000 })
  const usdcSwaps = (from: number, to: number) => every(600)(from, to).map((l) => swapLog(POOL, Number(BigInt(l.blockNumber!)), sqrtX96(0.5, 18, 6), BigInt(1e18), BigInt(-5e5)))
  const h = fakeHistory({ currency0: TOKEN, currency1: USDC, swaps: usdcSwaps })
  const r = await loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: scanCutoffSec }, h.deps)
  assert.equal(r.ok, true, String(r.code))
  assert.equal(h.calls.filter((c) => c.method === 'eth_call').length, 0)
  assert.equal(h.ethWindows.length, 0)
  assert.equal(r.quote?.source, 'usd_stable')
  assert.ok(r.candles.every((k) => Math.abs(k.close - 0.5) < 1e-9))
})

test('history: unproven quote USD is an honest gap — never a current price backfilled over history', async () => {
  resetV4SwapCandleCache()
  const h = fakeHistory({ swaps: every(600), ethPoints: null })
  const r = await loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: scanCutoffSec }, h.deps)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'quote_usd_price_unproven')
  assert.equal(r.candles.length, 0)
  resetV4SwapCandleCache()
  const noQuoteLane = fakeHistory({ currency0: BNKR, currency1: TOKEN, swaps: every(600) })
  const q = await loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: scanCutoffSec }, noQuoteLane.deps)
  assert.deepEqual([q.ok, q.code], [false, 'quote_usd_price_unproven'])
  assert.equal(swapPages(noQuoteLane.calls).length, 0, 'fails before reading any log page')
})

test('history: invalid requests (40-hex pool, other chain, cursor too old / in the future) make zero calls', async () => {
  resetV4SwapCandleCache()
  for (const input of [
    { chain: 'base', poolId: '0x' + '7a'.repeat(20), token: TOKEN, beforeSec: scanCutoffSec },
    { chain: 'polygon', poolId: POOL, token: TOKEN, beforeSec: scanCutoffSec },
    { chain: 'base', poolId: POOL, token: TOKEN, beforeSec: LATEST_TS - V4_HISTORY_MAX_AGE_SEC - 7200 },
    { chain: 'base', poolId: POOL, token: TOKEN, beforeSec: LATEST_TS + 86_400 },
  ]) {
    const h = fakeHistory({ swaps: every(600) })
    const r = await loadV4SwapHistoryWindow(input, h.deps)
    assert.equal(r.ok, false, JSON.stringify(input))
    assert.equal(h.calls.length, 0)
  }
})

// ── Quote USD lanes for history windows ──────────────────────────────────────────────────────────
test('independent quote pool history: hourly candles ending at the window (before_timestamp), cached per window', async () => {
  resetQuoteUsdCache()
  const QPOOL = '0x' + 'ab'.repeat(20)
  const seen: Array<{ pool: string; req: unknown; before: number }> = []
  const discovery = { data: [{ id: `base_${QPOOL}`, attributes: { address: QPOOL, reserve_in_usd: '900000' }, relationships: { base_token: { data: { id: `base_${BNKR}` } }, quote_token: { data: { id: `base_${WETH}` } } } }], included: [{ id: `base_${BNKR}`, type: 'token', attributes: { symbol: 'BNKR', decimals: 18 } }] }
  const deps = {
    now: () => LATEST_TS * 1000,
    fetchTokenPools: async () => ({ json: discovery, httpStatus: 200 }),
    fetchPoolUsdOhlcvBefore: async (_c: string, pool: string, _s: 'base' | 'quote', req: { resolution: 'hour'; aggregate: 1; limit: number }, before: number) => {
      seen.push({ pool, req, before })
      const list = Array.from({ length: req.limit }, (_, i) => [before - (i + 1) * 3600, 0.0005, 0.0005, 0.0005, 0.0005, 10])
      return { json: { data: { attributes: { ohlcv_list: list } } }, httpStatus: 200 }
    },
  }
  const input = { chain: 'base', quoteToken: BNKR, scannedToken: TOKEN, excludePool: POOL, anchors: new Set([WETH, USDC]), fromSec: LATEST_TS - 5 * 86_400, toSec: LATEST_TS - 2 * 86_400, budget: 2, deadlineMs: LATEST_TS * 1000 + 9000 }
  const r = await resolveIndependentQuoteUsdWindow(input, deps)
  assert.equal(r.ok, true, String(r.detail))
  assert.equal(seen[0].pool, QPOOL)
  assert.deepEqual(seen[0].req, { resolution: 'hour', aggregate: 1, limit: (Math.ceil(input.toSec / 3600) - Math.floor(input.fromSec / 3600)) + 1 })
  assert.equal(seen[0].before, Math.ceil(input.toSec / 3600) * 3600)
  const again = await resolveIndependentQuoteUsdWindow(input, deps)
  assert.deepEqual([again.callsUsed, again.cache.discovery, again.cache.series, seen.length], [0, true, true, 1])
})

test('CoinGecko windowed reads: before_timestamp only when asked; ETH/USD range hour-aligned, key only in a header, cached', async () => {
  const base = coingeckoOnchainOhlcvPath('base', '0x' + 'ab'.repeat(20), { resolution: 'minute', aggregate: 5, limit: 290 }, 'base')
  assert.doesNotMatch(base, /before_timestamp/, 'scan reads unchanged')
  assert.match(coingeckoOnchainOhlcvPath('base', '0x' + 'ab'.repeat(20), { resolution: 'hour', aggregate: 1, limit: 73 }, 'base', 1_799_000_000), /&before_timestamp=1799000000$/)
  const KEY = 'CG-history-secret'
  const prev = process.env.COINGECKO_API_KEY
  process.env.COINGECKO_API_KEY = KEY
  resetEthUsdRangeCache()
  try {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const f = async (url: string, init: { headers: Record<string, string> }) => { seen.push({ url, headers: init.headers }); return { status: 200, ok: true, json: async () => ({ prices: [[2000, 3001], [1000, 3000]] }) } }
    const out = await fetchCoingeckoEthUsdRange(1_799_000_100, 1_799_100_100, 3000, f, () => 1_800_000_000_000)
    assert.deepEqual(out.points, [[1000, 3000], [2000, 3001]])
    assert.match(seen[0].url, /\/coins\/ethereum\/market_chart\/range\?vs_currency=usd&from=1798999200&to=1799103600$/)
    assert.equal(seen[0].headers['x-cg-demo-api-key'], KEY)
    assert.doesNotMatch(JSON.stringify(out) + seen[0].url, new RegExp(KEY))
    const hit = await fetchCoingeckoEthUsdRange(1_799_000_200, 1_799_100_050, 3000, f, () => 1_800_000_000_000)
    assert.deepEqual([hit.cacheHit, seen.length], [true, 1])
  } finally {
    if (prev === undefined) delete process.env.COINGECKO_API_KEY
    else process.env.COINGECKO_API_KEY = prev
  }
})

// ── Client merge ─────────────────────────────────────────────────────────────────────────────────
const c = (tMs: number, close: number, volume: number | null = 1): ChartCandle => ({ t: tMs, open: close, high: close * 1.01, low: close * 0.99, close, volume })

test('merge: only whole hours before the cutoff; existing hours never overwritten; ascending; de-duplicated', () => {
  const cutoff = 100 * 3_600_000
  const a = mergeHistoryCandles([], [c(98 * 3_600_000, 2), c(99 * 3_600_000, 3), c(100 * 3_600_000, 999), c(99.5 * 3_600_000, 999)], cutoff)
  assert.deepEqual(a.map((x) => [x.t / 3_600_000, x.close]), [[98, 2], [99, 3]], 'the cutoff hour and a non-hour stamp are rejected')
  const b = mergeHistoryCandles(a, [c(97 * 3_600_000, 1), c(99 * 3_600_000, 777)], cutoff)
  assert.deepEqual(b.map((x) => [x.t / 3_600_000, x.close]), [[97, 1], [98, 2], [99, 3]], 'an older response never replaces newer evidence')
})

test('withHistory: 1H/4H/1D rebuilt over history + scan candles; 5M/15M untouched; the scan\'s partial first hour replaced; no gap filled', () => {
  const t0 = 1_000 * 3_600_000
  // Scan: 15m candles from t0 + 30m for 24h (first hour partial).
  const scan = Array.from({ length: 94 }, (_, i) => c(t0 + 30 * 60_000 + i * 900_000, 3 + i * 0.001))
  const set = buildChartTimeframes(scan, 900)
  const cutoff = historyCutoffMs(scan)!
  assert.equal(cutoff, t0 + 3_600_000)
  // History: hourly, with a 3h quiet gap (no trades) — stays absent.
  const hist = mergeHistoryCandles([], [...Array.from({ length: 30 }, (_, i) => c(t0 - (i + 5) * 3_600_000, 2)), c(t0, 2.5), c(t0 - 3_600_000, 2.4)], cutoff)
  const merged = withHistory(set, hist, cutoff)
  const tf = (k: string) => merged.timeframes.find((x) => x.key === k)!
  assert.deepEqual(tf('15M').candles, set.timeframes.find((x) => x.key === '15M')!.candles)
  const h1 = tf('1H').candles
  assert.equal(h1.find((x) => x.t === t0)!.close, 2.5, 'the complete history hour replaces the scan\'s partial first hour')
  assert.ok(h1.filter((x) => x.t === t0).length === 1)
  assert.ok(!h1.some((x) => x.t === t0 - 2 * 3_600_000 || x.t === t0 - 3 * 3_600_000 || x.t === t0 - 4 * 3_600_000), 'quiet hours are never fabricated')
  assert.equal(h1[h1.length - 1].close, scan[scan.length - 1].close, 'newest hour is the scan\'s own evidence')
  assert.ok(tf('1D').available && tf('4H').candles.length > set.timeframes.find((x) => x.key === '4H')!.candles.length)
  assert.equal(withHistory(set, [], cutoff), set, 'no history => identical set')
})

test('targets + labels: 1H 3d, 4H ~3 weeks, 1D 60d; loaded span label', () => {
  assert.deepEqual(HISTORY_TARGET_SPAN_SEC, { '1H': 3 * 86_400, '4H': 21 * 86_400, '1D': 60 * 86_400 })
  assert.equal(loadedSpanLabel(0, 23 * 3_600_000, 3600), '24h loaded')
  assert.equal(loadedSpanLabel(0, 10 * 86_400_000, 86_400), '11d loaded')
})

// ── Scan cost unchanged in kind: no history call during a scan; whole path <= 10 ─────────────────
test('normal scan never requests history; the whole candle path with the 24h V4 read stays <= 10 calls', async () => {
  const route = read('app/api/token/route.ts')
  assert.doesNotMatch(route, /loadV4SwapHistoryWindow|timeframe=history|makeV4HistoryDeps/, 'the scan route never touches the history path')
  const rel = { base_token: { data: { id: `base_${TOKEN}` } }, quote_token: { data: { id: `base_${WETH}` } } }
  const lpool = (id: string): LadderPool => ({ poolId: `base_${id}`, address: id, name: 'TKN / WETH', liquidityUsd: 1e5, pool: { id: `base_${id}`, relationships: rel } })
  const v4: LadderV4SwapResult = { ok: true, code: null, poolManager: POOL_MANAGER, logsFound: 720, intervalSec: 300, timeResolution: 'exact_log_timestamps', callsUsed: 7, pagesFetched: 3, budgetStopReason: 'target_window', candles: Array.from({ length: 288 }, (_, i) => ({ timestamp: new Date((LATEST_TS - (288 - i) * 300) * 1000).toISOString(), open: 3, high: 3, low: 3, close: 3, volume: 1, priceUsd: 3 })) }
  const budgets: number[] = []
  const r = await runEvmCandleLadder(
    { pools: [lpool(POOL), lpool('0x' + '7a'.repeat(20)), lpool('0x' + '7b'.repeat(20))], contract: TOKEN, networkId: 'base', coingeckoNetworkId: 'base', currentPriceUsd: 3 },
    { fetchCoingeckoPoolOhlcv: async () => ({ httpStatus: 404, json: null }), fetchPoolOhlcv: async () => ({ httpStatus: 404, json: null }), fetchTrades: async () => ({ httpStatus: 200, json: { data: [] } }), fetchV4SwapCandles: async (_p, b) => { budgets.push(b); return v4 } },
  )
  assert.ok(r.totalHttpCalls <= 10, String(r.totalHttpCalls))
  assert.equal(r.callBudget.stopReason, null, 'reaching the 24h target is not a budget stop')
  assert.equal(r.chartCandles?.points.length, 288, 'all 24h of candles reach the chart')
})

test('client: history loads only from explicit actions; loader only for exact V4 PoolId sources; endpoint auth + validation', () => {
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.doesNotMatch(panel, /\bfetch\(/)
  assert.equal((panel.match(/void requestHistory\(/g) ?? []).length, 2, 'two triggers: timeframe pick and left edge')
  assert.match(panel, /if \(historyEnabled && isHistoryTimeframe\(chip\.key\)/)
  assert.match(panel, /if \(next\.start === 0\) loadOlderAtLeftEdge\(\)/)
  assert.doesNotMatch(panel, /useEffect\([^)]*requestHistory/, 'never fetched from an effect on mount')
  assert.match(panel, /'Loading older candles…'/)
  assert.match(panel, /'Scroll\/zoom left for older history'/)
  assert.match(read('lib/chartHistory.ts'), /if \(res\.hasMore && !\(next != null && next < before\)\) \{/, 'a cursor that does not move ends paging')
  assert.match(panel, /await loadHistoryBatch\(/, 'the panel pages through the shared batch loader')
  const page = read('app/terminal/token-scanner/page.tsx')
  assert.match(page, /const v4 = source === 'v4_swap_events' && \/\^0x\[a-fA-F0-9\]\{64\}\$\/\.test\(pool\)/, 'V4 history only for an exact bytes32 PoolId')
  assert.match(page, /if \(!v4 && !normalPool\) return undefined/)
  assert.match(page, /historySourceLabel=\{result\.chartSource === 'v4_swap_events' \? 'real V4 swaps' :/)
  const ep = read('app/api/token/chart-candles/route.ts')
  assert.ok(ep.indexOf('requireAuthenticatedUser(req)') < ep.indexOf("timeframe') === 'history'"), 'auth + rate limit before any history work')
  assert.match(ep, /!\/\^0x\[a-fA-F0-9\]\{64\}\$\/\.test\(pool\)/, 'history accepts only an exact bytes32 PoolId')
  assert.doesNotMatch(read('lib/server/v4SwapHistoryDeps.ts'), /COINGECKO_API_KEY/)
})
