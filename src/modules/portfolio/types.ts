// MODULE 12 — portfolioAssembler: type definitions.
//
// Pure combination of holdingsEngine (balances) + pricingEngine (current prices) into a
// portfolio view — no network calls, no side effects. A token with no resolvable price
// contributes a null valueUsd, never a guessed one; totalValueUsd is null (not 0) when nothing
// could be priced at all.

import type { SupportedChain } from '../providerFetchWindow/types'

export type TokenListEntry = {
  chain: SupportedChain
  contract: string
  symbol: string
  name: string | null
  amount: number
  priceUsd: number | null
  valueUsd: number | null
}

export type ChainValueBreakdownEntry = {
  chain: SupportedChain
  valueUsd: number
  percent: number
}

export type PortfolioSummary = {
  totalValueUsd: number | null
  tokens: TokenListEntry[]
  chainValueBreakdown: ChainValueBreakdownEntry[]
}
