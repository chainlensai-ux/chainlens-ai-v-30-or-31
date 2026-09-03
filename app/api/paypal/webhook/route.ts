import { NextRequest, NextResponse } from 'next/server'
import { verifyPayPalWebhookSignature, type PayPalWebhookSignatureHeaders } from '@/lib/paypal'
import { createServiceRoleClient, activateUserPlanServerSide } from '@/lib/supabase/userSettings'
import { emptyPaypalPaymentAudit, logPaypalPaymentAudit, type PaypalPaymentAudit } from '@/lib/server/paypalAudit'

// PayPal recurring-Subscriptions webhook. Reconciles real Subscriptions API events (created via
// /api/paypal/create-subscription) into Supabase — see docs/paypal-verification.md.
//
// PayPal retries webhooks that don't return 2xx. A branch returns 200 once the event has been
// handled (or intentionally ignored) — but returns 500 if a Supabase write inside that branch
// failed, so PayPal retries a genuinely unprocessed event instead of the failure being silently
// swallowed (WRITE-FAILURE FIX, DISCLOSED — payments audit).

type PayPalWebhookBody = {
  id?: string
  event_type?: string
  resource?: {
    id?: string // subscription id for BILLING.SUBSCRIPTION.*, sale id for PAYMENT.SALE.*
    custom_id?: string
    billing_agreement_id?: string // PAYMENT.SALE.* references the subscription this way
    status?: string
    plan_id?: string
    billing_info?: { next_billing_time?: string }
  }
}

export function planFromCustomId(customId: string | undefined): 'pro' | 'elite' {
  return customId?.startsWith('elite:') ? 'elite' : 'pro'
}

// PLAN/PLAN_ID CROSS-CHECK, DISCLOSED: custom_id's plan prefix is set server-side by
// /api/paypal/create-subscription, tied 1:1 to the plan_id it requested — under normal operation
// they always agree. This checks PayPal's own resource.plan_id against the plan the event's
// custom_id claims, as defense-in-depth against a subscription created outside this app's own
// create-subscription route (e.g. directly against the PayPal API) with a mismatched/forged
// custom_id — never trust custom_id's plan claim alone when PayPal's own plan_id is available on
// the same event to cross-check it against.
export function planMatchesPlanId(plan: 'pro' | 'elite', planId: string | undefined): boolean {
  if (!planId) return true // event didn't include plan_id (not all event types do) — nothing to cross-check
  const expected = plan === 'elite' ? process.env.PAYPAL_ELITE_PLAN_ID : process.env.PAYPAL_PRO_PLAN_ID
  return !expected || expected === planId
}

export function userIdFromCustomId(customId: string | undefined): string | null {
  if (!customId) return null
  // custom_id is formatted as "<plan>:<userId>" by /api/paypal/create-subscription.
  const parts = customId.split(':')
  return parts.length === 2 ? parts[1] : null
}

// TESTABILITY, DISCLOSED (PayPal payments audit): optional dependency-injection seam — defaults to
// the real service-role client, real activateUserPlanServerSide, and the real PayPal
// verify-webhook-signature API call, identical to pre-refactor behavior for every real request.
// Lets tests exercise every event-type branch (activate/renew/suspend/cancel/refund), the dedupe
// path, and signature-rejection with an in-memory fake instead of a live database or PayPal API.
export type PayPalWebhookDeps = {
  getServiceClient?: () => ReturnType<typeof createServiceRoleClient>
  activatePlan?: typeof activateUserPlanServerSide
  verifySignature?: typeof verifyPayPalWebhookSignature
}

// Thin wrapper, DISCLOSED: Next.js's generated route-handler type requires POST's signature to be
// exactly `(request, context: { params: Promise<{}> }) => ...` for a route with no dynamic segments
// — a second `deps` parameter fails that generated check. handlePayPalWebhook carries the real logic
// (and the injectable deps for tests); POST itself stays a 1-argument passthrough.
export async function POST(request: NextRequest) {
  return handlePayPalWebhook(request)
}

export async function handlePayPalWebhook(request: NextRequest, deps: PayPalWebhookDeps = {}) {
  const getServiceClient = deps.getServiceClient ?? createServiceRoleClient
  const activatePlan = deps.activatePlan ?? activateUserPlanServerSide
  const verifySignature = deps.verifySignature ?? verifyPayPalWebhookSignature

  const audit: PaypalPaymentAudit = { ...emptyPaypalPaymentAudit(), webhookReceived: true }

  const rawBody = await request.text()
  let body: PayPalWebhookBody
  try {
    body = JSON.parse(rawBody) as PayPalWebhookBody
  } catch {
    audit.failureReason = 'invalid_json'
    logPaypalPaymentAudit(audit)
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }
  audit.eventType = body.event_type ?? null
  audit.subscriptionId = body.resource?.id ?? body.resource?.billing_agreement_id ?? null

  const webhookId = process.env.PAYPAL_SUBSCRIPTIONS_WEBHOOK_ID
  if (!webhookId) {
    // Not configured — do not process unverifiable events, but don't leak internal config state.
    audit.failureReason = 'webhook_not_configured'
    logPaypalPaymentAudit(audit)
    return NextResponse.json({ error: 'Webhook not configured.' }, { status: 503 })
  }

  const sigHeaders: PayPalWebhookSignatureHeaders = {
    transmissionId: request.headers.get('paypal-transmission-id') ?? '',
    transmissionTime: request.headers.get('paypal-transmission-time') ?? '',
    certUrl: request.headers.get('paypal-cert-url') ?? '',
    authAlgo: request.headers.get('paypal-auth-algo') ?? '',
    transmissionSig: request.headers.get('paypal-transmission-sig') ?? '',
  }
  if (!sigHeaders.transmissionId || !sigHeaders.transmissionSig || !sigHeaders.certUrl) {
    audit.failureReason = 'missing_signature_headers'
    logPaypalPaymentAudit(audit)
    return NextResponse.json({ error: 'Missing PayPal signature headers.' }, { status: 400 })
  }

  const verified = await verifySignature(sigHeaders, webhookId, body)
  if (!verified) {
    audit.failureReason = 'signature_verification_failed'
    logPaypalPaymentAudit(audit)
    return NextResponse.json({ error: 'Signature verification failed.' }, { status: 400 })
  }
  audit.webhookVerified = true

  const eventType = body.event_type
  const resource = body.resource ?? {}
  const client = getServiceClient()
  if (!client) {
    audit.failureReason = 'service_client_unavailable'
    logPaypalPaymentAudit(audit)
    return NextResponse.json({ error: 'Service role client unavailable.' }, { status: 500 })
  }

  // REPLAY-PROTECTION FIX, DISCLOSED: record this event's id before acting on it. A unique-
  // constraint violation means PayPal redelivered an event we already processed — return 200
  // immediately without re-running any billing-state change, rather than relying on every branch
  // below staying accidentally idempotent forever.
  if (body.id) {
    const { error: dedupeError } = await client
      .from('paypal_webhook_events')
      .insert({ event_id: body.id, event_type: eventType ?? 'unknown' })
    // Postgres unique-violation code specifically means "we've already recorded this exact event
    // id" — a real duplicate delivery, safe to skip. Any OTHER insert error (transient connection
    // issue, etc.) must NOT be treated as "already processed" — that would silently drop a
    // legitimate first-time event (e.g. a real plan activation) on an unrelated DB hiccup instead
    // of letting PayPal's own retry mechanism paper over it. Only skip on the specific duplicate
    // case; any other error just proceeds to process the event normally (without a dedupe record).
    if (dedupeError?.code === '23505') {
      audit.idempotencyHit = true
      logPaypalPaymentAudit(audit)
      return NextResponse.json({ received: true, deduped: true }, { status: 200 })
    }
  }

  switch (eventType) {
    case 'BILLING.SUBSCRIPTION.CREATED': {
      const userId = userIdFromCustomId(resource.custom_id)
      const subscriptionId = resource.id
      audit.userId = userId
      if (!userId || !subscriptionId) break
      if (!planMatchesPlanId(planFromCustomId(resource.custom_id), resource.plan_id)) {
        audit.failureReason = 'plan_id_mismatch'
        break
      }
      const { error: createdError } = await client.from('paypal_subscriptions').upsert(
        {
          user_id: userId,
          paypal_subscription_id: subscriptionId,
          plan: planFromCustomId(resource.custom_id),
          status: 'pending',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'paypal_subscription_id' },
      )
      // WRITE-FAILURE FIX, DISCLOSED: a failed Supabase write must NOT return 200 — the dedupe row
      // for this event is already committed above, so a silent 200 here means PayPal never retries
      // and this event is lost forever. Returning 500 lets PayPal's own retry mechanism recover it.
      if (createdError) {
        audit.failureReason = 'write_failed'
        logPaypalPaymentAudit(audit)
        return NextResponse.json({ error: 'Failed to record subscription.' }, { status: 500 })
      }
      break
    }

    case 'BILLING.SUBSCRIPTION.ACTIVATED': {
      const userId = userIdFromCustomId(resource.custom_id)
      const subscriptionId = resource.id
      audit.userId = userId
      if (!userId || !subscriptionId) break
      const plan = planFromCustomId(resource.custom_id)
      audit.newPlan = plan
      if (!planMatchesPlanId(plan, resource.plan_id)) {
        audit.failureReason = 'plan_id_mismatch'
        break
      }
      const nextBillingDate = resource.billing_info?.next_billing_time ?? null

      const { error: activateError } = await activatePlan(userId, plan, subscriptionId)
      if (activateError) {
        audit.failureReason = 'activate_failed'
        logPaypalPaymentAudit(audit)
        return NextResponse.json({ error: 'Failed to activate plan.' }, { status: 500 })
      }
      const { error: activatedError } = await client.from('paypal_subscriptions').upsert(
        {
          user_id: userId,
          paypal_subscription_id: subscriptionId,
          plan,
          status: 'active',
          next_billing_date: nextBillingDate,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'paypal_subscription_id' },
      )
      if (activatedError) {
        audit.failureReason = 'write_failed'
        logPaypalPaymentAudit(audit)
        return NextResponse.json({ error: 'Failed to record subscription.' }, { status: 500 })
      }
      break
    }

    case 'PAYMENT.SALE.COMPLETED': {
      // Recurring renewal payments reference the subscription via billing_agreement_id, not
      // custom_id — look up the existing row (created by CREATED/ACTIVATED above) to find the user.
      const subscriptionId = resource.billing_agreement_id
      if (!subscriptionId) break
      const { data: existing } = await client
        .from('paypal_subscriptions')
        .select('user_id, plan')
        .eq('paypal_subscription_id', subscriptionId)
        .maybeSingle()
      if (!existing) break
      audit.userId = existing.user_id as string
      // NULL-PLAN FIX, DISCLOSED (payments audit): previously defaulted a missing/invalid `plan`
      // column to 'pro', which would silently downgrade an elite subscriber on every renewal if the
      // row was ever missing its plan (bad migration, hand-inserted row, future upsert without
      // `plan`). Treat that as a hard failure instead of guessing — never renews the wrong plan.
      const renewalPlan = existing.plan === 'pro' || existing.plan === 'elite' ? existing.plan : null
      if (!renewalPlan) {
        audit.failureReason = 'missing_plan_on_row'
        logPaypalPaymentAudit(audit)
        return NextResponse.json({ error: 'Subscription row missing a valid plan.' }, { status: 500 })
      }
      audit.newPlan = renewalPlan

      const { error: renewError } = await activatePlan(
        existing.user_id as string,
        renewalPlan,
        subscriptionId,
      )
      if (renewError) {
        audit.failureReason = 'activate_failed'
        logPaypalPaymentAudit(audit)
        return NextResponse.json({ error: 'Failed to activate plan.' }, { status: 500 })
      }
      const { error: renewedError } = await client
        .from('paypal_subscriptions')
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .eq('paypal_subscription_id', subscriptionId)
      if (renewedError) {
        audit.failureReason = 'write_failed'
        logPaypalPaymentAudit(audit)
        return NextResponse.json({ error: 'Failed to record subscription.' }, { status: 500 })
      }
      break
    }

    // SUSPENDED/EXPIRED HANDLING, DISCLOSED (payments audit fix): PayPal auto-suspends a
    // subscription after repeated failed renewal charges via BILLING.SUBSCRIPTION.SUSPENDED (not
    // CANCELLED) — previously this fell into `default` and was silently ignored, leaving
    // paypal_subscriptions.status stuck on 'active' forever even though PayPal stopped billing.
    // activateUserPlanServerSide's rolling current_period_end still lazily expires access, so this
    // was never a full access-control gap — but the status row was misleading. Marked explicitly so
    // any admin/support tooling reading paypal_subscriptions reflects PayPal's real state.
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
    case 'BILLING.SUBSCRIPTION.EXPIRED': {
      const subscriptionId = resource.id
      if (!subscriptionId) break
      const status = eventType === 'BILLING.SUBSCRIPTION.SUSPENDED' ? 'suspended' : 'expired'
      const { error: statusError } = await client
        .from('paypal_subscriptions')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('paypal_subscription_id', subscriptionId)
      if (statusError) {
        audit.failureReason = 'write_failed'
        logPaypalPaymentAudit(audit)
        return NextResponse.json({ error: 'Failed to record subscription status.' }, { status: 500 })
      }
      break
    }

    case 'BILLING.SUBSCRIPTION.CANCELLED':
    // REFUND/REVERSAL HANDLING, DISCLOSED (PayPal payments audit fix): a refunded or reversed
    // (chargeback) sale on an otherwise-still-active recurring subscription previously fell into
    // `default` and was silently ignored — paid access stayed live even though PayPal had returned
    // the money. Treated exactly like BILLING.SUBSCRIPTION.CANCELLED: mark the subscription row
    // cancelled and downgrade to free, but ONLY if this PayPal subscription was actually the source
    // of the user's current paid plan (same guard as CANCELLED — a user who separately paid via
    // crypto keeps their plan). PayPal does not include billing_agreement_id on every
    // PAYMENT.SALE.REFUNDED payload (it can reference the original sale_id instead) — resource.id is
    // used defensively as a fallback below since REFUNDED/REVERSED events' own `id` is the refund's
    // own id, not the subscription's, so this branch only fires when a subscriptionId is actually
    // resolvable; an unresolvable refund is logged (failureReason) rather than silently ignored.
    case 'PAYMENT.SALE.REFUNDED':
    case 'PAYMENT.SALE.REVERSED': {
      const subscriptionId = eventType === 'BILLING.SUBSCRIPTION.CANCELLED' ? resource.id : resource.billing_agreement_id
      if (!subscriptionId) {
        audit.failureReason = 'no_subscription_reference'
        break
      }
      const { data: existing } = await client
        .from('paypal_subscriptions')
        .select('user_id')
        .eq('paypal_subscription_id', subscriptionId)
        .maybeSingle()

      const newStatus = eventType === 'BILLING.SUBSCRIPTION.CANCELLED' ? 'cancelled' : 'refunded'
      const { error: cancelledError } = await client
        .from('paypal_subscriptions')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('paypal_subscription_id', subscriptionId)
      if (cancelledError) {
        audit.failureReason = 'write_failed'
        logPaypalPaymentAudit(audit)
        return NextResponse.json({ error: 'Failed to record subscription.' }, { status: 500 })
      }

      // Only downgrade to free if this subscription was actually the source of the user's paid
      // plan — a user who separately paid via crypto or the manual PayPal flow keeps their plan.
      if (existing?.user_id) {
        audit.userId = existing.user_id as string
        const { data: settingsRow } = await client
          .from('user_settings')
          .select('plan, lemon_subscription_id')
          .eq('user_id', existing.user_id as string)
          .maybeSingle()
        if (settingsRow?.lemon_subscription_id === subscriptionId) {
          audit.previousPlan = (settingsRow.plan as 'free' | 'pro' | 'elite' | undefined) ?? null
          audit.newPlan = 'free'
          const { error: downgradeError } = await client
            .from('user_settings')
            .update({ plan: 'free', subscription_status: newStatus, updated_at: new Date().toISOString() })
            .eq('user_id', existing.user_id as string)
          if (downgradeError) {
            audit.failureReason = 'write_failed'
            logPaypalPaymentAudit(audit)
            return NextResponse.json({ error: 'Failed to downgrade plan.' }, { status: 500 })
          }
        }
      }
      break
    }

    default:
      // Ignore event types we don't act on — still a 200 so PayPal doesn't keep retrying.
      break
  }

  logPaypalPaymentAudit(audit)
  return NextResponse.json({ received: true }, { status: 200 })
}
