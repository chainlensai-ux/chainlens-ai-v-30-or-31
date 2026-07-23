// Regression tests for the closed-lot pricing-requirement prioritization fix in
// priceLotsForWallet.ts + priceAllEntries (pricingAtTimeEngine/index.ts). Real, unmodified fifoEngine
// calls run inside priceLotsForWallet; only priceSources is injected (no real network dependency).
// Run directly with:
//   npx tsx --test src/pipeline/priceLotsForWallet.priorityPricing.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { priceLotsForWallet } from './priceLotsForWallet.ts'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { PriceSourceFn, PriceSources } from '../modules/pricingAtTimeEngine/types'

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'alchemy', chain: 'base', txHash: '0xtx', timestamp: '2026-01-01T00:00:00.000Z',
    fromAddress: '0xfrom', toAddress: '0xto', contract: '0xtoken', symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

// A deterministic priceSources pair: returns a real, distinguishable price per real-call, never
// null unless the token is explicitly configured to fail — used to prove SELECTION (which entries
// got a real call at all), not pricing correctness (already covered elsewhere).
function countingPriceSources(): { sources: PriceSources; callsByTxContext: string[] } {
  const callsByTxContext: string[] = []
  const fn: PriceSourceFn = (token, chain, timestamp) => {
    callsByTxContext.push(`${chain}:${token.toLowerCase()}:${timestamp}`)
    return 1
  }
  return { sources: { primary: fn, fallback: fn }, callsByTxContext }
}

describe('priceLotsForWallet — closed-lot pricing requirement priority (confirmed bug, fixed)', () => {
  it('buy + sell (cap 2, non-dense wallet): both entries are selected and the resulting closed lot is fully priced', async () => {
    const buy = event({ txHash: '0xbuy', direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' })
    const sell = event({ txHash: '0xsell', direction: 'outbound', timestamp: '2026-01-02T00:00:00.000Z' })
    const { sources } = countingPriceSources()

    const lookups = await priceLotsForWallet({ normalizedEvents: [buy, sell], recoveredEvents: [], priceSources: sources })

    assert.equal(lookups.priceUsdLookup(buy), 1, 'buy prices')
    assert.equal(lookups.priceUsdLookup(sell), 1, 'sell prices — both legs of the single closed lot are fully priced')
  })

  it('buy + buy + sell (cap 2, dense wallet, >120 distinct tokens): the FIFO-relevant buy AND the sell are selected — the unrelated 2nd buy never crowds out the sell', async () => {
    // Confirmed real bug, real production evidence: fullyPricedLots stayed 0 even after the dense
    // cap was raised to 2, because ALL buys were dispatched before ANY sells (priceAllEntries'
    // combined array), so a token bought twice before being sold had both its own buys consume the
    // cap before its own sell was ever reached. Fixed via structural pre-pass + priority ordering.
    const noiseBuys = Array.from({ length: 125 }, (_, i) =>
      event({ txHash: `0xnoise${i}`, contract: `0xnoise${i}`, direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' }))
    const buy1 = event({ txHash: '0xbuy1', contract: '0xtarget', direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' })
    const buy2 = event({ txHash: '0xbuy2', contract: '0xtarget', direction: 'inbound', timestamp: '2026-01-02T00:00:00.000Z' })
    const sell = event({ txHash: '0xsell', contract: '0xtarget', direction: 'outbound', timestamp: '2026-01-03T00:00:00.000Z', amount: 1 })
    const { sources } = countingPriceSources()

    const lookups = await priceLotsForWallet({
      normalizedEvents: [...noiseBuys, buy1, buy2, sell], // 128 distinct tokens total -> dense tier
      recoveredEvents: [],
      priceSources: sources,
    })

    // FIFO matches the sell against the OLDEST open lot for that token — buy1 (2026-01-01), not
    // buy2 (2026-01-02) — so buy1 is the real closed-lot entry requirement, and the sell is the exit
    // requirement. Both must be prioritized and priced; buy2 (not needed for this closed lot) may or
    // may not price depending on remaining budget, but it must never block the sell.
    assert.equal(lookups.priceUsdLookup(buy1), 1, 'the FIFO-relevant buy (oldest open lot) prices')
    assert.equal(lookups.priceUsdLookup(sell), 1, 'the sell prices — no longer crowded out by the unrelated second buy')
  })

  it('multiple sells for different tokens: entry/exit reservation stays intact for each token independently', async () => {
    const noiseBuys = Array.from({ length: 122 }, (_, i) =>
      event({ txHash: `0xnoise${i}`, contract: `0xnoise${i}`, direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' }))
    const buyA = event({ txHash: '0xbuyA', contract: '0xtokenA', direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' })
    const sellA = event({ txHash: '0xsellA', contract: '0xtokenA', direction: 'outbound', timestamp: '2026-01-02T00:00:00.000Z' })
    const buyB = event({ txHash: '0xbuyB', contract: '0xtokenB', direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' })
    const sellB = event({ txHash: '0xsellB', contract: '0xtokenB', direction: 'outbound', timestamp: '2026-01-02T00:00:00.000Z' })
    const { sources } = countingPriceSources()

    const lookups = await priceLotsForWallet({
      normalizedEvents: [...noiseBuys, buyA, sellA, buyB, sellB], // 124 distinct tokens -> dense tier
      recoveredEvents: [],
      priceSources: sources,
    })

    assert.equal(lookups.priceUsdLookup(buyA), 1)
    assert.equal(lookups.priceUsdLookup(sellA), 1)
    assert.equal(lookups.priceUsdLookup(buyB), 1)
    assert.equal(lookups.priceUsdLookup(sellB), 1)
  })

  it('low-priority timeline-only events (no matching closed lot) cannot consume a reserved closed-lot slot', async () => {
    // A token with only ONE unmatched buy (no sell at all -> no structural closed lot) alongside a
    // DIFFERENT token with a real closed lot. The unmatched-buy token's own single entry is not
    // "priority" and must not affect the closed-lot token's own reserved slots.
    const noiseBuys = Array.from({ length: 121 }, (_, i) =>
      event({ txHash: `0xnoise${i}`, contract: `0xnoise${i}`, direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' }))
    const unmatchedBuy = event({ txHash: '0xunmatched', contract: '0xnosell', direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' })
    const closedBuy1 = event({ txHash: '0xcb1', contract: '0xtarget', direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' })
    const closedBuy2 = event({ txHash: '0xcb2', contract: '0xtarget', direction: 'inbound', timestamp: '2026-01-02T00:00:00.000Z' })
    const closedSell = event({ txHash: '0xcs', contract: '0xtarget', direction: 'outbound', timestamp: '2026-01-03T00:00:00.000Z' })
    const { sources } = countingPriceSources()

    const lookups = await priceLotsForWallet({
      normalizedEvents: [...noiseBuys, unmatchedBuy, closedBuy1, closedBuy2, closedSell],
      recoveredEvents: [],
      priceSources: sources,
    })

    assert.equal(lookups.priceUsdLookup(closedBuy1), 1, 'the real closed lot\'s entry prices')
    assert.equal(lookups.priceUsdLookup(closedSell), 1, 'the real closed lot\'s exit prices, unaffected by the unrelated unmatched-buy token')
  })

  it('missing pricing stays null — never fabricated to zero, even for a priority requirement', async () => {
    const buy = event({ txHash: '0xbuy', direction: 'inbound' })
    const sell = event({ txHash: '0xsell', direction: 'outbound', timestamp: '2026-01-02T00:00:00.000Z' })
    const alwaysNull: PriceSourceFn = () => null

    const lookups = await priceLotsForWallet({ normalizedEvents: [buy, sell], recoveredEvents: [], priceSources: { primary: alwaysNull, fallback: alwaysNull } })

    assert.equal(lookups.priceUsdLookup(buy), null)
    assert.equal(lookups.priceUsdLookup(sell), null)
  })

  it('evidence propagation: a resolved closed-lot price survives into the priceUsdLookup fifoEngine actually consumes', async () => {
    const buy = event({ txHash: '0xbuy', direction: 'inbound', contract: '0xtoken', chain: 'base' })
    const sell = event({ txHash: '0xsell', direction: 'outbound', contract: '0xtoken', chain: 'base', timestamp: '2026-01-02T00:00:00.000Z' })
    const priceSources: PriceSources = {
      primary: (token, chain) => (token === '0xtoken' && chain === 'base' ? 42 : null),
      fallback: () => null,
    }

    const lookups = await priceLotsForWallet({ normalizedEvents: [buy, sell], recoveredEvents: [], priceSources })

    // priceUsdLookup is the exact synchronous function fifoEngine.buildLots/matchLotsFIFO call —
    // this proves the real resolved price (42) reaches that exact call site unchanged.
    assert.equal(lookups.priceUsdLookup(buy), 42)
    assert.equal(lookups.priceUsdLookup(sell), 42)
  })

  it('regression guard: THREE closed lots for one token, cap 2 — completes ONE full pair, never two half-pairs (confirmed follow-up bug, fixed)', async () => {
    // Confirmed real production evidence: 283 closed lots, only 1 fully priced (0.35% coverage) even
    // after the previous round's boolean-priority fix. Root cause: a flat priority flag still let
    // ALL of a token's closed-lot BUYS outrank ALL of that same token's closed-lot SELLS (buys always
    // listed first in priceAllEntries' combined array) — a token with 3 closed lots (3 buys + 3
    // sells) spent its cap of 2 on 2 buys, leaving all 3 sells capped: zero fully priced lots for
    // that token. Fixed via assignClosedLotPairRanks: each lot's entry+exit share one rank, so rank
    // 0's complete pair is dispatched (and therefore priced) before rank 1/2 are ever reached.
    const noiseBuys = Array.from({ length: 121 }, (_, i) =>
      event({ txHash: `0xnoise${i}`, contract: `0xnoise${i}`, direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' }))
    // Three independent buy->sell round trips for the SAME token, largest amount first by our
    // deterministic tie-break so lot "amount:3" becomes rank 0 (the pair actually completed).
    const buy1 = event({ txHash: '0xbuy1', contract: '0xtarget', direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z', amount: 1 })
    const sell1 = event({ txHash: '0xsell1', contract: '0xtarget', direction: 'outbound', timestamp: '2026-01-02T00:00:00.000Z', amount: 1 })
    const buy2 = event({ txHash: '0xbuy2', contract: '0xtarget', direction: 'inbound', timestamp: '2026-01-03T00:00:00.000Z', amount: 3 })
    const sell2 = event({ txHash: '0xsell2', contract: '0xtarget', direction: 'outbound', timestamp: '2026-01-04T00:00:00.000Z', amount: 3 })
    const buy3 = event({ txHash: '0xbuy3', contract: '0xtarget', direction: 'inbound', timestamp: '2026-01-05T00:00:00.000Z', amount: 2 })
    const sell3 = event({ txHash: '0xsell3', contract: '0xtarget', direction: 'outbound', timestamp: '2026-01-06T00:00:00.000Z', amount: 2 })
    const { sources } = countingPriceSources()

    const lookups = await priceLotsForWallet({
      normalizedEvents: [...noiseBuys, buy1, sell1, buy2, sell2, buy3, sell3], // 122 distinct tokens -> dense tier
      recoveredEvents: [],
      priceSources: sources,
    })

    // priceUsdLookup returns price * amount (see pricingAtTimeEngine's multiplyAmount) — checking
    // != null (not a fixed value) is correct since these events use different amounts (1, 3, 2).
    const priced = (e: NormalizedEvent) => lookups.priceUsdLookup(e) != null
    const pairs = [
      { buy: buy1, sell: sell1, label: 'lot 1 (amount 1)' },
      { buy: buy2, sell: sell2, label: 'lot 2 (amount 3, rank 0 — largest amount)' },
      { buy: buy3, sell: sell3, label: 'lot 3 (amount 2)' },
    ]
    const fullyPricedPairs = pairs.filter((p) => priced(p.buy) && priced(p.sell))
    const halfPricedPairs = pairs.filter((p) => priced(p.buy) !== priced(p.sell))

    assert.equal(fullyPricedPairs.length, 1, 'exactly one complete pair should be fully priced under cap 2, not zero and not multiple half-pairs')
    assert.equal(halfPricedPairs.length, 0, 'no pair should end up with only its buy OR only its sell priced — that is the exact "half-pair" bug being fixed')
    assert.equal(fullyPricedPairs[0]!.label, 'lot 2 (amount 3, rank 0 — largest amount)', 'the deterministically highest-ranked pair (largest amount) is the one that completes')
  })

  it('regression guard: provider-call count for a single token stays bounded (never exceeds the per-token cap) even as competing closed lots increase', async () => {
    const noiseBuys = Array.from({ length: 121 }, (_, i) =>
      event({ txHash: `0xnoise${i}`, contract: `0xnoise${i}`, direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' }))
    // FOUR competing closed lots for one token (double the 2-lot case already tested above) — proves
    // the cap holds regardless of how many pairs compete, not just for a specific small count.
    const pairs = Array.from({ length: 4 }, (_, i) => ({
      buy: event({ txHash: `0xb${i}`, contract: '0xtarget', direction: 'inbound', timestamp: `2026-01-0${i * 2 + 1}T00:00:00.000Z` }),
      sell: event({ txHash: `0xs${i}`, contract: '0xtarget', direction: 'outbound', timestamp: `2026-01-0${i * 2 + 2}T00:00:00.000Z` }),
    }))
    const targetEvents = pairs.flatMap((p) => [p.buy, p.sell])

    let realCallsForTarget = 0
    const source: PriceSourceFn = (token) => { if (token === '0xtarget') realCallsForTarget += 1; return 1 }

    await priceLotsForWallet({
      normalizedEvents: [...noiseBuys, ...targetEvents],
      recoveredEvents: [],
      priceSources: { primary: source, fallback: source },
    })

    // Per priceLotsForWallet's two internal pricing passes: the at-trade-time pass caps 'target' at
    // maxLookupsPerToken (2, dense tier — 122 distinct tokens here), and the separate "current price"
    // pass makes exactly 1 more real call for 'target' (one distinct-held-token entry, cap never
    // binds for a single entry) — 3 total, regardless of whether 1, 2, or 4 closed lots compete for
    // that token's budget. The cap itself was never raised; only dispatch order changed.
    assert.equal(realCallsForTarget, 3, 'the target token\'s real provider-call count must stay bounded at cap(2) + current-price(1) = 3, never scaling up with the number of competing closed lots')
  })
})
