import assert from 'node:assert/strict'
import fs from 'node:fs'

// SOLANA-MEMORY-BLIND FIX, DISCLOSED.
//
// Requested live: "now audict the whole clark sysetm and fix bugs and improve memory." Auditing the
// memory subsystem found buildSolanaCreatorAnswer() — the shared Solana creator/authority read used
// by both the dominant-cascade guard and the token_scan branch — resolved real evidence (market data,
// mint/freeze authority, Helius creator trace) but never wrote any of it back to session memory.
// updateMemToken()/rememberClarkDeployer() were only ever called from the EVM branches. A follow-up
// like "is that safe" or "has this dev rugged before?" right after a Solana scan had nothing to
// resolve against — either misfiring on stale EVM memory or asking the user to repaste an address
// they'd just given.
//
// Fix: mirror the EVM answer paths inside buildSolanaCreatorAnswer itself — remember the token when
// any usable data came back, and remember the creator/fee-payer as a deployer candidate only when one
// was actually resolved (never remember a null as if it were evidence).
//
// Also disclosed: two other memory-audit findings from the same pass, already fixed and covered
// elsewhere in this suite's assertions below —
//   1. setMemChain() was a dead-code duplicate of the chain-collapse bug (mapped every chain other
//      than "ethereum" to "base"), already superseded by the very next line — removed entirely rather
//      than left as a wasted no-op call.
//   2. rememberClarkDeployer() rejected any non-EVM-shaped address outright, so a real Solana creator
//      address could never be remembered even before this fix existed to produce one.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// buildSolanaCreatorAnswer must write the token to memory when it got usable data.
assert.match(
  routeCode,
  /if \(hasUsableData\) \{\s*\n\s*updateMemToken\(sessionMem!, tokenAddress, marketData\?\.tokenSymbol \?\? null, marketData\?\.tokenName \?\? null, lines\.join\("\\n"\), \{ chain: "solana" \}\);\s*\n\s*\}/,
  'buildSolanaCreatorAnswer must call updateMemToken with chain: "solana" when usable evidence exists'
)

// MERGED-RESULT-WRONG-NESTING FIX, DISCLOSED: separately reproduced live — "is this token safe" on a
// real, live token always answered "no usable data" / "revoked or unresolved" for every field, because
// the code read solJson.mergedResult, a key that only ever exists nested inside
// solJson.solanaProviderWiringAudit.mergedResult, never at the top level (see providerMerge.ts's
// return statement). The real fields (mintAuthority, freezeAuthority, marketData,
// authorityReadSucceeded, marketDataAvailable) live directly on the top-level response.
assert.doesNotMatch(routeCode, /"mergedResult" in \(solJson/, 'must not read the non-existent top-level mergedResult key')
assert.match(
  routeCode,
  /const mintAuthority = typeof solData\?\.mintAuthority === "string" \? solData\.mintAuthority : null;/,
  'mintAuthority must be read directly from the top-level response field'
)
assert.match(
  routeCode,
  /const freezeAuthority = typeof solData\?\.freezeAuthority === "string" \? solData\.freezeAuthority : null;/,
  'freezeAuthority must be read directly from the top-level response field'
)
assert.match(
  routeCode,
  /const hasUsableData = Boolean\(solData\?\.authorityReadSucceeded \|\| solData\?\.marketDataAvailable\);/,
  'hasUsableData must be derived from the real top-level authorityReadSucceeded/marketDataAvailable flags, not a nonexistent nested mergedResult'
)
// CLARK-TOKEN-VERDICT FIX, DISCLOSED: marketData's inline type widened to also carry
// marketCap/fdv/liquidity/volume/pool fields for the new TOKEN READ verdict — token name/symbol are
// still read from the same real top-level field, just as part of a larger, honestly-typed object.
assert.match(
  routeCode,
  /const marketData = solData\?\.marketData as \{ tokenName\?: string \| null; tokenSymbol\?: string \| null;[\s\S]{0,300}\} \| null \| undefined;/,
  'token name/symbol for memory must be read from the top-level marketData field'
)

// It must remember the creator/fee-payer as a deployer candidate, only when actually resolved.
assert.match(
  routeCode,
  /if \(likelyCreator\) \{\s*\n\s*rememberClarkDeployer\(sessionMem!, likelyCreator, \{\s*\n\s*chain: "solana",\s*\n\s*sourceTokenAddress: tokenAddress,/,
  'buildSolanaCreatorAnswer must call rememberClarkDeployer with the resolved creator, gated on likelyCreator actually being non-null'
)

// Never call rememberClarkDeployer with a null/undefined address as if it were evidence.
assert.doesNotMatch(
  routeCode,
  /rememberClarkDeployer\(sessionMem!, null/,
  'must never remember a null creator as if it were resolved evidence'
)

// setMemChain must be fully removed (dead code, same collapse bug already fixed elsewhere for the
// live paths that mattered) rather than left as a no-op call.
assert.doesNotMatch(routeCode, /function setMemChain\(/, 'setMemChain must be removed, not left as dead code')
assert.doesNotMatch(routeCode, /setMemChain\(sessionMem/, 'no call site may still reference the removed setMemChain')

// rememberClarkDeployer must accept a real Solana mint address, not just EVM 0x addresses.
assert.match(
  routeCode,
  /const isSolana = !isEvm && isValidSolanaMintAddress\(trimmed\);\s*\n\s*if \(!isEvm && !isSolana\) return false;/,
  'rememberClarkDeployer must accept Solana addresses (validated structurally) alongside EVM addresses'
)
// Solana base58 is case-sensitive — only EVM addresses may be lowercased.
assert.match(
  routeCode,
  /const addr = isEvm \? trimmed\.toLowerCase\(\) : trimmed;/,
  'rememberClarkDeployer must never lowercase a Solana address (base58 is case-sensitive, unlike EVM hex)'
)

// The second, independent Solana creator/authority read (the dev_wallet intent's own Solana guard,
// a separate reimplementation rather than a call to buildSolanaCreatorAnswer — kept separate because
// an existing test pins its distinct clarkDeployerLookupAudit shape) had the identical mergedResult
// bug and must be fixed the same way, plus gain the same missing memory write-back.
const mergedResultOccurrences = (routeCode.match(/"mergedResult" in \(solJson/g) ?? []).length
assert.equal(mergedResultOccurrences, 0, 'no call site may read the non-existent top-level mergedResult key')
assert.equal((routeCode.match(/const hasUsableData = Boolean\(solData\?\.authorityReadSucceeded \|\| solData\?\.marketDataAvailable\);/g) ?? []).length, 2, 'both Solana creator/authority read call sites must derive hasUsableData from the real top-level fields')
assert.match(
  routeCode,
  /if \(likelyCreator\) \{\s*\n\s*rememberClarkDeployer\(sessionMem!, likelyCreator, \{\s*\n\s*chain: "solana",\s*\n\s*sourceTokenAddress: resolvedAddress,/,
  'the dev_wallet intent\'s Solana guard must also remember the resolved creator for follow-ups'
)

console.log('test-clark-solana-memory-writeback.mjs: all assertions passed')
