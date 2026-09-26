// On-demand real 5M candles (lib/server/chartCandlesOnDemand.ts + GET /api/token/chart-candles).
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ON_DEMAND_MAX_PROVIDER_CALLS,
  loadOnDemandCandles,
  rememberVerifiedChartPool,
  resetOnDemandCandleState,
} from '../lib/server/chartCandlesOnDemand.ts'
import { EVM_CHART_LADDER } from '../lib/evmChartCandles.ts'
import { buildChartTimeframes, normalizeChartCandles } from '../lib/priceChartCandles.ts'

const TOKEN = '0xabcdef0123456789abcdef0123456789abcdef01'
const WETH = '0x4200000000000000000000000000000000000006'
const POOL = '0x1111111111111111111111111111111111111111'
const END = Math.floor(Date.UTC(2026, 8, 26, 12) / 1000)
const fiveRows = (n: number) => Array.from({ length: n }, (_, i) => [END - i * 300, 1, 1.1, 0.9, 1.05, 5 + i])

type Json = { json: unknown; httpStatus: number | null }
function fetcher(urls: string[], handler: (url: string) => Json) {
  return async (url: string) => { urls.push(url); return handler(url) }
}
const poolInfo = (net: string, base: string, quote: string): Json => ({ httpStatus: 200, json: { data: { id: `${net}_${POOL}`, relationships: { base_token: { data: { id: `${net}_${base}` } }, quote_token: { data: { id: `${net}_${quote}` } } } } } })
const ok5m = (n = 288): Json => ({ httpStatus: 200, json: { data: { attributes: { ohlcv_list: fiveRows(n) } } } })

beforeEach(() => resetOnDemandCandleState())

test('normal scan makes no 5M request: the scan ladder has no 5-minute rung', () => {
  assert.ok(EVM_CHART_LADDER.every((r) => !(r.resolution === 'minute' && r.aggregate === 5)))
  const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(route, /aggregate=5\b|loadOnDemandCandles/)
})

test('5M is never derived from 15M candles', () => {
  const m15 = Array.from({ length: 96 }, (_, i) => ({ timestamp: (END - i * 900) * 1000, open: 1, high: 1.1, low: 0.9, close: 1, volume: 1 }))
  const set = buildChartTimeframes(normalizeChartCandles(m15), 900)
  const five = set.timeframes.find((t) => t.key === '5M')!
  assert.equal(five.available, false)
  assert.equal(five.candles.length, 0)
})

for (const chain of ['eth', 'base', 'bnb', 'robinhood'] as const) {
  const net = chain === 'bnb' ? 'bsc' : chain

  test(`${chain}: click 5M after a scan proved the pool -> exactly one bounded OHLCV request, scanned side`, async () => {
    rememberVerifiedChartPool(chain, TOKEN, POOL, 'quote')
    const urls: string[] = []
    const out = await loadOnDemandCandles({ chain, token: TOKEN, pool: POOL, timeframe: '5m' }, fetcher(urls, () => ok5m()))
    assert.equal(out.providerCalls, 1)
    assert.equal(urls.length, 1)
    assert.match(urls[0], new RegExp(`/networks/${net}/pools/${POOL}/ohlcv/minute\\?aggregate=5&limit=288&currency=usd&token=quote$`))
    assert.ok(out.result.ok && out.result.points.length === 288 && out.result.intervalSec === 300)
  })

  test(`${chain}: verification miss -> side re-proven from the pool's own ids (2 calls max)`, async () => {
    const urls: string[] = []
    const out = await loadOnDemandCandles({ chain, token: TOKEN, pool: POOL, timeframe: '5m' }, fetcher(urls, (u) => (u.includes('/ohlcv/') ? ok5m() : poolInfo(net, WETH, TOKEN))))
    assert.equal(out.providerCalls, 2)
    assert.ok(out.providerCalls <= ON_DEMAND_MAX_PROVIDER_CALLS)
    assert.match(urls[1], /token=quote$/)
  })

  test(`${chain}: cache hit -> zero additional provider calls`, async () => {
    rememberVerifiedChartPool(chain, TOKEN, POOL, 'base')
    const urls: string[] = []
    const f = fetcher(urls, () => ok5m())
    await loadOnDemandCandles({ chain, token: TOKEN, pool: POOL, timeframe: '5m' }, f)
    const again = await loadOnDemandCandles({ chain, token: TOKEN, pool: POOL, timeframe: '5m' }, f)
    assert.equal(again.providerCalls, 0)
    assert.equal(again.cacheHit, true)
    assert.equal(urls.length, 1)
  })
}

test('concurrent identical clicks share one request', async () => {
  rememberVerifiedChartPool('base', TOKEN, POOL, 'base')
  const urls: string[] = []
  const f = fetcher(urls, () => ok5m())
  const [a, b] = await Promise.all([
    loadOnDemandCandles({ chain: 'base', token: TOKEN, pool: POOL, timeframe: '5m' }, f),
    loadOnDemandCandles({ chain: 'base', token: TOKEN, pool: POOL, timeframe: '5m' }, f),
  ])
  assert.equal(urls.length, 1)
  assert.equal(a.providerCalls + b.providerCalls, 1)
})

test('pool that does not contain the scanned token -> token_side_unresolved, no OHLCV call', async () => {
  const urls: string[] = []
  const out = await loadOnDemandCandles({ chain: 'eth', token: TOKEN, pool: POOL, timeframe: '5m' }, fetcher(urls, () => poolInfo('eth', WETH, '0x9999999999999999999999999999999999999999')))
  assert.equal(out.result.ok, false)
  assert.equal(!out.result.ok && out.result.code, 'token_side_unresolved')
  assert.equal(urls.length, 1)
})

test('unsupported chain (solana / polygon) -> network_not_supported, zero calls', async () => {
  for (const chain of ['solana', 'polygon', null]) {
    const urls: string[] = []
    const out = await loadOnDemandCandles({ chain, token: TOKEN, pool: POOL, timeframe: '5m' }, fetcher(urls, () => ok5m()))
    assert.equal(!out.result.ok && out.result.code, 'network_not_supported')
    assert.equal(urls.length, 0)
  }
})

test('invalid input / timeframe -> rejected with zero calls', async () => {
  const urls: string[] = []
  const f = fetcher(urls, () => ok5m())
  assert.equal((await loadOnDemandCandles({ chain: 'eth', token: 'nope', pool: POOL, timeframe: '5m' }, f)).result.ok, false)
  assert.equal((await loadOnDemandCandles({ chain: 'eth', token: TOKEN, pool: POOL, timeframe: '1m' }, f)).result.ok, false)
  assert.equal(urls.length, 0)
})

test('empty 5M history and rate limits are reported honestly', async () => {
  rememberVerifiedChartPool('base', TOKEN, POOL, 'base')
  const empty = await loadOnDemandCandles({ chain: 'base', token: TOKEN, pool: POOL, timeframe: '5m' }, fetcher([], () => ({ httpStatus: 200, json: { data: { attributes: { ohlcv_list: [] } } } })))
  assert.equal(!empty.result.ok && empty.result.code, 'provider_empty')
  resetOnDemandCandleState()
  rememberVerifiedChartPool('base', TOKEN, POOL, 'base')
  const limited = await loadOnDemandCandles({ chain: 'base', token: TOKEN, pool: POOL, timeframe: '5m' }, fetcher([], () => ({ httpStatus: 429, json: null })))
  assert.equal(!limited.result.ok && limited.result.code, 'provider_rate_limited')
})

test('endpoint requires an authenticated user and is rate limited', () => {
  const src = readFileSync(new URL('../app/api/token/chart-candles/route.ts', import.meta.url), 'utf8')
  assert.match(src, /requireAuthenticatedUser\(req\)/)
  assert.match(src, /unauthorizedResponse\(\)/)
  assert.match(src, /limiter\.check\(/)
})
