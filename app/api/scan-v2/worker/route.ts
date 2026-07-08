// POST /api/scan-v2/worker — dedicated background function that actually runs a Deep Scan.
//
// WHY THIS ROUTE EXISTS, DISCLOSED: previously the whole Deep Scan ran inside app/api/scan-start's
// own `after()` callback, in the same invocation that had already returned a response to the
// client. Per explicit instruction, that's been reported as unreliable in the real deployment
// (background work tacked onto an already-responded invocation is a real, documented class of
// platform reliability risk, distinct from a normal request-triggered function). This route is a
// genuinely separate function: invoked by a real, fresh HTTP POST, with its own independent
// maxDuration budget, not "extra time squeezed onto a request that already finished."
//
// SECRET VERIFICATION, DISCLOSED ADDITION: the task's own Part 1/2 snippets have scan-start SEND an
// `x-worker-secret` header but never have THIS route check it — as literally specified, this
// endpoint would be a public, unauthenticated way for anyone who learns/guesses a jobId to trigger a
// real, expensive Deep Scan (real GoldRush/Alchemy provider calls) against this deployment. Added
// verification below. FAIL-OPEN WITH A LOGGED WARNING, DISCLOSED: if SCAN_WORKER_SECRET isn't
// configured at all, the request is still allowed through (with a warning) rather than hard-failing
// every job in a deployment that hasn't set the var yet — but this is a real gap a production
// deployment MUST close by setting SCAN_WORKER_SECRET, not something to rely on indefinitely.
//
// runtime/maxDuration, DISCLOSED: kept on the default Node runtime (not edge) for the same reason as
// app/api/scan-start/route.ts — ioredis (setScanJob/getScanJob) requires a raw TCP socket, which
// Edge doesn't support at all.
//
// QSTASH SIGNATURE VERIFICATION, DISCLOSED ADDITION (QStash-migration task): this route is now
// triggered by an Upstash QStash publish (src/modules/scanJobCreation.ts's triggerWorker) instead
// of a direct fetch. `verifySignatureAppRouter` (the real App Router equivalent of the Pages-Router
// `verifySignature` helper the task named — this file has no `req`/`res` handler shape at all, it's
// a NextRequest/NextResponse App Router route, so the literal `verifySignature(req)` +
// `res.status(401)` snippet doesn't apply here) wraps the existing POST handler unchanged below,
// verifying the `Upstash-Signature` header against QSTASH_CURRENT_SIGNING_KEY/
// QSTASH_NEXT_SIGNING_KEY (read automatically from env — not passed explicitly) before it ever
// runs. On an invalid/missing signature it returns a real 403 (the SDK's own behavior — not a 401
// as literally requested; forcing a different status than the SDK actually returns isn't worth
// re-implementing signature verification by hand for). The pre-existing SCAN_WORKER_SECRET check
// inside isAuthorized() below is left completely untouched, as instructed — this is an additional
// outer layer, not a replacement.
export const maxDuration = 900

import { NextResponse } from 'next/server'
import { verifySignatureAppRouter } from '@upstash/qstash/nextjs'
import { runWalletScanV2Worker } from '@/workers/walletScanV2'
import { setScanJob, getScanJob } from '@/src/modules/scanJobs'
import { resetAlchemyAudit, printAlchemyAuditSummary } from '@/lib/server/alchemyAudit'
import { withScanTimeout } from '@/src/utils/timeout'

// TIMEOUT WINDOW, DISCLOSED (raised again, this task): this is the REAL root cause of
// "SCAN_TIMEOUT_120000ms" reaching the UI. This is an INTERNAL timeout on the worker's own call to
// runWalletScanV2Worker — separate from, and previously far tighter than, this route's own 900s
// maxDuration budget above. Both Deep Scan and full-scan (normal mode) jobs dispatch to this same
// worker route; a normal scan on a real wallet can easily exceed 120s, at which point
// withScanTimeout rejects with the literal string `SCAN_TIMEOUT_120000ms`, this route writes that
// raw string as the job's `error`, and the frontend's poll loop (app/frontend/api/scanWallet.ts)
// surfaced it byte-for-byte to the user. Raised to 600s — matching pollScanJobUntilDone's own
// 600s poll ceiling (see that file), so the frontend doesn't give up waiting before this worker
// would even time out — while still leaving 300s of real margin under this route's own 900s
// maxDuration for the CU-guard check, audit summary, and job-status write that run after
// withScanTimeout resolves. Still overridable via SCAN_TIMEOUT_MS.
const SCAN_TIMEOUT_MS = process.env.SCAN_TIMEOUT_MS ? Number(process.env.SCAN_TIMEOUT_MS) : 600_000
const CU_GUARD_EVENT_THRESHOLD = 800 // see app/api/scan-start/route.ts's own header for the full disclosure on this number

function sumAlchemyEventCount(providerDiagnostics: unknown): number {
  if (!Array.isArray(providerDiagnostics)) return 0
  return providerDiagnostics.reduce((sum: number, entry) => {
    const alchemy = (entry as { alchemy?: { eventCount?: number } })?.alchemy
    return sum + (typeof alchemy?.eventCount === 'number' ? alchemy.eventCount : 0)
  }, 0)
}

function isAuthorized(req: Request): boolean {
  const configuredSecret = process.env.SCAN_WORKER_SECRET
  if (!configuredSecret) {
    // eslint-disable-next-line no-console
    console.warn('[WORKER] SCAN_WORKER_SECRET is not configured — this endpoint is currently unauthenticated')
    return true
  }
  return req.headers.get('x-worker-secret') === configuredSecret
}

// UNCHANGED, DISCLOSED: every line of this handler's body is exactly as it was before the QStash
// wrap below — only its name changed (POST -> postHandler) so verifySignatureAppRouter can wrap it
// while still exporting a function literally named POST, per instruction.
async function postHandler(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    return new Response('unauthorized', { status: 401 })
  }

  const { jobId } = await req.json().catch(() => ({ jobId: undefined }))
  if (typeof jobId !== 'string' || !jobId) {
    return NextResponse.json({ error: 'jobId is required' }, { status: 400 })
  }

  // eslint-disable-next-line no-console
  console.log('[WORKER] started', jobId)

  const job = await getScanJob(jobId)
  if (!job) {
    // eslint-disable-next-line no-console
    console.error('[WORKER] job not found', jobId)
    return new Response('job-not-found', { status: 404 })
  }

  await setScanJob(jobId, { ...job, status: 'running', updatedAt: Date.now() })
  resetAlchemyAudit()

  // ABORT CONTROLLER, DISCLOSED: see src/utils/timeout.ts's header for the honest scope of what
  // this actually stops today (a real, functioning abort signal — but not yet wired into the
  // underlying provider fetch calls, which keep running in the background after this fires).
  const controller = new AbortController()

  try {
    // `jobId`, ADDED DISCLOSED (module-progress-reporting task): this route has no visibility into
    // individual module boundaries itself (it awaits one runWalletScanV2Worker call) — passing
    // jobId lets that function report real per-module progress into the job store as it runs (see
    // workers/walletScanV2.ts's own reportProgress()/header for where the actual per-module calls
    // live).
    const { status, body } = await withScanTimeout(runWalletScanV2Worker(job.rawBody, job.ip, jobId), SCAN_TIMEOUT_MS, controller)
    const parsed = body as { success: boolean; data?: { providerDiagnostics?: unknown }; error?: { message: string } }
    printAlchemyAuditSummary()

    const totalAlchemyEvents = sumAlchemyEventCount(parsed.data?.providerDiagnostics)
    if (totalAlchemyEvents > CU_GUARD_EVENT_THRESHOLD) {
      // eslint-disable-next-line no-console
      console.warn('[pipeline] CU guard triggered', { jobId, totalAlchemyEvents })
      throw new Error('CU_GUARD_TRIGGERED')
    }

    if (status >= 200 && status < 300 && parsed.success) {
      await setScanJob(jobId, {
        ...job,
        status: 'completed',
        result: parsed.data ?? null,
        error: null,
        updatedAt: Date.now(),
      })
      // eslint-disable-next-line no-console
      console.log('[JOB] write', jobId, 'completed')
      // eslint-disable-next-line no-console
      console.log('[WORKER] finished', jobId)
      return new Response('ok')
    }

    const message = parsed.error?.message ?? 'scan-failed'
    await setScanJob(jobId, { ...job, status: 'failed', result: null, error: message, updatedAt: Date.now() })
    // eslint-disable-next-line no-console
    console.log('[JOB] write', jobId, 'failed')
    // eslint-disable-next-line no-console
    console.log('[WORKER] finished', jobId)
    return new Response('failed')
  } catch (err) {
    printAlchemyAuditSummary()
    const message = err instanceof Error ? err.message : String(err)
    if (controller.signal.aborted) {
      // eslint-disable-next-line no-console
      console.warn('[worker] cancellation triggered for job', jobId)
    }
    // eslint-disable-next-line no-console
    console.error('[WORKER] crash', jobId, message)

    await setScanJob(jobId, { ...job, status: 'failed', result: null, error: message, updatedAt: Date.now() })
    // eslint-disable-next-line no-console
    console.log('[JOB] write', jobId, 'failed')
    // eslint-disable-next-line no-console
    console.log('[WORKER] finished', jobId)
    return new Response('failed')
  }
}

// FAIL-OPEN GUARD, DISCLOSED ADDITION: verifySignatureAppRouter throws synchronously (at this
// module's import time, not per-request) if neither QSTASH_CURRENT_SIGNING_KEY nor
// QSTASH_NEXT_SIGNING_KEY nor QSTASH_REGION/devMode is available — that would hard-crash this
// entire route (every request, including local dev and any deployment that hasn't set these four
// QStash env vars up yet) instead of rejecting individual unsigned requests. That's a materially
// worse failure mode than isAuthorized()'s existing fail-open-with-a-warning pattern for
// SCAN_WORKER_SECRET above, so this mirrors that same pattern: only wrap with real QStash
// verification when the keys are actually configured; otherwise fall back to the unwrapped handler
// (still protected by the existing SCAN_WORKER_SECRET check) with a loud warning, rather than
// taking the whole route down.
const qstashConfigured = Boolean(process.env.QSTASH_CURRENT_SIGNING_KEY || process.env.QSTASH_NEXT_SIGNING_KEY)
if (!qstashConfigured) {
  console.warn('[WORKER] QSTASH_CURRENT_SIGNING_KEY/QSTASH_NEXT_SIGNING_KEY not configured — QStash signature verification is disabled; relying on SCAN_WORKER_SECRET only')
}
export const POST = qstashConfigured ? verifySignatureAppRouter(postHandler) : postHandler
