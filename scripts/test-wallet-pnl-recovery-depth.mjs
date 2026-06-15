import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const ui = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')

assert.match(snap, /_highValueRecoveryTriggered = _walletValueTier === 'high_value' \|\| _walletValueTier === 'whale' \|\| totalValue >= 5000 \|\| walletTradeStatsSummary\.closedLots < 3 \|\| _coveragePercentForRecovery < 30 \|\| walletTradeStatsSummary\.status === 'open_check' \|\| walletLotSummary\.closedLots === 0/, 'high-value/low-coverage/zero-lot wallets trigger historical recovery')
assert.match(snap, /_historicalRecoveryMaxPages = 3[\s\S]*_historicalRecoveryHardCapPages = _walletValueTier === 'high_value' \|\| _walletValueTier === 'whale' \? 5/, 'high-value deep scan uses 3 default / 5 hard-cap historical pages')
assert.match(snap, /maxHistoricalTxs = 250[\s\S]*maxCandidateSwaps = 40/, 'historical recovery has transaction and candidate swap caps')
assert.match(snap, /top_holdings_by_value_token_specific_recovery/, 'top holdings drive token-specific recovery targets')
assert.match(snap, /hasQuoteOutTokenIn[\s\S]*routerless buy candidate/, 'same tx with quote out + token in becomes buy candidate')
assert.match(snap, /hasTokenOutQuoteIn[\s\S]*routerless sell candidate/, 'same tx with token out + quote in becomes sell candidate')
assert.match(snap, /_fifoEligibleEventsFinal = _pricedEvidence\.filter[\s\S]*e\.swapDetection\?\.isSwapCandidate[\s\S]*e\.priceAtTime\?\.status === 'priced'/, 'priced eligible trade events flow into FIFO')
assert.match(snap, /pricedEventsExcludedFromFifoReason[\s\S]*quote_leg_without_token_side[\s\S]*direction_unknown[\s\S]*wallet_side_unresolved[\s\S]*not_trade_event/, 'priced quote-only/invalid events explain FIFO exclusion')
assert.match(snap, /safeToPromoteToPublicStats === true[\s\S]*promotedTradeStatsSummary = \{[\s\S]*\.\.\.previewTradeStats/, 'historical preview with closed lots promotes when safe')
assert.match(ui, /PnL recovery limited[\s\S]*could not reconstruct enough buy\/sell pairs[\s\S]*Historical pages attempted[\s\S]*Candidate swaps found[\s\S]*Priced candidates[\s\S]*Closed lots recovered[\s\S]*Stop reason[\s\S]*Run deeper recovery if budget allows/, 'UI explains limited recovery instead of final unavailable/zero PnL')
assert.doesNotMatch(ui, /final \$0 PnL|\$0 PnL/, 'UI does not present unknown PnL as zero')
assert.match(snap, /walletPnlRecoveryDebug[\s\S]*highValueRecoveryTriggered[\s\S]*candidateTxs[\s\S]*pricedCandidates[\s\S]*fifoEligibleEvents[\s\S]*closedLotsBefore[\s\S]*closedLotsAfter[\s\S]*excludedReasons[\s\S]*stopReason/, 'debug fields expose recovery pipeline counters')

console.log('wallet PnL recovery depth checks passed')
