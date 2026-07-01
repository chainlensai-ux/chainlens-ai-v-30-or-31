// MODULE 12 — portfolioAssembler: pure helper functions.

import type { SupportedChain } from '../providerFetchWindow/types'
import type { TokenPrice } from '../pricing/types'

export function priceKey(chain: SupportedChain, contract: string): string {
  return `${chain}:${contract.toLowerCase()}`
}

export function buildPriceLookup(prices: TokenPrice[]): Map<string, number | null> {
  const map = new Map<string, number | null>()
  for (const p of prices) map.set(priceKey(p.chain, p.contract), p.priceUsd)
  return map
}
