// Central LP model reconciliation for Base Radar drawer/data shaping.
//
// The shared token-scanner pipeline can produce internally-inconsistent LP model
// signals for a single scan (e.g. lpControl.displayLpModel = concentrated_liquidity
// while lpModelProof.model = constant_product, or a "secondary" ERC-20 LP pool that
// is actually the same address as the primary pool). This module reconciles those
// signals into one canonical model before the Base Radar enrichment payload is built,
// without making any additional provider/API calls — it only re-derives from fields
// already present on the scan result.

import { extractLpControllerSharePercent } from '../baseRadarSeverity'

export type ReconciledLpModel = 'concentrated_liquidity' | 'erc20_lp_token' | 'unknown'
export type LpProofApplicability = 'applicable' | 'not_applicable' | 'unknown'

export interface LpProofDisplay {
  proofLabel: string
  lockStatus: string
  lockAmount: string | null
  unlockTime: string
  burnProof: string | null
  controller: string | null
  exitRisk: string | null
}

function normalizeModelToken(value: unknown): ReconciledLpModel | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const v = value.trim().toLowerCase()
  if (['concentrated_liquidity', 'concentrated', 'v3', 'v4', 'slipstream', 'clmm'].some((k) => v === k || v.includes(k))) {
    return 'concentrated_liquidity'
  }
  if (['erc20_lp_token', 'constant_product', 'v2', 'aerodrome_v2', 'aerodrome', 'stableswap'].some((k) => v === k || v.includes(k))) {
    return 'erc20_lp_token'
  }
  return null
}

// Source-of-truth priority for the canonical LP model. The first source that
// resolves to a concrete model (concentrated_liquidity / erc20_lp_token) wins;
// sources that are missing or unrecognized are skipped.
function reconcileLpModel(sources: Array<unknown>): ReconciledLpModel {
  for (const source of sources) {
    const model = normalizeModelToken(source)
    if (model) return model
  }
  return 'unknown'
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asAddress(value: unknown): string | null {
  const s = asString(value)
  return s && /^0x[a-fA-F0-9]{40}$/.test(s) ? s.toLowerCase() : null
}

export type FallbackPoolModelHint = 'erc20_lp_token' | 'concentrated_liquidity' | 'unknown'

export interface NormalizedFallbackPoolIdentity {
  pairAddress: string | null
  dexName: string | null
  dexId: string | null
  pairLabel: string | null
  modelHint: FallbackPoolModelHint
}

// V2/constant-product style AMMs on Base — a fallback pool on one of these DEXes
// is treated as an ERC-20 LP token pool (standard lock/burn proof applies).
const V2_DEX_PATTERNS = ['uniswap_v2', 'uniswapv2', 'baseswap', 'aerodrome', 'alienbase', 'swapbased', 'sushiswap', 'pancakeswap_v2', 'pancakeswapv2']
// Concentrated-liquidity style pools — standard ERC-20 LP lock/burn proof does not apply.
const CONCENTRATED_DEX_PATTERNS = ['uniswap_v3', 'uniswapv3', 'uniswap_v4', 'uniswapv4', 'slipstream', 'pancakeswap_v3', 'pancakeswapv3', 'pancakeswap-v3']

function classifyDexModelHint(dexId: string | null): FallbackPoolModelHint {
  if (!dexId) return 'unknown'
  const normalized = dexId.toLowerCase().trim().replace(/[\s-]+/g, '_')
  if (normalized === 'uniswap') return 'unknown'
  if (CONCENTRATED_DEX_PATTERNS.some((p) => normalized.includes(p.replace(/[\s-]+/g, '_')))) return 'concentrated_liquidity'
  if (V2_DEX_PATTERNS.some((p) => normalized.includes(p.replace(/[\s-]+/g, '_')))) return 'erc20_lp_token'
  if (normalized.includes('v3') || normalized.includes('v4')) return 'concentrated_liquidity'
  if (normalized.includes('v2')) return 'erc20_lp_token'
  return 'unknown'
}

/**
 * Normalizes the fallback market pool identity (pair address, dex, pair label) from
 * whatever raw fallback fields are present on the scan result — no additional
 * provider/API calls. Used to carry pool/liquidity evidence Base Radar already has
 * into LP model classification, evidence, and simulation when lpControl never
 * resolved a primary pool.
 */
export function normalizeBaseRadarFallbackPoolIdentity(scan: Record<string, any>): NormalizedFallbackPoolIdentity {
  const selectedPool = scan?.selectedPool && typeof scan.selectedPool === 'object' ? scan.selectedPool as Record<string, unknown> : {}
  const marketFallback = scan?._diagnostics?.marketFallback && typeof scan._diagnostics.marketFallback === 'object' ? scan._diagnostics.marketFallback as Record<string, unknown> : {}
  const dexPair = scan?.dexPair && typeof scan.dexPair === 'object' ? scan.dexPair as Record<string, unknown> : {}
  const baseTokenObj = (dexPair.baseToken ?? scan?.baseToken) as Record<string, unknown> | undefined
  const quoteTokenObj = (dexPair.quoteToken ?? scan?.quoteToken) as Record<string, unknown> | undefined

  const pairAddress = asAddress(
    scan?.pairAddress ?? scan?.pair_address ?? scan?.poolAddress ?? scan?.pool_address ?? scan?.address
    ?? dexPair.pairAddress ?? dexPair.pair_address
    ?? selectedPool.address
    ?? marketFallback.pairAddress,
  )

  const dexId = asString(
    scan?.dexId ?? dexPair.dexId ?? marketFallback.dexId ?? selectedPool.dex ?? scan?.dexName ?? scan?.primaryDexName,
  )

  const dexName = asString(scan?.dexName ?? scan?.primaryDexName ?? (typeof selectedPool.dex === 'string' ? selectedPool.dex : null) ?? dexId)

  const symbolPair = [baseTokenObj?.symbol, quoteTokenObj?.symbol].filter((v) => typeof v === 'string' && v).join('/')
  const pairLabel = asString(selectedPool.pair) ?? (symbolPair ? symbolPair : null)

  return {
    pairAddress,
    dexName,
    dexId,
    pairLabel,
    modelHint: pairAddress ? classifyDexModelHint(dexId) : 'unknown',
  }
}


function extractEvidenceValue(evidence: string[], prefix: string): string | null {
  const line = evidence.find((e) => e.startsWith(prefix))
  return line ? line.slice(prefix.length).trim() : null
}

function formatDexLabel(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => (/^v\d+$/i.test(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join(' ')
}

function sanitizeConcentratedCortexText(text: string): string {
  if (!/constant[\s_-]?product/i.test(text)) return text
  return text.replace(
    /[^.!?]*constant[\s_-]?product[^.!?]*[.!?]?/gi,
    'This pool uses a concentrated-liquidity model; standard ERC-20 LP lock/burn proof does not apply, and liquidity control requires protocol-specific position checks.',
  )
}

export interface BaseRadarLpReconciliationResult {
  displayLpModel: ReconciledLpModel
  proofApplicability: LpProofApplicability
  lockBurnApplicable: boolean
  lpModelProof: { model: string; dexName: string | null; standardLockApplies: boolean } | null
  lpEvidenceSummary: string[] | null
  cortexLpRead: Record<string, unknown> | null
  evidence: string[]
  secondaryLpControlSignals: Record<string, unknown> | null
  lpProofDisplay: LpProofDisplay | null
  primaryMarketPool: string | null
  primaryMarketPoolId: string | null
  poolAddressPresent: boolean
  fallbackPoolIdentity: NormalizedFallbackPoolIdentity
  simulationPairAddress: string | null | undefined
  rugRiskDisplay: { status: string; reason: string } | null
}

export function reconcileBaseRadarLp(scan: Record<string, any>): BaseRadarLpReconciliationResult {
  const lpControl = scan.lpControl && typeof scan.lpControl === 'object' ? scan.lpControl as Record<string, unknown> : {}
  const evidence = Array.isArray(lpControl.evidence) ? [...lpControl.evidence as string[]] : []
  const lpModelProofRaw = scan.lpModelProof && typeof scan.lpModelProof === 'object' ? scan.lpModelProof as Record<string, unknown> : null

  // 0. Normalize the fallback market pool identity (no provider calls — re-derived
  // from fields already present on the scan result).
  const fallbackPoolIdentity = normalizeBaseRadarFallbackPoolIdentity(scan)

  // 1. Reconcile the canonical model from the priority-ordered sources. A fallback
  // pool's dex-based model hint is used only when it has a real pair address.
  const displayLpModel = reconcileLpModel([
    lpControl.displayLpModel,
    scan.displayLpModel,
    scan.lpControlRead?.selectedPoolModel,
    lpControl.primaryPoolType,
    lpModelProofRaw?.model,
    fallbackPoolIdentity.pairAddress ? fallbackPoolIdentity.modelHint : null,
  ])

  let proofApplicability: LpProofApplicability
  let lockBurnApplicable: boolean
  let standardLockApplies: boolean
  let lpModelProofModel: string

  if (displayLpModel === 'concentrated_liquidity') {
    proofApplicability = 'not_applicable'
    lockBurnApplicable = false
    standardLockApplies = false
    lpModelProofModel = 'concentrated'
  } else if (displayLpModel === 'erc20_lp_token') {
    proofApplicability = 'applicable'
    lockBurnApplicable = true
    standardLockApplies = true
    const existing = asString(lpModelProofRaw?.model)
    lpModelProofModel = existing && existing.toLowerCase() !== 'concentrated' ? existing : 'constant_product'
  } else {
    proofApplicability = typeof lpControl.proofApplicability === 'string' ? lpControl.proofApplicability as LpProofApplicability : 'unknown'
    lockBurnApplicable = Boolean(lpControl.lockBurnApplicable)
    standardLockApplies = Boolean(lpModelProofRaw?.standardLockApplies)
    lpModelProofModel = asString(lpModelProofRaw?.model) ?? 'unknown'
  }

  const lpModelProof = lpModelProofRaw
    ? { model: lpModelProofModel, dexName: asString(lpModelProofRaw.dexName), standardLockApplies }
    : null

  // 2. Reconcile lpEvidenceSummary's "Pool model: ..." line with the final model.
  let lpEvidenceSummary: string[] | null = Array.isArray(scan.lpEvidenceSummary) ? [...scan.lpEvidenceSummary as string[]] : null
  if (lpEvidenceSummary) {
    lpEvidenceSummary = lpEvidenceSummary.map((line) =>
      /^Pool model:/i.test(line) ? `Pool model: ${lpModelProofModel}` : line,
    )
  } else {
    const liquidity = typeof scan.liquidityUsd === 'number' && Number.isFinite(scan.liquidityUsd)
      ? `$${scan.liquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
      : 'unknown'
    lpEvidenceSummary = [
      `Pool model: ${lpModelProofModel}`,
      `Liquidity: ${liquidity}`,
      `Proof applicability: ${proofApplicability}`,
      `Proof status: ${scan.lpProofStatus ?? 'open_check'}`,
      `Migration: ${scan.lpMigrationProof?.status ?? 'unknown'}`,
    ]
  }

  // 3. Sanitize CORTEX pool-structure copy for concentrated primaries.
  let cortexLpRead: Record<string, unknown> | null = scan.cortexLpRead && typeof scan.cortexLpRead === 'object' ? { ...scan.cortexLpRead as Record<string, unknown> } : null
  if (cortexLpRead && displayLpModel === 'unknown') {
    cortexLpRead.riskSummary = 'Market activity was detected, but the pool model could not be confirmed from fallback evidence.'
  }

  if (cortexLpRead && displayLpModel === 'concentrated_liquidity') {
    for (const [key, value] of Object.entries(cortexLpRead)) {
      if (typeof value === 'string') cortexLpRead[key] = sanitizeConcentratedCortexText(value)
    }
  }

  // 4. Determine the primary pool's identity (address or pool id) to detect a
  // "secondary" pool that is actually the same pool as the primary. When lpControl
  // never resolved a primary pool, fall back to the normalized fallback pool identity
  // so pool/liquidity evidence Base Radar already has carries into LP/rug risk.
  let primaryAddr = asAddress(lpControl.primaryMarketPool)
  let primaryId = asString(lpControl.primaryMarketPoolId)?.toLowerCase() ?? null
  let usedFallbackPoolIdentity = false
  if (!primaryAddr && !primaryId && fallbackPoolIdentity.pairAddress) {
    primaryAddr = fallbackPoolIdentity.pairAddress
    usedFallbackPoolIdentity = true
  }

  const secondaryRaw = lpControl.secondaryLpControlSignals && typeof lpControl.secondaryLpControlSignals === 'object'
    ? lpControl.secondaryLpControlSignals as Record<string, unknown>
    : null
  const secondaryAddrFromSignal = asAddress(secondaryRaw?.poolAddress)
  const secondaryAddrFromEvidence = (() => {
    const line = extractEvidenceValue(evidence, 'Secondary ERC-20 LP exposure pool: ')
    if (!line) return null
    const addr = line.split(' ')[0]
    return asAddress(addr)
  })()
  const secondaryAddr = secondaryAddrFromSignal ?? secondaryAddrFromEvidence

  const secondaryMatchesPrimary = Boolean(
    secondaryAddr && ((primaryAddr && secondaryAddr === primaryAddr) || (primaryId && secondaryAddr === primaryId)),
  )

  // A "real" secondary pool is a different ERC-20-LP-compatible pool with its own
  // resolved address — not the primary pool, and not a "none" placeholder.
  const hasRealSecondaryPool = Boolean(secondaryAddr) && !secondaryMatchesPrimary

  const secondaryLpControlSignals = hasRealSecondaryPool ? (secondaryRaw ?? null) : null

  // 5. Reconcile evidence lines.
  let reconciledEvidence = evidence

  // 5a. Drop fake secondary-exposure lines unless a real, different ERC-20 LP pool
  // address exists (covers "secondary pool equals primary" and "secondary pool: none").
  if (!hasRealSecondaryPool) {
    reconciledEvidence = reconciledEvidence.filter((line) =>
      !/^Secondary ERC-20 LP exposure (pair|pool):/.test(line)
      && !/^Secondary exposure reason:/.test(line)
      && !/^Secondary pool differs from primary concentrated pool$/.test(line),
    )
  }

  // 5b. Fix "Market primary pair: unknown" using the best available pair label.
  const marketPairLine = extractEvidenceValue(reconciledEvidence, 'Market primary pair: ')
  if (marketPairLine && /^unknown$/i.test(marketPairLine)) {
    const fallbackPair =
      extractEvidenceValue(reconciledEvidence, 'LP verification pair: ')
      ?? extractEvidenceValue(reconciledEvidence, 'Secondary ERC-20 LP exposure pair: ')
      ?? asString(secondaryRaw?.pair)
    if (fallbackPair && !/^unknown$/i.test(fallbackPair)) {
      reconciledEvidence = reconciledEvidence.map((line) =>
        line.startsWith('Market primary pair: ') ? `Market primary pair: ${fallbackPair}` : line,
      )
    }
  }

  // 5c. For concentrated primary pools, add canonical "Primary pool" identity lines
  // (pool=/poolId=/dex=/poolType=) and never leave "pool=unknown".
  if (displayLpModel === 'concentrated_liquidity') {
    const resolvedPair = extractEvidenceValue(reconciledEvidence, 'Market primary pair: ') ?? fallbackPoolIdentity.pairLabel ?? 'unknown'
    const dex = asString(lpControl.primaryPoolDex) ?? fallbackPoolIdentity.dexId ?? 'unknown'
    const identityLines: string[] = [`Primary pool: ${resolvedPair} (concentrated)`]
    if (primaryAddr) identityLines.push(`pool=${primaryAddr}`)
    else if (primaryId) identityLines.push(`poolId=${primaryId}`)
    identityLines.push(`dex=${dex}`, 'poolType=concentrated')

    // Replace the legacy "Primary market pool[:| ID:] ..." line(s) with the canonical
    // identity lines, and drop any stray "pool=unknown" left by upstream logic.
    reconciledEvidence = reconciledEvidence.filter((line) =>
      !/^Primary market pool(?: ID)?:/.test(line) && line !== 'pool=unknown',
    )
    reconciledEvidence = [...reconciledEvidence, ...identityLines]
  }

  // 5c2. For erc20_lp_token pools whose identity came from fallback market data
  // (lpControl never resolved a primary pool), add the same "Market primary pair" /
  // "Primary market pool" identity lines a normal LP-control scan would produce.
  if (displayLpModel === 'erc20_lp_token' && usedFallbackPoolIdentity) {
    if (!extractEvidenceValue(reconciledEvidence, 'Market primary pair: ')) {
      reconciledEvidence = [...reconciledEvidence, `Market primary pair: ${fallbackPoolIdentity.pairLabel ?? 'unknown'}`]
    }
    if (!reconciledEvidence.some((line) => /^Primary market pool:/.test(line))) {
      reconciledEvidence = [...reconciledEvidence, `Primary market pool: ${primaryAddr} (${fallbackPoolIdentity.dexId ?? 'v2'})`]
    }
  }

  // 5d. For unknown LP models where a DEX is known from market data, surface
  // "DEX: <name> / Pool model: unknown / Pair identity: open check" instead of
  // generic "DEX metadata: not_indexed" / "Market primary pair: ?/?" lines.
  if (displayLpModel === 'unknown') {
    const dexName = asString(scan.primaryDexName) ?? asString(lpControl.primaryPoolDex) ?? fallbackPoolIdentity.dexName
    if (dexName) {
      reconciledEvidence = reconciledEvidence.filter((line) =>
        !/^DEX metadata:/.test(line) && !/^Market primary pair: \?\/\?$/.test(line),
      )
      reconciledEvidence = [
        ...reconciledEvidence,
        `DEX: ${formatDexLabel(dexName)}`,
        'Pool model: unknown',
        'Pair identity: open check',
      ]
    }
  }

  // 6. Build a clear LP proof display for V2/ERC-20 LP and concentrated pools.
  // Avoids leaving a generic "Open Check" when a check actually ran and found
  // no lock/burn proof for an erc20_lp_token pool with a known pool address.
  let lpProofDisplay: LpProofDisplay | null = null
  const lockBurnConfirmed = scan.lpLockStatus === 'locked' || scan.lpLockStatus === 'burned'
  const hasPrimaryPoolIdentity = Boolean(primaryAddr || primaryId)

  if (displayLpModel === 'erc20_lp_token' && hasPrimaryPoolIdentity && !lockBurnConfirmed) {
    const lpControllerSharePercent = extractLpControllerSharePercent(evidence)
    lpProofDisplay = {
      proofLabel: 'Checked',
      lockStatus: 'No lock detected',
      lockAmount: 'None found',
      unlockTime: 'No unlock schedule found',
      burnProof: 'Not burned',
      controller: lpControllerSharePercent != null ? `Wallet controlled · ${lpControllerSharePercent}%` : 'Wallet controlled',
      exitRisk: 'High — LP can be removed unless locked or burned',
    }
  } else if (displayLpModel === 'concentrated_liquidity') {
    lpProofDisplay = {
      proofLabel: 'Position verification required',
      lockStatus: 'Protocol-specific',
      lockAmount: null,
      unlockTime: 'Position check required',
      burnProof: null,
      controller: null,
      exitRisk: null,
    }
  }

  // Fallback market evidence (liquidity/volume/dex/age) exists, but no pair address
  // could be resolved — pool identity itself is the open item, not the LP proof.
  const pairIdentityOpenCheck = !hasPrimaryPoolIdentity && reconciledEvidence.includes('Pair identity: open check')

  if (!lpProofDisplay && pairIdentityOpenCheck) {
    lpProofDisplay = {
      proofLabel: 'Pair identity open check',
      lockStatus: 'Pair identity open check',
      lockAmount: null,
      unlockTime: 'Pair identity open check',
      burnProof: null,
      controller: null,
      exitRisk: null,
    }
  }

  // 7. Rug/LP risk: never leave a generic "Open Check" when facts exist.
  let rugRiskDisplay: { status: string; reason: string } | null = null
  if (displayLpModel === 'erc20_lp_token' && hasPrimaryPoolIdentity && !lockBurnConfirmed) {
    rugRiskDisplay = {
      status: 'checked_dangerous',
      reason: 'No lock or burn proof found for the LP token; exit risk is high if the wallet/team controls the LP.',
    }
  } else if (displayLpModel === 'concentrated_liquidity') {
    rugRiskDisplay = {
      status: 'position_control_open_check',
      reason: 'Concentrated-liquidity position control requires protocol-specific verification.',
    }
  } else if (pairIdentityOpenCheck) {
    rugRiskDisplay = {
      status: 'pool_identity_open_check',
      reason: 'Missing pair address — pool identity could not be confirmed.',
    }
  }

  // 8. Pool address presence and the simulation pair address. When fallback market
  // evidence exists but no pair address resolved, pass `null` (not `undefined`) so
  // getRadarSimulationDisplay reports "missing pair address" instead of skipping.
  const poolAddressPresent = Boolean(primaryAddr || primaryId)
  const simulationPairAddress: string | null | undefined = primaryAddr
    ? primaryAddr
    : pairIdentityOpenCheck
      ? null
      : undefined

  return {
    displayLpModel,
    proofApplicability,
    lockBurnApplicable,
    lpModelProof,
    lpEvidenceSummary,
    cortexLpRead,
    evidence: reconciledEvidence,
    secondaryLpControlSignals,
    lpProofDisplay,
    primaryMarketPool: primaryAddr,
    primaryMarketPoolId: primaryId,
    poolAddressPresent,
    fallbackPoolIdentity,
    simulationPairAddress,
    rugRiskDisplay,
  }
}
