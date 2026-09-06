export const ROBINHOOD_SIM_CHAIN_ID = 4663

export type TradingSimulationChainSlug = 'eth' | 'base' | 'bnb' | 'polygon' | 'robinhood' | 'solana'

export type TradingSimulationProvider = 'honeypot_is' | 'goplus' | 'chainlens_robinhood_sim' | 'none'

export type TradingSimulationFinalStatus =
  | 'verified_clear'
  | 'risk_detected'
  | 'simulated'
  | 'unsupported_on_robinhood'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'not_applicable'
  | 'unavailable_with_reason'

export interface TradingSimulationSupport {
  chainId: number | null
  honeypotIs: boolean
  goplus: boolean
  robinhoodSim: boolean
  notApplicable: boolean
}

export const TRADING_SIMULATION_SUPPORT: Record<TradingSimulationChainSlug, TradingSimulationSupport> = {
  base: { chainId: 8453, honeypotIs: true, goplus: true, robinhoodSim: false, notApplicable: false },
  eth: { chainId: 1, honeypotIs: true, goplus: true, robinhoodSim: false, notApplicable: false },
  bnb: { chainId: 56, honeypotIs: true, goplus: true, robinhoodSim: false, notApplicable: false },
  polygon: { chainId: 137, honeypotIs: true, goplus: true, robinhoodSim: false, notApplicable: false },
  robinhood: { chainId: ROBINHOOD_SIM_CHAIN_ID, honeypotIs: false, goplus: false, robinhoodSim: true, notApplicable: false },
  solana: { chainId: null, honeypotIs: false, goplus: false, robinhoodSim: false, notApplicable: true },
}

export const ROBINHOOD_SIM_UNSUPPORTED_STATUS = 'Unsupported on Robinhood'
export const ROBINHOOD_SIM_UNSUPPORTED_REASON = 'No configured honeypot provider supports chainId 4663.'
export const ROBINHOOD_SIM_UNSUPPORTED_IMPACT =
  'Taxes and sell-block simulation could not be verified. Treat as an open risk.'
export const ROBINHOOD_SIM_SOURCE = 'ChainLens Robinhood simulation'
export const ROBINHOOD_SIM_TIMEOUT_LABEL = 'Simulation timed out'
export const SOLANA_SIM_NOT_APPLICABLE_REASON =
  'EVM honeypot simulation is not applicable on Solana. Use Solana-native risk checks only.'

export const TRADING_SIM_SUCCESS_TTL_SECONDS = 120
export const TRADING_SIM_FAILURE_TTL_SECONDS = 8
export const ROBINHOOD_SIM_SUCCESS_TTL_MS = 10 * 60_000
export const ROBINHOOD_SIM_FAILURE_TTL_MS = 8_000

export type RobinhoodHoneypotSimStatus = 'sellable' | 'blocked' | 'unsupported' | 'timeout' | 'unavailable'

export interface RobinhoodTradingSimulationAudit {
  chainId: number
  tokenAddress: string
  poolAddress: string | null
  provider: 'alchemy_robinhood_rpc'
  scanhoodLogicUsed: true
  ethCallAttempted: boolean
  buySucceeded: boolean | null
  sellSucceeded: boolean | null
  buyTaxPct: number | null
  sellTaxPct: number | null
  sellable: boolean | null
  finalStatus: RobinhoodHoneypotSimStatus
  failureReason: string | null
  cacheHit: boolean
  selectedPoolFromMarket: string | null
  selectedPoolFromLp: string | null
  canonicalSelectedPool: string | null
  selectedPoolAddress: string | null
  selectedPoolDex: string | null
  selectedPoolChainOk: boolean
  simulationAttempted: boolean
  simulationModuleLoaded: boolean
  envReady: boolean
  finalReason: string | null
}

export interface TradingSimulationAudit {
  chainId: number | null
  chainSlug: TradingSimulationChainSlug | string
  tokenAddress: string
  poolAddress: string | null
  providersTried: TradingSimulationProvider[]
  providerUsed: TradingSimulationProvider
  providerSelected: TradingSimulationProvider
  providerSupportsChain: boolean
  attempted: boolean
  requestAttempted: boolean
  requestChainId: number | null
  responseReceived: boolean
  cacheKey: string
  cacheHit: boolean
  cacheChainMatches: boolean
  cachedStatus: TradingSimulationFinalStatus | null
  cacheAgeMs: number | null
  responseStatus: number | null
  responseError: string | null
  timedOut: boolean
  honeypotResult: boolean | null
  buyTax: number | null
  sellTax: number | null
  sellable: boolean | null
  source: string | null
  finalStatus: TradingSimulationFinalStatus
  finalReason: string
  exactReason: string
}

export interface TradingSimulationUi {
  statusLabel: string
  reason: string
  impact: string | null
  badge: string
  honeypotValue: string
  buyTaxValue: string
  sellTaxValue: string
  source: string | null
  showTaxRows: boolean
  treatAsOpenRisk: boolean
}

export interface ClassifyTradingSimulationInput {
  chainSlug: string
  chainId: number | null
  tokenAddress: string
  poolAddress?: string | null
  providerSelected?: TradingSimulationProvider | null
  providersTried?: TradingSimulationProvider[] | null
  requestAttempted?: boolean
  requestChainId?: number | null
  cacheKey?: string | null
  cacheHit?: boolean
  cacheChainMatches?: boolean
  cachedStatus?: TradingSimulationFinalStatus | null
  cacheAgeMs?: number | null
  responseStatus?: number | null
  responseError?: string | null
  timedOut?: boolean
  honeypotResult?: boolean | null
  buyTax?: number | null
  sellTax?: number | null
  sellable?: boolean | null
  simulationSuccess?: boolean | null
  honeypotStatus?: string | null
  honeypotReason?: string | null
}

function normalizeSlug(value: string | null | undefined): TradingSimulationChainSlug | string {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === 'ethereum') return 'eth'
  if (raw === 'bsc') return 'bnb'
  return raw
}

export function tradingSimulationSupportFor(chainSlug: string, chainId?: number | null): TradingSimulationSupport {
  const slug = normalizeSlug(chainSlug)
  if (chainId === ROBINHOOD_SIM_CHAIN_ID || slug === 'robinhood' || slug === '4663') {
    return TRADING_SIMULATION_SUPPORT.robinhood
  }
  if (slug === 'solana') return TRADING_SIMULATION_SUPPORT.solana
  if (slug === 'base' || chainId === 8453) return TRADING_SIMULATION_SUPPORT.base
  if (slug === 'eth' || chainId === 1) return TRADING_SIMULATION_SUPPORT.eth
  if (slug === 'bnb' || chainId === 56) return TRADING_SIMULATION_SUPPORT.bnb
  if (slug === 'polygon' || chainId === 137) return TRADING_SIMULATION_SUPPORT.polygon
  return { chainId: chainId ?? null, honeypotIs: false, goplus: false, robinhoodSim: false, notApplicable: false }
}

export function providerSupportsTradingSimulation(
  support: TradingSimulationSupport,
  provider: TradingSimulationProvider,
): boolean {
  if (provider === 'honeypot_is') return support.honeypotIs
  if (provider === 'goplus') return support.goplus
  if (provider === 'chainlens_robinhood_sim') return support.robinhoodSim
  return false
}

export function buildTradingSimulationCacheKey(
  chainId: number | null,
  tokenAddress: string,
  provider: TradingSimulationProvider,
  poolAddress?: string | null,
): string {
  const pool = `:${(poolAddress ?? 'none').toLowerCase()}`
  return `sim:${provider}:${chainId ?? 'none'}:${tokenAddress.toLowerCase()}${pool}`
}

export function isTradingSimulationCacheHitValid(
  cached: { chainId: number | null; tokenAddress: string; provider: TradingSimulationProvider; poolAddress?: string | null },
  selected: { chainId: number | null; tokenAddress: string; provider: TradingSimulationProvider; poolAddress?: string | null },
): boolean {
  if (cached.chainId !== selected.chainId) return false
  if (cached.provider !== selected.provider) return false
  if (cached.tokenAddress.toLowerCase() !== selected.tokenAddress.toLowerCase()) return false
  return (cached.poolAddress ?? '').toLowerCase() === (selected.poolAddress ?? '').toLowerCase()
}

export function isTradingSimulationSuccessCacheable(status: TradingSimulationFinalStatus): boolean {
  return status === 'verified_clear' || status === 'risk_detected' || status === 'simulated' || status === 'not_applicable'
}

export function tradingSimulationCacheTtlSeconds(status: TradingSimulationFinalStatus): number {
  return isTradingSimulationSuccessCacheable(status) ? TRADING_SIM_SUCCESS_TTL_SECONDS : TRADING_SIM_FAILURE_TTL_SECONDS
}

export function robinhoodSimulationCacheTtlMs(status: RobinhoodHoneypotSimStatus): number {
  return status === 'sellable' || status === 'blocked' ? ROBINHOOD_SIM_SUCCESS_TTL_MS : ROBINHOOD_SIM_FAILURE_TTL_MS
}

function taxLooksRisky(buyTax: number | null, sellTax: number | null): boolean {
  return (buyTax != null && buyTax > 8) || (sellTax != null && sellTax > 8)
}

export function classifyTradingSimulation(input: ClassifyTradingSimulationInput): TradingSimulationAudit {
  const chainSlug = normalizeSlug(input.chainSlug)
  const support = tradingSimulationSupportFor(chainSlug, input.chainId)
  const chainId = support.chainId ?? input.chainId ?? null
  const tokenAddress = (input.tokenAddress || '').toLowerCase()
  const poolAddress = input.poolAddress && /^0x[a-fA-F0-9]{40}$/.test(input.poolAddress)
    ? input.poolAddress.toLowerCase()
    : (input.poolAddress ?? null)
  const isRobinhood = chainId === ROBINHOOD_SIM_CHAIN_ID || chainSlug === 'robinhood'
  const timedOut = Boolean(input.timedOut) || input.honeypotStatus === 'timeout'
  const providerSelected: TradingSimulationProvider =
    input.providerSelected
    ?? (support.robinhoodSim ? 'chainlens_robinhood_sim' : support.honeypotIs ? 'honeypot_is' : support.goplus ? 'goplus' : 'none')
  const providersTried = input.providersTried?.length
    ? input.providersTried
    : providerSelected === 'none' ? [] : [providerSelected]
  const providerSupportsChain = providerSupportsTradingSimulation(support, providerSelected)
  const requestChainId = input.requestChainId ?? (input.requestAttempted ? chainId : null)
  const cacheKey = input.cacheKey ?? buildTradingSimulationCacheKey(chainId, tokenAddress, providerSelected, poolAddress)
  const sellable = input.sellable ?? null
  const source = providerSelected === 'chainlens_robinhood_sim' ? ROBINHOOD_SIM_SOURCE : null
  const status = input.honeypotStatus ?? null
  const attempted = Boolean(input.requestAttempted) && providerSupportsChain
  const responseReceived = input.responseStatus != null || input.honeypotResult != null || sellable != null || Boolean(status && status !== 'timeout' && status !== 'unavailable' && status !== 'failed')

  let finalStatus: TradingSimulationFinalStatus
  let finalReason: string

  if (support.notApplicable || chainSlug === 'solana') {
    finalStatus = 'not_applicable'
    finalReason = SOLANA_SIM_NOT_APPLICABLE_REASON
  } else if (timedOut) {
    finalStatus = 'provider_timeout'
    finalReason = input.honeypotReason || input.responseError || (isRobinhood ? ROBINHOOD_SIM_TIMEOUT_LABEL : 'Trading simulation timed out.')
  } else if (isRobinhood && providerSelected === 'chainlens_robinhood_sim') {
    if (status === 'unsupported' || status === 'not_supported') {
      finalStatus = 'unsupported_on_robinhood'
      finalReason = input.honeypotReason || 'No selected Robinhood pool'
    } else if (status === 'unavailable' || status === 'failed') {
      finalStatus = 'unavailable_with_reason'
      finalReason = input.honeypotReason || input.responseError || 'Robinhood simulation failed'
    } else if (status === 'blocked' || input.honeypotResult === true || sellable === false) {
      finalStatus = 'risk_detected'
      finalReason = input.honeypotReason || 'Simulated sell failed — sell path blocked.'
    } else if (status === 'sellable' || sellable === true || (input.honeypotResult === false && (input.simulationSuccess === true || status === 'confirmed'))) {
      finalStatus = 'simulated'
      finalReason = 'Simulated sell succeeded. Sellable only means the simulated sell worked — LP/dev/holder risks remain separate.'
    } else if (input.responseError && input.honeypotResult == null && sellable == null) {
      finalStatus = 'unavailable_with_reason'
      finalReason = input.honeypotReason || input.responseError || 'Robinhood simulation failed'
    } else if (!input.requestAttempted) {
      finalStatus = 'unsupported_on_robinhood'
      finalReason = input.honeypotReason || 'No selected Robinhood pool'
    } else {
      finalStatus = 'unavailable_with_reason'
      finalReason = input.honeypotReason || 'Robinhood simulation did not return a usable result'
    }
  } else if (isRobinhood) {
    if (!providerSupportsChain) {
      finalStatus = 'unsupported_on_robinhood'
      finalReason = input.honeypotReason || ROBINHOOD_SIM_UNSUPPORTED_REASON
    } else if (input.honeypotResult === true || taxLooksRisky(input.buyTax ?? null, input.sellTax ?? null)) {
      finalStatus = 'risk_detected'
      finalReason = input.honeypotResult === true
        ? 'Trading simulation flagged a blocked or trapped sell path.'
        : 'Trading simulation confirmed elevated buy/sell tax.'
    } else if (input.honeypotResult === false && input.simulationSuccess === true) {
      finalStatus = 'simulated'
      finalReason = 'Simulated sell succeeded. Sellable only means the simulated sell worked — LP/dev/holder risks remain separate.'
    } else {
      finalStatus = 'unsupported_on_robinhood'
      finalReason = input.honeypotReason || ROBINHOOD_SIM_UNSUPPORTED_REASON
    }
  } else if (!providerSupportsChain) {
    finalStatus = 'provider_unavailable'
    finalReason = input.honeypotReason || 'No configured honeypot provider supports this chain.'
  } else if (input.honeypotResult === true || taxLooksRisky(input.buyTax ?? null, input.sellTax ?? null)) {
    finalStatus = 'risk_detected'
    finalReason = input.honeypotResult === true
      ? 'Trading simulation flagged a blocked or trapped sell path.'
      : 'Trading simulation confirmed elevated buy/sell tax.'
  } else if (input.honeypotResult === false && (input.simulationSuccess === true || input.honeypotStatus === 'confirmed')) {
    finalStatus = 'verified_clear'
    finalReason = 'Trading simulation verified — no honeypot pattern detected.'
  } else if (input.honeypotStatus === 'failed' || input.responseError) {
    finalStatus = 'provider_unavailable'
    finalReason = input.honeypotReason || input.responseError || 'Honeypot provider was unavailable for this token.'
  } else if (input.honeypotStatus === 'not_supported') {
    finalStatus = 'provider_unavailable'
    finalReason = input.honeypotReason || 'Honeypot provider does not support this token/chain pair.'
  } else {
    finalStatus = 'unavailable_with_reason'
    finalReason = input.honeypotReason || 'Trading simulation did not return a usable result for this token.'
  }

  return {
    chainId,
    chainSlug,
    tokenAddress,
    poolAddress,
    providersTried,
    providerUsed: providerSelected,
    providerSelected,
    providerSupportsChain,
    attempted,
    requestAttempted: attempted,
    requestChainId: providerSupportsChain ? requestChainId : null,
    responseReceived,
    cacheKey,
    cacheHit: Boolean(input.cacheHit),
    cacheChainMatches: input.cacheChainMatches !== false,
    cachedStatus: input.cacheHit ? (input.cachedStatus ?? finalStatus) : null,
    cacheAgeMs: input.cacheHit ? (input.cacheAgeMs ?? 0) : null,
    responseStatus: input.responseStatus ?? null,
    responseError: input.responseError ?? null,
    timedOut,
    honeypotResult: input.honeypotResult ?? null,
    buyTax: input.buyTax ?? null,
    sellTax: input.sellTax ?? null,
    sellable,
    source,
    finalStatus,
    finalReason,
    exactReason: finalReason,
  }
}

export function classifyFromRobinhoodHoneypotSim(args: {
  tokenAddress: string
  poolAddress: string | null
  attempted: boolean
  sellable: boolean | null
  honeypotStatus: string
  buyTaxPct: number | null
  sellTaxPct: number | null
  failureReason: string | null
  rawProviderError: string | null
  cacheHit?: boolean
  cacheAgeMs?: number | null
}): TradingSimulationAudit {
  return classifyTradingSimulation({
    chainSlug: 'robinhood',
    chainId: ROBINHOOD_SIM_CHAIN_ID,
    tokenAddress: args.tokenAddress,
    poolAddress: args.poolAddress,
    providerSelected: 'chainlens_robinhood_sim',
    requestAttempted: args.attempted || args.honeypotStatus === 'unsupported' || args.honeypotStatus === 'not_supported',
    requestChainId: ROBINHOOD_SIM_CHAIN_ID,
    cacheHit: args.cacheHit,
    cacheAgeMs: args.cacheAgeMs ?? null,
    timedOut: args.honeypotStatus === 'timeout',
    honeypotResult: args.honeypotStatus === 'blocked' ? true : args.honeypotStatus === 'sellable' ? false : null,
    buyTax: args.buyTaxPct,
    sellTax: args.sellTaxPct,
    sellable: args.sellable,
    simulationSuccess: args.sellable === true,
    honeypotStatus: args.honeypotStatus,
    honeypotReason: args.failureReason,
    responseError: args.rawProviderError,
  })
}

export function buildTradingSimulationUi(audit: TradingSimulationAudit): TradingSimulationUi {
  const taxOrDash = (n: number | null) => (n == null ? 'Unavailable' : `${n.toFixed(1)}%`)
  const isRobinhood = audit.chainId === ROBINHOOD_SIM_CHAIN_ID || audit.chainSlug === 'robinhood'
  if (audit.finalStatus === 'unsupported_on_robinhood') {
    const label = `Unsupported: ${audit.finalReason}`
    return {
      statusLabel: label,
      reason: audit.finalReason,
      impact: ROBINHOOD_SIM_UNSUPPORTED_IMPACT,
      badge: 'UNSUPPORTED',
      honeypotValue: label,
      buyTaxValue: label,
      sellTaxValue: label,
      source: audit.source,
      showTaxRows: false,
      treatAsOpenRisk: true,
    }
  }
  if (audit.finalStatus === 'not_applicable') {
    return {
      statusLabel: 'Not Applicable: EVM honeypot simulation is not applicable on Solana',
      reason: audit.finalReason,
      impact: null,
      badge: 'NOT APPLICABLE',
      honeypotValue: 'Not Applicable: EVM honeypot simulation is not applicable on Solana',
      buyTaxValue: 'Not Applicable: EVM honeypot simulation is not applicable on Solana',
      sellTaxValue: 'Not Applicable: EVM honeypot simulation is not applicable on Solana',
      source: null,
      showTaxRows: false,
      treatAsOpenRisk: false,
    }
  }
  if (audit.finalStatus === 'provider_timeout') {
    const label = `Unavailable: ${isRobinhood ? ROBINHOOD_SIM_TIMEOUT_LABEL : 'Trading simulation timed out'}`
    return {
      statusLabel: label,
      reason: audit.finalReason,
      impact: 'Taxes and sell-block simulation could not be verified. Treat as an open risk.',
      badge: 'TIMED OUT',
      honeypotValue: label,
      buyTaxValue: label,
      sellTaxValue: label,
      source: audit.source,
      showTaxRows: false,
      treatAsOpenRisk: true,
    }
  }
  if (audit.finalStatus === 'provider_unavailable') {
    const label = `Unavailable: ${audit.finalReason}`
    return {
      statusLabel: label,
      reason: audit.finalReason,
      impact: 'Taxes and sell-block simulation could not be verified. Treat as an open risk.',
      badge: 'UNAVAILABLE',
      honeypotValue: label,
      buyTaxValue: label,
      sellTaxValue: label,
      source: audit.source,
      showTaxRows: false,
      treatAsOpenRisk: true,
    }
  }
  if (audit.finalStatus === 'unavailable_with_reason') {
    const label = `Unavailable: ${audit.finalReason}`
    return {
      statusLabel: label,
      reason: audit.finalReason,
      impact: 'Taxes and sell-block simulation could not be verified. Treat as an open risk.',
      badge: 'UNAVAILABLE',
      honeypotValue: label,
      buyTaxValue: label,
      sellTaxValue: label,
      source: audit.source,
      showTaxRows: false,
      treatAsOpenRisk: true,
    }
  }
  if (audit.finalStatus === 'simulated') {
    return {
      statusLabel: 'Sellable',
      reason: audit.finalReason,
      impact: null,
      badge: 'SIMULATED',
      honeypotValue: 'Sellable',
      buyTaxValue: taxOrDash(audit.buyTax),
      sellTaxValue: taxOrDash(audit.sellTax),
      source: audit.source ?? ROBINHOOD_SIM_SOURCE,
      showTaxRows: true,
      treatAsOpenRisk: true,
    }
  }
  if (audit.finalStatus === 'risk_detected') {
    const blocked = isRobinhood && (audit.honeypotResult === true || audit.sellable === false)
    return {
      statusLabel: blocked ? 'Blocked' : 'Risk detected',
      reason: audit.finalReason,
      impact: null,
      badge: 'RISK DETECTED',
      honeypotValue: blocked ? 'Blocked' : audit.honeypotResult === true ? 'YES' : audit.honeypotResult === false ? 'NO' : 'Risk detected',
      buyTaxValue: taxOrDash(audit.buyTax),
      sellTaxValue: taxOrDash(audit.sellTax),
      source: isRobinhood ? (audit.source ?? ROBINHOOD_SIM_SOURCE) : null,
      showTaxRows: true,
      treatAsOpenRisk: true,
    }
  }
  return {
    statusLabel: 'Verified',
    reason: audit.finalReason,
    impact: null,
    badge: 'VERIFIED CLEAR',
    honeypotValue: audit.honeypotResult === true ? 'YES' : 'NO',
    buyTaxValue: taxOrDash(audit.buyTax),
    sellTaxValue: taxOrDash(audit.sellTax),
    source: null,
    showTaxRows: true,
    treatAsOpenRisk: false,
  }
}

export function emptyTradingSimulationAudit(tokenAddress: string, chainSlug: string, chainId: number | null): TradingSimulationAudit {
  return classifyTradingSimulation({
    chainSlug,
    chainId,
    tokenAddress,
    providerSelected: chainId === ROBINHOOD_SIM_CHAIN_ID || chainSlug === 'robinhood' ? 'chainlens_robinhood_sim' : 'none',
    requestAttempted: false,
  })
}
