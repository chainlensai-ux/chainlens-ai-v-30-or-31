import assert from 'node:assert/strict'
import fs from 'node:fs'

// LP-META-FIELD-MISMATCH FIX, DISCLOSED.
//
// Reported live: "the lp has bad information it needs to use the apis its got alchemy and goldrush
// for that bro." An LP READ showed a real liquidity number ($72K+) but "Primary pool / pool id: not
// available" and other fields "unverified"/"unknown" regardless of the token. Traced to a field-name
// mismatch, not a missing-provider gap: /api/liquidity-safety's buildSharedLpMeta (lib/server/
// lpIntelligence.ts) returns FLAT fields — primaryPoolAddress, primaryPoolDex, primaryPoolType — but
// this mapping read lpMeta.primaryPool as if it were a nested object with its own .address/.poolType,
// a shape that has never existed on that response. That always evaluated to null/undefined regardless
// of whether GeckoTerminal/Alchemy/GoldRush genuinely found real pool data — a pure display bug on
// the way the already-correct API response was read back out.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

assert.doesNotMatch(routeCode, /const primaryPool = lpMeta\?\.primaryPool && typeof lpMeta\.primaryPool === "object"/, 'the old nonexistent-nested-object read of lpMeta.primaryPool must be gone')
assert.match(routeCode, /primaryPool: typeof lpMeta\?\.primaryPoolAddress === "string" \? lpMeta\.primaryPoolAddress : null,/, 'primaryPool must read the real flat primaryPoolAddress field buildSharedLpMeta actually returns')
assert.match(routeCode, /poolType: typeof lpMeta\?\.primaryPoolType === "string" \? lpMeta\.primaryPoolType : null,/, 'poolType must read the real flat primaryPoolType field')

// The memory-storage chain must also use the real auto-detected chain, not a hardcoded "base" —
// same bug class as the other Base-collapse fixes found this session.
assert.doesNotMatch(routeCode, /cachedEvidence: \{ ok: true, token: \{ \.\.\.mapped\.token, address: routed\.address \}, chain: "base",/, 'the LP-check memory storage must not hardcode chain: "base"')
assert.match(routeCode, /const lpMemoryChain = \(chainForClarkTools === "ethereum" \? "eth" : chainForClarkTools\) as "base" \| "eth" \| "robinhood";/, 'the LP-check memory storage must derive its chain from the real auto-detected chainForClarkTools')

console.log('test-clark-lp-meta-field-mismatch.mjs: all assertions passed')
