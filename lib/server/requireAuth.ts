// requireAuthenticatedUser — ONE shared server-side auth guard, DISCLOSED (account-required task).
//
// WHY: "Nobody should be able to use ChainLens without an account" requires every protected API
// (token scans, wallet scans, Clark, watchlist, portfolio, Base Radar, FOMO/Elite) to return a real
// 401 when the caller has no valid, verified Supabase session — not just silently downgrade to the
// Free plan's rate limits the way several of these routes did before this task. This module is the
// ONE place that decision is made, reusing the EXISTING, already-tested identity verification
// (getCurrentUserPlanFromBearerToken -> Supabase auth.getUser(token)) rather than adding a second,
// independent auth check that could drift from it. Never a new Supabase client, never a new JWT
// validation path.
import { NextResponse } from 'next/server'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'

export type AuthedRequestUser = {
  userId: string
  email: string | null
  // FAIL-CLOSED, DISCLOSED (this task's own hard rule — "missing plan should safely become Free, not
  // Pro/Elite"): sourced from getCurrentUserPlanFromBearerToken's own resolveEffectivePlan call,
  // which already defaults any null/unrecognized plan value to 'free' — never re-derived here.
  plan: 'free' | 'pro' | 'elite'
}

function bearerToken(req: Request): string {
  const auth = req.headers.get('authorization') ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
}

/**
 * Verifies the request's bearer token against Supabase. Returns null for any missing/invalid/
 * expired token — the caller must then respond 401 (see unauthorizedResponse below). Never throws.
 */
export async function requireAuthenticatedUser(req: Request): Promise<AuthedRequestUser | null> {
  const token = bearerToken(req)
  if (!token) return null
  try {
    const result = await getCurrentUserPlanFromBearerToken(token)
    if (!result.userId) return null
    return { userId: result.userId, email: result.email, plan: result.plan }
  } catch {
    return null
  }
}

export const UNAUTHORIZED_MESSAGE = 'Sign in required.'

export function unauthorizedResponse(message: string = UNAUTHORIZED_MESSAGE): NextResponse {
  return NextResponse.json({ error: 'unauthorized', message }, { status: 401, headers: { 'Cache-Control': 'no-store, max-age=0' } })
}
