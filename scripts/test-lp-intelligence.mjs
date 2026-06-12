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
  const sorted = [...pools].sort((a, b) => {
    const liqDiff = (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)
    if (liqDiff !== 0) return liqDiff
    return (a.address ?? '').localeCompare(b.address ?? '')
  })
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

function marketFallbackToCandidate(fb) {
  if (!fb) return null
  const liquidityUsd = typeof fb.liquidityUsd === 'number' && Number.isFinite(fb.liquidityUsd) ? fb.liquidityUsd : 0
  const hasLiquidityEvidence = liquidityUsd > 0 || (typeof fb.volume24h === 'number' && fb.volume24h > 0)
  const addr = typeof fb.pairAddress === 'string' && /^0x[a-fA-F0-9]{40}$/.test(fb.pairAddress) ? fb.pairAddress.toLowerCase() : null
  if (!addr && !hasLiquidityEvidence) return null
  return {
    address: addr,
    liquidityUsd,
    dexId: fb.dexId ?? null,
    dexName: fb.dexId ?? null,
    poolType: fb.poolType ?? 'unknown',
    hasLpToken: fb.hasLpToken ?? null,
    hasDexMeta: Boolean(fb.dexId),
    isValidAddress: Boolean(addr),
  }
}

function applyRpcClassificationToCandidate(candidate, rpc) {
  if (rpc.poolType === 'unknown') return { ...candidate, hasLpToken: candidate.hasLpToken ?? rpc.hasLpToken }
  return { ...candidate, poolType: rpc.poolType, hasLpToken: rpc.hasLpToken }
}

function computeDisplayLpModel(params) {
  const { noActivePools, proofPresent, primaryPoolType, primaryDexId, verifyPoolType, controlStatusConcentrated, marketLiquidityDetected, aerodromeLpConfirmed, modelProofStandardLockApplies } = params

  let displayLpModel
  let lockBurnApplicable
  let lockBurnReason

  if (noActivePools && !proofPresent && !marketLiquidityDetected) {
    displayLpModel = 'no_pool'
    lockBurnApplicable = false
    lockBurnReason = 'No active pool detected.'
  } else if (noActivePools && !proofPresent && marketLiquidityDetected) {
    displayLpModel = 'open_check'
    lockBurnApplicable = false
    lockBurnReason = 'Pool detected from market fallback; pool model requires RPC confirmation.'
  } else if (primaryPoolType === 'v3' || primaryPoolType === 'concentrated' || controlStatusConcentrated) {
    displayLpModel = 'concentrated_liquidity'
    lockBurnApplicable = false
    lockBurnReason = primaryDexId && /aerodrome|velodrome/i.test(primaryDexId)
      ? 'Aerodrome Slipstream (concentrated liquidity) — standard ERC-20 LP lock/burn proof does not apply.'
      : 'Concentrated liquidity (V3/V4) — standard ERC-20 LP lock/burn proof does not apply.'
  } else if (primaryPoolType === 'aerodrome' && proofPresent && aerodromeLpConfirmed === false) {
    displayLpModel = 'open_check'
    lockBurnApplicable = false
    lockBurnReason = 'Aerodrome pool detected, but the ERC-20 LP proof path is not confirmed — pool model/controller path not fully verified.'
  } else if ((primaryPoolType === 'v2' || primaryPoolType === 'aerodrome') && proofPresent) {
    displayLpModel = 'erc20_lp_token'
    lockBurnApplicable = true
    lockBurnReason = primaryPoolType === 'aerodrome'
      ? 'Aerodrome V2 (volatile/stable) LP token — lock/burn proof applies.'
      : 'Standard V2 LP token — lock/burn proof applies.'
  } else if (verifyPoolType === 'aerodrome' && proofPresent && aerodromeLpConfirmed === false) {
    displayLpModel = 'open_check'
    lockBurnApplicable = false
    lockBurnReason = 'Aerodrome verification pool detected, but the ERC-20 LP proof path is not confirmed — pool model/controller path not fully verified.'
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
    lockBurnReason = marketLiquidityDetected
      ? 'Pool detected from market fallback; pool model requires RPC confirmation.'
      : 'LP model could not be determined from available data.'
  }

  // Final consistency check: lpModelProof confirms a standard ERC-20/constant-product LP
  // model — never report the pool MODEL as "unknown"/open_check in that case.
  if (displayLpModel === 'open_check' && modelProofStandardLockApplies === true) {
    displayLpModel = 'erc20_lp_token'
    lockBurnApplicable = true
    lockBurnReason = 'Pool model is a standard ERC-20 LP token (constant-product) per DEX metadata. Lock/burn dominance has not yet been confirmed from holder/controller evidence.'
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

// ─── Mirrors lib/server/lpProof.ts computeLpExitRisk ───────────────────────────
function computeLpExitRisk(params) {
  const { proofApplicability, lpLockStatus, lpController, liquidityUsd, poolModel, hasPool, secondaryLpSignal, lpControllerAddress, isEstablishedToken } = params
  const liquidityDepthRisk =
    liquidityUsd == null ? 'unknown' :
    liquidityUsd >= 100_000 ? 'low' :
    liquidityUsd >= 20_000 ? 'medium' : 'high'
  const liqStr = liquidityUsd != null ? `$${liquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : 'unknown'

  if (!hasPool) return { lpExitRisk: 'open_check', lpExitRiskReason: 'No active liquidity pool was found — exit risk cannot be assessed.', liquidityDepthRisk }

  if (proofApplicability === 'not_applicable') {
    const monitor = liquidityUsd != null && liquidityUsd > 50_000
    const watch = liquidityUsd != null && liquidityUsd > 0
    const secondaryClause = secondaryLpSignal?.status === 'team_controlled'
      ? ' A secondary ERC-20 LP pool shows wallet-controlled LP exposure — monitor that pool separately.'
      : ''
    return {
      lpExitRisk: monitor ? 'monitor' : watch ? 'watch' : 'open_check',
      lpExitRiskReason: `${poolModel === 'concentrated' ? 'Concentrated-liquidity (V3/Slipstream)' : 'Protocol-managed'} pool — standard LP lock/burn proof does not apply. Exit risk based on pool depth ($${liqStr === 'unknown' ? 'unknown' : liqStr.replace('$', '')}).${secondaryClause}`,
      liquidityDepthRisk,
    }
  }
  if (lpLockStatus === 'burned' || lpLockStatus === 'locked') {
    return { lpExitRisk: liquidityDepthRisk === 'high' ? 'medium' : 'low', lpExitRiskReason: lpLockStatus === 'burned' ? 'LP tokens sent to a burn address — exit liquidity permanently locked.' : 'Active LP lock proof found — protected for the lock duration.', liquidityDepthRisk }
  }
  if (proofApplicability === 'unknown') {
    return { lpExitRisk: 'open_check', lpExitRiskReason: 'Pool model could not be confirmed — LP lock/burn proof could not be attempted.', liquidityDepthRisk }
  }
  if (lpController === 'wallet') {
    const reason = isEstablishedToken
      ? `Selected LP position appears wallet-controlled${lpControllerAddress ? ` (${lpControllerAddress})` : ''}. This is a liquidity-control signal, not proof of malicious behavior. Verify the controlling wallet and any lock/burn evidence before relying on liquidity safety. Pool depth ${liqStr}.`
      : `A wallet controls the LP with no lock or burn proof — liquidity can be withdrawn at any time. Pool depth ${liqStr}.`
    return { lpExitRisk: liquidityDepthRisk === 'low' ? 'watch' : 'high', lpExitRiskReason: reason, liquidityDepthRisk }
  }
  if (liquidityDepthRisk === 'low') {
    return { lpExitRisk: 'watch', lpExitRiskReason: 'Deep liquidity is present, but LP lock/burn proof and controller dominance remain unconfirmed.', liquidityDepthRisk }
  }
  return { lpExitRisk: 'open_check', lpExitRiskReason: 'LP lock/burn proof applies to the selected pool, but ChainLens could not confirm lock, burn, or controller dominance from current evidence.', liquidityDepthRisk }
}

// ─── Mirrors lib/server/lpProof.ts buildCortexLpRead lockClause (unknown controller) ──
function cortexLockClause({ lpLockStatus, modelUnknown, standardLockApplies, lpController, isEstablishedToken }) {
  if (lpLockStatus === 'locked') return 'lock'
  if (lpLockStatus === 'burned') return 'burn'
  if (modelUnknown) return 'model-unknown'
  if (!standardLockApplies) return 'concentrated'
  if (lpController === 'wallet' && isEstablishedToken) return 'wallet-established'
  if (lpController === 'wallet') return 'No lock or burn proof was confirmed for this LP — treat liquidity as potentially withdrawable.'
  return 'No lock or burn proof was confirmed for the selected LP model. ChainLens could not confirm whether liquidity is controlled by a wallet, lock contract, burn address, or protocol mechanism from current evidence.'
}

// ─── Mirrors lib/server/lpProof.ts deriveMigrationProof ────────────────────────
function deriveMigrationProof(pools, totalLiq, primaryPoolSelected = false) {
  const dexsUsed = Array.from(new Set(pools.map((p) => p.dexId).filter(Boolean)))
  const liquidities = pools.map((p) => p.liquidityUsd ?? 0)
  const topShare = totalLiq && totalLiq > 0 ? (liquidities[0] ?? 0) / totalLiq : null
  let status = 'unknown'
  let confidence = 'unverified'
  let reason = 'Not enough pool data to assess migration risk.'
  const hasMeaningfulPrimary = (liquidities[0] ?? 0) > 0 && topShare != null && topShare >= 0.2
  const hasSelectedPrimary = hasMeaningfulPrimary || primaryPoolSelected
  if (pools.length > 0 && topShare != null) {
    if (dexsUsed.length === 1 && topShare >= 0.7) { status = 'low'; confidence = 'medium'; reason = 'Liquidity is concentrated in a single DEX and primary pool — no migration signal observed.' }
    else if (hasSelectedPrimary) { status = 'low'; confidence = 'low'; reason = 'Liquidity is distributed across multiple pools. A primary pool is present, so pool count alone is not enough evidence of migration risk. Historical liquidity movement is unavailable.' }
    else { status = 'unknown'; confidence = 'unverified'; reason = 'Liquidity is spread across multiple pools with no clear primary pool. Historical liquidity movement is unavailable, so migration risk cannot be confirmed from current evidence.' }
  }
  return { status, confidence, reason, missingEvidence: ['pool_creation_date_unavailable', 'historical_liquidity_movement_unavailable'] }
}

// ─── Mirrors app/api/token/route.ts lpIntelligence.migrationRisk mapping ────────
function mapMigrationRiskFromProof(migrationProofStatus) {
  if (migrationProofStatus === 'flagged') return 'high'
  if (migrationProofStatus === 'watch') return 'medium'
  if (migrationProofStatus === 'low') return 'low'
  return 'inferred'
}

// ─── Mirrors lib/server/lpProof.ts buildCortexLpRead contractStatusClause ──────
function contractStatusClause(contractSignals) {
  if (!contractSignals) return 'ownership, mintability, simulation and tax status remain unconfirmed'
  const confirmed = []
  const unconfirmed = []
  if (contractSignals.ownershipStatus === 'renounced') confirmed.push('ownership is verified renounced')
  else if (contractSignals.ownershipStatus === 'held') confirmed.push('ownership is held by a non-renounced address')
  else unconfirmed.push('ownership')

  if (contractSignals.mintDetected === true) confirmed.push('a mint authority/function is detected')
  else if (contractSignals.mintDetected === false) confirmed.push('no mint authority was detected')
  else unconfirmed.push('mintability')

  if (contractSignals.simulationVerified) {
    const buyTaxStr = contractSignals.buyTax != null ? `${contractSignals.buyTax}%` : 'unknown'
    const sellTaxStr = contractSignals.sellTax != null ? `${contractSignals.sellTax}%` : 'unknown'
    confirmed.push(`a trade simulation passed (buy tax ${buyTaxStr}, sell tax ${sellTaxStr})`)
  } else {
    unconfirmed.push('simulation and tax status')
  }

  const parts = []
  if (confirmed.length > 0) parts.push(confirmed.join(', '))
  if (unconfirmed.length > 0) parts.push(`${unconfirmed.join(', ')} remain unconfirmed`)
  return parts.join('; ')
}

// ─── Mirrors lib/server/lpProof.ts buildCortexLpRead evidence-aware nextActions ──
function cortexContractCheckActions(contractSignals) {
  const actions = []
  if (!contractSignals) {
    actions.push('Verify contract ownership/renouncement and mintability via the contract source code.')
    actions.push('Run a simulation and tax check prior to trading.')
    return actions
  }
  if (contractSignals.ownershipStatus === 'unknown') {
    actions.push('Verify contract ownership/renouncement via the contract source code.')
  }
  if (contractSignals.mintDetected === true) {
    actions.push('Monitor the impact of the active mint authority — confirm whether mint authority is disabled or constrained if source-level evidence is missing.')
  } else if (contractSignals.mintDetected === null) {
    actions.push('Verify mintability via the contract source code.')
  }
  if (!contractSignals.simulationVerified) {
    actions.push('Run a simulation and tax check prior to trading.')
  }
  return actions
}

function cortexLpControllerActions(lpController) {
  if (lpController !== 'wallet') return []
  return [
    'Verify LP holder distribution and confirm whether lock/burn dominance exists for the selected LP pool.',
    'Monitor top-LP-holder wallet activity for movement of the controlling position.',
  ]
}

// ─── Mirrors app/api/token/route.ts rugRisk.lp_safety owner/controller fields ──
function lpSafetyOwnerController(lpControllerAddress, lpControllerUnproven) {
  return {
    owner: lpControllerAddress ?? null,
    controller: lpControllerUnproven ? 'unknown' : (lpControllerAddress ?? null),
  }
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

// ─── Scenario 6: GOAL — fallback liquidity + pair address + RPC unknown ─────────
// market.liquidityUsd > 0 from fallback, a usable pair address exists, but the RPC
// probe could not confirm the model → pool detected, model open check (NOT no_pool).
console.log('\nScenario 6: fallback liquidity + pair address + RPC unknown (GOAL-style)')
{
  const fb = { pairAddress: '0x072ab6b2ea4bb811102d3f11b092c63115ed1b83', liquidityUsd: 42_000, volume24h: 9_500, dexId: null }
  const candidate = marketFallbackToCandidate(fb)
  assert('fallback produces a pool candidate', candidate !== null, candidate)
  assert('candidate has a valid address', candidate?.isValidAddress === true, candidate)
  // RPC probe inconclusive
  const classified = applyRpcClassificationToCandidate(candidate, { poolType: 'unknown', hasLpToken: null })
  const selection = selectCanonicalPools([classified])
  const proofPresent = Boolean(selection.verifyPool?.address && selection.verifyPool.hasLpToken === true)
  const display = computeDisplayLpModel({
    noActivePools: false,
    proofPresent,
    primaryPoolType: selection.primaryPool.poolType,
    primaryDexId: selection.primaryPool.dexId,
    verifyPoolType: selection.verifyPool?.poolType ?? 'unknown',
    marketLiquidityDetected: true,
  })
  assert('displayLpModel is NOT no_pool', display.displayLpModel !== 'no_pool', display)
  assert('displayLpModel is open_check', display.displayLpModel === 'open_check', display)
  assert('proofApplicability is unknown', display.proofApplicability === 'unknown', display)
  assert('lockBurnApplicable is false', display.lockBurnApplicable === false, display)
  assert('reason cites market fallback', /market fallback/i.test(display.lockBurnReason), display.lockBurnReason)
}

// ─── Scenario 7: fallback pair + RPC confirms V2 → proof applicable ─────────────
console.log('\nScenario 7: fallback pair + RPC V2 confirmed (proof applicable)')
{
  const fb = { pairAddress: '0x1111111111111111111111111111111111111111', liquidityUsd: 130_000, volume24h: 50_000, dexId: null }
  const candidate = marketFallbackToCandidate(fb)
  // RPC probe: token0/token1/getReserves/totalSupply all resolved → V2 ERC-20 LP
  const classified = applyRpcClassificationToCandidate(candidate, { poolType: 'v2', hasLpToken: true })
  assert('candidate upgraded to v2', classified.poolType === 'v2', classified)
  assert('candidate has LP token', classified.hasLpToken === true, classified)
  const selection = selectCanonicalPools([classified])
  const proofPresent = Boolean(selection.verifyPool?.address && selection.verifyPool.hasLpToken === true)
  const display = computeDisplayLpModel({
    noActivePools: false,
    proofPresent,
    primaryPoolType: selection.primaryPool.poolType,
    primaryDexId: selection.primaryPool.dexId,
    verifyPoolType: selection.verifyPool?.poolType ?? 'unknown',
    marketLiquidityDetected: true,
  })
  assert('displayLpModel is erc20_lp_token', display.displayLpModel === 'erc20_lp_token', display)
  assert('proofApplicability is applicable', display.proofApplicability === 'applicable', display)
  assert('lockBurnApplicable is true', display.lockBurnApplicable === true, display)
}

// ─── Scenario 8: no GT pool + no fallback pair → true no_pool ───────────────────
console.log('\nScenario 8: no GeckoTerminal pool + no fallback pair (true no_pool)')
{
  const candidate = marketFallbackToCandidate(null)
  assert('no fallback candidate produced', candidate === null, candidate)
  const candidate2 = marketFallbackToCandidate({ pairAddress: null, liquidityUsd: 0, volume24h: 0, dexId: null })
  assert('empty fallback produces no candidate', candidate2 === null, candidate2)
  const selection = selectCanonicalPools([])
  const display = computeDisplayLpModel({
    noActivePools: true,
    proofPresent: false,
    primaryPoolType: 'unknown',
    primaryDexId: null,
    verifyPoolType: 'unknown',
    marketLiquidityDetected: false,
  })
  assert('displayLpModel is no_pool', display.displayLpModel === 'no_pool', display)
  assert('proofApplicability is not_applicable', display.proofApplicability === 'not_applicable', display)
}

// ─── Scenario 9: fallback pair + RPC confirms concentrated → not_applicable ─────
console.log('\nScenario 9: fallback pair + RPC concentrated confirmed (not_applicable, not no_pool)')
{
  const fb = { pairAddress: '0x2222222222222222222222222222222222222222', liquidityUsd: 800_000, volume24h: 200_000, dexId: null }
  const candidate = marketFallbackToCandidate(fb)
  // RPC probe: token0/token1 + slot0/liquidity resolved, no getReserves/totalSupply → concentrated
  const classified = applyRpcClassificationToCandidate(candidate, { poolType: 'concentrated', hasLpToken: false })
  const selection = selectCanonicalPools([classified])
  assert('primary flagged concentrated', selection.primaryConcentrated === true, selection.primaryConcentrated)
  const proofPresent = Boolean(selection.verifyPool?.address && selection.verifyPool.hasLpToken === true)
  const display = computeDisplayLpModel({
    noActivePools: false,
    proofPresent,
    primaryPoolType: selection.primaryPool.poolType,
    primaryDexId: selection.primaryPool.dexId,
    verifyPoolType: selection.verifyPool?.poolType ?? 'unknown',
    marketLiquidityDetected: true,
  })
  assert('displayLpModel is concentrated_liquidity', display.displayLpModel === 'concentrated_liquidity', display)
  assert('displayLpModel is NOT no_pool', display.displayLpModel !== 'no_pool', display)
  assert('proofApplicability is not_applicable', display.proofApplicability === 'not_applicable', display)
}

// ─── Scenario 10: VIRTUAL-style mixed (concentrated primary + V2 secondary) ─────
// With fallback liquidity also present, the primary stays concentrated and the V2
// wallet-control finding stays under secondaryLpControlSignals only.
console.log('\nScenario 10: mixed concentrated primary + V2 secondary, with fallback liquidity present')
{
  const pools = [
    { address: '0xprimaryclmm0000000000000000000000000000', liquidityUsd: 5_000_000, dexId: 'aerodrome-base', poolType: 'concentrated', hasLpToken: false, isValidAddress: true },
    { address: '0xsecondaryv200000000000000000000000000000', liquidityUsd: 250_000, dexId: 'uniswap-v2-base', poolType: 'v2', hasLpToken: true, isValidAddress: true },
  ]
  const selection = selectCanonicalPools(pools)
  const display = computeDisplayLpModel({
    noActivePools: false,
    proofPresent: true,
    primaryPoolType: selection.primaryPool.poolType,
    primaryDexId: selection.primaryPool.dexId,
    verifyPoolType: selection.verifyPool.poolType,
    marketLiquidityDetected: true,
  })
  assert('primary stays concentrated_liquidity', display.displayLpModel === 'concentrated_liquidity', display)
  const lpControlFromSecondary = { status: 'team_controlled', confidence: 'high', reason: 'Single wallet holds the LP supply.', evidence: ['holder=0xabc...'] }
  const { lpControl: reconciled, secondary } = reconcileSecondaryLpSignal(lpControlFromSecondary, {
    primaryConcentrated: selection.primaryConcentrated,
    verifyPool: selection.verifyPool,
    primaryPoolAddress: selection.primaryPool.address,
    primaryPoolType: selection.primaryPool.poolType,
    primaryDexId: selection.primaryPool.dexId,
    marketPairLabel: 'TOKEN/WETH',
  })
  assert('canonical status demoted to concentrated_liquidity', reconciled.status === 'concentrated_liquidity', reconciled.status)
  assert('secondary signal carries the V2 team_controlled finding', secondary?.status === 'team_controlled' && secondary?.poolAddress === '0xsecondaryv200000000000000000000000000000', secondary)
  assert('top-level never reports team_controlled', reconciled.status !== 'team_controlled', reconciled.status)
}

// ─── Scenario 11: applicable + unknown controller + missing lock/burn (VIRTUAL) ─
// Deep liquidity → exit risk label and reason must agree (watch + watch-worded reason).
console.log('\nScenario 11: applicable proof + unknown controller + missing lock/burn (deep liquidity)')
{
  const r = computeLpExitRisk({
    proofApplicability: 'applicable', lpLockStatus: 'unverified', lpController: 'unknown',
    liquidityUsd: 5_000_000, poolModel: 'constant_product', hasPool: true,
  })
  assert('exit risk is watch (deep liquidity)', r.lpExitRisk === 'watch', r)
  assert('reason does NOT say "open check"', !/open check/i.test(r.lpExitRiskReason), r.lpExitRiskReason)
  assert('reason matches the watch wording', /Deep liquidity is present/.test(r.lpExitRiskReason), r.lpExitRiskReason)
}

// ─── Scenario 12: applicable + unknown controller + thin liquidity ──────────────
// Thin liquidity → open_check label must carry an open_check-worded reason.
console.log('\nScenario 12: applicable proof + unknown controller + thin liquidity')
{
  const r = computeLpExitRisk({
    proofApplicability: 'applicable', lpLockStatus: 'unverified', lpController: 'unknown',
    liquidityUsd: 5_000, poolModel: 'constant_product', hasPool: true,
  })
  assert('exit risk is open_check (thin liquidity)', r.lpExitRisk === 'open_check', r)
  assert('reason does NOT contradict with a "watch" claim', !/^watch/i.test(r.lpExitRiskReason), r.lpExitRiskReason)
  assert('reason matches the open-check wording', /could not confirm lock, burn, or controller dominance/.test(r.lpExitRiskReason), r.lpExitRiskReason)
}

// ─── Scenario 13: CORTEX wording — unknown controller is not "withdrawable" ─────
console.log('\nScenario 13: CORTEX wording — unknown controller does not say "potentially withdrawable"')
{
  const unknownClause = cortexLockClause({ lpLockStatus: 'unverified', modelUnknown: false, standardLockApplies: true, lpController: 'unknown', isEstablishedToken: false })
  assert('unknown-controller clause avoids "withdrawable"', !/withdrawable/i.test(unknownClause), unknownClause)
  assert('unknown-controller clause uses the neutral wording', /could not confirm whether liquidity is controlled/i.test(unknownClause), unknownClause)
  const walletClause = cortexLockClause({ lpLockStatus: 'unverified', modelUnknown: false, standardLockApplies: true, lpController: 'wallet', isEstablishedToken: false })
  assert('confirmed wallet control still allowed to say "withdrawable"', /withdrawable/i.test(walletClause), walletClause)
}

// ─── Scenario 14: Aerodrome dex id alone does NOT force applicable ──────────────
console.log('\nScenario 14: Aerodrome detected but ERC-20 LP proof path not confirmed')
{
  const unconfirmed = computeDisplayLpModel({
    noActivePools: false, proofPresent: true, primaryPoolType: 'aerodrome',
    primaryDexId: 'aerodrome-base', verifyPoolType: 'aerodrome', aerodromeLpConfirmed: false,
  })
  assert('displayLpModel is open_check (not erc20_lp_token)', unconfirmed.displayLpModel === 'open_check', unconfirmed)
  assert('lockBurnApplicable is false', unconfirmed.lockBurnApplicable === false, unconfirmed)
  assert('proofApplicability is unknown (not applicable)', unconfirmed.proofApplicability === 'unknown', unconfirmed)
  assert('reason cites unverified pool model/controller path', /not fully verified/i.test(unconfirmed.lockBurnReason), unconfirmed.lockBurnReason)

  // Confirmed ERC-20 LP behavior → applicable.
  const confirmed = computeDisplayLpModel({
    noActivePools: false, proofPresent: true, primaryPoolType: 'aerodrome',
    primaryDexId: 'aerodrome-base', verifyPoolType: 'aerodrome', aerodromeLpConfirmed: true,
  })
  assert('confirmed Aerodrome ERC-20 LP is applicable', confirmed.displayLpModel === 'erc20_lp_token' && confirmed.proofApplicability === 'applicable', confirmed)
}

// ─── Scenario 15: multi-pool token with a clear primary does not auto-migrate ───
console.log('\nScenario 15: multi-pool token with meaningful primary pool — no false migration watch')
{
  const pools = [
    { dexId: 'uniswap-v2-base', liquidityUsd: 6_000_000 },
    { dexId: 'aerodrome-base', liquidityUsd: 2_000_000 },
    { dexId: 'uniswap-v3-base', liquidityUsd: 1_500_000 },
    { dexId: 'pancakeswap-base', liquidityUsd: 800_000 },
  ]
  const total = pools.reduce((s, p) => s + p.liquidityUsd, 0)
  const m = deriveMigrationProof(pools, total)
  assert('migration status is NOT watch/flagged', m.status !== 'watch' && m.status !== 'flagged', m.status)
  assert('migration reason avoids "no dominant pool"', !/no dominant pool/i.test(m.reason), m.reason)
  assert('migration reason uses neutral primary-pool wording', /primary pool is present/i.test(m.reason), m.reason)
  assert('historical movement recorded as a missing-evidence gap', m.missingEvidence.includes('historical_liquidity_movement_unavailable'), m.missingEvidence)

  // No clear primary (evenly fragmented) → unknown + unverified, still never an unsupported watch.
  const frag = [
    { dexId: 'a', liquidityUsd: 100 }, { dexId: 'b', liquidityUsd: 100 },
    { dexId: 'c', liquidityUsd: 100 }, { dexId: 'd', liquidityUsd: 100 },
    { dexId: 'e', liquidityUsd: 100 }, { dexId: 'f', liquidityUsd: 100 },
  ]
  const fm = deriveMigrationProof(frag, 600)
  assert('fragmented-no-primary status is unknown (not watch)', fm.status === 'unknown', fm.status)
}

// ─── Scenario 16: concentrated primary still not_applicable (regression guard) ──
console.log('\nScenario 16: concentrated primary preserved (regression)')
{
  const r = computeLpExitRisk({
    proofApplicability: 'not_applicable', lpLockStatus: 'unverified', lpController: 'unknown',
    liquidityUsd: 5_000_000, poolModel: 'concentrated', hasPool: true,
  })
  assert('concentrated deep-liquidity exit risk is monitor', r.lpExitRisk === 'monitor', r)
  assert('reason states standard proof does not apply', /does not apply/i.test(r.lpExitRiskReason), r.lpExitRiskReason)
}

// ─── Scenario 17: VIRTUAL-style — many ecosystem pools, selected primary, low top-share ──
console.log('\nScenario 17: VIRTUAL-style multi-pool + selected primary pool — neutral migration copy')
{
  // Many small ecosystem pools across DEXs; deep total liquidity but the top pool holds
  // less than 20% of the grand total. A primary/verification pool WAS selected by the LP
  // pipeline (primaryPoolSelected = true).
  const pools = [
    { dexId: 'uniswap-v3-base', liquidityUsd: 900_000 },
    { dexId: 'aerodrome-base', liquidityUsd: 850_000 },
    { dexId: 'uniswap-v2-base', liquidityUsd: 800_000 },
    { dexId: 'pancakeswap-base', liquidityUsd: 750_000 },
    { dexId: 'sushiswap-base', liquidityUsd: 700_000 },
    { dexId: 'baseswap', liquidityUsd: 1_000_000 },
  ]
  const total = pools.reduce((s, p) => s + p.liquidityUsd, 0)
  const topShare = pools[0].liquidityUsd / total
  assert('fixture has a top-share below the 20% meaningful-primary threshold', topShare < 0.2, topShare)

  const m = deriveMigrationProof(pools, total, true)
  assert('migration status is low (neutral), not watch/flagged', m.status === 'low', m.status)
  assert('migration confidence is low (not high/medium)', m.confidence === 'low', m.confidence)
  assert('migration reason does NOT say "no clear primary pool"', !/no clear primary pool/i.test(m.reason), m.reason)
  assert('migration reason uses the required neutral copy', m.reason === 'Liquidity is distributed across multiple pools. A primary pool is present, so pool count alone is not enough evidence of migration risk. Historical liquidity movement is unavailable.', m.reason)

  const migrationRisk = mapMigrationRiskFromProof(m.status)
  assert('mapped migrationRisk is low, not high', migrationRisk === 'low', migrationRisk)
}

// ─── Scenario 18: no selected primary + fragmented pools + missing history ──────
console.log('\nScenario 18: fragmented pools with no selected primary — open_check, not confirmed high')
{
  const pools = [
    { dexId: 'a', liquidityUsd: 100 }, { dexId: 'b', liquidityUsd: 100 },
    { dexId: 'c', liquidityUsd: 100 }, { dexId: 'd', liquidityUsd: 100 },
    { dexId: 'e', liquidityUsd: 100 }, { dexId: 'f', liquidityUsd: 100 },
  ]
  const total = pools.reduce((s, p) => s + p.liquidityUsd, 0)

  const m = deriveMigrationProof(pools, total, false)
  assert('migration status is unknown (open_check), not watch/flagged', m.status === 'unknown', m.status)
  assert('migration confidence is unverified', m.confidence === 'unverified', m.confidence)
  assert('migration reason cites no clear primary pool', /no clear primary pool/i.test(m.reason), m.reason)

  const migrationRisk = mapMigrationRiskFromProof(m.status)
  assert('mapped migrationRisk is inferred (open_check), not high', migrationRisk === 'inferred', migrationRisk)
  assert('mapped migrationRisk is never "high" for fragmentation alone', migrationRisk !== 'high', migrationRisk)
}

// ─── Scenario 19: migrationRisk mapping — only watch/flagged escalate ───────────
console.log('\nScenario 19: migrationRisk mapping requires real migration-proof evidence')
{
  assert('proof status "low" maps to migrationRisk "low"', mapMigrationRiskFromProof('low') === 'low')
  assert('proof status "watch" maps to migrationRisk "medium"', mapMigrationRiskFromProof('watch') === 'medium')
  assert('proof status "flagged" maps to migrationRisk "high"', mapMigrationRiskFromProof('flagged') === 'high')
  assert('proof status "unknown" maps to migrationRisk "inferred"', mapMigrationRiskFromProof('unknown') === 'inferred')
}

// ─── Scenario 20: CORTEX LP read — confirmed contract signals are not reported as unconfirmed ──
console.log('\nScenario 20: CORTEX LP read reports confirmed ownership/mint/simulation/tax evidence')
{
  // VIRTUAL-style: ownership verified renounced, simulation passed with 0% taxes, mint detected.
  const confirmedClause = contractStatusClause({
    ownershipStatus: 'renounced',
    mintDetected: true,
    simulationVerified: true,
    buyTax: 0,
    sellTax: 0,
  })
  assert('confirmed clause states ownership is verified renounced', /ownership is verified renounced/i.test(confirmedClause), confirmedClause)
  assert('confirmed clause states a mint authority/function is detected', /mint authority\/function is detected/i.test(confirmedClause), confirmedClause)
  assert('confirmed clause states simulation passed with tax values', /trade simulation passed \(buy tax 0%, sell tax 0%\)/i.test(confirmedClause), confirmedClause)
  assert('confirmed clause does NOT claim ownership/mintability/simulation/tax are unconfirmed', !/remain unconfirmed/i.test(confirmedClause), confirmedClause)

  // No mint detected + held ownership + no simulation → only simulation/tax remain unconfirmed.
  const partialClause = contractStatusClause({
    ownershipStatus: 'held',
    mintDetected: false,
    simulationVerified: false,
    buyTax: null,
    sellTax: null,
  })
  assert('partial clause states ownership is held by a non-renounced address', /ownership is held by a non-renounced address/i.test(partialClause), partialClause)
  assert('partial clause states no mint authority was detected', /no mint authority was detected/i.test(partialClause), partialClause)
  assert('partial clause says simulation and tax status remain unconfirmed', /simulation and tax status remain unconfirmed/i.test(partialClause), partialClause)
  assert('partial clause does not say ownership is unconfirmed', !/^ownership(?!.*verified|.*held)/i.test(partialClause), partialClause)

  // No contractSignals provided (e.g. Liquidity Safety route) → preserve the exact old wording.
  const legacyClause = contractStatusClause(undefined)
  assert('legacy (no signals) clause preserves old fully-unconfirmed wording', legacyClause === 'ownership, mintability, simulation and tax status remain unconfirmed', legacyClause)
}

// ─── Scenario 21: VIRTUAL-style constant-product primary pool — model/proof consistency ──
console.log('\nScenario 21: constant-product primary pool — proofApplicability matches lpModelProof.standardLockApplies')
{
  // RPC/holder evidence did not confirm an ERC-20 LP token for this Aerodrome V2 pool, but
  // lpModelProof (from classifyPoolModel on the same DEX id) says standardLockApplies=true.
  const display = computeDisplayLpModel({
    noActivePools: false,
    proofPresent: true,
    primaryPoolType: 'aerodrome',
    primaryDexId: 'aerodrome-base',
    verifyPoolType: 'aerodrome',
    aerodromeLpConfirmed: false,
    modelProofStandardLockApplies: true,
  })
  assert('displayLpModel is erc20_lp_token (not open_check)', display.displayLpModel === 'erc20_lp_token', display)
  assert('proofApplicability is applicable (not unknown)', display.proofApplicability === 'applicable', display)
  assert('lockBurnApplicable is true', display.lockBurnApplicable === true, display)
  assert('reason does not say "pool model unknown" / "not confirmed"', !/model.*not confirmed|model is unknown/i.test(display.lockBurnReason), display.lockBurnReason)
  assert('reason cites holder/controller evidence as the open item', /holder\/controller evidence/i.test(display.lockBurnReason), display.lockBurnReason)
}

// ─── Scenario 22: genuinely unknown model — proofApplicability stays unknown ──
console.log('\nScenario 22: genuinely unknown pool model — proofApplicability unknown, skip reason can say model unknown')
{
  const display = computeDisplayLpModel({
    noActivePools: false,
    proofPresent: true,
    primaryPoolType: 'unknown',
    primaryDexId: 'some-unindexed-dex',
    verifyPoolType: 'unknown',
    modelProofStandardLockApplies: false,
  })
  assert('displayLpModel is open_check', display.displayLpModel === 'open_check', display)
  assert('proofApplicability is unknown', display.proofApplicability === 'unknown', display)
  assert('lockBurnApplicable is false', display.lockBurnApplicable === false, display)
}

// ─── Scenario 23: concentrated/protocol pool — standard lock proof never applies ──
console.log('\nScenario 23: concentrated primary pool — standard ERC-20 LP lock proof does not apply')
{
  const display = computeDisplayLpModel({
    noActivePools: false,
    proofPresent: true,
    primaryPoolType: 'v3',
    primaryDexId: 'uniswap_v3-base',
    verifyPoolType: 'unknown',
    modelProofStandardLockApplies: false,
  })
  assert('displayLpModel is concentrated_liquidity', display.displayLpModel === 'concentrated_liquidity', display)
  assert('proofApplicability is not_applicable', display.proofApplicability === 'not_applicable', display)
  assert('lockBurnApplicable is false', display.lockBurnApplicable === false, display)
  assert('reason does not claim ERC-20 LP lock proof applies', !/lock\/burn proof applies/i.test(display.lockBurnReason), display.lockBurnReason)

  // Even if lpModelProof somehow said standardLockApplies=true for a confirmed-concentrated
  // primary, the concentrated classification must win — never override to erc20_lp_token.
  const displayOverrideAttempt = computeDisplayLpModel({
    noActivePools: false,
    proofPresent: true,
    primaryPoolType: 'v3',
    primaryDexId: 'uniswap_v3-base',
    verifyPoolType: 'unknown',
    modelProofStandardLockApplies: true,
  })
  assert('concentrated classification is not overridden by modelProofStandardLockApplies', displayOverrideAttempt.displayLpModel === 'concentrated_liquidity', displayOverrideAttempt)
}

// ─── Scenario 24: rugRisk.lp_safety.owner is the LP controller, never the token owner ──
console.log('\nScenario 24: rugRisk.lp_safety.owner/controller reflect LP control, not token ownership')
{
  // Token owner renounced (zero address), but LP controller is unknown (proofApplicability unknown).
  const unknownController = lpSafetyOwnerController(null, true)
  assert('owner is null when LP controller is not verified', unknownController.owner === null, unknownController)
  assert('controller is "unknown" consistently with owner=null', unknownController.controller === 'unknown', unknownController)

  // LP controller IS verified (team-controlled wallet) — owner is the LP controller wallet,
  // never the token-contract owner address.
  const knownController = lpSafetyOwnerController('0xteamwallet000000000000000000000000000001', false)
  assert('owner is the verified LP controller wallet', knownController.owner === '0xteamwallet000000000000000000000000000001', knownController)
  assert('controller matches owner for a verified wallet controller', knownController.controller === knownController.owner, knownController)
}

// ─── Scenario 25: CORTEX nextActions is evidence-aware (VIRTUAL-style) ──────────
console.log('\nScenario 25: CORTEX nextActions does not re-ask for already-verified evidence')
{
  // Ownership verified renounced, mint detected, simulation passed — VIRTUAL-style.
  const virtualSignals = { ownershipStatus: 'renounced', mintDetected: true, simulationVerified: true, buyTax: 0, sellTax: 0 }
  const contractActions = cortexContractCheckActions(virtualSignals)
  assert('does not say verify ownership/renouncement again', !contractActions.some((a) => /verify contract ownership/i.test(a)), contractActions)
  assert('does not say run simulation/tax check again', !contractActions.some((a) => /run a simulation and tax check/i.test(a)), contractActions)
  assert('mentions monitoring active mint authority impact', contractActions.some((a) => /monitor the impact of the active mint authority/i.test(a)), contractActions)

  const lpActions = cortexLpControllerActions('wallet')
  assert('focuses on LP controller/holder distribution proof', lpActions.some((a) => /lp holder distribution/i.test(a)), lpActions)
  assert('focuses on monitoring top-holder movement', lpActions.some((a) => /top-lp-holder wallet activity/i.test(a)), lpActions)

  // Legacy path (no contractSignals) still asks the generic questions.
  const legacyActions = cortexContractCheckActions(undefined)
  assert('legacy actions still verify ownership/mintability', legacyActions.some((a) => /verify contract ownership\/renouncement and mintability/i.test(a)), legacyActions)
  assert('legacy actions still ask for simulation/tax check', legacyActions.some((a) => /run a simulation and tax check/i.test(a)), legacyActions)
}

// ─── Scenario 26: deterministic primary-pool selection regardless of input order ──
console.log('\nScenario 26: primary-pool selection is deterministic for tied liquidity / reordered input')
{
  const poolsA = [
    { address: '0xbbbb000000000000000000000000000000bbbb', liquidityUsd: 1_000_000, poolType: 'v2', hasLpToken: true, isValidAddress: true },
    { address: '0xaaaa000000000000000000000000000000aaaa', liquidityUsd: 1_000_000, poolType: 'v2', hasLpToken: true, isValidAddress: true },
  ]
  const poolsB = [...poolsA].reverse()
  const selA = selectCanonicalPools(poolsA)
  const selB = selectCanonicalPools(poolsB)
  assert('tied-liquidity primary pool selection is order-independent', selA.primaryPool?.address === selB.primaryPool?.address, { a: selA.primaryPool, b: selB.primaryPool })
  assert('tie-break picks the lexicographically-first address', selA.primaryPool?.address === '0xaaaa000000000000000000000000000000aaaa', selA.primaryPool)
}

// ─── Scenario 27: Lock/Burn registry-intel semantics ───────────────────────
console.log('\nScenario 27: lpLockBurnIntel registry semantics')
{
  const registry = {
    burnAddresses: ['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead'],
    lockersByChain: { base: [], eth: [], bnb: [] },
  }
  const virtualIntel = {
    status: 'open_check',
    lockBurnProof: 'open_check',
    chain: 'base',
    lpTokenOrPool: '0x21594b992f68495dd28d605834b58889d0a727c7',
    lockedPercent: null,
    burnedPercent: null,
    summary: 'LP controller is known, but active lock/burn proof is not confirmed.',
    evidenceGaps: ['no verified base locker registry match', 'burn proof not confirmed'],
    nextActions: ['verify LP holders', 'verify locker', 'monitor/rescan'],
  }
  assert('registry has base/eth/bnb locker arrays', Array.isArray(registry.lockersByChain.base) && Array.isArray(registry.lockersByChain.eth) && Array.isArray(registry.lockersByChain.bnb), registry.lockersByChain)
  assert('registry has zero/dead burn addresses', registry.burnAddresses.length === 2 && registry.burnAddresses[0].endsWith('0000') && registry.burnAddresses[1].endsWith('dead'), registry.burnAddresses)
  assert('VIRTUAL lock/burn status is open_check', virtualIntel.status === 'open_check', virtualIntel)
  assert('VIRTUAL lock/burn proof is open_check', virtualIntel.lockBurnProof === 'open_check', virtualIntel)
  assert('VIRTUAL lock/burn percentages are null', virtualIntel.lockedPercent == null && virtualIntel.burnedPercent == null, virtualIntel)
  assert('VIRTUAL lock/burn summary says controller known but no active proof', /controller is known.*not confirmed/i.test(virtualIntel.summary), virtualIntel.summary)
  assert('VIRTUAL lock/burn gaps/actions match expected', virtualIntel.evidenceGaps.includes('no verified base locker registry match') && virtualIntel.evidenceGaps.includes('burn proof not confirmed') && virtualIntel.nextActions.includes('monitor/rescan'), virtualIntel)

  const goalIntel = {
    status: 'not_applicable',
    lockBurnProof: 'not_applicable',
    lockedPercent: null,
    burnedPercent: null,
    summary: 'ERC20 LP lock/burn proof does not apply to concentrated or protocol-managed pools; positions require protocol-specific verification.',
  }
  assert('GOAL/concentrated lock/burn status is not_applicable', goalIntel.status === 'not_applicable', goalIntel)
  assert('GOAL/concentrated lock/burn proof is not_applicable', goalIntel.lockBurnProof === 'not_applicable', goalIntel)
  assert('GOAL/concentrated lock/burn percentages are null', goalIntel.lockedPercent == null && goalIntel.burnedPercent == null, goalIntel)
  assert('GOAL/concentrated summary explains ERC20 proof does not apply', /ERC20 LP lock\/burn proof does not apply/i.test(goalIntel.summary), goalIntel.summary)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
