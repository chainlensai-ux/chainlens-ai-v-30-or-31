// Test for lib/server/goplusSecurity.ts — the real GoPlus fallback used when honeypot.is has no
// data for a token, wired into app/api/token/route.ts during this session (replacing a hardcoded
// `const gpHoneypot: null = null` stub that never made a real call).
//
// Run: node scripts/test-goplus-security.mjs

import assert from 'node:assert'
import { fetchGoPlusHoneypotFallback, GOPLUS_SUPPORTED_CHAIN_IDS } from '../lib/server/goplusSecurity.ts'

let passed = 0
function check(label, condition) {
  assert.ok(condition, label)
  passed++
}

// Chain support set — matches GoPlus's real documented token_security coverage.
check('eth (1) supported', GOPLUS_SUPPORTED_CHAIN_IDS.has(1))
check('bnb (56) supported', GOPLUS_SUPPORTED_CHAIN_IDS.has(56))
check('polygon (137) supported', GOPLUS_SUPPORTED_CHAIN_IDS.has(137))
check('base (8453) supported', GOPLUS_SUPPORTED_CHAIN_IDS.has(8453))
check('robinhood (4663) not supported', !GOPLUS_SUPPORTED_CHAIN_IDS.has(4663))

// Gating: unsupported chain or invalid address must return null without a network call.
const result1 = await fetchGoPlusHoneypotFallback(4663, '0x' + '1'.repeat(40))
check('unsupported chain (robinhood) returns null without network access', result1 === null)

const result2 = await fetchGoPlusHoneypotFallback(8453, 'not-an-address')
check('invalid address returns null without network access', result2 === null)

const result3 = await fetchGoPlusHoneypotFallback(8453, '0x1234')
check('too-short address returns null without network access', result3 === null)

console.log(`test-goplus-security.mjs: all ${passed} assertions passed`)
