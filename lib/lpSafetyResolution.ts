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
}

export type LpSafetyResolution = {
  model: string
  status: string
  lockBurnStatus: string
  controlStatus: string
  exitRisk: string
  reason: string | null
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
  }
}

const sentence = (value: string | null | undefined, fallback: string): string => {
  const text = value?.trim()
  if (!text) return fallback
  return text.replace(/^(open check[:\s—-]*)/i, '').trim() || fallback
}

export function resolveLpSafetyFinalState(input: LpSafetyResolutionInput): LpSafetyResolution {
  const dex = input.selectedPoolDex ?? ''
  const type = (input.poolType ?? '').toLowerCase()
  const hasPool = Boolean(input.selectedPoolAddress)
  const concentrated = /v3|v4|concentrated|slipstream/.test(type) || /v3|v4|slipstream/.test(dex.toLowerCase())
  const isV4 = /v4/.test(type) || /v4/.test(dex.toLowerCase())
  const isAerodrome = /aerodrome/.test(type) || /aerodrome/.test(dex.toLowerCase())
  const isV2 = !concentrated && (type === 'v2' || type === 'aerodrome' || type === 'constant_product' || /v2/.test(type))

  let model = 'Unavailable: pool model could not be verified by metadata or RPC'
  if (!hasPool) model = 'Unavailable: no active liquidity pool found'
  else if (concentrated) model = isV4 ? 'Uniswap V4 Concentrated' : isAerodrome ? 'Aerodrome Slipstream' : /pancake/i.test(dex) ? 'PancakeSwap V3 Concentrated' : 'Uniswap V3 Concentrated'
  else if (isAerodrome) model = 'Aerodrome V2 LP'
  else if (isV2) model = /uniswap/i.test(dex) ? 'Uniswap V2 LP' : 'V2 LP'

  const failure = sentence(input.failureReason ?? input.exitRiskReason, hasPool
    ? 'LP proof providers returned no usable ownership evidence'
    : 'No active liquidity pool was found')

  let status: string
  let lockBurnStatus: string
  let controlStatus: string
  if (!hasPool) {
    status = `Unavailable: ${failure}`
    lockBurnStatus = 'Unavailable: no LP model to verify'
    controlStatus = 'Unavailable: no LP controller to verify'
  } else if (concentrated) {
    status = input.positionProofStatus === 'verified'
      ? 'Verified: concentrated position owner resolved'
      : `Partial: ${sentence(input.failureReason, 'position ownership proof unavailable')}`
    lockBurnStatus = 'Not applicable: concentrated LP model uses positions, not ERC-20 LP tokens'
    controlStatus = input.positionProofStatus === 'verified'
      ? 'Verified: position owner resolved'
      : `Partial: ${sentence(input.failureReason, 'position ownership proof unavailable')}`
  } else if (isV2) {
    const verified = input.lockStatus === 'locked' || input.burnStatus === 'burned'
    status = verified ? 'Verified' : `Partial: ${failure}`
    lockBurnStatus = verified
      ? `Verified: LP ${input.burnStatus === 'burned' ? 'burned' : 'locked'}`
      : `Partial: LP holder proof unavailable: ${failure}`
    controlStatus = input.dominantHolder
      ? `Partial: controller detected (${input.controllerType ?? 'unknown type'}), lock not verified`
      : `Partial: LP controller proof unavailable: ${failure}`
  } else {
    status = `Unavailable: ${failure}`
    lockBurnStatus = `Unavailable: pool model unresolved — ${failure}`
    controlStatus = `Unavailable: pool model unresolved — ${failure}`
  }

  const rawExit = (input.exitRisk ?? '').toLowerCase()
  const exitRisk = rawExit === 'low' ? 'Low'
    : rawExit === 'high' ? 'High'
    : rawExit === 'medium' || rawExit === 'monitor' || rawExit === 'watch' ? 'Watch'
    : `Unavailable: ${sentence(input.exitRiskReason, failure)}`

  const audit = {
    chainId: input.chainId,
    tokenAddress: input.tokenAddress,
    selectedPoolAddress: input.selectedPoolAddress,
    selectedPoolDex: input.selectedPoolDex,
    selectedPoolSource: input.selectedPoolSource,
    poolTypeDetected: concentrated ? (isV4 ? 'v4_concentrated' : 'v3_concentrated') : isV2 ? 'v2_erc20_lp' : hasPool ? 'unknown' : 'no_pool',
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
    finalLpModel: model,
    finalLpStatus: status,
    finalLockBurnStatus: lockBurnStatus,
    finalExitRisk: exitRisk,
    failureReason: /^(Verified|Low|High|Watch)/.test(status) ? null : failure,
  }

  return { model, status, lockBurnStatus, controlStatus, exitRisk, reason: audit.failureReason, audit }
}
