// POST /api/scan-v2 — kept available as a separate, explicitly-named debugging alias for the V2
// engine. Since src/deployment/router.ts's handleScanRequest() now calls runWalletScanV2()
// directly (the V2 migration updated it in place — see app/api/scan/route.ts), this route is
// functionally identical to production's POST /api/scan; it exists only so "the V2 endpoint" has
// a stable, unambiguous name during the migration/debugging period, independent of whatever
// production's /api/scan happens to be wired to at any given time.

import { router } from '@/src/deployment/index'
import { handleApiError } from '@/src/deployment/api'

export async function POST(req: Request): Promise<Response> {
  try {
    const rawBody = await req.json().catch(() => null)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'

    const result = await router.handleScanRequest(rawBody, ip)

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
