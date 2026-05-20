import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ─── Admin access list ───────────────────────────────────────────────────────
const ADMIN_EMAILS = new Set([
  'chainlensai@gmail.com',
  'anthonynoumeir7@gmail.com',
  'anthonynoumeir@gmail.com',
])

// ─── Client factories ────────────────────────────────────────────────────────
function makeAnonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

function makeServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

// ─── Admin identity check ─────────────────────────────────────────────────────
async function verifyAdmin(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return null

  const anon = makeAnonClient()
  if (!anon) return null

  try {
    const { data } = await anon.auth.getUser(token)
    const email = (data.user?.email ?? '').toLowerCase()
    if (!email || !ADMIN_EMAILS.has(email)) return null
    return email
  } catch {
    return null
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────
type Payment = Record<string, unknown>
type Affiliate = Record<string, unknown>
type Commission = Record<string, unknown>
type ReferredUser = Record<string, unknown>

export interface AffiliateWithStats extends Record<string, unknown> {
  referredCheckoutCount: number
  confirmedRevenueUsd: number
  pendingCommissionOwed: number
}

export interface AdminData {
  metrics: {
    totalCheckoutAttempts: number
    confirmedPayments: number
    totalRevenueUsd: number
    pendingCommissionAmountUsd: number
    approvedAffiliatesCount: number
    pendingApplicationsCount: number
  }
  payments: Payment[]
  pendingApplications: Affiliate[]
  approvedAffiliates: AffiliateWithStats[]
  commissions: Commission[]
  referredUsers: ReferredUser[]
}

// ─── Route handler ─────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  // 1. Admin gate — must pass before any data is read
  const adminEmail = await verifyAdmin(req)
  if (!adminEmail) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sb = makeServiceClient()
  if (!sb) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }

  // 2. Parallel fetch of all display data + aggregate inputs
  const [
    paymentsRes,
    affiliatesRes,
    commissionsRes,
    referredUsersRes,
    allConfirmedRevenueRes,
    allPendingCommsRes,
    allAffiliatePaymentsRes,
  ] = await Promise.all([
    // Display: last 50 payments
    sb
      .from('crypto_payments')
      .select('order_id, user_email, plan, amount_usd, status, referral_code, affiliate_id, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(50),

    // All affiliates (for applications + approved sections)
    sb
      .from('affiliates')
      .select('id, name, email, x_handle, audience_size, referral_code, status, commission_rate, approved_at, created_at')
      .order('created_at', { ascending: false })
      .limit(200),

    // Display: last 50 commissions
    sb
      .from('affiliate_commissions')
      .select('id, affiliate_id, buyer_email, payment_amount_usd, commission_rate, commission_amount, referral_code, plan, status, paid_at, created_at')
      .order('created_at', { ascending: false })
      .limit(50),

    // Referred users (user_settings rows with a referring affiliate)
    sb
      .from('user_settings')
      .select('user_id, plan, subscription_status, referred_by_affiliate_id, created_at, updated_at')
      .not('referred_by_affiliate_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(50),

    // Aggregate: total confirmed revenue (all-time)
    sb
      .from('crypto_payments')
      .select('amount_usd')
      .in('status', ['confirmed', 'finished']),

    // Aggregate: all pending commissions (for total owed + per-affiliate owed)
    sb
      .from('affiliate_commissions')
      .select('affiliate_id, commission_amount')
      .eq('status', 'pending'),

    // Aggregate: all payments that have a referral_code (for per-affiliate stats)
    sb
      .from('crypto_payments')
      .select('referral_code, amount_usd, status')
      .not('referral_code', 'is', null),
  ])

  const payments = (paymentsRes.data ?? []) as Payment[]
  const allAffiliates = (affiliatesRes.data ?? []) as Affiliate[]
  const commissions = (commissionsRes.data ?? []) as Commission[]
  const referredUsers = (referredUsersRes.data ?? []) as ReferredUser[]
  const allConfirmedRevenue = (allConfirmedRevenueRes.data ?? []) as Array<{ amount_usd: unknown }>
  const allPendingComms = (allPendingCommsRes.data ?? []) as Array<{ affiliate_id: unknown; commission_amount: unknown }>
  const allAffiliatePayments = (allAffiliatePaymentsRes.data ?? []) as Array<{ referral_code: unknown; amount_usd: unknown; status: unknown }>

  // 3. Compute aggregate totals
  const totalRevenueUsd = allConfirmedRevenue.reduce((s, r) => s + (Number(r.amount_usd) || 0), 0)
  const pendingCommissionAmountUsd = allPendingComms.reduce((s, r) => s + (Number(r.commission_amount) || 0), 0)

  // 4. Count totals (use parallel count queries for accuracy)
  const [totalCountRes, confirmedCountRes, approvedCountRes, pendingAppCountRes] = await Promise.all([
    sb.from('crypto_payments').select('order_id', { count: 'exact', head: true }),
    sb.from('crypto_payments').select('order_id', { count: 'exact', head: true }).in('status', ['confirmed', 'finished']),
    sb.from('affiliates').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
    sb.from('affiliates').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
  ])

  // 5. Per-affiliate performance stats
  // Map referral_code -> { checkouts, revenue }
  const codeStats: Record<string, { checkouts: number; revenue: number }> = {}
  for (const p of allAffiliatePayments) {
    const code = String(p.referral_code ?? '')
    if (!code) continue
    if (!codeStats[code]) codeStats[code] = { checkouts: 0, revenue: 0 }
    codeStats[code].checkouts++
    if (p.status === 'confirmed' || p.status === 'finished') {
      codeStats[code].revenue += Number(p.amount_usd) || 0
    }
  }

  // Map affiliate_id -> pendingOwed
  const idPending: Record<string, number> = {}
  for (const c of allPendingComms) {
    const id = String(c.affiliate_id ?? '')
    if (!id) continue
    idPending[id] = (idPending[id] ?? 0) + (Number(c.commission_amount) || 0)
  }

  // 6. Split affiliates into pending applications vs approved
  const pendingApplications = allAffiliates.filter((a) => a.status === 'pending')
  const approvedAffiliates: AffiliateWithStats[] = allAffiliates
    .filter((a) => a.status === 'approved' || a.status === 'active')
    .map((a) => {
      const code = String(a.referral_code ?? '')
      const id = String(a.id ?? '')
      const stats = codeStats[code] ?? { checkouts: 0, revenue: 0 }
      return {
        ...a,
        referredCheckoutCount: stats.checkouts,
        confirmedRevenueUsd: stats.revenue,
        pendingCommissionOwed: idPending[id] ?? 0,
      }
    })

  return NextResponse.json({
    metrics: {
      totalCheckoutAttempts: totalCountRes.count ?? 0,
      confirmedPayments: confirmedCountRes.count ?? 0,
      totalRevenueUsd,
      pendingCommissionAmountUsd,
      approvedAffiliatesCount: approvedCountRes.count ?? 0,
      pendingApplicationsCount: pendingAppCountRes.count ?? 0,
    },
    payments,
    pendingApplications,
    approvedAffiliates,
    commissions,
    referredUsers,
  } satisfies AdminData)
}
