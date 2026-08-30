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
//
// Mapping now lives in lib/server/clarkLiquidityCheck.ts (runClarkLiquidityCheck adapter). The
// route still must not reintroduce the nested-object read or hardcode chain: "base".

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const adapterSrc = fs.readFileSync(new URL('../lib/server/clarkLiquidityCheck.ts', import.meta.url), 'utf8')

assert.doesNotMatch(routeCode, /const primaryPool = lpMeta\?\.primaryPool && typeof lpMeta\.primaryPool === "object"/, 'the old nonexistent-nested-object read of lpMeta.primaryPool must be gone')
assert.doesNotMatch(adapterSrc, /const primaryPool = lpMeta\?\.primaryPool && typeof lpMeta\.primaryPool === "object"/, 'the adapter must not revive the nested-object lpMeta.primaryPool read')
assert.match(adapterSrc, /primaryPoolAddress/, 'primaryPool must read the real flat primaryPoolAddress field buildSharedLpMeta actually returns')
assert.match(adapterSrc, /primaryPoolType/, 'poolType must read the real flat primaryPoolType field')

// The memory-storage chain must also use the real auto-detected chain, not a hardcoded "base" —
// same bug class as the other Base-collapse fixes found this session.
assert.doesNotMatch(routeCode, /cachedEvidence: \{ ok: true, token: \{ \.\.\.mapped\.token, address: routed\.address \}, chain: "base",/, 'the LP-check memory storage must not hardcode chain: "base"')
assert.match(routeCode, /const lpMemoryChain = runChain === "ethereum" \? "eth" : runChain;/, 'the LP-check memory storage must derive its chain from the real resolved runChain')
assert.doesNotMatch(routeCode, /runChain === "solana" \? "base"/, 'Solana liquidity checks must not be stored as Base in session memory')

console.log('test-clark-lp-meta-field-mismatch.mjs: all assertions passed')
