import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ─── Admin access list ────────────────────────────────────────────────────────
function getAdminEmails(): Set<string> {
  const raw = process.env.ADMIN_EMAILS
  if (raw) return new Set(raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean))
  return new Set()
}
const ADMIN_EMAILS = getAdminEmails()

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

// ─── UUID validation ──────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Action =
  | 'approve_affiliate'
  | 'reject_affiliate'
  | 'mark_commission_paid'
  | 'mark_commission_pending'

const VALID_ACTIONS = new Set<Action>([
  'approve_affiliate',
  'reject_affiliate',
  'mark_commission_paid',
  'mark_commission_pending',
])

// ─── Route handler ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // 1. Admin gate
  const adminEmail = await verifyAdmin(req)
  if (!adminEmail) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sb = makeServiceClient()
  if (!sb) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }

  // 2. Parse and validate body
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { action, id } = (body ?? {}) as { action?: unknown; id?: unknown }

  if (!action || !VALID_ACTIONS.has(action as Action)) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }
  if (!id || typeof id !== 'string' || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid id: must be a UUID' }, { status: 400 })
  }

  const act = action as Action
  const now = new Date().toISOString()

  // 3. Perform the action — each update guards on both id AND expected current status
  if (act === 'approve_affiliate') {
    const { error, count } = await sb
      .from('affiliates')
      .update({ status: 'approved', approved_at: now })
      .eq('id', id)
      .eq('status', 'pending')
    if (error) return NextResponse.json({ error: 'Database error' }, { status: 500 })
    if (count === 0) return NextResponse.json({ error: 'Affiliate not found or not in pending state' }, { status: 409 })
    return NextResponse.json({ ok: true, message: 'Affiliate approved' })
  }

  if (act === 'reject_affiliate') {
    const { error, count } = await sb
      .from('affiliates')
      .update({ status: 'rejected' })
      .eq('id', id)
      .eq('status', 'pending')
    if (error) return NextResponse.json({ error: 'Database error' }, { status: 500 })
    if (count === 0) return NextResponse.json({ error: 'Affiliate not found or not in pending state' }, { status: 409 })
    return NextResponse.json({ ok: true, message: 'Affiliate rejected' })
  }

  if (act === 'mark_commission_paid') {
    const { error, count } = await sb
      .from('affiliate_commissions')
      .update({ status: 'paid', paid_at: now })
      .eq('id', id)
      .eq('status', 'pending')
    if (error) return NextResponse.json({ error: 'Database error' }, { status: 500 })
    if (count === 0) return NextResponse.json({ error: 'Commission not found or not in pending state' }, { status: 409 })
    return NextResponse.json({ ok: true, message: 'Commission marked as paid' })
  }

  if (act === 'mark_commission_pending') {
    const { error, count } = await sb
      .from('affiliate_commissions')
      .update({ status: 'pending', paid_at: null })
      .eq('id', id)
      .eq('status', 'paid')
    if (error) return NextResponse.json({ error: 'Database error' }, { status: 500 })
    if (count === 0) return NextResponse.json({ error: 'Commission not found or not in paid state' }, { status: 409 })
    return NextResponse.json({ ok: true, message: 'Commission reverted to pending' })
  }

  return NextResponse.json({ error: 'Unhandled action' }, { status: 400 })
}
