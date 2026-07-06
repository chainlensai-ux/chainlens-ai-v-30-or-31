// Tests for withScanTimeout (src/utils/timeout.ts). NOT wired into `npm test`. Run directly with:
//   npx tsx --test src/utils/timeout.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { withScanTimeout } from './timeout'

function delay<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

describe('withScanTimeout', () => {
  it('resolves with the real value when the promise finishes before the timeout', async () => {
    const result = await withScanTimeout(delay('ok', 10), 1000)
    assert.equal(result, 'ok')
  })

  it('rejects with SCAN_TIMEOUT_<ms>ms when the promise takes longer than the timeout', async () => {
    await assert.rejects(
      () => withScanTimeout(delay('too-slow', 200), 20),
      (err: Error) => {
        assert.equal(err.message, 'SCAN_TIMEOUT_20ms')
        return true
      },
    )
  })

  it('propagates the real rejection reason when the promise itself rejects before the timeout', async () => {
    const rejecting = Promise.reject(new Error('real failure'))
    await assert.rejects(() => withScanTimeout(rejecting, 1000), /real failure/)
  })
})
