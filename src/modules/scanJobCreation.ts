// src/modules/scanJobCreation.ts — shared job-creation logic, extracted from
// app/api/scan-start/route.ts so app/api/scan-v2/full-scan/start/route.ts (normal-mode Deep-Scan-
// style job) can reuse the exact same validation/enqueue/trigger behavior instead of duplicating it.
//
// PURE EXTRACTION, DISCLOSED: every line below is unchanged from app/api/scan-start/route.ts's own
// POST handler — only relocated into a reusable function, parameterized on `defaultScanMode` so the
// existing route can keep defaulting to 'deep' (byte-for-byte unchanged behavior/response shape) while
// the new full-scan/start route defaults to 'normal'. No validation rule, no job shape, no worker-
// trigger logic was changed to make this extraction.

import { after } from 'next/server'
import { Client as QStashClient } from '@upstash/qstash'
import { validateWalletAddress, validateChains, validateScanMode } from '@/src/deployment/validator'
import { setScanJob, type ScanJob } from '@/src/modules/scanJobs'

export type ScanStartRequestBody = {
  walletAddress?: unknown
  chains?: unknown
  scanMode?: unknown
}

export type CreateScanJobResult =
  | { ok: true; jobId: string }
  | { ok: false; status: number; error: unknown }

// UNCHANGED from app/api/scan-start/route.ts's own workerBaseUrl/triggerWorker — see that file's
// header for the full disclosure on the WORKER_ENDPOINT misconfiguration this already guards against.
function workerBaseUrl(): string {
  const endpoint = process.env.WORKER_ENDPOINT
  if (endpoint) {
    if (endpoint.includes('/api')) {
      // eslint-disable-next-line no-console
      console.warn('[config] WORKER_ENDPOINT should be domain only, not a path:', endpoint)
    }
    return endpoint
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return 'http://localhost:3000'
}

// QSTASH MIGRATION, DISCLOSED: previously this called the worker route directly via a plain fetch.
// Now publishes through Upstash QStash instead — QStash queues the request, retries it on failure,
// and signs it (Upstash-Signature header) so the worker route can verify the request really came
// from QStash before running a real, expensive Deep Scan (see
// app/api/scan-v2/worker/route.ts's verifySignatureAppRouter wrap).
//
// PUBLISH ENDPOINT CORRECTION, DISCLOSED: the task's own snippet named
// `https://qstash.upstash.io/v1/publish/<url>` — QStash's real, current publish endpoint is
// `/v2/publish/<url>` (confirmed against @upstash/qstash's own compiled source); `/v1/publish` is
// not the current API and using it would 404. Rather than hand-roll that URL at all (and get the
// version wrong a second way), this uses the official Client.publishJSON() from `@upstash/qstash`,
// which targets the correct versioned endpoint internally and reads QSTASH_URL/QSTASH_TOKEN from
// env automatically when not passed explicitly.
const qstashClient = new QStashClient()

async function triggerWorker(jobId: string): Promise<void> {
  const workerUrl = `${workerBaseUrl()}/api/scan-v2/worker`
  // eslint-disable-next-line no-console
  console.log('[scan-job] workerUrl', workerUrl)
  if (!process.env.QSTASH_TOKEN) {
    // FAIL-LOUD, DISCLOSED: unlike SCAN_WORKER_SECRET (which fails open with a warning because it's
    // an extra defense-in-depth layer), QSTASH_TOKEN not being set means there is no way to trigger
    // the worker at all anymore — falling back to a direct fetch here would silently defeat the
    // entire point of this migration (queueing/retries/signing), so this fails loud instead of
    // quietly reverting to the old direct-call behavior.
    console.error('[scan-job] QSTASH_TOKEN is not configured — cannot trigger worker', jobId)
    return
  }
  try {
    await qstashClient.publishJSON({
      url: workerUrl,
      body: { jobId },
      // Still forwarded through to the worker route as a real HTTP header on the request QStash
      // delivers — the pre-existing SCAN_WORKER_SECRET check in app/api/scan-v2/worker/route.ts
      // keeps working unchanged, on top of QStash's own signature verification.
      headers: process.env.SCAN_WORKER_SECRET ? { 'x-worker-secret': process.env.SCAN_WORKER_SECRET } : undefined,
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[scan-job] worker trigger via QStash failed', jobId, err instanceof Error ? err.message : String(err))
  }
}

// Validates, persists a `pending` ScanJob, and schedules the worker trigger inside `after()` (runs
// only once the caller has already sent its {jobId} response — never blocks the client on the real
// scan). Never throws — returns a structured result instead.
export async function createAndEnqueueScanJob(
  req: Request,
  body: ScanStartRequestBody,
  defaultScanMode: 'deep' | 'normal',
): Promise<CreateScanJobResult> {
  const addressCheck = validateWalletAddress(body.walletAddress)
  if (!addressCheck.valid) return { ok: false, status: 400, error: addressCheck.error }

  const chainsCheck = validateChains(body.chains ?? ['base', 'eth'])
  if (!chainsCheck.valid) return { ok: false, status: 400, error: chainsCheck.error }

  const scanModeCheck = validateScanMode(body.scanMode ?? defaultScanMode)
  if (!scanModeCheck.valid) return { ok: false, status: 400, error: scanModeCheck.error }

  const walletAddress = body.walletAddress as string
  const rawBody = { walletAddress, chains: chainsCheck.sanitizedChains, scanMode: body.scanMode ?? defaultScanMode }
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const jobId = crypto.randomUUID()

  const job: ScanJob = {
    id: jobId,
    walletAddress,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'pending',
    result: null,
    error: null,
    rawBody,
    ip,
  }
  await setScanJob(jobId, job)
  after(() => triggerWorker(jobId))

  return { ok: true, jobId }
}
