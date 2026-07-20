import { redis } from '@/lib/server/cache/redisClient'
import { resetAlchemyAudit, printAlchemyAuditSummary } from '@/lib/server/alchemyAudit'
import { runWalletScanV2Worker } from '@/workers/walletScanV2'
import {
  readWalletScanJob,
  walletScanPayloadKey,
  walletScanPendingKey,
  walletScanResultKey,
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
  return await redis.get<WalletScanJobPayload>(walletScanPayloadKey(jobId))
}

async function runWalletScanJob(payload: WalletScanJobPayload): Promise<void> {
  const existing = await readWalletScanJob(payload.jobId)
  const baseJob: WalletScanJobMetadata = existing ?? {
    jobId: payload.jobId,
    wallet: payload.walletAddress,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  await writeWalletScanJob({ ...baseJob, status: 'running', error: undefined })
  resetAlchemyAudit()

  try {
    const { body } = await runWalletScanV2Worker(
      { walletAddress: payload.walletAddress, chains: payload.chains, scanMode: payload.scanMode },
      payload.ip,
      payload.jobId,
    )
    await redis.set(walletScanResultKey(payload.jobId), body, { ex: 30 * 60 })
    await writeWalletScanJob({ ...baseJob, status: 'done', error: undefined })
    printAlchemyAuditSummary()
  } catch (err) {
    await writeWalletScanJob({
      ...baseJob,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export default async function walletScanBackgroundWorker(): Promise<void> {
  for (;;) {
    const payload = await claimNextPayload()
    if (!payload) return
    await runWalletScanJob(payload)
  }
}
