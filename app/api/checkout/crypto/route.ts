import { NextRequest, NextResponse } from 'next/server'
import { createAnonSupabaseClient } from '@/lib/supabase/userSettings'

export const dynamic = 'force-dynamic'

const PLAN_AMOUNTS: Record<string, number> = { pro: 30, elite: 60 }
const PLAN_LABELS: Record<string, string> = { pro: 'Pro', elite: 'Elite' }

export async function POST(req: NextRequest) {
  const apiKey = process.env.COINBASE_COMMERCE_API_KEY
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
  const email = userData.user.email ?? ''
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''

  try {
    const res = await fetch('https://api.commerce.coinbase.com/charges', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CC-Api-Key': apiKey,
        'X-CC-Version': '2018-03-22',
      },
      body: JSON.stringify({
        name: `ChainLens ${PLAN_LABELS[plan]} Plan`,
        description: `ChainLens ${plan.toUpperCase()} — $${amountUsd}/month`,
        pricing_type: 'fixed_price',
        local_price: { amount: String(amountUsd), currency: 'USD' },
        redirect_url: appUrl ? `${appUrl}/terminal` : undefined,
        cancel_url: appUrl ? `${appUrl}/pricing` : undefined,
        metadata: {
          userId,
          email,
          plan,
          amountUsd: String(amountUsd),
        },
      }),
    })

    if (!res.ok) {
      return NextResponse.json(
        { error: 'Checkout creation failed. Try again.' },
        { status: 502 },
      )
    }

    const json = (await res.json()) as { data?: { hosted_url?: string } }
    const checkoutUrl = json?.data?.hosted_url
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
