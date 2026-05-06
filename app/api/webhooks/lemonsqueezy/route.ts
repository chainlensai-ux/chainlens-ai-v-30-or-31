import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { updatePlanServerSideByEmail, type ChainlensPlan } from '@/lib/supabase/plans'

function maskEmail(email: string) { const [n,d]=email.split('@'); return `${(n||'').slice(0,2)}***@${d||'***'}` }
function mapPlan(variantId: string | null, status: string, eventName: string): ChainlensPlan {
  if (['subscription_cancelled','subscription_expired','subscription_paused'].includes(eventName)) return 'free'
  if (variantId === 'a9ab7a81-bcde-4efe-9ed7-705d83471061') return 'pro'
  if (variantId === '7848d92a-f82f-41a6-8c2d-f14e9c041f90') return 'elite'
  if (status === 'cancelled' || status === 'expired' || status === 'paused') return 'free'
  return 'free'
}

export async function POST(req: NextRequest) {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET
  const raw = await req.text()
  const sig = req.headers.get('x-signature') || ''
  const digest = crypto.createHmac('sha256', secret || '').update(raw).digest('hex')
  if (!secret || !sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const body = JSON.parse(raw)
  const eventName = body.meta?.event_name as string
  const attrs = body.data?.attributes || {}
  const email = attrs.user_email || attrs.customer_email
  const status = attrs.status || null
  const variantId = attrs.variant_id ? String(attrs.variant_id) : null
  const subscriptionId = attrs.id ? String(attrs.id) : (body.data?.id ? String(body.data.id) : null)

  const handled = ['subscription_created','subscription_updated','subscription_cancelled','subscription_expired','subscription_paused','subscription_resumed']
  if (!handled.includes(eventName)) return NextResponse.json({ ok: true, ignored: true }, { status: 200 })
  if (!email) return NextResponse.json({ ok: true, missingEmail: true }, { status: 200 })

  const plan = mapPlan(variantId, status || '', eventName)
  await updatePlanServerSideByEmail({
    email,
    plan,
    lemonCustomerId: attrs.customer_id ? String(attrs.customer_id) : null,
    lemonSubscriptionId: subscriptionId,
    lemonVariantId: variantId,
    subscriptionStatus: status,
    currentPeriodEnd: attrs.ends_at || attrs.renews_at || null,
  })

  console.log('[lemonsqueezy-webhook]', { eventName, status, email: maskEmail(email), plan })
  return NextResponse.json({ ok: true }, { status: 200 })
}
