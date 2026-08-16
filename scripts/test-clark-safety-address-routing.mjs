// TESTS — Clark routing audit follow-up: bare "is 0x... safe" (and rug/honeypot/scam variants)
// must not default to a wallet scan.
//
// CONFIRMED BUG, DISCLOSED: classifyClarkPrompt's plain-EOA-address fallback (lib/server/
// clarkRouting.ts) routes an address with no other recognized strong-intent keyword to
// 'wallet_scan'. "is 0x... safe" — a very common real phrasing for pasting a token contract and
// asking about it, with no explicit "token" word — previously matched none of that rule's
// strong-intent keywords, so it silently ran Wallet Scanner against what's usually actually a
// token contract, and app/api/clark/route.ts's own `routed.intent === "wallet_scan" && routed.
// address && routeHint !== 'token'` branch (getClarkAddressRouteHint returns "none" — not "token"
// — for this exact phrasing, since it also has no explicit token keyword) does not block it.

import assert from 'node:assert/strict'
import { classifyClarkPrompt } from '../lib/server/clarkRouting.ts'

const CA = '0x111111111111111111111111111111111111111a'

// Must NOT be treated as a wallet scan — the whole point of this fix.
for (const prompt of [
  `is ${CA} safe`,
  `is ${CA} a rug`,
  `is ${CA} a honeypot`,
  `is ${CA} a scam`,
  `${CA} safety`,
]) {
  const r = classifyClarkPrompt(prompt)
  assert.notEqual(r.intent, 'wallet_scan', `must not misroute a token safety question as a wallet scan: "${prompt}"`)
  assert.equal(r.address, CA, `address must still be extracted: "${prompt}"`)
}

// Regression: genuine wallet-intent phrasings (with an address) must still classify as
// wallet_scan — this fix must never touch the wallet path itself.
for (const prompt of [
  `scan wallet ${CA}`,
  `analyze wallet ${CA}`,
  `${CA} pnl`,
  `${CA} holdings`,
  `${CA} portfolio`,
]) {
  const r = classifyClarkPrompt(prompt)
  assert.equal(r.intent, 'wallet_scan', `genuine wallet phrasing must still classify as wallet_scan: "${prompt}"`)
  assert.equal(r.address, CA)
}

// Regression: a bare address with a real token keyword (already worked before this fix) is
// unaffected — this only widens the strong-intent keyword list, never narrows it.
{
  const r = classifyClarkPrompt(`is this token safe ${CA}`)
  assert.notEqual(r.intent, 'wallet_scan')
}

console.log('test-clark-safety-address-routing: all assertions passed')
