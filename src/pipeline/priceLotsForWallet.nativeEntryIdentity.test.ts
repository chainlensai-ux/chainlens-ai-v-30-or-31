// Regression test for the ENTRY-IDENTITY cap tracking fix — production evidence: top completion
// candidates received negative ranks (-42/-41), reached pricingAtTimeEngine, yet both still reported
// selectedByCap: false and all 42 were reported capped.
//
// Root cause, confirmed: `cappedTxHashes` is keyed by bare txHash. A target and its same-transaction
// native quote leg share exactly that txHash (the standard shape of a native-funded swap) — if the
// TARGET's own entry got capped (its own token's per-token cap exhausted), that shared txHash was
// added to cappedTxHashes, so checking `cappedTxHashes.has(txHash)` for the UNRELATED native entry
// (a different token, a different dict) wrongly reported it as capped too, even when the native entry
// itself was genuinely selected and priced. Fixed by tracking cap status per EXACT entry identity
// (chain + routed token + txHash + list) instead of bare txHash.
//
// This fixture isolates the exact ambiguity: token X is traded 3 times (3 closed lots, same token,
// per-token cap = 2) so its own 3rd occurrence is genuinely capped — and that 3rd occurrence's own
// transaction also carries a real-direction native (WETH) quote leg, which is the ONLY WETH need in
// the whole fixture and so trivially survives WETH's own, completely independent per-token cap.
//
// Run with:
//   npx tsx --test src/pipeline/priceLotsForWallet.nativeEntryIdentity.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { priceLotsForWallet } from './priceLotsForWallet.ts'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { PriceSourceFn, PriceSources } from '../modules/pricingAtTimeEngine/types'

const WETH_BASE = '0x4200000000000000000000000000000000000006'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TOKEN_X = '0x0000000000000000000000000000000000000500'

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'goldrush', chain: 'base', txHash: '0xtx', timestamp: '2026-01-01T00:00:00.000Z',
    fromAddress: '0xfrom', toAddress: '0xto', contract: '0xtoken', symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

describe('priceLotsForWallet — native quote entry-identity (target and native share one txHash)', () => {
  it('the target entry is capped while the same-tx native quote entry survives and is priced', async () => {
    const events: NormalizedEvent[] = []

    // 3 closed lots, ALL for the SAME token X — its own per-token cap (2) means the 3rd (smallest
    // amount, lowest priority within token X's own group) is genuinely capped for token X itself.
    // buy0/buy1's own transactions use a stablecoin quote (a DIFFERENT token, never competes for
    // WETH's cap); buy2's transaction is the ONLY one in this fixture carrying a real, wallet-
    // touching (non-'unknown') native WETH leg SHARING buy2's own txHash.
    for (let i = 0; i < 2; i += 1) {
      events.push(event({ txHash: `0xstablebuy${i}`, contract: TOKEN_X, direction: 'inbound', amount: 1000 - i, timestamp: '2026-01-01T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xstablebuy${i}`, contract: USDC_BASE, symbol: 'USDC', tokenDecimals: 6,
        amount: 500, direction: 'unknown', timestamp: '2026-01-01T00:00:00.000Z',
      }))
      events.push(event({ txHash: `0xstablesell${i}`, contract: TOKEN_X, direction: 'outbound', amount: 1000 - i, timestamp: '2026-01-02T00:00:00.000Z' }))
      events.push(event({
        txHash: `0xstablesell${i}`, contract: USDC_BASE, symbol: 'USDC', tokenDecimals: 6,
        amount: 500, direction: 'unknown', timestamp: '2026-01-02T00:00:00.000Z',
      }))
    }

    // The 3rd, lowest-priority-within-token-X lot — smallest amount, so it ranks last among token X's
    // own 3 lots and is the one genuinely capped for token X. Its OWN transaction shares its txHash
    // with a real-direction (wallet-touching) WETH leg.
    const targetTxHash = '0xnativebuy2'
    events.push(event({ txHash: targetTxHash, contract: TOKEN_X, direction: 'inbound', amount: 1, timestamp: '2026-01-01T00:00:00.000Z' }))
    events.push(event({
      txHash: targetTxHash, contract: WETH_BASE, symbol: 'WETH', tokenDecimals: 18,
      amount: 1, direction: 'outbound', fromAddress: '0xwallet', toAddress: '0xrouter', timestamp: '2026-01-01T00:00:00.000Z',
    }))
    const targetSellTxHash = '0xnativesell2'
    events.push(event({ txHash: targetSellTxHash, contract: TOKEN_X, direction: 'outbound', amount: 1, timestamp: '2026-01-02T00:00:00.000Z' }))
    events.push(event({
      txHash: targetSellTxHash, contract: USDC_BASE, symbol: 'USDC', tokenDecimals: 6,
      amount: 3.5, direction: 'unknown', timestamp: '2026-01-02T00:00:00.000Z',
    }))

    let wethCallCount = 0
    const fn: PriceSourceFn = (token) => {
      if (token.toLowerCase() === WETH_BASE) wethCallCount += 1
      // Direct provider pricing genuinely fails for token X itself everywhere (production reality);
      // WETH always succeeds (deep, reliable coverage).
      return token.toLowerCase() === WETH_BASE ? 3500 : null
    }
    const sources: PriceSources = { primary: fn, fallback: fn }

    const sellTargets = events.filter((e) => e.direction === 'outbound')
    const lotsBefore = buildLots(events, [])
    const { matchedLots: matchedBefore } = matchLotsFIFO(lotsBefore, sellTargets)

    const fullyPricedBefore = 0
    const lookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sources })

    // The target's OWN entry (token X, costUsd, keyed by targetTxHash) is genuinely capped — token X's
    // per-token cap (2) is exhausted by the two stablecoin-quoted lots' own higher-priority ranks.
    const targetBuy = events.find((e) => e.txHash === targetTxHash && e.contract === TOKEN_X.toLowerCase())!
    // The SAME transaction's native WETH leg must still be selected (a different dict/token entirely)
    // and its resolved value reused to price the target's entry via the same-tx quote-leg gap-fill.
    const priced = lookups.priceUsdLookup(targetBuy)

    assert.ok(priced != null, 'the target entry must end up priced via the same-tx native quote reuse — the native entry itself was genuinely selected, never falsely reported as capped just because it shares a txHash with the capped target')
    assert.equal(priced, 3500, '1 WETH at $3500/unit = $3500, resolved under the routed WETH pricing entry')

    const targetSell = events.find((e) => e.txHash === targetSellTxHash && e.contract === TOKEN_X.toLowerCase())!
    const fullyPricedAfter = lookups.priceUsdLookup(targetBuy) != null && lookups.priceUsdLookup(targetSell) != null ? 1 : 0
    assert.ok(fullyPricedAfter > fullyPricedBefore, 'fullyPricedLots must increase')
    assert.ok(wethCallCount <= 2, 'no cap or provider-budget increase — the unchanged per-token cap (2) still bounds real WETH calls')

    const lotsAfter = buildLots(events, [])
    const { matchedLots: matchedAfter } = matchLotsFIFO(lotsAfter, sellTargets)
    assert.deepEqual(matchedAfter, matchedBefore, 'FIFO quantities/matches must be byte-identical')
  })
})
