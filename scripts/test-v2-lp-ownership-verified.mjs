import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Static source checks on route.ts (no live API call) — the V2 ownership-verified logic is
// inline in the request handler, so we assert on the derivation rules rather than mocking
// the entire handler.
const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')

// 1. lpOwnershipVerified must no longer be derived from "an owner address exists + a pool
//    was detected" — that proved nothing about lock/burn/controller dominance (the BSWAP bug).
assert.ok(!route.includes('Boolean(ownerAddrEarlyForLp && _lpProofPresent)'), 'lpOwnershipVerified no longer derives from owner-address-plus-pool-detected alone')

// 2. lpOwnershipVerified must require real lock/burn/proof-status evidence — never derived
//    from lpSafetyUsable/lpControl.status/team_controlled/controller-dominance alone, since
//    controller detection and ownership-proof verification are separate concepts.
assert.ok(route.includes("const lpOwnershipVerified = lpControl.lockStatus === 'locked'"), 'lpOwnershipVerified is gated on a confirmed lockStatus, not on lpSafetyUsable/team_controlled')
assert.ok(!/lpOwnershipVerified = lpSafetyUsable/.test(route), 'lpOwnershipVerified never derives from lpSafetyUsable (which includes team_controlled)')
assert.ok(route.includes("lpControl.burnStatus === 'burned'"), 'lpOwnershipVerified also accepts a confirmed burnStatus')
assert.ok(route.includes("lpControl.proofStatus === 'verified'"), 'lpOwnershipVerified also accepts a verified proofStatus')

// 3. Partial LP-holder evidence (e.g. owner_lp_share/controllerSharePercent) is tracked
//    separately and must never alone satisfy "verified".
assert.ok(route.includes('lpOwnershipHolderEvidenceFound'), 'partial LP-holder evidence is tracked as its own signal, distinct from verified')
assert.ok(route.includes('owner_lp_share|locker_share|burn_share|top_holder'), 'holder-evidence detection looks at the same evidence markers used elsewhere (no fabricated evidence)')

// 4. The two public ownership fields must use the three-tier verified/partial/open_check
//    ladder instead of collapsing straight to "inferred" for any unverified V2/ERC-20 pool.
assert.ok(route.includes("(lpOwnershipVerified ? 'verified' : (lpOwnershipHolderEvidenceFound ? 'partial' : 'open_check'))"), 'erc20LpOwnershipStatus/lpOwnershipStatus use the verified/partial/open_check ladder')

// 5. Concentrated-pool ownership split (added previously) must remain untouched — still
//    not_applicable for ERC-20 ownership, with position ownership reported separately.
assert.ok(route.includes("erc20LpOwnershipStatus: (lpState === 'protocol' || lpState === 'concentrated_liquidity')\n            ? 'not_applicable'"), 'concentrated/protocol pools still report erc20LpOwnershipStatus = not_applicable')
assert.ok(route.includes("'position_proof_partial'"), 'concentrated lpOwnershipStatus can still report position_proof_partial')
assert.ok(route.includes("'position_open_check'"), 'concentrated lpOwnershipStatus can still report position_open_check')
assert.ok(route.includes("'position_verified'"), 'concentrated lpOwnershipStatus can still report position_verified')

// 6. Standard ERC-20 LP proof status now mirrors the same verified/partial/open_check ladder
//    (derived from lpOwnershipVerified/lpOwnershipHolderEvidenceFound), not lpSafetyUsable —
//    so a wallet-controlled pool with no lock/burn proof is "open_check", not "verified".
assert.ok(route.includes(": (lpOwnershipVerified ? 'verified' : (lpOwnershipHolderEvidenceFound ? 'partial' : 'open_check'))"), 'standardLpProofStatus uses the verified/partial/open_check ladder, not lpSafetyUsable')

console.log('test-v2-lp-ownership-verified.mjs: all assertions passed')
