import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'
import { randomBytes } from 'crypto'

const limiter = createRateLimiter({ windowMs: 3_600_000, max: 3 })

type AffiliatePayload = {
  name?: string
  email?: string
  telegram?: string
  x_handle?: string
  audience_size?: string
  promotion_plan?: string
  payout_wallet?: string
  website?: string
}

const MAX = { name: 100, email: 200, telegram: 100, x_handle: 100, audience_size: 120, payout_wallet: 120, promotion_plan: 1200, website: 300 }
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function sanitize(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.slice(0, max)
}

function unavailableResponse(status: number) {
  return NextResponse.json({ error: 'Submission is temporarily unavailable. Please try again soon.' }, { status })
}

export async function POST(req: Request) {
  if (!limiter.check(getClientIp(req))) {
    return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 })
  }

  try {
    const body = (await req.json()) as AffiliatePayload
    const website = sanitize(body.website, MAX.website)
    if (website) return NextResponse.json({ error: 'Invalid submission.' }, { status: 400 })

    const name = sanitize(body.name, MAX.name)
    const email = sanitize(body.email, MAX.email).toLowerCase()
    const telegram = sanitize(body.telegram, MAX.telegram)
    const xHandle = sanitize(body.x_handle, MAX.x_handle)
    const audienceSize = sanitize(body.audience_size, MAX.audience_size)
    const payoutWallet = sanitize(body.payout_wallet, MAX.payout_wallet)
    const promotionPlan = sanitize(body.promotion_plan, MAX.promotion_plan)

    if (!name || !email || !xHandle || !audienceSize || !promotionPlan) return NextResponse.json({ error: 'Missing required fields.' }, { status: 400 })
    if (!emailRegex.test(email)) return NextResponse.json({ error: 'Please enter a valid email.' }, { status: 400 })

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseUrl || !serviceRole) return unavailableResponse(503)

    const supabase = createClient(supabaseUrl, serviceRole)
    const code = 'cl' + randomBytes(4).toString('hex')

    const { error } = await supabase.from('affiliates').insert({
      name,
      email,
      telegram: telegram || null,
      x_handle: xHandle,
      audience_size: audienceSize,
      promotion_plan: promotionPlan,
      payout_wallet: payoutWallet || null,
      referral_code: code,
      status: 'pending',
    })

    if (error) {
      console.error('affiliate_apply_failed', {
        code: error.code,
        message: error.message,
        details: error.details,
      })
      return unavailableResponse(500)
    }

    const resendApiKey = process.env.RESEND_API_KEY
    if (resendApiKey) {
      const notifyEmail = process.env.AFFILIATE_NOTIFY_EMAIL || 'chainlensai@gmail.com'
      const submittedAt = new Date().toISOString()
      const message = `New ChainLens Affiliate Application\n\nname: ${name}\nemail: ${email}\ntelegram: ${telegram || 'N/A'}\nX handle: ${xHandle}\naudience size: ${audienceSize}\npromo plan: ${promotionPlan}\npayout wallet: ${payoutWallet || 'N/A'}\nreferral code: ${code}\nsubmitted at: ${submittedAt}`

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

    return NextResponse.json({ status: 'pending', referral_code: code })
  } catch {
    return unavailableResponse(500)
  }
}
