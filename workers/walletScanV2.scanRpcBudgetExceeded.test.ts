// Tests for scanRpcBudgetExceeded (workers/walletScanV2.ts), added for the Alchemy-hard-limit
// task's per-scan cumulative RPC budget. NOT wired into `npm test`. Run directly with:
//   npx tsx --test workers/walletScanV2.scanRpcBudgetExceeded.test.ts

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { scanRpcBudgetExceeded } from './walletScanV2'
import { auditRPC, resetAlchemyAudit } from '@/lib/server/alchemyAudit'

describe('scanRpcBudgetExceeded', () => {
  beforeEach(() => {
    resetAlchemyAudit()
  })

  it('returns false when well under the 500-call budget', () => {
    for (let i = 0; i < 10; i++) auditRPC('alchemy_getTokenBalances', { i })
    const moduleErrors: Record<string, string> = {}
    assert.equal(scanRpcBudgetExceeded(moduleErrors), false)
    assert.equal(moduleErrors.rpcBudget, undefined)
  })

  it('returns true and records moduleErrors.rpcBudget once the budget is exceeded', () => {
    for (let i = 0; i < 501; i++) auditRPC('alchemy_getAssetTransfers', { i })
    const moduleErrors: Record<string, string> = {}
    assert.equal(scanRpcBudgetExceeded(moduleErrors), true)
    assert.match(moduleErrors.rpcBudget, /RPC_BUDGET_EXCEEDED_501_CALLS/)
  })

  it('does not overwrite an already-recorded rpcBudget entry on a later check', () => {
    for (let i = 0; i < 501; i++) auditRPC('alchemy_getAssetTransfers', { i })
    const moduleErrors: Record<string, string> = {}
    scanRpcBudgetExceeded(moduleErrors)
    const firstMessage = moduleErrors.rpcBudget

    for (let i = 0; i < 100; i++) auditRPC('alchemy_getAssetTransfers', { i })
    scanRpcBudgetExceeded(moduleErrors)

    assert.equal(moduleErrors.rpcBudget, firstMessage)
  })
})
