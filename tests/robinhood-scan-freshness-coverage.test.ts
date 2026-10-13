// Robinhood Wallet Scanner freshness, dedup and completeness (wallet 0x7895… report: a request was answered from
// an older canonical result with 2 swaps, and "zero_closed_lots_correct_no_overlap" was read as complete history).
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  runCanonicalRobinhoodScan, resolveRobinhoodRouteRequest, markRobinhoodScanQueued,
  readRobinhoodScanRecord, __resetRobinhoodScanCoordinatorForTest, ROBINHOOD_SCAN_LEASE_MS, ROBINHOOD_REFRESH_JOIN_WINDOW_MS,
  type RobinhoodScanResult,
} from '../lib/server/robinhoodScanCoordinator.ts'
import { robinhoodHistoryCoverage, selectRobinhoodDeepAcquisitionSell, RH_NATIVE, type RhVerifiedSwap, type RhPriceEvidence } from '../lib/server/robinhoodPnlV1.ts'

delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

let seq = 0
const nextWallet = () => `0x${(0xf7e500 + ++seq).toString(16).padStart(40, '0')}`
const fastSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)))
const silence = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const w = console.warn
  console.warn = () => {}
  try { return await fn() } finally { console.warn = w }
}
/** A scan result tagged with which provider call produced it. */
const fixture = (wallet: string, tag: string) => ({
  holdings: { status: 'partial', wallet, holdings: [], wrongChainCacheRejected: false },
  activity: { status: 'ok', wallet, items: [], swapDecodeAudits: [], wrongChainCacheRejected: false },
  pnl: { status: 'disabled', realizedPnlUsd: null, matchedLotsCount: 0, verifiedSwapCount: 0, reason: tag },
  audit: { chainId: 4663 },
  pnlVerificationAudit: { wallet, chainId: 4663 },
  robinhoodPnl: { status: 'not_verified', exactReason: tag, ingestionAudit: { historyCoverage: { status: 'incomplete', reasons: ['x'] } } },
}) as unknown as RobinhoodScanResult
function provider(delayMs: number) {
  let calls = 0
  const scan = async (wallet: string) => {
    calls += 1
    const n = calls
    await new Promise((r) => setTimeout(r, delayMs))
    return fixture(wallet, `scan-${n}`)
  }
  return { scan, calls: () => calls }
}
const reasonOf = (body: unknown) => (body as { pnl?: { reason?: string } }).pnl?.reason

beforeEach(() => { __resetRobinhoodScanCoordinatorForTest() })

// ── freshness ───────────────────────────────────────────────────────────────────────────────────────
test('a fresh (refresh) request encountering a cached finished result starts a new scan and is never served the old one', async () => {
  const wallet = nextWallet()
  const p = provider(5)
  let t = 1_000_000
  const now = () => t
  await silence(() => runCanonicalRobinhoodScan(wallet, fetch, { jobId: null, owner: 'standalone', scan: p.scan, now }))
  t += 60_000 // an old (but still "fresh" by the 5-minute reuse rule) result exists
  const plain = await silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { scan: p.scan, sleep: fastSleep, now }))
  assert.deepEqual([plain.status, reasonOf(plain.body), p.calls()], [200, 'scan-1', 1], 'a plain request may reuse it')
  const fresh = await silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { refresh: true, scan: p.scan, sleep: fastSleep, now, waitMs: 2_000 }))
  assert.equal(fresh.status, 200)
  assert.equal(reasonOf(fresh.body), 'scan-2', 'served by its own new scan')
  assert.equal(fresh.audit.startedNewRobinhoodProviderScan, true)
  assert.equal(p.calls(), 2)
})

test('refresh polls share one freshness floor: the scan the first poll started answers later polls, no scan per poll', async () => {
  const wallet = nextWallet()
  const p = provider(120)
  const kept: Promise<unknown>[] = []
  const first = await silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { refresh: true, scan: p.scan, sleep: fastSleep, waitMs: 20, keepAlive: (w) => { kept.push(w) } }))
  assert.equal(first.status, 202)
  assert.equal(kept.length, 1, 'the standalone scan is kept alive past the response')
  const since = (first.body as { refreshSince?: number }).refreshSince
  assert.equal(typeof since, 'number')
  const second = await silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { refresh: true, refreshSince: since, scan: p.scan, sleep: fastSleep, waitMs: 2_000 }))
  assert.deepEqual([second.status, reasonOf(second.body), second.audit.joinedInFlight, p.calls()], [200, 'scan-1', true, 1])
  // After completion, a late poll with the same floor is served the finished result — not a third/second scan.
  await Promise.all(kept)
  const late = await silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { refresh: true, refreshSince: since, scan: p.scan, sleep: fastSleep, waitMs: 2_000 }))
  assert.deepEqual([late.status, reasonOf(late.body), p.calls()], [200, 'scan-1', 1])
})

test('a refresh that finds an OLDER scan still running neither adopts it nor duplicates provider work', async () => {
  const wallet = nextWallet()
  const p = provider(150)
  let t = 5_000_000
  const now = () => t
  const old = silence(() => runCanonicalRobinhoodScan(wallet, fetch, { jobId: null, owner: 'standalone', scan: p.scan, now }))
  await new Promise((r) => setTimeout(r, 10))
  t += ROBINHOOD_REFRESH_JOIN_WINDOW_MS + 5_000 // the running scan started well before this refresh
  const r1 = await silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { refresh: true, scan: p.scan, sleep: fastSleep, now, waitMs: 2_000 }))
  assert.equal(r1.status, 202)
  assert.equal((r1.body as { state: string }).state, 'previous_scan_running')
  assert.equal(p.calls(), 1, 'no duplicate provider scan beside the live one')
  await old
  const since = (r1.body as { refreshSince?: number }).refreshSince
  const r2 = await silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { refresh: true, refreshSince: since, scan: p.scan, sleep: fastSleep, now, waitMs: 2_000 }))
  assert.deepEqual([r2.status, reasonOf(r2.body), p.calls()], [200, 'scan-2', 2], 'then it runs its own scan')
})

// ── dedup ───────────────────────────────────────────────────────────────────────────────────────────
test('concurrent requests join one genuinely active scan (one provider scan, every caller served its result)', async () => {
  const wallet = nextWallet()
  const p = provider(60)
  const results = await silence(() => Promise.all([
    resolveRobinhoodRouteRequest(wallet, fetch, { scan: p.scan, sleep: fastSleep, waitMs: 2_000 }),
    (async () => { await new Promise((r) => setTimeout(r, 5)); return resolveRobinhoodRouteRequest(wallet, fetch, { scan: p.scan, sleep: fastSleep, waitMs: 2_000 }) })(),
    (async () => { await new Promise((r) => setTimeout(r, 5)); return resolveRobinhoodRouteRequest(wallet, fetch, { refresh: true, scan: p.scan, sleep: fastSleep, waitMs: 2_000 }) })(),
  ]))
  assert.equal(p.calls(), 1)
  for (const r of results) assert.deepEqual([r.status, reasonOf(r.body)], [200, 'scan-1'])
  assert.equal(results.filter((r) => r.audit.startedNewRobinhoodProviderScan).length, 1)
})

test('a job whose scan lease expired is reported as failed, not "pending" forever, and the route never scans for it', async () => {
  const wallet = nextWallet()
  const p = provider(5)
  const t0 = 9_000_000
  await markRobinhoodScanQueued(wallet, 'job-lost', t0)
  const now = () => t0 + ROBINHOOD_SCAN_LEASE_MS + 1_000
  const r = await silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { jobId: 'job-lost', scan: p.scan, sleep: fastSleep, now, waitMs: 10 }))
  assert.equal(r.status, 502)
  assert.match((r.body as { error: { message: string } }).error.message, /did not complete/)
  assert.equal(p.calls(), 0)
})

test('a job that is genuinely queued keeps the page pending (budget respected, no scan from the route)', async () => {
  const wallet = nextWallet()
  const p = provider(5)
  await markRobinhoodScanQueued(wallet, 'job-live')
  const r = await silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { jobId: 'job-live', scan: p.scan, sleep: fastSleep, waitMs: 20 }))
  assert.equal(r.status, 202)
  assert.equal(p.calls(), 0)
  assert.equal((await readRobinhoodScanRecord(wallet))?.state, 'queued')
})

// ── completeness ────────────────────────────────────────────────────────────────────────────────────
const boot = (o: Partial<{ attempted: boolean; completed: boolean; stopReason: string | null; pendingRemaining: number; reason: string | null }> = {}) =>
  ({ attempted: true, completed: true, stopReason: 'history_exhausted', pendingRemaining: 0, reason: null, ...o })
const cov = (o: Partial<Parameters<typeof robinhoodHistoryCoverage>[0]> = {}) => robinhoodHistoryCoverage({
  candidatesDroppedByBudget: 0, stagedComplete: true, uncheckedReceipts: 0, unmatchedVerifiedSells: 0, bootstrap: boot(), ...o,
})

test('history coverage: complete only with exhausted history discovery and every candidate checked', () => {
  assert.deepEqual(cov(), { status: 'complete', reasons: [] })
})

test('a completed but incomplete scan is never represented as complete history', () => {
  assert.deepEqual(cov({ candidatesDroppedByBudget: 38 }).status, 'incomplete')
  assert.ok(cov({ candidatesDroppedByBudget: 38 }).reasons.includes('candidates_not_checked_by_budget:38'))
  assert.equal(cov({ stagedComplete: false }).status, 'incomplete')
  assert.equal(cov({ uncheckedReceipts: 2 }).status, 'incomplete')
  assert.equal(cov({ unmatchedVerifiedSells: 1 }).status, 'incomplete')
  assert.match(cov({ bootstrap: boot({ stopReason: 'lifetime_page_cap' }) }).reasons.join(), /history_discovery_not_exhausted:lifetime_page_cap/)
  assert.equal(cov({ bootstrap: boot({ completed: false, stopReason: 'page_cap', pendingRemaining: 3 }) }).status, 'incomplete')
})

test('no gap but no exhaustion proof is unknown, never complete', () => {
  assert.equal(cov({ bootstrap: null }).status, 'unknown')
  assert.equal(cov({ bootstrap: boot({ attempted: false, completed: false, stopReason: null, reason: 'manifest_lookup_failed' }) }).status, 'unknown')
})

// ── acquisition recovery target ─────────────────────────────────────────────────────────────────────
const T = '0xdee52f2ab639b6942b0d0f0565400b93b7a0fbe5'
const U = '0xedbf91223639800bcd5756815caf908df3b890be'
const E18 = BigInt(10) ** BigInt(18)
const sw = (txHash: string, ts: number, inputToken: string, outputToken: string): RhVerifiedSwap => ({
  txHash, blockNumber: ts, firstLogIndex: 0, timestampSec: ts, inputToken, outputToken, inputRaw: E18, outputRaw: E18, inputDecimals: 18, outputDecimals: 18, hops: [], intermediary: null,
})
const ev = (s: RhVerifiedSwap, o: Partial<RhPriceEvidence>): RhPriceEvidence => ({
  swapTxHash: s.txHash, inputToken: s.inputToken, outputToken: s.outputToken, inputAmount: 1, outputAmount: 1, inputPriceUsd: null, outputPriceUsd: null,
  inputSource: null, outputSource: null, bothLegsVerified: false, rejectionReason: 'x', ...o,
})

test('deep acquisition still targets an unmatched sell that is not priced on both legs (exact sold token)', () => {
  const unpriced = sw('0xa1', 2000, T, U) // token↔token sell, no verified price
  const pick = selectRobinhoodDeepAcquisitionSell([unpriced], [ev(unpriced, {})], (t) => t === RH_NATIVE)
  assert.deepEqual([pick?.txHash, pick?.token, pick?.tier], ['0xa1', T, 2])
})

test('deep acquisition prefers a both-legs-priced unmatched sell, then a daily estimate', () => {
  const unpriced = sw('0xa1', 3000, T, U)
  const daily = sw('0xa2', 2500, U, T)
  const priced = sw('0xa3', 2000, T, RH_NATIVE)
  const evidence = [ev(unpriced, {}), ev(daily, { dailyEstimate: { inputUsd: 1, outputUsd: 1 } }), ev(priced, { bothLegsVerified: true, rejectionReason: null })]
  assert.equal(selectRobinhoodDeepAcquisitionSell([unpriced, daily, priced], evidence, (t) => t === RH_NATIVE)?.txHash, '0xa3')
  assert.equal(selectRobinhoodDeepAcquisitionSell([unpriced, daily], evidence, (t) => t === RH_NATIVE)?.txHash, '0xa2')
})
