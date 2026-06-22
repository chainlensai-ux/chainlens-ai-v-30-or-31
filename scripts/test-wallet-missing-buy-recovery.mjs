import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const snap = readFileSync('lib/server/walletSnapshot.ts', 'utf8')

assert.match(snap, /_realBackedClosedLotsCountEarly === 0[\s\S]*walletSwapSummary\.swapCandidateEvents > 0/, 'base recovery gates on real-backed closed lots, not raw closed lots')
assert.doesNotMatch(snap, /walletLotSummary\.closedLots > 0 \? 'already_has_closed_lots'/, 'raw closed lots do not skip recovery as already_has_closed_lots')
assert.doesNotMatch(snap, /walletTradeStatsSummary\.closedLots >= 10[\s\S]*closed_lots_already_found/, 'raw trade-stats closed lots are not enough to skip missing-buy recovery')

assert.match(snap, /MORALIS-MISSING-BUY-RECOVERY/, 'Moralis targeted missing-buy recovery block exists')
assert.match(snap, /fetchMoralisTransfers\(addrNorm, chain, _moralisHistoricalPageSize, cursor\)/, 'Moralis ERC20 transfers are used with cursor pagination')
assert.match(snap, /page\.items\.filter\(it => \(it\.token_address \?\? ''\)\.toLowerCase\(\) === contract\)/, 'Moralis recovery filters pages to the target synthetic token')
assert.match(snap, /_syntheticTargetRankedTokens[\s\S]*excludedUsd[\s\S]*lotCount[\s\S]*sort\(\(a, b\) => b\.excludedUsd - a\.excludedUsd \|\| b\.lotCount - a\.lotCount\)/, 'synthetic target tokens are ranked by excluded USD and lot count')

assert.match(snap, /_finalCandidateEvidence\.length > 0[\s\S]*buildHistoricalPricingPreview/, 'recovered buys enter existing historical pricing even when broad historical coverage was skipped')
assert.match(snap, /walletHistoricalFifoPreviewSummary\.safeToPromoteToPublicStats === true/, 'promotion still requires existing FIFO preview safety checks')
assert.match(snap, /_shouldPromote =[\s\S]*_moralisHistoricalAttempted[\s\S]*safeToPromoteToPublicStats === true/, 'Moralis-recovered buys can be promoted only through safe preview promotion')

for (const field of [
  'moralisHistoricalAttempted',
  'moralisHistoricalPagesUsed',
  'moralisHistoricalEventsFetched',
  'moralisHistoricalPriorBuysFound',
  'moralisHistoricalPriorBuysPriced',
  'moralisHistoricalStopReason',
  'syntheticLotsBeforeRecovery',
  'syntheticLotsAfterRecovery',
  'realPriorBuysRecovered',
  'publicGradeLotsBeforeRecovery',
  'publicGradeLotsAfterRecovery',
  'targetTokensAttempted',
  'targetTokensRecovered',
  'recoverySkippedReason',
]) {
  assert.match(snap, new RegExp(`${field}:`), `diagnostic field ${field} is exposed`)
}

assert.match(snap, /_moralisHistoricalMaxPagesPerToken = 2/, 'Moralis pages per token remain capped')
assert.match(snap, /_moralisHistoricalMaxTotalPages = _walletValueTier === 'high_value' \? 6 : 4/, 'Moralis total pages remain explicitly capped')
assert.match(snap, /_sharedHistoricalBudgetRemaining\(\) <= 0[\s\S]*'budget_exhausted'/, 'budget exhaustion is reported before attempting recovery')
assert.match(snap, /_moralisHistoricalStopReason = 'budget_cap'/, 'runtime budget cap stop reason is reported')

console.log('wallet missing-buy recovery regression checks passed')
