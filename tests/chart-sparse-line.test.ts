// Sparse line fallback (PriceChartPanel lineMode): real closes are joined only where candles are
// temporally continuous (lib/chartQuality.ts buildSparseLineSegments). Across a larger gap the line AND
// its area break; isolated candles are markers only. Nothing is carried forward, interpolated or created.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildChartTimeframes, type ChartCandle } from '../lib/priceChartCandles.ts'
import { assessTimeframeSet, buildSparseLineSegments, lineChartXs, selectPresentationTimeframe, SPARSE_LINE_MAX_GAP_BUCKETS } from '../lib/chartQuality.ts'
import { scaleCandlesToMarketCap } from '../lib/chartMarketCap.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const M5 = 300_000, M15 = 900_000, H1 = 3_600_000, H4 = 14_400_000, D1 = 86_400_000
const T0 = Date.UTC(2026, 8, 10)
const c = (t: number, close: number): ChartCandle => ({ t, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1 })
const sizes = (r: ReturnType<typeof buildSparseLineSegments>) => r.segments.map((s) => s.indices.length)

// The live shape: 7 x 15M across ~14 days — one adjacent pair, the rest isolated days apart.
const LIVE = [
  c(T0, 200_000), c(T0 + M15, 205_000),
  c(T0 + 3 * D1, 240_000), c(T0 + 6 * D1, 280_000), c(T0 + 9 * D1, 300_000), c(T0 + 12 * D1, 330_000), c(T0 + 14 * D1, 360_000),
]

test('thresholds: 3 buckets for 5M/15M/1H/4H, 2 days for 1D', () => {
  assert.deepEqual(SPARSE_LINE_MAX_GAP_BUCKETS, { 300: 3, 900: 3, 3600: 3, 14_400: 3, 86_400: 2 })
})

test('1/4. LIVE 7 x 15M across 14 days -> 6 segments: one connected pair, five isolated markers; no 200k->360k diagonal', () => {
  const r = buildSparseLineSegments(LIVE, 900)
  assert.deepEqual(sizes(r), [2, 1, 1, 1, 1, 1])
  assert.deepEqual(r.stats, { pointCount: 7, segmentCount: 6, isolatedPointCount: 5, largestGapBuckets: 288, continuityThresholdBuckets: 3 })
  for (const seg of r.segments) for (let k = 1; k < seg.points.length; k++) assert.ok(seg.points[k].t - seg.points[k - 1].t <= 3 * M15, 'no joined pair spans a gap')
  // Still sparse and still not the default; 1D stays the recommended view.
  const q = assessTimeframeSet(buildChartTimeframes(LIVE, 900))
  assert.equal(q['15M']!.quality, 'sparse')
  assert.notEqual(selectPresentationTimeframe(q).key, '15M')
})

test('2/3. adjacent 15M candles connect; a several-day gap disconnects', () => {
  assert.deepEqual(sizes(buildSparseLineSegments([c(T0, 1), c(T0 + M15, 2), c(T0 + 3 * M15, 3)], 900)), [3], 'gaps of 1 and 2 buckets stay connected')
  assert.deepEqual(sizes(buildSparseLineSegments([c(T0, 1), c(T0 + 4 * M15, 2)], 900)), [1, 1], '4 buckets > 3: broken')
  assert.deepEqual(sizes(buildSparseLineSegments([c(T0, 1), c(T0 + M15, 2), c(T0 + 4 * D1, 3), c(T0 + 4 * D1 + M15, 4)], 900)), [2, 2])
})

test('5. area fill never bridges a gap: one area per connected segment, none for isolated points', () => {
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /sparseLine\.segments\.map\(\(seg\) => \{\n\s*if \(seg\.indices\.length < 2\) return null/)
  assert.match(panel, /L\$\{xC\(lastI\)\.toFixed\(1\)\},\$\{priceBot\} L\$\{xC\(first\)\.toFixed\(1\)\},\$\{priceBot\} Z/, 'each area closes under its own segment only')
  assert.doesNotMatch(panel, /L\$\{xC\(data\.length - 1\)\.toFixed\(1\)\},\$\{priceBot\}/, 'no whole-series area')
  assert.doesNotMatch(panel, /const pts = data\.map/, 'no single polyline through every point')
})

test('6-9. 5M burst, 1H, 4H and 1D sparse data segment by their own thresholds', () => {
  assert.deepEqual(sizes(buildSparseLineSegments([0, 1, 2, 3, 30, 31].map((k) => c(T0 + k * M5, 1 + k)), 300)), [4, 2])
  assert.deepEqual(sizes(buildSparseLineSegments([0, 3, 7, 8].map((k) => c(T0 + k * H1, 1 + k)), 3600)), [2, 2])
  assert.deepEqual(sizes(buildSparseLineSegments([0, 3, 10].map((k) => c(T0 + k * H4, 1 + k)), 14_400)), [2, 1])
  assert.deepEqual(sizes(buildSparseLineSegments([0, 1, 3, 6, 7].map((k) => c(T0 + k * D1, 1 + k)), 86_400)), [3, 2], '1D: <= 2 days joins, 3 days breaks')
})

test('10. PRICE and MCAP segment identically', () => {
  const a = buildSparseLineSegments(LIVE, 900)
  const b = buildSparseLineSegments(scaleCandlesToMarketCap(LIVE, 1e6), 900)
  assert.deepEqual(a.segments.map((s) => s.indices), b.segments.map((s) => s.indices))
  assert.deepEqual(a.stats, b.stats)
})

test('11. readable candlestick mode unchanged: segmentation only exists in sparse line mode', () => {
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /const sparseLine = lineMode \? buildSparseLineSegments\(data, intervalSec\) : null/)
  assert.match(panel, /const lineMode = activeQuality != null && !isPresentationUsable\(activeQuality\.quality\) && data\.length >= 2/)
  assert.match(panel, /\{!lineMode && <g>/)
})

test('12/13. no fake candles, no interpolation: segments hold the exact input candles; x keeps real time spacing', () => {
  const r = buildSparseLineSegments(LIVE, 900)
  const flat = r.segments.flatMap((s) => s.points)
  assert.equal(flat.length, LIVE.length)
  flat.forEach((p, i) => assert.equal(p, LIVE[i], 'same object, same close, same time'))
  const xs = lineChartXs(LIVE.map((p) => p.t), 1000)
  const gap = (i: number) => xs[i + 1] - xs[i]
  assert.ok(gap(1) > 100 * gap(0), 'a 3-day gap renders far wider than a 15-minute step (time not compressed)')
  assert.deepEqual(buildSparseLineSegments([], 900).segments, [])
})

test('14. no extra provider calls; debug exposes sparseLine stats', () => {
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.doesNotMatch(panel, /\bfetch\(/)
  assert.doesNotMatch(read('lib/chartQuality.ts'), /\bfetch\(/)
  assert.match(panel, /sparseLine: sparseLine\?\.stats \?\? null/)
})
