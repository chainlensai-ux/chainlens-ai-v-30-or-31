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
// GENERATION-AWARE IN-FLIGHT: one entry per wallet, tagged with the job (generation) that owns it. A caller of
// the same generation joins it; a caller for a DIFFERENT job (a newer Rescan) never adopts it as its own
// result — it waits for that scan to settle, then runs its own (see runProviderScan). jobId null = a
// standalone/orchestrator scan, which any jobless caller may join.
type InFlightScan = { jobId: string | null; promise: Promise<RobinhoodScanResult> }
const inFlight = new Map<string, InFlightScan>()
/** A caller may adopt an in-flight scan only if it belongs to the same job; jobless callers may join any. */
const mayJoin = (entry: InFlightScan, jobId: string | null) => jobId == null || entry.jobId === jobId
let providerScanCount = 0

export function getRobinhoodProviderScanCount(): number { return providerScanCount }
/** Test hook. */
export function __resetRobinhoodScanCoordinatorForTest(): void { providerScanCount = 0; inFlight.clear(); transitionChains.clear() }

export async function readRobinhoodScanRecord(wallet: string): Promise<RobinhoodScanRecord | null> {
  const r = await getTokenCache<RobinhoodScanRecord>(recordKey(wallet)).catch(() => null)
  return r && r.v === 1 && r.wallet === wallet.toLowerCase() ? r : null
}
async function writeRecord(rec: RobinhoodScanRecord): Promise<void> {
  await setTokenCache(recordKey(rec.wallet), rec, RECORD_TTL_SECONDS).catch(() => {})
}

// ── Monotonic transitions ─────────────────────────────────────────────────────────────────────────
// One scan's record only moves forward: queued → running → done | error, never backwards and never a
// repeat. Another scan (a different job, or a different standalone run) may replace the record only as a
// newer generation (`queuedAt`), and never while that other scan is live — except a strictly newer queued
// marker (a newer user Rescan) superseding it. A running/done write from a different scan never replaces a
// live queued marker: that marker's own worker is coming.
//
// CONCURRENCY LIMITS, DISCLOSED: tokenCache exposes only get/set (no SET NX / compare-and-set), so this is
// read-decide-write. Transitions for a wallet are serialized within one process (a per-wallet promise
// chain); across instances two writers can still interleave between read and write. The ordering at the
// call sites removes the race this guards against in the normal flow: POST writes the queued marker
// BEFORE enqueueing the job, so the job's worker cannot exist yet when the marker is written.
const STATE_RANK: Record<RobinhoodScanRecord['state'], number> = { queued: 0, running: 1, done: 2, error: 2 }
const sameScan = (a: RobinhoodScanRecord, b: RobinhoodScanRecord) =>
  a.jobId != null ? a.jobId === b.jobId : b.jobId == null && a.startedAt != null && a.startedAt === b.startedAt

export type RobinhoodScanTransition = { applied: boolean; reason: 'no_record' | 'forward' | 'newer_generation' | 'would_regress_or_repeat' | 'live_other_scan' | 'older_generation'; current: RobinhoodScanRecord | null }

/** PURE. Whether `next` may replace `current`. */
export function decideRobinhoodScanTransition(current: RobinhoodScanRecord | null, next: RobinhoodScanRecord, nowMs: number): Omit<RobinhoodScanTransition, 'current'> {
  if (!current) return { applied: true, reason: 'no_record' }
  if (sameScan(current, next)) return STATE_RANK[next.state] > STATE_RANK[current.state] ? { applied: true, reason: 'forward' } : { applied: false, reason: 'would_regress_or_repeat' }
  if (leaseLive(current, nowMs)) {
    return next.state === 'queued' && next.queuedAt > current.queuedAt
      ? { applied: true, reason: 'newer_generation' }
      : { applied: false, reason: 'live_other_scan' }
  }
  return next.queuedAt >= current.queuedAt ? { applied: true, reason: 'newer_generation' } : { applied: false, reason: 'older_generation' }
}

const transitionChains = new Map<string, Promise<unknown>>()
/** Read-decide-write, serialized per wallet in this process. */
export async function transitionRobinhoodScanRecord(next: RobinhoodScanRecord, nowMs: number = Date.now()): Promise<RobinhoodScanTransition> {
  const key = next.wallet
  const prev = transitionChains.get(key) ?? Promise.resolve()
  const step = prev.catch(() => {}).then(async (): Promise<RobinhoodScanTransition> => {
    const current = await readRobinhoodScanRecord(key)
    const d = decideRobinhoodScanTransition(current, next, nowMs)
    if (d.applied) await writeRecord(next)
    else console.warn('[robinhood-scan-transition-rejected]', { wallet: key, jobId: next.jobId, next: next.state, current: current?.state ?? null, currentJobId: current?.jobId ?? null, reason: d.reason })
    return { ...d, current }
  })
  transitionChains.set(key, step)
  try {
    return await step
  } finally {
    if (transitionChains.get(key) === step) transitionChains.delete(key)
  }
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

const leaseLive = (r: RobinhoodScanRecord, now: number) => (r.state === 'queued' || r.state === 'running') && now - (r.startedAt ?? r.queuedAt) < ROBINHOOD_SCAN_LEASE_MS

/**
 * POST /api/wallet-scan, BEFORE enqueueing the job: the job will scan Robinhood — mark it so no other path
 * starts a second scan. Never overwrites running/done/error of this job, nor a newer job's record.
 */
export async function markRobinhoodScanQueued(wallet: string, jobId: string, now: number = Date.now()): Promise<RobinhoodScanTransition> {
  return transitionRobinhoodScanRecord({ v: 1, wallet: wallet.toLowerCase(), state: 'queued', jobId, owner: 'worker', queuedAt: now, startedAt: null, completedAt: null, body: null, error: null }, now)
}

/** The job was never enqueued: close its queued marker (queued → error) so nothing waits on it. */
export async function markRobinhoodScanEnqueueFailed(wallet: string, jobId: string, queuedAt: number, now: number = Date.now()): Promise<RobinhoodScanTransition> {
  return transitionRobinhoodScanRecord({ v: 1, wallet: wallet.toLowerCase(), state: 'error', jobId, owner: 'worker', queuedAt, startedAt: null, completedAt: now, body: null, error: 'enqueue_failed' }, now)
}

type Opts = { scan?: RobinhoodScanFn; now?: () => number; sleep?: (ms: number) => Promise<void> }
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Runs THE provider scan for this wallet (joining one already in flight in this process) and records it. */
async function runProviderScan(wallet: string, fetchImpl: typeof fetch, jobId: string | null, owner: RobinhoodScanOwner, opts: Opts): Promise<{ result: RobinhoodScanResult; joined: boolean }> {
  const key = wallet.toLowerCase()
  // Same generation joins; an older generation is waited out (its result is never adopted), then re-checked.
  for (let existing = inFlight.get(key); existing; existing = inFlight.get(key)) {
    if (mayJoin(existing, jobId)) return { result: await existing.promise, joined: true }
    await existing.promise.catch(() => {})
    if (inFlight.get(key) === existing) inFlight.delete(key)
  }
  const now = opts.now ?? Date.now
  const scan = opts.scan ?? scanRobinhoodWallet
  const run = (async () => {
    providerScanCount += 1
    const startedAt = now()
    // Keep this job's generation: its own queued marker's time when present, else now.
    const marker = jobId != null ? await readRobinhoodScanRecord(key) : null
    const queuedAt = marker && marker.jobId === jobId ? marker.queuedAt : startedAt
    const rec = (state: RobinhoodScanRecord['state'], extra: Partial<RobinhoodScanRecord>): RobinhoodScanRecord =>
      ({ v: 1, wallet: key, state, jobId, owner, queuedAt, startedAt, completedAt: null, body: null, error: null, ...extra })
    await transitionRobinhoodScanRecord(rec('running', {}), now())
    try {
      const result = await scan(wallet, fetchImpl)
      await transitionRobinhoodScanRecord(rec('done', { completedAt: now(), body: buildRobinhoodRouteBody(wallet, result) }), now())
      return result
    } catch (err) {
      await transitionRobinhoodScanRecord(rec('error', { completedAt: now(), error: err instanceof Error ? err.message : String(err) }), now())
      throw err
    }
  })()
  const entry: InFlightScan = { jobId, promise: run }
  inFlight.set(key, entry)
  try {
    return { result: await run, joined: false }
  } finally {
    if (inFlight.get(key) === entry) inFlight.delete(key)
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
  const live = inFlight.get(wallet.toLowerCase())
  if (live && mayJoin(live, params.jobId)) {
    const { result } = await runProviderScan(wallet, fetchImpl, params.jobId, params.owner, params)
    logDedup({ ...base, reusedCanonicalResult: false, joinedInFlight: true, startedNewRobinhoodProviderScan: false, providerScanCount, resultAgeMs: 0, outcome: 'served' })
    return result
  }
  const rec = await readRobinhoodScanRecord(wallet)
  if (rec?.state === 'done' && rec.body && (params.reuseFreshMs ?? 0) > 0 && now() - (rec.completedAt ?? 0) < params.reuseFreshMs!) {
    logDedup({ ...base, reusedCanonicalResult: true, joinedInFlight: false, startedNewRobinhoodProviderScan: false, providerScanCount, resultAgeMs: now() - (rec.completedAt ?? 0), outcome: 'served' })
    return robinhoodScanResultFromBody(rec.body)
  }
  // Another instance is scanning this wallet right now (state running, not our own queued marker). Wait it
  // out either way; only a jobless caller may adopt its result — a job runs its own generation's scan.
  if (rec && rec.state === 'running' && leaseLive(rec, now()) && rec.jobId !== params.jobId) {
    const started = rec.startedAt
    const done = await waitForRecord(wallet, (r) => r.startedAt === started, (rec.startedAt ?? now()) + ROBINHOOD_SCAN_LEASE_MS, params)
    if (params.jobId == null && done?.state === 'done' && done.body) {
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
    // A job-backed request only ever reads its own job's scan, never an older generation's result.
    if (!local || !mayJoin(local, jobId)) return null
    const out = await raceDeadline(local.promise)
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
