import assert from 'node:assert/strict'
import fs from 'node:fs'

// ENTITY-CHECK-SINGLE-ATTEMPT-FLAKE FIX, DISCLOSED.
//
// Reported live: after the GoldRush/GeckoTerminal/DexScreener retry fixes shipped, the auto-detect
// probe kept flip-flopping on whether the same BNB address had a real contract on BNB across
// back-to-back identical queries — sometimes disclosing "real code on more than one chain" (Base +
// BNB), sometimes not (Base only). Traced to classifyAddressForClark's eth_getCode RPC call: a
// single fetch attempt with a 3.5s timeout, where ANY failure (timeout, transient RPC error,
// malformed response) silently fell through to "unknown" with no retry — so a momentary RPC hiccup
// on just the BNB leg of the parallel probe made that chain vanish from detection for that one
// request only, with nothing distinguishing it from "genuinely no contract there."
//
// Fix: one retry, and only on a genuine failure to get a structural result — never on a real
// "0x"/"0x0" empty-code response, which is itself a valid wallet verdict, not something to retry.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

assert.match(routeCode, /for \(let attempt = 0; attempt < 2; attempt\+\+\) \{\s*\n\s*try \{\s*\n\s*logRpcCall\(\{ route: "\/api\/clark", chain: loggedChain, method: "eth_getCode" \}\);/, 'classifyAddressForClark must attempt the eth_getCode call up to twice (one retry)')
assert.match(routeCode, /if \(code\) return code === "0x" \|\| code === "0x0" \? "wallet" : "contract";/, 'a genuine structural result (including a real empty-code wallet verdict) must return immediately, never be retried')
assert.match(routeCode, /if \(code\) return code === "0x" \|\| code === "0x0" \? "wallet" : "contract";\s*\n\s*if \(attempt === 1\) return "unknown";/, 'a missing/unusable result on the first attempt must trigger exactly one retry before giving up as unknown')

console.log('test-clark-entity-check-retry.mjs: all assertions passed')
