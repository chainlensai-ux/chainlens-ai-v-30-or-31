// ROBINHOOD SCAN COORDINATOR — one Robinhood provider scan per user scan.
//
// Before: one Wallet Scanner "Scan" fired up to three full scanRobinhoodWallet() pipelines for the same
// wallet — the POST /api/wallet-scan cache-warm, the queued worker, and the page's own synchronous
// GET /api/wallet-scan/robinhood (maxDuration 30s). The worker finished; the duplicate GET hit Vercel's
// 30s limit (504 FUNCTION_INVOCATION_TIMEOUT).
//
// Now the queued worker is the canonical owner. POST only marks the wallet "queued" for its job; the worker
// runs the one provider scan and stores the finished route body under the wallet; the GET route serves,
// joins or waits (bounded) for that record and never starts a scan for a known job. A provider scan starts
// outside the worker only when nothing is queued, running or fresh (direct navigation), and the route never
// waits past its own bounded budget for it. In one process, concurrent callers share a single in-flight scan.

import { getTokenCache, setTokenCache } from './cache/tokenCache'
import { scanRobinhoodWallet, formatRobinhoodPnlMessage } from './robinhoodWalletScanner'

export type RobinhoodScanResult = Awaited<ReturnType<typeof scanRobinhoodWallet>>
export type RobinhoodScanFn = (wallet: string, fetchImpl: typeof fetch) => Promise<RobinhoodScanResult>

/** The exact JSON body GET /api/wallet-scan/robinhood has always returned. */
export function buildRobinhoodRouteBody(wallet: string, r: RobinhoodScanResult) {
  return {
    ok: true as const,
    wallet,
    chainSlug: 'robinhood' as const,
    chainId: r.audit.chainId,
    holdings: r.holdings,
    activity: r.activity,
    pnl: {
      status: r.pnl.status,
      message: formatRobinhoodPnlMessage(r.pnl.status),
      realizedPnlUsd: r.pnl.realizedPnlUsd,
      matchedLotsCount: r.pnl.matchedLotsCount,
      verifiedSwapCount: r.pnl.verifiedSwapCount,
      reason: r.pnl.reason,
    },
    robinhoodWalletScannerAudit: r.audit,
    robinhoodPnlVerificationAudit: r.pnlVerificationAudit,
    robinhoodPnl: r.robinhoodPnl,
  }
}
export type RobinhoodRouteBody = ReturnType<typeof buildRobinhoodRouteBody>

/** The worker's view of a stored body (inverse of buildRobinhoodRouteBody). */
export function robinhoodScanResultFromBody(body: RobinhoodRouteBody): RobinhoodScanResult {
  return {
    holdings: body.holdings,
    activity: body.activity,
    pnl: { status: body.pnl.status, realizedPnlUsd: body.pnl.realizedPnlUsd, matchedLotsCount: body.pnl.matchedLotsCount, verifiedSwapCount: body.pnl.verifiedSwapCount, reason: body.pnl.reason },
    audit: body.robinhoodWalletScannerAudit,
    pnlVerificationAudit: body.robinhoodPnlVerificationAudit,
    robinhoodPnl: body.robinhoodPnl,
  }
}

export type RobinhoodScanOwner = 'worker' | 'standalone' | 'orchestrator'
export type RobinhoodScanRecord = {
  v: 1
  wallet: string
  state: 'queued' | 'running' | 'done' | 'error'
  jobId: string | null
  owner: RobinhoodScanOwner
  queuedAt: number
  startedAt: number | null
  completedAt: number | null
  body: RobinhoodRouteBody | null
  error: string | null
}

/** A finished result younger than this is served as-is to a request with no job of its own. */
export const ROBINHOOD_SCAN_RESULT_FRESH_MS = 5 * 60_000
/** A queued/running record older than this is treated as abandoned (its function was killed). */
export const ROBINHOOD_SCAN_LEASE_MS = 120_000
/** The route's own budget: well inside its 30s maxDuration. */
export const ROBINHOOD_ROUTE_WAIT_MS = 20_000
const RECORD_TTL_SECONDS = 15 * 60
const POLL_MS = 750

const recordKey = (wallet: string) => `robinhood:scan-coord:v1:${wallet.toLowerCase()}`
const inFlight = new Map<string, Promise<RobinhoodScanResult>>()
let providerScanCount = 0

export function getRobinhoodProviderScanCount(): number { return providerScanCount }
/** Test hook. */
export function __resetRobinhoodScanCoordinatorForTest(): void { providerScanCount = 0; inFlight.clear() }

export async function readRobinhoodScanRecord(wallet: string): Promise<RobinhoodScanRecord | null> {
  const r = await getTokenCache<RobinhoodScanRecord>(recordKey(wallet)).catch(() => null)
  return r && r.v === 1 && r.wallet === wallet.toLowerCase() ? r : null
}
async function writeRecord(rec: RobinhoodScanRecord): Promise<void> {
  await setTokenCache(recordKey(rec.wallet), rec, RECORD_TTL_SECONDS).catch(() => {})
}

export type RobinhoodScanDedupAudit = {
  wallet: string
  canonicalJobId: string | null
  standaloneRouteRequested: boolean
  reusedCanonicalResult: boolean
  joinedInFlight: boolean
  startedNewRobinhoodProviderScan: boolean
  providerScanCount: number
  resultAgeMs: number | null
  caller: RobinhoodScanOwner | 'route'
  outcome: 'served' | 'pending' | 'error'
}
function logDedup(a: RobinhoodScanDedupAudit): RobinhoodScanDedupAudit {
  // console.warn: next.config removeConsole strips console.log in production.
  console.warn('[robinhood-scan-dedup-audit]', a)
  return a
}

/** POST /api/wallet-scan: the queued job will scan Robinhood — mark it so no other path starts a second scan. */
export async function markRobinhoodScanQueued(wallet: string, jobId: string, now: number = Date.now()): Promise<void> {
  await writeRecord({ v: 1, wallet: wallet.toLowerCase(), state: 'queued', jobId, owner: 'worker', queuedAt: now, startedAt: null, completedAt: null, body: null, error: null })
}

const leaseLive = (r: RobinhoodScanRecord, now: number) => (r.state === 'queued' || r.state === 'running') && now - (r.startedAt ?? r.queuedAt) < ROBINHOOD_SCAN_LEASE_MS

type Opts = { scan?: RobinhoodScanFn; now?: () => number; sleep?: (ms: number) => Promise<void> }
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Runs THE provider scan for this wallet (joining one already in flight in this process) and records it. */
async function runProviderScan(wallet: string, fetchImpl: typeof fetch, jobId: string | null, owner: RobinhoodScanOwner, opts: Opts): Promise<{ result: RobinhoodScanResult; joined: boolean }> {
  const key = wallet.toLowerCase()
  const existing = inFlight.get(key)
  if (existing) return { result: await existing, joined: true }
  const now = opts.now ?? Date.now
  const scan = opts.scan ?? scanRobinhoodWallet
  const run = (async () => {
    providerScanCount += 1
    const startedAt = now()
    await writeRecord({ v: 1, wallet: key, state: 'running', jobId, owner, queuedAt: startedAt, startedAt, completedAt: null, body: null, error: null })
    try {
      const result = await scan(wallet, fetchImpl)
      await writeRecord({ v: 1, wallet: key, state: 'done', jobId, owner, queuedAt: startedAt, startedAt, completedAt: now(), body: buildRobinhoodRouteBody(wallet, result), error: null })
      return result
    } catch (err) {
      await writeRecord({ v: 1, wallet: key, state: 'error', jobId, owner, queuedAt: startedAt, startedAt, completedAt: now(), body: null, error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  })()
  inFlight.set(key, run)
  try {
    return { result: await run, joined: false }
  } finally {
    inFlight.delete(key)
  }
}

/** Waits (bounded) for the record to reach done/error for `match`; null on timeout. */
async function waitForRecord(wallet: string, match: (r: RobinhoodScanRecord) => boolean, deadline: number, opts: Opts): Promise<RobinhoodScanRecord | null> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  for (;;) {
    const r = await readRobinhoodScanRecord(wallet)
    if (r && match(r) && (r.state === 'done' || r.state === 'error')) return r
    if (now() + POLL_MS > deadline) return null
    await sleep(POLL_MS)
  }
}

/**
 * The worker (canonical owner) and the orchestrator. Never a second provider scan while one is live for
 * this wallet: joins an in-process scan, or waits out another instance's live lease and reuses its result.
 * `reuseFreshMs` > 0 also reuses a recent finished result (orchestrator); the worker's rescan passes 0.
 */
export async function runCanonicalRobinhoodScan(
  wallet: string,
  fetchImpl: typeof fetch,
  params: { jobId: string | null; owner: RobinhoodScanOwner; reuseFreshMs?: number } & Opts,
): Promise<RobinhoodScanResult> {
  const now = params.now ?? Date.now
  const base = { wallet: wallet.toLowerCase(), canonicalJobId: params.jobId, standaloneRouteRequested: false, caller: params.owner } as const
  if (inFlight.has(wallet.toLowerCase())) {
    const { result } = await runProviderScan(wallet, fetchImpl, params.jobId, params.owner, params)
    logDedup({ ...base, reusedCanonicalResult: false, joinedInFlight: true, startedNewRobinhoodProviderScan: false, providerScanCount, resultAgeMs: 0, outcome: 'served' })
    return result
  }
  const rec = await readRobinhoodScanRecord(wallet)
  if (rec?.state === 'done' && rec.body && (params.reuseFreshMs ?? 0) > 0 && now() - (rec.completedAt ?? 0) < params.reuseFreshMs!) {
    logDedup({ ...base, reusedCanonicalResult: true, joinedInFlight: false, startedNewRobinhoodProviderScan: false, providerScanCount, resultAgeMs: now() - (rec.completedAt ?? 0), outcome: 'served' })
    return robinhoodScanResultFromBody(rec.body)
  }
  // Another instance is scanning this wallet right now (state running, not our own queued marker).
  if (rec && rec.state === 'running' && leaseLive(rec, now()) && rec.jobId !== params.jobId) {
    const started = rec.startedAt
    const done = await waitForRecord(wallet, (r) => r.startedAt === started, (rec.startedAt ?? now()) + ROBINHOOD_SCAN_LEASE_MS, params)
    if (done?.state === 'done' && done.body) {
      logDedup({ ...base, reusedCanonicalResult: true, joinedInFlight: true, startedNewRobinhoodProviderScan: false, providerScanCount, resultAgeMs: now() - (done.completedAt ?? now()), outcome: 'served' })
      return robinhoodScanResultFromBody(done.body)
    }
  }
  const { result, joined } = await runProviderScan(wallet, fetchImpl, params.jobId, params.owner, params)
  logDedup({ ...base, reusedCanonicalResult: false, joinedInFlight: joined, startedNewRobinhoodProviderScan: !joined, providerScanCount, resultAgeMs: 0, outcome: 'served' })
  return result
}

export type RobinhoodRouteOutcome =
  | { status: 200; body: RobinhoodRouteBody; audit: RobinhoodScanDedupAudit }
  | { status: 202; body: { ok: false; pending: true; wallet: string; jobId: string | null; state: string; retryAfterMs: number }; audit: RobinhoodScanDedupAudit }
  | { status: 502; body: { error: { message: string; category: 'provider' } }; audit: RobinhoodScanDedupAudit }

/** GET /api/wallet-scan/robinhood. Bounded by ROBINHOOD_ROUTE_WAIT_MS; never starts a scan for a known job. */
export async function resolveRobinhoodRouteRequest(
  wallet: string,
  fetchImpl: typeof fetch,
  params: { jobId?: string | null; refresh?: boolean; waitMs?: number } & Opts,
): Promise<RobinhoodRouteOutcome> {
  const now = params.now ?? Date.now
  const key = wallet.toLowerCase()
  const jobId = params.jobId ?? null
  const deadline = now() + (params.waitMs ?? ROBINHOOD_ROUTE_WAIT_MS)
  const audit = (o: Partial<RobinhoodScanDedupAudit>, outcome: RobinhoodScanDedupAudit['outcome']): RobinhoodScanDedupAudit => logDedup({
    wallet: key, canonicalJobId: jobId, standaloneRouteRequested: true, reusedCanonicalResult: false, joinedInFlight: false,
    startedNewRobinhoodProviderScan: false, providerScanCount, resultAgeMs: null, caller: 'route', outcome, ...o,
  })
  const fromRecord = (r: RobinhoodScanRecord, joined: boolean): RobinhoodRouteOutcome => r.state === 'done' && r.body
    ? { status: 200, body: r.body, audit: audit({ canonicalJobId: r.jobId, reusedCanonicalResult: true, joinedInFlight: joined, resultAgeMs: now() - (r.completedAt ?? now()) }, 'served') }
    : { status: 502, body: { error: { message: `Robinhood scan failed: ${r.error ?? 'unknown error'}`, category: 'provider' } }, audit: audit({ canonicalJobId: r.jobId, joinedInFlight: joined }, 'error') }
  const pending = (state: string, extra: Partial<RobinhoodScanDedupAudit>): RobinhoodRouteOutcome => ({
    status: 202,
    body: { ok: false, pending: true, wallet: key, jobId, state, retryAfterMs: 2_500 },
    audit: audit(extra, 'pending'),
  })
  const raceDeadline = async <T,>(p: Promise<T>): Promise<{ x: T } | { e: unknown } | 'timeout'> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), Math.max(0, deadline - now())) })
    try {
      return await Promise.race([p.then((x) => ({ x }), (e: unknown) => ({ e })), timeout])
    } finally {
      clearTimeout(timer)
    }
  }
  const joinLocal = async (): Promise<RobinhoodRouteOutcome | null> => {
    const local = inFlight.get(key)
    if (!local) return null
    const out = await raceDeadline(local)
    if (out === 'timeout') return pending('running', { joinedInFlight: true })
    if ('e' in out) return { status: 502, body: { error: { message: `Robinhood scan failed: ${out.e instanceof Error ? out.e.message : String(out.e)}`, category: 'provider' } }, audit: audit({ joinedInFlight: true }, 'error') }
    return { status: 200, body: buildRobinhoodRouteBody(wallet, out.x), audit: audit({ joinedInFlight: true, reusedCanonicalResult: true, resultAgeMs: 0 }, 'served') }
  }

  // 1) The page's request for a known job: serve that job's result, wait for it, or say pending. Never scan.
  if (jobId) {
    const joined = await joinLocal()
    if (joined) return joined
    const r = await waitForRecord(wallet, (x) => x.jobId === jobId, deadline, params)
    return r ? fromRecord(r, true) : pending('queued_or_running', { joinedInFlight: true })
  }

  // 2) No job: a fresh finished result is served; a live scan is joined/waited on.
  const rec = await readRobinhoodScanRecord(wallet)
  if (rec?.state === 'done' && rec.body && !params.refresh && now() - (rec.completedAt ?? 0) < ROBINHOOD_SCAN_RESULT_FRESH_MS) return fromRecord(rec, false)
  const joined = await joinLocal()
  if (joined) return joined
  if (rec && leaseLive(rec, now())) {
    const marker = { jobId: rec.jobId, queuedAt: rec.queuedAt, startedAt: rec.startedAt }
    const r = await waitForRecord(wallet, (x) => (marker.jobId != null ? x.jobId === marker.jobId : x.startedAt === marker.startedAt), deadline, params)
    return r ? fromRecord(r, true) : pending(rec.state, { canonicalJobId: rec.jobId, joinedInFlight: true })
  }

  // 3) Nothing queued, running or fresh (direct navigation / explicit refresh): one bounded standalone scan.
  const started = runProviderScan(wallet, fetchImpl, null, 'standalone', params)
  started.catch(() => {})
  const out = await raceDeadline(started)
  if (out === 'timeout') return pending('running', { startedNewRobinhoodProviderScan: true })
  if ('e' in out) return { status: 502, body: { error: { message: `Robinhood scan failed: ${out.e instanceof Error ? out.e.message : String(out.e)}`, category: 'provider' } }, audit: audit({ startedNewRobinhoodProviderScan: true }, 'error') }
  return { status: 200, body: buildRobinhoodRouteBody(wallet, out.x.result), audit: audit({ startedNewRobinhoodProviderScan: !out.x.joined, joinedInFlight: out.x.joined, resultAgeMs: 0 }, 'served') }
}
