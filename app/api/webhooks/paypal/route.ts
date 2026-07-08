import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { activateUserPlanServerSide } from '@/lib/supabase/userSettings'
import { capturePayPalOrder, verifyPayPalWebhookSignature } from '@/lib/paypal'

export const dynamic = 'force-dynamic'
const PLAN_AMOUNTS: Record<string, number> = { pro: 30, elite: 60 }
const processedCaptureIds = new Set<string>()

function parseCustomId(customId: string): { userId: string; plan: string } | null {
  const p = customId.split('_')
  if (p.length < 4 || p[0] !== 'cl') return null
  const raw = p[3]
  if (!raw || raw.length !== 32) return null
  return { plan: p[1], userId: [raw.slice(0, 8), raw.slice(8, 12), raw.slice(12, 16), raw.slice(16, 20), raw.slice(20)].join('-') }
}

// Mirrors app/api/webhooks/crypto/route.ts's own security model exactly:
//   1. verify the webhook actually came from the real provider (signature check)
//   2. require a matching DB row we created at checkout time — never trust the webhook payload's
//      plan/amount alone, since anyone could POST a fabricated event to this endpoint if signature
//      verification were the only check and our own records weren't cross-checked too
//   3. dedupe by the payment/capture id so a provider retry can never double-activate or
//      double-pay an affiliate commission
export async function POST(req: NextRequest) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID
  if (!webhookId) return NextResponse.json({ ok: false }, { status: 500 })

  const rawBody = await req.text().catch(() => '')
  if (!rawBody) return NextResponse.json({ ok: false }, { status: 400 })

  const verified = await verifyPayPalWebhookSignature({
    transmissionId: req.headers.get('paypal-transmission-id') ?? '',
    transmissionTime: req.headers.get('paypal-transmission-time') ?? '',
    certUrl: req.headers.get('paypal-cert-url') ?? '',
    authAlgo: req.headers.get('paypal-auth-algo') ?? '',
    transmissionSig: req.headers.get('paypal-transmission-sig') ?? '',
    webhookId,
    rawBody,
  })
  if (!verified) return NextResponse.json({ ok: false }, { status: 400 })

  const event = JSON.parse(rawBody) as { event_type?: string; resource?: Record<string, unknown> }
  const eventType = String(event.event_type ?? '')
  const resource = event.resource ?? {}

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '')

  // Step 1 of 2: order approved by the buyer, but funds not yet captured (this codebase's checkout
  // uses a server redirect flow, not the client-side JS SDK button that auto-captures on approval,
  // so an explicit server-initiated capture call is required here).
  if (eventType === 'CHECKOUT.ORDER.APPROVED') {
    const orderId = String(resource.id ?? '')
    if (!orderId) return NextResponse.json({ ok: true })
    await capturePayPalOrder(orderId)
    return NextResponse.json({ ok: true })
  }

  // Step 2 of 2: funds actually captured — this is the real "payment complete" signal, equivalent
  // to crypto's 'confirmed'/'finished' IPN statuses.
  if (eventType !== 'PAYMENT.CAPTURE.COMPLETED') {
    return NextResponse.json({ ok: true, note: 'unhandled_event' })
  }

  const captureId = String(resource.id ?? '')
  const orderId = String((resource.supplementary_data as Record<string, unknown> | undefined)?.related_ids
    ? ((resource.supplementary_data as Record<string, unknown>).related_ids as Record<string, unknown>).order_id ?? ''
    : '')
  const customId = String(resource.custom_id ?? '')
  const amountValue = Number((resource.amount as Record<string, unknown> | undefined)?.value ?? 0)
  const currencyCode = String((resource.amount as Record<string, unknown> | undefined)?.currency_code ?? '').toUpperCase()

  if (captureId && processedCaptureIds.has(captureId)) return NextResponse.json({ ok: true })

  const parsed = parseCustomId(customId)
  if (!parsed || (parsed.plan !== 'pro' && parsed.plan !== 'elite')) return NextResponse.json({ ok: true })
  if (currencyCode !== 'USD' || Math.abs(amountValue - PLAN_AMOUNTS[parsed.plan]) > 1) return NextResponse.json({ ok: true })

  // Require a DB payment row from our own checkout route. Activating without one would bypass our
  // own checkout record — same rule crypto's webhook enforces.
  const { data: pay } = orderId
    ? await supabase.from('paypal_payments').select('id,plan,affiliate_id,referral_code,amount_usd,user_email,user_id').eq('order_id', orderId).maybeSingle()
    : { data: null }
  if (!pay?.id) return NextResponse.json({ ok: true })

  // Use the plan stored in our DB — never trust the encoded plan in custom_id alone.
  const storedPlan = String(pay.plan ?? '')
  if (storedPlan !== 'pro' && storedPlan !== 'elite') return NextResponse.json({ ok: true })
  if (storedPlan !== parsed.plan) return NextResponse.json({ ok: true })

  const { error } = await activateUserPlanServerSide(parsed.userId, storedPlan as 'pro' | 'elite', captureId || undefined)
  if (error) return NextResponse.json({ ok: false }, { status: 500 })

  await supabase.from('paypal_payments').update({ capture_id: captureId || null, status: 'completed', updated_at: new Date().toISOString() }).eq('id', pay.id)

  if (pay.affiliate_id && captureId) {
    const { data: exists } = await supabase.from('affiliate_commissions').select('id').eq('payment_id', captureId).maybeSingle()
    if (!exists) {
      const { data: aff } = await supabase.from('affiliates').select('commission_rate').eq('id', pay.affiliate_id).maybeSingle()
      const rate = Number(aff?.commission_rate ?? 0.20)
      const amount = Number(pay.amount_usd ?? PLAN_AMOUNTS[parsed.plan])
      const referralCode = (pay as Record<string, unknown>).referral_code ?? null
      const { error: commissionInsertError } = await supabase.from('affiliate_commissions').insert({
        affiliate_id: pay.affiliate_id,
        crypto_payment_id: null,
        buyer_user_id: parsed.userId,
        buyer_email: (pay as Record<string, unknown>).user_email ?? null,
        payment_id: captureId,
        referral_code: referralCode,
        plan: parsed.plan,
        payment_amount_usd: amount,
        commission_rate: rate,
        commission_amount: amount * rate,
        status: 'pending',
      })
      if (commissionInsertError?.code === '23505') {
        console.warn('paypal_commission_insert_duplicate')
      } else if (commissionInsertError) {
        console.error('paypal_commission_insert_failed', { code: commissionInsertError.code })
      }
    }
    await supabase
      .from('user_settings')
      .update({ referred_by_affiliate_id: pay.affiliate_id })
      .eq('user_id', parsed.userId)
      .is('referred_by_affiliate_id', null)
  }

  if (captureId) processedCaptureIds.add(captureId)
  return NextResponse.json({ ok: true })
}
