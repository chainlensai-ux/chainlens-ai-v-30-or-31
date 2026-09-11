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
// EXCLUSION CRITERIA, DISCLOSED, FIXED (Wallet Scanner final-state count convergence follow-up
// task — confirmed root cause of the "provisional 41 vs final canonical 28" divergence between
// this card and PnlStatusCard's right rail): this file used to re-implement its own by-hand
// eligibility check — evidenceQuality/finite-value/chronology tests written independently of, and
// NOT kept in sync with, `isCanonicalVerifiedPublishedLot` (src/lib/canonicalVerifiedLot.ts) — THE
// ONE shared predicate every other "is this lot part of the canonical verified sample" consumer
// (the public PnL gate, AYRI, the canonical manifest) is required to use. The by-hand version was
// missing the `proceedsUsd <= 0` check entirely (it checked `costBasisUsd <= 0` but never the
// matching exit-side check) — a real, exploitable gap that let a lot with a non-positive exit
// value count as "verified" here while the canonical predicate correctly rejects it everywhere
// else, one concrete component of the drift. Now delegates to the shared predicate directly, so
// this module's own verified-trade count converges on the SAME final canonical value
// (`isCanonicalVerifiedPublishedLot`), by construction, no matter what upstream selection
// (manifest replay, canonical sample selector) already ran on `matchedLots` before this function
// ever sees it — never a second, independently-drifting reimplementation. `amount > 0` remains an
// additional structural sanity check the shared predicate doesn't itself cover.

import type { MatchedLot } from '@/src/modules/fifoEngine/types'
import { isCanonicalVerifiedPublishedLot } from '@/src/lib/canonicalVerifiedLot'
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

    if (!isCanonicalVerifiedPublishedLot(lot)) continue
    // ADDITIONAL, DISCLOSED: the shared predicate's own chronology check (`closedAt < openedAt`)
    // never flags a non-finite timestamp (NaN comparisons are always false), so a genuinely
    // malformed record would otherwise slip through — this module still guards against that
    // itself, on top of (never instead of) the shared predicate; `amount > 0` is likewise a
    // structural check the shared predicate doesn't itself cover.
    if (!isFiniteNumber(lot.openedAt) || !isFiniteNumber(lot.closedAt)) continue
    if (!isFiniteNumber(lot.amount) || lot.amount <= 0) continue

    verifiedTrades.push({
      // `isCanonicalVerifiedPublishedLot` above already proves these three are non-null and finite
      // — the `as number` casts document that proof, never a runtime assumption of their own.
      realizedPnlUsd: lot.realizedPnlUsd as number,
      costBasisUsd: lot.costBasisUsd as number,
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
