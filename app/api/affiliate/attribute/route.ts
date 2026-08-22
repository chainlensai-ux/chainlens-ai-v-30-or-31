// LOGIN-TIME AFFILIATE ATTRIBUTION, DISCLOSED (requested: "if somebody logs in with that link it
// saves to their account so if they buy it 100 percent goes through").
//
// GAP THIS CLOSES: before this endpoint, the ONLY place a referral got permanently attached to an
// account was inside /api/checkout/crypto — which only runs the moment someone clicks "Crypto" on
// the pricing page. Everything before that (the 60-day cookie, the localStorage fallback) is
// client-side, browser-scoped state. If a visitor signs up, then weeks later clears their cookies,
// switches browsers, or buys from a different device after having logged in elsewhere, the referral
// is gone — even though they DID follow the affiliate's link and DID create an account off it.
//
// FIX: capture the referral the moment a session exists, not the moment a purchase begins. Called
// from SupabaseProvider on every sign-in — the one place in the app every login path (magic link,
// OAuth, password, fresh signup) already funnels through. Writes straight to
// user_settings.referred_by_affiliate_id, the exact same column /api/checkout/crypto already reads
// as its first, highest-priority source — so once this has run, the referral survives independent
// of any cookie or localStorage state from then on.
//
// FIRST-REFERRAL-WINS, PRESERVED: this endpoint is intentionally structured as "insert if the row
// doesn't exist yet, otherwise UPDATE ... WHERE referred_by_affiliate_id IS NULL" — the identical
// atomic guard /api/checkout/crypto and the crypto webhook both already use. A plain upsert was
// deliberately NOT used: Supabase's upsert has no WHERE clause on its DO UPDATE, so it would
// unconditionally overwrite an already-attributed buyer's original affiliate with whatever code
// happens to be in this request — silently breaking the exact guarantee this whole system exists to
// provide. Calling this endpoint twice, from two tabs, or with two different codes is always safe:
// only the very first successful write for a given account is ever kept.
//
// APPROVAL GATE, DISCLOSED: identical business rule to /api/checkout/crypto's own fresh-code
// resolution — only a currently APPROVED affiliate's code is stored. A pending or rejected
// affiliate's code is never written here. This is deliberate, not an oversight: first-referral-wins
// is PERMANENT, so writing a code that later gets rejected would waste that buyer's one attribution
// slot forever, on an affiliate who can never actually earn from it.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createAnonSupabaseClient } from '@/lib/supabase/userSettings'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'
import { isValidReferralCode, normalizeReferralCode } from '@/lib/affiliate/referral'

export const dynamic = 'force-dynamic'

const limiter = createRateLimiter({ windowMs: 60_000, max: 20 })

export async function POST(req: NextRequest) {
  if (!limiter.check(getClientIp(req))) {
    return NextResponse.json({ error: 'Too many requests.' }, { status: 429 })
  }

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 })

  const anon = createAnonSupabaseClient()
  if (!anon) return NextResponse.json({ error: 'Service unavailable.' }, { status: 503 })
  const { data: userData, error: authErr } = await anon.auth.getUser(token)
  if (authErr || !userData.user) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 })

  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  const rawRef = typeof body?.referralCode === 'string' ? body.referralCode : null
  if (!rawRef || !isValidReferralCode(rawRef)) {
    // Not an error — most sign-ins carry no referral code at all. Nothing to do.
    return NextResponse.json({ attributed: false, reason: 'no_code' })
  }
  const referralCode = normalizeReferralCode(rawRef)

  const userId = userData.user.id
  const userEmail = userData.user.email?.toLowerCase() ?? ''

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRole) return NextResponse.json({ error: 'Service unavailable.' }, { status: 503 })
  const supabase = createClient(supabaseUrl, serviceRole)

  // Already attributed? Then there is nothing this code could change — first-referral-wins means
  // whatever is already stored stays stored, approved or not, matching /api/checkout/crypto's own
  // "storedAffId short-circuits before ever looking at a fresh code" behavior.
  const { data: existingSettings } = await supabase
    .from('user_settings')
    .select('referred_by_affiliate_id')
    .eq('user_id', userId)
    .maybeSingle()
  if ((existingSettings as { referred_by_affiliate_id?: string | null } | null)?.referred_by_affiliate_id) {
    return NextResponse.json({ attributed: false, reason: 'already_attributed' })
  }

  // Resolve the code to a real, approved affiliate — two case variants for legacy pre-lowercase
  // codes, same dual lookup /api/checkout/crypto already does.
  type AffRow = { id: string; email: string | null; status: string }
  let aff: AffRow | null = null
  for (const variant of [referralCode, referralCode.toUpperCase()]) {
    const { data } = await supabase.from('affiliates').select('id,email,status').eq('referral_code', variant).maybeSingle()
    if (data?.id) { aff = data as AffRow; break }
  }
  const affEmail = String(aff?.email ?? '').toLowerCase()
  const selfReferral = Boolean(userEmail && affEmail && affEmail === userEmail)
  if (!aff?.id || aff.status !== 'approved' || selfReferral) {
    return NextResponse.json({ attributed: false, reason: 'no_matching_approved_affiliate' })
  }

  // Insert-or-guarded-update, DISCLOSED (see file header): NOT a plain upsert, precisely so an
  // already-attributed account can never be overwritten by this call.
  if (existingSettings) {
    await supabase
      .from('user_settings')
      .update({ referred_by_affiliate_id: aff.id, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('referred_by_affiliate_id', null)
  } else {
    const { error: insertError } = await supabase
      .from('user_settings')
      .insert({ user_id: userId, referred_by_affiliate_id: aff.id })
    if (insertError && insertError.code !== '23505') {
      // A genuine failure (not a benign race where the row was created between our SELECT and this
      // INSERT) — report it as not attributed rather than claiming success we can't confirm.
      console.error('affiliate_attribute_insert_failed', { code: insertError.code, message: insertError.message })
      return NextResponse.json({ attributed: false, reason: 'write_failed' })
    }
    if (insertError?.code === '23505') {
      // Row was created concurrently (e.g. a simultaneous request from another tab) between our
      // read and this insert — fall back to the same guarded update everyone else uses.
      await supabase
        .from('user_settings')
        .update({ referred_by_affiliate_id: aff.id, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .is('referred_by_affiliate_id', null)
    }
  }

  return NextResponse.json({ attributed: true })
}
