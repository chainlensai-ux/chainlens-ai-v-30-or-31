// TESTS — Clark deployer-question routing fix (right-panel/prompt-routing follow-up task).
//
// CONFIRMED BUG, DISCLOSED: "who is the deployer for this token 0x..." (or "who deployed 0x...",
// "deployer of 0x...") has an address, so resolveClarkIntent (lib/clarkIntent.ts — no dev_wallet
// concept at all) always defaulted it to 'token_scan', and buildClarkToolPlan's own
// `routedIntent.intent === 'token_scan' && routedIntent.address` early return then answered it with
// a PLAIN token_scan tool plan before the deployer question was ever read — silently swapping a
// deployer-info request for a generic token safety scan. The existing "HARD PRIORITY OVERRIDE" for
// dev_wallet in that same function only ran `if (!directAddress)` — the opposite of this case — so
// it never got a chance to fire either.
//
// buildClarkToolPlan itself is not exported (same "not exported for direct invocation" convention
// documented in scripts/test-clark-execution.mjs), so — matching that file's own established
// pattern — this reads route.ts's source to confirm the fix's shape/ordering, and directly
// re-verifies the exact regex it uses (a plain, pure RegExp — fully testable on its own) against
// real prompts, including regression prompts that must NOT match.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveClarkIntent } from '../lib/clarkIntent.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const routeFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'clark', 'route.ts'), 'utf8')

// ─── Source-shape checks ──────────────────────────────────────────────────────
{
  const devCheckIdx = routeFile.indexOf('DEV_WALLET_QUESTION_RE.test(message)')
  const tokenScanEarlyReturnIdx = routeFile.indexOf("routedIntent.intent === 'token_scan' && routedIntent.address")
  assert.ok(devCheckIdx > -1, 'the new dev-wallet-question check exists in route.ts')
  assert.ok(tokenScanEarlyReturnIdx > -1, 'the pre-existing token_scan early return still exists')
  assert.ok(devCheckIdx < tokenScanEarlyReturnIdx, 'the dev-wallet-question check runs BEFORE the generic token_scan early return, so it is never swallowed by it')
  assert.ok(routeFile.includes('name: "dev_wallet_analyze", args: { address: directAddress }'), 'the fix routes to the real dev_wallet_analyze tool with the address actually pasted, not a placeholder')
}

// ─── resolveClarkIntent confirms the ROOT CAUSE is real: these prompts always classify as
// token_scan (never wallet_scan/liquidity_scan), which is exactly why the fix has to intercept
// them before the token_scan early return specifically. ─────────────────────────────────────────
const CA = '0x111111111111111111111111111111111111111a'
for (const prompt of [
  `Who is the deployer for this token ${CA}`,
  `Who deployed ${CA}`,
  `Deployer of ${CA}`,
]) {
  const r = resolveClarkIntent(prompt)
  assert.equal(r.intent, 'token_scan', `resolveClarkIntent has no dev_wallet concept, so "${prompt}" defaults to token_scan — confirming why the extra check is needed`)
  assert.equal(r.address, CA)
}

// ─── The exact regex used in the fix — verified directly since buildClarkToolPlan is not exported.
const DEV_WALLET_QUESTION_RE = /\b(dev\s+wallet|deployer|who\s+deployed|who\s+made\s+this|who\s+built|who\s+created|check\s+creator|origin\s+wallet|is\s+the\s+dev|check\s+dev|deployer\s+of)\b/i

for (const prompt of [
  `Who is the deployer for this token ${CA}`,
  `Who deployed ${CA}`,
  `Deployer of ${CA}`,
  `who made this ${CA}`,
  `check the dev wallet for ${CA}`,
  `who built ${CA}`,
]) {
  assert.ok(DEV_WALLET_QUESTION_RE.test(prompt), `deployer question with a pasted contract must match: "${prompt}"`)
}

// Regression: prompts that must NOT be swept into dev_wallet routing by this new check.
for (const prompt of [
  `Scan BRETT ${CA}`,
  `Scan token ${CA}`,
  `is ${CA} safe`,
  `Analyze this wallet ${CA}`,
  `Liquidity check ${CA}`,
]) {
  assert.equal(DEV_WALLET_QUESTION_RE.test(prompt), false, `ordinary scan prompt must not be treated as a deployer question: "${prompt}"`)
}

console.log('test-clark-deployer-routing: all assertions passed')
