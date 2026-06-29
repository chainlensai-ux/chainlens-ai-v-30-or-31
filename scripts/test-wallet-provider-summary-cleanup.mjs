import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// API-AUDIT-CLEANUP-2: the stale hardcoded "expected 3 / expected 4" warnings must be gone — they
// fired on raw call counts that didn't account for legitimate provider-summary / price-at-time
// evidence call shapes.
assert.doesNotMatch(snap, /moralis_\$\{_moralisLiveCount\}_calls_expected_3/, 'stale moralis_X_calls_expected_3 warning template is removed')
assert.doesNotMatch(snap, /goldrush_\$\{_grLiveCount\}_calls_expected_\$\{_grExpectedCalls\}/, 'stale goldrush_X_calls_expected_Y warning template is removed')
assert.doesNotMatch(snap, /_grExpectedCalls = Math\.max\(4,/, 'the old blanket goldrush call-count budget is removed in favor of purpose-based explainability')

// Moralis warnings now only fire for calls outside the known purpose set — explainable deep
// provider-summary calls (2x erc20_holdings, 1x erc20_transfers, 1x profitability_summary = 4
// total) must never warn.
assert.match(snap, /const _moralisKnownPurposeEndpoints = new Set\(\['erc20_holdings', 'erc20_transfers', 'profitability_summary'\]\)/, 'moralis known-purpose endpoint set includes erc20_holdings, erc20_transfers, profitability_summary')
assert.match(snap, /const _moralisUnexplainedCalls = _moralisLiveCalls\.filter\(e => !_moralisKnownPurposeEndpoints\.has\(e\.endpoint\)\)\.length/, 'moralis unexplained-call count is derived from calls outside the known purpose set')
assert.match(snap, /if \(_moralisUnexplainedCalls > 0\) \{\s*\n\s*_apiWarnings\.push\(`moralis_\$\{_moralisUnexplainedCalls\}_unexplained_calls_beyond_known_purpose_endpoints`\)/, 'moralis warning only fires for unexplained calls, not raw count')

// GoldRush warnings now only fire for calls outside the known purpose set — explainable historical
// price-at-time evidence (1x transactions_v3, 2x balances_v2, 5x historical_by_addresses_v2 = 8
// total) must never warn, while historical_by_addresses_v2 stays out of the recovery budget check.
assert.match(snap, /const _grKnownPurposeEndpoints = new Set\(\['transactions_v3', 'balances_v2', 'historical_by_addresses_v2', 'log_events_by_address'\]\)/, 'goldrush known-purpose endpoint set includes transactions_v3, balances_v2, historical_by_addresses_v2, log_events_by_address')
assert.match(snap, /const _grUnexplainedCalls = _grLiveCalls\.filter\(e => !_grKnownPurposeEndpoints\.has\(e\.endpoint\)\)\.length/, 'goldrush unexplained-call count is derived from calls outside the known purpose set')
assert.match(snap, /if \(_grUnexplainedCalls > 0\) \{\s*\n\s*_apiWarnings\.push\(`goldrush_\$\{_grUnexplainedCalls\}_unexplained_calls_beyond_known_purpose_endpoints`\)/, 'goldrush warning only fires for unexplained calls, not raw count')

// log_events_by_address is the only goldrush endpoint that performs real historical recovery, so it
// alone is checked against the actual recovery page budget — true unknown extra recovery calls must
// still warn.
assert.match(snap, /const _grRecoveryCalls = _grLiveCalls\.filter\(e => e\.endpoint === 'log_events_by_address'\)\.length/, 'goldrush recovery-call count is scoped to log_events_by_address only')
assert.match(snap, /const _grRecoveryBudget = Number\(_historicalCoverageDebug\?\.pagesAttempted \?\? 0\) \+ Number\(_syntheticTargetExtraPagesAttempted \?\? 0\)/, 'goldrush recovery budget is derived from actual pages attempted, not a hardcoded floor')
assert.match(snap, /const _grRecoveryOverBudget = _grRecoveryCalls > _grRecoveryBudget/, 'goldrush recovery-over-budget flag compares real recovery calls against the real recovery budget')
assert.match(snap, /if \(_grRecoveryOverBudget\) \{\s*\n\s*_apiWarnings\.push\(`goldrush_recovery_\$\{_grRecoveryCalls\}_calls_exceeds_budget_\$\{_grRecoveryBudget\}`\)/, 'a real recovery-page overrun still produces a warning')

// historical_by_addresses_v2 stays bucketed under pricing, never historical_recovery (pre-existing
// invariant, re-asserted here since this cleanup touches the same call-accounting code).
assert.match(snap, /if \(e\.endpoint === 'historical_by_addresses_v2'\) return 'pricing'/, 'historical_by_addresses_v2 stays bucketed under pricing')
assert.match(snap, /if \(e\.endpoint === 'log_events_by_address'\) return 'historical_recovery'/, 'log_events_by_address is the only endpoint bucketed under historical_recovery')

// The api_audit_total_X_exceeds_budget_estimate_Y warning must only fire when the overage is
// genuinely unexplained (unknown-purpose calls or a real recovery overrun) — never when known-purpose
// calls fully account for the extra credits.
assert.match(snap, /const _apiAuditOverageUnexplained = _moralisUnexplainedCalls > 0 \|\| _grUnexplainedCalls > 0 \|\| _grRecoveryOverBudget/, 'budget-estimate-exceeded warning is gated on genuinely unexplained overage')
assert.match(snap, /if \(_apiTotalCredits > _walletScanBudgetDebug\.estimatedPlanningCreditsUsed && _apiAuditOverageUnexplained\) \{/, 'budget-estimate-exceeded warning requires both a credit overage and an unexplained cause')

// totalCredits and costByPurposeDetail/auditNotes/callsPrevented stay honest and present — this
// cleanup only changes which warnings fire, never the actual call accounting.
assert.match(snap, /totalCredits: _apiTotalCredits,/, 'totalCredits remains the real, unmodified credit total')
assert.match(snap, /costByPurposeDetail: \{/, 'costByPurposeDetail remains present')
assert.match(snap, /auditNotes: \[/, 'auditNotes remains present')
assert.match(snap, /callsPrevented: \{\s*\n\s*zerionCallsSavedByCache: _zerionCacheDebug\.callsSavedByCache,\s*\n\s*providerPnlSkippedChains: _providerPnlSkippedChains as string\[\],/, 'callsPrevented remains present with real prevented-call sources only')
assert.match(snap, /totalEstimatedCallsPrevented: _zerionCacheDebug\.callsSavedByCache \+ _providerPnlSkippedChains\.length,/, 'totalEstimatedCallsPrevented stays based only on real prevented calls')

console.log('wallet provider-summary apiAudit cleanup checks passed')
