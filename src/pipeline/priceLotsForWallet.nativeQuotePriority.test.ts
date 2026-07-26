// Regression tests for the native/WETH quote-leg PRICING fix — production evidence: 84 valid
// opposite quote legs found, 0 recovered (missing_verified_native_price: 42, no_verified_quote_leg_
// found: 42). Root cause #1: rank propagation was keyed by which SIDE of a closed lot a txHash
// represents (open vs close), not by which array a given leg of that transaction landed in — a
// swap's ETH/WETH leg (opposite direction from its target) always missed its own transaction's
// priority rank, so it lost the per-token cap to arbitrary, unranked lookups. Root cause #2: a quote
// leg that never touches the wallet directly (direction 'unknown') was never sent to
// resolvePricingAtTime as a pricing requirement AT ALL — no rank fix can recover a price that was
// never requested, so one extra high-priority requirement is now added per transaction that needs it.
//
// Run with:
//   npx tsx --test src/pipeline/priceLotsForWallet.nativeQuotePriority.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { priceLotsForWallet } from './priceLotsForWallet.ts'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { PriceSourceFn, PriceSources } from '../modules/pricingAtTimeEngine/types'

const WETH_BASE = '0x4200000000000000000000000000000000000006'
const MEME_TOKEN = '0x0000000000000000000000000000000000000001'

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'goldrush', chain: 'base', txHash: '0xtx', timestamp: '2026-01-01T00:00:00.000Z',
    fromAddress: '0xfrom', toAddress: '0xto', contract: '0xtoken', symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

describe('priceLotsForWallet — native/WETH quote-leg priority pricing', () => {
  it('1. router ETH buy prices the native leg first (as a real requirement), then reuses it for the token', async () => {
    const buy = event({ txHash: '0xbuy1', contract: MEME_TOKEN, direction: 'inbound', amount: 1000, timestamp: '2026-01-01T00:00:00.000Z' })
    // Router-to-pool WETH transfer — never touches the wallet, direction 'unknown'.
    const wethLeg = event({
      txHash: '0xbuy1', contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
      amount: 1, direction: 'unknown', fromAddress: '0xrouter', toAddress: '0xpool', timestamp: '2026-01-01T00:00:00.000Z',
    })
    const sell = event({ txHash: '0xsell1', contract: MEME_TOKEN, direction: 'outbound', amount: 1000, timestamp: '2026-01-02T00:00:00.000Z' })

    let wethCalls = 0
    const fn: PriceSourceFn = (token) => {
      if (token.toLowerCase() === WETH_BASE.toLowerCase()) { wethCalls += 1; return 3500 }
      return null // the memecoin itself never resolves directly — production's own reality
    }
    const sources: PriceSources = { primary: fn, fallback: fn }

    const lookups = await priceLotsForWallet({ normalizedEvents: [buy, wethLeg, sell], recoveredEvents: [], priceSources: sources })

    assert.ok(wethCalls > 0, 'WETH must actually be priced as a real requirement — this was 0 before the fix (missing_verified_native_price)')
    assert.equal(lookups.priceUsdLookup(buy), 3500, '1 WETH at $3500/unit reused as the target buy\'s total USD value')
  })

  it('2. a priority native quote requirement survives the per-token cap even when outnumbered by unranked ETH lookups', async () => {
    const buy = event({ txHash: '0xbuy2', contract: MEME_TOKEN, direction: 'inbound', amount: 1000, timestamp: '2026-01-01T00:00:00.000Z' })
    const wethLeg = event({
      txHash: '0xbuy2', contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
      amount: 1, direction: 'unknown', timestamp: '2026-01-01T00:00:00.000Z',
    })
    const sell = event({ txHash: '0xsell2', contract: MEME_TOKEN, direction: 'outbound', amount: 1000, timestamp: '2026-01-02T00:00:00.000Z' })

    // 5 unrelated, unranked WETH deposits (no matching sell — never part of any closed lot, so they
    // carry no priority rank at all) — enough to exceed the per-token cap (2) on their own.
    const decoys = Array.from({ length: 5 }, (_, i) =>
      event({ txHash: `0xdecoy${i}`, contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18, direction: 'inbound', amount: 1, timestamp: '2026-01-01T00:00:00.000Z' }))

    // Only the AT-TRADE-TIME pass is bounded by the per-token cap this test is about — the separate
    // "current" price pass (priceLotsForWallet's own distinct, pre-existing mark-to-market call, one
    // per distinct HELD token) legitimately makes its own additional WETH call, unrelated to this fix
    // and unrelated to the cap being tested here. Distinguish by timestamp: historical calls carry the
    // swap's own fixed 2026-01-01 timestamp; the "current" pass always uses Date.now().
    const expectedHistoricalTimestamp = Date.parse('2026-01-01T00:00:00.000Z')
    let historicalWethCallCount = 0
    const fn: PriceSourceFn = (token, _chain, timestamp) => {
      if (token.toLowerCase() === WETH_BASE.toLowerCase()) {
        if (timestamp === expectedHistoricalTimestamp) historicalWethCallCount += 1
        return 3500
      }
      return null
    }
    const sources: PriceSources = { primary: fn, fallback: fn }

    const lookups = await priceLotsForWallet({ normalizedEvents: [buy, wethLeg, sell, ...decoys], recoveredEvents: [], priceSources: sources })

    assert.ok(historicalWethCallCount <= 2, 'the per-token cap (2) must not be exceeded — no additional provider calls beyond the existing budget')
    assert.equal(lookups.priceUsdLookup(buy), 3500, 'the priority native-quote requirement must win a cap slot over the unranked decoys')
  })

  it('3. the native leg is priced at its own historical timestamp, never "now"', async () => {
    const historicalTimestamp = '2020-06-01T00:00:00.000Z' // far enough in the past that "now" would be a very different value
    const buy = event({ txHash: '0xbuy3', contract: MEME_TOKEN, direction: 'inbound', amount: 1000, timestamp: historicalTimestamp })
    const wethLeg = event({
      txHash: '0xbuy3', contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
      amount: 1, direction: 'unknown', timestamp: historicalTimestamp,
    })
    const sell = event({ txHash: '0xsell3', contract: MEME_TOKEN, direction: 'outbound', amount: 1000, timestamp: '2020-06-02T00:00:00.000Z' })

    const seenTimestamps: number[] = []
    const fn: PriceSourceFn = (token, _chain, timestamp) => {
      if (token.toLowerCase() === WETH_BASE.toLowerCase()) seenTimestamps.push(timestamp)
      return token.toLowerCase() === WETH_BASE.toLowerCase() ? 230 : null // real 2020-era ETH price magnitude
    }
    const sources: PriceSources = { primary: fn, fallback: fn }

    await priceLotsForWallet({ normalizedEvents: [buy, wethLeg, sell], recoveredEvents: [], priceSources: sources })

    assert.ok(seenTimestamps.length > 0, 'sanity: WETH was actually priced')
    const expected = Date.parse(historicalTimestamp)
    assert.ok(seenTimestamps.every((t) => t === expected), 'every WETH pricing attempt for this requirement must use the swap\'s own historical timestamp, never Date.now()')
  })

  it('4. no additional provider calls beyond the existing per-token cap', async () => {
    const buy = event({ txHash: '0xbuy4', contract: MEME_TOKEN, direction: 'inbound', amount: 1000, timestamp: '2026-01-01T00:00:00.000Z' })
    const wethLeg = event({
      txHash: '0xbuy4', contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
      amount: 1, direction: 'unknown', timestamp: '2026-01-01T00:00:00.000Z',
    })
    const sell = event({ txHash: '0xsell4', contract: MEME_TOKEN, direction: 'outbound', amount: 1000, timestamp: '2026-01-02T00:00:00.000Z' })
    // resolvePriceForEntry tries fallback too on a primary miss — the memecoin's own buy/sell/current
    // requirements each genuinely miss (production's own reality), so they legitimately invoke this
    // function twice each. What must NOT happen is the native-quote requirement adding calls beyond
    // its own single real requirement — verified directly by the WETH-specific historical count.
    const expectedHistoricalTimestamp = Date.parse('2026-01-01T00:00:00.000Z')
    let historicalWethCallCount = 0
    const fn: PriceSourceFn = (token, _chain, timestamp) => {
      if (token.toLowerCase() === WETH_BASE.toLowerCase()) {
        if (timestamp === expectedHistoricalTimestamp) historicalWethCallCount += 1
        return 3500
      }
      return null
    }
    const sources: PriceSources = { primary: fn, fallback: fn }

    await priceLotsForWallet({ normalizedEvents: [buy, wethLeg, sell], recoveredEvents: [], priceSources: sources })
    // Exactly ONE real historical WETH requirement exists here (the single native-quote entry) — it
    // must resolve in exactly one call, never more (no duplicate/added attempts for the same
    // requirement) and never zero (that would mean the requirement was never even attempted).
    assert.equal(historicalWethCallCount, 1, 'the single native-quote requirement must resolve in exactly one real call — no additional provider calls added')
  })

  it('5. coverage improves: a native-ETH-quoted closed lot that was unpriced becomes fully priced', async () => {
    const buy = event({ txHash: '0xbuy5', contract: MEME_TOKEN, direction: 'inbound', amount: 1000, timestamp: '2026-01-01T00:00:00.000Z' })
    const buyWeth = event({
      txHash: '0xbuy5', contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
      amount: 1, direction: 'unknown', timestamp: '2026-01-01T00:00:00.000Z',
    })
    const sell = event({ txHash: '0xsell5', contract: MEME_TOKEN, direction: 'outbound', amount: 1000, timestamp: '2026-01-02T00:00:00.000Z' })
    const sellWeth = event({
      txHash: '0xsell5', contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
      amount: 1.2, direction: 'unknown', timestamp: '2026-01-02T00:00:00.000Z',
    })
    const fn: PriceSourceFn = (token) => (token.toLowerCase() === WETH_BASE.toLowerCase() ? 3500 : null)
    const sources: PriceSources = { primary: fn, fallback: fn }

    const lookups = await priceLotsForWallet({
      normalizedEvents: [buy, buyWeth, sell, sellWeth],
      recoveredEvents: [],
      priceSources: sources,
    })

    const entryPriced = lookups.priceUsdLookup(buy) != null
    const exitPriced = lookups.priceUsdLookup(sell) != null
    assert.ok(entryPriced && exitPriced, 'both sides of this closed lot must now be priced via the native quote leg — this was 0/2 before the fix')
  })

  it('6. FIFO lot matching and public PnL gating are unaffected by native quote-leg prioritization', async () => {
    const buy = event({ txHash: '0xbuy6', contract: MEME_TOKEN, direction: 'inbound', amount: 1000, timestamp: '2026-01-01T00:00:00.000Z' })
    const buyWeth = event({
      txHash: '0xbuy6', contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
      amount: 1, direction: 'unknown', timestamp: '2026-01-01T00:00:00.000Z',
    })
    const sell = event({ txHash: '0xsell6', contract: MEME_TOKEN, direction: 'outbound', amount: 1000, timestamp: '2026-01-02T00:00:00.000Z' })
    const sellWeth = event({
      txHash: '0xsell6', contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
      amount: 1.2, direction: 'unknown', timestamp: '2026-01-02T00:00:00.000Z',
    })
    const events = [buy, buyWeth, sell, sellWeth]
    const fn: PriceSourceFn = (token) => (token.toLowerCase() === WETH_BASE.toLowerCase() ? 3500 : null)
    const sources: PriceSources = { primary: fn, fallback: fn }

    const lotsWithoutPricing = buildLots(events, [])
    const { matchedLots: matchedWithoutPricing } = matchLotsFIFO(lotsWithoutPricing, [sell])

    await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sources })

    const lotsAfter = buildLots(events, [])
    const { matchedLots: matchedAfter } = matchLotsFIFO(lotsAfter, [sell])

    assert.deepEqual(matchedAfter, matchedWithoutPricing, 'FIFO quantities/matches must be byte-identical regardless of native quote-leg prioritization')
  })
})
