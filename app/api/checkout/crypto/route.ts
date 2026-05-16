import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createAnonSupabaseClient } from '@/lib/supabase/userSettings'
import { isValidReferralCode, normalizeReferralCode, readReferralCodeFromCookie } from '@/lib/affiliate/referral'

export const dynamic = 'force-dynamic'
const PLAN_AMOUNTS: Record<string, number> = { pro: 30, elite: 60 }
const PLAN_LABELS: Record<string, string> = { pro: 'Pro', elite: 'Elite' }
const CHECKOUT_WINDOW_MS = 60 * 1000
const CHECKOUT_LIMIT_PER_IP = 6
const checkoutRate = new Map<string, { count: number; resetAt: number }>()

function checkoutAllowed(req: NextRequest): boolean { const key = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'; const now = Date.now(); const cur = checkoutRate.get(key); if (!cur || cur.resetAt <= now) { checkoutRate.set(key, { count: 1, resetAt: now + CHECKOUT_WINDOW_MS }); return true } if (cur.count >= CHECKOUT_LIMIT_PER_IP) return false; cur.count += 1; return true }

export async function POST(req: NextRequest) {
  if (!checkoutAllowed(req)) return NextResponse.json({ error: 'Too many checkout attempts. Try again shortly.' }, { status: 429 })
  const apiKey = process.env.NOWPAYMENTS_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'Crypto checkout is not configured yet.' }, { status: 503 })

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return NextResponse.json({ error: 'Sign in to start checkout.' }, { status: 401 })

  const sb = createAnonSupabaseClient()
  if (!sb) return NextResponse.json({ error: 'Service unavailable.' }, { status: 503 })
  const { data: userData, error: authErr } = await sb.auth.getUser(token)
  if (authErr || !userData.user) return NextResponse.json({ error: 'Sign in to start checkout.' }, { status: 401 })

  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  const plan = body?.plan
  if (plan !== 'pro' && plan !== 'elite') return NextResponse.json({ error: 'Invalid plan.' }, { status: 400 })

  const userId = userData.user.id
  const userEmail = userData.user.email?.toLowerCase() ?? ''
  const rawRef = typeof body?.referralCode === 'string' ? body.referralCode : readReferralCodeFromCookie(req.headers.get('cookie'))
  const referralCode = rawRef && isValidReferralCode(rawRef) ? normalizeReferralCode(rawRef) : null

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '')
  let affiliateId: string | null = null
  if (referralCode) {
    const { data: aff } = await supabase.from('affiliates').select('id,email,status,referral_code').eq('referral_code', referralCode).maybeSingle()
    const affEmail = String(aff?.email ?? '').toLowerCase()
    if (aff?.id && aff?.status === 'approved' && (!userEmail || !affEmail || affEmail !== userEmail)) affiliateId = aff.id as string
  }

  const orderId = `cl_${plan}_${Date.now()}_${userId.replace(/-/g, '')}`
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''

  try {
    const res = await fetch('https://api.nowpayments.io/v1/invoice', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey }, body: JSON.stringify({ price_amount: PLAN_AMOUNTS[plan], price_currency: 'usd', order_id: orderId, order_description: `ChainLens AI ${PLAN_LABELS[plan]}`, ipn_callback_url: appUrl ? `${appUrl}/api/webhooks/crypto` : undefined, success_url: appUrl ? `${appUrl}/pricing?payment=success` : undefined, cancel_url: appUrl ? `${appUrl}/pricing?payment=cancelled` : undefined, is_fixed_rate: false, is_fee_paid_by_user: false }) })
    if (!res.ok) return NextResponse.json({ error: 'Checkout creation failed. Try again.' }, { status: 502 })
    const json = (await res.json()) as { invoice_url?: string }
    if (!json.invoice_url) return NextResponse.json({ error: 'Checkout creation failed. Try again.' }, { status: 502 })

    await supabase.from('crypto_payments').insert({ user_id: userId, order_id: orderId, payment_id: null, plan, amount_usd: PLAN_AMOUNTS[plan], status: 'created', referral_code: referralCode, affiliate_id: affiliateId })
    return NextResponse.json({ checkoutUrl: json.invoice_url })
  } catch {
    return NextResponse.json({ error: 'Checkout creation failed. Try again.' }, { status: 502 })
  }
}
