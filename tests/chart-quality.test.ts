// Token Scanner chart PRESENTATION quality (lib/chartQuality.ts) and its use in PriceChartPanel and the
// EVM ladder's alternate-pool choice. Live bug: a Base token opened on 15M with 7 genuine 15-minute
// candles spread over 13 days, because "available" (>= 2 genuine buckets) was treated as "presentable".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildChartTimeframes, normalizeChartCandles, pickDefaultTimeframe, type ChartCandle } from '../lib/priceChartCandles.ts'
import {
  assessTimeframeQuality,
  assessTimeframeSet,
  chartXLayout,
  restingCandleTarget,
  selectPresentationTimeframe,
  sparseTimeframeTooltip,
} from '../lib/chartQuality.ts'
import { withHistory } from '../lib/chartHistory.ts'
import { scaleCandlesToMarketCap } from '../lib/chartMarketCap.ts'
import { EVM_CHART_NETWORK, runEvmCandleLadder, type EvmChartRung, type LadderDeps, type LadderFetchResult, type LadderPool } from '../lib/evmChartCandles.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const M15 = 900_000
const H1 = 3_600_000
const D1 = 86_400_000
const T0 = Date.UTC(2026, 8, 1)
const candle = (t: number, p = 1): ChartCandle => ({ t, open: p, high: p * 1.02, low: p * 0.98, close: p * 1.01, volume: 10 })
const series = (times: number[]) => times.map((t, i) => candle(t, 1 + i * 0.001))
const setOf = (cs: ChartCandle[], sec = 900) => buildChartTimeframes(cs, sec)
const select = (cs: ChartCandle[], sec = 900) => selectPresentationTimeframe(assessTimeframeSet(setOf(cs, sec)))

// The live shape: 7 genuine 15M candles across 13 days (one trade bucket every other day).
const LIVE = series(Array.from({ length: 7 }, (_, i) => T0 + i * 2 * D1 + 10 * M15))

test('1/14-rule. LIVE: 7 x 15M across 13 days is sparse, never the default; a coarser usable timeframe is chosen', () => {
  const set = setOf(LIVE)
  const q = assessTimeframeSet(set)
  assert.equal(q['15M']!.quality, 'sparse')
  assert.equal(q['15M']!.candleCount, 7)
  assert.equal(q['15M']!.expectedBuckets, 1153)
  assert.equal(pickDefaultTimeframe(set), '15M', 'data-availability pick alone WOULD have chosen 15M (the bug)')
  const sel = selectPresentationTimeframe(q)
  assert.notEqual(sel.key, '15M')
  assert.deepEqual([sel.key, sel.reason, sel.fallbackFrom, sel.quality], ['1D', '15m_sparse_fallback_to_1d', '15M', 'usable'])
  assert.deepEqual([q['1H']!.quality, q['4H']!.quality], ['sparse', 'sparse'])
  // The exact 7 genuine 15M buckets stay reachable; nothing was generated anywhere.
  const tf15 = set.timeframes.find((t) => t.key === '15M')!
  assert.deepEqual(tf15.candles.map((c) => c.t), LIVE.map((c) => c.t))
  for (const tf of set.timeframes) assert.ok(tf.candles.length <= 7, `${tf.key} has no extra candles`)
  assert.equal(sparseTimeframeTooltip(q['15M']!, '1D'), 'Only 7 genuine 15-minute candles are available across 12d. Use 1D for a clearer view.')
})

test('2. 60 continuous 15M candles -> good, 15M stays the default', () => {
  const cs = series(Array.from({ length: 60 }, (_, i) => T0 + i * M15))
  const q = assessTimeframeQuality(cs, 900, { timeframe: '15M' })
  assert.deepEqual([q.quality, q.density, q.recentCoverage, q.largestGapBuckets], ['good', 1, 1, 1])
  assert.deepEqual([select(cs).key, select(cs).reason], ['15M', 'default_15m_good'])
})

test('3. young pool: 3 x 15M over 45 minutes is judged against its own age -> good', () => {
  const cs = series([T0, T0 + M15, T0 + 2 * M15])
  const q = assessTimeframeQuality(cs, 900, { timeframe: '15M' })
  assert.deepEqual([q.quality, q.expectedBuckets, q.windowBuckets], ['good', 3, 3])
  assert.equal(select(cs).key, '15M')
})

test('4. 15M sparse, 1H good -> 1H', () => {
  const cs = series(Array.from({ length: 36 }, (_, i) => T0 + i * 2 * H1))
  const q = assessTimeframeSet(setOf(cs))
  assert.deepEqual([q['15M']!.quality, q['1H']!.quality], ['sparse', 'good'])
  assert.deepEqual([select(cs).key, select(cs).reason], ['1H', '15m_sparse_fallback_to_1h'])
})

test('5. 15M + 1H sparse, 4H good -> 4H', () => {
  const cs = series(Array.from({ length: 90 }, (_, i) => T0 + i * 8 * H1))
  const q = assessTimeframeSet(setOf(cs))
  assert.deepEqual([q['15M']!.quality, q['1H']!.quality, q['4H']!.quality], ['sparse', 'sparse', 'good'])
  assert.equal(select(cs).key, '4H')
})

test('6. all intraday sparse, 1D good -> 1D', () => {
  const cs = series(Array.from({ length: 30 }, (_, i) => T0 + i * 2 * D1))
  const q = assessTimeframeSet(setOf(cs))
  assert.deepEqual([q['15M']!.quality, q['1H']!.quality, q['4H']!.quality, q['1D']!.quality], ['sparse', 'sparse', 'sparse', 'good'])
  assert.equal(select(cs).key, '1D')
})

test('7. everything sparse -> honest sparse state on the least-bad timeframe (coarsest on ties)', () => {
  const cs = series([T0, T0 + 15 * D1, T0 + 29 * D1])
  const sel = select(cs)
  assert.deepEqual([sel.key, sel.quality, sel.reason], ['1D', 'sparse', 'all_timeframes_sparse_best_1d'])
})

test('8. no fake gaps: every aggregated bucket holds >= 1 genuine source candle; counts never grow', () => {
  const cs = series([T0, T0 + 5 * M15, T0 + 3 * H1, T0 + 2 * D1, T0 + 2 * D1 + M15])
  const set = setOf(cs)
  for (const tf of set.timeframes.filter((t) => t.available)) {
    assert.ok(tf.candles.length <= cs.length)
    for (const c of tf.candles) assert.ok(cs.some((s) => s.t >= c.t && s.t < c.t + tf.sec * 1000), `${tf.key} bucket ${c.t} has a genuine source candle`)
  }
})

test('9/10. giant single gap and recent activity after old inactivity are judged on the recent window', () => {
  const old = Array.from({ length: 30 }, (_, i) => T0 + i * M15)
  const gapStart = T0 + 10 * D1
  const recent30 = Array.from({ length: 30 }, (_, i) => gapStart + i * M15)
  const q9 = assessTimeframeQuality(series([...old, ...recent30]), 900, { timeframe: '15M' })
  assert.equal(q9.quality, 'usable')
  assert.ok(q9.largestGapBuckets > 900)
  const recent60 = Array.from({ length: 60 }, (_, i) => gapStart + i * M15)
  const q10 = assessTimeframeQuality(series([...old.slice(0, 5), ...recent60]), 900, { timeframe: '15M' })
  assert.equal(q10.quality, 'good')
})

test('13. MCAP is the same series scaled: identical quality, timeframe and timestamps', () => {
  const q = assessTimeframeQuality(LIVE, 900, { timeframe: '15M' })
  const mc = scaleCandlesToMarketCap(LIVE, 1_000_000)
  assert.deepEqual(mc.map((c) => c.t), LIVE.map((c) => c.t))
  assert.deepEqual(assessTimeframeQuality(mc, 900, { timeframe: '15M' }), q)
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /const scanQuality = useMemo\(\(\) => assessTimeframeSet\(scanSet, qualityOpts\), \[scanSet, qualityOpts\]\)/, 'quality is computed on PRICE timeframes, not the MCAP view')
  assert.doesNotMatch(panel, /assessTimeframe\w*\(series/, 'never assessed on the MCAP-scaled series')
})

test('14/15. history merge never flips the default mid-view: the default comes from the scan set only', () => {
  const cs = series(Array.from({ length: 36 }, (_, i) => T0 + 10 * D1 + i * 2 * H1))
  const scan = setOf(cs)
  const history = Array.from({ length: 200 }, (_, i) => candle(T0 + i * H1))
  const merged = withHistory(scan, history, Math.ceil(cs[0].t / H1) * H1)
  assert.equal(assessTimeframeSet(merged)['15M']!.quality, assessTimeframeSet(scan)['15M']!.quality, '15M is untouched by hourly history')
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  // The default is chosen from the scan set, re-chosen ONCE over the automatic history snapshot (never on later loads).
  assert.match(panel, /const autoSelection = useMemo\(\(\) => fullChartSelection\(selectPresentationTimeframe\(defaultQuality\), defaultQuality, autoHist != null && autoHist\.length > 0\), \[defaultQuality, autoHist\]\)/)
  assert.match(panel, /autoHist && autoHist\.length > 0 \? assessTimeframeSet\(withHistory\(scanSet, autoHist, cutoffMs\)/)
  assert.match(panel, /if \(auto\) setAutoSnap\(\{ source, candles: done\.candles \}\)/)
  assert.match(panel, /const defaultKey = useMemo\(\(\) => autoSelection\.key \?\? pickDefaultTimeframe\(scanSet\), \[autoSelection, scanSet\]\)/)
  assert.doesNotMatch(panel, /\bfetch\(/, 'quality decisions make no requests')
})

test('16-22. chain-neutral: one policy for every source (15m pool OHLCV, 5m V4 swap candles, Solana pools)', () => {
  // V4 swap candles are native 5M: exact timestamps -> 5M (finest usable); inferred -> never 5M.
  const v4 = series(Array.from({ length: 200 }, (_, i) => T0 + i * 300_000))
  assert.equal(select(v4, 300).key, '5M')
  assert.equal(selectPresentationTimeframe(assessTimeframeSet(setOf(v4, 300), { fiveMinuteExactTime: false })).key, '15M')
  // Solana and every EVM chain render through the same PriceChartPanel.
  const page = read('app/terminal/token-scanner/page.tsx')
  assert.equal((page.match(/<PriceChartPanel\b/g) ?? []).length, 2)
  assert.doesNotMatch(read('lib/chartQuality.ts'), /\bchain\b.*===|solana|robinhood|'base'|'bnb'|'eth'/i, 'no chain-specific thresholds')
})

test('23/24. viewport: resting view ~40 (phone) to ~100 (desktop); a short series keeps its real time gaps, centred, never stretched', () => {
  assert.equal(restingCandleTarget(320, true), 40)
  assert.equal(restingCandleTarget(560, false), 62)
  assert.equal(restingCandleTarget(1400, false), 100)
  // 6 x 5M: two adjacent, then a 10-bucket gap, then the rest — positions keep the gap, newest at the right edge.
  const times = [0, 1, 11, 12, 13, 14].map((k) => T0 + k * 300_000)
  const short = chartXLayout(times, 300, 6, 720)
  assert.equal(short.mode, 'time')
  assert.equal(short.slot, 720 / 15)
  assert.deepEqual(short.pos, [0, 1, 11, 12, 13, 14], 'spread over its own real span, not pinned right in a blank panel')
  assert.equal(short.pos[2] - short.pos[1], 10, 'the real 10-bucket gap is preserved')
  const full = chartXLayout(Array.from({ length: 90 }, (_, i) => T0 + i * M15), 900, 400, 900)
  assert.deepEqual([full.mode, full.slot, full.pos[5]], ['index', 10, 5])
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /const fit = restingCandleTarget\(plotW, compact\)/)
  // Candles use index bar-spacing (lib/chartGeometry.ts); chartXLayout remains the pure time-spacing helper.
  assert.match(panel, /const geo = candleGeometry\(data\.length, total, plotW\)/)
  assert.match(panel, /nearestCandleIndex\(x, layout\)/)
})

test('UI: sparse chips are dimmed with the explanation; status + ?debug=1 quality output', () => {
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /title: sparse \? sparseTimeframeTooltip\(q!, clearerThan\(tf\.key\)\)/)
  assert.match(panel, /selected for clearer history/)
  assert.match(panel, /Sparse trading — /)
  assert.match(panel, /selectedTimeframeReason: selectionReason,\s*latestClose: latestAudit,\s*sparseLine: sparseLine\?\.stats \?\? null,\s*timeframeQuality:/)
  assert.match(read('app/terminal/token-scanner/page.tsx'), /debug=\{Boolean\(result\.chartDebug\)\}/)
})

// ── 11/12. Alternate pools: quality decides only among evidence-valid candidates, within budget ──
const TOKEN = '0xabcdef0123456789abcdef0123456789abcdef01'
const WETH = '0x4200000000000000000000000000000000000006'
const P1 = '0x1111111111111111111111111111111111111111'
const P2 = '0x2222222222222222222222222222222222222222'
const P3 = '0x3333333333333333333333333333333333333333'
const END = Math.floor(Date.UTC(2026, 8, 26, 12) / 1000)
const ok = (times: number[]): LadderFetchResult => ({ httpStatus: 200, json: { data: { attributes: { ohlcv_list: times.map((t) => [t, 1, 1.1, 0.9, 1.05, 5]) } } } })
const empty: LadderFetchResult = { httpStatus: 200, json: { data: { attributes: { ohlcv_list: [] } } } }
const SPARSE = Array.from({ length: 7 }, (_, i) => END - i * 2 * 86_400)
const DENSE = Array.from({ length: 200 }, (_, i) => END - i * 900)
function pool(net: string, address: string, side: 'base' | 'none' = 'base'): LadderPool {
  const rel = side === 'none' ? {} : { base_token: { data: { id: `${net}_${TOKEN}` } }, quote_token: { data: { id: `${net}_${WETH}` } } }
  return { poolId: `${net}_${address}`, address, name: 'TKN / WETH', liquidityUsd: 1, pool: { id: `${net}_${address}`, relationships: rel } }
}
function deps(byPool: Record<string, LadderFetchResult>, calls: string[]): LadderDeps {
  return {
    fetchPoolOhlcv: async (address: string, rung: EvmChartRung) => { calls.push(`${address}:${rung.key}`); return byPool[address] ?? empty },
    fetchTrades: async () => ({ httpStatus: 200, json: { data: [] } }),
  }
}

for (const chain of ['base', 'eth', 'bnb', 'robinhood'] as const) {
  const net = EVM_CHART_NETWORK[chain]
  const run = (d: LadderDeps) => runEvmCandleLadder({ pools: [pool(net, P1), pool(net, P2), pool(net, P3)], contract: TOKEN, networkId: net, currentPriceUsd: 1, nowSec: END }, d)

  test(`${chain} 11/12. sparse first alternate + valid denser second alternate -> the denser one; <= the same 2 alternate calls`, async () => {
    const calls: string[] = []
    const r = await run(deps({ [P2]: ok(SPARSE), [P3]: ok(DENSE) }, calls))
    assert.equal(r.selectedPool?.address, P3)
    assert.equal(r.chartCandles?.points.length, 200)
    assert.equal(calls.filter((c) => c.startsWith(P2) || c.startsWith(P3)).length, 2)
    assert.deepEqual(r.alternateSelection?.candidates.map((c) => [c.pool, c.quality, c.timeframe]), [[P2, 'usable', '1D'], [P3, 'good', '15M']])
  })

  test(`${chain} 11. usable first alternate -> no extra call; worse second alternate never replaces a better first`, async () => {
    const calls: string[] = []
    const r = await run(deps({ [P2]: ok(DENSE), [P3]: ok(SPARSE) }, calls))
    assert.equal(r.selectedPool?.address, P2)
    assert.equal(calls.some((c) => c.startsWith(P3)), false, 'good first alternate => the second is never called')
    const calls2: string[] = []
    const r2 = await run(deps({ [P2]: ok(SPARSE), [P3]: ok(SPARSE.slice(0, 3)) }, calls2))
    assert.equal(r2.selectedPool?.address, P2, 'equal-or-worse quality keeps the first alternate')
  })

  test(`${chain} 12. a second alternate that fails evidence (no proven side) is never chosen for a prettier chart`, async () => {
    const calls: string[] = []
    const r = await runEvmCandleLadder({ pools: [pool(net, P1), pool(net, P2), pool(net, P3, 'none')], contract: TOKEN, networkId: net, currentPriceUsd: 1, nowSec: END }, deps({ [P2]: ok(SPARSE), [P3]: ok(DENSE) }, calls))
    assert.equal(r.selectedPool?.address, P2)
    assert.equal(calls.some((c) => c.startsWith(P3)), false)
  })

  test(`${chain}. primary pool success is never replaced by an alternate, even when sparse`, async () => {
    const calls: string[] = []
    const r = await run(deps({ [P1]: ok(SPARSE), [P2]: ok(DENSE) }, calls))
    assert.equal(r.selectedPool?.address, P1)
    assert.equal(calls.length, 1)
    assert.ok(calls[0].startsWith(P1))
  })
}

test('normalize: the live shape survives normalization unchanged (no fabricated rows)', () => {
  const rows = LIVE.map((c) => ({ timestamp: c.t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
  assert.equal(normalizeChartCandles(rows).length, 7)
})

// ── Final polish: natural finest -> coarsest order, 5M exactness, deterministic stale rule ──────────
import { PRESENTATION_PREFERENCE } from '../lib/chartQuality.ts'

test('order: natural finest -> coarsest 5M, 15M, 1H, 4H, 1D', () => {
  assert.deepEqual(PRESENTATION_PREFERENCE, ['5M', '15M', '1H', '4H', '1D'])
})

test('5M good + 15M good -> 5M selected', () => {
  const cs = series(Array.from({ length: 300 }, (_, i) => T0 + i * 300_000))
  const q = assessTimeframeSet(setOf(cs, 300))
  assert.deepEqual([q['5M']!.quality, q['15M']!.quality], ['good', 'good'])
  assert.deepEqual([select(cs, 300).key, select(cs, 300).reason], ['5M', 'default_5m_good'])
})

test('5M unavailable (15M native) + 15M good -> 15M selected', () => {
  const cs = series(Array.from({ length: 60 }, (_, i) => T0 + i * M15))
  const set = setOf(cs)
  assert.equal(set.timeframes.find((t) => t.key === '5M')!.available, false)
  assert.equal(assessTimeframeSet(set)['5M'], undefined, '5M does not participate when unavailable')
  assert.equal(select(cs).key, '15M')
})

test('inferred-timestamp V4 -> 5M excluded (sparse, inferred_timestamps), candles still reachable; exact V4 -> 5M', () => {
  const cs = series(Array.from({ length: 300 }, (_, i) => T0 + i * 300_000))
  const set = setOf(cs, 300)
  const inferred = assessTimeframeSet(set, { fiveMinuteExactTime: false })
  assert.deepEqual([inferred['5M']!.quality, inferred['5M']!.rejectionReason], ['sparse', 'inferred_timestamps'])
  assert.equal(selectPresentationTimeframe(inferred).key, '15M')
  assert.equal(set.timeframes.find((t) => t.key === '5M')!.candles.length, 300)
  assert.equal(selectPresentationTimeframe(assessTimeframeSet(set, { fiveMinuteExactTime: true })).key, '5M')
  const page = read('app/terminal/token-scanner/page.tsx')
  assert.match(page, /fiveMinuteExactTime=\{result\.chartSource !== 'v4_swap_events' \|\| result\.chartTimeResolution === 'exact_log_timestamps'\}/)
  assert.match(read('app/api/token/route.ts'), /chartTimeResolution: chartSource === 'v4_swap_events' \? \(chartV4Swap\?\.timeResolution \?\? null\) : null/)
})

test('stale rule: dense but stale demotes (good -> usable, then -> sparse); fresh stays good; never promotes', () => {
  const cs = series(Array.from({ length: 96 }, (_, i) => T0 + i * M15))
  const last = cs[cs.length - 1].t
  const fresh = assessTimeframeQuality(cs, 900, { timeframe: '15M', referenceMs: last + 2 * M15 })
  assert.deepEqual([fresh.quality, fresh.staleBuckets, fresh.rejectionReason], ['good', 2, null])
  const stale = assessTimeframeQuality(cs, 900, { timeframe: '15M', referenceMs: last + 100 * M15 })
  assert.deepEqual([stale.quality, stale.rejectionReason], ['usable', 'stale_recent_coverage'])
  const dead = assessTimeframeQuality(cs, 900, { timeframe: '15M', referenceMs: last + 400 * M15 })
  assert.deepEqual([dead.quality, dead.rejectionReason], ['sparse', 'stale_recent_coverage'])
  // No reference => no stale rule (deterministic; no implicit clock).
  assert.equal(assessTimeframeQuality(cs, 900, { timeframe: '15M' }).staleBuckets, null)
  // Never a promotion: an already-sparse series stays sparse however fresh.
  assert.equal(assessTimeframeQuality(LIVE, 900, { timeframe: '15M', referenceMs: LIVE[6].t }).quality, 'sparse')
  // Nothing added: the candles are untouched.
  assert.equal(cs.length, 96)
  // A dead token's dense 15M history falls back to a coarser timeframe that still reads well.
  const sel = selectPresentationTimeframe(assessTimeframeSet(setOf(cs), { referenceMs: last + 5 * D1 }))
  assert.deepEqual([sel.key, sel.fallbackFrom, sel.quality], ['4H', '15M', 'usable'])
})

test('stale rule: a young pool that stopped trading keeps only its real candles (floor of 12 buckets)', () => {
  const cs = series([T0, T0 + M15, T0 + 2 * M15])
  assert.equal(assessTimeframeQuality(cs, 900, { timeframe: '15M', referenceMs: cs[2].t + 10 * M15 }).quality, 'good', 'within 12 buckets of a 3-bucket window: not stale')
  const q = assessTimeframeQuality(cs, 900, { timeframe: '15M', referenceMs: cs[2].t + 20 * M15 })
  assert.deepEqual([q.quality, q.candleCount], ['usable', 3])
})

test('regression: exact 7-candle / 13-day shape still selects 1D (with and without a fresh reference)', () => {
  assert.equal(select(LIVE).key, '1D')
  assert.equal(selectPresentationTimeframe(assessTimeframeSet(setOf(LIVE), { referenceMs: LIVE[6].t + H1 })).key, '1D')
})

test('PRICE/MCAP unchanged and zero provider-call delta for all quality inputs', () => {
  const ref = LIVE[6].t + H1
  const mc = scaleCandlesToMarketCap(LIVE, 5e8)
  assert.deepEqual(assessTimeframeQuality(mc, 900, { timeframe: '15M', referenceMs: ref }), assessTimeframeQuality(LIVE, 900, { timeframe: '15M', referenceMs: ref }))
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /const scanQuality = useMemo\(\(\) => assessTimeframeSet\(scanSet, qualityOpts\), \[scanSet, qualityOpts\]\)/)
  assert.doesNotMatch(panel, /\bfetch\(|Date\.now\(\)/, 'no requests and no implicit clock in the panel')
  assert.doesNotMatch(read('lib/chartQuality.ts'), /\bfetch\(|Date\.now\(\)|Math\.random\(\)/)
  const page = read('app/terminal/token-scanner/page.tsx')
  assert.match(page, /referenceTimeMs=\{chartReferenceMs\}/)
})

// ── Loaded-window coverage (live bug #2: 6 x 5M candles in a 2h loaded window) ───────────────────────
import { buildCoverageMeta, resolveCoverageWindow, type ChartCoverageMeta } from '../lib/chartQuality.ts'
import { loadOnDemandCandles, resetOnDemandCandleState } from '../lib/server/chartCandlesOnDemand.ts'

const M5 = 300_000
const WEND = T0 + 30 * D1
const ESTABLISHED = Math.floor((WEND - 120 * D1) / 1000)
const pts = (ts: number[]) => ts.map((t) => ({ timestamp: new Date(t).toISOString() }))
const winOf = (meta: ChartCoverageMeta) => resolveCoverageWindow(meta)
const q5 = (cs: ChartCandle[], meta: ChartCoverageMeta | null) => assessTimeframeQuality(cs, 300, { timeframe: '5M', coverage: meta ? winOf(meta) : null, poolCreatedMs: meta?.poolCreatedSec != null ? meta.poolCreatedSec * 1000 : null })
const meta2h = (ts: number[], poolCreatedSec: number | null = ESTABLISHED) => buildCoverageMeta({ requestEndSec: WEND / 1000, intervalSec: 300, limit: 24, points: pts(ts), poolCreatedSec })

test('ROOT CAUSE (verified): judged only first->last, a 6-candle 25-minute burst rated "good"', () => {
  const burst = series(Array.from({ length: 6 }, (_, i) => WEND - 30 * 60_000 + i * M5))
  assert.equal(assessTimeframeQuality(burst, 300, { timeframe: '5M' }).quality, 'good', 'unknown window keeps the old candle-span logic')
  assert.equal(q5(burst, meta2h(burst.map((c) => c.t))).quality, 'sparse', 'against the loaded 2h window it is sparse')
})

test('LIVE REGRESSION: established pool, 5M, 2h loaded, 6 genuine candles clustered in ~25 min -> sparse, never auto-selected, nothing fabricated', () => {
  const ts = Array.from({ length: 6 }, (_, i) => WEND - 55 * 60_000 + i * M5)
  const cs = series(ts)
  const meta = meta2h(ts)
  const window = winOf(meta)!
  assert.deepEqual([window.basis, (window.endMs - window.startMs) / 60_000], ['requested_window', 120])
  const q = q5(cs, meta)
  assert.deepEqual([q.quality, q.rejectionReason, q.candleCount], ['sparse', 'insufficient_loaded_window_coverage', 6])
  assert.deepEqual([q.candleSpanExpectedBuckets, q.coverageExpectedBuckets, q.clusterDensity, q.coverageDensity], [6, 25, 1, 0.24])
  assert.deepEqual([q.coverageSpanSec, q.effectiveCoverageSpanSec, q.poolAgeSec], [7200, 7200, 120 * 86_400])
  const set = setOf(cs, 300)
  const sel = selectPresentationTimeframe(assessTimeframeSet(set, { coverageFor: () => window, poolCreatedMs: ESTABLISHED * 1000 }))
  assert.notEqual(sel.key, '5M')
  assert.deepEqual(set.timeframes.find((t) => t.key === '5M')!.candles.map((c) => c.t), ts, 'all 6 genuine candles preserved')
  for (const tf of set.timeframes) assert.ok(tf.candles.length <= 6)
})

test('LIVE REGRESSION fallback: 5M sparse over its loaded day -> the finest coarser usable timeframe (15M)', () => {
  const ts = Array.from({ length: 32 }, (_, i) => WEND - 24 * H1 + i * 45 * 60_000)
  const meta = buildCoverageMeta({ requestEndSec: WEND / 1000, intervalSec: 300, limit: 288, points: pts(ts), poolCreatedSec: ESTABLISHED })
  const window = winOf(meta)!
  const q = assessTimeframeSet(setOf(series(ts), 300), { coverageFor: () => window, poolCreatedMs: ESTABLISHED * 1000 })
  assert.deepEqual([q['5M']!.quality, q['15M']!.quality], ['sparse', 'usable'])
  assert.deepEqual([selectPresentationTimeframe(q).key, selectPresentationTimeframe(q).reason], ['15M', '5m_sparse_fallback_to_15m'])
})

test('1. young 30-minute pool + 6 x 5M -> usable (window clamped to pool creation)', () => {
  const created = WEND / 1000 - 30 * 60
  const ts = Array.from({ length: 6 }, (_, i) => WEND - 30 * 60_000 + i * M5)
  const meta = buildCoverageMeta({ requestEndSec: WEND / 1000, intervalSec: 300, limit: 288, points: pts(ts), poolCreatedSec: created })
  const q = q5(series(ts), meta)
  assert.ok(q.quality === 'usable' || q.quality === 'good', q.quality)
  assert.deepEqual([q.effectiveCoverageSpanSec, q.poolAgeSec], [1800, 1800])
})

test('2/3/6. established 2h window: 20/24 -> good; 6/24 spread -> sparse; 24/24 -> good', () => {
  const ts20 = Array.from({ length: 20 }, (_, i) => WEND - 2 * H1 + (i + 4) * M5)
  assert.equal(q5(series(ts20), meta2h(ts20)).quality, 'good')
  const ts6 = [0, 5, 9, 14, 19, 23].map((k) => WEND - 2 * H1 + k * M5)
  assert.equal(q5(series(ts6), meta2h(ts6)).quality, 'sparse')
  const ts24 = Array.from({ length: 24 }, (_, i) => WEND - 2 * H1 + (i + 1) * M5)
  assert.equal(q5(series(ts24), meta2h(ts24)).quality, 'good')
})

test('4/5. a burst at the WEND or the START of a large loaded window is sparse', () => {
  const day = (ts: number[]) => buildCoverageMeta({ requestEndSec: WEND / 1000, intervalSec: 300, limit: 288, points: pts(ts), poolCreatedSec: ESTABLISHED })
  const atEnd = Array.from({ length: 10 }, (_, i) => WEND - 50 * 60_000 + i * M5)
  assert.equal(q5(series(atEnd), day(atEnd)).quality, 'sparse')
  const atStart = Array.from({ length: 10 }, (_, i) => WEND - 24 * H1 + i * M5)
  assert.equal(q5(series(atStart), day(atStart)).quality, 'sparse')
})

test('7. unknown window: conservative candle-span logic, never a guessed window; count-truncated page proves only its own range', () => {
  const ts = Array.from({ length: 6 }, (_, i) => WEND - 30 * 60_000 + i * M5)
  const q = q5(series(ts), null)
  assert.deepEqual([q.coverageKnown, q.coverageExpectedBuckets, q.quality], [false, 6, 'good'])
  // Pool age unknown: the window is what was returned, up to the answer time (a young pool is never penalized by a guess).
  const noAge = resolveCoverageWindow(buildCoverageMeta({ requestEndSec: WEND / 1000, intervalSec: 300, limit: 288, points: pts(ts) }))!
  assert.deepEqual([noAge.basis, noAge.startMs, noAge.endMs], ['returned_range', ts[0], WEND])
  // A full (count-truncated) page proves nothing older than its oldest row.
  const full = Array.from({ length: 288 }, (_, i) => WEND - 288 * M5 + i * M5)
  const trunc = resolveCoverageWindow(buildCoverageMeta({ requestEndSec: WEND / 1000, intervalSec: 300, limit: 288, points: pts(full), poolCreatedSec: ESTABLISHED }))!
  assert.deepEqual([trunc.basis, trunc.startMs], ['returned_range', full[0]])
  // A proven time window (every V4 log page read) is used as-is.
  const v4 = resolveCoverageWindow(buildCoverageMeta({ requestEndSec: WEND / 1000, intervalSec: 300, limit: null, points: pts(ts), windowSec: 86_400, windowProven: true }))!
  assert.deepEqual([v4.basis, v4.startMs], ['requested_window', WEND - D1])
  assert.equal(resolveCoverageWindow(null), null)
})

test('8. PRICE/MCAP identical under the loaded-window rule', () => {
  const ts = Array.from({ length: 6 }, (_, i) => WEND - 55 * 60_000 + i * M5)
  const cs = series(ts)
  const w = winOf(meta2h(ts))
  assert.deepEqual(assessTimeframeQuality(scaleCandlesToMarketCap(cs, 7e7), 300, { timeframe: '5M', coverage: w }), assessTimeframeQuality(cs, 300, { timeframe: '5M', coverage: w }))
})

test('9. exact-timestamp V4 rule unchanged: inferred 5M stays excluded even with a proven window', () => {
  const ts = Array.from({ length: 288 }, (_, i) => WEND - D1 + (i + 1) * M5)
  const w = resolveCoverageWindow(buildCoverageMeta({ requestEndSec: WEND / 1000, intervalSec: 300, limit: null, points: pts(ts), windowSec: 86_400, windowProven: true }))
  const set = setOf(series(ts), 300)
  assert.equal(selectPresentationTimeframe(assessTimeframeSet(set, { coverageFor: () => w })).key, '5M')
  const inferred = assessTimeframeSet(set, { coverageFor: () => w, fiveMinuteExactTime: false })
  assert.deepEqual([inferred['5M']!.rejectionReason, selectPresentationTimeframe(inferred).key], ['inferred_timestamps', '15M'])
})

test('10. zero provider-call delta: coverage rides on requests already made', async () => {
  // On-demand 5M: the same 2 calls (pool proof + OHLCV) as before, now carrying the request window.
  resetOnDemandCandleState()
  const calls: string[] = []
  const TOKEN = '0xabcdef0123456789abcdef0123456789abcdef01'
  const POOL = '0x1111111111111111111111111111111111111111'
  const nowMs = WEND
  const rows = Array.from({ length: 6 }, (_, i) => [Math.floor((WEND - 55 * 60_000 + i * M5) / 1000), 1, 1.1, 0.9, 1.05, 5])
  const fetchJson = async (url: string) => {
    calls.push(url)
    if (/\/ohlcv\//.test(url)) return { httpStatus: 200, json: { data: { attributes: { ohlcv_list: rows } } } }
    return { httpStatus: 200, json: { data: { attributes: { pool_created_at: new Date(ESTABLISHED * 1000).toISOString() }, relationships: { base_token: { data: { id: `base_${TOKEN}` } }, quote_token: { data: { id: 'base_0x4200000000000000000000000000000000000006' } } } } } }
  }
  const out = await loadOnDemandCandles({ chain: 'base', token: TOKEN, pool: POOL, timeframe: '5m' }, fetchJson, { now: () => nowMs })
  assert.equal(out.providerCalls, 2)
  assert.equal(calls.length, 2)
  assert.ok(out.result.ok)
  const cov = out.result.ok ? out.result.coverage! : null
  assert.deepEqual([cov?.requestedLimit, cov?.returnedRows, cov?.requestEndSec, cov?.requestedStartSec, cov?.poolCreatedSec], [288, 6, WEND / 1000, WEND / 1000 - 86_400, ESTABLISHED])
  assert.equal(q5(series(rows.map((r) => (r[0] as number) * 1000)), cov).quality, 'sparse')
  // The panel judges on-demand 5M (it was never assessed before) and makes no request of its own.
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /const activeQuality: TimeframeQuality \| null = oneActive \? oneQuality : fiveActive \? fiveQuality :/)
  assert.match(panel, /coverage: resolveCoverageWindow\(five\.coverage, poolCreatedMs\)/)
  assert.doesNotMatch(panel, /\bfetch\(/)
  // Scan ladder / Solana attach coverage to the reads they already make.
  assert.match(read('lib/evmChartCandles.ts'), /coverage: buildCoverageMeta\(\{ requestEndSec: nowSec, intervalSec: rung\.intervalSec, limit: rung\.requestLimit, points, poolCreatedSec: poolCreatedSec\(pool\) \}\)/)
  assert.match(read('lib/server/solanaProviders.ts'), /buildCoverageMeta\(\{ requestEndSec: Math\.floor\(Date\.now\(\) \/ 1000\), intervalSec: 900, limit: SOLANA_OHLCV_LIMIT, points: candles \}\)/)
})
