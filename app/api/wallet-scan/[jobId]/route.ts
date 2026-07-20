import { NextResponse } from 'next/server'
import { readWalletScanJob, readWalletScanResult } from '@/src/modules/walletScanQueue'

export async function GET(_req: Request, context: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const { jobId } = await context.params
  const job = await readWalletScanJob(jobId)

  if (!job) {
    return NextResponse.json({ jobId, status: 'not-found' }, { status: 404 })
  }

  if (job.status === 'done') {
    const result = await readWalletScanResult(jobId)
    return NextResponse.json({ jobId, status: job.status, result })
  }

  return NextResponse.json({ jobId, status: job.status, ...(job.error ? { error: job.error } : {}) })
}
