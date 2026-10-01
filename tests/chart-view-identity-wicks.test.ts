// Token Scanner chart hardening: (1) the zoom/pan viewport and per-scan UI state are tied to a stable
// scan/data identity (chartDataIdentity), never to the candle array's object identity; (2) only genuine
// display outliers are clipped, with an edge continuation mark and the exact TRUE high/low.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  chartDataIdentity, clampViewport, defaultViewport, normalizeChartCandles, resolveChartViewport,
  type ChartCandle, type ChartViewport, type StoredChartViewport,
} from '../lib/priceChartCandles.ts'
import { robustPriceDomain, WICK_ALLOWANCE_BODY_FRACTION } from '../lib/chartGeometry.ts'
import { scaleCandlesToMarketCap } from '../lib/chartMarketCap.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const T0 = Date.UTC(2026, 8, 30)
const H1 = 3_600_000
const series = (n: number, base = 1, step = 0.004, t0 = T0): ChartCandle[] => Array.from({ length: n }, (_, i) => {
  const o = base * (1 + step * i)
  const c = o * (1 + (i % 2 ? -0.003 : 0.005))
  return { t: t0 + i * H1, open: o, close: c, high: Math.max(o, c) * 1.004, low: Math.min(o, c) * 0.996, volume: 100 + i }
})
const deepCopy = <T,>(x: T): T => JSON.parse(JSON.stringify(x))
// Provider-shaped rows (what the page passes as `candles`), normalized exactly like the panel does.
const rows = (cs: ChartCandle[]) => cs.map(({ t, open, high, low, close, volume }) => ({ timestamp: t, open, high, low, close, volume }))
const norm = (cs: ChartCandle[]) => normalizeChartCandles(rows(cs))

// The panel's own flow: identity of the normalized scan candles, stored view set on (identity, seriesKey).
const store = (identity: string, seriesKey: string, view: ChartViewport, total: number): StoredChartViewport =>
  ({ identity, seriesKey, view: clampViewport(view, total), total })

test('equivalent NEW candle-array reference does NOT reset zoom', () => {
  const scanKey = 'base:0xabc:0xpool:pool_ohlcv'
  const a = series(200)
  const b = deepCopy(a) // parent rebuilt an equivalent array (new object, same data)
  assert.notEqual(a, b)
  const idA = chartDataIdentity(scanKey, norm(a))
  const idB = chartDataIdentity(scanKey, norm(b))
  assert.equal(idA, idB)
  assert.match(idA, /\|200\|/, "fingerprint covers the real series")
  const zoom = store(idA, '1H:x', { start: 120, end: 150 }, 200)
  const r = resolveChartViewport(zoom, { identity: idB, seriesKey: '1H:x', total: 200 }, defaultViewport(200, 90))
  assert.equal(r.valid, true)
  assert.deepEqual(r.view, { start: 120, end: 150 })
  // No per-scan state in the panel is keyed on the array object any more.
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.doesNotMatch(panel, /=== candles\b|source: candles\b|autoRan\.current = candles/)
  assert.match(panel, /const dataId = useMemo\(\(\) => chartDataIdentity\(scanKey, normalized\), \[scanKey, normalized\]\)/)
  for (const s of ['histRaw', 'autoSnap', 'fiveRaw', 'modeRaw']) assert.match(panel, new RegExp(`${s} && ${s}\\.source === dataId`))
})

test('new token with the SAME timeframe / latest timestamp DOES reset the viewport', () => {
  const cs = norm(series(200))
  const idOld = chartDataIdentity('base:0xaaa:0xp1:pool_ohlcv', cs)
  // Identical timestamps and even identical prices: the scan key alone separates the tokens/pools.
  assert.notEqual(chartDataIdentity('base:0xbbb:0xp2:pool_ohlcv', cs), idOld)
  // Different pool for the same token also resets.
  assert.notEqual(chartDataIdentity('base:0xaaa:0xp9:pool_ohlcv', cs), idOld)
  // Without a scan key, a different token's series (same count + newest timestamp) still differs by its prices.
  const other = norm(series(200, 0.002))
  assert.equal(other[other.length - 1].t, cs[cs.length - 1].t)
  assert.notEqual(chartDataIdentity(null, other), chartDataIdentity(null, cs))
  const zoom = store(idOld, '1H:x', { start: 10, end: 40 }, 200)
  const rest = defaultViewport(200, 90)
  const r = resolveChartViewport(zoom, { identity: chartDataIdentity('base:0xbbb:0xp2:pool_ohlcv', cs), seriesKey: '1H:x', total: 200 }, rest)
  assert.equal(r.valid, false)
  assert.deepEqual(r.view, rest)
  // The page passes a scan key for both EVM and Solana charts.
  const page = read('app/terminal/token-scanner/page.tsx')
  assert.match(page, /scanKey=\{`\$\{result\.chain\}:\$\{result\.contract\}:\$\{result\.chartCandles\?\.poolAddress \?\? ''\}:\$\{result\.chartSource \?\? ''\}`\}/)
  assert.match(page, /scanKey=\{`solana:\$\{sr\.mintAddress\}:\$\{sr\.ohlcv\.poolAddress \?\? ''\}`\}/)
})

test('same token rescanned: equivalent series keeps the view; a genuinely new series (new candle) resets; timeframe switch is isolated', () => {
  const key = 'base:0xabc:0xpool:pool_ohlcv'
  const cs = norm(series(200))
  const id = chartDataIdentity(key, cs)
  assert.equal(chartDataIdentity(key, norm(deepCopy(series(200)))), id)
  const newer = norm(series(200, 1, 0.004, T0 + H1)) // rescan an hour later: newest candle moved
  assert.notEqual(chartDataIdentity(key, newer), id)
  const zoom = store(id, '1H:x', { start: 10, end: 40 }, 200)
  const rest = defaultViewport(200, 90)
  assert.equal(resolveChartViewport(zoom, { identity: chartDataIdentity(key, newer), seriesKey: '1H:y', total: 200 }, rest).valid, false)
  // Timeframe switch on the same scan: a different series key never inherits the 1H zoom.
  const r = resolveChartViewport(zoom, { identity: id, seriesKey: '4H:x', total: 50 }, defaultViewport(50, 90))
  assert.equal(r.valid, false)
  assert.deepEqual(r.view, defaultViewport(50, 90))
})

test('prepended OLDER history preserves the viewport (same visible candles)', () => {
  const key = 'base:0xabc:0xpool:v4_swap_events'
  const scan = norm(series(100, 1, 0.004, T0))
  const id = chartDataIdentity(key, scan) // identity comes from the SCAN candles; history is merged under them
  const before = scan
  const older = series(40, 0.8, 0.004, T0 - 40 * H1)
  const after = [...older, ...scan]
  const seriesKey = `1H:${after[after.length - 1].t}`
  const zoom = store(id, seriesKey, { start: 50, end: 80 }, before.length)
  const r = resolveChartViewport(zoom, { identity: id, seriesKey, total: after.length }, defaultViewport(after.length, 90))
  assert.equal(r.valid, true)
  assert.equal(r.prepended, 40)
  assert.deepEqual(after.slice(r.view.start, r.view.end).map((c) => c.t), before.slice(50, 80).map((c) => c.t))
})

test('moderate long wick remains FULLY visible (no clipping, no marker), PRICE and MCAP', () => {
  const cs = series(30)
  const bodyHi = Math.max(...cs.map((c) => Math.max(c.open, c.close)))
  const bodyLo = Math.min(...cs.map((c) => Math.min(c.open, c.close)))
  const span = bodyHi - bodyLo
  // Reaches well past the old allowance (0.5 x body span above the bodies) — a long but ordinary wick.
  cs[22] = { ...cs[22], high: bodyHi + span * (WICK_ALLOWANCE_BODY_FRACTION + 0.4) }
  cs[6] = { ...cs[6], low: bodyLo - span * 0.6 }
  const before = JSON.stringify(cs)
  for (const [k, xs] of [[1, cs], [5e8, scaleCandlesToMarketCap(cs, 5e8)]] as const) {
    const d = robustPriceDomain(xs)
    assert.deepEqual([d.clippedHigh, d.clippedLow], [false, false], `scale ${k}`)
    assert.ok(d.max >= xs[22].high && d.min <= xs[6].low, 'the whole wick is inside the display range')
  }
  assert.equal(JSON.stringify(cs), before, 'raw OHLC untouched')
})

test('true extreme wick: clipped with a continuation marker and the EXACT true value (PRICE and MCAP)', () => {
  const cs = series(30)
  cs[17] = { ...cs[17], high: cs[17].high * 25 }
  cs[9] = { ...cs[9], low: cs[9].low * 0.02 }
  const before = JSON.stringify(cs)
  const d = robustPriceDomain(cs)
  assert.deepEqual([d.clippedHigh, d.clippedLow], [true, true])
  assert.equal(d.trueMax, cs[17].high)
  assert.equal(d.trueMin, cs[9].low)
  assert.ok(d.max < cs[17].high && d.min > cs[9].low)
  const k = 2e9
  const m = robustPriceDomain(scaleCandlesToMarketCap(cs, k))
  assert.deepEqual([m.clippedHigh, m.clippedLow], [true, true])
  assert.ok(Math.abs(m.trueMax - cs[17].high * k) / (cs[17].high * k) < 1e-12, 'MCAP marker shows the true MCAP high')
  assert.equal(JSON.stringify(cs), before)
  // Only the extreme side is clipped: a lone spike up leaves the ordinary lows drawn in full.
  const up = series(30)
  up[17] = { ...up[17], high: up[17].high * 25 }
  assert.deepEqual([robustPriceDomain(up).clippedHigh, robustPriceDomain(up).clippedLow], [true, false])

  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  // Continuation: solid wick stops short of the edge, then dashed THROUGH the edge — no fake high/low end.
  assert.match(panel, /\{hiOut && <line data-wick-continues="high" [^>]*y2=\{priceTop\} [^>]*strokeDasharray="2 2" \/>\}/)
  assert.match(panel, /\{loOut && <line data-wick-continues="low" [^>]*y2=\{priceBot\} [^>]*strokeDasharray="2 2" \/>\}/)
  // Tag with the exact true value, formatted by the active mode's formatter (PRICE or MCAP).
  assert.match(panel, /const label = `High \$\{fmtValue\(domain\.trueMax, 4\)\}`/)
  assert.match(panel, /const label = `Low \$\{fmtValue\(domain\.trueMin, 4\)\}`/)
  assert.match(panel, /<g data-clipped="high" data-true-value=\{domain\.trueMax\}/)
  // Crosshair readout always reads the real candle.
  assert.match(panel, /H <span style=\{\{ color: readoutColor \}\}>\{fmtValue\(readout\.high\)\}<\/span>/)
  assert.match(panel, /L <span style=\{\{ color: readoutColor \}\}>\{fmtValue\(readout\.low\)\}<\/span>/)
})
