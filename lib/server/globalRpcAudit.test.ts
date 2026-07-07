// Tests for lib/server/globalRpcAudit.ts (hidden-CU-burn task). NOT wired into `npm test`. Run
// directly with:
//   npx tsx --test lib/server/globalRpcAudit.test.ts

import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { auditGlobalAlchemyCall, resetGlobalRpcAudit, getGlobalRpcAuditSnapshot } from './globalRpcAudit'

describe('globalRpcAudit', () => {
  beforeEach(() => {
    resetGlobalRpcAudit()
  })

  it('never throws, even with unusual params', () => {
    assert.doesNotThrow(() => auditGlobalAlchemyCall('eth_getCode', { circular: undefined }))
  })

  it('tracks a call count per caller file', () => {
    auditGlobalAlchemyCall('eth_getCode', {})
    auditGlobalAlchemyCall('eth_getBalance', {})
    const snapshot = getGlobalRpcAuditSnapshot()
    const counts = Object.values(snapshot)
    assert.ok(counts.length > 0)
    assert.ok(counts.some((c) => c >= 2))
  })

  it('logs a BURST DETECTED warning once a caller exceeds 50 calls in the burst window', () => {
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    try {
      for (let i = 0; i < 60; i++) auditGlobalAlchemyCall('eth_getCode', { i })
    } finally {
      console.warn = originalWarn
    }
    assert.ok(warnings.some((w) => w[0] === '[GLOBAL-RPC-AUDIT] BURST DETECTED'))
  })

  it('does not log a burst warning for a normal, low call count', () => {
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    try {
      for (let i = 0; i < 5; i++) auditGlobalAlchemyCall('eth_getCode', { i })
    } finally {
      console.warn = originalWarn
    }
    assert.ok(!warnings.some((w) => w[0] === '[GLOBAL-RPC-AUDIT] BURST DETECTED'))
  })

  it('logs a POLL LOOP DETECTED warning when calls arrive at a fixed interval', async () => {
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    try {
      // Simulate 5 calls exactly ~1200ms apart — inside the [1000, 5000]ms poll window and
      // tightly regular (the signature of a setInterval loop).
      for (let i = 0; i < 5; i++) {
        auditGlobalAlchemyCall('eth_getBalance', { i })
        await new Promise((r) => setTimeout(r, 1200))
      }
    } finally {
      console.warn = originalWarn
    }
    assert.ok(warnings.some((w) => w[0] === '[GLOBAL-RPC-AUDIT] POLL LOOP DETECTED'))
  })

  it('does not flag irregular, organic call timing as a poll loop', async () => {
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    try {
      const delays = [50, 800, 30, 1900]
      for (const d of delays) {
        auditGlobalAlchemyCall('eth_getBalance', {})
        await new Promise((r) => setTimeout(r, d))
      }
      auditGlobalAlchemyCall('eth_getBalance', {})
    } finally {
      console.warn = originalWarn
    }
    assert.ok(!warnings.some((w) => w[0] === '[GLOBAL-RPC-AUDIT] POLL LOOP DETECTED'))
  })

  it('logs an info line for every call with a [GLOBAL-RPC-AUDIT] prefix', () => {
    const infoMock = mock.method(console, 'info', () => {})
    try {
      auditGlobalAlchemyCall('eth_getCode', {})
    } finally {
      infoMock.mock.restore()
    }
    assert.equal(infoMock.mock.calls.length, 1)
    assert.equal(infoMock.mock.calls[0].arguments[0], '[GLOBAL-RPC-AUDIT]')
  })
})
