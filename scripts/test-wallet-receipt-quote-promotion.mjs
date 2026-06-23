import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// 1. swap-reconstruction-v1 now tracks a buy/sell split on its promoted events so the funnel and
// the receipt-quote debug can attribute receipt-proven sell legs (the SEARXLY WETH-quote sell).
assert.match(snap, /swapReconstructionEventsPromotedBuy: number/, 'promoted buy split field on the debug type')
assert.match(snap, /swapReconstructionEventsPromotedSell: number/, 'promoted sell split field on the debug type')
assert.match(snap, /if \(direction === 'sell'\) eventsPromotedSell\+\+/, 'sell promotions are counted by direction')
assert.match(snap, /else if \(direction === 'buy'\) eventsPromotedBuy\+\+/, 'buy promotions are counted by direction')

// 2. ROOT-CAUSE FIX: the funnel's receiptProvenSellLegs/receiptProvenQuoteSellEvents now read
// swap-reconstruction-v1's promoted-sell count additively, not only the older Base sell-side pass.
// This is the exact reported bug: eventsPromoted=1 but receiptProvenSellLegs=0.
assert.match(snap, /receiptProvenSellLegs: \(_sellSideReconDebug\.promotedSellEvents \?\? _sellSideReconDebug\.sellSideEventsPromoted \?\? 0\) \+ \(_swapReconstructionV1Debug\.swapReconstructionEventsPromotedSell \?\? 0\)/, 'funnel receiptProvenSellLegs incorporates swap-recon-v1 promoted sells')
assert.match(snap, /receiptProvenQuoteSellEvents: \(_sellSideReconDebug\.promotedSellEvents \?\? _sellSideReconDebug\.sellSideEventsPromoted \?\? 0\) \+ \(_swapReconstructionV1Debug\.swapReconstructionEventsPromotedSell \?\? 0\)/, 'funnel receiptProvenQuoteSellEvents incorporates swap-recon-v1 promoted sells')
assert.match(snap, /publicSellEvents: _performanceClosedLotsFinal\.length \+ _swapReconstructionV1Debug\.swapReconstructionEventsPromotedSell/, 'funnel publicSellEvents incorporates swap-recon-v1 promoted sells')

// 3. INTEGRITY GATE (not weakened, tightened): a provider_event_usd leg paired with a receipt
// quote-leg leg must NOT be laundered into independent/verified PnL — keep the lot locked.
assert.match(snap, /PROVIDER_PRICE_SOURCES\.has\(entrySource\) !== PROVIDER_PRICE_SOURCES\.has\(exitSource\)/, 'computePriceIndependence rejects one-sided provider_event_usd + receipt pairings')
{
  const strictIdx = snap.indexOf('PROVIDER_PRICE_SOURCES.has(entrySource) !== PROVIDER_PRICE_SOURCES.has(exitSource)')
  const mixedIdx = snap.indexOf('} else if (!pricesEqual && !sameSource) {')
  assert.ok(strictIdx >= 0 && mixedIdx >= 0 && strictIdx < mixedIdx, 'the new strict provider/receipt branch sits before the generic mixed_independent fallback')
}

// 4. Exclusion bucketing: sell-receipt-proven + provider buy lands in missingBuyPrice (entry not
// public-grade), NOT flatPrice; the mirror case lands in missingSellPrice.
assert.match(snap, /if \(_isReceiptQuoteSource\(_exitSrc\) && _isProviderSource\(_entrySrc\)\) \{ _reconExclusionTally\.missingBuyPrice\+\+; continue \}/, 'sell-receipt-proven/provider-buy lots route to missingBuyPrice')
assert.match(snap, /if \(_isReceiptQuoteSource\(_entrySrc\) && _isProviderSource\(_exitSrc\)\) \{ _reconExclusionTally\.missingSellPrice\+\+; continue \}/, 'mirror case routes to missingSellPrice')
assert.match(snap, /missingBuyPrice: _reconExclusionTally\.missingBuyPrice,/, 'breakdown surfaces measured missingBuyPrice instead of hardcoded 0')

// 5. New receiptQuoteReconstructionDebug: all spec fields present and wired into _diagnostics.
for (const field of [
  'attempted', 'reconstructedPromotedEvents', 'reconstructedEventsInjectedIntoPricing',
  'reconstructedEventsInjectedIntoFifo', 'receiptProvenBuyLegs', 'receiptProvenSellLegs',
  'receiptProvenQuoteSellEvents', 'publicSellEvents', 'publicGradeLotsBeforeReceiptUpgrade',
  'publicGradeLotsAfterReceiptUpgrade', 'sampleReceiptPricedEvents', 'sampleReceiptPricedClosedLots',
]) {
  assert.ok(snap.includes(field), `receiptQuoteReconstructionDebug includes ${field}`)
}
assert.match(snap, /receiptQuoteReconstructionDebug: _receiptQuoteReconstructionDebug,/, 'receipt-quote debug is wired into _diagnostics output')

// 6. Requirement #7: when only the sell side is receipt-proven and the buy side is still
// provider_event_usd, the debug must say sell_price_receipt_proven / buy_price_not_public_grade.
assert.match(snap, /sell_price_receipt_proven \| buy_price_not_public_grade/, 'lock reason attributes the lock to a non-public-grade buy, not a flat price')

// 7. Price source tagging for receipt-priced sample events per spec (receipt_quote_weth/stable).
assert.match(snap, /priceSource: s\.quoteToken === 'WETH' \? 'receipt_quote_weth'/, 'WETH quote leg tagged receipt_quote_weth')
assert.match(snap, /'receipt_quote_stable'/, 'stable quote leg tagged receipt_quote_stable')
assert.match(snap, /verificationStatus: 'receipt_quote_priced'/, 'verificationStatus is receipt_quote_priced')

console.log('wallet receipt-quote promotion checks passed')
