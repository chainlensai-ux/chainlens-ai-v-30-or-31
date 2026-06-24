import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const ui = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')

// 1. open PnL appears when realized PnL is locked.
assert.match(snap, /const _pnlDisplayMode: NonNullable<WalletSnapshot\['pnlDisplayMode'\]> = _publicPnlStatusFinal === 'ok'\s*\n\s*\? 'realized'\s*\n\s*: _walletOpenPositionPnlRead\.status === 'available'\s*\n\s*\? 'open_position_only'/, 'pnlDisplayMode becomes open_position_only when realized PnL is locked but open PnL is available')
assert.match(snap, /pnlDisplayLabel: string \| undefined|_pnlDisplayLabel = _pnlDisplayMode === 'open_position_only'\s*\n\s*\? 'Open-position PnL available — realized PnL locked'/, 'pnlDisplayLabel is the dedicated open-position-only copy')
assert.match(snap, /_pnlDisplayReason = _pnlDisplayMode === 'open_position_only'\s*\n\s*\? 'Open lots are priced, but realized PnL is locked because prior buy cost basis is missing for sold tokens\.'/, 'pnlDisplayReason explains the open-position-only state')
assert.match(ui, /result\.pnlDisplayMode === 'open_position_only' && result\.walletOpenPositionPnlRead\?\.status === 'available'/, 'UI shows the Open PnL chip set only when realized PnL is locked and open PnL is available')
assert.match(ui, /label: 'Open PnL'/, 'UI exposes an Open PnL chip')
assert.match(ui, /label: 'Realized PnL'/, 'UI exposes a Realized PnL chip explaining the lock')

// 2. open PnL is read-only and excluded from win rate/profit skill/wallet score/realized PnL.
assert.match(snap, /excludedFrom: \['realized_pnl', 'win_rate', 'profit_skill', 'wallet_score'\],/, 'walletOpenPositionPnlRead is explicitly excluded from realized PnL, win rate, profit skill, and wallet score')
assert.doesNotMatch(snap, /profitSkillStatus = .*_walletOpenPositionPnlRead/, 'walletOpenPositionPnlRead never feeds profitSkillStatus')
assert.doesNotMatch(snap, /winRatePercent.*_walletOpenPositionPnlRead|_walletOpenPositionPnlRead.*winRatePercent/, 'walletOpenPositionPnlRead never feeds win rate')

// 3. synthetic closed lots do not show misleading estimated PnL = 0 as useful.
assert.match(snap, /_estimatedLotsAllSynthetic = _syntheticLotsAfterSourceLots\.length > 0 && _syntheticLotsAfterSourceLots\.every\(/, 'all-synthetic closed lots are detected before treating the estimate as useful')
assert.match(snap, /_estimatedRealizedPnlIsBreakeven = _rawEstimatedRealizedPnlUsd !== null && Math\.abs\(_rawEstimatedRealizedPnlUsd\) < 0\.01/, 'a break-even ($0) estimated realized PnL is detected explicitly')
assert.match(snap, /_estimatedPerformanceReadUseful = _rawEstimatedRealizedPnlUsd !== null && _syntheticLotsAfterSourceLots\.length > 0 && _rawEstimatedCostBasisUsd > 0 && !_estimatedPerformanceReadSyntheticBreakeven/, 'synthetic/break-even estimates are never treated as a useful PnL estimate')
assert.match(snap, /'Closed-lot estimate is synthetic break-even cost basis only\.'/, 'the synthetic break-even case reports the dedicated honest reason instead of a misleading $0 PnL')

// 4. missingCostBasisRead lists affected tokens.
assert.match(snap, /_missingCostBasisAffectedTokens = Array\.from\(new Map\(_missingCostBasisSyntheticLots\.map\(l => \{/, 'missingCostBasisRead derives affectedTokens from the synthetic-cost-basis closed lots')
assert.match(snap, /affectedTokens: _missingCostBasisAffectedTokens,/, 'missingCostBasisRead exposes affectedTokens')
assert.match(snap, /syntheticClosedLots: _missingCostBasisSyntheticLots\.length,/, 'missingCostBasisRead exposes syntheticClosedLots count')
assert.match(snap, /unknownCostSellValueUsd: _missingCostBasisUnknownSellValueUsd,/, 'missingCostBasisRead exposes unknownCostSellValueUsd')

// 5. no provider calls added — this patch only reads existing FIFO/estimatedPnl/recovery-debug
// outputs that were already computed elsewhere in the function.
const openPnlSection = snap.slice(snap.indexOf("WALLET-OPEN-PNL-1 (#1/#2)"), snap.indexOf('LOW-VALUE-RECOVERY-FIX: surfaces'))
assert.doesNotMatch(openPnlSection, /fetchMoralisTransfers\(|fetchGoldrush|await fetch\(|buildWalletHistoricalCoverage\(|buildWalletPnlRecoveryV2Base\(/, 'the open-PnL/missing-cost-basis read section makes no new provider/reconstruction calls — it only reuses already-computed values')

// 6. existing realized PnL gates are unchanged.
assert.match(snap, /if \(lot\.priceIndependenceStatus === 'missing_independent_price' \|\| lot\.priceIndependenceStatus === 'current_price_reused' \|\| lot\.priceIndependenceStatus === 'fallback_price_reused'\) return \{ reconstructedEligible: true, verifiedPnlEligible: false, performanceEligible: false,/, 'missing/current/fallback price-reuse statuses remain non-performance-eligible unchanged')
assert.match(snap, /snapshot\.publicPnlIntegrityGate = \{/, 'the existing publicPnlIntegrityGate construction is unchanged')

console.log('wallet open-position PnL checks passed')
