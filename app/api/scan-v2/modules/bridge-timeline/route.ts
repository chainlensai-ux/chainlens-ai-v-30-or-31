// POST /api/scan-v2/modules/bridge-timeline — returns only the 'bridgeTimeline' module: cross-chain
// bridge candidates detected by src/modules/bridgeDetection (a same-wallet, same-token,
// amount-and-time-proximity heuristic over normalized events — not a bridge-contract registry).
// Reuses the same cached-or-computed scan (src/deployment/scanCache.ts) as every other module
// route and /api/scan-v2 for an identical (walletAddress, chains, scanMode) request.

import { router } from '@/src/deployment/index'
import { handleApiError } from '@/src/deployment/api'

const MODULE_KEY = 'bridgeTimeline' as const

export async function POST(req: Request): Promise<Response> {
  try {
    const rawBody = await req.json().catch(() => null)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'

    const result = await router.handleModuleRequest(rawBody, ip, MODULE_KEY)

    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify(handleApiError(err)), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
