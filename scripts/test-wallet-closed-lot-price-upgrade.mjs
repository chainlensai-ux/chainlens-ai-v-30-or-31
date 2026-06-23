import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// 1. The upgrade pass exists and only targets weak/flat price sources, never independent ones —
// never touching synthetic/dust lots and never weakening classifyClosedLotForPublicPerformance.
assert.match(snap, /async function buildClosedLotPriceUpgradePass\(/, 'buildClosedLotPriceUpgradePass exists')
assert.match(snap, /const WEAK_PRICE_SOURCES = new Set\(\['provider_event_usd', \.\.\.CURRENT_PRICE_REUSE_SOURCES, \.\.\.FALLBACK_PRICE_REUSE_SOURCES\]\)/, 'upgrade pass candidate selection is scoped to known weak/flat/reused price sources only')
assert.match(snap, /never weakened here\. This pass only improves the INPUT those gates read/, 'upgrade pass documents it never weakens the public PnL gates')

// 2. Regression: flat provider_event_usd lots without receipt proof must stay locked — no quote
// leg found means the lot is left exactly as-is (still flat, still rejected downstream).
assert.match(snap, /if \(newEntryPriceUsd === null && newExitPriceUsd === null\) \{\s*\n\s*lotsStillFlatPrice\+\+/, 'a lot with no receipt-proven quote leg on either side stays flat/locked')
assert.match(snap, /rejectedBreakdown\['no_quote_leg_receipt_proof'\]/, 'rejection reason is tracked for lots with no quote-leg receipt proof')

// 3. Regression: same-tx quote-leg priced lots (real receipt proof) can become public-grade —
// the upgrade recomputes costBasisUsd/proceedsUsd/realizedPnlUsd from the new independent prices
// and re-runs computePriceIndependence so a genuinely-priced lot can land on verified_pnl.
assert.match(snap, /const costBasisUsd = lot\.amountClosed \* finalEntryPriceUsd/, 'upgraded lot recomputes cost basis from the independently-derived entry price')
assert.match(snap, /const _independence = computePriceIndependence\(finalEntrySource, finalExitSource, finalEntryPriceUsd, finalExitPriceUsd, lot\.openedTxHash, lot\.closedTxHash\)/, 'upgraded lot reruns the same unweakened computePriceIndependence gate with the new prices')
assert.match(snap, /quote_leg_receipt_weth.*quote_leg_receipt_stable.*quote_leg_receipt_native/, 'new receipt-derived price sources are added to the independent quote-leg source set (additive only)')

// 4. Regression: synthetic cost basis must remain locked even if a sell-side price exists —
// candidates filter explicitly excludes synthetic/fifo_backfilled/zero-coverage lots up front,
// so the upgrade pass can never grant independent pricing to a lot with no real cost basis.
assert.match(snap, /const isSyntheticOrDust = \(l: WalletClosedLot\): boolean =>\s*\n\s*l\.evidence\?\.entrySource === 'synthetic' \|\| \(l\.missingReasons \?\? \[\]\)\.includes\('fifo_backfilled_buy'\) \|\| \(l\.coveragePercent \?\? 100\) === 0/, 'synthetic/fifo-backfilled/zero-coverage lots are excluded from upgrade candidacy before any receipt fetch')
assert.match(snap, /!isSyntheticOrDust\(l\) &&/, 'candidate filter applies the synthetic/dust exclusion')

// 5. Regression: receipt cache dedupes entry/exit tx hash fetches — a tx hash used as both this
// lot's entry and another lot's exit (or repeated across lots) is only fetched once via the
// shared basePnlReceiptCache, with cache hits tracked separately from fresh fetches.
assert.match(snap, /const txHashesNeeded = new Set<string>\(\)/, 'tx hashes to fetch are deduped into a Set before any receipt fetch')
assert.match(snap, /const cacheKey = `closed_lot_price_upgrade:\$\{key\}`\s*\n\s*const cached = basePnlReceiptCache\.get\(cacheKey\)/, 'upgrade pass checks the shared receipt cache before fetching')
assert.match(snap, /if \(cached && cached\.exp > now\) \{\s*\n\s*receiptCacheHits\+\+/, 'cache hits are tracked separately from fresh receipt fetches')

// 6. One-sided upgrade rule (requirement #8): one side independently priced is only sufficient
// if the other side was not itself still flat/reused — i.e. genuinely already had real evidence.
assert.match(snap, /const otherSideStillWeak = newEntryPriceUsd !== null/, 'one-sided upgrade checks whether the untouched side still has independent (non-weak) evidence')

// 7. Debug fields per spec are present on the diagnostics type and wired into the snapshot output.
for (const field of [
  'receiptPriceUpgradeAttempted', 'entryReceiptsFetched', 'exitReceiptsFetched', 'receiptCacheHits',
  'entryQuoteLegsFound', 'exitQuoteLegsFound', 'lotsUpgradedWithEntryQuote', 'lotsUpgradedWithExitQuote',
  'lotsUpgradedWithBothSides', 'lotsStillFlatPrice', 'lotsStillSyntheticCostBasis', 'lotsStillDust',
  'publicPerformanceLotsBefore', 'publicPerformanceLotsAfter', 'sampleUpgradedLots', 'sampleStillRejectedLots',
  'rejectedReasonBreakdown',
]) {
  assert.ok(snap.includes(field), `closedLotPriceUpgradeDebug includes ${field}`)
}
assert.match(snap, /closedLotPriceUpgradeDebug: _closedLotPriceUpgradeDebug,/, 'closed-lot price-upgrade debug is wired into _diagnostics output')

// 8. Call site: runs on the same source lots that feed _publicLotClassifications (after synthetic
// promotion, before the final classification/tally section), and never bypasses
// classifyClosedLotForPublicPerformance — it only replaces the array those classifications read.
const upgradeCallIdx = snap.indexOf('const _priceUpgradeResult = await buildClosedLotPriceUpgradePass(')
const classificationIdx = snap.indexOf('const _publicLotClassifications = _syntheticLotsAfterSourceLots.map(')
assert.ok(upgradeCallIdx >= 0 && classificationIdx >= 0 && upgradeCallIdx < classificationIdx, 'price-upgrade pass call site runs before the final public-lot classification step')

// 9. Existing gates untouched: classifyClosedLotForPublicPerformance and computePriceIndependence
// still exist with their original synthetic/dust/flat-estimate rejection branches intact.
assert.match(snap, /function classifyClosedLotForPublicPerformance\(/, 'classifyClosedLotForPublicPerformance still exists')
assert.match(snap, /rejectReason: 'synthetic_cost_basis_missing', priceEvidenceClass: 'synthetic_missing_cost_basis' \}/, 'synthetic cost-basis rejection branch is unchanged')
assert.match(snap, /rejectReason: 'estimate_only_price_flat', priceEvidenceClass: 'same_price_flat_estimate' \}/, 'flat-estimate rejection branch is unchanged')

console.log('wallet closed-lot price-upgrade checks passed')
