// Token Scanner price chart reliability: 15-minute V4 swap history (so a quiet V4 pool's 15M is no longer
// limited to the scan's 24h read), operator-recorded provider PoolId support with on-chain fallback, and
// the client merge at either history interval. Logs are ABI-encoded with viem exactly as PoolManager emits them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem'
import { V4_INITIALIZE_TOPIC0, V4_POOL_MANAGER_ABI, type RawEvmLog } from '../lib/v4SwapCandles.ts'
import { V4_SWAP_CHAIN_CONFIG, loadV4SwapHistoryWindow, resetV4SwapCandleCache, type V4HistoryDeps } from '../lib/server/v4SwapCandlesRpc.ts'
import {
  HISTORY_TARGET_SPAN_15M_SEC,
  historyCutoffMs,
  historyTargetSpanSec,
  isHistoryTimeframe,
  loadHistoryBatch,
  mergeHistoryCandles,
  normalizeHistoryIntervalSec,
  withHistory,
  type HistoryWindowResult,
} from '../lib/chartHistory.ts'
import { aggregateCandles, buildChartTimeframes, normalizeChartCandles, type ChartCandle } from '../lib/priceChartCandles.ts'
import { assessTimeframeQuality, isPresentationUsable } from '../lib/chartQuality.ts'
import { provenV4PoolIdPairsFromEnv, runEvmCandleLadder, v4PoolIdOhlcvSupported, type LadderDeps, type LadderFetchResult, type LadderPool, type LadderV4SwapResult } from '../lib/evmChartCandles.ts'
import { loadPoolOhlcvHistory, resetOnDemandCandleState } from '../lib/server/chartCandlesOnDemand.ts'

const NATIVE = '0x0000000000000000000000000000000000000000'
const TOKEN = '0x1bc0c42215582d5a085795f4badbac3ff36d1bcb'
const WETH = '0x4200000000000000000000000000000000000006'
const SENDER = '0x000000000000000000000000000000000000beef'
const POOL = ('0x' + '9f3c'.repeat(16)) as Hex
const Q96 = BigInt(2) ** BigInt(96)
const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`
const LATEST = 30_000_000
const LATEST_TS = 1_800_000_000 - (1_800_000_000 % 3600) + 1800
const sqrtX96 = (p: number) => BigInt(Math.round(Math.sqrt(p) * 2 ** 96))

function initLog(manager: string, block: number): RawEvmLog {
  const topics = encodeEventTopics({ abi: V4_POOL_MANAGER_ABI, eventName: 'Initialize', args: { id: POOL, currency0: NATIVE as Hex, currency1: TOKEN as Hex } })
  const data = encodeAbiParameters([{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }], [10000, 200, NATIVE, Q96, 0])
  return { address: manager, topics: topics as string[], data, blockNumber: hex(block), logIndex: '0x0' }
}
function swapLog(manager: string, block: number, tokenPerEth: number, logIndex = 0): RawEvmLog {
  const topics = encodeEventTopics({ abi: V4_POOL_MANAGER_ABI, eventName: 'Swap', args: { id: POOL, sender: SENDER } })
  const data = encodeAbiParameters([{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }], [BigInt(-1e16), BigInt(1e19), sqrtX96(tokenPerEth), BigInt(1e18), 0, 10000])
  return { address: manager, topics: topics as string[], data, blockNumber: hex(block), logIndex: hex(logIndex) }
}

/** A V4 history RPC fake for one chain: real block -> time mapping, swaps every `step` blocks with a varying price. */
function fakeChain(chain: 'base' | 'eth', step: number) {
  const cfg = V4_SWAP_CHAIN_CONFIG[chain]
  const manager = cfg.managers[0].address.toLowerCase()
  const sec = chain === 'base' ? 2 : 12
  const deps: V4HistoryDeps = {
    now: () => LATEST_TS * 1000,
    rpc: async (method, params) => {
      if (method === 'eth_getBlockByNumber') {
        const b = params[0] === 'latest' ? LATEST : Number(BigInt(params[0] as string))
        return { result: { number: hex(b), timestamp: hex(LATEST_TS - (LATEST - b) * sec) }, error: false }
      }
      if (method === 'eth_call') return { result: hex(18), error: false }
      const f = params[0] as { topics: string[]; fromBlock: string; toBlock: string }
      if (f.topics[0] === V4_INITIALIZE_TOPIC0) return { result: [initLog(manager, LATEST - 2_000_000)], error: false }
      const from = Number(BigInt(f.fromBlock))
      const to = Number(BigInt(f.toBlock))
      const out: RawEvmLog[] = []
      // Price varies per swap so every bucket has a genuine open / high / low / close shape.
      for (let b = Math.ceil(from / step) * step; b <= to; b += step) out.push(swapLog(manager, b, 1000 + ((b / step) % 7) * 25))
      return { result: out, error: false }
    },
    ethUsdRange: async (fromSec, toSec) => {
      const pts: Array<[number, number]> = []
      for (let t = Math.floor(fromSec / 3600) * 3600; t <= toSec; t += 3600) pts.push([t * 1000, 3000])
      return { points: pts, cacheHit: false }
    },
  }
  return deps
}
const toCandles = (pts: ReadonlyArray<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number | null }>) => normalizeChartCandles(pts)
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
const cursor = Math.floor((LATEST_TS - 24 * 3600) / 3600) * 3600 + 3600

// ── Server: 15-minute V4 swap history ────────────────────────────────────────────────────────────
test('V4 history: interval=900 buckets the SAME swaps at 15 minutes; rolling them up equals the hourly result exactly', async () => {
  resetV4SwapCandleCache()
  const hourly = await loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: cursor }, fakeChain('base', 200))
  resetV4SwapCandleCache()
  const fine = await loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: cursor, intervalSec: 900 }, fakeChain('base', 200))
  assert.equal(hourly.ok, true, String(hourly.code))
  assert.equal(fine.ok, true, String(fine.code))
  assert.equal(hourly.intervalSec, 3600)
  assert.equal(fine.intervalSec, 900, 'Base fixed-block times allow 15-minute buckets')
  assert.equal(fine.timeResolution, 'inferred_block_time')
  assert.ok(fine.candles.length > hourly.candles.length * 3, `${fine.candles.length} 15M vs ${hourly.candles.length} 1H`)
  assert.ok(fine.candles.every((k) => (Date.parse(k.timestamp) / 1000) % 900 === 0 && Date.parse(k.timestamp) / 1000 < cursor))
  // Same window and cursor: only the bucket width differs.
  assert.equal(fine.nextBeforeSec, hourly.nextBeforeSec)
  assert.equal(fine.hasMore, hourly.hasMore)
  const rolled = aggregateCandles(toCandles(fine.candles), 3600)
  const h = toCandles(hourly.candles)
  assert.equal(rolled.length, h.length)
  rolled.forEach((r, i) => {
    assert.equal(r.t, h[i].t)
    for (const k of ['open', 'high', 'low', 'close'] as const) assert.ok(close(r[k], h[i][k]), `${k} @${i}: ${r[k]} vs ${h[i][k]}`)
    assert.ok(close(r.volume ?? 0, h[i].volume ?? 0), `volume @${i}`)
  })
})

test('V4 history: interpolated times (ETH) stay hourly even when 15 minutes is requested — never a guessed 15M bucket', async () => {
  resetV4SwapCandleCache()
  const r = await loadV4SwapHistoryWindow({ chain: 'eth', poolId: POOL, token: TOKEN, beforeSec: cursor, intervalSec: 900 }, fakeChain('eth', 40))
  assert.equal(r.ok, true, String(r.code))
  assert.equal(r.timeResolution, 'block_timestamp_lookup')
  assert.equal(r.intervalSec, 3600)
  assert.ok(r.candles.length > 0 && r.candles.every((k) => (Date.parse(k.timestamp) / 1000) % 3600 === 0))
})

test('V4 history: 15-minute and hourly results are cached separately per cursor (never served for each other)', async () => {
  resetV4SwapCandleCache()
  const deps = fakeChain('base', 200)
  const a = await loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: cursor, intervalSec: 900 }, deps)
  const b = await loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: cursor }, deps)
  const c = await loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: cursor, intervalSec: 900 }, deps)
  assert.equal(a.intervalSec, 900)
  assert.equal(b.intervalSec, 3600)
  assert.equal(b.cache.result, false, 'the hourly read is not answered from the 15-minute entry')
  assert.equal(c.cache.result, true)
  assert.equal(c.intervalSec, 900)
  // Any other requested width is hourly (only 900 is a recognised option).
  resetV4SwapCandleCache()
  const d = await loadV4SwapHistoryWindow({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: cursor, intervalSec: 60 }, deps)
  assert.equal(d.intervalSec, 3600)
})

// ── Client: merge at the history interval ────────────────────────────────────────────────────────
const M15 = 900_000
const H1 = 3_600_000
const NOW = 1_800_000_000_000 - (1_800_000_000_000 % H1)
const k = (t: number, c: number, volume: number | null = 10): ChartCandle => ({ t, open: c, high: c * 1.02, low: c * 0.98, close: c, volume })

test('reproduction: 12 genuine 5M candles in 24h -> 4 sparse 15M candles; 2 days of 15M history makes 15M a real chart', () => {
  // The production case: a quiet V4 pool, exact log times (5M native), 12 trades clustered in 4 quarter-hours.
  const quarters = [NOW - 20 * H1, NOW - 14 * H1, NOW - 6 * H1, NOW - H1]
  const scan = normalizeChartCandles(quarters.flatMap((q, i) => [0, 1, 2].map((j) => ({ timestamp: new Date(q + j * 300_000).toISOString(), open: 1 + i, high: 1.1 + i, low: 0.9 + i, close: 1 + i, volume: 5 }))))
  assert.equal(scan.length, 12)
  const set = buildChartTimeframes(scan, 300)
  const before = set.timeframes.find((t) => t.key === '15M')!
  assert.equal(before.candles.length, 4, 'before: exactly the 4-candle 15M view')
  const beforeQ = assessTimeframeQuality(before.candles, 900, { timeframe: '15M', referenceMs: NOW, coverage: { startMs: NOW - 24 * H1, endMs: NOW }, poolCreatedMs: null })
  assert.equal(isPresentationUsable(beforeQ.quality), false)

  // Older genuine 15-minute history (every other quarter-hour traded for the previous 2 days).
  const cutoff = historyCutoffMs(scan, 900)!
  const hist = mergeHistoryCandles([], Array.from({ length: 96 }, (_, i) => k(cutoff - (i * 2 + 1) * M15, 1 + (i % 5) * 0.01)), cutoff, 900)
  const after = withHistory(set, hist, cutoff, 900)
  const fifteen = after.timeframes.find((t) => t.key === '15M')!
  assert.equal(fifteen.candles.length, 100, 'after: 96 history + the 4 scan quarter-hours')
  assert.ok(fifteen.candles.every((c, i, a) => i === 0 || a[i - 1].t < c.t), 'ascending, no duplicates')
  // Empty quarter-hours stay absent — nothing is filled.
  assert.ok(fifteen.candles.every((c) => c.t % M15 === 0))
  const afterQ = assessTimeframeQuality(fifteen.candles, 900, { timeframe: '15M', referenceMs: NOW, coverage: { startMs: fifteen.candles[0].t, endMs: NOW }, poolCreatedMs: null })
  assert.ok(afterQ.candleCount > beforeQ.candleCount * 20)
  // 1H / 4H / 1D are exact roll-ups of the same merged 15-minute series; 5M stays the scan's own.
  const merged15 = [...hist, ...aggregateCandles(scan.filter((c) => c.t >= cutoff), 900)]
  assert.deepEqual(after.timeframes.find((t) => t.key === '1H')!.candles, aggregateCandles(merged15, 3600))
  assert.deepEqual(after.timeframes.find((t) => t.key === '5M')!.candles, set.timeframes.find((t) => t.key === '5M')!.candles)
})

test('history helpers default to hourly exactly as before; 15M is a history timeframe only with 15-minute history', () => {
  assert.equal(isHistoryTimeframe('15M'), false)
  assert.equal(isHistoryTimeframe('15M', 900), true)
  assert.equal(isHistoryTimeframe('1D', 900), true)
  assert.equal(isHistoryTimeframe('5M', 900), false)
  assert.equal(normalizeHistoryIntervalSec(900), 900)
  assert.equal(normalizeHistoryIntervalSec(undefined), 3600)
  assert.equal(normalizeHistoryIntervalSec(300), 3600)
  assert.equal(historyTargetSpanSec('15M'), HISTORY_TARGET_SPAN_15M_SEC)
  assert.equal(historyTargetSpanSec('1H'), 3 * 86_400)
  assert.equal(historyTargetSpanSec('5M'), null)
  const scan = [k(NOW - 2 * H1 + 5 * 60_000, 1), k(NOW - H1, 1)]
  assert.equal(historyCutoffMs(scan), NOW - H1)
  assert.equal(historyCutoffMs(scan, 900), NOW - 2 * H1 + M15)
  // A 15-minute candle is not an hourly bucket: the hourly merge ignores it.
  assert.deepEqual(mergeHistoryCandles([], [k(NOW - 3 * H1 + M15, 2)], NOW), [])
  assert.equal(mergeHistoryCandles([], [k(NOW - 3 * H1 + M15, 2)], NOW, 900).length, 1)
})

test('pagination across 3 requests at 15 minutes: out-of-order and duplicate rows merge once, ascending; existing buckets win', async () => {
  const scan = [k(NOW - 4 * H1, 1), k(NOW - H1, 1)]
  const cutoff = historyCutoffMs(scan, 900)!
  const iso = (t: number, c: number) => ({ timestamp: new Date(t).toISOString(), open: c, high: c, low: c, close: c, volume: 1 })
  const pages: Record<number, HistoryWindowResult> = {
    [cutoff / 1000]: { ok: true, intervalSec: 900, hasMore: true, nextBeforeSec: cutoff / 1000 - 8 * 900, points: [iso(cutoff - M15, 5), iso(cutoff - 3 * M15, 3), iso(cutoff - 2 * M15, 4), iso(cutoff - 3 * M15, 3)] },
    [cutoff / 1000 - 8 * 900]: { ok: true, intervalSec: 900, hasMore: true, nextBeforeSec: cutoff / 1000 - 16 * 900, points: [iso(cutoff - 9 * M15, 2), iso(cutoff - 10 * M15, 1)] },
    [cutoff / 1000 - 16 * 900]: { ok: true, intervalSec: 900, hasMore: false, nextBeforeSec: null, endReason: 'reached_pool_creation', points: [iso(cutoff - 17 * M15, 0.5)] },
  }
  const requested: number[] = []
  const out = await loadHistoryBatch({ start: { candles: [], nextBeforeSec: null, hasMore: true }, cutoffMs: cutoff, newestMs: scan[1].t, maxRequests: 3, targetSpanSec: null, intervalSec: 900, load: async (b) => { requested.push(b); return pages[b] } })
  assert.deepEqual(requested, [cutoff / 1000, cutoff / 1000 - 8 * 900, cutoff / 1000 - 16 * 900])
  assert.deepEqual(out.candles.map((c) => (cutoff - c.t) / M15), [17, 10, 9, 3, 2, 1])
  assert.equal(out.hasMore, false)
  assert.equal(out.endReason, 'reached_pool_creation')
})

test('a history response at a different interval is never merged (no mixed 15M / 1H series); an empty one is fine', async () => {
  const scan = [k(NOW - 4 * H1, 1), k(NOW - H1, 1)]
  const cutoff = historyCutoffMs(scan, 900)!
  const empty = await loadHistoryBatch({ start: { candles: [], nextBeforeSec: null, hasMore: true }, cutoffMs: cutoff, newestMs: scan[1].t, maxRequests: 1, targetSpanSec: null, intervalSec: 900, load: async () => ({ ok: true, intervalSec: 3600, hasMore: true, nextBeforeSec: cutoff / 1000 - 3600, points: [] }) })
  assert.equal(empty.failedMessage, null)
  const mixed = await loadHistoryBatch({ start: { candles: [], nextBeforeSec: null, hasMore: true }, cutoffMs: cutoff, newestMs: scan[1].t, maxRequests: 3, targetSpanSec: null, intervalSec: 900, load: async () => ({ ok: true, intervalSec: 3600, hasMore: true, nextBeforeSec: cutoff / 1000 - 7200, points: [{ timestamp: new Date(NOW - 6 * H1).toISOString(), open: 1, high: 1, low: 1, close: 1, volume: 1 }] }) })
  assert.deepEqual(mixed.candles, [])
  assert.equal(mixed.endReason, 'history_interval_mismatch')
  assert.equal(mixed.requests, 1)
  assert.ok(mixed.failedMessage)
})

test('zero-volume and missing timestamps: rows without a valid time are dropped, zero-volume buckets are kept as real candles', () => {
  const rows = normalizeChartCandles([
    { timestamp: 'not-a-date', open: 1, high: 1, low: 1, close: 1, volume: 1 },
    { timestamp: new Date(NOW - H1).toISOString(), open: 1, high: 1.2, low: 0.9, close: 1.1, volume: 0 },
    { timestamp: new Date(NOW - 2 * H1).toISOString(), open: 1, high: 1.2, low: 0.9, close: 1.1, volume: null },
  ])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.volume), [null, 0])
})

// ── Provider PoolId support: operator-recorded live evidence, never assumed ──────────────────────
test('provider PoolId allowlist: parsed strictly; unset changes nothing', () => {
  assert.deepEqual([...provenV4PoolIdPairsFromEnv(' geckoterminal:base , coingecko:ETH,foo:base,geckoterminal:,geckoterminal:ba se ')].sort(), ['coingecko:eth', 'geckoterminal:base'])
  assert.equal(provenV4PoolIdPairsFromEnv(undefined).size, 0)
  const prev = process.env.CHART_V4_POOL_ID_OHLCV_PROVEN
  try {
    delete process.env.CHART_V4_POOL_ID_OHLCV_PROVEN
    assert.equal(v4PoolIdOhlcvSupported('geckoterminal', 'base'), false)
    process.env.CHART_V4_POOL_ID_OHLCV_PROVEN = 'geckoterminal:base'
    assert.equal(v4PoolIdOhlcvSupported('geckoterminal', 'base'), true)
    assert.equal(v4PoolIdOhlcvSupported('coingecko', 'base'), false, 'per provider')
    assert.equal(v4PoolIdOhlcvSupported('geckoterminal', 'eth'), false, 'per network')
  } finally {
    if (prev === undefined) delete process.env.CHART_V4_POOL_ID_OHLCV_PROVEN
    else process.env.CHART_V4_POOL_ID_OHLCV_PROVEN = prev
  }
})

const END = Math.floor(Date.UTC(2026, 8, 26, 12) / 1000)
const gtRows = Array.from({ length: 672 }, (_, i) => [END - i * 900, 1, 1.1, 0.9, 1.05, 10])
const v4LadderPool: LadderPool = { poolId: `base_${POOL}`, address: POOL, name: 'TKN / WETH', liquidityUsd: 250_000, pool: { id: `base_${POOL}`, type: 'pool', attributes: { address: POOL, name: 'TKN / WETH' }, relationships: { base_token: { data: { id: `base_${TOKEN}` } }, quote_token: { data: { id: `base_${WETH}` } }, dex: { data: { id: 'uniswap-v4-base' } } } } }
const v4Ok: LadderV4SwapResult = { ok: true, code: null, poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b', logsFound: 12, candles: Array.from({ length: 12 }, (_, i) => ({ timestamp: new Date((END - (12 - i) * 300) * 1000).toISOString(), open: 1, high: 1.1, low: 0.9, close: 1.05, volume: 1, priceUsd: 1.05 })), intervalSec: 300, timeResolution: 'exact_log_timestamps', callsUsed: 7, pagesFetched: 3, budgetStopReason: 'target_window', chain: 'base' }
function ladderDeps(gt: (addr: string) => LadderFetchResult, calls: string[], v4Budgets: number[]): LadderDeps {
  return {
    fetchCoingeckoPoolOhlcv: async (a) => { calls.push(`CG ${a}`); return { httpStatus: 404, json: null } },
    fetchPoolOhlcv: async (a, rung) => { calls.push(`GT ${rung.key} ${a}`); return gt(a) },
    fetchTrades: async (a) => { calls.push(`trades ${a}`); return { httpStatus: 404, json: null } },
    fetchV4SwapCandles: async (_p, budget) => { v4Budgets.push(budget); calls.push('V4 swaps'); return v4Ok },
  }
}

test('proven provider (allowlisted): a V4 market pool is charted from its own 7-day 15M provider OHLCV, full 64-hex id, one call', async () => {
  const calls: string[] = []
  const budgets: number[] = []
  const r = await runEvmCandleLadder({ pools: [v4LadderPool], contract: TOKEN, networkId: 'base', coingeckoNetworkId: null, currentPriceUsd: 1.05, poolIdSupport: { geckoterminal: true } }, ladderDeps(() => ({ httpStatus: 200, json: { data: { attributes: { ohlcv_list: gtRows } } } }), calls, budgets))
  assert.deepEqual(calls, [`GT 24h ${POOL}`])
  assert.equal(r.candleProvider, 'geckoterminal')
  assert.equal(r.chartCandles?.points.length, 672)
  assert.equal(r.chartCandles?.poolAddress, POOL)
  assert.equal(r.chartCandles?.tokenSide, 'base')
})

test('primary provider fails (404) -> verified on-chain swap fallback, which keeps >= 7 calls of budget (only the 15m rung was tried)', async () => {
  const calls: string[] = []
  const budgets: number[] = []
  const r = await runEvmCandleLadder({ pools: [v4LadderPool], contract: TOKEN, networkId: 'base', coingeckoNetworkId: 'base', currentPriceUsd: 1.05, poolIdSupport: { geckoterminal: true, coingecko: true } }, ladderDeps(() => ({ httpStatus: 404, json: null }), calls, budgets))
  assert.deepEqual(calls, [`CG ${POOL}`, `GT 24h ${POOL}`, 'V4 swaps'])
  assert.equal(r.candleProvider, 'v4_swap_events')
  assert.ok(budgets[0] >= 7, `V4 fallback budget ${budgets[0]}`)
})

test('provider answers for the wrong price (live-price sanity) -> never charted; the on-chain swaps are used instead', async () => {
  const calls: string[] = []
  const wrong = gtRows.map((row) => [row[0], 50, 55, 45, 52, 10])
  const r = await runEvmCandleLadder({ pools: [v4LadderPool], contract: TOKEN, networkId: 'base', coingeckoNetworkId: null, currentPriceUsd: 1.05, poolIdSupport: { geckoterminal: true } }, ladderDeps(() => ({ httpStatus: 200, json: { data: { attributes: { ohlcv_list: wrong } } } }), calls, []))
  assert.equal(r.candleProvider, 'v4_swap_events')
  assert.ok(r.attempts.some((a) => a.code === 'price_sanity_mismatch'))
})

test('pool OHLCV history: a PoolId with no proven provider costs zero calls; an allowlisted one asks only that provider with the full id', async () => {
  resetOnDemandCandleState()
  const urls: string[] = []
  const fetchJson = async (url: string) => {
    urls.push(url)
    if (url.endsWith(`/pools/${POOL}`)) return { httpStatus: 200, json: { data: v4LadderPool.pool } }
    return { httpStatus: 200, json: { data: { attributes: { ohlcv_list: gtRows.slice(0, 50).map((r) => [r[0] - 7 * 86_400, ...r.slice(1)]) } } } }
  }
  const before = END - 7 * 86_400 + 3600
  const prev = process.env.CHART_V4_POOL_ID_OHLCV_PROVEN
  try {
    delete process.env.CHART_V4_POOL_ID_OHLCV_PROVEN
    const none = await loadPoolOhlcvHistory({ chain: 'base', token: TOKEN, pool: POOL, side: 'base', before }, fetchJson, { now: () => END * 1000, fetchCoingecko: async () => { urls.push('CG'); return { httpStatus: 200, json: null } } })
    assert.equal(none.result.ok, false)
    assert.equal(none.result.ok === false && none.result.code, 'provider_unsupported_pool_id')
    assert.equal(none.providerCalls, 0)
    assert.equal(urls.length, 0)
    process.env.CHART_V4_POOL_ID_OHLCV_PROVEN = 'geckoterminal:base'
    const gt = await loadPoolOhlcvHistory({ chain: 'base', token: TOKEN, pool: POOL, side: 'base', before }, fetchJson, { now: () => END * 1000, fetchCoingecko: async () => { urls.push('CG'); return { httpStatus: 200, json: null } } })
    assert.equal(gt.result.ok, true)
    assert.ok(!urls.includes('CG'), 'CoinGecko is not proven for PoolIds here, so it is not asked')
    assert.ok(urls.every((u) => u.includes(`/pools/${POOL}`)), 'the full 64-hex id, never truncated')
  } finally {
    if (prev === undefined) delete process.env.CHART_V4_POOL_ID_OHLCV_PROVEN
    else process.env.CHART_V4_POOL_ID_OHLCV_PROVEN = prev
  }
})
