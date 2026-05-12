import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

type AffiliatePayload = {
  name?: string
  email?: string
  telegram?: string
  x_handle?: string
  audience_size?: string
  audience_type?: string
  payout_wallet?: string
  promo_plan?: string
  website?: string
}

const MAX = {
  name: 100,
  email: 200,
  telegram: 100,
  x_handle: 100,
  audience_size: 120,
  audience_type: 160,
  payout_wallet: 120,
  promo_plan: 1200,
  website: 300,
}

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function sanitize(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.slice(0, max)
}

function unavailableResponse(status: number, debug = false, code?: string) {
  if (debug) {
    return NextResponse.json({ ok: false, reason: 'db_insert_failed', code: code ?? null }, { status })
  }
  return NextResponse.json({ error: 'Submission is temporarily unavailable. Please try again soon.' }, { status })
}

export async function POST(req: Request) {
  const debug = new URL(req.url).searchParams.get('debug') === 'true'

  try {
    const body = (await req.json()) as AffiliatePayload

    const website = sanitize(body.website, MAX.website)
    if (website) return NextResponse.json({ ok: true })

    const name = sanitize(body.name, MAX.name)
    const email = sanitize(body.email, MAX.email).toLowerCase()
    const telegram = sanitize(body.telegram, MAX.telegram)
    const xHandle = sanitize(body.x_handle, MAX.x_handle)
    const audienceSize = sanitize(body.audience_size, MAX.audience_size)
    const audienceType = sanitize(body.audience_type, MAX.audience_type)
    const payoutWallet = sanitize(body.payout_wallet, MAX.payout_wallet)
    const promoPlan = sanitize(body.promo_plan, MAX.promo_plan)

    if (!name) return NextResponse.json({ error: 'Name is required.' }, { status: 400 })
    if (!email || !emailRegex.test(email)) return NextResponse.json({ error: 'Please enter a valid email.' }, { status: 400 })
    if (!xHandle) return NextResponse.json({ error: 'X handle is required.' }, { status: 400 })
    if (!audienceSize) return NextResponse.json({ error: 'Audience size is required.' }, { status: 400 })
    if (!audienceType) return NextResponse.json({ error: 'Audience type is required.' }, { status: 400 })
    if (!promoPlan) return NextResponse.json({ error: 'Promotion plan is required.' }, { status: 400 })

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!supabaseUrl || !serviceRole) {
      console.error('affiliate_apply_failed', {
        code: 'missing_env',
        message: 'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY',
        details: null,
      })
      return unavailableResponse(503, debug, 'missing_env')
    }

    const supabase = createClient(supabaseUrl, serviceRole)
    const { error } = await supabase.from('affiliate_applications').insert({
      name,
      email,
      telegram: telegram || null,
      x_handle: xHandle,
      audience_size: audienceSize,
      audience_type: audienceType,
      payout_wallet: payoutWallet || null,
      promo_plan: promoPlan,
    })

    if (error) {
      console.error('affiliate_apply_failed', {
        code: error.code,
        message: error.message,
        details: error.details,
      })
      return unavailableResponse(500, debug, error.code)
    }

    const resendApiKey = process.env.RESEND_API_KEY
    if (resendApiKey) {
      const notifyEmail = process.env.AFFILIATE_NOTIFY_EMAIL || 'chainlensai@gmail.com'
      const submittedAt = new Date().toISOString()
      const message = `New ChainLens Affiliate Application\n\nname: ${name}\nemail: ${email}\ntelegram: ${telegram || 'N/A'}\nX handle: ${xHandle}\naudience size: ${audienceSize}\naudience type: ${audienceType}\npromo plan: ${promoPlan}\npayout wallet: ${payoutWallet || 'N/A'}\nsubmitted at: ${submittedAt}`

      const mailResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.AFFILIATE_FROM_EMAIL || 'ChainLens Affiliate <onboarding@resend.dev>',
          to: [notifyEmail],
          subject: 'New ChainLens Affiliate Application',
          text: message,
        }),
      })

      if (!mailResp.ok) {
        console.error('affiliate_apply_failed', {
          code: `resend_${mailResp.status}`,
          message: 'Resend notification failed after successful DB insert',
          details: null,
        })
      }
    }

    return NextResponse.json({ ok: true })
  } catch {
    return unavailableResponse(500, debug)
  }
}
