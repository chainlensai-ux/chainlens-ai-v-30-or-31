// lib/engine/modules/holdings/types.ts — shared types for the new ChainHolding holdings module.
//
// FILE-LOCATION DISCLOSURE: the task asked for these types to live "in the engine types file
// (where other engine inputs live)" — no single shared engine-types file exists anywhere in this
// codebase (each lib/engines/*.ts file — pricingAtTimeEngine.ts, unrealizedPnlEngine.ts,
// tradeTimelineEngineV2.ts, smartMoneyScoreEngine.ts, metadataEngine.ts — defines its own types
// inline, co-located with its own logic). Rather than fabricate a new shared file that doesn't
// match this codebase's actual convention, these types are co-located with the new module itself,
// consistent with every other engine file's own pattern.
//
// SHAPE, EXACTLY AS SPECIFIED (no changes):

export type ChainHolding = {
  chainId: number
  tokenAddress: string
  symbol: string
  decimals: number
  quantity: string // kept as string, per request
  lastActivityAt: string | null // ISO or null
  classification: 'stable' | 'blue_chip' | 'meme' | 'lp' | 'other'
}

export type HoldingsEngineInput = {
  walletAddress: string
  holdings: ChainHolding[]
}
