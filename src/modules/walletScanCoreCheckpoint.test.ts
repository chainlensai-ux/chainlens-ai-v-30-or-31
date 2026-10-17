// A timed-out job's still-running core scan is checkpointed so the PnL follow-up resumes from it
// instead of running the whole pipeline again (and timing out again).
//   npx tsx --test src/modules/walletScanCoreCheckpoint.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { kv } from '@/lib/server/kv'
import {
  markWalletScanCoreCheckpointPending, saveWalletScanCoreCheckpoint, waitForWalletScanCoreCheckpoint,
  walletScanCoreCheckpointKey, walletScanCoreCheckpointPendingKey,
} from '@/src/modules/walletScanCoreCheckpoint'
import { checkpointLateCore } from '@/src/modules/walletScanWorker'
import { attachHeavyWalletFollowUp } from '@/src/modules/heavyWalletFollowUp'
import type { WalletScanJobPayload } from '@/src/modules/walletScanQueue'

const original = { get: kv.get, set: kv.set }
let store: Map<string, unknown>
const core = { status: 200, body: { success: true, data: { scanMetadata: { walletAddress: '0xd40e' }, chainSelection: {} } } }

describe('core-scan checkpoint', () => {
  beforeEach(() => {
    store = new Map()
    kv.get = async <T = unknown>(key: string | null) => ((key === null ? undefined : store.get(key)) as T | undefined) ?? null
    kv.set = async (key: string, value: unknown) => { store.set(key, value); return 'OK' }
  })
  afterEach(() => { Object.assign(kv, original) })

  it('the follow-up waits while the first job says a checkpoint may land, then resumes from it', async () => {
    let t = 1_000
    await markWalletScanCoreCheckpointPending('job-1', 20_000, t)
    let polls = 0
    const got = await waitForWalletScanCoreCheckpoint('job-1', {
      now: () => t,
      sleep: async (ms) => { t += ms; polls += 1; if (polls === 3) await saveWalletScanCoreCheckpoint('job-1', core, t) },
    })
    assert.deepEqual(got, core)
    assert.equal(polls, 3)
  })

  it('no marker, an expired marker, or a cleared one: the follow-up runs the core itself at once', async () => {
    assert.equal(await waitForWalletScanCoreCheckpoint('none', { sleep: async () => assert.fail('must not wait') }), null)
    await markWalletScanCoreCheckpointPending('job-2', 5_000, 0)
    assert.equal(await waitForWalletScanCoreCheckpoint('job-2', { now: () => 9_000, sleep: async () => assert.fail('must not wait') }), null)
  })

  it('a late core that lands in time is saved; one that does not clears the marker', async () => {
    assert.equal(await checkpointLateCore('job-3', Promise.resolve(core), Date.now() + 5_000), 'saved')
    assert.deepEqual((store.get(walletScanCoreCheckpointKey('job-3')) as { result: unknown }).result, core)

    await markWalletScanCoreCheckpointPending('job-4', Date.now() + 60_000)
    assert.equal(await checkpointLateCore('job-4', new Promise(() => {}), Date.now() + 20), 'timed_out')
    assert.deepEqual(store.get(walletScanCoreCheckpointPendingKey('job-4')), { until: 0 })
    assert.equal(await waitForWalletScanCoreCheckpoint('job-4'), null)

    assert.equal(await checkpointLateCore('job-5', Promise.reject(new Error('boom')), Date.now() + 5_000), 'not_saved')
  })

  it('a timed-out job queues a follow-up that resumes from it only when its core may still land', async () => {
    const payload: WalletScanJobPayload = { jobId: 'main', userId: 'u', walletAddress: '0xd40e', chains: ['base'], scanMode: 'deep', ip: '1' }
    const timedOut = { success: false, partial: true, partialSnapshotPublished: true, error: { message: 'worker_global_timeout' } }
    const queued: WalletScanJobPayload[] = []
    await attachHeavyWalletFollowUp(timedOut, payload, async (_id, p) => { queued.push(p) }, () => 'f1', true)
    await attachHeavyWalletFollowUp(timedOut, payload, async (_id, p) => { queued.push(p) }, () => 'f2')
    assert.equal(queued[0].resumeCoreFromJobId, 'main')
    assert.equal(queued[1].resumeCoreFromJobId, undefined)
    assert.ok(queued.every((p) => p.heavyWalletFollowUp === true))
  })
})
