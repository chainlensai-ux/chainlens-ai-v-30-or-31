import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')
const page = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')

// 1. Historical page count shape: explicit per-chain vs total fields, and legacy aliases kept
// internally consistent (maxPages === maxPagesTotal, pagesAttempted === pagesAttemptedTotal) so no
// object can read "attempted 2 vs max 1".
for (const field of ['maxPagesPerChain', 'maxPagesTotal', 'pagesAttemptedTotal', 'pagesAttemptedByChain']) {
  assert.ok(snap.includes(field), `walletHistoricalCoverageSummary exposes ${field}`)
}
assert.match(snap, /const _maxPagesTotal = maxPages \* chains\.length/, 'maxPagesTotal computed as per-chain cap times chain count')
assert.match(snap, /maxPages: _maxPagesTotal, maxPagesPerChain: maxPages, maxPagesTotal: _maxPagesTotal, pagesAttemptedTotal: pagesAttempted/, 'legacy maxPages aliases maxPagesTotal; pagesAttempted aliases pagesAttemptedTotal')
assert.match(snap, /_chainPagesAttempted\[chain\] = \(_chainPagesAttempted\[chain\] \?\? 0\) \+ 1/, 'per-chain attempted pages are tracked')

// 2. Historical recovery reason cleanup: provider-failure wording only when the provider truly
// errored; a successful-but-empty scan uses attempted_light_no_new_candidates.
assert.match(snap, /const _historicalProviderErrored = _historicalMissing\.includes\('provider_errors'\)/, 'provider-error detection keys off real provider errors')
assert.match(snap, /reason: 'attempted_light_no_new_candidates'/, 'non-failure reason used when provider succeeded but found nothing new')
assert.match(snap, /Historical scan ran with a capped light window but found no additional public-grade buy\/sell evidence\./, 'honest detail copy present')
assert.ok(!snap.includes("reason: 'historical_provider_failed_or_no_new_closed_lots'"), 'misleading provider-failed-or-no-new-lots reason removed')

// 3. Budget source-of-truth: unambiguous names; public card uses actual provider credits only.
assert.match(route, /_publicBudget\.actualProviderCreditsUsed = _actualCreditsUsed/, 'actualProviderCreditsUsed = apiAudit total credits')
assert.match(route, /const _actualCreditsUsed = Number\(snapshot\._diagnostics\?\.apiAudit\?\.totalCredits/, 'actual credits sourced from apiAudit.totalCredits')
assert.match(route, /_publicBudget\.estimatedPlanningCreditsUsed = _estimatedCreditsUsed/, 'estimatedPlanningCreditsUsed is the planning estimate')
assert.match(route, /_publicBudget\.historicalPageUnitsUsed = /, 'historicalPageUnitsUsed exposed as units, not credits')
assert.match(route, /_publicBudget\.alchemyLoadUnitsUsed = /, 'alchemyLoadUnitsUsed exposed separately from paid credits')
assert.match(snap, /historicalSourcePageUnitsUsed: number/, 'historical source budget renames creditsUsedEstimate to page units')
assert.match(snap, /estimatedPlanningCreditsUsed: _creditsUsedFinal/, 'scan budget debug clarifies its creditsUsed is a planning estimate')

// 4. Alchemy warning cleanup: receipt-reconstruction load is separated from baseline and labelled
// intentionally; a healthy receipt-heavy scan does not emit a scary credit warning.
assert.match(snap, /const ALCHEMY_RECEIPT_CALL_CAP = \d+/, 'an explicit receipt-call cap exists')
assert.match(snap, /alchemy_receipt_calls_within_cap_/, 'receipt calls within cap are labelled intentionally')
assert.match(snap, /_alchemyNonReceiptCalls > ALCHEMY_NON_RECEIPT_CALL_BASELINE/, 'only non-receipt baseline overage is a real warning')
assert.ok(!snap.includes('`alchemy_${_alchemyCount}_calls_expected_8`'), 'old scary alchemy_31_calls_expected_8 warning removed')

// 5. Estimated PnL copy: when public PnL is locked, the average-cost estimate shows Locked, not a
// green $0 implying break-even.
assert.match(page, /const _estPnlLocked = publicPnlLocked\(result, result\.walletTradeStatsSummary \?\? undefined\)/, 'estimated PnL lock flag computed')
assert.match(page, /_estPnlLocked \? 'Locked' : legacyVal === 'Open Check'/, 'average-cost estimate shows Locked when public PnL locked')
assert.match(page, /Estimated PnL is locked because public-grade performance evidence failed integrity checks\./, 'locked estimated-PnL copy present')

// 6. Open-position unrealized PnL honesty: flat/estimate-only current price is labelled and public
// unrealized PnL is nulled (raw kept for debug); no fake 0% public read.
assert.match(route, /priceEstimateOnly = currentPriceUsd !== null && t\.avgEntryPriceUsd !== null/, 'flat-estimate detection compares current price to entry price')
assert.match(route, /const unrealizedPnlUsd = priceEstimateOnly \? null : rawUnrealizedPnlUsd/, 'public unrealized PnL nulled when estimate-only')
assert.match(route, /openPositionPnlStatus: 'priced' \| 'estimate_only' \| 'cost_basis_only'/, 'openPositionPnlStatus exposed')
assert.match(route, /Current value reuses estimate-only pricing; unrealized PnL is not public-grade\./, 'estimate-only reason copy present')
assert.match(route, /rawTotalUnrealizedPnlUsd: totalUnrealizedPnlUsd/, 'raw unrealized aggregate kept for debug')

console.log('wallet diagnostics-cleanup checks passed')
