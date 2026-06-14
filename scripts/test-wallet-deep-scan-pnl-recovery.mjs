import fs from 'node:fs'
import assert from 'node:assert/strict'

const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')
const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const ui = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')

assert.match(route, /const deepActivity = deepScan \|\| deepActivityFlag \|\| includeActivityFlag/, 'deepScan=true must imply deep activity')
assert.match(route, /walletValueTier === 'high_value' \|\| walletValueTier === 'whale'/, 'high-value wallets trigger historical recovery')
assert.match(route, /coveragePercent < 60/, 'low PnL coverage triggers historical recovery')
assert.match(route, /unmatchedSells > 0 \|\| unmatchedBuys > 0/, 'unmatched buys/sells trigger historical recovery')
assert.match(route, /closedLots < 10/, 'closedLots < 10 triggers historical recovery')
assert.match(route, /stats\.status === 'partial'/, 'partial tradeStats triggers historical recovery')
assert.match(route, /historicalStatus === 'not_requested'/, 'not_requested historical coverage triggers historical recovery')
assert.match(route, /_shouldAutoRequestHistoricalRecovery[\s\S]*fetchWalletSnapshot[\s\S]*historicalCoverage: true/, 'live deep scan auto-runs historical recovery when needed')

assert.match(route, /type PnlCacheQuality = 'complete' \| 'partial_needs_historical' \| 'stale_low_coverage'/, 'pnlCacheQuality union is present')
assert.match(route, /getPnlCacheQuality[\s\S]*partial_needs_historical/, 'persistent cache low coverage is classified partial_needs_historical')
assert.match(route, /Cached wallet snapshot loaded, but historical PnL recovery is still needed for fuller trade stats\./, 'partial cached snapshot message is present')
assert.match(route, /recoverHistoricalFromCachedPayload[\s\S]*cacheBackend: 'memory' \| 'persistent'/, 'cached partial snapshots can recover historically')

assert.match(snap, /backfill_not_started_timeout/, 'timeout before pagesAttempted is classified')
assert.match(snap, /backfill_budget_blocked/, 'budget-blocked backfill is classified')
assert.match(snap, /backfill_provider_unavailable/, 'provider-unavailable backfill is classified')
assert.match(snap, /sort\(\(a, b\) => \{[\s\S]*exitPriceUsd[\s\S]*return bV - aV[\s\S]*\}\)\s*\.slice\(0, 5\)/, 'highest-value unmatched sells are prioritized')

assert.match(snap, /promotedTradeStatsSummary = \{[\s\S]*\.\.\.previewTradeStats/, 'historical recovery can update trade stats from added closed lots')
assert.match(ui, /Win rate locked until decisive closed lots exist/, 'break-even/low-sample win rate lock reason is shown')
assert.match(ui, /Historical recovery/, 'UI shows historical recovery status')
assert.match(ui, /Unmatched buys/, 'UI shows unmatched buys')
assert.match(ui, /Unmatched sells/, 'UI shows unmatched sells')
assert.match(ui, /Run historical recovery \/ Retry deep scan when budget allows/, 'UI has recovery CTA')
assert.match(route, /budget_hard_cap_blocks_recovery/, 'low budget blocks recovery with clear reason')

console.log('wallet deep scan PnL recovery checks passed')
