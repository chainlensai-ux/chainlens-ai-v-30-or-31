import { NextResponse, after } from 'next/server'
import type { WalletScanJobMetadata, WalletScanJobPayload } from '@/src/modules/walletScanQueue'

export const runtime = 'edge'
export const preferredRegion = 'iad1'

async function readPendingJobIds(): Promise<string[]> {
  const { redis } = await import('@/lib/server/cache/redisClient')
  const { walletScanPendingKey } = await import('@/src/modules/walletScanQueue')
  return (await redis.get<string[]>(walletScanPendingKey())) ?? []
}

async function writePendingJobIds(jobIds: string[]): Promise<void> {
  const { redis } = await import('@/lib/server/cache/redisClient')
  const { walletScanPendingKey } = await import('@/src/modules/walletScanQueue')
  await redis.set(walletScanPendingKey(), jobIds, { ex: 30 * 60 })
}

async function claimNextPayload(): Promise<WalletScanJobPayload | null> {
  const { redis } = await import('@/lib/server/cache/redisClient')
  const { readWalletScanJob, walletScanPendingJobKey } = await import('@/src/modules/walletScanQueue')
  const pending = await readPendingJobIds()
  const [jobId, ...remaining] = pending
  if (!jobId) return null

  await writePendingJobIds(remaining)
  const job = await readWalletScanJob(jobId)
  if (!job) return null

  await redis.set(walletScanPendingJobKey(jobId), false, { ex: 60 })
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
  const { readWalletScanJob, writeWalletScanJob } = await import('@/src/modules/walletScanQueue')
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
    await runWalletScanV2Worker(
      { walletAddress: payload.walletAddress, chains: payload.chains, scanMode: payload.scanMode },
      payload.ip,
      payload.jobId,
    )
    printAlchemyAuditSummary()
    console.log('[wallet-scan-worker] job completed', { jobId: payload.jobId })
  } catch (err) {
    await writeWalletScanJob({
      ...baseJob,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    })
    console.error('[wallet-scan-worker] job failed', err)
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

export default async function worker(request: Request): Promise<Response> {
  void request

  after(async () => {
    await drainWalletScanQueue()
  })

  return NextResponse.json({ accepted: true })
}

export const POST = worker
