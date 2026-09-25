// EVM (ETH / Base / BNB / Robinhood) Price Chart candle pipeline. All four chains share one
// GeckoTerminal ladder (lib/evmChartCandles.ts) and differ only by network id, so every behaviour
// below is asserted once per chain.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  EVM_CHART_LADDER,
  EVM_CHART_NETWORK,
  normalizeGtOhlcvRows,
  pickTradePriceForToken,
  reconstructCandlesFromTrades,
  resolveEvmPoolTokenSide,
  splitChartWindow,
} from '../lib/evmChartCandles.ts'
import { buildChartTimeframes, formatChartPrice, normalizeChartCandles, pickDefaultTimeframe } from '../lib/priceChartCandles.ts'

const CHAINS = ['eth', 'base', 'bnb', 'robinhood'] as const
const TOKEN = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'
const WETH = '0x4200000000000000000000000000000000000006'
const END_SEC = Math.floor(Date.UTC(2026, 8, 25, 12, 0, 0) / 1000)

function pool(network: string, base: string, quote: string): Record<string, unknown> {
  return { id: `${network}_0xpool`, relationships: { base_token: { data: { id: `${network}_${base.toLowerCase()}` } }, quote_token: { data: { id: `${network}_${quote.toLowerCase()}` } } } }
}

/** GeckoTerminal-shaped rows, newest first: [unix_sec, o, h, l, c, v]. Deterministic walk. */
function gtRows(n: number, stepSec: number, start = 0.00042): unknown[][] {
  const rows: unknown[][] = []
  let p = start
  for (let i = 0; i < n; i++) {
    const o = p
    const c = o * (1 + (((i * 7919) % 13) - 6) / 400)
    const h = Math.max(o, c) * 1.004
    const l = Math.min(o, c) * 0.996
    rows.push([END_SEC - (n - 1 - i) * stepSec, o, h, l, c, 100 + i])
    p = c
  }
  return rows.reverse()
}

for (const chain of CHAINS) {
  const net = EVM_CHART_NETWORK[chain]

  test(`${chain}: scanned-token side comes from the pool's own base/quote ids, never guessed`, () => {
    assert.equal(resolveEvmPoolTokenSide(pool(net, TOKEN, WETH), TOKEN, net), 'base')
    assert.equal(resolveEvmPoolTokenSide(pool(net, WETH, TOKEN), TOKEN, net), 'quote')
    assert.equal(resolveEvmPoolTokenSide(pool(net, TOKEN, WETH), TOKEN.toLowerCase(), net), 'base', 'EVM hex is case-insensitive')
    assert.equal(resolveEvmPoolTokenSide({ id: `${net}_0xpool` }, TOKEN, net), null, 'no relationships -> unresolved')
    assert.equal(resolveEvmPoolTokenSide(pool(net, WETH, '0x1111111111111111111111111111111111111111'), TOKEN, net), null)
  })

  test(`${chain}: real 15m rows -> chronological, OHLC and volume mapped per candle`, () => {
    const rows = gtRows(672, 900)
    const { points, validPointCount, rawPointCount } = normalizeGtOhlcvRows(rows)
    assert.equal(rawPointCount, 672)
    assert.equal(validPointCount, 672)
    for (let i = 1; i < points.length; i++) assert.ok(Date.parse(points[i].timestamp) - Date.parse(points[i - 1].timestamp) === 900_000)
    // newest-first input row 0 is the LAST chronological point
    const newest = rows[0] as number[]
    const last = points[points.length - 1]
    assert.deepEqual([Date.parse(last.timestamp) / 1000, last.open, last.high, last.low, last.close, last.volume], newest)
    assert.equal(last.priceUsd, last.close)
    for (const p of points) for (const v of [p.open, p.high, p.low, p.close]) assert.ok(Number.isFinite(v) && v > 0)
  })

  test(`${chain}: incomplete / NaN / inconsistent rows are dropped, never repaired`, () => {
    const t = END_SEC
    const { points, rejectedReason } = normalizeGtOhlcvRows([
      [t, 1, 1.2, 0.9, 1.1, 5],
      [t - 900, null, 1.2, 0.9, 1.1, 5], // missing open (was: open := close)
      [t - 1800, 1, 0, 0.9, 1.1, 5], // non-positive high
      [t - 2700, 1, 1.05, 0.9, 1.1, 5], // close above high (was: high widened)
      [t - 3600, 1, 1.2, 0.9, Number.NaN, 5],
      [t - 4500, 1, 1.2, 0.9, 1.1, Number.POSITIVE_INFINITY], // bad volume only -> kept, volume null
    ])
    assert.equal(points.length, 2)
    assert.equal(points[0].volume, null)
    assert.equal(points[1].open, 1)
    assert.equal(rejectedReason, undefined)
    assert.equal(normalizeGtOhlcvRows([[t, 1, 1, 1, 1, 1]]).rejectedReason, 'insufficient_points')
    assert.equal(normalizeGtOhlcvRows(null).rejectedReason, 'ohlcv_list_missing')
  })

  test(`${chain}: legacy priceChart window is unchanged; deep series feeds the chart`, () => {
    const rung = EVM_CHART_LADDER[0]
    const deepRows = normalizeGtOhlcvRows(gtRows(672, 900)).points
    const { window, deep } = splitChartWindow(deepRows, rung.windowLimit)
    // What limit=96 returned before is exactly the newest 96 of limit=672.
    const oldRequest = normalizeGtOhlcvRows(gtRows(672, 900).slice(0, 96)).points
    assert.deepEqual(window, oldRequest)
    assert.equal(deep.length, 672)
  })

  test(`${chain}: 15M source rolls up exactly into 1H / 4H / 1D; 5M stays disabled`, () => {
    const points = normalizeGtOhlcvRows(gtRows(672, 900)).points
    const set = buildChartTimeframes(normalizeChartCandles(points), EVM_CHART_LADDER[0].intervalSec)
    const tf = Object.fromEntries(set.timeframes.map((x) => [x.key, x]))
    assert.equal(tf['5M'].available, false)
    assert.equal(tf['5M'].candles.length, 0)
    assert.equal(tf['15M'].origin, 'native')
    assert.equal(tf['15M'].candles.length, 672)
    assert.ok(tf['1H'].available && tf['1H'].origin === 'aggregated')
    assert.ok(tf['4H'].available && tf['1D'].available)
    assert.equal(tf['1D'].candles.length, 8, '7 days of 15m ending mid-day spans 8 UTC days')
    // exact aggregation of the first full hour
    const h0 = tf['1H'].candles[1]
    const members = set.nativeCandles.filter((c) => Math.floor(c.t / 3_600_000) * 3_600_000 === h0.t)
    assert.equal(members.length, 4)
    assert.equal(h0.open, members[0].open)
    assert.equal(h0.close, members[3].close)
    assert.equal(h0.high, Math.max(...members.map((m) => m.high)))
    assert.equal(h0.low, Math.min(...members.map((m) => m.low)))
    assert.equal(h0.volume, members.reduce((s, m) => s + (m.volume ?? 0), 0))
    assert.equal(pickDefaultTimeframe(set), '1H')
  })

  test(`${chain}: hourly-only history shows 1H/4H/1D, never 5M/15M`, () => {
    const points = normalizeGtOhlcvRows(gtRows(168, 3600)).points
    const set = buildChartTimeframes(normalizeChartCandles(points), EVM_CHART_LADDER[1].intervalSec)
    assert.deepEqual(set.timeframes.filter((x) => x.available).map((x) => x.key), ['1H', '4H', '1D'])
    const fifteen = set.timeframes.find((x) => x.key === '15M')!
    assert.match(fifteen.unavailableReason ?? '', /coarser interval/)
  })

  test(`${chain}: daily-only history shows only 1D`, () => {
    const points = normalizeGtOhlcvRows(gtRows(30, 86_400)).points
    const set = buildChartTimeframes(normalizeChartCandles(points), EVM_CHART_LADDER[2].intervalSec)
    assert.deepEqual(set.timeframes.filter((x) => x.available).map((x) => x.key), ['1D'])
  })

  test(`${chain}: swap-rebuilt candles price the scanned token and stay non-standard`, () => {
    const t0 = Date.UTC(2026, 8, 25, 10, 0, 0)
    const trades = Array.from({ length: 12 }, (_, i) => ({
      attributes: {
        block_timestamp: new Date(t0 + i * 7 * 60_000).toISOString(),
        // alternate buys/sells: the scanned token is sometimes "from", sometimes "to"
        from_token_address: i % 2 ? TOKEN : WETH,
        to_token_address: i % 2 ? WETH : TOKEN,
        price_from_in_usd: i % 2 ? String(0.0004 + i * 1e-6) : '2600',
        price_to_in_usd: i % 2 ? '2600' : String(0.0004 + i * 1e-6),
        volume_in_usd: '50',
      },
    }))
    trades.push({ attributes: { block_timestamp: new Date(t0 + 30 * 60_000).toISOString(), from_token_address: WETH, to_token_address: '0x2222222222222222222222222222222222222222', price_from_in_usd: '2600', price_to_in_usd: '1', volume_in_usd: '9' } })
    const r = reconstructCandlesFromTrades(trades, 0.0004, TOKEN)
    assert.ok(r.candles.length >= 2)
    for (const c of r.candles) {
      assert.ok(c.high < 0.001, 'the pair token price (2600) must never appear')
      assert.ok(c.low >= 0.0004)
    }
    assert.equal(r.rejectedTradeReasons.trade_does_not_involve_scanned_token, 1)
    const set = buildChartTimeframes(normalizeChartCandles(r.candles), null)
    assert.equal(set.nativeIsStandard, false)
    assert.equal(set.timeframes.some((x) => x.available), false)
  })
}

test('pickTradePriceForToken: address-matched side, rejects unrelated trades, legacy shape unchanged', () => {
  assert.deepEqual(pickTradePriceForToken({ from_token_address: TOKEN, to_token_address: WETH, price_from_in_usd: '0.0005', price_to_in_usd: '2600' }, TOKEN, 0.0005), { price: 0.0005 })
  assert.deepEqual(pickTradePriceForToken({ from_token_address: WETH, to_token_address: TOKEN, price_from_in_usd: '2600', price_to_in_usd: '0.0005' }, TOKEN, null), { price: 0.0005 })
  assert.equal(pickTradePriceForToken({ from_token_address: WETH, to_token_address: WETH, price_from_in_usd: '2600' }, TOKEN, 1).reason, 'trade_does_not_involve_scanned_token')
  assert.equal(pickTradePriceForToken({ from_token_address: TOKEN, to_token_address: WETH, price_from_in_usd: 'NaN' }, TOKEN, 1).reason, 'missing_positive_trade_price')
  // no address fields -> previous nearest-to-current-price behaviour
  assert.deepEqual(pickTradePriceForToken({ price_from_in_usd: '2600', price_to_in_usd: '0.00051' }, TOKEN, 0.0005), { price: 0.00051 })
})

test('EVM ladder: same three rungs and order, deeper rows only', () => {
  assert.deepEqual(EVM_CHART_LADDER.map((r) => [r.key, r.resolution, r.aggregate, r.windowLimit]), [['24h', 'minute', 15, 96], ['48h', 'hour', 1, 48], ['7d', 'day', 1, 7]])
  assert.deepEqual(EVM_CHART_LADDER.map((r) => r.requestLimit), [672, 168, 30])
  for (const r of EVM_CHART_LADDER) assert.ok(r.requestLimit <= 1000, 'GeckoTerminal maximum')
  assert.deepEqual(Object.fromEntries(CHAINS.map((c) => [c, EVM_CHART_NETWORK[c]])), { eth: 'eth', base: 'base', bnb: 'bsc', robinhood: 'robinhood' })
})

test('tiny EVM prices format without NaN/Infinity', () => {
  assert.equal(formatChartPrice(0.0000000421), '$0.0₇421')
  assert.equal(formatChartPrice(0.000503), '$0.000503')
  assert.equal(formatChartPrice(Number.NaN), '—')
})

// ── Route wiring (static): the route must use the shared ladder/side rules, not local copies ──
const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')

test('route: ladder comes from EVM_CHART_LADDER, one call per rung, priceChart keeps its window', () => {
  assert.match(route, /const _primaryTimeframes = EVM_CHART_LADDER\.map/)
  assert.doesNotMatch(route, /limit: 96 \}/)
  assert.match(route, /splitChartWindow\(points, tf\.windowLimit\)/)
  assert.match(route, /const _MAX_OHLCV_CALLS = 10\b/, 'worst-case OHLCV call cap unchanged')
})

test('route: an unresolved pool side is never guessed', () => {
  assert.doesNotMatch(route, /\['base', 'quote'\]/)
  assert.match(route, /rejectedReason: 'token_side_unresolved'/)
})

test('route: swap reconstruction is told which token was scanned; chartCandles only for real OHLCV', () => {
  assert.match(route, /reconstructCandlesFromTrades\(tradesArr, priceUsd, contract\)/)
  assert.match(route, /chartCandles: chartStatus === 'ok' && chartCandles && chartCandles\.points\.length >= 2 \? chartCandles : null/)
  assert.doesNotMatch(route, /function reconstructCandlesFromTrades\(/, 'single implementation lives in lib/evmChartCandles.ts')
})
