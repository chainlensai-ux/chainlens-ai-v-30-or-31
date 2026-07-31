import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateAlchemyUsage, type AlchemyUsageRecord } from './alchemyUsageAttribution'

function rec(overrides: Partial<AlchemyUsageRecord> = {}): AlchemyUsageRecord {
  return {
    timestamp: 1, requestId: 'req-1', route: '/api/scan-v2', feature: 'wallet_scan',
    method: 'eth_getLogs', chain: 'base', callCount: 1, cacheHit: false, estimatedCu: 75,
    userClassification: 'anonymous', sourceCategory: 'explicit_scan',
    ...overrides,
  }
}

// NEVER LOGS SENSITIVE DATA, DISCLOSED: the record type itself has no field for a wallet address,
// token balance, secret, or API key -- this test asserts that structural guarantee by exhaustively
// checking every key on a built record.
test('a usage record never carries a field resembling wallet contents, tokens, or secrets', () => {
  const record = rec()
  const forbiddenKeyPatterns = /wallet|token|secret|key|balance|amount/i
  for (const key of Object.keys(record)) {
    assert.doesNotMatch(key, forbiddenKeyPatterns, `field "${key}" looks like it could carry sensitive data`)
  }
})

test('aggregates total calls, estimated CU, and cache hit/miss counts', () => {
  const records = [rec({ cacheHit: true, estimatedCu: 10 }), rec({ cacheHit: false, estimatedCu: 75 }), rec({ cacheHit: false, estimatedCu: 150, method: 'alchemy_getAssetTransfers' })]
  const agg = aggregateAlchemyUsage(records)
  assert.equal(agg.totalCalls, 3)
  assert.equal(agg.totalEstimatedCu, 235)
  assert.equal(agg.cacheHits, 1)
  assert.equal(agg.cacheMisses, 2)
})

test('groups calls and estimated CU by route', () => {
  const records = [
    rec({ route: '/api/scan-v2', estimatedCu: 75 }),
    rec({ route: '/api/scan-v2', estimatedCu: 75 }),
    rec({ route: '/api/portfolio', estimatedCu: 26 }),
  ]
  const agg = aggregateAlchemyUsage(records)
  assert.equal(agg.byRoute['/api/scan-v2'].calls, 2)
  assert.equal(agg.byRoute['/api/scan-v2'].estimatedCu, 150)
  assert.equal(agg.byRoute['/api/portfolio'].calls, 1)
})

test('groups calls and estimated CU by method', () => {
  const records = [
    rec({ method: 'eth_getLogs', estimatedCu: 75 }),
    rec({ method: 'alchemy_getAssetTransfers', estimatedCu: 150 }),
  ]
  const agg = aggregateAlchemyUsage(records)
  assert.equal(agg.byMethod.eth_getLogs.calls, 1)
  assert.equal(agg.byMethod.alchemy_getAssetTransfers.estimatedCu, 150)
})

test('top request IDs are ranked by estimated CU, descending, bounded to at most 10', () => {
  const records = Array.from({ length: 15 }, (_, i) => rec({ requestId: `req-${i}`, estimatedCu: i }))
  const agg = aggregateAlchemyUsage(records)
  assert.equal(agg.topRequestIds.length, 10)
  assert.equal(agg.topRequestIds[0].requestId, 'req-14')
  assert.equal(agg.topRequestIds[0].estimatedCu, 14)
  // Strictly descending.
  for (let i = 1; i < agg.topRequestIds.length; i += 1) {
    assert.ok(agg.topRequestIds[i - 1].estimatedCu >= agg.topRequestIds[i].estimatedCu)
  }
})

test('an empty record set aggregates to all zeros, never throws', () => {
  const agg = aggregateAlchemyUsage([])
  assert.equal(agg.totalCalls, 0)
  assert.equal(agg.totalEstimatedCu, 0)
  assert.deepEqual(agg.topRequestIds, [])
})
