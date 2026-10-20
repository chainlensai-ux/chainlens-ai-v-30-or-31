// A stored side total is scaled down to the quantity this scan actually matched on that side, so a
// dust slice of a mostly-unmatched sell can't inherit the whole sell's value.
//   npx tsx --test src/lib/acceptedEvidenceGroupTotal.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { acceptedEvidenceGroupTotal, acceptedEvidenceCoveredQuantity } from '@/src/lib/canonicalPnlSampleManifest'
import { buildAcceptedEvidenceCoverageFingerprint } from '@/src/lib/acceptedEvidenceStore'
import type { MatchedLot } from '@/src/modules/fifoEngine/types'

const TOKEN = '0x226a2fa2556c48245e57cd1cba4c6c9e67077dd2'
const SELL = '0x4301268edf8d52901e4c63dc2868ecfa5003379471552257aced43f3dc294824'
function lot(lotId: string, openedTxHash: string, amount: number): MatchedLot {
  return {
    lotId, token: TOKEN, chain: 'base', openedAt: 1_000, closedAt: 2_000, openedTxHash, closedTxHash: SELL,
    amount, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced',
  }
}

describe('acceptedEvidenceGroupTotal', () => {
  const fullSell = [lot('a', '0xbuy1', 3_000), lot('b', '0xbuy2', 1_054.2036774929984)]
  const record = { priceUsd: 70.35, coverageFingerprint: buildAcceptedEvidenceCoverageFingerprint(fullSell), coveredLotCount: 2 }

  it('reads the covered quantity back from the fingerprint', () => {
    assert.ok(Math.abs((acceptedEvidenceCoveredQuantity(record.coverageFingerprint, 2) ?? 0) - 4_054.2036774929984) < 1e-6)
    assert.equal(acceptedEvidenceCoveredQuantity(record.coverageFingerprint, 1), null, 'fingerprint/count disagreement is not trusted')
  })

  it('keeps the full total when the same quantity is matched', () => {
    assert.equal(acceptedEvidenceGroupTotal(fullSell, record), 70.35)
  })

  it('scales a dust slice of the sell down to its own share (production: +$70 on a 1e-12 slice)', () => {
    const total = acceptedEvidenceGroupTotal([lot('dust', '0xbuy3', 1e-12)], record)
    assert.ok(total < 1e-10, `dust slice got $${total}`)
  })

  it('never scales up, and leaves records without a usable fingerprint alone', () => {
    assert.equal(acceptedEvidenceGroupTotal([...fullSell, lot('c', '0xbuy4', 500)], record), 70.35)
    assert.equal(acceptedEvidenceGroupTotal([lot('dust', '0xbuy3', 1e-12)], { priceUsd: 70.35, coverageFingerprint: '', coveredLotCount: 1 }), 70.35)
  })
})
