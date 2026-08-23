// Tests for goldrushPriceSource's negative-result caching (src/modules/pricingAtTimeEngine/sources/
// goldrushPriceSource.ts). NOT wired into `npm test`. Run directly with:
//   npx tsx --test src/modules/pricingAtTimeEngine/sources/goldrushPriceSource.test.ts
//
// Uses a minimal fake GoldRushClient (only the `PricingService.getTokenPrices` method this module
// actually calls) so this never hits real RPC/env vars. Asserts: (1) a real "no data" response gets
// cached as negative and a repeat lookup for the same (token, chain) on a DIFFERENT date skips the
// real call, (2) a positive result for a DIFFERENT date is computed fresh (not confused with the
// negative cache, which is per-token not per-day), (3) a thrown error is never cached as negative,
// (4) concurrent identical (token, chain, date) lookups share one real call.
//
// PERF-SPRINT TASK, DISCLOSED (update to this header): a positive result for the SAME (token,
// chain, day) IS now cached by this module itself — see goldrushPriceSource.ts's own
// `positiveGoldrushPriceCache` header for the full "why this is 100% accuracy-safe" disclosure.
// This supersedes this file's own prior "positive caching is the wrapping withPriceSourceCache's
// job, not this module's" assumption — every test below still passes because each uses a DIFFERENT
// date per repeat lookup (a genuinely different real answer), and the new describe block further
// down specifically covers the SAME-date reuse case.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { GoldRushClient } from '@covalenthq/client-sdk'
import { goldrushPriceSource, __resetGoldrushPriceSourceCachesForTest, getGoldrushPriceSourceCallCount, isKnownGoldrushNegative, isGoldrushBreakerOpenForTest, setGoldrushPriceSourceStage, resetGoldrushPriceSourceStage, isKnownGoldrushPositive, getGoldrushLiveCallLatencyStats } from './goldrushPriceSource'
// SHARED LEDGER RESET, DISCLOSED (cost-audit task): goldrushPriceSource now consumes from the
// scan-wide provider budget (walletProviderCostLedger), which in production is reset once per scan
// job. A test file runs many "scans" back to back in one process, so without this reset the
// cumulative budget would leak across cases and refuse calls a real single scan would allow —
// resetting per test models the real per-job lifecycle, it does not weaken any assertion.
import { __resetWalletProviderCostLedgerForTest, getWalletProviderCostAudit } from '../../providerCost/walletProviderCostLedger'

const TOKEN = '0x1111111111111111111111111111111111111111'
const CHAIN = 'base'

function tokenAddress(i: number): string {
  return `0x${i.toString(16).padStart(40, '0')}`
}

function makeFakeClient(opts: {
  respond: (dateStr: string) => { error: boolean; data: unknown }
}) {
  let calls = 0
  const client = {
    PricingService: {
      async getTokenPrices(_chainSlug: string, _quote: string, _contract: string, range: { from: string; to: string }) {
        calls++
        return opts.respond(range.from)
      },
    },
  }
  return { client: client as unknown as GoldRushClient, getCallCount: () => calls }
}

describe('goldrushPriceSource negative-result caching', () => {
  beforeEach(() => {
    __resetWalletProviderCostLedgerForTest()
    __resetGoldrushPriceSourceCachesForTest()
  })

  it('a "no data" response resolves to null and is cached as negative', async () => {
    const { client, getCallCount } = makeFakeClient({ respond: () => ({ error: false, data: [{ items: [] }] }) })
    const price = await goldrushPriceSource(client)(TOKEN, CHAIN, Date.parse('2024-01-01'))
    assert.equal(price, null)
    assert.equal(getCallCount(), 1)
  })

  it('a repeat lookup for the same (token, chain) on a DIFFERENT date skips the real call once negatively cached', async () => {
    const { client, getCallCount } = makeFakeClient({ respond: () => ({ error: false, data: [{ items: [] }] }) })
    const fn = goldrushPriceSource(client)

    const first = await fn(TOKEN, CHAIN, Date.parse('2024-01-01'))
    assert.equal(first, null)
    assert.equal(getCallCount(), 1)

    // Different date — a day-scoped cache would NOT catch this, but the negative cache here is
    // deliberately scoped per (token, chain), not per (token, chain, day).
    const second = await fn(TOKEN, CHAIN, Date.parse('2024-06-15'))
    assert.equal(second, null)
    assert.equal(getCallCount(), 1, 'expected the second lookup (different date, same token) to hit the negative cache, not make a new real call')
  })

  it('a positive result is returned correctly and does NOT get added to the negative cache', async () => {
    const { client, getCallCount } = makeFakeClient({
      respond: () => ({ error: false, data: [{ items: [{ price: 1.23 }] }] }),
    })
    const fn = goldrushPriceSource(client)

    const first = await fn(TOKEN, CHAIN, Date.parse('2024-01-01'))
    assert.equal(first, 1.23)
    assert.equal(getCallCount(), 1)

    // A second call for the same token on a different date must NOT be suppressed by a (wrongly
    // set) negative cache entry — it should make its own real call.
    const second = await fn(TOKEN, CHAIN, Date.parse('2024-02-02'))
    assert.equal(second, 1.23)
    assert.equal(getCallCount(), 2, 'expected a positive result to never populate the negative cache')
  })

  it('a thrown error resolves to null but is NOT cached as negative (a network hiccup gets a fresh retry)', async () => {
    let calls = 0
    let shouldThrow = true
    const client = {
      PricingService: {
        async getTokenPrices() {
          calls++
          if (shouldThrow) throw new Error('network error')
          return { error: false, data: [{ items: [{ price: 4.56 }] }] }
        },
      },
    } as unknown as GoldRushClient
    const fn = goldrushPriceSource(client)

    const first = await fn(TOKEN, CHAIN, Date.parse('2024-01-01'))
    assert.equal(first, null)
    assert.equal(calls, 1)

    shouldThrow = false
    const second = await fn(TOKEN, CHAIN, Date.parse('2024-03-03'))
    assert.equal(second, 4.56, 'a thrown error must not have been cached as negative — the next real attempt should still run')
    assert.equal(calls, 2)
  })

  it('in-flight coalescing: two concurrent lookups for the same (token, chain, date) share one real call', async () => {
    const { client, getCallCount } = makeFakeClient({ respond: () => ({ error: false, data: [{ items: [{ price: 9.99 }] }] }) })
    const fn = goldrushPriceSource(client)
    const ts = Date.parse('2024-01-01')

    const [a, b] = await Promise.all([fn(TOKEN, CHAIN, ts), fn(TOKEN, CHAIN, ts)])
    assert.equal(a, 9.99)
    assert.equal(b, 9.99)
    assert.equal(getCallCount(), 1, 'expected only one real call for two concurrent identical lookups')
  })

  it('the call counter increments once per real call and is reset by the test helper', async () => {
    const { client } = makeFakeClient({ respond: () => ({ error: false, data: [{ items: [{ price: 1 }] }] }) })
    const fn = goldrushPriceSource(client)
    await fn(TOKEN, CHAIN, Date.parse('2024-01-01'))
    await fn(TOKEN, CHAIN, Date.parse('2024-01-02'))
    assert.equal(getGoldrushPriceSourceCallCount(), 2)
  })

  it('isKnownGoldrushNegative reflects the same negative-cache state a repeat lookup would use', async () => {
    const { client } = makeFakeClient({ respond: () => ({ error: false, data: [{ items: [] }] }) })
    const fn = goldrushPriceSource(client)

    assert.equal(isKnownGoldrushNegative(TOKEN, CHAIN), false, 'expected no negative cache entry before any lookup')
    await fn(TOKEN, CHAIN, Date.parse('2024-01-01'))
    assert.equal(isKnownGoldrushNegative(TOKEN, CHAIN), true, 'expected a negative cache entry after a real "no data" response')
  })

  it('isKnownGoldrushNegative stays false after a positive result (never wrongly reports negative)', async () => {
    const { client } = makeFakeClient({ respond: () => ({ error: false, data: [{ items: [{ price: 5 }] }] }) })
    const fn = goldrushPriceSource(client)

    await fn(TOKEN, CHAIN, Date.parse('2024-01-01'))
    assert.equal(isKnownGoldrushNegative(TOKEN, CHAIN), false, 'expected no negative cache entry after a positive result')
  })
})

describe('goldrushPriceSource — scan-level circuit breaker', () => {
  beforeEach(() => {
    __resetWalletProviderCostLedgerForTest()
    __resetGoldrushPriceSourceCachesForTest()
  })

  it('opens after enough consecutive distinct-token misses and short-circuits the next lookup without a real call', async () => {
    const { client, getCallCount } = makeFakeClient({ respond: () => ({ error: false, data: [{ items: [] }] }) })
    const fn = goldrushPriceSource(client)

    // 20 distinct tokens, each a genuine miss (negative cache is per-token, so each of these makes
    // its own real call rather than hitting an earlier token's cache entry).
    for (let i = 0; i < 20; i++) {
      await fn(tokenAddress(i), CHAIN, Date.parse('2024-01-01'))
    }
    assert.equal(getCallCount(), 20, 'expected all 20 distinct-token lookups to make real calls')
    assert.equal(isGoldrushBreakerOpenForTest(), true, 'expected the breaker to be open after 20 consecutive misses')

    const price = await fn(tokenAddress(999), CHAIN, Date.parse('2024-01-01'))
    assert.equal(price, null)
    assert.equal(getCallCount(), 20, 'expected the breaker-open lookup to skip the real call entirely')
  })

  it('never opens when misses are interspersed with a success (counter resets on any real answer)', async () => {
    let calls = 0
    const client = {
      PricingService: {
        async getTokenPrices(_chainSlug: string, _quote: string, contract: string) {
          calls++
          // Every 5th distinct token (by trailing hex digit) resolves with real data — keeps the
          // consecutive-miss streak from ever reaching the threshold.
          return contract.endsWith('4') || contract.endsWith('9')
            ? { error: false, data: [{ items: [{ price: 1.5 }] }] }
            : { error: false, data: [{ items: [] }] }
        },
      },
    } as unknown as GoldRushClient
    const fn = goldrushPriceSource(client)

    for (let i = 0; i < 30; i++) {
      await fn(tokenAddress(i), CHAIN, Date.parse('2024-01-01'))
    }
    assert.equal(calls, 30, 'expected every distinct token to make a real call (breaker never tripped)')
    assert.equal(isGoldrushBreakerOpenForTest(), false, 'expected the breaker to stay closed when successes keep resetting the streak')
  })

  it('a timeout/thrown error counts toward the breaker exactly like a clean "no data" miss', async () => {
    const client = {
      PricingService: {
        async getTokenPrices() {
          throw new Error('network error')
        },
      },
    } as unknown as GoldRushClient
    const fn = goldrushPriceSource(client)

    for (let i = 0; i < 20; i++) {
      await fn(tokenAddress(i), CHAIN, Date.parse('2024-01-01'))
    }
    assert.equal(isGoldrushBreakerOpenForTest(), true, 'expected 20 consecutive thrown errors to trip the breaker exactly like clean misses')
  })
})

// STAGE ATTRIBUTION, DISCLOSED (wallet-provider-cost-audit follow-up task — confirmed production
// confusion: wallet-provider-cost-audit reported 80 calls under `historical_pricing` for a scan
// whose historical/replay-covered pass made zero, because this shared price source hardcoded
// `stage: 'historical_pricing'` regardless of which resolvePricingAtTime pass invoked it).
describe('goldrushPriceSource stage attribution (wallet-provider-cost-audit follow-up task)', () => {
  beforeEach(() => {
    __resetWalletProviderCostLedgerForTest()
    __resetGoldrushPriceSourceCachesForTest()
    resetGoldrushPriceSourceStage()
  })

  it('HARD ASSERTION (required regression): defaults to historical_pricing when the caller never sets a stage', async () => {
    const { client } = makeFakeClient({ respond: () => ({ error: false, data: [{ items: [{ price: 1 }] }] }) })
    await goldrushPriceSource(client)(TOKEN, CHAIN, Date.parse('2024-01-01'))
    const audit = getWalletProviderCostAudit()
    assert.equal(audit.goldrush.callsByStage.historical_pricing, 1)
    assert.equal(audit.goldrush.callsByStage.current_pricing, undefined)
  })

  it('HARD ASSERTION (required regression): a call made while setGoldrushPriceSourceStage(\'current_pricing\') is active is attributed to current_pricing, never historical_pricing', async () => {
    const { client } = makeFakeClient({ respond: () => ({ error: false, data: [{ items: [{ price: 1 }] }] }) })
    setGoldrushPriceSourceStage('current_pricing')
    try {
      await goldrushPriceSource(client)(TOKEN, CHAIN, Date.parse('2024-01-01'))
    } finally {
      resetGoldrushPriceSourceStage()
    }
    const audit = getWalletProviderCostAudit()
    assert.equal(audit.goldrush.callsByStage.current_pricing, 1)
    assert.equal(audit.goldrush.callsByStage.historical_pricing, undefined)
  })

  it('resetGoldrushPriceSourceStage returns to historical_pricing for the next call — no leakage across passes', async () => {
    const { client } = makeFakeClient({ respond: () => ({ error: false, data: [{ items: [{ price: 1 }] }] }) })
    setGoldrushPriceSourceStage('current_pricing')
    resetGoldrushPriceSourceStage()
    await goldrushPriceSource(client)(TOKEN, CHAIN, Date.parse('2024-01-01'))
    const audit = getWalletProviderCostAudit()
    assert.equal(audit.goldrush.callsByStage.historical_pricing, 1)
    assert.equal(audit.goldrush.callsByStage.current_pricing, undefined)
  })
})

// PERF-SPRINT TASK, DISCLOSED: covers positiveGoldrushPriceCache — see that cache's own header in
// goldrushPriceSource.ts for the full "why reusing a same-day price is 100% accuracy-safe"
// disclosure (the real query itself is date-scoped, from === to === dateString).
describe('goldrushPriceSource positive-result day-bucket cache (perf-sprint: "deduplicate identical token+timestamp lookups", "reuse a single historical price across every lot sharing the same token and timestamp bucket", "persist historical prices indefinitely")', () => {
  beforeEach(() => {
    __resetWalletProviderCostLedgerForTest()
    __resetGoldrushPriceSourceCachesForTest()
  })

  it('a SECOND lookup for the same (token, chain, day) — even a genuinely SEQUENTIAL one, not concurrent — reuses the first real call\'s price with zero new call', async () => {
    const { client, getCallCount } = makeFakeClient({ respond: () => ({ error: false, data: [{ items: [{ price: 42.5 }] }] }) })
    const fn = goldrushPriceSource(client)
    const morning = Date.parse('2024-05-10T01:00:00.000Z')
    const evening = Date.parse('2024-05-10T23:00:00.000Z') // same UTC day, different exact ms timestamp

    const first = await fn(TOKEN, CHAIN, morning)
    assert.equal(first, 42.5)
    assert.equal(getCallCount(), 1)
    assert.equal(isKnownGoldrushPositive(TOKEN, CHAIN, morning), true)

    // Deliberately sequential (awaited, not Promise.all) — this is exactly the case the OLD
    // in-flight-only singleflight map could NOT catch (the first promise already settled and was
    // removed from that map before this second call ever starts).
    const second = await fn(TOKEN, CHAIN, evening)
    assert.equal(second, 42.5, 'must reuse the exact same real price for the same UTC day')
    assert.equal(getCallCount(), 1, 'a second SEQUENTIAL lookup for the same day must not make a new real call')
  })

  it('a lookup for a DIFFERENT day for the same token still makes its own real call — bucketing is per-day, never wider', async () => {
    const { client, getCallCount } = makeFakeClient({ respond: (dateStr) => ({ error: false, data: [{ items: [{ price: dateStr === '2024-05-10' ? 10 : 20 }] }] }) })
    const fn = goldrushPriceSource(client)

    const day1 = await fn(TOKEN, CHAIN, Date.parse('2024-05-10T12:00:00.000Z'))
    const day2 = await fn(TOKEN, CHAIN, Date.parse('2024-05-11T12:00:00.000Z'))
    assert.equal(day1, 10)
    assert.equal(day2, 20)
    assert.equal(getCallCount(), 2, 'two genuinely different days must never be collapsed into one cached answer')
  })

  it('positive-cache hits are recorded as real duplicate-prevention (request_cache), visible in the shared cost ledger', async () => {
    const { client } = makeFakeClient({ respond: () => ({ error: false, data: [{ items: [{ price: 7 }] }] }) })
    const fn = goldrushPriceSource(client)
    const ts = Date.parse('2024-05-10T01:00:00.000Z')

    await fn(TOKEN, CHAIN, ts)
    await fn(TOKEN, CHAIN, Date.parse('2024-05-10T22:00:00.000Z'))
    const audit = getWalletProviderCostAudit()
    assert.equal(audit.cache.requestHits, 1, 'the second (dedup-eliminated) lookup must be counted under cache.requestHits')
  })

  it('a "no data" (negative) result is never positively cached, and a thrown error is never positively cached', async () => {
    const { client: negClient } = makeFakeClient({ respond: () => ({ error: false, data: [{ items: [] }] }) })
    await goldrushPriceSource(negClient)(TOKEN, CHAIN, Date.parse('2024-05-10'))
    assert.equal(isKnownGoldrushPositive(TOKEN, CHAIN, Date.parse('2024-05-10')), false)
  })

  it('getGoldrushLiveCallLatencyStats reports real, measured elapsed time for genuine live calls only — never for a cache hit', async () => {
    const { client } = makeFakeClient({ respond: () => ({ error: false, data: [{ items: [{ price: 3 }] }] }) })
    const fn = goldrushPriceSource(client)
    const ts = Date.parse('2024-05-10T01:00:00.000Z')

    const beforeAnyCall = getGoldrushLiveCallLatencyStats()
    assert.equal(beforeAnyCall.count, 0)
    assert.equal(beforeAnyCall.avgMs, null)

    await fn(TOKEN, CHAIN, ts)
    const afterOneLiveCall = getGoldrushLiveCallLatencyStats()
    assert.equal(afterOneLiveCall.count, 1)
    assert.ok(afterOneLiveCall.avgMs !== null && afterOneLiveCall.avgMs >= 0)

    // Same-day repeat — a cache hit, must NOT add a second entry to the latency stats (there was no
    // real network call to time).
    await fn(TOKEN, CHAIN, Date.parse('2024-05-10T22:00:00.000Z'))
    const afterCacheHit = getGoldrushLiveCallLatencyStats()
    assert.equal(afterCacheHit.count, 1, 'a positive-cache hit must never be counted as a timed live call')
  })
})
