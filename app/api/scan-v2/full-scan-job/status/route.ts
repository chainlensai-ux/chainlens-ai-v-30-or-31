// GET /api/scan-v2/full-scan-job/status?jobId=<id> — Background Job variant, step 2 (poll).
//
// See .../start/route.ts's header for the full disclosure on this pair's design and honest limits.
// This route is a fast, cheap Redis read — its own duration never depends on how long the
// underlying scan takes.
//
// REDIS MIGRATION, DISCLOSED: replaced lib/server/cache/tokenCache.ts's @vercel/kv-backed
// getTokenCache with lib/server/cache/redisClient.ts's redis.get (ioredis-backed — see that file's
// header for why ioredis, not @upstash/redis, is the correct client for a real REDIS_URL
// connection string). A failed/unreachable Redis read degrades to the same honest "not-found" a
// genuinely missing job would produce — never a thrown error, never a fabricated "pending" guess.
//
// Response shape (flat, exactly as required by the caller — app/frontend/api/scanWallet.ts):
//   {status:"pending"}                                   — job accepted, still running
//   {status:"done", success:true, data:FinalReport}       — job finished successfully
//   {status:"done", success:false, error:{...}}           — job finished with a real failure
//   {status:"not-found"}                                  — unknown/expired jobId, Redis
//                                                            unreachable, or unconfigured (all
//                                                            collapse to the same honest status —
//                                                            never a fabricated guess at which)

import { NextResponse } from 'next/server'
import { redis } from '@/lib/server/cache/redisClient'
import { jobKey, type FullScanJobResult } from '../start/route'

export async function GET(req: Request): Promise<Response> {
  try {
    const jobId = new URL(req.url).searchParams.get('jobId')
    if (!jobId) {
      return NextResponse.json({ status: 'not-found', error: { message: 'jobId is required', category: 'validation' } }, { status: 400 })
    }

    let job: FullScanJobResult | null = null
    try {
      job = await redis.get<FullScanJobResult>(jobKey(jobId))
    } catch (err) {
      // Redis unreachable/misconfigured (see redisClient.ts's header) — degrades to the same
      // honest "not-found" a genuinely missing job would produce, never a thrown error.
      // eslint-disable-next-line no-console
      console.warn('[full-scan-job/status] redis.get failed', { jobId, err: err instanceof Error ? err.message : String(err) })
    }

    if (job == null) {
      return NextResponse.json({ status: 'not-found' })
    }

    if (job.status === 'pending') {
      return NextResponse.json({ status: 'pending' })
    }

    // job.status === 'done' — return the stored job object exactly, as required.
    return NextResponse.json(job)
  } catch (err) {
    // Never throw — a polling endpoint that itself fails should read as "try again," not crash the
    // caller's poll loop.
    return NextResponse.json(
      { status: 'not-found', error: { message: 'status-check-failed', category: 'unknown', details: [err instanceof Error ? err.message : String(err)] } },
      { status: 500 },
    )
  }
}
