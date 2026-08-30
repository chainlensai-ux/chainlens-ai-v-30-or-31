import { NextRequest, NextResponse } from 'next/server'
import { createPayPalSubscription } from '@/lib/paypal'
import { createAnonSupabaseClient, createServiceRoleClient } from '@/lib/supabase/userSettings'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'
import { emptyPaypalPaymentAudit, logPaypalPaymentAudit } from '@/lib/server/paypalAudit'

const limiter = createRateLimiter({ windowMs: 60_000, max: 10 })

// Preview/production base URL used to build the return/cancel redirect PayPal sends the user back
// to after they approve (or cancel) the subscription on PayPal's own site.
function resolveAppUrl(request: NextRequest): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ??
    `${request.nextUrl.protocol}//${request.headers.get('host') ?? 'www.chainlensai.app'}`
  )
}

// Read lazily (at request time), not once at module load — matches the webhook route's
// planMatchesPlanId, which reads the same env vars per-call for the same reason.
function planIds(): Record<'pro' | 'elite', string | undefined> {
  return {
    pro: process.env.PAYPAL_PRO_PLAN_ID,
    elite: process.env.PAYPAL_ELITE_PLAN_ID,
  }
}

// TESTABILITY, DISCLOSED (PayPal payments audit): optional dependency-injection seam, defaulting to
// the real Supabase/GoTrue clients in production — mirrors the fetchImpl-injection pattern already
// used elsewhere in this codebase (e.g. lib/server/solana/rpcClient.ts) so this route's auth/
// duplicate-guard logic can be exercised with a fake in-memory client in tests, without touching a
// real database or network. Passing no second argument (every real Next.js request) is identical to
// the pre-refactor behavior.
export type CreateSubscriptionDeps = {
  getAnonClient?: () => ReturnType<typeof createAnonSupabaseClient>
  getServiceClient?: () => ReturnType<typeof createServiceRoleClient>
}

// Thin wrapper, DISCLOSED: Next.js's generated route-handler type requires POST's signature to be
// exactly `(request, context: { params: Promise<{}> }) => ...` for a route with no dynamic segments
// — a second `deps` parameter fails that generated check. handleCreateSubscription carries the real
// logic (and the injectable deps for tests); POST itself stays a 1-argument passthrough.
export async function POST(request: NextRequest) {
  return handleCreateSubscription(request)
}

export async function handleCreateSubscription(request: NextRequest, deps: CreateSubscriptionDeps = {}) {
  const audit = emptyPaypalPaymentAudit()
  if (!limiter.check(getClientIp(request))) {
    return NextResponse.json({ error: 'Too many requests.' }, { status: 429 })
  }

  const authHeader = request.headers.get('authorization')
  if (!authHeader?.toLowerCase().startsWith('bearer ')) {
    audit.failureReason = 'unauthenticated'
    logPaypalPaymentAudit(audit)
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }
  const token = authHeader.slice(7).trim()
  const authSupabase = (deps.getAnonClient ?? createAnonSupabaseClient)()
  if (!token || !authSupabase) {
    audit.failureReason = 'unauthenticated'
    logPaypalPaymentAudit(audit)
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }
  const { data: userData, error: authErr } = await authSupabase.auth.getUser(token)
  if (authErr || !userData.user) {
    audit.failureReason = 'unauthenticated'
    logPaypalPaymentAudit(audit)
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }
  const userId = userData.user.id
  audit.userId = userId

  // PLAN ALLOWLIST, DISCLOSED (PayPal payments audit fix): previously any non-'elite' value —
  // including a typo, an unexpected type, or a tampered/garbage string — silently coerced to 'pro'
  // rather than being rejected. Silent coercion is a correctness risk (a client bug or a probing
  // request could end up creating a real PayPal subscription for a plan nobody actually asked for)
  // even though it could never grant a plan beyond Pro/Elite. Now: only the literal strings 'pro' or
  // 'elite' are accepted; anything else is rejected outright with 400. The requested plan is never
  // used for anything but selecting which server-side PAYPAL_*_PLAN_ID to use — the price itself is
  // never client-supplied at all (it lives entirely in the PayPal-side Billing Plan).
  let requestedPlan: string | undefined
  try {
    const body = await request.json() as { plan?: unknown }
    requestedPlan = typeof body.plan === 'string' ? body.plan : undefined
  } catch {
    requestedPlan = undefined
  }
  if (requestedPlan !== 'pro' && requestedPlan !== 'elite') {
    audit.requestedPlan = null
    audit.failureReason = 'invalid_plan'
    logPaypalPaymentAudit(audit)
    return NextResponse.json({ error: 'Invalid plan requested. Must be "pro" or "elite".' }, { status: 400 })
  }
  const plan: 'pro' | 'elite' = requestedPlan
  audit.requestedPlan = plan

  const planId = planIds()[plan]
  audit.paypalPlanId = planId ?? null
  if (!planId) {
    audit.failureReason = 'plan_not_configured'
    logPaypalPaymentAudit(audit)
    return NextResponse.json({ error: `PayPal Billing Plan for "${plan}" is not configured (missing PAYPAL_${plan.toUpperCase()}_PLAN_ID).` }, { status: 503 })
  }

  // DUPLICATE-SUBSCRIPTION GUARD, DISCLOSED: without this, nothing stops the same user clicking
  // "Subscribe" twice (e.g. a double-click, or subscribing again after already having an active
  // subscription) and ending up with two live PayPal subscriptions both actually charging them,
  // with this app's DB only ever reflecting one. Block creating a new one while an active or
  // pending subscription already exists for this user.
  //
  // SERVICE-ROLE + ERROR-CHECKED FIX, DISCLOSED (PayPal payments audit): this used to query via a
  // JWT-forwarding client (createAuthedSupabaseClient(token)) and never checked the query's `error`
  // — the exact PostgREST JWT-clock-skew failure mode already found and fixed in three other places
  // in this codebase (see getVerifiedUserPlan's own DISCLOSED comment in lib/supabase/userSettings.ts
  // for the full root cause). A rejected query here would silently read as "no existing
  // subscription" and let a duplicate subscription through undetected. Identity is already verified
  // independently via GoTrue (userData.user, above), so this read uses the service-role client
  // instead — never re-validates the caller's JWT against Postgres's clock — and the query stays
  // scoped to the already-verified user_id, so this is not a widened trust boundary. A genuine
  // lookup failure now fails CLOSED (blocks subscription creation) rather than failing open.
  const serviceClient = (deps.getServiceClient ?? createServiceRoleClient)()
  if (!serviceClient) {
    audit.failureReason = 'service_client_unavailable'
    logPaypalPaymentAudit(audit)
    return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 500 })
  }
  const { data: existingSubscription, error: existingError } = await serviceClient
    .from('paypal_subscriptions')
    .select('status')
    .eq('user_id', userId)
    .in('status', ['pending', 'active'])
    .limit(1)
    .maybeSingle()
  if (existingError) {
    audit.failureReason = 'duplicate_check_failed'
    logPaypalPaymentAudit(audit)
    return NextResponse.json({ error: 'Could not verify existing subscription state. Try again.' }, { status: 500 })
  }
  if (existingSubscription) {
    audit.failureReason = 'duplicate_subscription'
    logPaypalPaymentAudit(audit)
    return NextResponse.json(
      { error: `You already have a ${existingSubscription.status} PayPal subscription. Cancel it in your PayPal account before starting a new one.` },
      { status: 409 },
    )
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
    audit.failureReason = `checkout_${result.reason}`
    logPaypalPaymentAudit(audit)
    const status = result.reason === 'not_configured' ? 503 : result.reason === 'auth_failed' ? 502 : 502
    return NextResponse.json({ error: `PayPal subscription creation failed (${result.reason}).` }, { status })
  }

  audit.checkoutCreated = true
  audit.subscriptionId = result.subscriptionId
  logPaypalPaymentAudit(audit)
  return NextResponse.json({ approvalUrl: result.approvalUrl, subscriptionId: result.subscriptionId }, { status: 200 })
}
