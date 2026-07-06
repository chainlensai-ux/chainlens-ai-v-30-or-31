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

async function triggerWorker(jobId: string): Promise<void> {
  try {
    const workerUrl = `${workerBaseUrl()}/api/scan-v2/worker`
    // eslint-disable-next-line no-console
    console.log('[scan-job] workerUrl', workerUrl)
    const res = await fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.SCAN_WORKER_SECRET ? { 'x-worker-secret': process.env.SCAN_WORKER_SECRET } : {}),
      },
      body: JSON.stringify({ jobId }),
    })
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error('[scan-job] worker trigger returned non-2xx', jobId, res.status)
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[scan-job] worker trigger failed', jobId, err instanceof Error ? err.message : String(err))
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
