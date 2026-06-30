import fs from 'node:fs'
import assert from 'node:assert/strict'

const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')
const page = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')
const engine = fs.readFileSync('lib/server/smartRecoveryEngine.ts', 'utf8')
const windowMod = fs.readFileSync('lib/server/smartRecoveryWindow.ts', 'utf8')

// Smart Recovery must be admin-gated on the server using the same fullRecoveryAllowed check as
// full_recovery — never trusting the client-sent walletScanMode alone.
assert.match(route, /smartRecoveryRequested[\s\S]{0,200}if \(!fullRecoveryAllowed\)/, 'smart_recovery route branch is gated by fullRecoveryAllowed')
assert.match(route, /Smart Recovery is admin-only\./, 'route returns admin-only error for non-admins')

// Smart Recovery must delegate to the existing fetchWalletSnapshot pipeline, not reimplement FIFO.
assert.match(engine, /import \{ fetchWalletSnapshot, WALLET_SCAN_MODE_CONFIG/, 'engine imports fetchWalletSnapshot instead of reimplementing the pipeline')
assert.match(engine, /await fetchWalletSnapshot\(/, 'engine calls fetchWalletSnapshot')
assert.doesNotMatch(engine, /function matchFifo|function reconstructFifo/i, 'engine does not reimplement FIFO matching')

// Window detection is capped (cheap pre-pass), not a full-history scan.
assert.match(windowMod, /Math\.max\(1, Math\.min\(maxPages, 2\)\)/, 'window detection caps pages to a cheap pre-pass')

// Frontend: button and handler exist, gated by isFullRecoveryAdmin, with correct mode string.
assert.match(page, /handleScan\('smart_recovery'\)/, 'frontend triggers smart_recovery scan mode')
assert.match(page, /Smart Recovery \(Admin\)/, 'frontend has Smart Recovery admin button label')
assert.match(page, /Smart Recovery is admin-only\./, 'frontend blocks non-admins with correct message')

console.log('test-smart-recovery-mode: all assertions passed')
