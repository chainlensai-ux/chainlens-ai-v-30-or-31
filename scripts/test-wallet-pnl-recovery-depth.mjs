import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const ui = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')

// Targeted recovery recommendation — reuses existing ranked targets, no new provider calls
assert.match(snap, /walletRecoveryRecommendation\?:\s*\{/, 'walletRecoveryRecommendation type is present')
assert.match(snap, /_rankedHistoricalTargets\.slice\(0, 3\)\.map/, 'recovery recommendation targets the top 3 ranked tokens by value')
assert.match(snap, /mode: 'targeted_token_recovery'/, 'recovery recommendation uses targeted_token_recovery mode')
assert.match(snap, /estimatedExtraPages: Math\.min\(2, targetTokens\.length\)/, 'recovery recommendation caps estimated extra pages')

// Dedup guard: balance-delta promotion never double-promotes an event already a swap candidate
assert.match(snap, /if \(e\.swapDetection\?\.isSwapCandidate\) continue/, 'already-classified swap candidates are skipped, avoiding duplicate FIFO events')
assert.match(snap, /existingSwapKeys\.has\(eventKey\)/, 'single-leg promotion dedupes against existing swap-candidate keys by tx+contract+direction')

// UI copy
assert.match(ui, /Exact FIFO PnL/, 'UI shows Exact FIFO PnL label')
assert.match(ui, /Estimated FIFO PnL/, 'UI shows Estimated FIFO PnL label')
assert.match(ui, /Sell found — buy cost missing/, 'UI shows sell-side-only label')
assert.match(ui, /Open position — cost basis missing/, 'UI shows open-positions-cost-missing label')
assert.match(ui, /Activity found — no matched trade yet/, 'UI shows activity-only label')
assert.match(ui, /Targeted recovery recommended/, 'UI shows targeted recovery recommendation')
assert.match(ui, /does not fake profit/, 'UI explains PnL is only shown from matched lots, never faked')

console.log('wallet PnL recovery depth checks passed')
