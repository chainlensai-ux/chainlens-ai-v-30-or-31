import assert from 'node:assert/strict'
import fs from 'node:fs'

// EVIDENCE-CHAIN-COLLAPSE FIX, DISCLOSED.
//
// Reported live: "every Robinhood token title has Base next to it." Root cause: the ev.chain value
// fetchTokenEvidence builds from the real /api/token response only ever recognized "eth"/"ethereum"/
// "base" — its final fallback collapsed EVERYTHING else, a genuine "bnb" or "robinhood" response
// value included, down to "base". So even when chainForClarkTools had already correctly auto-
// detected Robinhood/BNB upstream and the scan genuinely ran on that chain, this derivation silently
// overwrote it with "base" before tokenEvidenceChain/chainDisplayLabel (already fixed earlier this
// session to recognize bnb/robinhood) ever got a chance to show the real one.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

assert.match(routeCode, /responseChainRaw === "bnb" \|\| responseChainRaw === "bsc" \? "bnb"/, 'evidenceChain must recognize a real BNB response value')
assert.match(routeCode, /responseChainRaw === "robinhood" \? "robinhood"/, 'evidenceChain must recognize a real Robinhood response value')
assert.match(routeCode, /: chainForClarkTools;/, 'evidenceChain\'s final fallback must be the real auto-detected chainForClarkTools, never a hardcoded "base"')
assert.doesNotMatch(routeCode, /const evidenceChain = responseChainRaw === "eth" \|\| responseChainRaw === "ethereum" \? "eth" : responseChainRaw === "base" \? "base" : \(chain === "ethereum" \? "eth" : "base"\);/, 'the old collapse-to-base-or-eth derivation must be gone')

console.log('test-clark-evidence-chain-collapse.mjs: all assertions passed')
