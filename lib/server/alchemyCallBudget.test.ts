import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createAlchemyCallBudget, estimatedCuForMethod, ALCHEMY_METHOD_CU_COSTS, DEFAULT_ESTIMATED_CU,
} from './alchemyCallBudget'

test('known high-CU methods use their real, published cost, never the default fallback', () => {
  assert.equal(estimatedCuForMethod('alchemy_getAssetTransfers'), ALCHEMY_METHOD_CU_COSTS.alchemy_getAssetTransfers)
  assert.equal(estimatedCuForMethod('eth_getLogs'), ALCHEMY_METHOD_CU_COSTS.eth_getLogs)
  assert.equal(estimatedCuForMethod('trace_transaction'), ALCHEMY_METHOD_CU_COSTS.trace_transaction)
})

test('an unaudited/unknown method falls back to the conservative default, never zero or undefined', () => {
  assert.equal(estimatedCuForMethod('some_future_method_not_in_the_table'), DEFAULT_ESTIMATED_CU)
})

test('allows calls under both the call-count and CU budget', () => {
  const budget = createAlchemyCallBudget({ maxCalls: 5, maxEstimatedCu: 1000 })
  const result = budget.check('eth_blockNumber')
  assert.equal(result.allowed, true)
})

test('call-count budget exhaustion is a typed, distinguishable reason', () => {
  const budget = createAlchemyCallBudget({ maxCalls: 2, maxEstimatedCu: 100_000 })
  budget.record('eth_blockNumber')
  budget.record('eth_blockNumber')
  const result = budget.check('eth_blockNumber')
  assert.equal(result.allowed, false)
  if (result.allowed) return
  assert.equal(result.reason, 'call_count_budget_exceeded')
  assert.equal(result.callsUsed, 2)
})

test('estimated-CU budget exhaustion is a typed, distinguishable reason, distinct from call-count', () => {
  const budget = createAlchemyCallBudget({ maxCalls: 100, maxEstimatedCu: 100 })
  budget.record('alchemy_getAssetTransfers') // 150 CU -- already over the 100 CU cap
  const result = budget.check('eth_blockNumber')
  assert.equal(result.allowed, false)
  if (result.allowed) return
  assert.equal(result.reason, 'estimated_cu_budget_exceeded')
})

test('a budget never records a call unless the caller explicitly calls record() -- check() alone never consumes it', () => {
  const budget = createAlchemyCallBudget({ maxCalls: 1, maxEstimatedCu: 1000 })
  budget.check('eth_blockNumber')
  budget.check('eth_blockNumber')
  budget.check('eth_blockNumber')
  assert.equal(budget.callsUsed(), 0)
})

test('each budget instance is independent -- never a shared/global counter across instances', () => {
  const a = createAlchemyCallBudget({ maxCalls: 1, maxEstimatedCu: 1000 })
  const b = createAlchemyCallBudget({ maxCalls: 1, maxEstimatedCu: 1000 })
  a.record('eth_blockNumber')
  assert.equal(a.callsUsed(), 1)
  assert.equal(b.callsUsed(), 0)
  assert.equal(b.check('eth_blockNumber').allowed, true)
})

test('default budget bounds are sane and finite', () => {
  const budget = createAlchemyCallBudget()
  assert.ok(budget.maxCalls() > 0)
  assert.ok(budget.maxEstimatedCu() > 0)
})
