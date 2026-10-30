// GoldRush rate limits are transient, not "no data". The installed SDK returns (never throws) a
// 429 as its generic 500 fallback, so the price source must recognise it and never negative-cache it. Real API errors (GoldRush's own message) keep the existing negative caching.
//   npx tsx --test src/modules/pricingAtTimeEngine/sources/goldrushPriceSource.rateLimit.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { GoldRushClient } from '@covalenthq/client-sdk'
import { goldrushPriceSource, __resetGoldrushPriceSourceCachesForTest, isGoldrushTransientError, isKnownGoldrushNegative } from './goldrushPriceSource'
import { __resetWalletProviderCostLedgerForTest } from '../../providerCost/walletProviderCostLedger'

const TOKEN = '0x1111111111111111111111111111111111111111'
// Exactly what @covalenthq/client-sdk 3.0.6 returns for an HTTP 429 (pinned by the first test below).
const SDK_RATE_LIMITED = { data: null, error: true, error_code: 500, error_message: 'Internal server error' }
const PRICED = { error: false, data: [{ items: [{ price: 2.5 }] }] }

function scripted(replies: unknown[]) {
  let calls = 0
  const client = { PricingService: { async getTokenPrices() { const r = replies[Math.min(calls, replies.length - 1)]; calls++; return r } } }
  return { client: client as unknown as GoldRushClient, calls: () => calls }
}

describe('goldrushPriceSource — rate limits', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => { __resetWalletProviderCostLedgerForTest(); __resetGoldrushPriceSourceCachesForTest() })
  afterEach(() => { globalThis.fetch = realFetch })

  it('the installed SDK returns, not throws, a 429 as its generic 500 fallback', async () => {
    let fetches = 0
    globalThis.fetch = (async () => { fetches++; return new Response('{}', { status: 429 }) }) as typeof fetch
    const client = new GoldRushClient('cqt_rQ' + 'b'.repeat(26), { enableRetry: true })
    const response = await client.PricingService.getTokenPrices('base-mainnet', 'USD', TOKEN, { from: '2026-10-01', to: '2026-10-01' })
    assert.deepEqual({ error: response.error, error_code: response.error_code, error_message: response.error_message }, { error: true, error_code: 500, error_message: 'Internal server error' })
    assert.equal(fetches, 1, 'the SDK does not retry its own 429')
    assert.equal(isGoldrushTransientError(response), true)
  })

  it('a rate-limited answer is null for that call, and the token is NOT cached as having no data', async () => {
    const { client, calls } = scripted([SDK_RATE_LIMITED, PRICED])
    const fn = goldrushPriceSource(client)
    assert.equal(await fn(TOKEN, 'base', Date.parse('2026-10-01')), null)
    assert.equal(calls(), 1)
    assert.equal(isKnownGoldrushNegative(TOKEN, 'base'), false)
    assert.equal(await fn(TOKEN, 'base', Date.parse('2026-10-02')), 2.5, 'a later date is still asked')
    assert.equal(calls(), 2)
  })

  it('a genuine error result (not a rate limit) is still cached as negative, unchanged', async () => {
    const { client, calls } = scripted([{ data: null, error: true, error_code: 400, error_message: 'Invalid contract address' }, PRICED])
    const fn = goldrushPriceSource(client)
    assert.equal(await fn(TOKEN, 'base', Date.parse('2026-10-01')), null)
    assert.equal(isKnownGoldrushNegative(TOKEN, 'base'), true)
    assert.equal(await fn(TOKEN, 'base', Date.parse('2026-10-02')), null)
    assert.equal(calls(), 1, 'no retry and no second call for a real error')
  })

  it('the SDK network-failure fallback is the same transient shape', async () => {
    globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    const client = new GoldRushClient('cqt_rQ' + 'b'.repeat(26))
    const response = await client.PricingService.getTokenPrices('base-mainnet', 'USD', TOKEN, { from: '2026-10-01', to: '2026-10-01' })
    assert.equal(isGoldrushTransientError(response), true)
  })

  it('isGoldrushTransientError recognises the SDK transient shapes and nothing else', () => {
    assert.equal(isGoldrushTransientError({ error: true, error_code: 429, error_message: '2 retries exceeded' }), true)
    assert.equal(isGoldrushTransientError(SDK_RATE_LIMITED), true)
    assert.equal(isGoldrushTransientError({ error: true, error_code: 500, error_message: 'Pricing data unavailable for this chain' }), false)
    assert.equal(isGoldrushTransientError({ error: false, error_code: null, error_message: null }), false)
    assert.equal(isGoldrushTransientError(null), false)
  })
})
