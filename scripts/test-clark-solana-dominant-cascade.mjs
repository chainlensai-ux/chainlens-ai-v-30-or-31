import assert from 'node:assert/strict'
import fs from 'node:fs'

// SOLANA-DOMINANT-CASCADE FIX, DISCLOSED.
//
// Requested live: "i need sol working as well." A real Solana creator/authority read (mint/freeze
// authority + Deep Creator trace, genuine on-chain evidence, no fake "deployer" claims) already
// existed but was wired ONLY into routed.intent === "token_scan" — the narrow tool-plan-ish path.
// Most real phrasing ("X safe", "is X safe", "is liquidity safe on X", "can dev rug", etc.) routes
// through token_safety/liquidity_scan/dev_rug_check/lp_lock_check/risk_explanation/token_ape_risk/
// token_full_report/dev_rug_history instead — the exact same "dominant legacy cascade never got the
// fix" pattern already found and fixed for EVM chains earlier this session (see test-clark-legacy-
// cascade-chain.mjs). Those branches all assume an EVM 0x address; a Solana mint reaching them would
// either silently try to scan on Base (no real Solana data) or produce a confusing empty-scan
// message, never the real Solana read that already existed one branch over.
//
// Fix: extracted the existing Solana handler into a shared function (never duplicated) and added an
// early short-circuit, before any EVM-only token-address branch, that fires whenever the parsed
// address is a genuine Solana mint and the question is about the token (not a wallet question).

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// The Solana handler must be a single shared function, not duplicated per branch.
assert.match(routeCode, /async function buildSolanaCreatorAnswer\(tokenAddress: string\): Promise<Record<string, unknown>> \{/, 'a single shared Solana creator/authority answer builder must exist')
const buildFnOccurrences = (routeCode.match(/async function buildSolanaCreatorAnswer\(/g) ?? []).length
assert.equal(buildFnOccurrences, 1, 'buildSolanaCreatorAnswer must be defined exactly once — never duplicated per intent branch')

// It must be called from BOTH the early universal guard and the original token_scan branch (reused,
// not reimplemented).
const callSites = (routeCode.match(/buildSolanaCreatorAnswer\(/g) ?? []).length
assert.ok(callSites >= 3, `buildSolanaCreatorAnswer must be both defined and called from multiple sites (found ${callSites} occurrences including the definition)`)

// The early guard must cover every dominant natural-language token intent, not just token_scan.
assert.match(routeCode, /const SOLANA_TOKEN_INTENTS = new Set\(\["token_safety", "liquidity_scan", "dev_rug_check", "dev_rug_history", "lp_lock_check", "risk_explanation", "token_ape_risk", "token_full_report", "token_scan"\]\);/, 'the Solana short-circuit must cover every dominant token-question intent, not just the narrow token_scan tool-plan path')
assert.match(routeCode, /if \(routed\.address && SOLANA_TOKEN_INTENTS\.has\(routed\.intent\) && isValidSolanaMintAddress\(routed\.address\)\) \{\s*\n\s*return await buildSolanaCreatorAnswer\(routed\.address\);\s*\n\s*\}/, 'the early guard must actually short-circuit to the Solana answer before any EVM-only branch runs')

console.log('test-clark-solana-dominant-cascade.mjs: all assertions passed')
