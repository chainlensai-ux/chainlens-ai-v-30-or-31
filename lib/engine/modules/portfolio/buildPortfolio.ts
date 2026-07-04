// lib/engine/modules/portfolio/buildPortfolio.ts — new portfolio module, consuming
// lib/engine/modules/pricing's PricedHolding[]/totalValueUsd/chainValueUsd.
//
// PURE, DISCLOSED: everything below is synchronous arithmetic over already-computed data — no
// network calls, no provider dependency. Declared `async` only because the task's own spec
// requires `Promise<PortfolioEngineOutput>` (kept exactly as specified, for a consistent call
// signature alongside fetchAllHoldings/priceHoldings, even though nothing here actually awaits).
//
// CONCENTRATION INDEX, DISCLOSED: the task offered two options — "simple version: sum of top 5
// holdings' percentages" (listed as the primary spec) and an "optional" Herfindahl index (sum of
// squared percentages). Implemented the simple top-5-percentage-sum version, since a single numeric
// field can only carry one formula and the task marked Herfindahl explicitly optional — not
// computed here, so a reader comparing this number to a real Herfindahl index elsewhere wouldn't
// silently get the wrong impression of what it measures.
//
// PERCENTAGE CONVENTION, DISCLOSED: every `percentage` field below (categories/chains/topHoldings)
// is a 0-1 fraction of totalValueUsd, matching `stablecoinRatio`'s own explicitly-specified 0-1
// convention — the task never asked for a 0-100 scale, so this stays consistent across every field
// rather than mixing conventions.

import type { PricedHolding } from '../pricing/types'
import type { Portfolio, PortfolioCategoryBreakdown, PortfolioChainBreakdown, PortfolioEngineOutput, PortfolioTopHolding } from './types'

const EMPTY_PORTFOLIO: Portfolio = {
  totalValueUsd: 0,
  categories: [],
  chains: [],
  topHoldings: [],
  stablecoinRatio: 0,
  concentrationIndex: 0,
}

function safeDivide(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0
}

export async function buildPortfolio(
  pricedHoldings: PricedHolding[],
  totalValueUsd: number,
  chainValueUsd: Record<number, number>,
): Promise<PortfolioEngineOutput> {
  // A. Empty case — exactly as specified.
  if (pricedHoldings.length === 0) {
    return { portfolio: EMPTY_PORTFOLIO, portfolioStatus: 'empty' }
  }

  // B. Category breakdown — grouped only by classifications actually present, per the task's own
  // "single holding -> categories length = 1" test case (never a fabricated zero-value row for a
  // classification that isn't held).
  const categoryTotals = new Map<string, number>()
  for (const h of pricedHoldings) {
    categoryTotals.set(h.classification, (categoryTotals.get(h.classification) ?? 0) + (h.valueUsd ?? 0))
  }
  const categories: PortfolioCategoryBreakdown[] = [...categoryTotals.entries()].map(([category, valueUsd]) => ({
    category,
    valueUsd,
    percentage: safeDivide(valueUsd, totalValueUsd),
  }))

  // C. Chain breakdown.
  const chains: PortfolioChainBreakdown[] = Object.entries(chainValueUsd).map(([chainIdStr, valueUsd]) => ({
    chainId: Number(chainIdStr),
    valueUsd,
    percentage: safeDivide(valueUsd, totalValueUsd),
  }))

  // D. Top holdings — top 5 by valueUsd desc. Holdings with a null valueUsd (unpriced) sort last
  // and are excluded from "top" (they have no real value to rank by) rather than being treated as
  // 0 and potentially displacing a real, smaller-but-actually-priced holding.
  const rankable = pricedHoldings.filter((h): h is PricedHolding & { valueUsd: number } => h.valueUsd != null)
  const topHoldings: PortfolioTopHolding[] = [...rankable]
    .sort((a, b) => b.valueUsd - a.valueUsd)
    .slice(0, 5)
    .map((h) => ({
      tokenAddress: h.tokenAddress,
      symbol: h.symbol,
      valueUsd: h.valueUsd,
      percentage: safeDivide(h.valueUsd, totalValueUsd),
      chainId: h.chainId,
    }))

  // E. Stablecoin ratio.
  const stableValueUsd = pricedHoldings
    .filter((h) => h.classification === 'stable')
    .reduce((sum, h) => sum + (h.valueUsd ?? 0), 0)
  const stablecoinRatio = safeDivide(stableValueUsd, totalValueUsd)

  // F. Concentration index — simple version, see file header disclosure.
  const concentrationIndex = topHoldings.reduce((sum, h) => sum + h.percentage, 0)

  // G. portfolioStatus. Order matters: "some holdings unpriced" is checked BEFORE "totalValueUsd >
  // 0", since a partially-priced portfolio can still have a positive total from the holdings that
  // DID price — per the task's own "partial pricing -> portfolioStatus = partial" test case.
  const hasUnpriced = pricedHoldings.some((h) => h.valueUsd == null)
  const portfolioStatus: PortfolioEngineOutput['portfolioStatus'] = hasUnpriced
    ? 'partial'
    : totalValueUsd > 0
      ? 'ok'
      : 'empty'

  return {
    portfolio: { totalValueUsd, categories, chains, topHoldings, stablecoinRatio, concentrationIndex },
    portfolioStatus,
  }
}
