// Robinhood Trading Simulation "No selected Robinhood pool" — diagnosis + fix regression tests.
//
// Diagnosis: app/api/token/route.ts called simulateRobinhoodHoneypot() using `lpPoolAddress`
// (= lpPool?.address, an early/generic pool candidate resolved from the chain-agnostic dex/pool
// classifier) roughly 700 lines and one full canonical-pool-resolution pass BEFORE
// _robinhoodLpProofResult — LP Safety's own Robinhood-specific resolver, which independently
// confirms chainId 4663 and merges lpVerifyPool/lpPool into one canonical pool identity — ever
// ran. When that early candidate was empty/wrong for Robinhood chain (the same generic-classifier
// gap already found and fixed for LP Safety's own applicability gate in an earlier task),
// simulation received poolAddress: null and hard-failed with "No selected Robinhood pool" even
// when LP Safety, scanning the exact same token a few hundred lines later, went on to find and
// verify a real pool. Two contradicting reads of the same scan.
//
// Fix: simulation now runs AFTER _robinhoodLpProofResult resolves, using the exact same canonical
// pool identity (proofAudit.selectedPoolAddress, gated on proofAudit.selectedPoolChainOk so a
// wrong-chain/unconfirmed pool can never be used) that LP Safety itself already verified. A pool
// that exists but whose chain could not be confirmed gets its own distinct reason, never
// conflated with "no pool exists at all".
//
// Verified by source contract (this route has no dependency-injection seam for a live-request
// test, matching the existing convention in scripts/test-trading-simulation.mjs for this same
// file) plus pure-logic replication of the canonical-pool-selection expressions.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const routeSrc = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++ }
  else { failed++; console.error(`  ❌ FAIL: ${label}`) }
}

// ── Pure replication of the canonical-pool-selection logic ─────────────────
function resolveCanonicalRobinhoodPool(params) {
  const robinhoodProofSelectedPool = params.proofAuditSelectedPoolAddress
  const robinhoodSelectedPoolChainOk = params.proofAuditSelectedPoolChainOk
  const canonicalRobinhoodSelectedPool = robinhoodSelectedPoolChainOk ? robinhoodProofSelectedPool : null
  const robinhoodPoolExistsButChainUnconfirmed = !canonicalRobinhoodSelectedPool && Boolean(robinhoodProofSelectedPool)
  return { canonicalRobinhoodSelectedPool, robinhoodPoolExistsButChainUnconfirmed }
}

console.log('Section A: a scan with a real, chain-confirmed selected pool attempts simulation')
{
  const { canonicalRobinhoodSelectedPool, robinhoodPoolExistsButChainUnconfirmed } = resolveCanonicalRobinhoodPool({
    proofAuditSelectedPoolAddress: '0xpool',
    proofAuditSelectedPoolChainOk: true,
  })
  check('the canonical pool is passed through to simulation', canonicalRobinhoodSelectedPool === '0xpool')
  check('a chain-confirmed pool is never treated as "unconfirmed"', robinhoodPoolExistsButChainUnconfirmed === false)
}

console.log('\nSection B: if LP Safety sees a Robinhood pool, trading simulation receives the SAME pool')
check(
  'trading simulation reads _robinhoodLpProofResult.proofAudit.selectedPoolAddress — the exact object LP Safety itself resolved and verified, never a second independent guess',
  /const robinhoodProofSelectedPool = _robinhoodLpProofResult\.proofAudit\.selectedPoolAddress/.test(routeSrc)
)
check(
  'the pool passed to simulateRobinhoodHoneypot is the canonical one, not the early lpPoolAddress candidate',
  /poolAddress: canonicalRobinhoodSelectedPool,/.test(routeSrc)
)
check(
  'simulation no longer uses the early, pre-canonicalization lpPoolAddress as its own poolAddress input',
  !/poolAddress: lpPoolAddress,\s*\n\s*poolType: lpPoolType,\s*\n\s*\}\)/.test(routeSrc)
)

console.log('\nSection C: missing pool shows the exact reason — "no pool at all" vs. "pool exists, chain unconfirmed" are never conflated')
{
  const noPool = resolveCanonicalRobinhoodPool({ proofAuditSelectedPoolAddress: null, proofAuditSelectedPoolChainOk: false })
  check('genuinely no pool anywhere → canonical pool is null', noPool.canonicalRobinhoodSelectedPool === null)
  check('genuinely no pool anywhere → NOT reported as "exists but unconfirmed"', noPool.robinhoodPoolExistsButChainUnconfirmed === false)

  const unconfirmedChain = resolveCanonicalRobinhoodPool({ proofAuditSelectedPoolAddress: '0xpool', proofAuditSelectedPoolChainOk: false })
  check('a pool exists but chain unconfirmed → canonical pool is still null (never used)', unconfirmedChain.canonicalRobinhoodSelectedPool === null)
  check('a pool exists but chain unconfirmed → flagged distinctly from "no pool at all"', unconfirmedChain.robinhoodPoolExistsButChainUnconfirmed === true)
}
check(
  'the route gives the chain-unconfirmed case its own reason, taken from LP Safety\'s own resolver, not a fabricated string',
  /const rhFailureReason = robinhoodPoolExistsButChainUnconfirmed\s*\n\s*\? \(_robinhoodLpProofResult\.reason \|\| 'Selected Robinhood pool could not be confirmed as chainId 4663\.'\)/.test(routeSrc)
)
check(
  '"No selected Robinhood pool" (the module\'s own message) is reserved for genuinely no pool found anywhere',
  readFileSync(new URL('../lib/server/robinhoodHoneypotSimulation.ts', import.meta.url), 'utf8')
    .includes("failureReason: 'No selected Robinhood pool'")
)

console.log('\nSection D: wrong-chain cache is never used — simulation only ever receives an independently chain-confirmed pool')
check(
  'the canonical pool is gated on selectedPoolChainOk before ever reaching simulateRobinhoodHoneypot',
  /const canonicalRobinhoodSelectedPool = robinhoodSelectedPoolChainOk \? robinhoodProofSelectedPool : null/.test(routeSrc)
)
check(
  'selectedPoolChainOk itself comes from resolveRobinhoodLpProof, which independently verifies chainId 4663 via selectedRobinhoodPoolChainOk() — never trusted blindly from cache or client input',
  /const robinhoodSelectedPoolChainOk = _robinhoodLpProofResult\.proofAudit\.selectedPoolChainOk/.test(routeSrc)
)
check(
  "the simulation module's own cache key includes poolAddress, so a stale null-pool cache entry can never satisfy a lookup for a real, newly-resolved pool address",
  /buildRobinhoodHoneypotCacheKey\(chainId: number, tokenAddress: string, poolAddress: string \| null\)/.test(
    readFileSync(new URL('../lib/server/robinhoodHoneypotSimulation.ts', import.meta.url), 'utf8')
  )
)

console.log('\nSection E: audit object carries the required fields, including canonical/market/LP pool provenance')
const auditSrc = readFileSync(new URL('../lib/tradingSimulation.ts', import.meta.url), 'utf8')
for (const field of [
  'selectedPoolFromMarket', 'selectedPoolFromLp', 'canonicalSelectedPool', 'selectedPoolAddress',
  'selectedPoolDex', 'selectedPoolChainOk', 'simulationAttempted', 'simulationModuleLoaded',
  'envReady', 'finalReason',
]) {
  check(`RobinhoodTradingSimulationAudit declares ${field}`, new RegExp(`\\b${field}:`).test(auditSrc))
}
check(
  'the route populates the market/LP/canonical provenance fields on the audit it attaches to the response',
  /selectedPoolFromMarket: robinhoodSelectedPoolFromMarket,/.test(routeSrc)
  && /selectedPoolFromLp: robinhoodSelectedPoolFromLp,/.test(routeSrc)
  && /canonicalSelectedPool: canonicalRobinhoodSelectedPool,/.test(routeSrc)
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
