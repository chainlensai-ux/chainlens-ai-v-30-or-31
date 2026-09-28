// TEMPORARY Preview-only "TEST V4 CANDLES" diagnostic (lib/server/v4CandleProbe.ts +
// app/api/debug/v4-candle-probe/route.ts + the CANDLE DEBUG panel button): gating, strict inputs,
// provider isolation, the 2-call cap, and that nothing secret or raw ever comes back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { COINGECKO_V4_POOL_ID_OHLCV_CONFIRMED, GECKOTERMINAL_V4_POOL_ID_OHLCV_CONFIRMED } from '../lib/evmChartCandles.ts'
import { V4_PROBE_MAX_PROVIDER_CALLS, geckoTerminalProbePath, parseV4ProbeInput, runV4CandleProbe, type V4ProbeInput } from '../lib/server/v4CandleProbe.ts'

const POOL = '0x' + '9f3c'.repeat(16)
const TOKEN = '0x1bc0c42215582d5a085795f4badbac3ff36d1bcb'
const WETH = '0x4200000000000000000000000000000000000006'
const KEY = 'CG-probe-secret-key-never-returned'
const END = Math.floor(Date.UTC(2026, 8, 28, 12) / 1000)
const rows = (n: number, price: number) => Array.from({ length: n }, (_, i) => [END - i * 900, price, price * 1.1, price * 0.9, price * (1 + i / 1000), 10])
const ohlcv = (n: number, price: number, meta?: unknown) => ({ httpStatus: 200, json: { data: { attributes: { ohlcv_list: rows(n, price) } }, ...(meta ? { meta } : {}) } })
const metaFor = (baseAddr: string, quoteAddr: string) => ({ base: { address: baseAddr, symbol: 'B' }, quote: { address: quoteAddr, symbol: 'Q' } })
const input = (over: Partial<V4ProbeInput> = {}): V4ProbeInput => ({ chain: 'base', pool: POOL, token: TOKEN, side: 'base', livePriceUsd: 1.05, ...over })
const qs = (o: Record<string, string>) => new URLSearchParams({ chain: 'base', pool: POOL, token: TOKEN, side: 'base', livePriceUsd: '1.05', ...o })

test('normal chart behavior untouched: both V4 PoolId support flags still false', () => {
  assert.equal(COINGECKO_V4_POOL_ID_OHLCV_CONFIRMED, false)
  assert.equal(GECKOTERMINAL_V4_POOL_ID_OHLCV_CONFIRMED, false)
})

test('input: only a 64-hex PoolId is accepted; malformed and 40-hex pools are rejected', () => {
  assert.ok(!('error' in parseV4ProbeInput(qs({}))))
  for (const bad of ['0x' + 'a'.repeat(63), '0x' + 'a'.repeat(65), '0x' + 'g'.repeat(64), 'a'.repeat(64), '0x' + 'a'.repeat(40), '']) {
    assert.ok('error' in parseV4ProbeInput(qs({ pool: bad })), bad)
  }
})

test('input: token identity stays strict 40-hex; side must be base|quote; chain and price validated', () => {
  for (const bad of [POOL, '0x' + 'a'.repeat(41), '0x' + 'a'.repeat(39), 'WETH']) assert.ok('error' in parseV4ProbeInput(qs({ token: bad })), bad)
  for (const bad of ['both', '', 'BASE']) assert.ok('error' in parseV4ProbeInput(qs({ side: bad })), bad)
  assert.ok('error' in parseV4ProbeInput(qs({ chain: 'solana' })))
  assert.ok('error' in parseV4ProbeInput(qs({ livePriceUsd: '-1' })))
  const noPrice = parseV4ProbeInput(qs({ livePriceUsd: '' }))
  assert.ok(!('error' in noPrice) && noPrice.livePriceUsd === null)
})

test('hard max 2 provider calls: exactly one per provider, one click', async () => {
  const calls: string[] = []
  const r = await runV4CandleProbe(input(), {
    coingecko: async () => { calls.push('cg'); return ohlcv(100, 1) },
    geckoterminal: async () => { calls.push('gt'); return ohlcv(100, 1) },
  })
  assert.deepEqual(calls.sort(), ['cg', 'gt'])
  assert.equal(r.providerCalls, 2)
  assert.equal(V4_PROBE_MAX_PROVIDER_CALLS, 2)
})

test('CoinGecko result is isolated from GeckoTerminal (success vs 404, and a throw on one side)', async () => {
  const a = await runV4CandleProbe(input(), { coingecko: async () => ohlcv(100, 1, metaFor(TOKEN, WETH)), geckoterminal: async () => ({ httpStatus: 404, json: null }) })
  assert.deepEqual([a.coingecko.httpStatus, a.coingecko.rows, a.coingecko.outcome], [200, 100, 'ok'])
  assert.deepEqual([a.geckoterminal.httpStatus, a.geckoterminal.rows, a.geckoterminal.outcome], [404, 0, 'pool_not_indexed'])
  const b = await runV4CandleProbe(input(), { coingecko: async () => { throw new Error(`boom ${KEY}`) }, geckoterminal: async () => ohlcv(50, 1) })
  assert.deepEqual([b.coingecko.httpStatus, b.coingecko.rows], [null, 0])
  assert.deepEqual([b.geckoterminal.httpStatus, b.geckoterminal.rows], [200, 50])
  assert.equal(b.providerCalls, 2)
})

test('no key => CoinGecko not requested (1 call total), reason shown', async () => {
  const r = await runV4CandleProbe(input(), { coingecko: null, coingeckoSkipReason: 'coingecko_key_not_configured', geckoterminal: async () => ohlcv(10, 1) })
  assert.equal(r.providerCalls, 1)
  assert.deepEqual([r.coingecko.attempted, r.coingecko.skippedReason], [false, 'coingecko_key_not_configured'])
})

test('first/latest close are chronological; identity + price match reported honestly', async () => {
  const r = await runV4CandleProbe(input({ side: 'quote' }), {
    coingecko: async () => ohlcv(100, 1, metaFor(WETH, TOKEN)), // token on quote, as requested
    geckoterminal: async () => ohlcv(100, 3000, metaFor(TOKEN, WETH)), // WETH-priced, token on the OTHER side
  })
  assert.equal(r.coingecko.firstClose, 1 * (1 + 99 / 1000))
  assert.equal(r.coingecko.latestClose, 1 * 1.0)
  assert.deepEqual([r.coingecko.tokenSide, r.coingecko.identityMatched, r.coingecko.priceMatch], ['quote', true, true])
  assert.deepEqual([r.geckoterminal.identityMatched, r.geckoterminal.priceMatch], [false, false])
  const noMeta = await runV4CandleProbe(input(), { coingecko: async () => ohlcv(5, 1), geckoterminal: async () => ohlcv(5, 1) })
  assert.equal(noMeta.coingecko.identityMatched, null, 'no meta => unknown, never assumed')
  const noPrice = await runV4CandleProbe(input({ livePriceUsd: null }), { coingecko: async () => ohlcv(5, 1), geckoterminal: async () => ohlcv(5, 1) })
  assert.equal(noPrice.coingecko.priceMatch, null)
})

test('no secrets, headers, URLs or raw bodies in the response', async () => {
  const r = await runV4CandleProbe(input(), {
    coingecko: async () => ({ httpStatus: 401, json: { error: `invalid key ${KEY}`, headers: { 'x-cg-demo-api-key': KEY } } }),
    geckoterminal: async () => ohlcv(3, 1, metaFor(TOKEN, WETH)),
  })
  const s = JSON.stringify(r)
  assert.doesNotMatch(s, new RegExp(KEY))
  assert.doesNotMatch(s.toLowerCase(), /x-cg-|api_key|apikey|authorization|bearer|https?:\/\/|ohlcv_list/)
  assert.deepEqual(Object.keys(r).sort(), ['chain', 'coingecko', 'geckoterminal', 'livePriceUsd', 'pool', 'providerCalls', 'side', 'token'])
  assert.deepEqual(Object.keys(r.coingecko).sort(), ['attempted', 'firstClose', 'httpStatus', 'identityMatched', 'latestClose', 'outcome', 'priceMatch', 'provider', 'rows', 'skippedReason', 'tokenSide'])
})

test('GeckoTerminal request uses the exact 64-hex PoolId and side, minute/15 x 100, USD', () => {
  assert.equal(geckoTerminalProbePath(input({ side: 'quote' })), `/api/v2/networks/base/pools/${POOL}/ohlcv/minute?aggregate=15&limit=100&currency=usd&token=quote&include_empty_intervals=false`)
  assert.match(geckoTerminalProbePath(input({ chain: 'bnb' })), /^\/api\/v2\/networks\/bsc\//)
})

// ── Route gating (the real handler) ──────────────────────────────────────────────────────────────
test('route: 404 in Production and without debug=1, before any auth or provider work', async () => {
  const { GET } = await import('../app/api/debug/v4-candle-probe/route.ts')
  const prev = process.env.VERCEL_ENV
  try {
    for (const env of [undefined, 'production', 'development']) {
      if (env === undefined) delete process.env.VERCEL_ENV
      else process.env.VERCEL_ENV = env
      const res = await GET(new Request(`https://x.test/api/debug/v4-candle-probe?debug=1&${qs({}).toString()}`))
      assert.equal(res.status, 404, String(env))
    }
    process.env.VERCEL_ENV = 'preview'
    const noDebug = await GET(new Request(`https://x.test/api/debug/v4-candle-probe?${qs({}).toString()}`))
    assert.equal(noDebug.status, 404)
    assert.equal(await noDebug.text(), 'Not available')
  } finally {
    if (prev === undefined) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = prev
  }
})

test('route: auth, rate limit and gate order', () => {
  const src = readFileSync(new URL('../app/api/debug/v4-candle-probe/route.ts', import.meta.url), 'utf8')
  const iPreview = src.indexOf("process.env.VERCEL_ENV !== 'preview'")
  const iDebug = src.indexOf("get('debug') !== '1'")
  const iAuth = src.indexOf('requireAuthenticatedUser(req)')
  const iLimit = src.indexOf('limiter.check(')
  const iRun = src.indexOf('runV4CandleProbe(')
  assert.ok(iPreview > 0 && iPreview < iDebug && iDebug < iAuth && iAuth < iLimit && iLimit < iRun)
  assert.match(src, /createRateLimiter\(\{ windowMs: 60_000, max: 5 \}\)/)
  assert.doesNotMatch(src, /COINGECKO_API_KEY|x-cg-/, 'the key is only ever read inside lib/server/coingeckoOnchainOhlcv.ts')
})

test('button: server shows it only on Preview, for a 64-hex PoolId with a proven side (hidden for 40-hex pools)', () => {
  const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  assert.match(route, /const _v4Probe = process\.env\.VERCEL_ENV === 'preview' && _chartPrimaryPool && EVM_POOL_ID_RE\.test\(_chartPrimaryPool\.address\) && _chartPrimarySide/)
  assert.match(route, /const chartDebug: ChartDebugInfo \| undefined = chartDebugAuthorized \? \{ v4Probe: _v4Probe,/)
  const page = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
  assert.match(page, /const v4Probe = debug\.v4Probe && chain && token \? debug\.v4Probe : null/)
  assert.match(page, /\{v4Probe && \(/)
  assert.match(page, /TEST V4 CANDLES/)
})
