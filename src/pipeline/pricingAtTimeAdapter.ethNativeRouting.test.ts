// Regression tests for the ETH NATIVE HISTORICAL PROVIDER ROUTING fix — production evidence: two
// selected Ethereum native (Tier-2) requirements, correctly routed to the canonical WETH-on-mainnet
// contract (0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2) with ranks -48/-47, both returned
// resolvedPriceUsd: null — while two Base native requirements (routed the same way, to Base's own
// canonical WETH) priced successfully.
//
// Root cause, confirmed by audit: Base's extra success comes from basedex.ts's on-chain Uniswap V3
// fallback, which structurally only supports 'base' (fetchBaseDexPriceDetailed returns
// 'base_dex_only_supports_base_chain' for every other chain) — not addable here without a real
// mainnet on-chain integration. The genuinely fixable mismatch: every source queries WETH uniformly
// by its CONTRACT address, including CoinGecko's contract-based market_chart/range endpoint — a
// secondary, contract-derived dataset that can have date gaps a token's own coin-id history does
// not. CoinGecko separately indexes native ETH under its own coin id ("ethereum") via
// /coins/ethereum/history — the primary dataset for the SAME asset. Fixed by trying that endpoint
// first, specifically for chain 'eth' + the canonical WETH-on-mainnet address, before falling
// through to the existing (unchanged) ordering.
//
// Run with:
//   npx tsx --test src/pipeline/pricingAtTimeAdapter.ethNativeRouting.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildChainAwareHistoricalPriceSourceDetailed, resetPricingAtTimeAdapterScanState } from './pricingAtTimeAdapter'
import { resetCoingeckoCircuitBreaker } from '../modules/pricingAtTimeEngine/sources/coingecko'
import { __resetGoldrushPriceSourceCachesForTest } from '../modules/pricingAtTimeEngine/sources/goldrushPriceSource'
import { resetGeckoTerminalNoPoolCache } from './providers/geckoTerminalPriceSource'
import { __resetBaseDexCachesForTest } from '../modules/pricingAtTimeEngine/sources/basedex'
import type { PriceSourceFn } from '../modules/pricingAtTimeEngine/types'

const originalFetch = global.fetch
const ETH_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const HISTORICAL_TIMESTAMP = Date.parse('2024-03-15T00:00:00.000Z')

beforeEach(() => {
  resetPricingAtTimeAdapterScanState()
  __resetGoldrushPriceSourceCachesForTest()
  resetCoingeckoCircuitBreaker()
  resetGeckoTerminalNoPoolCache()
  __resetBaseDexCachesForTest()
})

afterEach(() => {
  global.fetch = originalFetch
})

function mockCoingeckoNativeEthSuccess(priceUsd: number): { calls: Array<{ url: string; date: string | null }> } {
  const calls: Array<{ url: string; date: string | null }> = []
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const parsed = new URL(url)
    if (url.includes('/coins/ethereum/history')) {
      calls.push({ url, date: parsed.searchParams.get('date') })
      return new Response(JSON.stringify({ market_data: { current_price: { usd: priceUsd } } }), { status: 200 })
    }
    calls.push({ url, date: null })
    return new Response(JSON.stringify({}), { status: 200 })
  }) as unknown as typeof fetch
  return { calls }
}

describe('pricingAtTimeAdapter — ETH native routing (canonical WETH-on-mainnet address)', () => {
  it('a selected Ethereum native requirement at a historical timestamp resolves via the native CoinGecko route', async () => {
    const { calls } = mockCoingeckoNativeEthSuccess(3500)
    const goldrush: PriceSourceFn = async () => null
    const detailed = buildChainAwareHistoricalPriceSourceDetailed(goldrush)

    const result = await detailed(ETH_WETH, 'eth', HISTORICAL_TIMESTAMP)

    assert.equal(result.price, 3500)
    assert.equal(result.route, 'coingecko_native_eth')
    assert.ok(calls.some((c) => c.url.includes('/coins/ethereum/history')), 'the native coin-id endpoint must actually be called')
  })

  it('the raw native pseudo-address never reaches the provider — only the routed canonical WETH address is queried', async () => {
    const { calls } = mockCoingeckoNativeEthSuccess(3500)
    const goldrush: PriceSourceFn = async () => null
    const detailed = buildChainAwareHistoricalPriceSourceDetailed(goldrush)

    await detailed(ETH_WETH, 'eth', HISTORICAL_TIMESTAMP)

    assert.ok(!calls.some((c) => c.url.toLowerCase().includes('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')), 'the sentinel native pseudo-address must never appear in a real provider URL')
  })

  it('uses the correct ETH-native CoinGecko identifier ("ethereum"), not a contract-based lookup, for this address', async () => {
    const { calls } = mockCoingeckoNativeEthSuccess(3500)
    const goldrush: PriceSourceFn = async () => null
    const detailed = buildChainAwareHistoricalPriceSourceDetailed(goldrush)

    await detailed(ETH_WETH, 'eth', HISTORICAL_TIMESTAMP)

    const nativeCall = calls.find((c) => c.url.includes('/coins/ethereum/history'))
    assert.ok(nativeCall, 'must call the coin-id ("ethereum") history endpoint')
    assert.ok(!calls.some((c) => c.url.includes('/coins/ethereum/contract/')), 'must not ALSO call the contract-based endpoint once the native route already succeeded')
  })

  it('preserves the exact requested historical timestamp — never "now"', async () => {
    const { calls } = mockCoingeckoNativeEthSuccess(3500)
    const goldrush: PriceSourceFn = async () => null
    const detailed = buildChainAwareHistoricalPriceSourceDetailed(goldrush)

    await detailed(ETH_WETH, 'eth', HISTORICAL_TIMESTAMP)

    const nativeCall = calls.find((c) => c.url.includes('/coins/ethereum/history'))!
    // 2024-03-15 UTC -> "15-03-2024" in CoinGecko's DD-MM-YYYY format.
    assert.equal(nativeCall.date, '15-03-2024')
  })

  it('a non-ETH-mainnet WETH address (e.g. Base) is completely unaffected by this new route', async () => {
    let nativeEndpointCalled = false
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/coins/ethereum/history')) nativeEndpointCalled = true
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    const goldrush: PriceSourceFn = async () => null
    const detailed = buildChainAwareHistoricalPriceSourceDetailed(goldrush)

    await detailed('0x4200000000000000000000000000000000000006', 'base', HISTORICAL_TIMESTAMP)

    assert.equal(nativeEndpointCalled, false, 'the native ETH route must never fire for a different chain/address')
  })

  it('falls through to the existing ordering, unchanged, when the native route itself misses', async () => {
    global.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch
    const goldrush: PriceSourceFn = async () => null
    const detailed = buildChainAwareHistoricalPriceSourceDetailed(goldrush)

    const result = await detailed(ETH_WETH, 'eth', HISTORICAL_TIMESTAMP)

    const nativeAttempt = result.attempts[0]
    assert.equal(nativeAttempt.ok, false)
    assert.ok(result.attempts.length > 1, 'must still fall through to the existing goldrush/dexscreener/geckoterminal/safety-net ordering')
  })
})
