import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildScanDeterminismAudit, checkPricingDeterminismViolation, logPricingDeterminismViolationIfAny,
  checkFinalPnlSnapshotDivergence, logFinalPnlSnapshotDivergenceIfAny, type FinalPnlSnapshotConsumers,
  sortLotsByCanonicalIdentity, quantizeUsd, sumQuantizedUsd,
} from './scanDeterminismAudit'
import type { MatchedLot } from '../modules/fifoEngine/types'

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return {
    lotId: 'lot-1', token: '0xtoken', chain: 'base', openedAt: 1, closedAt: 2,
    openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 1,
    costBasisUsd: 10, proceedsUsd: 12, realizedPnlUsd: 2, evidenceQuality: 'verified',
    ...overrides,
  }
}

describe('buildScanDeterminismAudit', () => {
  it('HARD ASSERTION: identical matched-lot sets and realized PnL produce identical fingerprints across two independent calls (the determinism this feature exists to prove)', () => {
    const lots = [lot(), lot({ lotId: 'lot-2', openedTxHash: '0xbuy2', closedTxHash: '0xsell2' })]
    const first = buildScanDeterminismAudit({ matchedLots: lots, realizedPnlUsd: 14, persistedEvidenceHits: 2, liveEvidenceMisses: 0 })
    const second = buildScanDeterminismAudit({ matchedLots: lots.map((l) => ({ ...l })), realizedPnlUsd: 14, persistedEvidenceHits: 2, liveEvidenceMisses: 0 })
    assert.equal(first.scanFingerprint, second.scanFingerprint)
    assert.equal(first.matchedLotFingerprint, second.matchedLotFingerprint)
    assert.equal(first.verifiedLotIdentityFingerprint, second.verifiedLotIdentityFingerprint)
    assert.equal(first.acceptedHistoricalPriceFingerprint, second.acceptedHistoricalPriceFingerprint)
    assert.equal(first.realizedPnlFingerprint, second.realizedPnlFingerprint)
  })

  it('is independent of matched-lot array order', () => {
    const a = lot({ lotId: 'a' })
    const b = lot({ lotId: 'b', openedTxHash: '0xbuy2', closedTxHash: '0xsell2' })
    const forward = buildScanDeterminismAudit({ matchedLots: [a, b], realizedPnlUsd: 10, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
    const reversed = buildScanDeterminismAudit({ matchedLots: [b, a], realizedPnlUsd: 10, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
    assert.equal(forward.scanFingerprint, reversed.scanFingerprint)
  })

  it('HARD ASSERTION: a different accepted historical price (different costBasisUsd on the same lot identity) changes acceptedHistoricalPriceFingerprint and scanFingerprint, but not matchedLotFingerprint/verifiedLotIdentityFingerprint', () => {
    const base = lot({ costBasisUsd: 10 })
    const repriced = lot({ costBasisUsd: 999 })
    const a = buildScanDeterminismAudit({ matchedLots: [base], realizedPnlUsd: 2, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
    const b = buildScanDeterminismAudit({ matchedLots: [repriced], realizedPnlUsd: 2, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
    assert.notEqual(a.acceptedHistoricalPriceFingerprint, b.acceptedHistoricalPriceFingerprint)
    assert.notEqual(a.scanFingerprint, b.scanFingerprint)
    assert.equal(a.matchedLotFingerprint, b.matchedLotFingerprint, 'lot identity itself is unchanged — same tx pair, same amount')
    assert.equal(a.verifiedLotIdentityFingerprint, b.verifiedLotIdentityFingerprint)
  })

  it('a lot that drops from verified to unpriced changes verifiedLotIdentityFingerprint but not matchedLotFingerprint', () => {
    const verified = lot({ evidenceQuality: 'verified' })
    const unpriced = lot({ evidenceQuality: 'unpriced', costBasisUsd: null, proceedsUsd: null })
    const a = buildScanDeterminismAudit({ matchedLots: [verified], realizedPnlUsd: 2, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
    const b = buildScanDeterminismAudit({ matchedLots: [unpriced], realizedPnlUsd: null, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
    assert.equal(a.matchedLotFingerprint, b.matchedLotFingerprint)
    assert.notEqual(a.verifiedLotIdentityFingerprint, b.verifiedLotIdentityFingerprint)
  })

  it('a different realizedPnlUsd changes realizedPnlFingerprint and scanFingerprint', () => {
    const lots = [lot()]
    const a = buildScanDeterminismAudit({ matchedLots: lots, realizedPnlUsd: 2, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
    const b = buildScanDeterminismAudit({ matchedLots: lots, realizedPnlUsd: 2.01, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
    assert.notEqual(a.realizedPnlFingerprint, b.realizedPnlFingerprint)
    assert.notEqual(a.scanFingerprint, b.scanFingerprint)
  })

  it('HARD ASSERTION: deterministicComparedToPreviousScan is null when no previous fingerprint is supplied — never a guessed true/false', () => {
    const audit = buildScanDeterminismAudit({ matchedLots: [lot()], realizedPnlUsd: 2, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
    assert.equal(audit.deterministicComparedToPreviousScan, null)
  })

  it('deterministicComparedToPreviousScan is true when the previous fingerprint matches, false when it does not', () => {
    const lots = [lot()]
    const first = buildScanDeterminismAudit({ matchedLots: lots, realizedPnlUsd: 2, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
    const same = buildScanDeterminismAudit({ matchedLots: lots, realizedPnlUsd: 2, persistedEvidenceHits: 5, liveEvidenceMisses: 0, previousScanFingerprint: first.scanFingerprint })
    assert.equal(same.deterministicComparedToPreviousScan, true)

    const different = buildScanDeterminismAudit({ matchedLots: lots, realizedPnlUsd: 999, persistedEvidenceHits: 0, liveEvidenceMisses: 0, previousScanFingerprint: first.scanFingerprint })
    assert.equal(different.deterministicComparedToPreviousScan, false)
  })

  it('persistedEvidenceHits/liveEvidenceMisses are passed through unchanged, real counters only', () => {
    const audit = buildScanDeterminismAudit({ matchedLots: [], realizedPnlUsd: null, persistedEvidenceHits: 7, liveEvidenceMisses: 3 })
    assert.equal(audit.persistedEvidenceHits, 7)
    assert.equal(audit.liveEvidenceMisses, 3)
  })
})

describe('checkPricingDeterminismViolation / logPricingDeterminismViolationIfAny (requirement #10)', () => {
  it('no previous result -> never a violation', () => {
    const check = checkPricingDeterminismViolation({ matchedLotFingerprint: 'a', realizedPnlFingerprint: 'b' }, null)
    assert.equal(check.violation, false)
  })

  it('HARD ASSERTION: same matchedLotFingerprint but different realizedPnlFingerprint IS a violation', () => {
    const check = checkPricingDeterminismViolation(
      { matchedLotFingerprint: '7877dd6b', realizedPnlFingerprint: 'aaa' },
      { matchedLotFingerprint: '7877dd6b', realizedPnlFingerprint: 'bbb' },
    )
    assert.equal(check.violation, true)
  })

  it('a genuinely different matchedLotFingerprint (real chain-data change) is never a violation, even with a different realizedPnlFingerprint', () => {
    const check = checkPricingDeterminismViolation(
      { matchedLotFingerprint: 'new-structure', realizedPnlFingerprint: 'aaa' },
      { matchedLotFingerprint: 'old-structure', realizedPnlFingerprint: 'bbb' },
    )
    assert.equal(check.violation, false)
  })

  it('same matchedLotFingerprint AND same realizedPnlFingerprint is never a violation', () => {
    const check = checkPricingDeterminismViolation(
      { matchedLotFingerprint: '7877dd6b', realizedPnlFingerprint: 'aaa' },
      { matchedLotFingerprint: '7877dd6b', realizedPnlFingerprint: 'aaa' },
    )
    assert.equal(check.violation, false)
  })

  it('HARD ASSERTION: a violation logs CRITICAL pricing_determinism_violation via logger.error, never .warn', () => {
    const calls: unknown[][] = []
    const logger = { error: (...args: unknown[]) => { calls.push(args) } }
    logPricingDeterminismViolationIfAny({ violation: true, matchedLotFingerprint: '7877dd6b', currentRealizedPnlFingerprint: 'aaa', previousRealizedPnlFingerprint: 'bbb' }, logger)
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'CRITICAL pricing_determinism_violation')
  })

  it('no log call at all when there is no violation', () => {
    const calls: unknown[][] = []
    const logger = { error: (...args: unknown[]) => { calls.push(args) } }
    logPricingDeterminismViolationIfAny({ violation: false, matchedLotFingerprint: 'x', currentRealizedPnlFingerprint: 'y', previousRealizedPnlFingerprint: null }, logger)
    assert.equal(calls.length, 0)
  })
})


describe('checkFinalPnlSnapshotDivergence — realized-PnL agreement (canonical-price-replay requirement #8)', () => {
  const base = {
    publicGateVerifiedLots: 23,
    publicGatePricingCoverage: 0.8519,
    ayriFullyPricedLots: 23,
    ayriVerifiedPricingCoverage: 0.8519,
    smartMoneyVerifiedLots: null,
    smartMoneyVerifiedPricingCoverage: null,
    canonicalVerifiedLots: 23,
  }

  it('agreeing counts, coverage and totals are never divergent', () => {
    const check = checkFinalPnlSnapshotDivergence({
      ...base,
      publicRealizedPnlUsd: 1791.71,
      publishedLotsRealizedPnlSum: 1791.71,
      manifestStoredRealizedPnlUsd: 1791.71,
      ayriRealizedPnlUsd: 1791.71,
    })
    assert.equal(check.divergent, false)
    assert.equal(check.realizedPnlAgrees, true)
  })

  it('HARD ASSERTION (the confirmed production failure): identical lot counts and coverage but a drifted realized total IS divergent', () => {
    // 23 verified lots agreed across every consumer while the total moved 1791.71 -> 4286.93. The
    // prior check compared only counts and coverage, so it could not see this at all.
    const check = checkFinalPnlSnapshotDivergence({
      ...base,
      publicRealizedPnlUsd: 4286.93,
      publishedLotsRealizedPnlSum: 4286.93,
      manifestStoredRealizedPnlUsd: 1791.71,
      ayriRealizedPnlUsd: 4286.93,
    })
    assert.equal(check.verifiedLotCountsAgree, true)
    assert.equal(check.pricingCoverageAgrees, true)
    assert.equal(check.realizedPnlAgrees, false)
    assert.equal(check.divergent, true)
  })

  it('a manifest coverage that disagrees with the gate is divergent', () => {
    const check = checkFinalPnlSnapshotDivergence({ ...base, manifestStoredCoverage: 0.7037 })
    assert.equal(check.pricingCoverageAgrees, false)
    assert.equal(check.divergent, true)
  })

  it('omitted (undefined) optional consumers are skipped, never treated as a fabricated agreement or mismatch', () => {
    const check = checkFinalPnlSnapshotDivergence(base)
    assert.equal(check.realizedPnlAgrees, true)
    assert.equal(check.divergent, false)
  })

  it('an explicit null realized total disagreeing with a real one is still caught', () => {
    const check = checkFinalPnlSnapshotDivergence({
      ...base, publicRealizedPnlUsd: null, publishedLotsRealizedPnlSum: 1791.71,
    })
    assert.equal(check.realizedPnlAgrees, false)
    assert.equal(check.divergent, true)
  })

  it('cent-scale rounding noise in the realized total never false-positives', () => {
    const check = checkFinalPnlSnapshotDivergence({
      ...base, publicRealizedPnlUsd: 1791.71, publishedLotsRealizedPnlSum: 1791.715,
    })
    assert.equal(check.realizedPnlAgrees, true)
  })

  it('a realized-PnL divergence logs CRITICAL final_pnl_snapshot_divergence', () => {
    const errors: unknown[][] = []
    const check = checkFinalPnlSnapshotDivergence({
      ...base, publicRealizedPnlUsd: 4286.93, manifestStoredRealizedPnlUsd: 1791.71,
    })
    logFinalPnlSnapshotDivergenceIfAny(check, { error: (...args: unknown[]) => { errors.push(args) } })
    assert.equal(errors.length, 1)
    assert.equal(errors[0][0], 'CRITICAL final_pnl_snapshot_divergence')
  })
})

describe('checkFinalPnlSnapshotDivergence / logFinalPnlSnapshotDivergenceIfAny (requirement #4)', () => {
  function consumers(overrides: Partial<FinalPnlSnapshotConsumers> = {}): FinalPnlSnapshotConsumers {
    return {
      publicGateVerifiedLots: 19, publicGatePricingCoverage: 0.7037,
      ayriFullyPricedLots: 19, ayriVerifiedPricingCoverage: 0.7037,
      smartMoneyVerifiedLots: null, smartMoneyVerifiedPricingCoverage: null,
      canonicalVerifiedLots: 19,
      ...overrides,
    }
  }

  it('agreeing consumers -> never divergent', () => {
    const check = checkFinalPnlSnapshotDivergence(consumers())
    assert.equal(check.divergent, false)
    assert.equal(check.verifiedLotCountsAgree, true)
    assert.equal(check.pricingCoverageAgrees, true)
  })

  it('HARD ASSERTION: reproduces the exact confirmed production divergence — gate 19/70.37% vs AYRI 6/22.22% -> divergent', () => {
    const check = checkFinalPnlSnapshotDivergence(consumers({ ayriFullyPricedLots: 6, ayriVerifiedPricingCoverage: 0.2222 }))
    assert.equal(check.divergent, true)
    assert.equal(check.verifiedLotCountsAgree, false)
    assert.equal(check.pricingCoverageAgrees, false)
  })

  it('a null smart-money consumer is skipped, never treated as a fabricated agreement or mismatch', () => {
    const check = checkFinalPnlSnapshotDivergence(consumers({ smartMoneyVerifiedLots: null, smartMoneyVerifiedPricingCoverage: null }))
    assert.equal(check.divergent, false)
  })

  it('a real smart-money disagreement is also caught', () => {
    const check = checkFinalPnlSnapshotDivergence(consumers({ smartMoneyVerifiedLots: 3, smartMoneyVerifiedPricingCoverage: 0.1 }))
    assert.equal(check.divergent, true)
  })

  it('tiny floating-point coverage noise is never treated as a real divergence', () => {
    const check = checkFinalPnlSnapshotDivergence(consumers({ ayriVerifiedPricingCoverage: 0.70370001 }))
    assert.equal(check.pricingCoverageAgrees, true)
    assert.equal(check.divergent, false)
  })

  it('HARD ASSERTION: a divergence logs CRITICAL final_pnl_snapshot_divergence via logger.error', () => {
    const calls: unknown[][] = []
    const logger = { error: (...args: unknown[]) => { calls.push(args) } }
    logFinalPnlSnapshotDivergenceIfAny(checkFinalPnlSnapshotDivergence(consumers({ ayriFullyPricedLots: 6 })), logger)
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'CRITICAL final_pnl_snapshot_divergence')
  })

  it('no log call when consumers agree', () => {
    const calls: unknown[][] = []
    const logger = { error: (...args: unknown[]) => { calls.push(args) } }
    logFinalPnlSnapshotDivergenceIfAny(checkFinalPnlSnapshotDivergence(consumers()), logger)
    assert.equal(calls.length, 0)
  })
})

// =================================================================================================
// FINGERPRINT-DIVERGENCE FIX — fingerprint-divergence fix task (confirmed production shape: manifest
// replay resolves every lot, zero value/identity/evidence mismatches, yet
// manifest_fingerprint_mismatch still fires — two independently re-derived allocations of the same
// accepted-evidence total agreed within CANONICAL_VALUE_TOLERANCE but diverged at float-bit level,
// which the former raw-string/order-dependent-sum fingerprint treated as a real difference).
// =================================================================================================

describe('fingerprint-divergence fix: quantization + canonical order + integer summation', () => {
  it('HARD ASSERTION (required regression): two independent allocations of the same side totals differing only BELOW the accepted tolerance produce the identical fingerprint after a JSON/KV round-trip', () => {
    // Two "independently re-derived" per-lot values for the SAME lot identity — the exact confirmed
    // production shape: both are correct, both would pass CANONICAL_VALUE_TOLERANCE (1e-9) against
    // each other, but they are not the same float bit pattern.
    const allocationA = lot({ lotId: 'v1', costBasisUsd: 33.33333333, proceedsUsd: 50, realizedPnlUsd: 16.66666667 })
    const allocationB = lot({ lotId: 'v1', costBasisUsd: 33.33333333 + 1e-10, proceedsUsd: 50, realizedPnlUsd: 16.66666667 - 1e-10 })
    assert.notEqual(allocationA.costBasisUsd, allocationB.costBasisUsd, 'sanity: the two allocations really do differ at the raw float level')

    // A genuine JSON/KV round-trip — proves the fix survives real (de)serialization, not just an
    // in-memory object reference.
    const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v))
    const buildAudit = (l: MatchedLot) => buildScanDeterminismAudit({
      matchedLots: roundTrip([l]), realizedPnlUsd: roundTrip(l.realizedPnlUsd), persistedEvidenceHits: 0, liveEvidenceMisses: 0,
    })
    const auditA = buildAudit(allocationA)
    const auditB = buildAudit(allocationB)
    assert.equal(auditA.acceptedHistoricalPriceFingerprint, auditB.acceptedHistoricalPriceFingerprint, 'sub-tolerance divergence must no longer produce different fingerprints')
    assert.equal(auditA.realizedPnlFingerprint, auditB.realizedPnlFingerprint)
    assert.equal(auditA.scanFingerprint, auditB.scanFingerprint)
  })

  it('HARD ASSERTION (required regression): a difference ABOVE the accepted tolerance must still produce a different fingerprint — never accepting a genuinely different manifest', () => {
    const genuinelyDifferent = lot({ lotId: 'v1', costBasisUsd: 33.34, proceedsUsd: 50, realizedPnlUsd: 16.66 })
    const original = lot({ lotId: 'v1', costBasisUsd: 33.33, proceedsUsd: 50, realizedPnlUsd: 16.67 })
    const a = buildScanDeterminismAudit({ matchedLots: [original], realizedPnlUsd: original.realizedPnlUsd, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
    const b = buildScanDeterminismAudit({ matchedLots: [genuinelyDifferent], realizedPnlUsd: genuinelyDifferent.realizedPnlUsd, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
    assert.notEqual(a.acceptedHistoricalPriceFingerprint, b.acceptedHistoricalPriceFingerprint)
    assert.notEqual(a.scanFingerprint, b.scanFingerprint)
  })

  it('sumQuantizedUsd sums the SAME multiset to the identical total regardless of array order — no order-dependent float accumulation', () => {
    const values = [33.33, 66.67, 12.01, 0.99, 87.55, 5.44]
    const forward = sumQuantizedUsd(values)
    const reversed = sumQuantizedUsd([...values].reverse())
    const shuffled = sumQuantizedUsd([values[3], values[0], values[5], values[1], values[4], values[2]])
    assert.equal(forward, reversed)
    assert.equal(forward, shuffled)
    assert.equal(forward, Math.round(values.reduce((s, v) => s + v, 0) * 100) / 100)
  })

  it('sumQuantizedUsd returns null the moment any value is null — never a fabricated total', () => {
    assert.equal(sumQuantizedUsd([1, 2, null, 3]), null)
    assert.equal(sumQuantizedUsd([]), 0)
  })

  it('sortLotsByCanonicalIdentity produces the same order regardless of input order, and quantizeUsd is stable across a JSON/KV round-trip', () => {
    const a = lot({ lotId: 'a', openedTxHash: '0xaaa' })
    const b = lot({ lotId: 'b', openedTxHash: '0xbbb' })
    const c = lot({ lotId: 'c', openedTxHash: '0xccc' })
    const forward = sortLotsByCanonicalIdentity([a, b, c]).map((l) => l.lotId)
    const reversed = sortLotsByCanonicalIdentity([c, b, a]).map((l) => l.lotId)
    const shuffled = sortLotsByCanonicalIdentity([b, c, a]).map((l) => l.lotId)
    assert.deepEqual(forward, reversed)
    assert.deepEqual(forward, shuffled)

    const value = 1384.9299999999998
    const roundTripped = JSON.parse(JSON.stringify(value)) as number
    assert.equal(quantizeUsd(value), quantizeUsd(roundTripped))
    assert.equal(quantizeUsd(null), 'null')
  })

  it('a genuine, above-tolerance realized-PnL total change is still detected as a pricing determinism violation — replay value validation is not weakened', () => {
    const matchedLots = [lot({ lotId: 'v1' })]
    const before = buildScanDeterminismAudit({ matchedLots, realizedPnlUsd: 100, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
    const after = buildScanDeterminismAudit({ matchedLots, realizedPnlUsd: 105, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
    const check = checkPricingDeterminismViolation(after, { matchedLotFingerprint: before.matchedLotFingerprint, realizedPnlFingerprint: before.realizedPnlFingerprint })
    assert.equal(check.violation, true, 'the same structural lot set with a genuinely different realized total must still be flagged')
  })

  it('HARD ASSERTION (quantization-safety follow-up, required regression): a pair ~1.1e-9 apart — genuinely ABOVE CANONICAL_VALUE_TOLERANCE (1e-9) — falls inside the same 1e-8 bucket (proving the OLD 8-decimal quantum was unsafe) but must NOT produce the same fingerprint under the fixed 1e-9 quantum', () => {
    const a = 33.0
    const b = 33.0 + 1.1e-9
    assert.ok(Math.abs(a - b) > 1e-9, 'sanity: this pair is genuinely above CANONICAL_VALUE_TOLERANCE')

    // Proves the OLD, coarser 8-decimal step really did collapse this above-tolerance pair — a
    // step of 1e-8 rounds both a and b to the identical nearest multiple of 1e-8 here.
    const oldScale = 100_000_000
    const oldBucketA = BigInt(Math.round(a * oldScale)).toString()
    const oldBucketB = BigInt(Math.round(b * oldScale)).toString()
    assert.equal(oldBucketA, oldBucketB, 'sanity: the prior 1e-8 quantum genuinely collapsed this above-tolerance pair')

    // The FIXED quantum (quantizeUsd, now 1e-9 — see this module's own header) must never collapse it.
    assert.notEqual(quantizeUsd(a), quantizeUsd(b), 'an above-tolerance difference must produce a different fingerprint input')

    const auditA = buildScanDeterminismAudit({ matchedLots: [lot({ lotId: 'v1', costBasisUsd: a, proceedsUsd: 50, realizedPnlUsd: 50 - a })], realizedPnlUsd: 50 - a, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
    const auditB = buildScanDeterminismAudit({ matchedLots: [lot({ lotId: 'v1', costBasisUsd: b, proceedsUsd: 50, realizedPnlUsd: 50 - b })], realizedPnlUsd: 50 - b, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
    assert.notEqual(auditA.acceptedHistoricalPriceFingerprint, auditB.acceptedHistoricalPriceFingerprint)
    assert.notEqual(auditA.realizedPnlFingerprint, auditB.realizedPnlFingerprint)
    assert.notEqual(auditA.scanFingerprint, auditB.scanFingerprint)
  })

  it('the fixed 1e-9 quantum still collapses genuine sub-tolerance allocation noise (the original bug this task fixes)', () => {
    const a = 33.33333333
    const b = 33.33333333 + 1e-13
    assert.notEqual(a, b, 'sanity: the two allocations really do differ at the raw float level')
    assert.equal(quantizeUsd(a), quantizeUsd(b), 'real allocation noise (~1e-13) is comfortably inside one 1e-9 quantum')
  })
})
