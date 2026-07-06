// Tests for src/modules/scanJobs.ts's setJobProgress (module-progress-reporting task). NOT wired
// into `npm test`. Run directly with:
//   npx tsx --test src/modules/scanJobs.test.ts
//
// This sandbox has no REDIS_URL configured, so getScanJob/setScanJob fail open (null / no-op) —
// these tests verify setJobProgress's own branching (no-op on a missing job, never throws), not
// real persistence (same disclosed limitation as every other Redis-backed piece of this codebase).

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setJobProgress } from './scanJobs'

describe('setJobProgress', () => {
  it('never throws when the job does not exist (no REDIS_URL in this sandbox)', async () => {
    await assert.doesNotReject(() =>
      setJobProgress('nonexistent-job-id', { currentModule: 1, totalModules: 11, moduleName: 'holdings' }),
    )
  })

  it('never throws for any module index/name', async () => {
    await assert.doesNotReject(() =>
      setJobProgress('job-1', { currentModule: 11, totalModules: 11, moduleName: 'smartMoneyScore' }),
    )
  })
})
