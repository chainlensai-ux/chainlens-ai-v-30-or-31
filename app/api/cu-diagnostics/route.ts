// GET /api/cu-diagnostics — combined diagnostic: V1-fallback status + CU usage summary.
//
// Not part of any scan path. See app/api/_shared/v1Detector.ts's header for what "V1" means here
// (the job/poll fallback route, not the real production engine) and
// app/api/_shared/cuUsageStore.ts's header for the in-memory-per-instance durability caveat.
//
// GATING, DISCLOSED (same convention as app/api/cu-usage/route.ts and this repo's existing
// debug-engines/diagnostics routes): disabled in production unless an admin secret is presented,
// since this exposes internal CU/engine-routing diagnostics.

import { wasV1Triggered } from '@/app/api/_shared/v1Detector'
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

  return Response.json({
    v1Triggered: wasV1Triggered(),
    cuUsage: getCuUsageSummary(),
  })
}
