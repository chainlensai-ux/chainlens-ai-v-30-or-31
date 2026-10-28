// Base Radar reliability audit — deterministic regression tests against the REAL /api/radar handler
// (tests/helpers/radarRouteHarness.ts: mocked fetch, no Redis, no network). The route's clock is shifted with
// a Date.now offset so cooldowns and snapshot ages can be exercised without waiting.
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { setScenario, callRadar, gtPool, dsPair, calls, resetCalls, tokenAddr, type Scenario } from './helpers/radarRouteHarness'
import {
  computeRadarBackoffMs, decideRadarProviderBreaker, deriveRadarFeedState, parseRetryAfterMs, radarProviderBreakerOpen,
  shouldRetryWithinRequest, RADAR_AUTH_FAILURE_BACKOFF_MS, RADAR_BACKOFF_BASE_MS, RADAR_BACKOFF_MAX_MS,
  RADAR_LAST_VERIFIED_MAX_AGE_MS, RADAR_LAST_VERIFIED_RETENTION_MS, RADAR_RETRY_AFTER_CAP_MS,
} from '../lib/radarDiscoveryResilience'
import { radarStatTileMode } from '../lib/radarFeedStatus'

// ─── clock + reset ──────────────────────────────────────────────────────────────────────────────
const realNow = Date.now
let offsetMs = 0
Date.now = () => realNow() + offsetMs
const advance = (ms: number) => { offsetMs += ms }

async function reset(opts: { keepBackoff?: boolean; keepLastVerified?: boolean } = {}) {
  await import('../app/api/radar/route')
  const hooks = await import('../lib/server/radarRouteTestHooks')
  hooks.__resetRadarResilienceStateForTest(opts)
  ;(globalThis as { __chainlensGeckoCache?: Map<string, unknown> }).__chainlensGeckoCache?.clear()
  const tc = await import('../lib/server/cache/tokenCache')
  tc.__resetMemoryFallbackForTest?.()
  resetCalls()
}
beforeEach(async () => { offsetMs = 0; await reset() })

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture JSON from the route
type Body = Record<string, any>
const basePools = (ns: number[]) => ns.map(n => { const p = gtPool(n, 'base'); p.pool.relationships.dex.data.id = 'uniswap-v3-base'; return p })
const gtListCalls = () => calls.filter(c => c.kind === 'gt' && /\/networks\/base\/(new_pools|trending_pools|pools)\?/.test(c.url)).length
const audit = (b: Body) => b._debug?.discoveryResilienceAudit
const contracts = (b: Body) => (b.tokens as Body[]).map(t => String(t.contract).toLowerCase())
async function run(s: Scenario, q = 'chain=base&page=1&debug=true') { setScenario(s); return (await callRadar(q)).body as Body }
const HEALTHY: Scenario = { gtPools: { new_pools: basePools([1, 2, 3]), trending_pools: basePools([4]) } }
const ALL_429: Scenario = { gt: { new_pools: 'r429', trending_pools: 'r429', pools: 'r429' } }
/** After the payload cache (≤100s) has expired but well inside every other window. */
const PAST_PAYLOAD_TTL = 2 * 60_000

// ─── pure policy ────────────────────────────────────────────────────────────────────────────────
test('policy: Retry-After parsing (seconds and HTTP date)', () => {
  const now = Date.parse('2026-10-24T12:00:00Z')
  assert.equal(parseRetryAfterMs('120', now), 120_000)
  assert.equal(parseRetryAfterMs(new Date(now + 30_000).toUTCString(), now), 30_000)
  assert.equal(parseRetryAfterMs('soon', now), null)
  assert.equal(parseRetryAfterMs(null, now), null)
})

test('policy: cooldown escalates, honours Retry-After (capped), never hammers 401/403', () => {
  const base = { failureClass: 'provider_rate_limited' as const, status: 429, random: () => 1 }
  assert.equal(computeRadarBackoffMs({ ...base, consecutiveFailures: 1 }), RADAR_BACKOFF_BASE_MS)
  assert.equal(computeRadarBackoffMs({ ...base, consecutiveFailures: 2 }), RADAR_BACKOFF_BASE_MS * 2)
  assert.equal(computeRadarBackoffMs({ ...base, consecutiveFailures: 20 }), RADAR_BACKOFF_MAX_MS)
  assert.equal(computeRadarBackoffMs({ ...base, consecutiveFailures: 1, retryAfterMs: 120_000 }), 120_000)
  assert.equal(computeRadarBackoffMs({ ...base, consecutiveFailures: 1, retryAfterMs: 60 * 60_000 }), RADAR_RETRY_AFTER_CAP_MS)
  assert.equal(computeRadarBackoffMs({ failureClass: 'provider_http_error', status: 403, consecutiveFailures: 1 }), RADAR_AUTH_FAILURE_BACKOFF_MS)
  // jitter only shortens: a first failure never exceeds the base
  for (const r of [0, 0.5, 0.999]) assert.ok(computeRadarBackoffMs({ ...base, consecutiveFailures: 1, random: () => r }) <= RADAR_BACKOFF_BASE_MS)
  assert.equal(shouldRetryWithinRequest('provider_rate_limited'), false)
  assert.equal(shouldRetryWithinRequest('provider_http_error'), false)
  assert.equal(shouldRetryWithinRequest('provider_timeout'), true)
  assert.equal(shouldRetryWithinRequest('provider_5xx'), true)
})

test('policy: provider breaker opens on a mostly-429 or any 401/403 cycle, not on a partial blip', () => {
  const now = 1_000_000
  const p = (status: number | null, ok = false) => ({ attempted: true, status: ok ? 200 : status, backoffUntil: ok ? null : now + 40_000 })
  assert.equal(decideRadarProviderBreaker({ pages: [p(429), p(429), p(200, true), p(429)], previous: null, now })?.reason, 'rate_limited')
  assert.equal(decideRadarProviderBreaker({ pages: [p(429), p(200, true), p(200, true), p(200, true)], previous: null, now }), null)
  assert.equal(decideRadarProviderBreaker({ pages: [p(403), p(200, true)], previous: null, now })?.reason, 'auth_failure')
  assert.equal(decideRadarProviderBreaker({ pages: [{ attempted: false, status: null, backoffUntil: null }], previous: null, now }), null)
  const b = decideRadarProviderBreaker({ pages: [p(429)], previous: null, now })!
  assert.ok(radarProviderBreakerOpen(b, now + 1) && !radarProviderBreakerOpen(b, b.openUntil))
})

test('policy: feed state is honest for every delivery shape', () => {
  const live = { kind: 'live' as const }
  assert.equal(deriveRadarFeedState({ delivery: live, liveTokenCount: 3, primaryPagesOk: 8, primaryPagesTotal: 8, fallbackContributed: false, discoveryDegraded: false }), 'LIVE')
  assert.equal(deriveRadarFeedState({ delivery: live, liveTokenCount: 0, primaryPagesOk: 8, primaryPagesTotal: 8, fallbackContributed: false, discoveryDegraded: false }), 'EMPTY')
  assert.equal(deriveRadarFeedState({ delivery: { kind: 'stale', staleAgeMs: 1 }, liveTokenCount: 0, primaryPagesOk: 0, primaryPagesTotal: 8, fallbackContributed: false, discoveryDegraded: true }), 'STALE')
  assert.equal(deriveRadarFeedState({ delivery: live, liveTokenCount: 2, primaryPagesOk: 0, primaryPagesTotal: 8, fallbackContributed: true, discoveryDegraded: true }), 'DEGRADED')
  assert.equal(deriveRadarFeedState({ delivery: { kind: 'empty_provider_unavailable' }, liveTokenCount: 0, primaryPagesOk: 0, primaryPagesTotal: 8, fallbackContributed: false, discoveryDegraded: true }), 'UNAVAILABLE')
  assert.equal(deriveRadarFeedState({ delivery: live, liveTokenCount: 0, primaryPagesOk: 0, primaryPagesTotal: 8, fallbackContributed: true, discoveryDegraded: true }), 'UNAVAILABLE')
  // tiles never render a failed discovery as a legitimate "0 tokens"
  assert.equal(radarStatTileMode({ loading: false, hasData: true, error: null, feedState: 'UNAVAILABLE' }), 'unavailable')
  assert.equal(radarStatTileMode({ loading: false, hasData: true, error: null, feedState: 'EMPTY' }), 'ready')
})

// ─── 1. primary timeout → fallback ──────────────────────────────────────────────────────────────
test('1. primary discovery timeout → bounded fallback delivers real, freshly re-verified tokens (DEGRADED)', { timeout: 90_000 }, async () => {
  const b = await run({
    gt: { new_pools: 'timeout', trending_pools: 'timeout', pools: 'timeout' },
    dsLists: [{ chainId: 'base', tokenAddress: tokenAddr(5) }],
    dsPairs: [dsPair(5, 'base')],
  })
  assert.equal(b.feedState, 'DEGRADED')
  assert.deepEqual(contracts(b), [tokenAddr(5)])
  assert.equal(audit(b).baseFallback.attempted, true)
  assert.equal(audit(b).pages.find((p: Body) => p.source === 'new_pools').failureClass, 'provider_timeout')
  assert.ok(!b.servedFromStaleCache)
})

// ─── 2. primary 429 → bounded cooldown ─────────────────────────────────────────────────────────
test('2. primary 429 with Retry-After → no in-request retry, cooldown ≥ Retry-After, breaker stops further calls', async () => {
  const b = await run({ ...ALL_429, retryAfterSeconds: 120 })
  // Shared GeckoTerminal cooldown (P0 rate-limit incident): the first wave of 6 pages gets one attempt each
  // (a 429 is not retried inside the request); once GeckoTerminal has refused them, the remaining pages of the
  // cycle are not sent at all.
  assert.equal(gtListCalls(), 6, 'one attempt per page in the first wave, nothing after the provider refused')
  for (const p of audit(b).pages.filter((x: Body) => x.source !== 'dexscreener_supplementary_token')) {
    assert.equal(p.retryAttempt, null)
    assert.ok(Date.parse(p.backoffUntil) - Date.now() >= 119_000, 'cooldown honours Retry-After')
  }
  assert.ok(audit(b).providerBreaker.after, 'mostly-429 cycle opens the provider breaker')
  assert.ok(b.retryAfterMs >= 119_000 && b.retryAfterMs <= RADAR_BACKOFF_MAX_MS)

  resetCalls()
  advance(60_000) // payload cache expired, still inside the ≥120s cooldown
  const b2 = await run({ ...ALL_429, retryAfterSeconds: 120 })
  assert.equal(gtListCalls(), 0, 'while the breaker is open no GeckoTerminal list page is requested')
  assert.equal(audit(b2).providerBreaker.wasOpen, true)
})

// ─── 3. everything down ─────────────────────────────────────────────────────────────────────────
test('3. all discovery providers unavailable → UNAVAILABLE (never a legitimate 0), nothing cached', async () => {
  const b = await run({ gt: { new_pools: 'r500', trending_pools: 'r500', pools: 'r500' }, dsLists: [] })
  assert.equal(b.tokens.length, 0)
  assert.equal(b.feedState, 'UNAVAILABLE')
  assert.equal(b.finalState, 'providerUnavailable')
  assert.equal(b.liveDiscovery, 'delayed')
  assert.match(b.baseRadarLoadAudit.userVisibleError, /temporarily delayed/)
  assert.equal(radarStatTileMode({ loading: false, hasData: true, error: null, feedState: b.feedState }), 'unavailable')
  // 5xx is transient: retried once in-request (bounded), then cooled down
  assert.equal(gtListCalls(), 16)
  // after the cooldown a new request tries again — the failure was not cached as an empty feed
  resetCalls(); advance(5 * 60_000)
  await run({ gt: { new_pools: 'r500', trending_pools: 'r500', pools: 'r500' }, dsLists: [] })
  assert.ok(gtListCalls() > 0)
})

// ─── 4. genuine zero ────────────────────────────────────────────────────────────────────────────
test('4. provider returns a valid zero → EMPTY, never replaced by old cards', async () => {
  await run(HEALTHY) // a last verified feed exists
  advance(PAST_PAYLOAD_TTL)
  resetCalls()
  const b = await run({ gt: { new_pools: 'empty', trending_pools: 'empty', pools: 'empty' } })
  assert.equal(b.feedState, 'EMPTY')
  assert.equal(b.finalState, 'noRawCandidates')
  assert.equal(b.tokens.length, 0)
  assert.ok(!b.servedFromStaleCache, 'a healthy empty market is not papered over with the last verified feed')
  assert.equal(audit(b).baseFallback.attempted, false)
})

// ─── 5. filtered out ────────────────────────────────────────────────────────────────────────────
test('5. valid tokens filtered out by the unchanged gates → EMPTY with allFilteredOut, gates not relaxed', async () => {
  const thin = basePools([7, 8]).map(p => { p.pool.attributes.reserve_in_usd = '900'; return p })
  const b = await run({ gtPools: { new_pools: thin } })
  assert.equal(b.tokens.length, 0)
  assert.equal(b.feedState, 'EMPTY')
  assert.equal(b.finalState, 'allFilteredOut')
  assert.ok(!b.servedFromStaleCache)
})

// ─── 6. snapshot retained ───────────────────────────────────────────────────────────────────────
test('6. failed refresh → last verified snapshot served as STALE with its own timestamp, and not overwritten', async () => {
  const healthy = await run(HEALTHY)
  const verifiedAt = healthy.fetchedAt
  assert.equal(healthy.feedState, 'LIVE')
  advance(10 * 60_000)
  const b = await run({ ...ALL_429, dsLists: [] })
  assert.equal(b.feedState, 'STALE')
  assert.equal(b.servedFromStaleCache, true)
  assert.equal(b.fetchedAt, verifiedAt, 'stale cards keep their original fetchedAt — never relabelled live')
  assert.ok(b.staleAgeMs >= 10 * 60_000)
  assert.deepEqual(contracts(b).sort(), contracts(healthy).sort())
  // a second failed refresh still finds the same snapshot (the failure did not replace it)
  advance(10 * 60_000)
  const b2 = await run({ ...ALL_429, dsLists: [] })
  assert.equal(b2.feedState, 'STALE')
  assert.equal(b2.fetchedAt, verifiedAt)
})

// ─── 7. too old ─────────────────────────────────────────────────────────────────────────────────
test('7. snapshot older than the serving limit is not shown; its tokens are re-verified with fresh data instead', async () => {
  const healthy = await run(HEALTHY)
  advance(RADAR_LAST_VERIFIED_MAX_AGE_MS + 60_000)
  assert.ok(RADAR_LAST_VERIFIED_MAX_AGE_MS + 60_000 < RADAR_LAST_VERIFIED_RETENTION_MS)
  // (a) DexScreener has nothing for those tokens → honest UNAVAILABLE, no old cards
  const none = await run({ ...ALL_429, dsLists: [] })
  assert.equal(none.feedState, 'UNAVAILABLE')
  assert.equal(none.tokens.length, 0)
  assert.ok(!none.servedFromStaleCache)
  assert.ok(audit(none).baseFallback.seeds.lastVerified >= 3, 'the old snapshot still seeds the fallback')
  // (b) DexScreener has fresh pairs for them → DEGRADED, fresh market data, normal gates
  await reset({ keepLastVerified: true })
  const fresh = await run({ ...ALL_429, dsLists: [], dsPairs: [dsPair(1, 'base'), dsPair(2, 'base')] })
  assert.equal(fresh.feedState, 'DEGRADED')
  assert.ok(!fresh.servedFromStaleCache)
  assert.ok(contracts(fresh).every(c => contracts(healthy).includes(c)))
  assert.notEqual(fresh.fetchedAt, healthy.fetchedAt)
})

// ─── 8. coalescing ──────────────────────────────────────────────────────────────────────────────
test('8. concurrent identical requests share one discovery (no upstream burst)', async () => {
  setScenario({ ...HEALTHY, gtDelayMs: 150 }) // responses take time, so the five requests really overlap
  const results = await Promise.all(Array.from({ length: 5 }, () => callRadar('chain=base&page=1')))
  assert.equal(gtListCalls(), 8, 'five simultaneous users → one 8-page discovery, not forty requests')
  const first = contracts(results[0].body as Body)
  for (const r of results) assert.deepEqual(contracts(r.body as Body), first)
})

// ─── 9. manual refresh during an outage ─────────────────────────────────────────────────────────
test('9. manual refresh while the provider is rate limiting cannot bypass the cooldown', async () => {
  await run({ ...ALL_429, retryAfterSeconds: 90 })
  resetCalls()
  advance(30_000)
  const b = await run({ ...ALL_429, retryAfterSeconds: 90 }, 'chain=base&page=1&debug=true&manual=1')
  assert.equal(gtListCalls(), 0)
  assert.notEqual(audit(b).recoveryProbe.outcome, 'attempted', 'no probe into a 429 cooldown')
  // and a burst of manual refreshes stays at zero provider calls
  for (let i = 0; i < 3; i++) await run({ ...ALL_429 }, 'chain=base&page=1&manual=1')
  assert.equal(gtListCalls(), 0)
})

// ─── 10. recovery ───────────────────────────────────────────────────────────────────────────────
test('10. recovery: once the cooldown lapses a healthy provider restores LIVE and clears every cooldown', async () => {
  await run({ ...ALL_429, retryAfterSeconds: 60 })
  advance(RADAR_BACKOFF_MAX_MS + 1_000)
  resetCalls()
  const b = await run(HEALTHY)
  assert.equal(b.feedState, 'LIVE')
  assert.ok(b.tokens.length > 0)
  assert.equal(gtListCalls(), 8)
  assert.equal(audit(b).providerBreaker.after, null)
  // nothing is left cooling down: the next cycle after the payload cache expires fetches normally
  advance(PAST_PAYLOAD_TTL); resetCalls()
  const b2 = await run(HEALTHY)
  assert.equal(gtListCalls(), 8)
  assert.equal(audit(b2).pages.filter((p: Body) => p.failureClass === 'backoff_skip').length, 0)
})

// ─── 11. optional enrichment ────────────────────────────────────────────────────────────────────
test('11. optional enrichment failures (holder provider down, honeypot unavailable) never discard valid discovery', async () => {
  const b = await run({ ...HEALTHY, holdersFail: true })
  assert.ok(b.tokens.length > 0, 'tokens survive a holder-provider outage')
  assert.ok(b.hiddenHolderUnavailable >= 0)
  assert.notEqual(b.feedState, 'UNAVAILABLE')
  assert.equal(b.finalState, 'ok')
})

// ─── 12. stable after recovery ──────────────────────────────────────────────────────────────────
test('12. no duplicated tokens and stable ordering across outage → stale → recovery', async () => {
  const before = await run(HEALTHY)
  advance(5 * 60_000)
  const stale = await run({ ...ALL_429, dsLists: [] })
  assert.equal(stale.feedState, 'STALE')
  advance(RADAR_BACKOFF_MAX_MS + 1_000)
  const after = await run(HEALTHY)
  for (const b of [before, stale, after]) assert.equal(new Set(contracts(b)).size, contracts(b).length, 'no duplicate cards')
  assert.deepEqual(contracts(after), contracts(before), 'same inputs → same order after recovery')
})

// ─── regression for the exact bug found in the audit ───────────────────────────────────────────
test('audit regression: an empty supplementary lookup no longer suppresses the Base fallback', async () => {
  const b = await run({ ...ALL_429, dsLists: [{ chainId: 'base', tokenAddress: tokenAddr(5) }], dsPairs: [dsPair(5, 'base')] })
  assert.equal(audit(b).baseFallback.attempted, true)
  assert.deepEqual(contracts(b), [tokenAddr(5)])
  assert.equal(b.feedState, 'DEGRADED')
})

test('audit regression: a page cached hours earlier is never served as live during an outage', async () => {
  await run(HEALTHY) // fills the per-page cache, the payload cache and the last verified snapshot
  const pages = (globalThis as { __chainlensGeckoCache?: Map<string, { timestamp: number }> }).__chainlensGeckoCache!
  assert.ok(pages.size > 0)
  for (const e of pages.values()) e.timestamp -= 3 * 60 * 60_000 // 3h old: inside the cache's 6h stale retention
  await import('../app/api/radar/route')
  const hooks = await import('../lib/server/radarRouteTestHooks')
  hooks.__resetRadarResilienceStateForTest({}) // payload cache + snapshot gone; only the 3h-old pages remain
  resetCalls()
  const b = await run({ ...ALL_429, dsLists: [] })
  assert.notEqual(b.feedState, 'LIVE')
  assert.equal(b.tokens.length, 0, 'hours-old pages are not rendered as the current feed')
  assert.equal(b.finalState, 'providerUnavailable')
  assert.equal(gtListCalls(), 6, 'and the failing provider is asked once per page, not twice — only for the first wave, before the shared cooldown opens')
})
