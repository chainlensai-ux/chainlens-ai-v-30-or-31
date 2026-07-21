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

function redisErrorDetails(error: unknown, client: FinalPublishClient): Record<string, unknown> {
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

  return { client, code, name, timeoutType, message }
}

export async function publishFinalWalletScanResult(jobId: string, result: unknown): Promise<void> {
  const now = Date.now()
  const existing = await readWalletScanJob(jobId).catch(() => null)
  const finalJob: WalletScanJobMetadata = {
    ...(existing ?? { jobId, wallet: '', createdAt: now, updatedAt: now }),
    status: 'done',
    error: undefined,
    updatedAt: now,
  }

  const finalResult = result ?? walletScanResultMissingFallback(jobId, existing)
  console.log('[walletScanQueue] final publish start', { jobId })

  const writeWithClient = async (client: FinalPublishClient): Promise<void> => {
    const set = client === 'critical' ? redis.setCritical.bind(redis) : redis.set.bind(redis)
    await Promise.all([
      set(walletScanResultKey(jobId), finalResult),
      set(walletScanJobKey(jobId), finalJob),
    ])
  }

  try {
    await writeWithClient('critical')
    console.log('[walletScanQueue] final publish success', { jobId, client: 'critical' })
    return
  } catch (criticalError) {
    console.error('[walletScanQueue] final publish failed', { jobId, ...redisErrorDetails(criticalError, 'critical') })
  }

  console.warn('[walletScanQueue] final publish falling back to normal client', { jobId })

  try {
    await writeWithClient('normal')
    console.log('[walletScanQueue] final publish success', { jobId, client: 'normal' })
  } catch (normalError) {
    console.error('[walletScanQueue] final publish failed', { jobId, ...redisErrorDetails(normalError, 'normal') })
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
