import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { buildSyntheticPoolPriceData, discoverAerodromePools, fetchDexScreenerPool, fetchUniswapPool, mapAerodromeToken, mergePoolMetadata, priceBaseTokenFromAerodrome, resolvePipelinePrice, scorePricingCoverage, scorePricingIntegrity } from './pricing'
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

  it('wires resolver output and merged metadata into safe synthetic pool data', async () => {
    const resolved = (await resolvePipelinePrice(789, {
      goldrush: () => null,
      dexscreener: () => null,
      subgraphs: { aerodrome: () => ({ source: 'aerodrome', priceUsd: 2 }) },
      ratio: () => 3,
      synthetic: () => 4,
    }))[789]!
    assert.deepEqual(buildSyntheticPoolPriceData(20, 10, resolved, [
      { source: 'aerodrome', token0: '0xa', token1: '0xb', reserve0: 10, liquidity: 900, feeTier: 0.003, poolType: 'stable' },
      { source: 'sushi', reserve1: 30 },
    ]), {
      token0: '0xa', token1: '0xb', reserve0: 10, reserve1: 30, liquidity: 900,
      feeTier: 0.003, poolType: 'stable', midPriceUsd: 2, liquidityUsd: 900,
      priceConfidence: 'medium', pricedViaAerodrome: true,
    })
  })

  it('rejects invalid mid-price operands and never fabricates liquidity', () => {
    const resolved = { priceUsd: 2, source: 'goldrush', confidence: 'high' } as const
    for (const [usd, amount] of [[NaN, 1], [1, Infinity], [-1, 1], [1, 0]]) {
      assert.equal(buildSyntheticPoolPriceData(usd, amount, resolved, []), undefined)
    }
    assert.deepEqual(buildSyntheticPoolPriceData(10, 2, resolved, []), {
      midPriceUsd: 5, priceConfidence: 'high',
    })
  })
})

describe('Aerodrome Base fallback', () => {
  it('discovers both token sides and rejects rows with invalid reserves', async () => {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: { token: string } }
      assert.match(request.query, /token0Pools/)
      assert.equal(request.variables.token, '0xtoken')
      return new Response(JSON.stringify({ data: {
        token0Pools: [{ id: '0xpool', token0: { id: '0xtoken', decimals: '18', symbol: 'TOKEN' }, token1: { id: '0xusd', decimals: '6', symbol: 'USDC' }, reserve0: '10', reserve1: '25', reserveUSD: '50' }],
        token1Pools: [{ id: '0xbad', token0: { id: '0xusd' }, token1: { id: '0xtoken' }, reserve0: 'NaN', reserve1: '2' }],
      } }))
    }) as typeof fetch
    assert.deepEqual(await discoverAerodromePools('0xTOKEN'), [{ source: 'aerodrome', address: '0xpool', token0: '0xtoken', token1: '0xusd', reserve0: 10, reserve1: 25, liquidity: 50, token0Decimals: 18, token1Decimals: 6, token0Symbol: 'TOKEN', token1Symbol: 'USDC' }])
  })

  it('uses TWAP before reserve ratio, maps metadata strictly, and rejects ambiguity', () => {
    const token = { address: '0xtoken', decimals: 18, symbol: 'TOKEN' }
    const pool = { source: 'aerodrome' as const, address: '0xpool', token0: '0xtoken', token1: '0xusd', reserve0: 10, reserve1: 25, token0Decimals: 18, token0Symbol: 'TOKEN', twapPriceUsd: 2.4 }
    assert.equal(mapAerodromeToken(token, [pool]), pool)
    assert.equal(priceBaseTokenFromAerodrome(token, pool, { '0xusd': 1 }), 2.4)
    assert.equal(priceBaseTokenFromAerodrome(token, { ...pool, twapPriceUsd: undefined }, { '0xusd': 1 }), 2.5)
    assert.equal(mapAerodromeToken(token, [pool, { ...pool, address: '0xother' }]), null)
    assert.equal(priceBaseTokenFromAerodrome(token, { ...pool, twapPriceUsd: undefined }, {}), null)
  })

  it('falls back to the alternative pair query when pools are empty', async () => {
    let calls = 0
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++
      const query = (JSON.parse(String(init?.body)) as { query: string }).query
      return new Response(JSON.stringify({ data: query.includes('token0Pairs') ? { token0Pairs: [{ id: '0xpair', token0: { id: '0xtoken' }, token1: { id: '0xusd' }, reserve0: '2', reserve1: '4' }], token1Pairs: [] } : { token0Pools: [], token1Pools: [] } }))
    }) as typeof fetch
    assert.equal((await discoverAerodromePools('0xtoken'))[0]?.address, '0xpair')
    assert.equal(calls, 3)
  })
})
