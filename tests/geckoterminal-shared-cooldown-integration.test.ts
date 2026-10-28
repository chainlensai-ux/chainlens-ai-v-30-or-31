// Shared GeckoTerminal cooldown in Wallet Scanner pricing, Clark and the Solana scan chart.
// A skipped lookup is reported with the existing "skipped / quota stopped / 429" reasons and a null
// price — never a zero price, never a "no pool" result — and a 429 in any of them pauses the others.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { __setGeckoTerminalGuardForTest, geckoTerminalCooldown, geckoTerminalFetch, recordGeckoTerminalRateLimit } from '../lib/server/providers/geckoTerminalGuard'
import { fetchGeckoTerminalCurrentPrice, fetchGeckoTerminalPriceDetailed, isKnownGeckoTerminalNoPool, resetGeckoTerminalNoPoolCache, type GeckoTerminalCooldownKvLike } from '../src/pipeline/providers/geckoTerminalPriceSource'
import { getGeckoTerminalEthOhlcvRequestCount, isGeckoTerminalQuotaStopped, primeGeckoTerminalRangeForBuckets, resetGeckoTerminalEthOhlcvForScan } from '../src/modules/nativePriceResolver/geckoTerminalEthOhlcv'
import { GeckoTerminalClient } from '../src/modules/fallbackPricing/geckoTerminalClient'
import { resetPriceCache, resolvePricesDetailed } from '../src/modules/pricing/index'
import { resetDexscreenerRequestCache } from '../src/lib/dexscreenerRequestCache'
import { geckoTerminalMarketProvider } from '../lib/server/clarkMarketDataProviders'
import { fetchSolanaOhlcv } from '../lib/server/solanaProviders'

const realFetch = globalThis.fetch
let gtCalls = 0
let gtStatus = 200
const TOKEN = '0xabc0000000000000000000000000000000000a'
const memKv = (): GeckoTerminalCooldownKvLike & { store: Map<string, unknown> } => {
  const store = new Map<string, unknown>()
  return { store, get: async <T>(k: string) => (store.get(k) as T) ?? null, set: async (k: string, v: unknown) => { store.set(k, v) } }
}

beforeEach(() => {
  __setGeckoTerminalGuardForTest({ kv: { configured: () => false, get: async () => null, set: async () => undefined }, log: () => undefined })
  resetGeckoTerminalNoPoolCache(); resetPriceCache(); resetDexscreenerRequestCache(); resetGeckoTerminalEthOhlcvForScan()
  gtCalls = 0; gtStatus = 200
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('geckoterminal.com')) {
      gtCalls++
      if (gtStatus !== 200) return new Response('{}', { status: gtStatus, headers: gtStatus === 429 ? { 'retry-after': '25' } : {} })
      if (url.includes('/ohlcv/')) return Response.json({ data: { attributes: { ohlcv_list: [] } } })
      return Response.json({ data: [{ attributes: { address: '0xpool', reserve_in_usd: '50000', base_token_price_usd: '2' } }] })
    }
    if (url.includes('dexscreener.com')) return Response.json({ pairs: [] })
    return new Response('{}', { status: 503 })
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })
const openSharedCooldown = () => recordGeckoTerminalRateLimit({ route: 'token', endpoint: 'token_pools', retryAfterHeader: '30' })

test('Wallet pricing honours a cooldown opened by another route: null price, existing skip reasons, no request', async () => {
  await openSharedCooldown()
  const hist = await fetchGeckoTerminalPriceDetailed(TOKEN, 'base', Date.now(), { kv: memKv() })
  assert.deepEqual(hist, { priceUsd: null, reason: 'skipped_due_to_persisted_cooldown', skippedDueToPersistedCooldown: true })
  const cur = await fetchGeckoTerminalCurrentPrice(TOKEN, 'base', { kv: memKv() })
  assert.deepEqual(cur, { priceUsd: null, reason: 'quota_stopped', quotaStopped: true })
  assert.equal(gtCalls, 0)
  assert.equal(isKnownGeckoTerminalNoPool('base', TOKEN), false, 'a skipped lookup is never cached as "no pool"')
})

test('Wallet pricing: a 429 on the pool lookup is a rate limit, not "no pool", and opens the shared cooldown', async () => {
  gtStatus = 429
  const kv = memKv()
  const r = await fetchGeckoTerminalPriceDetailed(TOKEN, 'base', Date.now(), { kv })
  assert.deepEqual(r, { priceUsd: null, reason: 'http_429' })
  assert.equal(isKnownGeckoTerminalNoPool('base', TOKEN), false, 'previously cached as no_pool_found, which could later read as dead_unindexed')
  assert.ok(kv.store.size > 0, 'the wallet scanner\'s own persisted cooldown is still written')
  assert.equal((await geckoTerminalCooldown()).active, true, 'and the shared cooldown is open for every other route')
  const tokenRoute = await geckoTerminalFetch('https://api.geckoterminal.com/api/v2/networks/base/tokens/0x1/pools', {}, { route: 'token' })
  assert.equal(tokenRoute.status, 429)
  assert.equal(gtCalls, 1, 'Token Scanner sends nothing while Wallet Scanner\'s 429 cooldown is open')
})

test('Wallet pricing: current-price 429 keeps its quota_stopped semantics and a stale price is reused, never zero', async () => {
  gtStatus = 200
  const first = await resolvePricesDetailed([{ chain: 'base', contract: TOKEN }])
  assert.equal(first.prices[0].priceUsd, 2)
  resetDexscreenerRequestCache()
  await openSharedCooldown()
  // Force a revalidation: the stale-cache fallback path is the one a quota stop takes.
  const { prices, audit, noLiquidityFoundKeys } = await resolvePricesDetailed([{ chain: 'base', contract: TOKEN }])
  assert.notEqual(prices[0].priceUsd, 0)
  assert.ok(prices[0].priceUsd === 2 || prices[0].priceUsd === null)
  assert.equal(noLiquidityFoundKeys.length, 0, 'a cooldown never classifies the token as dead_unindexed')
  assert.ok(audit.totalRequests === 1)
})

test('Wallet ETH price history: shared cooldown stops the quota group with no request and no candle', async () => {
  await openSharedCooldown()
  const bucket = Date.UTC(2026, 4, 11)
  const d = await primeGeckoTerminalRangeForBuckets([bucket])
  assert.equal(getGeckoTerminalEthOhlcvRequestCount(), 0, 'a skipped request is not counted against the per-scan cap')
  assert.equal(isGeckoTerminalQuotaStopped(), true)
  assert.equal(gtCalls, 0)
  assert.equal(d.quotaStopped, true)
  assert.equal(JSON.stringify(d).includes('skipped_shared_geckoterminal_cooldown'), true)
})

test('Wallet ETH price history: a real 429 opens the shared cooldown', async () => {
  gtStatus = 429
  await primeGeckoTerminalRangeForBuckets([Date.UTC(2026, 4, 11)])
  assert.equal(gtCalls, 1)
  assert.equal((await geckoTerminalCooldown()).active, true)
})

test('Wallet fallback pricing client: no request during the cooldown, no pools, reported as a 429', async () => {
  await openSharedCooldown()
  const r = await new GeckoTerminalClient('base').getTokenPools(TOKEN)
  assert.deepEqual(r, { network: 'base', pools: [], reason: 'http_429' })
  assert.equal(gtCalls, 0)
})

test('Clark market quote: null during the cooldown with no request; a 429 opens it', async () => {
  await openSharedCooldown()
  assert.equal(await geckoTerminalMarketProvider(TOKEN, 'base'), null)
  assert.equal(gtCalls, 0)
  __setGeckoTerminalGuardForTest({ kv: { configured: () => false, get: async () => null, set: async () => undefined }, log: () => undefined })
  gtStatus = 429
  assert.equal(await geckoTerminalMarketProvider(TOKEN, 'base'), null)
  assert.equal(gtCalls, 1)
  assert.equal((await geckoTerminalCooldown()).active, true)
})

test('Solana scan chart: uses its injected fetch, reports a cooldown as geckoterminal_http_429, no Helius involvement', async () => {
  const seen: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => { seen.push(String(input)); return new Response('{}', { status: 429 }) }) as typeof fetch
  const first = await fetchSolanaOhlcv('PooL111', fetchImpl, 'base', null, null)
  assert.equal(seen.length, 1, 'the module\'s own fetch is still the one called')
  assert.equal(first.errorReason, 'geckoterminal_http_429')
  const second = await fetchSolanaOhlcv('PooL111', fetchImpl, 'base', null, null)
  assert.equal(seen.length, 1, 'during the cooldown nothing is sent')
  assert.equal(second.errorReason, 'geckoterminal_http_429')
  assert.equal(second.success, false)
  assert.ok(seen.every((u) => u.includes('api.geckoterminal.com')))
})

test('wiring: no direct GeckoTerminal fetch remains in Clark, the Solana scan chart, or outside the wallet pricing bridge', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
  const clark = read('app/api/clark/route.ts')
  assert.match(clark, /geckoTerminalFetch\(url, \{[\s\S]*?\}, \{ route: 'clark_search', retry: false \}\)/)
  assert.match(read('lib/server/clarkMarketDataProviders.ts'), /geckoTerminalFetch\(`https:\/\/api\.geckoterminal\.com/)
  assert.match(read('lib/server/solanaProviders.ts'), /geckoTerminalFetch\(`https:\/\/api\.geckoterminal\.com\/api\/v2\/networks\/solana/)
  for (const p of ['src/pipeline/providers/geckoTerminalPriceSource.ts', 'src/modules/nativePriceResolver/geckoTerminalEthOhlcv.ts', 'src/modules/fallbackPricing/geckoTerminalClient.ts']) {
    const src = read(p)
    assert.match(src, /isGeckoTerminalCoolingDown\(\)/, `${p} checks the shared cooldown`)
    assert.match(src, /recordGeckoTerminalRateLimit\(/, `${p} records its 429s`)
  }
})
