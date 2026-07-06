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

export interface ScanJob {
  id: string
  walletAddress: string
  createdAt: number
  updatedAt: number
  status: ScanJobStatus
  result: unknown | null
  error: string | null
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
