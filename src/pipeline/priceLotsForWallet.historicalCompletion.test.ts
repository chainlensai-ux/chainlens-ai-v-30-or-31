// Regression tests for the Wallet Scanner historical-price completion audit.
// Production symptom: 13 closed lots, 4 verified (30.77%), same-tx quote evidence resolved many
// requirements but completed 0 lots. Run directly with:
//   npx tsx --test src/pipeline/priceLotsForWallet.historicalCompletion.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runHistoricalCompletionFixture, seedAcceptedEvidenceForVerifiedLots, USDC_BASE, WETH_BASE, ETH_USD_DAY1, ETH_USD_DAY2 } from './priceLotsForWallet.historicalCompletion.fixture.ts'
import { deriveSameTransactionQuotePrice, isVerifiedQuoteLegAddress, type SwapLeg } from '../modules/quoteLegPricing/index'

const tokenOf = (i: number) => `0x${(0xa000 + i).toString(16).padStart(40, '0')}`

describe('priceLotsForWallet — historical-price completion (13-lot regression fixture)', () => {
  it('reaches 7/13 verified from real same-tx WETH evidence; the other 6 stay missing_price with an exact reason', async () => {
    const run = await runHistoricalCompletionFixture()
    assert.equal(run.closedLots, 13)
    // Before this fix the same fixture measured 4/13 (30.77%), 0 lots completed by same-tx quote.
    assert.equal(run.verifiedLots, 7)
    assert.equal(run.coveragePct, 53.85)
    assert.equal(run.lotsCompletedBySameTxQuote, 3)
    for (const i of [1, 2, 3, 4, 5, 6, 7]) assert.ok(run.verifiedTokens.has(tokenOf(i)), `lot ${i} verified`)

    // Derived from the exact WETH leg × that day's historical ETH/USD — never a current price.
    const lot5 = run.matchedLots.find((l) => l.token.toLowerCase() === tokenOf(5))!
    assert.equal(lot5.costBasisUsd, 0.1 * ETH_USD_DAY1)
    assert.equal(lot5.proceedsUsd, 0.12 * ETH_USD_DAY2)

    const audit = run.lookups.closedLotMissingPriceAudit
    assert.equal(audit.blockedLots, 6)
    assert.deepEqual(audit.missingSideReasonCounts, {
      no_opposite_leg_in_transaction: 3,
      no_verified_quote_leg_found: 5,
      derived_price_out_of_bounds: 2,
    })
    // Where same-tx recoveries landed: the "resolved but 0 completed" split is now visible.
    assert.equal(audit.sameTxSidesCompletingAClosedLot, 6)
    assert.equal(audit.sameTxSidesOnClosedLotWithOtherSideMissing, 2)
    assert.equal(audit.sameTxSidesNotOnAnyClosedLot, 6)

    const transferIn = audit.lots.find((l) => l.token.toLowerCase() === tokenOf(8))!
    assert.equal(transferIn.missingSide, 'entry')
    assert.equal(transferIn.entry.sameTxRejectionReason, 'no_opposite_leg_in_transaction')
    assert.equal(transferIn.exit.status, 'priced_same_tx_quote')
    assert.equal(transferIn.exit.sameTxQuoteToken, USDC_BASE)
    assert.equal(transferIn.exit.sameTxQuoteValueUsd, 80)
    assert.equal(transferIn.exit.sameTxDerivedPriceUsd, 0.08)
    assert.equal(transferIn.entry.acceptedEvidenceRecordFound, false)
  })

  it('never values a token as ETH because its symbol is "WETH" (address-only identity)', async () => {
    const run = await runHistoricalCompletionFixture()
    const spoof = run.lookups.closedLotMissingPriceAudit.lots.find((l) => l.token.toLowerCase() === tokenOf(12))!
    assert.equal(spoof.entry.status, 'missing', 'the fake-WETH leg was previously priced at 5 × $3000 = $15,000')
    assert.equal(spoof.entry.sameTxRejectionReason, 'no_verified_quote_leg_found')
    assert.equal(isVerifiedQuoteLegAddress('base', `0x${'c'.repeat(40)}`), false)
    assert.equal(isVerifiedQuoteLegAddress('base', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'), true, 'native pseudo-address')
    assert.equal(isVerifiedQuoteLegAddress('base', WETH_BASE), true)
  })

  it('an out-of-bounds derived price fails closed and is counted, not silently dropped', async () => {
    const run = await runHistoricalCompletionFixture()
    const lot = run.lookups.closedLotMissingPriceAudit.lots.find((l) => l.token.toLowerCase() === tokenOf(13))!
    assert.equal(lot.missingSide, 'both')
    assert.equal(lot.entry.sameTxRejectionReason, 'derived_price_out_of_bounds')
    assert.equal(lot.entry.sameTxApplied, false)
    assert.equal(run.rejectionReasonCounts.derived_price_out_of_bounds, 2)
  })

  it('accepted evidence: writer and fast-path reader agree on the key; never-verified lots are "never_accepted_lot", not lost coverage', async () => {
    const run = await runHistoricalCompletionFixture()
    assert.equal(run.acceptedEvidenceReused, 8, 'all 8 sides of the 4 accepted lots are read back and skipped')
    const lost = run.lookups.manifestFastPathAudit.lostCoverageSides
    assert.equal(lost.length, 18)
    assert.ok(lost.every((s) => s.rejectionReason === 'no_persisted_record_found' && s.evidenceHistory === 'never_accepted_lot'))
  })

  it('accepted evidence: a lot with only one side persisted is flagged opposite_side_present (a real loss)', async () => {
    const run = await runHistoricalCompletionFixture({
      seed: (kv, lots, now) => seedAcceptedEvidenceForVerifiedLots(kv, lots, now, 'entry', ['token_to_token_only']),
    })
    const lost = run.lookups.manifestFastPathAudit.lostCoverageSides
    const exits = lost.filter((s) => s.token.toLowerCase() === tokenOf(10) || s.token.toLowerCase() === tokenOf(11))
    assert.equal(exits.length, 2)
    assert.ok(exits.every((s) => s.side === 'exit' && s.evidenceHistory === 'opposite_side_present'))
  })
})

describe('deriveSameTransactionQuotePrice — native identity', () => {
  const base = { chain: 'base' as const, txHash: '0x1', timestamp: Date.parse('2026-03-01T00:00:00Z'), targetToken: tokenOf(1), targetDirection: 'inbound' as const, targetQuantity: 1000 }
  it('a symbol-only "ETH" leg is not a native quote', () => {
    const legs: SwapLeg[] = [
      { contract: tokenOf(1), symbol: 'T', decimals: 18, amount: 1000, direction: 'inbound', logIndex: 0 },
      { contract: `0x${'d'.repeat(40)}`, symbol: 'ETH', decimals: 18, amount: 1, direction: 'outbound', logIndex: 1 },
    ]
    const result = deriveSameTransactionQuotePrice({ ...base, groupedSwapLegs: legs, historicalNativePrice: 3000 })
    assert.equal(result.priceUsd, null)
    assert.equal(result.evidence.rejectionReason, 'no_verified_quote_leg_found')
  })
  it('canonical WETH behind a hop leg derives from the exact WETH amount', () => {
    const legs: SwapLeg[] = [
      { contract: tokenOf(1), symbol: 'T', decimals: 18, amount: 1000, direction: 'inbound', logIndex: 0 },
      { contract: `0x${'b'.repeat(40)}`, symbol: 'HOP', decimals: 18, amount: 50, direction: 'unknown', logIndex: 1 },
      { contract: WETH_BASE, symbol: 'WETH', decimals: 18, amount: 0.1, direction: 'unknown', logIndex: 2 },
    ]
    const result = deriveSameTransactionQuotePrice({ ...base, groupedSwapLegs: legs, historicalNativePrice: 3000 })
    assert.equal(result.source, 'same_tx_native_quote')
    assert.equal(result.quoteValueUsd, 300)
  })
})
