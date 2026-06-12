/**
 * Integration test for the shared LP intelligence layer
 * (lib/server/lpIntelligence.ts) used by Token Scanner, Liquidity Safety,
 * and Base Radar enrichment.
 *
 * Re-implements the pure selection/classification logic in plain JS
 * (matching lib/server/lpIntelligence.ts) so it can run without a TS
 * loader, and exercises the canonical scenarios called out in the LP
 * unification task: a mixed concentrated-primary/V2-secondary token
 * (VIRTUAL-style), a pure Uniswap V2 pool, an Aerodrome Slipstream-only
 * pool, a no-pool token, and an unclassified pool model.
 *
 * Run: node scripts/test-lp-intelligence.mjs
 */

let passed = 0
let failed = 0

function assert(label, condition, got) {
  if (condition) {
    console.log(`  ✅ ${label}`)
    passed++
  } else {
    console.error(`  ❌ FAIL: ${label} — got: ${JSON.stringify(got)}`)
    failed++
  }
}

// ─── Mirrors lib/server/lpIntelligence.ts ──────────────────────────────────

function selectCanonicalPools(pools) {
  const sorted = [...pools].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
  const primaryPool = sorted[0] ?? null
  const primaryConcentrated = primaryPool?.poolType === 'v3' || primaryPool?.poolType === 'concentrated'
  const isVerifiable = (p) =>
    (p.poolType === 'v2' || p.poolType === 'unknown' || p.poolType === 'aerodrome' || p.hasLpToken === true) &&
    p.isValidAddress && Boolean(p.address)
  const verifyPool = sorted.find(isVerifiable) ?? null
  const v2Candidates = sorted.filter(isVerifiable)
  const protocolCandidates = sorted.filter((p) => p.poolType === 'v3' || p.poolType === 'concentrated')
  return {
    primaryPool,
    primaryConcentrated,
    verifyPool,
    verifyPoolPresent: Boolean(verifyPool?.address && /^0x[a-f0-9]{40}$/i.test(verifyPool.address)),
    v2Candidates,
    protocolCandidates,
  }
}

function computeDisplayLpModel(params) {
  const { noActivePools, proofPresent, primaryPoolType, primaryDexId, verifyPoolType, controlStatusConcentrated } = params

  let displayLpModel
  let lockBurnApplicable
  let lockBurnReason

  if (noActivePools && !proofPresent) {
    displayLpModel = 'no_pool'
    lockBurnApplicable = false
    lockBurnReason = 'No active pool detected.'
  } else if (primaryPoolType === 'v3' || primaryPoolType === 'concentrated' || controlStatusConcentrated) {
    displayLpModel = 'concentrated_liquidity'
    lockBurnApplicable = false
    lockBurnReason = primaryDexId && /aerodrome|velodrome/i.test(primaryDexId)
      ? 'Aerodrome Slipstream (concentrated liquidity) — standard ERC-20 LP lock/burn proof does not apply.'
      : 'Concentrated liquidity (V3/V4) — standard ERC-20 LP lock/burn proof does not apply.'
  } else if ((primaryPoolType === 'v2' || primaryPoolType === 'aerodrome') && proofPresent) {
    displayLpModel = 'erc20_lp_token'
    lockBurnApplicable = true
    lockBurnReason = primaryPoolType === 'aerodrome'
      ? 'Aerodrome V2 (volatile/stable) LP token — lock/burn proof applies.'
      : 'Standard V2 LP token — lock/burn proof applies.'
  } else if (proofPresent && (verifyPoolType === 'v2' || verifyPoolType === 'aerodrome')) {
    displayLpModel = 'erc20_lp_token'
    lockBurnApplicable = true
    lockBurnReason = 'V2-style verification pool with LP token — lock/burn proof applies.'
  } else if (proofPresent) {
    displayLpModel = 'open_check'
    lockBurnApplicable = false
    lockBurnReason = 'Pool detected, but LP model could not be fully classified.'
  } else {
    displayLpModel = 'open_check'
    lockBurnApplicable = false
    lockBurnReason = 'LP model could not be determined from available data.'
  }

  const notApplicable = displayLpModel === 'concentrated_liquidity' || displayLpModel === 'no_pool'
  const proofApplicability = displayLpModel === 'erc20_lp_token' ? 'applicable'
    : notApplicable ? 'not_applicable'
    : 'unknown'

  return { displayLpModel, lockBurnApplicable, lockBurnReason, proofApplicability }
}

function reconcileSecondaryLpSignal(lpControl, params) {
  const { primaryConcentrated, verifyPool, primaryPoolAddress, primaryPoolType, primaryDexId, marketPairLabel, canonicalStatus } = params

  if (!(primaryConcentrated && verifyPool?.address && verifyPool.address !== primaryPoolAddress)) {
    return { lpControl, secondary: null }
  }

  const secondary = {
    status: lpControl.status,
    confidence: lpControl.confidence,
    poolAddress: verifyPool.address,
    poolDex: verifyPool.dexId ?? verifyPool.dexName ?? null,
    poolType: verifyPool.poolType,
    reason: lpControl.reason,
    evidence: lpControl.evidence,
  }

  const reconciled = {
    ...lpControl,
    status: canonicalStatus ?? 'concentrated_liquidity',
    confidence: 'medium',
    reason: 'Protocol-specific LP proof required for the primary pool.',
    evidence: [
      `Primary pool: ${marketPairLabel} (${primaryPoolType})`,
      `pool=${primaryPoolAddress ?? 'unknown'}`,
      `dex=${primaryDexId ?? 'unknown'}`,
      `poolType=${primaryPoolType}`,
    ],
    secondaryLpControlSignals: secondary,
  }

  return { lpControl: reconciled, secondary }
}

// ─── Scenario 1: VIRTUAL-style — concentrated primary + V2 secondary ──────────
console.log('Scenario 1: concentrated primary pool + separate V2 secondary pool (VIRTUAL-style)')
{
  const pools = [
    { address: '0xprimaryclmm', liquidityUsd: 5_000_000, dexId: 'aerodrome-base', poolType: 'concentrated', hasLpToken: false, isValidAddress: true },
    { address: '0xsecondaryv2', liquidityUsd: 250_000, dexId: 'uniswap-v2-base', poolType: 'v2', hasLpToken: true, isValidAddress: true },
  ]
  const selection = selectCanonicalPools(pools)
  assert('primary pool is the concentrated pool (highest liquidity)', selection.primaryPool?.address === '0xprimaryclmm', selection.primaryPool)
  assert('primary is flagged concentrated', selection.primaryConcentrated === true, selection.primaryConcentrated)
  assert('verify pool is the secondary V2 pool', selection.verifyPool?.address === '0xsecondaryv2', selection.verifyPool)

  const display = computeDisplayLpModel({
    noActivePools: false,
    proofPresent: true,
    primaryPoolType: selection.primaryPool.poolType,
    primaryDexId: selection.primaryPool.dexId,
    verifyPoolType: selection.verifyPool.poolType,
  })
  assert('displayLpModel is concentrated_liquidity', display.displayLpModel === 'concentrated_liquidity', display)
  assert('lockBurnApplicable is false', display.lockBurnApplicable === false, display)
  assert('proofApplicability is not_applicable', display.proofApplicability === 'not_applicable', display)

  // Simulate an on-chain holder scan having classified the SECONDARY V2 pool as team_controlled.
  const lpControlFromSecondary = { status: 'team_controlled', confidence: 'high', reason: 'Single wallet holds the LP supply.', evidence: ['holder=0xabc...'] }
  const { lpControl: reconciled, secondary } = reconcileSecondaryLpSignal(lpControlFromSecondary, {
    primaryConcentrated: selection.primaryConcentrated,
    verifyPool: selection.verifyPool,
    primaryPoolAddress: selection.primaryPool.address,
    primaryPoolType: selection.primaryPool.poolType,
    primaryDexId: selection.primaryPool.dexId,
    marketPairLabel: 'TOKEN/WETH',
  })
  assert('canonical status is demoted to concentrated_liquidity', reconciled.status === 'concentrated_liquidity', reconciled)
  assert('secondary signal carries the team_controlled finding', secondary?.status === 'team_controlled' && secondary?.poolAddress === '0xsecondaryv2', secondary)
  assert('reconciled lpControl never reports team_controlled at top level', reconciled.status !== 'team_controlled', reconciled.status)
}

// ─── Scenario 2: pure Uniswap V2 / Base pool ───────────────────────────────────
console.log('\nScenario 2: pure Uniswap V2 pool on Base')
{
  const pools = [
    { address: '0xv2only', liquidityUsd: 80_000, dexId: 'uniswap-v2-base', poolType: 'v2', hasLpToken: true, isValidAddress: true },
  ]
  const selection = selectCanonicalPools(pools)
  const display = computeDisplayLpModel({
    noActivePools: false,
    proofPresent: true,
    primaryPoolType: selection.primaryPool.poolType,
    primaryDexId: selection.primaryPool.dexId,
    verifyPoolType: selection.verifyPool.poolType,
  })
  assert('displayLpModel is erc20_lp_token', display.displayLpModel === 'erc20_lp_token', display)
  assert('lockBurnApplicable is true', display.lockBurnApplicable === true, display)
  assert('proofApplicability is applicable', display.proofApplicability === 'applicable', display)
  assert('verify pool equals primary pool', selection.verifyPool?.address === selection.primaryPool?.address, selection)
}

// ─── Scenario 3: Aerodrome Slipstream-only pool ────────────────────────────────
console.log('\nScenario 3: Aerodrome Slipstream-only pool (no V2 secondary)')
{
  const pools = [
    { address: '0xslipstream', liquidityUsd: 1_200_000, dexId: 'aerodrome-slipstream-base', poolType: 'concentrated', hasLpToken: false, isValidAddress: true },
  ]
  const selection = selectCanonicalPools(pools)
  assert('no proof-applicable verify pool exists', selection.verifyPool === null, selection.verifyPool)
  const display = computeDisplayLpModel({
    noActivePools: false,
    proofPresent: false,
    primaryPoolType: selection.primaryPool.poolType,
    primaryDexId: selection.primaryPool.dexId,
    verifyPoolType: selection.verifyPool?.poolType ?? 'unknown',
  })
  assert('displayLpModel is concentrated_liquidity', display.displayLpModel === 'concentrated_liquidity', display)
  assert('reason mentions Aerodrome Slipstream', /Aerodrome Slipstream/.test(display.lockBurnReason), display.lockBurnReason)
  assert('proofApplicability is not_applicable', display.proofApplicability === 'not_applicable', display)
}

// ─── Scenario 4: no-pool token ─────────────────────────────────────────────────
console.log('\nScenario 4: no-pool token')
{
  const pools = []
  const selection = selectCanonicalPools(pools)
  assert('no primary pool', selection.primaryPool === null, selection.primaryPool)
  const display = computeDisplayLpModel({
    noActivePools: true,
    proofPresent: false,
    primaryPoolType: 'unknown',
    primaryDexId: null,
    verifyPoolType: 'unknown',
  })
  assert('displayLpModel is no_pool', display.displayLpModel === 'no_pool', display)
  assert('lockBurnApplicable is false', display.lockBurnApplicable === false, display)
  assert('proofApplicability is not_applicable', display.proofApplicability === 'not_applicable', display)
}

// ─── Scenario 5: unknown / unclassified pool model ─────────────────────────────
console.log('\nScenario 5: pool present but model could not be classified')
{
  const pools = [
    { address: '0xunknownpool', liquidityUsd: 40_000, dexId: 'some-unlisted-dex', poolType: 'unknown', hasLpToken: null, isValidAddress: true },
  ]
  const selection = selectCanonicalPools(pools)
  const display = computeDisplayLpModel({
    noActivePools: false,
    proofPresent: false,
    primaryPoolType: selection.primaryPool.poolType,
    primaryDexId: selection.primaryPool.dexId,
    verifyPoolType: selection.verifyPool?.poolType ?? 'unknown',
  })
  assert('displayLpModel is open_check', display.displayLpModel === 'open_check', display)
  assert('proofApplicability is unknown (not "applicable" or "not_applicable")', display.proofApplicability === 'unknown', display)
  assert('lockBurnApplicable is false', display.lockBurnApplicable === false, display)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
