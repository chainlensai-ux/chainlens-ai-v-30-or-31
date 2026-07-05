// GET /api/cu-usage — diagnostic-only CU (provider-call) usage summary.
//
// Not part of any scan path — reads app/api/_shared/cuUsageStore.ts's in-memory counters, which
// app/api/scan-v2/full-scan/route.ts updates additively after each scan. See cuUsageStore.ts's own
// header for the real durability caveat (per-instance in-memory, resets on cold start).
//
// GATING, DISCLOSED (addition beyond the literal spec): this exposes internal CU/provider-call
// counts, the same sensitivity class as this repo's existing debug-engines/diagnostics routes
// (app/api/debug-engines/route.ts, app/api/diagnostics/pricing/route.ts) — both disabled in
// production unless an admin secret is presented. Following that same real, already-established
// convention here rather than shipping a second, differently-secured diagnostic route.

import { getCuUsageSummary } from '@/app/api/_shared/cuUsageStore'

export async function GET(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === 'production') {
    const auth = req.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    if (!process.env.ADMIN_SECRET || token !== process.env.ADMIN_SECRET) {
      return new Response(JSON.stringify({ success: false, error: 'Not available in production' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }

  // eslint-disable-next-line no-console
  console.debug('[CU-USAGE] summary requested')
  return Response.json(getCuUsageSummary())
}
