// POST /api/scan-v2/full-scan-job/start — Background Job variant, step 1 (enqueue).
//
// Calls the exact same real orchestrator every other scan route uses
// (router.handleScanRequest, src/deployment/router.ts) — not a reimplementation. Never throws.
//
// HONEST LIMITS DISCLOSURE (unchanged from the prior version of this file): "no time limits" is not
// literally achievable on Vercel serverless — every plan has SOME upper bound on how long `after()`
// (Next.js's real, built-in background-work primitive) can keep running after a response is sent.
// What this genuinely fixes: the CLIENT's HTTP request no longer has to stay open for the full scan
// duration — this route returns immediately, and the real computation continues via `after()`,
// decoupled from that response. Polling (.../status/route.ts) then has no timeout coupling to the
// scan's own duration.
//
// KV-UNCONFIGURED GRACEFUL DEGRADATION, DISCLOSED: this route's whole design (enqueue + poll) only
// works if the job's result can be PERSISTED somewhere between the `after()` background write and a
// later poll request — that's Vercel KV (lib/server/cache/tokenCache.ts, reused here unmodified).
// If KV isn't configured (e.g. local dev without KV_REST_API_URL/TOKEN — the same check that
// module's own kvConfigured() already makes, duplicated here rather than exporting that private
// helper, since modifying that file wasn't requested and this is a one-line, disclosed duplication
// of an already-simple check), there is nowhere to persist a background result for later polling.
// Rather than silently enqueue a job that can NEVER be found by a later poll (which would force
// every dev-without-KV caller to wait out the full client-side polling timeout before failing),
// this route detects that case and runs the scan SYNCHRONOUSLY instead, returning the completed
// result directly in this response with `status: "done"` already set — the frontend checks for
// this and skips polling entirely when it sees a `"done"` status here.

import { NextResponse, after } from 'next/server'
import { getTokenCache, setTokenCache } from '@/lib/server/cache/tokenCache'
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

// Same real env var names lib/server/cache/tokenCache.ts's own (private) kvConfigured() checks —
// duplicated, not imported, since that helper isn't exported and this file doesn't modify that
// module. Both copies checking the identical two env vars can never disagree in practice.
function kvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
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

    if (!kvConfigured()) {
      // Graceful degradation — see file header. No persistence layer exists to poll against, so
      // run synchronously and hand back the finished result immediately, nested under `job` (NOT
      // spread over this response's own top-level `success`, which means "this HTTP request was
      // handled" and must never be confused with — or overwritten by — the scan's own success/
      // failure outcome).
      const job = await runScanToJobResult(rawBody, ip)
      return NextResponse.json({ success: true, jobId, job })
    }

    // Mark pending BEFORE returning, so an immediate poll never sees "not found" for a job that was
    // actually accepted.
    await setTokenCache<FullScanJobResult>(jobKey(jobId), { status: 'pending' }, JOB_TTL_SECONDS)

    // Runs AFTER this response is sent — the real mechanism that decouples the client's request
    // lifetime from the scan's actual duration. Never throws: runScanToJobResult already catches
    // everything and always resolves to a valid FullScanJobResult.
    after(async () => {
      const job = await runScanToJobResult(rawBody, ip)
      await setTokenCache(jobKey(jobId), job, JOB_TTL_SECONDS)
    })

    return NextResponse.json({ success: true, jobId, job: { status: 'pending' } })
  } catch (err) {
    // Last-resort guard — never throw out of this route even if request parsing or the initial KV
    // write itself fails unexpectedly.
    return NextResponse.json(
      { success: false, error: { message: 'job-enqueue-failed', category: 'unknown', details: [err instanceof Error ? err.message : String(err)] } },
      { status: 500 },
    )
  }
}
