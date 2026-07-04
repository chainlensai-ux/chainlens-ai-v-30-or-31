// POST /api/scan-v2/full-scan-job/start — Background Job variant, step 1 (enqueue).
//
// Calls the exact same real orchestrator every other scan route uses
// (router.handleScanRequest, src/deployment/router.ts) — not a reimplementation. Never throws.
//
// REDIS MIGRATION, DISCLOSED: this route previously used lib/server/cache/tokenCache.ts's
// @vercel/kv-backed getTokenCache/setTokenCache, with a synchronous fallback when KV wasn't
// configured. Per explicit instruction, it now always uses the new lib/server/cache/redisClient.ts
// client (REDIS_URL — a real redis:// TCP connection string, per that file's own header on why
// ioredis, not @upstash/redis, is the correct client for it) and NEVER falls back to synchronous
// execution, even if Redis is unreachable. If Redis is down/misconfigured, `safeRedisSet` below
// degrades to a logged warning rather than throwing or silently switching back to sync mode — that
// failure is surfaced as a real, diagnosable job outcome (the job simply never reaches "done" for a
// later poll to find), per this task's explicit instruction not to paper over it with a fallback.
//
// HONEST LIMITS DISCLOSURE (unchanged): "no time limits" is not literally achievable on Vercel
// serverless — every plan has SOME upper bound on how long `after()` (Next.js's built-in
// background-work primitive) can keep running after a response is sent. What this genuinely fixes:
// the CLIENT's HTTP request no longer has to stay open for the full scan duration.

import { NextResponse, after } from 'next/server'
import { redis } from '@/lib/server/cache/redisClient'
import { router } from '@/src/deployment/index'

export type JobErrorShape = { message: string; category: string; details?: string[] }

export type FullScanJobResult =
  | { status: 'pending' }
  | { status: 'done'; success: true; data: unknown }
  | { status: 'done'; success: false; error: JobErrorShape }

const JOB_TTL_SECONDS = 15 * 60 // 15 minutes — enough headroom for reasonable polling

export function jobKey(jobId: string): string {
  return `v1:full-scan-job:${jobId}`
}

// Never throws — a Redis write failure (including the protocol mismatch disclosed in
// redisClient.ts's header) degrades to a logged warning, not a crashed request. Per this task's
// explicit instruction, this does NOT fall back to synchronous execution.
async function safeRedisSet(key: string, value: FullScanJobResult): Promise<void> {
  try {
    await redis.set(key, value, { ex: JOB_TTL_SECONDS })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[full-scan-job/start] redis.set failed', { key, err: err instanceof Error ? err.message : String(err) })
  }
}

async function runScanToJobResult(rawBody: unknown, ip: string): Promise<FullScanJobResult> {
  try {
    const result = await router.handleScanRequest(rawBody, ip)
    const body = result.body as { success: boolean; data?: unknown; error?: JobErrorShape }
    return body.success
      ? { status: 'done', success: true, data: body.data }
      : { status: 'done', success: false, error: body.error ?? { message: 'scan-failed', category: 'unknown' } }
  } catch (err) {
    // handleScanRequest already never throws internally, but this is a final backstop in case
    // something fails before/outside its own error handling.
    return {
      status: 'done',
      success: false,
      error: { message: 'job-failed', category: 'unknown', details: [err instanceof Error ? err.message : String(err)] },
    }
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const rawBody = await req.json().catch(() => null)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    const jobId = crypto.randomUUID()

    // Mark pending BEFORE returning, so an immediate poll never sees "not found" for a job that was
    // actually accepted. Always attempted, even if Redis is unreachable — see file header;
    // safeRedisSet degrades to a logged warning rather than throwing or falling back to sync mode.
    await safeRedisSet(jobKey(jobId), { status: 'pending' })

    // Runs AFTER this response is sent — the real mechanism that decouples the client's request
    // lifetime from the scan's actual duration. Never throws: runScanToJobResult already catches
    // everything and always resolves to a valid FullScanJobResult; safeRedisSet never throws either.
    after(async () => {
      const job = await runScanToJobResult(rawBody, ip)
      await safeRedisSet(jobKey(jobId), job)
    })

    return NextResponse.json({ success: true, jobId, job: { status: 'pending' } })
  } catch (err) {
    // Last-resort guard — never throw out of this route even if request parsing itself fails
    // unexpectedly.
    return NextResponse.json(
      { success: false, error: { message: 'job-enqueue-failed', category: 'unknown', details: [err instanceof Error ? err.message : String(err)] } },
      { status: 500 },
    )
  }
}
