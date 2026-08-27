import assert from 'node:assert/strict'
import fs from 'node:fs'

// SOLANA-DEPLOYER-HELIUS-ENHANCED FIX, DISCLOSED.
//
// Requested live: "for solana for deployer ca make sure it uses helius enhanced." The Solana
// creator/authority read always called /api/token WITHOUT deepDev — the one flag that reaches
// Helius's Enhanced Transactions API (lib/server/solana/deepCreatorAnalyzer.ts's own disclosure:
// "explicit opt-in only... paid API"). Without it, /api/token only checks recent signature
// presence, never resolving a real creator — exactly why every Solana deployer question ended in
// "Not resolved. Run the Deep Creator Check in Token Scanner."
//
// Fix is scoped, not blanket: deepDev now goes true only when the question is actually about the
// deployer/creator, so a plain "is it safe" still costs nothing extra — the explicit-opt-in-for-
// cost-control contract stays intact, just correctly triggered for the one question class where the
// fast, non-enhanced check can never answer at all.
//
// Also verified (not modified): the EVM deployer pipeline (Base/ETH/BNB/Robinhood) already forwards
// the real auto-detected chain at every call site (resolveTokenDeployer, both /api/dev-wallet call
// sites) and skips honestly rather than defaulting to Base for an unsupported chain — this was
// already fixed in an earlier round ("Clark deployer audit" disclosures), confirmed still intact.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

assert.match(routeCode, /const SOLANA_DEPLOYER_QUESTION_RE = \/\\b\(dev\\s\+wallet\|deployer\|who\\s\+deployed\|who\\s\+made\\s\+this\|who\\s\+built\|who\\s\+created\|check\\s\+creator\|origin\\s\+wallet\|is\\s\+the\\s\+dev\|check\\s\+dev\|deployer\\s\+of\|creator\\s\+of\|rugged\\s\+before\|dev\\s\+history\|deployer\\s\+history\)\\b\/i;/, 'a dedicated Solana deployer-question regex must exist')
assert.match(routeCode, /async function buildSolanaCreatorAnswer\(tokenAddress: string, wantsDeployer = false\): Promise<Record<string, unknown>> \{/, 'buildSolanaCreatorAnswer must accept whether this is a deployer-specific question')
assert.match(routeCode, /body: JSON\.stringify\(\{ contract: tokenAddress, chain: "solana", \.\.\.\(wantsDeployer \? \{ deepDev: true \} : \{\}\) \}\),/, 'the /api/token request must set deepDev: true — the only flag that reaches Helius Enhanced Transactions — when the question is deployer-specific')

// Both call sites must actually determine and forward wantsDeployer, not just accept the param and
// ignore it.
assert.match(routeCode, /return await buildSolanaCreatorAnswer\(routed\.address, isSolanaDeployerQuestion\);/, 'the early dominant-cascade guard must forward whether this is a deployer question')
assert.match(routeCode, /return await buildSolanaCreatorAnswer\(tokenAddress, SOLANA_DEPLOYER_QUESTION_RE\.test\(prompt\)\);/, 'the token_scan branch guard must also forward whether this is a deployer question')

// A plain "who deployed X" has no dedicated intent bucket in classifyClarkPrompt at all — the guard
// must catch it independently of routed.intent, not just when it happens to land in
// SOLANA_TOKEN_INTENTS.
assert.match(routeCode, /const isSolanaDeployerQuestion = routed\.address != null && SOLANA_DEPLOYER_QUESTION_RE\.test\(prompt\);/, 'the guard must independently detect a deployer question')
assert.match(routeCode, /if \(routed\.address && \(SOLANA_TOKEN_INTENTS\.has\(routed\.intent\) \|\| isSolanaDeployerQuestion\) && isValidSolanaMintAddress\(routed\.address\)\) \{/, 'a bare deployer question must reach the Solana answer even when routed.intent is "none"')

// EVM deployer chain-awareness, verified intact (not modified this round).
assert.match(routeCode, /resolverChain = toTokenApiChain\(input\.chain\);/, 'the fast EVM deployer resolver must still resolve the real chain, not default to Base')
assert.match(routeCode, /const thisDevChain = toTokenApiChain\(chainForClarkTools\);/, 'the "who deployed this" contextual dev-wallet lookup must still use the real auto-detected chain')
assert.match(routeCode, /const devWalletChain = toTokenApiChain\(chainForClarkTools\);\s*\n\s*if \(!devWalletChain\) \{/, 'the dev-history dev-wallet lookup must still skip honestly rather than defaulting to Base for an unsupported chain')

console.log('test-clark-solana-deployer-helius-enhanced.mjs: all assertions passed')
