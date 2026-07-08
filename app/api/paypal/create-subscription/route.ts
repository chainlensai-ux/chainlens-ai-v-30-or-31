import { NextRequest, NextResponse } from 'next/server'
import { createPayPalSubscription } from '@/lib/paypal'
import { createAnonSupabaseClient } from '@/lib/supabase/userSettings'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'

const limiter = createRateLimiter({ windowMs: 60_000, max: 10 })

// Preview/production base URL used to build the return/cancel redirect PayPal sends the user back
// to after they approve (or cancel) the subscription on PayPal's own site.
function resolveAppUrl(request: NextRequest): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ??
    `${request.nextUrl.protocol}//${request.headers.get('host') ?? 'www.chainlensai.app'}`
  )
}

const PLAN_IDS: Record<'pro' | 'elite', string | undefined> = {
  pro: process.env.PAYPAL_PRO_PLAN_ID,
  elite: process.env.PAYPAL_ELITE_PLAN_ID,
}

export async function POST(request: NextRequest) {
  if (!limiter.check(getClientIp(request))) {
    return NextResponse.json({ error: 'Too many requests.' }, { status: 429 })
  }

  const authHeader = request.headers.get('authorization')
  if (!authHeader?.toLowerCase().startsWith('bearer ')) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }
  const token = authHeader.slice(7).trim()
  const authSupabase = createAnonSupabaseClient()
  if (!token || !authSupabase) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }
  const { data: userData, error: authErr } = await authSupabase.auth.getUser(token)
  if (authErr || !userData.user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }
  const userId = userData.user.id

  let plan: 'pro' | 'elite'
  try {
    const body = await request.json() as { plan?: string }
    plan = body.plan === 'elite' ? 'elite' : 'pro'
  } catch {
    plan = 'pro'
  }

  const planId = PLAN_IDS[plan]
  if (!planId) {
    return NextResponse.json({ error: `PayPal Billing Plan for "${plan}" is not configured (missing PAYPAL_${plan.toUpperCase()}_PLAN_ID).` }, { status: 503 })
  }

  const appUrl = resolveAppUrl(request)
  // custom_id carries "<plan>:<userId>" — this is how the webhook (which cannot trust anything a
  // client sends) attributes BILLING.SUBSCRIPTION.* events back to the right ChainLens account.
  const customId = `${plan}:${userId}`

  const result = await createPayPalSubscription(
    planId,
    customId,
    `${appUrl}/pricing?paypal_subscription=approved`,
    `${appUrl}/pricing?paypal_subscription=cancelled`,
  )

  if (!result.ok) {
    const status = result.reason === 'not_configured' ? 503 : result.reason === 'auth_failed' ? 502 : 502
    return NextResponse.json({ error: `PayPal subscription creation failed (${result.reason}).` }, { status })
  }

  return NextResponse.json({ approvalUrl: result.approvalUrl, subscriptionId: result.subscriptionId }, { status: 200 })
}
