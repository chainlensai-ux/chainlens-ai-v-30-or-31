import { redis } from '@/lib/server/cache/redisClient'
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

export function walletScanResultMissingFallback(jobId: string, job: WalletScanJobMetadata | null): unknown {
  void jobId
  void job
  return {
    error: 'scan-final-result-unavailable',
    degraded: true,
  }
}

type FinalPublishClient = 'critical' | 'normal'

function redisErrorDetails(error: unknown): { code?: string; name?: string; timeoutType?: 'command' | 'connect' | 'unknown'; message: string } {
  const err = error as { code?: unknown; name?: unknown; message?: unknown } | null
  const message = err?.message ?? String(error)
  const code = typeof err?.code === 'string' ? err.code : undefined
  const name = typeof err?.name === 'string' ? err.name : undefined
  const lowerMessage = String(message).toLowerCase()
  const timeoutType = code === 'ETIMEDOUT' || lowerMessage.includes('command timed out')
    ? 'command'
    : lowerMessage.includes('connect') && lowerMessage.includes('timeout')
      ? 'connect'
      : lowerMessage.includes('timeout')
        ? 'unknown'
        : undefined

  return { code, name, timeoutType, message: String(message) }
}

export async function publishFinalWalletScanResult(jobId: string, result: unknown): Promise<void> {
  const finishedAt = Date.now()
  const finalJob = { jobId, status: 'done' as const, finishedAt }
  const finalResult = result ?? walletScanResultMissingFallback(jobId, null)
  console.log('[final-publish] start', { jobId })

  const writeWithClient = async (client: FinalPublishClient): Promise<void> => {
    const set = client === 'critical' ? redis.setCritical.bind(redis) : redis.set.bind(redis)
    await set(walletScanResultKey(jobId), finalResult)
    await set(walletScanJobKey(jobId), finalJob)
  }

  try {
    await writeWithClient('critical')
    console.log('[final-publish] success', { jobId, client: 'critical' })
    return
  } catch (criticalError) {
    console.error('[final-publish] failure-critical', { jobId, ...redisErrorDetails(criticalError) })
  }

  console.warn('[final-publish] fallback-normal-client', { jobId })

  try {
    await writeWithClient('normal')
    console.log('[final-publish] success', { jobId, client: 'normal' })
  } catch (normalError) {
    console.error('[final-publish] failure-normal', { jobId, ...redisErrorDetails(normalError) })
    throw new Error('wallet_scan_final_publish_failed')
  }
}

export async function writeWalletScanJob(job: WalletScanJobMetadata): Promise<void> {
  try { await redis.set(walletScanJobKey(job.jobId), { ...job, updatedAt: Date.now() }, { ex: JOB_TTL_SECONDS }) } catch {}
}

export async function readWalletScanJob(jobId: string): Promise<WalletScanJobMetadata | null> {
  return await redis.get<WalletScanJobMetadata>(walletScanJobKey(jobId)).catch(() => null)
}

export async function readWalletScanResult(jobId: string): Promise<unknown | null> {
  return await redis.get(walletScanResultKey(jobId)).catch(() => null)
}


export async function claimNextWalletScanPayload(): Promise<WalletScanJobPayload | null> {
  const pending = (await redis.get<string[]>(walletScanPendingKey()).catch(() => null)) ?? []
  const [jobId, ...remaining] = pending
  if (!jobId) return null

  try { await redis.set(walletScanPendingKey(), remaining, { ex: JOB_TTL_SECONDS }) } catch {}

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
  try { await redis.set(walletScanPendingJobKey(jobId), true, { ex: JOB_TTL_SECONDS }) } catch {}
  const pending = (await redis.get<string[]>(walletScanPendingKey()).catch(() => null)) ?? []
  try { await redis.set(walletScanPendingKey(), [...new Set([...pending, jobId])], { ex: JOB_TTL_SECONDS }) } catch {}
  await triggerWalletScanWorker()
}
