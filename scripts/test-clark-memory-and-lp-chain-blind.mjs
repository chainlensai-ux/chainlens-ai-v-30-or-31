import assert from 'node:assert/strict'
import fs from 'node:fs'

// MEMORY-CHAIN-COLLAPSE + LP-CHECK-CHAIN-BLIND FIX, DISCLOSED.
//
// Follow-up to "Robinhood titles show Base" — user asked that the fix generalize to every chain.
// Auditing every remaining hardcoded/collapsing chain default in the dominant cascade turned up two
// more real instances of the same bug class:
//
//  1. updateMemToken's local evidenceChain (used to remember a scanned token for follow-ups) only
//     recognized "eth"/"Ethereum"/"base"/"Base" in the cached evidence's own chain — a real BNB or
//     Robinhood scan (correctly reporting its real chain after the fetchTokenEvidence fix) fell
//     through to mem.selectedChain (base by default) the moment it got stored. A later "is it safe"
//     follow-up, or the title on that stored token, would then show the wrong chain even after a
//     scan that got it right the first time.
//
//  2. The `routed.intent === "liquidity_scan"` branch always sent chain: "base" to
//     /api/liquidity-safety regardless of the real auto-detected chain — an ETH or Robinhood token's
//     LP check silently queried Base's liquidity instead of its own. /api/liquidity-safety supports
//     base/eth/robinhood (not yet bnb — a separate, deeper gap in that file, honestly flagged rather
//     than silently forced to base too).

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// ─── updateMemToken must recognize every real chain, not just eth/base ─────────────────────────
assert.match(routeCode, /opts\?\.cachedEvidence\?\.chain === "bnb" \|\| opts\?\.cachedEvidence\?\.chain === "BNB" \|\| opts\?\.cachedEvidence\?\.chain === "bsc" \? "bnb"/, 'updateMemToken must recognize a real BNB cached-evidence chain')
assert.match(routeCode, /opts\?\.cachedEvidence\?\.chain === "robinhood" \|\| opts\?\.cachedEvidence\?\.chain === "Robinhood Chain" \? "robinhood"/, 'updateMemToken must recognize a real Robinhood cached-evidence chain')

// ─── the liquidity_scan branch must use the real detected chain, never a hardcoded "base" ──────
assert.doesNotMatch(routeCode, /callInternalApi\(origin, "\/api\/liquidity-safety", \{ contract: routed\.address, chain: "base" \}/, 'the old hardcoded chain: "base" call to /api/liquidity-safety must be gone')
assert.match(routeCode, /const lpApiChain = toTokenApiChain\(chainForClarkTools\);/, 'the liquidity_scan branch must resolve the real auto-detected chain before calling /api/liquidity-safety')
assert.match(routeCode, /callInternalApi\(origin, "\/api\/liquidity-safety", \{ contract: routed\.address, chain: lpApiChain \}/, 'the actual LP-safety call must use the resolved real chain')
// bnb must be honestly flagged as unsupported by this specific endpoint, never silently forced to base.
assert.match(routeCode, /if \(lpApiChain === "bnb" \|\| lpApiChain == null\) \{/, 'a chain /api/liquidity-safety cannot handle (bnb, or anything unsupported) must get an honest message, never a silent Base substitution')

console.log('test-clark-memory-and-lp-chain-blind.mjs: all assertions passed')
