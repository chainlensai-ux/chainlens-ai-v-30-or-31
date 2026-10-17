// Heartbeat/progress live on their own key and never rewrite the job record: a heartbeat racing a
// newer partial snapshot, the watchdog or finalization can neither drop the snapshot nor revert a
// terminal job. Races are driven by a gate that parks the heartbeat's write mid-flight.
//   npx tsx --test src/modules/walletScanLiveness.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { kv } from '@/lib/server/kv'
import {
  heartbeatWalletScanJob, markWalletScanJobStalled, mergeWalletScanJobLive, publishWalletScanPartialSnapshot,
  updateWalletScanJobProgress, walletScanJobKey, walletScanJobLiveKey, walletScanResultKey,
  type WalletScanJobMetadata, type WalletScanPartialSnapshot,
} from '@/src/modules/walletScanQueue'
import { publishFinal } from '@/src/modules/walletScanWorker'
import { GET as pollJob } from '@/app/api/wallet-scan/[jobId]/route'
import { clearWalletScanTestAuth, installWalletScanTestAuth, walletScanTestAuthHeaders } from '@/app/api/wallet-scan/walletScanTestAuth'

const originalEnv = { ...process.env }
const original = { get: kv.get, set: kv.set, setIfAbsent: kv.setIfAbsent }
let store: Map<string, unknown>
// One-shot gate: the next kv.set is parked until released; `reached` resolves once it is parked.
function armGate() {
  let markReached!: () => void
  let release!: () => void
  const reached = new Promise<void>((resolve) => { markReached = resolve })
  const released = new Promise<void>((resolve) => { release = resolve })
  return { reached, release, released, markReached }
}
let pendingGate: ReturnType<typeof armGate> | null
function memoryKv() {
  store = new Map()
  pendingGate = null
  kv.get = async <T = unknown>(key: string | null) => ((key === null ? undefined : store.get(key)) as T | undefined) ?? null
  kv.set = async (key: string, value: unknown) => {
    const g = pendingGate
    if (g) { pendingGate = null; g.markReached(); await g.released }
    store.set(key, value)
    return 'OK'
  }
  kv.setIfAbsent = async (key: string, value: unknown) => { if (store.has(key)) return false; store.set(key, value); return true }
}
function parkNextWrite() { pendingGate = armGate(); return pendingGate }

// A fresh id per test: finalization is remembered per job id for the life of the process.
let jobSeq = 0
let JOB = 'job-live-0'
const running = (over: Partial<WalletScanJobMetadata> = {}): WalletScanJobMetadata => ({
  jobId: JOB, userId: 'user-a', wallet: '0xd40e93db1160cd9a6bef2f9fd8e81b9beddeb811', status: 'running',
  createdAt: Date.now() - 30_000, updatedAt: Date.now() - 30_000, claimedAt: Date.now() - 30_000, heartbeatAt: Date.now() - 30_000, scanMode: 'deep', ...over,
})
const snapshot = (publishedAtElapsedMs: number) => ({ publishedAtElapsedMs, totalValueUsd: 30_420.53 }) as unknown as WalletScanPartialSnapshot
const record = () => store.get(walletScanJobKey(JOB)) as WalletScanJobMetadata

describe('worker liveness never rewrites the job record', () => {
  beforeEach(() => { process.env.KV_REST_API_URL = 'https://x.upstash.io'; process.env.KV_REST_API_TOKEN = 't'; memoryKv(); JOB = `job-live-${++jobSeq}` })
  afterEach(() => { process.env = { ...originalEnv }; Object.assign(kv, original) })

  it('(5) a heartbeat in flight while a newer partial snapshot lands does not drop the snapshot', async () => {
    store.set(walletScanJobKey(JOB), running())
    const g = parkNextWrite()
    const beat = heartbeatWalletScanJob(JOB)
    await g.reached // the heartbeat's write is mid-flight
    await publishWalletScanPartialSnapshot(JOB, snapshot(2_700))
    g.release()
    await beat
    assert.deepEqual(record().partial, snapshot(2_700), 'snapshot preserved')
    assert.equal(record().status, 'running')
    assert.equal(typeof (store.get(walletScanJobLiveKey(JOB)) as { heartbeatAt: number }).heartbeatAt, 'number')
  })

  it('(6a) a heartbeat in flight while the watchdog marks the job failed cannot revert it to running', async () => {
    store.set(walletScanJobKey(JOB), running())
    const g = parkNextWrite()
    const beat = heartbeatWalletScanJob(JOB)
    await g.reached
    await markWalletScanJobStalled(running(), 'worker_stalled')
    g.release()
    await beat
    assert.equal(record().status, 'failed')
  })

  it('(6b) a heartbeat in flight during finalization cannot overwrite the final result', async () => {
    installWalletScanTestAuth('user-a')
    try {
      store.set(walletScanJobKey(JOB), running({ partial: snapshot(2_700) }))
      await updateWalletScanJobProgress(JOB, { stage: 'pnl', label: 'Computing PnL', elapsedMs: 40_000 } as never)
      const g = parkNextWrite()
      const beat = heartbeatWalletScanJob(JOB)
      await g.reached
      const final = publishFinal(JOB, { ...running(), status: 'done', finishedAt: Date.now() } as never, { success: true, data: { totalValueUsd: 31_000 } })
      g.release()
      await Promise.all([beat, final])
      assert.equal(record().status, 'done')
      assert.deepEqual(store.get(walletScanResultKey(JOB)), { success: true, data: { totalValueUsd: 31_000 } })
      // After finalization, further heartbeats/progress are refused outright.
      const liveBefore = store.get(walletScanJobLiveKey(JOB))
      await heartbeatWalletScanJob(JOB)
      await updateWalletScanJobProgress(JOB, { stage: 'late', label: 'late', elapsedMs: 1 } as never)
      assert.deepEqual(store.get(walletScanJobLiveKey(JOB)), liveBefore)
      // Even a fresh live key (a late writer anywhere) never changes what a poll of a finished job returns.
      store.set(walletScanJobLiveKey(JOB), { heartbeatAt: Date.now(), progress: { stage: 'late' } })
      const res = await pollJob(new Request(`http://localhost/api/wallet-scan/${JOB}`, { headers: walletScanTestAuthHeaders }), { params: Promise.resolve({ jobId: JOB }) })
      assert.deepEqual(await res.json(), { status: 'done', result: { success: true, data: { totalValueUsd: 31_000 } } })
    } finally {
      clearWalletScanTestAuth()
    }
  })

  it('the poll route reports the live heartbeat and progress alongside the snapshot', async () => {
    installWalletScanTestAuth('user-a')
    try {
      store.set(walletScanJobKey(JOB), running({ partial: snapshot(2_700) }))
      await updateWalletScanJobProgress(JOB, { stage: 'pricing', label: 'Pricing holdings', elapsedMs: 20_000 } as never)
      const res = await pollJob(new Request(`http://localhost/api/wallet-scan/${JOB}`, { headers: walletScanTestAuthHeaders }), { params: Promise.resolve({ jobId: JOB }) })
      const body = await res.json() as { status: string; progress?: { stage: string }; partial?: unknown; heartbeatAt?: number; serverNow?: number }
      assert.equal(body.status, 'running')
      assert.equal(body.progress?.stage, 'pricing')
      assert.deepEqual(body.partial, snapshot(2_700))
      assert.ok((body.serverNow ?? 0) - (body.heartbeatAt ?? 0) < 5_000, 'fresh heartbeat from the live key')
    } finally {
      clearWalletScanTestAuth()
    }
  })

  it('mergeWalletScanJobLive ignores the live key once the job is terminal', () => {
    const live = { heartbeatAt: 9_999_999, progress: { stage: 'x' } as never }
    assert.deepEqual(mergeWalletScanJobLive({ status: 'done', heartbeatAt: 1 }, live), { status: 'done', heartbeatAt: 1 })
    assert.equal(mergeWalletScanJobLive({ status: 'running', heartbeatAt: 1 }, live).heartbeatAt, 9_999_999)
    assert.equal(mergeWalletScanJobLive({ status: 'running', heartbeatAt: 10_000_000 }, live).heartbeatAt, 10_000_000, 'never moves backwards')
  })
})
