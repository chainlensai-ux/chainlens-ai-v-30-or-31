// UNREALIZED-PRICE-USAGE-AUDIT, DISCLOSED, ADDITIVE (Wallet Scanner second-pass audit, task 1 —
// exact shape requested. Live report: currentPriceGoldrushLiveCalls: 2, currentPriceDexLiveCalls: 13,
// currentPriceCallsUsedForUnrealized: 0 — real GoldRush/DexScreener current-price calls were being
// made but the existing `currentPriceCallsUsedForUnrealized` counter
// (src/modules/providerCost/walletProviderCostLedger.ts) never actually measured reconciliation
// usage at all — it is a scan-wide GoldRush success clamp, unrelated to computePnl's own exclusion
// ladder. This is a NEW, real measurement that answers the actual question: of the current-price
// fallback calls this scan made (PricingResolutionAudit's own dexscreenerCalls/geckoTerminalCalls —
// src/modules/pricing/types.ts), how many were actually consumed by a RECONCILED (never-excluded)
// open position, and for the rest, exactly why not.
//
// Every field here is derived from two already-real, already-measured sources — fifoEngine's own
// UnrealizedReconciliationSummary (which position ended up reconciled/excluded, and why) and
// PricingResolutionAudit (how many real fallback calls were made) — never a new provider call, never
// an estimate presented as measured.

import type { ExcludedUnrealizedPosition, UnrealizedExclusionReason, UnrealizedReconciliationSummary } from '../modules/fifoEngine/types'
import type { PricingResolutionAudit } from '../modules/pricing/types'

export type UnrealizedPriceUsageExample = {
  chainId: string
  tokenAddress: string
  symbol: string | null
  exclusionReason: UnrealizedExclusionReason
  hadResolvedPrice: boolean
}

export type UnrealizedPriceUsageAudit = {
  openPositions: number
  // Real fallback-provider call count this scan's current-price resolution pass made (DexScreener +
  // GeckoTerminal combined) — see PricingResolutionAudit's own SCOPE note for what this does and does
  // not include (provider-supplied/free prices and cache hits never count as a "call made").
  currentPriceCallsMade: number
  // Count of RECONCILED positions whose winning price came from one of those real fallback calls
  // (dexscreener_fallback/geckoterminal_fallback) or the short-TTL cache seeded by one — i.e. a call
  // this scan actually made (or a recent one) that ended up backing the official unrealized total.
  currentPriceCallsUsed: number
  // Count of EXCLUDED positions that nonetheless had a real, resolved currentPriceUsd (from ANY
  // source) — a price the resolver successfully produced, that still could not be used because of a
  // different, unrelated reconciliation failure (most commonly a balance mismatch). This is the
  // direct, real answer to "why were calls made but not used."
  pricesRejected: number
  // Tally of exclusionReason for exactly the pricesRejected subset above — e.g.
  // { missing_canonical_balance: 40, open_quantity_exceeds_balance: 3 } tells you the price resolver
  // is working fine and the real gap is balance reconciliation, not pricing.
  rejectionReasons: Partial<Record<UnrealizedExclusionReason, number>>
  // Reconciled-position counts by real winning price source — restated here (same data
  // reconciledPositionsByPriceSource already carries) for a reader looking at this one audit object.
  bySource: Record<string, number>
  // A handful of real, concrete excluded-with-a-real-price positions (bounded — never the full list),
  // so a reader can see actual examples rather than only aggregate counts.
  examples: UnrealizedPriceUsageExample[]
}

const CALL_BACKED_SOURCES = new Set(['dexscreener_fallback', 'geckoterminal_fallback', 'short_ttl_cache'])
const MAX_EXAMPLES = 5

export function buildUnrealizedPriceUsageAudit(params: {
  unrealizedReconciliation: UnrealizedReconciliationSummary
  pricingAudit: PricingResolutionAudit | null
}): UnrealizedPriceUsageAudit {
  const { unrealizedReconciliation, pricingAudit } = params

  const currentPriceCallsMade = (pricingAudit?.dexscreenerCalls ?? 0) + (pricingAudit?.geckoTerminalCalls ?? 0)

  const currentPriceCallsUsed = Object.entries(unrealizedReconciliation.reconciledPositionsByPriceSource)
    .filter(([source]) => CALL_BACKED_SOURCES.has(source))
    .reduce((sum, [, count]) => sum + count, 0)

  const rejected: ExcludedUnrealizedPosition[] = unrealizedReconciliation.excludedPositions.filter((p) => p.currentPriceUsd != null)
  const rejectionReasons: Partial<Record<UnrealizedExclusionReason, number>> = {}
  for (const p of rejected) {
    rejectionReasons[p.exclusionReason] = (rejectionReasons[p.exclusionReason] ?? 0) + 1
  }

  const examples: UnrealizedPriceUsageExample[] = rejected.slice(0, MAX_EXAMPLES).map((p) => ({
    chainId: p.chainId,
    tokenAddress: p.tokenAddress,
    symbol: p.symbol,
    exclusionReason: p.exclusionReason,
    hadResolvedPrice: true,
  }))

  return {
    openPositions: unrealizedReconciliation.totalOpenPositions,
    currentPriceCallsMade,
    currentPriceCallsUsed,
    pricesRejected: rejected.length,
    rejectionReasons,
    bySource: { ...unrealizedReconciliation.reconciledPositionsByPriceSource },
    examples,
  }
}
