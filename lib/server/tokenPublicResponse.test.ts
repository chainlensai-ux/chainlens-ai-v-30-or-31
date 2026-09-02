// Tests for lib/server/tokenPublicResponse.ts's applyTokenScannerPlanGate.
// Free now includes holders, LP Safety, Risk Engine, and dev checks — the gate
// must not redact those sections. Quota is enforced at the route.
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
  it('returns the exact same object reference for pro — zero overhead', () => {
    const full = fakeFullResponse()
    const result = applyTokenScannerPlanGate(full, 'pro')
    assert.equal(result, full)
  })

  it('returns the exact same object reference for elite', () => {
    const full = fakeFullResponse()
    const result = applyTokenScannerPlanGate(full, 'elite')
    assert.equal(result, full)
  })

  it('returns the exact same object reference for free — Free includes holders, LP Safety, risk, and dev checks', () => {
    const full = fakeFullResponse()
    const result = applyTokenScannerPlanGate(full, 'free')
    assert.equal(result, full)
  })

  it('never mutates the input object', () => {
    const full = fakeFullResponse()
    const before = JSON.stringify(full)
    applyTokenScannerPlanGate(full, 'free')
    assert.equal(JSON.stringify(full), before)
  })

  it('does not redact holder, LP, risk, or security evidence for free', () => {
    const gated = applyTokenScannerPlanGate(fakeFullResponse(), 'free') as Record<string, any>
    assert.equal(gated.holderDistribution.top1, 12)
    assert.equal(gated.riskEngine.deployerProfile.deployPattern, 'proxy')
    assert.equal(gated.lpControllerIntel.controllerType, 'timelock')
    assert.equal(gated.lpMovementWatch.recentTransferCount, 5)
    assert.equal(gated.security.mint, true)
    assert.equal(gated.riskScore, 62)
    assert.equal(gated.riskLabel, 'moderate')
    assert.equal(gated.sections.contractChecks.totalSupply, '1000000')
    assert.equal(gated.planGate, undefined)
  })

  it('leaves basic/market fields untouched for free', () => {
    const gated = applyTokenScannerPlanGate(fakeFullResponse(), 'free')
    assert.equal(gated.symbol, 'TEST')
    assert.equal(gated.priceUsd, 1.23)
    assert.equal(gated.liquidityUsd, 45000)
    assert.equal(gated.volume24hUsd, 9000)
  })
})
