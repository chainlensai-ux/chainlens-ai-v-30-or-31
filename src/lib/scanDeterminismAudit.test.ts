import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildScanDeterminismAudit } from './scanDeterminismAudit'
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
