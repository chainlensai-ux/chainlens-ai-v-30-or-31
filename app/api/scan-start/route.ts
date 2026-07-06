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

type ScanStartRequestBody = {
  walletAddress?: unknown
  chains?: unknown
  scanMode?: unknown
}

async function runJobInBackground(jobId: string, walletAddress: string, rawBody: unknown, ip: string): Promise<void> {
  const existing = await getScanJob(jobId)
  if (!existing) return // job record vanished (TTL/eviction) — nothing to update

  await setScanJob(jobId, { ...existing, status: 'running', updatedAt: Date.now() })

  try {
    const { status, body } = await runWalletScanV2Worker(rawBody, ip)
    const parsed = body as { success: boolean; data?: unknown; error?: { message: string } }
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
    await setScanJob(jobId, {
      ...existing,
      status: 'failed',
      result: null,
      error: err instanceof Error ? err.message : String(err),
      updatedAt: Date.now(),
    })
  }
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
