// Wallet-scanner audit fixes: zero closed lots is "open position only" only with complete history and no unmatched
// sell (P1-1); a verified Robinhood figure carries its bounded-sample qualifier (P1-2); the recovery lane orders swaps
// exactly like FIFO (P2-1); a finished scan whose body never reached the shared store is never mistaken for a dead
// worker or re-scanned (P1-4); the dedup diagnostic says whether a request really joined a live scan (P2-2); and a
// truncated activity window is flagged (P2-3).
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  selectRobinhoodSwapEvidence, robinhoodPnlCardView, robinhoodHistoryCoverageLabel, robinhoodZeroLotsIsOpenPositionOnly,
  type RobinhoodWalletScanResponse, type RobinhoodPnlSummary,
} from '../lib/walletScan/canonicalWalletSelectors.ts'
import { buildWalletPnlViewModel, robinhoodVerifiedQualifier } from '../app/frontend/lib/buildWalletPnlViewModel.ts'
import { robinhoodUnmatchedSellRaw } from '../lib/server/robinhoodAcquisitionRecovery.ts'
import { buildRobinhoodPnlV1Fifo, RH_NATIVE, type RhVerifiedSwap, type RhPriceEvidence } from '../lib/server/robinhoodPnlV1.ts'
import {
  runCanonicalRobinhoodScan, resolveRobinhoodRouteRequest, markRobinhoodScanQueued, __resetRobinhoodScanCoordinatorForTest,
  __setRobinhoodScanStoreForTest, ROBINHOOD_SCAN_LEASE_MS, type RobinhoodScanResult,
} from '../lib/server/robinhoodScanCoordinator.ts'
import { fetchRobinhoodTransactions, ROBINHOOD_GOLDRUSH_TX_PAGE_SIZE } from '../lib/server/robinhoodWalletScanner.ts'

delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

const WALLET = '0x9d69b5ffb22608d8003508b9c6bd9f6b458d4184'
const T = '0xdee52f2ab639b6942b0d0f0565400b93b7a0fbe5'
const E18 = BigInt(10) ** BigInt(18)

// ── P1-1 ────────────────────────────────────────────────────────────────────────────────────────────
function summary(over: Partial<RobinhoodPnlSummary> = {}): RobinhoodPnlSummary {
  return {
    status: 'not_verified', structuralClosedLots: 0, verifiedClosedLots: 0, pricingCoverage: null, realizedPnlUsd: null, realizedRoiPct: null,
    unmatchedSellCount: 0, exactReason: '2 swaps proven, 2 priced on both legs, but no buy→sell pair closed a lot in this sample.',
    swapsFound: 2, swapsVerified: 2, swapsBothLegsPriced: 2, historyCoverage: { status: 'complete', reasons: [] }, ...over,
  }
}
function result(pnl: Partial<RobinhoodPnlSummary> = {}, audit: RobinhoodWalletScanResponse['robinhoodPnlVerificationAudit'] = null): RobinhoodWalletScanResponse {
  return {
    ok: true, wallet: WALLET, chainSlug: 'robinhood', chainId: 4663,
    holdings: { status: 'ok', native: null, holdings: [], portfolioTotalUsd: 0, unpricedTokenCount: 0, reason: null },
    activity: { status: 'ok', items: [], skippedSwapLogs: 0, verifiedSwapCount: 0, reason: null, blockscoutEvidence: { blockscoutAttempted: false, blockscoutSucceeded: false, blockscoutFallbackUsed: false, blockscoutStatus: 'not_attempted', blockscoutError: null, blockscoutVerifiedSwap: false } },
    pnl: { status: 'disabled', message: '', realizedPnlUsd: null, matchedLotsCount: 0, verifiedSwapCount: 2, reason: null },
    robinhoodWalletScannerAudit: {},
    robinhoodPnlVerificationAudit: audit,
    robinhoodPnl: summary(pnl),
  } as RobinhoodWalletScanResponse
}

test('P1-1: verified sells with no verified buy are never "open position only"; the coverage caveat survives', () => {
  const exact = '2 swaps proven, 2 priced on both legs, but no buy→sell pair closed a lot in this sample. Wallet history coverage is incomplete — earlier acquisitions may lie outside this sample, so this is not proof the wallet has no closed trades.'
  const r = result({ unmatchedSellCount: 2, historyCoverage: { status: 'incomplete', reasons: ['verified_sells_without_verified_acquisition:2'] }, exactReason: exact })
  const ev = selectRobinhoodSwapEvidence(r)!
  assert.equal(ev.openPositionOnly, false)
  assert.equal(ev.reason, exact, 'the V1 reason (already carrying the coverage caveat) is kept, not duplicated')
  assert.deepEqual(ev.historyCoverage, { status: 'incomplete', reasons: ['verified_sells_without_verified_acquisition:2'] })
  assert.equal(robinhoodPnlCardView(r.robinhoodPnl)!.statusLabel, 'NOT VERIFIED')
})

test('P1-1: incomplete or unknown history coverage is never "open position only", even with zero unmatched sells', () => {
  for (const historyCoverage of [{ status: 'incomplete' as const, reasons: ['candidates_not_checked_by_budget:30'] }, { status: 'unknown' as const, reasons: ['history_discovery_not_configured'] }, undefined]) {
    const r = result({ historyCoverage })
    const ev = selectRobinhoodSwapEvidence(r)!
    assert.equal(ev.openPositionOnly, false, String(historyCoverage?.status))
    assert.match(ev.reason!, /History coverage (incomplete|unknown)/)
    assert.notEqual(robinhoodPnlCardView(r.robinhoodPnl)!.statusLabel, 'OPEN POSITION ONLY')
  }
  assert.equal(robinhoodHistoryCoverageLabel({ status: 'complete', reasons: [] }), null)
})

test('P1-1: buys only, complete coverage, no unmatched sell → still "open position only"', () => {
  const ev = selectRobinhoodSwapEvidence(result())!
  assert.equal(ev.openPositionOnly, true)
  assert.equal(robinhoodZeroLotsIsOpenPositionOnly(result().robinhoodPnl), true)
  assert.equal(robinhoodPnlCardView(result().robinhoodPnl)!.statusLabel, 'OPEN POSITION ONLY')
})

// ── P1-2 ────────────────────────────────────────────────────────────────────────────────────────────
const verifiedAudit = {
  source: 'robinhood_sidecar_phase3', chainId: 4663, status: 'verified', realizedPnlUsd: 12.5, verifiedSwapCount: 3, swapsFedToFifo: 3,
  fifoClosedLots: 1, priceEvidenceBothLegsCount: 3,
} as unknown as RobinhoodWalletScanResponse['robinhoodPnlVerificationAudit']
function verifiedResult(pnl: Partial<RobinhoodPnlSummary>) {
  const r = result({ status: 'verified_bounded_sample', swapsVerified: 3, swapsBothLegsPriced: 3, realizedPnlUsd: 12.5, ...pnl }, verifiedAudit)
  return { ...r, pnl: { ...r.pnl, status: 'verified' as const, realizedPnlUsd: 12.5, verifiedSwapCount: 3 } }
}

test('P1-2: a bounded verified sample states verified/structural lots and history coverage on the box and the chain row', () => {
  const r = verifiedResult({ structuralClosedLots: 2, verifiedClosedLots: 1, historyCoverage: { status: 'incomplete', reasons: ['verified_sells_without_verified_acquisition:1'] } })
  const vm = buildWalletPnlViewModel({ pnlV2: null, publicPnlStatus: 'unavailable', robinhoodResult: r, chainsScanned: ['base', 'eth'] })
  assert.equal(vm.robinhoodBox.status, 'Verified', 'the lane gate is unchanged')
  assert.equal(vm.robinhoodBox.value, '+$12.50')
  assert.match(vm.robinhoodBox.reason, /1\/2 closed lots verified/)
  assert.match(vm.robinhoodBox.reason, /History coverage incomplete/)
  const row = vm.chainRows.find((c) => c.chain === 'robinhood')!
  assert.match(row.reason, /^Bounded verified sample — 1\/2 closed lots verified · History coverage incomplete/)
})

test('P1-2: plain "Verified" wording only when every structural lot is verified AND history coverage is complete', () => {
  assert.equal(robinhoodVerifiedQualifier({ structuralClosedLots: 2, verifiedClosedLots: 2, historyCoverage: { status: 'complete', reasons: [] } }), null)
  assert.match(robinhoodVerifiedQualifier({ structuralClosedLots: 2, verifiedClosedLots: 2, historyCoverage: { status: 'unknown', reasons: [] } })!, /2\/2 closed lots verified · History coverage unknown/)
  assert.match(robinhoodVerifiedQualifier({ structuralClosedLots: 3, verifiedClosedLots: 2, historyCoverage: { status: 'complete', reasons: [] } })!, /2\/3 closed lots verified · History coverage complete/)
  const plain = buildWalletPnlViewModel({ pnlV2: null, publicPnlStatus: 'unavailable', robinhoodResult: verifiedResult({ structuralClosedLots: 1, verifiedClosedLots: 1 }), chainsScanned: ['base', 'eth'] })
  assert.doesNotMatch(plain.robinhoodBox.reason, /bounded verified sample/)
})

// ── P2-1 ────────────────────────────────────────────────────────────────────────────────────────────
const swap = (txHash: string, ts: number, block: number, inputToken: string, outputToken: string, inputRaw: bigint, outputRaw: bigint): RhVerifiedSwap => ({
  txHash, blockNumber: block, firstLogIndex: 0, timestampSec: ts, inputToken, outputToken, inputRaw, outputRaw, inputDecimals: 18, outputDecimals: 18, hops: [], intermediary: null,
})
const priced = (s: RhVerifiedSwap): RhPriceEvidence => ({ swapTxHash: s.txHash, inputToken: s.inputToken, outputToken: s.outputToken, inputAmount: 1, outputAmount: 1, inputPriceUsd: 1, outputPriceUsd: 1, inputSource: 'x', outputSource: 'x', bothLegsVerified: true, rejectionReason: null })
const isQuote = (t: string) => t === RH_NATIVE

test('P2-1: same second, sell in block 10 and buy in block 12 → the recovery lane agrees with FIFO: the sell is unmatched', () => {
  const sell = swap('0x0a', 1000, 10, T, RH_NATIVE, E18, E18 / BigInt(50))
  const buy = swap('0x0b', 1000, 12, RH_NATIVE, T, E18 / BigInt(100), E18)
  const { fifo } = buildRobinhoodPnlV1Fifo(WALLET, [sell, buy], [priced(sell), priced(buy)])
  assert.equal(fifo.unmatchedSells, 1)
  assert.equal(robinhoodUnmatchedSellRaw([sell, buy], isQuote).get('0x0a')!.unmatchedRaw, E18)
})

test('P2-1: same second, buy in block 10 and sell in block 12 (and same-block log order) still covers the sell', () => {
  const buy = swap('0x0b', 1000, 10, RH_NATIVE, T, E18 / BigInt(100), E18)
  const sell = swap('0x0a', 1000, 12, T, RH_NATIVE, E18, E18 / BigInt(50))
  assert.equal(robinhoodUnmatchedSellRaw([sell, buy], isQuote).get('0x0a')!.unmatchedRaw, BigInt(0))
  const buyLog = { ...swap('0x0c', 1000, 12, RH_NATIVE, T, E18 / BigInt(100), E18), firstLogIndex: 1 }
  const sellLog = { ...swap('0x0d', 1000, 12, T, RH_NATIVE, E18, E18 / BigInt(50)), firstLogIndex: 5 }
  assert.equal(robinhoodUnmatchedSellRaw([sellLog, buyLog], isQuote).get('0x0d')!.unmatchedRaw, BigInt(0))
})

// ── P1-4 / P2-2 ─────────────────────────────────────────────────────────────────────────────────────
let seq = 0
const nextWallet = () => `0x${(0xc0c000 + ++seq).toString(16).padStart(40, '0')}`
const fastSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)))
const silence = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const w = console.warn
  console.warn = () => {}
  try { return await fn() } finally { console.warn = w }
}
function fixture(wallet: string): RobinhoodScanResult {
  return {
    holdings: { status: 'ok', wallet, chainSlug: 'robinhood', native: null, holdings: [], portfolioTotalUsd: 1, unpricedTokenCount: 0, reason: null, fromCache: false, wrongChainCacheRejected: false },
    activity: { status: 'ok', wallet, chainSlug: 'robinhood', items: [], skippedSwapLogs: 0, swapDecodeAudits: [], verifiedSwapCount: 0, reason: null, fromCache: false, wrongChainCacheRejected: false },
    pnl: { status: 'disabled', realizedPnlUsd: null, matchedLotsCount: 0, verifiedSwapCount: 0, reason: 'x' },
    audit: { chainId: 4663 },
    pnlVerificationAudit: { wallet, chainId: 4663, source: 'robinhood_sidecar_phase3', status: 'disabled', verifiedSwapCount: 0 },
    robinhoodPnl: { status: 'not_verified', structuralClosedLots: 0, verifiedClosedLots: 0, pricingCoverage: null, realizedPnlUsd: null, realizedRoiPct: null, unmatchedSellCount: 0, exactReason: 'x', swapsFound: 0, swapsVerified: 0, swapsBothLegsPriced: 0 },
  } as unknown as RobinhoodScanResult
}
function provider(delayMs = 5) {
  let calls = 0
  return { scan: async (wallet: string) => { calls += 1; await new Promise((r) => setTimeout(r, delayMs)); return fixture(wallet) }, calls: () => calls }
}
/** A shared store that never accepts a scan body (as when the body exceeds the KV payload limit). */
function bodylessSharedStore() {
  const map = new Map<string, unknown>()
  return {
    map,
    store: {
      get: async <T,>(key: string) => (map.get(key) as T | undefined) ?? null,
      set: async (key: string, value: unknown) => { if (key.includes(':body:')) return false; map.set(key, structuredClone(value)); return true },
    },
  }
}

beforeEach(() => { __resetRobinhoodScanCoordinatorForTest(); __setRobinhoodScanStoreForTest(null) })
afterEach(() => { __setRobinhoodScanStoreForTest(null) })

test('P1-4: a finished job whose body never reached the shared store → 409 "in the job report", never a lease-expiry 502, never re-scanned', async () => {
  const { store, map } = bodylessSharedStore()
  __setRobinhoodScanStoreForTest(store)
  const wallet = nextWallet()
  const p = provider()
  await markRobinhoodScanQueued(wallet, 'job-big')
  await silence(() => runCanonicalRobinhoodScan(wallet, fetch, { jobId: 'job-big', owner: 'worker', scan: p.scan }))
  const marker = [...map.values()][0] as { state: string; bodyStored: boolean; body: unknown }
  assert.deepEqual([marker.state, marker.bodyStored, marker.body], ['done', false, null], 'a small done marker, the body never inline')
  for (const offset of [0, ROBINHOOD_SCAN_LEASE_MS * 2]) {
    const out = await silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { jobId: 'job-big', scan: p.scan, sleep: fastSleep, waitMs: 200, now: () => Date.now() + offset }))
    assert.equal(out.status, 409, `offset ${offset}`)
    assert.deepEqual([(out.body as { resultInJobReport: boolean }).resultInJobReport, (out.body as { state: string }).state], [true, 'done'])
  }
  assert.equal(p.calls(), 1, 'never a second provider scan')
})

test('P1-4: a refresh whose own scan finished (body not shareable) is answered, never restarted', async () => {
  const { store } = bodylessSharedStore()
  __setRobinhoodScanStoreForTest(store)
  const wallet = nextWallet()
  const p = provider(5)
  const first = await silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { refresh: true, scan: p.scan, sleep: fastSleep, waitMs: 2_000 }))
  assert.equal(first.status, 200, 'the request that ran the scan in-process serves it directly')
  const since = Date.now() - 50
  const again = await silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { refresh: true, refreshSince: since, scan: p.scan, sleep: fastSleep, waitMs: 200 }))
  assert.equal(again.status, 409)
  assert.equal((again.body as { resultInJobReport: boolean }).resultInJobReport, false)
  assert.equal(p.calls(), 1)
})

test('P1-4: with a shared body the split record is transparent — the route serves the body (200)', async () => {
  const wallet = nextWallet()
  const p = provider()
  await markRobinhoodScanQueued(wallet, 'job-ok')
  await silence(() => runCanonicalRobinhoodScan(wallet, fetch, { jobId: 'job-ok', owner: 'worker', scan: p.scan }))
  const out = await silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { jobId: 'job-ok', scan: p.scan, sleep: fastSleep, waitMs: 200 }))
  assert.equal(out.status, 200)
})

test('P2-2: an already-finished job record is servedCompletedRecord, not joinedInFlight; waiting on a live job is joinedInFlight', async () => {
  const wallet = nextWallet()
  const p = provider(40)
  await markRobinhoodScanQueued(wallet, 'job-late')
  await silence(() => runCanonicalRobinhoodScan(wallet, fetch, { jobId: 'job-late', owner: 'worker', scan: p.scan }))
  const done = await silence(() => resolveRobinhoodRouteRequest(wallet, fetch, { jobId: 'job-late', scan: p.scan, sleep: fastSleep, waitMs: 200 }))
  assert.deepEqual([done.status, done.audit.joinedInFlight, done.audit.servedCompletedRecord, done.audit.standaloneRouteRequested], [200, false, true, true])
  assert.equal(typeof done.audit.processProviderScanCount, 'number')
  assert.equal(done.audit.processProviderScanCount, done.audit.providerScanCount, 'deprecated alias kept for one release')

  const wallet2 = nextWallet()
  await markRobinhoodScanQueued(wallet2, 'job-live')
  const routeP = silence(() => resolveRobinhoodRouteRequest(wallet2, fetch, { jobId: 'job-live', scan: p.scan, sleep: fastSleep, waitMs: 2_000 }))
  await new Promise((r) => setTimeout(r, 10))
  // Another instance's worker: the route only sees the shared record move queued → running → done.
  await silence(() => runCanonicalRobinhoodScan(wallet2, fetch, { jobId: 'job-live', owner: 'worker', scan: p.scan }))
  const live = await routeP
  assert.deepEqual([live.status, live.audit.joinedInFlight, live.audit.servedCompletedRecord], [200, true, false])
})

// ── P2-3 ────────────────────────────────────────────────────────────────────────────────────────────
test('P2-3: a full GoldRush page or a page link marks the activity window truncated; a short page does not', async () => {
  const prev = process.env.GOLDRUSH_API_KEY
  process.env.GOLDRUSH_API_KEY = 'k'
  try {
    const page = (n: number, links: unknown = null) => (async () => ({ ok: true, status: 200, json: async () => ({ data: { items: Array.from({ length: n }, (_, i) => ({ tx_hash: `0x${i}` })), links } }) })) as unknown as typeof fetch
    assert.equal((await fetchRobinhoodTransactions(WALLET, page(ROBINHOOD_GOLDRUSH_TX_PAGE_SIZE))).truncated, true)
    assert.equal((await fetchRobinhoodTransactions(WALLET, page(3, { prev: 'https://next', next: null }))).truncated, true)
    assert.equal((await fetchRobinhoodTransactions(WALLET, page(3, { prev: null, next: null }))).truncated, false)
  } finally {
    if (prev === undefined) delete process.env.GOLDRUSH_API_KEY; else process.env.GOLDRUSH_API_KEY = prev
  }
})
