// lib/engine/modules/behavior/types.ts — shared types for the new behavior module.
//
// FILE-LOCATION DISCLOSURE (same as every prior module this task chain): no single shared "engine
// types" file exists anywhere in this codebase — co-located with this module instead.
//
// "EXISTING behavior/intelligence FIELD", DISCLOSED: verified before writing anything — the real
// existing field is `behaviorIntel` (src/modules/behaviorIntel, a real `BehaviorIntelResult` object
// already computed by the production pipeline). It is a different top-level key from the new
// `behaviorV2` this task adds — no collision/rename needed; both coexist, `behaviorIntel` untouched.
//
// SHAPES, EXACTLY AS SPECIFIED (no changes).

export type BehaviorV2 = {
  accumulationStyle: 'accumulator' | 'distributor' | 'neutral'
  rotationStyle: 'rotating' | 'holding' | 'inactive'
  bridgingBehavior: 'bridge-heavy' | 'bridge-light' | 'none'
  farmingBehavior: 'farmer' | 'occasional' | 'none'
  stableRoutingBehavior: 'router' | 'occasional' | 'none'
  memeBehavior: 'meme-active' | 'meme-curious' | 'none'
  tradeFrequency: 'high' | 'medium' | 'low'
  behaviorSummary: string
}

export type BehaviorEngineOutput = {
  behaviorV2: BehaviorV2
  behaviorStatus: 'ok' | 'empty' | 'partial'
}
