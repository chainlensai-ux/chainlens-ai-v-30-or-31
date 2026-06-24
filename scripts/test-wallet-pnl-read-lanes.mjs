import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const ui = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')

// 1. walletPnlRead type exists with the full required shape.
assert.match(snap, /walletPnlRead\?:\s*\{/, 'walletPnlRead type is present on WalletSnapshot')
for (const field of [
  'displayMode', 'headlineLabel', 'headlineValueUsd', 'headlineWarning', 'officialRealized',
  'limitedSample', 'openPosition', 'estimatedTransferFlow', 'rawReconstruction', 'lockedReasons', 'excludedFrom',
]) {
  assert.match(snap, new RegExp(`${field}:`), `walletPnlRead includes ${field}`)
}

// 2. displayMode decision tree follows the spec precedence order.
assert.match(snap, /_pnlReadOfficialAvailable = _publicPnlStatusFinal === 'ok'/, 'official_realized requires _publicPnlStatusFinal === ok')
assert.match(snap, /_pnlReadLimitedSampleAvailable = !_pnlReadOfficialAvailable && snapshot\.publicSamplePerformanceRead\?\.status === 'available'/, 'limited_sample only applies when official is unavailable')
assert.match(snap, /_pnlReadOpenPositionAvailable = !_pnlReadOfficialAvailable && !_pnlReadLimitedSampleAvailable && snapshot\.walletOpenPositionPnlRead\?\.status === 'available'/, 'open_position_only only applies after official/limited are unavailable')
assert.match(snap, /_pnlReadEstimatedTransferAvailable = !_pnlReadOfficialAvailable && !_pnlReadLimitedSampleAvailable && !_pnlReadOpenPositionAvailable/, 'estimated_transfer_flow_only only applies after official/limited/open are unavailable')
assert.match(snap, /_pnlReadRawReconstructionOnly = !_pnlReadOfficialAvailable && !_pnlReadLimitedSampleAvailable && !_pnlReadOpenPositionAvailable && !_pnlReadEstimatedTransferAvailable && _rawMatchedClosedLotsFinal > 0/, 'raw_reconstruction_locked only applies after all richer lanes are unavailable, gated on rawMatchedClosedLots > 0')

// 3. estimated transfer-flow PnL is excluded from win rate/profit skill/wallet score/official realized/verified PnL.
assert.match(snap, /excludedFrom: \['official_realized_pnl', 'win_rate', 'profit_skill', 'wallet_score', 'verified_pnl'\],/, 'estimatedTransferFlow.excludedFrom (and the top-level excludedFrom) lists all five locked-out consumers')
assert.doesNotMatch(snap, /profitSkillStatus = .*_pnlReadEstimatedTransfer/, 'estimated transfer-flow PnL never feeds profitSkillStatus')
assert.doesNotMatch(snap, /winRatePercent.*_pnlReadEstimatedTransfer|_pnlReadEstimatedTransfer.*winRatePercent/, 'estimated transfer-flow PnL never feeds win rate')

// 4. flat/synthetic/estimate-only lots never show realizedPnlUsd = 0 as a useful estimate.
assert.match(snap, /_estimatedLotsAllFlatOrEstimateOnly = _syntheticLotsAfterSourceLots\.length > 0 && _syntheticLotsAfterSourceLots\.every\(/, 'flat/estimate-only closed lots are detected before treating the estimate as useful')
assert.match(snap, /_estimatedPerformanceReadSyntheticBreakeven = _estimatedLotsAllSynthetic \|\| _estimatedRealizedPnlIsBreakeven \|\| _estimatedLotsAllFlatOrEstimateOnly/, 'the synthetic/breakeven guard is broadened to include flat/estimate-only lots')
assert.match(snap, /'Closed lots were detected, but they are synthetic\/flat\/estimate-only and cannot produce verified realized PnL\.'/, 'the broadened guard reports the dedicated honest reason')

// 5. raw reconstruction read appears when rawMatchedClosedLots > 0 but the richer lanes are unavailable.
assert.match(snap, /rawReconstruction: \{\s*\n\s*rawClosedLots: _rawMatchedClosedLotsFinal,/, 'rawReconstruction.rawClosedLots reuses the existing rawMatchedClosedLots count')
assert.match(snap, /lockedReason: _pnlReadLockedReason,/, 'rawReconstruction exposes a lockedReason')

// 6. official PnL gates are unchanged.
assert.match(snap, /if \(lot\.priceIndependenceStatus === 'missing_independent_price' \|\| lot\.priceIndependenceStatus === 'current_price_reused' \|\| lot\.priceIndependenceStatus === 'fallback_price_reused'\) return \{ reconstructedEligible: true, verifiedPnlEligible: false, performanceEligible: false,/, 'missing/current/fallback price-reuse statuses remain non-performance-eligible unchanged')
assert.match(snap, /snapshot\.publicPnlIntegrityGate = \{/, 'the existing publicPnlIntegrityGate construction is unchanged')

// 7. no new provider calls — only already-computed snapshot/local values are read.
const pnlReadSection = snap.slice(snap.indexOf('WALLET-PNL-READ-1: build a single read hierarchy'), snap.indexOf('WALLET-ADDRESS-TYPE-GATE-1: a token-contract/treasury/distributor-like address is not a'))
assert.doesNotMatch(pnlReadSection, /fetchMoralisTransfers\(|fetchGoldrush|await fetch\(|buildWalletHistoricalCoverage\(|buildWalletPnlRecoveryV2Base\(/, 'walletPnlRead construction makes no new provider/reconstruction calls')

// 8. frontend type + UI.
assert.match(ui, /walletPnlRead\?:\s*\{/, 'page.tsx result type exposes walletPnlRead')
assert.match(ui, /PnL Read<\/span>/, 'UI renders a PnL Read card')
assert.match(ui, /Estimated PnL: \{fmtUsd\(pr\.estimatedTransferFlow\.realizedPnlUsd\)/, 'UI shows "Estimated PnL: $X, not verified" copy')
assert.match(ui, /Raw lots found: \{pr\.rawReconstruction\.rawClosedLots\}, excluded: \{pr\.rawReconstruction\.excludedClosedLots\}/, 'UI shows "Raw lots found: N, excluded: N" copy')
assert.match(ui, /Realized stats locked: \{pr\.officialRealized\.reason/, 'UI shows "Realized stats locked: ..." copy')
assert.match(ui, /no verified trades — see Estimated transfer-flow PnL above/, 'checklist no longer says a bare "no verified trades" when an estimated transfer-flow read exists')
assert.match(ui, /no verified trades — \$\{result\.walletPnlRead\.rawReconstruction\.rawClosedLots\} raw lots found, see PnL Read above/, 'checklist no longer says a bare "no verified trades" when a raw reconstruction read exists')

console.log('wallet PnL read lanes checks passed')
