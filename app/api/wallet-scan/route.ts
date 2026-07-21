import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { redis } from '@/lib/server/cache/redisClient'
import {
  walletScanJobKey,
  walletScanPendingJobKey,
  walletScanPendingKey,
} from '@/src/modules/walletScanQueueKeys'

export const maxDuration = 10

type ScanMode = 'normal' | 'deep'

const JOB_TTL_SECONDS = 30 * 60

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null) as { walletAddress?: unknown; wallet?: unknown; chains?: unknown; scanMode?: unknown } | null
  const wallet = typeof body?.walletAddress === 'string'
    ? body.walletAddress.trim()
    : typeof body?.wallet === 'string'
      ? body.wallet.trim()
      : ''

  if (!isAddress(wallet)) {
    return NextResponse.json({ error: { message: 'Invalid wallet address', category: 'validation' } }, { status: 400 })
  }

  const chains = Array.isArray(body?.chains) && body.chains.every((chain) => typeof chain === 'string')
    ? body.chains
    : ['base', 'eth']
  const scanMode: ScanMode = body?.scanMode === 'deep' ? 'deep' : 'normal'
  const jobId = crypto.randomUUID()
  const now = Date.now()
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : new URL(req.url).origin

  await redis.set(walletScanJobKey(jobId), {
    jobId,
    wallet,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    chains,
    scanMode,
    ip,
  }, { ex: JOB_TTL_SECONDS })
  await redis.set(walletScanPendingJobKey(jobId), true, { ex: JOB_TTL_SECONDS })
  const pending = (await redis.get<string[]>(walletScanPendingKey())) ?? []
  await redis.set(walletScanPendingKey(), [...new Set([...pending, jobId])], { ex: JOB_TTL_SECONDS })
  await fetch(`${base}/api/wallet-scan/worker`, { method: 'POST' })

  return NextResponse.json({ jobId, wallet, status: 'queued' })
}
