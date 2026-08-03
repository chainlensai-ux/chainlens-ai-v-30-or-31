// MODULE — scanDeterminismAudit (determinism follow-up task, requirement #6).
//
// GOAL, DISCLOSED: a real, before/after-comparable fingerprint of the canonical FIFO/PnL result a
// scan produced — so "did this rescan reproduce the same verified-lot set and realized PnL" can be
// answered by comparing two small strings instead of eyeballing a diff of full lot arrays. Pure,
// deterministic, no I/O — every fingerprint here is a function of already-computed pipeline state
// (matchedLots, realizedPnlUsd), never a new source of truth. Comparing to a previous scan's
// fingerprint is the CALLER's responsibility (this module never itself persists or fetches one) —
// `previousScanFingerprint` is an optional input, and `deterministicComparedToPreviousScan` is
// `null` (never guessed true/false) whenever the caller didn't supply one to compare against.
//
// HASH CHOICE, DISCLOSED: reuses this codebase's own existing djb2-style pure hash convention
// (see src/modules/lotOpener/lotOpener.ts's `deterministicHash` for the precedent) rather than
// introducing a crypto import — this is an equality-comparison fingerprint, not a security control,
// so a compact, dependency-free hash is the right tool, matching this codebase's established
// pattern.

import type { MatchedLot } from '../modules/fifoEngine/types'

function deterministicHash(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// IDENTITY KEY, DISCLOSED: the same lot-identity fields already used elsewhere in this codebase for
// lot equality (chain/token/openedTxHash/closedTxHash/openedAt/closedAt — see pnlReconciliation.ts's
// own `lotKey`), plus `amount` — a lot with the same tx pair but a different matched quantity is a
// genuinely different match, not the same lot re-observed.
type FingerprintableLot = Pick<MatchedLot, 'chain' | 'token' | 'openedTxHash' | 'closedTxHash' | 'openedAt' | 'closedAt' | 'amount' | 'evidenceQuality' | 'costBasisUsd' | 'proceedsUsd'>

function lotIdentityKey(lot: FingerprintableLot): string {
  return [lot.chain, lot.token.toLowerCase(), lot.openedTxHash, lot.closedTxHash, lot.openedAt, lot.closedAt, lot.amount].join(':')
}

export type ScanDeterminismAudit = {
  scanFingerprint: string
  matchedLotFingerprint: string
  verifiedLotIdentityFingerprint: string
  acceptedHistoricalPriceFingerprint: string
  realizedPnlFingerprint: string
  persistedEvidenceHits: number
  liveEvidenceMisses: number
  // null: no previous fingerprint was supplied to compare against (first scan, or caller hasn't
  // wired persistence for it yet) — never fabricated as true or false.
  deterministicComparedToPreviousScan: boolean | null
}

export function buildScanDeterminismAudit(params: {
  matchedLots: readonly FingerprintableLot[]
  realizedPnlUsd: number | null
  persistedEvidenceHits: number
  liveEvidenceMisses: number
  previousScanFingerprint?: string | null
}): ScanDeterminismAudit {
  // ALL SORTED, DISCLOSED: FIFO's own internal ordering is not itself a determinism guarantee this
  // module wants to assert on — two structurally-identical matches produced in a different array
  // order must fingerprint identically. Sorting here is fingerprinting-only; it never reorders or
  // mutates the caller's own `matchedLots` array.
  const matchedKeys = [...params.matchedLots].map(lotIdentityKey).sort()
  const matchedLotFingerprint = deterministicHash(matchedKeys.join('|'))

  const verifiedLots = params.matchedLots.filter((l) => l.evidenceQuality === 'verified')
  const verifiedKeys = verifiedLots.map(lotIdentityKey).sort()
  const verifiedLotIdentityFingerprint = deterministicHash(verifiedKeys.join('|'))

  // ACCEPTED HISTORICAL PRICE FINGERPRINT, DISCLOSED: the exact per-lot costBasisUsd/proceedsUsd
  // pair for every VERIFIED lot — this is what actually changes when a rescan accepts a different
  // historical price than a previous scan did (the reported nondeterminism), independent of whether
  // the lot SET itself (verifiedLotIdentityFingerprint) also changed.
  const priceKeys = verifiedLots.map((l) => `${lotIdentityKey(l)}:${l.costBasisUsd}:${l.proceedsUsd}`).sort()
  const acceptedHistoricalPriceFingerprint = deterministicHash(priceKeys.join('|'))

  const realizedPnlFingerprint = deterministicHash(params.realizedPnlUsd === null ? 'null' : params.realizedPnlUsd.toFixed(8))

  const scanFingerprint = deterministicHash([
    matchedLotFingerprint, verifiedLotIdentityFingerprint, acceptedHistoricalPriceFingerprint, realizedPnlFingerprint,
  ].join('|'))

  const deterministicComparedToPreviousScan = params.previousScanFingerprint == null
    ? null
    : params.previousScanFingerprint === scanFingerprint

  return {
    scanFingerprint,
    matchedLotFingerprint,
    verifiedLotIdentityFingerprint,
    acceptedHistoricalPriceFingerprint,
    realizedPnlFingerprint,
    persistedEvidenceHits: params.persistedEvidenceHits,
    liveEvidenceMisses: params.liveEvidenceMisses,
    deterministicComparedToPreviousScan,
  }
}

// PRODUCTION SAFETY WARNING, DISCLOSED (determinism follow-up task, requirement #10): the specific,
// narrower violation this task's own production evidence proved — the matched-lot STRUCTURE is
// unchanged (same matchedLotFingerprint) but the realized PnL figure differs from a previously
// persisted result. This is distinct from `deterministicComparedToPreviousScan` above (which flags
// ANY difference, including a legitimate one from newly-scanned chain activity) — a violation here
// specifically means the FIFO input didn't change but the accepted PRICING evidence did, which
// should now be structurally impossible once accepted evidence is honored (see
// pnlReconciliation.ts's hydrateFromAcceptedEvidence). Pure — returns a real, typed result; logging
// is the caller's responsibility (see `logPricingDeterminismViolationIfAny` below), keeping this
// function itself I/O-free and directly testable.
export type PricingDeterminismViolationCheck = {
  violation: boolean
  matchedLotFingerprint: string
  currentRealizedPnlFingerprint: string
  previousRealizedPnlFingerprint: string | null
}

export function checkPricingDeterminismViolation(
  current: Pick<ScanDeterminismAudit, 'matchedLotFingerprint' | 'realizedPnlFingerprint'>,
  previous: { matchedLotFingerprint: string; realizedPnlFingerprint: string } | null | undefined,
): PricingDeterminismViolationCheck {
  if (!previous) {
    return { violation: false, matchedLotFingerprint: current.matchedLotFingerprint, currentRealizedPnlFingerprint: current.realizedPnlFingerprint, previousRealizedPnlFingerprint: null }
  }
  const sameStructure = current.matchedLotFingerprint === previous.matchedLotFingerprint
  const violation = sameStructure && current.realizedPnlFingerprint !== previous.realizedPnlFingerprint
  return {
    violation,
    matchedLotFingerprint: current.matchedLotFingerprint,
    currentRealizedPnlFingerprint: current.realizedPnlFingerprint,
    previousRealizedPnlFingerprint: previous.realizedPnlFingerprint,
  }
}

// LOGGING WRAPPER, DISCLOSED: the ONLY function in this module that performs I/O — a thin,
// separately-testable (via an injectable logger) wrapper so `checkPricingDeterminismViolation`
// itself stays pure. `logger.error`, not `.warn` — this is the explicit CRITICAL severity requirement
// #10 asks for, distinct from every other `logger.warn` diagnostic in this codebase's pricing path.
export function logPricingDeterminismViolationIfAny(
  check: PricingDeterminismViolationCheck,
  logger: Pick<Console, 'error'> = console,
): void {
  if (!check.violation) return
  logger.error('CRITICAL pricing_determinism_violation', {
    matchedLotFingerprint: check.matchedLotFingerprint,
    currentRealizedPnlFingerprint: check.currentRealizedPnlFingerprint,
    previousRealizedPnlFingerprint: check.previousRealizedPnlFingerprint,
  })
}

// FINAL-SNAPSHOT DIVERGENCE CHECK, DISCLOSED (accepted-evidence-skip-hydration follow-up task,
// requirement #4 — confirmed production evidence: the public gate reported 19 verified lots /
// 70.37% coverage for the SAME scan AYRI reported 6 verified lots / 22.22% coverage for). Every
// consumer listed here is SUPPOSED to derive its own verified-lot/coverage figures from the exact
// same final canonical matched-lot array (`reconciledFifoAndPnl.matchedLots` in
// src/pipeline/index.ts) — a real disagreement here means two consumers computed their own figure
// from data that had already diverged (a stale intermediate snapshot, a different filtering rule, a
// classification bug), which is exactly the failure mode this check exists to catch, loudly, rather
// than silently ship two different numbers for the same wallet in the same response. Pure — no I/O,
// directly testable; logging is `logFinalPnlSnapshotDivergenceIfAny`'s job, same split as the
// pricing-determinism check above.
export type FinalPnlSnapshotConsumers = {
  publicGateVerifiedLots: number
  publicGatePricingCoverage: number | null
  ayriFullyPricedLots: number
  ayriVerifiedPricingCoverage: number | null
  smartMoneyVerifiedLots: number | null
  smartMoneyVerifiedPricingCoverage: number | null
  canonicalVerifiedLots: number
}

export type FinalPnlSnapshotDivergenceCheck = {
  divergent: boolean
  verifiedLotCountsAgree: boolean
  pricingCoverageAgrees: boolean
  consumers: FinalPnlSnapshotConsumers
}

// COVERAGE-COMPARISON TOLERANCE, DISCLOSED: coverage percentages are real floating-point divisions
// (fullyPricedLots / totalLots) computed independently by each consumer — a tiny float-precision
// difference (e.g. rounding to a different number of decimal places) is not a real divergence.
// 0.0001 (0.01 percentage points) is far tighter than any real, meaningfully-different coverage gap
// (the production evidence's own divergence was 70.37% vs 22.22% — a 48-point gap, nowhere near this
// tolerance) while still absorbing genuine floating-point noise.
const COVERAGE_AGREEMENT_TOLERANCE = 0.0001

function numbersAgree(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b
  return Math.abs(a - b) <= COVERAGE_AGREEMENT_TOLERANCE
}

export function checkFinalPnlSnapshotDivergence(consumers: FinalPnlSnapshotConsumers): FinalPnlSnapshotDivergenceCheck {
  const lotCounts = [consumers.publicGateVerifiedLots, consumers.ayriFullyPricedLots, consumers.canonicalVerifiedLots]
  if (consumers.smartMoneyVerifiedLots !== null) lotCounts.push(consumers.smartMoneyVerifiedLots)
  const verifiedLotCountsAgree = lotCounts.every((n) => n === lotCounts[0])

  const coverages = [consumers.publicGatePricingCoverage, consumers.ayriVerifiedPricingCoverage]
  if (consumers.smartMoneyVerifiedPricingCoverage !== null) coverages.push(consumers.smartMoneyVerifiedPricingCoverage)
  const pricingCoverageAgrees = coverages.every((c) => numbersAgree(c, coverages[0]))

  return {
    divergent: !verifiedLotCountsAgree || !pricingCoverageAgrees,
    verifiedLotCountsAgree,
    pricingCoverageAgrees,
    consumers,
  }
}

export function logFinalPnlSnapshotDivergenceIfAny(
  check: FinalPnlSnapshotDivergenceCheck,
  logger: Pick<Console, 'error'> = console,
): void {
  if (!check.divergent) return
  logger.error('CRITICAL final_pnl_snapshot_divergence', {
    verifiedLotCountsAgree: check.verifiedLotCountsAgree,
    pricingCoverageAgrees: check.pricingCoverageAgrees,
    consumers: check.consumers,
  })
}
