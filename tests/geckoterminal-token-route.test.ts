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
type Mode = 'healthy' | 'rate_limited' | 'not_found'
type ScanBody = {
  mode?: string
  noActivePools?: boolean
  marketDataSource?: string
  tokenScannerChainStrictnessAudit?: { cacheHit?: boolean; cacheReadBeforeChainProbe?: boolean }
  primaryMarketProvider?: { status: string; degraded: boolean; note: string | null; rateLimitedCalls: number | null }
  poolEvidenceStatus?: string
  riskScore?: number | null
  marketStatus?: string
  aiSummary?: string
  lpExitRiskReason?: string
  riskEngine?: { trendIntelligence?: { stage: string; confidence: string; note: string }; lpIntelligence?: { status: string; note: string } }
}
let mode: Mode = 'healthy'
let gtCalls = 0
let goldrushCalls = 0
const gtPaths: string[] = []
let plan: 'free' | 'pro' | 'elite' = 'elite'

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input instanceof Request ? input.url : input))
  if (url.host === 'api.geckoterminal.com') {
    gtCalls++
    gtPaths.push(url.pathname.replace(/0x[0-9a-f]{40}/gi, '{addr}'))
    if (mode === 'rate_limited') return new Response('{}', { status: 429, headers: { 'retry-after': '20' } })
    if (mode === 'not_found') return new Response('{}', { status: 404 })
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
  if (url.host === 'api.covalenthq.com') goldrushCalls++
  return new Response('{}', { status: 503 })
}) as typeof fetch
test.after(() => { globalThis.fetch = realFetch; __setAuthTokenVerifierForTest(null); __setGeckoTerminalGuardForTest(null) })

let uid = 0
__setAuthTokenVerifierForTest((async () => ({ userId: `route-test-${++uid}`, email: 'route-test@example.com', plan })) as never)
let ip = 0
const reset = (m: Mode) => {
  mode = m; gtCalls = 0; goldrushCalls = 0; gtPaths.length = 0; plan = 'elite'
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

test('a rate-limited scan makes one GeckoTerminal request, is labelled, and its cached copy keeps the label', async () => {
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

test('GeckoTerminal unavailable is never treated as verified absence of pools; risk score unchanged', async () => {
  reset('not_found')
  const absent = await scan(token(20))
  reset('rate_limited')
  const unknown = await scan(token(21))
  // Verified absence (provider answered 404): unchanged behaviour.
  assert.equal(absent.body.noActivePools, true)
  assert.equal(absent.body.poolEvidenceStatus, 'none_found')
  assert.equal(absent.body.marketStatus, 'no_pool_found')
  // Provider unavailable: no claim of absence, dormancy or illiquidity; open checks say why.
  assert.equal(unknown.body.noActivePools, false)
  assert.equal(unknown.body.poolEvidenceStatus, 'provider_unavailable')
  assert.equal(unknown.body.marketStatus, 'error')
  assert.notEqual(unknown.body.riskEngine?.trendIntelligence?.stage, 'dormant')
  assert.equal(unknown.body.riskEngine?.trendIntelligence?.confidence, 'low')
  assert.match(unknown.body.riskEngine?.trendIntelligence?.note ?? '', /unavailable from the provider/)
  assert.notEqual(unknown.body.riskEngine?.lpIntelligence?.status, 'not_applicable')
  assert.match(unknown.body.lpExitRiskReason ?? '', /unavailable from the market data provider/)
  assert.doesNotMatch(unknown.body.aiSummary ?? '', /no active trading pools/i)
  assert.match(unknown.body.aiSummary ?? '', /unverified, not absent/)
  // The score is neither safer nor riskier than with verified absence: missing market data stays an open check.
  assert.equal(unknown.body.riskScore, absent.body.riskScore)
})

test('a degraded cached scan is reused only during the cooldown or for 15s, never as fresh evidence', async () => {
  reset('rate_limited')
  const t = token(22)
  await scan(t)
  const key = buildTokenScanCacheKey('base', 8453, t)
  const entry = await getTokenCache<Record<string, unknown>>(key)
  assert.ok(entry)
  // 20s old, cooldown still active (Retry-After 20s): reused, labelled.
  await setTokenCache(key, { ...entry, scanRequestStartedAt: Date.now() - 20_000 }, 45)
  const during = await scan(t)
  assert.equal(during.body.tokenScannerChainStrictnessAudit?.cacheHit, true)
  assert.equal(during.body.primaryMarketProvider?.degraded, true)
  // Cooldown over (fresh guard) and the entry is 20s old: a new scan runs instead of reusing it.
  reset('healthy')
  const after = await scan(t)
  assert.notEqual(after.body.tokenScannerChainStrictnessAudit?.cacheHit, true)
  assert.equal(after.body.primaryMarketProvider?.status, 'available')
  assert.ok(gtCalls > 0)
})

test('concurrent requests for one token share a single scan (no repeated GoldRush/Honeypot work)', async () => {
  reset('healthy')
  const t = token(23)
  const first = scan(t)
  await new Promise((r) => setTimeout(r, 30))
  const second = scan(t)
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.status, 200)
  assert.equal(b.body.tokenScannerChainStrictnessAudit?.cacheHit, true, 'the second request waited for the first and was served its result')
  assert.equal(gtPaths.filter((p) => p.endsWith('/tokens/{addr}/pools')).length, 1)
  const oneScanGoldrush = goldrushCalls
  reset('healthy')
  await scan(token(24))
  assert.equal(goldrushCalls, oneScanGoldrush, 'two concurrent requests cost the GoldRush requests of one scan')
})

test('drawer cache-only preview: existing scan shown with no provider call, plan gate applied, null when nothing cached', async () => {
  reset('healthy')
  const t = token(25)
  await scan(t)
  const { GET } = await import('../app/api/base-radar/enrichment/route')
  const preview = async (contract: string, auth = true) => {
    const res = await GET(new Request(`http://localhost/api/base-radar/enrichment?contract=${contract}&chain=base&cacheOnly=1`, { headers: auth ? { authorization: 'Bearer test' } : {} }))
    return { status: res.status, body: await res.json() as { preview?: { source?: string; ageSec?: number | null } | null; market?: { liquidityUsd?: number | null } } }
  }
  const before = { gt: gtCalls, gr: goldrushCalls }
  const hit = await preview(t)
  assert.equal(hit.status, 200)
  assert.equal(hit.body.preview?.source, 'token_scan_cache')
  assert.ok(typeof hit.body.preview?.ageSec === 'number')
  assert.equal(hit.body.market?.liquidityUsd ?? null, 250000)
  assert.deepEqual({ gt: gtCalls, gr: goldrushCalls }, before, 'no provider request for a preview')
  const miss = await preview(token(26))
  assert.deepEqual(miss.body, { preview: null })
  assert.deepEqual({ gt: gtCalls, gr: goldrushCalls }, before)
  assert.equal((await preview(t, false)).status, 401)
  plan = 'free'
  const free = await preview(t)
  assert.equal(free.body.preview?.source, 'token_scan_cache', 'free users get the plan-gated cached scan')
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
