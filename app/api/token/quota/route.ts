import { NextResponse } from 'next/server'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { snapshotTokenScan } from '@/lib/tokenScanQuota'

export const runtime = 'nodejs'

// Read-only peek at the real Token Scanner weekly quota (lib/tokenScanQuota.ts), keyed exactly like
// /api/token's POST handler consumes it: per verified account (`user:<id>`), so the "N left" the
// scanner shows never drifts from what a scan will actually be charged. Mirrors
// app/api/wallet-scan/quota/route.ts. A caller without a valid session sees the Free allowance unused.
async function getPlanAndActor(req: Request): Promise<{ plan: 'free' | 'pro' | 'elite'; actor: string | null }> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return { plan: 'free', actor: null }
  try {
    const resolved = await getCurrentUserPlanFromBearerToken(token)
    return { plan: resolved.plan, actor: resolved.userId ? `user:${resolved.userId}` : null }
  } catch {
    return { plan: 'free', actor: null }
  }
}

export async function GET(req: Request): Promise<Response> {
  const { plan, actor } = await getPlanAndActor(req)
  return NextResponse.json(await snapshotTokenScan(plan, actor ?? 'anonymous'))
}
