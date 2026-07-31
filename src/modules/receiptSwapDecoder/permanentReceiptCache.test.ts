import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  seedPermanentReceiptsIntoRequestScope,
  recordPermanentReceiptsFromRequestScope,
  permanentReceiptCacheSize,
  __resetPermanentReceiptCacheForTest,
  __getPermanentReceiptCacheEntryForTest,
} from './permanentReceiptCache'
import { createReceiptRequestScopeCache, receiptCacheKey } from './receiptAcquisition'
import type { RawReceiptLog } from './types'

const LOGS: RawReceiptLog[] = [{ logIndex: 0, address: '0xpool', topics: ['0xtopic'], data: '0x' }]

beforeEach(() => {
  __resetPermanentReceiptCacheForTest()
})

test('an accepted receipt recorded from a request scope is stored permanently', () => {
  const scope = createReceiptRequestScopeCache()
  scope.cache.set(receiptCacheKey('base', '0xabc'), { status: 'ok', logs: LOGS })
  const recorded = recordPermanentReceiptsFromRequestScope(scope)
  assert.equal(recorded, 1)
  assert.equal(permanentReceiptCacheSize(), 1)
  assert.deepEqual(__getPermanentReceiptCacheEntryForTest('base', '0xabc'), { status: 'ok', logs: LOGS })
})

test('a missing/timeout/malformed/reverted outcome is never stored permanently', () => {
  const scope = createReceiptRequestScopeCache()
  scope.cache.set(receiptCacheKey('base', '0x1'), { status: 'missing' })
  scope.cache.set(receiptCacheKey('base', '0x2'), { status: 'timeout' })
  scope.cache.set(receiptCacheKey('base', '0x3'), { status: 'malformed' })
  scope.cache.set(receiptCacheKey('base', '0x4'), { status: 'reverted' })
  const recorded = recordPermanentReceiptsFromRequestScope(scope)
  assert.equal(recorded, 0)
  assert.equal(permanentReceiptCacheSize(), 0)
})

test('a permanently cached receipt is seeded into a fresh request scope as a real ok outcome, zero network calls implied', () => {
  const firstScope = createReceiptRequestScopeCache()
  firstScope.cache.set(receiptCacheKey('base', '0xabc'), { status: 'ok', logs: LOGS })
  recordPermanentReceiptsFromRequestScope(firstScope)

  const secondScope = createReceiptRequestScopeCache()
  const seeded = seedPermanentReceiptsIntoRequestScope(secondScope, [{ chain: 'base', txHash: '0xabc' }, { chain: 'base', txHash: '0xnotcached' }])
  assert.equal(seeded, 1)
  assert.deepEqual(secondScope.cache.get(receiptCacheKey('base', '0xabc')), { status: 'ok', logs: LOGS })
  assert.equal(secondScope.cache.has(receiptCacheKey('base', '0xnotcached')), false)
})

test('seeding never overwrites an entry the request scope already has', () => {
  const permScope = createReceiptRequestScopeCache()
  permScope.cache.set(receiptCacheKey('base', '0xabc'), { status: 'ok', logs: LOGS })
  recordPermanentReceiptsFromRequestScope(permScope)

  const otherLogs: RawReceiptLog[] = [{ logIndex: 1, address: '0xother', topics: ['0xdifferent'], data: '0x01' }]
  const freshScope = createReceiptRequestScopeCache()
  freshScope.cache.set(receiptCacheKey('base', '0xabc'), { status: 'ok', logs: otherLogs })
  const seeded = seedPermanentReceiptsIntoRequestScope(freshScope, [{ chain: 'base', txHash: '0xabc' }])
  assert.equal(seeded, 0)
  assert.deepEqual(freshScope.cache.get(receiptCacheKey('base', '0xabc')), { status: 'ok', logs: otherLogs })
})

test('recording is idempotent — re-recording an already-permanent entry changes nothing', () => {
  const scope = createReceiptRequestScopeCache()
  scope.cache.set(receiptCacheKey('base', '0xabc'), { status: 'ok', logs: LOGS })
  recordPermanentReceiptsFromRequestScope(scope)
  const secondRecord = recordPermanentReceiptsFromRequestScope(scope)
  assert.equal(secondRecord, 0)
  assert.equal(permanentReceiptCacheSize(), 1)
})

test('an unrecorded chain:txHash reads back null, never a fabricated entry', () => {
  assert.equal(__getPermanentReceiptCacheEntryForTest('base', '0xneverfetched'), null)
})
