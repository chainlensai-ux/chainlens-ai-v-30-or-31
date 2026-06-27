export type LpControllerIntelStatus =
  | 'wallet_controlled'
  | 'locked'
  | 'burned'
  | 'protected'
  | 'protocol_controlled'
  | 'concentrated_liquidity'
  | 'open_check'
  | 'no_pool'

export type LpControllerIntelProof = 'confirmed' | 'open_check' | 'not_applicable'

export interface LpControllerIntelInput {
  lpControl?: Record<string, unknown> | null
  lpControlRead?: Record<string, unknown> | null
  selectedPool?: Record<string, unknown> | null
  lpExitRisk?: string | null
  liquidityDepthRisk?: string | null
  lpMigrationProof?: Record<string, unknown> | null
  lpEvidenceGaps?: Array<{ id?: unknown; label?: unknown }> | null
  lpMeta?: Record<string, unknown> | null
  lpDataMode?: string | null
  /** Real attempted position/controller proof for concentrated-liquidity pools (V3/V4/etc) —
   * when present, this is the authoritative source for the controller label/summary instead of
   * a static "Position verification required" placeholder. */
  concentratedPositionProof?: {
    status: 'verified' | 'partial' | 'not_found' | 'not_supported' | 'failed' | 'open_check'
    confidence?: string | null
    topPositionOwner?: string | null
    topPositionOwnerType?: string | null
    topPositionSharePercent?: number | null
    controllerRisk?: string | null
    reason?: string | null
    /** Concrete pool model (e.g. "uniswap_v4") so labels name the real protocol instead of
     * defaulting to "Uniswap V4" for every concentrated-liquidity pool. */
    poolModel?: string | null
    /** Verified position-manager address (e.g. Uniswap V3's NonfungiblePositionManager on this
     * chain), when resolved — distinguishes "manager unsupported" from "manager resolved but
     * ownership not yet verified" in the partial-status summary. */
    positionManager?: string | null
    poolId?: string | null
    poolIdentity?: string | null
    poolIdentityType?: 'contract' | 'pool_id' | 'unknown' | null
    /** Deterministic public ownership-proof state — see ConcentratedOwnershipStatus in lpProof.ts. */
    ownershipStatus?: string | null
    ownershipDebug?: { source?: string | null; type?: string | null; confidence?: string | null; proofPath?: string | null } | null
    /** Bounded sample-only owner evidence (Stage 14) — never claims full-pool coverage. */
    samplingStatus?: 'not_attempted' | 'attempted_no_candidates' | 'sampled_partial' | 'failed' | null
    sampledOwners?: Array<unknown> | null
  } | null
}

export interface LpControllerIntel {
  status: LpControllerIntelStatus
  controller: string | null
  controllerType: string
  controllerLabel: string
  controllerSharePercent: number | null
  poolAddress: string | null
  /** Set when the pool is identified by a Uniswap V4-style 32-byte pool ID rather than a
   * deployed contract address — never surfaced as poolAddress so the UI doesn't present a
   * pool ID as a normal EVM contract address. */
  poolId: string | null
  poolIdentity: string | null
  poolIdentityType: 'contract' | 'pool_id' | 'unknown'
  poolPair: string | null
  poolLiquidityUsd: number | null
  controlProof: LpControllerIntelProof
  lockBurnProof: LpControllerIntelProof
  exitRisk: string
  liquidityDepth: string
  migrationRisk: string
  confidence: string
  summary: string
  signals: string[]
  evidenceGaps: string[]
  nextActions: string[]
  /** Concise label for the Control Proof UI field — reflects the real attempted position-proof
   * result for concentrated pools instead of a static "Position verification required". */
  controlProofLabel: string
  /** Mirrors the concentrated position-proof status/confidence/owner fields so consumers don't
   * need to separately thread `concentratedPositionProof` through to read them. Null when no
   * concentrated-position proof was attempted (e.g. a plain V2 pool). */
  positionProofStatus: string | null
  positionProofConfidence: string | null
  topPositionOwner: string | null
  topPositionSharePercent: number | null
  controllerRisk: string | null
  /** Deterministic ownership-proof state (e.g. "ownership_verified_burned") and its human label
   * (e.g. "Burned"). Null when no concentrated-position proof was attempted. */
  positionOwnershipStatus: string | null
  positionOwnershipLabel: string | null
  ownershipDebug: { source: string | null; type: string | null; confidence: string | null; proofPath: string | null } | null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.replace(/[$,%]/g, ''))
    return Number.isFinite(n) ? n : null
  }
  return null
}

function roundPercent(value: number | null): number | null {
  return value == null ? null : Math.round(value * 100) / 100
}

function evidencePercent(evidence: unknown, keys: string[]): number | null {
  if (!Array.isArray(evidence)) return null
  for (const key of keys) {
    const line = evidence.find((item) => typeof item === 'string' && item.toLowerCase().startsWith(`${key.toLowerCase()}=`))
    if (typeof line === 'string') {
      const pct = asNumber(line.split('=').slice(1).join('='))
      if (pct != null) return pct
    }
  }
  return null
}

function normalizeControllerType(value: unknown, status: string | null): string {
  const raw = asString(value)?.toLowerCase() ?? null
  if (raw === 'lockcontract') return 'lock_contract'
  if (raw === 'wallet' || raw === 'contract' || raw === 'burn' || raw === 'unknown') return raw
  if (status === 'team_controlled') return 'wallet'
  if (status === 'locked') return 'lock_contract'
  if (status === 'burned') return 'burn'
  if (status === 'protocol' || status === 'protocol_managed') return 'protocol'
  if (status === 'concentrated_liquidity') return 'concentrated_liquidity'
  return 'unknown'
}

// Renders the Control Proof UI line from a real attempted concentrated-liquidity
// position-proof result, never the static "Position verification required" placeholder.
function concentratedPoolModelLabel(poolModel: string | null | undefined): string {
  switch (poolModel) {
    case 'uniswap_v4': return 'Uniswap V4'
    case 'uniswap_v3': return 'Uniswap V3'
    case 'slipstream': return 'Aerodrome Slipstream'
    case 'aerodrome': return 'Aerodrome'
    default: return 'concentrated-liquidity'
  }
}

function concentratedControlProofLabel(proof: LpControllerIntelInput['concentratedPositionProof']): string {
  if (!proof) return 'Liquidity ownership is still being verified.'
  switch (proof.status) {
    case 'verified': {
      const who = proof.topPositionOwner ?? proof.topPositionOwnerType ?? 'the resolved owner'
      const pct = typeof proof.topPositionSharePercent === 'number' && Number.isFinite(proof.topPositionSharePercent)
        ? ` controls ${proof.topPositionSharePercent.toFixed(2)}% of active liquidity`
        : ''
      return `Verified — ${who}${pct}`
    }
    case 'partial': {
      const hasSampledEvidence = proof.samplingStatus === 'sampled_partial' && Array.isArray(proof.sampledOwners) && proof.sampledOwners.length > 0
      if (hasSampledEvidence) {
        return 'The Uniswap V3 position manager was resolved and sampled position-owner evidence was found, but full-pool ownership is not yet verified.'
      }
      return proof.positionManager
        ? `The ${concentratedPoolModelLabel(proof.poolModel)} position manager was resolved and the pool is active, but ChainLens could not verify the largest liquidity owner from current evidence.`
        : 'The pool is confirmed active but ownership of concentrated liquidity positions could not be fully resolved.'
    }
    case 'not_supported':
      return `The largest liquidity owner could not be verified for this ${concentratedPoolModelLabel(proof.poolModel)} pool.`
    case 'not_found':
      return 'The pool is confirmed active with zero current liquidity, so there is no position to attribute ownership to.'
    case 'failed':
      return 'Liquidity ownership is still being verified.'
    case 'open_check':
    default:
      return 'Liquidity ownership is still being verified.'
  }
}

function concentratedControllerLabel(proof: LpControllerIntelInput['concentratedPositionProof']): string {
  if (!proof) return 'Liquidity ownership is still being verified.'
  switch (proof.status) {
    case 'verified': return 'Liquidity ownership verified'
    case 'partial': return 'Liquidity ownership is still being verified.'
    case 'not_supported': return 'The largest liquidity owner could not be verified.'
    case 'failed': return 'Liquidity ownership is still being verified.'
    case 'not_found': return 'No active liquidity position currently exists.'
    case 'open_check':
    default: return 'Liquidity ownership is still being verified.'
  }
}

// Renders "Position Ownership" UI text from the deterministic ownershipStatus taxonomy
// (lpProof.ts `ConcentratedOwnershipStatus`) — never set independently of that status.
function positionOwnershipLabel(ownershipStatus: string | null | undefined): string | null {
  switch (ownershipStatus) {
    case 'ownership_verified_team': return 'Team Controlled'
    case 'ownership_verified_protocol': return 'Protocol Controlled'
    case 'ownership_verified_multisig': return 'Multisig Controlled'
    case 'ownership_verified_locked': return 'Locked'
    case 'ownership_verified_burned': return 'Burned'
    case 'ownership_verified_contract': return 'Contract Controlled'
    case 'ownership_verified': return 'Ownership Verified'
    case 'ownership_open_check': return 'Open Check'
    case 'ownership_unavailable_with_reason': return 'Open Check'
    default: return null
  }
}

function controllerLabel(type: string): string {
  switch (type) {
    case 'wallet': return 'Wallet controller'
    case 'lock_contract': return 'Lock contract'
    case 'burn': return 'Burn address'
    case 'protocol': return 'Protocol controller'
    case 'concentrated_liquidity': return 'Liquidity ownership is still being verified.'
    case 'contract': return 'Contract controller'
    default: return 'Liquidity ownership is still being verified.'
  }
}

function isNotApplicableModel(lpControl: Record<string, unknown>, selectedPool: Record<string, unknown>): boolean {
  const status = asString(lpControl.status)
  const model = asString(lpControl.displayLpModel) ?? asString(selectedPool.model)
  const applicability = asString(lpControl.proofApplicability)
  return status === 'protocol' || status === 'protocol_managed' || status === 'concentrated_liquidity'
    || model === 'concentrated_liquidity' || model === 'protocol_or_gauge' || model === 'concentrated' || model === 'stableswap'
    || applicability === 'not_applicable'
}

function normalizeExitRisk(value: string | null): string {
  if (value === 'monitor') return 'watch'
  if (value === 'medium') return 'monitor'
  if (value === 'high' || value === 'watch' || value === 'low' || value === 'open_check') return value
  return 'open_check'
}

function normalizeLiquidityDepth(value: string | null, liquidityUsd: number | null): string {
  if (value === 'low') return 'deep'
  if (value === 'medium') return 'moderate'
  if (value === 'high') return 'thin'
  if (liquidityUsd != null) {
    if (liquidityUsd > 500_000) return 'deep'
    if (liquidityUsd > 50_000) return 'moderate'
    if (liquidityUsd > 0) return 'thin'
  }
  return 'open_check'
}

function normalizeMigrationRisk(value: string | null): string {
  if (value === 'flagged') return 'high'
  if (value === 'watch') return 'medium'
  if (value === 'low') return 'low'
  return 'open_check'
}

function buildStatus(lpControl: Record<string, unknown>, controllerTypeValue: string, notApplicable: boolean): LpControllerIntelStatus {
  const status = asString(lpControl.status)
  const model = asString(lpControl.displayLpModel)
  if (status === 'burned') return 'burned'
  if (status === 'locked') return 'locked'
  if (status === 'concentrated_liquidity' || model === 'concentrated_liquidity') return 'concentrated_liquidity'
  if (status === 'protocol' || status === 'protocol_managed' || model === 'protocol_or_gauge') return 'protocol_controlled'
  if (status === 'no_pool') return 'no_pool'
  if (controllerTypeValue === 'wallet' || status === 'team_controlled') return 'wallet_controlled'
  if (notApplicable) return 'concentrated_liquidity'
  return 'open_check'
}

function buildSummary(params: {
  status: LpControllerIntelStatus
  share: number | null
  pair: string | null
  lockBurnProof: LpControllerIntelProof
  liquidityDepth: string
}): string {
  const poolLabel = params.pair ? `The selected ${params.pair} LP` : 'The selected LP'
  if (params.status === 'burned') return `${poolLabel} shows burn evidence, so standard ERC-20 LP removal risk is reduced by confirmed burn proof. Liquidity depth is ${params.liquidityDepth}.`
  if (params.status === 'locked' || params.status === 'protected') return `${poolLabel} shows active lock evidence, so standard ERC-20 LP removal risk is reduced while that lock remains valid. Liquidity depth is ${params.liquidityDepth}.`
  if (params.status === 'protocol_controlled') return `${poolLabel} is protocol-controlled. Standard ERC-20 LP lock/burn proof is not applicable to this pool model, so liquidity control should be reviewed through the protocol-specific position or governance path.`
  if (params.status === 'concentrated_liquidity') return `${poolLabel} uses concentrated liquidity. Standard ERC-20 LP-token lock/burn proof does not apply to the primary concentrated-liquidity pool. Liquidity control requires protocol-specific position checks.`
  if (params.status === 'wallet_controlled') {
    const share = params.share != null ? ` with about ${params.share.toFixed(2)}% of the LP supply` : ''
    const lockText = params.lockBurnProof === 'confirmed' ? 'lock/burn proof is confirmed' : 'lock/burn proof is not confirmed'
    return `${poolLabel} is controlled by a dominant wallet${share}; ${lockText}. This is a liquidity-control signal and should be monitored without assuming intent.`
  }
  if (params.status === 'no_pool') return 'No active LP pool was selected, so LP controller intelligence is not applicable until liquidity appears.'
  return `${poolLabel} has partial LP evidence only. Lock/burn proof and controller dominance remain open checks until stronger on-chain evidence is available.`
}

export function buildLpControllerIntel(input: LpControllerIntelInput): LpControllerIntel {
  const lpControl = input.lpControl ?? {}
  const selectedPool = input.selectedPool ?? {}
  const lpMeta = input.lpMeta ?? {}
  const lpMigrationProof = input.lpMigrationProof ?? {}
  const statusRaw = asString(lpControl.status)
  const notApplicable = isNotApplicableModel(lpControl, selectedPool)
  const controllerTypeValue = normalizeControllerType(lpControl.lpControllerType, statusRaw)
  const status = buildStatus(lpControl, controllerTypeValue, notApplicable)
  const controller = asString(lpControl.lpController) && asString(lpControl.lpController) !== controllerTypeValue ? asString(lpControl.lpController) : null
  const share = roundPercent(
    evidencePercent(lpControl.evidence, ['top_share', 'owner_lp_share', 'locker_share', 'burn_share'])
    ?? asNumber(lpMeta.teamPercent)
    ?? asNumber(lpMeta.controllerSharePercent)
  )
  // A V4-style 32-byte pool ID is not a deployed contract address — keep it out of poolAddress
  // so the UI never presents a pool ID as a normal EVM contract address.
  const isContractAddress = (value: string | null): boolean => value != null && /^0x[a-f0-9]{40}$/i.test(value)
  const rawPoolIdentity = asString(selectedPool.address) ?? asString(selectedPool.poolId) ?? asString(lpControl.primaryMarketPool) ?? asString(lpControl.primaryMarketPoolId) ?? asString(lpControl.verificationPool)
  const cppPoolIdentity = asString(input.concentratedPositionProof?.poolIdentity) ?? asString(input.concentratedPositionProof?.poolId)
  const poolAddress = isContractAddress(rawPoolIdentity) ? rawPoolIdentity : null
  const poolId = !isContractAddress(rawPoolIdentity) ? (rawPoolIdentity ?? cppPoolIdentity) : null
  const poolIdentity = poolAddress ?? poolId
  const poolIdentityType: 'contract' | 'pool_id' | 'unknown' = poolAddress ? 'contract' : poolId ? 'pool_id' : 'unknown'
  const poolPair = asString(selectedPool.pair)
  const poolLiquidityUsd = asNumber(selectedPool.liquidityUsd)
  const lockStatus = asString(lpControl.lockStatus)
  const burnStatus = asString(lpControl.burnStatus)
  // For concentrated-liquidity pools, controller is null and there is no ERC20
  // LP-holder controller to prove — "confirmed" here would misleadingly read as
  // confirmed controller/ownership proof. The pool *model* classification is
  // confirmed, but controller proof does not apply to this pool model.
  const controlProof: LpControllerIntelProof = status === 'no_pool' ? 'open_check'
    : status === 'open_check' ? 'open_check'
    : status === 'concentrated_liquidity' ? 'not_applicable'
    : 'confirmed'
  const lockBurnProof: LpControllerIntelProof = notApplicable ? 'not_applicable'
    : (lockStatus === 'locked' || burnStatus === 'burned' || status === 'locked' || status === 'burned') ? 'confirmed'
    : 'open_check'
  const exitRisk = normalizeExitRisk(asString(input.lpExitRisk))
  const liquidityDepth = normalizeLiquidityDepth(asString(input.liquidityDepthRisk), poolLiquidityUsd)
  const migrationRisk = normalizeMigrationRisk(asString(lpMigrationProof.status))
  const confidence = asString(lpControl.confidence) ?? 'low'
  const signals: string[] = []
  if (poolIdentity) signals.push('selected LP pool found')
  if (controllerTypeValue === 'wallet') signals.push('controller wallet detected')
  else if (controllerTypeValue === 'protocol') signals.push('protocol-controlled pool detected')
  else if (status === 'concentrated_liquidity') signals.push('concentrated-liquidity pool detected')
  if (status === 'concentrated_liquidity'
    && input.concentratedPositionProof?.samplingStatus === 'attempted_no_candidates') {
    signals.push('bounded owner sampling not available from current evidence')
  }
  if (share != null && share >= 50) signals.push('dominant LP share detected')
  if (lockBurnProof === 'confirmed' && (lockStatus === 'locked' || status === 'locked')) signals.push('lock proof confirmed')
  else if (lockBurnProof === 'not_applicable') signals.push('protocol-specific lock proof model')
  else signals.push('lock proof not confirmed')
  if (lockBurnProof === 'confirmed' && (burnStatus === 'burned' || status === 'burned')) signals.push('burn proof confirmed')
  else if (lockBurnProof === 'not_applicable') signals.push('protocol-specific burn proof model')
  else signals.push('burn proof not confirmed')
  if (liquidityDepth === 'deep') signals.push('liquidity depth is deep')
  else if (liquidityDepth === 'moderate') signals.push('liquidity depth is moderate')
  else if (liquidityDepth === 'thin') signals.push('liquidity depth is thin')

  // Structured, concentrated-position-specific gaps (POSITION_MANAGER_UNSUPPORTED,
  // TOP_LIQUIDITY_OWNER_NOT_VERIFIED, ACTIVE_POSITIONS_NOT_INDEXED) supersede the generic
  // "largest liquidity owner"/"active liquidity positions" wording below — when they're present,
  // pushing both would surface the same gap twice under two different labels.
  const _structuredConcentratedGapIds = new Set(['POSITION_MANAGER_UNSUPPORTED', 'TOP_LIQUIDITY_OWNER_NOT_VERIFIED', 'ACTIVE_POSITIONS_NOT_INDEXED'])
  const hasStructuredConcentratedGaps = Array.isArray(input.lpEvidenceGaps) && input.lpEvidenceGaps.some((g) => _structuredConcentratedGapIds.has(asString(g.id) ?? ''))
  // Same dedup for the standard ERC-20 LP lock/burn/controller gaps — buildEvidenceGaps() already
  // produces humanized LOCK_STATUS_UNVERIFIED/BURN_PROOF_UNCONFIRMED/CONTROLLER_UNKNOWN labels for
  // this exact case, so the hardcoded strings below would otherwise duplicate the same gap.
  const _structuredLpLockBurnGapIds = new Set(['LOCK_STATUS_UNVERIFIED', 'BURN_PROOF_UNCONFIRMED'])
  const hasStructuredLpLockBurnGaps = Array.isArray(input.lpEvidenceGaps) && input.lpEvidenceGaps.some((g) => _structuredLpLockBurnGapIds.has(asString(g.id) ?? ''))

  const evidenceGaps: string[] = []
  if (lockBurnProof === 'open_check') {
    if (!hasStructuredLpLockBurnGaps) evidenceGaps.push('active LP lock not confirmed', 'LP burn proof not confirmed')
  } else if (lockBurnProof === 'not_applicable') {
    if (!hasStructuredConcentratedGaps) {
      evidenceGaps.push('protocol-specific liquidity position verification required')
      if (input.concentratedPositionProof && input.concentratedPositionProof.status !== 'verified' && input.concentratedPositionProof.status !== 'not_found') {
        for (const gap of ['the largest liquidity owner is not yet verified', 'the number of active liquidity positions is not yet verified']) {
          if (!evidenceGaps.includes(gap)) evidenceGaps.push(gap)
        }
      }
    }
  }
  if (Array.isArray(input.lpEvidenceGaps)) {
    for (const gap of input.lpEvidenceGaps) {
      const label = asString(gap.label)
      if (label && !evidenceGaps.includes(label)) evidenceGaps.push(label)
    }
  }

  const nextActions = lockBurnProof === 'not_applicable'
    ? ['review protocol-specific liquidity positions', 'monitor pool liquidity and position changes', 'rescan after liquidity changes']
    : [
      'monitor controller wallet for LP movement',
      'verify lock/burn evidence on-chain',
      'rescan after liquidity changes',
      'treat LP as removable until lock/burn proof is confirmed',
    ]

  return {
    status,
    controller,
    controllerType: controllerTypeValue,
    controllerLabel: status === 'concentrated_liquidity'
      ? concentratedControllerLabel(input.concentratedPositionProof)
      : controllerLabel(controllerTypeValue),
    controllerSharePercent: share,
    poolAddress,
    poolId,
    poolIdentity,
    poolIdentityType,
    poolPair,
    poolLiquidityUsd,
    controlProof,
    lockBurnProof,
    exitRisk,
    liquidityDepth,
    migrationRisk,
    confidence,
    summary: buildSummary({ status, share, pair: poolPair, lockBurnProof, liquidityDepth }),
    signals,
    evidenceGaps,
    nextActions,
    controlProofLabel: status === 'concentrated_liquidity'
      ? concentratedControlProofLabel(input.concentratedPositionProof)
      : (controlProof === 'confirmed' ? 'Confirmed' : controlProof === 'not_applicable' ? 'Not Applicable' : 'Open Check'),
    positionProofStatus: input.concentratedPositionProof?.status ?? null,
    positionProofConfidence: asString(input.concentratedPositionProof?.confidence) ?? null,
    topPositionOwner: asString(input.concentratedPositionProof?.topPositionOwner) ?? null,
    topPositionSharePercent: asNumber(input.concentratedPositionProof?.topPositionSharePercent ?? null),
    controllerRisk: asString(input.concentratedPositionProof?.controllerRisk) ?? null,
    positionOwnershipStatus: asString(input.concentratedPositionProof?.ownershipStatus) ?? null,
    positionOwnershipLabel: positionOwnershipLabel(input.concentratedPositionProof?.ownershipStatus),
    ownershipDebug: input.concentratedPositionProof?.ownershipDebug ? {
      source: asString(input.concentratedPositionProof.ownershipDebug.source),
      type: asString(input.concentratedPositionProof.ownershipDebug.type),
      confidence: asString(input.concentratedPositionProof.ownershipDebug.confidence),
      proofPath: asString(input.concentratedPositionProof.ownershipDebug.proofPath),
    } : null,
  }
}

export type LpControllerType = 'wallet' | 'contract' | 'burn' | 'lockContract' | 'unknown'

export interface LpControllerIdentityInput {
  /** lpControl.status from the LP-holder/controller derivation. */
  status?: string | null
  /** lpControl.evidence — e.g. 'top_holder=0x..', 'top_share=82.45%', 'owner_lp_share=...'. */
  evidence?: string[] | null
  /** Controller type returned by the on-chain LP lock/burn proof scan ('unknown' when not run/inconclusive). */
  lpControllerFromProof: LpControllerType
  /** Contract owner address, used when evidence only proves an owner-held LP share. */
  ownerAddr?: string | null
}

export interface LpControllerIdentity {
  lpControllerType: LpControllerType
  lpControllerAddress: string | null
  lpController: string
}

// Single authoritative LP-controller identity derivation, shared by the API route and
// tests, so a dominant LP holder discovered anywhere in the scan (even when lpControl.status
// stops short of the strict 80% "team_controlled" threshold, e.g. a "partial" result from a
// flaky holder-data fetch) is consistently reused for lpControl.lpController,
// lpControllerIntel.controller/controllerSharePercent, and lpMovementWatch.controller —
// instead of collapsing to an "unknown" controller.
export function resolveLpControllerIdentity(input: LpControllerIdentityInput): LpControllerIdentity {
  const evidence = input.evidence ?? []
  const extractPct = (prefix: string): number | null => {
    const line = evidence.find((e) => e.startsWith(`${prefix}=`))
    if (!line) return null
    const value = parseFloat(line.split('=').slice(1).join('=').replace('%', ''))
    return Number.isFinite(value) ? value : null
  }
  const dominantSharePct = extractPct('owner_lp_share') ?? extractPct('top_share')

  const lpControllerType: LpControllerType = (() => {
    if (input.lpControllerFromProof !== 'unknown') return input.lpControllerFromProof
    if (input.status === 'team_controlled') return 'wallet'
    if (input.status === 'burned') return 'burn'
    if (input.status === 'locked') return 'lockContract'
    if (dominantSharePct != null && dominantSharePct >= 50) return 'wallet'
    return input.lpControllerFromProof
  })()

  const lpControllerAddress: string | null = (() => {
    if (lpControllerType !== 'wallet') return null
    const topHolderEv = evidence.find((e) => e.startsWith('top_holder='))
    if (topHolderEv) {
      const addr = topHolderEv.split('=')[1]?.toLowerCase()
      return addr && /^0x[a-f0-9]{40}$/.test(addr) ? addr : null
    }
    if (evidence.some((e) => e.startsWith('owner_lp_share='))) return input.ownerAddr ?? null
    return null
  })()

  return {
    lpControllerType,
    lpControllerAddress,
    lpController: lpControllerAddress ?? lpControllerType,
  }
}
