// Robinhood scan coordinator: record transitions are monotonic (queued → running → done | error), and a late
// queued marker can never overwrite newer state. POST writes the marker before enqueueing the job.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  markRobinhoodScanQueued, markRobinhoodScanEnqueueFailed, readRobinhoodScanRecord, runCanonicalRobinhoodScan,
  resolveRobinhoodRouteRequest, transitionRobinhoodScanRecord, decideRobinhoodScanTransition, buildRobinhoodRouteBody,
  getRobinhoodProviderScanCount, __resetRobinhoodScanCoordinatorForTest, type RobinhoodScanRecord, type RobinhoodScanResult,
} from '../lib/server/robinhoodScanCoordinator.ts'

delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

let seq = 0
const nextWallet = () => `0x${(0xe1e000 + ++seq).toString(16).padStart(40, '0')}`
const fastSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)))
const quiet = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const w = console.warn
  console.warn = () => {}
  try { return await fn() } finally { console.warn = w }
}
function fixture(wallet: string): RobinhoodScanResult {
  return {
    holdings: { status: 'partial', wallet, holdings: [], native: null, portfolioTotalUsd: 1, unpricedTokenCount: 0, reason: null },
    activity: { status: 'partial', wallet, items: [], reason: null },
    pnl: { status: 'disabled', realizedPnlUsd: null, matchedLotsCount: 0, verifiedSwapCount: 0, reason: 'x' },
    audit: { chainId: 4663 },
    pnlVerificationAudit: { chainId: 4663 },
    robinhoodPnl: { status: 'not_verified', exactReason: 'x' },
  } as unknown as RobinhoodScanResult
}
const rec = (wallet: string, state: RobinhoodScanRecord['state'], jobId: string | null, queuedAt: number, extra: Partial<RobinhoodScanRecord> = {}): RobinhoodScanRecord =>
  ({ v: 1, wallet: wallet.toLowerCase(), state, jobId, owner: 'worker', queuedAt, startedAt: state === 'queued' ? null : queuedAt, completedAt: state === 'done' || state === 'error' ? queuedAt : null, body: null, error: null, ...extra })

beforeEach(() => { __resetRobinhoodScanCoordinatorForTest() })

test('1. normal queued -> running -> done', async () => {
  const wallet = nextWallet()
  const t0 = Date.now()
  assert.equal((await quiet(() => markRobinhoodScanQueued(wallet, 'job-1', t0))).applied, true)
  assert.equal((await readRobinhoodScanRecord(wallet))?.state, 'queued')
  const result = await quiet(() => runCanonicalRobinhoodScan(wallet, fetch, { jobId: 'job-1', owner: 'worker', scan: async (w) => fixture(w) }))
  const r = await readRobinhoodScanRecord(wallet)
  assert.equal(r?.state, 'done')
  assert.equal(r?.jobId, 'job-1')
  assert.equal(r?.queuedAt, t0, 'the job keeps its own generation from its queued marker')
  assert.deepEqual(r?.body, buildRobinhoodRouteBody(wallet, result))
})

test('2. worker already wrote running -> a late queued marker leaves it running', async () => {
  const wallet = nextWallet()
  const t0 = Date.now()
  await transitionRobinhoodScanRecord(rec(wallet, 'running', 'job-2', t0), t0)
  const t = await quiet(() => markRobinhoodScanQueued(wallet, 'job-2', t0 + 5))
  assert.deepEqual([t.applied, t.reason], [false, 'would_regress_or_repeat'])
  assert.equal((await readRobinhoodScanRecord(wallet))?.state, 'running')
})

test('3. worker already wrote done -> a late queued marker leaves it done with its body', async () => {
  const wallet = nextWallet()
  const t0 = Date.now()
  const body = buildRobinhoodRouteBody(wallet, fixture(wallet))
  await transitionRobinhoodScanRecord(rec(wallet, 'done', 'job-3', t0, { body }), t0)
  const t = await quiet(() => markRobinhoodScanQueued(wallet, 'job-3', t0 + 5))
  assert.equal(t.applied, false)
  const r = await readRobinhoodScanRecord(wallet)
  assert.equal(r?.state, 'done')
  assert.deepEqual(r?.body, body)
})

test('4. a late OLD-job queued marker cannot overwrite a newer job (queued, running or done)', async () => {
  for (const state of ['queued', 'running', 'done'] as const) {
    const wallet = nextWallet()
    const tOld = Date.now()
    const tNew = tOld + 1_000
    await transitionRobinhoodScanRecord(rec(wallet, state, 'job-new', tNew, state === 'done' ? { body: buildRobinhoodRouteBody(wallet, fixture(wallet)) } : {}), tNew)
    const t = await quiet(() => markRobinhoodScanQueued(wallet, 'job-old', tOld))
    assert.equal(t.applied, false, state)
    const r = await readRobinhoodScanRecord(wallet)
    assert.deepEqual([r?.jobId, r?.state], ['job-new', state])
  }
  // ...while a genuinely newer Rescan's marker does supersede an older job.
  const wallet = nextWallet()
  const t0 = Date.now()
  await transitionRobinhoodScanRecord(rec(wallet, 'running', 'job-a', t0), t0)
  assert.equal((await quiet(() => markRobinhoodScanQueued(wallet, 'job-b', t0 + 10))).applied, true)
  // and job A's own late running/done write cannot clobber job B's live marker.
  assert.equal((await quiet(() => transitionRobinhoodScanRecord(rec(wallet, 'done', 'job-a', t0 + 20), t0 + 20))).applied, false)
  assert.equal((await readRobinhoodScanRecord(wallet))?.jobId, 'job-b')
})

test('5. error cannot regress to queued; a failed enqueue closes its marker (queued -> error)', async () => {
  const wallet = nextWallet()
  const t0 = Date.now()
  await quiet(() => markRobinhoodScanQueued(wallet, 'job-5', t0))
  assert.equal((await quiet(() => markRobinhoodScanEnqueueFailed(wallet, 'job-5', t0))).applied, true)
  assert.deepEqual([(await readRobinhoodScanRecord(wallet))?.state, (await readRobinhoodScanRecord(wallet))?.error], ['error', 'enqueue_failed'])
  const t = await quiet(() => markRobinhoodScanQueued(wallet, 'job-5', t0 + 5))
  assert.equal(t.applied, false)
  assert.equal((await readRobinhoodScanRecord(wallet))?.state, 'error')
  assert.equal(decideRobinhoodScanTransition(rec(wallet, 'error', 'j', 1), rec(wallet, 'running', 'j', 1), 2).applied, false)
  assert.equal(decideRobinhoodScanTransition(rec(wallet, 'done', 'j', 1), rec(wallet, 'error', 'j', 1), 2).applied, false)
})

test('6. a job-backed GET still never starts provider work', async () => {
  const wallet = nextWallet()
  let calls = 0
  const scan = async (w: string) => { calls += 1; return fixture(w) }
  await quiet(() => markRobinhoodScanQueued(wallet, 'job-6'))
  const out = await quiet(() => resolveRobinhoodRouteRequest(wallet, fetch, { jobId: 'job-6', scan, sleep: fastSleep, waitMs: 30 }))
  assert.equal(out.status, 202)
  assert.equal(calls, 0)
})

test('7. one normal user scan (marker before enqueue, worker, concurrent job-backed GET) -> one provider scan', async () => {
  const wallet = nextWallet()
  let calls = 0
  const scan = async (w: string) => { calls += 1; await new Promise((r) => setTimeout(r, 30)); return fixture(w) }
  await quiet(() => markRobinhoodScanQueued(wallet, 'job-7'))
  const [, route] = await quiet(() => Promise.all([
    runCanonicalRobinhoodScan(wallet, fetch, { jobId: 'job-7', owner: 'worker', scan }),
    resolveRobinhoodRouteRequest(wallet, fetch, { jobId: 'job-7', scan, sleep: fastSleep }),
  ]))
  assert.equal(calls, 1)
  assert.equal(getRobinhoodProviderScanCount(), 1)
  assert.equal(route.status, 200)
  assert.equal((await readRobinhoodScanRecord(wallet))?.state, 'done')
})

test('POST writes the queued marker before enqueueing, and closes it if enqueue fails', () => {
  const post = readFileSync(new URL('../app/api/wallet-scan/route.ts', import.meta.url), 'utf8')
  const mark = post.indexOf('await markRobinhoodScanQueued(wallet, jobId, robinhoodQueuedAt)')
  const enqueue = post.indexOf('await enqueueWalletScanJob(jobId,')
  assert.ok(mark > 0 && enqueue > 0 && mark < enqueue, 'marker precedes enqueue')
  assert.match(post, /catch \(err\) \{[\s\S]{0,200}markRobinhoodScanEnqueueFailed\(wallet, jobId, robinhoodQueuedAt\)/)
})
