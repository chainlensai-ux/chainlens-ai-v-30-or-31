// Tests for scripts/perfBenchmark/formatReport.ts. Run directly with:
//   npx tsx --test scripts/perfBenchmark/formatReport.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { percentChange, formatBenchmarkReport } from './formatReport'
import type { BenchmarkBuckets } from './buckets'

describe('percentChange', () => {
  it('a real slowdown is reported as a positive percent', () => {
    assert.equal(percentChange(100, 150, 0), '+50%')
  })

  it('a real speedup is reported as a negative percent', () => {
    assert.equal(percentChange(100, 69, 0), '-31%')
  })

  it('no change at all is reported as exactly 0%, not a rounding artifact like -0% or +0%', () => {
    assert.equal(percentChange(100, 100, 0), '0%')
  })

  it('both old and new are genuinely 0ms (a stage this scan never reached, either time) reports an honest 0%, never a fabricated number', () => {
    assert.equal(percentChange(0, 0, 0), '0%')
  })

  it('old was 0ms but new is not (a stage that started running that never ran before) is reported as undefined, never a fabricated Infinity/NaN', () => {
    assert.equal(percentChange(0, 50, 0), 'N/A (new work)')
  })

  it('respects the requested decimal precision (0 for per-bucket lines, 1 for the Overall line)', () => {
    assert.equal(percentChange(64200, 41800, 1), '-34.9%')
  })
})

function buckets(overrides: Partial<BenchmarkBuckets>): BenchmarkBuckets {
  return { providerFetch: 0, pricing: 0, merge: 0, recovery: 0, other: 0, totalMs: 0, ...overrides }
}

describe('formatBenchmarkReport', () => {
  it('matches the exact requested report shape for a representative before/after', () => {
    const old = buckets({ providerFetch: 20000, pricing: 18000, merge: 5000, recovery: 5000, totalMs: 64200 })
    const current = buckets({ providerFetch: 13800, pricing: 14000, merge: 5000, recovery: 5000, totalMs: 41800 })
    const report = formatBenchmarkReport(old, current)
    assert.equal(
      report,
      [
        'Old scan: 64.2s',
        'New scan: 41.8s',
        'Provider fetch:',
        '-31%',
        'Pricing:',
        '-22%',
        'Merge:',
        '0%',
        'Recovery:',
        '0%',
        'Overall:',
        '-34.9%',
      ].join('\n'),
    )
  })

  it('omits the "Other" line when neither run spent any time in an unmapped stage', () => {
    const old = buckets({ totalMs: 1000 })
    const current = buckets({ totalMs: 1000 })
    assert.doesNotMatch(formatBenchmarkReport(old, current), /Other/)
  })

  it('includes the "Other" line, never silently hiding real unmapped-stage time, when either run has some', () => {
    const old = buckets({ other: 500, totalMs: 500 })
    const current = buckets({ other: 200, totalMs: 200 })
    const report = formatBenchmarkReport(old, current)
    assert.match(report, /Other \(unmapped stages\):\n-60%/)
  })
})
