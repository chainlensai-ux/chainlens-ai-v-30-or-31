// Tests for src/modules/scanJobCreation.ts (extracted from app/api/scan-start/route.ts). NOT wired
// into `npm test`. Run directly with:
//   npx tsx --test src/modules/scanJobCreation.test.ts
//
// SCOPE, DISCLOSED: only the validation-rejection branches are unit-tested here. The success path
// calls next/server's `after()`, which throws "`after` was called outside a request scope" when
// invoked directly by node:test rather than through Next's real request-handling runtime — this is
// a genuine harness limitation (identical to how this exact `after()` call already couldn't be
// unit-tested before this task's extraction; it only ever ran via the real dev server/deployment
// inside app/api/scan-start/route.ts). The success path (job actually enqueued, worker triggered)
// is verified instead via a real dev-server request against /api/scan-v2/full-scan/start, not a
// node:test unit test — see this task's own verification notes.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAndEnqueueScanJob } from './scanJobCreation'

function fakeRequest(): Request {
  return new Request('http://localhost/api/scan-start', { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' } })
}

describe('createAndEnqueueScanJob', () => {
  it('rejects an invalid wallet address before creating a job', async () => {
    const result = await createAndEnqueueScanJob(fakeRequest(), { walletAddress: 'not-a-wallet' }, 'deep')
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.status, 400)
  })

  it('rejects an invalid scanMode', async () => {
    const result = await createAndEnqueueScanJob(
      fakeRequest(),
      { walletAddress: '0x' + '1'.repeat(40), scanMode: 'bogus' },
      'deep',
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.status, 400)
  })

  it('rejects invalid chains before creating a job', async () => {
    const result = await createAndEnqueueScanJob(
      fakeRequest(),
      { walletAddress: '0x' + '1'.repeat(40), chains: ['not-a-real-chain'] },
      'deep',
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.status, 400)
  })
})
