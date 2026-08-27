import assert from 'node:assert/strict'
import fs from 'node:fs'
import { classifyClarkPrompt } from '../lib/server/clarkRouting.ts'

// CLARK TOKEN-VS-WALLET MISROUTING FIX, DISCLOSED.
//
// Reported: token-specific questions ("Is 0x... safe?", "Who deployed 0x...?", "Top holders for
// 0x...?", "Is LP locked on 0x...?", "Market cap of 0x...?", "Why is 0x... pumping?") sometimes
// answered with wallet portfolio/PnL data instead of token evidence.
//
// Root cause: Clark has ~40 legacy intent branches (appIntent/routedClassification/analystRouting/
// detectIntent), each independently deciding whether an address is a wallet or a token from
// keyword heuristics — none of them verified the address's REAL on-chain type before routing,
// except one narrow liquidity_scan-only check. A phrasing that slipped past every keyword
// heuristic (or hit one wired to the wrong branch) could reach a wallet handler with a real token
// contract address and vice versa, with no safety net.
//
// Fix: required flow is parse intent -> resolve entity -> route. Added a single, narrow gate
// (classifyClarkQuestionCategory + resolveClarkEntity) that runs before EVERY existing branch,
// using the real eth_getCode-based classifyAddressForClark check (already existed, reused not
// duplicated) — so it can't be bypassed by whichever legacy classifier fires for a given phrasing.
// Only gates on an address literally present in the CURRENT message; a memory-resolved follow-up
// is untouched.
//
// Static source assertions, matching this repo's established convention for this route file.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// ─── Required flow: parse intent -> resolve entity -> route ────────────────────────────────────
assert.match(routeCode, /function classifyClarkQuestionCategory\(prompt: string\): 'token' \| 'wallet' \| 'ambiguous' \{/, 'a dedicated, narrow token-vs-wallet question classifier must exist')
assert.match(routeCode, /async function resolveClarkEntity\(/, 'a resolveClarkEntity function must exist')
// Must be a thin wrapper, never a second implementation of the on-chain check.
assert.match(routeCode, /const kind = await classifyAddressForClark\(input\.address, input\.requestedChain\);/, 'resolveClarkEntity must reuse the existing eth_getCode-based classifier, not reimplement it')
// The gate must run before the CLARK-BASIC-INTENT block and everything after it.
const gateIdx = routeCode.indexOf('const inlineAddress = extractAddress(prompt);')
const basicIntentIdx = routeCode.indexOf('const basicIntent = classifyClarkBasicIntent(prompt);')
assert.ok(gateIdx > 0 && basicIntentIdx > 0 && gateIdx < basicIntentIdx, 'the entity-resolution gate must run before every existing intent branch')

// ─── Hard rules ──────────────────────────────────────────────────────────────────────────────
assert.match(routeCode, /if \(inlineAddress && questionCategory !== 'ambiguous'\) \{/, 'the gate must only fire on a real address present in the current message with a clear declared category — never guess on an ambiguous prompt')
// Never blocks on an RPC failure (fails open — "never say unavailable until all sources tried").
assert.match(routeCode, /return \{ hasContractCode: null, resolvedEntityType: 'unknown' \};/, 'resolveClarkEntity must fail open (unknown), never block a real answer when the RPC check itself fails')
// The mismatch ternary only fires on a CONFIRMED opposite entity type ('wallet' or 'contract') —
// 'unknown' matches neither branch of the ternary, so it falls through to null (no short-circuit).
assert.match(routeCode, /\(questionCategory === 'token' && resolvedEntityType === 'wallet'\) \? 'token_question_wallet_address' :\s*\n\s*\(questionCategory === 'wallet' && resolvedEntityType === 'contract'\) \? 'wallet_question_token_address' :\s*\n\s*null;/, 'a mismatch must only be declared for a confirmed opposite entity type, defaulting to null (no short-circuit) otherwise — this covers the unknown case implicitly')

const SOL_MINT = 'So11111111111111111111111111111111111111112'
const EVM_ADDR = '0x1234567890123456789012345678901234567890'

{
  const r = classifyClarkPrompt(SOL_MINT)
  assert.equal(r.intent, 'token_scan', 'a bare Solana mint must route as token_scan, never wallet_scan')
}
{
  const r = classifyClarkPrompt(`scan this wallet ${EVM_ADDR} on base`)
  assert.equal(r.intent, 'wallet_scan', 'explicit wallet language must win over chain keywords like on base')
}
{
  const r = classifyClarkPrompt(`scan this token ${SOL_MINT}`)
  assert.equal(r.intent, 'token_scan', 'scan this token <mint> must stay token_scan')
}

console.log('test-clark-entity-routing.mjs: all assertions passed')
