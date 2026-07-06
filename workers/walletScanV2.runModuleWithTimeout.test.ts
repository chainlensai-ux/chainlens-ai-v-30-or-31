// Tests for runModuleWithTimeout (workers/walletScanV2.ts), added for the stuck-at-module-11 task.
// NOT wired into `npm test`. Run directly with:
//   npx tsx --test workers/walletScanV2.runModuleWithTimeout.test.ts
//
// SCOPE, DISCLOSED: workers/walletScanV2.ts's own runWalletScanV2Worker has too large a real-
// provider dependency chain (router.handleScanRequest, fetchAllHoldings, etc.) to unit-test
// directly without a heavy mocking harness beyond this task's scope — this file tests
// runModuleWithTimeout in isolation instead, which is where the actual new timeout/error-recording
// logic lives.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runModuleWithTimeout } from './walletScanV2'

describe('runModuleWithTimeout', () => {
  it('returns the real value when the module resolves before the timeout', async () => {
    const moduleErrors: Record<string, string> = {}
    const result = await runModuleWithTimeout('holdings', async () => 'real-value', 'fallback', moduleErrors)
    assert.equal(result, 'real-value')
    assert.deepEqual(moduleErrors, {})
  })

  it('returns the fallback and records the error when the module rejects', async () => {
    const moduleErrors: Record<string, string> = {}
    const result = await runModuleWithTimeout(
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
    const result = await runModuleWithTimeout(
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
    const first = await runModuleWithTimeout('holdings', () => new Promise(() => {}), 'fallback-1', moduleErrors, 30)
    const second = await runModuleWithTimeout('pricing', async () => 'real-value-2', 'fallback-2', moduleErrors, 30)

    assert.equal(first, 'fallback-1')
    assert.equal(second, 'real-value-2')
    assert.ok(moduleErrors.holdings)
    assert.equal(moduleErrors.pricing, undefined)
  })
})
