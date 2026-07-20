import { after } from 'next/server'
import { redis } from '@/lib/server/cache/redisClient'
import { runWalletScanV2Worker } from '@/workers/walletScanV2'
import { resetAlchemyAudit, printAlchemyAuditSummary } from '@/lib/server/alchemyAudit'

export type WalletScanJobStatus = 'queued' | 'running' | 'done' | 'failed'

export type WalletScanJobMetadata = {
  jobId: string
  wallet: string
  status: WalletScanJobStatus
  createdAt: number
  updatedAt: number
  error?: string
}

export type WalletScanJobPayload = {
  jobId: string
  walletAddress: string
  chains: string[]
  scanMode: 'normal' | 'deep'
  ip: string
}

const JOB_TTL_SECONDS = 30 * 60

const queue: WalletScanJobPayload[] = []
let processing = false

export function walletScanJobKey(jobId: string): string {
  return `walletScanJob:${jobId}`
}

export function walletScanResultKey(jobId: string): string {
  return `walletScanResult:${jobId}`
}

export async function writeWalletScanJob(job: WalletScanJobMetadata): Promise<void> {
  await redis.set(walletScanJobKey(job.jobId), { ...job, updatedAt: Date.now() }, { ex: JOB_TTL_SECONDS })
}

export async function readWalletScanJob(jobId: string): Promise<WalletScanJobMetadata | null> {
  return await redis.get<WalletScanJobMetadata>(walletScanJobKey(jobId))
}

export async function readWalletScanResult(jobId: string): Promise<unknown | null> {
  return await redis.get(walletScanResultKey(jobId))
}

export function enqueueWalletScanJob(payload: WalletScanJobPayload): void {
  queue.push(payload)
  after(async () => {
    await drainWalletScanQueue()
  })
}

async function drainWalletScanQueue(): Promise<void> {
  if (processing) return
  processing = true
  try {
    while (queue.length > 0) {
      const payload = queue.shift()
      if (!payload) continue
      await runWalletScanJob(payload)
    }
  } finally {
    processing = false
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
  }

  await writeWalletScanJob({ ...baseJob, status: 'running', error: undefined })
  resetAlchemyAudit()

  try {
    const { body } = await runWalletScanV2Worker(
      { walletAddress: payload.walletAddress, chains: payload.chains, scanMode: payload.scanMode },
      payload.ip,
    )
    await redis.set(walletScanResultKey(payload.jobId), body, { ex: JOB_TTL_SECONDS })
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
