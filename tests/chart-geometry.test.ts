// Token Scanner chart STRUCTURE (lib/chartGeometry.ts, used by PriceChartPanel): bar spacing / viewport
// fill, candle width, robust y-autoscale with flagged extreme wicks, and the volume pane. Display only —
// every test also checks the raw candles are untouched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CANDLE_FILL_FRACTION, MAX_BAR_SPACING, MAX_BODY_WIDTH, MAX_RIGHT_OFFSET_PX, DOJI_MIN_BODY_PX,
  PRICE_PANE_HEIGHT, PRICE_PANE_HEIGHT_COMPACT,
  candleBodyRect, candleGeometry, candleFillFraction, pricePaneHeight, robustPriceDomain, volumePaneHeight,
} from '../lib/chartGeometry.ts'
import { aggregateCandles, type ChartCandle } from '../lib/priceChartCandles.ts'
import { scaleCandlesToMarketCap } from '../lib/chartMarketCap.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const T0 = Date.UTC(2026, 8, 30)
const M5 = 300_000
// A gently trending series with ordinary wicks.
const series = (n: number, base = 1, step = 0.004): ChartCandle[] => Array.from({ length: n }, (_, i) => {
  const o = base * (1 + step * i)
  const c = o * (1 + (i % 2 ? -0.003 : 0.005))
  return { t: T0 + i * M5, open: o, close: c, high: Math.max(o, c) * 1.004, low: Math.min(o, c) * 0.996, volume: 100 + i }
})
const snapshot = (cs: ChartCandle[]) => JSON.stringify(cs)

test('fresh token (12 candles): fills ~82% of the plot, capped spacing, newest at the right with a modest offset', () => {
  for (const plotW of [320, 700, 1100]) {
    const g = candleGeometry(12, 12, plotW)
    assert.ok(g.fill >= 0.7 && g.fill <= 0.86, `${plotW}px: fill ${g.fill}`)
    assert.ok(g.spacing <= MAX_BAR_SPACING)
    const rightGap = plotW - g.xs[11]
    assert.ok(rightGap - 0.5 * g.spacing <= MAX_RIGHT_OFFSET_PX + 1e-9, 'a modest right offset only (<= 24px) — no empty future timeline')
    for (let i = 1; i < 12; i++) assert.ok(Math.abs(g.xs[i] - g.xs[i - 1] - g.spacing) < 1e-9, 'even index spacing')
    assert.ok(g.bodyW < g.spacing && g.bodyW <= MAX_BODY_WIDTH && g.bodyW >= 1)
  }
  // 15 candles on a desktop plot: ~82% fill.
  const g15 = candleGeometry(15, 15, 900)
  assert.ok(Math.abs(g15.fill - CANDLE_FILL_FRACTION) < 0.01, String(g15.fill))
})

test('50+ candles: dense bars, no dead band on the left (whole series ~96%); zoomed/long series fills the plot', () => {
  const whole = candleGeometry(60, 60, 900)
  assert.ok(whole.fill > 0.94, String(whole.fill))
  assert.ok(candleGeometry(40, 40, 900).fill > 0.85 && candleGeometry(40, 40, 900).fill < whole.fill, 'fill grows smoothly with bar count')
  assert.ok(whole.bodyW >= 6 && whole.bodyW < whole.spacing, String(whole.bodyW))
  const zoomed = candleGeometry(100, 400, 900)
  assert.ok(zoomed.fill > 0.96, String(zoomed.fill))
  assert.ok(zoomed.bodyW >= 1 && zoomed.bodyW < zoomed.spacing)
})

test('responsive width: spacing and body width scale with the plot, within guardrails', () => {
  const small = candleGeometry(40, 40, 300)
  const large = candleGeometry(40, 40, 1200)
  assert.ok(large.spacing > small.spacing && large.bodyW >= small.bodyW)
  assert.ok(candleGeometry(3, 3, 1400).bodyW <= MAX_BODY_WIDTH, 'a few candles are never blown up to huge bars')
  assert.ok(candleGeometry(500, 500, 300).bodyW >= 1)
})

test('one extreme HIGH wick: body region keeps the scale; the true high is flagged, raw OHLC untouched', () => {
  const cs = series(30)
  cs[17] = { ...cs[17], high: cs[17].high * 25 }
  const before = snapshot(cs)
  const d = robustPriceDomain(cs)
  assert.equal(d.clippedHigh, true)
  assert.equal(d.trueMax, cs[17].high)
  const bodyLo = Math.min(...cs.map((c) => Math.min(c.open, c.close)))
  const bodyHi = Math.max(...cs.map((c) => Math.max(c.open, c.close)))
  assert.ok((bodyHi - bodyLo) / (d.max - d.min) > 0.5, 'bodies use most of the height, not a thin strip')
  assert.equal(snapshot(cs), before)
})

test('one extreme LOW wick: symmetric handling, true low flagged', () => {
  const cs = series(30)
  cs[9] = { ...cs[9], low: cs[9].low * 0.02 }
  const d = robustPriceDomain(cs)
  assert.equal(d.clippedLow, true)
  assert.equal(d.trueMin, cs[9].low)
  assert.ok(d.min > cs[9].low)
})

test('ordinary wicks are never clipped', () => {
  const d = robustPriceDomain(series(40))
  assert.deepEqual([d.clippedHigh, d.clippedLow], [false, false])
  assert.ok(d.max >= d.trueMax && d.min <= d.trueMin)
})

test('nearly flat market: a minimum spread centred on price (no exploded noise, no divide-by-zero)', () => {
  const flat: ChartCandle[] = Array.from({ length: 20 }, (_, i) => ({ t: T0 + i * M5, open: 0.00042, close: 0.00042, high: 0.00042, low: 0.00042, volume: 1 }))
  const d = robustPriceDomain(flat)
  assert.ok(d.max > 0.00042 && d.min < 0.00042)
  assert.ok((d.max - d.min) / 0.00042 < 0.01)
  assert.ok(Number.isFinite(d.max) && Number.isFinite(d.min))
})

test('timeframe switching: each timeframe recomputes its own domain / geometry from its own visible candles', () => {
  const five = series(96)
  const hour = aggregateCandles(five, 3600)
  assert.notDeepEqual(candleGeometry(hour.length, hour.length, 900), candleGeometry(96, 96, 900))
  const dh = robustPriceDomain(hour)
  const d5 = robustPriceDomain(five)
  assert.ok(dh.trueMax === d5.trueMax && dh.trueMin === d5.trueMin, 'same real extremes, exact roll-up')
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /const domain = robustPriceDomain\(data\)/, 'domain from the VISIBLE candles every render')
  assert.match(panel, /const geo = candleGeometry\(data\.length, total, plotW\)/)
  assert.doesNotMatch(panel, /useState<[^>]*yMin|useRef<[^>]*domain/, 'no stored domain that could go stale')
})

test('MCAP <-> PRICE: the domain scales exactly with the series (same clipping, same geometry)', () => {
  const cs = series(30)
  cs[5] = { ...cs[5], high: cs[5].high * 30 }
  const k = 1_000_000_000
  const a = robustPriceDomain(cs)
  const b = robustPriceDomain(scaleCandlesToMarketCap(cs, k))
  assert.equal(b.clippedHigh, a.clippedHigh)
  assert.ok(Math.abs(b.max / k - a.max) / a.max < 1e-9 && Math.abs(b.min / k - a.min) / a.min < 1e-9)
})

test('new scan / resize: the view is tied to the scan and recomputed; volume is its own proportional pane', () => {
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /const \{ view \} = resolveChartViewport\(viewRaw, \{ identity: dataId, seriesKey, total \}, restView\)/)
  assert.match(panel, /const volH = volumePaneHeight\(priceH, hasVolume\)/)
  assert.equal(volumePaneHeight(310, true), 74)
  assert.equal(volumePaneHeight(310, false), 0)
  // Volume bars share the candles' x and width.
  assert.match(panel, /x=\{xC\(i\) - bodyW \/ 2\} y=\{volBot - h\} width=\{bodyW\}/)
  // Clipped (outlier) wicks: solid wick stops short of the edge and continues dashed; true-value tag; OHLC never modified.
  assert.match(panel, /const wickTop = hiOut \? priceTop \+ WICK_BREAK_PX : yP\(c\.high\)/)
  assert.match(panel, /const wickBot = loOut \? priceBot - WICK_BREAK_PX : yP\(c\.low\)/)
  assert.match(panel, /data-clipped="high"/)
  assert.doesNotMatch(read('lib/chartGeometry.ts'), /\bfetch\(/)
})

test('header vs candle change are named differently', () => {
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /\{windowSpan\} view<\/span>/)
  assert.match(panel, /title="This candle's change \(its open to its close\)">Candle </)
})

// ── Short-series polish: slimmer bodies, visible dojis, matched volume width, shorter pane ─────────
test('body/slot ratio: ~48-55% for 12/17/24 candles, rising to ~72% at 60; spacing and fill unchanged', () => {
  for (const plotW of [360, 900, 1100]) {
    for (const n of [12, 17, 24]) {
      const g = candleGeometry(n, n, plotW)
      const ratio = g.bodyW / g.spacing
      // A huge slot can hit MAX_BODY_WIDTH first (only ever slimmer).
      assert.ok(ratio <= 0.55 + 1e-9 && (ratio >= 0.48 || g.bodyW === MAX_BODY_WIDTH), `${n} @ ${plotW}px: ${ratio}`)
      // Adaptive plot fill / spacing unchanged.
      assert.equal(g.spacing, Math.min(MAX_BAR_SPACING, (plotW * candleFillFraction(n)) / n, (plotW - Math.min(MAX_RIGHT_OFFSET_PX, plotW / (n + 1))) / n))
    }
    const g60 = candleGeometry(60, 60, plotW)
    const r60 = g60.bodyW / g60.spacing
    assert.ok(Math.abs(r60 - 0.72) < 0.01 || (g60.spacing < 4 && r60 > 0.5), `60 @ ${plotW}px: ${r60}`)
  }
})

test('doji visibility: open == close still draws a visible body centred on the real level', () => {
  const flat = candleBodyRect(120, 120)
  assert.equal(flat.h, DOJI_MIN_BODY_PX)
  assert.ok(flat.h >= 3)
  assert.equal(flat.y + flat.h / 2, 120, 'centred on the open/close price')
  const near = candleBodyRect(100.4, 100)
  assert.equal(near.h, DOJI_MIN_BODY_PX)
  assert.ok(Math.abs(near.y + near.h / 2 - 100.2) < 1e-9)
  // Real bodies are drawn exactly (either order).
  assert.deepEqual(candleBodyRect(80, 140), { y: 80, h: 60 })
  assert.deepEqual(candleBodyRect(140, 80), { y: 80, h: 60 })
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /const body = candleBodyRect\(yP\(c\.open\), yP\(c\.close\)\)/)
  assert.match(panel, /<rect x=\{x - bodyW \/ 2\} y=\{body\.y\} width=\{bodyW\} height=\{body\.h\}/)
})

test('volume bars use the same (narrower) width and x as the candles for 12/17/24/60 candles', () => {
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /x=\{xC\(i\) - bodyW \/ 2\} y=\{volBot - h\} width=\{bodyW\}/)
  assert.match(panel, /<rect x=\{x - bodyW \/ 2\} y=\{body\.y\} width=\{bodyW\}/)
  for (const n of [12, 17, 24, 60]) {
    const g = candleGeometry(n, n, 900)
    assert.ok(g.bodyW < g.spacing, `${n}: gap between volume bars too`)
  }
})

test('short-history (<24 candles) price pane is ~10-15% shorter; denser series keep the standard height', () => {
  for (const compact of [false, true]) {
    const base = compact ? PRICE_PANE_HEIGHT_COMPACT : PRICE_PANE_HEIGHT
    for (const n of [12, 17]) {
      const h = pricePaneHeight(compact, n)
      const cut = 1 - h / base
      assert.ok(cut >= 0.1 && cut <= 0.15, `${n} candles: ${h} vs ${base}`)
    }
    assert.equal(pricePaneHeight(compact, 24), base)
    assert.equal(pricePaneHeight(compact, 60), base)
  }
  assert.equal(PRICE_PANE_HEIGHT, 310)
  assert.equal(PRICE_PANE_HEIGHT_COMPACT, 220)
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /const priceH = pricePaneHeight\(compact, series\.length\)/)
  // The volume pane stays proportional to the (possibly shorter) price pane.
  assert.equal(volumePaneHeight(pricePaneHeight(false, 12), true), Math.round(pricePaneHeight(false, 12) * 0.24))
})
