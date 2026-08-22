import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Regression test: "we have a liquidity safety problem for the chain robinhood".
//
// ROOT CAUSE: app/api/liquidity-safety/route.ts declared `type ChainKey = "base" | "eth"` and its
// normalizeChain() coerced every other value — "robinhood" included — to "base" SILENTLY. The
// symptom was not an error, it was WRONG-CHAIN DATA: pool discovery queried GeckoTerminal with
// network=base (finding nothing for a Robinhood token, or matching a DIFFERENT token that shares
// the address on Base), and resolveLpProof ran burn/lock reads against the BASE RPC instead of the
// Robinhood RPC — reporting another chain's liquidity state as this token's. The Liquidity Safety
// page compounded it by never sending a chain at all.
//
// Static source-text checks, matching this codebase's established pattern for regression-testing
// logic inside large route/page modules (see scripts/test-robinhood-holder-chain-fallback.mjs).

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

const route = readFileSync(new URL('../app/api/liquidity-safety/route.ts', import.meta.url), 'utf8')
const lpIntel = readFileSync(new URL('../lib/server/lpIntelligence.ts', import.meta.url), 'utf8')
const lpProof = readFileSync(new URL('../lib/server/lpProof.ts', import.meta.url), 'utf8')
const page = readFileSync(new URL('../app/terminal/liquidity/page.tsx', import.meta.url), 'utf8')

// ─── 1. Robinhood is a real ChainKey, not silently downgraded ───────────────────────────────────
check('ChainKey includes robinhood', /type ChainKey = "base" \| "eth" \| "robinhood"/.test(route))
check('normalizeChain has an explicit robinhood branch', /raw === "robinhood"/.test(route))
check('the old two-chain ChainKey is gone', !/type ChainKey = "base" \| "eth"\s*$/m.test(route))

// ─── 2. Robinhood is only honored when the deployment can actually READ that chain ──────────────
// Without the feature flag AND a configured RPC URL there is no way to run LP proof against it,
// so falling back to Base (the pre-existing behavior) is correct — offering a chain the backend
// cannot read would reproduce the exact wrong-data bug in a new form.
check('robinhood is gated on isRobinhoodChainAvailable()', /raw === "robinhood" && isRobinhoodChainAvailable\(\)/.test(route))
check('isRobinhoodChainAvailable is imported from the server-only chain config', /import \{ isRobinhoodChainAvailable \} from '@\/lib\/server\/robinhoodChainConfig'/.test(route))
check('the gate falls back to base rather than throwing or returning robinhood unchecked', /if \(raw === "robinhood" && isRobinhoodChainAvailable\(\)\) return "robinhood"[\s\S]{0,80}return "base"/.test(route))

// ─── 3. The resolved chain actually reaches pool discovery and LP proof ─────────────────────────
// These were already chain-generic; the bug was purely that they could never RECEIVE "robinhood".
check('pool discovery interpolates the chain into the GeckoTerminal network path', route.includes('${GT}/networks/${chain}/tokens/'))
check('LP proof is called with the resolved chain, not a hardcoded one', route.includes('resolveLpProof(chain, proofAddress)'))
check('lpProof.ts already resolves a Robinhood RPC URL for that chain', /if \(chain === "robinhood"\) \{\s*return getRobinhoodRpcUrl\(\)/.test(lpProof))
check('LpChain already admits robinhood, so no cast is needed at the call site', /export type LpChain = "eth" \| "base" \| "bnb" \| "robinhood"/.test(lpProof))

// ─── 4. Lock-proof coverage stays HONEST for Robinhood ──────────────────────────────────────────
// Ethereum is the only chain with a verified locker registry. Robinhood must not fall into the
// 'configured'/'full' branch, which would imply locker detection this codebase cannot perform.
check('buildSharedLpMeta accepts robinhood', /chain: 'eth' \| 'base' \| 'robinhood'/.test(lpIntel))
check('only Ethereum reports a configured locker registry', /lockerRegistryStatus: chain === 'eth' \? 'configured' : 'empty'/.test(lpIntel))
check('locker detection is claimed for Ethereum only, never for Robinhood', /lockerDetectionAvailable: chain === 'eth'/.test(lpIntel))
check('lock proof coverage is limited (not full) for Robinhood', /lockProofCoverage: display\.lockBurnApplicable \? \(chain === 'eth' \? 'full' : 'limited'\) : 'none'/.test(lpIntel))
check('the old base-only locker branches are gone', !/lockerDetectionAvailable: chain !== 'base'/.test(lpIntel))

// ─── 5. The page can actually reach the chain, and never offers one the backend would downgrade ──
check('the page sends a chain on contract scans', /\{ contract: q, chain \}/.test(page))
check('the page sends a chain on name-query scans', /\{ query: q, chain \}/.test(page))
check('the page no longer hardcodes a Base-only not-found message', !page.includes("'Token not found on Base.'"))
check('robinhood is only offered once chain-status confirms availability', /json\?\.robinhood\?\.available === true/.test(page))
check('the selector renders robinhood conditionally on that flag, never unconditionally', /robinhoodAvailable \? \['robinhood' as const\] : \[\]/.test(page))
check('a chain-status failure leaves robinhood hidden rather than shown unverified', /catch \{ \/\* best-effort: on failure Robinhood simply stays hidden/.test(page))

console.log(`test-robinhood-liquidity-safety-chain.mjs: all ${passed} assertions passed`)
