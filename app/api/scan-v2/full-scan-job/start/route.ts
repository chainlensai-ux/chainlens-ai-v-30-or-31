// POST /api/scan-v2/full-scan-job/start — Background Job variant, step 1 (enqueue).
//
// STATUS: ADDITIVE, NOT WIRED UP — see app/api/scan-v2/full-scan-edge/route.ts's header for the
// same disclosure; the frontend still calls the existing synchronous
// /api/scan-v2/full-scan/route.ts, untouched. This pair of routes (this file + .../status/route.ts)
// exists so that decision CAN be made later.
//
// HONEST LIMITS DISCLOSURE: "run the full scan without time limits" is not literally achievable on
// Vercel serverless — every plan has SOME upper bound on how long `after()` (Next.js's real,
// built-in background-work primitive, confirmed available in this repo's Next 16.2.2 via
// `next/server`) can keep running after a response is sent (a Pro/Enterprise ceiling, not
// "unlimited"). What this DOES genuinely fix is the actual problem: the CLIENT's HTTP request no
// longer has to stay open for the full scan duration at all — this route returns a `jobId`
// immediately, and the real computation continues via `after()` decoupled from that response.
// Polling (.../status/route.ts) then has no timeout coupling to the scan's own duration; each poll
// is a fast, cheap KV read. This route's own `maxDuration` should be raised in vercel.json if you
// wire this up for real (not done here — see that file's own header on why only the currently-used
// routes are configured there today).
//
// STORAGE, DISCLOSED: reuses the existing, already-verified KV client (lib/server/cache/
// tokenCache.ts's getTokenCache/setTokenCache — Vercel KV, fails open to "unavailable" if
// KV_REST_API_URL/TOKEN aren't configured) rather than building a second cache. A job's result is
// never available if KV isn't configured in this deployment — that's the same real constraint this
// codebase's other KV consumers already live with, not a new one introduced here.

import { NextResponse, after } from 'next/server'
import { setTokenCache } from '@/lib/server/cache/tokenCache'
import { router } from '@/src/deployment/index'

export type JobErrorShape = { message: string; category: string; details?: string[] }

export type FullScanJobResult =
  | { status: 'pending' }
  | { status: 'done'; success: true; data: unknown }
  | { status: 'done'; success: false; error: JobErrorShape }

const JOB_TTL_SECONDS = 15 * 60 // 15 minutes — enough headroom for reasonable polling, bounded like every other KV entry in this codebase

function jobKey(jobId: string): string {
  return `v1:full-scan-job:${jobId}`
}

export async function POST(req: Request): Promise<Response> {
  try {
    const rawBody = await req.json().catch(() => null)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'

    const jobId = crypto.randomUUID()

    // Mark pending BEFORE returning, so an immediate poll never sees "not found" for a job that
    // was actually accepted.
    await setTokenCache<FullScanJobResult>(jobKey(jobId), { status: 'pending' }, JOB_TTL_SECONDS)

    // Runs the real scan AFTER this response is sent — the actual mechanism that decouples the
    // client's request lifetime from the scan's real duration. Never throws out of this callback:
    // handleScanRequest already never throws (see app/api/scan/route.ts's own disclosure), and any
    // truly unexpected error is still caught below so a failed background job is recorded, not lost
    // silently.
    after(async () => {
      try {
        const result = await router.handleScanRequest(rawBody, ip)
        const body = result.body as { success: boolean; data?: unknown; error?: JobErrorShape }
        const jobResult: FullScanJobResult = body.success
          ? { status: 'done', success: true, data: body.data }
          : { status: 'done', success: false, error: body.error ?? { message: 'job-failed', category: 'unknown' } }
        await setTokenCache(jobKey(jobId), jobResult, JOB_TTL_SECONDS)
      } catch (err) {
        await setTokenCache<FullScanJobResult>(jobKey(jobId), {
          status: 'done',
          success: false,
          error: { message: 'job-failed', category: 'unknown', details: [err instanceof Error ? err.message : String(err)] },
        }, JOB_TTL_SECONDS)
      }
    })

    return NextResponse.json({ success: true, jobId })
  } catch (err) {
    // Last-resort guard — never throw out of this route even if request parsing or the initial KV
    // write itself fails unexpectedly.
    return NextResponse.json(
      { success: false, error: { message: 'job-enqueue-failed', category: 'unknown', details: [err instanceof Error ? err.message : String(err)] } },
      { status: 500 },
    )
  }
}
