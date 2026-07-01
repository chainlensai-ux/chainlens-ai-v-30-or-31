// MODULE 10 — holdingsEngine
//
// Fetches current token balances for a wallet on a single chain. Follows the same
// fetch/merge/provider-status pattern as providerFetchWindow (module 1): try GoldRush, fall back
// to Alchemy if it fails, mark provider_unavailable only if both fail. One bounded call per
// provider per chain — never paginated, never repeated.

import type { ProviderStatus, SupportedChain } from '../providerFetchWindow/types'
import type { HoldingsFetchResult, TokenHolding } from './types'
import { dedupeHoldingsKey, fetchAlchemyHoldings, fetchGoldrushHoldings } from './utils'

export type { HoldingsFetchResult, TokenHolding } from './types'

export function mergeHoldingsResults(goldrushHoldings: TokenHolding[], alchemyHoldings: TokenHolding[]): TokenHolding[] {
  const merged = new Map<string, TokenHolding>()
  // GoldRush holdings are preferred when both providers report the same token — GoldRush's copy
  // carries a real symbol, decimals, and often a price; Alchemy's copy (without an extra metadata
  // call) doesn't.
  for (const holding of [...goldrushHoldings, ...alchemyHoldings]) {
    const key = dedupeHoldingsKey(holding)
    if (!merged.has(key)) merged.set(key, holding)
  }
  return [...merged.values()]
}

export function detectHoldingsProviderUnavailable(goldrushOk: boolean, alchemyOk: boolean): ProviderStatus {
  if (goldrushOk && alchemyOk) return 'ok'
  if (goldrushOk || alchemyOk) return 'partial'
  return 'provider_unavailable'
}

export async function fetchHoldings(chain: SupportedChain, walletAddress: string): Promise<HoldingsFetchResult> {
  const [goldrush, alchemy] = await Promise.all([
    fetchGoldrushHoldings(chain, walletAddress),
    fetchAlchemyHoldings(chain, walletAddress),
  ])

  const providerStatus = detectHoldingsProviderUnavailable(goldrush.ok, alchemy.ok)
  const holdings = providerStatus === 'provider_unavailable' ? [] : mergeHoldingsResults(goldrush.holdings, alchemy.holdings)

  return { chain, providerStatus, holdings }
}
