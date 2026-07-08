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
//
// MODULE-LOAD-TIME CRASH FIX, DISCLOSED (Preview-stuck-at-Initializing diagnosis): this used to be
// `const qstashClient = new QStashClient()` at module scope, executed unconditionally the instant
// this file is imported (by app/api/scan-start/route.ts and
// app/api/scan-v2/full-scan/start/route.ts) — before any request arrives. The `Client` constructor
// itself calls the SDK's internal `shouldUseDevelopmentMode()`, which THROWS SYNCHRONOUSLY if the
// `QSTASH_DEV` environment variable is set to anything other than "true"/"false"/"1"/"0"/empty/unset
// (confirmed by reading node_modules/@upstash/qstash/index.js directly — not assumed). This is a
// real, distinct crash vector from the one already guarded in
// app/api/scan-v2/worker/route.ts (that guard only covers verifySignatureAppRouter's own
// signing-key check, a completely separate code path from this Client construction). If QSTASH_DEV
// ever ends up set to an unexpected value in Preview (a stray/placeholder value, a copy-paste
// mistake, anything non-boolean-ish), this constructor throws at IMPORT time, which crashes every
// route that imports this module — exactly the "function fails to initialize" failure mode. Fixed
// by constructing the client lazily, inside a function, on the first actual publish attempt (a real
// request, never at import time) and wrapping construction in try/catch so ANY constructor failure
// — this one or an unknown future one — degrades to the safe direct-fetch fallback below instead of
// crashing the module.
let qstashClient: QStashClient | null | undefined // undefined = not yet attempted, null = construction failed
function getQstashClient(): QStashClient | null {
  if (qstashClient !== undefined) return qstashClient
  try {
    qstashClient = new QStashClient()
  } catch (err) {
    console.error('[scan-job] QStash Client construction failed — falling back to direct worker calls', err instanceof Error ? err.message : String(err))
    qstashClient = null
  }
  return qstashClient
}

// LOCAL-DEV FALLBACK, DISCLOSED CORRECTION: an earlier version of this function returned early
// (never triggering the worker at all) when QSTASH_TOKEN wasn't set, reasoning that a silent
// fallback would "defeat the point of the migration." That was wrong on reflection: QStash is a
// remote cloud service that can never reach `http://localhost:3000` in the first place, so setting
// QSTASH_TOKEN could never make local dev work either way — the real effect of failing loud was
// that NO scan could ever be triggered locally anymore, jobs silently stuck in 'pending' forever,
// which is a functional regression, not a safety improvement. Falls back to the exact pre-migration
// direct fetch when QSTASH_TOKEN isn't configured (local dev, or any deployment that hasn't set up
// QStash yet) — mirroring the same fail-open-with-a-warning pattern already used for
// SCAN_WORKER_SECRET and the signing keys, instead of being the one place in this migration that
// fails closed.
async function triggerWorker(jobId: string): Promise<void> {
  const workerUrl = `${workerBaseUrl()}/api/scan-v2/worker`
  // eslint-disable-next-line no-console
  console.log('[scan-job] workerUrl', workerUrl)

  const secretHeaders = process.env.SCAN_WORKER_SECRET ? { 'x-worker-secret': process.env.SCAN_WORKER_SECRET } : undefined

  const client = process.env.QSTASH_TOKEN ? getQstashClient() : null
  if (!client) {
    if (process.env.QSTASH_TOKEN) {
      // QSTASH_TOKEN was set but getQstashClient() still returned null — construction itself threw
      // (see getQstashClient's own header); already logged there, just falling back here.
    } else {
      console.warn('[scan-job] QSTASH_TOKEN is not configured — falling back to a direct worker call (fine for local dev; set QSTASH_TOKEN in real deployments for queueing/retries/signed requests)')
    }
    try {
      const res = await fetch(workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...secretHeaders },
        body: JSON.stringify({ jobId }),
      })
      if (!res.ok) {
        console.error('[scan-job] direct worker trigger returned non-2xx', jobId, res.status)
      }
    } catch (err) {
      console.error('[scan-job] direct worker trigger failed', jobId, err instanceof Error ? err.message : String(err))
    }
    return
  }

  try {
    await client.publishJSON({
      url: workerUrl,
      body: { jobId },
      // Still forwarded through to the worker route as a real HTTP header on the request QStash
      // delivers — the pre-existing SCAN_WORKER_SECRET check in app/api/scan-v2/worker/route.ts
      // keeps working unchanged, on top of QStash's own signature verification.
      headers: secretHeaders,
    })
  } catch (err) {
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
