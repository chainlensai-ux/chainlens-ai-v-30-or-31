export type LpSafetyResolutionInput = {
  chainId: number | null
  tokenAddress: string
  selectedPoolAddress: string | null
  selectedPoolDex: string | null
  selectedPoolSource: string | null
  poolType: string | null
  token0: string | null
  token1: string | null
  lpTokenAddress: string | null
  totalSupplyRead: boolean
  rpcAttempted: boolean
  rpcCallsMade: number
  proofAttempted: boolean
  holdersReturned: number
  burnSharePct: number | null
  deadSharePct: number | null
  dominantHolder: string | null
  controllerType: string | null
  positionProofAttempted: boolean
  positionProofStatus: string | null
  lockStatus: string | null
  burnStatus: string | null
  exitRisk: string | null
  exitRiskReason: string | null
  failureReason: string | null
  poolId?: string | null
  poolAddressType?: string | null
  rpcPoolType?: string | null
  controlPoolType?: string | null
  concentratedPoolModel?: string | null
  displayLpModel?: string | null
  primaryDexName?: string | null
}

export type LpFinalDecisionAudit = {
  poolAddress: string | null
  dex: string | null
  detectorsTried: string[]
  successfulDetector: string | null
  detectedModel: string | null
  modelBeforeFallback: string | null
  fallbackTriggered: boolean
  fallbackReason: string | null
  proofPathUsed: 'v2_holder_burn_controller' | 'concentrated_position_ownership' | 'none'
  finalModel: string
  finalStatus: string
}

export type LpSafetyResolution = {
  model: string
  status: string
  lockBurnStatus: string
  controlStatus: string
  exitRisk: string
  reason: string | null
  finalDecisionAudit: LpFinalDecisionAudit
  audit: {
    chainId: number | null
    tokenAddress: string
    selectedPoolAddress: string | null
    selectedPoolDex: string | null
    selectedPoolSource: string | null
    poolTypeDetected: string
    token0: string | null
    token1: string | null
    lpTokenAddress: string | null
    totalSupplyRead: boolean
    alchemyRpcAttempted: boolean
    alchemyCallsMade: number
    proofAttempted: boolean
    holdersReturned: number
    burnSharePct: number | null
    deadSharePct: number | null
    dominantHolder: string | null
    controllerType: string
    concentratedDetected: boolean
    positionProofAttempted: boolean
    finalLpModel: string
    finalLpStatus: string
    finalLockBurnStatus: string
    finalExitRisk: string
    failureReason: string | null
    lpFinalDecisionAudit: LpFinalDecisionAudit
  }
}

export type DetectedLpProtocol =
  | 'uniswap_v2'
  | 'uniswap_v3'
  | 'uniswap_v4'
  | 'aerodrome_v2'
  | 'slipstream'
  | 'pancake_v2'
  | 'pancake_v3'
  | 'v2_erc20'
  | 'concentrated'
  | 'unknown'

export type DetectedLpPoolType = 'v2' | 'v3' | 'aerodrome' | 'concentrated' | 'unknown'

export type LpProtocolDetection = {
  protocol: DetectedLpProtocol
  poolType: DetectedLpPoolType
  detector: string | null
  detectorsTried: string[]
}

const sentence = (value: string | null | undefined, fallback: string): string => {
  const text = value?.trim()
  if (!text) return fallback
  return text.replace(/^(open check[:\s—-]*)/i, '').trim() || fallback
}

function blob(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(' ').toLowerCase()
}

function protocolToPoolType(protocol: DetectedLpProtocol): DetectedLpPoolType {
  if (protocol === 'uniswap_v2' || protocol === 'pancake_v2' || protocol === 'v2_erc20') return 'v2'
  if (protocol === 'aerodrome_v2') return 'aerodrome'
  if (protocol === 'uniswap_v3' || protocol === 'pancake_v3') return 'v3'
  if (protocol === 'uniswap_v4' || protocol === 'slipstream' || protocol === 'concentrated') return 'concentrated'
  return 'unknown'
}

function protocolLabel(protocol: DetectedLpProtocol): string | null {
  switch (protocol) {
    case 'uniswap_v2': return 'Uniswap V2 LP'
    case 'uniswap_v3': return 'Uniswap V3 Concentrated'
    case 'uniswap_v4': return 'Uniswap V4 Concentrated'
    case 'aerodrome_v2': return 'Aerodrome V2 LP'
    case 'slipstream': return 'Aerodrome Slipstream'
    case 'pancake_v2': return 'PancakeSwap V2 LP'
    case 'pancake_v3': return 'PancakeSwap V3 Concentrated'
    case 'v2_erc20': return 'V2 LP'
    case 'concentrated': return 'Uniswap V3 Concentrated'
    default: return null
  }
}

function classifyFromText(text: string, poolAddressType?: string | null, poolId?: string | null): DetectedLpProtocol {
  const t = text.toLowerCase()
  const isPoolId = poolAddressType === 'pool_id' || Boolean(poolId && /^0x[a-f0-9]{64}$/i.test(poolId))
  if (/slipstream/.test(t) || ((/aerodrome|velodrome/.test(t)) && /(v3|clmm|concentrated|(?:^|[-_\s])cl(?:[-_\s]|$))/.test(t))) return 'slipstream'
  if (/aerodrome|velodrome/.test(t) && /v2/.test(t)) return 'aerodrome_v2'
  if (/pancake/.test(t) && /v3|clmm|infinity/.test(t)) return 'pancake_v3'
  if (/pancake/.test(t) && /v2/.test(t)) return 'pancake_v2'
  if (/uniswap/.test(t) && /v4/.test(t)) return 'uniswap_v4'
  if (/uniswap/.test(t) && /v3/.test(t)) return 'uniswap_v3'
  if (/uniswap/.test(t) && /v2/.test(t)) return 'uniswap_v2'
  if (isPoolId && /uniswap/.test(t)) return 'uniswap_v4'
  if (isPoolId && /pancake/.test(t)) return 'pancake_v3'
  return 'unknown'
}

function classifyUnversionedDex(text: string, poolAddressType?: string | null, poolId?: string | null): DetectedLpProtocol {
  const t = text.toLowerCase()
  const isPoolId = poolAddressType === 'pool_id' || Boolean(poolId && /^0x[a-f0-9]{64}$/i.test(poolId))
  if (/aerodrome|velodrome/.test(t)) return isPoolId ? 'slipstream' : 'aerodrome_v2'
  if (/pancake/.test(t)) return isPoolId ? 'pancake_v3' : 'pancake_v2'
  if (/uniswap/.test(t)) return isPoolId ? 'uniswap_v4' : 'uniswap_v2'
  return 'unknown'
}

function classifyFromPoolType(type: string | null | undefined): DetectedLpProtocol {
  const t = (type ?? '').toLowerCase()
  if (!t || t === 'unknown') return 'unknown'
  if (t === 'uniswap_v4' || t === 'v4' || t === 'v4_concentrated') return 'uniswap_v4'
  if (t === 'uniswap_v3') return 'uniswap_v3'
  if (t === 'uniswap_v2') return 'uniswap_v2'
  if (t === 'pancakeswap_v3' || t === 'pancake_v3') return 'pancake_v3'
  if (t === 'slipstream' || t === 'aerodrome-slipstream') return 'slipstream'
  if (t === 'aerodrome' || t === 'aerodrome_v2') return 'aerodrome_v2'
  if (t === 'v3' || t === 'concentrated' || t === 'v3_concentrated') return 'concentrated'
  if (t === 'v2' || t === 'constant_product' || t === 'v2_erc20_lp' || t === 'erc20_lp_token') return 'v2_erc20'
  return 'unknown'
}

/**
 * Ordered protocol detectors. The first successful classification wins; a later
 * unknown/generic result must never overwrite it.
 */
export function detectKnownLpProtocol(input: {
  dex?: string | null
  dexName?: string | null
  primaryDexName?: string | null
  poolType?: string | null
  poolId?: string | null
  poolAddressType?: string | null
  rpcPoolType?: string | null
  controlPoolType?: string | null
  concentratedPoolModel?: string | null
  displayLpModel?: string | null
}): LpProtocolDetection {
  const detectorsTried: string[] = []
  const text = blob([input.dex, input.dexName, input.primaryDexName])
  const accept = (protocol: DetectedLpProtocol, detector: string): LpProtocolDetection | null => {
    detectorsTried.push(detector)
    if (protocol === 'unknown') return null
    return { protocol, poolType: protocolToPoolType(protocol), detector, detectorsTried }
  }

  const fromDex = accept(classifyFromText(text, input.poolAddressType, input.poolId), 'dex_metadata')
  if (fromDex) return fromDex

  const fromType = accept(classifyFromPoolType(input.poolType), 'declared_pool_type')
  if (fromType) return fromType

  const fromProof = accept(classifyFromPoolType(input.concentratedPoolModel), 'concentrated_position_proof')
  if (fromProof) return fromProof

  const fromRpc = accept(classifyFromPoolType(input.rpcPoolType), 'rpc_interface_probe')
  if (fromRpc) return fromRpc

  const fromControl = accept(classifyFromPoolType(input.controlPoolType), 'lp_control_classifier')
  if (fromControl) return fromControl

  const isPoolId = input.poolAddressType === 'pool_id' || Boolean(input.poolId && /^0x[a-f0-9]{64}$/i.test(input.poolId))
  detectorsTried.push('pool_id_shape')
  if (isPoolId) {
    const protocol: DetectedLpProtocol = /pancake/.test(text) ? 'pancake_v3' : /aerodrome|velodrome|slipstream/.test(text) ? 'slipstream' : 'uniswap_v4'
    return { protocol, poolType: protocolToPoolType(protocol), detector: 'pool_id_shape', detectorsTried }
  }

  const fromUnversioned = accept(classifyUnversionedDex(text, input.poolAddressType, input.poolId), 'unversioned_dex_metadata')
  if (fromUnversioned) return fromUnversioned

  detectorsTried.push('display_lp_model')
  if (input.displayLpModel === 'concentrated_liquidity') {
    return { protocol: 'concentrated', poolType: 'concentrated', detector: 'display_lp_model', detectorsTried }
  }
  if (input.displayLpModel === 'erc20_lp_token') {
    return { protocol: 'v2_erc20', poolType: 'v2', detector: 'display_lp_model', detectorsTried }
  }

  return { protocol: 'unknown', poolType: 'unknown', detector: null, detectorsTried }
}

export function resolveLpSafetyFinalState(input: LpSafetyResolutionInput): LpSafetyResolution {
  const dex = input.selectedPoolDex ?? input.primaryDexName ?? ''
  const hasPool = Boolean(input.selectedPoolAddress || input.poolId)
  const detected = detectKnownLpProtocol({
    dex: input.selectedPoolDex,
    dexName: input.primaryDexName,
    primaryDexName: input.primaryDexName,
    poolType: input.poolType,
    poolId: input.poolId,
    poolAddressType: input.poolAddressType,
    rpcPoolType: input.rpcPoolType,
    controlPoolType: input.controlPoolType,
    concentratedPoolModel: input.concentratedPoolModel,
    displayLpModel: input.displayLpModel,
  })

  const concentrated = detected.poolType === 'v3' || detected.poolType === 'concentrated'
    || detected.protocol === 'uniswap_v3' || detected.protocol === 'uniswap_v4'
    || detected.protocol === 'slipstream' || detected.protocol === 'pancake_v3'
    || detected.protocol === 'concentrated'
  const isV2 = detected.poolType === 'v2' || detected.poolType === 'aerodrome'
    || detected.protocol === 'uniswap_v2' || detected.protocol === 'pancake_v2'
    || detected.protocol === 'aerodrome_v2' || detected.protocol === 'v2_erc20'

  const detectedLabel = protocolLabel(detected.protocol)
  const modelBeforeFallback = detectedLabel
    ?? (concentrated
      ? (detected.protocol === 'uniswap_v4' ? 'Uniswap V4 Concentrated'
        : detected.protocol === 'slipstream' ? 'Aerodrome Slipstream'
        : detected.protocol === 'pancake_v3' ? 'PancakeSwap V3 Concentrated'
        : 'Uniswap V3 Concentrated')
      : isV2
        ? (detected.protocol === 'uniswap_v2' ? 'Uniswap V2 LP'
          : detected.protocol === 'pancake_v2' ? 'PancakeSwap V2 LP'
          : detected.protocol === 'aerodrome_v2' ? 'Aerodrome V2 LP'
          : /uniswap/i.test(dex) ? 'Uniswap V2 LP'
          : /pancake/i.test(dex) ? 'PancakeSwap V2 LP'
          : /aerodrome/i.test(dex) ? 'Aerodrome V2 LP'
          : 'V2 LP')
        : null)

  let fallbackTriggered = false
  let fallbackReason: string | null = null
  let model = modelBeforeFallback
  if (!hasPool) {
    fallbackTriggered = true
    fallbackReason = 'No active liquidity pool was found'
    model = 'Unavailable: no active liquidity pool found'
  } else if (!model) {
    fallbackTriggered = true
    fallbackReason = sentence(
      input.failureReason,
      input.rpcAttempted
        ? 'Every supported LP detector (Uniswap V2/V3/V4, Aerodrome, Slipstream, Pancake V2/V3) failed to classify this pool from metadata and RPC'
        : 'Pool is present, but DEX metadata and RPC classification did not identify a supported LP model',
    )
    model = `Unavailable: pool model could not be verified by metadata or RPC — ${fallbackReason}`
  }

  const exactFailure = sentence(
    input.failureReason ?? input.exitRiskReason,
    concentrated
      ? 'position ownership proof unavailable'
      : isV2
        ? (input.holdersReturned === 0 ? 'LP holder rows were not returned' : 'LP holder proof did not confirm lock or burn dominance')
        : (fallbackReason ?? 'supported LP detectors did not classify this pool'),
  )

  let status: string
  let lockBurnStatus: string
  let controlStatus: string
  let proofPathUsed: LpFinalDecisionAudit['proofPathUsed'] = 'none'
  if (!hasPool) {
    status = `Unavailable: ${exactFailure}`
    lockBurnStatus = 'Unavailable: no LP model to verify'
    controlStatus = 'Unavailable: no LP controller to verify'
  } else if (concentrated) {
    proofPathUsed = 'concentrated_position_ownership'
    status = input.positionProofStatus === 'verified'
      ? 'Verified: concentrated position owner resolved'
      : `Partial: ${exactFailure}`
    lockBurnStatus = 'Not applicable: concentrated LP model uses positions, not ERC-20 LP tokens'
    controlStatus = input.positionProofStatus === 'verified'
      ? 'Verified: position owner resolved'
      : `Partial: ${exactFailure}`
  } else if (isV2) {
    proofPathUsed = 'v2_holder_burn_controller'
    const verified = input.lockStatus === 'locked' || input.burnStatus === 'burned'
    status = verified ? 'Verified' : `Partial: ${exactFailure}`
    lockBurnStatus = verified
      ? `Verified: LP ${input.burnStatus === 'burned' ? 'burned' : 'locked'}`
      : `Partial: LP holder proof unavailable: ${exactFailure}`
    controlStatus = input.dominantHolder
      ? `Partial: controller detected (${input.controllerType ?? 'unknown type'}), lock not verified`
      : `Partial: LP controller proof unavailable: ${exactFailure}`
  } else {
    fallbackTriggered = true
    fallbackReason = fallbackReason ?? exactFailure
    status = `Unavailable: ${exactFailure}`
    lockBurnStatus = `Unavailable: pool model unresolved — ${exactFailure}`
    controlStatus = `Unavailable: pool model unresolved — ${exactFailure}`
  }

  const rawExit = (input.exitRisk ?? '').toLowerCase()
  const exitRisk = rawExit === 'low' ? 'Low'
    : rawExit === 'high' ? 'High'
    : rawExit === 'medium' || rawExit === 'monitor' || rawExit === 'watch' ? 'Watch'
    : concentrated || isV2
      ? (rawExit === 'unrated' || !rawExit || rawExit === 'open_check' || rawExit === 'unknown'
        ? `Unavailable: ${sentence(input.exitRiskReason, exactFailure)}`
        : `Unavailable: ${sentence(input.exitRiskReason, exactFailure)}`)
      : `Unavailable: ${sentence(input.exitRiskReason, exactFailure)}`

  const finalDecisionAudit: LpFinalDecisionAudit = {
    poolAddress: input.selectedPoolAddress ?? input.poolId ?? null,
    dex: dex || null,
    detectorsTried: detected.detectorsTried,
    successfulDetector: detected.detector,
    detectedModel: detectedLabel ?? detected.protocol,
    modelBeforeFallback,
    fallbackTriggered,
    fallbackReason,
    proofPathUsed,
    finalModel: model ?? 'Unavailable: pool model could not be verified by metadata or RPC',
    finalStatus: status,
  }

  const audit = {
    chainId: input.chainId,
    tokenAddress: input.tokenAddress,
    selectedPoolAddress: input.selectedPoolAddress,
    selectedPoolDex: input.selectedPoolDex,
    selectedPoolSource: input.selectedPoolSource,
    poolTypeDetected: concentrated
      ? (detected.protocol === 'uniswap_v4' ? 'v4_concentrated' : detected.protocol === 'slipstream' ? 'slipstream' : 'v3_concentrated')
      : isV2
        ? (detected.protocol === 'aerodrome_v2' ? 'aerodrome_v2' : 'v2_erc20_lp')
        : hasPool ? 'unknown' : 'no_pool',
    token0: input.token0,
    token1: input.token1,
    lpTokenAddress: isV2 ? input.lpTokenAddress : null,
    totalSupplyRead: isV2 && input.totalSupplyRead,
    alchemyRpcAttempted: input.rpcAttempted,
    alchemyCallsMade: input.rpcCallsMade,
    proofAttempted: input.proofAttempted,
    holdersReturned: input.holdersReturned,
    burnSharePct: input.burnSharePct,
    deadSharePct: input.deadSharePct,
    dominantHolder: input.dominantHolder,
    controllerType: input.controllerType ?? 'unknown',
    concentratedDetected: concentrated,
    positionProofAttempted: input.positionProofAttempted,
    finalLpModel: finalDecisionAudit.finalModel,
    finalLpStatus: status,
    finalLockBurnStatus: lockBurnStatus,
    finalExitRisk: exitRisk,
    failureReason: /^(Verified|Low|High|Watch)/.test(status) ? null : exactFailure,
    lpFinalDecisionAudit: finalDecisionAudit,
  }

  return {
    model: finalDecisionAudit.finalModel,
    status,
    lockBurnStatus,
    controlStatus,
    exitRisk,
    reason: audit.failureReason,
    finalDecisionAudit,
    audit,
  }
}
