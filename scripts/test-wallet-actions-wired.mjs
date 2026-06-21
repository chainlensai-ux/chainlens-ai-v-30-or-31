import fs from 'node:fs'
import assert from 'node:assert/strict'

const ui = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')
const route = fs.readFileSync('app/api/watchlist/wallets/route.ts', 'utf8')

// WIRE-WALLET-ACTIONS-1: Set Alert is removed entirely, no replacement CTA.
assert.doesNotMatch(ui, /Set Alert/, 'Set Alert button and copy are removed from the Next Actions card')

// Add To Watchlist actually calls the wallet watchlist API and is disabled without a scanned wallet.
assert.match(ui, /function handleAddWalletToWatchlist\(/, 'handleAddWalletToWatchlist handler exists')
assert.match(ui, /fetch\('\/api\/watchlist\/wallets', \{/, 'Add To Watchlist posts to the wallet watchlist API')
assert.match(ui, /disabled=\{!result\?\.address \|\| watchlistStatus === 'saving'\}/, 'Add To Watchlist button is disabled while saving or with no scanned wallet')
assert.match(ui, /Added to watchlist/, 'success feedback string is present')
assert.match(ui, /Already in watchlist/, 'already-exists feedback string is present')
assert.match(ui, /Sign in to add wallets to your watchlist\./, 'auth-required feedback string is present, no crash on missing session')

// Export Report builds a public-safe client-side JSON download, not a raw debug dump.
assert.match(ui, /function buildWalletReport\(result: WalletResult\)/, 'buildWalletReport helper exists')
assert.match(ui, /function handleExportWalletReport\(/, 'handleExportWalletReport handler exists')
assert.match(ui, /new Blob\(\[JSON\.stringify\(report, null, 2\)\], \{ type: 'application\/json' \}\)/, 'export uses a client-side Blob, no report API required')
assert.match(ui, /`chainlens-wallet-report-\$\{shortAddress\}-\$\{dateStr\}\.json`/, 'export filename matches the chainlens-wallet-report-<shortAddress>-<date>.json format')

// Safety rules: never label the export's sample PnL as a final/total figure, never derive win rate
// from raw lots, and gate the numeric win rate on the same strict public gate as the rest of the UI.
assert.match(ui, /label: 'Public-sample PnL', valueUsd: publicSamplePnlUsd/, 'export labels sample PnL as Public-sample PnL, not Total PnL')
assert.match(ui, /const winRateUnlocked = publicWinRateUnlocked\(ts\)/, 'export gates win rate through the existing strict public gate')
assert.doesNotMatch(ui, /buildWalletReport[\s\S]{0,2000}winningClosedLots \/ (?:ts\.)?closedLots/, 'export never derives win rate from raw winningClosedLots/closedLots')
assert.match(ui, /excluded lot\(s\) are not counted as realized performance/, 'export limitations explain excluded lots are not counted as realized performance')

// API route: smallest wallet-safe watchlist path, auth-gated, and tells the caller when the
// wallet already exists instead of silently double-adding it.
assert.match(route, /from\('watchlist_wallets'\)/, 'wallet watchlist API uses its own watchlist_wallets table, not the token watchlist table')
assert.match(route, /alreadyExists: true/, 'POST distinguishes an existing watchlist entry')
assert.match(route, /return NextResponse\.json\(\{ error: 'Unauthorized' \}, \{ status: 401 \}\)/, 'GET/POST/DELETE all require an authenticated user')

console.log('wallet action wiring checks passed')
