import { after } from 'next/server'
import type { WalletScanJobMetadata, WalletScanJobPayload } from '@/src/modules/walletScanQueue'

export const runtime = 'nodejs'
export const preferredRegion = 'iad1'
export const maxDuration = 300

function timeoutResultBody(timeoutMs: number): unknown {
  return { success: false, error: 'wallet-scan-timeout', timeoutMs, partial: true }
}

function invalidShapeResultBody(): unknown {
  return { success: false, error: 'wallet-scan-invalid-result-shape', partial: true }
}

function errorResultBody(err: unknown): unknown {
  return { success: false, error: err instanceof Error ? err.message : String(err), partial: true }
}

async function runWithTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function runWalletScanJob(payload: WalletScanJobPayload): Promise<void> {
  const { resetAlchemyAudit, printAlchemyAuditSummary } = await import('@/lib/server/alchemyAudit')
  const { runWalletScanV2Worker } = await import('@/workers/walletScanV2')
  const { readWalletScanJob, writeWalletScanJob, publishFinalWalletScanResult } = await import('@/src/modules/walletScanQueue')
  const existing = await readWalletScanJob(payload.jobId)
  const baseJob: WalletScanJobMetadata = existing ?? {
    jobId: payload.jobId,
    wallet: payload.walletAddress,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    chains: payload.chains,
    scanMode: payload.scanMode,
    ip: payload.ip,
  }

  await writeWalletScanJob({ ...baseJob, status: 'running', error: undefined })
  console.log('[wallet-scan-worker] job started', { jobId: payload.jobId })
  resetAlchemyAudit()

  let finalBody: unknown
  let completedSuccessfully = false
  const timeoutMs = 285_000

  try {
    const result = await runWithTimeout(
      runWalletScanV2Worker(
        { walletAddress: payload.walletAddress, chains: payload.chains, scanMode: payload.scanMode },
        payload.ip,
        payload.jobId,
      ),
      timeoutMs,
    )

    if (typeof result === 'object' && result !== null && 'timedOut' in result) {
      finalBody = timeoutResultBody(timeoutMs)
      console.error('[wallet-scan-worker] job timed out before finalization', { jobId: payload.jobId, timeoutMs })
    } else if (!result || typeof result !== 'object' || !('body' in result)) {
      finalBody = invalidShapeResultBody()
      console.error('[wallet-scan-worker] job returned invalid result shape', { jobId: payload.jobId })
    } else {
      finalBody = result.body ?? invalidShapeResultBody()
      completedSuccessfully = true
    }
  } catch (err) {
    finalBody = errorResultBody(err)
    console.error('[wallet-scan-worker] job completed with partial failure', err)
  }

  await publishFinalWalletScanResult(payload.jobId, finalBody)

  if (completedSuccessfully) {
    printAlchemyAuditSummary()
    console.log('[wallet-scan-worker] job completed', { jobId: payload.jobId })
  }
}

async function drainWalletScanQueue(): Promise<void> {
  const { claimNextWalletScanPayload } = await import('@/src/modules/walletScanQueue')

  for (;;) {
    try {
      const payload = await claimNextWalletScanPayload()
      if (!payload) return
      await runWalletScanJob(payload)
    } catch (err) {
      console.error('[wallet-scan-worker] loop failed', err)
    }
  }
}

export async function POST(): Promise<Response> {
  after(async () => {
    await drainWalletScanQueue()
  })

  return new Response(null, { status: 202 })
}
