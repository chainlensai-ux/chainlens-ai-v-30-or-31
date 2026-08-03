// Regression tests for the ONE canonical published-verified predicate (canonical-price-replay
// follow-up task, requirement #6). Run directly with:
//   npx tsx --test src/lib/canonicalVerifiedLot.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isCanonicalVerifiedPublishedLot, canonicalVerifiedRejectionReason,
  buildCanonicalVerifiedPredicateReasonCounts, emptyCanonicalVerifiedPredicateReasonCounts,
  CANONICAL_VERIFIED_REJECTION_REASONS,
} from './canonicalVerifiedLot.ts'
import type { MatchedLot } from '../modules/fifoEngine/types'

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return {
    lotId: 'lot', token: '0xtoken', chain: 'base', openedAt: 1, closedAt: 2,
    openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 1,
    costBasisUsd: 10, proceedsUsd: 12, realizedPnlUsd: 2, evidenceQuality: 'verified',
    ...overrides,
  }
}

describe('canonicalVerifiedLot — the one shared predicate (requirement #6)', () => {
  it('a fully-priced verified lot is canonically verified', () => {
    assert.equal(isCanonicalVerifiedPublishedLot(lot()), true)
    assert.equal(canonicalVerifiedRejectionReason(lot()), null)
  })

  it('reports the real, specific reason for each way a lot fails', () => {
    assert.equal(canonicalVerifiedRejectionReason(lot({ evidenceQuality: 'unpriced' })), 'evidence_quality_not_verified')
    assert.equal(canonicalVerifiedRejectionReason(lot({ costBasisUsd: null })), 'missing_cost_basis')
    assert.equal(canonicalVerifiedRejectionReason(lot({ proceedsUsd: null })), 'missing_proceeds')
    assert.equal(canonicalVerifiedRejectionReason(lot({ realizedPnlUsd: null })), 'missing_realized_pnl')
    assert.equal(canonicalVerifiedRejectionReason(lot({ proceedsUsd: Number.NaN })), 'non_finite_value')
  })

  it('HARD ASSERTION (the confirmed production gap): a lot is judged on its own evidence, never on an attribution label', () => {
    // The confirmed 5-lot AYRI gap came from lots being labelled `syntheticPrice` purely by their
    // POSITION in a sorted array, via a scan-level syntheticAlignedCount budget. A lot carrying real
    // canonical entry and exit values is canonically verified regardless of any such label.
    const realEvidence = lot({ costBasisUsd: 3.25, proceedsUsd: 5.5, realizedPnlUsd: 2.25 })
    assert.equal(isCanonicalVerifiedPublishedLot(realEvidence), true)
  })

  it('a partially-priced lot is never canonically verified', () => {
    assert.equal(isCanonicalVerifiedPublishedLot(lot({ proceedsUsd: null, realizedPnlUsd: null })), false)
  })

  it('reason counts always carry every key, so a zero is a real measured zero', () => {
    const counts = buildCanonicalVerifiedPredicateReasonCounts([
      lot(),
      lot({ evidenceQuality: 'unpriced' }),
      lot({ evidenceQuality: 'unpriced' }),
      lot({ costBasisUsd: null }),
    ])
    assert.equal(counts.evidence_quality_not_verified, 2)
    assert.equal(counts.missing_cost_basis, 1)
    assert.equal(counts.missing_proceeds, 0)
    for (const reason of CANONICAL_VERIFIED_REJECTION_REASONS) {
      assert.equal(typeof counts[reason], 'number', `${reason} must always be reported`)
    }
    assert.deepEqual(Object.keys(emptyCanonicalVerifiedPredicateReasonCounts()).sort(), [...CANONICAL_VERIFIED_REJECTION_REASONS].sort())
  })

  it('an all-verified array produces zero rejections', () => {
    const counts = buildCanonicalVerifiedPredicateReasonCounts([lot(), lot(), lot()])
    assert.deepEqual(counts, emptyCanonicalVerifiedPredicateReasonCounts())
  })
})
