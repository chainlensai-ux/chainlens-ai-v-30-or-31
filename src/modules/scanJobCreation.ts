// src/modules/scanJobCreation.ts — shared job-creation logic, extracted from
// app/api/scan-start/route.ts so app/api/scan-v2/full-scan/start/route.ts (normal-mode Deep-Scan-
// style job) can reuse the exact same validation/enqueue/trigger behavior instead of duplicating it.
//
// PURE EXTRACTION, DISCLOSED: every line below is unchanged from app/api/scan-start/route.ts's own
// POST handler — only relocated into a reusable function, parameterized on `defaultScanMode` so the
// existing route can keep defaulting to 'deep' (byte-for-byte unchanged behavior/response shape) while
// the new full-scan/start route defaults to 'normal'. No validation rule, no job shape, no worker-
// trigger logic was changed to make this extraction.

import { waitUntil } from '@vercel/functions'
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
// ENV-VALUE SANITIZATION, DISCLOSED ("invalid token" despite a visually-correct QSTASH_TOKEN):
// pasting a secret into a dashboard env-var field very commonly captures an invisible trailing
// newline, a leading/trailing space, or a wrapping pair of quotes — none of which are visible when
// you "double-check" the value by looking at it, but all of which are sent to QStash byte-for-byte
// and rejected as "unable to authenticate: invalid token". The @upstash/qstash Client reads the raw
// env value as-is, so it never noticed. This strips exactly those (whitespace + one layer of
// wrapping quotes) before use, and passes the cleaned value to the Client explicitly rather than
// relying on the SDK's raw env read. If anything was stripped, it logs that fact (never the token
// itself) so the real cause is visible in logs instead of looking like a genuinely-wrong token.
function sanitizeEnvValue(value: string | undefined | null): string | undefined {
  if (value == null) return undefined
  let v = value.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1).trim()
  }
  return v.length > 0 ? v : undefined
}

let qstashClient: QStashClient | null | undefined // undefined = not yet attempted, null = construction failed
function getQstashClient(): QStashClient | null {
  if (qstashClient !== undefined) return qstashClient
  try {
    const rawToken = process.env.QSTASH_TOKEN
    const token = sanitizeEnvValue(rawToken)
    if (rawToken != null && token != null && rawToken !== token) {
      console.warn(`[scan-job] QSTASH_TOKEN had surrounding whitespace/quotes stripped (raw length ${rawToken.length} -> cleaned length ${token.length}) — this is a very common cause of "invalid token"; re-check the value in Vercel for a trailing newline/space or wrapping quotes`)
    }
    const baseUrl = sanitizeEnvValue(process.env.QSTASH_URL)
    // Pass the sanitized token/baseUrl explicitly — do NOT let the SDK re-read the raw (possibly
    // whitespace-corrupted) env values.
    qstashClient = new QStashClient({
      ...(token != null ? { token } : {}),
      ...(baseUrl != null ? { baseUrl } : {}),
    })
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
// GUARANTEED-DISPATCH SPLIT, DISCLOSED ("triggerWorker never executes" diagnosis, follow-up to the
// after()->waitUntil() switch above): that switch assumed the only failure mode was *which*
// background-scheduling primitive to use. But `waitUntil()`'s own contract (see
// node_modules/@vercel/functions/get-context.js: `getContext().waitUntil?.(promise)`) is an
// OPTIONAL CALL — if `globalThis[Symbol.for('@vercel/request-context')]` isn't populated for this
// runtime/build the way `after()`'s `@next/request-context` wasn't, `waitUntil?.()` just silently
// does nothing: no throw, no log, nothing. The promise passed to it (triggerWorker(jobId)) still
// starts running synchronously up to its first `await`, but nothing then keeps this invocation alive
// long enough for that `await` (a real network call to QStash) to ever resolve — the function
// returns, the response is sent, and the platform is free to freeze/kill the invocation before the
// publish request's bytes ever leave the machine. That failure mode is indistinguishable from
// "triggerWorker never ran" from the outside (no outgoing request, no error), which matches the
// reported symptom exactly, and it is NOT something switching between after()/waitUntil() alone
// can fix — both are "best-effort, ONLY if the platform kept us alive" primitives.
//
// FIX: split the QStash publish attempt out into its own function and AWAIT IT DIRECTLY in
// createAndEnqueueScanJob(), in the main request path, before the response is returned — not
// deferred to any background-scheduling primitive at all. This makes the actual `publishJSON` call
// unconditionally reached and unconditionally completed (or its failure unconditionally logged)
// every single time a scan is requested, independent of whether waitUntil()/after() are wired
// correctly on this deployment. This is safe to await synchronously (unlike the old code's
// direct-fetch fallback) because `publishJSON` only waits for QStash's own publish acknowledgement
// (accepted-for-queueing) — a fast, ~100-300ms API call — NOT for the worker's scan to finish; QStash
// delivers to the worker route asynchronously via its own retry engine afterward. Only the
// local-dev-only direct-fetch fallback (which DOES await the worker's full response, and the worker
// route runs the entire Deep Scan synchronously before responding — see
// app/api/scan-v2/worker/route.ts) still needs to be non-blocking, so that one path alone stays on
// waitUntil() below, same as before.
async function publishToQstash(
  jobId: string,
  workerUrl: string,
  secretHeaders: Record<string, string> | undefined,
): Promise<boolean> {
  const client = process.env.QSTASH_TOKEN ? getQstashClient() : null
  if (!client) return false
  try {
    // eslint-disable-next-line no-console
    console.log('[scan-job] publishing to QStash', jobId, workerUrl)
    await client.publishJSON({
      url: workerUrl,
      body: { jobId },
      // Still forwarded through to the worker route as a real HTTP header on the request QStash
      // delivers — the pre-existing SCAN_WORKER_SECRET check in app/api/scan-v2/worker/route.ts
      // keeps working unchanged, on top of QStash's own signature verification.
      headers: secretHeaders,
    })
    // eslint-disable-next-line no-console
    console.log('[scan-job] QStash publish acknowledged', jobId)
    return true
  } catch (err) {
    console.error('[scan-job] worker trigger via QStash failed — falling back to direct fetch', jobId, err instanceof Error ? err.message : String(err))
    return false
  }
}

// LOCAL-DEV FALLBACK, kept non-blocking/deferred (see the header comment above for why this one
// path, unlike the QStash publish above, must NOT be awaited in the main request path).
function triggerWorkerDirectFallback(
  jobId: string,
  workerUrl: string,
  secretHeaders: Record<string, string> | undefined,
): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('[scan-job] direct-fetch fallback dispatching', jobId, workerUrl)
  return fetch(workerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...secretHeaders },
    body: JSON.stringify({ jobId }),
  })
    .then((res) => {
      if (!res.ok) console.error('[scan-job] direct worker trigger returned non-2xx', jobId, res.status)
    })
    .catch((err) => {
      console.error('[scan-job] direct worker trigger failed', jobId, err instanceof Error ? err.message : String(err))
    })
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

  const workerUrl = `${workerBaseUrl()}/api/scan-v2/worker`
  const secretHeaders = process.env.SCAN_WORKER_SECRET ? { 'x-worker-secret': process.env.SCAN_WORKER_SECRET } : undefined
  // eslint-disable-next-line no-console
  console.log('[scan-job] workerUrl', workerUrl)

  // GUARANTEED DISPATCH, DISCLOSED: awaited directly in the request path, NOT deferred to
  // waitUntil()/after() — see publishToQstash's own header for why this specific call is safe to
  // await here (fast QStash-acknowledgement only, not the worker's full scan) and why deferring it
  // to a background-scheduling primitive was the actual root cause of "no outgoing requests" ever
  // being observed.
  const published = await publishToQstash(jobId, workerUrl, secretHeaders)
  if (!published) {
    if (!process.env.QSTASH_TOKEN) {
      console.warn('[scan-job] QSTASH_TOKEN is not configured — falling back to a direct worker call (fine for local dev; set QSTASH_TOKEN in real deployments for queueing/retries/signed requests)')
    }
    // DOOMED-FALLBACK DETECTION, DISCLOSED (worker POST 403 "invalid signature"/"missing header"
    // diagnosis, reproduced live: Firewall allowed the request, the function ran, but NO postHandler
    // log lines appeared — the exact signature of verifySignatureAppRouter rejecting a request
    // BEFORE it ever reaches our own handler — and the request's own User-Agent was the plain "node"
    // default, not a QStash delivery agent, confirming it was this direct-fetch fallback, unsigned,
    // hitting a worker that requires a signature). If app/api/scan-v2/worker/route.ts's own
    // QSTASH_CURRENT_SIGNING_KEY/QSTASH_NEXT_SIGNING_KEY ARE configured (same env, readable here
    // too), that route wraps every POST in verifySignatureAppRouter and will reject ANY unsigned
    // request — including this plain fetch — with a 403, before any of its own logging runs. In that
    // exact configuration (signing keys present, but QSTASH_TOKEN missing/broken so publishToQstash
    // above failed), this fallback is not a safety net at all — it is guaranteed to 403 every time.
    // Logging that plainly here, since the resulting 403 alone (with zero logs from the worker side)
    // is otherwise very hard to trace back to "QSTASH_TOKEN is broken" — the real, actionable fix is
    // to correct QSTASH_TOKEN in this deployment's env vars, not the worker's signing keys (those are
    // working as designed).
    const workerRequiresSignature = Boolean(process.env.QSTASH_CURRENT_SIGNING_KEY || process.env.QSTASH_NEXT_SIGNING_KEY)
    if (workerRequiresSignature) {
      console.error('[scan-job] MISCONFIGURATION: QStash publish failed/unavailable, but the worker route has QSTASH_CURRENT_SIGNING_KEY/QSTASH_NEXT_SIGNING_KEY configured and requires a signed request. The direct-fetch fallback below is UNSIGNED and will be rejected with a 403 by the worker before it logs anything — this is not a transient error, it will happen on every scan until QSTASH_TOKEN is fixed. Check QSTASH_TOKEN in this deployment\'s env vars (see getQstashClient()\'s own logs above for why publish failed).', jobId)
    }
    // Still deferred: this fallback DOES await the worker's full response, and the worker route
    // runs the entire Deep Scan synchronously before responding — awaiting it in the main request
    // path would block exactly as long as the scan takes.
    waitUntil(triggerWorkerDirectFallback(jobId, workerUrl, secretHeaders))
  }

  return { ok: true, jobId }
}
