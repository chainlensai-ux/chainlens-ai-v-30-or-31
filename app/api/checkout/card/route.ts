import { NextRequest, NextResponse } from 'next/server'
import { createAnonSupabaseClient } from '@/lib/supabase/userSettings'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'
import { emptyCheckoutFlowAudit, logCheckoutFlowAudit } from '@/lib/server/checkoutFlowAudit'
import { CARD_CHECKOUT_AVAILABLE } from '@/lib/pricingPlans'

// CARD CHECKOUT, DISCLOSED (card/PayPal checkout fix task): no real card payment provider (Stripe
// or similar) is wired into this codebase — "Card" on /pricing used to silently reuse the PayPal
// Subscriptions endpoint (cardCheckoutUrl === '/api/paypal/create-subscription'), which is why
// clicking "Card" redirected to PayPal's hosted approval page and forced a PayPal login instead of
// a real card form. This route is the real, honest replacement: it requires a signed-in user (same
// as every other checkout-creation route) and always responds 503 "not configured" until a real
// card provider is actually wired here — it never redirects anywhere, and never claims success.
// The frontend keeps the Card option visually disabled ("Card checkout coming soon") so this route
// is defense-in-depth against a direct/bypassed request, not the primary gate.
const limiter = createRateLimiter({ windowMs: 60_000, max: 10 })

// TESTABILITY, DISCLOSED: same injectable-client seam as /api/paypal/create-subscription — lets
// tests exercise the auth-required / plan-parsing behavior with an in-memory fake instead of a real
// Supabase project. Every real request (no second argument) behaves identically to before.
export type CreateCardCheckoutDeps = {
  getAnonClient?: () => ReturnType<typeof createAnonSupabaseClient>
}

export async function POST(request: NextRequest) {
  return handleCreateCardCheckout(request)
}

export async function handleCreateCardCheckout(request: NextRequest, deps: CreateCardCheckoutDeps = {}) {
  const audit = emptyCheckoutFlowAudit()
  audit.selectedPaymentMethod = 'card'
  audit.provider = 'card'
  audit.cardProviderConfigured = CARD_CHECKOUT_AVAILABLE
  audit.isSubscription = true
  audit.billingInterval = 'monthly'
  audit.redirectsToPaypalLogin = false

  if (!limiter.check(getClientIp(request))) {
    audit.finalStatus = 'blocked'
    audit.failureReason = 'rate_limited'
    logCheckoutFlowAudit(audit)
    return NextResponse.json({ error: 'Too many requests.' }, { status: 429 })
  }

  const authHeader = request.headers.get('authorization')
  const token = authHeader?.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : ''
  const authSupabase = (deps.getAnonClient ?? createAnonSupabaseClient)()
  if (!token || !authSupabase) {
    audit.finalStatus = 'blocked'
    audit.failureReason = 'unauthenticated'
    logCheckoutFlowAudit(audit)
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }
  const { data: userData, error: authErr } = await authSupabase.auth.getUser(token)
  if (authErr || !userData.user) {
    audit.finalStatus = 'blocked'
    audit.failureReason = 'unauthenticated'
    logCheckoutFlowAudit(audit)
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }
  audit.userIdPresent = true

  let requestedPlan: string | undefined
  try {
    const body = await request.json() as { plan?: unknown }
    requestedPlan = typeof body.plan === 'string' ? body.plan : undefined
  } catch {
    requestedPlan = undefined
  }
  audit.selectedPlan = requestedPlan === 'pro' || requestedPlan === 'elite' ? requestedPlan : null

  // No real card provider configured — never fabricate a checkout URL or claim success.
  audit.finalStatus = 'failed'
  audit.failureReason = 'card_provider_not_configured'
  logCheckoutFlowAudit(audit)
  return NextResponse.json(
    { error: 'Card checkout is not configured yet. Use PayPal or Crypto for now.' },
    { status: 503 },
  )
}
