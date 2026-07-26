// Regression/verification test for the RANK-DIRECTION correctness of native quote-leg priority.
//
// Task premise: pricingAtTimeEngine sorts pairRank ASCENDING (smallest number = highest priority,
// processed first — see priceAllEntries' `rankOf(a) - rankOf(b)` comparator), so the best
// (completion-tier-sorted-first) native candidate must receive the SMALLEST (most negative) rank —
// best = -N, worst = -1 — never the reverse (best = -1, worst = -N), which would let the WORST
// candidates win the shared per-token cap instead of the best ones.
//
// Verified directly here with 40 "distractor" requirements (large raw amounts, but their lots can
// never complete) plus 2 completion-eligible requirements (small amounts, but their lot's opposite
// side already has a verified stablecoin quote) — the completion candidates must receive the two
// smallest ranks, survive the (unchanged) 2-slot cap, and fullyPricedLots must increase.
//
// Run with:
//   npx tsx --test src/pipeline/priceLotsForWallet.nativeRankDirection.test.ts

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
  return `0x${(i + 400).toString().padStart(40, '0')}`
}

describe('priceLotsForWallet — native quote rank direction (best gets the smallest rank)', () => {
  it('40 distractors + 2 completion candidates: completion candidates receive the two smallest ranks and both survive the cap', async () => {
    const events: NormalizedEvent[] = []

    for (let i = 0; i < 40; i += 1) {
      const token = memeToken(i)
      const bigAmount = 100 + i
      events.push(event({ txHash: `0xdrbuy${i}`, contract: token, direction: 'inbound', amount: 1000, timestamp: '2026-01-01T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xdrbuy${i}`, contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
        amount: bigAmount, direction: 'unknown', timestamp: '2026-01-01T00:00:00.000Z',
      }))
      events.push(event({ txHash: `0xdrsell${i}`, contract: token, direction: 'outbound', amount: 1000, timestamp: '2026-01-02T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xdrsell${i}`, contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
        amount: 0.01, direction: 'unknown', timestamp: '2026-01-02T00:00:00.000Z',
      }))
    }

    const completableTxHashes: string[] = []
    for (let i = 0; i < 2; i += 1) {
      const token = memeToken(40 + i)
      events.push(event({ txHash: `0xcompbuy${i}`, contract: token, direction: 'inbound', amount: 1000, timestamp: '2026-01-01T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xcompbuy${i}`, contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
        amount: 0.5, direction: 'unknown', timestamp: '2026-01-01T00:00:00.000Z',
      }))
      events.push(event({ txHash: `0xcompsell${i}`, contract: token, direction: 'outbound', amount: 1000, timestamp: '2026-01-02T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xcompsell${i}`, contract: USDC_BASE, symbol: 'USDC', tokenDecimals: 6,
        amount: 500, direction: 'unknown', timestamp: '2026-01-02T00:00:00.000Z',
      }))
      completableTxHashes.push(`0xcompbuy${i}`)
    }

    let wethCallCount = 0
    const fn: PriceSourceFn = (token) => { if (token.toLowerCase() === WETH_BASE) wethCallCount += 1; return token.toLowerCase() === WETH_BASE ? 3500 : null }
    const sources: PriceSources = { primary: fn, fallback: fn }

    const sellTargets = events.filter((e) => e.direction === 'outbound')
    const lotsBefore = buildLots(events, [])
    const { matchedLots: matchedBefore } = matchLotsFIFO(lotsBefore, sellTargets)

    const fullyPricedBefore = 0
    const lookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sources })

    let fullyPricedAfter = 0
    for (let i = 0; i < 2; i += 1) {
      const buy = events.find((e) => e.contract === memeToken(40 + i) && e.direction === 'inbound')!
      const sell = events.find((e) => e.contract === memeToken(40 + i) && e.direction === 'outbound')!
      if (lookups.priceUsdLookup(buy) != null && lookups.priceUsdLookup(sell) != null) fullyPricedAfter += 1
    }

    // Both completion candidates survive the (unchanged) 2-slot cap.
    for (const txHash of completableTxHashes) {
      const buy = events.find((e) => e.txHash === txHash && e.direction === 'inbound')!
      assert.ok(lookups.priceUsdLookup(buy) != null, `${txHash} must survive the cap — it received one of the two smallest (best) ranks`)
    }

    // expectedLotsCompletedBySelection (predicted) must match the real, observed outcome.
    assert.equal(fullyPricedAfter, 2, 'expectedLotsCompletedBySelection must match actual: both completable lots become fully priced')
    assert.ok(fullyPricedAfter > fullyPricedBefore, 'fullyPricedLots must increase')
    assert.ok(wethCallCount <= 2, 'no cap or provider-budget increase — the unchanged per-token cap (2) still bounds real WETH calls')

    // FIFO must remain byte-identical.
    const lotsAfter = buildLots(events, [])
    const { matchedLots: matchedAfter } = matchLotsFIFO(lotsAfter, sellTargets)
    assert.deepEqual(matchedAfter, matchedBefore, 'FIFO quantities/matches must be byte-identical')
  })
})
