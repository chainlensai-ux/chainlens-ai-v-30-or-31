// src/pipeline/selectCanonicalPricedFifo.ts — the ONE shared, pure selector for the canonical,
// finalized FIFO result a scan produces (pricing + receipt canonical-promotion + recovery all
// already applied — see src/modules/finalReportAssembler/types.ts's own
// FinalReport.canonicalPricedFifo header for the full disclosure of what "finalized" means).
//
// WHY THIS EXISTS, DISCLOSED (Smart Money evidence-source-ordering task): every consumer that
// needs "the real, verified FIFO trade evidence for this wallet" — Wallet Personality's
// profit-evidence panel (app/frontend/lib/walletPersonality.ts) and Smart Money's adapter
// (lib/engine/modules/smartMoney/adaptFifoMatchedLots.ts) — MUST go through this function, never
// read report.fifoAndPnl (or any other snapshot) directly for that purpose. A single shared
// selector is what makes "these two can never drift apart" a structural guarantee rather than a
// convention two independently-written call sites could each get slightly wrong.

import type { FifoOutput, MatchedLot } from '../modules/fifoEngine/types'

export type CanonicalPricedFifoSource = {
  canonicalPricedFifo?: FifoOutput | null
}

// PURE. `null` when the canonical snapshot itself is genuinely unavailable this scan (the field is
// missing or explicitly null on the report) — NEVER fabricated as an empty result standing in for
// "unavailable". A real FifoOutput with zero matchedLots (a wallet with no closed lots at all) is
// returned as-is, honestly distinct from "unavailable".
export function selectCanonicalPricedFifo(report: CanonicalPricedFifoSource | null | undefined): FifoOutput | null {
  return report?.canonicalPricedFifo ?? null
}

// PURE. Convenience wrapper — `null` (never `[]`) when the canonical snapshot itself is
// unavailable; a real, possibly-empty matchedLots array otherwise.
export function selectCanonicalMatchedLots(report: CanonicalPricedFifoSource | null | undefined): MatchedLot[] | null {
  const fifo = selectCanonicalPricedFifo(report)
  return fifo ? fifo.matchedLots : null
}
