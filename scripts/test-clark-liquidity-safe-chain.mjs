import assert from 'node:assert/strict'
import fs from 'node:fs'

// LIQUIDITY-SAFE-PHRASING + LIQUIDITY-SAFE-CHAIN-BLIND FIX, DISCLOSED.
//
// Reported live, in the same session as the keyword-not-exact-phrasing and entity-check-retry
// fixes: "is liquidity safe on 0x..." — a real, contract-confirmed multi-chain token, already
// verified minutes earlier via the plain "safe" phrasing — came back as "That address looks like a
// wallet, not a token contract" as soon as "liquidity" was added to the question.
//
// Root cause, two layers deep:
//  1. CLARK_TOKEN_QUESTION_RE (the entity gate / auto-chain-detection trigger) only recognized
//     "liquidity safety" (noun) and "liquidity locked", never "liquidity safe" (adjective) — so this
//     exact phrasing never triggered the entity gate or the multi-chain auto-detect probe at all.
//  2. With the gate skipped, the address fell straight to the OLDER, separate
//     `appIntent.intent === 'liquidity_scan'` legacy branch, which ran its own classifyAddressForClark
//     check against the bare `chain` variable (the pre-auto-detection UI/prompt default) instead of
//     `chainForClarkTools` — so even when the entity gate DOES run and auto-detect the real chain for
//     other phrasings of the same address, this branch never benefited from it.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

assert.match(routeCode, /liquidity\\s\+safe\|is\\s\+liquidity\\s\+safe/, 'CLARK_TOKEN_QUESTION_RE must recognize "liquidity safe" (adjective form), not just "liquidity safety"')
assert.match(routeCode, /const kind = await classifyAddressForClark\(appIntent\.address, chainForClarkTools\);/, 'the liquidity_scan legacy branch must check the auto-detected chainForClarkTools, not the plain pre-detection chain default')
assert.doesNotMatch(routeCode, /const kind = await classifyAddressForClark\(appIntent\.address, chain\);/, 'the old chain-blind call must be gone entirely')

console.log('test-clark-liquidity-safe-chain.mjs: all assertions passed')
