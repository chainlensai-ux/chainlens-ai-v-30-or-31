// CoinGecko contract pricing: at most COINGECKO_PRICING_MAX_CONCURRENT (default 4) requests in flight;
// after the first 429 the queued requests are dropped, not sent; a 404 (not listed) is asked once per scan.
//   npx tsx --test src/modules/pricingAtTimeEngine/sources/coingeckoContractGate.test.ts
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchCoingeckoPriceDetailed, resetCoingeckoCircuitBreaker } from './coingecko'

const originalFetch = global.fetch
const T = Date.parse('2026-10-01T12:00:00Z')
const DAY = 86_400_000
const token = (i: number) => `0x${i.toString(16).padStart(40, '0')}`

afterEach(() => { global.fetch = originalFetch; resetCoingeckoCircuitBreaker() })

function slowFetch(statusFor: (n: number) => number) {
  let sent = 0, active = 0, peak = 0
  global.fetch = (async () => {
    const n = sent++
    active++; peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 20))
    active--
    const status = statusFor(n)
    return new Response(JSON.stringify(status === 200 ? { prices: [[T, 1.5]] } : {}), { status })
  }) as typeof fetch
  return { sent: () => sent, peak: () => peak }
}

describe('CoinGecko contract pricing gate', () => {
  it('50 concurrent lookups: never more than 4 in flight, all priced', async () => {
    const f = slowFetch(() => 200)
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => fetchCoingeckoPriceDetailed(token(i + 1), 'base', T)))
    assert.equal(f.peak(), 4)
    assert.equal(results.filter((r) => r.priceUsd === 1.5).length, 50)
  })

  it('after the first 429, queued lookups are dropped instead of sent', async () => {
    const f = slowFetch((n) => (n === 0 ? 429 : 200))
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => fetchCoingeckoPriceDetailed(token(i + 1), 'base', T)))
    assert.ok(f.sent() <= 4, `only the first batch was sent (sent ${f.sent()})`)
    assert.ok(results.filter((r) => r.reason === 'coingecko_circuit_open_after_429').length >= 46)
  })

  it('a 404 (not listed) is asked once per scan, including lookups already queued', async () => {
    const f = slowFetch(() => 404)
    const same = token(7)
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => fetchCoingeckoPriceDetailed(same, 'base', T + i * DAY)))
    assert.ok(results.every((r) => r.reason === 'http_404'))
    assert.ok(f.sent() <= 4, `at most the first in-flight batch (sent ${f.sent()})`)
    const later = await fetchCoingeckoPriceDetailed(same, 'base', T + 20 * DAY)
    assert.equal(later.reason, 'http_404')
    assert.ok(f.sent() <= 4)
  })

  it('a 5xx is not remembered, and the per-scan reset forgets a 404', async () => {
    let status = 503
    const f = slowFetch(() => status)
    await fetchCoingeckoPriceDetailed(token(1), 'base', T)
    status = 200
    assert.equal((await fetchCoingeckoPriceDetailed(token(1), 'base', T + DAY)).priceUsd, 1.5)
    status = 404
    await fetchCoingeckoPriceDetailed(token(2), 'base', T)
    resetCoingeckoCircuitBreaker()
    status = 200
    assert.equal((await fetchCoingeckoPriceDetailed(token(2), 'base', T)).priceUsd, 1.5)
    assert.equal(f.sent(), 4)
  })
})
