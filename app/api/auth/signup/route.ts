import { NextRequest, NextResponse } from 'next/server'
import { createAnonSupabaseClient } from '@/lib/supabase/userSettings'

// ── Password policy ───────────────────────────────────────────────────────────

const BANNED_PASSWORDS = new Set([
  '123456', '12345678', '123456789', 'password', 'password123',
  'qwerty', 'qwerty123', 'chainlens', 'chainlens123', 'letmein', 'admin123',
])

function meetsPolicy(pw: string): boolean {
  if (typeof pw !== 'string') return false
  if (BANNED_PASSWORDS.has(pw.toLowerCase())) return false
  return (
    pw.length >= 10 &&
    /[A-Z]/.test(pw) &&
    /[a-z]/.test(pw) &&
    /[0-9]/.test(pw) &&
    /[^A-Za-z0-9]/.test(pw)
  )
}

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

  if (!meetsPolicy(password as string)) {
    return NextResponse.json(
      { error: 'weak_password', message: 'Use at least 10 characters with uppercase, lowercase, a number, and a symbol.' },
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

  const origin = request.headers.get('origin') || ''
  const redirectTo = origin ? `${origin}/auth/callback` : undefined

  const { error: signUpError } = await supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password: password as string,
    options: { emailRedirectTo: redirectTo },
  })

  if (signUpError) {
    const msg = signUpError.message.toLowerCase()
    console.error('[signup] error status:', signUpError.status)

    if (msg.includes('already registered') || msg.includes('already exists')) {
      return NextResponse.json(
        { error: 'email_exists', message: 'An account with this email already exists. Try signing in.' },
        { status: 409 },
      )
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

  return NextResponse.json({ success: true })
}
