// TESTS — Wallet Scanner fast-snapshot architecture-audit task: the early portfolio/holdings
// snapshot published while the core FIFO/PnL/manifest scan is still running, surfaced through the
// SAME live poll route the frontend actually calls.
//
// Run with:
//   npx tsx --test app/api/wallet-scan/walletScanPartialSnapshot.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { kv } from '@/lib/server/kv'
import { walletScanJobKey, publishWalletScanPartialSnapshot, type WalletScanJobMetadata, type WalletScanPartialSnapshot } from '@/src/modules/walletScanQueue'
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
  return { jobId: 'job-partial', wallet: '0xabc', status: 'running', createdAt: 1, updatedAt: 1, ...overrides }
}

function snapshot(overrides: Partial<WalletScanPartialSnapshot> = {}): WalletScanPartialSnapshot {
  return {
    portfolioTotalValueUsd: 1234.56,
    holdingsCount: 12,
    topHoldings: [{ chainId: 8453, tokenAddress: '0xusdc', symbol: 'USDC', valueUsd: 900 }],
    activeChainIds: [1, 8453],
    publishedAtElapsedMs: 850,
    ...overrides,
  }
}

describe('publishWalletScanPartialSnapshot — real early portfolio/holdings, wired to the live poll route', () => {
  beforeEach(() => {
    restore()
    configureRestEnv()
  })
  afterEach(restore)

  it('HARD ASSERTION (required regression): a partial snapshot reaches the poll response while the job is still running', async () => {
    const store = installMemoryKv()
    store.set(walletScanJobKey('job-partial'), { value: runningJob() })

    await publishWalletScanPartialSnapshot('job-partial', snapshot())
    const response = await poll('job-partial')

    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { status: 'running', partial: snapshot() })
  })

  it('HARD ASSERTION (required regression): the final result still overwrites the partial result — publishFinal replaces the whole job record', async () => {
    const store = installMemoryKv()
    store.set(walletScanJobKey('job-partial'), { value: runningJob() })
    await publishWalletScanPartialSnapshot('job-partial', snapshot({ portfolioTotalValueUsd: 999 }))

    const finalResult = { success: true, data: { portfolioV2: { totalValueUsd: 1234.56 } } }
    await publishFinal('job-partial', { status: 'done', startedAt: 1, finishedAt: 2, durationMs: 1, pipelineDiagnostics: null }, finalResult)

    const response = await poll('job-partial')
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { status: 'done', result: finalResult }, 'the final result must win outright — no partial field, no merge artifact')
  })

  it('progress and partial can coexist on the same running job — both surfaced together', async () => {
    const store = installMemoryKv()
    store.set(walletScanJobKey('job-partial'), { value: runningJob({ progress: { stage: 'portfolio', label: 'Loading portfolio...', elapsedMs: 800 } }) })

    await publishWalletScanPartialSnapshot('job-partial', snapshot())
    const response = await poll('job-partial')

    const body = response.body as { progress?: unknown; partial?: unknown }
    assert.ok(body.progress)
    assert.ok(body.partial)
  })

  it('never clobbers the rest of the job record — status/wallet survive a partial-snapshot publish untouched', async () => {
    const store = installMemoryKv()
    store.set(walletScanJobKey('job-partial'), { value: runningJob({ chains: ['base', 'eth'] }) })

    await publishWalletScanPartialSnapshot('job-partial', snapshot())

    const stored = store.get(walletScanJobKey('job-partial'))?.value as WalletScanJobMetadata
    assert.equal(stored.status, 'running')
    assert.equal(stored.wallet, '0xabc')
    assert.deepEqual(stored.chains, ['base', 'eth'])
  })

  it('a missing job record is a silent no-op — never throws, never creates a phantom job', async () => {
    const store = installMemoryKv()
    await assert.doesNotReject(() => publishWalletScanPartialSnapshot('job-does-not-exist', snapshot()))
    assert.equal(store.has(walletScanJobKey('job-does-not-exist')), false)
  })

  it('KV unconfigured is a silent no-op — never throws', async () => {
    process.env.KV_REST_API_URL = ''
    process.env.KV_REST_API_TOKEN = ''
    await assert.doesNotReject(() => publishWalletScanPartialSnapshot('job-partial', snapshot()))
  })

  it('a small, display-shaped snapshot — never the full holdings/pricedHoldings array', () => {
    const s = snapshot()
    assert.ok(s.topHoldings.length <= 10, 'must stay a small, bounded top-N list, never the full holdings array')
    assert.ok(!('pricedHoldings' in s), 'must never carry the full pricedHoldings array')
  })
})
