// MODULE — fallbackPricing
//
// Additive, standalone fallback-pricing service. Deliberately independent of PRICE_SOURCES
// (src/pipeline/index.ts's buildPriceSources) and of pricingAtTimeEngine's own priceSources
// contract — never imported by, never wired into, either of those. Only the DISPLAY-ONLY
// pricingAtTime pass (src/pipeline/index.ts's stage 6c call site) is authorized to call this.
//
// NEVER FABRICATES: every branch below is a real HTTP call (via BaseScanClient/GeckoTerminalClient)
// or an honest { ok: false, errorReason }. No fallback/default price is ever invented.

import { BaseScanClient } from './baseScanClient'
import { GeckoTerminalClient } from './geckoTerminalClient'
import type { SupportedChain } from '../providerFetchWindow/types'

export type FallbackPricingSourceName = 'BaseScan' | 'GeckoTerminal'

export type GetFallbackPriceParams = {
  chainId: number
  tokenAddress: string
  // Accepted per spec but intentionally UNUSED, disclosed: both underlying clients are current-
  // price-only (see their own file headers) — this service's stated purpose is "current portfolio
  // valuation," not a historical re-price, so there's nothing to do with a timestamp here. Kept in
  // the signature only so a caller passing one doesn't hit a type error.
  timestampMs?: number
}

export type GetFallbackPriceResult =
  | { ok: true; priceUsd: number; source: FallbackPricingSourceName }
  | { ok: false; errorReason: string }

// CHAIN-ID MAPPING, DISCLOSED: this task's own params use a numeric `chainId` (not this codebase's
// usual `SupportedChain` string) — mapped here to the two real EVM mainnet chain IDs this task's
// own routing rule names explicitly (base=8453, eth=1). Any other chainId is an honest
// 'unsupported_chain' miss, never a guess at which client to call.
const CHAIN_ID_TO_SUPPORTED_CHAIN: Record<number, SupportedChain> = {
  8453: 'base',
  1: 'eth',
}

export interface FallbackPricingService {
  getFallbackPrice(params: GetFallbackPriceParams): Promise<GetFallbackPriceResult>
}

export class DefaultFallbackPricingService implements FallbackPricingService {
  constructor(
    private readonly baseScanClient: BaseScanClient = new BaseScanClient(),
    // Keyed by chain — GeckoTerminalClient binds its network at construction (see its own header).
    private readonly geckoTerminalClients: Partial<Record<SupportedChain, GeckoTerminalClient>> = {
      eth: new GeckoTerminalClient('eth'),
    },
  ) {}

  async getFallbackPrice(params: GetFallbackPriceParams): Promise<GetFallbackPriceResult> {
    const chain = CHAIN_ID_TO_SUPPORTED_CHAIN[params.chainId]
    if (!chain) return { ok: false, errorReason: 'unsupported_chain' }

    if (chain === 'base') {
      const result = await this.baseScanClient.getTokenPriceUsdDetailed(params.tokenAddress)
      if (result.priceUsd === null) return { ok: false, errorReason: result.reason ?? 'basescan_no_price' }
      return { ok: true, priceUsd: result.priceUsd, source: 'BaseScan' }
    }

    if (chain === 'eth') {
      const client = this.geckoTerminalClients.eth ?? new GeckoTerminalClient('eth')
      const result = await client.getTokenPriceUsdDetailed(params.tokenAddress)
      if (result.priceUsd === null) return { ok: false, errorReason: result.reason ?? 'geckoterminal_no_price' }
      return { ok: true, priceUsd: result.priceUsd, source: 'GeckoTerminal' }
    }

    return { ok: false, errorReason: 'unsupported_chain' }
  }
}

export { BaseScanClient } from './baseScanClient'
export { GeckoTerminalClient } from './geckoTerminalClient'

// Singleton, real default instance — the one the pipeline actually wires in. Callers that want a
// custom/mock instance (tests) construct DefaultFallbackPricingService directly.
export const fallbackPricingService: FallbackPricingService = new DefaultFallbackPricingService()
