import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Regression test: Robinhood Chain scans commonly showed Holders as "CONCENTRATION UNVERIFIED" /
// "Holder distribution was not returned this scan", while Base/ETH/BNB scans worked fine. Root
// cause: fetchTokenHoldersUncached (app/api/token/route.ts) sent exactly ONE GoldRush/Covalent
// chain identifier per chain with no fallback — 'robinhood-mainnet' was only ever a guessed slug
// following GoldRush's naming convention, never independently confirmed. This is the SAME
// ambiguity lib/server/goldrushHolderCount.ts already hit and fixed for the Base Radar drawer
// (trying 'robinhood-mainnet' then the verified real numeric chain ID 4663) — this test confirms
// the same fallback is now applied to Token Scanner's own holder resolver.
//
// Static source-text checks, matching this codebase's own established pattern for regression-
// testing logic embedded in app/api/token/route.ts's very large, non-exported functions (see
// scripts/test-holder-count-not-fake-zero.mjs for the same approach).

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

const fullRoute = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
// Scope strictly to fetchTokenHoldersUncached and its new CHAIN_SLUG_CANDIDATES map — a SEPARATE,
// unrelated function (fetchGoldRushContractIntel, contract security flags) has its own inline
// CHAIN_SLUG_MAP with the exact same single-slug-per-chain bug, deliberately left untouched here
// since the reported symptom was specifically Holders, not contract security flags.
const holdersFnStart = fullRoute.indexOf('async function fetchTokenHoldersUncached')
const holdersFnEnd = fullRoute.indexOf('\ntype LpControlResult', holdersFnStart)
const route = fullRoute.slice(fullRoute.indexOf('const CHAIN_SLUG_CANDIDATES'), holdersFnEnd)

// 1. The old single-slug map (inside fetchTokenHoldersUncached specifically) is gone; a
//    multi-candidate map exists in its place.
check('located fetchTokenHoldersUncached to scope the rest of these checks', holdersFnStart > -1 && holdersFnEnd > holdersFnStart)
check('CHAIN_SLUG_MAP (single slug per chain) no longer exists inside fetchTokenHoldersUncached', !route.includes('const CHAIN_SLUG_MAP: Record<ChainKey, string> ='))
check('CHAIN_SLUG_CANDIDATES (multi-candidate) exists', route.includes('const CHAIN_SLUG_CANDIDATES: Record<ChainKey, string[]> ='))

// 2. Robinhood gets both the original slug AND the verified numeric chain ID as a fallback.
check('robinhood tries robinhood-mainnet first', /robinhood:\s*\['robinhood-mainnet',\s*'4663'\]/.test(route))

// 3. Every other chain keeps its single, already-confirmed slug — this fix must not change
//    behavior for Base/ETH/BNB/Polygon, which were never the reported problem.
check('eth keeps its single confirmed slug', /eth:\s*\['eth-mainnet'\]/.test(route))
check('base keeps its single confirmed slug', /base:\s*\['base-mainnet'\]/.test(route))
check('bnb keeps its single confirmed slug', /bnb:\s*\['bsc-mainnet'\]/.test(route))
check('polygon keeps its single confirmed slug', /polygon:\s*\['matic-mainnet'\]/.test(route))

// 4. The retry loop advances to the next chain-identifier candidate on a 404 OR an empty-but-
//    successful response (itemCount === 0) — a wrong-but-recognized identifier can return 200
//    with zero items rather than a clean 404, matching the exact failure mode
//    lib/server/goldrushHolderCount.ts already had to handle for the same provider/chain.
check('empty-but-ok responses (itemCount === 0) are tracked to advance to the next candidate', route.includes('sawEmptyButOk = true'))
check('the retry loop checks itemCount === 0 specifically', route.includes('if (itemCount === 0) {'))

// 5. A genuine infra failure (not 404, not empty-data) still stops immediately — a different
//    chain identifier would not fix a real network/rate-limit/5xx problem, matching the proven
//    goldrushHolderCount.ts pattern exactly.
check('the loop breaks on genuine failures rather than trying every candidate blindly', route.includes('if (!sawEmptyButOk && lastFailure.__statusCode !== 404) break'))

// 6. The function still returns a usable result shape when every candidate fails — never throws,
//    never returns undefined — preserving the existing __status/__reason/__chainUsed contract
//    every downstream debug/audit consumer already reads.
check('a final fallback result is always returned, never undefined', route.includes('return lastFailure\n}'))
check('__chainUsed is still set on every branch (missing key, empty, success, and final failure)', (route.match(/__chainUsed:\s*chainSlug/g) ?? []).length >= 3)

// 7. Multi-host fallback (already-proven-reliable, unrelated to this fix) is preserved unchanged
//    inside each chain-candidate attempt — this fix adds a new outer loop, it doesn't remove the
//    existing per-host retry.
check('the existing multi-host fallback loop is preserved inside each chain-candidate attempt', route.includes('for (const host of hosts) {'))
check('GOLDRUSH_BASE_URL override still bypasses multi-host fallback exactly as before', route.includes("process.env.GOLDRUSH_BASE_URL\n    ? [process.env.GOLDRUSH_BASE_URL.replace"))

console.log(`test-robinhood-holder-chain-fallback.mjs: all ${passed} assertions passed`)
