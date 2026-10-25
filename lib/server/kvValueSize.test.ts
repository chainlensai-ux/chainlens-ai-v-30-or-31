import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertKvValueWithinLimit, KvValueTooLargeError, kvValueBytes } from './kvValueSize'

test('values under the limit pass; oversized values are refused before any request is sent', () => {
  assert.doesNotThrow(() => assertKvValueWithinLimit('k', { a: 'x'.repeat(100) }, 1_000))
  assert.throws(() => assertKvValueWithinLimit('walletScanCoreCheckpoint:abc', { a: 'x'.repeat(2_000) }, 1_000), KvValueTooLargeError)
  assert.equal(kvValueBytes('héllo'), 6)
})
