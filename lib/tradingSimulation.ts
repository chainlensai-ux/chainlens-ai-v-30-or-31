export const ROBINHOOD_SIM_CHAIN_ID = 4663

export type TradingSimulationChainSlug = 'eth' | 'base' | 'bnb' | 'polygon' | 'robinhood' | 'solana'

export type TradingSimulationProvider = 'honeypot_is' | 'goplus' | 'none'

export type TradingSimulationFinalStatus =
  | 'verified_clear'
  | 'risk_detected'
  | 'unsupported_on_robinhood'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'not_applicable'
  | 'unavailable_with_reason'

export interface TradingSimulationSupport {
  chainId: number | null
  honeypotIs: boolean
  goplus: boolean
  notApplicable: boolean
}

export const TRADING_SIMULATION_SUPPORT: Record<TradingSimulationChainSlug, TradingSimulationSupport> = {
  base: { chainId: 8453, honeypotIs: true, goplus: true, notApplicable: false },
  eth: { chainId: 1, honeypotIs: true, goplus: true, notApplicable: false },
  bnb: { chainId: 56, honeypotIs: true, goplus: true, notApplicable: false },
  polygon: { chainId: 137, honeypotIs: true, goplus: true, notApplicable: false },
  robinhood: { chainId: ROBINHOOD_SIM_CHAIN_ID, honeypotIs: false, goplus: false, notApplicable: false },
  solana: { chainId: null, honeypotIs: false, goplus: false, notApplicable: true },
}

export const ROBINHOOD_SIM_UNSUPPORTED_STATUS = 'Unsupported on Robinhood'
export const ROBINHOOD_SIM_UNSUPPORTED_REASON = 'No configured honeypot provider supports chainId 4663.'
export const ROBINHOOD_SIM_UNSUPPORTED_IMPACT =
  'Taxes and sell-block simulation could not be verified. Treat as an open risk.'
export const SOLANA_SIM_NOT_APPLICABLE_REASON =
  'EVM honeypot simulation is not applicable on Solana. Use Solana-native risk checks only.'

export interface TradingSimulationAudit {
  chainId: number | null
  chainSlug: TradingSimulationChainSlug | string
  tokenAddress: string
  providerSelected: TradingSimulationProvider
  providerSupportsChain: boolean
  requestAttempted: boolean
  requestChainId: number | null
  cacheKey: string
  cacheHit: boolean
  cacheChainMatches: boolean
  responseStatus: number | null
  responseError: string | null
  timedOut: boolean
  honeypotResult: boolean | null
  buyTax: number | null
  sellTax: number | null
  finalStatus: TradingSimulationFinalStatus
  finalReason: string
}

export interface TradingSimulationUi {
  statusLabel: string
  reason: string
  impact: string | null
  badge: string
  honeypotValue: string
  buyTaxValue: string
  sellTaxValue: string
  showTaxRows: boolean
  treatAsOpenRisk: boolean
}

export interface ClassifyTradingSimulationInput {
  chainSlug: string
  chainId: number | null
  tokenAddress: string
  providerSelected?: TradingSimulationProvider | null
  requestAttempted?: boolean
  requestChainId?: number | null
  cacheKey?: string | null
  cacheHit?: boolean
  cacheChainMatches?: boolean
  responseStatus?: number | null
  responseError?: string | null
  timedOut?: boolean
  honeypotResult?: boolean | null
  buyTax?: number | null
  sellTax?: number | null
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
  return { chainId: chainId ?? null, honeypotIs: false, goplus: false, notApplicable: false }
}

export function providerSupportsTradingSimulation(
  support: TradingSimulationSupport,
  provider: TradingSimulationProvider,
): boolean {
  if (provider === 'honeypot_is') return support.honeypotIs
  if (provider === 'goplus') return support.goplus
  return false
}

export function buildTradingSimulationCacheKey(
  chainId: number | null,
  tokenAddress: string,
  provider: TradingSimulationProvider,
): string {
  return `sim:${provider}:${chainId ?? 'none'}:${tokenAddress.toLowerCase()}`
}

export function isTradingSimulationCacheHitValid(
  cached: { chainId: number | null; tokenAddress: string; provider: TradingSimulationProvider },
  selected: { chainId: number | null; tokenAddress: string; provider: TradingSimulationProvider },
): boolean {
  return (
    cached.chainId === selected.chainId
    && cached.provider === selected.provider
    && cached.tokenAddress.toLowerCase() === selected.tokenAddress.toLowerCase()
  )
}

function taxLooksRisky(buyTax: number | null, sellTax: number | null): boolean {
  return (buyTax != null && buyTax > 8) || (sellTax != null && sellTax > 8)
}

export function classifyTradingSimulation(input: ClassifyTradingSimulationInput): TradingSimulationAudit {
  const chainSlug = normalizeSlug(input.chainSlug)
  const support = tradingSimulationSupportFor(chainSlug, input.chainId)
  const chainId = support.chainId ?? input.chainId ?? null
  const tokenAddress = (input.tokenAddress || '').toLowerCase()
  const timedOut = Boolean(input.timedOut) || input.honeypotStatus === 'timeout'
  const providerSelected: TradingSimulationProvider =
    input.providerSelected
    ?? (support.honeypotIs ? 'honeypot_is' : support.goplus ? 'goplus' : 'none')
  const providerSupportsChain = providerSupportsTradingSimulation(support, providerSelected)
  const requestChainId = input.requestChainId ?? (input.requestAttempted ? chainId : null)
  const cacheKey = input.cacheKey ?? buildTradingSimulationCacheKey(chainId, tokenAddress, providerSelected)

  let finalStatus: TradingSimulationFinalStatus
  let finalReason: string

  if (support.notApplicable || chainSlug === 'solana') {
    finalStatus = 'not_applicable'
    finalReason = SOLANA_SIM_NOT_APPLICABLE_REASON
  } else if (timedOut) {
    finalStatus = 'provider_timeout'
    finalReason = input.honeypotReason || input.responseError || 'Trading simulation timed out.'
  } else if (chainId === ROBINHOOD_SIM_CHAIN_ID || chainSlug === 'robinhood') {
    if (!providerSupportsChain) {
      finalStatus = 'unsupported_on_robinhood'
      finalReason = ROBINHOOD_SIM_UNSUPPORTED_REASON
    } else if (input.honeypotResult === true || taxLooksRisky(input.buyTax ?? null, input.sellTax ?? null)) {
      finalStatus = 'risk_detected'
      finalReason = input.honeypotResult === true
        ? 'Trading simulation flagged a blocked or trapped sell path.'
        : 'Trading simulation confirmed elevated buy/sell tax.'
    } else if (input.honeypotResult === false && input.simulationSuccess === true) {
      finalStatus = 'verified_clear'
      finalReason = 'Trading simulation verified — no honeypot pattern detected.'
    } else {
      finalStatus = 'unsupported_on_robinhood'
      finalReason = ROBINHOOD_SIM_UNSUPPORTED_REASON
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
    providerSelected,
    providerSupportsChain,
    requestAttempted: Boolean(input.requestAttempted) && providerSupportsChain,
    requestChainId: providerSupportsChain ? requestChainId : null,
    cacheKey,
    cacheHit: Boolean(input.cacheHit),
    cacheChainMatches: input.cacheChainMatches !== false,
    responseStatus: input.responseStatus ?? null,
    responseError: input.responseError ?? null,
    timedOut,
    honeypotResult: input.honeypotResult ?? null,
    buyTax: input.buyTax ?? null,
    sellTax: input.sellTax ?? null,
    finalStatus,
    finalReason,
  }
}

export function buildTradingSimulationUi(audit: TradingSimulationAudit): TradingSimulationUi {
  const taxOrDash = (n: number | null) => (n == null ? 'Unavailable' : `${n.toFixed(1)}%`)
  if (audit.finalStatus === 'unsupported_on_robinhood') {
    return {
      statusLabel: ROBINHOOD_SIM_UNSUPPORTED_STATUS,
      reason: ROBINHOOD_SIM_UNSUPPORTED_REASON,
      impact: ROBINHOOD_SIM_UNSUPPORTED_IMPACT,
      badge: 'UNSUPPORTED',
      honeypotValue: ROBINHOOD_SIM_UNSUPPORTED_STATUS,
      buyTaxValue: ROBINHOOD_SIM_UNSUPPORTED_STATUS,
      sellTaxValue: ROBINHOOD_SIM_UNSUPPORTED_STATUS,
      showTaxRows: false,
      treatAsOpenRisk: true,
    }
  }
  if (audit.finalStatus === 'not_applicable') {
    return {
      statusLabel: 'Not applicable',
      reason: audit.finalReason,
      impact: null,
      badge: 'NOT APPLICABLE',
      honeypotValue: 'Not applicable',
      buyTaxValue: 'Not applicable',
      sellTaxValue: 'Not applicable',
      showTaxRows: false,
      treatAsOpenRisk: false,
    }
  }
  if (audit.finalStatus === 'provider_timeout') {
    return {
      statusLabel: 'Timed out',
      reason: audit.finalReason,
      impact: 'Taxes and sell-block simulation could not be verified. Treat as an open risk.',
      badge: 'TIMED OUT',
      honeypotValue: 'Timed out',
      buyTaxValue: 'Timed out',
      sellTaxValue: 'Timed out',
      showTaxRows: false,
      treatAsOpenRisk: true,
    }
  }
  if (audit.finalStatus === 'provider_unavailable') {
    return {
      statusLabel: 'Provider unavailable',
      reason: audit.finalReason,
      impact: 'Taxes and sell-block simulation could not be verified. Treat as an open risk.',
      badge: 'UNAVAILABLE',
      honeypotValue: 'Provider unavailable',
      buyTaxValue: 'Provider unavailable',
      sellTaxValue: 'Provider unavailable',
      showTaxRows: false,
      treatAsOpenRisk: true,
    }
  }
  if (audit.finalStatus === 'unavailable_with_reason') {
    return {
      statusLabel: `Unavailable: ${audit.finalReason}`,
      reason: audit.finalReason,
      impact: 'Taxes and sell-block simulation could not be verified. Treat as an open risk.',
      badge: 'UNAVAILABLE',
      honeypotValue: `Unavailable: ${audit.finalReason}`,
      buyTaxValue: `Unavailable: ${audit.finalReason}`,
      sellTaxValue: `Unavailable: ${audit.finalReason}`,
      showTaxRows: false,
      treatAsOpenRisk: true,
    }
  }
  if (audit.finalStatus === 'risk_detected') {
    return {
      statusLabel: 'Risk detected',
      reason: audit.finalReason,
      impact: null,
      badge: 'RISK DETECTED',
      honeypotValue: audit.honeypotResult === true ? 'YES' : audit.honeypotResult === false ? 'NO' : 'Risk detected',
      buyTaxValue: taxOrDash(audit.buyTax),
      sellTaxValue: taxOrDash(audit.sellTax),
      showTaxRows: true,
      treatAsOpenRisk: true,
    }
  }
  return {
    statusLabel: 'Verified clear',
    reason: audit.finalReason,
    impact: null,
    badge: 'VERIFIED CLEAR',
    honeypotValue: audit.honeypotResult === true ? 'YES' : 'NO',
    buyTaxValue: taxOrDash(audit.buyTax),
    sellTaxValue: taxOrDash(audit.sellTax),
    showTaxRows: true,
    treatAsOpenRisk: false,
  }
}

export function emptyTradingSimulationAudit(tokenAddress: string, chainSlug: string, chainId: number | null): TradingSimulationAudit {
  return classifyTradingSimulation({
    chainSlug,
    chainId,
    tokenAddress,
    providerSelected: 'none',
    requestAttempted: false,
  })
}
