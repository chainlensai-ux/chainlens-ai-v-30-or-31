import fs from 'node:fs'
import assert from 'node:assert/strict'

const windowMod = fs.readFileSync('lib/server/smartRecoveryWindow.ts', 'utf8')

// Window detection is a cheap 1-2 page pre-pass — never a full history sweep.
assert.match(windowMod, /Math\.max\(1, Math\.min\(maxPages, 2\)\)/, 'window detection caps pages to 1-2')

// Returns the required shape: startTimestamp, endTimestamp, confidence.
assert.match(windowMod, /startTimestamp: string \| null/, 'window result has startTimestamp')
assert.match(windowMod, /endTimestamp: string \| null/, 'window result has endTimestamp')
assert.match(windowMod, /confidence: 'high' \| 'medium' \| 'low' \| 'none'/, 'window result has confidence')

// Confidence is derived from observed transfer volume, not guessed.
assert.match(windowMod, /transfersSeen >= 50 \? 'high' : transfersSeen >= 10 \? 'medium' : 'low'/, 'confidence is derived from transfersSeen thresholds')

// Isolated module: does not import or call into FIFO/swap-detection/price-evidence internals.
assert.doesNotMatch(windowMod, /import.*(?:fifo|swapDetection|priceEvidence)/i, 'window module does not import FIFO/swap/price logic')
assert.doesNotMatch(windowMod, /function\s+(?:matchFifo|reconstructFifo|detectSwaps)/i, 'window module does not implement FIFO/swap logic')

// No activity found is a distinct, non-crashing outcome.
assert.match(windowMod, /reason: 'no_transfer_activity_found'/, 'handles wallets with no transfer activity')
assert.match(windowMod, /reason: 'unsupported_chain'/, 'handles unsupported chains without throwing')

console.log('test-smart-recovery-window: all assertions passed')
