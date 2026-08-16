// TESTS — Clark routing audit follow-up: bare "deep scan 0x..."/"full scan 0x..." (no explicit
// "wallet" word) must not default to a wallet scan.
//
// CONFIRMED BUG, DISCLOSED: WALLET_DEEP_RE's own "deep"/"deep scan"/"full scan" alternatives are
// genuinely ambiguous depth modifiers, not wallet-specific vocabulary — "deep scan 0x..." with no
// other signal reads at least as naturally as "run a thorough scan on this token" as it does "scan
// my wallet deeply". app/api/clark/route.ts's own separate classifyPlannerIntent already treats
// "deep scan"/"full analysis"/"run all checks" as TOKEN full-report triggers, not wallet ones —
// classifyClarkPrompt (lib/server/clarkRouting.ts) was the one place still defaulting them to a
// wallet scan, at TWO separate gates (the WALLET_DEEP_RE-driven gate, and the plain-EOA-address
// fallback right after it).

import assert from 'node:assert/strict'
import { classifyClarkPrompt } from '../lib/server/clarkRouting.ts'

const CA = '0x111111111111111111111111111111111111111a'

// Must NOT default to wallet_scan — the whole point of this fix.
for (const prompt of [
  `Deep scan ${CA}`,
  `deep scan ${CA}`,
  `Full scan ${CA}`,
  `full scan ${CA}`,
]) {
  const r = classifyClarkPrompt(prompt)
  assert.notEqual(r.intent, 'wallet_scan', `bare depth-modifier phrasing must not default to a wallet scan: "${prompt}"`)
  assert.equal(r.address, CA)
}

// Regression: the moment "wallet" is explicit, still a wallet scan — completely unaffected.
for (const prompt of [
  `deep scan this wallet ${CA}`,
  `deep scan wallet ${CA}`,
  `full wallet scan ${CA}`,
]) {
  const r = classifyClarkPrompt(prompt)
  assert.equal(r.intent, 'wallet_scan', `explicit wallet wording must still classify as wallet_scan: "${prompt}"`)
  assert.equal(r.address, CA)
}

// Regression: real, unambiguous wallet vocabulary (pnl, cost basis, dig deeper, history, trades,
// scan all chains) must still classify as wallet_scan / wallet_pnl_followup — this fix only
// narrows the ambiguous depth-modifier terms, never the genuinely wallet-specific ones.
assert.equal(classifyClarkPrompt(`${CA} pnl`).intent, 'wallet_scan')
assert.equal(classifyClarkPrompt(`${CA} cost basis`).intent, 'wallet_scan')
assert.equal(classifyClarkPrompt(`${CA} trades`).intent, 'wallet_scan')
assert.equal(classifyClarkPrompt(`scan all chains ${CA}`).intent, 'wallet_scan')
assert.equal(classifyClarkPrompt(`dig deeper ${CA}`).intent, 'wallet_pnl_followup')
assert.equal(classifyClarkPrompt(`recover more history ${CA}`).intent, 'wallet_pnl_followup')

console.log('test-clark-deep-scan-address-routing: all assertions passed')
