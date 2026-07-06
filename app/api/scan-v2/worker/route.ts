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

export const maxDuration = 900

import { NextResponse } from 'next/server'
import { runWalletScanV2Worker } from '@/workers/walletScanV2'
import { setScanJob, getScanJob } from '@/src/modules/scanJobs'
import { resetAlchemyAudit, printAlchemyAuditSummary } from '@/lib/server/alchemyAudit'
import { withScanTimeout } from '@/src/utils/timeout'

const SCAN_TIMEOUT_MS = process.env.SCAN_TIMEOUT_MS ? Number(process.env.SCAN_TIMEOUT_MS) : 60_000
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

export async function POST(req: Request): Promise<Response> {
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

  try {
    const { status, body } = await withScanTimeout(runWalletScanV2Worker(job.rawBody, job.ip), SCAN_TIMEOUT_MS)
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
