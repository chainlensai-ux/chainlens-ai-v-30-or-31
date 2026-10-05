// Robinhood coordinator generations: a newer Rescan (job B) never adopts an older in-flight scan (job A) as
// its own result. Same-job callers still join one scan; B runs its own scan after A settles and records
// queued -> running -> done with B's body.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  markRobinhoodScanQueued, readRobinhoodScanRecord, runCanonicalRobinhoodScan, resolveRobinhoodRouteRequest,
  getRobinhoodProviderScanCount, __resetRobinhoodScanCoordinatorForTest, type RobinhoodScanResult,
} from '../lib/server/robinhoodScanCoordinator.ts'

delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

let seq = 0
const nextWallet = () => `0x${(0xf9f000 + ++seq).toString(16).padStart(40, '0')}`
const fastSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)))
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))
const quiet = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const w = console.warn
  console.warn = () => {}
  try { return await fn() } finally { console.warn = w }
}

/** Each provider call returns a result stamped with its own generation (1st call = A, 2nd = B, ...). */
function controlledProvider() {
  const calls: Array<{ n: number; release: () => void }> = []
  const scan = async (wallet: string): Promise<RobinhoodScanResult> => {
    const n = calls.length + 1
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    calls.push({ n, release })
    await gate
    return {
      holdings: { status: 'ok', wallet, holdings: [], native: null, portfolioTotalUsd: n * 100, unpricedTokenCount: 0, reason: null },
      activity: { status: 'ok', wallet, items: [], reason: `generation-${n}` },
      pnl: { status: 'disabled', realizedPnlUsd: null, matchedLotsCount: 0, verifiedSwapCount: 0, reason: 'x' },
      audit: { chainId: 4663 },
      pnlVerificationAudit: { chainId: 4663 },
      robinhoodPnl: { status: 'not_verified', exactReason: 'x' },
    } as unknown as RobinhoodScanResult
  }
  return { scan, calls }
}
const gen = (r: { activity: { reason: string | null } } | null | undefined) => r?.activity.reason

beforeEach(() => { __resetRobinhoodScanCoordinatorForTest() })

test('newer Rescan B vs older in-flight A: B waits, runs its own scan, publishes only its own result', async () => {
  const wallet = nextWallet()
  const p = controlledProvider()
  const tA = Date.now()

  // 1. A queued and running.
  await quiet(() => markRobinhoodScanQueued(wallet, 'job-A', tA))
  const aP = quiet(() => runCanonicalRobinhoodScan(wallet, fetch, { jobId: 'job-A', owner: 'worker', scan: p.scan }))
  await tick()
  assert.equal(p.calls.length, 1)
  assert.equal((await readRobinhoodScanRecord(wallet))?.state, 'running')

  // B queued (supersedes A's live record as a newer generation); B's worker starts before A finishes.
  await quiet(() => markRobinhoodScanQueued(wallet, 'job-B', tA + 1_000))
  assert.deepEqual([(await readRobinhoodScanRecord(wallet))?.jobId, (await readRobinhoodScanRecord(wallet))?.state], ['job-B', 'queued'])
  const bP = quiet(() => runCanonicalRobinhoodScan(wallet, fetch, { jobId: 'job-B', owner: 'worker', scan: p.scan }))
  // 5. A second same-job caller for B joins B's scan (no third provider call).
  const b2P = quiet(() => runCanonicalRobinhoodScan(wallet, fetch, { jobId: 'job-B', owner: 'worker', scan: p.scan }))
  // 6. B's job-backed GET, issued while A is still in flight.
  const routeB = quiet(() => resolveRobinhoodRouteRequest(wallet, fetch, { jobId: 'job-B', scan: p.scan, sleep: fastSleep, waitMs: 2_000 }))
  await tick()
  assert.equal(p.calls.length, 1, 'B does not start while A is in flight, and does not adopt A either')

  // A finishes.
  p.calls[0].release()
  const a = await aP
  assert.equal(gen(a), 'generation-1')
  await tick()
  // 3. A's late done could not overwrite B; 4. B is now running its own scan.
  const mid = await readRobinhoodScanRecord(wallet)
  assert.equal(mid?.jobId, 'job-B')
  assert.equal(mid?.state, 'running')
  assert.equal(p.calls.length, 2, 'B started its own provider scan after A settled')

  p.calls[1].release()
  const [b, b2, route] = await Promise.all([bP, b2P, routeB])
  // 2. B never publishes A as its own result.
  assert.equal(gen(b), 'generation-2')
  assert.equal(gen(b2), 'generation-2')
  // 4. B: queued -> running -> done, with B's own body.
  const fin = await readRobinhoodScanRecord(wallet)
  assert.deepEqual([fin?.jobId, fin?.state], ['job-B', 'done'])
  assert.equal(gen(fin?.body), 'generation-2')
  assert.equal(fin?.queuedAt, tA + 1_000, 'B keeps its own generation')
  // 6. B's job-backed GET got B's result, never A's.
  assert.equal(route.status, 200)
  assert.equal(gen(route.status === 200 ? route.body : null), 'generation-2')
  // 7. exactly one provider scan per generation.
  assert.equal(p.calls.length, 2)
  assert.equal(getRobinhoodProviderScanCount(), 2)
})

test('5. same-job concurrent callers join a single provider scan', async () => {
  const wallet = nextWallet()
  const p = controlledProvider()
  await quiet(() => markRobinhoodScanQueued(wallet, 'job-S'))
  const all = Promise.all([1, 2, 3].map(() => quiet(() => runCanonicalRobinhoodScan(wallet, fetch, { jobId: 'job-S', owner: 'worker', scan: p.scan }))))
  await tick()
  assert.equal(p.calls.length, 1)
  p.calls[0].release()
  const results = await all
  assert.deepEqual(results.map(gen), ['generation-1', 'generation-1', 'generation-1'])
  assert.equal(getRobinhoodProviderScanCount(), 1)
  assert.equal((await readRobinhoodScanRecord(wallet))?.state, 'done')
})

test('a job-backed GET for B never joins A\'s in-flight scan (pending until B has its own result)', async () => {
  const wallet = nextWallet()
  const p = controlledProvider()
  await quiet(() => markRobinhoodScanQueued(wallet, 'job-A2', Date.now()))
  const aP = quiet(() => runCanonicalRobinhoodScan(wallet, fetch, { jobId: 'job-A2', owner: 'worker', scan: p.scan }))
  await tick()
  await quiet(() => markRobinhoodScanQueued(wallet, 'job-B2', Date.now() + 1_000))
  const routeP = quiet(() => resolveRobinhoodRouteRequest(wallet, fetch, { jobId: 'job-B2', scan: p.scan, sleep: fastSleep, waitMs: 40 }))
  p.calls[0].release()
  await aP
  const route = await routeP
  assert.equal(route.status, 202, 'A finished, but B has no result yet: pending, never A\'s body')
  assert.equal(p.calls.length, 1, 'the GET started nothing')
})
