import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { kv } from '@/lib/server/kv'
import { walletScanJobKey, walletScanResultKey } from '@/src/modules/walletScanQueue'
import { publishFinal, verifyWalletScanKvConnection, toSerializableResult } from '@/src/modules/walletScanWorker'

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


function doneState() {
  return { status: 'done' as const, startedAt: 1, finishedAt: 3, durationMs: 2, pipelineDiagnostics: null }
}

async function publishFinalResultForTest(jobId: string, result: unknown): Promise<void> {
  await publishFinal(jobId, doneState(), result)
}

async function poll(jobId: string): Promise<{ status: number; body: unknown }> {
  const { GET } = await import('./[jobId]/route.ts')
  const res = await GET(new Request(`http://localhost/api/wallet-scan/${encodeURIComponent(jobId)}`), { params: Promise.resolve({ jobId }) })
  return { status: res.status, body: await res.json() }
}

describe('wallet-scan final publish and poll key alignment', () => {
  beforeEach(() => {
    restore()
    configureRestEnv()
  })

  afterEach(restore)


  it('worker KV verification writes and reads walletScanTestKey', async () => {
    const store = installMemoryKv()

    await verifyWalletScanKvConnection()

    assert.deepEqual(store.get('walletScanTestKey'), { value: 'ok', opts: undefined })
  })

  it('publish → poll returns the full successful result', async () => {
    installMemoryKv()
    const result = { success: true, data: { wallet: '0x1', pnl: { realized: 42 } } }

    await publishFinalResultForTest('job-full', result)
    const response = await poll('job-full')

    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { status: 'done', result })
  })

  it('publish → poll stays running when the result key is missing', async () => {
    const store = installMemoryKv()
    await publishFinalResultForTest('job-missing-result', { success: true })
    store.delete(walletScanResultKey('job-missing-result'))

    const response = await poll('job-missing-result')

    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { status: 'done' })
  })

  it('poll uses the exact jobId formatting written by final publish', async () => {
    const store = installMemoryKv()
    const jobId = 'wallet:scan/job 1'

    await publishFinalResultForTest(jobId, { success: true })
    await poll(jobId)

    assert.equal(store.has(walletScanJobKey(jobId)), true)
    assert.equal(store.has(walletScanResultKey(jobId)), true)
  })

  it('poll uses the same key prefixes as final publish', async () => {
    const store = installMemoryKv()
    await publishFinalResultForTest('job-prefix', { success: true })
    await poll('job-prefix')

    assert.deepEqual([...store.keys()].sort(), ['walletScanJob:job-prefix', 'walletScanResult:job-prefix'])
  })

  it('poll returns the full result when both final keys exist', async () => {
    installMemoryKv()
    const result = { success: true, report: { sections: ['holdings', 'pnl', 'behavior'] } }

    await publishFinalResultForTest('job-both-keys', result)
    const response = await poll('job-both-keys')

    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { status: 'done', result })
  })

  it('final publish writes the RESULT key before marking the job done (a poll can never observe done-without-result mid-publish)', async () => {
    installMemoryKv()
    const writeOrder: string[] = []
    const innerSet = kv.set
    kv.set = async (key: string, value: unknown, opts?: { ex?: number }): Promise<unknown> => {
      writeOrder.push(key)
      return innerSet(key, value, opts)
    }

    await publishFinalResultForTest('job-order', { success: true })

    assert.deepEqual(writeOrder, [walletScanResultKey('job-order'), walletScanJobKey('job-order')],
      'expected the result write to happen strictly before the job-done write')
  })

  it('a failed result write leaves the job key untouched — never marked done with a missing result', async () => {
    const store = installMemoryKv()
    const innerSet = kv.set
    kv.set = async (key: string, value: unknown, opts?: { ex?: number }): Promise<unknown> => {
      if (key === walletScanResultKey('job-pubfail')) throw new Error('kv write failed')
      return innerSet(key, value, opts)
    }

    await assert.rejects(() => publishFinalResultForTest('job-pubfail', { success: true }), /kv write failed/)
    assert.equal(store.has(walletScanJobKey('job-pubfail')), false,
      'a failed result write must not have marked the job done')
    const response = await poll('job-pubfail')
    assert.equal(response.status, 404)
    assert.deepEqual(response.body, { status: 'not-found' })
  })

  it('poll surfaces the safe stage error code for a failed job', async () => {
    const store = installMemoryKv()
    store.set(walletScanJobKey('job-failed'), { value: { status: 'failed', error: 'worker_result_publish_failed' } })

    const response = await poll('job-failed')

    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { status: 'failed', error: 'worker_result_publish_failed' })
  })
})

describe('wallet-scan result serialization guard', () => {
  it('converts BigInt to decimal strings and non-finite numbers to null; JSON-safe values pass through identically', () => {
    const raw = {
      blockNumber: BigInt('123456789012345678901234567890'),
      pnl: { realized: 42.5, broken: Number.NaN, alsoBroken: Infinity, negBroken: -Infinity },
      list: [1, 'two', null, true],
    }
    assert.deepEqual(toSerializableResult(raw), {
      blockNumber: '123456789012345678901234567890',
      pnl: { realized: 42.5, broken: null, alsoBroken: null, negBroken: null },
      list: [1, 'two', null, true],
    })
  })

  it('an undefined result becomes null, never the string "undefined"', () => {
    assert.equal(toSerializableResult(undefined), null)
  })

  it('a circular result throws (caught by the worker publish-failure path) rather than publishing corrupted data', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    assert.throws(() => toSerializableResult(circular))
  })
})
