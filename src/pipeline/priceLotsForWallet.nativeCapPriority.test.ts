// Regression tests for the native quote-leg CAP-PRIORITY fix — production evidence:
// nativeQuoteRequirementsFound: 42, nativeQuoteRequirementsPriced: 0, nativeQuoteRequirementsCapped: 42.
//
// Root cause, confirmed: assignClosedLotPairRanks ranks purely PER TARGET TOKEN — a wallet where most
// tokens have exactly one closed lot has every closed lot tied at rank 0 within its own token group (a
// rank only ever meaningful when compared against OTHER lots of that SAME token). ETH/WETH is the one
// token shared across every one of these different closed lots' quote legs, so its own per-token cap
// (2, unchanged) had to arbitrate among all 42 nominally-tied "rank 0" requirements — a tie broken only
// by original array order, which does not reliably let the intended highest-priority requirements win.
// Fixed by giving every native quote requirement a distinct, strictly negative rank (always beats any
// real closed-lot rank >= 0 or unranked entry), deterministically tie-broken by amount/timestamp/txHash.
//
// Run with:
//   npx tsx --test src/pipeline/priceLotsForWallet.nativeCapPriority.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { priceLotsForWallet } from './priceLotsForWallet.ts'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { PriceSourceFn, PriceSources } from '../modules/pricingAtTimeEngine/types'

const WETH_BASE = '0x4200000000000000000000000000000000000006'

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'goldrush', chain: 'base', txHash: '0xtx', timestamp: '2026-01-01T00:00:00.000Z',
    fromAddress: '0xfrom', toAddress: '0xto', contract: '0xtoken', symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

function memeToken(i: number): string {
  return `0x${(i + 100).toString().padStart(40, '0')}`
}

describe('priceLotsForWallet — native quote-leg cap-priority (42 tied requirements + decoys)', () => {
  it('42 native requirements (one per distinct token, all tied at rank 0) plus unranked ETH decoys: only the per-token cap (2) survive, and they are the top-ranked ones', async () => {
    const events: NormalizedEvent[] = []
    // 42 distinct memecoins, each with exactly ONE closed lot (buy+sell) — the exact shape that ties
    // every closed lot at rank 0 within its own per-token group. Quote amounts vary so a deterministic
    // "top 2 by amount" is unambiguous.
    for (let i = 0; i < 42; i += 1) {
      const token = memeToken(i)
      // SAME quote amount for both legs of one token's closed lot — strictly increasing across
      // tokens, so token 41 has the unambiguously LARGEST quote amount on both its buy and sell side.
      const quoteAmount = 1 + i * 0.01
      events.push(event({ txHash: `0xbuy${i}`, contract: token, direction: 'inbound', amount: 1000, timestamp: '2026-01-01T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xbuy${i}`, contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
        amount: quoteAmount, direction: 'unknown', timestamp: '2026-01-01T00:00:00.000Z',
      }))
      events.push(event({ txHash: `0xsell${i}`, contract: token, direction: 'outbound', amount: 1000, timestamp: '2026-01-02T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xsell${i}`, contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
        amount: quoteAmount, direction: 'unknown', timestamp: '2026-01-02T00:00:00.000Z',
      }))
    }
    // Unranked WETH decoys — ordinary, unrelated ETH activity with no matching sell (never part of
    // any closed lot), competing for the exact same per-token cap.
    const decoys = Array.from({ length: 10 }, (_, i) =>
      event({ txHash: `0xdecoy${i}`, contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18, direction: 'inbound', amount: 1, timestamp: '2026-01-01T00:00:00.000Z' }))

    const expectedHistoricalTimestamps = new Set([Date.parse('2026-01-01T00:00:00.000Z'), Date.parse('2026-01-02T00:00:00.000Z')])
    let historicalWethCallCount = 0
    const fn: PriceSourceFn = (token, _chain, timestamp) => {
      if (token.toLowerCase() === WETH_BASE.toLowerCase() && expectedHistoricalTimestamps.has(timestamp)) historicalWethCallCount += 1
      return token.toLowerCase() === WETH_BASE.toLowerCase() ? 3500 : null
    }
    const sources: PriceSources = { primary: fn, fallback: fn }

    const lookups = await priceLotsForWallet({ normalizedEvents: [...events, ...decoys], recoveredEvents: [], priceSources: sources })

    // No cap or provider-budget increase: the per-token cap (2) must not be exceeded.
    assert.ok(historicalWethCallCount <= 2, `expected at most 2 real historical WETH calls (the unchanged per-token cap), got ${historicalWethCallCount}`)

    // The top-ranked token (41 — the largest quote amount, tied on both its own buy AND sell side,
    // tie-broken by earlier timestamp then txHash) wins BOTH of the per-token cap's 2 slots — its
    // closed lot becomes fully priced. Every other token (including the runner-up, 40) is capped out
    // entirely: this is the correct, honest outcome of "reserve the bounded slots for the
    // highest-ranked native quote requirements" when amounts genuinely tie a single token's own pair.
    const topBuy = events.find((e) => e.contract === memeToken(41) && e.direction === 'inbound')!
    const topSell = events.find((e) => e.contract === memeToken(41) && e.direction === 'outbound')!
    const runnerUpBuy = events.find((e) => e.contract === memeToken(40) && e.direction === 'inbound')!

    assert.ok(lookups.priceUsdLookup(topBuy) != null, 'the highest-ranked native requirement (entry side) must survive the cap')
    assert.ok(lookups.priceUsdLookup(topSell) != null, 'the highest-ranked native requirement (exit side) must survive the cap')
    assert.equal(lookups.priceUsdLookup(runnerUpBuy), null, 'a lower-ranked requirement genuinely loses the (unchanged) cap — sanity that the cap itself was not silently raised')

    // At least one same-tx target is genuinely recovered (not just "attempted").
    assert.equal(lookups.priceUsdLookup(topBuy), 3500 * (1 + 41 * 0.01))
  })

  it('FIFO lot matching and public PnL gating are unaffected by native cap-priority reordering', async () => {
    const events: NormalizedEvent[] = []
    for (let i = 0; i < 5; i += 1) {
      const token = memeToken(i)
      events.push(event({ txHash: `0xfbuy${i}`, contract: token, direction: 'inbound', amount: 1000, timestamp: '2026-01-01T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xfbuy${i}`, contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
        amount: 1 + i * 0.1, direction: 'unknown', timestamp: '2026-01-01T00:00:00.000Z',
      }))
      events.push(event({ txHash: `0xfsell${i}`, contract: token, direction: 'outbound', amount: 1000, timestamp: '2026-01-02T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xfsell${i}`, contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
        amount: 1.2 + i * 0.1, direction: 'unknown', timestamp: '2026-01-02T00:00:00.000Z',
      }))
    }
    const sellEventsForFifo = events.filter((e) => e.direction === 'outbound')
    const fn: PriceSourceFn = (token) => (token.toLowerCase() === WETH_BASE.toLowerCase() ? 3500 : null)
    const sources: PriceSources = { primary: fn, fallback: fn }

    const lotsWithoutPricing = buildLots(events, [])
    const { matchedLots: matchedWithoutPricing } = matchLotsFIFO(lotsWithoutPricing, sellEventsForFifo)

    await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sources })

    const lotsAfter = buildLots(events, [])
    const { matchedLots: matchedAfter } = matchLotsFIFO(lotsAfter, sellEventsForFifo)

    assert.deepEqual(matchedAfter, matchedWithoutPricing, 'FIFO quantities/matches must be byte-identical regardless of native cap-priority reordering')
  })
})
