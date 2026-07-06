// Tests for logFifoPricingDivergence (lib/server/engineComparison.ts). NOT wired into `npm test`.
// Run directly with:
//   npx tsx --test lib/server/engineComparison.test.ts
//
// Purely observational function — asserts it logs (or doesn't) via console.warn, never that it
// changes any value, since it has no return value and touches nothing else.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { logFifoPricingDivergence } from './engineComparison'

function captureWarnings(fn: () => void): unknown[][] {
  const calls: unknown[][] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { calls.push(args) }
  try {
    fn()
  } finally {
    console.warn = original
  }
  return calls
}

describe('logFifoPricingDivergence', () => {
  it('does not log when all three realizedPnlUsd values agree', () => {
    const calls = captureWarnings(() => {
      logFifoPricingDivergence({
        walletAddress: '0xabc',
        fifoAndPnl: { realizedPnlUsd: 100, matchedLots: [1, 2] },
        pnlSummaryV2: { realizedPnlUsd: 100, closedLots: [1, 2] },
        pnlV2: { realizedPnlUsd: 100, unrealizedPnlUsd: 0 },
      })
    })
    assert.equal(calls.length, 0)
  })

  it('logs a structured divergence warning when values disagree by more than the threshold', () => {
    const calls = captureWarnings(() => {
      logFifoPricingDivergence({
        walletAddress: '0xabc',
        fifoAndPnl: { realizedPnlUsd: 100, matchedLots: [1, 2] },
        pnlSummaryV2: { realizedPnlUsd: 100, closedLots: [1, 2] },
        pnlV2: { realizedPnlUsd: 150, unrealizedPnlUsd: 0 }, // diverges from the other two
      })
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], '[fifo-compare] divergence detected')
    const payload = calls[0][1] as Record<string, unknown>
    assert.equal(payload.wallet, '0xabc')
  })

  it('treats one side being null and the other not as a divergence', () => {
    const calls = captureWarnings(() => {
      logFifoPricingDivergence({
        walletAddress: '0xabc',
        fifoAndPnl: { realizedPnlUsd: null },
        pnlSummaryV2: { realizedPnlUsd: null },
        pnlV2: { realizedPnlUsd: 50, unrealizedPnlUsd: 0 },
      })
    })
    assert.equal(calls.length, 1)
  })

  it('never throws even with missing/undefined inputs', () => {
    assert.doesNotThrow(() => {
      logFifoPricingDivergence({
        walletAddress: '0xabc',
        fifoAndPnl: undefined,
        pnlSummaryV2: null,
        pnlV2: undefined,
      })
    })
  })

  it('small float differences within the threshold do not trigger a false positive', () => {
    const calls = captureWarnings(() => {
      logFifoPricingDivergence({
        walletAddress: '0xabc',
        fifoAndPnl: { realizedPnlUsd: 100.2 },
        pnlSummaryV2: { realizedPnlUsd: 100.5 },
        pnlV2: { realizedPnlUsd: 100.8, unrealizedPnlUsd: 0 },
      })
    })
    assert.equal(calls.length, 0)
  })
})
