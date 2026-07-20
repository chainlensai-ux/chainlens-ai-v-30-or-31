import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { enqueueWalletScanJob, writeWalletScanJob, type WalletScanJobMetadata } from '@/src/modules/walletScanQueue'

export const maxDuration = 10

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
  const jobId = crypto.randomUUID()
  const now = Date.now()
  const job: WalletScanJobMetadata = { jobId, wallet, status: 'queued', createdAt: now, updatedAt: now }

  await writeWalletScanJob(job)
  enqueueWalletScanJob({
    jobId,
    walletAddress: wallet,
    chains,
    scanMode,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown',
  })

  return NextResponse.json({ jobId, wallet, status: 'queued' })
}
