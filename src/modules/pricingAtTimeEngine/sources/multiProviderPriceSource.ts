// MODULE — pricingAtTimeEngine/sources: multiProviderPriceSource
//
// Orchestrator only — real per-provider logic now lives in dexscreener.ts / coingecko.ts /
// basedex.ts (split out for modularization; logic is unchanged from before the split). Provider
// priority: DexScreener -> CoinGecko -> Base-native Uniswap V3 (Base only) -> null. Never
// fabricates a price — every branch below is a real HTTP/RPC call (inside the imported provider
// functions) or an honest null with a structured debug reason.

import type { SupportedChain } from '../../providerFetchWindow/types'
import { fetchDexscreenerPriceDetailed } from './dexscreener'
import { fetchCoingeckoPriceDetailed } from './coingecko'
import { fetchBaseDexPriceDetailed } from './basedex'

export type PriceProviderName = 'dexscreener' | 'coingecko' | 'base_dex' | 'none'

export type GetPriceAtTimeParams = {
  chain: SupportedChain
  tokenAddress: string
  timestamp: number
}

export type ProviderAttemptDebug = {
  provider: PriceProviderName
  attempted: boolean
  ok: boolean
  reason: string | null
  durationMs: number
}

export type GetPriceAtTimeResult = {
  priceUsd: number | null
  source: PriceProviderName
  debug: {
    chain: SupportedChain
    tokenAddress: string
    timestamp: number
    attempts: ProviderAttemptDebug[]
  }
}

type ProviderAttemptResult = { priceUsd: number | null; reason: string | null }

export async function getPriceAtTime(params: GetPriceAtTimeParams): Promise<GetPriceAtTimeResult> {
  const attempts: ProviderAttemptDebug[] = []

  const run = async (
    provider: Exclude<PriceProviderName, 'none'>,
    fn: (token: string, chain: SupportedChain, timestamp: number) => Promise<ProviderAttemptResult>,
  ): Promise<number | null> => {
    const start = Date.now()
    const result = await fn(params.tokenAddress, params.chain, params.timestamp)
    attempts.push({ provider, attempted: true, ok: result.priceUsd !== null, reason: result.reason, durationMs: Date.now() - start })
    return result.priceUsd
  }

  const dexScreenerPrice = await run('dexscreener', fetchDexscreenerPriceDetailed)
  if (dexScreenerPrice !== null) {
    return { priceUsd: dexScreenerPrice, source: 'dexscreener', debug: { ...params, attempts } }
  }

  const coinGeckoPrice = await run('coingecko', fetchCoingeckoPriceDetailed)
  if (coinGeckoPrice !== null) {
    return { priceUsd: coinGeckoPrice, source: 'coingecko', debug: { ...params, attempts } }
  }

  if (params.chain === 'base') {
    const baseDexPrice = await run('base_dex', fetchBaseDexPriceDetailed)
    if (baseDexPrice !== null) {
      return { priceUsd: baseDexPrice, source: 'base_dex', debug: { ...params, attempts } }
    }
  }

  return { priceUsd: null, source: 'none', debug: { ...params, attempts } }
}

// Adapter onto this codebase's existing PriceSourceFn contract (see ../types.ts) — lets this
// engine plug into pricingAtTimeEngine/pipeline the exact same way goldrushPriceSource does,
// without changing resolvePricingAtTime's own signature or logic.
export function multiProviderPriceSource(): (token: string, chain: SupportedChain, timestamp: number) => Promise<number | null> {
  return async (token, chain, timestamp) => {
    const result = await getPriceAtTime({ chain, tokenAddress: token, timestamp })
    return result.priceUsd
  }
}
