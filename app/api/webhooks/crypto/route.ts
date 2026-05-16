import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { activateUserPlanServerSide } from '@/lib/supabase/userSettings'

export const dynamic = 'force-dynamic'
const PLAN_AMOUNTS: Record<string, number> = { pro: 30, elite: 60 }
const ACTIVATION_STATUSES = new Set(['confirmed', 'finished'])
const processedPaymentIds = new Set<string>()

function sortObjectKeys(obj: Record<string, unknown>): Record<string, unknown> { const sorted: Record<string, unknown> = {}; for (const k of Object.keys(obj).sort()) sorted[k] = obj[k]; return sorted }
function verifyIpnSignature(rawBody: string, sig: string, secret: string): boolean { if (!sig || !secret) return false; try { const sortedBody = JSON.stringify(sortObjectKeys(JSON.parse(rawBody) as Record<string, unknown>)); const expected = crypto.createHmac('sha512', secret).update(sortedBody).digest('hex'); const sigBuf = Buffer.from(sig, 'hex'); const expBuf = Buffer.from(expected, 'hex'); return sigBuf.length > 0 && sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf) } catch { return false } }
function parseOrderId(orderId: string): { userId: string; plan: string } | null { const p = orderId.split('_'); if (p.length < 4 || p[0] !== 'cl') return null; const raw = p[3]; if (!raw || raw.length !== 32) return null; return { plan: p[1], userId: [raw.slice(0,8),raw.slice(8,12),raw.slice(12,16),raw.slice(16,20),raw.slice(20)].join('-') } }

export async function POST(req: NextRequest) {
  const secret = process.env.NOWPAYMENTS_IPN_SECRET
  if (!secret) return NextResponse.json({ ok: false }, { status: 500 })
  const rawBody = await req.text().catch(() => '')
  if (!rawBody) return NextResponse.json({ ok: false }, { status: 400 })
  if (!verifyIpnSignature(rawBody, req.headers.get('x-nowpayments-sig') ?? '', secret)) return NextResponse.json({ ok: false }, { status: 400 })

  const ipn = JSON.parse(rawBody) as Record<string, unknown>
  const paymentId = String(ipn.payment_id ?? '').trim()
  const paymentStatus = String(ipn.payment_status ?? '').trim()
  const orderId = String(ipn.order_id ?? '').trim()
  if (!ACTIVATION_STATUSES.has(paymentStatus)) return NextResponse.json({ ok: true })
  if (paymentId && processedPaymentIds.has(paymentId)) return NextResponse.json({ ok: true })

  const parsed = parseOrderId(orderId)
  if (!parsed || (parsed.plan !== 'pro' && parsed.plan !== 'elite')) return NextResponse.json({ ok: true })
  if (String(ipn.price_currency ?? '').toLowerCase() !== 'usd' || Number(ipn.price_amount ?? 0) !== PLAN_AMOUNTS[parsed.plan]) return NextResponse.json({ ok: true })

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '')
  const { data: pay } = await supabase.from('crypto_payments').select('id,affiliate_id,referral_code,amount_usd').eq('order_id', orderId).maybeSingle()

  const { error } = await activateUserPlanServerSide(parsed.userId, parsed.plan as 'pro' | 'elite', paymentId || undefined)
  if (error) return NextResponse.json({ ok: false }, { status: 500 })

  if (pay?.id) {
    await supabase.from('crypto_payments').update({ payment_id: paymentId || null, status: paymentStatus }).eq('id', pay.id)
  }

  if (pay?.affiliate_id && paymentId) {
    const { data: exists } = await supabase.from('affiliate_commissions').select('id').eq('payment_id', paymentId).maybeSingle()
    if (!exists) {
      const { data: aff } = await supabase.from('affiliates').select('commission_rate').eq('id', pay.affiliate_id).maybeSingle()
      const rate = Number(aff?.commission_rate ?? 0.3)
      const amount = Number(pay.amount_usd ?? PLAN_AMOUNTS[parsed.plan])
      await supabase.from('affiliate_commissions').insert({ affiliate_id: pay.affiliate_id, buyer_user_id: parsed.userId, payment_id: paymentId, referral_code: pay.referral_code, plan: parsed.plan, payment_amount: amount, commission_rate: rate, commission_amount: amount * rate, status: 'pending' })
    }
  }

  if (paymentId) processedPaymentIds.add(paymentId)
  return NextResponse.json({ ok: true })
}
