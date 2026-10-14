import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createHmac, timingSafeEqual } from 'crypto'
import { clearWhaleFeedCache } from '@/lib/server/whaleAlertCache'
import { persistWhaleAlerts, type WhaleAlertsDb } from '@/lib/server/whaleAlertPersist'
import { buildWebhookCandidates, SUPPORTED_WEBHOOK_NETWORKS, type WebhookTrackedWallet } from '@/lib/server/whaleWebhookCandidates'

type AlchemyPayload = {
  createdAt?: string | null
  type?: string
  event?: {
    network?: string
    activity?: unknown[]
  }
}

const WEBHOOK_EVENT_CAP_PER_MINUTE = 150

const minuteBuckets = new Map<string, number>()

function consumeMinuteBudget(requested: number): { allowed: number; deferred: number } {
  const now = new Date()
  const minuteKey = now.toISOString().slice(0, 16)

  for (const key of minuteBuckets.keys()) {
    if (key !== minuteKey) minuteBuckets.delete(key)
  }

  const used = minuteBuckets.get(minuteKey) ?? 0
  const remaining = Math.max(0, WEBHOOK_EVENT_CAP_PER_MINUTE - used)
  const allowed = Math.min(requested, remaining)
  minuteBuckets.set(minuteKey, used + allowed)

  return { allowed, deferred: Math.max(0, requested - allowed) }
}

async function handleWebhook(payload: AlchemyPayload) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRole) {
    return NextResponse.json({ ok: false, error: 'missing_supabase_env' }, { status: 503 })
  }

  const rawActivity = payload?.event?.activity
  if (!Array.isArray(rawActivity) || rawActivity.length === 0) {
    console.log('[alchemy-webhook]', { received: 0, earlySkipped: 1, duplicateSkipped: 0, relevantForEnrichment: 0, enriched: 0, inserted: 0 })
    return NextResponse.json({ ok: true, received: 0, inserted: 0 })
  }

  // Every stored row is chain 'base': events from any other network must not become Base alerts.
  const network = payload?.event?.network ?? null
  if (network && !SUPPORTED_WEBHOOK_NETWORKS.has(network)) {
    console.warn('[alchemy-webhook] unsupported network ignored', network)
    return NextResponse.json({ ok: true, received: rawActivity.length, inserted: 0, ignored: 'unsupported_network', network })
  }

  const received = rawActivity.length
  const budget = consumeMinuteBudget(received)

  const supabase = createClient(supabaseUrl, serviceRole)
  const { data: wallets, error: walletError } = await supabase
    .from('tracked_wallets')
    .select('address,label')
    .is('user_id', null)
    .eq('is_active', true)

  if (walletError) {
    return NextResponse.json({ ok: false, error: 'wallet_load_failed' }, { status: 500 })
  }

  const occurredAt = payload.createdAt ? new Date(payload.createdAt).toISOString() : new Date().toISOString()
  const built = buildWebhookCandidates(rawActivity.slice(0, budget.allowed), (wallets ?? []) as WebhookTrackedWallet[], occurredAt)
  const candidates = built.candidates
  let duplicateSkipped = built.duplicateSkipped
  const earlySkipped = built.earlySkipped
  const relevantForEnrichment = built.relevantForEnrichment
  const deferred = budget.deferred

  const enriched = candidates.length

  // Events over the per-minute cap were NOT processed. Answer 429 so Alchemy re-delivers the
  // payload later (writes are idempotent on the movement key) instead of acknowledging and losing them.
  const deferredResponse = (inserted: number) => {
    console.warn('[alchemy-webhook] budget deferred events; requesting redelivery', { received, deferred, inserted })
    return NextResponse.json({ ok: false, error: 'rate_limited_deferred', received, deferred, inserted }, { status: 429, headers: { 'Retry-After': '60' } })
  }

  if (candidates.length === 0) {
    console.log('[alchemy-webhook]', { received, earlySkipped, deferred, duplicateSkipped, relevantForEnrichment, enriched: 0, inserted: 0 })
    if (deferred > 0) return deferredResponse(0)
    return NextResponse.json({ ok: true, received, inserted: 0 })
  }

  // System wallets only (user_id IS NULL), so every row is shareable — the legacy no-owner
  // write path is safe here when the ownership migration has not been applied.
  const write = await persistWhaleAlerts(supabase as unknown as WhaleAlertsDb, candidates)

  if (write.error) {
    console.error('[alchemy-webhook] whale_alerts insert failed', write.error.code, write.error.message)
    return NextResponse.json({ ok: false, error: 'insert_failed', code: write.error.code ?? null }, { status: 500 })
  }

  const inserted = write.inserted
  duplicateSkipped += Math.max(0, candidates.length - inserted)

  if (inserted > 0) clearWhaleFeedCache()
  console.log('[alchemy-webhook]', { received, earlySkipped, deferred, duplicateSkipped, relevantForEnrichment, enriched, inserted, writePath: write.path })
  if (deferred > 0) return deferredResponse(inserted)
  return NextResponse.json({ ok: true, received, inserted })
}

export async function GET() {
  return NextResponse.json({ ok: true, route: 'alchemy webhook alive' })
}

export async function POST(request: Request) {
  const webhooksEnabled = (process.env.WEBHOOKS_ENABLED ?? 'true').toLowerCase() !== 'false'
  if (!webhooksEnabled) {
    return NextResponse.json({ ok: true, disabled: true })
  }

  const signingKey = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY

  if (!signingKey) {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json({ ok: false, error: 'Webhook service unavailable' }, { status: 500 })
    }
    console.warn('[alchemy-webhook] ALCHEMY_WEBHOOK_SIGNING_KEY not set — skipping signature check (non-production only)')
  }

  // Always read the raw body first so we can both verify and parse
  const rawBody = await request.text()

  if (signingKey) {
    const providedSig = request.headers.get('x-alchemy-signature') ?? ''
    const expected = createHmac('sha256', signingKey).update(rawBody).digest('hex')
    let sigValid = false
    try {
      sigValid = timingSafeEqual(Buffer.from(providedSig, 'hex'), Buffer.from(expected, 'hex'))
    } catch {
      sigValid = false
    }
    if (!sigValid) {
      return NextResponse.json({ ok: false, error: 'Invalid signature' }, { status: 401 })
    }
  }

  let payload: AlchemyPayload = {}
  try {
    payload = JSON.parse(rawBody) as AlchemyPayload
  } catch {
    console.log('[alchemy-webhook]', { received: 0, earlySkipped: 1, duplicateSkipped: 0, relevantForEnrichment: 0, enriched: 0, inserted: 0 })
    return NextResponse.json({ ok: true, received: 0, inserted: 0 })
  }

  return handleWebhook(payload)
}
