import { createHash } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'
import { createAnonSupabaseClient, createAuthedSupabaseClient } from '@/lib/supabase/userSettings'

const ipLimiter = createRateLimiter({ windowMs: 60_000, max: 8 })
const userLimiter = createRateLimiter({ windowMs: 60_000, max: 5 })

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function canonicalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export async function POST(request: NextRequest) {
  const noStoreHeaders = { 'Cache-Control': 'no-store, max-age=0' }
  const ip = getClientIp(request)
  if (!ipLimiter.check(`trial:${ip}`)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: noStoreHeaders })
  }

  const authHeader = request.headers.get('authorization')
  if (!authHeader?.toLowerCase().startsWith('bearer ')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: noStoreHeaders })
  }
  const token = authHeader.slice(7).trim()
  if (!token) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: noStoreHeaders })

  const authSupabase = createAnonSupabaseClient()
  const supabase = createAuthedSupabaseClient(token)
  if (!authSupabase || !supabase) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503, headers: noStoreHeaders })
  }

  const { data: authData, error: authError } = await authSupabase.auth.getUser(token)
  if (authError || !authData.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: noStoreHeaders })
  }

  const userId = authData.user.id
  if (!userLimiter.check(`trial-user:${userId}`)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: noStoreHeaders })
  }

  const email = authData.user.email
  if (!email) {
    return NextResponse.json({ error: 'ineligible' }, { status: 403, headers: noStoreHeaders })
  }

  const emailHash = sha256(canonicalizeEmail(email))
  const ipHash = sha256(ip)
  const ua = request.headers.get('user-agent') ?? 'unknown'
  const uaHash = sha256(ua)

  const { data: settings, error: settingsError } = await supabase
    .from('user_settings')
    .select('plan,subscription_status,trial_used,trial_plan,trial_started_at,trial_ends_at')
    .eq('user_id', userId)
    .maybeSingle()
  if (settingsError) return NextResponse.json({ error: 'request_failed' }, { status: 500, headers: noStoreHeaders })

  const paidEliteActive = settings?.plan === 'elite' && settings?.subscription_status === 'active'
  if (paidEliteActive) return NextResponse.json({ status: 'already_elite' }, { status: 200, headers: noStoreHeaders })

  if (settings?.trial_used === true) {
    const endsAt = settings?.trial_ends_at ? Date.parse(settings.trial_ends_at) : Number.NaN
    const isActive = settings?.trial_plan === 'elite' && Number.isFinite(endsAt) && endsAt > Date.now()
    const daysLeft = isActive ? Math.max(1, Math.ceil((endsAt - Date.now()) / 86_400_000)) : 0
    return NextResponse.json({ status: isActive ? 'already_active' : 'already_claimed', daysLeft }, { status: 200, headers: noStoreHeaders })
  }

  const { data: priorEmailClaim, error: emailCheckError } = await supabase
    .from('user_settings')
    .select('user_id')
    .eq('trial_email_hash', emailHash)
    .eq('trial_used', true)
    .limit(1)
    .maybeSingle()
  if (emailCheckError) return NextResponse.json({ error: 'request_failed' }, { status: 500, headers: noStoreHeaders })
  if (priorEmailClaim) return NextResponse.json({ status: 'already_claimed_email' }, { status: 200, headers: noStoreHeaders })

  const cutoffIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { count: ipClaimCount, error: ipCheckError } = await supabase
    .from('user_settings')
    .select('user_id', { count: 'exact', head: true })
    .eq('trial_claim_ip_hash', ipHash)
    .eq('trial_used', true)
    .gte('trial_started_at', cutoffIso)
  if (ipCheckError) return NextResponse.json({ error: 'request_failed' }, { status: 500, headers: noStoreHeaders })
  if ((ipClaimCount ?? 0) >= 5) return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: noStoreHeaders })

  const nowIso = new Date().toISOString()
  const endsIso = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const { error: updateError } = await supabase.from('user_settings').upsert({
    user_id: userId,
    trial_started_at: nowIso,
    trial_ends_at: endsIso,
    trial_plan: 'elite',
    trial_used: true,
    trial_granted_reason: 'homepage_claim_7_day_elite',
    trial_email_hash: emailHash,
    trial_claim_ip_hash: ipHash,
    trial_claim_user_agent_hash: uaHash,
    updated_at: nowIso,
  }, { onConflict: 'user_id' })
  if (updateError) return NextResponse.json({ error: 'request_failed' }, { status: 500, headers: noStoreHeaders })

  return NextResponse.json({ status: 'claimed', trialEndsAt: endsIso }, { status: 200, headers: noStoreHeaders })
}
