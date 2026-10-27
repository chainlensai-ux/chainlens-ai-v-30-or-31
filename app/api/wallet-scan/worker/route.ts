import { runWalletScanWorker } from '@/src/modules/walletScanWorker'
import { checkWorkerRequest, isAuthorizedWalletScanWorkerRequest, WORKER_SECRET_HEADER } from '@/src/lib/walletScanWorkerAuth'

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
  if (!isAuthorizedWalletScanWorkerRequest(req)) {
    const auth = checkWorkerRequest(req)
    // Which check failed and where the call landed — never the secret itself.
    console.warn('[wallet-scan-worker] unauthorized internal call', {
      reason: auth.ok ? 'secret_mismatch' : auth.reason,
      host: req.headers.get('host'),
      hasAuthorizationHeader: req.headers.has('authorization'),
      hasWorkerSecretHeader: req.headers.has(WORKER_SECRET_HEADER),
    })
    return Response.json({ error: 'unauthorized', reason: auth.ok ? 'secret_mismatch' : auth.reason }, { status: 401 })
  }
  return await runWalletScanWorker(req)
}
