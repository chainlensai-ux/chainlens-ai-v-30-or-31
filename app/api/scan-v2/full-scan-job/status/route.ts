// GET /api/scan-v2/full-scan-job/status?jobId=<id> — Background Job variant, step 2 (poll).
//
// See .../start/route.ts's header for the full disclosure on this pair's design, storage, and
// honest limits. This route is a fast, cheap KV read — its own duration never depends on how long
// the underlying scan takes, which is the actual point of the polling model.

import { NextResponse } from 'next/server'
import { getTokenCache } from '@/lib/server/cache/tokenCache'
import type { FullScanJobResult } from '../start/route'

function jobKey(jobId: string): string {
  return `v1:full-scan-job:${jobId}`
}

export async function GET(req: Request): Promise<Response> {
  try {
    const jobId = new URL(req.url).searchParams.get('jobId')
    if (!jobId) {
      return NextResponse.json({ success: false, error: { message: 'jobId is required', category: 'validation' } }, { status: 400 })
    }

    const job = await getTokenCache<FullScanJobResult>(jobKey(jobId))

    // A missing entry means either the job never existed, already expired (JOB_TTL_SECONDS in
    // start/route.ts), or KV itself isn't configured in this deployment — all three collapse to
    // the same honest "not-found" status rather than a fabricated guess at which one it was.
    if (!job) {
      return NextResponse.json({ success: true, status: 'not-found' })
    }

    if (job.status === 'pending') {
      return NextResponse.json({ success: true, status: 'pending' })
    }

    // `success` here is this STATUS CHECK's own outcome (it succeeded — we found a completed job);
    // the scan's own outcome is nested under `result` to avoid any ambiguity between the two.
    return NextResponse.json({
      success: true,
      status: 'done',
      result: job.success ? { success: true, data: job.data } : { success: false, error: job.error },
    })
  } catch (err) {
    // Never throw — a polling endpoint that itself fails should read as "try again," not crash the
    // caller's poll loop.
    return NextResponse.json(
      { success: false, error: { message: 'status-check-failed', category: 'unknown', details: [err instanceof Error ? err.message : String(err)] } },
      { status: 500 },
    )
  }
}
