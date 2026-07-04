// lib/engine/modules/personality/types.ts — shared types for the new wallet personality module.
//
// FILE-LOCATION DISCLOSURE (same as every prior module this task chain): no single shared "engine
// types" file exists anywhere in this codebase — co-located with this module instead.
//
// "EXISTING personality/intelligence FIELD", DISCLOSED: verified by search before writing anything
// — the real existing field is `finalSummary.walletPersonality` (src/modules/finalReportAssembler/
// types.ts, a plain `string`, rendered by app/frontend/components/FinalSummaryView.tsx). It is
// nested under `finalSummary`, not a top-level `personality` key, so there is no name collision
// with the new top-level `personalityV2`/`personalityStatus` fields this task adds — both coexist,
// `finalSummary.walletPersonality` is completely untouched.
//
// SHAPES, EXACTLY AS SPECIFIED (no changes).

export type PersonalityV2 = {
  archetype: string // e.g. "Degen Trader", "Stable Farmer", "Blue-Chip Holder", etc.
  riskAppetite: 'low' | 'medium' | 'high'
  tradingStyle: 'active' | 'occasional' | 'passive'
  chainPreference: number | null // chainId
  volatilityTolerance: number // 0-1
  stabilityPreference: number // 0-1
  pnlBehavior: 'profit-seeking' | 'loss-averse' | 'neutral'
  activityConsistency: 'consistent' | 'sporadic' | 'dormant'
  summary: string // human-readable personality description
}

export type PersonalityEngineOutput = {
  personalityV2: PersonalityV2
  personalityStatus: 'ok' | 'empty' | 'partial'
}
