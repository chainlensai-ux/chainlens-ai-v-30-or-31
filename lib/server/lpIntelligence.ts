// Shared LP pool-selection / classification layer used by Token Scanner,
// Liquidity Safety, and Base Radar enrichment so all three agree on:
//   - which pool is the canonical primary (highest-liquidity) market pool
//   - which pool (if any) is used for ERC-20 LP lock/burn proof
//   - whether standard LP lock/burn proof applies (displayLpModel / lockBurnApplicable)
//   - how a secondary V2/Aerodrome LP-control signal is reported when the
//     primary pool is concentrated/protocol liquidity (never overrides the
//     primary pool's classification — selection rules 3/4)
import { classifyPoolModel, idToAddress, type GTPool } from './lpProof'

export type LpPoolType = "v2" | "v3" | "aerodrome" | "concentrated" | "unknown"

export interface LpPoolCandidate {
  address: string | null
  liquidityUsd: number
  dexId?: string | null
  dexName?: string | null
  poolType: LpPoolType
  // true = confirmed ERC-20 LP token (V2-style, can probe burn/lock)
  // false = no ERC-20 LP token (V3/CL NFT positions, proof not applicable)
  // null = unknown (needs RPC probe)
  hasLpToken: boolean | null
  hasDexMeta?: boolean
  isValidAddress: boolean
}

export interface CanonicalPoolSelection {
  primaryPool: LpPoolCandidate | null
  primaryConcentrated: boolean
  verifyPool: LpPoolCandidate | null
  verifyPoolPresent: boolean
  v2Candidates: LpPoolCandidate[]
  protocolCandidates: LpPoolCandidate[]
}

// Selection rules 1/2: the canonical PRIMARY pool is always the highest-liquidity
// pool. The VERIFY pool is the highest-liquidity pool that is proof-applicable
// (V2/Aerodrome-V2/unknown with an ERC-20 LP token) — it may be the same pool as
// the primary, or a separate secondary pool when the primary is concentrated.
export function selectCanonicalPools(pools: LpPoolCandidate[]): CanonicalPoolSelection {
  // Sort by liquidity descending with an address tie-breaker so the canonical primary pool is
  // deterministic for the same evidence regardless of input/provider ordering.
  const sorted = [...pools].sort((a, b) => {
    const liqDiff = (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)
    if (liqDiff !== 0) return liqDiff
    return (a.address ?? "").localeCompare(b.address ?? "")
  })
  const primaryPool = sorted[0] ?? null
  const primaryConcentrated = primaryPool?.poolType === 'v3' || primaryPool?.poolType === 'concentrated'
  const isVerifiable = (p: LpPoolCandidate) =>
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

// Converts a raw GeckoTerminal pool into an LpPoolCandidate using the shared
// classifyPoolModel() — the single source of truth for Aerodrome V2 vs.
// Aerodrome Slipstream / Uniswap V3 / unknown classification.
export function gtPoolToCandidate(pool: GTPool): LpPoolCandidate {
  const dexId = pool.relationships?.dex?.data?.id ?? null
  const cls = classifyPoolModel(dexId)
  const address = (() => {
    const a = idToAddress(pool.id)
    return /^0x[a-fA-F0-9]{40}$/.test(a) ? a.toLowerCase() : null
  })()
  const reserve = pool.attributes?.reserve_in_usd
  const liquidityUsd = reserve == null ? 0 : (typeof reserve === 'number' ? reserve : parseFloat(reserve)) || 0
  const poolType: LpPoolType =
    cls.poolModel === 'aerodrome_v2' ? 'aerodrome' :
    cls.poolModel === 'concentrated' ? 'concentrated' :
    cls.poolModel === 'constant_product' ? 'v2' :
    cls.poolModel === 'stableswap' ? 'unknown' :
    'unknown'
  return {
    address,
    liquidityUsd,
    dexId,
    dexName: dexId,
    poolType,
    hasLpToken: cls.proofAddressType === 'erc20_lp_token' ? true : cls.proofAddressType === 'nft_position' ? false : null,
    hasDexMeta: Boolean(dexId),
    isValidAddress: Boolean(address),
  }
}

// Converts a market-fallback pair read (e.g. DexScreener token-pairs) into the same
// LpPoolCandidate shape used everywhere else, so fallback liquidity is treated as a
// real pool candidate. Returns null only when there is neither a usable pair address
// nor any liquidity/volume evidence (a genuine no-pool).
export function marketFallbackToCandidate(fb: {
  pairAddress?: string | null
  liquidityUsd?: number | null
  volume24h?: number | null
  dexId?: string | null
  poolType?: LpPoolType | null
  hasLpToken?: boolean | null
} | null | undefined): LpPoolCandidate | null {
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

// Applies an RPC pool-model classification (token0/token1/getReserves/totalSupply/
// slot0/liquidity probe) to a candidate, upgrading its poolType / hasLpToken. Pure so
// it can be unit-tested without RPC: pass the already-resolved classification.
export function applyRpcClassificationToCandidate(
  candidate: LpPoolCandidate,
  rpc: { poolType: 'v2' | 'concentrated' | 'unknown'; hasLpToken: boolean | null }
): LpPoolCandidate {
  if (rpc.poolType === 'unknown') return { ...candidate, hasLpToken: candidate.hasLpToken ?? rpc.hasLpToken }
  return { ...candidate, poolType: rpc.poolType, hasLpToken: rpc.hasLpToken }
}

export type DisplayLpModel = 'erc20_lp_token' | 'concentrated_liquidity' | 'protocol_or_gauge' | 'open_check' | 'no_pool'
export type LpProofApplicability = 'applicable' | 'not_applicable' | 'unknown'

export interface DisplayLpModelResult {
  displayLpModel: DisplayLpModel
  lockBurnApplicable: boolean
  lockBurnReason: string
  proofApplicability: LpProofApplicability
}

// Generalized form of Token Scanner's "Normalize split-pool and proof-status
// fields" block — single source of truth for whether standard ERC-20 LP
// lock/burn proof applies to the canonical primary pool, used identically by
// Token Scanner and Liquidity Safety.
export function computeDisplayLpModel(params: {
  noActivePools: boolean
  proofPresent: boolean
  primaryPoolType: LpPoolType | 'unknown'
  primaryDexId?: string | null
  verifyPoolType?: LpPoolType | 'unknown'
  // Pre-existing control status (e.g. an on-chain holder scan already classified
  // the verification pool as concentrated_liquidity) — treated the same as a
  // concentrated primary pool type when set.
  controlStatusConcentrated?: boolean
  // True when market-fallback evidence proves liquidity exists (e.g. a DexScreener
  // pair with reserves/volume) even though no canonical on-chain pool could be
  // selected/probed. A pool that is detected from fallback liquidity is reported as
  // an open check ("model pending"), never as no_pool.
  marketLiquidityDetected?: boolean
  // Tri-state confirmation that the ERC-20 LP proof path actually verified ERC-20 LP
  // behavior (totalSupply/holder/balance evidence) for an Aerodrome pool. Aerodrome is
  // only marked applicable/erc20_lp_token from RPC/holder evidence — never from the DEX id
  // alone. `false` = proof path ran but did not confirm an ERC-20 LP token → open check.
  // `undefined` (default) preserves prior behavior for callers that do not probe Aerodrome.
  aerodromeLpConfirmed?: boolean
  // standardLockApplies from lpModelProof (classifyPoolModel on this pool's DEX id). When true,
  // the POOL MODEL is a known ERC-20/constant-product LP token even if holder/RPC evidence has
  // not yet confirmed lock/burn DOMINANCE — the model itself must never be reported as
  // "unknown"/open_check in that case. Model classification and control/dominance proof are
  // tracked separately (displayLpModel/proofApplicability vs lpControl.status).
  modelProofStandardLockApplies?: boolean
}): DisplayLpModelResult {
  const { noActivePools, proofPresent, primaryPoolType, primaryDexId, verifyPoolType, controlStatusConcentrated, marketLiquidityDetected, aerodromeLpConfirmed, modelProofStandardLockApplies } = params

  let displayLpModel: DisplayLpModel
  let lockBurnApplicable: boolean
  let lockBurnReason: string

  if (noActivePools && !proofPresent && !marketLiquidityDetected) {
    displayLpModel = 'no_pool'
    lockBurnApplicable = false
    lockBurnReason = 'No active pool detected.'
  } else if (noActivePools && !proofPresent && marketLiquidityDetected) {
    // Liquidity is proven by market-fallback evidence but the pool model could not be
    // confirmed on-chain — pool detected, model is an open check (not no_pool).
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
    // Aerodrome pool detected, but the ERC-20 LP proof path was attempted and did NOT confirm
    // ERC-20 LP behavior — do not mark applicable from the DEX id alone.
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

  // Final consistency check: lpModelProof (derived from this pool's DEX id via
  // classifyPoolModel) already confirms a standard ERC-20/constant-product LP model — never
  // report the pool MODEL as "unknown"/open_check in that case. Lock/burn DOMINANCE may still
  // be unconfirmed; that is tracked separately by lpControl.status ("partial"), not by the
  // model classification.
  if (displayLpModel === 'open_check' && modelProofStandardLockApplies === true) {
    displayLpModel = 'erc20_lp_token'
    lockBurnApplicable = true
    lockBurnReason = 'Pool model is a standard ERC-20 LP token (constant-product) per DEX metadata. Lock/burn dominance has not yet been confirmed from holder/controller evidence.'
  }

  const notApplicable = displayLpModel === 'concentrated_liquidity' || displayLpModel === 'no_pool'
  const proofApplicability: LpProofApplicability = displayLpModel === 'erc20_lp_token' ? 'applicable'
    : notApplicable ? 'not_applicable'
    : 'unknown'

  return { displayLpModel, lockBurnApplicable, lockBurnReason, proofApplicability }
}

export interface SecondaryLpSignal {
  status: string
  confidence: string
  poolAddress: string | null
  poolDex: string | null
  poolType: string | null
  pair?: string | null
  reason: string
  evidence: string[]
}

interface ReconcilableLpControl {
  status: string
  confidence: string
  reason: string
  evidence: string[]
}

// Selection rules 3/4: when the canonical PRIMARY pool is concentrated/CLMM but a
// SEPARATE V2/Aerodrome-V2 ERC-20 LP pool was found and classified (e.g. as
// team_controlled/burned/locked), demote that classification to a
// `secondaryLpControlSignals` entry and report the canonical primary-pool status
// as concentrated_liquidity/protocol. A secondary pool must never make the whole
// token "team_controlled" while the primary pool is concentrated/protocol liquidity.
export function reconcileSecondaryLpSignal<T extends ReconcilableLpControl>(
  lpControl: T,
  params: {
    primaryConcentrated: boolean
    verifyPool: LpPoolCandidate | null
    primaryPoolAddress: string | null
    primaryPoolType: string
    primaryDexId?: string | null
    primaryMarketPoolId?: string | null
    marketPairLabel: string
    canonicalStatus?: T['status']
  }
): { lpControl: T & { secondaryLpControlSignals?: SecondaryLpSignal | null }; secondary: SecondaryLpSignal | null } {
  const { primaryConcentrated, verifyPool, primaryPoolAddress, primaryPoolType, primaryDexId, primaryMarketPoolId, marketPairLabel, canonicalStatus } = params

  if (!(primaryConcentrated && verifyPool?.address && verifyPool.address !== primaryPoolAddress)) {
    return { lpControl, secondary: null }
  }

  const secondary: SecondaryLpSignal = {
    status: lpControl.status,
    confidence: lpControl.confidence,
    poolAddress: verifyPool.address,
    poolDex: verifyPool.dexId ?? verifyPool.dexName ?? null,
    poolType: verifyPool.poolType,
    reason: lpControl.reason,
    evidence: lpControl.evidence,
  }

  const reconciled: T & { secondaryLpControlSignals?: SecondaryLpSignal | null } = {
    ...lpControl,
    status: (canonicalStatus ?? 'concentrated_liquidity') as T['status'],
    confidence: 'medium' as T['confidence'],
    reason: 'Protocol-specific LP proof required for the primary pool.',
    evidence: [
      `Primary pool: ${marketPairLabel} (${primaryPoolType})`,
      primaryPoolAddress ? `pool=${primaryPoolAddress}` : primaryMarketPoolId ? `poolId=${primaryMarketPoolId}` : 'pool=unknown',
      `dex=${primaryDexId ?? 'unknown'}`,
      `poolType=${primaryPoolType}`,
    ],
    secondaryLpControlSignals: secondary,
  }

  // The pre-reconciliation lpControl.poolType describes the SECONDARY pool that was just
  // probed (e.g. "aerodrome"); once reconciled to the primary pool's canonical status, the
  // primary pool's own type must be reported instead — otherwise the public payload shows
  // an Aerodrome poolType for a PancakeSwap V3 primary pool.
  if ('poolType' in lpControl) {
    (reconciled as Record<string, unknown>).poolType = primaryPoolType
  }

  return { lpControl: reconciled, secondary }
}

export interface SharedLpMeta {
  primaryPoolAddress: string | null
  primaryPoolDex: string | null
  primaryPoolType: string | null
  verificationPoolAddress: string | null
  verificationPoolDex: string | null
  verificationPoolType: string | null
  v2PoolCandidatesCount: number
  protocolPoolCandidatesCount: number
  lockerRegistryStatus: 'configured' | 'empty' | 'not_supported'
  lockerDetectionAvailable: boolean
  lockProofCoverage: 'full' | 'limited' | 'none'
  reason: string
}

// Assembles the lpMeta subset required by the shared LpIntelligenceResult type —
// both Token Scanner and Liquidity Safety spread this into their richer lpMeta objects.
export function buildSharedLpMeta(params: {
  selection: CanonicalPoolSelection
  display: DisplayLpModelResult
  chain: 'eth' | 'base'
}): SharedLpMeta {
  const { selection, display, chain } = params
  const notApplicable = display.displayLpModel === 'concentrated_liquidity' || display.displayLpModel === 'no_pool'
  return {
    primaryPoolAddress: selection.primaryPool?.address ?? null,
    primaryPoolDex: selection.primaryPool?.dexId ?? selection.primaryPool?.dexName ?? null,
    primaryPoolType: selection.primaryPool?.poolType ?? null,
    verificationPoolAddress: notApplicable ? null : (selection.verifyPool?.address ?? null),
    verificationPoolDex: notApplicable ? null : (selection.verifyPool?.dexId ?? selection.verifyPool?.dexName ?? null),
    verificationPoolType: notApplicable ? null : (selection.verifyPool?.poolType ?? null),
    v2PoolCandidatesCount: selection.v2Candidates.length,
    protocolPoolCandidatesCount: selection.protocolCandidates.length,
    // No verified Base LP-locker registry is configured yet — never fabricate "locked"
    // via locker-address detection on Base.
    lockerRegistryStatus: chain === 'base' ? 'empty' : 'configured',
    lockerDetectionAvailable: chain !== 'base',
    lockProofCoverage: display.lockBurnApplicable ? (chain === 'base' ? 'limited' : 'full') : 'none',
    reason: display.lockBurnReason,
  }
}
