import { redis } from '@/lib/server/cache/redisClient'
import { resetAlchemyAudit, printAlchemyAuditSummary } from '@/lib/server/alchemyAudit'
import { runWalletScanV2Worker } from '@/workers/walletScanV2'
import {
  readWalletScanJob,
  walletScanPendingJobKey,
  walletScanPendingKey,
  writeWalletScanJob,
  type WalletScanJobMetadata,
  type WalletScanJobPayload,
} from '@/src/modules/walletScanQueue'

export const runtime = 'edge'
export const preferredRegion = 'iad1'

async function readPendingJobIds(): Promise<string[]> {
  return (await redis.get<string[]>(walletScanPendingKey())) ?? []
}

async function writePendingJobIds(jobIds: string[]): Promise<void> {
  await redis.set(walletScanPendingKey(), jobIds, { ex: 30 * 60 })
}

async function claimNextPayload(): Promise<WalletScanJobPayload | null> {
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

export default async function worker(request: Request): Promise<void> {
  void request

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
