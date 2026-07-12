// MODULE (orchestration layer) — pnlSummaryAdapter
//
// Defensive UI-facing guard over pnlEngine's real PnlSummaryResult (src/modules/pnlEngine/types.ts
// — never modified here). Clamps only a genuinely-garbage realizedPnlUsd (overflow/invalid) to
// null rather than rendering it; never invents a value, never alters pnlSummaryV2's own closedLots/
// winLossRate/chainBreakdown/confidenceBasis.
//
// FIELD MISMATCH, DISCLOSED: the task that requested this file described an `integrity` field and
// an `unrealizedPnlUsd` field on pnlSummaryV2 — neither exists. PnlSummaryResult has only
// `realizedPnlUsd: number | null` (confirmed by reading src/modules/pnlEngine/types.ts); this
// engine has no unrealized-PnL concept at all (it only computes realized PnL over closed lots).
// This adapter guards the one real numeric field that could plausibly overflow, and nothing else.

import type { PnlSummaryResult } from '../modules/pnlEngine/types'

export type PnlSummaryStatus = 'ok' | 'invalid_overflow'

export type AdaptedPnlSummary = PnlSummaryResult & {
  pnlStatus: PnlSummaryStatus
}

// Same sanity ceiling for both directions of overflow — no real wallet's realized PnL should ever
// exceed $1e12 in either direction; anything past that is a pricing/arithmetic bug upstream, not a
// real number to render.
const PNL_OVERFLOW_CEILING_USD = 1e12

export function adaptPnlSummaryForUi(pnlSummaryV2: PnlSummaryResult): AdaptedPnlSummary {
  const value = pnlSummaryV2.realizedPnlUsd
  const isOverflow = value != null && Math.abs(value) > PNL_OVERFLOW_CEILING_USD

  if (isOverflow) {
    // eslint-disable-next-line no-console
    console.warn('[pnl-guard] invalid or overflow PnL detected; clamping to null', { realizedPnlUsd: value })
    return { ...pnlSummaryV2, realizedPnlUsd: null, pnlStatus: 'invalid_overflow' }
  }

  return { ...pnlSummaryV2, pnlStatus: 'ok' }
}
