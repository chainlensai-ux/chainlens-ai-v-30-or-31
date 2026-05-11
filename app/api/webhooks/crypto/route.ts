import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { activateUserPlanServerSide } from '@/lib/supabase/userSettings'

export const dynamic = 'force-dynamic'

const PLAN_AMOUNTS: Record<string, number> = { pro: 30, elite: 60 }
// Only activate on these statuses; all others are ignored
const ACTIVATION_STATUSES = new Set(['confirmed', 'finished'])

// In-process dedup on payment_id. For multi-instance deployments,
// replace with a DB-backed idempotency key.
const processedPaymentIds = new Set<string>()

// NOWPayments IPN signature: HMAC-SHA512 of alphabetically sorted JSON body
function sortObjectKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k]
  return sorted
}

function verifyIpnSignature(rawBody: string, sig: string, secret: string): boolean {
  if (!sig || !secret) return false
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>
    const sortedBody = JSON.stringify(sortObjectKeys(parsed))
    const expected = crypto.createHmac('sha512', secret).update(sortedBody).digest('hex')
    const sigBuf = Buffer.from(sig, 'hex')
    const expBuf = Buffer.from(expected, 'hex')
    if (sigBuf.length === 0 || sigBuf.length !== expBuf.length) return false
    return crypto.timingSafeEqual(sigBuf, expBuf)
  } catch {
    return false
  }
}

// Parse order_id format: cl_{plan}_{ts}_{userId_no_hyphens}
function parseOrderId(orderId: string): { userId: string; plan: string } | null {
  const parts = orderId.split('_')
  // expect: cl, {plan}, {ts}, {userId_no_hyphens}
  if (parts.length < 4 || parts[0] !== 'cl') return null
  const plan = parts[1]
  const rawUserId = parts[3]
  if (!rawUserId || rawUserId.length !== 32) return null
  // Reinsert hyphens into UUID: 8-4-4-4-12
  const userId = [
    rawUserId.slice(0, 8),
    rawUserId.slice(8, 12),
    rawUserId.slice(12, 16),
    rawUserId.slice(16, 20),
    rawUserId.slice(20),
  ].join('-')
  return { userId, plan }
}

export async function POST(req: NextRequest) {
  const secret = process.env.NOWPAYMENTS_IPN_SECRET
  if (!secret) {
    console.warn('[crypto-webhook] NOWPAYMENTS_IPN_SECRET not set')
    // Acknowledge to stop provider retries during initial setup
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  let rawBody: string
  try {
    rawBody = await req.text()
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const sig = req.headers.get('x-nowpayments-sig') ?? ''
  if (!verifyIpnSignature(rawBody, sig, secret)) {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  let ipn: Record<string, unknown>
  try {
    ipn = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const paymentId = String(ipn.payment_id ?? '').trim()
  const paymentStatus = String(ipn.payment_status ?? '').trim()
  const orderId = String(ipn.order_id ?? '').trim()

  // Ignore non-activation statuses
  if (!ACTIVATION_STATUSES.has(paymentStatus)) {
    return NextResponse.json({ ok: true })
  }

  // Deduplicate
  if (paymentId) {
    if (processedPaymentIds.has(paymentId)) {
      return NextResponse.json({ ok: true })
    }
    if (processedPaymentIds.size > 10_000) processedPaymentIds.clear()
  }

  // Parse order_id
  const parsed = parseOrderId(orderId)
  if (!parsed || (parsed.plan !== 'pro' && parsed.plan !== 'elite')) {
    console.warn('[crypto-webhook] unparseable or invalid order_id:', orderId)
    return NextResponse.json({ ok: true })
  }

  const { userId, plan } = parsed

  // Validate price_amount matches expected for the plan
  const priceAmount = Number(ipn.price_amount ?? 0)
  const priceCurrency = String(ipn.price_currency ?? '').toLowerCase()
  const expectedAmount = PLAN_AMOUNTS[plan]

  if (priceCurrency !== 'usd' || priceAmount !== expectedAmount) {
    console.warn(
      `[crypto-webhook] amount/currency mismatch: expected ${expectedAmount} usd, got ${priceAmount} ${priceCurrency}`,
    )
    return NextResponse.json({ ok: true })
  }

  const { error } = await activateUserPlanServerSide(userId, plan as 'pro' | 'elite', paymentId || undefined)
  if (error) {
    console.error('[crypto-webhook] plan activation failed:', error)
    return NextResponse.json({ ok: false }, { status: 500 })
  }

  if (paymentId) processedPaymentIds.add(paymentId)
  console.info(`[crypto-webhook] activated plan=${plan} for userId=${userId} paymentId=${paymentId}`)
  return NextResponse.json({ ok: true })
}
