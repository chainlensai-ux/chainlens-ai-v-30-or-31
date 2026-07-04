// GET /api/scan-v2/full-scan-job/status?jobId=<id> — Background Job variant, step 2 (poll).
//
// See .../start/route.ts's header for the full disclosure on this pair's design, KV-unconfigured
// degradation, and honest limits. This route is a fast, cheap KV read — its own duration never
// depends on how long the underlying scan takes.
//
// Response shape (flat, exactly as required by the caller — app/frontend/api/scanWallet.ts):
//   {status:"pending"}                                   — job accepted, still running
//   {status:"done", success:true, data:FinalReport}       — job finished successfully
//   {status:"done", success:false, error:{...}}           — job finished with a real failure
//   {status:"not-found"}                                  — unknown/expired jobId, or KV isn't
//                                                            configured in this deployment (both
//                                                            collapse to the same honest status —
//                                                            never a fabricated guess at which)

import { NextResponse } from 'next/server'
import { getTokenCache } from '@/lib/server/cache/tokenCache'
import { jobKey, type FullScanJobResult } from '../start/route'

export async function GET(req: Request): Promise<Response> {
  try {
    const jobId = new URL(req.url).searchParams.get('jobId')
    if (!jobId) {
      return NextResponse.json({ status: 'not-found', error: { message: 'jobId is required', category: 'validation' } }, { status: 400 })
    }

    const job = await getTokenCache<FullScanJobResult>(jobKey(jobId))

    if (!job) {
      return NextResponse.json({ status: 'not-found' })
    }

    // job is already exactly {status:'pending'} or {status:'done', success, data|error} — the same
    // flat shape this route returns, so it's passed straight through.
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
