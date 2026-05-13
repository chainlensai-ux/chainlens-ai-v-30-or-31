import { NextRequest, NextResponse } from 'next/server'
import { createAnonSupabaseClient } from '@/lib/supabase/userSettings'

export const dynamic = 'force-dynamic'

const PLAN_AMOUNTS: Record<string, number> = { pro: 30, elite: 60 }
const PLAN_LABELS: Record<string, string> = { pro: 'Pro', elite: 'Elite' }
const CHECKOUT_WINDOW_MS = 60 * 1000
const CHECKOUT_LIMIT_PER_IP = 6
const checkoutRate = new Map<string, { count: number; resetAt: number }>()

function checkoutIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

function checkoutAllowed(req: NextRequest): boolean {
  const key = checkoutIp(req)
  const now = Date.now()
  const cur = checkoutRate.get(key)
  if (!cur || cur.resetAt <= now) {
    checkoutRate.set(key, { count: 1, resetAt: now + CHECKOUT_WINDOW_MS })
    return true
  }
  if (cur.count >= CHECKOUT_LIMIT_PER_IP) return false
  cur.count += 1
  return true
}

export async function POST(req: NextRequest) {
  if (!checkoutAllowed(req)) {
    return NextResponse.json({ error: 'Too many checkout attempts. Try again shortly.' }, { status: 429 })
  }
  const apiKey = process.env.NOWPAYMENTS_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { error: 'Crypto checkout is not configured yet.' },
      { status: 503 },
    )
  }

  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) {
    return NextResponse.json({ error: 'Sign in to start checkout.' }, { status: 401 })
  }

  const sb = createAnonSupabaseClient()
  if (!sb) {
    return NextResponse.json({ error: 'Service unavailable.' }, { status: 503 })
  }

  const { data: userData, error: authErr } = await sb.auth.getUser(token)
  if (authErr || !userData.user) {
    return NextResponse.json({ error: 'Sign in to start checkout.' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const plan = (body as Record<string, unknown>)?.plan
  if (plan !== 'pro' && plan !== 'elite') {
    return NextResponse.json({ error: 'Invalid plan.' }, { status: 400 })
  }

  const amountUsd = PLAN_AMOUNTS[plan]
  const userId = userData.user.id
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''

  // order_id encodes userId + plan + timestamp for webhook parsing
  // format: cl_{plan}_{ts}_{userId_no_hyphens}
  const orderId = `cl_${plan}_${Date.now()}_${userId.replace(/-/g, '')}`

  try {
    const res = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        price_amount: amountUsd,
        price_currency: 'usd',
        order_id: orderId,
        order_description: `ChainLens AI ${PLAN_LABELS[plan]}`,
        ipn_callback_url: appUrl ? `${appUrl}/api/webhooks/crypto` : undefined,
        success_url: appUrl ? `${appUrl}/pricing?payment=success` : undefined,
        cancel_url: appUrl ? `${appUrl}/pricing?payment=cancelled` : undefined,
        is_fixed_rate: false,
        is_fee_paid_by_user: false,
      }),
    })

    if (!res.ok) {
      return NextResponse.json(
        { error: 'Checkout creation failed. Try again.' },
        { status: 502 },
      )
    }

    const json = (await res.json()) as { invoice_url?: string }
    const checkoutUrl = json?.invoice_url
    if (!checkoutUrl) {
      return NextResponse.json(
        { error: 'Checkout creation failed. Try again.' },
        { status: 502 },
      )
    }

    return NextResponse.json({ checkoutUrl })
  } catch {
    return NextResponse.json(
      { error: 'Checkout creation failed. Try again.' },
      { status: 502 },
    )
  }
}
