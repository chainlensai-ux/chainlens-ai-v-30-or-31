import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ─── Admin access list ────────────────────────────────────────────────────────
const ADMIN_EMAILS = new Set([
  'chainlensai@gmail.com',
  'anthonynoumeir7@gmail.com',
  'anthonynoumeir@gmail.com',
])

// ─── Internal / test emails ───────────────────────────────────────────────────
const INTERNAL_EMAILS = new Set([
  'chainlensai@gmail.com',
  'anthonynoumeir7@gmail.com',
  'anthonynoumeir@gmail.com',
])

const CONFIRMED_STATUSES = new Set(['confirmed', 'finished'])
const UNPAID_STATUSES    = new Set(['created', 'waiting', 'pending'])
const FAILED_STATUSES    = new Set(['failed', 'expired', 'cancelled'])

// ─── Client factories ─────────────────────────────────────────────────────────
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
type Payment      = Record<string, unknown>
type Affiliate    = Record<string, unknown>
type Commission   = Record<string, unknown>
type ReferredUser = Record<string, unknown>

export interface AffiliateWithStats extends Record<string, unknown> {
  referredCheckoutCount:   number
  confirmedSalesCount:     number
  confirmedRevenueUsd:     number
  pendingCommissionOwed:   number
  paidCommissionUsd:       number
  affiliateConversionRate: number
}

export interface AdminData {
  metrics: {
    totalCheckoutAttempts:    number
    realCheckoutAttempts:     number
    unpaidCheckoutsCount:     number
    realConfirmedSalesCount:  number
    realConfirmedRevenueUsd:  number
    testPaymentsCount:        number
    testConfirmedRevenueUsd:  number
    pendingCommissionAmountUsd: number
    totalPaidCommissionUsd:   number
    approvedAffiliatesCount:  number
    pendingApplicationsCount: number
    avgOrderValueUsd:         number
    realConversionRate:       number
    proConfirmedCount:        number
    eliteConfirmedCount:      number
    proConfirmedRevenueUsd:   number
    eliteConfirmedRevenueUsd: number
    proUnpaidCount:           number
    eliteUnpaidCount:         number
    funnelConfirmed:          number
    funnelFailed:             number
    funnelUnpaid:             number
  }
  payments:            Payment[]
  pendingApplications: Affiliate[]
  approvedAffiliates:  AffiliateWithStats[]
  commissions:         Commission[]
  referredUsers:       ReferredUser[]
}

// ─── Route handler ────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  // Admin gate — must pass before any data is read
  const adminEmail = await verifyAdmin(req)
  if (!adminEmail) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sb = makeServiceClient()
  if (!sb) return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })

  // All queries run in parallel
  const [
    paymentsRes,
    affiliatesRes,
    commissionsRes,
    referredUsersRes,
    allPaymentsAggRes,       // drives ALL aggregate metrics (replaces separate count queries)
    allPendingCommsRes,
    allPaidCommsRes,
    allAffiliatePaymentsRes,
    approvedCountRes,
    pendingAppCountRes,
  ] = await Promise.all([
    // Display: last 50 payments (all statuses)
    sb.from('crypto_payments')
      .select('order_id, user_email, plan, amount_usd, status, referral_code, affiliate_id, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(50),

    // All affiliates
    sb.from('affiliates')
      .select('id, name, email, x_handle, audience_size, referral_code, status, commission_rate, approved_at, created_at')
      .order('created_at', { ascending: false })
      .limit(200),

    // Display: last 50 commissions
    sb.from('affiliate_commissions')
      .select('id, affiliate_id, buyer_email, payment_amount_usd, commission_rate, commission_amount, referral_code, plan, status, paid_at, created_at')
      .order('created_at', { ascending: false })
      .limit(50),

    // Referred users
    sb.from('user_settings')
      .select('user_id, plan, subscription_status, referred_by_affiliate_id, created_at, updated_at')
      .not('referred_by_affiliate_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(50),

    // All payments (lightweight fields) — computes funnel, conversion, plan breakdown
    sb.from('crypto_payments')
      .select('user_email, status, plan, amount_usd'),

    // Pending commissions — total owed + per-affiliate breakdown
    sb.from('affiliate_commissions')
      .select('affiliate_id, commission_amount')
      .eq('status', 'pending'),

    // Paid commissions — total paid + per-affiliate paid total
    sb.from('affiliate_commissions')
      .select('affiliate_id, commission_amount')
      .eq('status', 'paid'),

    // Payments with referral codes — per-affiliate checkout + revenue stats
    // user_email included to exclude internal payments from affiliate revenue
    sb.from('crypto_payments')
      .select('referral_code, amount_usd, status, user_email')
      .not('referral_code', 'is', null),

    sb.from('affiliates').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
    sb.from('affiliates').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
  ])

  // Flag display payment rows with _isInternal for UI badging
  const payments = (paymentsRes.data ?? []).map((p) => {
    const row = p as Record<string, unknown>
    return { ...row, _isInternal: INTERNAL_EMAILS.has(String(row.user_email ?? '').toLowerCase()) }
  }) as Payment[]

  const allAffiliates = (affiliatesRes.data ?? []) as Affiliate[]

  // Flag commission rows with _isTestPayment based on buyer_email
  const commissions = (commissionsRes.data ?? []).map((c) => {
    const row = c as Record<string, unknown>
    return { ...row, _isTestPayment: INTERNAL_EMAILS.has(String(row.buyer_email ?? '').toLowerCase()) }
  }) as Commission[]

  const referredUsers        = (referredUsersRes.data ?? []) as ReferredUser[]
  const allPaymentsAgg       = (allPaymentsAggRes.data ?? []) as Array<{ user_email: unknown; status: unknown; plan: unknown; amount_usd: unknown }>
  const allPendingComms      = (allPendingCommsRes.data ?? []) as Array<{ affiliate_id: unknown; commission_amount: unknown }>
  const allPaidComms         = (allPaidCommsRes.data ?? []) as Array<{ affiliate_id: unknown; commission_amount: unknown }>
  const allAffiliatePayments = (allAffiliatePaymentsRes.data ?? []) as Array<{ referral_code: unknown; amount_usd: unknown; status: unknown; user_email: unknown }>

  // ── Aggregate all metrics in a single pass ────────────────────────────────
  let totalCheckoutAttempts  = 0
  let realCheckoutAttempts   = 0
  let unpaidCheckoutsCount   = 0
  let realConfirmedSalesCount = 0
  let realConfirmedRevenueUsd = 0
  let testPaymentsCount       = 0
  let testConfirmedRevenueUsd = 0
  let proConfirmedCount       = 0
  let eliteConfirmedCount     = 0
  let proConfirmedRevenueUsd  = 0
  let eliteConfirmedRevenueUsd = 0
  let proUnpaidCount          = 0
  let eliteUnpaidCount        = 0
  let funnelConfirmed         = 0
  let funnelFailed            = 0
  let funnelUnpaid            = 0

  for (const p of allPaymentsAgg) {
    const email       = String(p.user_email ?? '').toLowerCase()
    const status      = String(p.status ?? '').toLowerCase()
    const plan        = String(p.plan ?? '').toLowerCase()
    const amt         = Number(p.amount_usd) || 0
    const isInternal  = INTERNAL_EMAILS.has(email)
    const isConfirmed = CONFIRMED_STATUSES.has(status)
    const isUnpaid    = UNPAID_STATUSES.has(status)
    const isFailed    = FAILED_STATUSES.has(status)

    totalCheckoutAttempts++

    // Funnel counts include all rows (internal + real) so they sum to total
    if (isConfirmed)     funnelConfirmed++
    else if (isFailed)   funnelFailed++
    else if (isUnpaid)   funnelUnpaid++

    if (isInternal) {
      if (isConfirmed) { testPaymentsCount++; testConfirmedRevenueUsd += amt }
    } else {
      realCheckoutAttempts++
      if (isUnpaid) {
        unpaidCheckoutsCount++
        if (plan === 'pro') proUnpaidCount++
        else if (plan === 'elite') eliteUnpaidCount++
      }
      if (isConfirmed) {
        realConfirmedSalesCount++
        realConfirmedRevenueUsd += amt
        if (plan === 'pro')        { proConfirmedCount++;    proConfirmedRevenueUsd += amt }
        else if (plan === 'elite') { eliteConfirmedCount++; eliteConfirmedRevenueUsd += amt }
      }
    }
  }

  const avgOrderValueUsd   = realConfirmedSalesCount > 0 ? realConfirmedRevenueUsd / realConfirmedSalesCount : 0
  const realConversionRate = realCheckoutAttempts > 0 ? realConfirmedSalesCount / realCheckoutAttempts : 0
  const pendingCommissionAmountUsd = allPendingComms.reduce((s, r) => s + (Number(r.commission_amount) || 0), 0)
  const totalPaidCommissionUsd     = allPaidComms.reduce((s, r) => s + (Number(r.commission_amount) || 0), 0)

  // ── Per-affiliate performance — real customers only ───────────────────────
  const codeStats: Record<string, { checkouts: number; revenue: number; confirmedCount: number }> = {}
  for (const p of allAffiliatePayments) {
    const code       = String(p.referral_code ?? '')
    const isInternal = INTERNAL_EMAILS.has(String(p.user_email ?? '').toLowerCase())
    if (!code || isInternal) continue
    if (!codeStats[code]) codeStats[code] = { checkouts: 0, revenue: 0, confirmedCount: 0 }
    codeStats[code].checkouts++
    if (CONFIRMED_STATUSES.has(String(p.status ?? '').toLowerCase())) {
      codeStats[code].revenue += Number(p.amount_usd) || 0
      codeStats[code].confirmedCount++
    }
  }

  const idPending: Record<string, number> = {}
  for (const c of allPendingComms) {
    const id = String(c.affiliate_id ?? '')
    if (id) idPending[id] = (idPending[id] ?? 0) + (Number(c.commission_amount) || 0)
  }

  const idPaid: Record<string, number> = {}
  for (const c of allPaidComms) {
    const id = String(c.affiliate_id ?? '')
    if (id) idPaid[id] = (idPaid[id] ?? 0) + (Number(c.commission_amount) || 0)
  }

  const pendingApplications = allAffiliates.filter((a) => a.status === 'pending')
  const approvedAffiliates: AffiliateWithStats[] = allAffiliates
    .filter((a) => a.status === 'approved' || a.status === 'active')
    .map((a) => {
      const code  = String(a.referral_code ?? '')
      const id    = String(a.id ?? '')
      const stats = codeStats[code] ?? { checkouts: 0, revenue: 0, confirmedCount: 0 }
      return {
        ...a,
        referredCheckoutCount:   stats.checkouts,
        confirmedSalesCount:     stats.confirmedCount,
        confirmedRevenueUsd:     stats.revenue,
        pendingCommissionOwed:   idPending[id] ?? 0,
        paidCommissionUsd:       idPaid[id] ?? 0,
        affiliateConversionRate: stats.checkouts > 0 ? stats.confirmedCount / stats.checkouts : 0,
      }
    })
    .sort((a, b) => b.confirmedRevenueUsd - a.confirmedRevenueUsd)

  return NextResponse.json({
    metrics: {
      totalCheckoutAttempts,
      realCheckoutAttempts,
      unpaidCheckoutsCount,
      realConfirmedSalesCount,
      realConfirmedRevenueUsd,
      testPaymentsCount,
      testConfirmedRevenueUsd,
      pendingCommissionAmountUsd,
      totalPaidCommissionUsd,
      approvedAffiliatesCount:  approvedCountRes.count ?? 0,
      pendingApplicationsCount: pendingAppCountRes.count ?? 0,
      avgOrderValueUsd,
      realConversionRate,
      proConfirmedCount,
      eliteConfirmedCount,
      proConfirmedRevenueUsd,
      eliteConfirmedRevenueUsd,
      proUnpaidCount,
      eliteUnpaidCount,
      funnelConfirmed,
      funnelFailed,
      funnelUnpaid,
    },
    payments,
    pendingApplications,
    approvedAffiliates,
    commissions,
    referredUsers,
  } satisfies AdminData)
}
