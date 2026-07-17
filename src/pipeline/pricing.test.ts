import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { fetchDexScreenerPool, fetchUniswapPool, mergePoolMetadata, resolvePipelinePrice, scorePricingCoverage, scorePricingIntegrity } from './pricing'
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

describe('DexScreener pipeline pricing', () => {
  it('fetches the pairs endpoint and returns its explicit USD price', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      assert.equal(String(url), 'https://api.dexscreener.com/latest/dex/pairs/arbitrum/0xpool')
      return new Response(JSON.stringify({ pair: { priceUsd: '2.5', liquidity: { usd: 999999 } } }))
    }) as typeof fetch
    assert.deepEqual(await fetchDexScreenerPool('arbitrum', '0xpool'), { source: 'dexscreener', priceUsd: 2.5 })
  })
  it('does not infer a price from liquidity or volume', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ pair: { liquidity: { usd: 10_000 }, volume: { h24: 50_000 } } }))) as typeof fetch
    assert.deepEqual(await fetchDexScreenerPool('base', '0xpool'), { source: 'dexscreener' })
  })
  it('uses the required order and labels DexScreener medium-confidence', async () => {
    const calls: string[] = []
    const result = await resolvePipelinePrice(123, {
      goldrush: () => { calls.push('goldrush'); return null }, dexscreener: () => { calls.push('dexscreener'); return 4 },
      ratio: () => { calls.push('ratio'); return 5 }, synthetic: () => { calls.push('synthetic'); return 6 },
    })
    assert.deepEqual(calls, ['goldrush', 'dexscreener'])
    assert.deepEqual(result[123], { priceUsd: 4, source: 'dexscreener', confidence: 'medium', pricedViaExternal: true, pricedViaDexScreener: true })
  })
  it('improves coverage and preserves the one-tier downgrade below 50%', () => {
    const dex = { priceUsd: 2, source: 'dexscreener', confidence: 'medium', pricedViaDexScreener: true } as const
    assert.equal(scorePricingCoverage([dex, null], 2), 50)
    assert.equal(scorePricingIntegrity([dex, null], 2), 'medium')
    assert.equal(scorePricingIntegrity([{ priceUsd: 1, source: 'goldrush', confidence: 'high' }, null, null], 3), 'medium')
    assert.equal(scorePricingIntegrity([{ priceUsd: 1, source: 'ratio', confidence: 'low' }, null, null], 3), 'low')
  })

  it('uses an explicit subgraph price after DexScreener misses', async () => {
    const result = await resolvePipelinePrice(456, {
      goldrush: () => null, dexscreener: () => null,
      subgraphs: { uniswap: () => ({ source: 'uniswap', priceUsd: 3 }) },
      ratio: () => 4, synthetic: () => 5,
    })
    assert.deepEqual(result[456], { priceUsd: 3, source: 'uniswap', confidence: 'medium', pricedViaExternal: true })
  })

  it('parses explicit subgraph price and metadata without using liquidity as price', async () => {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(init?.method, 'POST')
      return new Response(JSON.stringify({ data: { pool: {
        token0: { id: '0xaaa' }, token1: { id: '0xbbb' }, reserve0: '10', reserve1: '20',
        liquidity: '999', feeTier: '3000', poolType: 'concentrated', priceUSD: '1.25',
      } } }))
    }) as typeof fetch
    assert.deepEqual(await fetchUniswapPool('0xPOOL'), {
      source: 'uniswap', priceUsd: 1.25, token0: '0xaaa', token1: '0xbbb', reserve0: 10,
      reserve1: 20, liquidity: 999, feeTier: 3000, poolType: 'concentrated',
    })
  })

  it('merges only present metadata in source order', () => {
    assert.deepEqual(mergePoolMetadata([
      { source: 'uniswap', token0: '0xa', reserve0: 10 },
      { source: 'aerodrome', token0: 'ignored', token1: '0xb', poolType: 'stable' },
      { source: 'balancer', feeTier: 0.003, liquidity: 500 },
    ]), { token0: '0xa', reserve0: 10, token1: '0xb', poolType: 'stable', feeTier: 0.003, liquidity: 500 })
  })
})
