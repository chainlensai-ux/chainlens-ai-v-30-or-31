import fs from 'node:fs'
import assert from 'node:assert/strict'

const page = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')

// Official wallet PnL logic (walletPnlRead, walletLockedPnlRead, publicRealizedPnlUsd, etc.) must
// be untouched — this fix is display-layer only for the Matched Trade Evidence sample cards.
assert.match(page, /publicPnlFullyLocked\(result, ts\) \|\| s\.includedInPublicStats === false \|\| s\.publicPnlStatus !== 'ok'/, 'samplePnlLocked gating logic is unchanged')

// Sample cards must no longer headline every locked lot as "Official PnL locked" — that copy is
// now a small secondary badge only, not the card's main headline.
const officialLockedHeadlineRe = /fontSize: '12px', fontWeight: 700, color: '#fbbf24'[^}]*\}\}>Official PnL locked</
assert.doesNotMatch(page, officialLockedHeadlineRe, '"Official PnL locked" is no longer rendered as the big yellow card headline')

// New estimated-PnL headline and copy must be present.
assert.match(page, /Estimated PnL<\/div>/, 'locked sample cards show an "Estimated PnL" headline when raw PnL is available')
assert.match(page, /Estimated PnL unavailable/, 'locked sample cards with no raw PnL show "Estimated PnL unavailable"')
assert.match(page, /Sample only · Not official/, 'estimated PnL cards are subcopied as sample-only, not official')
assert.match(page, /Price\/cost basis was not strong enough for this lot\./, 'unavailable estimated PnL cards explain why')
assert.match(page, /Excluded from official PnL, win rate, score, and profit skill\./, 'locked sample cards always disclose exclusion from official PnL/win rate/score/profit skill')

// Integrity badge must be small/secondary, not the big yellow headline color, and must read
// "Official locked" or "Integrity gated".
assert.match(page, /integrityBadgeLabel = s\.verificationStatus === 'synthetic_cost_basis_missing' \|\| s\.verificationStatus === 'price_independence_missing'\s*\n\s*\? 'Integrity gated'\s*\n\s*: 'Official locked'/, 'secondary integrity badge reads Official locked or Integrity gated')

// Top section copy must be updated to the new estimated/sample-evidence framing.
assert.match(page, /Reconstructed trade samples\. PnL shown here is estimated\/sample evidence only and is excluded from official PnL, win rate, score, and profit skill unless public-grade checks pass\./, 'Matched Trade Evidence intro copy uses the new estimated/sample framing')

// Card must still separate entry->exit price, hold time, and confidence from PnL.
assert.match(page, /Entry → Exit<\/div>/, 'card still shows an Entry → Exit section')
assert.match(page, />Hold<\/div>/, 'card still shows a Hold section')
assert.match(page, />Conf<\/div>/, 'card still shows a Confidence section')

console.log('test-wallet-sample-pnl-display: all assertions passed')
