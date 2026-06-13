// Central LP model reconciliation for Base Radar drawer/data shaping.
//
// The shared token-scanner pipeline can produce internally-inconsistent LP model
// signals for a single scan (e.g. lpControl.displayLpModel = concentrated_liquidity
// while lpModelProof.model = constant_product, or a "secondary" ERC-20 LP pool that
// is actually the same address as the primary pool). This module reconciles those
// signals into one canonical model before the Base Radar enrichment payload is built,
// without making any additional provider/API calls — it only re-derives from fields
// already present on the scan result.

export type ReconciledLpModel = 'concentrated_liquidity' | 'erc20_lp_token' | 'unknown'
export type LpProofApplicability = 'applicable' | 'not_applicable' | 'unknown'

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

function extractEvidenceValue(evidence: string[], prefix: string): string | null {
  const line = evidence.find((e) => e.startsWith(prefix))
  return line ? line.slice(prefix.length).trim() : null
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
}

export function reconcileBaseRadarLp(scan: Record<string, any>): BaseRadarLpReconciliationResult {
  const lpControl = scan.lpControl && typeof scan.lpControl === 'object' ? scan.lpControl as Record<string, unknown> : {}
  const evidence = Array.isArray(lpControl.evidence) ? [...lpControl.evidence as string[]] : []
  const lpModelProofRaw = scan.lpModelProof && typeof scan.lpModelProof === 'object' ? scan.lpModelProof as Record<string, unknown> : null

  // 1. Reconcile the canonical model from the priority-ordered sources.
  const displayLpModel = reconcileLpModel([
    lpControl.displayLpModel,
    scan.displayLpModel,
    scan.lpControlRead?.selectedPoolModel,
    lpControl.primaryPoolType,
    lpModelProofRaw?.model,
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
  // "secondary" pool that is actually the same pool as the primary.
  const primaryAddr = asAddress(lpControl.primaryMarketPool)
  const primaryId = asString(lpControl.primaryMarketPoolId)?.toLowerCase() ?? null

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

  const secondaryLpControlSignals = secondaryMatchesPrimary ? null : (secondaryRaw ?? null)

  // 5. Reconcile evidence lines.
  let reconciledEvidence = evidence

  // 5a. Drop fake secondary-exposure lines when the "secondary" pool is the primary pool.
  if (secondaryMatchesPrimary) {
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
    const resolvedPair = extractEvidenceValue(reconciledEvidence, 'Market primary pair: ') ?? 'unknown'
    const dex = asString(lpControl.primaryPoolDex) ?? 'unknown'
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

  return {
    displayLpModel,
    proofApplicability,
    lockBurnApplicable,
    lpModelProof,
    lpEvidenceSummary,
    cortexLpRead,
    evidence: reconciledEvidence,
    secondaryLpControlSignals,
  }
}
