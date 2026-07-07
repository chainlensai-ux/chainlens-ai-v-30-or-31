// Tests for derivePublicPnlStatus's coverage-ratio confidence tiering (src/modules/fifoEngine/
// index.ts). NOT wired into `npm test`. Run directly with:
//   npx tsx --test src/modules/fifoEngine/derivePublicPnlStatus.test.ts
//
// Regression coverage for the Clark-summary-confidence-mislabeling fix: previously this function
// only checked an absolute verified-lot count (>=10 -> 'ok'), so a wallet with plenty of verified
// lots but far more UNMATCHED sells (no cost-basis evidence at all) still got the strongest
// confidence label. These tests assert the new coverage-ratio gate actually catches that case,
// while not regressing the honest-high-confidence and honest-zero-evidence cases.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { derivePublicPnlStatus } from './index'

describe('derivePublicPnlStatus', () => {
  it('hardInvalid always wins, regardless of counts', () => {
    assert.equal(derivePublicPnlStatus(50, 50, 0, true), 'unavailable')
  })

  it('zero verified matches is unavailable', () => {
    assert.equal(derivePublicPnlStatus(0, 0, 0, false), 'unavailable')
  })

  it('fewer than 10 verified matches is limited_verified_sample, even with perfect coverage', () => {
    assert.equal(derivePublicPnlStatus(9, 9, 0, false), 'limited_verified_sample')
  })

  it('THE REGRESSION CASE: 17 verified matches but 118 unmatched sells (heavy evidence gap) must NOT be "ok"', () => {
    // Matches the real wallet that surfaced this bug: 17 closed/verified lots, 118 unmatched sells —
    // coverage ratio = 17 / (17 + 118) ≈ 0.126, far below the 0.5 majority bar.
    assert.equal(
      derivePublicPnlStatus(17, 17, 118, false),
      'limited_verified_sample',
      'a wallet whose sells are ~87% unmatched must not be labeled "Verified FIFO sample — official PnL available"',
    )
  })

  it('a wallet with >=10 verified matches AND real majority coverage is "ok"', () => {
    // 40 verified matches, only 10 unmatched sells -> coverage ratio = 40/50 = 0.8, well over 0.5.
    assert.equal(derivePublicPnlStatus(40, 40, 10, false), 'ok')
  })

  it('exactly at the 0.5 coverage boundary is "ok" (>= 0.5, not > 0.5)', () => {
    // 10 verified matches, 10 unmatched sells -> coverage ratio = 10/20 = 0.5 exactly.
    assert.equal(derivePublicPnlStatus(10, 10, 10, false), 'ok')
  })

  it('just under the 0.5 coverage boundary is limited_verified_sample', () => {
    // 10 verified matches, 11 unmatched sells -> coverage ratio = 10/21 ≈ 0.476.
    assert.equal(derivePublicPnlStatus(10, 10, 11, false), 'limited_verified_sample')
  })

  it('lower-quality (non-verified) matched lots count toward totalSellAttempts, diluting coverage', () => {
    // 10 verified + 10 lower-quality matched (matchedCount=20) + 0 unmatched -> ratio = 10/20 = 0.5, exactly "ok".
    assert.equal(derivePublicPnlStatus(10, 20, 0, false), 'ok')
    // Same but one more unmatched sell tips it under: 10/21 < 0.5.
    assert.equal(derivePublicPnlStatus(10, 20, 1, false), 'limited_verified_sample')
  })

  it('zero total sell attempts (matchedCount=0, unmatchedSells=0) never divides by zero', () => {
    // Can only happen if verifiedMatchedCount is also 0 in practice (matchedCount >= verifiedMatchedCount),
    // but guard the arithmetic directly regardless.
    assert.doesNotThrow(() => derivePublicPnlStatus(0, 0, 0, false))
  })
})
