// Tests for app/api/_shared/cuUsageStore.ts. NOT wired into `npm test`. Run directly with:
//   npx tsx --test app/api/_shared/cuUsageStore.test.ts
//
// The module holds a single shared in-memory object (matching its own real, module-level design —
// see its header) so these tests read/assert on cumulative totals rather than resetting state
// between cases, and use a diff (before/after) to stay correct regardless of test run order.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { recordCuUsage, getCuUsageSummary } from './cuUsageStore'

describe('cuUsageStore', () => {
  it('recordCuUsage accumulates providerCalls/cacheHits under today\'s date key', () => {
    const today = new Date().toISOString().slice(0, 10)
    const before = getCuUsageSummary()[today] ?? { date: today, providerCalls: 0, cacheHits: 0 }

    recordCuUsage(3, 2)
    recordCuUsage(1, 0)

    const after = getCuUsageSummary()[today]
    assert.ok(after, 'expected an entry for today\'s date after recording usage')
    assert.equal(after.date, today)
    assert.equal(after.providerCalls, before.providerCalls + 4)
    assert.equal(after.cacheHits, before.cacheHits + 2)
  })

  it('getCuUsageSummary returns the same live object recordCuUsage writes to (not a stale copy)', () => {
    const today = new Date().toISOString().slice(0, 10)
    const beforeCount = getCuUsageSummary()[today]?.providerCalls ?? 0
    recordCuUsage(5, 0)
    assert.equal(getCuUsageSummary()[today].providerCalls, beforeCount + 5)
  })

  it('recording 0/0 is a safe no-op on the totals (still creates today\'s entry)', () => {
    const today = new Date().toISOString().slice(0, 10)
    const before = getCuUsageSummary()[today]?.providerCalls ?? 0
    const beforeHits = getCuUsageSummary()[today]?.cacheHits ?? 0
    recordCuUsage(0, 0)
    assert.equal(getCuUsageSummary()[today].providerCalls, before)
    assert.equal(getCuUsageSummary()[today].cacheHits, beforeHits)
  })
})
