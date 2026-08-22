import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'
import { validateAffiliateApplication, type AffiliateApplicationInput } from '@/lib/server/affiliateValidation'
import { randomBytes } from 'crypto'

// RATE LIMITING, DISCLOSED (fixed a real bug reported live: a legitimate applicant hit "Too many
// requests" and could not submit at all).
//
// ROOT CAUSE: a single limiter (3/hour/IP) was checked BEFORE the request body was even parsed, so
// EVERY attempt consumed a slot — a typo, an empty required field, a double-click, a retry after a
// dropped connection. Three ordinary mistakes while filling out the form and a real applicant was
// hard-locked out for an hour with no way to actually apply. This is exactly what the screenshot
// showed: a normal person testing/filling the form, not abuse.
//
// FIX: split into two limiters with two different jobs.
//  - rawLimiter is the actual anti-flood guard — generous, because it exists only to stop a script
//    hammering this endpoint, not to throttle a human. Checked immediately, before any work.
//  - validatedLimiter is the "how many real applications from one IP" cap, checked ONLY after the
//    submission has passed validation — so mistakes and retries are free, and the cap only ever
//    counts genuine, well-formed submission attempts.
const rawLimiter = createRateLimiter({ windowMs: 3_600_000, max: 20 })
const validatedLimiter = createRateLimiter({ windowMs: 3_600_000, max: 5 })

function unavailableResponse(status: number) {
  return NextResponse.json({ error: 'Submission is temporarily unavailable. Please try again soon.' }, { status })
}

export async function POST(req: Request) {
  const ip = getClientIp(req)
  if (!rawLimiter.check(ip)) {
    return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 })
  }

  try {
    const body = (await req.json()) as AffiliateApplicationInput

    const validation = validateAffiliateApplication(body)
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: validation.status })
    }

    // Only a well-formed submission reaches here, so only well-formed submissions count against
    // this cap — a typo two minutes ago never blocks the corrected resubmission.
    if (!validatedLimiter.check(ip)) {
      return NextResponse.json({ error: 'Too many applications submitted recently. Please try again in a bit, or email chainlensai@gmail.com.' }, { status: 429 })
    }
    const { name, email, telegram, xHandle, audienceSize, audienceType, payoutWallet, promotionPlan } = validation.fields

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseUrl || !serviceRole) return unavailableResponse(503)

    const supabase = createClient(supabaseUrl, serviceRole)

    // Generate a code and retry once on unique-constraint collision (Postgres error 23505).
    // Primary code: 'cl' + 8 hex chars (e.g. cl1a2b3c4d).
    // On collision: append 4 more hex chars as suffix (e.g. cl1a2b3c4d-5e6f).
    const primaryCode = 'cl' + randomBytes(4).toString('hex')
    let code = primaryCode
    let insertError = (await supabase.from('affiliates').insert({
      name,
      email,
      telegram: telegram || null,
      x_handle: xHandle,
      audience_size: audienceSize,
      audience_type: audienceType || null,
      promotion_plan: promotionPlan,
      payout_wallet: payoutWallet || null,
      referral_code: code,
      status: 'pending',
    })).error

    if (insertError?.code === '23505') {
      // Unique collision — append random suffix and retry once.
      code = primaryCode + '-' + randomBytes(2).toString('hex')
      insertError = (await supabase.from('affiliates').insert({
        name,
        email,
        telegram: telegram || null,
        x_handle: xHandle,
        audience_size: audienceSize,
        audience_type: audienceType || null,
        promotion_plan: promotionPlan,
        payout_wallet: payoutWallet || null,
        referral_code: code,
        status: 'pending',
      })).error
    }

    if (insertError) {
      console.error('affiliate_apply_failed', {
        code: insertError.code,
        message: insertError.message,
        details: insertError.details,
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
