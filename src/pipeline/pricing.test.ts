import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { fetchDexScreenerPool, resolvePipelinePrice, scorePricingCoverage, scorePricingIntegrity } from './pricing'
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

describe('DexScreener pipeline pricing', () => {
  it('fetches the pairs endpoint and returns its explicit USD price', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      assert.equal(String(url), 'https://api.dexscreener.com/latest/dex/pairs/arbitrum/0xpool')
      return new Response(JSON.stringify({ pair: { priceUsd: '2.5', liquidity: { usd: 999999 } } }))
    }) as typeof fetch
    assert.equal(await fetchDexScreenerPool('arbitrum', '0xpool'), 2.5)
  })
  it('does not infer a price from liquidity or volume', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ pair: { liquidity: { usd: 10_000 }, volume: { h24: 50_000 } } }))) as typeof fetch
    assert.equal(await fetchDexScreenerPool('base', '0xpool'), null)
  })
  it('uses the required order and labels DexScreener medium-confidence', async () => {
    const calls: string[] = []
    const result = await resolvePipelinePrice(123, {
      goldrush: () => { calls.push('goldrush'); return null }, dexscreener: () => { calls.push('dexscreener'); return 4 },
      ratio: () => { calls.push('ratio'); return 5 }, synthetic: () => { calls.push('synthetic'); return 6 },
    })
    assert.deepEqual(calls, ['goldrush', 'dexscreener'])
    assert.deepEqual(result[123], { priceUsd: 4, source: 'dexscreener', confidence: 'medium', pricedViaDexScreener: true })
  })
  it('improves coverage and preserves the one-tier downgrade below 50%', () => {
    const dex = { priceUsd: 2, source: 'dexscreener', confidence: 'medium', pricedViaDexScreener: true } as const
    assert.equal(scorePricingCoverage([dex, null], 2), 50)
    assert.equal(scorePricingIntegrity([dex, null], 2), 'medium')
    assert.equal(scorePricingIntegrity([{ priceUsd: 1, source: 'goldrush', confidence: 'high' }, null, null], 3), 'medium')
    assert.equal(scorePricingIntegrity([{ priceUsd: 1, source: 'ratio', confidence: 'low' }, null, null], 3), 'low')
  })
})
