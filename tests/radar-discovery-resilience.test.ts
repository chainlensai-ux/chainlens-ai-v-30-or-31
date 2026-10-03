import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setScenario, callRadar, gtPool, dsPair, calls, resetCalls, tokenAddr, type Scenario } from './helpers/radarRouteHarness'
import {
  chooseRadarRecoveryProbe, classifyRadarSourceFailure, decideRadarDelivery, decodeRadarBackoff, dexPairsToRadarPools,
  mergeRadarFallbackAddresses, radarDiscoveryBudget, radarRetryAfterMs, v4InitializeTokenAddresses, RADAR_LAST_VERIFIED_MAX_AGE_MS, V4_INITIALIZE_TOPIC0,
} from '../lib/radarDiscoveryResilience'

process.env.BLOCKSCOUT_API_KEY = 'harness-blockscout'
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const NONV4 = { } // GT pools use a non-V4 dex below so GT liquidity is used directly
const rhPools = (ns: number[]) => ns.map(n => { const p = gtPool(n, 'robinhood'); p.pool.relationships.dex.data.id = 'uniswap-v3-robinhood'; return p })
const basePools = (ns: number[]) => ns.map(n => { const p = gtPool(n, 'base'); p.pool.relationships.dex.data.id = 'uniswap-v3-base'; return p })
void NONV4

async function reset(opts: { keepBackoff?: boolean; keepLastVerified?: boolean } = {}) {
  const route = await import('../app/api/radar/route')
  route.__resetRadarResilienceStateForTest(opts)
  ;(globalThis as { __chainlensGeckoCache?: Map<string, unknown> }).__chainlensGeckoCache?.clear()
  const bs = await import('../lib/server/robinhoodBlockscoutEvidence')
  bs.__resetRobinhoodBlockscoutRateLimitForTest()
  const tc = await import('../lib/server/cache/tokenCache')
  tc.__resetMemoryFallbackForTest?.()
  resetCalls()
}
beforeEach(async () => { await reset() })

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture JSON from the route
type Body = Record<string, any>
const gtListCalls = () => calls.filter(c => c.kind === 'gt' && /\/networks\/[^/]+\/(new_pools|trending_pools|pools)\?/.test(c.url))
const gtSupplementaryCalls = () => calls.filter(c => c.kind === 'gt' && /\/tokens\/0x[\da-f]{40}\/pools\?/i.test(c.url))
const audit = (b: Body) => b._debug?.discoveryResilienceAudit
async function run(s: Scenario, q = 'chain=robinhood&page=1&debug=true') { setScenario(s); return (await callRadar(q)).body as Body }

// ─── Pure decisions ─────────────────────────────────────────────────────────────────────────────
test('failure classes are explicit', () => {
  assert.equal(classifyRadarSourceFailure({ status: 429, errorName: 'Error' }), 'provider_rate_limited')
  assert.equal(classifyRadarSourceFailure({ status: null, errorName: 'AbortError' }), 'provider_timeout')
  assert.equal(classifyRadarSourceFailure({ status: 503, errorName: 'Error' }), 'provider_5xx')
  assert.equal(classifyRadarSourceFailure({ status: 404, errorName: 'Error' }), 'provider_http_error')
  assert.equal(classifyRadarSourceFailure({ status: null, errorName: 'TypeError' }), 'network_error')
  assert.equal(classifyRadarSourceFailure({ status: null, errorName: 'backoff_skip', skippedByBackoff: true }), 'backoff_skip')
})

test('backoff records decode legacy numbers and keep their origin', () => {
  assert.deepEqual(decodeRadarBackoff(123), { until: 123, status: null, failureClass: 'unknown', setAt: null })
  assert.equal(decodeRadarBackoff({ until: 5, status: 429, failureClass: 'provider_rate_limited', setAt: 1 })?.failureClass, 'provider_rate_limited')
  assert.equal(decodeRadarBackoff(null), null)
  assert.equal(decodeRadarBackoff({ status: 1 }), null)
})

test('Robinhood spends half of Base\'s GeckoTerminal budget; gates are not part of the budget', () => {
  const b = radarDiscoveryBudget('base'), r = radarDiscoveryBudget('robinhood')
  assert.equal(b.newPoolsPages + b.trendingPages + b.volumePages, 8)
  assert.equal(r.newPoolsPages + r.trendingPages + r.volumePages, 4)
})

test('recovery probe: manual only, all primary cooling down, never after a 429', () => {
  const now = 1000
  const keys = ['a', 'b']
  const rec = (failureClass: string, status: number | null) => ({ until: 5000, status, failureClass: failureClass as never, setAt: 0 })
  assert.equal(chooseRadarRecoveryProbe({ manual: true, primaryKeys: keys, backoffs: { a: rec('provider_5xx', 503), b: rec('provider_timeout', null) }, now }), 'a')
  assert.equal(chooseRadarRecoveryProbe({ manual: false, primaryKeys: keys, backoffs: { a: rec('provider_5xx', 503), b: rec('provider_5xx', 503) }, now }), null)
  assert.equal(chooseRadarRecoveryProbe({ manual: true, primaryKeys: keys, backoffs: { a: rec('provider_5xx', 503), b: null }, now }), null)
  assert.equal(chooseRadarRecoveryProbe({ manual: true, primaryKeys: keys, backoffs: { a: rec('provider_rate_limited', 429), b: rec('provider_5xx', 503) }, now }), null)
})

test('delivery: live wins, healthy-empty stays honest, degraded-empty uses fresh-enough stale only', () => {
  const now = Date.parse('2026-10-03T12:00:00Z')
  const stale = { tokenCount: 3, fetchedAt: new Date(now - 10 * 60_000).toISOString() }
  assert.equal(decideRadarDelivery({ liveTokenCount: 2, discoveryDegraded: true, allSourcesFailed: false, stale, now }).kind, 'live')
  assert.equal(decideRadarDelivery({ liveTokenCount: 0, discoveryDegraded: false, allSourcesFailed: false, stale, now }).kind, 'live')
  assert.equal(decideRadarDelivery({ liveTokenCount: 0, discoveryDegraded: true, allSourcesFailed: true, stale, now }).kind, 'stale')
  assert.equal(decideRadarDelivery({ liveTokenCount: 0, discoveryDegraded: true, allSourcesFailed: true, stale: { ...stale, fetchedAt: new Date(now - RADAR_LAST_VERIFIED_MAX_AGE_MS - 1).toISOString() }, now }).kind, 'empty_provider_unavailable')
  assert.equal(decideRadarDelivery({ liveTokenCount: 0, discoveryDegraded: true, allSourcesFailed: true, stale: null, now }).kind, 'empty_provider_unavailable')
  assert.equal(radarRetryAfterMs([null, now + 15_000, now + 4_000], now, 20_000), 15_000)
  assert.equal(radarRetryAfterMs([null], now, 20_000), null)
})

test('fallback helpers: real addresses only, exact chain only, bounded', () => {
  assert.deepEqual(mergeRadarFallbackAddresses([[tokenAddr(1), 'bad', tokenAddr(1).toUpperCase().replace('0X', '0x')], ['0x0000000000000000000000000000000000000000', tokenAddr(2)]]), [tokenAddr(1), tokenAddr(2)])
  assert.equal(mergeRadarFallbackAddresses([Array.from({ length: 50 }, (_, i) => tokenAddr(i + 1))]).length, 30)
  const pad = (a: string) => `0x${'0'.repeat(24)}${a.slice(2)}`
  const logs = [
    { address: { hash: PM }, topics: [V4_INITIALIZE_TOPIC0, '0x' + 'ab'.repeat(32), pad('0x0000000000000000000000000000000000000000'), pad(tokenAddr(7))] },
    { address: { hash: tokenAddr(9) }, topics: [V4_INITIALIZE_TOPIC0, '0x' + 'ab'.repeat(32), pad(tokenAddr(8)), pad(tokenAddr(9))] },
    { address: { hash: PM }, topics: ['0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f', '0x' + 'cd'.repeat(32)] },
  ]
  assert.deepEqual(v4InitializeTokenAddresses(logs, PM), [tokenAddr(7)])
  const mapped = dexPairsToRadarPools([dsPair(1, 'robinhood'), dsPair(2, 'base'), dsPair(3, 'ethereum')], 'robinhood', [tokenAddr(1), tokenAddr(2), tokenAddr(3)])
  assert.equal(mapped.data.length, 1)
  assert.equal((mapped.included[0] as { attributes: { address: string } }).attributes.address, tokenAddr(1))
})

// ─── Exact-token identity of the DexScreener fallback mapper ────────────────────────────────────
const candidateAddrs = (m: ReturnType<typeof dexPairsToRadarPools>) => m.included.map(t => String((t as { attributes: { address: string } }).attributes.address).toLowerCase())
const baseTokenIdOf = (m: ReturnType<typeof dexPairsToRadarPools>, i: number) => ((m.data[i] as { relationships: { base_token: { data: { id: string } } } }).relationships.base_token.data.id)
const quoteSide = (seed: number, other: number, over: Record<string, unknown> = {}) => dsPair(other, 'robinhood', { quoteToken: { address: tokenAddr(seed), symbol: `TK${seed}` }, ...over })

test('identity: requested token as pair base → accepted, priced by that pair, relationship points at it', () => {
  const m = dexPairsToRadarPools([dsPair(1, 'robinhood')], 'robinhood', [tokenAddr(1)])
  assert.deepEqual(candidateAddrs(m), [tokenAddr(1)])
  assert.equal(baseTokenIdOf(m, 0), `dexfallback_token_${tokenAddr(1)}`)
  assert.equal((m.data[0] as { attributes: { base_token_price_usd: unknown } }).attributes.base_token_price_usd, '0.0015')
  assert.equal(m.audit.accepted, 1)
})

test('identity: requested token only on the quote side → no candidate, unrelated base never promoted, no reciprocal price', () => {
  const m = dexPairsToRadarPools([quoteSide(1, 2)], 'robinhood', [tokenAddr(1)])
  assert.equal(m.data.length, 0)
  assert.ok(!candidateAddrs(m).includes(tokenAddr(2)), 'TOKEN_B must never become a Radar token')
  assert.equal(m.audit.rejected.quoteSideUnpriced, 1)
})

test('identity: requested quote-side token still qualifies through a pair where it is the base', () => {
  const m = dexPairsToRadarPools([quoteSide(1, 2), dsPair(1, 'robinhood', { pairAddress: `0x${'e'.repeat(40)}` })], 'robinhood', [tokenAddr(1)])
  assert.deepEqual(candidateAddrs(m), [tokenAddr(1)])
  assert.equal((m.data[0] as { attributes: { address: string } }).attributes.address, `0x${'e'.repeat(40)}`)
})

test('identity: neither side requested → rejected; wrong chain → rejected', () => {
  const m = dexPairsToRadarPools([dsPair(5, 'robinhood'), dsPair(1, 'base'), dsPair(1, 'ethereum')], 'robinhood', [tokenAddr(1)])
  assert.equal(m.data.length, 0)
  assert.equal(m.audit.rejected.notRequested, 1)
  assert.equal(m.audit.rejected.wrongChain, 2)
})

test('identity: duplicate pairs for one requested token → one record, highest liquidity then lowest pair address', () => {
  const low = dsPair(1, 'robinhood', { pairAddress: `0x${'1'.repeat(40)}`, liquidity: { usd: 90_000 } })
  const high = dsPair(1, 'robinhood', { pairAddress: `0x${'9'.repeat(40)}`, liquidity: { usd: 200_000 } })
  const tieA = dsPair(1, 'robinhood', { pairAddress: `0x${'2'.repeat(40)}`, liquidity: { usd: 200_000 } })
  for (const order of [[low, high, tieA], [tieA, high, low], [high, low, tieA]]) {
    const m = dexPairsToRadarPools(order, 'robinhood', [tokenAddr(1)])
    assert.equal(m.data.length, 1)
    assert.equal((m.data[0] as { attributes: { address: string } }).attributes.address, `0x${'2'.repeat(40)}`, 'deterministic regardless of response order')
    assert.equal(m.audit.rejected.duplicate, 2)
  }
})

test('identity: two requested tokens on opposite sides of one pair → only the base becomes a candidate, never double-counted', () => {
  const both = dsPair(1, 'robinhood', { quoteToken: { address: tokenAddr(2), symbol: 'TK2' } })
  const m = dexPairsToRadarPools([both, both], 'robinhood', [tokenAddr(1), tokenAddr(2)])
  assert.deepEqual(candidateAddrs(m), [tokenAddr(1)])
  assert.equal(m.data.length, 1)
  const reversed = dsPair(2, 'robinhood', { quoteToken: { address: tokenAddr(1), symbol: 'TK1' }, pairAddress: `0x${'d'.repeat(40)}` })
  const m2 = dexPairsToRadarPools([both, reversed], 'robinhood', [tokenAddr(1), tokenAddr(2)])
  assert.deepEqual(candidateAddrs(m2).sort(), [tokenAddr(1), tokenAddr(2)].sort(), 'each token appears once, each priced by a pair where it is the base')
})

test('identity: malformed or missing token / pair addresses are rejected; malformed seeds are ignored', () => {
  const pairs = [
    dsPair(1, 'robinhood', { baseToken: { address: 'not-an-address', symbol: 'X' } }),
    dsPair(1, 'robinhood', { baseToken: undefined }),
    dsPair(1, 'robinhood', { pairAddress: null }),
    null as unknown as Record<string, unknown>,
  ]
  const m = dexPairsToRadarPools(pairs, 'robinhood', [tokenAddr(1), 'garbage', '0x123'])
  assert.equal(m.data.length, 0)
  assert.equal(m.audit.rejected.malformed, 4)
  assert.equal(dexPairsToRadarPools([dsPair(1, 'robinhood')], 'robinhood', ['garbage']).data.length, 0)
})

// ─── Real /api/radar handler, mocked providers ──────────────────────────────────────────────────
test('healthy Robinhood cycle: live feed, 4 GeckoTerminal list pages (Base keeps 8)', async () => {
  const b = await run({ gtPools: { new_pools: rhPools([1, 2, 3]) } })
  assert.ok(b.tokens.length > 0, `expected live tokens, got ${b.tokens.length} (${b.finalState})`)
  assert.equal(b.liveDiscovery, 'live')
  assert.notEqual(b.servedFromStaleCache, true)
  assert.equal(gtListCalls().length, 4)
  assert.ok(gtListCalls().every(c => c.url.includes('/networks/robinhood/')))
  await reset(); resetCalls()
  const base = await run({ gtPools: { new_pools: basePools([1, 2]) } }, 'chain=base&page=1')
  assert.ok(base.tokens.length > 0)
  assert.equal(gtListCalls().length, 8)
})

test('new_pools 429 → other Robinhood sources still deliver a nonzero live feed; class + retry recorded', async () => {
  const b = await run({ gt: { new_pools: 'r429' }, gtPools: { trending_pools: rhPools([4, 5]) } })
  assert.ok(b.tokens.length > 0)
  assert.equal(b.liveDiscovery, 'live')
  const page = audit(b).pages.find((p: Body) => p.source === 'new_pools')
  assert.equal(page.failureClass, 'provider_rate_limited')
  assert.equal(page.firstAttempt.status, 429)
  assert.equal(page.retryAttempt.status, 429)
})

test('one source in cooldown + another succeeds → nonzero feed', async () => {
  await run({ gt: { new_pools: 'r500' }, gtPools: { trending_pools: rhPools([4]) } })
  await reset({ keepBackoff: true }); resetCalls()
  const b = await run({ gtPools: { trending_pools: rhPools([4, 5]) } })
  assert.ok(b.tokens.length > 0)
  const skipped = audit(b).pages.filter((p: Body) => p.failureClass === 'backoff_skip')
  assert.ok(skipped.length >= 1)
  assert.equal(skipped[0].backoffOrigin.failureClass, 'provider_5xx')
  assert.ok(gtListCalls().every(c => !c.url.includes('/new_pools?page=1&')), 'a cooling-down page is not re-requested')
})

test('timeout on new_pools → feed survives through the alternate source', { timeout: 60_000 }, async () => {
  const b = await run({ gt: { new_pools: 'timeout' }, gtPools: { pools: rhPools([6]) } })
  assert.ok(b.tokens.length > 0)
  assert.ok(audit(b).pages.some((p: Body) => p.source === 'new_pools' && p.failureClass === 'provider_timeout'))
})

test('THE SCREENSHOT: all sources fail, refresh lands in cooldown → last verified feed, never a blank', async () => {
  const good = await run({ gtPools: { new_pools: rhPools([1, 2, 3]) } })
  assert.ok(good.tokens.length > 0)
  const goodFetchedAt = good.fetchedAt
  // New instance state for this key (payload + page caches gone), last verified feed kept.
  await reset({ keepLastVerified: true }); resetCalls()
  const failed = await run({ gt: { new_pools: 'r429', trending_pools: 'r429', pools: 'r429' } })
  assert.equal(failed.servedFromStaleCache, true)
  assert.equal(failed.liveDiscovery, 'delayed')
  assert.equal(failed.fetchedAt, goodFetchedAt, 'stale cards keep their original timestamp')
  assert.ok(failed.tokens.length > 0)
  assert.equal(audit(failed).stale.used, true)
  assert.equal(audit(failed).stale.source, 'last_verified_feed')
  // Refresh inside the 20s cooldown: everything is backoff_skip — and the origin is reported.
  await reset({ keepBackoff: true, keepLastVerified: true }); resetCalls()
  const skipped = await run({})
  assert.equal(gtListCalls().length, 0, 'cooldown still protects GeckoTerminal')
  assert.equal(skipped.servedFromStaleCache, true)
  assert.ok(skipped.tokens.length > 0)
  const pages = audit(skipped).pages
  assert.ok(pages.every((p: Body) => p.failureClass === 'backoff_skip'))
  assert.ok(pages.every((p: Body) => p.backoffOrigin.failureClass === 'provider_rate_limited' && p.backoffOrigin.status === 429), 'origin of the cooldown is proven')
  assert.ok(typeof skipped.retryAfterMs === 'number' && skipped.retryAfterMs > 0 && skipped.retryAfterMs <= 20_000)
  assert.match(skipped.publicDiscoveryMessage, /Robinhood market discovery is temporarily delayed\. Showing the latest verified Radar results\./)
})

test('all fail + no stale + no fallback → honest providerUnavailable with public copy only', async () => {
  const b = await run({ gt: { new_pools: 'r500', trending_pools: 'r500', pools: 'r500' } })
  assert.equal(b.tokens.length, 0)
  assert.equal(b.finalState, 'providerUnavailable')
  assert.equal(b.liveDiscovery, 'delayed')
  const msg = b.baseRadarLoadAudit.userVisibleError as string
  assert.equal(msg, 'Robinhood market discovery is temporarily delayed. Retrying automatically.')
  // What the UI renders (userVisibleError + providerErrors) carries no source keys or raw messages.
  assert.doesNotMatch(JSON.stringify(b.baseRadarLoadAudit.providerErrors), /robinhood_new_p\d|market_source_unavailable|cooldown/)
  assert.ok(b.baseRadarLoadAudit.providerErrors.every((e: Body) => typeof e.failureClass === 'string'))
  assert.ok(b._debug.providerErrorsDetail.some((e: Body) => /market_source_unavailable_500/.test(e.errorMessage)), 'exact detail kept in debug')
  // Same refresh without debug: still no internal detail.
  await reset(); resetCalls()
  setScenario({ gt: { new_pools: 'r500', trending_pools: 'r500', pools: 'r500' } })
  const plain = (await callRadar('chain=robinhood&page=1')).body
  assert.equal(plain._debug, undefined)
  assert.doesNotMatch(JSON.stringify(plain), /cooldown until|skipped — |market_source_unavailable/, 'no raw provider messages or cooldown timestamps without debug')
})

test('HTTP 200 empty Robinhood pages: success, no backoff, honest quiet market (no stale substitution)', async () => {
  await run({ gtPools: { new_pools: rhPools([1, 2]) } })
  await reset({ keepLastVerified: true }); resetCalls()
  const b = await run({ gt: { new_pools: 'empty', trending_pools: 'empty', pools: 'empty' } })
  assert.equal(b.finalState, 'noRawCandidates')
  assert.notEqual(b.finalState, 'providerUnavailable')
  assert.equal(b.sourcesFailedCount, 0)
  assert.notEqual(b.servedFromStaleCache, true, 'a healthy empty market is never papered over with old cards')
  assert.equal(b.liveDiscovery, 'live')
  assert.equal(b.baseRadarLoadAudit.userVisibleError, null)
  assert.ok(audit(b).pages.every((p: Body) => p.failureClass === 'genuine_empty_page'))
  await reset({ keepBackoff: true }); resetCalls()
  await run({ gt: { new_pools: 'empty', trending_pools: 'empty', pools: 'empty' } })
  assert.equal(gtListCalls().length, 4, 'empty pages set no cooldown — the next cycle re-requests them')
})

test('deeper Robinhood pages empty after a full page 1 → no failure, no provider-unavailable', async () => {
  const b = await run({ gtPools: { new_pools: rhPools([1, 2, 3]) } })
  assert.equal(b.sourcesFailedCount, 0)
  assert.equal(b.discoveryDegraded, false)
  assert.ok(audit(b).pages.filter((p: Body) => p.page > 1).every((p: Body) => p.ok && p.failureClass === 'genuine_empty_page'))
})

test('total GeckoTerminal outage → non-GeckoTerminal fallback delivers verified Robinhood coins through normal gates', async () => {
  const pad = (a: string) => `0x${'0'.repeat(24)}${a.slice(2)}`
  const b = await run({
    gt: { new_pools: 'r429', trending_pools: 'r429', pools: 'r429' },
    dsLists: [{ chainId: 'robinhood', tokenAddress: tokenAddr(11) }, { chainId: 'base', tokenAddress: tokenAddr(12) }],
    blockscoutLogs: [{ address: { hash: PM }, topics: [V4_INITIALIZE_TOPIC0, '0x' + 'ab'.repeat(32), pad('0x0000000000000000000000000000000000000000'), pad(tokenAddr(13))] }],
    dsPairs: [
      dsPair(11, 'robinhood'),
      dsPair(13, 'robinhood'),
      dsPair(12, 'base'), // wrong chain: must never enter the Robinhood feed
      dsPair(11, 'base', { pairAddress: `0x${'c'.repeat(40)}` }),
      dsPair(14, 'robinhood', { liquidity: { usd: 300 } }),
    ],
  })
  const contracts = (b.tokens as Body[]).map(t => String(t.contract).toLowerCase())
  assert.ok(contracts.includes(tokenAddr(11)), `fallback token missing (${b.finalState}, ${JSON.stringify(audit(b).fallback)})`)
  assert.ok(contracts.includes(tokenAddr(13)), 'V4 PoolManager Initialize seed resolved through DexScreener')
  assert.ok(!contracts.includes(tokenAddr(12)), 'no wrong-chain token')
  assert.ok((b.tokens as Body[]).every(t => t.chainSlug === 'robinhood'))
  const f = audit(b).fallback
  assert.equal(f.attempted, true)
  assert.equal(f.calls.dexscreener, 1)
  assert.ok(f.calls.blockscout <= 1)
  assert.equal(f.poolsOnRequestedChain, 2, 'wrong-chain pairs dropped before gating')
  assert.equal(b.liveDiscovery, 'live')
  assert.notEqual(b.servedFromStaleCache, true)
})

test('fallback candidates still face the normal liquidity gate', async () => {
  const b = await run({
    gt: { new_pools: 'r429', trending_pools: 'r429', pools: 'r429' },
    dsLists: [{ chainId: 'robinhood', tokenAddress: tokenAddr(14) }],
    dsPairs: [dsPair(14, 'robinhood', { liquidity: { usd: 300 } })],
  })
  assert.equal(b.tokens.length, 0)
  assert.equal(audit(b).fallback.poolsOnRequestedChain, 1)
  assert.equal(b._debug.filterFunnel.liquidity_below_minimum >= 1, true)
})

test('no provider-call explosion in a total outage', async () => {
  await run({
    gt: { new_pools: 'r429', trending_pools: 'r429', pools: 'r429' },
    dsLists: [{ chainId: 'robinhood', tokenAddress: tokenAddr(11) }],
    dsPairs: [dsPair(11, 'robinhood')],
  })
  assert.ok(gtListCalls().length <= 8, `GT list attempts ${gtListCalls().length} (4 pages × first try + one retry)`)
  assert.ok(gtSupplementaryCalls().length <= 8, 'existing DexScreener-seeded token lookups stay within their cap of 4 (+ one retry each)')
  assert.ok(calls.filter(c => c.kind === 'ds' && c.url.includes('/latest/dex/tokens/')).length <= 1)
  assert.ok(calls.filter(c => c.kind === 'blockscout').length <= 1)
  resetCalls()
  await reset({ keepBackoff: true, keepLastVerified: true })
  await run({})
  assert.equal(gtListCalls().length, 0, 'the immediate refresh makes zero GeckoTerminal list calls')
})

test('manual refresh: one bounded probe after 5xx cooldowns; none after 429; probe lock shared', async () => {
  await run({ gt: { new_pools: 'r500', trending_pools: 'r500', pools: 'r500' } })
  await reset({ keepBackoff: true }); resetCalls()
  const probed = await run({ gtPools: { new_pools: rhPools([1, 2]) } }, 'chain=robinhood&page=1&debug=true&manual=1')
  assert.equal(gtListCalls().length, 1, 'exactly one page probed')
  assert.equal(audit(probed).recoveryProbe.outcome, 'attempted')
  assert.ok(probed.tokens.length > 0, 'successful probe restores a live feed')
  await reset({ keepBackoff: true }); resetCalls()
  await run({ gtPools: { new_pools: rhPools([1, 2]) } }, 'chain=robinhood&page=1&debug=true&manual=1')
  assert.ok(gtListCalls().some(c => c.url.includes('/new_pools?page=1&')), 'the probed page\'s cooldown was cleared by its success')

  await reset(); resetCalls()
  await run({ gt: { new_pools: 'r429', trending_pools: 'r429', pools: 'r429' } })
  await reset({ keepBackoff: true }); resetCalls()
  const blocked = await run({}, 'chain=robinhood&page=1&debug=true&manual=1')
  assert.equal(gtListCalls().length, 0, '429 cooldowns are never probed')
  assert.equal(audit(blocked).recoveryProbe.outcome, 'not_eligible')
})

test('Base and Robinhood concurrent refresh: each chain only touches its own GeckoTerminal network, budgets hold', async () => {
  setScenario({ gtPools: { new_pools: rhPools([1]) } })
  await Promise.all([callRadar('chain=robinhood&page=1'), callRadar('chain=base&page=1')])
  const rh = gtListCalls().filter(c => c.url.includes('/networks/robinhood/'))
  const base = gtListCalls().filter(c => c.url.includes('/networks/base/'))
  assert.equal(rh.length, 4)
  assert.equal(base.length, 8)
  const route = readFileSync(new URL('../app/api/radar/route.ts', import.meta.url), 'utf8')
  assert.match(route, /await reserveGlobalDiscoveryWaveSlot\(DISCOVERY_WAVE_DELAY_MS\)/, 'shared Base/Robinhood wave pacing is still in the loop')
})

test('route: fallback seed on the quote side never turns its counter-token into a Robinhood Radar card', async () => {
  const b = await run({
    gt: { new_pools: 'r429', trending_pools: 'r429', pools: 'r429' },
    dsLists: [{ chainId: 'robinhood', tokenAddress: tokenAddr(21) }],
    dsPairs: [
      // TOKEN_B (22) as base, requested TOKEN_A (21) as quote — B was never a seed.
      dsPair(22, 'robinhood', { quoteToken: { address: tokenAddr(21), symbol: 'TK21' } }),
    ],
  })
  const contracts = (b.tokens as Body[]).map(t => String(t.contract).toLowerCase())
  assert.ok(!contracts.includes(tokenAddr(22)), 'unrelated base token must never enter the feed')
  assert.equal(audit(b).fallback.pairMapping.rejected.quoteSideUnpriced, 1)
  assert.equal(audit(b).fallback.poolsOnRequestedChain, 0)
})

test('route: every fallback card is one of the exact DexScreener seed addresses and passes the normal gates', async () => {
  const b = await run({
    gt: { new_pools: 'r429', trending_pools: 'r429', pools: 'r429' },
    dsLists: [{ chainId: 'robinhood', tokenAddress: tokenAddr(31) }, { chainId: 'robinhood', tokenAddress: tokenAddr(32) }, { chainId: 'robinhood', tokenAddress: tokenAddr(33) }],
    dsPairs: [
      dsPair(31, 'robinhood'),
      dsPair(32, 'robinhood', { liquidity: { usd: 200 } }),                     // liquidity gate
      dsPair(33, 'robinhood', { marketCap: null, fdv: null }),                   // valuation gate
      dsPair(34, 'robinhood', { quoteToken: { address: tokenAddr(31), symbol: 'TK31' } }), // counter-token of a seed
    ],
  })
  const contracts = (b.tokens as Body[]).map(t => String(t.contract).toLowerCase())
  assert.deepEqual(contracts, [tokenAddr(31)])
  assert.ok(contracts.every(c => [tokenAddr(31), tokenAddr(32), tokenAddr(33)].includes(c)))
  assert.equal(b._debug.filterFunnel.liquidity_below_minimum >= 1, true)
  // Holder gate: the same fallback token with too few holders is hidden.
  await reset(); resetCalls()
  // (fresh token: the route caches holder counts per contract)
  const few = await run({ holders: 5, gt: { new_pools: 'r429', trending_pools: 'r429', pools: 'r429' }, dsLists: [{ chainId: 'robinhood', tokenAddress: tokenAddr(41) }], dsPairs: [dsPair(41, 'robinhood')] })
  assert.equal(few.tokens.length, 0, 'holder floor still applies to fallback candidates')
  // Age window: a pool older than the Radar window is hidden.
  await reset(); resetCalls()
  const old = await run({ gt: { new_pools: 'r429', trending_pools: 'r429', pools: 'r429' }, dsLists: [{ chainId: 'robinhood', tokenAddress: tokenAddr(42) }], dsPairs: [dsPair(42, 'robinhood', { pairCreatedAt: Date.now() - 90 * 24 * 3600_000 })] })
  assert.equal(old.tokens.length, 0, 'age window still applies to fallback candidates')
})
