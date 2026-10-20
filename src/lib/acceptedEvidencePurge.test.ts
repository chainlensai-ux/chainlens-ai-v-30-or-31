//   npx tsx --test src/lib/acceptedEvidencePurge.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { acceptedEvidencePurgeReason } from '@/src/lib/acceptedEvidencePurge'

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
