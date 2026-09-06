import { getTokenCache, setTokenCache } from './cache/tokenCache'
import {
  buildTradingSimulationCacheKey,
  classifyTradingSimulation,
  isTradingSimulationCacheHitValid,
  tradingSimulationCacheTtlSeconds,
  tradingSimulationSupportFor,
  type ClassifyTradingSimulationInput,
  type TradingSimulationAudit,
  type TradingSimulationProvider,
} from '../tradingSimulation'

export interface ResolveTradingSimulationInput {
  chainSlug: string
  chainId: number | null
  tokenAddress: string
  poolAddress?: string | null
  providerSelected: TradingSimulationProvider
  requestAttempted: boolean
  requestChainId: number | null
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
  skipCache?: boolean
}

export async function resolveTradingSimulationAudit(input: ResolveTradingSimulationInput): Promise<TradingSimulationAudit> {
  const support = tradingSimulationSupportFor(input.chainSlug, input.chainId)
  const provider: TradingSimulationProvider = input.providerSelected
  const chainId = support.chainId ?? input.chainId
  const tokenAddress = input.tokenAddress.toLowerCase()
  const poolAddress = input.poolAddress ?? null
  const cacheKey = buildTradingSimulationCacheKey(chainId, tokenAddress, provider, poolAddress)
  const selected = { chainId, tokenAddress, provider, poolAddress }

  if (!input.skipCache) {
    const cached = await getTokenCache<{
      chainId: number | null
      tokenAddress: string
      provider: TradingSimulationProvider
      poolAddress?: string | null
      audit: TradingSimulationAudit
      cachedAt?: number
    }>(cacheKey)
    if (
      cached?.audit
      && isTradingSimulationCacheHitValid(cached, selected)
    ) {
      const cacheAgeMs = cached.cachedAt != null ? Math.max(0, Date.now() - cached.cachedAt) : 0
      return {
        ...cached.audit,
        cacheHit: true,
        cacheChainMatches: true,
        cacheKey,
        cachedStatus: cached.audit.finalStatus,
        cacheAgeMs,
      }
    }
  }

  const classifyInput: ClassifyTradingSimulationInput = {
    chainSlug: input.chainSlug,
    chainId,
    tokenAddress,
    poolAddress,
    providerSelected: provider,
    requestAttempted: input.requestAttempted,
    requestChainId: input.requestChainId,
    cacheKey,
    cacheHit: false,
    cacheChainMatches: true,
    responseStatus: input.responseStatus ?? null,
    responseError: input.responseError ?? null,
    timedOut: input.timedOut,
    honeypotResult: input.honeypotResult ?? null,
    buyTax: input.buyTax ?? null,
    sellTax: input.sellTax ?? null,
    sellable: input.sellable ?? null,
    simulationSuccess: input.simulationSuccess ?? null,
    honeypotStatus: input.honeypotStatus ?? null,
    honeypotReason: input.honeypotReason ?? null,
  }
  const audit = classifyTradingSimulation(classifyInput)
  const ttl = tradingSimulationCacheTtlSeconds(audit.finalStatus)
  if (!input.skipCache && ttl > 0) {
    await setTokenCache(cacheKey, { ...selected, audit, cachedAt: Date.now() }, ttl)
  }
  return audit
}
