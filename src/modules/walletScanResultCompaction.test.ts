// An oversized final result must not fail the whole scan: publishFinal retries once with the
// diagnostic audit lists shortened, keeping every other field intact.
//   npx tsx --test src/modules/walletScanResultCompaction.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { kv } from '@/lib/server/kv'
import { walletScanJobKey, walletScanResultKey } from '@/src/modules/walletScanQueue'
import { compactResultDiagnostics, publishFinal, shrinkResultToBudget } from '@/src/modules/walletScanWorker'

const originalEnv = { ...process.env }
const original = { get: kv.get, set: kv.set, setIfAbsent: kv.setIfAbsent }
let store: Map<string, unknown>
let jobSeq = 0

const big = (n: number) => Array.from({ length: n }, (_, i) => i)
const result = () => ({
  success: true,
  data: {
    matchedLots: big(300),
    pnl: { realizedPnlUsd: 12.5, publicPnlGateAudit: { verifiedLotCount: 300, blockingReasons: big(120), nested: { rows: big(80) } } },
    canonicalSampleManifestAudit: { candidateNewEvidenceLotKeys: big(500) },
  },
})

describe('final result publication', () => {
  beforeEach(() => {
    process.env.KV_REST_API_URL = 'https://x.upstash.io'
    process.env.KV_REST_API_TOKEN = 't'
    store = new Map()
    kv.get = async <T = unknown>(key: string | null) => ((key === null ? undefined : store.get(key)) as T | undefined) ?? null
    kv.setIfAbsent = async (key: string, value: unknown) => { if (store.has(key)) return false; store.set(key, value); return true }
  })
  afterEach(() => { process.env = { ...originalEnv }; Object.assign(kv, original) })

  it('compaction shortens only arrays under *audit* keys', () => {
    const compacted = compactResultDiagnostics(result()) as ReturnType<typeof result>
    assert.equal(compacted.data.matchedLots.length, 300, 'non-diagnostic data is untouched')
    assert.equal(compacted.data.pnl.realizedPnlUsd, 12.5)
    assert.equal(compacted.data.pnl.publicPnlGateAudit.verifiedLotCount, 300)
    assert.equal(compacted.data.pnl.publicPnlGateAudit.blockingReasons.length, 50)
    assert.equal(compacted.data.pnl.publicPnlGateAudit.nested.rows.length, 50, 'nested arrays inside an audit are shortened too')
    assert.equal(compacted.data.canonicalSampleManifestAudit.candidateNewEvidenceLotKeys.length, 50)
  })

  it('a rejected result write is retried with the compacted result, and the job still finishes', async () => {
    const JOB = `job-compact-${++jobSeq}`
    let resultWrites = 0
    kv.set = async (key: string, value: unknown) => {
      if (key === walletScanResultKey(JOB)) {
        resultWrites += 1
        if (resultWrites === 1) throw new Error('ERR max request size exceeded')
      }
      store.set(key, value)
      return 'OK'
    }
    const done = { jobId: JOB, status: 'done', finishedAt: Date.now() } as never
    await publishFinal(JOB, done, result())
    assert.equal(resultWrites, 2)
    const stored = store.get(walletScanResultKey(JOB)) as ReturnType<typeof result>
    assert.equal(stored.data.matchedLots.length, 300)
    assert.equal(stored.data.canonicalSampleManifestAudit.candidateNewEvidenceLotKeys.length, 50)
    assert.equal((store.get(walletScanJobKey(JOB)) as { status: string }).status, 'done')
  })

  it('a result still too large after compaction is shrunk under the budget, diagnostics first', () => {
    const row = (i: number) => ({ txHash: `0x${i.toString(16).padStart(64, '0')}`, token: 'abc', usd: i })
    const huge = {
      success: true,
      data: {
        holdings: Array.from({ length: 100 }, (_, i) => row(i)),
        pnl: { realizedPnlUsd: 12.5, publicPnlGateAudit: { verifiedLotCount: 3 } },
        pricingDebug: { rows: Array.from({ length: 40_000 }, (_, i) => row(i)) },
        traceByTx: Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, row(i)])),
      },
    }
    const started = Date.now()
    const shrunk = shrinkResultToBudget(huge, 200_000) as typeof huge & { resultCompaction: { finalBytes: number } }
    assert.ok(Date.now() - started < 5_000, 'shrinking stays fast')
    assert.ok(Buffer.byteLength(JSON.stringify(shrunk)) < 200_000)
    assert.equal(shrunk.data.holdings.length, 100, 'non-diagnostic data is kept while diagnostics can be cut')
    assert.equal(shrunk.data.pnl.realizedPnlUsd, 12.5)
    assert.ok(shrunk.resultCompaction.finalBytes < 200_000)
  })

  it('when the compacted write is also rejected, the size-budgeted result is stored', async () => {
    const JOB = `job-compact-${++jobSeq}`
    let resultWrites = 0
    kv.set = async (key: string, value: unknown) => {
      if (key === walletScanResultKey(JOB)) {
        resultWrites += 1
        if (resultWrites <= 2) throw new Error('ERR max request size exceeded')
      }
      store.set(key, value)
      return 'OK'
    }
    const done = { jobId: JOB, status: 'done', finishedAt: Date.now() } as never
    await publishFinal(JOB, done, result())
    assert.equal(resultWrites, 3)
    assert.ok((store.get(walletScanResultKey(JOB)) as { resultCompaction?: unknown }).resultCompaction)
    assert.equal((store.get(walletScanJobKey(JOB)) as { status: string }).status, 'done')
  })
})
