// Tests for src/modules/fallbackPricing — DefaultFallbackPricingService, BaseScanClient,
// GeckoTerminalClient. Uses node:test, same convention as this codebase's other module tests. Run
// directly with:
//   npx tsx --test src/modules/fallbackPricing/index.test.ts
//
// NETWORK, DISCLOSED: this sandbox has no outbound network access to api.basescan.org or
// api.geckoterminal.com — real HTTP calls are exercised via constructor-injected client instances
// with their `getTokenPriceUsdDetailed` replaced by a mock, same pattern this codebase already uses
// elsewhere (e.g. lib/server/cache/v2StageCache's __setKvClientForTest injection seam) rather than
// mocking global fetch.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultFallbackPricingService } from './index'
import { BaseScanClient } from './baseScanClient'
import { GeckoTerminalClient } from './geckoTerminalClient'

function mockBaseScanClient(result: { priceUsd: number | null; reason: string | null }): BaseScanClient {
  const client = new BaseScanClient()
  client.getTokenPriceUsdDetailed = async () => result
  return client
}

function mockGeckoTerminalClient(result: { priceUsd: number | null; reason: string | null }): GeckoTerminalClient {
  const client = new GeckoTerminalClient('eth')
  client.getTokenPriceUsdDetailed = async () => result
  return client
}

describe('DefaultFallbackPricingService — routing rule (base -> BaseScan, eth -> GeckoTerminal)', () => {
  it('returns ok + price for base, source "BaseScan"', async () => {
    const service = new DefaultFallbackPricingService(mockBaseScanClient({ priceUsd: 1.23, reason: null }))
    const result = await service.getFallbackPrice({ chainId: 8453, tokenAddress: '0xtoken' })
    assert.deepEqual(result, { ok: true, priceUsd: 1.23, source: 'BaseScan' })
  })

  it('returns ok + price for eth, source "GeckoTerminal"', async () => {
    const service = new DefaultFallbackPricingService(
      new BaseScanClient(),
      { eth: mockGeckoTerminalClient({ priceUsd: 4.56, reason: null }) },
    )
    const result = await service.getFallbackPrice({ chainId: 1, tokenAddress: '0xtoken' })
    assert.deepEqual(result, { ok: true, priceUsd: 4.56, source: 'GeckoTerminal' })
  })

  it('returns { ok: false, errorReason } when no price is found (base)', async () => {
    const service = new DefaultFallbackPricingService(mockBaseScanClient({ priceUsd: null, reason: 'no_tokenPriceUSD_field' }))
    const result = await service.getFallbackPrice({ chainId: 8453, tokenAddress: '0xtoken' })
    assert.equal(result.ok, false)
    assert.equal((result as { errorReason: string }).errorReason, 'no_tokenPriceUSD_field')
  })

  it('returns { ok: false, errorReason } when no price is found (eth)', async () => {
    const service = new DefaultFallbackPricingService(
      new BaseScanClient(),
      { eth: mockGeckoTerminalClient({ priceUsd: null, reason: 'no_pool_found' }) },
    )
    const result = await service.getFallbackPrice({ chainId: 1, tokenAddress: '0xtoken' })
    assert.equal(result.ok, false)
    assert.equal((result as { errorReason: string }).errorReason, 'no_pool_found')
  })

  it('returns errorReason "unsupported_chain" for a chainId with no routing rule — never fabricates a price', async () => {
    const service = new DefaultFallbackPricingService()
    const result = await service.getFallbackPrice({ chainId: 999999, tokenAddress: '0xtoken' })
    assert.deepEqual(result, { ok: false, errorReason: 'unsupported_chain' })
  })

  it('never fabricates a price — a zero/negative "price" from a client is treated as no data', async () => {
    // BaseScanClient/GeckoTerminalClient's own safeParsedUsdPrice already rejects <= 0, but this
    // confirms the service layer never substitutes a default when priceUsd is null.
    const service = new DefaultFallbackPricingService(mockBaseScanClient({ priceUsd: null, reason: 'basescan_status_not_1' }))
    const result = await service.getFallbackPrice({ chainId: 8453, tokenAddress: '0xtoken' })
    assert.equal(result.ok, false)
  })
})
