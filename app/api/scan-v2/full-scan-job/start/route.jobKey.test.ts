// Test for full-scan-job/start's jobKey — "clear or version stale cached scan results containing
// legacy unrealized fields" requirement. Confirms the Redis key namespace was bumped so this
// deploy can never read a job entry written by a previous version (e.g. one enqueued just before a
// deploy, whose background work could still run on old code that lacked
// unrealizedReconciliation), forcing a clean re-scan instead of serving a stale legacy-shaped
// payload.
//
// NOT wired into `npm test`. Run directly with:
//   npx tsx --test app/api/scan-v2/full-scan-job/start/route.jobKey.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fullScanJobKey as jobKey } from '@/lib/server/fullScanJobs'

describe('jobKey — cache-version namespace bump', () => {
  it('uses the v2 key namespace, never the old v1 one', () => {
    const key = jobKey('abc-123')
    assert.equal(key, 'v2:full-scan-job:abc-123')
    assert.ok(!key.startsWith('v1:'), 'must never read/write under the pre-fix v1 namespace')
  })

  it('a job written under the old v1 namespace is unreachable via the current jobKey for the same jobId', () => {
    const jobId = 'same-job-id'
    const legacyKey = `v1:full-scan-job:${jobId}`
    const currentKey = jobKey(jobId)
    assert.notEqual(currentKey, legacyKey, 'the current key must never coincide with a pre-fix legacy key for the same jobId')
  })

  it('distinct jobIds still produce distinct keys within the new namespace', () => {
    assert.notEqual(jobKey('a'), jobKey('b'))
  })
})
