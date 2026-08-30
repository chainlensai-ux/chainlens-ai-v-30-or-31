import assert from 'node:assert/strict'
import fs from 'node:fs'

// ADDRESS-BLIND-GATE FIX, DISCLOSED.
//
// Reported live: "solana lp is basic and shit and clark needs to be more aware whats a wallet and
// a token." Live reproduction: a real Solana mint pasted with "is it safe" — the exact phrasing that
// worked one round earlier for a different address — instead got "Which token should I check? Send
// a symbol or contract." Traced to THIS_RE, a "contextual 'this' resolution" gate (`is it safe`
// among its own alternatives) guarded by `!extractAddress(prompt)` — extractAddress only recognizes
// 0x-EVM addresses, so a real Solana address right there in the prompt was invisible to it. The gate
// concluded "no address here, must be a follow-up to whatever's in memory" and answered from stale
// context instead — the same failure mode as "WALLET READ ... Active chains: Base" for a Solana
// token pasted alone.
//
// Auditing the file turned up OVER A DOZEN more early gates with the identical `!extractAddress
// (prompt)` pattern — every one of them blind to a Solana address in the current message. Rather
// than patching this bug one report at a time (already done once for the token-followup memory
// guard specifically), consolidated into a single hasAnyAddress() helper (EVM OR Solana) and
// migrated every one of these gates to use it.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

assert.match(routeCode, /function hasAnyAddress\(text: string\): boolean \{\s*\n\s*return extractAddress\(text\) != null \|\| isValidSolanaMintAddress\(extractAddressForRouting\(text\) \?\? ""\);\s*\n\}/, 'a shared hasAnyAddress helper must exist, checking both EVM and Solana address shapes')

// No "no address present" gate in this file should still be using the old EVM-only check — every
// occurrence of `!extractAddress(prompt)` as a standalone guard condition must be gone.
assert.doesNotMatch(routeCode, /&& !extractAddress\(prompt\)/, 'no gate may still use the EVM-only !extractAddress(prompt) check for "is there an address in this message" — all must use hasAnyAddress')

// Spot-check the specific gate that reproduced the reported bug (THIS_RE, which includes
// "is it safe" among its own alternatives) — it must now use the shared, Solana-aware helper.
assert.match(routeCode, /if \(THIS_RE\.test\(prompt\) && !hasAnyAddress\(prompt\)\) \{/, 'THIS_RE (the exact gate that mishandled "is it safe" for a Solana address) must use hasAnyAddress')

// Every other migrated gate, so a future edit can't quietly reintroduce the EVM-only check on one
// of them without this test catching it.
for (const gatePattern of [
  /THIS_DEV_RE\.test\(prompt\).*!hasAnyAddress\(prompt\)/,
  /if \(THIS_LIQ_RE\.test\(prompt\) && !hasAnyAddress\(prompt\)\) \{/,
  /if \(SCAN_ETH_INSTEAD_RE\.test\(prompt\) && !hasAnyAddress\(prompt\)\) \{/,
  /if \(talkingMatch && !hasAnyAddress\(prompt\)\) \{/,
  /if \(WATCH_VERDICT_RE\.test\(prompt\) && !hasAnyAddress\(prompt\) && !extractTokenLookupQuery\(prompt\)\) \{/,
  /if \(isHolderQuestion\(prompt\) && !extractTokenLookupQuery\(prompt\) && !hasAnyAddress\(prompt\)\) \{/,
  /if \(WHY_RISKY_RE\.test\(prompt\) && !hasAnyAddress\(prompt\) && !extractTokenLookupQuery\(prompt\)\) \{/,
  /if \(MISSING_CHECKS_RE\.test\(prompt\) && !hasAnyAddress\(prompt\) && !extractTokenLookupQuery\(prompt\)\) \{/,
  /if \(COMPARE_LAST_RE\.test\(prompt\) && !hasAnyAddress\(prompt\)\) \{/,
  /if \(WATCH_NEXT_RE\.test\(prompt\) && !hasAnyAddress\(prompt\) && !extractTokenLookupQuery\(prompt\)\) \{/,
  /if \(CASUAL_CHAT_RE\.test\(prompt\.trim\(\)\) && !hasAnyAddress\(prompt\)\) \{/,
]) {
  assert.match(routeCode, gatePattern, `gate must be migrated to hasAnyAddress: ${gatePattern}`)
}

console.log('test-clark-address-blind-gates.mjs: all assertions passed')
