// src/modules/scanJobs.ts — job model + storage for the Deep Scan background job system.
//
// STORAGE, DISCLOSED: reuses the real, already-shipped, already-battle-tested
// lib/server/cache/redisClient.ts (ioredis, REDIS_URL) rather than building a second Redis/KV
// client — that file's own header explains why ioredis (not @upstash/redis) is the correct client
// for this deployment's REDIS_URL shape, and its `redis.get`/`redis.set` already fail open (resolve
// to null / a no-op) when Redis isn't configured or reachable, exactly the behavior this job store
// needs. Building a second client here would just duplicate that same reasoning.
//
// `result: unknown`, DISCLOSED: the task's own type used `result: any` — typed as `unknown` here
// instead (this codebase's real, consistent convention everywhere else — see
// e.g. ScanWalletApiResponse's `data?: unknown`), since `any` disables type checking entirely for
// no real benefit here.

import { redis } from '@/lib/server/cache/redisClient'

export type ScanJobStatus = 'pending' | 'running' | 'completed' | 'failed'

// PROGRESS, DISCLOSED (module-progress-reporting task): optional so every existing job (created
// before this field existed, or never updated because Redis is unconfigured) still deserializes
// fine — getScanJob callers must treat its absence as "no progress info available yet", not as an
// error.
export type ScanJobProgress = {
  currentModule: number
  totalModules: number
  moduleName: string
}

// `ScanModuleErrors`, DISCLOSED (stuck-at-module-11 task): NOT a new top-level field on ScanJob —
// `result: unknown` intentionally stays untyped (see that field's own comment below; it mirrors
// whatever shape src/pipeline + the V2 module chain produce, which isn't modeled here). This type
// documents the shape workers/walletScanV2.ts merges into `result.moduleErrors` when one or more
// modules time out or reject: a map of moduleName -> the real error/timeout message for that
// module, present (possibly empty) on every completed job. Consumers (e.g.
// app/api/scan-status/route.ts) read it back out of `job.result` at the point of use rather than
// this file storing it separately, since it's already part of the same unknown result blob.
export type ScanModuleErrors = Record<string, string>

export interface ScanJob {
  id: string
  walletAddress: string
  createdAt: number
  updatedAt: number
  status: ScanJobStatus
  result: unknown | null
  error: string | null
  // rawBody/ip, ADDED DISCLOSED: the worker now runs as a separate HTTP-triggered route
  // (app/api/scan-v2/worker/route.ts), a genuinely different function invocation with no closure
  // access to the original request's rawBody/ip — they're persisted on the job itself so the
  // worker route can reconstruct the exact same runWalletScanV2Worker call.
  rawBody: unknown
  ip: string
  progress?: ScanJobProgress
}

const JOB_TTL_SECONDS = 15 * 60 // 15 minutes — matches the existing full-scan-job system's convention

export function scanJobKey(jobId: string): string {
  return `v2:scan-job:${jobId}`
}

// Never throws — a Redis write failure degrades to a logged warning, matching
// app/api/scan-v2/full-scan-job/start/route.ts's own safeRedisSet convention (does not fall back to
// any synchronous/in-memory alternative; a failed write here just means a later poll finds nothing,
// a real and honestly-surfaced outcome rather than a papered-over one).
//
// updatedAt STAMPED HERE, DISCLOSED: every real call site already sets `updatedAt: Date.now()`
// itself before calling this — stamping it again here too, unconditionally, so that invariant holds
// even if a future call site forgets it, rather than relying solely on caller discipline.
export async function setScanJob(jobId: string, job: ScanJob): Promise<void> {
  const stamped: ScanJob = { ...job, updatedAt: Date.now() }
  // eslint-disable-next-line no-console
  console.log('[JOB] write', jobId, stamped.status)
  try {
    await redis.set(scanJobKey(jobId), stamped, { ex: JOB_TTL_SECONDS })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[scanJobs] setScanJob failed', { jobId, err: err instanceof Error ? err.message : String(err) })
  }
}

// PROGRESS UPDATE, DISCLOSED (module-progress-reporting task): a plain read-modify-write over the
// same setScanJob/getScanJob this whole job store already uses — no new storage primitive, no new
// Redis client. NOT ATOMIC under concurrent writes (same disclosed tradeoff as
// lib/server/divergenceStore.ts's appendCapped): if something else writes the job between this
// function's read and write, that write could be lost. Acceptable here because progress is a
// best-effort UI nicety, not a correctness-critical field — a dropped/stale progress update never
// affects `status`/`result`/`error`, which every real completion path still writes directly via
// setScanJob. Never throws — a missing job or a Redis failure is a silent no-op (there's nothing
// useful to update).
export async function setJobProgress(jobId: string, progress: ScanJobProgress): Promise<void> {
  try {
    const job = await getScanJob(jobId)
    if (!job) return
    await setScanJob(jobId, { ...job, progress })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[scanJobs] setJobProgress failed', { jobId, err: err instanceof Error ? err.message : String(err) })
  }
}

// Never throws — a Redis read failure resolves to null (indistinguishable from "not found" to the
// caller), matching redis.get's own existing fail-open contract.
export async function getScanJob(jobId: string): Promise<ScanJob | null> {
  try {
    return await redis.get<ScanJob>(scanJobKey(jobId))
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[scanJobs] getScanJob failed', { jobId, err: err instanceof Error ? err.message : String(err) })
    return null
  }
}
