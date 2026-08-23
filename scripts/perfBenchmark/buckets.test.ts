// Tests for scripts/perfBenchmark/buckets.ts. Run directly with:
//   npx tsx --test scripts/perfBenchmark/buckets.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bucketizeStages, sumBuckets } from './buckets'

describe('bucketizeStages', () => {
  it('maps each real stage name onto its documented bucket', () => {
    const buckets = bucketizeStages([
      { name: 'providerFetchWindow', ms: 100 },
      { name: 'recoveryPolicy', ms: 50 },
      { name: 'priceLotsForWallet', ms: 200 },
      { name: 'pricingAtTime', ms: 30 },
      { name: 'fifoEngine', ms: 20 },
    ])
    assert.equal(buckets.providerFetch, 100)
    assert.equal(buckets.recovery, 50)
    assert.equal(buckets.pricing, 230, 'priceLotsForWallet + pricingAtTime must combine into one Pricing bucket')
    assert.equal(buckets.merge, 20)
    assert.equal(buckets.other, 0)
    assert.equal(buckets.totalMs, 400, 'totalMs must be the real sum of every stage, regardless of bucket')
  })

  it('an unmapped stage name (e.g. dustSuppression) lands in "other", never silently dropped', () => {
    const buckets = bucketizeStages([
      { name: 'dustSuppression', ms: 15 },
      { name: 'receiptDecoding', ms: 5 },
    ])
    assert.equal(buckets.other, 20)
    assert.equal(buckets.totalMs, 20, 'unmapped stage time must still count toward the real total')
  })

  it('a stage this scan never reached is simply absent — its bucket is honestly 0, never fabricated', () => {
    const buckets = bucketizeStages([{ name: 'providerFetchWindow', ms: 100 }])
    assert.equal(buckets.recovery, 0, 'recoveryPolicy never ran (e.g. a normal-mode scan) — must be 0, not estimated')
    assert.equal(buckets.pricing, 0)
    assert.equal(buckets.merge, 0)
  })

  it('an empty stage list produces an all-zero bucket set', () => {
    const buckets = bucketizeStages([])
    assert.deepEqual(buckets, { providerFetch: 0, pricing: 0, merge: 0, recovery: 0, other: 0, totalMs: 0 })
  })
})

describe('sumBuckets', () => {
  it('sums per-wallet bucket totals across a representative wallet set — real addition, no averaging', () => {
    const walletA = bucketizeStages([{ name: 'providerFetchWindow', ms: 100 }, { name: 'fifoEngine', ms: 10 }])
    const walletB = bucketizeStages([{ name: 'providerFetchWindow', ms: 50 }, { name: 'recoveryPolicy', ms: 200 }])
    const total = sumBuckets([walletA, walletB])
    assert.equal(total.providerFetch, 150)
    assert.equal(total.merge, 10)
    assert.equal(total.recovery, 200)
    assert.equal(total.totalMs, 360)
  })

  it('an empty wallet set sums to all zeros', () => {
    assert.deepEqual(sumBuckets([]), { providerFetch: 0, pricing: 0, merge: 0, recovery: 0, other: 0, totalMs: 0 })
  })
})
