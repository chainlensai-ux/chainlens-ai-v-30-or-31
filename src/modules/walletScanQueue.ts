import { after } from 'next/server'
import { kv } from '@/lib/server/kv'
import {
  walletScanClaimLockKey,
  walletScanJobKey,
  walletScanPendingJobKey,
  walletScanPendingKey,
  walletScanResultKey,
} from '@/src/modules/walletScanQueueKeys'

export {
  walletScanClaimLockKey,
  walletScanJobKey,
  walletScanPendingJobKey,
  walletScanPendingKey,
  walletScanResultKey,
} from '@/src/modules/walletScanQueueKeys'

export type WalletScanJobStatus = 'queued' | 'running' | 'done' | 'failed'

// STAGE PROGRESS, DISCLOSED (perceived-speed follow-up task, explicit requirement: "Split UI stages
// clearly" / never leave the user staring at a blank/generic spinner for the whole scan). Real,
// already-existing per-module checkpoints (workers/walletScanV2.ts's own reportProgress, and one
// added checkpoint before the core FIFO/PnL/manifest call) — never a fabricated timer-based guess.
// `elapsedMs` is a real `Date.now() - scanStartedAt` delta, stamped at the moment this stage began.
export type WalletScanJobProgress = {
  stage: string
  label: string
  elapsedMs: number
}

// PARTIAL SNAPSHOT, DISCLOSED (fast-snapshot architecture-audit task): real portfolio/holdings data,
// computed by the SAME single fetchAllHoldings/priceHoldings/buildPortfolio call the final result
// already uses (see workers/walletScanV2.ts's own fast-snapshot header) — never a fabricated or
// re-fetched value. Intentionally a SMALL, display-shaped subset (never the full holdings array) to
// keep this write cheap and to avoid the final result's own shape leaking into the poll response
// early in a way a caller might mistake for the complete report.
export type WalletScanPartialSnapshot = {
  portfolioTotalValueUsd: number | null
  /** What is known about the EVM value (lib/walletScan/portfolioEvidence.ts) — distinguishes verified $0 from unknown. */
  portfolioEvidence?: import('../../lib/walletScan/portfolioEvidence').PortfolioEvidence | null
  /** Fresh vs recent-verified vs unpriced support for the EVM value (lib/engine/modules/pricing/types.ts). */
  portfolioPricingEvidence?: import('../../lib/engine/modules/pricing/types').PortfolioPricingEvidence | null
  holdingsCount: number
  topHoldings: Array<{ chainId: number; tokenAddress: string; symbol: string; valueUsd: number | null }>
  activeChainIds: number[]
  publishedAtElapsedMs: number
}

export type WalletScanJobMetadata = {
  jobId: string
  userId: string
  wallet: string
  status: WalletScanJobStatus
  createdAt: number
  updatedAt: number
  chains?: string[]
  scanMode?: 'normal' | 'deep'
  ip?: string
  error?: string
  finishedAt?: number
  progress?: WalletScanJobProgress
  partial?: WalletScanPartialSnapshot
  // ADDED, DISCLOSED (Wallet Scanner chain selection fix, worker level): whether the ORIGINAL
  // client request asked for Robinhood Chain — see workers/walletScanV2.ts's own header for why
  // this can't be recovered from `chains` alone (Robinhood is filtered out of `chains` before it
  // ever reaches this queue, since enqueueWalletScanJob/runValidatedScanRequest are EVM-only).
  // Optional/defaults to false in every reader below — purely additive, no existing job record
  // written before this task loses meaning.
  includeRobinhoodRequested?: boolean
  /** Follow-up job that runs the V2 analysis modules a heavy wallet's first job deferred. */
  heavyWalletFollowUp?: boolean
  // WATCHDOG (see superviseWalletScanJob): when a worker claimed the job, its latest heartbeat, and how
  // often / when the job was (re)triggered while still queued.
  claimedAt?: number
  heartbeatAt?: number
  triggerAttempts?: number
  lastTriggerAt?: number
}

export type WalletScanJobPayload = {
  jobId: string
  userId: string
  walletAddress: string
  chains: string[]
  scanMode: 'normal' | 'deep'
  ip: string
  // Optional, DISCLOSED: defaults to false in enqueueWalletScanJob below — every existing caller
  // (walletScanOrchestrator.ts's deep-mode enqueue, this file's own tests) that doesn't pass it
  // keeps byte-identical behavior (no Robinhood inclusion at the worker level, same as before this
  // task), purely additive for app/api/wallet-scan/route.ts, which now does pass it.
  includeRobinhoodRequested?: boolean
  /** See WalletScanJobMetadata.heavyWalletFollowUp. */
  heavyWalletFollowUp?: boolean
}

const JOB_TTL_SECONDS = 30 * 60

export const WALLET_SCAN_QUEUE_UNAVAILABLE = { error: 'scan-queue-unavailable' } as const
export const WALLET_SCAN_STATUS_UNAVAILABLE = { error: 'scan-status-unavailable' } as const

export type EnqueueStage = 'kv_not_configured' | 'write_job_record' | 'write_pending_flag' | 'read_pending_list' | 'write_pending_list'

export class WalletScanQueueUnavailableError extends Error {
  /** Which enqueue/claim step failed, and the underlying KV/Redis error text (logged, never sent to the client). */
  stage?: EnqueueStage
  detail?: string
  constructor(message = 'scan-queue-unavailable', info: { stage?: EnqueueStage; detail?: string } = {}) {
    super(message)
    this.name = 'WalletScanQueueUnavailableError'
    this.stage = info.stage
    this.detail = info.detail
  }
}

/** The underlying KV/Redis error as text: message plus any status/code/body the client attached. */
export function describeKvError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const extra = err as Error & { status?: unknown; code?: unknown; cause?: unknown; response?: unknown }
  const parts = [`${err.name}: ${err.message}`]
  if (extra.status != null) parts.push(`status=${String(extra.status)}`)
  if (extra.code != null) parts.push(`code=${String(extra.code)}`)
  if (extra.cause != null) parts.push(`cause=${extra.cause instanceof Error ? extra.cause.message : String(extra.cause)}`)
  return parts.join(' | ').slice(0, 1000)
}

export class WalletScanStatusUnavailableError extends Error {
  constructor(message = 'scan-status-unavailable') {
    super(message)
    this.name = 'WalletScanStatusUnavailableError'
  }
}

export function walletScanRedisConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
}

function assertWalletScanRedisConfigured(kind: 'queue' | 'status'): void {
  if (walletScanRedisConfigured()) return
  if (kind === 'queue') throw new WalletScanQueueUnavailableError('KV is not configured', { stage: 'kv_not_configured' })
  throw new WalletScanStatusUnavailableError('KV is not configured')
}

function queueUnavailable(err: unknown, stage?: EnqueueStage): WalletScanQueueUnavailableError {
  return err instanceof WalletScanQueueUnavailableError
    ? err
    : new WalletScanQueueUnavailableError(err instanceof Error ? err.message : String(err), { stage, detail: describeKvError(err) })
}

function statusUnavailable(err: unknown): WalletScanStatusUnavailableError {
  return err instanceof WalletScanStatusUnavailableError
    ? err
    : new WalletScanStatusUnavailableError(err instanceof Error ? err.message : String(err))
}

function logQueueFailure(label: string, err: unknown): void {
  console.error(label, err)
}

export async function writeWalletScanJob(job: WalletScanJobMetadata): Promise<void> {
  assertWalletScanRedisConfigured('queue')
  try {
    await kv.set(walletScanJobKey(job.jobId), { ...job, updatedAt: Date.now() }, { ex: JOB_TTL_SECONDS })
  } catch (err) {
    logQueueFailure('[wallet-scan-queue] write-job-failure', err)
    throw queueUnavailable(err, 'write_job_record')
  }
}

export async function readWalletScanJob(jobId: string): Promise<WalletScanJobMetadata | null> {
  assertWalletScanRedisConfigured('status')
  try {
    return await kv.get<WalletScanJobMetadata>(walletScanJobKey(jobId))
  } catch (err) {
    logQueueFailure('[wallet-scan-queue] read-job-failure', err)
    throw statusUnavailable(err)
  }
}

// BEST-EFFORT PROGRESS UPDATE, DISCLOSED (perceived-speed follow-up task): a plain read-modify-write
// over the SAME job record `claimWalletScanPayload` already maintains during the running phase —
// no new storage primitive, no new KV client. NOT atomic under concurrent writes (same accepted
// tradeoff as src/modules/scanJobs.ts's own setJobProgress) — a dropped/stale progress update never
// affects `status`/the final result, which the worker's own `publishFinal` still writes directly and
// unconditionally once the scan completes. Never throws — a missing job, unconfigured KV, or a
// transient failure is a silent no-op; there is nothing useful to update and the real scan must
// never be slowed or blocked by an observability write.
export async function updateWalletScanJobProgress(jobId: string, progress: WalletScanJobProgress): Promise<void> {
  if (!walletScanRedisConfigured() || finalizingJobIds.has(jobId)) return
  return trackJobRecordWrite(jobId, (async () => {
    try {
      const job = await kv.get<WalletScanJobMetadata>(walletScanJobKey(jobId))
      if (!job || isTerminalJob(job) || finalizingJobIds.has(jobId)) return
      await kv.set(walletScanJobKey(jobId), { ...job, progress, heartbeatAt: Date.now(), updatedAt: Date.now() }, { ex: JOB_TTL_SECONDS })
    } catch (err) {
      logQueueFailure('[wallet-scan-queue] update-progress-failure', err)
    }
  })())
}

// OVERWRITE ORDER GUARD (repeated-scan portfolio-value audit): progress and partial-snapshot writes are
// read-modify-write and were fire-and-forget (`void updateWalletScanJobProgress(...)` for the 'finalizing'
// stage right before publishFinal). One that read the job while it was still running and landed AFTER
// publishFinal's terminal write restored `status: 'running'` plus the older partial snapshot over the final
// record. Now: every such write is tracked per job; publishFinal first marks the job finalizing (later writes
// are refused) and drains the in-flight ones before writing; a write that reads a terminal job is a no-op.
const finalizingJobIds = new Set<string>()
const pendingJobRecordWrites = new Map<string, Set<Promise<void>>>()
const MAX_FINALIZING_TRACKED = 1_000

function isTerminalJob(job: WalletScanJobMetadata): boolean {
  return job.status === 'done' || job.status === 'failed'
}

function trackJobRecordWrite(jobId: string, write: Promise<void>): Promise<void> {
  let set = pendingJobRecordWrites.get(jobId)
  if (!set) { set = new Set(); pendingJobRecordWrites.set(jobId, set) }
  set.add(write)
  return write.finally(() => {
    const s = pendingJobRecordWrites.get(jobId)
    s?.delete(write)
    if (s && s.size === 0) pendingJobRecordWrites.delete(jobId)
  })
}

/** Called by publishFinal before its terminal writes: refuse further partial/progress writes, drain in-flight ones. */
export async function beginWalletScanJobFinalization(jobId: string): Promise<void> {
  finalizingJobIds.add(jobId)
  if (finalizingJobIds.size > MAX_FINALIZING_TRACKED) {
    const oldest = finalizingJobIds.values().next().value
    if (oldest !== undefined && oldest !== jobId) finalizingJobIds.delete(oldest)
  }
  await Promise.all([...(pendingJobRecordWrites.get(jobId) ?? [])])
}

// BEST-EFFORT PARTIAL-SNAPSHOT PUBLISH, DISCLOSED (fast-snapshot architecture-audit task): same
// read-modify-write convention as updateWalletScanJobProgress above, on the same job record. A real
// early portfolio/holdings snapshot the poll route can surface WHILE the core FIFO/PnL/manifest
// scan is still running — see workers/walletScanV2.ts's own header for how it is computed (in
// parallel with, never blocked by, the core scan) and never a fabricated/guessed value. `publishFinal`
// (src/modules/walletScanWorker.ts) overwrites this ENTIRE job record with the terminal result once
// the scan completes, so `partial` — like `progress` — naturally disappears the moment a real final
// result exists; there is no separate "clear partial" step to forget. Never throws.
export async function publishWalletScanPartialSnapshot(jobId: string, partial: WalletScanPartialSnapshot): Promise<void> {
  if (!walletScanRedisConfigured() || finalizingJobIds.has(jobId)) return
  return trackJobRecordWrite(jobId, (async () => {
    try {
      const job = await kv.get<WalletScanJobMetadata>(walletScanJobKey(jobId))
      if (!job || isTerminalJob(job) || finalizingJobIds.has(jobId)) return
      // Monotonic: an older partial snapshot never replaces a newer one already on the record.
      if (job.partial && job.partial.publishedAtElapsedMs > partial.publishedAtElapsedMs) return
      await kv.set(walletScanJobKey(jobId), { ...job, partial, heartbeatAt: Date.now(), updatedAt: Date.now() }, { ex: JOB_TTL_SECONDS })
    } catch (err) {
      logQueueFailure('[wallet-scan-queue] publish-partial-snapshot-failure', err)
    }
  })())
}

export async function readWalletScanResult(jobId: string): Promise<unknown | null> {
  assertWalletScanRedisConfigured('status')
  try {
    return await kv.get(walletScanResultKey(jobId))
  } catch (err) {
    logQueueFailure('[wallet-scan-queue] read-result-failure', err)
    throw statusUnavailable(err)
  }
}



const CLAIM_LOCK_TTL_SECONDS = 10 * 60

async function acquireClaimLock(jobId: string): Promise<boolean> {
  try {
    return await kv.setIfAbsent(walletScanClaimLockKey(jobId), Date.now(), CLAIM_LOCK_TTL_SECONDS)
  } catch (err) {
    // The status check above still guards duplicates; never strand a job because the lock write failed.
    logQueueFailure('[wallet-scan-queue] claim-lock-failure', { jobId, error: describeKvError(err) })
    return true
  }
}

export async function claimWalletScanPayload(jobId: string): Promise<WalletScanJobPayload | null> {
  assertWalletScanRedisConfigured('queue')
  // KEY HELPER, FIXED (audit: key consistency): this previously rebuilt the job key as an inline
  // template literal — the one place in the whole enqueue/worker/poll chain that bypassed
  // walletScanJobKey(), so a future prefix change would silently desynchronize the claim path.
  const jobKey = walletScanJobKey(jobId)
  const pendingJobKey = walletScanPendingJobKey(jobId)

  let job: WalletScanJobMetadata | null
  try {
    job = await kv.get<WalletScanJobMetadata>(jobKey)
  } catch (err) {
    logQueueFailure('[wallet-scan-queue] claim-read-job-failure', err)
    throw queueUnavailable(err)
  }

  if (!job) return null

  // IDEMPOTENCY GUARD, FIXED (audit: duplicate worker invocation): a repeated worker invocation
  // for a job that already reached a terminal state previously re-claimed it (rewriting status
  // back to 'running') and re-ran the entire expensive scan, overwriting the already-published
  // result. A terminal job is now never re-claimed — the repeat invocation gets null (the same
  // "nothing to do" the worker route already reports as not-found) and the original result stays
  // exactly as published.
  if (job.status === 'done' || job.status === 'failed') return null
  // A job is claimed exactly once: the poll route may re-trigger a queued job, so a second worker
  // invocation for a job another worker already runs (status 'running', or the NX lock is taken)
  // gets null instead of starting a duplicate scan.
  if (job.status === 'running') return null
  if (!(await acquireClaimLock(jobId))) return null

  try {
    const claimedAt = Date.now()
    await kv.set(jobKey, { ...job, status: 'running', claimedAt, heartbeatAt: claimedAt, updatedAt: claimedAt }, { ex: JOB_TTL_SECONDS })
    await kv.set(pendingJobKey, false, { ex: 60 })
    const pending = (await kv.get<string[]>(walletScanPendingKey())) ?? []
    await kv.set(walletScanPendingKey(), pending.filter((pendingJobId) => pendingJobId !== jobId), { ex: JOB_TTL_SECONDS })
  } catch (err) {
    logQueueFailure('[wallet-scan-queue] claim-write-running-job-failure', err)
    throw queueUnavailable(err)
  }

  return {
    jobId,
    userId: job.userId,
    walletAddress: job.wallet,
    chains: job.chains ?? ['base', 'eth'],
    scanMode: job.scanMode ?? 'normal',
    ip: job.ip ?? 'unknown',
    includeRobinhoodRequested: job.includeRobinhoodRequested ?? false,
    ...(job.heavyWalletFollowUp ? { heavyWalletFollowUp: true } : {}),
  }
}

export async function claimNextWalletScanPayload(): Promise<WalletScanJobPayload | null> {
  assertWalletScanRedisConfigured('queue')
  let pending: string[]
  try {
    pending = (await kv.get<string[]>(walletScanPendingKey())) ?? []
  } catch (err) {
    logQueueFailure('[wallet-scan-queue] claim-read-pending-failure', err)
    throw queueUnavailable(err)
  }
  const [jobId, ...remaining] = pending
  if (!jobId) return null

  try { await kv.set(walletScanPendingKey(), remaining, { ex: JOB_TTL_SECONDS }) } catch (err) { logQueueFailure('[wallet-scan-queue] claim-write-pending-failure', err); throw queueUnavailable(err) }

  const job = await readWalletScanJob(jobId).catch((err) => { throw queueUnavailable(err) })
  if (!job) return null
  if (job.status === 'done' || job.status === 'failed' || job.status === 'running') return null
  if (!(await acquireClaimLock(jobId))) return null

  try { await kv.set(walletScanPendingJobKey(jobId), false, { ex: 60 }) } catch (err) { logQueueFailure('[wallet-scan-queue] claim-write-pending-job-failure', err); throw queueUnavailable(err) }

  try { const claimedAt = Date.now(); await kv.set(walletScanJobKey(jobId), { ...job, status: 'running', claimedAt, heartbeatAt: claimedAt, updatedAt: claimedAt }, { ex: JOB_TTL_SECONDS }) } catch (err) { logQueueFailure('[wallet-scan-queue] claim-write-running-job-failure', err); throw queueUnavailable(err) }

  return {
    jobId,
    userId: job.userId,
    walletAddress: job.wallet,
    chains: job.chains ?? ['base', 'eth'],
    scanMode: job.scanMode ?? 'normal',
    ip: job.ip ?? 'unknown',
    includeRobinhoodRequested: job.includeRobinhoodRequested ?? false,
    ...(job.heavyWalletFollowUp ? { heavyWalletFollowUp: true } : {}),
  }
}

export type WorkerTriggerOutcome =
  | { kind: 'dispatched'; waitedMs: number }
  | { kind: 'responded'; status: number; waitedMs: number }
  | { kind: 'error'; message: string; waitedMs: number }
  | { kind: 'not_configured' }

// The worker route only responds when its whole job has finished (up to ~300s). Awaiting that response
// here held the enqueue request open for the entire scan — and, for a follow-up queued from inside a
// worker, held THAT worker past its maxDuration before it could publish (a killed job left 'running',
// the enqueue request a non-JSON 504 → the client's 'scan-enqueue-failed'). Now the request is sent,
// we wait only until it is dispatched (or answers quickly, e.g. 401/503), and after() keeps the
// in-flight request alive past this response without blocking it.
export const WORKER_TRIGGER_DISPATCH_WAIT_MS = 1_500

export async function triggerWalletScanWorker(jobId: string, deps: { fetchImpl?: typeof fetch; keepAlive?: (work: Promise<unknown>) => void; dispatchWaitMs?: number } = {}): Promise<WorkerTriggerOutcome> {
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000'
  const workerSecret = process.env.WALLET_SCAN_WORKER_SECRET
  if (!workerSecret) {
    console.error('[walletScanQueue] WALLET_SCAN_WORKER_SECRET is not configured; worker trigger denied')
    return { kind: 'not_configured' }
  }
  const startedAt = Date.now()
  const fetchImpl = deps.fetchImpl ?? fetch
  const request: Promise<WorkerTriggerOutcome> = fetchImpl(`${base}/api/wallet-scan/worker`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${workerSecret}` },
    body: JSON.stringify({ jobId }),
  }).then(
    (res) => ({ kind: 'responded' as const, status: res.status, waitedMs: Date.now() - startedAt }),
    (err) => ({ kind: 'error' as const, message: err instanceof Error ? err.message : String(err), waitedMs: Date.now() - startedAt }),
  )
  const keepAlive = deps.keepAlive ?? ((work: Promise<unknown>) => {
    // Outside a request scope (scripts, tests) after() throws; the request simply runs to completion.
    try { after(() => work.then(() => undefined)) } catch { /* no request scope */ }
  })
  keepAlive(request.then((outcome) => {
    if (outcome.kind !== 'responded' || outcome.status >= 400) {
      console.warn('[walletScanQueue] worker trigger finished unsuccessfully', { jobId, ...outcome })
    }
  }))
  let timer: ReturnType<typeof setTimeout> | undefined
  const dispatched = new Promise<WorkerTriggerOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'dispatched', waitedMs: Date.now() - startedAt }), deps.dispatchWaitMs ?? WORKER_TRIGGER_DISPATCH_WAIT_MS)
  })
  const outcome = await Promise.race([request, dispatched])
  if (timer) clearTimeout(timer)
  // Enqueue never fails on the trigger: the persisted pending job stays in KV for the next worker run.
  if (outcome.kind === 'error' || (outcome.kind === 'responded' && outcome.status >= 400)) {
    console.warn('[walletScanQueue] failed to trigger background worker', { jobId, ...outcome })
  }
  return outcome
}

export async function enqueueWalletScanJob(jobId: string, payload: WalletScanJobPayload): Promise<void> {
  assertWalletScanRedisConfigured('queue')
  const now = Date.now()
  await writeWalletScanJob({
    jobId,
    userId: payload.userId,
    wallet: payload.walletAddress,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    chains: payload.chains,
    scanMode: payload.scanMode,
    ip: payload.ip,
    includeRobinhoodRequested: payload.includeRobinhoodRequested ?? false,
    ...(payload.heavyWalletFollowUp ? { heavyWalletFollowUp: true } : {}),
  })
  let stage: EnqueueStage = 'write_pending_flag'
  let pendingCount = 0
  try {
    await kv.set(walletScanPendingJobKey(jobId), true, { ex: JOB_TTL_SECONDS })
    stage = 'read_pending_list'
    const stored = await kv.get<unknown>(walletScanPendingKey())
    // A malformed or oversized list (ids of jobs that were never claimed) can never block a new job:
    // keep only string ids, dedupe, and cap to the newest MAX_PENDING_JOB_IDS.
    const pending = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []
    const next = [...new Set([...pending, jobId])].slice(-MAX_PENDING_JOB_IDS)
    pendingCount = next.length
    stage = 'write_pending_list'
    await kv.set(walletScanPendingKey(), next, { ex: JOB_TTL_SECONDS })
  } catch (err) {
    logQueueFailure('[wallet-scan-queue] enqueue-pending-failure', { jobId, stage, error: describeKvError(err) })
    throw queueUnavailable(err, stage)
  }
  const trigger = await triggerWalletScanWorker(jobId)
  console.warn('[wallet-scan-queue] enqueued', { jobId, followUp: payload.heavyWalletFollowUp === true, pendingCount, trigger })
}

export const MAX_PENDING_JOB_IDS = 200

// ── WATCHDOG ──────────────────────────────────────────────────────────────────────────────────────
// A queued job nobody claims, or a running job whose worker stopped heart-beating, is never left
// spinning: the poll route (app/api/wallet-scan/[jobId]/route.ts) asks superviseWalletScanJob on every
// poll, re-triggers a queued job a few times (claim is NX-locked, so a duplicate trigger is harmless),
// and marks it failed with a clear code once it has gone WALLET_SCAN_WATCHDOG_MS without progress.
export const WALLET_SCAN_WATCHDOG_MS = 90_000
export const WALLET_SCAN_HEARTBEAT_INTERVAL_MS = 20_000
export const WALLET_SCAN_RETRIGGER_AFTER_MS = 8_000
export const WALLET_SCAN_MAX_TRIGGER_ATTEMPTS = 5

export type WalletScanWatchdogFailure = 'worker_not_started' | 'worker_stalled'
export type WalletScanSupervision =
  | { action: 'none' }
  | { action: 'retrigger'; attempt: number }
  | { action: 'fail'; error: WalletScanWatchdogFailure; silentForMs: number }

/** PURE. What the poll route should do about a non-terminal job right now. */
export function superviseWalletScanJob(job: WalletScanJobMetadata, now: number): WalletScanSupervision {
  if (job.status === 'done' || job.status === 'failed') return { action: 'none' }
  if (job.status === 'running') {
    const last = job.heartbeatAt ?? job.claimedAt ?? job.updatedAt ?? job.createdAt
    const silentForMs = now - last
    return silentForMs > WALLET_SCAN_WATCHDOG_MS ? { action: 'fail', error: 'worker_stalled', silentForMs } : { action: 'none' }
  }
  // queued
  const waitingMs = now - job.createdAt
  if (waitingMs > WALLET_SCAN_WATCHDOG_MS) return { action: 'fail', error: 'worker_not_started', silentForMs: waitingMs }
  const attempts = job.triggerAttempts ?? 0
  const sinceTrigger = now - (job.lastTriggerAt ?? job.createdAt)
  if (attempts < WALLET_SCAN_MAX_TRIGGER_ATTEMPTS && sinceTrigger >= WALLET_SCAN_RETRIGGER_AFTER_MS) return { action: 'retrigger', attempt: attempts + 1 }
  return { action: 'none' }
}

/** Records a re-trigger attempt on a still-queued job (best effort). */
export async function recordWalletScanRetrigger(job: WalletScanJobMetadata, attempt: number, now: number = Date.now()): Promise<void> {
  try {
    await kv.set(walletScanJobKey(job.jobId), { ...job, triggerAttempts: attempt, lastTriggerAt: now, updatedAt: now }, { ex: JOB_TTL_SECONDS })
  } catch (err) {
    logQueueFailure('[wallet-scan-queue] record-retrigger-failure', { jobId: job.jobId, error: describeKvError(err) })
  }
}

/** Marks a stuck job failed so its poller stops; a late worker publishFinal still overwrites it. */
export async function markWalletScanJobStalled(job: WalletScanJobMetadata, error: WalletScanWatchdogFailure, now: number = Date.now()): Promise<void> {
  try {
    await kv.set(walletScanJobKey(job.jobId), { ...job, status: 'failed', error, finishedAt: now, updatedAt: now }, { ex: JOB_TTL_SECONDS })
  } catch (err) {
    logQueueFailure('[wallet-scan-queue] mark-stalled-failure', { jobId: job.jobId, error: describeKvError(err) })
  }
}

/** Writes heartbeatAt on a running job (never over a finalizing/terminal one). Never throws. */
export async function heartbeatWalletScanJob(jobId: string): Promise<void> {
  if (!walletScanRedisConfigured() || finalizingJobIds.has(jobId)) return
  return trackJobRecordWrite(jobId, (async () => {
    try {
      const job = await kv.get<WalletScanJobMetadata>(walletScanJobKey(jobId))
      if (!job || isTerminalJob(job) || finalizingJobIds.has(jobId)) return
      await kv.set(walletScanJobKey(jobId), { ...job, heartbeatAt: Date.now() }, { ex: JOB_TTL_SECONDS })
    } catch (err) {
      logQueueFailure('[wallet-scan-queue] heartbeat-failure', { jobId, error: describeKvError(err) })
    }
  })())
}

/** Heartbeats every WALLET_SCAN_HEARTBEAT_INTERVAL_MS while a worker runs a job; returns the stopper. */
export function startWalletScanHeartbeat(jobId: string, intervalMs: number = WALLET_SCAN_HEARTBEAT_INTERVAL_MS): () => void {
  const timer = setInterval(() => { void heartbeatWalletScanJob(jobId) }, intervalMs)
  if (typeof timer === 'object' && timer && 'unref' in timer) (timer as { unref: () => void }).unref()
  return () => clearInterval(timer)
}
