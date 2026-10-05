// One user scan -> at most one Robinhood provider scan (lib/server/robinhoodScanCoordinator.ts).
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  runCanonicalRobinhoodScan, resolveRobinhoodRouteRequest, markRobinhoodScanQueued, buildRobinhoodRouteBody,
  robinhoodScanResultFromBody, getRobinhoodProviderScanCount, __resetRobinhoodScanCoordinatorForTest,
  ROBINHOOD_ROUTE_WAIT_MS, type RobinhoodScanResult,
} from '../lib/server/robinhoodScanCoordinator.ts'

delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

let seq = 0
const nextWallet = () => `0x${(0xd0d000 + ++seq).toString(16).padStart(40, '0')}`
const fastSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)))

function fixture(wallet: string): RobinhoodScanResult {
  return {
    holdings: { status: 'partial', wallet, chainSlug: 'robinhood', native: null, holdings: [], portfolioTotalUsd: 120.86, unpricedTokenCount: 0, reason: null, fromCache: false, wrongChainCacheRejected: false },
    activity: { status: 'partial', wallet, chainSlug: 'robinhood', items: [], skippedSwapLogs: 0, swapDecodeAudits: [], verifiedSwapCount: 0, reason: 'timeout (GoldRush primary); activity from Blockscout fallback', fromCache: false, wrongChainCacheRejected: false },
    pnl: { status: 'disabled', realizedPnlUsd: null, matchedLotsCount: 0, verifiedSwapCount: 0, reason: '4 swaps found / 0 proven as wallet V4 trades (most common: wallet_not_tx_sender).' },
    audit: { chainId: 4663 },
    pnlVerificationAudit: { wallet, chainId: 4663, source: 'robinhood_sidecar_phase3', status: 'disabled', verifiedSwapCount: 0 },
    robinhoodPnl: { status: 'not_verified', structuralClosedLots: 0, verifiedClosedLots: 0, pricingCoverage: null, realizedPnlUsd: null, realizedRoiPct: null, unmatchedSellCount: 0, exactReason: '4 swaps found / 0 proven as wallet V4 trades (most common: wallet_not_tx_sender).', swapsFound: 4, swapsVerified: 0, swapsBothLegsPriced: 0 },
  } as unknown as RobinhoodScanResult
}
function provider(delayMs = 30, fail: string | null = null) {
  let calls = 0
  const scan = async (wallet: string) => {
    calls += 1
    await new Promise((r) => setTimeout(r, delayMs))
    if (fail) throw new Error(fail)
    return fixture(wallet)
  }
  return { scan, calls: () => calls }
}
const silence = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const w = console.warn
  console.warn = () => {}
  try { return await fn() } finally { console.warn = w }
}

beforeEach(() => { __resetRobinhoodScanCoordinatorForTest() })

test('1. main wallet scan + concurrent Robinhood frontend request -> exactly one provider scan', async () => {
  const wallet = nextWallet()
  const p = provider(40)
  await markRobinhoodScanQueued(wallet, 'job-1')
  const [worker, route] = await silence(() => Promise.all([
    runCanonicalRobinhoodScan(wallet, fetch, { jobId: 'job-1', owner: 'worker', scan: p.scan }),
    resolveRobinhoodRouteRequest(wallet, fetch, { jobId: 'job-1', scan: p.scan, sleep: fastSleep }),
  ]))
  assert.equal(p.calls(), 1)
  assert.equal(getRobinhoodProviderScanCount(), 1)
  assert.equal(route.status, 200)
  assert.deepEqual(route.body, buildRobinhoodRouteBody(wallet, worker))
  assert.equal(route.audit.startedNewRobinhoodProviderScan, false)
})

test('1b. a job-backed request arriving before the worker starts waits for it and never scans itself', async () => {
  const wallet = nextWallet()
  const p = provider(10)
  const routeP = silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { jobId: 'job-early', scan: p.scan, sleep: fastSleep, waitMs: 2_000 }))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(p.calls(), 0, 'the route never starts a scan for a known job')
  await silence(() => runCanonicalRobinhoodScan(wallet, fetch, { jobId: 'job-early', owner: 'worker', scan: p.scan }))
  const route = await routeP
  assert.equal(route.status, 200)
  assert.equal(p.calls(), 1)
})

test('2. a request without a job joins the in-flight canonical scan', async () => {
  const wallet = nextWallet()
  const p = provider(40)
  const workerP = silence(() => runCanonicalRobinhoodScan(wallet, fetch, { jobId: 'job-2', owner: 'worker', scan: p.scan }))
  await new Promise((r) => setTimeout(r, 5))
  const route = await silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { scan: p.scan, sleep: fastSleep }))
  await workerP
  assert.equal(route.status, 200)
  assert.equal(route.audit.joinedInFlight, true)
  assert.equal(route.audit.startedNewRobinhoodProviderScan, false)
  assert.equal(p.calls(), 1)
})

test('3. a completed recent result returns immediately with no provider work', async () => {
  const wallet = nextWallet()
  const p = provider(5)
  await silence(() => runCanonicalRobinhoodScan(wallet, fetch, { jobId: 'job-3', owner: 'worker', scan: p.scan }))
  const t0 = Date.now()
  const route = await silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { scan: p.scan, sleep: fastSleep }))
  assert.ok(Date.now() - t0 < 200)
  assert.equal(route.status, 200)
  assert.equal(route.audit.reusedCanonicalResult, true)
  assert.equal(route.audit.canonicalJobId, 'job-3')
  assert.ok(route.audit.resultAgeMs != null && route.audit.resultAgeMs >= 0)
  assert.equal(p.calls(), 1)
})

test('4. no canonical result -> one bounded standalone scan: 202 within budget, then served without re-scanning', async () => {
  const wallet = nextWallet()
  const p = provider(150)
  const first = await silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { scan: p.scan, sleep: fastSleep, waitMs: 30 }))
  assert.equal(first.status, 202)
  assert.equal(first.audit.startedNewRobinhoodProviderScan, true)
  const second = await silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { scan: p.scan, sleep: fastSleep, waitMs: 2_000 }))
  assert.equal(second.status, 200)
  assert.equal(second.audit.startedNewRobinhoodProviderScan, false)
  assert.equal(p.calls(), 1)
  assert.ok(ROBINHOOD_ROUTE_WAIT_MS < 30_000, 'the route budget stays inside its 30s maxDuration')
})

test('5. a provider error propagates honestly (502 with the real message), never an empty success', async () => {
  const wallet = nextWallet()
  const p = provider(5, 'GoldRush exploded')
  await markRobinhoodScanQueued(wallet, 'job-5')
  await assert.rejects(silence(() => runCanonicalRobinhoodScan(wallet, fetch, { jobId: 'job-5', owner: 'worker', scan: p.scan })), /GoldRush exploded/)
  const route = await silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { jobId: 'job-5', scan: p.scan, sleep: fastSleep }))
  assert.equal(route.status, 502)
  assert.deepEqual(route.body, { error: { message: 'Robinhood scan failed: GoldRush exploded', category: 'provider' } })
  assert.equal(p.calls(), 1)
})

test('dedup audit is logged (console.warn) with the required fields', async () => {
  const wallet = nextWallet()
  const lines: unknown[][] = []
  const w = console.warn
  console.warn = (...a: unknown[]) => { lines.push(a) }
  try {
    await runCanonicalRobinhoodScan(wallet, fetch, { jobId: 'job-a', owner: 'worker', scan: provider(1).scan })
    await resolveRobinhoodRouteRequest(wallet, fetch, { scan: provider(1).scan, sleep: fastSleep })
  } finally { console.warn = w }
  const audits = lines.filter((l) => l[0] === '[robinhood-scan-dedup-audit]').map((l) => l[1] as Record<string, unknown>)
  assert.equal(audits.length, 2)
  for (const a of audits) {
    for (const k of ['wallet', 'canonicalJobId', 'standaloneRouteRequested', 'reusedCanonicalResult', 'joinedInFlight', 'startedNewRobinhoodProviderScan', 'providerScanCount', 'resultAgeMs']) assert.ok(k in a, k)
  }
})

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('6. no 30s synchronous route dependency in the normal Wallet Scanner flow', () => {
  const route = read('app/api/wallet-scan/robinhood/route.ts')
  assert.doesNotMatch(route, /(await|void) scanRobinhoodWallet\(|import \{[^}]*scanRobinhoodWallet/)
  assert.match(route, /resolveRobinhoodRouteRequest\(/)
  const post = read('app/api/wallet-scan/route.ts')
  assert.doesNotMatch(post, /(await|void) scanRobinhoodWallet\(|import \{[^}]*scanRobinhoodWallet/, 'no cache-warm provider scan on POST')
  assert.match(post, /markRobinhoodScanQueued\(wallet, jobId, robinhoodQueuedAt\)/)
  const worker = read('workers/walletScanV2.ts')
  assert.match(worker, /runCanonicalRobinhoodScan\(walletAddress, fetch, \{ jobId: jobId \?\? null, owner: 'worker' \}\)/)
  const page = read('app/terminal/wallet-scanner/page.tsx')
  const scanFn = page.slice(page.indexOf('async function handleScan('), page.indexOf('async function handleRobinhoodScan('))
  assert.doesNotMatch(scanFn, /void handleRobinhoodScan\(\)/, 'the page never fires an unscoped Robinhood scan at scan start')
  assert.match(scanFn, /void handleRobinhoodScan\(\{ jobId \}\)/)
})

test('7. Base/ETH pipeline unchanged: no Base/ETH module touches the coordinator', () => {
  const root = new URL('../', import.meta.url).pathname
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : []
  })
  for (const f of [...walk(join(root, 'src/pipeline')), ...walk(join(root, 'src/modules'))]) assert.doesNotMatch(readFileSync(f, 'utf8'), /robinhoodScanCoordinator/, f)
})

test('8. Robinhood V4/PnL output unchanged: the stored body is the legacy route body and round-trips exactly', () => {
  const wallet = nextWallet()
  const r = fixture(wallet)
  const body = buildRobinhoodRouteBody(wallet, r)
  assert.deepEqual(Object.keys(body), ['ok', 'wallet', 'chainSlug', 'chainId', 'holdings', 'activity', 'pnl', 'robinhoodWalletScannerAudit', 'robinhoodPnlVerificationAudit', 'robinhoodPnl'])
  assert.equal(body.pnl.message, 'PnL: disabled — verified Robinhood swap decoding unavailable')
  assert.deepEqual(robinhoodScanResultFromBody(body), r)
  for (const f of ['lib/server/robinhoodPnlV1.ts', 'lib/server/robinhoodSwapDecoder.ts']) assert.doesNotMatch(read(f), /robinhoodScanCoordinator/)
})
