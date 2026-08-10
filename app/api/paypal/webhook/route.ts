import { NextRequest, NextResponse } from 'next/server'
import { verifyPayPalWebhookSignature, type PayPalWebhookSignatureHeaders } from '@/lib/paypal'
import { createServiceRoleClient, activateUserPlanServerSide } from '@/lib/supabase/userSettings'

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
    id?: string // subscription id for BILLING.SUBSCRIPTION.*, sale id for PAYMENT.SALE.COMPLETED
    custom_id?: string
    billing_agreement_id?: string // PAYMENT.SALE.COMPLETED references the subscription this way
    status?: string
    plan_id?: string
    billing_info?: { next_billing_time?: string }
  }
}

function planFromCustomId(customId: string | undefined): 'pro' | 'elite' {
  return customId?.startsWith('elite:') ? 'elite' : 'pro'
}

// PLAN/PLAN_ID CROSS-CHECK, DISCLOSED: custom_id's plan prefix is set server-side by
// /api/paypal/create-subscription, tied 1:1 to the plan_id it requested — under normal operation
// they always agree. This checks PayPal's own resource.plan_id against the plan the event's
// custom_id claims, as defense-in-depth against a subscription created outside this app's own
// create-subscription route (e.g. directly against the PayPal API) with a mismatched/forged
// custom_id — never trust custom_id's plan claim alone when PayPal's own plan_id is available on
// the same event to cross-check it against.
function planMatchesPlanId(plan: 'pro' | 'elite', planId: string | undefined): boolean {
  if (!planId) return true // event didn't include plan_id (not all event types do) — nothing to cross-check
  const expected = plan === 'elite' ? process.env.PAYPAL_ELITE_PLAN_ID : process.env.PAYPAL_PRO_PLAN_ID
  return !expected || expected === planId
}

function userIdFromCustomId(customId: string | undefined): string | null {
  if (!customId) return null
  // custom_id is formatted as "<plan>:<userId>" by /api/paypal/create-subscription.
  const parts = customId.split(':')
  return parts.length === 2 ? parts[1] : null
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  let body: PayPalWebhookBody
  try {
    body = JSON.parse(rawBody) as PayPalWebhookBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const webhookId = process.env.PAYPAL_SUBSCRIPTIONS_WEBHOOK_ID
  if (!webhookId) {
    // Not configured — do not process unverifiable events, but don't leak internal config state.
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
    return NextResponse.json({ error: 'Missing PayPal signature headers.' }, { status: 400 })
  }

  const verified = await verifyPayPalWebhookSignature(sigHeaders, webhookId, body)
  if (!verified) {
    return NextResponse.json({ error: 'Signature verification failed.' }, { status: 400 })
  }

  const eventType = body.event_type
  const resource = body.resource ?? {}
  const client = createServiceRoleClient()
  if (!client) {
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
      return NextResponse.json({ received: true, deduped: true }, { status: 200 })
    }
  }

  switch (eventType) {
    case 'BILLING.SUBSCRIPTION.CREATED': {
      const userId = userIdFromCustomId(resource.custom_id)
      const subscriptionId = resource.id
      if (!userId || !subscriptionId) break
      if (!planMatchesPlanId(planFromCustomId(resource.custom_id), resource.plan_id)) break
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
      if (createdError) return NextResponse.json({ error: 'Failed to record subscription.' }, { status: 500 })
      break
    }

    case 'BILLING.SUBSCRIPTION.ACTIVATED': {
      const userId = userIdFromCustomId(resource.custom_id)
      const subscriptionId = resource.id
      if (!userId || !subscriptionId) break
      const plan = planFromCustomId(resource.custom_id)
      if (!planMatchesPlanId(plan, resource.plan_id)) break
      const nextBillingDate = resource.billing_info?.next_billing_time ?? null

      const { error: activateError } = await activateUserPlanServerSide(userId, plan, subscriptionId)
      if (activateError) return NextResponse.json({ error: 'Failed to activate plan.' }, { status: 500 })
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
      if (activatedError) return NextResponse.json({ error: 'Failed to record subscription.' }, { status: 500 })
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
      // NULL-PLAN FIX, DISCLOSED (payments audit): previously defaulted a missing/invalid `plan`
      // column to 'pro', which would silently downgrade an elite subscriber on every renewal if the
      // row was ever missing its plan (bad migration, hand-inserted row, future upsert without
      // `plan`). Treat that as a hard failure instead of guessing — never renews the wrong plan.
      const renewalPlan = existing.plan === 'pro' || existing.plan === 'elite' ? existing.plan : null
      if (!renewalPlan) {
        return NextResponse.json({ error: 'Subscription row missing a valid plan.' }, { status: 500 })
      }

      const { error: renewError } = await activateUserPlanServerSide(
        existing.user_id as string,
        renewalPlan,
        subscriptionId,
      )
      if (renewError) return NextResponse.json({ error: 'Failed to activate plan.' }, { status: 500 })
      const { error: renewedError } = await client
        .from('paypal_subscriptions')
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .eq('paypal_subscription_id', subscriptionId)
      if (renewedError) return NextResponse.json({ error: 'Failed to record subscription.' }, { status: 500 })
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
      if (statusError) return NextResponse.json({ error: 'Failed to record subscription status.' }, { status: 500 })
      break
    }

    case 'BILLING.SUBSCRIPTION.CANCELLED': {
      const subscriptionId = resource.id
      if (!subscriptionId) break
      const { data: existing } = await client
        .from('paypal_subscriptions')
        .select('user_id')
        .eq('paypal_subscription_id', subscriptionId)
        .maybeSingle()

      const { error: cancelledError } = await client
        .from('paypal_subscriptions')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('paypal_subscription_id', subscriptionId)
      if (cancelledError) return NextResponse.json({ error: 'Failed to record subscription.' }, { status: 500 })

      // Only downgrade to free if this subscription was actually the source of the user's paid
      // plan — a user who separately paid via crypto or the manual PayPal flow keeps their plan.
      if (existing?.user_id) {
        const { data: settingsRow } = await client
          .from('user_settings')
          .select('lemon_subscription_id')
          .eq('user_id', existing.user_id as string)
          .maybeSingle()
        if (settingsRow?.lemon_subscription_id === subscriptionId) {
          const { error: downgradeError } = await client
            .from('user_settings')
            .update({ plan: 'free', subscription_status: 'cancelled', updated_at: new Date().toISOString() })
            .eq('user_id', existing.user_id as string)
          if (downgradeError) return NextResponse.json({ error: 'Failed to downgrade plan.' }, { status: 500 })
        }
      }
      break
    }

    default:
      // Ignore event types we don't act on — still a 200 so PayPal doesn't keep retrying.
      break
  }

  return NextResponse.json({ received: true }, { status: 200 })
}
