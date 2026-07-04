// lib/engine/modules/activity/types.ts — shared types for the new chain activity module.
//
// FILE-LOCATION DISCLOSURE (same as holdings/pricing/portfolio/pnl before it): no single shared
// "engine types" file exists anywhere in this codebase — co-located with this module instead.
//
// SHAPES, EXACTLY AS SPECIFIED (no changes).

export type ChainActivityRecord = {
  chainId: number
  lastActiveAt: string | null
  activityLevel: 'high' | 'medium' | 'low' | 'dust-only'
  primaryUse: 'trading' | 'bridging' | 'farming' | 'memecoins' | 'stable-routing' | 'lp' | 'other'
  txCount30d: number
  valueHeldUsd: number
  valueMovedUsd30d: number
}

export type ChainActivityEngineOutput = {
  chainActivityV2: ChainActivityRecord[]
  chainActivityStatus: 'ok' | 'empty' | 'partial'
}
