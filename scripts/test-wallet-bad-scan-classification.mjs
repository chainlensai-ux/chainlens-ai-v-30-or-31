import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')
const ui = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')

// Same-tx balance-delta swap reconstruction (no router label required)
assert.match(snap, /reconstructionMethod\?:\s*'tx_balance_delta'/, 'PnL events can be tagged as tx-balance-delta reconstructed')
assert.match(snap, /Swap-derived from same-tx \$\{cp\.symbol\} quote leg \(no router label needed\)/, 'quote-leg same-tx swap is reconstructed without a router label')
assert.match(snap, /Single-leg derived from same-tx \$\{peer\.symbol\} quote leg \(no router label needed\)/, 'single-leg quote-leg swap is reconstructed without a router label')
assert.match(snap, /isVerifiedNativeQuoteLeg/, 'verified per-chain native quote-leg detection exists')

// PnL quality tiers — no fake $0 PnL, every tier maps to real evidence
assert.match(snap, /pnlQuality\?:\s*'exact_fifo' \| 'fifo_with_estimates' \| 'sell_side_only' \| 'open_positions_cost_missing' \| 'activity_only' \| 'no_trade_evidence' \| 'missing_cost_basis'/, 'pnlQuality tier union is present')
assert.match(snap, /_realClosedLotsCount > 0 && !_missingCostBasisProven \? 'exact_fifo'/, 'exact FIFO closed lots map to exact_fifo')
assert.match(snap, /_unmatchedSellsCount > 0 \? 'sell_side_only'/, 'sells without matched buys map to sell_side_only, not open_check')
assert.match(snap, /holdings\.length > 0 && _openedLotsCount > 0 \? 'open_positions_cost_missing'/, 'open positions with no buy map to open_positions_cost_missing')

// Cache/historical label honesty
assert.match(route, /_hadLiveHistoricalCalls/, 'cache-hit recovery checks for actual live provider calls before labeling')
assert.match(route, /'cached_preview_only'/, 'cache hits with zero live calls are labeled cached_preview_only')
assert.match(route, /walletHistoricalRecoveryStatus = 'not_attempted'/, 'cache hits with zero live calls are not labeled attempted')

// PNL-SAFETY-FIX: synthetic-only closed lots must never be reported as fifo_with_estimates,
// and recovery recommendations must not claim closed lots were "already found" from synthetic lots.
assert.match(snap, /_missingCostBasisProven && \(promotedLotSummary\.syntheticClosedLots \?\? 0\) > 0 \? 'missing_cost_basis'/, 'synthetic-only closed lots map to missing_cost_basis, not fifo_with_estimates')
assert.match(snap, /reason: 'missing_cost_basis_synthetic_lots_excluded'/, 'recovery recommendation excludes synthetic-only lots with a clear reason')
assert.match(snap, /if \(_realClosedLotsCount > 0\) \{\s*\n\s*return \{ recommended: false, mode: 'none', targetTokens: \[\], reason: 'closed_lots_already_found'/, 'closed_lots_already_found is only returned when real-backed closed lots exist')
assert.match(snap, /verificationStatus: 'verifiable' \| 'partial' \| 'not_available' \| 'synthetic_cost_basis_missing'/, 'synthetic closed-trade samples get a distinct non-verifiable status')
assert.match(snap, /_sampleEligibleLots = _closedLotsForStatsFinal === 0 \? \[\] : _sampleSourceLots/, 'no closed-trade samples are exposed when every closed lot is synthetic')
assert.match(snap, /verifiedClosedLots\?:\s*number/, 'walletTradeStatsSummary exposes a verified-only closed lot count')

assert.match(ui, /_verifiedClosedLots > 0 && ts\.realizedPnlUsd !== null && ts\.pnlUnavailableReason !== 'missing_cost_basis'/, 'UI trade-evidence-strong gate uses verified closed lots, not raw synthetic closedLots count')

console.log('wallet bad-scan classification checks passed')
