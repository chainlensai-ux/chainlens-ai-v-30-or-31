// MODULE 12 — portfolioAssembler
//
// Pure combination of holdings + prices into a portfolio view. No network calls of its own — it
// only reads what holdingsEngine and pricingEngine already produced.

import type { SupportedChain } from '../providerFetchWindow/types'
import type { TokenHolding } from '../holdings/types'
import type { TokenPrice } from '../pricing/types'
import type { ChainValueBreakdownEntry, PortfolioSummary, TokenListEntry } from './types'
import { buildPriceLookup, priceKey } from './utils'

export type { ChainValueBreakdownEntry, PortfolioSummary, TokenListEntry } from './types'

export function buildPortfolioSummary(holdings: TokenHolding[], prices: TokenPrice[]): PortfolioSummary {
  const priceLookup = buildPriceLookup(prices)

  const tokens: TokenListEntry[] = holdings.map((h) => {
    const resolvedPrice = h.providerPriceUsd ?? priceLookup.get(priceKey(h.chain, h.contract)) ?? null
    const valueUsd = resolvedPrice != null ? resolvedPrice * h.amount : null
    return {
      chain: h.chain,
      contract: h.contract,
      symbol: h.symbol,
      name: h.name,
      amount: h.amount,
      priceUsd: resolvedPrice,
      valueUsd,
    }
  })

  const pricedTokens = tokens.filter((t) => t.valueUsd != null)
  const totalValueUsd = pricedTokens.length > 0 ? pricedTokens.reduce((sum, t) => sum + (t.valueUsd as number), 0) : null

  const valueByChain = new Map<SupportedChain, number>()
  for (const t of pricedTokens) {
    valueByChain.set(t.chain, (valueByChain.get(t.chain) ?? 0) + (t.valueUsd as number))
  }

  const chainValueBreakdown: ChainValueBreakdownEntry[] = [...valueByChain.entries()].map(([chain, valueUsd]) => ({
    chain,
    valueUsd,
    percent: totalValueUsd && totalValueUsd > 0 ? (valueUsd / totalValueUsd) * 100 : 0,
  }))

  return { totalValueUsd, tokens, chainValueBreakdown }
}
