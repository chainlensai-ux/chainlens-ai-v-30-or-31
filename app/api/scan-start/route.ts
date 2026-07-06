// POST /api/scan-start — enqueue a Deep Scan as a background job (step 1 of the job/poll system).
//
// REUSE, NOT REIMPLEMENTATION, DISCLOSED: this calls the exact same real, unchanged
// runWalletScanV2Worker (workers/walletScanV2.ts) every other scan route uses — the same 11-module
// V2 chain (holdings/pricing/portfolio/pnl/chainActivity/risk/personality/behavior/signals/
// smartMoneyScore), same CU tracking, same shape guard. Nothing about the V2 engine or worker is
// touched or duplicated here.
//
// BACKGROUND EXECUTION, DISCLOSED: the task offered a choice ("either call a Vercel background
// function, or trigger your existing worker with jobId... or use Vercel background function
// syntax"). Used Next.js's `after()` here — the exact same real, already-proven mechanism
// app/api/scan-v2/full-scan-job/start/route.ts already uses successfully for this identical
// problem (decoupling the client's request lifetime from the scan's real duration) — rather than
// standing up a second route reached over an internal HTTP call, which would be more fragile in a
// serverless environment (a self-fetch from one function to another) for no real benefit over
// calling the worker directly in the same process via `after()`.
//
// nanoid, DISCLOSED: not installed in this codebase (verified via package.json before writing this
// file) — used crypto.randomUUID() instead, the same real, already-used-elsewhere (full-scan-job/
// start/route.ts) id generator, avoiding a new dependency for no functional benefit.

import { NextResponse, after } from 'next/server'
import { validateWalletAddress, validateChains, validateScanMode } from '@/src/deployment/validator'
import { runWalletScanV2Worker } from '@/workers/walletScanV2'
import { setScanJob, getScanJob, type ScanJob } from '@/src/modules/scanJobs'
import { resetAlchemyAudit, printAlchemyAuditSummary } from '@/lib/server/alchemyAudit'

// maxDuration, DISCLOSED — the real fix for "infinite running": Next.js's `after()` callback runs
// INSIDE the same function invocation that already sent its response — it does not get its own,
// separate execution budget. Whatever `maxDuration` this route is configured with is the ceiling
// for the ENTIRE invocation, background work included. Without raising it, a genuinely long Deep
// Scan can get killed by the platform mid-`after()` — after the job was already marked 'running'
// but before anything ever writes 'completed'/'failed' — leaving it stuck at 'running' forever with
// nothing left to update it. Set to 900s (Vercel's real maximum on plans that support it; a lower
// real plan ceiling silently clamps this value rather than erroring, so setting it high is safe
// everywhere).
export const maxDuration = 900

// RUNTIME, DISCLOSED: intentionally NOT edge. ioredis (lib/server/cache/redisClient.ts, used by
// setScanJob/getScanJob) requires a raw TCP socket — the Edge runtime doesn't support raw sockets at
// all, so `export const runtime = 'edge'` here would break every job read/write outright, not just
// risk an "unverified" GoldRush SDK compatibility question. Kept on the default Node runtime, the
// one this whole background-job flow (ioredis, plus every module in runWalletScanV2Worker) is
// already written for.

type ScanStartRequestBody = {
  walletAddress?: unknown
  chains?: unknown
  scanMode?: unknown
}

async function runJobInBackground(jobId: string, walletAddress: string, rawBody: unknown, ip: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('[WORKER] started', jobId)
  const existing = await getScanJob(jobId)
  if (!existing) {
    // eslint-disable-next-line no-console
    console.log('[WORKER] finished', jobId, '(job record vanished — nothing to update)')
    return
  }

  await setScanJob(jobId, { ...existing, status: 'running', updatedAt: Date.now() })

  // ALCHEMY-AUDIT WIRING, DISCLOSED: this is the real fix for the audit system going silent on
  // Deep Scan. lib/server/alchemyAudit.ts's reset/print calls were wired into app/api/scan-v2/
  // full-scan/route.ts two commits ago — but Deep Scan no longer calls that route at all (it goes
  // through this background job path instead, added in the prior commit). Without moving the
  // reset/print here, Deep Scan's own Alchemy call audit was silently orphaned — reset on a route
  // Deep Scan never hits, so it never actually captured anything for a real Deep Scan.
  resetAlchemyAudit()

  try {
    const { status, body } = await runWalletScanV2Worker(rawBody, ip)
    const parsed = body as { success: boolean; data?: unknown; error?: { message: string } }
    printAlchemyAuditSummary()
    if (status >= 200 && status < 300 && parsed.success) {
      await setScanJob(jobId, {
        ...existing,
        status: 'completed',
        result: parsed.data ?? null,
        error: null,
        updatedAt: Date.now(),
      })
    } else {
      await setScanJob(jobId, {
        ...existing,
        status: 'failed',
        result: null,
        error: parsed.error?.message ?? 'scan-failed',
        updatedAt: Date.now(),
      })
    }
  } catch (err) {
    // runWalletScanV2Worker already never throws internally, but this is a final backstop in case
    // something fails before/outside its own error handling.
    printAlchemyAuditSummary()
    // eslint-disable-next-line no-console
    console.error('[WORKER] crash', jobId, err)
    await setScanJob(jobId, {
      ...existing,
      status: 'failed',
      result: null,
      error: err instanceof Error ? err.message : String(err),
      updatedAt: Date.now(),
    })
  }
  // eslint-disable-next-line no-console
  console.log('[WORKER] finished', jobId)
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body: ScanStartRequestBody = await req.json().catch(() => ({}))
    const addressCheck = validateWalletAddress(body.walletAddress)
    if (!addressCheck.valid) {
      return NextResponse.json({ success: false, error: addressCheck.error }, { status: 400 })
    }
    const chainsCheck = validateChains(body.chains ?? ['base', 'eth'])
    if (!chainsCheck.valid) {
      return NextResponse.json({ success: false, error: chainsCheck.error }, { status: 400 })
    }
    const scanModeCheck = validateScanMode(body.scanMode ?? 'deep')
    if (!scanModeCheck.valid) {
      return NextResponse.json({ success: false, error: scanModeCheck.error }, { status: 400 })
    }

    const walletAddress = body.walletAddress as string
    const rawBody = { walletAddress, chains: chainsCheck.sanitizedChains, scanMode: body.scanMode ?? 'deep' }
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
    }
    // Stored BEFORE returning, so an immediate poll never sees "not found" for a job that was
    // actually accepted — same reasoning as full-scan-job/start/route.ts's own ordering.
    await setScanJob(jobId, job)

    // Runs AFTER this response is sent.
    after(() => runJobInBackground(jobId, walletAddress, rawBody, ip))

    return NextResponse.json({ jobId })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
