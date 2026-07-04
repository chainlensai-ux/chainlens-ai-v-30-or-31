// lib/engine/modules/portfolio/types.ts — shared types for the new portfolio module.
//
// FILE-LOCATION DISCLOSURE (same as the holdings/pricing modules before it): no single shared
// "engine types" file exists anywhere in this codebase — co-located with this module instead.
//
// SHAPE, EXACTLY AS SPECIFIED (no changes).

export type PortfolioCategoryBreakdown = {
  category: string // stable, blue_chip, meme, lp, other
  valueUsd: number
  percentage: number // of total portfolio value
}

export type PortfolioChainBreakdown = {
  chainId: number
  valueUsd: number
  percentage: number
}

export type PortfolioTopHolding = {
  tokenAddress: string
  symbol: string
  valueUsd: number
  percentage: number
  chainId: number
}

export type Portfolio = {
  totalValueUsd: number
  categories: PortfolioCategoryBreakdown[]
  chains: PortfolioChainBreakdown[]
  topHoldings: PortfolioTopHolding[]
  stablecoinRatio: number // 0-1
  concentrationIndex: number // simple top-5 percentage sum — see buildPortfolio.ts's own disclosure
}

export type PortfolioEngineOutput = {
  portfolio: Portfolio
  portfolioStatus: 'ok' | 'empty' | 'partial'
}
