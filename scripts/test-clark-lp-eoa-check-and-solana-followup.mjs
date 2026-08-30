import assert from 'node:assert/strict'
import fs from 'node:fs'

// EOA-CHECK-CHAIN-BLIND FIX + SOLANA-FOLLOWUP-HIJACK FIX, DISCLOSED.
//
// User asked to generalize the Robinhood-title fix to every chain, then live-tested it: several
// real tokens on non-Base chains — already correctly auto-detected as contracts by the entity gate
// moments earlier — all failed "is liquidity safe on 0x..." with "That address looks like a wallet,
// not a token contract." Traced to isContractAddress(), a second, independent eth_getCode
// reimplementation hardcoded to Base only (no chain param, no retry, and treating ANY fetch failure
// as "not a contract"). A token genuinely deployed off-Base has no code on Base, so this redundant,
// chain-blind check reported it as a wallet regardless of what chain it actually auto-detected on.
//
// Separately, a real Solana mint address typed with "is it safe" fell through to a wrong/garbled
// EVM-style response ("TOKEN SAFETY — ? (Base)") instead of the real Solana creator/authority read.
// Traced to the "Task 1: hard token follow-up memory guard" — extractAddress(prompt) only
// recognizes 0x-EVM addresses, so it returned null even though a real Solana address WAS just
// typed, and the guard treated the message as a bare follow-up ("is it safe" with no new address),
// answering from whatever EVM token happened to be in memory instead of the Solana address just
// pasted.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// ─── isContractAddress must be gone entirely, not just its call site patched ───────────────────
assert.doesNotMatch(routeCode, /async function isContractAddress\(/, 'the chain-blind isContractAddress reimplementation must be removed entirely, not left as dead code')
assert.doesNotMatch(routeCode, /isContractAddress\(routed\.address, origin\)/, 'the old chain-blind call site must be gone')

// ─── The liquidity_scan wallet-guard must reuse the chain-aware, retry-hardened classifier ─────
assert.match(routeCode, /const addressKind = await classifyAddressForClark\(routed\.address, chainForClarkTools\);/, 'the liquidity_scan EOA guard must reuse classifyAddressForClark with the real auto-detected chain, not a chain-blind duplicate')
assert.match(routeCode, /if \(addressKind === "wallet"\) \{/, 'the guard must only block on a confirmed wallet verdict, not silently on any check failure')

// ─── The token-followup memory guard must not hijack a freshly-typed Solana address ────────────
// ADDRESS-BLIND-GATE FIX, DISCLOSED (superseding round): the original fix above only patched this
// one guard directly; a follow-up report ("clark needs to be more aware whats a wallet and a
// token") found over a dozen MORE early gates in this file with the identical bug — all testing
// `!extractAddress(prompt)` (EVM-only) as their "no address in this message" check. Consolidated
// into a single hasAnyAddress() helper (EVM OR Solana) and every one of those gates now uses it.
assert.match(routeCode, /if \(!isForcedLiquidityCheckPrompt\(prompt\) && !isLiquidityCheckIntent\(prompt\) && classifyTokenFollowupKind\(prompt\) !== "lp_lock" && classifyTokenFollowupKind\(prompt\) !== "deployer" && isTokenFollowupPrompt\(prompt\) && \(sessionMem\.lastClarkSubject\?\.address \|\| sessionMem\.lastToken\?\.address\) && !hasAnyAddress\(prompt\) && !deepScanItOnWallet\) \{/, 'the token-followup memory guard must use hasAnyAddress, skip LP-locked and deployer prompts, and skip wallet deep-scan-it follow-ups')
assert.match(routeCode, /function hasAnyAddress\(text: string\): boolean \{\s*\n\s*return extractAddress\(text\) != null \|\| isValidSolanaMintAddress\(extractAddressForRouting\(text\) \?\? ""\);\s*\n\}/, 'a shared hasAnyAddress helper must exist and check both EVM and Solana address shapes')
// CLARK-TOKEN-VERDICT FIX, DISCLOSED: more exports were added after extractAddressForRouting in
// this import block, so it is no longer the last import — checking membership in the block instead
// of exact adjacency to the closing brace.
assert.match(routeCode, /^\s*extractAddressForRouting,\s*$/m, 'extractAddressForRouting must be imported so the guard above can actually use it')
assert.match(routeCode, /^\s*renderClarkTokenVerdictForEvm,\s*$/m, 'the new verdict engine must be imported from clarkRouting')

console.log('test-clark-lp-eoa-check-and-solana-followup.mjs: all assertions passed')
