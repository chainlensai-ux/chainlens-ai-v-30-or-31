import assert from 'node:assert/strict'
import fs from 'node:fs'
import { classifyClarkPrompt } from '../lib/server/clarkRouting.ts'

// KEYWORD-NOT-EXACT-PHRASING FIX, DISCLOSED.
//
// Reported live: "0x... is it safe" worked correctly, but "0x... safe" (no "is") fell through to a
// wrong/garbled generic response ("Safety read for Unknown (?)") because TOKEN_SAFETY_RE (routing)
// and CLARK_TOKEN_QUESTION_RE (the entity gate) both required the full "is (it|this|that) safe"
// phrase — a bare "safe" alongside a real address, or "safe" alone, never matched anything. User's
// own words: "its like a robot u shoudent have to put exact words... should have to put keyworfs."
//
// Fix: both regexes now also match "<address> safe[?]", "safe[?] <address>", and bare "safe" as the
// entire prompt — without colliding with existing, more specific categories like LP/liquidity safety
// ("is liquidity safe" must stay lp_lock_check, not get swallowed by the new bare-"safe" match).

const ADDR = '0x4F06DbA806d66e1CAeB37516C0f7A28728067777'

assert.equal(classifyClarkPrompt(`${ADDR} safe`).intent, 'token_safety', 'address followed by bare "safe" (no "is") must route to token_safety')
assert.equal(classifyClarkPrompt(`${ADDR} safe?`).intent, 'token_safety', 'address followed by "safe?" must route to token_safety')
assert.equal(classifyClarkPrompt(`safe ${ADDR}`).intent, 'token_safety', '"safe" leading an address must route to token_safety')
assert.equal(classifyClarkPrompt(`${ADDR} is it safe`).intent, 'token_safety', 'the original full-phrase form must still work (no regression)')

// Must not swallow the existing, more specific LP/liquidity-safety category.
assert.equal(classifyClarkPrompt('is liquidity safe').intent, 'lp_lock_check', 'the bare-"safe" widening must not steal "is liquidity safe" from lp_lock_check')
assert.equal(classifyClarkPrompt('is LP locked').intent, 'lp_lock_check', 'lp_lock_check routing must be unaffected')

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
assert.match(routeCode, /const CLARK_TOKEN_QUESTION_RE = \/.*0x\[a-f0-9\]\{40\}\\s\+safe\\\?\?\$\|\^safe\\\?\?\\s\+0x\[a-f0-9\]\{40\}\/i;/, 'CLARK_TOKEN_QUESTION_RE (the entity gate) must also recognize the bare-address-plus-safe phrasing, kept in sync with the routing classifier')

console.log('test-clark-keyword-not-phrasing.mjs: all assertions passed')
