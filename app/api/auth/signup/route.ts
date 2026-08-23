import { NextRequest, NextResponse } from 'next/server'
import { createAnonSupabaseClient } from '@/lib/supabase/userSettings'
import { meetsPasswordPolicy, PASSWORD_POLICY_MESSAGE } from '@/lib/authPolicy'
import { authRedirectUrl } from '@/lib/authFlow'

// ── Password policy ───────────────────────────────────────────────────────────

// ── IP-based in-memory rate limit: 5 attempts per 10 minutes ─────────────────

const rateMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT = 5
const RATE_WINDOW_MS = 10 * 60 * 1000

function allowed(ip: string): boolean {
  const now = Date.now()
  const entry = rateMap.get(ip)
  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return true
  }
  if (entry.count >= RATE_LIMIT) return false
  entry.count++
  return true
}

function clientIP(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  )
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const ip = clientIP(request)

  if (!allowed(ip)) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many signup attempts. Please wait 10 minutes and try again.' },
      { status: 429 },
    )
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'signup_unavailable', message: 'Unable to create account. Please try again.' },
      { status: 400 },
    )
  }

  const { email, password } = body

  if (typeof email !== 'string' || !email.includes('@') || email.length < 3) {
    return NextResponse.json(
      { error: 'invalid_email', message: 'Please enter a valid email address.' },
      { status: 400 },
    )
  }

  if (!meetsPasswordPolicy(password)) {
    return NextResponse.json(
      { error: 'weak_password', message: PASSWORD_POLICY_MESSAGE },
      { status: 400 },
    )
  }

  const supabase = createAnonSupabaseClient()
  if (!supabase) {
    return NextResponse.json(
      { error: 'signup_unavailable', message: 'Unable to create account. Please try again.' },
      { status: 503 },
    )
  }

  let redirectTo: string | undefined
  try {
    // Build from NextRequest's parsed origin rather than the caller-controlled Origin header.
    redirectTo = authRedirectUrl(request.nextUrl.origin, '/auth/callback')
  } catch {
    return NextResponse.json(
      { error: 'signup_unavailable', message: 'Unable to create account. Please try again.' },
      { status: 400 },
    )
  }

  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password: password as string,
    options: { emailRedirectTo: redirectTo },
  })

  if (signUpError) {
    const msg = signUpError.message.toLowerCase()
    console.error('[signup] error status:', signUpError.status)

    // USER-ENUMERATION FIX, DISCLOSED (security audit): this branch previously returned a
    // distinct 409 "email_exists" response with an explicit "already exists" message, letting
    // anyone submit arbitrary email addresses here to learn which ones already have a ChainLens
    // account — a standard, OWASP-recognized enumeration vector, and a real targeting/phishing
    // risk for a financial product. Supabase's own signUp() call itself already doesn't leak this
    // (it returns a fake unconfirmed user object for an existing email rather than an error in
    // most configurations) — this route was the one adding the distinguishable signal back in.
    // Now responds with the exact same shape a genuine new signup gets, so an existing-email
    // attempt is indistinguishable from a real one; Supabase does not send a new confirmation
    // email to an already-verified address, so no account state or notification is fabricated.
    if (msg.includes('already registered') || msg.includes('already exists')) {
      return NextResponse.json({ ok: true, requiresEmailVerification: true })
    }
    if (msg.includes('invalid email') || msg.includes('valid email') || msg.includes('email address')) {
      return NextResponse.json(
        { error: 'invalid_email', message: 'Please enter a valid email address.' },
        { status: 400 },
      )
    }
    if (msg.includes('rate limit') || msg.includes('too many')) {
      return NextResponse.json(
        { error: 'rate_limited', message: 'Too many signup attempts. Please wait a moment and try again.' },
        { status: 429 },
      )
    }
    return NextResponse.json(
      { error: 'signup_unavailable', message: 'Unable to create account. Please try again.' },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    requiresEmailVerification: !signUpData?.user?.email_confirmed_at,
  })
}
