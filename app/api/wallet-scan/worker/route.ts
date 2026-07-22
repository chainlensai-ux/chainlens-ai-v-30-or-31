import { runWalletScanWorker } from '@/src/modules/walletScanWorker'

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

export async function POST(req: Request) {
  return await runWalletScanWorker(req)
}
