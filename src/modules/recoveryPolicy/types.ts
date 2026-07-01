// MODULE 5 — recoveryPolicy: type definitions.
//
// The ONLY module (besides providerFetchWindow) permitted to make a network call, and the ONLY
// module allowed to fetch HISTORICAL pages beyond the base 30-40 day window (Architecture Step 4
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

export type RecoveryPolicyResult = {
  triggerRecoveryWhen: RecoveryPolicyTriggerConfig
  caps: RecoveryPolicyCaps
  evaluation: RecoveryEvaluationEntry[]
  totalPagesUsedThisWallet: number
}

export const DEFAULT_TRIGGER_RECOVERY_WHEN: RecoveryPolicyTriggerConfig = {
  token_value_usd_gte: 1000,
  in_top_3_holdings: true,
  repeated_in_sell_timeline_min_count: 2,
}

// Architecture Step 4 §4 / Step 8 §3: fixed caps, never overridable by a request.
export const DEFAULT_RECOVERY_CAPS: RecoveryPolicyCaps = {
  maxHistoricalPagesPerWallet: 3,
  maxHistoricalPagesPerToken: 2,
}
