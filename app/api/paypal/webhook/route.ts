import { NextRequest, NextResponse } from 'next/server'
import { verifyPayPalWebhookSignature, type PayPalWebhookSignatureHeaders } from '@/lib/paypal'
import { createServiceRoleClient, activateUserPlanServerSide } from '@/lib/supabase/userSettings'

// PayPal recurring-Subscriptions webhook — a SEPARATE flow from the one-time manual-verification
// PayPal integration (docs/paypal-verification.md). This endpoint reconciles real Subscriptions API
// events (created via /api/paypal/create-subscription) into Supabase.
//
// PayPal retries webhooks that don't return 2xx, so every branch below returns 200 once the event
// has been handled (or intentionally ignored) — a 4xx/5xx here just causes pointless retries for
// events we already understood.

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

  const verified = await verifyPayPalWebhookSignature(sigHeaders, webhookId, JSON.parse(rawBody))
  if (!verified) {
    return NextResponse.json({ error: 'Signature verification failed.' }, { status: 400 })
  }

  const eventType = body.event_type
  const resource = body.resource ?? {}
  const client = createServiceRoleClient()
  if (!client) {
    return NextResponse.json({ error: 'Service role client unavailable.' }, { status: 500 })
  }

  switch (eventType) {
    case 'BILLING.SUBSCRIPTION.CREATED': {
      const userId = userIdFromCustomId(resource.custom_id)
      const subscriptionId = resource.id
      if (!userId || !subscriptionId) break
      await client.from('paypal_subscriptions').upsert(
        {
          user_id: userId,
          paypal_subscription_id: subscriptionId,
          plan: planFromCustomId(resource.custom_id),
          status: 'pending',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'paypal_subscription_id' },
      )
      break
    }

    case 'BILLING.SUBSCRIPTION.ACTIVATED': {
      const userId = userIdFromCustomId(resource.custom_id)
      const subscriptionId = resource.id
      if (!userId || !subscriptionId) break
      const plan = planFromCustomId(resource.custom_id)
      const nextBillingDate = resource.billing_info?.next_billing_time ?? null

      await activateUserPlanServerSide(userId, plan, subscriptionId)
      await client.from('paypal_subscriptions').upsert(
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

      await activateUserPlanServerSide(existing.user_id as string, (existing.plan as 'pro' | 'elite') ?? 'pro', subscriptionId)
      await client
        .from('paypal_subscriptions')
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .eq('paypal_subscription_id', subscriptionId)
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

      await client
        .from('paypal_subscriptions')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('paypal_subscription_id', subscriptionId)

      // Only downgrade to free if this subscription was actually the source of the user's paid
      // plan — a user who separately paid via crypto or the manual PayPal flow keeps their plan.
      if (existing?.user_id) {
        const { data: settingsRow } = await client
          .from('user_settings')
          .select('lemon_subscription_id')
          .eq('user_id', existing.user_id as string)
          .maybeSingle()
        if (settingsRow?.lemon_subscription_id === subscriptionId) {
          await client
            .from('user_settings')
            .update({ plan: 'free', subscription_status: 'cancelled', updated_at: new Date().toISOString() })
            .eq('user_id', existing.user_id as string)
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
