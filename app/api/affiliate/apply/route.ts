import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createHash } from 'crypto'

type AffiliatePayload = {
  name?: string
  email?: string
  telegram?: string
  x_handle?: string
  audience_size?: string
  audience_type?: string
  promotion_plan?: string
  wallet_address?: string
  website?: string
  company_url?: string
}

const MAX = {
  name: 100,
  email: 200,
  telegram: 100,
  x_handle: 100,
  audience_size: 120,
  audience_type: 160,
  promotion_plan: 1200,
  wallet_address: 120,
}

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function sanitize(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.slice(0, max)
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as AffiliatePayload

    const honeypotWebsite = sanitize(body.website, 300)
    const honeypotCompanyUrl = sanitize(body.company_url, 300)
    if (honeypotWebsite || honeypotCompanyUrl) {
      return NextResponse.json({ ok: true })
    }

    const name = sanitize(body.name, MAX.name)
    const email = sanitize(body.email, MAX.email).toLowerCase()
    const telegram = sanitize(body.telegram, MAX.telegram)
    const xHandle = sanitize(body.x_handle, MAX.x_handle)
    const audienceSize = sanitize(body.audience_size, MAX.audience_size)
    const audienceType = sanitize(body.audience_type, MAX.audience_type)
    const promotionPlan = sanitize(body.promotion_plan, MAX.promotion_plan)
    const walletAddress = sanitize(body.wallet_address, MAX.wallet_address)

    if (!name) {
      return NextResponse.json({ error: 'Name is required.' }, { status: 400 })
    }
    if (!email || !emailRegex.test(email)) {
      return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 })
    }

    const filledCount = [telegram, xHandle, audienceSize, audienceType, promotionPlan, walletAddress].filter(Boolean).length
    if (filledCount === 0) {
      return NextResponse.json({ error: 'Please include at least one application detail.' }, { status: 400 })
    }

    const supabaseUrl = process.env.SUPABASE_URL
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseUrl || !serviceRole) {
      console.error('[affiliate] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
      return NextResponse.json({ error: 'Submission unavailable right now.' }, { status: 503 })
    }

    const userAgent = req.headers.get('user-agent') ?? ''
    const ipRaw = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? ''
    const ipHash = ipRaw ? createHash('sha256').update(ipRaw).digest('hex') : null

    const supabase = createClient(supabaseUrl, serviceRole)
    const source = 'affiliate_page'
    const { error: insertError } = await supabase.from('affiliate_applications').insert({
      name,
      email,
      telegram: telegram || null,
      x_handle: xHandle || null,
      audience_size: audienceSize || null,
      audience_type: audienceType || null,
      promotion_plan: promotionPlan || null,
      wallet_address: walletAddress || null,
      source,
      user_agent: userAgent || null,
      ip_hash: ipHash,
    })

    if (insertError) {
      console.error('[affiliate] db insert failed', insertError.message)
      return NextResponse.json({ error: 'Could not save application.' }, { status: 500 })
    }

    const notifyEmail = process.env.AFFILIATE_NOTIFY_EMAIL || 'chainlensai@gmail.com'
    const resendApiKey = process.env.RESEND_API_KEY
    if (resendApiKey) {
      const submittedAt = new Date().toISOString()
      const message = `New ChainLens Affiliate Application\n\nname: ${name}\nemail: ${email}\ntelegram: ${telegram || 'N/A'}\nX handle: ${xHandle || 'N/A'}\naudience size: ${audienceSize || 'N/A'}\naudience type: ${audienceType || 'N/A'}\npromotion plan: ${promotionPlan || 'N/A'}\nwallet address: ${walletAddress || 'N/A'}\nsubmitted at: ${submittedAt}\nsource: ${source}`

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
        console.error('[affiliate] resend email failed', mailResp.status)
      }
    } else {
      console.warn('[affiliate] RESEND_API_KEY not set; application saved without email notification')
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[affiliate] unexpected error', err)
    return NextResponse.json({ error: 'Could not submit right now.' }, { status: 500 })
  }
}
