import assert from 'node:assert/strict'
import fs from 'node:fs'
import { classifyClarkPrompt } from '../lib/server/clarkRouting.ts'

// SOLANA-BARE-SAFE FIX + LP-CTA-STALE-FEATURE FIX, DISCLOSED.
//
// Reported live: "solana just aint working" — a Solana mint address followed by bare "safe" (no
// "is") classified as intent "none" and never reached the Solana creator/authority read, even
// though the same address with the full "is it safe" phrase worked. Root cause: the earlier
// KEYWORD-NOT-EXACT-PHRASING fix for bare "safe" only recognized an EVM 0x-address next to it.
//
// Also reported: "it still says liquidity safety feature but we dont have it anymore" — the LP
// read's CTA said "Open Liquidity Safety", a standalone page not linked in the current nav; LP
// checking now lives under Token Scanner's LP Safety tab.

const ADDR = 'Dwa2kXQZdb2XduBCHBNYDRAxJp1LzRyW3x3MBrLLpump'

assert.equal(classifyClarkPrompt(`${ADDR} safe`).intent, 'token_safety', 'a Solana mint followed by bare "safe" must route to token_safety, same as an EVM address would')
assert.equal(classifyClarkPrompt(`safe ${ADDR}`).intent, 'token_safety', '"safe" leading a Solana mint must also route to token_safety')
assert.equal(classifyClarkPrompt(`${ADDR} is it safe`).intent, 'token_safety', 'the original full-phrase form must still work (no regression)')

const routingSrc = fs.readFileSync(new URL('../lib/server/clarkRouting.ts', import.meta.url), 'utf8')
const routingCode = routingSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
assert.match(routingCode, /\[1-9A-HJ-NP-Za-km-z\]\{32,44\}\\s\+safe\\\?\?\$\|\^safe\\\?\?\\s\+\[1-9A-HJ-NP-Za-km-z\]\{32,44\}/, 'TOKEN_SAFETY_RE must recognize a bare Solana mint next to "safe", not just an EVM address')

// The LP read must no longer reference the orphaned standalone "Liquidity Safety" page.
assert.doesNotMatch(routingCode, /Open Liquidity Safety/, 'formatLpReadResult must not reference the orphaned "Liquidity Safety" page')
assert.match(routingCode, /CTA: Open Token Scanner \(LP Safety tab\)/, 'formatLpReadResult must point to the current Token Scanner LP tab')

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
assert.doesNotMatch(routeCode, /Open Liquidity Safety/, 'the LP-check mapped.nextAction must not reference the orphaned "Liquidity Safety" page either')

console.log('test-clark-solana-bare-safe-and-lp-cta.mjs: all assertions passed')
