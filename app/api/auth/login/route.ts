import { NextRequest, NextResponse } from 'next/server'
import { createAnonSupabaseClient } from '@/lib/supabase/userSettings'

// TODO: replace with Redis/DB-backed store for multi-instance production deployments.
// In-memory map tracks failed attempts per IP+email key within a rolling window.
const failMap = new Map<string, { failed: number; resetAt: number }>()
const MAX_FAILS = 5
const WINDOW_MS = 10 * 60 * 1000

function clientIP(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  )
}

function rateLimitKey(ip: string, email: string): string {
  return `${ip}:${email.trim().toLowerCase()}`
}

function isBlocked(key: string): boolean {
  const now = Date.now()
  const entry = failMap.get(key)
  if (!entry || now > entry.resetAt) return false
  return entry.failed >= MAX_FAILS
}

function recordFail(key: string): number {
  const now = Date.now()
  const entry = failMap.get(key)
  if (!entry || now > entry.resetAt) {
    failMap.set(key, { failed: 1, resetAt: now + WINDOW_MS })
    return 1
  }
  entry.failed += 1
  return entry.failed
}

function clearFails(key: string): void {
  failMap.delete(key)
}

export async function POST(request: NextRequest) {
  const ip = clientIP(request)

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const { email, password } = body

  if (typeof email !== 'string' || !email.includes('@') || email.length < 3) {
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 400 })
  }
  if (typeof password !== 'string' || !password) {
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 400 })
  }

  const key = rateLimitKey(ip, email)

  if (isBlocked(key)) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many login attempts. Please wait before trying again.' },
      { status: 429 },
    )
  }

  const supabase = createAnonSupabaseClient()
  if (!supabase) {
    return NextResponse.json({ error: 'Login service unavailable. Please try again.' }, { status: 503 })
  }

  const { data, error: signInError } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  })

  if (signInError) {
    const failCount = recordFail(key)
    // Progressive delay after 3 failures — slows brute force without blocking the server long
    if (failCount >= 3) {
      await new Promise(r => setTimeout(r, 1000))
    }
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 })
  }

  // Verified sign-in — clear failed count
  clearFails(key)

  const user = data.user
  const session = data.session

  // Enforce email verification for email/password accounts
  if (user?.app_metadata?.provider === 'email' && !user?.email_confirmed_at) {
    // Sign out the unverified session immediately
    await supabase.auth.signOut()
    return NextResponse.json(
      { error: 'unverified', message: 'Please verify your email before signing in. Check your inbox for a confirmation link.' },
      { status: 403 },
    )
  }

  if (!session) {
    return NextResponse.json({ error: 'Login service unavailable. Please try again.' }, { status: 503 })
  }

  return NextResponse.json({
    ok: true,
    session: {
      access_token:  session.access_token,
      refresh_token: session.refresh_token,
    },
  })
}
