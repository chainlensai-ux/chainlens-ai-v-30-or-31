// MCAP / PRICE chart mode (lib/chartMarketCap.ts + PriceChartPanel + page wiring): the supply gate,
// exact candle scaling, readable compact values, and that toggling is a pure client-side view.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { INFERRED_MCAP_BASIS_TOOLTIP, MCAP_SUPPLY_TOLERANCE, formatCompactUsd, marketCapBasisLabel, resolveChartMarketCapSupply, scaleCandlesToMarketCap } from '../lib/chartMarketCap.ts'
import { aggregateCandles, normalizeChartCandles, type ChartCandle } from '../lib/priceChartCandles.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % 14_400_000)
const candle = (i: number, o: number, h: number, l: number, c: number, v: number | null): ChartCandle => ({ t: T0 + i * 300_000, open: o, high: h, low: l, close: c, volume: v })

// ── Supply gate ──────────────────────────────────────────────────────────────────────────────────
test('verified circulating market cap + agreeing circulating_supply => MCAP enabled with exactly that supply', () => {
  const r = resolveChartMarketCapSupply({ valuationStatus: 'verified_mc', verifiedMarketCapUsd: 578_440, circulatingSupply: 1_000_000_000, priceUsd: 0.00057844 })
  assert.equal(r.enabled, true)
  assert.equal(r.enabled && r.supply, 1_000_000_000)
  assert.equal(r.enabled && r.basis, 'circulating_supply')
  assert.ok(r.enabled && r.deviation < 1e-9)
})

test('FDV alone, estimated (total-supply) market cap, or partial valuation can never enable MCAP — with or without a supply', () => {
  for (const valuationStatus of ['fdv_only', 'estimated_mc', 'partial', null, undefined]) {
    for (const circulatingSupply of [1e9, null]) {
      const r = resolveChartMarketCapSupply({ valuationStatus, verifiedMarketCapUsd: 1_000_000, circulatingSupply, priceUsd: 0.001 })
      assert.equal(r.enabled, false, `${String(valuationStatus)} / ${circulatingSupply}`)
      assert.equal(!r.enabled && r.reason, 'Verified market cap unavailable')
    }
  }
})

test('verified market cap but no usable price (or no MC) => PRICE; never an inferred basis', () => {
  for (const [verifiedMarketCapUsd, priceUsd] of [[1_000_000, null], [1_000_000, 0], [1_000_000, Number.NaN], [null, 0.001], [0, 0.001], [-5, 0.001]] as const) {
    for (const circulatingSupply of [null, 1e9]) {
      const r = resolveChartMarketCapSupply({ valuationStatus: 'verified_mc', verifiedMarketCapUsd, circulatingSupply, priceUsd })
      assert.deepEqual([r.enabled, !r.enabled && r.reason], [false, 'Verified market cap unavailable'], `${verifiedMarketCapUsd} / ${priceUsd} / ${circulatingSupply}`)
    }
  }
})

// ── Level B: inferred basis from the VERIFIED current market cap ─────────────────────────────────
test('verified MC with circulating_supply missing => MCAP enabled on the inferred basis, exactly MC ÷ price', () => {
  for (const circulatingSupply of [null, undefined, 0, Number.NaN, -1]) {
    const r = resolveChartMarketCapSupply({ valuationStatus: 'verified_mc', verifiedMarketCapUsd: 578_440, circulatingSupply, priceUsd: 0.00057844 })
    assert.equal(r.enabled, true, String(circulatingSupply))
    assert.equal(r.enabled && r.basis, 'inferred_current_mc')
    assert.equal(r.enabled && r.supply, 578_440 / 0.00057844, 'the exact quotient — no rounding, no FDV')
    assert.equal(r.enabled && r.verifiedMarketCapUsd, 578_440)
  }
})

test('inferred basis scales candles exactly and reproduces the Market Cap card at the scan price; volume unchanged', () => {
  const mc = 2_345_678
  const price = 0.0023456
  const gate = resolveChartMarketCapSupply({ valuationStatus: 'verified_mc', verifiedMarketCapUsd: mc, circulatingSupply: null, priceUsd: price })
  assert.ok(gate.enabled && gate.basis === 'inferred_current_mc')
  const src = [candle(0, 0.002, 0.0025, 0.0019, 0.0021, 1_234), candle(1, 0.0021, 0.0024, 0.002, price, null)]
  const out = scaleCandlesToMarketCap(src, gate.supply)
  assert.deepEqual(out.map((c) => [c.open, c.high, c.low, c.close]), src.map((c) => [c.open * gate.supply, c.high * gate.supply, c.low * gate.supply, c.close * gate.supply]))
  assert.deepEqual(out.map((c) => c.volume), [1_234, null])
  assert.ok(Math.abs(out[1].close - mc) / mc < 1e-12, `${out[1].close} vs card ${mc}`)
})

test('priority: a verified, agreeing circulating_supply always wins over the inferred basis; a mismatching one is not papered over', () => {
  const verified = resolveChartMarketCapSupply({ valuationStatus: 'verified_mc', verifiedMarketCapUsd: 1_050_000, circulatingSupply: 1e9, priceUsd: 0.001 })
  assert.deepEqual([verified.enabled && verified.basis, verified.enabled && verified.supply], ['circulating_supply', 1e9])
  const mismatch = resolveChartMarketCapSupply({ valuationStatus: 'verified_mc', verifiedMarketCapUsd: 100_000, circulatingSupply: 1e9, priceUsd: 0.001 })
  assert.equal(mismatch.enabled, false)
})

test('basis label + tooltip distinguish verified from inferred', () => {
  assert.deepEqual(marketCapBasisLabel('inferred_current_mc'), { label: 'MCAP · inferred supply basis', tooltip: 'Historical market cap is derived from verified current market cap and price using a constant circulating-supply basis.' })
  assert.equal(INFERRED_MCAP_BASIS_TOOLTIP, marketCapBasisLabel('inferred_current_mc').tooltip)
  assert.equal(marketCapBasisLabel('circulating_supply').label, 'MCAP · verified supply basis')
  assert.notEqual(marketCapBasisLabel('circulating_supply').tooltip, INFERRED_MCAP_BASIS_TOOLTIP)
})

test('a supply that disagrees with the verified market cap is surfaced as a mismatch, never forced into parity', () => {
  // e.g. a raw (un-decimaled) supply, or total supply standing in for circulating: 10x off.
  const r = resolveChartMarketCapSupply({ valuationStatus: 'verified_mc', verifiedMarketCapUsd: 100_000, circulatingSupply: 1e9, priceUsd: 0.001 })
  assert.equal(r.enabled, false)
  assert.equal(!r.enabled && r.reason, 'Circulating supply does not match the verified market cap')
  assert.ok(!r.enabled && r.deviation! > MCAP_SUPPLY_TOLERANCE)
  const edge = resolveChartMarketCapSupply({ valuationStatus: 'verified_mc', verifiedMarketCapUsd: 1_000_000, circulatingSupply: 1.14e9, priceUsd: 0.001 })
  assert.equal(edge.enabled, true, '14% apart (price moved since the market cap was quoted) is still the same basis')
})

test('latest MCAP close uses the same circulating-supply basis as the Market Cap card', () => {
  const verified = 2_345_678
  const price = 0.0023456
  const supply = 1_000_000_000
  const gate = resolveChartMarketCapSupply({ valuationStatus: 'verified_mc', verifiedMarketCapUsd: verified, circulatingSupply: supply, priceUsd: price })
  assert.ok(gate.enabled)
  const [latest] = scaleCandlesToMarketCap([candle(0, price, price, price, price, 10)], gate.supply)
  assert.ok(Math.abs(latest.close - verified) / verified < 0.001, `${latest.close} vs card ${verified}`)
})

// ── Scaling ──────────────────────────────────────────────────────────────────────────────────────
test('O/H/L/C multiplied exactly; volume, time and the source candles unchanged (PRICE restores the originals)', () => {
  const src = [candle(0, 0.001, 0.0012, 0.0009, 0.0011, 5_000), candle(1, 0.0011, 0.0015, 0.001, 0.0014, null)]
  const snapshot = JSON.parse(JSON.stringify(src))
  const out = scaleCandlesToMarketCap(src, 1e9)
  assert.deepEqual(out.map((c) => [c.open, c.high, c.low, c.close]), src.map((c) => [c.open * 1e9, c.high * 1e9, c.low * 1e9, c.close * 1e9]))
  assert.deepEqual(out.map((c) => [c.t, c.volume]), src.map((c) => [c.t, c.volume]))
  assert.deepEqual(src, snapshot, 'PRICE mode still renders the exact original candles')
})

test('tiny token price renders a readable market cap', () => {
  const [c] = scaleCandlesToMarketCap([candle(0, 1.2e-9, 1.3e-9, 1.1e-9, 1.2e-9, 1)], 1e15)
  assert.ok(Math.abs(c.close - 1_200_000) < 1e-3)
  assert.equal(formatCompactUsd(c.close), '$1.2M')
})

test('compact USD formatting: axis and header', () => {
  assert.equal(formatCompactUsd(82_000), '$82K')
  assert.equal(formatCompactUsd(580_000), '$580K')
  assert.equal(formatCompactUsd(1_200_000), '$1.2M')
  assert.equal(formatCompactUsd(4_500_000), '$4.5M')
  assert.equal(formatCompactUsd(578_440, 2), '$578.44K')
  assert.equal(formatCompactUsd(2_350_000_000, 2), '$2.35B')
  assert.equal(formatCompactUsd(950, 2), '$950')
})

test('no NaN / Infinity ever reaches the chart', () => {
  assert.equal(formatCompactUsd(Number.NaN), '—')
  assert.equal(formatCompactUsd(Number.POSITIVE_INFINITY), '—')
  const huge = scaleCandlesToMarketCap([candle(0, 1e300, 1e300, 1e300, 1e300, 1)], 1e20)
  assert.equal(huge.length, 0, 'an overflowing candle is dropped, not drawn as Infinity')
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const src = [candle(0, 1, 1, 1, 1, 1)]
    assert.deepEqual(scaleCandlesToMarketCap(src, bad), src, `supply ${bad} leaves prices untouched`)
  }
})

test('scaling commutes with timeframe roll-ups, so V4 5m candles give exact 15M / 1H / 4H market caps', () => {
  // V4 swap-derived 5m candles (native 5m), 4h of them.
  const v4 = normalizeChartCandles(Array.from({ length: 48 }, (_, i) => ({ timestamp: T0 + i * 300_000, open: 0.001 + i * 1e-6, high: 0.0011 + i * 1e-6, low: 0.0009 + i * 1e-6, close: 0.00105 + i * 1e-6, volume: 100 + i })))
  const supply = 777_000_000
  for (const sec of [900, 3600, 14_400]) {
    const a = scaleCandlesToMarketCap(aggregateCandles(v4, sec), supply)
    const b = aggregateCandles(scaleCandlesToMarketCap(v4, supply), sec)
    assert.equal(a.length, b.length)
    a.forEach((x, i) => {
      for (const k of ['open', 'high', 'low', 'close'] as const) assert.ok(Math.abs(x[k] - b[i][k]) / x[k] < 1e-12, `${sec}s ${k}`)
      assert.equal(x.volume, b[i].volume)
    })
  }
})

// ── Wiring: default, toggle, no provider calls ───────────────────────────────────────────────────
test('panel: MCAP by default whenever a verified or inferred basis is passed; toggle is pure client state (no fetch, no rescan)', () => {
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /const valueMode: ChartValueMode = !mcapAvailable \? 'PRICE' : modeRaw && modeRaw\.source === candles \? modeRaw\.mode : 'MCAP'/)
  assert.match(panel, /const series: ChartCandle\[\] = valueMode === 'MCAP' \? scaleCandlesToMarketCap\(priceSeries, marketCapSupply!\) : priceSeries/)
  assert.match(panel, /onClick=\{\(\) => \{ if \(!disabled\) \{ setModeRaw\(\{ source: candles, mode: m \}\); setHover\(null\) \} \}\}/)
  assert.match(panel, /title=\{disabled \? \(marketCapUnavailableReason \?\? 'Verified market cap unavailable'\) : m === 'MCAP' \? mcapBasisInfo\.tooltip : 'Token price \(USD\)'\}/)
  assert.match(panel, /\{valueMode === 'MCAP' && \(\s*<span title=\{mcapBasisInfo\.tooltip\} data-mcap-basis=/, 'the active basis is always shown next to MCAP')
  assert.doesNotMatch(panel, /\bfetch\(/, 'the chart panel never calls a provider — 5M loads go through the page-supplied loader only')
  assert.doesNotMatch(read('lib/chartMarketCap.ts'), /\bfetch\(|from '\.\/server|process\.env/)
})

test('page: supply comes only from the verified valuation + circulating_supply the scan already returns; Solana stays PRICE', () => {
  const page = read('app/terminal/token-scanner/page.tsx')
  assert.match(page, /resolveChartMarketCapSupply\(\{\s*valuationStatus: result\.valuationContext\?\.primaryValuationStatus,\s*verifiedMarketCapUsd: result\.valuationContext\?\.primaryValuationUsd,\s*circulatingSupply: result\.circulatingSupply,\s*priceUsd: result\.price,\s*\}\)/)
  assert.match(page, /marketCapSupply=\{_mcapSupply\.enabled \? _mcapSupply\.supply : null\}/)
  assert.match(page, /marketCapBasis=\{_mcapSupply\.enabled \? _mcapSupply\.basis : null\}/)
  assert.doesNotMatch(page, /marketCapSupply=\{[^}]*fdv/i, 'FDV is never passed as a market-cap basis')
  assert.match(page, /<PriceChartPanel candles=\{sr\.ohlcv\.candles\} declaredIntervalSec=\{chartIntervalSec\(sr\.ohlcv\.timeframe\)\} \/>/, 'Solana chart unchanged: no verified circulating supply in its result, so MCAP stays disabled')
})
