// MODULE — canonicalVerifiedLot (canonical-price-replay follow-up task, requirement #6).
//
// GOAL, DISCLOSED: ONE definition of "this lot is part of the canonical published verified sample",
// shared by every consumer. CONFIRMED PRODUCTION DIVERGENCE THIS CLOSES: for a single scan the
// public gate reported 23 verified lots / 85.19% coverage while AYRI reported 18 verified /
// 66.67% — because the two were asking genuinely different questions of the same lot array. The
// gate counted lots that were fully priced (`costBasisUsd`/`proceedsUsd` both non-null), while
// AYRI counted lots whose ATTRIBUTION SOURCE fell in its own `VERIFIED_ATTRIBUTION_SOURCES` set,
// and that source is assigned partly from a scan-level BUDGET (`syntheticAlignedCount`, consumed
// first-come over a sorted lot array) rather than from per-lot evidence — so exactly
// `syntheticAlignedCount` lots were labelled `syntheticPrice` and dropped from AYRI's verified
// tally regardless of the real evidence backing them. Five, in the confirmed production case.
//
// This module is deliberately tiny and dependency-light (it imports only a type) precisely so every
// consumer — gate, AYRI, smart-money, fingerprinting, serialization, UI — can import it without a
// dependency cycle, and so there is no incentive to reimplement "verified" locally ever again.
//
// SCOPE, DISCLOSED: this predicate describes PUBLICATION classification only. It deliberately does
// NOT look at attribution source, recovery status, router involvement or synthetic alignment —
// those remain real, useful DIAGNOSTIC labels (and are unchanged), but none of them is evidence
// that a lot's own canonical entry/exit values are absent. A lot either has both canonical sides
// and a real realized figure, or it does not.

import type { MatchedLot } from '../modules/fifoEngine/types'

export type CanonicalVerifiedRejectionReason =
  | 'evidence_quality_not_verified'
  | 'missing_cost_basis'
  | 'missing_proceeds'
  | 'missing_realized_pnl'
  | 'non_finite_value'
  | 'invalid_chronology'

export const CANONICAL_VERIFIED_REJECTION_REASONS: readonly CanonicalVerifiedRejectionReason[] = [
  'evidence_quality_not_verified',
  'missing_cost_basis',
  'missing_proceeds',
  'missing_realized_pnl',
  'non_finite_value',
  'invalid_chronology',
]

type PublishableLot = Pick<MatchedLot, 'evidenceQuality' | 'costBasisUsd' | 'proceedsUsd' | 'realizedPnlUsd' | 'openedAt' | 'closedAt'>

// CHRONOLOGY GUARD, DISCLOSED, ADDITIVE (wallet-scanner-bounded-publication follow-up task —
// confirmed production shape: a structural lot with `closedAt < openedAt` — a sell TIMESTAMPED
// before its own matched buy — observed in the raw structural array. Such a lot cannot represent a
// real, physically-possible trade; whatever upstream matching/normalization step produced it, this
// predicate is the ONE shared gate every consumer (gate, AYRI, smart-money, fingerprinting,
// serialization, UI) already goes through, so it is the right place to fail closed rather than
// trusting an impossible timeline into a "verified" publication. This never rejects a genuinely
// same-block/same-second open+close (`closedAt === openedAt` is a real, valid same-block round-trip,
// left alone) — only a closedAt STRICTLY BEFORE its own openedAt, which no real trade can produce.
function hasInvalidChronology(lot: Pick<PublishableLot, 'openedAt' | 'closedAt'>): boolean {
  return lot.closedAt < lot.openedAt
}

// Returns the FIRST reason this lot is not canonically verified, or null when it is. Ordered from
// most-fundamental to most-specific so the reason counts read as a real diagnosis rather than an
// arbitrary pick among several simultaneous failures. Chronology is checked FIRST — an impossible
// timeline invalidates the lot regardless of what its price fields otherwise look like.
export function canonicalVerifiedRejectionReason(lot: PublishableLot): CanonicalVerifiedRejectionReason | null {
  if (hasInvalidChronology(lot)) return 'invalid_chronology'
  if (lot.evidenceQuality !== 'verified') return 'evidence_quality_not_verified'
  if (lot.costBasisUsd === null) return 'missing_cost_basis'
  if (lot.proceedsUsd === null) return 'missing_proceeds'
  if (lot.realizedPnlUsd === null) return 'missing_realized_pnl'
  if (!Number.isFinite(lot.costBasisUsd) || !Number.isFinite(lot.proceedsUsd) || !Number.isFinite(lot.realizedPnlUsd)) return 'non_finite_value'
  return null
}

// THE ONE PREDICATE (requirement #6). Every consumer listed in this module's header must call this
// — never `evidenceQuality === 'verified'` on its own, and never an attribution-source test.
export function isCanonicalVerifiedPublishedLot(lot: PublishableLot): boolean {
  return canonicalVerifiedRejectionReason(lot) === null
}

export type CanonicalVerifiedPredicateReasonCounts = Record<CanonicalVerifiedRejectionReason, number>

export function emptyCanonicalVerifiedPredicateReasonCounts(): CanonicalVerifiedPredicateReasonCounts {
  return {
    evidence_quality_not_verified: 0,
    missing_cost_basis: 0,
    missing_proceeds: 0,
    missing_realized_pnl: 0,
    non_finite_value: 0,
    invalid_chronology: 0,
  }
}

// Every reason key is always present, so a zero is a real measured zero rather than an absent key.
export function buildCanonicalVerifiedPredicateReasonCounts(lots: readonly PublishableLot[]): CanonicalVerifiedPredicateReasonCounts {
  const counts = emptyCanonicalVerifiedPredicateReasonCounts()
  for (const lot of lots) {
    const reason = canonicalVerifiedRejectionReason(lot)
    if (reason) counts[reason] += 1
  }
  return counts
}
