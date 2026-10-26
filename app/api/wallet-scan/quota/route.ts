import { NextResponse } from 'next/server'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { snapshotDailyScan } from '@/lib/scanQuota'

export const runtime = 'nodejs'

// Read-only peek at the deep-scan quota, keyed exactly like POST /api/wallet-scan consumes it: per
// verified account (`user:<id>`). A caller without a valid session sees the Free allowance unused.
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
  return NextResponse.json(await snapshotDailyScan(plan, actor ?? 'anonymous'))
}
