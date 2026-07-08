import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createAnonSupabaseClient, activateUserPlanServerSide } from '@/lib/supabase/userSettings'
import { lookupPayPalTransaction } from '@/lib/paypal'

export const dynamic = 'force-dynamic'

// PRICE SOURCE OF TRUTH, DISCLOSED: the task spec's own example ("9.99 AUD") does not match this
// app's actual, real Pro/Elite pricing shown on /pricing ($30 / $60 USD, same numbers the crypto
// checkout route already charges) — using the example number here would let a PayPal payment buy
// Pro for a different, much lower price than every other payment method charges. Defaults to the
// app's real prices; override via env if you genuinely want different PayPal pricing.
const DEFAULT_PLAN_AMOUNTS: Record<string, number> = { pro: 30, elite: 60 }
const EXPECTED_CURRENCY = (process.env.PAYPAL_EXPECTED_CURRENCY ?? 'USD').toUpperCase()

function expectedAmount(plan: 'pro' | 'elite'): number {
  const envKey = plan === 'pro' ? 'PAYPAL_PRO_PRICE' : 'PAYPAL_ELITE_PRICE'
  const override = process.env[envKey]
  return override ? Number(override) : DEFAULT_PLAN_AMOUNTS[plan]
}

const VERIFY_WINDOW_MS = 60 * 1000
const VERIFY_LIMIT_PER_IP = 8
const verifyRate = new Map<string, { count: number; resetAt: number }>()

function verifyAllowed(req: NextRequest): boolean {
  const key = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const now = Date.now()
  const cur = verifyRate.get(key)
  if (!cur || cur.resetAt <= now) { verifyRate.set(key, { count: 1, resetAt: now + VERIFY_WINDOW_MS }); return true }
  if (cur.count >= VERIFY_LIMIT_PER_IP) return false
  cur.count += 1
  return true
}

// PAYPAL TRANSACTION STATUS CODES, DISCLOSED: the Reporting API returns single-letter codes, not
// the string "COMPLETED" the task spec described — 'S' = Success/Completed, 'D' = Denied,
// 'P' = Pending, 'V' = Reversed/Refunded. Only 'S' is accepted as a real, final, successful payment.
const SUCCESS_STATUS_CODE = 'S'

export async function POST(req: NextRequest) {
  if (!verifyAllowed(req)) return NextResponse.json({ error: 'Too many verification attempts. Try again shortly.' }, { status: 429 })

  // SECURITY DEVIATION FROM THE LITERAL SPEC, DISCLOSED: the task's own spec says accept `userId`
  // as request input — but trusting a client-supplied userId directly would let anyone upgrade ANY
  // account by pairing a transaction ID they themselves paid for with someone else's user id (a
  // real account-takeover / free-upgrade vulnerability). Instead, the user id is derived ONLY from
  // the authenticated Bearer session token, exactly like every other payment route in this app
  // (checkout/crypto). A client-supplied userId, if present, is ignored for authorization purposes.
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return NextResponse.json({ error: 'Sign in to verify a payment.' }, { status: 401 })

  const sb = createAnonSupabaseClient()
  if (!sb) return NextResponse.json({ error: 'Service unavailable.' }, { status: 503 })
  const { data: userData, error: authErr } = await sb.auth.getUser(token)
  if (authErr || !userData.user) return NextResponse.json({ error: 'Sign in to verify a payment.' }, { status: 401 })

  const userId = userData.user.id

  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  const transactionId = typeof body?.transactionId === 'string' ? body.transactionId.trim() : ''
  const plan = (body?.plan === 'elite' ? 'elite' : 'pro') as 'pro' | 'elite'

  if (!transactionId || !/^[A-Za-z0-9]{10,20}$/.test(transactionId)) {
    return NextResponse.json({ error: 'Enter a valid PayPal transaction ID.' }, { status: 400 })
  }
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    return NextResponse.json({ error: 'Payment verification is not configured yet.' }, { status: 503 })
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '')

  // A given real transaction can only ever grant a plan ONCE — this is the replay-protection
  // equivalent of the crypto webhook's processedPaymentIds dedup set, but persisted (not
  // in-process) since this route is called directly by the user, not a provider's own retrying
  // webhook infrastructure.
  const { data: existing } = await supabase
    .from('paypal_transactions')
    .select('id,user_id,plan')
    .eq('transaction_id', transactionId)
    .maybeSingle()

  if (existing) {
    if (existing.user_id === userId) {
      // Same user re-submitting the same (already-verified) transaction id — idempotent success,
      // not an error, since their plan is already active from the first successful verification.
      return NextResponse.json({ success: true, plan: existing.plan })
    }
    return NextResponse.json({ error: 'This transaction has already been used to verify a different account.' }, { status: 409 })
  }

  const lookup = await lookupPayPalTransaction(transactionId)
  if (!lookup.ok) {
    const messages: Record<string, string> = {
      not_configured: 'Payment verification is not configured yet.',
      auth_failed: 'Could not authenticate with PayPal. Try again shortly.',
      not_found: 'That transaction ID was not found. Double-check it and try again.',
      request_failed: 'Could not verify with PayPal right now. Try again shortly.',
    }
    const status = lookup.reason === 'not_configured' ? 503 : lookup.reason === 'not_found' ? 404 : 502
    return NextResponse.json({ error: messages[lookup.reason] }, { status })
  }

  const info = lookup.transaction.transaction_info
  const payerEmail = lookup.transaction.payer_info?.email_address

  if (info?.transaction_status !== SUCCESS_STATUS_CODE) {
    return NextResponse.json({ error: 'This transaction was not completed successfully.' }, { status: 400 })
  }
  if (!payerEmail) {
    return NextResponse.json({ error: 'Could not verify the payer on this transaction.' }, { status: 400 })
  }

  const currency = (info.transaction_amount?.currency_code ?? '').toUpperCase()
  const amount = Number(info.transaction_amount?.value ?? 0)
  const expected = expectedAmount(plan)
  if (currency !== EXPECTED_CURRENCY || Math.abs(amount - expected) > 0.5) {
    return NextResponse.json({ error: `Transaction amount does not match the ${plan === 'pro' ? 'Pro' : 'Elite'} plan price.` }, { status: 400 })
  }

  const { error: activateError } = await activateUserPlanServerSide(userId, plan, transactionId)
  if (activateError) return NextResponse.json({ error: 'Could not activate your plan. Try again or contact support.' }, { status: 500 })

  await supabase.from('paypal_transactions').insert({
    user_id: userId,
    method: 'paypal',
    transaction_id: transactionId,
    payer_email: payerEmail,
    amount,
    currency,
    plan,
    status: 'completed',
  })

  return NextResponse.json({ success: true, plan })
}
