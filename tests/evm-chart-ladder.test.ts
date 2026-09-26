// EVM candle ladder (lib/evmChartCandles.ts runEvmCandleLadder) per chain: which genuine route
// produced candles, which structured reason is reported when none did, and how many provider calls
// each path costs. The route's estimated-trend fallback only runs when this ladder returns no chart.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  EVM_CHART_NETWORK,
  EVM_MAX_OHLCV_CALLS,
  runEvmCandleLadder,
  summarizeCandleFailure,
  type EvmChartRung,
  type LadderDeps,
  type LadderFetchResult,
  type LadderPool,
} from '../lib/evmChartCandles.ts'

const CHAINS = ['eth', 'base', 'bnb', 'robinhood'] as const
const TOKEN = '0xabcdef0123456789abcdef0123456789abcdef01'
const WETH = '0x4200000000000000000000000000000000000006'
const END = Math.floor(Date.UTC(2026, 8, 26, 12) / 1000)

function rows(n: number, stepSec: number): unknown[][] {
  return Array.from({ length: n }, (_, i) => [END - i * stepSec, 1, 1.1, 0.9, 1.05, 10 + i])
}
const ohlcv = (n: number, stepSec = 900): LadderFetchResult => ({ httpStatus: 200, json: { data: { attributes: { ohlcv_list: rows(n, stepSec) } } } })
const status = (httpStatus: number | null, json: unknown = null): LadderFetchResult => ({ httpStatus, json })

function pool(net: string, address: string, side: 'base' | 'quote' | 'none', liquidityUsd = 100_000): LadderPool {
  const rel = side === 'none' ? {} : {
    base_token: { data: { id: `${net}_${side === 'base' ? TOKEN : WETH}` } },
    quote_token: { data: { id: `${net}_${side === 'base' ? WETH : TOKEN}` } },
  }
  return { poolId: `${net}_${address}`, address, name: 'TKN / WETH', liquidityUsd, pool: { id: `${net}_${address}`, relationships: rel } }
}

type Call = { kind: 'pool' | 'trades'; pool?: string; rung?: string; side?: string }
function deps(script: {
  pool?: (address: string, rung: EvmChartRung, side: 'base' | 'quote') => LadderFetchResult
  trades?: (address: string) => LadderFetchResult
}, calls: Call[]): LadderDeps {
  return {
    fetchPoolOhlcv: async (address, rung, side) => { calls.push({ kind: 'pool', pool: address, rung: rung.key, side }); return script.pool ? script.pool(address, rung, side) : status(200, { data: { attributes: { ohlcv_list: [] } } }) },
    fetchTrades: async (address) => { calls.push({ kind: 'trades', pool: address }); return script.trades ? script.trades(address) : status(200, { data: [] }) },
  }
}
const P1 = '0x1111111111111111111111111111111111111111'
const P2 = '0x2222222222222222222222222222222222222222'
const P3 = '0x3333333333333333333333333333333333333333'

for (const chain of CHAINS) {
  const net = EVM_CHART_NETWORK[chain]
  const run = (pools: LadderPool[], d: LadderDeps) => runEvmCandleLadder({ pools, contract: TOKEN, networkId: net, currentPriceUsd: 1 }, d)

  test(`${chain}: primary pool 15m success — one call, deep series, proven pool/side carried`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'base')], deps({ pool: () => ohlcv(672) }, calls))
    assert.equal(calls.length, 1)
    assert.equal(r.priceChart?.points.length, 96, 'legacy window unchanged')
    assert.equal(r.chartCandles?.points.length, 672)
    assert.equal(r.chartCandles?.poolAddress, P1)
    assert.equal(r.chartCandles?.tokenSide, 'base')
    assert.equal(r.candleFailure, null)
  })

  test(`${chain}: quote-side token is requested with token=quote, never base`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'quote')], deps({ pool: (_a, _r, side) => (side === 'quote' ? ohlcv(40) : ohlcv(0)) }, calls))
    assert.deepEqual(calls.map((c) => c.side), ['quote'])
    assert.equal(r.chartCandles?.tokenSide, 'quote')
  })

  test(`${chain}: unknown side — pool skipped with no call, reason token_side_unresolved`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'none')], deps({}, calls))
    assert.equal(calls.filter((c) => c.kind === 'pool').length, 0)
    assert.equal(r.priceChart, null)
    assert.equal(r.candleFailure?.code, 'token_side_unresolved')
  })

  test(`${chain}: provider empty on every rung -> provider_empty, falls through every genuine route`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'base')], deps({}, calls))
    assert.deepEqual(calls.map((c) => c.kind), ['pool', 'pool', 'pool', 'trades'], 'no token-level request')
    assert.equal(r.priceChart, null, 'estimated trend may only follow when this is null')
    assert.equal(r.candleFailure?.code, 'provider_empty')
    assert.ok(r.candleFailure?.message.length)
  })

  test(`${chain}: provider HTTP error -> provider_http_error (not "not indexed")`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'base')], deps({ pool: () => status(500) }, calls))
    assert.equal(r.candleFailure?.code, 'provider_http_error')
  })

  test(`${chain}: pool 404 -> pool_not_indexed; the unsupported token-level path makes ZERO calls`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'base')], deps({ pool: () => status(404) }, calls))
    assert.deepEqual(calls.map((c) => c.kind), ['pool', 'pool', 'pool', 'trades'])
    assert.equal(r.tokenLevelAttempted, false)
    assert.equal(r.usedTokenLevel, false)
    assert.equal(r.candleFailure?.code, 'pool_not_indexed')
  })

  test(`${chain}: a 429 ends ALL further provider calls for the scan (no swap fan-out)`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'base'), pool(net, P2, 'base')], deps({ pool: () => status(429) }, calls))
    assert.deepEqual(calls.map((c) => c.kind), ['pool'], 'previously pool + 2 trades reads')
    assert.equal(r.rateLimited, true)
    assert.equal(r.tradeReconstructionAttempted, false)
    assert.equal(r.priceChart, null, 'no candles fabricated')
    assert.equal(r.candleFailure?.code, 'provider_rate_limited')
  })

  test(`${chain}: a 429 on the first swap read stops the second`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'base'), pool(net, P2, 'base')], deps({ trades: () => status(429) }, calls))
    assert.equal(calls.filter((c) => c.kind === 'trades').length, 1)
    assert.equal(r.candleFailure?.code, 'provider_rate_limited')
  })

  test(`${chain}: alternate pool succeeds after the primary is empty`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'base'), pool(net, P2, 'quote')], deps({ pool: (a) => (a === P2 ? ohlcv(50) : ohlcv(0)) }, calls))
    assert.equal(r.selectedPool?.address, P2)
    assert.equal(r.chartCandles?.tokenSide, 'quote')
    assert.equal(r.candleFailure, null)
  })

  test(`${chain}: all pools and token-level fail -> alternate_pool_failed recorded, swap fallback tried`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'base'), pool(net, P2, 'base'), pool(net, P3, 'base')], deps({}, calls))
    assert.ok(r.attempts.some((a) => a.code === 'alternate_pool_failed'))
    assert.ok(r.attempts.some((a) => a.route === 'swaps' && a.code === 'swap_fallback_insufficient'))
    assert.equal(r.priceChart, null)
  })

  test(`${chain}: no pools -> pool_not_indexed`, async () => {
    const r = await run([], deps({}, []))
    assert.equal(r.candleFailure?.code, 'pool_not_indexed')
  })

  test(`${chain}: worst case is 7 provider calls (3 primary + 2 alternate + 2 swap reads), under the cap`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'base'), pool(net, P2, 'base'), pool(net, P3, 'base')], deps({}, calls))
    assert.equal(calls.length, 7)
    assert.equal(r.totalHttpCalls, 7, 'swap reads are counted in the budget')
    assert.ok(calls.length <= EVM_MAX_OHLCV_CALLS)
  })

  test(`${chain}: a lower cap binds across pool AND swap reads`, async () => {
    const calls: Call[] = []
    const r = await runEvmCandleLadder({ pools: [pool(net, P1, 'base'), pool(net, P2, 'base'), pool(net, P3, 'base')], contract: TOKEN, networkId: net, currentPriceUsd: 1, maxOhlcvCalls: 4 }, deps({}, calls))
    assert.equal(calls.length, 4)
    assert.ok(r.candleFailure)
  })
}

test('unsupported network -> network_not_supported with zero calls', async () => {
  const calls: Call[] = []
  const r = await runEvmCandleLadder({ pools: [pool('x', P1, 'base')], contract: TOKEN, networkId: null, currentPriceUsd: 1 }, deps({}, calls))
  assert.equal(calls.length, 0)
  assert.equal(r.candleFailure?.code, 'network_not_supported')
})

test('summary priority: rate limit outranks later empties; messages are plain language', () => {
  const s = summarizeCandleFailure([
    { route: 'pool', poolAddress: P1, side: 'base', timeframe: '24h', httpStatus: 200, rows: 0, validRows: 0, code: 'provider_empty' },
    { route: 'alternate_pool', poolAddress: P2, side: 'base', timeframe: '24h', httpStatus: 429, rows: 0, validRows: 0, code: 'provider_rate_limited' },
  ], false)
  assert.equal(s.code, 'provider_rate_limited')
  assert.doesNotMatch(s.message, /gecko|dexscreener/i, 'no provider names in user-facing reasons')
})

// ── Credential + endpoint guards ──────────────────────────────────────────────────────────────────
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('no CoinGecko credential is sent on the candle path or reachable client-side (unproven for api.geckoterminal.com)', () => {
  for (const rel of ['lib/evmChartCandles.ts', 'lib/server/chartCandlesOnDemand.ts', 'app/api/token/chart-candles/route.ts', 'app/terminal/token-scanner/PriceChartPanel.tsx', 'app/terminal/token-scanner/page.tsx', 'lib/priceChartCandles.ts']) {
    const src = read(rel)
    assert.doesNotMatch(src, /COINGECKO_API_KEY|x-cg-(demo|pro)-api-key/i, rel)
  }
  // The scan route's GeckoTerminal OHLCV/trades requests carry only an Accept header.
  const route = read('app/api/token/route.ts')
  const ohlcvFn = route.slice(route.indexOf('async function fetchGeckoTerminalPoolOhlcv'), route.indexOf('// Token-level OHLCV (/tokens/{addr}/ohlcv) is not requested'))
  assert.match(ohlcvFn, /headers: \{ Accept: 'application\/json;version=20230302' \}/)
  assert.doesNotMatch(ohlcvFn, /x-cg|COINGECKO/i)
})

test('the unsupported token-level OHLCV endpoint is gone from the scan route', () => {
  const route = read('app/api/token/route.ts')
  assert.doesNotMatch(route, /tokens\/\$\{tokenAddress\}\/ohlcv/)
  assert.doesNotMatch(route, /fetchGeckoTerminalTokenOhlcv|fetchTokenOhlcv/)
  assert.doesNotMatch(read('lib/evmChartCandles.ts'), /fetchTokenOhlcv/)
})
