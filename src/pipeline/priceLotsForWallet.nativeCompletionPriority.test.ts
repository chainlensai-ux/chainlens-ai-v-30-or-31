// Regression test for NATIVE QUOTE COMPLETION PRIORITY — production evidence: raw native pricing
// itself works (2 selected, 2 priced, 2 same-tx recoveries, 0 provider misses) but fullyPricedLots
// stayed flat (5 -> 5) — amount-only ranking can spend the ETH cap's only 2 slots on two requirements
// that do not, together, complete any closed lot.
//
// This fixture is specifically constructed so plain amount-only ranking (the prior round's behavior)
// would select two USELESS entry-side legs (large amounts, but their own lots' exit sides have no
// stablecoin escape and are NOT selected — so neither lot completes), while completion-aware ranking
// (tier 1: opposite side already stablecoin-priced) selects the two SMALL-amount tokens whose exit
// side is guaranteed via a stablecoin quote leg — completing two full lots instead of zero.
//
// Run with:
//   npx tsx --test src/pipeline/priceLotsForWallet.nativeCompletionPriority.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { priceLotsForWallet } from './priceLotsForWallet.ts'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { PriceSourceFn, PriceSources } from '../modules/pricingAtTimeEngine/types'

const WETH_BASE = '0x4200000000000000000000000000000000000006'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'goldrush', chain: 'base', txHash: '0xtx', timestamp: '2026-01-01T00:00:00.000Z',
    fromAddress: '0xfrom', toAddress: '0xto', contract: '0xtoken', symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

function memeToken(i: number): string {
  return `0x${(i + 300).toString().padStart(40, '0')}`
}

describe('priceLotsForWallet — native quote completion priority (42 requirements)', () => {
  it('completion-aware ranking increases fullyPricedLots where amount-only ranking would not', async () => {
    const events: NormalizedEvent[] = []

    // 40 "distractor" lots: LARGE native-quote amount on the ENTRY side, but the EXIT side has no
    // stablecoin escape either (its own quote is also native, small) — amount-only ranking would
    // greedily pick these large entry-side amounts first, but doing so completes NOTHING, because the
    // exit side is never selected too (cap = 2, all consumed by unrelated large entries).
    for (let i = 0; i < 40; i += 1) {
      const token = memeToken(i)
      const bigAmount = 100 + i // strictly larger than anything in the completable pair below
      events.push(event({ txHash: `0xdistractbuy${i}`, contract: token, direction: 'inbound', amount: 1000, timestamp: '2026-01-01T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xdistractbuy${i}`, contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
        amount: bigAmount, direction: 'unknown', timestamp: '2026-01-01T00:00:00.000Z',
      }))
      events.push(event({ txHash: `0xdistractsell${i}`, contract: token, direction: 'outbound', amount: 1000, timestamp: '2026-01-02T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xdistractsell${i}`, contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
        amount: 0.01, direction: 'unknown', timestamp: '2026-01-02T00:00:00.000Z',
      }))
    }

    // 2 "completable" lots: small native-quote amount on the ENTRY side, but the EXIT side already has
    // a verified STABLECOIN quote leg (USDC) — deterministically resolved at $1/unit, no provider call,
    // no cap slot. Completion-aware ranking (tier 1) recognizes that pricing the entry side here is
    // what actually completes a full lot, and prioritizes it over the much-larger distractor amounts.
    for (let i = 0; i < 2; i += 1) {
      const token = memeToken(40 + i)
      events.push(event({ txHash: `0xcompletebuy${i}`, contract: token, direction: 'inbound', amount: 1000, timestamp: '2026-01-01T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xcompletebuy${i}`, contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
        amount: 0.5, direction: 'unknown', timestamp: '2026-01-01T00:00:00.000Z',
      }))
      events.push(event({ txHash: `0xcompletesell${i}`, contract: token, direction: 'outbound', amount: 1000, timestamp: '2026-01-02T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xcompletesell${i}`, contract: USDC_BASE, symbol: 'USDC', tokenDecimals: 6,
        amount: 500, direction: 'unknown', timestamp: '2026-01-02T00:00:00.000Z',
      }))
    }

    let wethCallCount = 0
    const fn: PriceSourceFn = (token) => {
      if (token.toLowerCase() === WETH_BASE) wethCallCount += 1
      return token.toLowerCase() === WETH_BASE ? 3500 : null
    }
    const sources: PriceSources = { primary: fn, fallback: fn }

    // fullyPricedLots BEFORE: none of the 42 lots have any direct provider price for the memecoin, and
    // none has both sides resolved without this pass's native-quote reuse.
    const fullyPricedBefore = 0

    const lookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sources })

    let fullyPricedAfter = 0
    for (let i = 0; i < 2; i += 1) {
      const buy = events.find((e) => e.contract === memeToken(40 + i) && e.direction === 'inbound')!
      const sell = events.find((e) => e.contract === memeToken(40 + i) && e.direction === 'outbound')!
      if (lookups.priceUsdLookup(buy) != null && lookups.priceUsdLookup(sell) != null) fullyPricedAfter += 1
    }

    // No distractor lot became fully priced — amount-only ranking would have wasted the cap here.
    let distractorFullyPriced = 0
    for (let i = 0; i < 40; i += 1) {
      const buy = events.find((e) => e.contract === memeToken(i) && e.direction === 'inbound')!
      const sell = events.find((e) => e.contract === memeToken(i) && e.direction === 'outbound')!
      if (lookups.priceUsdLookup(buy) != null && lookups.priceUsdLookup(sell) != null) distractorFullyPriced += 1
    }

    assert.ok(fullyPricedAfter > fullyPricedBefore, 'fullyPricedLots must increase — completion-aware ranking must select the completable pair, not the largest raw amounts')
    assert.equal(fullyPricedAfter, 2, 'both completable lots (their entry side reused via WETH, exit side deterministically stablecoin-priced) should complete under the unchanged 2-slot cap')
    assert.equal(distractorFullyPriced, 0, 'amount-only ranking would have picked large useless distractor legs — completion-aware ranking must not')
    assert.ok(wethCallCount <= 2, 'no cap or provider-budget increase — the unchanged per-token cap (2) still bounds real WETH calls')
  })

  it('FIFO lot matching and public PnL gating are unaffected by completion-aware native ranking', async () => {
    const events: NormalizedEvent[] = []
    for (let i = 0; i < 5; i += 1) {
      const token = memeToken(50 + i)
      events.push(event({ txHash: `0xfifobuy${i}`, contract: token, direction: 'inbound', amount: 1000, timestamp: '2026-01-01T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xfifobuy${i}`, contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
        amount: 1 + i * 0.1, direction: 'unknown', timestamp: '2026-01-01T00:00:00.000Z',
      }))
      events.push(event({ txHash: `0xfifosell${i}`, contract: token, direction: 'outbound', amount: 1000, timestamp: '2026-01-02T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xfifosell${i}`, contract: USDC_BASE, symbol: 'USDC', tokenDecimals: 6,
        amount: 500, direction: 'unknown', timestamp: '2026-01-02T00:00:00.000Z',
      }))
    }
    const sellTargets = events.filter((e) => e.direction === 'outbound')
    const fn: PriceSourceFn = (token) => (token.toLowerCase() === WETH_BASE ? 3500 : null)
    const sources: PriceSources = { primary: fn, fallback: fn }

    const lotsBefore = buildLots(events, [])
    const { matchedLots: matchedBefore } = matchLotsFIFO(lotsBefore, sellTargets)

    await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sources })

    const lotsAfter = buildLots(events, [])
    const { matchedLots: matchedAfter } = matchLotsFIFO(lotsAfter, sellTargets)

    assert.deepEqual(matchedAfter, matchedBefore, 'FIFO quantities/matches must be byte-identical regardless of completion-aware native ranking')
  })
})
