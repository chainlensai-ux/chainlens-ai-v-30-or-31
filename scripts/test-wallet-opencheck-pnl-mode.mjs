import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// OPENCHECK-PNL-1: the unlock-logic type must expose a pnlMode so callers can tell "real matched
// lots exist but are below the verified/performance threshold" apart from "verified" and "no
// matched lots at all" — without changing the win-rate/score unlock gate itself.
assert.match(snap, /pnlMode\?:\s*'verified' \| 'open-check' \| 'unavailable'/, 'walletTradeStatsSummary exposes pnlMode')

// The fix must branch on whether real (non-synthetic) matched lots exist before deciding whether
// to zero out closedLots/realizedPnlUsd — previously ANY shortfall below the performance/verified
// threshold zeroed PnL even when real matched lots existed (the circular dependency).
assert.match(snap, /\} else if \(_closedLotsForStatsFinal > 0\) \{/, 'open-check branch only fires when real matched lots exist')
assert.match(snap, /pnlMode: 'open-check',/, 'matched-but-unverified lots are labeled open-check, not zeroed')
assert.match(snap, /pnlMode: 'verified',/, 'performance-grade lots are labeled verified')
assert.match(snap, /pnlMode: 'unavailable',/, 'true zero-matched-lots / all-flat-estimate cases stay unavailable')

// The open-check branch must NOT zero closedLots/closedLotsForStats (that was the bug) while still
// keeping win rate, score, and public-grade-only fields locked.
const openCheckBranch = snap.slice(snap.indexOf('} else if (_closedLotsForStatsFinal > 0) {'), snap.indexOf("pnlMode: 'open-check',"))
assert.doesNotMatch(openCheckBranch, /\n\s*closedLots: 0,/, 'open-check branch does not zero closedLots')
assert.doesNotMatch(openCheckBranch, /\n\s*closedLotsForStats: 0,/, 'open-check branch does not zero closedLotsForStats')
assert.match(openCheckBranch, /scoreUnlocked: false,/, 'open-check branch still locks scoreUnlocked')
assert.match(openCheckBranch, /readyForWalletScore: false,/, 'open-check branch still locks readyForWalletScore')
assert.match(openCheckBranch, /winRatePercent: null,/, 'open-check branch still locks winRatePercent')
assert.match(openCheckBranch, /winRateStatus: 'locked_small_sample',/, 'open-check branch reports win rate as locked, never silently unlocked')

console.log('wallet open-check PnL mode checks passed')
