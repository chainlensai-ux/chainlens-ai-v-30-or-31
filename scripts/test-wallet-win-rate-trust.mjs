import fs from 'node:fs'
import assert from 'node:assert/strict'

const ui = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')

// WIN-RATE-TRUST-FIX-1: a strict public-grade gate must exist and be the only path that allows
// rendering a numeric win rate labeled as official/public.
assert.match(ui, /function publicWinRateUnlocked\(/, 'publicWinRateUnlocked gating helper exists')
assert.match(ui, /Number\.isFinite\(ts\.publicWinRatePercent\) &&\s*\n\s*publicPerfLots >= 10 &&\s*\n\s*ts\.winRateStatus !== 'locked_small_sample' &&\s*\n\s*\(ts\.scoreUnlocked === true \|\| ts\.readyForWalletScore === true\)/, 'publicWinRateUnlocked requires a finite public win rate, 10+ public-grade lots, an unlocked winRateStatus, and an unlocked score')

// The Instant Wallet Score card must never compute a raw win rate from winningClosedLots/closedLots
// and must never label it "Official Win Rate" or "Win Rate (raw)".
assert.doesNotMatch(ui, /winningClosedLots \/ closedLots\) \* 100\) : null\s*\n\s*const label = walletIntel\.winRate/, 'Instant Wallet Score no longer derives a raw win rate fallback')
assert.doesNotMatch(ui, /'Official Win Rate'/, 'Official Win Rate label removed — public win rate is shown as Locked or a public-grade percentage only')

// Best/Worst/Average win-loss labels must distinguish "no public-grade evidence" from a generic
// Open Check when the reason is simply zero public-grade wins/losses.
assert.match(ui, /\['Best Trade', hasPublicWin \? fmtSignedUSD\(ts!\.largestWinUsd\) : 'No verified win'\]/, 'Best Trade shows No verified win instead of Open Check when there are zero public-grade winning lots')
assert.match(ui, /\['Worst Trade', hasPublicLoss \? fmtSignedUSD\(ts!\.largestLossUsd\) : 'No verified loss'\]/, 'Worst Trade shows No verified loss instead of Open Check when there are zero public-grade losing lots')
assert.match(ui, /\['Average Win', hasPublicWin \? fmtSignedUSD\(deriveAverageMatchedWinUsd\(result\)\) : 'No verified win'\]/, 'Average Win shows No verified win instead of Open Check')
assert.match(ui, /\['Average Loss', hasPublicLoss \? fmtSignedUSD\(deriveAverageMatchedLossUsd\(result\)\) : 'No verified loss'\]/, 'Average Loss shows No verified loss instead of Open Check')

// Public-sample PnL labeling and win-rate-unlock copy.
assert.match(ui, /Win rate and profit-skill scoring unlock at 10 public-grade trades\./, 'Real Trade Evidence card explains the 10 public-grade trade unlock threshold')
assert.match(ui, /'Public-sample PnL'/, 'limited-sample PnL keeps the Public-sample PnL label, never claiming full-wallet Realized PnL')

// Position Estimate card must never render an empty "Average-Cost Estimate —" box with zero context
// when there is no open-position summary or open-position performance evidence at all.
assert.match(ui, /No open position estimate/, 'Position Estimate card shows an explicit no-estimate state')
assert.match(ui, /No public-safe open-lot estimate is available from this scan\./, 'Position Estimate card explains why no estimate is shown')

console.log('wallet win-rate trust checks passed')
