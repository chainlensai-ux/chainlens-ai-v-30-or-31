// On-demand older history for NORMAL 20-byte EVM pools (lib/server/chartCandlesOnDemand.ts
// loadPoolOhlcvHistory + /api/token/chart-candles + page/panel wiring), including the AERO shape:
// an old Aerodrome pool whose scan window (15m x 672) only yields ~8 daily candles.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  POOL_HISTORY_MAX_PROVIDER_CALLS,
  POOL_HISTORY_REQUEST,
  loadPoolOhlcvHistory,
  rememberVerifiedChartPool,
  resetOnDemandCandleState,
  type FetchCoingeckoOhlcv,
} from '../lib/server/chartCandlesOnDemand.ts'
import { aggregateCandles, buildChartTimeframes, formatChartTime, normalizeChartCandles, type ChartCandle } from '../lib/priceChartCandles.ts'
import { HISTORY_MAX_REQUESTS_PER_ACTION, HISTORY_TARGET_SPAN_SEC, historyCutoffMs, loadHistoryBatch, withHistory, type HistoryWindowResult } from '../lib/chartHistory.ts'
import { scaleCandlesToMarketCap } from '../lib/chartMarketCap.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const AERO = '0x940181a94a35a4569e4529a3cdfb74e38fd98631'
const WETH = '0x4200000000000000000000000000000000000006'
const POOL = '0x' + '7f'.repeat(20)
const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 29, 14, 37)

// ── Ground truth: 120 days of real 5m trades (with a dead hour every day and one no-trade day) ────
let seed = 11
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const TRUTH: ChartCandle[] = []
{
  let px = 1.2
  for (let t = NOW - 120 * DAY - (NOW % 300_000); t <= NOW - (NOW % 300_000); t += 300_000) {
    const d = new Date(t)
    if (d.getUTCHours() === 4 || (d.getUTCMonth() === 6 && d.getUTCDate() === 15)) continue
    const open = px
    px = Math.max(0.01, px * (1 + (rnd() - 0.5) * 0.01))
    TRUTH.push({ t, open, high: Math.max(open, px) * 1.002, low: Math.min(open, px) * 0.998, close: px, volume: Math.round(rnd() * 5000) })
  }
}
const HOURLY = aggregateCandles(TRUTH, 3600)
const toRow = (c: ChartCandle) => [c.t / 1000, c.open, c.high, c.low, c.close, c.volume ?? 0]

/** A provider serving genuine hourly OHLCV newest-first, `limit` rows at/before the cursor (inclusive, to test the boundary). */
function providerWindow(beforeSec: number, limit: number, side: 'base' | 'quote') {
  const rows = HOURLY.filter((c) => c.t / 1000 <= beforeSec).slice(-limit).reverse().map(toRow)
  return { data: { attributes: { ohlcv_list: rows } }, meta: side === 'base' ? { base: { address: AERO }, quote: { address: WETH } } : { base: { address: WETH }, quote: { address: AERO } } }
}

function fakes(opts: { cgFails?: boolean; cgMetaWrong?: boolean; gtPoolSide?: 'base' | 'quote' | 'none' } = {}) {
  const calls: string[] = []
  const fetchCoingecko: FetchCoingeckoOhlcv = async (_c, pool, req, side, beforeSec) => {
    calls.push(`CG ${pool} ${req.resolution}x${req.limit} ${side} before=${beforeSec}`)
    if (opts.cgFails) return { json: null, httpStatus: 500 }
    const json = providerWindow(beforeSec!, req.limit, side)
    if (opts.cgMetaWrong) json.meta = { base: { address: WETH }, quote: { address: '0x' + '99'.repeat(20) } }
    return { json, httpStatus: 200 }
  }
  const fetchJson = async (url: string) => {
    calls.push(`GT ${url.replace('https://api.geckoterminal.com', '')}`)
    if (/\/ohlcv\//.test(url)) {
      const before = Number(new URL(url).searchParams.get('before_timestamp'))
      const side = new URL(url).searchParams.get('token') as 'base' | 'quote'
      return { json: providerWindow(before, 1000, side), httpStatus: 200 }
    }
    const s = opts.gtPoolSide ?? 'base'
    const base = s === 'base' ? AERO : WETH
    const quote = s === 'quote' ? AERO : s === 'none' ? '0x' + '55'.repeat(20) : WETH
    return { json: { data: { id: `base_${POOL}`, relationships: { base_token: { data: { id: `base_${base}` } }, quote_token: { data: { id: `base_${quote}` } } } } }, httpStatus: 200 }
  }
  return { calls, fetchCoingecko, fetchJson }
}
const cutoffSec = Math.floor(NOW / 1000 / 3600) * 3600 - 7 * 86_400

// ── Server: bounded, side-proven, cursor windows ─────────────────────────────────────────────────
test('remembered side: ONE CoinGecko call, hour x 1000 with before_timestamp; rows strictly before the cursor; hasMore + nextBeforeSec', async () => {
  resetOnDemandCandleState()
  rememberVerifiedChartPool('base', AERO, POOL, 'base', NOW)
  const f = fakes()
  const r = await loadPoolOhlcvHistory({ chain: 'base', token: AERO, pool: POOL, side: 'base', before: cutoffSec }, f.fetchJson, { now: () => NOW, fetchCoingecko: f.fetchCoingecko })
  assert.equal(r.result.ok, true)
  assert.deepEqual(f.calls, [`CG ${POOL} hourx1000 base before=${cutoffSec}`])
  assert.equal(r.providerCalls, 1)
  if (!r.result.ok) return
  assert.equal(r.result.intervalSec, 3600)
  const ts = r.result.points.map((p) => Date.parse(p.timestamp) / 1000)
  assert.ok(ts.every((t) => t < cutoffSec), 'the inclusive boundary row at the cursor is dropped')
  assert.equal(r.result.points.length, 999)
  assert.equal(r.result.hasMore, true)
  assert.equal(r.result.nextBeforeSec, Math.min(...ts))
  assert.equal(r.result.source, 'coingecko_onchain')
})

test('unremembered side is proven from the pool itself (one GeckoTerminal read); a quote-side token asks for its own side', async () => {
  resetOnDemandCandleState()
  const f = fakes({ gtPoolSide: 'quote' })
  const r = await loadPoolOhlcvHistory({ chain: 'base', token: AERO, pool: POOL, side: 'quote', before: cutoffSec }, f.fetchJson, { now: () => NOW, fetchCoingecko: f.fetchCoingecko })
  assert.equal(r.result.ok, true)
  assert.deepEqual(f.calls, [`GT /api/v2/networks/base/pools/${POOL}`, `CG ${POOL} hourx1000 quote before=${cutoffSec}`])
  assert.ok(r.providerCalls <= POOL_HISTORY_MAX_PROVIDER_CALLS)
})

test('identity: a claimed side that disagrees with the proof, a token not in the pool, or a CoinGecko meta for another pair never shows data', async () => {
  resetOnDemandCandleState()
  const a = fakes({ gtPoolSide: 'base' })
  const mismatch = await loadPoolOhlcvHistory({ chain: 'base', token: AERO, pool: POOL, side: 'quote', before: cutoffSec }, a.fetchJson, { now: () => NOW, fetchCoingecko: a.fetchCoingecko })
  assert.deepEqual([mismatch.result.ok, !mismatch.result.ok && mismatch.result.code], [false, 'token_side_unresolved'])
  assert.ok(!a.calls.some((c) => c.startsWith('CG')), 'no OHLCV read for an unproven side')
  resetOnDemandCandleState()
  const b = fakes({ gtPoolSide: 'none' })
  const notInPool = await loadPoolOhlcvHistory({ chain: 'base', token: AERO, pool: POOL, before: cutoffSec }, b.fetchJson, { now: () => NOW, fetchCoingecko: b.fetchCoingecko })
  assert.deepEqual([notInPool.result.ok, !notInPool.result.ok && notInPool.result.code], [false, 'token_side_unresolved'])
  assert.equal(b.calls.length, 1)
  resetOnDemandCandleState()
  rememberVerifiedChartPool('base', AERO, POOL, 'base', NOW)
  const c = fakes({ cgMetaWrong: true })
  const wrongMeta = await loadPoolOhlcvHistory({ chain: 'base', token: AERO, pool: POOL, before: cutoffSec }, c.fetchJson, { now: () => NOW, fetchCoingecko: c.fetchCoingecko })
  assert.equal(wrongMeta.result.ok && wrongMeta.result.source, 'geckoterminal', 'a CoinGecko series for another pair is not used — GeckoTerminal serves the proven side')
})

test('CoinGecko failure falls back to GeckoTerminal with the same cursor; <= 3 calls', async () => {
  resetOnDemandCandleState()
  const f = fakes({ cgFails: true, gtPoolSide: 'base' })
  const r = await loadPoolOhlcvHistory({ chain: 'base', token: AERO, pool: POOL, before: cutoffSec }, f.fetchJson, { now: () => NOW, fetchCoingecko: f.fetchCoingecko })
  assert.equal(r.providerCalls, 3)
  assert.match(f.calls[2], new RegExp(`/ohlcv/hour\\?aggregate=1&limit=1000&currency=usd&token=base&before_timestamp=${cutoffSec}$`))
  assert.equal(r.result.ok && r.result.source, 'geckoterminal')
})

// ── End-of-history evidence (a short page is NOT evidence) ───────────────────────────────────────
/** CoinGecko serving an arbitrary list of hourly timestamps (sec) at/before the cursor. */
function listProvider(hoursSec: number[], opts: { gtRows?: number[]; created?: string | null } = {}) {
  const calls: string[] = []
  const rows = (ts: number[], before: number) => ts.filter((t) => t <= before).sort((a, b) => b - a).slice(0, 1000).map((t) => [t, 1, 1.01, 0.99, 1, 10])
  const fetchCoingecko: FetchCoingeckoOhlcv = async (_c, _p, _r, side, beforeSec) => {
    calls.push(`CG before=${beforeSec}`)
    return { json: { data: { attributes: { ohlcv_list: rows(hoursSec, beforeSec!) } }, meta: side === 'base' ? { base: { address: AERO }, quote: { address: WETH } } : undefined }, httpStatus: 200 }
  }
  const fetchJson = async (url: string) => {
    if (/\/ohlcv\//.test(url)) {
      const before = Number(new URL(url).searchParams.get('before_timestamp'))
      calls.push(`GT ohlcv before=${before}`)
      return { json: { data: { attributes: { ohlcv_list: rows(opts.gtRows ?? [], before) } } }, httpStatus: 200 }
    }
    calls.push('GT pool')
    return { json: { data: { id: `base_${POOL}`, attributes: { pool_created_at: opts.created ?? null }, relationships: { base_token: { data: { id: `base_${AERO}` } }, quote_token: { data: { id: `base_${WETH}` } } } } }, httpStatus: 200 }
  }
  return { calls, fetchCoingecko, fetchJson }
}
const hoursBefore = (endSec: number, n: number, stepH = 1) => Array.from({ length: n }, (_, i) => endSec - (i + 1) * stepH * 3600)
const CREATED_LONG_AGO = new Date(NOW - 400 * DAY).toISOString()

test('300 rows (short page) with the oldest well after pool creation => hasMore stays true, cursor = oldest candle', async () => {
  resetOnDemandCandleState()
  const f = listProvider(hoursBefore(cutoffSec, 300), { created: CREATED_LONG_AGO })
  const r = await loadPoolOhlcvHistory({ chain: 'base', token: AERO, pool: POOL, before: cutoffSec }, f.fetchJson, { now: () => NOW, fetchCoingecko: f.fetchCoingecko })
  assert.ok(r.result.ok)
  if (!r.result.ok) return
  assert.deepEqual([r.result.points.length, r.result.hasMore, r.result.endReason], [300, true, null])
  assert.equal(r.result.nextBeforeSec, cutoffSec - 300 * 3600)
})

test('sparse pool: 20 rows spread over weeks => hasMore stays true', async () => {
  resetOnDemandCandleState()
  rememberVerifiedChartPool('base', AERO, POOL, 'base', NOW)
  const f = listProvider(hoursBefore(cutoffSec, 20, 30))
  const r = await loadPoolOhlcvHistory({ chain: 'base', token: AERO, pool: POOL, before: cutoffSec }, f.fetchJson, { now: () => NOW, fetchCoingecko: f.fetchCoingecko })
  assert.ok(r.result.ok && r.result.hasMore && r.result.points.length === 20)
})

test('zero older candles => hasMore false (no_older_candles) — a CoinGecko zero is cross-checked with GeckoTerminal first', async () => {
  resetOnDemandCandleState()
  rememberVerifiedChartPool('base', AERO, POOL, 'base', NOW)
  const f = listProvider([])
  const r = await loadPoolOhlcvHistory({ chain: 'base', token: AERO, pool: POOL, before: cutoffSec }, f.fetchJson, { now: () => NOW, fetchCoingecko: f.fetchCoingecko })
  assert.deepEqual(f.calls, [`CG before=${cutoffSec}`, `GT ohlcv before=${cutoffSec}`])
  assert.ok(r.result.ok && !r.result.hasMore && r.result.endReason === 'no_older_candles' && r.result.nextBeforeSec === null)
  // CoinGecko has nothing that old but GeckoTerminal does: its rows are used, and history continues.
  resetOnDemandCandleState()
  rememberVerifiedChartPool('base', AERO, POOL, 'base', NOW)
  const g = listProvider([], { gtRows: hoursBefore(cutoffSec, 40) })
  const r2 = await loadPoolOhlcvHistory({ chain: 'base', token: AERO, pool: POOL, before: cutoffSec }, g.fetchJson, { now: () => NOW, fetchCoingecko: g.fetchCoingecko })
  assert.ok(r2.result.ok && r2.result.source === 'geckoterminal' && r2.result.hasMore && r2.result.points.length === 40)
})

test('oldest candle in the pool\'s creation hour => hasMore false (reached_pool_creation)', async () => {
  resetOnDemandCandleState()
  const createdSec = cutoffSec - 50 * 3600 + 1234
  const f = listProvider(hoursBefore(cutoffSec, 50), { created: new Date(createdSec * 1000).toISOString() })
  const r = await loadPoolOhlcvHistory({ chain: 'base', token: AERO, pool: POOL, before: cutoffSec }, f.fetchJson, { now: () => NOW, fetchCoingecko: f.fetchCoingecko })
  assert.ok(r.result.ok && !r.result.hasMore && r.result.endReason === 'reached_pool_creation' && r.result.points.length === 50)
})

test('provider ignores the cursor (rows, but none before it) => stopped with history_cursor_not_advancing, no repeat request', async () => {
  resetOnDemandCandleState()
  rememberVerifiedChartPool('base', AERO, POOL, 'base', NOW)
  const f = listProvider([])
  f.fetchCoingecko = async (_c, _p, _r, _s, beforeSec) => { f.calls.push(`CG before=${beforeSec}`); return { json: { data: { attributes: { ohlcv_list: [[beforeSec, 1, 1, 1, 1, 1], [beforeSec! + 3600, 1, 1, 1, 1, 1]] } } }, httpStatus: 200 } }
  const r = await loadPoolOhlcvHistory({ chain: 'base', token: AERO, pool: POOL, before: cutoffSec }, f.fetchJson, { now: () => NOW, fetchCoingecko: f.fetchCoingecko })
  assert.ok(r.result.ok && !r.result.hasMore && r.result.endReason === 'history_cursor_not_advancing' && r.result.points.length === 0)
  assert.equal(f.calls.length, 1)
})

test('client batch: a server that claims more without moving the cursor back is stopped — never the same window twice', async () => {
  const cursors: number[] = []
  const stuck = async (before: number): Promise<HistoryWindowResult> => { cursors.push(before); return { ok: true, points: [], hasMore: true, nextBeforeSec: before } }
  const out = await loadHistoryBatch({ start: { candles: [], nextBeforeSec: null, hasMore: true }, cutoffMs: cutoffSec * 1000, newestMs: NOW, maxRequests: 3, targetSpanSec: null, load: stuck })
  assert.deepEqual([cursors, out.hasMore, out.endReason, out.requests], [[cutoffSec], false, 'history_cursor_not_advancing', 1])
  const forward = async (before: number): Promise<HistoryWindowResult> => ({ ok: true, points: [], hasMore: true, nextBeforeSec: before + 3600 })
  const out2 = await loadHistoryBatch({ start: { candles: [], nextBeforeSec: null, hasMore: true }, cutoffMs: cutoffSec * 1000, newestMs: NOW, maxRequests: 3, targetSpanSec: null, load: forward })
  assert.deepEqual([out2.requests, out2.hasMore, out2.endReason], [1, false, 'history_cursor_not_advancing'])
  // Normal paging: strictly decreasing, distinct cursors; the server's end evidence is surfaced.
  const seen: number[] = []
  const pages = async (before: number): Promise<HistoryWindowResult> => { seen.push(before); return seen.length < 3 ? { ok: true, points: [], hasMore: true, nextBeforeSec: before - 86_400 } : { ok: true, points: [], hasMore: false, nextBeforeSec: null, endReason: 'no_older_candles' } }
  const out3 = await loadHistoryBatch({ start: { candles: [], nextBeforeSec: null, hasMore: true }, cutoffMs: cutoffSec * 1000, newestMs: NOW, maxRequests: 3, targetSpanSec: null, load: pages })
  assert.deepEqual(seen, [cutoffSec, cutoffSec - 86_400, cutoffSec - 2 * 86_400])
  assert.deepEqual([out3.hasMore, out3.endReason], [false, 'no_older_candles'])
})

test('cache: the same window is served with 0 calls; concurrent identical requests share one read; V4 ids and bad input make 0 calls', async () => {
  resetOnDemandCandleState()
  rememberVerifiedChartPool('base', AERO, POOL, 'base', NOW)
  const f = fakes()
  const opts = { now: () => NOW, fetchCoingecko: f.fetchCoingecko }
  const [a, b] = await Promise.all([
    loadPoolOhlcvHistory({ chain: 'base', token: AERO, pool: POOL, before: cutoffSec }, f.fetchJson, opts),
    loadPoolOhlcvHistory({ chain: 'base', token: AERO, pool: POOL, before: cutoffSec + 1200 }, f.fetchJson, opts),
  ])
  assert.deepEqual(a.result, b.result)
  const again = await loadPoolOhlcvHistory({ chain: 'base', token: AERO, pool: POOL, before: cutoffSec }, f.fetchJson, opts)
  assert.deepEqual([again.providerCalls, again.cacheHit, f.calls.length], [0, true, 1])
  for (const bad of [
    { chain: 'base', token: AERO, pool: '0x' + 'ab'.repeat(32), before: cutoffSec },
    { chain: 'solana', token: AERO, pool: POOL, before: cutoffSec },
    { chain: 'base', token: AERO, pool: POOL, before: Math.floor(NOW / 1000) + 86_400 },
    { chain: 'base', token: AERO, pool: POOL, side: 'both', before: cutoffSec },
  ]) {
    const n = f.calls.length
    const r = await loadPoolOhlcvHistory(bad, f.fetchJson, opts)
    assert.equal(r.result.ok, false, JSON.stringify(bad))
    assert.equal(f.calls.length, n)
  }
})

// ── AERO: ~8 daily candles from the scan, then the user selects 1D ───────────────────────────────
test('AERO: 7 days of 15M give 8 x 1D; selecting 1D loads substantially more — exact UTC daily OHLCV, no duplicate boundary, MCAP once', async () => {
  resetOnDemandCandleState()
  const scanRows = aggregateCandles(TRUTH, 900).slice(-POOL_HISTORY_REQUEST.limit + 328).slice(-672)
  const scan = normalizeChartCandles(scanRows.map((c) => ({ timestamp: c.t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })))
  const before1D = buildChartTimeframes(scan, 900).timeframes.find((t) => t.key === '1D')!
  assert.equal(before1D.candles.length, 8, 'the live footer: 8 x 1D real candles · rolled up from 15M')

  rememberVerifiedChartPool('base', AERO, POOL, 'base', NOW)
  const f = fakes()
  let serverCalls = 0
  const load = async (beforeSec: number): Promise<HistoryWindowResult> => {
    const { result, providerCalls } = await loadPoolOhlcvHistory({ chain: 'base', token: AERO, pool: POOL, side: 'base', before: beforeSec }, f.fetchJson, { now: () => NOW, fetchCoingecko: f.fetchCoingecko })
    serverCalls += providerCalls
    return result.ok ? { ok: true, points: result.points, hasMore: result.hasMore, nextBeforeSec: result.nextBeforeSec } : { ok: false, message: result.message, hasMore: result.hasMore }
  }
  const cutoff = historyCutoffMs(scan)!
  const out = await loadHistoryBatch({ start: { candles: [], nextBeforeSec: null, hasMore: true }, cutoffMs: cutoff, newestMs: scan[scan.length - 1].t, maxRequests: HISTORY_MAX_REQUESTS_PER_ACTION, targetSpanSec: HISTORY_TARGET_SPAN_SEC['1D'], load })
  assert.equal(out.requests, 2, '60-day 1D target reached with two 1000-hour windows')
  assert.equal(serverCalls, 2, 'one provider call per window (side remembered from the scan)')
  const d1 = withHistory(buildChartTimeframes(scan, 900), out.candles, cutoff).timeframes.find((t) => t.key === '1D')!
  assert.ok(d1.candles.length >= 75, `${d1.candles.length} daily candles (was 8)`)

  const oldest = out.candles[0].t
  const expected = aggregateCandles(TRUTH.filter((c) => c.t >= oldest), 86_400)
  assert.deepEqual(d1.candles.map((c) => c.t), expected.map((c) => c.t), 'UTC days, no invented or missing day, no duplicate')
  d1.candles.forEach((c, i) => {
    for (const k of ['open', 'high', 'low', 'close'] as const) assert.ok(Math.abs(c[k] - expected[i][k]) / expected[i][k] < 1e-12, `${new Date(c.t).toISOString()} ${k}`)
    assert.equal(c.volume, expected[i].volume, `${new Date(c.t).toISOString()} volume counted once`)
  })
  assert.ok(!d1.candles.some((c) => c.t === Date.UTC(2026, 6, 15)), 'the no-trade day stays absent')
  assert.ok(d1.candles.every((c) => c.t % DAY === 0))
  const prev = process.env.TZ
  process.env.TZ = 'America/New_York'
  try { assert.match(formatChartTime(d1.candles[d1.candles.length - 1].t, 86_400, 'axis'), /Sep\s29$/) } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev }

  const supply = 1_000_000_000
  const mcap = scaleCandlesToMarketCap(d1.candles, supply)
  mcap.forEach((c, i) => assert.ok(Math.abs(c.close - d1.candles[i].close * supply) / c.close < 1e-12, 'scaled exactly once'))
  const snapshot = JSON.parse(JSON.stringify(d1.candles))
  scaleCandlesToMarketCap(d1.candles, supply)
  assert.deepEqual(d1.candles, snapshot, 'PRICE mode still renders the untouched originals')
})

// ── Wiring: no scan calls, explicit-interaction only, V4 path untouched ─────────────────────────
test('wiring: scan never requests history; endpoint routes 20-byte pools to pool OHLCV history and bytes32 to V4; page passes the proven side', () => {
  const route = read('app/api/token/route.ts')
  assert.doesNotMatch(route, /loadPoolOhlcvHistory|timeframe=history|before_timestamp/, 'zero additional calls in a normal scan')
  const ep = read('app/api/token/chart-candles/route.ts')
  const hist = ep.slice(ep.indexOf("timeframe') === 'history'"))
  assert.ok(hist.indexOf('/^0x[a-fA-F0-9]{40}$/.test(pool)') < hist.indexOf('loadV4SwapHistoryWindow'), 'normal pools are handled before the V4 branch')
  assert.match(hist, /loadPoolOhlcvHistory\(\s*\{ chain, token, pool, side: url\.searchParams\.get\('side'\)/)
  assert.match(hist, /const h = await loadV4SwapHistoryWindow\(\{ chain, poolId: pool, token, beforeSec: before \}, deps\)/, 'V4 history unchanged')
  assert.ok(ep.indexOf('requireAuthenticatedUser(req)') < ep.indexOf("timeframe') === 'history'"), 'authenticated + rate limited first')
  const page = read('app/terminal/token-scanner/page.tsx')
  assert.match(page, /const normalPool = source === 'pool_ohlcv' && \/\^0x\[a-fA-F0-9\]\{40\}\$\/\.test\(pool\) && \(tokenSide === 'base' \|\| tokenSide === 'quote'\)/)
  assert.match(page, /makeHistoryLoader\(result\.chain, result\.contract, result\.chartCandles\?\.poolAddress, result\.chartSource, result\.chartCandles\?\.tokenSide \?\? null\)/)
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  // Triggers: a timeframe pick, reaching the left edge, and ONE bounded automatic batch per scan when the
  // default view needs history to read as a chart (lib/chartQuality.ts planAutoHistory).
  assert.equal((panel.match(/void requestHistory\(/g) ?? []).length, 3, 'pick, left edge, readable-default auto batch')
  assert.match(panel, /if \(autoRan\.current === candles \|\| !autoPlan\.load \|\| !autoPlan\.key \|\| picked != null\) return\n\s*autoRan\.current = candles/, 'the automatic batch runs at most once per scan')
  assert.doesNotMatch(read('lib/server/chartCandlesOnDemand.ts'), /COINGECKO_API_KEY/)
})

test('endReason is carried in the endpoint response, the page loader and the panel history state', () => {
  const ep = read('app/api/token/chart-candles/route.ts')
  assert.match(ep, /nextBeforeSec: h\.nextBeforeSec, endReason: h\.endReason,/)
  assert.match(read('app/terminal/token-scanner/page.tsx'), /endReason: typeof json\.endReason === 'string' \? json\.endReason : null/)
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /message: out\.failedMessage, endReason: out\.endReason \}/)
  assert.match(panel, /data-history-end=\{hist\.endReason \?\? undefined\}/)
})
