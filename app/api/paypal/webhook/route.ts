import { NextRequest, NextResponse } from 'next/server'
import { verifyPayPalWebhookSignature, type PayPalWebhookSignatureHeaders } from '@/lib/paypal'
import { createServiceRoleClient, activateUserPlanServerSide } from '@/lib/supabase/userSettings'
import { emptyPaypalPaymentAudit, logPaypalPaymentAudit, type PaypalPaymentAudit } from '@/lib/server/paypalAudit'
import { getPricingPlan } from '@/lib/pricingPlans'
import { getAffiliateCommissionRate } from '@/lib/affiliate/commission'

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
    parent_payment?: string // refunds can reference the original sale with this field
    sale_id?: string
    status?: string
    plan_id?: string
    amount?: { total?: string; currency?: string }
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

async function createPayPalCommission(
  client: NonNullable<ReturnType<typeof createServiceRoleClient>>,
  saleId: string,
  userId: string,
  plan: 'pro' | 'elite',
  amount: { total?: string; currency?: string } | undefined,
) {
  const { data: settings, error: settingsError } = await client
    .from('user_settings')
    .select('referred_by_affiliate_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (settingsError) return settingsError

  const affiliateId = settings?.referred_by_affiliate_id
  if (!affiliateId) return null

  const { data: affiliate, error: affiliateError } = await client
    .from('affiliates')
    .select('id, referral_code, status, commission_rate')
    .eq('id', affiliateId)
    .maybeSingle()
  if (affiliateError) return affiliateError
  if (!affiliate || affiliate.status !== 'approved') return null

  const chargedUsd = amount?.currency === 'USD' ? Number(amount.total) : Number.NaN
  // Commission base is the checkout's gross USD charge; the server-side plan price is only a
  // fallback for PayPal events that omit a usable USD amount.
  const paymentAmountUsd = Number.isFinite(chargedUsd) && chargedUsd > 0
    ? chargedUsd
    : getPricingPlan(plan).priceMonthly
  const commissionRate = getAffiliateCommissionRate(affiliate)
  const { error } = await client.from('affiliate_commissions').insert({
    affiliate_id: affiliate.id,
    buyer_user_id: userId,
    payment_id: saleId,
    referral_code: affiliate.referral_code,
    plan,
    payment_amount_usd: paymentAmountUsd,
    commission_rate: commissionRate,
    commission_amount: paymentAmountUsd * commissionRate,
    status: 'pending',
  })
  return error?.code === '23505' ? null : error
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

  // REPLAY-PROTECTION: a row means the event finished successfully. Never reserve an event before
  // its side effects: otherwise a transient activation failure leaves a row that makes PayPal's
  // retry look processed and strands the customer on Free. The writes below are idempotent upserts/
  // updates, so concurrent first deliveries are safe; the unique insert after the switch makes all
  // later deliveries no-ops.
  if (body.id) {
    const { data: processedEvent, error: dedupeReadError } = await client
      .from('paypal_webhook_events')
      .select('event_id')
      .eq('event_id', body.id)
      .maybeSingle()
    if (dedupeReadError) {
      audit.failureReason = 'idempotency_read_failed'
      logPaypalPaymentAudit(audit)
      return NextResponse.json({ error: 'Failed to check webhook status.' }, { status: 500 })
    }
    if (processedEvent) {
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
      // A failed write must not return 200 or mark the event processed. Returning 500 lets PayPal's
      // retry mechanism recover it.
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
      // This is the sole commission trigger for both the first successful charge and renewals.
      // ACTIVATED grants access but creates no commission, because it does not prove money moved.
      // Recurring payments reference the subscription via billing_agreement_id, not custom_id.
      const subscriptionId = resource.billing_agreement_id
      const saleId = resource.id
      if (!subscriptionId || !saleId) break
      const { data: existing, error: subscriptionError } = await client
        .from('paypal_subscriptions')
        .select('user_id, plan')
        .eq('paypal_subscription_id', subscriptionId)
        .maybeSingle()
      if (subscriptionError) {
        audit.failureReason = 'subscription_lookup_failed'
        logPaypalPaymentAudit(audit)
        return NextResponse.json({ error: 'Failed to resolve subscription.' }, { status: 500 })
      }
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
      const commissionError = await createPayPalCommission(
        client,
        saleId,
        existing.user_id as string,
        renewalPlan,
        resource.amount,
      )
      if (commissionError) {
        audit.failureReason = 'commission_write_failed'
        logPaypalPaymentAudit(audit)
        return NextResponse.json({ error: 'Failed to record affiliate commission.' }, { status: 500 })
      }
      break
    }

    // SUSPENDED/EXPIRED HANDLING, DISCLOSED (payments audit fix): PayPal auto-suspends a
    // subscription after repeated failed renewal charges via BILLING.SUBSCRIPTION.SUSPENDED (not
    // CANCELLED) — previously this fell into `default` and was silently ignored, leaving
    // paypal_subscriptions.status stuck on 'active' forever even though PayPal stopped billing.
    // Access remains available only through current_period_end; unlike cancellation/refund, a
    // suspension does not wipe the paid plan immediately.
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
      const { data: existing } = await client
        .from('paypal_subscriptions')
        .select('user_id')
        .eq('paypal_subscription_id', subscriptionId)
        .maybeSingle()
      if (existing?.user_id) {
        audit.userId = existing.user_id as string
        const { data: settingsRow } = await client
          .from('user_settings')
          .select('lemon_subscription_id')
          .eq('user_id', existing.user_id as string)
          .maybeSingle()
        if (settingsRow?.lemon_subscription_id === subscriptionId) {
          const { error: settingsStatusError } = await client
            .from('user_settings')
            .update({ subscription_status: status, updated_at: new Date().toISOString() })
            .eq('user_id', existing.user_id as string)
          if (settingsStatusError) {
            audit.failureReason = 'write_failed'
            logPaypalPaymentAudit(audit)
            return NextResponse.json({ error: 'Failed to sync subscription status.' }, { status: 500 })
          }
        }
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
      const isCancellation = eventType === 'BILLING.SUBSCRIPTION.CANCELLED'
      const subscriptionId = isCancellation ? resource.id : resource.billing_agreement_id
      if (!isCancellation) {
        const originalSaleId = resource.sale_id ?? resource.parent_payment ?? resource.id
        if (originalSaleId) {
          const { error: reversalError } = await client
            .from('affiliate_commissions')
            .update({ status: 'reversed' })
            .eq('payment_id', originalSaleId)
          if (reversalError) {
            audit.failureReason = 'commission_reversal_failed'
            logPaypalPaymentAudit(audit)
            return NextResponse.json({ error: 'Failed to reverse affiliate commission.' }, { status: 500 })
          }
        }
      }
      if (!subscriptionId) {
        audit.failureReason = 'no_subscription_reference'
        break
      }
      const { data: existing } = await client
        .from('paypal_subscriptions')
        .select('user_id')
        .eq('paypal_subscription_id', subscriptionId)
        .maybeSingle()

      const newStatus = isCancellation ? 'cancelled' : 'refunded'
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

  // Commit the idempotency marker only after every required side effect above succeeded. If this
  // insert itself fails, return 500: replaying the idempotent side effects is safer than losing the
  // event. A 23505 can occur when concurrent deliveries both completed; that is also success.
  if (body.id) {
    const { error: markProcessedError } = await client
      .from('paypal_webhook_events')
      .insert({ event_id: body.id, event_type: eventType ?? 'unknown' })
    if (markProcessedError && markProcessedError.code !== '23505') {
      audit.failureReason = 'idempotency_write_failed'
      logPaypalPaymentAudit(audit)
      return NextResponse.json({ error: 'Failed to record webhook completion.' }, { status: 500 })
    }
  }

  logPaypalPaymentAudit(audit)
  return NextResponse.json({ received: true }, { status: 200 })
}
