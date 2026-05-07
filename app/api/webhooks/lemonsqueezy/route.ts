import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { updateUserPlanByEmail, type UserPlan } from '@/lib/supabase/subscriptionPlan'

// Required env vars:
//   LEMONSQUEEZY_WEBHOOK_SECRET   — secret from Lemon Squeezy webhook settings
//   LEMONSQUEEZY_PRO_VARIANT_ID   — variant_id for the Pro product variant
//   LEMONSQUEEZY_ELITE_VARIANT_ID — variant_id for the Elite product variant
//   SUPABASE_SERVICE_ROLE_KEY     — used by updateUserPlanByEmail

const ACTIVE_EVENTS = new Set([
  'subscription_created',
  'subscription_updated',
  'subscription_resumed',
])
const INACTIVE_EVENTS = new Set([
  'subscription_cancelled',
  'subscription_expired',
  'subscription_paused',
])

function verifySignature(rawBody: string, signature: string): boolean {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET
  if (!secret || !signature) return false
  try {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
    const a = Buffer.from(expected, 'hex')
    const b = Buffer.from(signature, 'hex')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function mapVariantToPlan(variantId: string | number | null | undefined): UserPlan | null {
  if (variantId == null) return null
  const v = String(variantId)
  const proVariant = process.env.LEMONSQUEEZY_PRO_VARIANT_ID ?? ''
  const eliteVariant = process.env.LEMONSQUEEZY_ELITE_VARIANT_ID ?? ''
  if (proVariant && v === proVariant) return 'pro'
  if (eliteVariant && v === eliteVariant) return 'elite'
  return null
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!domain) return '***'
  return `${local[0] ?? ''}***@${domain}`
}

export async function POST(req: NextRequest) {
  let rawBody: string
  try {
    rawBody = await req.text()
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  }

  const signature = req.headers.get('x-signature') ?? ''
  if (!verifySignature(rawBody, signature)) {
    console.warn('[ls-webhook] invalid signature')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const meta = (payload.meta ?? {}) as Record<string, unknown>
  const eventName = String(meta.event_name ?? '')
  const data = (payload.data ?? {}) as Record<string, unknown>
  const attrs = (data.attributes ?? {}) as Record<string, unknown>

  const email = String(attrs.user_email ?? '').toLowerCase().trim()
  if (!email || !email.includes('@')) {
    console.log('[ls-webhook] event', eventName, 'has no user_email — skipping')
    return NextResponse.json({ ok: true, note: 'no_email' })
  }

  const masked = maskEmail(email)
  const subscriptionId = String(data.id ?? '')
  const customerId = String(attrs.customer_id ?? '')
  const variantId = attrs.variant_id
  const status = String(attrs.status ?? '')
  const currentPeriodEnd = (attrs.renews_at ?? attrs.ends_at ?? null) as string | null

  if (ACTIVE_EVENTS.has(eventName)) {
    const plan = mapVariantToPlan(variantId as string | number)
    if (!plan) {
      console.warn('[ls-webhook]', eventName, 'unrecognized variant_id', variantId, masked)
      return NextResponse.json({ ok: true, note: 'unrecognized_variant' })
    }
    const result = await updateUserPlanByEmail(email, plan, {
      lemon_customer_id: customerId,
      lemon_subscription_id: subscriptionId,
      lemon_variant_id: String(variantId),
      subscription_status: status,
      current_period_end: currentPeriodEnd,
    })
    console.log('[ls-webhook]', eventName, masked, '->', plan, result.ok ? 'ok' : result.error)
    return NextResponse.json({ ok: true })
  }

  if (INACTIVE_EVENTS.has(eventName)) {
    const result = await updateUserPlanByEmail(email, 'free', {
      subscription_status: status,
      current_period_end: currentPeriodEnd,
    })
    console.log('[ls-webhook]', eventName, masked, '-> free', result.ok ? 'ok' : result.error)
    return NextResponse.json({ ok: true })
  }

  console.log('[ls-webhook] unhandled event', eventName)
  return NextResponse.json({ ok: true, note: 'unhandled_event' })
}
