// Token Scanner DEX-chart parity — busy Robinhood Uniswap V4 pool (ROBINPEPE-style). Root cause proven:
// the scan's exact-PoolId swap read keeps at most V4_SWAP_MAX_LOGS (6,000) NEWEST swaps; at ~1,500
// swaps/h on 0.25s blocks that is ~4h (17 x 15M). The window evidence is now exposed, coverage is
// truthful (never a claimed 24h), history pages are sized to the pool's real swap density so a busy pool
// reaches a full 1H chart after load, an exact-timestamp 1M lane exists on demand, and the latest close
// is audited against the scanner's live price. Never fabricated: genuine swaps only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem'
import { V4_INITIALIZE_TOPIC0, V4_POOL_MANAGER_ABI, V4_SWAP_TOPIC0, type RawEvmLog } from '../lib/v4SwapCandles.ts'
import {
  HISTORY_DENSITY_CLASSES, V4_HISTORY_MAX_LOGS, V4_HISTORY_TARGET_PAGE_LOGS, historyDensityClass, V4_SWAP_CHAIN_CONFIG, V4_SWAP_MAX_LOGS, V4_SWAP_TARGET_WINDOW_SEC,
  loadV4SwapCandles, loadV4SwapHistoryWindow, loadV4SwapIntradayWindow, resetV4SwapCandleCache,
  type V4HistoryDeps, type V4SwapDeps,
} from '../lib/server/v4SwapCandlesRpc.ts'
import { runEvmCandleLadder, type LadderDeps, type LadderPool, type LadderV4SwapResult } from '../lib/evmChartCandles.ts'
import { auditLatestClose, LATEST_CLOSE_DRIFT_NOTICE } from '../lib/chartMarketCap.ts'
import { loadHistoryBatch, mergeHistoryCandles } from '../lib/chartHistory.ts'
import { chartDataIdentity, normalizeChartCandles, resolveChartViewport, type ChartCandle } from '../lib/priceChartCandles.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const MGR = V4_SWAP_CHAIN_CONFIG.robinhood.poolManager
const POOL = ('0x' + '7e1d'.repeat(16)) as Hex
const NATIVE = '0x0000000000000000000000000000000000000000'
const TOKEN = '0x2bc0c42215582d5a085795f4badbac3ff36d1bcb'
const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`
const LATEST = 50_000_000
const LATEST_TS = 1_800_000_000
const sq = (p: number) => BigInt(Math.round(Math.sqrt(p) * 2 ** 96))
const swapTopics = encodeEventTopics({ abi: V4_POOL_MANAGER_ABI, eventName: 'Swap', args: { id: POOL, sender: '0x000000000000000000000000000000000000beef' } }) as string[]
const swapData = (pricePerEth: number) => encodeAbiParameters([{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }], [BigInt(-1e16), BigInt(1e19), sq(pricePerEth), BigInt(1e18), 0, 10000])

type Opts = { blockSec?: number; swapsPerHour: number; exact?: boolean; poolAgeSec?: number; nodeMaxLogs?: number; pricePerEth?: (b: number) => number; eth?: Array<[number, number]> }
// Robinhood Chain V4 pool: native ETH currency0, scanned token currency1; every swap log carries its exact time.
function robinhood(o: Opts) {
  const bs = o.blockSec ?? 0.25
  const tsOf = (b: number) => Math.round(LATEST_TS - (LATEST - b) * bs)
  const every = Math.max(1, Math.round(3600 / o.swapsPerHour / bs))
  const initBlock = LATEST - Math.floor((o.poolAgeSec ?? 4 * 86_400) / bs)
  const calls: Array<{ method: string; params: unknown[] }> = []
  let logsServed = 0
  const logsIn = (from: number, to: number): RawEvmLog[] => {
    const out: RawEvmLog[] = []
    for (let b = Math.ceil(Math.max(from, initBlock + 1) / every) * every; b <= to; b += every) {
      out.push({ address: MGR, topics: swapTopics, data: swapData(o.pricePerEth ? o.pricePerEth(b) : 1000), blockNumber: hex(b), logIndex: '0x0', ...(o.exact === false ? {} : { blockTimestamp: hex(tsOf(b)) }) } as RawEvmLog)
    }
    return out
  }
  const rpc = async (method: string, params: unknown[]) => {
    calls.push({ method, params })
    if (method === 'eth_getBlockByNumber') { const b = params[0] === 'latest' ? LATEST : Number(BigInt(params[0] as string)); return { result: { number: hex(b), timestamp: hex(tsOf(b)) }, error: false } }
    if (method === 'eth_call') return { result: hex(18), error: false }
    const f = params[0] as { topics: string[]; fromBlock: string; toBlock: string }
    if (f.topics[0] === V4_INITIALIZE_TOPIC0) {
      return { result: [{ address: MGR, topics: encodeEventTopics({ abi: V4_POOL_MANAGER_ABI, eventName: 'Initialize', args: { id: POOL, currency0: NATIVE as Hex, currency1: TOKEN as Hex } }) as string[], data: encodeAbiParameters([{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }], [10000, 200, NATIVE, BigInt(2) ** BigInt(96), 0]), blockNumber: hex(initBlock), logIndex: '0x0' }], error: false }
    }
    const logs = logsIn(Number(BigInt(f.fromBlock)), Number(BigInt(f.toBlock)))
    if (o.nodeMaxLogs != null && logs.length > o.nodeMaxLogs) return { result: null, error: true } // node response limit
    logsServed += logs.length
    return { result: logs, error: false }
  }
  const ethPoints = o.eth ?? Array.from({ length: 600 }, (_, i) => [(LATEST_TS - 48 * 3600 + i * 300) * 1000, 3000] as [number, number])
  const deps: V4SwapDeps = { now: () => LATEST_TS * 1000, rpc, ethUsdSeries: async () => ({ points: ethPoints, cacheHit: false }) }
  const historyDeps: V4HistoryDeps = {
    now: () => LATEST_TS * 1000, rpc,
    ethUsdRange: async (f, t) => ({ points: Array.from({ length: Math.ceil((t - f) / 3600) + 2 }, (_, i) => [(f + i * 3600) * 1000, 3000] as [number, number]), cacheHit: false }),
  }
  return { deps, historyDeps, calls, tsOf, initBlock, logsServed: () => logsServed, pages: () => calls.filter((c) => c.method === 'eth_getLogs' && (c.params[0] as { topics: string[] }).topics[0] === V4_SWAP_TOPIC0) }
}
const scanInput = { chain: 'robinhood', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 3 }

test('busy Robinhood V4 pool (~1,500 swaps/h, 0.25s blocks): the scan stops on the 6,000-log cap at ~4h — proven by the window evidence', async () => {
  resetV4SwapCandleCache()
  const c = robinhood({ swapsPerHour: 1500 })
  const r = await loadV4SwapCandles(scanInput, c.deps)
  assert.equal(r.ok, true, String(r.code))
  assert.equal(r.budgetStopReason, 'log_cap')
  assert.equal(r.logsFound, V4_SWAP_MAX_LOGS)
  assert.equal(r.intervalSec, 300)
  const w = r.window!
  assert.deepEqual([w.latestBlock, w.latestTs, w.initBlock, w.targetSource], [LATEST, LATEST_TS, c.initBlock, 'real_header'])
  assert.equal(w.targetBlock, LATEST - V4_SWAP_TARGET_WINDOW_SEC / 0.25 + 1, 'the 24h target in blocks')
  // Newest-first pages of 57,600 blocks (= 4h at 0.25s); busy => the second page is the same size; contiguous.
  assert.deepEqual(w.pages.map((p) => p.toBlock - p.fromBlock + 1), [57_600, 57_600])
  assert.equal(w.pages[0].toBlock, LATEST)
  assert.equal(w.pages[1].toBlock, w.pages[0].fromBlock - 1)
  assert.ok(w.pages[0].logs > 5000, 'page 1 alone holds ~5,800 exact-PoolId swaps')
  // Covered ~4h (newest 6,000 swaps, oldest partial bucket dropped) — NOT 24h; the real rate is reported.
  assert.ok(w.coveredSec! > 3.9 * 3600 && w.coveredSec! < 4.3 * 3600, String(w.coveredSec))
  assert.ok(Math.abs(w.swapsPerHour! - 1500) / 1500 < 0.06, String(w.swapsPerHour))
  assert.equal(w.newestSwapTs, c.tsOf(Math.floor(LATEST / 10) * 10), 'newest swap is the latest block\'s trade')
  assert.ok(LATEST_TS - w.newestSwapTs! < 60, 'the newest candle is at "now" — log cap keeps the NEWEST swaps')
  // 17 x 15M after roll-up, exactly as in production.
  const span = (Date.parse(r.candles[r.candles.length - 1].timestamp) - Date.parse(r.candles[0].timestamp)) / 1000 + 300
  assert.equal(Math.round(span / 900), 17)
  assert.deepEqual([r.pipeline.logsReturned >= r.pipeline.exactPoolSwaps, r.pipeline.usdPricedSwaps > 0, r.pipeline.candles], [true, true, r.candles.length])
})

test('log-cap / rpc-error stops are honest; a quiet pool covers the full 24h target', async () => {
  resetV4SwapCandleCache()
  const quiet = await loadV4SwapCandles(scanInput, robinhood({ swapsPerHour: 200 }).deps)
  assert.equal(quiet.budgetStopReason, 'target_window')
  assert.equal(quiet.window!.coveredSec, V4_SWAP_TARGET_WINDOW_SEC)
  resetV4SwapCandleCache()
  // A node that rejects page 2 (8h page > its 2,500-log limit): stops on rpc_error, covers only page 1 (~4h) — truthfully.
  const nodeLimited = await loadV4SwapCandles(scanInput, robinhood({ swapsPerHour: 400, nodeMaxLogs: 2_500 }).deps)
  assert.equal(nodeLimited.ok, true)
  assert.equal(nodeLimited.budgetStopReason, 'rpc_error')
  assert.equal(nodeLimited.window!.pages.length, 1)
  assert.ok(nodeLimited.window!.coveredSec! <= 4 * 3600 + 300, String(nodeLimited.window!.coveredSec))
  resetV4SwapCandleCache()
  const veryBusy = await loadV4SwapCandles(scanInput, robinhood({ swapsPerHour: 2500 }).deps)
  assert.equal(veryBusy.budgetStopReason, 'log_cap')
  assert.equal(veryBusy.window!.pages.length, 1)
})

test('chain FASTER than its nominal block time: Robinhood extends the target by the measured rate (24h, no extra call); never claims 24h it did not read', async () => {
  resetV4SwapCandleCache()
  const c = robinhood({ swapsPerHour: 200, blockSec: 0.1 })
  const r = await loadV4SwapCandles(scanInput, c.deps)
  assert.equal(r.window!.targetSource, 'measured_rate')
  assert.ok(Math.abs(r.window!.secPerBlock! - 0.1) < 1e-6)
  assert.equal(r.budgetStopReason, 'target_window')
  assert.ok(Math.abs(r.window!.coveredSec! - V4_SWAP_TARGET_WINDOW_SEC) <= 1)
  assert.equal(c.calls.filter((x) => x.method === 'eth_getBlockByNumber').length, 2, 'latest + one anchor header only')
  // A young pool on that fast chain: stops at its creation and says exactly how much exists.
  resetV4SwapCandleCache()
  const young = await loadV4SwapCandles(scanInput, robinhood({ swapsPerHour: 200, blockSec: 0.05, poolAgeSec: 10 * 3600 }).deps)
  assert.equal(young.ok, true)
  assert.ok(young.window!.coveredSec! <= 10 * 3600 + 1, String(young.window!.coveredSec))
})

test('ladder coverage is truthful: a log-capped read is not a proven 24h window and carries the real swap rate', async () => {
  resetV4SwapCandleCache()
  const c = robinhood({ swapsPerHour: 1500 })
  const v4 = await loadV4SwapCandles(scanInput, c.deps)
  const pool: LadderPool = { poolId: `robinhood_${POOL}`, address: POOL, name: 'ROBINPEPE / ETH', liquidityUsd: 1e5, pool: { id: `robinhood_${POOL}` } }
  const deps: LadderDeps = {
    fetchPoolOhlcv: async () => ({ httpStatus: 404, json: null }),
    fetchTrades: async () => ({ httpStatus: 200, json: { data: [] } }),
    fetchV4SwapCandles: async () => v4 as unknown as LadderV4SwapResult,
  }
  const r = await runEvmCandleLadder({ pools: [pool], contract: TOKEN, networkId: 'robinhood', coingeckoNetworkId: null, currentPriceUsd: 3, nowSec: LATEST_TS }, deps)
  const cov = r.chartCandles!.coverage!
  assert.equal(cov.windowProven, undefined, 'never a proven 24h window')
  assert.equal(cov.requestedStartSec, null)
  assert.equal(cov.stopReason, 'log_cap')
  assert.ok(Math.abs(cov.swapsPerHour! - 1500) / 1500 < 0.06)
  assert.equal(r.v4Swap!.window!.pages.length, 2, 'window evidence reaches the debug panel')
  assert.ok(r.v4Swap!.latestTrade)
  const page = read('app/terminal/token-scanner/page.tsx')
  assert.match(page, /debug\.v4\?\.window \? v4WindowDebugText\(debug\.v4\.window, debug\.v4\.pipeline \?\? null\) : ''/)
  assert.match(page, /page \$\{i \+ 1\}: blocks \$\{pg\.fromBlock\}–\$\{pg\.toBlock\}/)
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /const busyCapped = coverage\?\.stopReason === 'log_cap' && hist\.candles\.length === 0/)
  assert.match(panel, / · newest swaps \(busy pool\)/)
})

test('history for a busy pool: density-sized pages (no 24h page of ~36k logs, no node-limit error), up to 15,000 genuine swaps per request', async () => {
  resetV4SwapCandleCache()
  const before = LATEST_TS - 4 * 3600
  const blind = robinhood({ swapsPerHour: 1500, nodeMaxLogs: 10_000 })
  const old = await loadV4SwapHistoryWindow({ chain: 'robinhood', poolId: POOL, token: TOKEN, beforeSec: before }, blind.historyDeps)
  assert.equal(old.ok, true)
  // Without a density the first page is 24h of blocks: rejected by a 10k-log node, then shrunk once.
  const span = (p: { params: unknown[] }) => { const f = p.params[0] as { fromBlock: string; toBlock: string }; return Number(BigInt(f.toBlock)) - Number(BigInt(f.fromBlock)) + 1 }
  assert.equal(Math.round(span(blind.pages()[0]) * 0.25 / 3600), 24, 'blind first page = 24h of blocks (~36k logs)')
  assert.ok(blind.pages().length >= 2 && span(blind.pages()[1]) < span(blind.pages()[0]), 'rejected by the node, then a smaller page')
  resetV4SwapCandleCache()
  const c = robinhood({ swapsPerHour: 1500, nodeMaxLogs: 10_000 })
  const h = await loadV4SwapHistoryWindow({ chain: 'robinhood', poolId: POOL, token: TOKEN, beforeSec: before, swapsPerHourHint: 1500 }, c.historyDeps)
  assert.equal(h.ok, true)
  for (const p of c.pages()) {
    const f = p.params[0] as { fromBlock: string; toBlock: string }
    const blocks = Number(BigInt(f.toBlock)) - Number(BigInt(f.fromBlock)) + 1
    assert.ok(blocks * 0.25 * 1500 / 3600 <= V4_HISTORY_TARGET_PAGE_LOGS * 1.05, `page of ${blocks} blocks stays near the per-page log target`)
  }
  assert.equal(c.logsServed(), h.logsFound, 'every downloaded swap is kept (no oversized page discarded)')
  assert.ok(h.logsFound <= V4_HISTORY_MAX_LOGS)
  assert.ok(h.candles.length >= 5, String(h.candles.length))
  // The scan's own read remembers the density on this instance (no hint needed).
  resetV4SwapCandleCache()
  const warm = robinhood({ swapsPerHour: 1500, nodeMaxLogs: 10_000 })
  await loadV4SwapCandles(scanInput, warm.deps)
  const before2 = warm.pages().length
  const h2 = await loadV4SwapHistoryWindow({ chain: 'robinhood', poolId: POOL, token: TOKEN, beforeSec: before }, warm.historyDeps)
  assert.equal(h2.ok, true)
  assert.equal(warm.pages().length - before2, h2.pagesFetched, 'no failed oversized page')
})

test('busy pool after load: 4 bounded automatic requests build a full 1H chart (>= 30 genuine hourly candles); history prepends without moving the view', async () => {
  resetV4SwapCandleCache()
  const c = robinhood({ swapsPerHour: 1500, nodeMaxLogs: 10_000 })
  const scan = await loadV4SwapCandles(scanInput, c.deps)
  const scanCandles = normalizeChartCandles(scan.candles)
  const cutoffMs = Math.ceil(scanCandles[0].t / 3_600_000) * 3_600_000
  const out = await loadHistoryBatch({
    start: { candles: [], nextBeforeSec: null, hasMore: true }, cutoffMs, newestMs: scanCandles[scanCandles.length - 1].t, maxRequests: 4, targetSpanSec: 3 * 86_400,
    load: async (beforeSec) => {
      const h = await loadV4SwapHistoryWindow({ chain: 'robinhood', poolId: POOL, token: TOKEN, beforeSec, swapsPerHourHint: scan.window!.swapsPerHour }, c.historyDeps)
      return h.ok ? { ok: true, points: h.candles, hasMore: h.hasMore, nextBeforeSec: h.nextBeforeSec, endReason: h.endReason ?? null } : { ok: false, message: String(h.code) }
    },
  })
  assert.ok(out.candles.length >= 30, `${out.candles.length} hourly candles`)
  for (const k of out.candles) assert.equal(k.t % 3_600_000, 0, 'genuine hourly buckets only')
  assert.ok(out.candles.every((k) => k.t < cutoffMs), 'history stays strictly older than the scan window')
  // Prepend keeps the visible candles: a zoom set before the batch maps onto the same candles after it.
  const merged: ChartCandle[] = mergeHistoryCandles([], out.candles, cutoffMs)
  const id = chartDataIdentity('robinhood:pool', scanCandles)
  const beforeTotal = 10
  const stored = { identity: id, seriesKey: '1H:x', view: { start: 2, end: 10 }, total: beforeTotal }
  const after = resolveChartViewport(stored, { identity: id, seriesKey: '1H:x', total: beforeTotal + merged.length }, { start: 0, end: 8 })
  assert.deepEqual([after.valid, after.prepended, after.view.start, after.view.end], [true, merged.length, 2 + merged.length, 10 + merged.length])
})

test('exact 1M aggregation: genuine 60s buckets from the pool\'s own swaps on demand; never from 5M; non-exact -> precise reason', async () => {
  resetV4SwapCandleCache()
  const c = robinhood({ swapsPerHour: 200 }) // one swap every 18s of blocks... every 72 blocks = 18s
  const scan = await loadV4SwapCandles(scanInput, c.deps)
  assert.equal(scan.intervalSec, 300)
  const callsBefore = c.calls.length
  const one = await loadV4SwapIntradayWindow({ chain: 'robinhood', poolId: POOL, token: TOKEN, intervalSec: 60 }, c.deps)
  assert.equal(one.ok, true, String(one.code))
  assert.equal(one.intervalSec, 60)
  assert.ok(c.calls.length > callsBefore, 'a fresh bounded read — the scan\'s 5M candles are never split')
  const swapMinutes = new Set<number>()
  for (const p of c.pages().slice(-3)) {
    const f = p.params[0] as { fromBlock: string; toBlock: string }
    for (let b = Math.ceil(Number(BigInt(f.fromBlock)) / 72) * 72; b <= Number(BigInt(f.toBlock)); b += 72) swapMinutes.add(Math.floor(c.tsOf(b) / 60) * 60)
  }
  for (const k of one.candles) {
    const t = Date.parse(k.timestamp) / 1000
    assert.equal(t % 60, 0)
    assert.ok(swapMinutes.has(t), 'every 1M candle is a minute with a real swap')
  }
  assert.ok(one.candles.length > scan.candles.length, 'denser than 5M over the same window')
  // Inferred times: 1M refused with the exact reason (Robinhood: logs without timestamps are unproven).
  resetV4SwapCandleCache()
  const inexact = await loadV4SwapIntradayWindow({ chain: 'robinhood', poolId: POOL, token: TOKEN, intervalSec: 60 }, robinhood({ swapsPerHour: 200, exact: false }).deps)
  assert.equal(inexact.ok, false)
  assert.ok(inexact.code === 'v4_timestamps_unproven' || inexact.code === 'v4_timestamps_not_exact', String(inexact.code))
  const route = read('app/api/token/chart-candles/route.ts')
  assert.match(route, /if \(tfParam === '1m' && !isV4Pool\)/, '1M exists only on the exact V4 lane')
  const page = read('app/terminal/token-scanner/page.tsx')
  assert.match(page, /if \(source !== 'v4_swap_events' \|\| timeResolution !== 'exact_log_timestamps' \|\| !pool \|\| !\/\^0x\[a-fA-F0-9\]\{64\}\$\/\.test\(pool\)\) return undefined/)
  assert.doesNotMatch(read('app/api/token/route.ts'), /timeframe=1m|loadV4SwapIntradayWindow/, 'zero normal-scan cost')
})

test('latest-price freshness + quote drift: the latest close carries its exact quote point; drift vs the live price is measured, never hidden', async () => {
  resetV4SwapCandleCache()
  // ETH/USD moves 3000 -> 3090 (+3%) 10 minutes before "now"; the newest trade must use the NEAREST real point.
  const eth: Array<[number, number]> = Array.from({ length: 600 }, (_, i) => {
    const ms = (LATEST_TS - 48 * 3600 + i * 300) * 1000
    return [ms, ms >= (LATEST_TS - 600) * 1000 ? 3090 : 3000]
  })
  const c = robinhood({ swapsPerHour: 200, eth })
  const r = await loadV4SwapCandles({ ...scanInput, livePriceUsd: 3.09 }, c.deps)
  const t = r.latestTrade!
  assert.ok(LATEST_TS - t.timestampSec < 30)
  assert.equal(t.counterUsd, 3090)
  assert.ok(t.quoteGapMs! <= 300_000)
  assert.ok(Math.abs(t.priceInCounter - 0.001) < 1e-9)
  assert.ok(Math.abs(t.priceUsd - 3.09) < 1e-6)
  assert.ok(Math.abs(r.candles[r.candles.length - 1].close - t.priceUsd) < 1e-9, 'the latest close IS that trade')
  // Audit: chart close ~16% under the live price (the ~$409K vs ~$488K shape) is flagged; MCAP under the
  // inferred basis moves 1:1 with it; within 5% nothing is flagged.
  const live = 3.57
  const supply = 488_000 / live
  const a = auditLatestClose({ lastCandle: { t: 0, close: 2.993 }, livePriceUsd: live, livePriceAtMs: 60_000, supply, basis: 'inferred_current_mc', verifiedMarketCapUsd: 488_000 })
  assert.ok(a.drifted)
  assert.ok(Math.abs(a.closeVsLive! - (2.993 - live) / live) < 1e-12)
  assert.ok(Math.abs(a.mcapClose! - 409_000) / 409_000 < 0.01)
  assert.ok(Math.abs(a.mcapCloseVsVerified! - a.closeVsLive!) < 1e-12, 'inferred basis: MCAP gap == close gap')
  assert.equal(a.candleAgeSec, 60)
  assert.equal(auditLatestClose({ lastCandle: { t: 0, close: 3.5 }, livePriceUsd: live, livePriceAtMs: 0, supply, basis: 'inferred_current_mc', verifiedMarketCapUsd: 488_000 }).drifted, false)
  assert.equal(LATEST_CLOSE_DRIFT_NOTICE, 0.05)
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /const latestAudit = auditLatestClose\(\{ lastCandle: scanNewest, livePriceUsd, livePriceAtMs: referenceTimeMs,/)
  assert.match(panel, /latestAudit\.drifted && latestAudit\.closeVsLive != null/)
  assert.match(panel, /latestClose: latestAudit,/)
  assert.match(read('app/terminal/token-scanner/page.tsx'), /livePriceUsd=\{result\.price \?\? null\}/)
})

test('timeframe label always matches the real candle interval (1M / 5M on demand, 15M+ from genuine data)', () => {
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /const activeKey: ChartTimeframeKey \| null = oneActive \? '1M' : fiveActive \? '5M' : \(activeTf\?\.key \?\? null\)/)
  assert.match(panel, /const intervalSec = oneActive \? ONE_MIN_SEC : fiveActive \? FIVE_MIN_SEC : activeTf/)
  assert.match(panel, /const priceSeries: ChartCandle\[\] = oneActive && one\.status === 'ready' \? one\.candles : fiveActive && five\.status === 'ready' \? five\.candles :/)
  assert.match(panel, /× \{formatIntervalLabel\(intervalSec\)\} real candles/)
  assert.match(panel, /const oneLoadable = loadOneMinute != null/)
})

// ── History cache hardening: retryable sizing failures never block a density-sized read ─────────────
// Base (fixed 2s blocks) pool behind a node that rejects block ranges wider than `maxRange`.
function rangeLimitedBase(swapsPerHour: number, maxRange: number) {
  const mgr = V4_SWAP_CHAIN_CONFIG.base.poolManager
  const every = Math.max(1, Math.round(3600 / swapsPerHour / 2))
  const tsOf = (b: number) => LATEST_TS - (LATEST - b) * 2
  const topics = encodeEventTopics({ abi: V4_POOL_MANAGER_ABI, eventName: 'Swap', args: { id: POOL, sender: '0x000000000000000000000000000000000000beef' } }) as string[]
  let logPages = 0
  const deps: V4HistoryDeps = {
    now: () => LATEST_TS * 1000,
    rpc: async (method, params) => {
      if (method === 'eth_getBlockByNumber') return { result: { number: hex(LATEST), timestamp: hex(LATEST_TS) }, error: false }
      if (method === 'eth_call') return { result: hex(18), error: false }
      const f = params[0] as { topics: string[]; fromBlock: string; toBlock: string }
      if (f.topics[0] === V4_INITIALIZE_TOPIC0) {
        return { result: [{ address: mgr, topics: encodeEventTopics({ abi: V4_POOL_MANAGER_ABI, eventName: 'Initialize', args: { id: POOL, currency0: NATIVE as Hex, currency1: TOKEN as Hex } }) as string[], data: encodeAbiParameters([{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }], [10000, 200, NATIVE, BigInt(2) ** BigInt(96), 0]), blockNumber: hex(LATEST - 10 * 43_200), logIndex: '0x0' }], error: false }
      }
      logPages++
      const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock))
      if (to - from + 1 > maxRange) return { result: null, error: true } // node block-range limit
      const out: RawEvmLog[] = []
      for (let b = Math.ceil(from / every) * every; b <= to; b += every) out.push({ address: mgr, topics, data: swapData(1000), blockNumber: hex(b), logIndex: '0x0', blockTimestamp: hex(tsOf(b)) } as RawEvmLog)
      return { result: out, error: false }
    },
    ethUsdRange: async (f, t) => ({ points: Array.from({ length: Math.ceil((t - f) / 3600) + 2 }, (_, i) => [(f + i * 3600) * 1000, 3000] as [number, number]), cacheHit: false }),
  }
  return { deps, logPages: () => logPages }
}
const historyReq = (hint: number | null) => ({ chain: 'base', poolId: POOL, token: TOKEN, beforeSec: LATEST_TS - 4 * 3600, swapsPerHourHint: hint })

test('history cache: a no-hint read the node rejects (rpc_error) does not block a later busy-hint read of the same cursor; the success is then shared', async () => {
  resetV4SwapCandleCache()
  const node = rangeLimitedBase(1500, 6_500) // 24h / 6h / 4h pages all exceed the node's 6,500-block range
  // 1. No hint: blind 24h page, shrunk to the 4h floor — every page rejected => retryable failure.
  const blind = await loadV4SwapHistoryWindow(historyReq(null), node.deps)
  assert.equal(blind.ok, false)
  assert.equal(blind.code, 'v4_swap_logs_unavailable')
  assert.equal(blind.stopReason, 'rpc_error')
  const pagesAfterBlind = node.logPages()
  // 2. Busy hint: density-sized pages under the node limit — it actually executes (not the cached failure) and succeeds.
  const sized = await loadV4SwapHistoryWindow(historyReq(1500), node.deps)
  assert.equal(sized.ok, true, String(sized.code))
  assert.ok(sized.callsUsed > 0 && node.logPages() > pagesAfterBlind, 'a fresh read, not the cached failure')
  assert.ok(sized.candles.length > 0)
  // 3. The success is reusable for that cursor regardless of hint — even a no-hint request now gets it, 0 calls.
  const pagesAfterSuccess = node.logPages()
  for (const h of [null, 300, 1500, 12_000]) {
    const again = await loadV4SwapHistoryWindow(historyReq(h), node.deps)
    assert.equal(again.ok, true)
    assert.deepEqual([again.callsUsed, again.cache.result], [0, true])
  }
  assert.equal(node.logPages(), pagesAfterSuccess)
})

test('history cache: the same no-hint failure IS reused for the same class (no hammering); identical busy requests dedupe; bounded key cardinality', async () => {
  resetV4SwapCandleCache()
  const node = rangeLimitedBase(1500, 6_500)
  await loadV4SwapHistoryWindow(historyReq(null), node.deps)
  const pages = node.logPages()
  const repeat = await loadV4SwapHistoryWindow(historyReq(null), node.deps)
  assert.deepEqual([repeat.ok, repeat.callsUsed, node.logPages()], [false, 0, pages], 'same blind class: cached failure, zero calls')
  // 4. Identical concurrent busy-hint requests share one read (1500 and 1499.7 normalize to the same class).
  resetV4SwapCandleCache()
  const shared = rangeLimitedBase(1500, 6_500)
  const [a, b] = await Promise.all([loadV4SwapHistoryWindow(historyReq(1500), shared.deps), loadV4SwapHistoryWindow(historyReq(1499.7), shared.deps)])
  assert.deepEqual(a, b)
  const single = rangeLimitedBase(1500, 6_500)
  resetV4SwapCandleCache()
  await loadV4SwapHistoryWindow(historyReq(1500), single.deps)
  assert.equal(shared.logPages(), single.logPages(), 'two identical concurrent requests = one read')
  // Raw floating-point hints never become keys: a small fixed set of classes.
  assert.deepEqual([historyDensityClass(null), historyDensityClass(50), historyDensityClass(600), historyDensityClass(1500), historyDensityClass(1499.7), historyDensityClass(9000)], ['unknown', 'quiet', 'normal', 'busy', 'busy', 'very_busy'])
  assert.equal(HISTORY_DENSITY_CLASSES.length, 6)
})

test('history cache: a call-budget stop stays uncached (as before)', async () => {
  resetV4SwapCandleCache()
  // Every log page is rejected; a cold non-fixed chain (header + Initialize + decimals + anchor) runs out of calls first.
  const c = robinhood({ swapsPerHour: 1500, nodeMaxLogs: 1 })
  const req = { chain: 'robinhood', poolId: POOL, token: TOKEN, beforeSec: LATEST_TS - 4 * 3600 }
  const first = await loadV4SwapHistoryWindow(req, c.historyDeps)
  assert.deepEqual([first.ok, first.code, first.stopReason], [false, 'call_budget_exhausted', 'call_budget'])
  const before = c.calls.length
  const second = await loadV4SwapHistoryWindow(req, c.historyDeps)
  assert.equal(second.cache.result, false, 'a budget stop says nothing about the pool: never served from cache')
  assert.ok(c.calls.length > before && second.callsUsed > 0, 'the second request really executes')
})
