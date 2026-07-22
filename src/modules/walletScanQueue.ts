import { kv } from '@/lib/server/kv'
import {
  walletScanJobKey,
  walletScanPendingJobKey,
  walletScanPendingKey,
  walletScanResultKey,
} from '@/src/modules/walletScanQueueKeys'

export {
  walletScanJobKey,
  walletScanPendingJobKey,
  walletScanPendingKey,
  walletScanResultKey,
} from '@/src/modules/walletScanQueueKeys'

export type WalletScanJobStatus = 'queued' | 'running' | 'done' | 'failed'

export type WalletScanJobMetadata = {
  jobId: string
  wallet: string
  status: WalletScanJobStatus
  createdAt: number
  updatedAt: number
  chains?: string[]
  scanMode?: 'normal' | 'deep'
  ip?: string
  error?: string
  finishedAt?: number
}

export type WalletScanJobPayload = {
  jobId: string
  walletAddress: string
  chains: string[]
  scanMode: 'normal' | 'deep'
  ip: string
}

const JOB_TTL_SECONDS = 30 * 60

export const WALLET_SCAN_QUEUE_UNAVAILABLE = { error: 'scan-queue-unavailable' } as const
export const WALLET_SCAN_STATUS_UNAVAILABLE = { error: 'scan-status-unavailable' } as const

export class WalletScanQueueUnavailableError extends Error {
  constructor(message = 'scan-queue-unavailable') {
    super(message)
    this.name = 'WalletScanQueueUnavailableError'
  }
}

export class WalletScanStatusUnavailableError extends Error {
  constructor(message = 'scan-status-unavailable') {
    super(message)
    this.name = 'WalletScanStatusUnavailableError'
  }
}

export function walletScanRedisConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
}

function assertWalletScanRedisConfigured(kind: 'queue' | 'status'): void {
  if (walletScanRedisConfigured()) return
  if (kind === 'queue') throw new WalletScanQueueUnavailableError('KV is not configured')
  throw new WalletScanStatusUnavailableError('KV is not configured')
}

function queueUnavailable(err: unknown): WalletScanQueueUnavailableError {
  return err instanceof WalletScanQueueUnavailableError
    ? err
    : new WalletScanQueueUnavailableError(err instanceof Error ? err.message : String(err))
}

function statusUnavailable(err: unknown): WalletScanStatusUnavailableError {
  return err instanceof WalletScanStatusUnavailableError
    ? err
    : new WalletScanStatusUnavailableError(err instanceof Error ? err.message : String(err))
}

function logQueueFailure(label: string, err: unknown): void {
  console.error(label, err)
}

export async function publishFinalWalletScanResult(jobId: string, result: unknown): Promise<void> {
  const finishedAt = Date.now()
  const finalResultKey = walletScanResultKey(jobId)
  const finalJobKey = walletScanJobKey(jobId)
  const finalJob = { jobId, status: 'done' as const, finishedAt, updatedAt: finishedAt }

  console.warn('[wallet-scan-publish]', { finalResultKey, finalJobKey })
  await kv.set(finalResultKey, result)
  await kv.set(finalJobKey, finalJob)
  console.log('[final-publish] success', { jobId })
}

export async function writeWalletScanJob(job: WalletScanJobMetadata): Promise<void> {
  assertWalletScanRedisConfigured('queue')
  try {
    await kv.set(walletScanJobKey(job.jobId), { ...job, updatedAt: Date.now() }, { ex: JOB_TTL_SECONDS })
  } catch (err) {
    logQueueFailure('[wallet-scan-queue] write-job-failure', err)
    throw queueUnavailable(err)
  }
}

export async function readWalletScanJob(jobId: string): Promise<WalletScanJobMetadata | null> {
  assertWalletScanRedisConfigured('status')
  try {
    return await kv.get<WalletScanJobMetadata>(walletScanJobKey(jobId))
  } catch (err) {
    logQueueFailure('[wallet-scan-queue] read-job-failure', err)
    throw statusUnavailable(err)
  }
}

export async function readWalletScanResult(jobId: string): Promise<unknown | null> {
  assertWalletScanRedisConfigured('status')
  try {
    return await kv.get(walletScanResultKey(jobId))
  } catch (err) {
    logQueueFailure('[wallet-scan-queue] read-result-failure', err)
    throw statusUnavailable(err)
  }
}


export async function claimNextWalletScanPayload(): Promise<WalletScanJobPayload | null> {
  assertWalletScanRedisConfigured('queue')
  let pending: string[]
  try {
    pending = (await kv.get<string[]>(walletScanPendingKey())) ?? []
  } catch (err) {
    logQueueFailure('[wallet-scan-queue] claim-read-pending-failure', err)
    throw queueUnavailable(err)
  }
  const [jobId, ...remaining] = pending
  if (!jobId) return null

  try { await kv.set(walletScanPendingKey(), remaining, { ex: JOB_TTL_SECONDS }) } catch (err) { logQueueFailure('[wallet-scan-queue] claim-write-pending-failure', err); throw queueUnavailable(err) }

  const job = await readWalletScanJob(jobId).catch((err) => { throw queueUnavailable(err) })
  if (!job) return null

  try { await kv.set(walletScanPendingJobKey(jobId), false, { ex: 60 }) } catch (err) { logQueueFailure('[wallet-scan-queue] claim-write-pending-job-failure', err); throw queueUnavailable(err) }

  try { await kv.set(walletScanJobKey(jobId), { jobId, status: 'running' }) } catch (err) { logQueueFailure('[wallet-scan-queue] claim-write-running-job-failure', err); throw queueUnavailable(err) }

  return {
    jobId,
    walletAddress: job.wallet,
    chains: job.chains ?? ['base', 'eth'],
    scanMode: job.scanMode ?? 'normal',
    ip: job.ip ?? 'unknown',
  }
}

async function triggerWalletScanWorker(): Promise<void> {
  try {
    const base = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000'

    await fetch(`${base}/api/wallet-scan/worker`, { method: 'POST' })
  } catch (err) {
    // Enqueue must stay lightweight and never run the scan inline. If the trigger fails, the
    // persisted pending job remains in KV for the next worker invocation/retry.
    console.warn('[walletScanQueue] failed to trigger background worker', { err: err instanceof Error ? err.message : String(err) })
  }
}

export async function enqueueWalletScanJob(jobId: string, payload: WalletScanJobPayload): Promise<void> {
  assertWalletScanRedisConfigured('queue')
  const now = Date.now()
  await writeWalletScanJob({
    jobId,
    wallet: payload.walletAddress,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    chains: payload.chains,
    scanMode: payload.scanMode,
    ip: payload.ip,
  })
  try {
    await kv.set(walletScanPendingJobKey(jobId), true, { ex: JOB_TTL_SECONDS })
    const pending = (await kv.get<string[]>(walletScanPendingKey())) ?? []
    await kv.set(walletScanPendingKey(), [...new Set([...pending, jobId])], { ex: JOB_TTL_SECONDS })
  } catch (err) {
    logQueueFailure('[wallet-scan-queue] enqueue-pending-failure', err)
    throw queueUnavailable(err)
  }
  await triggerWalletScanWorker()
}
