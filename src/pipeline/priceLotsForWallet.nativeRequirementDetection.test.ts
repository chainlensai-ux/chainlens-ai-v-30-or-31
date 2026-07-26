// Regression tests for the native-requirement DETECTION fix — production evidence:
// requirementsWithValidOppositeLeg: 84, nativeQuoteRequirementsFound: 0,
// nativeQuoteRequirementsPriced: 0, sameTxNativePricesRecovered: 0.
//
// Root cause, confirmed: the requirement-builder's "is this a native/WETH quote leg" predicate
// recognized a candidate only by `leg.symbol === 'ETH' || leg.symbol === 'WETH'`, a weaker,
// string-based signal than the canonical NATIVE_ASSET_ADDRESS every GoldRush-synthesized native leg
// actually carries (see providerFetchWindow/utils.ts's own native-value-synthesis fix), AND it only
// counted a leg with direction === 'unknown' — but a wallet-touching native leg (the common,
// synthesized shape) has a REAL direction (inbound/outbound), so it was excluded outright. Fixed by
// recognizing native/WETH legs by ADDRESS (isNativePseudoAddress/isCanonicalWethAddress) regardless
// of direction, and by resolving "priced" against whichever dictionary a real-direction leg's own
// ordinary requirement actually uses (no duplicate entry, no budget increase) versus a synthetic key
// only for genuinely 'unknown'-direction legs.
//
// Run with:
//   npx tsx --test src/pipeline/priceLotsForWallet.nativeRequirementDetection.test.ts

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchGoldrushRawEvents, NATIVE_ASSET_ADDRESS } from '../modules/providerFetchWindow/utils'
import { normalizeEvents } from '../modules/normalization/index'
import { priceLotsForWallet } from './priceLotsForWallet.ts'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import type { PriceSourceFn, PriceSources } from '../modules/pricingAtTimeEngine/types'

const originalFetch = global.fetch
const originalApiKey = process.env.GOLDRUSH_API_KEY

afterEach(() => {
  global.fetch = originalFetch
  process.env.GOLDRUSH_API_KEY = originalApiKey
})

const WALLET = '0x00000000000000000000000000000000000abc'
const MEME_TOKEN = '0x0000000000000000000000000000000000000001'
const ROUTER = '0xrouter000000000000000000000000000000000'
const POOL = '0xpool0000000000000000000000000000000000'

function mockCovalentResponse(txHash: string, timestamp: string, tokenAmountRaw: string, ethAmountRaw: string): void {
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
                  contract_address: MEME_TOKEN,
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

function memeFailsNativeSucceedsSources(nativePriceUsd: number): { sources: PriceSources; callCount: () => number } {
  let calls = 0
  const fn: PriceSourceFn = (token) => {
    calls += 1
    return token.toLowerCase() === NATIVE_ASSET_ADDRESS ? nativePriceUsd : null
  }
  return { sources: { primary: fn, fallback: fn }, callCount: () => calls }
}

describe('priceLotsForWallet — native-requirement detection (production-shaped, real NATIVE_ASSET_ADDRESS)', () => {
  it('a GoldRush-synthesized native pseudo-address leg is detected as a valid native quote candidate and recovers the entry price', async () => {
    mockCovalentResponse('0xnativereq1', new Date(Date.now() - 1 * 86400000).toISOString(), '1000000000000000000000', '1000000000000000000')
    const raw = await fetchGoldrushRawEvents('base', WALLET, 90)
    const { normalizedEvents } = normalizeEvents(raw.events, WALLET)

    const nativeLeg = normalizedEvents.find((e) => e.contract === NATIVE_ASSET_ADDRESS)
    assert.ok(nativeLeg, 'sanity: the synthesized native leg is present in normalizedEvents')
    // Confirms this is the SAME real shape production sees: a real (non-'unknown') direction, since
    // the wallet itself directly sent this native value.
    assert.equal(nativeLeg?.direction, 'outbound')

    const { sources } = memeFailsNativeSucceedsSources(3500)
    const buyLeg = normalizedEvents.find((e) => e.contract === MEME_TOKEN.toLowerCase())!
    const lookups = await priceLotsForWallet({ normalizedEvents, recoveredEvents: [], priceSources: sources })

    assert.equal(lookups.priceUsdLookup(buyLeg), 3500, 'the native leg must be recognized and its resolved value reused for the target buy')
  })

  it('fullyPricedLots rises from 0 to 1 for a matched native-pseudo-address buy+sell pair, with no budget increase', async () => {
    mockCovalentResponse('0xnativereq2', new Date(Date.now() - 2 * 86400000).toISOString(), '1000000000000000000000', '1000000000000000000')
    const buyRaw = await fetchGoldrushRawEvents('base', WALLET, 90)
    const { normalizedEvents: buyEvents } = normalizeEvents(buyRaw.events, WALLET)

    mockCovalentResponse('0xnativesell2b', new Date(Date.now() - 1 * 86400000).toISOString(), '1000000000000000000000', '2000000000000000000')
    const sellRaw = await fetchGoldrushRawEvents('base', WALLET, 90)
    const { normalizedEvents: sellRawNormalized } = normalizeEvents(sellRaw.events, WALLET)
    const sellEvents = sellRawNormalized.map((e) =>
      e.contract === MEME_TOKEN.toLowerCase()
        ? { ...e, direction: 'outbound' as const, fromAddress: WALLET.toLowerCase(), toAddress: ROUTER.toLowerCase() }
        : { ...e, direction: 'inbound' as const, fromAddress: ROUTER.toLowerCase(), toAddress: WALLET.toLowerCase() },
    )

    const allEvents = [...buyEvents, ...sellEvents]
    const { sources, callCount } = memeFailsNativeSucceedsSources(3500)

    const lotsWithoutPricing = buildLots(allEvents, [])
    const sellTargets = sellEvents.filter((e) => e.direction === 'outbound')
    const { matchedLots: matchedWithoutPricing } = matchLotsFIFO(lotsWithoutPricing, sellTargets)

    const lookups = await priceLotsForWallet({ normalizedEvents: allEvents, recoveredEvents: [], priceSources: sources })

    const buyLeg = buyEvents.find((e) => e.contract === MEME_TOKEN.toLowerCase())!
    const sellLeg = sellEvents.find((e) => e.contract === MEME_TOKEN.toLowerCase())!
    const entryPriced = lookups.priceUsdLookup(buyLeg) != null
    const exitPriced = lookups.priceUsdLookup(sellLeg) != null

    assert.ok(entryPriced && exitPriced, 'fullyPricedLots must rise from 0 (before this fix) to 1')
    assert.ok(callCount() > 0, 'sanity: resolvePricingAtTime genuinely ran')

    // FIFO must remain byte-identical — this fix only affects pricing, never lot matching.
    const lotsAfter = buildLots(allEvents, [])
    const { matchedLots: matchedAfter } = matchLotsFIFO(lotsAfter, sellTargets)
    assert.deepEqual(matchedAfter, matchedWithoutPricing, 'FIFO quantities/matches must be byte-identical')
  })

  it('a wallet-touching (real-direction) native leg is priced through its ordinary requirement, never a duplicate synthetic entry', async () => {
    mockCovalentResponse('0xnativereq3', new Date(Date.now() - 1 * 86400000).toISOString(), '1000000000000000000000', '1000000000000000000')
    const raw = await fetchGoldrushRawEvents('base', WALLET, 90)
    const { normalizedEvents } = normalizeEvents(raw.events, WALLET)

    let nativeCallCount = 0
    const fn: PriceSourceFn = (token) => {
      if (token.toLowerCase() === NATIVE_ASSET_ADDRESS) nativeCallCount += 1
      return token.toLowerCase() === NATIVE_ASSET_ADDRESS ? 3500 : null
    }
    const sources: PriceSources = { primary: fn, fallback: fn }

    await priceLotsForWallet({ normalizedEvents, recoveredEvents: [], priceSources: sources })

    // Exactly one real requirement exists for this native leg (its own ordinary buy/sell entry) — a
    // duplicate synthetic entry would double this count for the same real requirement.
    assert.equal(nativeCallCount, 1, 'a real-direction native leg must resolve through exactly one requirement, never a duplicate')
  })
})
