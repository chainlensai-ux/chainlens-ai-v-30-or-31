// Tests for app/frontend/lib/walletScannerDiagnosticsSelector.ts — the V3 "Advanced Diagnostics"
// collapsed-summary selector. Uses node:test. Run with:
//   npx tsx --test app/frontend/lib/walletScannerDiagnosticsSelector.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectDiagnosticsSummary } from './walletScannerDiagnosticsSelector'

describe('selectDiagnosticsSummary — Wallet Scanner V3 Advanced Diagnostics (real counts only, never a fabricated score)', () => {
  it('reports real counts from recoveryPolicy.evaluation, never an invented score', () => {
    const result = selectDiagnosticsSummary({
      recoveryPolicy: {
        evaluation: [
          { chain: 'base', token: '0xa', recoveryTriggered: true, triggeredBy: [], pagesUsed: 1, recoveredEvents: [] },
          { chain: 'base', token: '0xb', recoveryTriggered: false, triggeredBy: [], pagesUsed: 0, recoveredEvents: [] },
          { chain: 'base', token: '0xc', recoveryTriggered: true, triggeredBy: [], pagesUsed: 2, recoveredEvents: [] },
        ],
        caps: { maxHistoricalPagesPerWallet: 10, maxHistoricalPagesPerToken: 3 },
        totalPagesUsedThisWallet: 3,
      } as never,
    })
    assert.equal(result.recoveryTriggeredCount, 2)
    assert.equal(result.recoveryEvaluatedCount, 3)
  })

  it('reports the real windowCoverage.coverageBasis string verbatim, never a derived label', () => {
    const result = selectDiagnosticsSummary({ windowCoverage: { realDataDays: 80, inferredDays: 10, recoveredExtraDays: 5, coverageBasis: 'partial_window_plus_targeted_recovery' } as never })
    assert.equal(result.windowCoverageBasis, 'partial_window_plus_targeted_recovery')
  })

  it('counts real wallet condition messages and module errors', () => {
    const result = selectDiagnosticsSummary({
      walletConditionMessages: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }] as never,
      moduleErrors: { pnl: 'timeout', chainActivity: 'timeout' },
    })
    assert.equal(result.walletConditionCount, 2)
    assert.equal(result.moduleErrorCount, 2)
  })

  it('defaults every count to 0/null when nothing is supplied — never a fabricated nonzero default', () => {
    const result = selectDiagnosticsSummary({})
    assert.deepEqual(result, {
      walletConditionCount: 0,
      recoveryTriggeredCount: 0,
      recoveryEvaluatedCount: 0,
      windowCoverageBasis: null,
      moduleErrorCount: 0,
    })
  })
})
