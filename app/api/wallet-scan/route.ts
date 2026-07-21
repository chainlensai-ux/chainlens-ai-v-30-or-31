import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { WALLET_SCAN_QUEUE_UNAVAILABLE, WalletScanQueueUnavailableError, enqueueWalletScanJob, walletScanRedisConfigured } from '@/src/modules/walletScanQueue'

export const runtime = 'nodejs'
export const preferredRegion = 'iad1'
export const maxDuration = 300

type ScanMode = 'normal' | 'deep'

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
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'

  if (!walletScanRedisConfigured()) {
    return NextResponse.json(WALLET_SCAN_QUEUE_UNAVAILABLE, { status: 503 })
  }

  const jobId = crypto.randomUUID()

  try {
    await enqueueWalletScanJob(jobId, { jobId, walletAddress: wallet, chains, scanMode, ip })
  } catch (err) {
    console.error('[wallet-scan] failed to enqueue job', { error: err instanceof Error ? err.message : String(err) })
    if (err instanceof WalletScanQueueUnavailableError) {
      return NextResponse.json(WALLET_SCAN_QUEUE_UNAVAILABLE, { status: 503 })
    }
    return NextResponse.json(WALLET_SCAN_QUEUE_UNAVAILABLE, { status: 503 })
  }

  return NextResponse.json({ jobId, wallet, status: 'queued' })
}
