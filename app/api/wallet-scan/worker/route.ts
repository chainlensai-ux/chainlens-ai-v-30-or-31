import { runWalletScanWorker } from '@/src/modules/walletScanWorker'
import { timingSafeEqual } from 'node:crypto'

// DEPLOYMENT CONFIG, FIXED (audit: route/deployment correctness): this is the route that actually
// runs the long V2 pipeline (up to WORKER_GLOBAL_TIMEOUT_MS = 270s inside workers/walletScanV2.ts),
// yet it previously declared NO runtime/maxDuration/preferredRegion — while the fast enqueue route
// (app/api/wallet-scan/route.ts) declared all three. Without an explicit maxDuration this route
// runs at the platform default function duration, which on plan/config changes can drop below the
// pipeline's own 270s budget and kill the worker mid-scan with no failure record. Mirrors the
// enqueue route's exact values: nodejs runtime (required for @vercel/kv + the pipeline's Node
// APIs), iad1 (same region as the Redis endpoint per lib/server/cache/redisClient.ts), 300s.
export const runtime = 'nodejs'
export const preferredRegion = 'iad1'
export const maxDuration = 300

export function isAuthorizedWalletScanWorkerRequest(req: Request): boolean {
  const secret = process.env.WALLET_SCAN_WORKER_SECRET
  const authorization = req.headers.get('authorization') ?? ''
  if (!secret || !authorization.startsWith('Bearer ')) return false
  const provided = authorization.slice(7)
  const expectedBuffer = Buffer.from(secret)
  const providedBuffer = Buffer.from(provided)
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer)
}

export async function POST(req: Request) {
  if (!isAuthorizedWalletScanWorkerRequest(req)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  return await runWalletScanWorker(req)
}
