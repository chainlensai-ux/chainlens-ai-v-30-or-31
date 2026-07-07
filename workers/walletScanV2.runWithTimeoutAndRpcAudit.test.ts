// Tests for runWithTimeoutAndRpcAudit (workers/walletScanV2.ts), renamed from
// runModuleWithTimeout along with this file (runaway-RPC task, extending the earlier
// stuck-at-module-11 timeout wrapper with a per-module RPC-call-count guard). NOT wired into
// `npm test`. Run directly with:
//   npx tsx --test workers/walletScanV2.runWithTimeoutAndRpcAudit.test.ts
//
// SCOPE, DISCLOSED: workers/walletScanV2.ts's own runWalletScanV2Worker has too large a real-
// provider dependency chain (router.handleScanRequest, fetchAllHoldings, etc.) to unit-test
// directly without a heavy mocking harness beyond this task's scope — this file tests
// runWithTimeoutAndRpcAudit in isolation instead, which is where the actual timeout/RPC-threshold/
// error-recording logic lives.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { runWithTimeoutAndRpcAudit } from './walletScanV2'
import { alchemyAudit, auditRPC, resetAlchemyAudit } from '@/lib/server/alchemyAudit'

describe('runWithTimeoutAndRpcAudit', () => {
  beforeEach(() => {
    resetAlchemyAudit()
  })

  it('returns the real value when the module resolves before the timeout', async () => {
    const moduleErrors: Record<string, string> = {}
    const result = await runWithTimeoutAndRpcAudit('holdings', async () => 'real-value', 'fallback', moduleErrors)
    assert.equal(result, 'real-value')
    assert.deepEqual(moduleErrors, {})
  })

  it('returns the fallback and records the error when the module rejects', async () => {
    const moduleErrors: Record<string, string> = {}
    const result = await runWithTimeoutAndRpcAudit(
      'pricing',
      async () => { throw new Error('provider exploded') },
      'fallback',
      moduleErrors,
    )
    assert.equal(result, 'fallback')
    assert.equal(moduleErrors.pricing, 'provider exploded')
  })

  it('returns the fallback and records a timeout when the module never settles', async () => {
    const moduleErrors: Record<string, string> = {}
    // A promise that never resolves/rejects — the exact "hang" scenario this task fixes.
    const result = await runWithTimeoutAndRpcAudit(
      'portfolio',
      () => new Promise(() => {}),
      'fallback',
      moduleErrors,
      50, // short timeout override so this test doesn't wait the real 20s default
    )
    assert.equal(result, 'fallback')
    assert.match(moduleErrors.portfolio, /SCAN_TIMEOUT_50ms/)
  })

  it('a hung module does not block a later module from also being attempted', async () => {
    const moduleErrors: Record<string, string> = {}
    const first = await runWithTimeoutAndRpcAudit('holdings', () => new Promise(() => {}), 'fallback-1', moduleErrors, 30)
    const second = await runWithTimeoutAndRpcAudit('pricing', async () => 'real-value-2', 'fallback-2', moduleErrors, 30)

    assert.equal(first, 'fallback-1')
    assert.equal(second, 'real-value-2')
    assert.ok(moduleErrors.holdings)
    assert.equal(moduleErrors.pricing, undefined)
  })

  it('aborts a module that makes more than 200 RPC calls, before its 20s/timeout would fire', async () => {
    const moduleErrors: Record<string, string> = {}
    const result = await runWithTimeoutAndRpcAudit(
      'chainActivity',
      () => new Promise((resolve) => {
        // Simulate a runaway loop making real Alchemy calls, well past the 200 threshold, on an
        // interval fast enough that the RPC guard (polling every 500ms) catches it long before
        // this module's own 5s override timeout would.
        const loopTimer = setInterval(() => auditRPC('alchemy_getAssetTransfers', { loop: true }), 5)
        setTimeout(() => { clearInterval(loopTimer); resolve('should-never-resolve-in-time') }, 4000)
      }),
      'fallback',
      moduleErrors,
      5000,
    )
    assert.equal(result, 'fallback')
    assert.match(moduleErrors.chainActivity, /RPC_THRESHOLD_EXCEEDED_\d+_calls/)
  })

  it('does not abort a module making a normal, bounded number of RPC calls', async () => {
    const moduleErrors: Record<string, string> = {}
    const result = await runWithTimeoutAndRpcAudit(
      'holdings',
      async () => {
        for (let i = 0; i < 5; i++) auditRPC('alchemy_getTokenBalances', { i })
        return 'real-value'
      },
      'fallback',
      moduleErrors,
    )
    assert.equal(result, 'real-value')
    assert.equal(moduleErrors.holdings, undefined)
    assert.equal(alchemyAudit.calls.length, 5)
  })
})
