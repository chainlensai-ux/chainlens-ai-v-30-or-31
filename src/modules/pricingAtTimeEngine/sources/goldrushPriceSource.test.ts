// Tests for goldrushPriceSource's negative-result caching (src/modules/pricingAtTimeEngine/sources/
// goldrushPriceSource.ts). NOT wired into `npm test`. Run directly with:
//   npx tsx --test src/modules/pricingAtTimeEngine/sources/goldrushPriceSource.test.ts
//
// Uses a minimal fake GoldRushClient (only the `PricingService.getTokenPrices` method this module
// actually calls) so this never hits real RPC/env vars. Asserts: (1) a real "no data" response gets
// cached as negative and a repeat lookup for the same (token, chain) on a DIFFERENT date skips the
// real call, (2) a positive result is never added to the negative cache and is computed fresh every
// time (positive caching is the wrapping withPriceSourceCache's job, not this module's), (3) a
// thrown error is never cached as negative, (4) concurrent identical (token, chain, date) lookups
// share one real call.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { GoldRushClient } from '@covalenthq/client-sdk'
import { goldrushPriceSource, __resetGoldrushPriceSourceCachesForTest, getGoldrushPriceSourceCallCount } from './goldrushPriceSource'

const TOKEN = '0x1111111111111111111111111111111111111111'
const CHAIN = 'base'

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
})
