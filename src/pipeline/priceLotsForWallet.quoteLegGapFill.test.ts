// Regression tests for the same-transaction quote-leg gap-fill data-flow fix in
// priceLotsForWallet.ts — confirmed production bug: the quote leg (USDC/WETH) is frequently a
// router-to-pool transfer that never touches the scanned wallet directly, so normalization honestly
// classifies its direction 'unknown' (src/modules/normalization/index.ts's classifyDirection) rather
// than the strict opposite of the target's own inbound/outbound. The gap-fill's previous
// `leg.direction === oppositeDirection` match silently excluded every such leg — 0 recovered in
// production despite 425 same-tx candidates. Fixed to match on "not the same direction as the
// target."
//
// Run directly with:
//   npx tsx --test src/pipeline/priceLotsForWallet.quoteLegGapFill.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { priceLotsForWallet } from './priceLotsForWallet.ts'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { PriceSourceFn, PriceSources } from '../modules/pricingAtTimeEngine/types'

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'goldrush', chain: 'base', txHash: '0xtx', timestamp: '2026-01-01T00:00:00.000Z',
    fromAddress: '0xfrom', toAddress: '0xto', contract: '0xtoken', symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

// A price source that returns null for every real token except a configured allowlist — used to
// force the gap-fill pass to be the ONLY way an entry gets priced, and to count real calls (proving
// "no additional provider calls" — the gap-fill itself never invokes this function for its own
// derivation, only resolvePricingAtTime's existing pass does, unmodified).
function nullExceptSources(allow: Record<string, number>): { sources: PriceSources; callCount: () => number } {
  let calls = 0
  const fn: PriceSourceFn = (token, chain) => {
    calls += 1
    return allow[`${chain}:${token.toLowerCase()}`] ?? null
  }
  return { sources: { primary: fn, fallback: fn }, callCount: () => calls }
}

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const WETH_BASE = '0x4200000000000000000000000000000000000006'
const MEME = '0x00000000000000000000000000000000000001'
const OTHER = '0x00000000000000000000000000000000000002'

describe('priceLotsForWallet — same-tx quote-leg gap-fill (real grouped-swap fixtures)', () => {
  it('1. real grouped-swap buy + USDC quote leg (router-mediated, unknown direction) recovers the entry price', async () => {
    const buy = event({ txHash: '0xbuy1', contract: MEME, direction: 'inbound', amount: 1000 })
    // Router-to-pool USDC transfer — never touches the wallet, so normalization classifies it
    // 'unknown', not 'outbound'. This is the exact production shape.
    const quoteLeg = event({
      txHash: '0xbuy1', contract: USDC_BASE, symbol: 'USDC', tokenDecimals: 6,
      amount: 500, direction: 'unknown', fromAddress: '0xrouter', toAddress: '0xpool',
    })
    const { sources, callCount } = nullExceptSources({})
    const lookups = await priceLotsForWallet({ normalizedEvents: [buy, quoteLeg], recoveredEvents: [], priceSources: sources })
    // costUsd/proceedsUsd store the TOTAL resolved USD value of the leg (price * amount) — the
    // quote leg's own $500 total value is exactly the target leg's total USD value too.
    assert.equal(lookups.priceUsdLookup(buy), 500)
    assert.ok(callCount() > 0, 'sanity: resolvePricingAtTime was actually invoked')
  })

  it('2. real grouped-swap sell + USDC quote leg recovers the exit price', async () => {
    const sell = event({ txHash: '0xsell1', contract: MEME, direction: 'outbound', amount: 2000 })
    const quoteLeg = event({
      txHash: '0xsell1', contract: USDC_BASE, symbol: 'USDC', tokenDecimals: 6,
      amount: 1000, direction: 'unknown', fromAddress: '0xpool', toAddress: '0xrouter',
    })
    const { sources } = nullExceptSources({})
    const lookups = await priceLotsForWallet({ normalizedEvents: [sell, quoteLeg], recoveredEvents: [], priceSources: sources })
    assert.equal(lookups.priceUsdLookup(sell), 1000)
  })

  it('3. WETH/native quote leg recovers a price when the WETH leg itself directly touched the wallet (its own resolved USD value is reused, zero extra calls)', async () => {
    const buy = event({ txHash: '0xbuy2', contract: MEME, direction: 'inbound', amount: 1000 })
    // This WETH leg DOES touch the wallet (outbound) — resolvePricingAtTime prices it directly.
    const weth = event({
      txHash: '0xbuy2', contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
      amount: 1, direction: 'outbound', fromAddress: '0xwallet', toAddress: '0xrouter',
    })
    const { sources } = nullExceptSources({ [`base:${WETH_BASE.toLowerCase()}`]: 3500 })
    const lookups = await priceLotsForWallet({ normalizedEvents: [buy, weth], recoveredEvents: [], priceSources: sources })
    assert.equal(lookups.priceUsdLookup(buy), 3500, '1 WETH at $3500/unit = $3500 total quote value')
  })

  it('4. quote leg absent from pricing requirements (unknown direction, excluded from buys/sells) but present in the swap-leg lookup is still used', async () => {
    const sell = event({ txHash: '0xsell2', contract: MEME, direction: 'outbound', amount: 100 })
    // 'unknown' direction — never appears in `buys`/`sells`, so it was never itself a pricing
    // requirement. It must still be found via groupSwapLegsByTransaction and used as the quote leg.
    const quoteLeg = event({
      txHash: '0xsell2', contract: USDC_BASE, symbol: 'USDC', tokenDecimals: 6,
      amount: 250, direction: 'unknown', fromAddress: '0xpool', toAddress: '0xrouter',
    })
    const { sources } = nullExceptSources({})
    const lookups = await priceLotsForWallet({ normalizedEvents: [sell, quoteLeg], recoveredEvents: [], priceSources: sources })
    assert.equal(lookups.priceUsdLookup(sell), 250)
  })

  it('5. no cross-chain or cross-tx matching', async () => {
    const buy = event({ txHash: '0xbuy3', chain: 'base', contract: MEME, direction: 'inbound', amount: 1000 })
    // Same txHash text, but a DIFFERENT chain — must never be treated as the same group.
    const wrongChainQuote = event({
      txHash: '0xbuy3', chain: 'eth', contract: USDC_BASE, symbol: 'USDC', tokenDecimals: 6,
      amount: 999999, direction: 'unknown',
    })
    // A different tx entirely — must never be borrowed as this buy's quote leg.
    const otherTxQuote = event({
      txHash: '0xunrelated', chain: 'base', contract: USDC_BASE, symbol: 'USDC', tokenDecimals: 6,
      amount: 777, direction: 'unknown',
    })
    const { sources } = nullExceptSources({})
    const lookups = await priceLotsForWallet({ normalizedEvents: [buy, wrongChainQuote, otherTxQuote], recoveredEvents: [], priceSources: sources })
    assert.equal(lookups.priceUsdLookup(buy), null, 'no real same-chain-same-tx quote leg exists for 0xbuy3 — must stay unpriced, never borrow from elsewhere')
  })

  it('6. router refund / unrelated transfer marked excludeReason-equivalent (same-direction, unrelated) is rejected', async () => {
    const buy = event({ txHash: '0xbuy4', contract: MEME, direction: 'inbound', amount: 1000 })
    // A second, unrelated INBOUND transfer in the same tx (e.g. an airdrop bundled in) — same
    // direction as the target, must never be treated as its quote leg.
    const unrelatedInbound = event({
      txHash: '0xbuy4', contract: OTHER, symbol: 'JUNK', direction: 'inbound', amount: 50,
    })
    const { sources } = nullExceptSources({})
    const lookups = await priceLotsForWallet({ normalizedEvents: [buy, unrelatedInbound], recoveredEvents: [], priceSources: sources })
    assert.equal(lookups.priceUsdLookup(buy), null)
  })

  it('7. deterministic regardless of input event order', async () => {
    const buy = event({ txHash: '0xbuy5', contract: MEME, direction: 'inbound', amount: 1000 })
    const quoteLeg = event({
      txHash: '0xbuy5', contract: USDC_BASE, symbol: 'USDC', tokenDecimals: 6,
      amount: 500, direction: 'unknown',
    })
    const { sources: sourcesA } = nullExceptSources({})
    const { sources: sourcesB } = nullExceptSources({})
    const lookupsA = await priceLotsForWallet({ normalizedEvents: [buy, quoteLeg], recoveredEvents: [], priceSources: sourcesA })
    const lookupsB = await priceLotsForWallet({ normalizedEvents: [quoteLeg, buy], recoveredEvents: [], priceSources: sourcesB })
    assert.equal(lookupsA.priceUsdLookup(buy), lookupsB.priceUsdLookup(buy))
  })

  it('8. an existing, stronger resolved price is never overwritten by the gap-fill', async () => {
    const buy = event({ txHash: '0xbuy6', contract: MEME, direction: 'inbound', amount: 1000 })
    const quoteLeg = event({
      txHash: '0xbuy6', contract: USDC_BASE, symbol: 'USDC', tokenDecimals: 6,
      amount: 500, direction: 'unknown',
    })
    // The target token itself already has a real, direct provider price (7/unit * 1000 = $7000 total,
    // versus the $500 total the quote leg would derive) — the gap-fill must never replace it.
    const { sources } = nullExceptSources({ [`base:${MEME.toLowerCase()}`]: 7 })
    const lookups = await priceLotsForWallet({ normalizedEvents: [buy, quoteLeg], recoveredEvents: [], priceSources: sources })
    assert.equal(lookups.priceUsdLookup(buy), 7000, 'the stronger, already-resolved provider price must win — never demoted by a same-tx quote estimate')
  })

  it('9. no additional provider calls: the quote-leg derivation itself never invokes the price source function', async () => {
    const buy = event({ txHash: '0xbuy7', contract: MEME, direction: 'inbound', amount: 1000 })
    const quoteLeg = event({
      txHash: '0xbuy7', contract: USDC_BASE, symbol: 'USDC', tokenDecimals: 6,
      amount: 500, direction: 'unknown',
    })
    const distinctTokensCalled = new Set<string>()
    const fn: PriceSourceFn = (token, chain) => { distinctTokensCalled.add(`${chain}:${token.toLowerCase()}`); return null }
    const lookups = await priceLotsForWallet({ normalizedEvents: [buy, quoteLeg], recoveredEvents: [], priceSources: { primary: fn, fallback: fn } })
    assert.equal(lookups.priceUsdLookup(buy), 500, 'sanity: the gap-fill still recovers the price')
    assert.ok(!distinctTokensCalled.has(`base:${USDC_BASE.toLowerCase()}`), 'the USDC quote leg (priced as a constant $1/unit) must never itself trigger a provider call')
  })

  it('10. FIFO lot matching and public PnL gating are unaffected by the gap-fill', async () => {
    const buy = event({ txHash: '0xbuy8', contract: MEME, direction: 'inbound', amount: 1000, timestamp: '2026-01-01T00:00:00.000Z' })
    const buyQuote = event({
      txHash: '0xbuy8', contract: USDC_BASE, symbol: 'USDC', tokenDecimals: 6,
      amount: 500, direction: 'unknown', timestamp: '2026-01-01T00:00:00.000Z',
    })
    const sell = event({ txHash: '0xsell8', contract: MEME, direction: 'outbound', amount: 1000, timestamp: '2026-01-02T00:00:00.000Z' })
    const sellQuote = event({
      txHash: '0xsell8', contract: USDC_BASE, symbol: 'USDC', tokenDecimals: 6,
      amount: 800, direction: 'unknown', timestamp: '2026-01-02T00:00:00.000Z',
    })
    const events = [buy, buyQuote, sell, sellQuote]
    const { sources } = nullExceptSources({})

    // FIFO matching computed from the RAW events, completely independent of pricing — same call
    // shape as the real pipeline's own structural pre-pass.
    const lotsWithoutPricing = buildLots(events, [])
    const { matchedLots: matchedWithoutPricing } = matchLotsFIFO(lotsWithoutPricing, [sell])

    const lookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sources })

    const lotsAfter = buildLots(events, [])
    const { matchedLots: matchedAfter } = matchLotsFIFO(lotsAfter, [sell])

    assert.deepEqual(matchedAfter, matchedWithoutPricing, 'FIFO quantities/matches must be byte-identical regardless of pricing')
    assert.equal(lookups.priceUsdLookup(buy), 500)
    assert.equal(lookups.priceUsdLookup(sell), 800)
  })

  it('11. production-shaped fixture: several router-mediated swaps with unknown-direction quote legs raise fullyPricedLots from 0', async () => {
    const events: NormalizedEvent[] = []
    for (let i = 0; i < 5; i += 1) {
      const token = `0x${(i + 10).toString().padStart(40, '0')}`
      events.push(event({ txHash: `0xprodbuy${i}`, contract: token, direction: 'inbound', amount: 1000, timestamp: '2026-01-01T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xprodbuy${i}`, contract: USDC_BASE, symbol: 'USDC', tokenDecimals: 6,
        amount: 500, direction: 'unknown', timestamp: '2026-01-01T00:00:00.000Z',
      }))
      events.push(event({ txHash: `0xprodsell${i}`, contract: token, direction: 'outbound', amount: 1000, timestamp: '2026-01-02T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xprodsell${i}`, contract: USDC_BASE, symbol: 'USDC', tokenDecimals: 6,
        amount: 600, direction: 'unknown', timestamp: '2026-01-02T00:00:00.000Z',
      }))
    }
    const { sources } = nullExceptSources({}) // every direct provider attempt genuinely fails, as in production
    const lookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sources })
    let fullyPriced = 0
    for (let i = 0; i < 5; i += 1) {
      const buyEvt = events.find((e) => e.txHash === `0xprodbuy${i}` && e.direction === 'inbound')!
      const sellEvt = events.find((e) => e.txHash === `0xprodsell${i}` && e.direction === 'outbound')!
      if (lookups.priceUsdLookup(buyEvt) != null && lookups.priceUsdLookup(sellEvt) != null) fullyPriced += 1
    }
    assert.equal(fullyPriced, 5, 'all 5 router-mediated swaps must now be fully priced via the same-tx quote leg, versus 0 before this fix')
  })
})
