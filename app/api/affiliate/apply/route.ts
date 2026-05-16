import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isValidReferralCode, normalizeReferralCode } from '@/lib/affiliate/referral'

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

const WINDOW_MS = 10 * 60 * 1000
const LIMIT_PER_IP = 5
const ipRate = new Map<string, { count: number; resetAt: number }>()
const MAX = { name: 100, email: 200, telegram: 100, x_handle: 100, audience_size: 120, payout_wallet: 120, promotion_plan: 1200, website: 300 }
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function sanitize(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.slice(0, max)
}

function isAllowed(req: NextRequest): boolean {
  const key = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const now = Date.now()
  const cur = ipRate.get(key)
  if (!cur || cur.resetAt <= now) {
    ipRate.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return true
  }
  if (cur.count >= LIMIT_PER_IP) return false
  cur.count += 1
  return true
}

function referralBase(name: string, handle: string): string {
  const base = normalizeReferralCode((handle || name).replace(/^@+/, '').replace(/\s+/g, '-').replace(/[^a-z0-9_-]+/gi, '-').replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, ''))
  return isValidReferralCode(base) ? base : `affiliate-${Math.random().toString(36).slice(2, 6)}`
}

export async function POST(req: NextRequest) {
  if (!isAllowed(req)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })

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
    if (!supabaseUrl || !serviceRole) return NextResponse.json({ error: 'Submission is temporarily unavailable. Please try again soon.' }, { status: 503 })

    const supabase = createClient(supabaseUrl, serviceRole)
    let code = referralBase(name, xHandle)
    for (let i = 0; i < 5; i += 1) {
      const { data: existing } = await supabase.from('affiliates').select('id').eq('referral_code', code).maybeSingle()
      if (!existing) break
      code = `${code}-${Math.random().toString(36).slice(2, 6)}`
    }

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
      console.error('affiliate_apply_failed', { code: error.code })
      return NextResponse.json({ error: 'Submission is temporarily unavailable. Please try again soon.' }, { status: 500 })
    }

    return NextResponse.json({ status: 'pending', referral_code: code })
  } catch {
    return NextResponse.json({ error: 'Submission is temporarily unavailable. Please try again soon.' }, { status: 500 })
  }
}
