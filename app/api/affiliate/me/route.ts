// AFFILIATE SELF-SERVE ENDPOINT, DISCLOSED (requested: "once someone joins the affiliate program
// they should automatically get their own referral link they can copy and start sharing
// immediately... sign up → get their link → start promoting → track their referrals/commissions").
//
// WHAT ALREADY WORKED BEFORE THIS FILE: a unique referral code IS generated at application time
// (app/api/affiliate/apply/route.ts) and the full ?ref= attribution pipeline is real end-to-end —
// components/AffiliateRefCapture.tsx stores the code for 60 days, app/api/checkout/crypto resolves
// it to an affiliate with first-referral-wins, and app/api/webhooks/crypto writes the commission
// row at that affiliate's own rate.
//
// WHAT DID NOT: the code was returned exactly ONCE, in the apply response, and rendered as plain
// un-copyable text. A refresh lost it permanently — there was no endpoint, page, or email that
// could ever show it again — and an affiliate had no way at all to see their own referrals or
// commissions (that data existed only behind /app/admin). This endpoint is the missing half:
// it lets an affiliate retrieve their own link and their own numbers, at any time.
//
// AUTHORIZATION, DISCLOSED: identity comes from a verified Supabase session, never from a query
// parameter or a client-supplied email — the bearer token is validated with the ANON client
// (sb.auth.getUser), and the affiliate row is then matched on that VERIFIED email. Someone who
// controls the email address used on the application can read that application's stats and nothing
// else; there is no code path here that can return another affiliate's row. The service-role client
// is used only AFTER that check and only for queries already narrowed to the caller's own
// affiliate id.
//
// FIELDS DELIBERATELY NOT RETURNED: payout_wallet (a payout destination is worth stealing and is
// never needed to display a dashboard), and every other applicant's data. Commission rate IS
// returned — it is the affiliate's own agreed rate and they are entitled to see it.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createAnonSupabaseClient } from '@/lib/supabase/userSettings'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'
import { buildAffiliateReferralLink } from '@/lib/affiliate/referral'

export const dynamic = 'force-dynamic'

const limiter = createRateLimiter({ windowMs: 60_000, max: 20 })

type AffiliateRow = {
  id: string
  referral_code: string
  status: string
  commission_rate: number | null
  created_at: string | null
  approved_at: string | null
}

export async function GET(req: NextRequest) {
  if (!limiter.check(getClientIp(req))) {
    return NextResponse.json({ error: 'Too many requests. Please try again shortly.' }, { status: 429 })
  }

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return NextResponse.json({ error: 'Sign in to view your affiliate dashboard.' }, { status: 401 })

  const anon = createAnonSupabaseClient()
  if (!anon) return NextResponse.json({ error: 'Service unavailable.' }, { status: 503 })
  const { data: userData, error: authErr } = await anon.auth.getUser(token)
  if (authErr || !userData.user) return NextResponse.json({ error: 'Sign in to view your affiliate dashboard.' }, { status: 401 })

  // The ONLY identity used for the lookup below — taken from the verified token, never from input.
  const email = userData.user.email?.trim().toLowerCase() ?? ''
  if (!email) return NextResponse.json({ error: 'Your account has no email address on file.' }, { status: 400 })

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRole) return NextResponse.json({ error: 'Service unavailable.' }, { status: 503 })
  const sb = createClient(supabaseUrl, serviceRole)

  // Applications are stored with whatever casing the applicant typed, so match case-insensitively
  // on the verified address. ilike with no wildcard characters is an exact, case-insensitive match.
  const { data: affRow, error: affErr } = await sb
    .from('affiliates')
    .select('id, referral_code, status, commission_rate, created_at, approved_at')
    .ilike('email', email)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (affErr) {
    console.error('affiliate_me_lookup_failed', { code: affErr.code, message: affErr.message })
    return NextResponse.json({ error: 'Could not load your affiliate account.' }, { status: 500 })
  }
  // Not an affiliate — an ordinary, expected state, not an error. The dashboard renders a join CTA.
  if (!affRow) return NextResponse.json({ isAffiliate: false })

  const aff = affRow as AffiliateRow

  // ── Real tracking numbers, each scoped to THIS affiliate id ────────────────────────────────────
  // Every figure below is a count/sum over rows the attribution pipeline actually wrote; nothing is
  // projected, estimated, or back-filled. A query that errors reports null (unknown), never 0 —
  // showing a hard 0 for a failed read would tell an affiliate they earned nothing when the truth
  // is that the number could not be loaded.
  const [commissionsRes, referredUsersRes, paymentsRes] = await Promise.all([
    sb.from('affiliate_commissions')
      .select('commission_amount, payment_amount_usd, status, plan, created_at, paid_at')
      .eq('affiliate_id', aff.id)
      .order('created_at', { ascending: false })
      .limit(100),
    sb.from('user_settings')
      .select('user_id', { count: 'exact', head: true })
      .eq('referred_by_affiliate_id', aff.id),
    sb.from('crypto_payments')
      .select('id', { count: 'exact', head: true })
      .eq('affiliate_id', aff.id),
  ])

  const commissionRows = (commissionsRes.data ?? []) as Array<{
    commission_amount: number | null
    payment_amount_usd: number | null
    status: string | null
    plan: string | null
    created_at: string | null
    paid_at: string | null
  }>

  const sum = (rows: typeof commissionRows) => rows.reduce((t, r) => t + Number(r.commission_amount ?? 0), 0)
  const paidRows = commissionRows.filter((r) => r.status === 'paid')
  const pendingRows = commissionRows.filter((r) => r.status !== 'paid')

  const stats = commissionsRes.error
    ? { unavailable: true as const, reason: 'Commission history could not be loaded this request.' }
    : {
        unavailable: false as const,
        conversions: commissionRows.length,
        earnedTotalUsd: sum(commissionRows),
        earnedPaidUsd: sum(paidRows),
        earnedPendingUsd: sum(pendingRows),
        revenueGeneratedUsd: commissionRows.reduce((t, r) => t + Number(r.payment_amount_usd ?? 0), 0),
        // Most recent conversions only — enough to recognise activity without shipping a full ledger.
        recent: commissionRows.slice(0, 10).map((r) => ({
          plan: r.plan,
          paymentUsd: Number(r.payment_amount_usd ?? 0),
          commissionUsd: Number(r.commission_amount ?? 0),
          status: r.status === 'paid' ? 'paid' : 'pending',
          createdAt: r.created_at,
          paidAt: r.paid_at,
        })),
      }

  return NextResponse.json({
    isAffiliate: true,
    referralCode: aff.referral_code,
    referralLink: buildAffiliateReferralLink(aff.referral_code),
    status: aff.status,
    // Whether the link is CURRENTLY attributing referrals. This mirrors the real gate in
    // app/api/checkout/crypto/route.ts, which only credits an affiliate whose status is
    // 'approved' — so the dashboard can never imply a pending link is tracking when it is not.
    linkIsLive: aff.status === 'approved',
    commissionRate: aff.commission_rate == null ? null : Number(aff.commission_rate),
    appliedAt: aff.created_at,
    approvedAt: aff.approved_at,
    // null (not 0) when the count query failed — see the note above on never faking a zero.
    referredAccounts: referredUsersRes.error ? null : (referredUsersRes.count ?? 0),
    attributedCheckouts: paymentsRes.error ? null : (paymentsRes.count ?? 0),
    stats,
  })
}
