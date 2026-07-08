import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createAnonSupabaseClient } from '@/lib/supabase/userSettings'
import { isValidReferralCode, normalizeReferralCode, readReferralCodeFromCookie } from '@/lib/affiliate/referral'
import { createPayPalOrder } from '@/lib/paypal'

export const dynamic = 'force-dynamic'
const PLAN_AMOUNTS: Record<string, number> = { pro: 30, elite: 60 }
const PLAN_LABELS: Record<string, string> = { pro: 'Pro', elite: 'Elite' }
const CHECKOUT_WINDOW_MS = 60 * 1000
const CHECKOUT_LIMIT_PER_IP = 6
const checkoutRate = new Map<string, { count: number; resetAt: number }>()

function checkoutAllowed(req: NextRequest): boolean { const key = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'; const now = Date.now(); const cur = checkoutRate.get(key); if (!cur || cur.resetAt <= now) { checkoutRate.set(key, { count: 1, resetAt: now + CHECKOUT_WINDOW_MS }); return true } if (cur.count >= CHECKOUT_LIMIT_PER_IP) return false; cur.count += 1; return true }

// Mirrors app/api/checkout/crypto/route.ts's own structure (auth check, rate limit, affiliate
// resolution) exactly — same security model, different payment processor underneath.
export async function POST(req: NextRequest) {
  if (!checkoutAllowed(req)) return NextResponse.json({ error: 'Too many checkout attempts. Try again shortly.' }, { status: 429 })
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    return NextResponse.json({ error: 'Card checkout is not configured yet.' }, { status: 503 })
  }

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

  // ── Affiliate resolution (first-referral-wins) — identical logic to the crypto checkout route ──
  const { data: settingsRow } = await supabase
    .from('user_settings')
    .select('referred_by_affiliate_id')
    .eq('user_id', userId)
    .maybeSingle()
  const storedAffId = String((settingsRow as Record<string, unknown> | null)?.referred_by_affiliate_id ?? '').trim() || null

  if (storedAffId) {
    const { data: storedAff } = await supabase
      .from('affiliates')
      .select('id,status')
      .eq('id', storedAffId)
      .maybeSingle()
    if ((storedAff as Record<string, unknown> | null)?.status === 'approved') {
      affiliateId = storedAffId
    }
  } else if (referralCode) {
    type AffRow = { id: string; email: string | null; status: string }
    let aff: AffRow | null = null
    for (const variant of [referralCode, referralCode.toUpperCase()]) {
      const { data } = await supabase.from('affiliates').select('id,email,status').eq('referral_code', variant).maybeSingle()
      if (data?.id) { aff = data as AffRow; break }
    }
    const affEmail = String(aff?.email ?? '').toLowerCase()
    const selfReferral = Boolean(userEmail && affEmail && affEmail === userEmail)
    if (aff?.id && aff?.status === 'approved' && !selfReferral) affiliateId = aff.id

    if (affiliateId) {
      await supabase
        .from('user_settings')
        .update({ referred_by_affiliate_id: affiliateId })
        .eq('user_id', userId)
        .is('referred_by_affiliate_id', null)
    }
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://www.chainlensai.app'
  // custom_id, DISCLOSED: same encoding convention as crypto's order_id (plan + userId), but this
  // is NEVER trusted alone by the webhook — the webhook looks up the real plan/amount from our own
  // paypal_payments row keyed by PayPal's own order id, exactly like crypto's webhook requires a
  // matching crypto_payments row before activating anything.
  const customId = `cl_${plan}_${Date.now()}_${userId.replace(/-/g, '')}`

  const order = await createPayPalOrder({
    amountUsd: PLAN_AMOUNTS[plan],
    customId,
    description: `ChainLens AI ${PLAN_LABELS[plan]}`,
    returnUrl: `${appUrl}/pricing?payment=success`,
    cancelUrl: `${appUrl}/pricing?payment=cancelled`,
  })
  if (!order?.id) return NextResponse.json({ error: 'Checkout creation failed. Try again.' }, { status: 502 })

  const approveUrl = order.links?.find((l) => l.rel === 'approve')?.href
  if (!approveUrl) return NextResponse.json({ error: 'Checkout creation failed. Try again.' }, { status: 502 })

  await supabase.from('paypal_payments').insert({
    user_id: userId,
    order_id: order.id,
    capture_id: null,
    user_email: userEmail || null,
    plan,
    amount_usd: PLAN_AMOUNTS[plan],
    status: 'created',
    referral_code: referralCode,
    affiliate_id: affiliateId,
  })

  return NextResponse.json({ checkoutUrl: approveUrl })
}
