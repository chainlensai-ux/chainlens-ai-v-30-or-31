import { redis } from '@/lib/server/cache/redisClient'

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
const WALLET_SCAN_PENDING_KEY = 'walletScanPendingJobs'

export function walletScanJobKey(jobId: string): string {
  return `walletScanJob:${jobId}`
}

export function walletScanResultKey(jobId: string): string {
  return `walletScanResult:${jobId}`
}

export function walletScanPayloadKey(jobId: string): string {
  return `walletScanPayload:${jobId}`
}

export function walletScanPendingKey(): string {
  return WALLET_SCAN_PENDING_KEY
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

function walletScanWorkerUrl(): string {
  const configured = process.env.WALLET_SCAN_WORKER_URL
  if (configured) return configured

  const vercelUrl = process.env.VERCEL_URL
  if (vercelUrl) return `https://${vercelUrl}/api/wallet-scan/worker`

  return 'http://localhost:3000/api/wallet-scan/worker'
}

async function triggerWalletScanWorker(): Promise<void> {
  try {
    await fetch(walletScanWorkerUrl(), { method: 'POST' })
  } catch (err) {
    // Enqueue must stay lightweight and never run the scan inline. If the trigger fails, the
    // persisted pending job remains in KV for the next worker invocation/retry.
    console.warn('[walletScanQueue] failed to trigger background worker', { err: err instanceof Error ? err.message : String(err) })
  }
}

export async function enqueueWalletScanJob(payload: WalletScanJobPayload): Promise<void> {
  await redis.set(walletScanPayloadKey(payload.jobId), payload, { ex: JOB_TTL_SECONDS })
  const pending = (await redis.get<string[]>(walletScanPendingKey())) ?? []
  await redis.set(walletScanPendingKey(), [...pending, payload.jobId], { ex: JOB_TTL_SECONDS })
  void triggerWalletScanWorker()
}
