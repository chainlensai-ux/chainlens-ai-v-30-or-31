import { after } from 'next/server'
import type { WalletScanJobMetadata, WalletScanJobPayload } from '@/src/modules/walletScanQueue'

export const runtime = 'nodejs'
export const preferredRegion = 'iad1'
export const maxDuration = 300

async function readPendingJobIds(): Promise<string[]> {
  const { redis } = await import('@/lib/server/cache/redisClient')
  const { walletScanPendingKey } = await import('@/src/modules/walletScanQueueKeys')
  return (await redis.get<string[]>(walletScanPendingKey()).catch(() => null)) ?? []
}

async function writePendingJobIds(jobIds: string[]): Promise<void> {
  const { redis } = await import('@/lib/server/cache/redisClient')
  const { walletScanPendingKey } = await import('@/src/modules/walletScanQueueKeys')
  try { await redis.set(walletScanPendingKey(), jobIds, { ex: 30 * 60 }) } catch {}
}

async function claimNextPayload(): Promise<WalletScanJobPayload | null> {
  const { redis } = await import('@/lib/server/cache/redisClient')
  const { readWalletScanJob } = await import('@/src/modules/walletScanQueue')
  const { walletScanPendingJobKey } = await import('@/src/modules/walletScanQueueKeys')
  const pending = await readPendingJobIds()
  const [jobId, ...remaining] = pending
  if (!jobId) return null

  await writePendingJobIds(remaining)
  const job = await readWalletScanJob(jobId)
  if (!job) return null

  try { await redis.set(walletScanPendingJobKey(jobId), false, { ex: 60 }) } catch {}
  return {
    jobId,
    walletAddress: job.wallet,
    chains: job.chains ?? ['base', 'eth'],
    scanMode: job.scanMode ?? 'normal',
    ip: job.ip ?? 'unknown',
  }
}

async function runWalletScanJob(payload: WalletScanJobPayload): Promise<void> {
  const { resetAlchemyAudit, printAlchemyAuditSummary } = await import('@/lib/server/alchemyAudit')
  const { runWalletScanV2Worker } = await import('@/workers/walletScanV2')
  const { redis } = await import('@/lib/server/cache/redisClient')
  const { readWalletScanJob, writeWalletScanJob } = await import('@/src/modules/walletScanQueue')
  const { walletScanJobKey, walletScanResultKey } = await import('@/src/modules/walletScanQueueKeys')
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

  try {
    const result = await runWalletScanV2Worker(
      { walletAddress: payload.walletAddress, chains: payload.chains, scanMode: payload.scanMode },
      payload.ip,
      payload.jobId,
    )
    try { await redis.set(walletScanResultKey(payload.jobId), result.body, { ex: 30 * 60 }) } catch {}
    try { await redis.set(walletScanJobKey(payload.jobId), {
      ...baseJob,
      status: 'done',
      error: undefined,
      updatedAt: Date.now(),
    }, { ex: 30 * 60 }) } catch {}
    printAlchemyAuditSummary()
    console.log('[wallet-scan-worker] job completed', { jobId: payload.jobId })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    const errorBody = { success: false, error: errorMessage, partial: true }
    try { await redis.set(walletScanResultKey(payload.jobId), errorBody, { ex: 30 * 60 }) } catch {}
    try { await redis.set(walletScanJobKey(payload.jobId), {
      ...baseJob,
      status: 'done',
      error: undefined,
      updatedAt: Date.now(),
    }, { ex: 30 * 60 }) } catch {}
    console.error('[wallet-scan-worker] job completed with partial failure', err)
  }
}

async function drainWalletScanQueue(): Promise<void> {
  for (;;) {
    try {
      const payload = await claimNextPayload()
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
