//   npx tsx --test src/lib/acceptedEvidencePurge.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { acceptedEvidenceKeysForOutlierSides, acceptedEvidencePurgeReason } from '@/src/lib/acceptedEvidencePurge'
import type { MatchedLot } from '@/src/modules/fifoEngine/types'

const fp = (amount: number) => `base:0x226a2fa2556c48245e57cd1cba4c6c9e67077dd2:0xa:0xb:1:2:${amount}`

describe('acceptedEvidencePurgeReason', () => {
  it('keeps an ordinary record', () => {
    assert.equal(acceptedEvidencePurgeReason({ chain: 'base', token: '0x226a', priceUsd: 70.35, coverageFingerprint: fp(4054.2), coveredLotCount: 1 }), null)
  })
  it('flags a side valued in the billions (production: $603,963/token replayed across 2,181 tokens)', () => {
    assert.equal(acceptedEvidencePurgeReason({ chain: 'base', token: '0x226a', priceUsd: 1.3e9, coverageFingerprint: fp(2181.1), coveredLotCount: 1 }), 'side_value_too_large')
  })
  it('flags impossible per-unit prices, zero and non-finite values', () => {
    assert.equal(acceptedEvidencePurgeReason({ chain: 'base', token: '0x226a', priceUsd: 70.35, coverageFingerprint: fp(1e-12), coveredLotCount: 1 }), 'per_unit_price_too_large')
    assert.equal(acceptedEvidencePurgeReason({ priceUsd: 0 }), 'non_positive_or_non_finite_value')
    assert.equal(acceptedEvidencePurgeReason({ priceUsd: Number.NaN }), 'non_positive_or_non_finite_value')
    assert.equal(acceptedEvidencePurgeReason('x'), 'not_an_object')
  })
})

describe('acceptedEvidenceKeysForOutlierSides', () => {
  const lot = (over: Partial<MatchedLot>): MatchedLot => ({
    lotId: 'l', token: '0xB200000000000000000000c2e324d24d7eecd1fb', chain: 'base', amount: 1.47,
    openedAt: 1792446449000, closedAt: 1792446485000, openedTxHash: '0x28245E2F', closedTxHash: '0xb3b1454e',
    costBasisUsd: 345.15, proceedsUsd: 504.02, realizedPnlUsd: 158.86, evidenceQuality: 'verified', ...over,
  })

  it('names the stored record of exactly the side the guard rejected, with that side\'s timestamp', () => {
    const keys = acceptedEvidenceKeysForOutlierSides([lot({}), lot({ lotId: 'l2', openedTxHash: '0xother' })], [{
      chain: 'base', token: '0xb200000000000000000000c2e324d24d7eecd1fb', txHash: '0x28245e2f', side: 'entry',
      perUnitUsd: 234.69, tokenMedianPerUnitUsd: 342.7, valueUsd: 345.15, reason: 'token_local_price_outlier',
    }])
    assert.deepEqual(keys, ['v1:accepted-evidence:base:0xb200000000000000000000c2e324d24d7eecd1fb:0x28245E2F:entry:1792446449000'])
  })

  it('deletes nothing for a lot-level return outlier, which does not say which side is wrong', () => {
    const keys = acceptedEvidenceKeysForOutlierSides([lot({})], [{
      chain: 'base', token: '0xb200000000000000000000c2e324d24d7eecd1fb', txHash: '0xb3b1454e', side: 'exit',
      perUnitUsd: 1, tokenMedianPerUnitUsd: null, valueUsd: 1, reason: 'lot_return_outlier',
    }])
    assert.deepEqual(keys, [])
  })
})
