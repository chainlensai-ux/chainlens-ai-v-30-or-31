// Tests for src/modules/pricingAtTimeEngine/sources/dexscreener.ts's fetchDexscreenerPriceDetailed
// pair-selection logic — the dominant-holding price audit task's confirmed fixes: deterministic
// best-pair selection, a real minimum-liquidity floor, and wrong-chain-pair rejection. Mocks
// global.fetch (no real network dependency), same pattern already used by
// lib/server/dustPriceCheck.test.ts. Run directly with:
//   npx tsx --test src/modules/pricingAtTimeEngine/sources/dexscreener.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchDexscreenerPriceDetailed } from './dexscreener'

const originalFetch = global.fetch
const NOW = Date.now()

afterEach(() => {
  global.fetch = originalFetch
})

function mockPairsResponse(pairs: unknown[]): void {
  global.fetch = (async () => new Response(JSON.stringify({ pairs }), { status: 200 })) as unknown as typeof fetch
}

const REQUESTED_TOKEN = '0xtoken'
const baseToken = (address = REQUESTED_TOKEN) => ({ address })

describe('fetchDexscreenerPriceDetailed — deterministic best-pair selection (dominant-holding price audit)', () => {
  it('pair ordering cannot change the selected price — reversing the API response array yields the identical winner', async () => {
    const pairA = { chainId: 'base', pairAddress: '0xAAA', priceUsd: '1.00', liquidity: { usd: 50_000 }, dexId: 'uniswap', baseToken: baseToken() }
    const pairB = { chainId: 'base', pairAddress: '0xBBB', priceUsd: '1.05', liquidity: { usd: 20_000 }, dexId: 'aerodrome', baseToken: baseToken() }

    mockPairsResponse([pairA, pairB])
    const forward = await fetchDexscreenerPriceDetailed('0xtoken', 'base', NOW)

    mockPairsResponse([pairB, pairA])
    const reversed = await fetchDexscreenerPriceDetailed('0xtoken', 'base', NOW)

    assert.equal(forward.priceUsd, 1.00, 'the higher-liquidity pair must win regardless of array order')
    assert.equal(reversed.priceUsd, 1.00)
    assert.equal(forward.pairAddress, reversed.pairAddress)
  })

  it('a tie in liquidity (including the real all-zero-liquidity case) resolves deterministically by pair address, not by API response order', async () => {
    const tiedA = { chainId: 'base', pairAddress: '0xZZZ', priceUsd: '2.00', liquidity: { usd: 5000 }, dexId: 'uniswap', baseToken: baseToken() }
    const tiedB = { chainId: 'base', pairAddress: '0xAAA', priceUsd: '2.10', liquidity: { usd: 5000 }, dexId: 'aerodrome', baseToken: baseToken() }

    mockPairsResponse([tiedA, tiedB])
    const order1 = await fetchDexscreenerPriceDetailed('0xtoken', 'base', NOW)
    mockPairsResponse([tiedB, tiedA])
    const order2 = await fetchDexscreenerPriceDetailed('0xtoken', 'base', NOW)

    assert.equal(order1.pairAddress, '0xAAA', 'the lexicographically-first pair address must win a real liquidity tie')
    assert.equal(order2.pairAddress, '0xAAA', 'the winner must be identical regardless of which order the tied pairs arrived in')
    assert.equal(order1.priceUsd, order2.priceUsd)
  })

  it('a wrong-chain pair is rejected even if it has far higher liquidity than the real matching pair', async () => {
    const wrongChain = { chainId: 'ethereum', pairAddress: '0xETH', priceUsd: '999.00', liquidity: { usd: 10_000_000 }, dexId: 'uniswap', baseToken: baseToken() }
    const correctChain = { chainId: 'base', pairAddress: '0xBASE', priceUsd: '1.50', liquidity: { usd: 2000 }, dexId: 'aerodrome', baseToken: baseToken() }

    mockPairsResponse([wrongChain, correctChain])
    const result = await fetchDexscreenerPriceDetailed('0xtoken', 'base', NOW)

    assert.equal(result.priceUsd, 1.50, 'the wrong-chain pair must never win regardless of its liquidity advantage')
    assert.equal(result.pairAddress, '0xBASE')
  })

  it('a low-liquidity outlier pair is rejected — never used to price a token even when it is the only pair returned', async () => {
    const dustPair = { chainId: 'base', pairAddress: '0xDUST', priceUsd: '0.0001', liquidity: { usd: 5 }, baseToken: baseToken() }
    mockPairsResponse([dustPair])
    const result = await fetchDexscreenerPriceDetailed('0xtoken', 'base', NOW)

    assert.equal(result.priceUsd, null, 'a pair below the minimum liquidity floor must never be used, even as a last resort')
    assert.equal(result.reason, 'no_pair_meets_minimum_liquidity')
  })

  it('a low-liquidity outlier is rejected in favor of a real liquid pair for the same token', async () => {
    const dustPair = { chainId: 'base', pairAddress: '0xDUST', priceUsd: '50.00', liquidity: { usd: 3 }, baseToken: baseToken() }
    const realPair = { chainId: 'base', pairAddress: '0xREAL', priceUsd: '1.10', liquidity: { usd: 10_000 }, baseToken: baseToken() }
    mockPairsResponse([dustPair, realPair])
    const result = await fetchDexscreenerPriceDetailed('0xtoken', 'base', NOW)

    assert.equal(result.priceUsd, 1.10, 'the real, liquid pair must win — the dust pair\'s wildly different price must never be selected')
    assert.equal(result.pairAddress, '0xREAL')
  })

  it('surfaces real pair provenance for a winning pair — pairAddress, dexId, liquidityUsd, pairAgeMs, quoteTokenSymbol, winnerReason', async () => {
    const pairCreatedAt = NOW - 5000
    mockPairsResponse([{
      chainId: 'base', pairAddress: '0xPROV', dexId: 'aerodrome', priceUsd: '3.33',
      liquidity: { usd: 25_000 }, pairCreatedAt, quoteToken: { symbol: 'WETH' }, baseToken: baseToken(),
    }])
    const result = await fetchDexscreenerPriceDetailed('0xtoken', 'base', NOW)

    assert.equal(result.pairAddress, '0xPROV')
    assert.equal(result.dexId, 'aerodrome')
    assert.equal(result.liquidityUsd, 25_000)
    assert.equal(result.quoteTokenSymbol, 'WETH')
    assert.ok(result.pairAgeMs !== null && result.pairAgeMs >= 4000, 'pair age must be a real, computed duration')
    assert.equal(result.winnerReason, 'only_pair_meeting_minimum_liquidity')
  })

  it('alternate valid pairs are surfaced (compact, capped) alongside the winner', async () => {
    mockPairsResponse([
      { chainId: 'base', pairAddress: '0xWIN', priceUsd: '1.00', liquidity: { usd: 100_000 }, baseToken: baseToken() },
      { chainId: 'base', pairAddress: '0xALT', priceUsd: '1.02', liquidity: { usd: 40_000 }, baseToken: baseToken() },
    ])
    const result = await fetchDexscreenerPriceDetailed('0xtoken', 'base', NOW)
    assert.equal(result.pairAddress, '0xWIN')
    assert.equal(result.alternatePairs.length, 1)
    assert.equal(result.alternatePairs[0].pairAddress, '0xALT')
    assert.equal(result.alternatePairs[0].priceUsd, 1.02)
  })
})

describe('fetchDexscreenerPriceDetailed — requested token side determines price (FreeCode valuation audit)', () => {
  it('a pair where the requested token is only the QUOTE token (not the base) is rejected, never used as an inverted/wrong price', async () => {
    // A real pair shape where our requested token is the quote side — priceUsd here belongs to the
    // OTHER token (the pair's baseToken), not ours. Must never be used as if it were our token's price.
    const wrongSide = {
      chainId: 'base', pairAddress: '0xWRONGSIDE', priceUsd: '3500.00', liquidity: { usd: 1_000_000 },
      baseToken: { address: '0xsomeothertoken' }, quoteToken: { address: REQUESTED_TOKEN, symbol: 'REQ' },
    }
    mockPairsResponse([wrongSide])
    const result = await fetchDexscreenerPriceDetailed(REQUESTED_TOKEN, 'base', NOW)

    assert.equal(result.priceUsd, null, 'a pair where the requested token is only the quote side must never be used to price it')
    assert.equal(result.reason, 'no_matching_pair')
  })

  it('when the requested token has both a quote-side pair and a real base-side pair, only the base-side pair prices it', async () => {
    const wrongSide = {
      chainId: 'base', pairAddress: '0xWRONGSIDE', priceUsd: '3500.00', liquidity: { usd: 5_000_000 },
      baseToken: { address: '0xsomeothertoken' }, quoteToken: { address: REQUESTED_TOKEN, symbol: 'REQ' },
    }
    const correctSide = {
      chainId: 'base', pairAddress: '0xCORRECTSIDE', priceUsd: '0.000002625', liquidity: { usd: 2000 },
      baseToken: baseToken(REQUESTED_TOKEN), quoteToken: { address: '0xweth', symbol: 'WETH' },
    }
    mockPairsResponse([wrongSide, correctSide])
    const result = await fetchDexscreenerPriceDetailed(REQUESTED_TOKEN, 'base', NOW)

    assert.equal(result.priceUsd, 0.000002625, 'the real base-side pair must win, never the far-higher-liquidity wrong-side pair')
    assert.equal(result.pairAddress, '0xCORRECTSIDE')
  })
})
