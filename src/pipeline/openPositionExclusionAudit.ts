// OPEN-POSITION-EXCLUSION-AUDIT, DISCLOSED, ADDITIVE (Wallet Scanner weak-spot pass —
// requested as `openPositionExclusionAudit`). Pure reshape of fifoEngine's already-computed
// UnrealizedReconciliationSummary. NEVER changes which positions are excluded, never changes
// officialUnrealizedPnlUsd, never invents a price/balance. Built so a scan log can answer
// "why is coverage ~15%?" with exact, public-language reasons instead of a single opaque percent.
//
// `unrealizedCoveragePercent` (fifoEngine) still counts FIFO leftovers with no canonical balance
// as coverage failures. `currentlyHeldCoveragePercent` restates `openPositionCoveragePercent`
// — the figure that answers "of positions this wallet actually still holds, how many were
// priced." Both are real; this audit reports both so neither is silently substituted.

import type {
  ExcludedUnrealizedPosition,
  OpenPositionClassification,
  UnrealizedExclusionReason,
  UnrealizedReconciliationSummary,
} from '../modules/fifoEngine/types'

export const PUBLIC_EXCLUSION_REASON_LABELS: Record<UnrealizedExclusionReason, string> = {
  missing_verified_current_price: 'no verified current price',
  missing_canonical_balance: 'not currently in this wallet',
  open_quantity_exceeds_balance: 'recorded open amount is larger than the current balance',
  unverified_or_outlier_price: 'price was found but failed sanity checks',
  invalid_decimals: 'token decimals could not be verified',
  invalid_open_quantity: 'open quantity is not a usable number',
  synthetic_or_quarantined_position: 'position was flagged as synthetic or quarantined',
  chain_or_token_key_mismatch: 'holdings snapshot answered for a different token or chain',
}

export const PUBLIC_CLASSIFICATION_LABELS: Record<Exclude<OpenPositionClassification, 'priced_reconciled'>, string> = {
  missing_price: 'missing verified current price',
  missing_balance: 'historical open position not currently held',
  balance_less_than_fifo_open: 'current balance is smaller than the recorded open position',
  dust_spam: 'dust or spam token',
  dead_unindexed: 'no indexed liquidity on this chain',
  unsupported: 'could not be verified from available evidence',
  suspicious_airdrop: 'suspicious airdrop pattern',
}

export type OpenPositionExclusionExample = {
  chainId: string
  tokenAddress: string
  symbol: string | null
  exclusionReason: UnrealizedExclusionReason
  classification: OpenPositionClassification
  publicReason: string
  hadVerifiedCurrentPrice: boolean
  hadCanonicalBalance: boolean
}

export type OpenPositionExclusionAudit = {
  totalOpenPositions: number
  reconciledOpenPositions: number
  excludedOpenPositions: number
  officialUnrealizedPnlUsd: number | null
  unrealizedCoveragePercent: number
  currentlyHeldCoveragePercent: number
  byReason: Partial<Record<UnrealizedExclusionReason, number>>
  byClassification: Partial<Record<OpenPositionClassification, number>>
  publicReasons: Array<{ label: string; count: number }>
  deadOrSpamPositionsCount: number
  examples: OpenPositionExclusionExample[]
}

const MAX_EXAMPLES = 8

function publicLabelFor(p: ExcludedUnrealizedPosition): string {
  if (p.classification !== 'missing_price' && p.classification !== 'missing_balance' && p.classification !== 'balance_less_than_fifo_open' && p.classification !== 'unsupported') {
    return PUBLIC_CLASSIFICATION_LABELS[p.classification]
  }
  return PUBLIC_EXCLUSION_REASON_LABELS[p.exclusionReason]
}

export function buildOpenPositionExclusionAudit(
  unrealizedReconciliation: UnrealizedReconciliationSummary,
): OpenPositionExclusionAudit {
  const publicReasonCounts = new Map<string, number>()
  for (const p of unrealizedReconciliation.excludedPositions) {
    const label = publicLabelFor(p)
    publicReasonCounts.set(label, (publicReasonCounts.get(label) ?? 0) + 1)
  }
  const publicReasons = [...publicReasonCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)

  const examples: OpenPositionExclusionExample[] = unrealizedReconciliation.excludedPositions.slice(0, MAX_EXAMPLES).map((p) => ({
    chainId: p.chainId,
    tokenAddress: p.tokenAddress,
    symbol: p.symbol,
    exclusionReason: p.exclusionReason,
    classification: p.classification,
    publicReason: publicLabelFor(p),
    hadVerifiedCurrentPrice: p.currentPriceUsd != null,
    hadCanonicalBalance: p.canonicalCurrentBalance != null,
  }))

  return {
    totalOpenPositions: unrealizedReconciliation.totalOpenPositions,
    reconciledOpenPositions: unrealizedReconciliation.reconciledOpenPositions,
    excludedOpenPositions: unrealizedReconciliation.excludedOpenPositions,
    officialUnrealizedPnlUsd: unrealizedReconciliation.officialUnrealizedPnlUsd,
    unrealizedCoveragePercent: unrealizedReconciliation.unrealizedCoveragePercent,
    currentlyHeldCoveragePercent: unrealizedReconciliation.openPositionCoveragePercent,
    byReason: { ...unrealizedReconciliation.excludedReasonCounts },
    byClassification: { ...unrealizedReconciliation.excludedClassificationCounts },
    publicReasons,
    deadOrSpamPositionsCount: unrealizedReconciliation.deadOrSpamPositionsCount,
    examples,
  }
}
