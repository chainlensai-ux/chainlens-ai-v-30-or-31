import { NextResponse } from 'next/server'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { snapshotTokenScan } from '@/lib/tokenScanQuota'

export const runtime = 'nodejs'

// Read-only peek at the real Token Scanner weekly quota (lib/tokenScanQuota.ts) — same
// plan+IP actor key /api/token's POST handler consumes against, so this never drifts from
// what a scan will actually be charged. Mirrors app/api/wallet-scan/quota/route.ts.
async function getPlan(req: Request): Promise<'free' | 'pro' | 'elite'> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return 'free'
  try { return (await getCurrentUserPlanFromBearerToken(token)).plan } catch { return 'free' }
}

export async function GET(req: Request): Promise<Response> {
  const plan = await getPlan(req)
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  return NextResponse.json(snapshotTokenScan(plan, ip))
}
