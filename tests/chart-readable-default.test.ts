// Token Scanner chart opens as a readable "actual chart": default timeframe = finest READABLE one
// (5M -> 15M -> 1H -> 4H -> 1D), one bounded automatic history batch when the default still needs older
// genuine candles, sparse timeframes stay reachable but render as a line/area of REAL closes, and
// nothing is ever fabricated. Same pure policy for Base / Ethereum / BNB / Robinhood / Solana.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildChartTimeframes, type ChartCandle } from '../lib/priceChartCandles.ts'
import {
  AUTO_HISTORY_MAX_REQUESTS,
  READABLE_MIN_CANDLES,
  assessTimeframeSet,
  buildCoverageMeta,
  lineChartXs,
  planAutoHistory,
  resolveCoverageWindow,
  selectPresentationTimeframe,
  type ChartCoverageMeta,
} from '../lib/chartQuality.ts'
import { HISTORY_TARGET_SPAN_SEC, loadHistoryBatch, withHistory, historyCutoffMs } from '../lib/chartHistory.ts'
import { scaleCandlesToMarketCap } from '../lib/chartMarketCap.ts'
import { EVM_CHART_NETWORK, runEvmCandleLadder, type LadderDeps, type LadderFetchResult, type LadderPool } from '../lib/evmChartCandles.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const M5 = 300_000
const M15 = 900_000
const H1 = 3_600_000
const D1 = 86_400_000
const NOW = Date.UTC(2026, 8, 30, 12)
const OLD_POOL = Math.floor((NOW - 200 * D1) / 1000)
const c = (t: number, p = 1): ChartCandle => ({ t, open: p, high: p * 1.02, low: p * 0.98, close: p * 1.01, volume: 3 })
const series = (ts: number[]) => ts.map((t, i) => c(t, 1 + i * 0.002))
const pts = (ts: number[]) => ts.map((t) => ({ timestamp: new Date(t).toISOString() }))
const meta = (ts: number[], intervalSec: number, limit: number, poolCreatedSec: number | null = OLD_POOL): ChartCoverageMeta =>
  buildCoverageMeta({ requestEndSec: NOW / 1000, intervalSec, limit, points: pts(ts), poolCreatedSec })
function choose(ts: number[], intervalSec: number, m: ChartCoverageMeta | null, extra: { fiveMinuteExactTime?: boolean; referenceMs?: number } = {}) {
  const set = buildChartTimeframes(series(ts), intervalSec)
  const w = resolveCoverageWindow(m)
  const q = assessTimeframeSet(set, { coverageFor: () => w, poolCreatedMs: m?.poolCreatedSec != null ? m.poolCreatedSec * 1000 : null, ...extra })
  return { set, q, sel: selectPresentationTimeframe(q) }
}

test('sparse 5M burst (6 candles in a loaded day) never opens as the 5M candle chart', () => {
  const ts = Array.from({ length: 6 }, (_, i) => NOW - 40 * 60_000 + i * M5)
  const { q, sel, set } = choose(ts, 300, meta(ts, 300, 288))
  assert.equal(q['5M']!.quality, 'sparse')
  // Nothing in a single burst is readable at any timeframe: the default is the least-bad one, drawn as the
  // readable fallback view (line/area of real closes — never the floating-candle chart) ...
  assert.equal(sel.quality, 'sparse')
  assert.match(read('app/terminal/token-scanner/PriceChartPanel.tsx'), /const lineMode = activeQuality != null && !isPresentationUsable\(activeQuality\.quality\)/)
  // ... and, where the source has older history, one bounded daily batch is loaded to build a real chart.
  assert.deepEqual(planAutoHistory({ defaultKey: sel.key, defaultQuality: q[sel.key!]!, historyEnabled: true, hasMore: true }), { load: true, key: '1D', reason: 'no_readable_timeframe_load_daily_history' })
  assert.equal(set.timeframes.find((t) => t.key === '5M')!.candles.length, 6, 'raw 5M candles stay available')
})

test('sparse 5M burst inside a day that has older genuine trading: the default moves off 5M', () => {
  const older = Array.from({ length: 20 }, (_, i) => NOW - 20 * H1 + i * H1)
  const burst = Array.from({ length: 6 }, (_, i) => NOW - 40 * 60_000 + i * M5)
  const ts = [...older.filter((t) => t < burst[0]), ...burst]
  const { q, sel } = choose(ts, 300, meta(ts, 300, 288))
  assert.equal(q['5M']!.quality, 'sparse')
  assert.notEqual(sel.key, '5M')
  assert.ok(sel.quality === 'good' || sel.quality === 'usable', String(sel.quality))
})

test('sparse 15M across many days opens on a readable coarser timeframe (or loads history for it)', () => {
  const ts = Array.from({ length: 7 }, (_, i) => NOW - 13 * D1 + i * 2 * D1)
  const { q, sel } = choose(ts, 900, meta(ts, 900, 672))
  assert.equal(q['15M']!.quality, 'sparse')
  assert.notEqual(sel.key, '15M')
  const plan = planAutoHistory({ defaultKey: sel.key, defaultQuality: sel.key ? q[sel.key]! : null, historyEnabled: true, hasMore: true })
  assert.equal(plan.load, true, 'a thin daily default loads its history so it reads as a chart')
  assert.equal(plan.key, sel.key === '1H' || sel.key === '4H' || sel.key === '1D' ? sel.key : '1D')
})

test('young pool with dense short history opens on its fine timeframe, no history needed', () => {
  const created = NOW / 1000 - 3 * 3600
  const ts = Array.from({ length: 36 }, (_, i) => NOW - 3 * H1 + (i + 1) * M5)
  const { q, sel } = choose(ts, 300, meta(ts, 300, 288, created))
  assert.equal(q['5M']!.quality, 'good')
  assert.equal(sel.key, '5M')
  assert.equal(planAutoHistory({ defaultKey: sel.key, defaultQuality: q['5M']!, historyEnabled: true, hasMore: true }).load, false)
})

test('stale dense history is demoted and the default moves coarser', () => {
  const ts = Array.from({ length: 96 }, (_, i) => NOW - 6 * D1 + i * M15)
  const { q, sel } = choose(ts, 900, null, { referenceMs: NOW })
  assert.equal(q['15M']!.quality, 'sparse')
  assert.ok(['1H', '4H', '1D'].includes(String(sel.key)), String(sel.key))
})

test('V4 inferred timestamps: 5M never the default; exact timestamps: 5M allowed', () => {
  const ts = Array.from({ length: 288 }, (_, i) => NOW - D1 + (i + 1) * M5)
  const m = buildCoverageMeta({ requestEndSec: NOW / 1000, intervalSec: 300, limit: null, points: pts(ts), windowSec: 86_400, windowProven: true })
  assert.equal(choose(ts, 300, m).sel.key, '5M')
  assert.equal(choose(ts, 300, m, { fiveMinuteExactTime: false }).sel.key, '15M')
})

test('alternate-pool fallback prefers the evidence-valid pool whose genuine candles read better (no extra calls)', async () => {
  const TOKEN = '0xabcdef0123456789abcdef0123456789abcdef01'
  const WETH = '0x4200000000000000000000000000000000000006'
  const [P1, P2, P3] = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333']
  const net = EVM_CHART_NETWORK.base
  const pool = (a: string): LadderPool => ({ poolId: `${net}_${a}`, address: a, name: 'T/W', liquidityUsd: 1, pool: { id: `${net}_${a}`, relationships: { base_token: { data: { id: `${net}_${TOKEN}` } }, quote_token: { data: { id: `${net}_${WETH}` } } } } })
  const ok = (secs: number[]): LadderFetchResult => ({ httpStatus: 200, json: { data: { attributes: { ohlcv_list: secs.map((t) => [t, 1, 1.1, 0.9, 1.05, 5]) } } } })
  const nowSec = NOW / 1000
  const calls: string[] = []
  const deps: LadderDeps = {
    fetchPoolOhlcv: async (a) => { calls.push(a); return a === P2 ? ok([0, 5, 9].map((d) => nowSec - d * 86_400)) : a === P3 ? ok(Array.from({ length: 200 }, (_, i) => nowSec - i * 900)) : ok([]) },
    fetchTrades: async () => ({ httpStatus: 200, json: { data: [] } }),
  }
  const r = await runEvmCandleLadder({ pools: [pool(P1), pool(P2), pool(P3)], contract: TOKEN, networkId: net, currentPriceUsd: 1, nowSec }, deps)
  assert.equal(r.selectedPool?.address, P3)
  assert.equal(calls.filter((a) => a !== P1).length, 2, 'the same two alternate calls the ladder always allowed')
})

test('Solana: the same policy on its 672 x 15m request window', () => {
  const ts = Array.from({ length: 5 }, (_, i) => NOW - 9 * D1 + i * 2 * D1)
  const m = buildCoverageMeta({ requestEndSec: NOW / 1000, intervalSec: 900, limit: 672, points: pts(ts) })
  const { q, sel } = choose(ts, 900, m)
  assert.equal(q['15M']!.quality, 'sparse')
  assert.notEqual(sel.key, '15M')
  const page = read('app/terminal/token-scanner/page.tsx')
  assert.match(page, /coverage=\{sr\.ohlcv\.coverage \?\? null\}/)
  assert.match(read('lib/server/solanaProviders.ts'), /limit: SOLANA_OHLCV_LIMIT, points: candles \}\)/)
})

test('cross-chain consistency: one chain-neutral policy and one panel for Base / Ethereum / BNB / Robinhood / Solana', () => {
  const page = read('app/terminal/token-scanner/page.tsx')
  assert.equal((page.match(/<PriceChartPanel\b/g) ?? []).length, 2, 'EVM (all four chains) and Solana share PriceChartPanel')
  assert.match(page, /coverage=\{result\.chartCandles\?\.coverage \?\? null\}/)
  assert.doesNotMatch(read('lib/chartQuality.ts'), /solana|robinhood|'base'|'bnb'|'eth'/i)
  for (const chain of ['eth', 'base', 'bnb', 'robinhood'] as const) assert.ok(EVM_CHART_NETWORK[chain], chain)
})

test('auto history: bounded (<= 2 requests, once), only when the default needs it; re-chosen once over the snapshot', async () => {
  // Default already readable -> no request.
  assert.equal(planAutoHistory({ defaultKey: '15M', defaultQuality: { quality: 'good', candleCount: 80 } as never, historyEnabled: true, hasMore: true }).load, false)
  // No loader / nothing more -> no request.
  assert.equal(planAutoHistory({ defaultKey: '1D', defaultQuality: { quality: 'sparse', candleCount: 3 } as never, historyEnabled: false, hasMore: true }).load, false)
  assert.equal(planAutoHistory({ defaultKey: '1D', defaultQuality: { quality: 'sparse', candleCount: 3 } as never, historyEnabled: true, hasMore: false }).load, false)
  // Readable but short 1H default -> load 1H's span.
  const p = planAutoHistory({ defaultKey: '1H', defaultQuality: { quality: 'usable', candleCount: 12 } as never, historyEnabled: true, hasMore: true })
  assert.deepEqual([p.load, p.key], [true, '1H'])
  assert.deepEqual([AUTO_HISTORY_MAX_REQUESTS, READABLE_MIN_CANDLES], [2, 30])
  // The batch itself: never more than AUTO_HISTORY_MAX_REQUESTS loads, genuine rows only.
  const scan = series(Array.from({ length: 24 }, (_, i) => NOW - 24 * H1 + (i + 1) * H1))
  const cutoff = historyCutoffMs(scan)!
  let loads = 0
  const out = await loadHistoryBatch({
    start: { candles: [], nextBeforeSec: null, hasMore: true }, cutoffMs: cutoff, newestMs: NOW, maxRequests: AUTO_HISTORY_MAX_REQUESTS, targetSpanSec: HISTORY_TARGET_SPAN_SEC['1D'],
    load: async (before) => { loads++; return { ok: true, points: Array.from({ length: 200 }, (_, i) => ({ timestamp: (before - (i + 1) * 3600), open: 1, high: 1.1, low: 0.9, close: 1, volume: 1 })), hasMore: true, nextBeforeSec: before - 200 * 3600 } },
  })
  assert.equal(loads, AUTO_HISTORY_MAX_REQUESTS)
  assert.equal(out.candles.length, 400)
  const merged = withHistory(buildChartTimeframes(scan, 3600), out.candles, cutoff)
  const q = assessTimeframeSet(merged)
  assert.equal(selectPresentationTimeframe(q).key, '1H', 'with its history the hourly view reads as a chart')
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /void requestHistory\(AUTO_HISTORY_MAX_REQUESTS, HISTORY_TARGET_SPAN_SEC\[autoPlan\.key\], true\)/)
  assert.match(panel, /picked != null\) return/, 'never overrides a timeframe the user chose')
})

test('sparse timeframe the user selects renders as a line/area of REAL closes (no smoothing, a dot per genuine candle)', () => {
  const times = [NOW - 10 * H1, NOW - 9 * H1, NOW - 2 * H1, NOW]
  const xs = lineChartXs(times, 424)
  assert.deepEqual(xs.map((x) => Math.round(x)), [12, 52, 332, 412], 'x proportional to real time; gaps preserved')
  assert.deepEqual(lineChartXs([NOW], 400), [200])
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /const lineMode = activeQuality != null && !isPresentationUsable\(activeQuality\.quality\) && data\.length >= 2/)
  assert.match(panel, /<polyline points=\{pts\.join\(' '\)\}/)
  assert.match(panel, /data\.map\(\(c, i\) => <circle key=\{`p\$\{c\.t\}`\} cx=\{xC\(i\)\} cy=\{yP\(c\.close\)\}/)
  assert.match(panel, /\{!lineMode && <g>/, 'candles are not drawn in the sparse line view')
  assert.doesNotMatch(panel, /\bcurveBasis|bezier|Q\$\{|C\$\{/i, 'no smoothing')
})

test('PRICE/MCAP toggle unchanged: same candles scaled, same quality and timeframe choice', () => {
  const ts = Array.from({ length: 7 }, (_, i) => NOW - 13 * D1 + i * 2 * D1)
  const cs = series(ts)
  const mc = scaleCandlesToMarketCap(cs, 1e9)
  const a = assessTimeframeSet(buildChartTimeframes(cs, 900))
  const b = assessTimeframeSet(buildChartTimeframes(mc, 900))
  for (const k of Object.keys(a) as Array<keyof typeof a>) assert.equal(a[k]!.quality, b[k]!.quality)
  assert.equal(selectPresentationTimeframe(a).key, selectPresentationTimeframe(b).key)
  assert.match(read('app/terminal/token-scanner/PriceChartPanel.tsx'), /const series: ChartCandle\[\] = valueMode === 'MCAP' \? scaleCandlesToMarketCap\(priceSeries, marketCapSupply!\)/)
})
