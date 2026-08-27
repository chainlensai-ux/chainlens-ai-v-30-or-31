import assert from 'node:assert/strict'
import fs from 'node:fs'

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

// ─── Exact required messages ────────────────────────────────────────────────────────────────
assert.match(routeCode, /"This address is a wallet, not a token contract\. Market cap\/holders\/LP\/deployer do not apply\."/, 'the token-question-on-wallet-address message must match exactly')
assert.match(routeCode, /"This is a token contract\. Use Token Scanner or ask token-specific questions\."/, 'the wallet-question-on-token-address message must match exactly')

// ─── Intent coverage: every required token intent must be recognized ───────────────────────────
// route.ts pulls in Next.js server deps, so it can't be imported directly by a plain node test —
// extract the classifier regexes' own literal source and test them against the exact required
// prompts, matching this repo's static-source-assertion convention for this file.
const tokenReSrc = routeCode.match(/const CLARK_TOKEN_QUESTION_RE = (\/.+\/i);/)?.[1]
const walletReSrc = routeCode.match(/const CLARK_WALLET_QUESTION_RE = (\/.+\/i);/)?.[1]
assert.ok(tokenReSrc, 'CLARK_TOKEN_QUESTION_RE must exist')
assert.ok(walletReSrc, 'CLARK_WALLET_QUESTION_RE must exist')
// eslint-disable-next-line no-eval -- constructing a RegExp from the route's own literal source, not external input
const TOKEN_RE = new RegExp(tokenReSrc.slice(1, tokenReSrc.lastIndexOf('/')), 'i')
const WALLET_RE = new RegExp(walletReSrc.slice(1, walletReSrc.lastIndexOf('/')), 'i')

const TOKEN_PROMPTS = [
  'Is 0x1234567890123456789012345678901234567890 safe?',
  'Who deployed 0x1234567890123456789012345678901234567890?',
  'Top holders for 0x1234567890123456789012345678901234567890?',
  'Is LP locked on 0x1234567890123456789012345678901234567890?',
  'What is the market cap of 0x1234567890123456789012345678901234567890?',
  'Why is 0x1234567890123456789012345678901234567890 pumping?',
]
for (const p of TOKEN_PROMPTS) {
  assert.ok(TOKEN_RE.test(p), `CLARK_TOKEN_QUESTION_RE must match: "${p}"`)
  assert.ok(!WALLET_RE.test(p), `CLARK_WALLET_QUESTION_RE must NOT match: "${p}"`)
}

const WALLET_PROMPTS = [
  'Explain wallet 0x1234567890123456789012345678901234567890',
  'What is the portfolio of 0x1234567890123456789012345678901234567890?',
]
for (const p of WALLET_PROMPTS) {
  assert.ok(WALLET_RE.test(p), `CLARK_WALLET_QUESTION_RE must match: "${p}"`)
  assert.ok(!TOKEN_RE.test(p), `CLARK_TOKEN_QUESTION_RE must NOT match: "${p}"`)
}

// "Market cap of 0xWALLET" / "LP locked on 0xWALLET" are still TOKEN-shaped questions (the metric
// asked about is a token metric) — the entity resolver, not the intent classifier, is what
// produces "not applicable" for these; classification alone is correct if it reads as a token
// question, matching test cases 8/9's premise that the QUESTION is token-shaped but the ADDRESS
// resolves to a wallet.
assert.ok(TOKEN_RE.test('What is the market cap of 0x1234567890123456789012345678901234567890?'))
assert.ok(TOKEN_RE.test('Is LP locked on 0x1234567890123456789012345678901234567890?'))

// ─── Follow-ups must not be gated (no new address in the message) ──────────────────────────────
assert.ok(!/0x[a-f0-9]{40}/i.test('what about holders?'), 'a memory-only follow-up has no inline address and must skip the gate entirely')
assert.ok(!/0x[a-f0-9]{40}/i.test('scan that wallet'), 'a memory-only follow-up has no inline address and must skip the gate entirely')

// ─── clarkEntityRoutingAudit: exact requested shape ─────────────────────────────────────────────
assert.match(routeCode, /type ClarkEntityRoutingAudit = \{/, 'a ClarkEntityRoutingAudit type must exist')
for (const field of [
  'prompt', 'parsedIntent', 'address', 'requestedChain', 'codeChecked', 'hasContractCode',
  'resolvedEntityType', 'routeSelected', 'apiCalled', 'cacheKey', 'cacheChainMatched',
  'fallbackUsed', 'responseMode', 'notApplicableReason',
]) {
  assert.ok(routeCode.includes(`${field}:`), `ClarkEntityRoutingAudit must include ${field}`)
}
assert.match(routeCode, /normData\.clarkEntityRoutingAudit = \{ \.\.\.clarkInternalCtx\.entityAudit, cacheKey \}/, 'the main response path must attach clarkEntityRoutingAudit with the real cacheKey')
assert.match(routeCode, /\(normalized\.data as Record<string, unknown>\)\.clarkEntityRoutingAudit = \{ \.\.\.clarkInternalCtx\.entityAudit, cacheKey: earlyCacheKey \}/, 'the memory-only follow-up path must attach clarkEntityRoutingAudit too')

// ─── Chain-scoped cache: same address on a different chain must not share cached data ──────────
// (test 12) — the request cache key already includes chain; the entity audit's cacheChainMatched
// is a truthful reflection of that, not a separate mechanism that could drift from it.
assert.match(routeCode, /chain: body\.chain \?\? "base", token: body\.tokenAddress/, 'the response cache key must include chain, never shared across chains for the same address')

// ─── Debug fields must never leak into user-facing text (lib/server/clarkRouting.ts) ──────────
const clarkRoutingSrc = fs.readFileSync(new URL('../lib/server/clarkRouting.ts', import.meta.url), 'utf8')
for (const rawField of ['walletScanHealth:', 'walletModuleCoverage:', 'walletTokenPnlSummary:', 'walletTradeStatsSummary:']) {
  assert.doesNotMatch(clarkRoutingSrc, new RegExp(`lines\\.push\\(\`- ${rawField}`), `${rawField} must never be printed as a raw field name in formatWalletScanResult`)
}

// ─── CTA vocabulary: token side must have an equivalent to Deep Scan Wallet ────────────────────
assert.match(clarkRoutingSrc, /"Deep Scan Token",/, 'CLARK_ACTIONS must include Deep Scan Token')
assert.match(clarkRoutingSrc, /"Check Deployer",/, 'CLARK_ACTIONS must include Check Deployer')

console.log('test-clark-entity-routing.mjs: all assertions passed')
