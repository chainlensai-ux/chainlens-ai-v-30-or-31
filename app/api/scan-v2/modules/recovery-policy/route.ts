// POST /api/scan-v2/modules/recovery-policy — returns only the 'recoveryPolicy' module of the V2 engine's report.
// Reuses the same cached-or-computed scan (src/deployment/scanCache.ts) as every other module
// route and /api/scan-v2 for an identical (walletAddress, chains, scanMode) request, so fetching
// all 9 modules for one wallet triggers exactly one runWalletScanV2() run, not nine.

import { router } from '@/src/deployment/index'
import { handleApiError } from '@/src/deployment/api'

const MODULE_KEY = 'recoveryPolicy' as const

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
