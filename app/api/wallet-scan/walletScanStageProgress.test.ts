// TESTS — Wallet Scanner perceived-speed follow-up task: real, backend-reported stage progress
// surfaced through the SAME live poll route the frontend actually calls
// (app/api/wallet-scan/[jobId]/route.ts), not the disconnected src/modules/scanJobs.ts namespace
// workers/walletScanV2.ts's own reportProgress()/setJobProgress() writes to (confirmed: the poll
// route never reads that key at all — see this file's own header disclosures in
// src/modules/walletScanQueue.ts and app/terminal/wallet-scanner/page.tsx for the full trail).
//
// Run with:
//   npx tsx --test app/api/wallet-scan/walletScanStageProgress.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { kv } from '@/lib/server/kv'
import { walletScanJobKey, updateWalletScanJobProgress, type WalletScanJobMetadata } from '@/src/modules/walletScanQueue'
import { publishFinal } from '@/src/modules/walletScanWorker'

const originalEnv = { ...process.env }
const originalGet = kv.get
const originalSet = kv.set

type Stored = { value: unknown; opts?: { ex?: number } }

function restore(): void {
  process.env = { ...originalEnv }
  kv.get = originalGet
  kv.set = originalSet
}

function configureRestEnv(): void {
  process.env.KV_REST_API_URL = 'https://settled-iad1-example.upstash.io'
  process.env.KV_REST_API_TOKEN = 'test-token'
}

function installMemoryKv(): Map<string, Stored> {
  const store = new Map<string, Stored>()
  kv.get = async <T = unknown>(key: string | null): Promise<T | null> => ((key === null ? undefined : store.get(key)?.value) as T | undefined) ?? null
  kv.set = async (key: string, value: unknown, opts?: { ex?: number }): Promise<unknown> => { store.set(key, { value, opts }); return 'OK' }
  return store
}

async function poll(jobId: string): Promise<{ status: number; body: unknown }> {
  const { GET } = await import('./[jobId]/route.ts')
  const res = await GET(new Request(`http://localhost/api/wallet-scan/${encodeURIComponent(jobId)}`), { params: Promise.resolve({ jobId }) })
  return { status: res.status, body: await res.json() }
}

function runningJob(overrides: Partial<WalletScanJobMetadata> = {}): WalletScanJobMetadata {
  return { jobId: 'job-progress', wallet: '0xabc', status: 'running', createdAt: 1, updatedAt: 1, ...overrides }
}

describe('updateWalletScanJobProgress — real stage checkpoints, wired to the live poll route', () => {
  beforeEach(() => {
    restore()
    configureRestEnv()
  })
  afterEach(restore)

  it('HARD ASSERTION (required regression): a stage update reaches the poll response while the job is still running', async () => {
    const store = installMemoryKv()
    store.set(walletScanJobKey('job-progress'), { value: runningJob() })

    await updateWalletScanJobProgress('job-progress', { stage: 'portfolio', label: 'Loading portfolio...', elapsedMs: 1234 })
    const response = await poll('job-progress')

    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { status: 'running', progress: { stage: 'portfolio', label: 'Loading portfolio...', elapsedMs: 1234 } })
  })

  it('a later stage update overwrites the earlier one — the poll route always shows the MOST RECENT real checkpoint', async () => {
    const store = installMemoryKv()
    store.set(walletScanJobKey('job-progress'), { value: runningJob() })

    await updateWalletScanJobProgress('job-progress', { stage: 'holdings', label: 'Loading holdings...', elapsedMs: 100 })
    await updateWalletScanJobProgress('job-progress', { stage: 'portfolio', label: 'Loading portfolio...', elapsedMs: 500 })
    const response = await poll('job-progress')

    assert.deepEqual((response.body as { progress: unknown }).progress, { stage: 'portfolio', label: 'Loading portfolio...', elapsedMs: 500 })
  })

  it('never clobbers the rest of the job record — status/wallet/chains survive a progress update untouched', async () => {
    const store = installMemoryKv()
    store.set(walletScanJobKey('job-progress'), { value: runningJob({ chains: ['base', 'eth'], scanMode: 'deep' }) })

    await updateWalletScanJobProgress('job-progress', { stage: 'activity', label: 'Checking activity...', elapsedMs: 900 })

    const stored = store.get(walletScanJobKey('job-progress'))?.value as WalletScanJobMetadata
    assert.equal(stored.status, 'running')
    assert.equal(stored.wallet, '0xabc')
    assert.deepEqual(stored.chains, ['base', 'eth'])
    assert.equal(stored.scanMode, 'deep')
  })

  it('HARD ASSERTION (required regression): progress never leaks into the response once the scan is done — publishFinal overwrites the whole record', async () => {
    const store = installMemoryKv()
    store.set(walletScanJobKey('job-progress'), { value: runningJob() })
    await updateWalletScanJobProgress('job-progress', { stage: 'smartMoney', label: 'Building Smart Money...', elapsedMs: 9000 })

    await publishFinal('job-progress', { status: 'done', startedAt: 1, finishedAt: 2, durationMs: 1, pipelineDiagnostics: null }, { success: true, data: {} })
    const response = await poll('job-progress')

    assert.equal(response.status, 200)
    assert.ok(!('progress' in (response.body as Record<string, unknown>)), 'a finished scan must never show a stale in-progress stage label')
  })

  it('a missing job record is a silent no-op — never throws, never creates a phantom job', async () => {
    const store = installMemoryKv()
    await assert.doesNotReject(() => updateWalletScanJobProgress('job-does-not-exist', { stage: 'holdings', label: 'Loading holdings...', elapsedMs: 1 }))
    assert.equal(store.has(walletScanJobKey('job-does-not-exist')), false)
  })

  it('KV unconfigured is a silent no-op — never throws', async () => {
    process.env.KV_REST_API_URL = ''
    process.env.KV_REST_API_TOKEN = ''
    await assert.doesNotReject(() => updateWalletScanJobProgress('job-progress', { stage: 'holdings', label: 'Loading holdings...', elapsedMs: 1 }))
  })

  it('a queued job (not yet running) can also carry a real stage update', async () => {
    const store = installMemoryKv()
    store.set(walletScanJobKey('job-progress'), { value: runningJob({ status: 'queued' }) })

    await updateWalletScanJobProgress('job-progress', { stage: 'core', label: 'Replaying verified PnL...', elapsedMs: 50 })
    const response = await poll('job-progress')

    assert.deepEqual(response.body, { status: 'queued', progress: { stage: 'core', label: 'Replaying verified PnL...', elapsedMs: 50 } })
  })
})
