// Tests for lib/server/tokenPublicResponse.ts's applyTokenScannerPlanGate — token-scanner audit
// fix (free callers previously got the exact same LP/holder/security/dev-risk analysis as Pro/
// Elite, with zero server-side gating).
//
// Run with:
//   npx tsx --test lib/server/tokenPublicResponse.test.ts

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyTokenScannerPlanGate } from './tokenPublicResponse'

function fakeFullResponse(): Record<string, unknown> {
  return {
    symbol: 'TEST',
    name: 'Test Token',
    priceUsd: 1.23,
    liquidityUsd: 45000,
    volume24hUsd: 9000,
    holderDistribution: { top1: 12, top10: 40, topHolders: [{ rank: 1, address: '0xabc', percent: 12 }] },
    riskEngine: { deployerProfile: { deployPattern: 'proxy' }, riskDrivers: ['x'] },
    lpControllerIntel: { controllerType: 'timelock', controllerSharePercent: 10 },
    lpMovementWatch: { recentTransferCount: 5, controller: '0xdead' },
    security: { mint: true, blacklist: false },
    riskScore: 62,
    riskLabel: 'moderate',
    sections: { contractChecks: { totalSupply: '1000000' }, market: { status: 'ok' } },
  }
}

describe('applyTokenScannerPlanGate', () => {
  it('returns the exact same object reference for pro — zero overhead, zero risk of regression', () => {
    const full = fakeFullResponse()
    const result = applyTokenScannerPlanGate(full, 'pro')
    assert.equal(result, full)
  })

  it('returns the exact same object reference for elite', () => {
    const full = fakeFullResponse()
    const result = applyTokenScannerPlanGate(full, 'elite')
    assert.equal(result, full)
  })

  it('never mutates the input object for free — the shared token cache depends on this', () => {
    const full = fakeFullResponse()
    const before = JSON.stringify(full)
    applyTokenScannerPlanGate(full, 'free')
    assert.equal(JSON.stringify(full), before)
  })

  it('gates the Pro-only object sections for free, replacing them with a benign placeholder rather than deleting them', () => {
    const gated = applyTokenScannerPlanGate(fakeFullResponse(), 'free')
    assert.deepEqual(gated.holderDistribution, { status: 'requires_pro' })
    assert.deepEqual(gated.riskEngine, { status: 'requires_pro' })
    assert.deepEqual(gated.lpControllerIntel, { status: 'requires_pro' })
    assert.deepEqual(gated.lpMovementWatch, { status: 'requires_pro' })
    assert.deepEqual(gated.security, { status: 'requires_pro' })
  })

  it('never fully deletes a gated section — direct dot-access on a known sub-field must not throw (matches un-optional-chained frontend reads like lpMovementWatch.recentTransferCount)', () => {
    const gated = applyTokenScannerPlanGate(fakeFullResponse(), 'free') as Record<string, any>
    assert.doesNotThrow(() => {
      const v = gated.lpMovementWatch.recentTransferCount
      assert.equal(v, undefined)
    })
  })

  it('nulls the gated scalar fields for free rather than deleting them', () => {
    const gated = applyTokenScannerPlanGate(fakeFullResponse(), 'free')
    assert.equal(gated.riskScore, null)
    assert.equal(gated.riskLabel, null)
  })

  it('gates sections.contractChecks specifically while leaving sibling sections intact', () => {
    const gated = applyTokenScannerPlanGate(fakeFullResponse(), 'free') as Record<string, any>
    assert.deepEqual(gated.sections.contractChecks, { status: 'requires_pro' })
    assert.deepEqual(gated.sections.market, { status: 'ok' })
  })

  it('leaves basic/market fields untouched for free — matches the pricing page\'s "basic token and liquidity checks" promise', () => {
    const gated = applyTokenScannerPlanGate(fakeFullResponse(), 'free')
    assert.equal(gated.symbol, 'TEST')
    assert.equal(gated.priceUsd, 1.23)
    assert.equal(gated.liquidityUsd, 45000)
    assert.equal(gated.volume24hUsd, 9000)
  })

  it('adds planGate metadata for free responses only', () => {
    const gatedFree = applyTokenScannerPlanGate(fakeFullResponse(), 'free') as Record<string, any>
    assert.equal(gatedFree.planGate.plan, 'free')
    assert.equal(gatedFree.planGate.requiredPlan, 'pro')
    const gatedPro = applyTokenScannerPlanGate(fakeFullResponse(), 'pro') as Record<string, any>
    assert.equal(gatedPro.planGate, undefined)
  })

  it('is a no-op on an already-gated response (idempotent — matters since the cache-read path can run this on data already shaped differently)', () => {
    const once = applyTokenScannerPlanGate(fakeFullResponse(), 'free')
    const twice = applyTokenScannerPlanGate(once, 'free')
    assert.deepEqual(twice, once)
  })
})
