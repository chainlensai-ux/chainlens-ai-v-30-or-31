// MODULE 5 — recoveryPolicy: type definitions.
//
// The ONLY module (besides providerFetchWindow) permitted to make a network call, and the ONLY
// module allowed to fetch HISTORICAL pages beyond the base 80-100 day window (Architecture Step 4
// §5, Step 8 §3). Used strictly to unlock financial precision (cost basis / FIFO / PnL) for
// high-value or behavior-critical tokens — never to extend behavioral coverage.

import type { RawProviderEvent, SupportedChain } from '../providerFetchWindow/types'

export type RecoveryTriggerRule =
  | 'token_value_usd_gte'
  | 'in_top_3_holdings'
  | 'repeated_in_sell_timeline_min_count'

export type RecoveryTriggerEvidenceRef = {
  txHash: string
  timestamp: number
}

export type RecoveryTriggeredBy = {
  rule: RecoveryTriggerRule
  evidenceSource: 'buyTimeline' | 'sellTimeline'
  evidenceEntryRefs: RecoveryTriggerEvidenceRef[]
  detail: string
}

// Holdings/portfolio pricing is not part of this delivery (no such module exists yet) — callers
// supply current per-token USD value as an explicit input, same pattern as chainSelection's
// `visibleValueUsd`. Never fabricated by this module.
export type HoldingInput = {
  token: string
  chain: SupportedChain
  valueUsd: number
}

export type RecoveryPolicyTriggerConfig = {
  token_value_usd_gte: number
  in_top_3_holdings: boolean
  repeated_in_sell_timeline_min_count: number
}

export type RecoveryPolicyCaps = {
  maxHistoricalPagesPerWallet: number
  maxHistoricalPagesPerToken: number
}

export type RecoveryEvaluationEntry = {
  token: string
  chain: SupportedChain
  triggeredBy: RecoveryTriggeredBy[]
  recoveryTriggered: boolean
  pagesUsed: number
  recoveredEvents: RawProviderEvent[]
}

// PNL-RECOVERY-FLOW-FIX, DISCLOSED (Wallet Scanner PnL recovery bottleneck task) — a compact,
// per-token trace of the fetch-stage flow this module owns: triggered -> ranked -> included in the
// shared per-chain request -> matching events found -> entry/exit legs recovered. `priceRequirements`/
// `pricesResolved`/`lotsVerified` are always null here — this module runs strictly BEFORE
// fifoEngine/pricing (Architecture Step 4 §5, index.ts's own header) and structurally cannot import
// either, so it honestly cannot know those three outcomes; a caller with pricing/lot visibility
// (src/lib/walletPnlCoverageRecoveryAudit.ts) is the correct place to fill them in.
export type PnlRecoveryFlowAuditEntry = {
  token: string
  chain: SupportedChain
  lotCount: number
  ranked: number
  includedInSharedRequest: boolean
  pagesAvailable: number
  matchingEventsFound: number
  entryLotsRecovered: number
  exitLotsRecovered: number
  priceRequirements: number | null
  pricesResolved: number | null
  lotsVerified: number | null
  dropStage: 'not_triggered' | 'no_shared_request' | 'no_matching_events' | 'not_dropped'
  dropReason: string | null
}

export type RecoveryPolicyResult = {
  triggerRecoveryWhen: RecoveryPolicyTriggerConfig
  caps: RecoveryPolicyCaps
  evaluation: RecoveryEvaluationEntry[]
  totalPagesUsedThisWallet: number
  // Optional so any existing caller/test constructing a RecoveryPolicyResult without it keeps
  // compiling.
  pnlRecoveryFlowAudit?: PnlRecoveryFlowAuditEntry[]
}

// repeated_in_sell_timeline_min_count LOWERED 2 -> 1, DISCLOSED (real-scan evidence): a
// "distributor" wallet pattern — many distinct low-value tokens, each sold exactly once, never
// repeated — never triggered recovery under the old threshold of 2, because none of its sold
// tokens appear twice in the sell timeline. Confirmed via a real production scan: totalPagesUsedThisWallet
// was 0 despite missingEvidenceCount: 724, i.e. recovery was never attempted for any of the 92
// distinct tokens. Lowering to 1 lets a single real sell of a token also qualify for a targeted
// history fetch. token_value_usd_gte and in_top_3_holdings are untouched — those two, plus the
// existing maxHistoricalPagesPerWallet/maxHistoricalPagesPerToken caps below (also untouched),
// remain the real cost guardrails bounding how much this can grow provider spend.
export const DEFAULT_TRIGGER_RECOVERY_WHEN: RecoveryPolicyTriggerConfig = {
  token_value_usd_gte: 1000,
  in_top_3_holdings: true,
  repeated_in_sell_timeline_min_count: 1,
}

// Architecture Step 4 §4 / Step 8 §3: fixed caps, never overridable by a request.
//
// WINDOW EXPANSION (intel window 90 -> 180 days, base fetch window 35 -> 90 days): the gap a
// recovery pass may need to bridge grew from ~55 to ~90 days, so these caps were scaled up
// proportionally (roughly the same recovered-days-per-page ratio as before) rather than left fixed
// while the window they're covering doubled.
export const DEFAULT_RECOVERY_CAPS: RecoveryPolicyCaps = {
  maxHistoricalPagesPerWallet: 6,
  maxHistoricalPagesPerToken: 4,
}
