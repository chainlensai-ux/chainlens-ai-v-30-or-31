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
import { isCanonicalVerifiedPublishedLot } from './canonicalVerifiedLot'

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
export type FingerprintableLot = Pick<MatchedLot, 'chain' | 'token' | 'openedTxHash' | 'closedTxHash' | 'openedAt' | 'closedAt' | 'amount' | 'evidenceQuality' | 'costBasisUsd' | 'proceedsUsd' | 'realizedPnlUsd'>

function lotIdentityKey(lot: FingerprintableLot): string {
  return [lot.chain, lot.token.toLowerCase(), lot.openedTxHash, lot.closedTxHash, lot.openedAt, lot.closedAt, lot.amount].join(':')
}

// CANONICAL LOT ORDER, DISCLOSED, EXPORTED (fingerprint-divergence fix task — confirmed production
// root cause: manifest build and replay independently RE-DERIVE the same accepted-evidence side
// totals via two separate allocation passes — buildManifestFromCandidate's own `correctedByLot` at
// build time, replayManifest's own `rebuiltByLot` here — both of which pass the existing per-group
// CANONICAL_VALUE_TOLERANCE checks, but a caller that then SUMS those lots' realizedPnlUsd with a
// plain floating-point `.reduce()` over each lot ARRAY's own — potentially different — iteration
// order gets an order-dependent, non-associative float result). Every caller that sums or hashes a
// canonical lot set for a fingerprint now sorts through this ONE shared function first, so both
// build and replay always fold the identical multiset in the identical order.
export function sortLotsByCanonicalIdentity<T extends FingerprintableLot>(lots: readonly T[]): T[] {
  return [...lots].sort((a, b) => lotIdentityKey(a).localeCompare(lotIdentityKey(b)))
}

// QUANTIZATION, DISCLOSED, EXPORTED (fingerprint-divergence fix task, quantization-safety
// follow-up). ONE shared canonicalization step for every USD field this module hashes, and for
// every USD total a caller sums before handing it to this module.
//
// CONFIRMED, PROVEN-UNSAFE PRIOR CHOICE, DISCLOSED: the first version of this quantum used 8 decimal
// places (step = 1e-8) — COARSER than `canonicalPnlSampleManifest.ts`'s own
// `CANONICAL_VALUE_TOLERANCE` (1e-9), the exact tolerance the per-group value checks already gate
// replay on. Rounding to the nearest multiple of `step` only guarantees two DIFFERENT buckets when
// the two values differ by AT LEAST `step` (two values in the SAME bucket can differ by up to just
// under `step`) — so an 8-decimal step could not prove it never collapsed a pair that legitimately
// differs by MORE than the 1e-9 tolerance (e.g. two values ~1.1e-9 apart, genuinely above tolerance,
// both round to the identical 1e-8 bucket — see this module's own regression test). Collapsing an
// above-tolerance difference into an identical fingerprint would silently widen what this codebase
// treats as "the same value" beyond the tolerance every other value check already enforces.
//
// FIX, DISCLOSED: the quantum is now 1e-9 — EXACTLY `CANONICAL_VALUE_TOLERANCE`, never coarser.
// PROOF this is safe: two values in the same bucket cannot differ by `step` or more (rounding to the
// nearest multiple of `step` bounds same-bucket separation to strictly less than `step`) — so with
// `step === CANONICAL_VALUE_TOLERANCE`, any pair differing by MORE than the tolerance is GUARANTEED
// to land in different buckets; the guarantee never depends on where exactly the pair sits. The two
// independently re-derived allocations this task exists to reconcile differ only by genuine
// floating-point rounding noise (far below 1e-9, typically ~1e-13-1e-15) — comfortably inside one
// 1e-9 quantum — so they still collapse to the identical fingerprint exactly as intended. This
// hardens agreement to be provably no more permissive than the existing tolerance; it never widens
// it, and it never touches the tolerance checks themselves.
const QUANTIZE_SCALE = 1_000_000_000 // 9 decimal places — matches CANONICAL_VALUE_TOLERANCE (1e-9)

export function quantizeUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'null'
  return BigInt(Math.round(value * QUANTIZE_SCALE)).toString()
}

// CENT-PRECISION CANONICALIZATION, DISCLOSED, EXPORTED (wallet-scanner-bounded-publication
// follow-up task — confirmed production shape: manifest replay resolved 23/23 lots, identity and
// realized-total fingerprints matched, stored/recomputed realized PnL both $701.47, cost/proceeds
// agreed at cent precision — yet `acceptedHistoricalPriceFingerprint` still mismatched on genuine
// per-lot rounding drift below a cent). `quantizeUsd`'s 1e-9 quantum is the CORRECT precision for
// the per-group VALUE TOLERANCE CHECK (`CANONICAL_VALUE_TOLERANCE` in
// canonicalPnlSampleManifest.ts's own `replayManifest`) — that check is what actually GATES replay
// pass/fail on cost/proceeds agreement, stays completely unchanged, and still fails closed on any
// genuine value divergence above 1e-9. The FINGERPRINT is a SEPARATE, downstream concern: whether
// two independently re-derived, ALREADY-tolerance-passing allocations produce the same PUBLISHED
// representation — and every published USD figure in this codebase (realizedPnlUsd, the manifest's
// own `CANONICAL_TOTAL_TOLERANCE_USD`) is already cent-precision. Rounding cost/proceeds to cents
// here — matching that same, already-established precision — canonicalizes what the fingerprint
// actually represents without touching the stricter upstream gate: a genuine, PUBLISHABLE (>= 1
// cent) difference still produces a different fingerprint and still fails closed; only sub-cent
// noise that the per-group tolerance check has ALREADY proven immaterial is absorbed.
export function quantizeUsdCents(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'null'
  return BigInt(Math.round(value * 100)).toString()
}

// INTEGER SUM, DISCLOSED, EXPORTED (fingerprint-divergence fix task): BigInt addition is exactly
// associative — unlike `Array.prototype.reduce` over floating-point numbers — so summing the SAME
// multiset of quantized values always produces the identical result regardless of array order. The
// caller is expected to have already sorted with `sortLotsByCanonicalIdentity` (order no longer
// matters for the sum itself, but keeps every caller's canonicalization step visibly uniform).
// Returns null (never a fabricated 0) the moment any input is null/non-finite, exactly matching this
// codebase's existing "unpriced lot blocks the total" convention.
export function sumQuantizedUsd(values: readonly (number | null)[]): number | null {
  let total = BigInt(0)
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) return null
    total += BigInt(Math.round(v * QUANTIZE_SCALE))
  }
  return Math.round((Number(total) / QUANTIZE_SCALE) * 100) / 100
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
  // CANONICAL ORDER, DISCLOSED: FIFO's own internal ordering is not itself a determinism guarantee
  // this module wants to assert on — two structurally-identical matches produced in a different
  // array order must fingerprint identically. Sorting here is fingerprinting-only; it never reorders
  // or mutates the caller's own `matchedLots` array. Uses the ONE shared canonical order (see
  // sortLotsByCanonicalIdentity's own header) rather than sorting hash-input strings after the fact —
  // the same order every caller of this function's canonicalization helpers now uses.
  const canonicalMatchedLots = sortLotsByCanonicalIdentity(params.matchedLots)
  const matchedKeys = canonicalMatchedLots.map(lotIdentityKey)
  const matchedLotFingerprint = deterministicHash(matchedKeys.join('|'))

  // ONE SHARED PREDICATE, DISCLOSED (canonical-price-replay follow-up task, requirement #6): the
  // fingerprint's verified-set selection must be the SAME question the gate, AYRI, smart-money,
  // serialization and the UI all ask — previously this filtered on `evidenceQuality` alone while
  // the gate counted fully-priced lots and AYRI counted attribution sources, so all three could
  // legitimately disagree about which lots the "verified" fingerprint even covered.
  const verifiedLots = canonicalMatchedLots.filter(isCanonicalVerifiedPublishedLot)
  const verifiedKeys = verifiedLots.map(lotIdentityKey)
  const verifiedLotIdentityFingerprint = deterministicHash(verifiedKeys.join('|'))

  // ACCEPTED HISTORICAL PRICE FINGERPRINT, DISCLOSED, QUANTIZED (fingerprint-divergence fix task):
  // the exact per-lot costBasisUsd/proceedsUsd pair for every VERIFIED lot — this is what actually
  // changes when a rescan accepts a different historical price than a previous scan did (the
  // reported nondeterminism), independent of whether the lot SET itself
  // (verifiedLotIdentityFingerprint) also changed. QUANTIZED via the one shared `quantizeUsd` (never
  // raw float interpolation) — CONFIRMED PRODUCTION ROOT CAUSE: two independently re-derived
  // allocations of the identical accepted-evidence total (manifest build vs manifest replay) could
  // already agree within CANONICAL_VALUE_TOLERANCE while still differing at a float bit level too
  // fine for that tolerance to catch as a "mismatch" but exact enough to fail this fingerprint's
  // former raw-string comparison — quantizing collapses any such sub-tolerance divergence to the
  // identical string, while a genuine above-tolerance difference still fails.
  // Re-sorted by the FULL compound string (identity + quantized values), not just lot identity:
  // occurrence-group siblings share an identical identity key by construction, so only sorting by
  // VALUE too guarantees the same joined string regardless of which physical sibling object ends up
  // holding which value in either scan's own array order.
  const priceKeys = verifiedLots.map((l) => `${lotIdentityKey(l)}:${quantizeUsdCents(l.costBasisUsd)}:${quantizeUsdCents(l.proceedsUsd)}`).sort()
  const acceptedHistoricalPriceFingerprint = deterministicHash(priceKeys.join('|'))

  const realizedPnlFingerprint = deterministicHash(quantizeUsd(params.realizedPnlUsd))

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
  // STRENGTHENED INVARIANT, DISCLOSED (canonical-price-replay follow-up task, requirement #8): lot
  // counts and coverage agreeing is necessary but NOT sufficient — the confirmed production failure
  // had 23 verified lots agreed across consumers while the realized total silently moved from
  // 1791.71 to 4286.93. Every field below is optional (`undefined` = "this consumer isn't present
  // in this scan", never a fabricated agreement); `null` is a real, compared value.
  canonicalRecomputedCoverage?: number | null
  manifestStoredCoverage?: number | null
  publicRealizedPnlUsd?: number | null
  publishedLotsRealizedPnlSum?: number | null
  manifestStoredRealizedPnlUsd?: number | null
  ayriRealizedPnlUsd?: number | null
}

export type FinalPnlSnapshotDivergenceCheck = {
  divergent: boolean
  verifiedLotCountsAgree: boolean
  pricingCoverageAgrees: boolean
  realizedPnlAgrees: boolean
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

// REALIZED-PNL AGREEMENT TOLERANCE, DISCLOSED: public realized PnL is rounded to cents before
// publication, so comparing it against a freshly-summed total needs a cent-scale tolerance. One cent
// is far tighter than any real divergence (the confirmed production case moved by ~2495 USD).
const REALIZED_PNL_AGREEMENT_TOLERANCE_USD = 0.01

export function checkFinalPnlSnapshotDivergence(consumers: FinalPnlSnapshotConsumers): FinalPnlSnapshotDivergenceCheck {
  const lotCounts = [consumers.publicGateVerifiedLots, consumers.ayriFullyPricedLots, consumers.canonicalVerifiedLots]
  if (consumers.smartMoneyVerifiedLots !== null) lotCounts.push(consumers.smartMoneyVerifiedLots)
  const verifiedLotCountsAgree = lotCounts.every((n) => n === lotCounts[0])

  const coverages = [consumers.publicGatePricingCoverage, consumers.ayriVerifiedPricingCoverage]
  if (consumers.smartMoneyVerifiedPricingCoverage !== null) coverages.push(consumers.smartMoneyVerifiedPricingCoverage)
  // OPTIONAL-MEANS-ABSENT, DISCLOSED: only compare a manifest/recomputed coverage that this scan
  // actually produced. `undefined` is skipped (there is nothing real to compare); an explicit `null`
  // is a genuine value and IS compared, so a null-vs-number disagreement still fails.
  if (consumers.canonicalRecomputedCoverage !== undefined) coverages.push(consumers.canonicalRecomputedCoverage)
  if (consumers.manifestStoredCoverage !== undefined) coverages.push(consumers.manifestStoredCoverage)
  const pricingCoverageAgrees = coverages.every((c) => numbersAgree(c, coverages[0]))

  const realizedTotals: Array<number | null> = []
  if (consumers.publicRealizedPnlUsd !== undefined) realizedTotals.push(consumers.publicRealizedPnlUsd)
  if (consumers.publishedLotsRealizedPnlSum !== undefined) realizedTotals.push(consumers.publishedLotsRealizedPnlSum)
  if (consumers.manifestStoredRealizedPnlUsd !== undefined) realizedTotals.push(consumers.manifestStoredRealizedPnlUsd)
  if (consumers.ayriRealizedPnlUsd !== undefined) realizedTotals.push(consumers.ayriRealizedPnlUsd)
  const realizedPnlAgrees = realizedTotals.length === 0
    ? true
    : realizedTotals.every((t) => {
        const first = realizedTotals[0]
        if (t === null || first === null) return t === first
        return Math.abs(t - first) <= REALIZED_PNL_AGREEMENT_TOLERANCE_USD
      })

  return {
    divergent: !verifiedLotCountsAgree || !pricingCoverageAgrees || !realizedPnlAgrees,
    verifiedLotCountsAgree,
    pricingCoverageAgrees,
    realizedPnlAgrees,
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
    realizedPnlAgrees: check.realizedPnlAgrees,
    consumers: check.consumers,
  })
}
