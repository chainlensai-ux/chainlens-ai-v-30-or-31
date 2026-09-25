// Tests for lib/priceChartCandles.ts — the Token Scanner Price Chart's candle logic. The chart must
// render REAL returned OHLCV only: no interpolation, no gap filling, no lower timeframe built from a
// higher one, and no unavailable timeframe silently showing another timeframe's candles.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateCandles,
  buildChartTimeframes,
  formatChartPct,
  formatChartPrice,
  formatChartVolume,
  niceTicks,
  normalizeChartCandles,
  pctChange,
  pickDefaultTimeframe,
  resolveNativeIntervalSec,
  timeTickIndices,
  type ChartCandleInput,
} from '../lib/priceChartCandles.ts'
import { fetchSolanaOhlcv } from '../lib/server/solanaProviders.ts'

const T0 = Date.UTC(2026, 8, 20, 0, 0, 0) // aligned to a UTC day boundary
const M15 = 15 * 60_000

function row(i: number, o: number, h: number, l: number, c: number, v: number | null = 100, stepMs = M15): ChartCandleInput {
  return { timestamp: new Date(T0 + i * stepMs).toISOString(), open: o, high: h, low: l, close: c, volume: v }
}

test('normalize: sorts chronologically, keeps OHLC mapping, keeps volume on its own candle', () => {
  const rows = [row(2, 3, 4, 2.5, 3.5, 30), row(0, 1, 2, 0.5, 1.5, 10), row(1, 2, 3, 1.5, 2.5, 20)]
  const out = normalizeChartCandles(rows)
  assert.deepEqual(out.map((c) => c.t), [T0, T0 + M15, T0 + 2 * M15])
  assert.deepEqual(out.map((c) => [c.open, c.high, c.low, c.close, c.volume]), [
    [1, 2, 0.5, 1.5, 10],
    [2, 3, 1.5, 2.5, 20],
    [3, 4, 2.5, 3.5, 30],
  ])
})

test('normalize: drops NaN/Infinity/non-positive/inconsistent rows instead of repairing them', () => {
  const out = normalizeChartCandles([
    row(0, 1, 2, 0.5, 1.5),
    row(1, Number.NaN, 2, 1, 1.5),
    row(2, 1, Number.POSITIVE_INFINITY, 1, 1.5),
    row(3, 0, 2, 1, 1.5),
    row(4, 1, 0.5, 2, 1.5), // high < low
    row(5, 3, 2, 1, 1.5), // open above high
    { timestamp: 'not a date', open: 1, high: 2, low: 0.5, close: 1.5 },
    row(6, 1, 2, 0.5, 1.5, Number.NaN), // bad volume only -> candle kept, volume null
  ])
  assert.deepEqual(out.map((c) => c.t), [T0, T0 + 6 * M15])
  assert.equal(out[1].volume, null)
  for (const c of out) for (const v of [c.open, c.high, c.low, c.close]) assert.ok(Number.isFinite(v) && v > 0)
})

test('normalize: duplicate timestamps collapse to one candle (never double-counted)', () => {
  const out = normalizeChartCandles([row(0, 1, 2, 0.5, 1.5, 10), row(0, 1, 2.2, 0.5, 1.8, 12)])
  assert.equal(out.length, 1)
  assert.equal(out[0].close, 1.8)
  assert.equal(out[0].volume, 12)
})

test('normalize: accepts unix-seconds timestamps and numeric strings', () => {
  const out = normalizeChartCandles([{ timestamp: T0 / 1000, open: '0.0000012', high: '0.0000015', low: '0.000001', close: '0.0000014', volume: '5' }])
  assert.equal(out[0].t, T0)
  assert.equal(out[0].close, 0.0000014)
  assert.equal(out[0].volume, 5)
})

test('native interval: declared width kept when gaps are exact multiples (sparse buckets omitted)', () => {
  const sparse = normalizeChartCandles([row(0, 1, 1, 1, 1), row(1, 1, 1, 1, 1), row(4, 1, 1, 1, 1), row(7, 1, 1, 1, 1)])
  assert.equal(resolveNativeIntervalSec(sparse, 900), 900)
  // Declared width contradicted by the real gaps -> inferred instead.
  assert.equal(resolveNativeIntervalSec(sparse, 3600), 900)
  // Nothing declared -> smallest real gap.
  assert.equal(resolveNativeIntervalSec(sparse, null), 900)
})

test('aggregate: exact OHLCV roll-up into UTC buckets, no invented buckets', () => {
  // 15m candles in hour 0 (i=0..3) and hour 2 (i=8,9). Hour 1 has no trades.
  const m15 = normalizeChartCandles([
    row(0, 10, 12, 9, 11, 1),
    row(1, 11, 15, 10, 14, 2),
    row(2, 14, 14, 8, 9, 3),
    row(3, 9, 10, 9, 10, 4),
    row(8, 20, 22, 19, 21, 5),
    row(9, 21, 21, 18, 19, null),
  ])
  const h1 = aggregateCandles(m15, 3600)
  assert.equal(h1.length, 2, 'the empty hour must not be filled')
  assert.deepEqual(h1[0], { t: T0, open: 10, high: 15, low: 8, close: 10, volume: 10 })
  assert.deepEqual(h1[1], { t: T0 + 2 * 3_600_000, open: 20, high: 22, low: 18, close: 19, volume: 5 })
})

test('aggregate: a bucket whose candles carry no volume stays null, not 0', () => {
  const out = aggregateCandles(normalizeChartCandles([row(0, 1, 1, 1, 1, null), row(1, 1, 1, 1, 1, null)]), 3600)
  assert.equal(out[0].volume, null)
})

test('timeframes: 15m native enables 15M + exact roll-ups, never 5M', () => {
  const rows: ChartCandleInput[] = []
  for (let i = 0; i < 96 * 3; i++) rows.push(row(i, 1 + i * 0.01, 1.2 + i * 0.01, 0.9 + i * 0.01, 1.1 + i * 0.01))
  const set = buildChartTimeframes(normalizeChartCandles(rows), 900)
  const byKey = Object.fromEntries(set.timeframes.map((tf) => [tf.key, tf]))
  assert.equal(set.nativeSec, 900)
  assert.equal(byKey['5M'].available, false)
  assert.equal(byKey['5M'].candles.length, 0, 'unavailable timeframe must not carry any candles')
  assert.equal(byKey['15M'].origin, 'native')
  assert.equal(byKey['15M'].candles.length, 288)
  assert.equal(byKey['1H'].candles.length, 72)
  assert.equal(byKey['4H'].candles.length, 18)
  assert.equal(byKey['1D'].available, false, '3 days is below the derived-candle minimum')
  assert.equal(pickDefaultTimeframe(set), '1H')
})

test('timeframes: young pool with ~10 hourly-worth of 15m candles defaults to the dense native view', () => {
  const rows: ChartCandleInput[] = []
  for (let i = 0; i < 40; i++) rows.push(row(i, 1, 1.1, 0.9, 1))
  const set = buildChartTimeframes(normalizeChartCandles(rows), 900)
  assert.equal(pickDefaultTimeframe(set), '15M')
})

test('timeframes: hourly native never produces 5M/15M', () => {
  const rows: ChartCandleInput[] = []
  for (let i = 0; i < 48; i++) rows.push(row(i, 1, 1.1, 0.9, 1, 1, 3_600_000))
  const set = buildChartTimeframes(normalizeChartCandles(rows), 3600)
  const avail = set.timeframes.filter((tf) => tf.available).map((tf) => tf.key)
  assert.deepEqual(avail, ['1H', '4H'])
})

test('timeframes: non-standard reconstructed buckets disable every standard chip', () => {
  const step = 7 * 60_000
  const rows: ChartCandleInput[] = []
  for (let i = 0; i < 20; i++) rows.push(row(i, 1, 1.1, 0.9, 1, 1, step))
  const set = buildChartTimeframes(normalizeChartCandles(rows), null)
  assert.equal(set.nativeSec, 420)
  assert.equal(set.nativeIsStandard, false)
  assert.equal(set.timeframes.some((tf) => tf.available), false)
  assert.equal(pickDefaultTimeframe(set), null)
  assert.equal(set.nativeCandles.length, 20)
})

test('timeframes: fewer than 2 candles -> nothing available', () => {
  const set = buildChartTimeframes(normalizeChartCandles([row(0, 1, 1, 1, 1)]), 900)
  assert.equal(set.timeframes.some((tf) => tf.available), false)
})

test('price format: tiny memecoin prices stay readable and never print NaN/Infinity', () => {
  assert.equal(formatChartPrice(0.0005016), '$0.0005016')
  assert.equal(formatChartPrice(0.0000042), '$0.0₅42')
  assert.equal(formatChartPrice(0.00000000123456), '$0.0₈1235')
  assert.equal(formatChartPrice(0.001), '$0.001')
  assert.equal(formatChartPrice(0.0009999, 3), '$0.001')
  assert.equal(formatChartPrice(0.5), '$0.5')
  assert.equal(formatChartPrice(1.23456), '$1.2346')
  assert.equal(formatChartPrice(64231.5), '$64,231.50')
  assert.equal(formatChartPrice(Number.NaN), '—')
  assert.equal(formatChartPrice(Number.POSITIVE_INFINITY), '—')
  assert.equal(formatChartPrice(null), '—')
})

test('volume / pct format and pctChange guard against bad input', () => {
  assert.equal(formatChartVolume(1_530_000), '$1.53M')
  assert.equal(formatChartVolume(Number.NaN), '—')
  assert.equal(formatChartPct(5.3456), '+5.35%')
  assert.equal(formatChartPct(-2), '−2.00%')
  assert.equal(formatChartPct(Number.NaN), '—')
  assert.equal(pctChange(0, 1), null)
  assert.equal(pctChange(1, Number.NaN), null)
  assert.ok(Math.abs((pctChange(0.0004761, 0.0005016) ?? 0) - 5.356) < 0.01)
})

test('niceTicks: evenly spaced, inside range, finite for tiny prices', () => {
  const { ticks, step } = niceTicks(0.00000041, 0.00000058, 5)
  assert.ok(ticks.length >= 3 && ticks.length <= 8)
  assert.ok(step > 0)
  for (const t of ticks) {
    assert.ok(Number.isFinite(t))
    assert.ok(t >= 0.00000041 - step * 1e-6 && t <= 0.00000058 + step * 1e-6)
  }
  assert.deepEqual(niceTicks(1, 1, 5).ticks, [])
})

test('timeTickIndices: several labels, increasing, spaced apart', () => {
  const rows: ChartCandleInput[] = []
  for (let i = 0; i < 96; i++) rows.push(row(i, 1, 1, 1, 1))
  const idx = timeTickIndices(normalizeChartCandles(rows), 12, 0)
  assert.ok(idx.length >= 4, `expected multiple labels, got ${idx.length}`)
  for (let k = 1; k < idx.length; k++) assert.ok(idx[k] - idx[k - 1] >= 12)
})

// ── Solana candle request: same single call, deeper + correct token side ─────────────────────────

function mockGt(urls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    // GeckoTerminal returns newest-first [unix_sec, o, h, l, c, v] rows.
    const t = Math.floor(T0 / 1000)
    return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [[t + 900, 2, 3, 1.5, 2.5, 20], [t, 1, 2, 0.5, 1.5, 10]] } } }), { status: 200 })
  }) as typeof fetch
}

test('solana ohlcv: exactly one request, 15m x 672, token side forwarded', async () => {
  const urls: string[] = []
  const quote = await fetchSolanaOhlcv('Pool111', mockGt(urls), 'quote')
  assert.equal(urls.length, 1, 'provider-call delta must stay zero')
  assert.match(urls[0], /\/networks\/solana\/pools\/Pool111\/ohlcv\/minute\?/)
  assert.match(urls[0], /aggregate=15&limit=672&currency=usd&token=quote/)
  assert.equal(quote.timeframe, '15m')
  // newest-first rows come back chronological with OHLCV intact
  assert.deepEqual(quote.candles.map((c) => [c.open, c.high, c.low, c.close, c.volume]), [[1, 2, 0.5, 1.5, 10], [2, 3, 1.5, 2.5, 20]])
  assert.ok(Date.parse(quote.candles[0].timestamp) < Date.parse(quote.candles[1].timestamp))

  await fetchSolanaOhlcv('Pool111', mockGt(urls), null)
  assert.match(urls[1], /token=base/, 'unknown side keeps the prior base default')
})
