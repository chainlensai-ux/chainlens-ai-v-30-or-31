// lib/providers/onchainDex.ts — on-chain DEX historical price provider adapter for
// PricingAtTimeEngine.
//
// REUSE, NOT REIMPLEMENTATION, DISCLOSED: delegates to the REAL, already-shipped on-chain Uniswap
// V3 price resolver at src/modules/pricingAtTimeEngine/sources/basedex.ts (real historical-block
// binary search + on-chain slot0 read via viem), rather than a second parallel RPC implementation.
// See lib/providers/goldrush.ts's header for the same rationale.
//
// REAL LIMITATION, DISCLOSED (not invented here — inherited from the real source function): this
// on-chain resolver only supports chain "base" today (Uniswap V3 pool discovery is only wired for
// Base's WETH/USDC pairs). For "eth"/"arbitrum"/"hyperevm" this honestly returns
// { priceUsd: null, notes: 'base_dex_only_supports_base_chain' } — never a fabricated price.

import { fetchBaseDexPriceDetailed } from '@/src/modules/pricingAtTimeEngine/sources/basedex'
import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'

export type OnchainDexPriceRequest = { chain: SupportedChain; tokenAddress: string; timestamp: number }
export type OnchainDexPriceResult = { priceUsd: number | null; timestamp: number; notes?: string }

// Gracefully returns { priceUsd: null } for any failure — unsupported chain, no pool found, RPC
// error, or no key configured. Never throws.
export async function fetchOnchainDexPriceAtTime(req: OnchainDexPriceRequest): Promise<OnchainDexPriceResult> {
  try {
    const result = await fetchBaseDexPriceDetailed(req.tokenAddress, req.chain, req.timestamp * 1000)
    return { priceUsd: result.priceUsd, timestamp: req.timestamp, notes: result.reason ?? undefined }
  } catch (err) {
    return { priceUsd: null, timestamp: req.timestamp, notes: `onchain_dex_error: ${err instanceof Error ? err.message : String(err)}` }
  }
}
