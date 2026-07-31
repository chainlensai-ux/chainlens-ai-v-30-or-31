// lib/engine/modules/smartMoney/adaptFifoMatchedLots.ts — pure adapter from the canonical FIFO
// engine's real MatchedLot[] into computeSmartMoneyScore's generic VerifiedTradeEvidence[] shape.
//
// TRACE, DISCLOSED (this task's own required trace, confirmed by reading each stage):
//   1. canonical fifoAndPnl / matchedLots — src/modules/fifoEngine/index.ts's buildFifoOutput(),
//      called from src/pipeline/index.ts's safeRunFifoEngine(). Each MatchedLot already carries
//      evidenceQuality: 'verified' | 'unpriced' (never a third "estimated"/"synthetic" tier — this
//      codebase's fifoEngine structurally never fabricates a lot; integrityFlags.syntheticLotsExcluded
//      stays 0 by construction, see that module's own header), real openedAt/closedAt timestamps,
//      real costBasisUsd/proceedsUsd/realizedPnlUsd (null when unpriced, never a guessed number).
//   2. priceLotsForWallet — src/pipeline/priceLotsForWallet.ts resolves the real priceUsdLookup
//      fifoEngine's matchLotsFIFO() consumes; a lot's evidenceQuality is 'verified' only when BOTH
//      its cost basis AND proceeds resolved to a real, non-null price (see matchLotsFIFO's own
//      `isVerified = costBasisForPortion != null && proportionOfSell != null`).
//   3. worker/API serialization — router.handleScanRequest (src/pipeline/index.ts, via
//      src/deployment/router.ts) already serializes the full FifoOutput (matchedLots included) as
//      `body.data.fifoAndPnl` — confirmed present in workers/walletScanV2.ts's own existing
//      `body.data as { fifoAndPnl?: unknown }` diagnostic-comparison read, just never previously
//      typed or used as a real scoring input.
//   4. Smart Money scorer input — THIS file's own adaptFifoMatchedLots() below.
//   5. frontend fields — SmartMoneyScoreCard.tsx already renders evidenceConfidence.
//      fullyPricedTradeCount/verifiedCoveragePercent/totalMatchedLotCount; no UI change needed
//      beyond what those fields already display, since they were already reading real (if
//      previously empty) evidenceConfidence output.
//
// EXCLUSION CRITERIA, DISCLOSED (this task's own required list, mapped onto this codebase's REAL
// type system — there is no separate "estimated"/"synthetic"/"transfer-only"/"audit-only" lot tier
// to exclude beyond what evidenceQuality already encodes): a lot is included ONLY when
// evidenceQuality === 'verified' AND realizedPnlUsd/costBasisUsd/proceedsUsd are all real, finite
// numbers AND amount > 0 AND both openedAt/closedAt are real, finite timestamps. Every other lot
// (evidenceQuality === 'unpriced', or a genuinely malformed record with a non-finite field) is
// excluded — never included with a guessed value.

import type { MatchedLot } from '@/src/modules/fifoEngine/types'
import type { VerifiedTradeEvidence } from './computeSmartMoneyScore'

export type FifoAdapterResult = {
  verifiedTrades: VerifiedTradeEvidence[]
  // The canonical FIFO closed-lot denominator — ALL matched lots (verified + unpriced), never
  // pnlSummaryV2's diagnostic sell-row count. `null` only via the caller's own
  // adaptFifoMatchedLots(null) call (see below) when the canonical FIFO result itself was
  // unavailable this scan — never fabricated as 0 (0 means "FIFO genuinely closed zero lots").
  structuralClosedLotCount: number
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

// PURE. Deterministic dedupe key — a real closed lot is uniquely identified by its own lotId
// (fifoEngine's buildLotId already incorporates chain+contract+openedTxHash+timestamp — see
// src/modules/fifoEngine/utils.ts), so duplicate lotId values (e.g. a caller accidentally
// concatenating the same matchedLots array twice) collapse to the FIRST occurrence, matching this
// task's own "dedupe deterministically" requirement without inventing a second identity scheme.
function dedupeKey(lot: MatchedLot): string {
  return `${lot.chain}:${lot.lotId}:${lot.closedTxHash.toLowerCase()}`
}

// PURE. The single entry point. Never throws. `matchedLots: null` means the canonical FIFO result
// itself was unavailable this scan (a real, honest distinction from `[]`, which means FIFO ran and
// found zero closed lots) — the caller is responsible for passing null vs. [] correctly; this
// function never invents the distinction on its own.
export function adaptFifoMatchedLots(matchedLots: readonly MatchedLot[] | null): FifoAdapterResult | null {
  if (matchedLots == null) return null

  const seen = new Set<string>()
  const verifiedTrades: VerifiedTradeEvidence[] = []

  for (const lot of matchedLots) {
    const key = dedupeKey(lot)
    if (seen.has(key)) continue
    seen.add(key)

    if (lot.evidenceQuality !== 'verified') continue
    if (!isFiniteNumber(lot.realizedPnlUsd)) continue
    if (!isFiniteNumber(lot.costBasisUsd) || lot.costBasisUsd <= 0) continue
    if (!isFiniteNumber(lot.proceedsUsd)) continue
    if (!isFiniteNumber(lot.amount) || lot.amount <= 0) continue
    if (!isFiniteNumber(lot.openedAt) || !isFiniteNumber(lot.closedAt)) continue
    if (lot.closedAt < lot.openedAt) continue

    verifiedTrades.push({
      realizedPnlUsd: lot.realizedPnlUsd,
      costBasisUsd: lot.costBasisUsd,
      closedAt: lot.closedAt,
      openedAt: lot.openedAt,
      isVerified: true,
    })
  }

  // STRUCTURAL DENOMINATOR, DISCLOSED: deduped count of the FULL canonical matched-lot set (every
  // real FIFO match this scan produced, verified or not) — never pnlSummaryV2's diagnostic,
  // non-FIFO sell-row count, and never just `verifiedTrades.length` (which would silently make
  // coverage always read 100%).
  const dedupedTotal = new Set(matchedLots.map(dedupeKey)).size

  return { verifiedTrades, structuralClosedLotCount: dedupedTotal }
}
