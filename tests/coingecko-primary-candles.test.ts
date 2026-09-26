// CoinGecko on-chain pool OHLCV as the PRIMARY EVM candle source, GeckoTerminal as fallback:
// ladder behaviour per chain, token-side identity, 429 policy, call budget, the server-only fetcher
// (key only ever in a request header), on-demand 5M, and the debug trail.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  COINGECKO_ONCHAIN_NETWORK,
  EVM_CHART_NETWORK,
  EVM_MAX_OHLCV_CALLS,
  buildEvmChartDebugInfo,
  runEvmCandleLadder,
  type EvmChartRung,
  type LadderDeps,
  type LadderFetchResult,
  type LadderPool,
} from '../lib/evmChartCandles.ts'
import { coingeckoOnchainOhlcvPath, fetchCoingeckoOnchainPoolOhlcv, isCoingeckoOnchainConfigured } from '../lib/server/coingeckoOnchainOhlcv.ts'
import { loadOnDemandCandles, rememberVerifiedChartPool, resetOnDemandCandleState } from '../lib/server/chartCandlesOnDemand.ts'

const CHAINS = ['eth', 'base', 'bnb', 'robinhood'] as const
const TOKEN = '0xabcdef0123456789abcdef0123456789abcdef01'
const WETH = '0x4200000000000000000000000000000000000006'
const P1 = '0x1111111111111111111111111111111111111111'
const P2 = '0x2222222222222222222222222222222222222222'
const END = Math.floor(Date.UTC(2026, 8, 26, 12) / 1000)
const KEY = 'CG-test-secret-key-do-not-leak-42'

// Newest-first like both providers: [unix_sec, o, h, l, c, v].
function rows(n: number, stepSec = 900, price = 1): unknown[][] {
  return Array.from({ length: n }, (_, i) => [END - i * stepSec, price, price * 1.1, price * 0.9, price * 1.05, 10 + i])
}
const ohlcv = (list: unknown[][], meta?: unknown): LadderFetchResult => ({ httpStatus: 200, json: { data: { attributes: { ohlcv_list: list } }, ...(meta ? { meta } : {}) } })
const status = (httpStatus: number | null): LadderFetchResult => ({ httpStatus, json: null })
const meta = (baseAddr: string, quoteAddr: string) => ({ base: { address: baseAddr, symbol: 'B' }, quote: { address: quoteAddr, symbol: 'Q' } })

function pool(net: string, address: string, side: 'base' | 'quote' | 'none'): LadderPool {
  const rel = side === 'none' ? {} : {
    base_token: { data: { id: `${net}_${side === 'base' ? TOKEN : WETH}` } },
    quote_token: { data: { id: `${net}_${side === 'base' ? WETH : TOKEN}` } },
  }
  return { poolId: `${net}_${address}`, address, name: 'TKN / WETH', liquidityUsd: 100_000, pool: { id: `${net}_${address}`, relationships: rel } }
}

type Call = { provider: 'cg' | 'gt' | 'trades'; pool: string; rung?: string; token?: string; aggregate?: number; limit?: number }
function deps(script: {
  cg?: (token: string) => LadderFetchResult
  gt?: (address: string, rung: EvmChartRung, side: 'base' | 'quote') => LadderFetchResult
  trades?: () => LadderFetchResult
}, calls: Call[]): LadderDeps {
  return {
    fetchCoingeckoPoolOhlcv: async (address, rung, token) => { calls.push({ provider: 'cg', pool: address, rung: rung.key, token, aggregate: rung.aggregate, limit: rung.requestLimit }); return script.cg ? script.cg(token) : ohlcv([]) },
    fetchPoolOhlcv: async (address, rung, side) => { calls.push({ provider: 'gt', pool: address, rung: rung.key, token: side }); return script.gt ? script.gt(address, rung, side) : ohlcv([]) },
    fetchTrades: async (address) => { calls.push({ provider: 'trades', pool: address }); return script.trades ? script.trades() : { httpStatus: 200, json: { data: [] } } },
  }
}

for (const chain of CHAINS) {
  const net = EVM_CHART_NETWORK[chain]
  const cgNet = COINGECKO_ONCHAIN_NETWORK[chain] ?? null
  const run = (pools: LadderPool[], d: LadderDeps, currentPriceUsd: number | null = 1.05) =>
    runEvmCandleLadder({ pools, contract: TOKEN, networkId: net, coingeckoNetworkId: cgNet, currentPriceUsd }, d)

  if (chain === 'robinhood') {
    test('robinhood: not routed to CoinGecko (unverified network) — GeckoTerminal stays primary, zero CoinGecko calls', async () => {
      assert.equal(cgNet, null)
      const calls: Call[] = []
      const r = await run([pool(net, P1, 'base')], deps({ gt: () => ohlcv(rows(672)) }, calls))
      assert.deepEqual(calls.map((c) => c.provider), ['gt'])
      assert.equal(r.candleProvider, 'geckoterminal')
      assert.equal(r.coingeckoAttempted, false)
    })
    continue
  }

  test(`${chain}: CoinGecko 200 + real rows => one call, GeckoTerminal never called`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'base'), pool(net, P2, 'base')], deps({ cg: () => ohlcv(rows(672)) }, calls))
    assert.deepEqual(calls.map((c) => c.provider), ['cg'])
    assert.equal(calls[0].aggregate, 15, 'normal scan asks for 15m, never 5m')
    assert.equal(calls[0].limit, 672)
    assert.equal(r.totalHttpCalls, 1)
    assert.equal(r.candleProvider, 'coingecko_onchain')
    assert.equal(r.chartCandles?.points.length, 672)
    assert.equal(r.chartCandles?.intervalSec, 900, '1H/4H/1D are derived locally from these 15m candles')
    assert.equal(r.priceChart?.points.length, 96, 'legacy window unchanged')
    assert.equal(r.candleFailure, null)
  })

  test(`${chain}: base-side token => CoinGecko token=base`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'base')], deps({ cg: () => ohlcv(rows(50)) }, calls))
    assert.equal(calls[0].token, 'base')
    assert.equal(r.chartCandles?.tokenSide, 'base')
  })

  test(`${chain}: quote-side token => CoinGecko token=quote, never base`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'quote')], deps({ cg: (t) => (t === 'quote' ? ohlcv(rows(50)) : ohlcv([])) }, calls))
    assert.deepEqual(calls.map((c) => c.token), ['quote'])
    assert.equal(r.chartCandles?.tokenSide, 'quote')
    assert.equal(r.candleProvider, 'coingecko_onchain')
  })

  test(`${chain}: OHLC + volume mapped exactly, chronological, empty intervals stay absent`, async () => {
    // Newest-first with a 45-minute hole (two missing 15m buckets) between the 2nd and 3rd rows.
    const list = [
      [END, 2, 2.5, 1.5, 2.2, 700],
      [END - 900, 1.8, 2.1, 1.7, 2, 500],
      [END - 3600, 1.5, 1.9, 1.4, 1.8, 300],
    ]
    const r = await run([pool(net, P1, 'base')], deps({ cg: () => ohlcv(list) }, []), 2.2)
    const pts = r.chartCandles!.points
    assert.equal(pts.length, 3, 'no candle invented for the missing buckets')
    assert.deepEqual(pts.map((p) => Date.parse(p.timestamp) / 1000), [END - 3600, END - 900, END])
    assert.deepEqual(pts[2], { timestamp: new Date(END * 1000).toISOString(), open: 2, high: 2.5, low: 1.5, close: 2.2, volume: 700, priceUsd: 2.2 })
    assert.equal(pts[0].volume, 300)
  })

  test(`${chain}: CoinGecko empty => GeckoTerminal fallback succeeds`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'base')], deps({ cg: () => ohlcv([]), gt: () => ohlcv(rows(460)) }, calls))
    assert.deepEqual(calls.map((c) => c.provider), ['cg', 'gt'])
    assert.equal(r.candleProvider, 'geckoterminal')
    assert.equal(r.chartCandles?.points.length, 460)
    assert.equal(r.attempts[0].code, 'provider_empty')
    assert.equal(r.candleFailure, null)
  })

  test(`${chain}: CoinGecko 404 => GeckoTerminal fallback`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'base')], deps({ cg: () => status(404), gt: () => ohlcv(rows(100)) }, calls))
    assert.deepEqual(calls.map((c) => c.provider), ['cg', 'gt'])
    assert.equal(r.attempts[0].code, 'pool_not_indexed')
    assert.equal(r.candleProvider, 'geckoterminal')
  })

  test(`${chain}: CoinGecko 429 => falls back once to GeckoTerminal, CoinGecko not retried`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'base'), pool(net, P2, 'base')], deps({ cg: () => status(429), gt: () => ohlcv(rows(460)) }, calls))
    assert.deepEqual(calls.map((c) => c.provider), ['cg', 'gt'])
    assert.equal(r.coingeckoRateLimited, true)
    assert.equal(r.rateLimited, false, 'GeckoTerminal was not rate limited')
    assert.equal(r.candleProvider, 'geckoterminal')
  })

  test(`${chain}: CoinGecko 429 then GeckoTerminal 429 => GeckoTerminal fan-out stops, no fabricated candles`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'base'), pool(net, P2, 'base')], deps({ cg: () => status(429), gt: () => status(429) }, calls))
    assert.deepEqual(calls.map((c) => c.provider), ['cg', 'gt'])
    assert.equal(r.priceChart, null)
    assert.equal(r.candleFailure?.code, 'provider_rate_limited')
  })

  test(`${chain}: both providers fail => swap route tried, then no chart (route's estimated trend)`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'base')], deps({ cg: () => status(500) }, calls))
    assert.deepEqual(calls.map((c) => c.provider), ['cg', 'gt', 'gt', 'gt', 'trades'])
    assert.equal(r.priceChart, null)
    assert.ok(r.candleFailure)
    const withSwaps = await run([pool(net, P1, 'base')], deps({
      cg: () => status(500),
      trades: () => ({ httpStatus: 200, json: { data: Array.from({ length: 6 }, (_, i) => ({ attributes: { block_timestamp: new Date((END - i * 600) * 1000).toISOString(), from_token_address: TOKEN, to_token_address: WETH, price_from_in_usd: String(1 + i * 0.01), volume_in_usd: '10' } })) } }),
    }, []))
    assert.equal(withSwaps.usedTradeReconstruction, true)
    assert.equal(withSwaps.candleProvider, null)
  })

  test(`${chain}: unproven side => CoinGecko asked by the token's own address; accepted only with meta proof + price match`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'none')], deps({ cg: () => ohlcv(rows(80), meta(WETH, TOKEN)) }, calls))
    assert.equal(calls[0].token, TOKEN, 'exact scanned token address, not a guessed side')
    assert.equal(r.candleProvider, 'coingecko_onchain')
    assert.equal(r.chartCandles?.tokenSide, 'quote')
  })

  test(`${chain}: no token-side leakage — the pair token's series (WETH price) is rejected, never charted`, async () => {
    // meta names the token, but the series is priced like WETH (~3000 vs the token's live 1.05).
    const r1 = await run([pool(net, P1, 'none')], deps({ cg: () => ohlcv(rows(80, 900, 3000), meta(TOKEN, WETH)) }, []))
    assert.equal(r1.attempts[0].code, 'token_identity_unverified')
    assert.equal(r1.chartCandles, null)
    assert.equal(r1.priceChart, null)
    // meta that doesn't name the token at all.
    const r2 = await run([pool(net, P1, 'none')], deps({ cg: () => ohlcv(rows(80), meta(WETH, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')) }, []))
    assert.equal(r2.attempts[0].code, 'token_identity_unverified')
    assert.equal(r2.chartCandles, null)
    // no live price to check against.
    const r3 = await run([pool(net, P1, 'none')], deps({ cg: () => ohlcv(rows(80), meta(TOKEN, WETH)) }, []), null)
    assert.equal(r3.chartCandles, null)
  })

  test(`${chain}: worst case is 8 provider calls (1 CoinGecko + 7 GeckoTerminal), under the cap`, async () => {
    const calls: Call[] = []
    const r = await run([pool(net, P1, 'base'), pool(net, P2, 'base'), pool(net, '0x3333333333333333333333333333333333333333', 'base')], deps({}, calls))
    assert.equal(calls.length, 8)
    assert.equal(r.totalHttpCalls, 8)
    assert.ok(calls.length <= EVM_MAX_OHLCV_CALLS)
  })

  test(`${chain}: debug trail shows CoinGecko then GeckoTerminal, and never the API key`, async () => {
    const r = await run([pool(net, P1, 'quote')], deps({ cg: () => status(429), gt: () => ohlcv(rows(460)) }, []))
    const d = buildEvmChartDebugInfo({
      chain, network: net, coingeckoNetwork: cgNet, scannedToken: TOKEN, attempts: r.attempts, candleFailure: r.candleFailure,
      selectedPoolAddress: r.selectedPool?.address ?? null, tokenSide: r.chartCandles?.tokenSide ?? null,
      rateLimited: r.rateLimited, coingeckoRateLimited: r.coingeckoRateLimited, usedEstimatedTrend: false, source: 'pool_ohlcv', finalCandleCount: 96,
    })
    const cg = d.attempts.find((a) => a.stage === 'coingecko_15m')!
    const gt = d.attempts.find((a) => a.stage === 'primary_pool_15m')!
    assert.deepEqual([cg.provider, cg.httpStatus, cg.rowsReturned, cg.status], ['coingecko_onchain', 429, 0, 'provider_rate_limited'])
    assert.deepEqual([gt.provider, gt.httpStatus, gt.rowsReturned, gt.status], ['geckoterminal', 200, 460, 'ok'])
    assert.equal(d.finalSource, 'geckoterminal')
    assert.equal(d.rateLimitedProvider, 'coingecko_onchain')
    assert.equal(d.tokenSide, 'quote')
    assert.doesNotMatch(JSON.stringify(d), new RegExp(KEY))
    assert.doesNotMatch(JSON.stringify(d).toLowerCase(), /x-cg-|api_key|apikey|authorization|ohlcv_list/)
  })
}

test('no key configured => CoinGecko skipped by the route (coingeckoNetworkId null), GeckoTerminal ladder unchanged', async () => {
  const calls: Call[] = []
  const r = await runEvmCandleLadder({ pools: [pool('base', P1, 'base')], contract: TOKEN, networkId: 'base', coingeckoNetworkId: null, currentPriceUsd: 1 }, deps({ gt: () => ohlcv(rows(672)) }, calls))
  assert.deepEqual(calls.map((c) => c.provider), ['gt'])
  assert.equal(r.candleProvider, 'geckoterminal')
})

// ── Server-only fetcher ───────────────────────────────────────────────────────────────────────────
function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
  return fn().finally(() => { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k] } })
}
type Seen = { url: string; headers: Record<string, string> }
const fakeFetch = (seen: Seen[], statusCode: number, body: unknown) => async (url: string, init: { headers: Record<string, string> }) => {
  seen.push({ url, headers: init.headers })
  return { status: statusCode, ok: statusCode >= 200 && statusCode < 300, json: async () => body }
}

test('fetcher: demo host + x-cg-demo-api-key header only; key never in the URL or the result', async () => {
  await withEnv({ COINGECKO_API_KEY: KEY, COINGECKO_API_TIER: undefined }, async () => {
    const seen: Seen[] = []
    const out = await fetchCoingeckoOnchainPoolOhlcv('base', P1, { resolution: 'minute', aggregate: 15, limit: 672 }, 'quote', fakeFetch(seen, 200, { data: { attributes: { ohlcv_list: rows(3) } } }))
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, `https://api.coingecko.com/api/v3/onchain/networks/base/pools/${P1}/ohlcv/minute?aggregate=15&limit=672&currency=usd&token=quote&include_empty_intervals=false`)
    assert.equal(seen[0].headers['x-cg-demo-api-key'], KEY)
    assert.doesNotMatch(seen[0].url, new RegExp(KEY))
    assert.equal(out.httpStatus, 200)
    assert.doesNotMatch(JSON.stringify(out), new RegExp(KEY))
  })
})

test('fetcher: COINGECKO_API_TIER=pro uses the pro host and x-cg-pro-api-key', async () => {
  await withEnv({ COINGECKO_API_KEY: KEY, COINGECKO_API_TIER: 'pro' }, async () => {
    const seen: Seen[] = []
    await fetchCoingeckoOnchainPoolOhlcv('eth', P1, { resolution: 'minute', aggregate: 5, limit: 288 }, 'base', fakeFetch(seen, 200, {}))
    assert.match(seen[0].url, /^https:\/\/pro-api\.coingecko\.com\/api\/v3\/onchain\/networks\/eth\//)
    assert.equal(seen[0].headers['x-cg-pro-api-key'], KEY)
    assert.equal(seen[0].headers['x-cg-demo-api-key'], undefined)
  })
})

test('fetcher: BNB maps to bsc; Robinhood, no key, bad pool or bad token => zero calls', async () => {
  assert.match(coingeckoOnchainOhlcvPath('bsc', P1, { resolution: 'minute', aggregate: 15, limit: 672 }, 'base'), /^\/onchain\/networks\/bsc\//)
  await withEnv({ COINGECKO_API_KEY: KEY, COINGECKO_API_TIER: undefined }, async () => {
    const seen: Seen[] = []
    const req = { resolution: 'minute' as const, aggregate: 15, limit: 672 }
    await fetchCoingeckoOnchainPoolOhlcv('bnb', P1, req, 'base', fakeFetch(seen, 200, {}))
    assert.match(seen[0].url, /\/onchain\/networks\/bsc\//)
    for (const [chain, p, t] of [['robinhood', P1, 'base'], ['solana', P1, 'base'], ['base', 'not-a-pool', 'base'], ['base', P1, 'both']] as const) {
      const out = await fetchCoingeckoOnchainPoolOhlcv(chain, p, req, t, fakeFetch(seen, 200, {}))
      assert.deepEqual(out, { json: null, httpStatus: null })
    }
    assert.equal(seen.length, 1)
  })
  await withEnv({ COINGECKO_API_KEY: undefined }, async () => {
    const seen: Seen[] = []
    assert.equal(isCoingeckoOnchainConfigured(), false)
    await fetchCoingeckoOnchainPoolOhlcv('base', P1, { resolution: 'minute', aggregate: 15, limit: 672 }, 'base', fakeFetch(seen, 200, {}))
    assert.equal(seen.length, 0)
  })
})

test('fetcher: network error / non-2xx never surface the key', async () => {
  await withEnv({ COINGECKO_API_KEY: KEY, COINGECKO_API_TIER: undefined }, async () => {
    const thrower = async () => { throw new Error(`boom ${KEY}`) }
    assert.deepEqual(await fetchCoingeckoOnchainPoolOhlcv('base', P1, { resolution: 'minute', aggregate: 15, limit: 672 }, 'base', thrower), { json: null, httpStatus: null })
    const out = await fetchCoingeckoOnchainPoolOhlcv('base', P1, { resolution: 'minute', aggregate: 15, limit: 672 }, 'base', fakeFetch([], 401, { error: KEY }))
    assert.deepEqual(out, { json: null, httpStatus: 401 })
  })
})

// ── On-demand 5M ─────────────────────────────────────────────────────────────────────────────────
type Cg5 = { chain: string; pool: string; aggregate: number; limit: number; side: string }
function fiveMin(opts: { cg?: LadderFetchResult; gt?: LadderFetchResult; gtPool?: LadderFetchResult }) {
  const cgCalls: Cg5[] = []
  const gtCalls: string[] = []
  const fetchJson = async (url: string) => {
    gtCalls.push(url)
    if (/\/ohlcv\//.test(url)) return opts.gt ?? ohlcv(rows(288, 300))
    return opts.gtPool ?? { httpStatus: 200, json: { data: pool('base', P1, 'quote').pool } }
  }
  const fetchCoingecko = async (chain: string, p: string, req: { aggregate: number; limit: number }, side: string) => {
    cgCalls.push({ chain, pool: p, aggregate: req.aggregate, limit: req.limit, side })
    return opts.cg ?? ohlcv(rows(288, 300))
  }
  return { cgCalls, gtCalls, fetchJson, fetchCoingecko }
}
const req5 = (chain = 'base') => ({ chain, token: TOKEN, pool: P1, timeframe: '5m' })

test('5M: click => one CoinGecko 5m x 288 read for the proven side; GeckoTerminal not called', async () => {
  resetOnDemandCandleState()
  rememberVerifiedChartPool('base', TOKEN, P1, 'quote')
  const f = fiveMin({})
  const out = await loadOnDemandCandles(req5(), f.fetchJson, { fetchCoingecko: f.fetchCoingecko })
  assert.deepEqual(f.cgCalls, [{ chain: 'base', pool: P1, aggregate: 5, limit: 288, side: 'quote' }])
  assert.equal(f.gtCalls.length, 0)
  assert.equal(out.providerCalls, 1)
  assert.equal(out.result.ok && out.result.source, 'coingecko_onchain')
  assert.equal(out.result.ok && out.result.intervalSec, 300, 'real 5m candles, not derived from 15m')
})

test('5M: cache hit => zero additional calls', async () => {
  resetOnDemandCandleState()
  rememberVerifiedChartPool('base', TOKEN, P1, 'quote')
  const f = fiveMin({})
  await loadOnDemandCandles(req5(), f.fetchJson, { fetchCoingecko: f.fetchCoingecko })
  const again = await loadOnDemandCandles(req5(), f.fetchJson, { fetchCoingecko: f.fetchCoingecko })
  assert.equal(again.cacheHit, true)
  assert.equal(again.providerCalls, 0)
  assert.equal(f.cgCalls.length, 1)
})

test('5M: CoinGecko 429 => one GeckoTerminal 5m fallback, honest source label', async () => {
  resetOnDemandCandleState()
  rememberVerifiedChartPool('base', TOKEN, P1, 'quote')
  const f = fiveMin({ cg: status(429) })
  const out = await loadOnDemandCandles(req5(), f.fetchJson, { fetchCoingecko: f.fetchCoingecko })
  assert.equal(f.cgCalls.length, 1)
  assert.equal(f.gtCalls.length, 1)
  assert.match(f.gtCalls[0], /ohlcv\/minute\?aggregate=5&limit=288&currency=usd&token=quote/)
  assert.equal(out.result.ok && out.result.source, 'geckoterminal')
})

test('5M: both providers fail => honest failure, no candles', async () => {
  resetOnDemandCandleState()
  rememberVerifiedChartPool('base', TOKEN, P1, 'quote')
  const f = fiveMin({ cg: ohlcv([]), gt: status(429) })
  const out = await loadOnDemandCandles(req5(), f.fetchJson, { fetchCoingecko: f.fetchCoingecko })
  assert.equal(out.result.ok, false)
  assert.equal(!out.result.ok && out.result.code, 'provider_rate_limited')
})

test('5M: side not yet proven => GeckoTerminal pool read proves it first, then CoinGecko; bounded at 3 calls', async () => {
  resetOnDemandCandleState()
  const f = fiveMin({ cg: status(500) })
  const out = await loadOnDemandCandles(req5(), f.fetchJson, { fetchCoingecko: f.fetchCoingecko })
  assert.equal(f.cgCalls[0].side, 'quote')
  assert.equal(out.providerCalls, 3)
  assert.equal(out.result.ok, true)
})

test('5M: Robinhood => GeckoTerminal only, CoinGecko never called', async () => {
  resetOnDemandCandleState()
  rememberVerifiedChartPool('robinhood', TOKEN, P1, 'base')
  const f = fiveMin({})
  const out = await loadOnDemandCandles(req5('robinhood'), f.fetchJson, { fetchCoingecko: f.fetchCoingecko })
  assert.equal(f.cgCalls.length, 0)
  assert.equal(out.result.ok && out.result.source, 'geckoterminal')
})

// ── Static wiring guards ─────────────────────────────────────────────────────────────────────────
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('the CoinGecko key is read in exactly one candle-path module and never reaches the client', () => {
  assert.match(read('lib/server/coingeckoOnchainOhlcv.ts'), /process\.env\.COINGECKO_API_KEY/)
  for (const rel of ['lib/evmChartCandles.ts', 'lib/server/chartCandlesOnDemand.ts', 'app/api/token/chart-candles/route.ts', 'app/terminal/token-scanner/page.tsx', 'app/terminal/token-scanner/PriceChartPanel.tsx']) {
    assert.doesNotMatch(read(rel), /COINGECKO_API_KEY|x-cg-(demo|pro)-api-key/i, rel)
  }
  const fetcher = read('lib/server/coingeckoOnchainOhlcv.ts')
  assert.doesNotMatch(fetcher, /console\.(log|error|warn|info)/, 'nothing logged from the fetcher')
})

test('scan route: CoinGecko wired as primary, side-aware cache key, no 5m request on a normal scan', () => {
  const route = read('app/api/token/route.ts')
  assert.match(route, /coingeckoNetworkId: _chartCoingeckoNetwork/)
  assert.match(route, /fetchCoingeckoPoolOhlcv: \(poolAddress, rung, token\) => fetchCoingeckoOnchainPoolOhlcv\(chain, poolAddress/)
  assert.match(route, /_chartCacheKey = `evm-candles-v2:\$\{chain\}:\$\{contract\.toLowerCase\(\)\}:\$\{primaryAddr \|\| 'no_pool'\}:\$\{_chartPrimarySide \?\? 'side_unresolved'\}:15m`/)
  const chartSection = route.slice(route.indexOf('const _ladder = await runEvmCandleLadder'), route.indexOf('// Phase 6: Synthetic micro-candles'))
  assert.doesNotMatch(chartSection, /aggregate: 5|ON_DEMAND_TIMEFRAMES|loadOnDemandCandles/)
})

test('Solana chart path is untouched by the CoinGecko wiring', () => {
  assert.equal(COINGECKO_ONCHAIN_NETWORK.solana, undefined)
  assert.doesNotMatch(read('lib/server/coingeckoOnchainOhlcv.ts'), /solana/i)
})
