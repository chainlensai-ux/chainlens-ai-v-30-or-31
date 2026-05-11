import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { activateUserPlanServerSide } from '@/lib/supabase/userSettings'

export const dynamic = 'force-dynamic'

const PLAN_AMOUNTS: Record<string, number> = { pro: 30, elite: 60 }
// Only activate on these event types — ignore pending/failed/expired
const ACTIVATION_EVENTS = new Set(['charge:confirmed', 'charge:resolved'])

// In-process dedup set. Prevents double-activation from retry storms.
// For multi-instance deployments, replace with a DB-backed idempotency key check.
const processedEventIds = new Set<string>()

function verifySignature(rawBody: string, sig: string, secret: string): boolean {
  if (!sig) return false
  try {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
    const sigBuf = Buffer.from(sig, 'hex')
    const expBuf = Buffer.from(expected, 'hex')
    if (sigBuf.length === 0 || sigBuf.length !== expBuf.length) return false
    return crypto.timingSafeEqual(sigBuf, expBuf)
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const secret = process.env.COINBASE_COMMERCE_WEBHOOK_SECRET
  if (!secret) {
    // Not configured — acknowledge to avoid provider retries while we set up
    console.warn('[crypto-webhook] COINBASE_COMMERCE_WEBHOOK_SECRET not set')
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  let rawBody: string
  try {
    rawBody = await req.text()
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const sig = req.headers.get('x-cc-webhook-signature') ?? ''
  if (!verifySignature(rawBody, sig, secret)) {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  let event: Record<string, unknown>
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const eventId = String(event.id ?? '').trim()
  const eventType = String(event.type ?? '').trim()

  // Deduplicate
  if (eventId) {
    if (processedEventIds.has(eventId)) {
      return NextResponse.json({ ok: true })
    }
    if (processedEventIds.size > 10_000) processedEventIds.clear()
  }

  // Ignore non-activation events
  if (!ACTIVATION_EVENTS.has(eventType)) {
    return NextResponse.json({ ok: true })
  }

  const data = (event.data ?? {}) as Record<string, unknown>
  const metadata = (data.metadata ?? {}) as Record<string, unknown>
  const userId = String(metadata.userId ?? '').trim()
  const plan = String(metadata.plan ?? '').trim()
  const amountUsd = Number(metadata.amountUsd ?? 0)

  if (!userId || (plan !== 'pro' && plan !== 'elite')) {
    console.warn('[crypto-webhook] missing or invalid userId/plan in metadata')
    return NextResponse.json({ ok: true })
  }

  const expectedAmount = PLAN_AMOUNTS[plan]
  if (amountUsd !== expectedAmount) {
    console.warn(`[crypto-webhook] amount mismatch: expected ${expectedAmount}, got ${amountUsd}`)
    return NextResponse.json({ ok: true })
  }

  const paymentRef = String(data.id ?? eventId ?? '').trim() || undefined

  const { error } = await activateUserPlanServerSide(userId, plan as 'pro' | 'elite', paymentRef)
  if (error) {
    console.error('[crypto-webhook] plan activation failed:', error)
    // Return 500 so provider retries — but only if it's a transient DB error
    return NextResponse.json({ ok: false }, { status: 500 })
  }

  if (eventId) processedEventIds.add(eventId)
  console.info(`[crypto-webhook] activated plan=${plan} for userId=${userId}`)
  return NextResponse.json({ ok: true })
}
