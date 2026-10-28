// Deterministic before/after simulation of GeckoTerminal usage (see tests/sim/gtRateLimitSim.ts).
// Fake clock, fake providers, fake KV; the "after" path runs the real guard.
import assert from 'node:assert/strict'
import test from 'node:test'
import { baseRadarScenario, cacheExpiryScenario, chartDuringCooldownScenario, DEFAULT_CONFIG, summarize, tokenScannerScenario, type SimConfig } from './sim/gtRateLimitSim'

const run = async (f: (c: SimConfig) => Promise<Parameters<typeof summarize>[0]>, over: Partial<SimConfig> = {}) => ({
  before: summarize(await f({ ...DEFAULT_CONFIG, ...over, variant: 'before' })),
  after: summarize(await f({ ...DEFAULT_CONFIG, ...over, variant: 'after' })),
})

test('the simulation is deterministic', async () => {
  const a = summarize(await baseRadarScenario({ ...DEFAULT_CONFIG, variant: 'after' }, 10))
  const b = summarize(await baseRadarScenario({ ...DEFAULT_CONFIG, variant: 'after' }, 10))
  assert.deepEqual(a, b)
})

test('Token Scanner, one token, 1/10/50/100 users: never more requests, no 429 storm, no unlabelled degraded data', async () => {
  for (const users of [1, 10, 50, 100]) {
    const { before, after } = await run((c) => tokenScannerScenario(c, users, true))
    assert.ok(after.gtRequests <= before.gtRequests, `${users}u requests`)
    assert.ok(after.gt429 <= before.gt429, `${users}u 429s`)
    assert.equal(after.degradedServedUnlabelled, 0)
    assert.ok(after.primaryMarketRate >= before.primaryMarketRate, `${users}u primary data`)
    assert.ok((after.scanP95 ?? 0) <= (before.scanP95 ?? 0), `${users}u p95 latency`)
  }
  const { before, after } = await run((c) => tokenScannerScenario(c, 100, true))
  assert.ok(before.degradedServedUnlabelled > 0, 'before: rate-limited "no pool" results were cached and served as healthy')
  assert.equal(after.gt429, 0)
})

test('Token Scanner, different tokens competing for one quota: 429s collapse, primary data share is kept', async () => {
  for (const users of [1, 10, 50, 100]) {
    const { before, after } = await run((c) => tokenScannerScenario(c, users, false))
    assert.ok(after.gtRequests <= before.gtRequests, `${users}u requests`)
    assert.ok(after.gt429 <= Math.max(before.gt429 * 0.05, 0), `${users}u 429s ${after.gt429} vs ${before.gt429}`)
    assert.ok(after.primaryMarketRate >= before.primaryMarketRate - 2, `${users}u primary ${after.primaryMarketRate} vs ${before.primaryMarketRate}`)
    assert.ok((after.scanP95 ?? 0) <= (before.scanP95 ?? 0), `${users}u p95`)
  }
})

test('429 without Retry-After: bounded escalation keeps the primary data share', async () => {
  const { before, after } = await run((c) => tokenScannerScenario(c, 50, false), { retryAfter: false })
  assert.ok(after.gt429 < before.gt429 / 50)
  assert.ok(after.primaryMarketRate >= before.primaryMarketRate - 2, `${after.primaryMarketRate} vs ${before.primaryMarketRate}`)
})

test('Base Radar browsing, 1/10/50/100 users: far fewer upstream requests and 429s, more primary data', async () => {
  for (const users of [1, 10, 50, 100]) {
    const { before, after } = await run((c) => baseRadarScenario(c, users))
    assert.ok(after.gtRequests < before.gtRequests / 5, `${users}u requests ${after.gtRequests} vs ${before.gtRequests}`)
    assert.ok(after.gt429 < before.gt429 / 10 || before.gt429 === 0, `${users}u 429s`)
    assert.ok(after.primaryMarketRate >= before.primaryMarketRate - 5, `${users}u primary`)
    assert.equal(after.degradedServedUnlabelled, 0)
    assert.equal(after.drawerOpens, before.drawerOpens)
  }
})

test('Base Radar drawer data latency: measured, bounded by one scan', async () => {
  const one = await run((c) => baseRadarScenario(c, 1))
  // Viewport preloading had already scanned the opened row; intent-only preloading starts 650ms earlier
  // than the click (800ms rest - 150ms intent), so the remaining wait is under one 1.8s scan.
  assert.equal(one.before.drawerP50, 0)
  assert.ok((one.after.drawerP95 ?? Infinity) < 1_800)
  const ten = await run((c) => baseRadarScenario(c, 10))
  assert.ok((ten.after.drawerP95 ?? Infinity) <= (ten.before.drawerP95 ?? 0), 'under load the tail improves')
  assert.ok(ten.after.drawerDegraded < ten.before.drawerDegraded, 'fewer drawers open on rate-limited data')
})

test('expensive scans (GoldRush/Honeypot load) never exceed the original, even at 100 Base Radar users', async () => {
  for (const users of [10, 50, 100]) {
    const c = (variant: SimConfig['variant']) => ({ ...DEFAULT_CONFIG, variant })
    const before = summarize(await baseRadarScenario(c('before'), users))
    const p0 = summarize(await baseRadarScenario(c('p0'), users))
    const after = summarize(await baseRadarScenario(c('after'), users))
    assert.ok(after.fullScans <= before.fullScans, `${users}u full scans ${after.fullScans} vs before ${before.fullScans}`)
    assert.ok(after.fullScans <= p0.fullScans, `${users}u full scans ${after.fullScans} vs p0 ${p0.fullScans}`)
    assert.ok(after.goldrushRequests <= before.goldrushRequests && after.honeypotRequests <= before.honeypotRequests)
    assert.equal(after.degradedServedUnlabelled, 0)
    assert.ok((after.drawerFirstP95 ?? Infinity) <= (after.drawerP95 ?? Infinity), 'the preview never delays the drawer')
  }
  const kvDown = { before: summarize(await baseRadarScenario({ ...DEFAULT_CONFIG, kvUp: false, variant: 'before' }, 100)), after: summarize(await baseRadarScenario({ ...DEFAULT_CONFIG, kvUp: false, variant: 'after' }, 100)) }
  assert.ok(kvDown.after.fullScans <= kvDown.before.fullScans, 'KV down: per-instance dedupe still keeps full scans at or below the original')
  const same = summarize(await tokenScannerScenario({ ...DEFAULT_CONFIG, variant: 'after' }, 100, true))
  assert.equal(same.fullScans, 2, '100 users on one token: concurrent requests share scans')
  assert.ok(same.sharedWaits > 0)
})

test('KV unavailable: per-instance cooldowns still collapse the request volume', async () => {
  const radar = await run((c) => baseRadarScenario(c, 10), { kvUp: false })
  assert.ok(radar.after.gtRequests < radar.before.gtRequests / 5)
  assert.ok(radar.after.gt429 < radar.before.gt429 / 20)
  const tok = await run((c) => tokenScannerScenario(c, 50, false), { kvUp: false })
  assert.ok(tok.after.gt429 < tok.before.gt429 / 20)
})

test('DexScreener fallback: market availability is unchanged by the cooldown', async () => {
  const up = await run((c) => tokenScannerScenario(c, 50, false))
  assert.equal(up.after.marketUnavailable, 0)
  assert.equal(up.before.marketUnavailable, 0)
  const down = await run((c) => tokenScannerScenario(c, 50, false), { dexscreenerUp: false })
  assert.ok(Math.abs(down.after.marketUnavailable - down.before.marketUnavailable) <= 2, `${down.after.marketUnavailable} vs ${down.before.marketUnavailable}`)
})

test('cache expiry: rescans after the 45s TTL refetch; the cache read no longer costs a probe', async () => {
  const { before, after } = await run((c) => cacheExpiryScenario(c))
  assert.equal(after.scanCacheHitRate, before.scanCacheHitRate, 'same freshness: hits and misses at the same times')
  assert.equal(after.gtRequests, before.gtRequests - 3, 'three cache hits no longer pay a probe each')
})

test('chart requests during a shared cooldown never reach GeckoTerminal', async () => {
  const { before, after } = await run((c) => chartDuringCooldownScenario(c))
  assert.equal(before.chartUpstream, 10)
  assert.equal(after.chartUpstream, 0)
  assert.equal(after.chartRequests, 10)
})
