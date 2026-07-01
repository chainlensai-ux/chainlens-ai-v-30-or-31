import fs from 'node:fs'
import assert from 'node:assert/strict'

const engine = fs.readFileSync('lib/server/smartRecoveryEngine.ts', 'utf8')
const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')

// Targeted recovery delegates to the existing fetchWalletSnapshot pipeline instead of
// reimplementing swap extraction, multi-hop merging, LP quarantine, BUY/SELL classification,
// or FIFO reconstruction — those all stay owned by walletSnapshot.ts.
assert.match(engine, /import \{ fetchWalletSnapshot, WALLET_SCAN_MODE_CONFIG/, 'engine imports fetchWalletSnapshot instead of reimplementing the pipeline')
assert.match(engine, /await fetchWalletSnapshot\(/, 'engine calls fetchWalletSnapshot for targeted recovery')
assert.doesNotMatch(engine, /function matchFifo|function reconstructFifo|function detectSwaps|function classifyBuySell/i, 'engine does not reimplement swap/FIFO logic')

// Window detection always runs first unless explicitly disabled by an admin flag.
assert.match(engine, /adminForceWindowDetection !== false\)/, 'window detection runs by default before recovery')
assert.match(engine, /window = await detectTradingWindow\(/, 'engine calls detectTradingWindow before targeted recovery')

// Admin-only cost caps: page/price attempts never exceed the full_recovery ceiling, and
// admin-provided values are clamped, not trusted verbatim.
assert.match(engine, /Math\.max\(1, Math\.min\(controls\.adminMaxPages \?\? baseConfig\.targetedRecoveryPages, baseConfig\.targetedRecoveryPages\)\)/, 'admin max pages is clamped to the full_recovery ceiling')
assert.match(engine, /Math\.max\(1, Math\.min\(controls\.adminMaxPriceAttempts \?\? baseConfig\.priceAttempts, baseConfig\.priceAttempts\)\)/, 'admin max price attempts is clamped to the full_recovery ceiling')

// admin_disable_full_history_scan / admin_targeted_recovery_only must cap recovery to the
// detected window only — never fall back to a full-history page sweep.
assert.match(engine, /targetedOnly = Boolean\(controls\.adminTargetedRecoveryOnly\) \|\| Boolean\(controls\.adminDisableFullHistoryScan\)/, 'targeted-only flags are honored')
assert.match(engine, /effectivePages = targetedOnly && !window\.startTimestamp \? 0 : maxPages/, 'no window found + targeted-only means zero pages, not a full scan')

// Never invents lots/cost basis: the snapshot returned is whatever fetchWalletSnapshot's own
// integrity gates produced, with missing-cost-basis sells surfaced, not fabricated.
assert.doesNotMatch(engine, /realizedPnlUsd\s*=\s*(?!.*fifoResult|.*snapshot)/i, 'engine never assigns a synthetic realizedPnlUsd')

// Route-level admin gating: smart_recovery is unreachable without fullRecoveryAllowed, and the
// server never trusts a client-sent admin flag as authorization by itself.
assert.match(route, /smartRecoveryRequested[\s\S]{0,200}if \(!fullRecoveryAllowed\)/, 'smart_recovery route branch is gated by fullRecoveryAllowed')
assert.match(route, /Smart Recovery is admin-only\./, 'route returns admin-only error for non-admins')
assert.match(route, /admin_force_window_detection/, 'admin_force_window_detection flag is wired through')
assert.match(route, /admin_targeted_recovery_only/, 'admin_targeted_recovery_only flag is wired through')
assert.match(route, /admin_disable_full_history_scan/, 'admin_disable_full_history_scan flag is wired through')
assert.match(route, /admin_max_pages/, 'admin_max_pages flag is wired through')
assert.match(route, /admin_max_price_attempts/, 'admin_max_price_attempts flag is wired through')

// Response fields required for admin review of a smart_recovery scan.
for (const field of [
  'smartRecoveryWindow', 'smartRecoveryConfidence', 'smartRecoveryCost',
  'smartRecoveryLots', 'smartRecoveryMissingCostBasis', 'smartRecoveryStatus',
]) {
  assert.match(route, new RegExp(`smartSnapshot\\.${field}\\s*=`), `route attaches ${field} to the snapshot`)
}

console.log('test-smart-recovery-engine: all assertions passed')
