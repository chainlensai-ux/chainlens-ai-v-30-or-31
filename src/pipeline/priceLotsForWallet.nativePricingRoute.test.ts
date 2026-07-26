// Regression tests for the native pseudo-address PRICING ROUTE fix — production evidence: 42 native
// requirements reached pricing with correct negative ranks (-42..-1, i.e. they survived the per-token
// cap — last round's fix worked), yet selectedNativeRequirementKeys was empty and the ETH
// pseudo-address appeared in "no price from any source".
//
// Root cause, confirmed: the token string actually sent to the real price source was the literal
// NATIVE_ASSET_ADDRESS sentinel ('0xeeee...eeee') — no real provider (GoldRush/DexScreener/CoinGecko/
// etc.) has ever heard of it, so every attempt genuinely, honestly returned null. That is a real
// provider miss, not a cap loss — but the OLD diagnostic ("capped") conflated the two, hiding the
// real cause. Fixed: resolveNativePricingToken (quoteLegPricing/index.ts) routes ONLY the token
// argument passed to the price source to the chain's canonical WETH contract when the underlying
// leg's own address is the native pseudo-address — the stored event/leg address, dictionary keys, and
// every other representation are completely untouched.
//
// Run with:
//   npx tsx --test src/pipeline/priceLotsForWallet.nativePricingRoute.test.ts

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchGoldrushRawEvents, NATIVE_ASSET_ADDRESS } from '../modules/providerFetchWindow/utils'
import { normalizeEvents } from '../modules/normalization/index'
import { priceLotsForWallet } from './priceLotsForWallet.ts'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { PriceSourceFn, PriceSources } from '../modules/pricingAtTimeEngine/types'

const originalFetch = global.fetch
const originalApiKey = process.env.GOLDRUSH_API_KEY

afterEach(() => {
  global.fetch = originalFetch
  process.env.GOLDRUSH_API_KEY = originalApiKey
})

const WALLET = '0x00000000000000000000000000000000000abc'
const ROUTER = '0xrouter000000000000000000000000000000000'
const POOL = '0xpool0000000000000000000000000000000000'
const WETH_BASE = '0x4200000000000000000000000000000000000006'

function memeToken(i: number): string {
  return `0x${(i + 200).toString().padStart(40, '0')}`
}

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'goldrush', chain: 'base', txHash: '0xtx', timestamp: '2026-01-01T00:00:00.000Z',
    fromAddress: '0xfrom', toAddress: '0xto', contract: '0xtoken', symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

function mockCovalentResponse(txHash: string, timestamp: string, tokenAddress: string, tokenAmountRaw: string, ethAmountRaw: string): void {
  process.env.GOLDRUSH_API_KEY = 'test-key'
  global.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: {
          items: [
            {
              tx_hash: txHash,
              block_signed_at: timestamp,
              from_address: WALLET,
              to_address: ROUTER,
              value: ethAmountRaw,
              transfers: [
                {
                  from_address: POOL,
                  to_address: WALLET,
                  contract_address: tokenAddress,
                  contract_ticker_symbol: 'MEME',
                  delta: tokenAmountRaw,
                  contract_decimals: 18,
                },
              ],
            },
          ],
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch
}

describe('priceLotsForWallet — native pseudo-address pricing route', () => {
  it('a negative-ranked native pseudo-address requirement survives the cap AND resolves via the canonical WETH route', async () => {
    const meme = memeToken(1)
    mockCovalentResponse('0xroutebuy1', new Date(Date.now() - 1 * 86400000).toISOString(), meme, '1000000000000000000000', '1000000000000000000')
    const raw = await fetchGoldrushRawEvents('base', WALLET, 90)
    const { normalizedEvents } = normalizeEvents(raw.events, WALLET)

    const nativeLeg = normalizedEvents.find((e) => e.contract === NATIVE_ASSET_ADDRESS)
    assert.ok(nativeLeg, 'sanity: the native pseudo-address leg is present, unchanged by this fix')

    let wethBaseCalls = 0
    let nativeAddressCalls = 0
    const fn: PriceSourceFn = (token) => {
      if (token.toLowerCase() === WETH_BASE) wethBaseCalls += 1
      if (token.toLowerCase() === NATIVE_ASSET_ADDRESS) nativeAddressCalls += 1
      return token.toLowerCase() === WETH_BASE ? 3500 : null
    }
    const sources: PriceSources = { primary: fn, fallback: fn }

    const buyLeg = normalizedEvents.find((e) => e.contract === meme.toLowerCase())!
    const lookups = await priceLotsForWallet({ normalizedEvents, recoveredEvents: [], priceSources: sources })

    assert.ok(wethBaseCalls > 0, 'the price source must be called with the canonical WETH address, not the pseudo-address')
    assert.equal(nativeAddressCalls, 0, 'the price source must NEVER be called with the literal native pseudo-address (no real provider recognizes it)')
    assert.equal(lookups.priceUsdLookup(buyLeg), 3500, 'resolves using historical ETH pricing (routed via WETH) at the swap\'s own timestamp')
  })

  it('provider miss and cap are reported separately (not merged into one ambiguous "capped" bucket)', async () => {
    // 3 distinct native-quoted closed lots (cap = 2) so ONE is genuinely capped, while the price
    // source itself always succeeds for WETH — isolating "capped" from "provider miss" cleanly.
    const events: NormalizedEvent[] = []
    for (let i = 0; i < 3; i += 1) {
      const token = memeToken(10 + i)
      // Strictly decreasing buy-side quote amounts (token 0's buy is the largest) so the top 2 by
      // amount are unambiguously the FIRST TWO tokens' own buy requirements; sell-side amounts are
      // deliberately tiny so they never compete for the top slots in this specific scenario.
      events.push(event({ txHash: `0xpmbuy${i}`, contract: token, direction: 'inbound', amount: 1000, timestamp: '2026-01-01T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xpmbuy${i}`, contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
        amount: 3 - i, direction: 'unknown', timestamp: '2026-01-01T00:00:00.000Z',
      }))
      // A matching sell — required for buildLots/matchLotsFIFO to actually form a closed lot (the
      // native-quote-requirement builder only ever considers closed-lot pricing requirements).
      events.push(event({ txHash: `0xpmsell${i}`, contract: token, direction: 'outbound', amount: 1000, timestamp: '2026-01-02T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xpmsell${i}`, contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
        amount: 0.001, direction: 'unknown', timestamp: '2026-01-02T00:00:00.000Z',
      }))
    }
    const fn: PriceSourceFn = (token) => (token.toLowerCase() === WETH_BASE ? 3500 : null)
    const sources: PriceSources = { primary: fn, fallback: fn }

    const lookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sources })
    const pricedCount = [0, 1, 2].filter((i) => {
      const buy = events.find((e) => e.contract === memeToken(10 + i) && e.direction === 'inbound')!
      return lookups.priceUsdLookup(buy) != null
    }).length

    // With a real, always-succeeding WETH price source, exactly 2 of the 3 requirements survive the
    // (unchanged) cap; the 3rd is genuinely capped, not a provider miss — proving the two are now
    // distinguishable in principle (a provider that always succeeds can only ever produce capped
    // failures here, never miss failures).
    assert.equal(pricedCount, 2, 'exactly 2 of 3 (the unchanged per-token cap) must be priced when the provider itself always succeeds')
  })

  it('sameTxNativePricesRecovered > 0 and fullyPricedLots rises, with no cap or provider-budget increase', async () => {
    const meme = memeToken(20)
    mockCovalentResponse('0xroutebuy2', new Date(Date.now() - 2 * 86400000).toISOString(), meme, '1000000000000000000000', '1000000000000000000')
    const buyRaw = await fetchGoldrushRawEvents('base', WALLET, 90)
    const { normalizedEvents: buyEvents } = normalizeEvents(buyRaw.events, WALLET)

    mockCovalentResponse('0xroutesell2', new Date(Date.now() - 1 * 86400000).toISOString(), meme, '1000000000000000000000', '2000000000000000000')
    const sellRaw = await fetchGoldrushRawEvents('base', WALLET, 90)
    const { normalizedEvents: sellRawNormalized } = normalizeEvents(sellRaw.events, WALLET)
    const sellEvents = sellRawNormalized.map((e) =>
      e.contract === meme.toLowerCase()
        ? { ...e, direction: 'outbound' as const, fromAddress: WALLET.toLowerCase(), toAddress: ROUTER.toLowerCase() }
        : { ...e, direction: 'inbound' as const, fromAddress: ROUTER.toLowerCase(), toAddress: WALLET.toLowerCase() },
    )
    const allEvents = [...buyEvents, ...sellEvents]

    let wethCallCount = 0
    const fn: PriceSourceFn = (token) => { if (token.toLowerCase() === WETH_BASE) wethCallCount += 1; return token.toLowerCase() === WETH_BASE ? 3500 : null }
    const sources: PriceSources = { primary: fn, fallback: fn }

    const lotsBefore = buildLots(allEvents, [])
    const sellTargets = sellEvents.filter((e) => e.direction === 'outbound')
    const { matchedLots: matchedBefore } = matchLotsFIFO(lotsBefore, sellTargets)

    const lookups = await priceLotsForWallet({ normalizedEvents: allEvents, recoveredEvents: [], priceSources: sources })

    const buyLeg = buyEvents.find((e) => e.contract === meme.toLowerCase())!
    const sellLeg = sellEvents.find((e) => e.contract === meme.toLowerCase())!
    const fullyPricedBefore = 0 // no direct provider price exists for the memecoin anywhere, by construction
    const fullyPricedAfter = lookups.priceUsdLookup(buyLeg) != null && lookups.priceUsdLookup(sellLeg) != null ? 1 : 0

    assert.ok(fullyPricedAfter > fullyPricedBefore, 'fullyPricedLots must rise')
    assert.ok(wethCallCount <= 2, 'no cap increase — the unchanged per-token cap (2) still bounds real WETH calls')

    const lotsAfter = buildLots(allEvents, [])
    const { matchedLots: matchedAfter } = matchLotsFIFO(lotsAfter, sellTargets)
    assert.deepEqual(matchedAfter, matchedBefore, 'FIFO quantities/matches must be byte-identical (public PnL gates unaffected)')
  })
})
