// Real POST /api/token handler against fake providers: scan-cache ordering, GeckoTerminal 429
// handling, degraded-result labelling and cache scoping. No network: global fetch is replaced.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { __setAuthTokenVerifierForTest } from '../lib/server/requireAuth'
import { getTokenCache, setTokenCache } from '../lib/server/cache/tokenCache'
import { buildTokenScanCacheKey } from '../lib/tokenScannerChainStrictness'
import { TOKEN_SCAN_RESPONSE_SCHEMA_VERSION } from '../lib/server/tokenPublicResponse'
import { __setGeckoTerminalGuardForTest } from '../lib/server/providers/geckoTerminalGuard'

const WETH = '0x4200000000000000000000000000000000000006'
const token = (n: number) => '0x' + n.toString(16).padStart(40, 'd')
type Mode = 'healthy' | 'rate_limited'
type ScanBody = {
  mode?: string
  noActivePools?: boolean
  marketDataSource?: string
  tokenScannerChainStrictnessAudit?: { cacheHit?: boolean; cacheReadBeforeChainProbe?: boolean }
  primaryMarketProvider?: { status: string; degraded: boolean; note: string | null; rateLimitedCalls: number | null }
}
let mode: Mode = 'healthy'
let gtCalls = 0
const gtPaths: string[] = []

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input instanceof Request ? input.url : input))
  if (url.host === 'api.geckoterminal.com') {
    gtCalls++
    gtPaths.push(url.pathname.replace(/0x[0-9a-f]{40}/gi, '{addr}'))
    if (mode === 'rate_limited') return new Response('{}', { status: 429, headers: { 'retry-after': '20' } })
    const m = url.pathname.match(/networks\/([a-z_]+)\/tokens\/(0x[0-9a-f]{40})\/pools/i)
    if (m) {
      if (m[1] !== 'base') return Response.json({ data: [] })
      const t = m[2].toLowerCase()
      return Response.json({ data: [{ id: `base_0x${'a'.repeat(40)}`, type: 'pool', attributes: { address: `0x${'a'.repeat(40)}`, name: 'TKN / WETH', reserve_in_usd: '250000', base_token_price_usd: '1.25', volume_usd: { h24: '50000' }, price_change_percentage: { h24: '3.1' }, pool_created_at: '2026-01-01T00:00:00Z', fdv_usd: '1250000' }, relationships: { base_token: { data: { id: `base_${t}` } }, quote_token: { data: { id: `base_${WETH}` } }, dex: { data: { id: 'uniswap_v2_base' } } } }] })
    }
    if (/tokens\/0x[0-9a-f]{40}$/i.test(url.pathname)) return Response.json({ data: { attributes: { name: 'Token', symbol: 'TKN', price_usd: '1.25', decimals: 18 } } })
    return Response.json({ data: { attributes: { ohlcv_list: [] } } })
  }
  if (url.host === 'api.dexscreener.com') return Response.json({ pairs: [] })
  return new Response('{}', { status: 503 })
}) as typeof fetch
test.after(() => { globalThis.fetch = realFetch; __setAuthTokenVerifierForTest(null); __setGeckoTerminalGuardForTest(null) })

let uid = 0
__setAuthTokenVerifierForTest((async () => ({ userId: `route-test-${++uid}`, email: 'route-test@example.com', plan: 'elite' })) as never)
let ip = 0
const reset = (m: Mode) => {
  mode = m; gtCalls = 0; gtPaths.length = 0
  __setGeckoTerminalGuardForTest({ kv: { configured: () => false, get: async () => null, set: async () => undefined }, log: () => undefined })
}
async function scan(contract: string, chain = 'base', extra: Record<string, unknown> = {}) {
  const { POST } = await import('../app/api/token/route')
  const res = await POST(new Request('http://localhost/api/token', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test', 'x-forwarded-for': `10.9.${Math.floor(++ip / 250)}.${ip % 250}` }, body: JSON.stringify({ contract, chain, ...extra }) }))
  return { status: res.status, body: await res.json() as ScanBody }
}

test('a valid cached scan is served before the chain probe: zero GeckoTerminal requests', async () => {
  reset('healthy')
  const t = token(1)
  await setTokenCache(buildTokenScanCacheKey('base', 8453, t), { scanResponseSchemaVersion: TOKEN_SCAN_RESPONSE_SCHEMA_VERSION, chain: 'base', contract: t, status: 'ok', priceUsd: 1.25 }, 45)
  const r = await scan(t)
  assert.equal(r.status, 200)
  assert.equal(r.body.tokenScannerChainStrictnessAudit?.cacheHit, true)
  assert.equal(r.body.tokenScannerChainStrictnessAudit?.cacheReadBeforeChainProbe, true)
  assert.equal(gtCalls, 0)
})

test('cache entries never cross chains, schema versions or clark fast mode', async () => {
  const t = token(2)
  await setTokenCache(buildTokenScanCacheKey('base', 8453, t), { scanResponseSchemaVersion: TOKEN_SCAN_RESPONSE_SCHEMA_VERSION, chain: 'base', contract: t, status: 'ok', priceUsd: 9 }, 45)
  reset('healthy')
  const eth = await scan(t, 'eth')
  assert.notEqual(eth.body.tokenScannerChainStrictnessAudit?.cacheHit, true, 'a Base entry is never served for Ethereum')
  assert.ok(gtCalls > 0, 'the Ethereum request ran its own probe')

  const old = token(3)
  await setTokenCache(buildTokenScanCacheKey('base', 8453, old), { scanResponseSchemaVersion: TOKEN_SCAN_RESPONSE_SCHEMA_VERSION - 1, chain: 'base', contract: old, status: 'ok' }, 45)
  reset('healthy')
  const stale = await scan(old)
  assert.notEqual(stale.body.tokenScannerChainStrictnessAudit?.cacheHit, true, 'an older schema version is never served')

  const mismatched = token(4)
  await setTokenCache(buildTokenScanCacheKey('base', 8453, mismatched), { scanResponseSchemaVersion: TOKEN_SCAN_RESPONSE_SCHEMA_VERSION, chain: 'base', contract: token(5), status: 'ok' }, 45)
  reset('healthy')
  const wrong = await scan(mismatched)
  assert.notEqual(wrong.body.tokenScannerChainStrictnessAudit?.cacheHit, true, 'an entry recording another address is never served')

  reset('healthy')
  const fast = await scan(t, 'base', { mode: 'clark_fast' })
  assert.equal(fast.body.mode, 'clark_fast', 'Clark fast mode still runs its own pass')
})

test('a rate-limited scan makes one GeckoTerminal request, is labelled, and its 15s cache copy keeps the label', async () => {
  reset('rate_limited')
  const t = token(6)
  const r = await scan(t)
  assert.equal(r.status, 200)
  assert.equal(gtCalls, 1, `one request, no immediate retry, no probes during the cooldown (got ${gtPaths.join(', ')})`)
  assert.equal(r.body.primaryMarketProvider?.degraded, true)
  assert.equal(r.body.primaryMarketProvider?.status, 'cooling_down')
  assert.equal(r.body.primaryMarketProvider?.rateLimitedCalls, 1)
  assert.match(r.body.primaryMarketProvider?.note ?? '', /rate-limited/)
  const cached = await getTokenCache<ScanBody>(buildTokenScanCacheKey('base', 8453, t))
  assert.equal(cached?.primaryMarketProvider?.degraded, true, 'the cached copy is labelled')

  const again = await scan(t)
  assert.equal(gtCalls, 1, 'the cached copy is reused: no new request')
  assert.equal(again.body.tokenScannerChainStrictnessAudit?.cacheHit, true)
  assert.equal(again.body.primaryMarketProvider?.degraded, true, 'served with its label, never as healthy data')

  const other = await scan(token(7))
  assert.equal(gtCalls, 1, 'another token during the cooldown sends nothing to GeckoTerminal')
  assert.equal(other.body.primaryMarketProvider?.status, 'cooling_down')
})

test('a healthy scan is cached as before and reports the provider as available', async () => {
  reset('healthy')
  const t = token(8)
  const r = await scan(t)
  assert.equal(r.body.primaryMarketProvider?.status, 'available')
  assert.equal(r.body.primaryMarketProvider?.degraded, false)
  assert.equal(r.body.noActivePools, false)
  assert.equal(r.body.marketDataSource, 'primary')
  assert.equal(gtPaths.filter((p) => p.endsWith('/tokens/{addr}/pools')).length, 1, 'pools fetched once (the probe result is reused)')
  const before = gtCalls
  await scan(t)
  assert.equal(gtCalls, before, 'second scan is a cache hit')
})

test('wiring: every covered caller goes through the guard and Base Radar rows no longer preload on scroll', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
  const covered = ['app/api/token/route.ts', 'app/api/token/chart-candles/route.ts', 'lib/server/v4SwapHistoryDeps.ts', 'app/api/radar/route.ts', 'lib/server/trendingTokens.ts', 'app/api/trending/route.ts', 'app/api/ohlcv/route.ts', 'app/api/resolve/route.ts', 'app/api/scan-token/route.ts', 'app/api/liquidity-safety/route.ts', 'app/api/pump-alerts/route.ts', 'app/api/whale-alerts/route.ts', 'app/api/proxy/gt/route.ts', 'app/api/debug/v4-candle-probe/route.ts']
  for (const file of covered) {
    const src = read(file)
    assert.match(src, /geckoTerminalFetch\(/, file)
    // No direct fetch() whose first argument is a GeckoTerminal URL literal or GT base variable.
    assert.doesNotMatch(src, /[^a-zA-Z]fetch\(\s*[`'"]https:\/\/api\.geckoterminal\.com/, `${file}: direct GeckoTerminal fetch`)
    assert.doesNotMatch(src, /[^a-zA-Z]fetch\(\s*`\$\{(GT|_gtBase|_gtBaseV4|GT_BASE_URL|base)\}/, `${file}: direct GeckoTerminal fetch`)
  }
  const hook = read('lib/useDrawerPreload.ts')
  assert.doesNotMatch(hook, /IntersectionObserver/)
  assert.match(hook, /HOVER_INTENT_MS = 150/)
  const radar = read('app/terminal/base-radar/page.tsx')
  assert.doesNotMatch(radar, /registerPreloadTarget/)
  assert.match(radar, /onMouseEnter=\{\(\) => \{ preloadOnHover\(\); onPreload\(\) \}\}/)
  assert.match(radar, /onFocus=\{\(\) => \{ preload\(\); onPreload\(\) \}\}/)
  assert.doesNotMatch(read('app/terminal/watchlist/page.tsx'), /registerPreloadTarget/)
})
