// Test for lib/server/watchlistValidation.ts — the address/chain/label format checks added to
// app/api/watchlist/tokens/route.ts and app/api/watchlist/wallets/route.ts during a security
// hardening pass.
//
// Run: node scripts/test-watchlist-validation.mjs

import assert from 'node:assert'
import { isValidAddress, isAllowedChain, isValidLabel, MAX_WATCHLIST_LABEL_LEN } from '../lib/server/watchlistValidation.ts'

let passed = 0
function check(label, condition) {
  assert.ok(condition, label)
  passed++
}

// Address validation
check('real 40-hex address accepted', isValidAddress('0x1234567890abcdef1234567890ABCDEF12345678') === true)
check('address missing 0x prefix rejected', isValidAddress('1234567890abcdef1234567890ABCDEF12345678') === false)
check('address too short rejected', isValidAddress('0x1234') === false)
check('address with non-hex characters rejected', isValidAddress('0xZZZZ567890abcdef1234567890ABCDEF123456') === false)
check('SQL-injection-shaped string rejected', isValidAddress("0x'; DROP TABLE watchlist_tokens; --") === false)
check('empty string rejected', isValidAddress('') === false)
check('null rejected', isValidAddress(null) === false)
check('non-string rejected', isValidAddress(12345) === false)

// Chain allowlist
check('base allowed', isAllowedChain('base') === true)
check('eth allowed', isAllowedChain('eth') === true)
check('bnb allowed', isAllowedChain('bnb') === true)
check('robinhood allowed', isAllowedChain('robinhood') === true)
check('unsupported chain rejected', isAllowedChain('solana') === false)
check('arbitrary string rejected', isAllowedChain('../../etc/passwd') === false)
check('empty string rejected', isAllowedChain('') === false)

// Label length
check('short label accepted', isValidLabel('My favorite token') === true)
check('null label accepted (optional field)', isValidLabel(null) === true)
check('undefined label accepted (optional field)', isValidLabel(undefined) === true)
check('label at max length accepted', isValidLabel('a'.repeat(MAX_WATCHLIST_LABEL_LEN)) === true)
check('oversized label rejected', isValidLabel('a'.repeat(MAX_WATCHLIST_LABEL_LEN + 1)) === false)

console.log(`test-watchlist-validation.mjs: all ${passed} assertions passed`)
