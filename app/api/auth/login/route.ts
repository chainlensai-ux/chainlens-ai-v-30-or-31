import { NextRequest } from 'next/server'
import { createAnonSupabaseClient } from '@/lib/supabase/userSettings'
import { normalizeAuthEmail } from '@/lib/authFlow'
import { clientIpFromHeaders, createFixedWindowCounter } from '@/lib/authRateLimit'
import { noStoreJson } from '@/lib/authHttp'

const WINDOW_MS = 10 * 60 * 1000
const ipAttempts = createFixedWindowCounter(30, WINDOW_MS)
const emailFailures = createFixedWindowCounter(5, WINDOW_MS)

export async function POST(request: NextRequest) {
  const length = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > 16_384) {
    return noStoreJson({ error: 'Invalid email or password.' }, 400)
  }

  const ip = clientIpFromHeaders(request.headers)
  if (ipAttempts.isBlocked(`login:${ip}`)) {
    return noStoreJson(
      { error: 'rate_limited', message: 'Too many login attempts. Please wait before trying again.' },
      429,
    )
  }
  ipAttempts.increment(`login:${ip}`)

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return noStoreJson({ error: 'Invalid request.' }, 400)
  }

  const email = normalizeAuthEmail(body.email, false)
  const password = body.password
  if (!email || typeof password !== 'string' || password.length === 0 || password.length > 1024) {
    return noStoreJson({ error: 'Invalid email or password.' }, 400)
  }

  const failKey = `login-fail:${ip}:${email}`
  if (emailFailures.isBlocked(failKey)) {
    return noStoreJson(
      { error: 'rate_limited', message: 'Too many login attempts. Please wait before trying again.' },
      429,
    )
  }

  const supabase = createAnonSupabaseClient()
  if (!supabase) {
    return noStoreJson({ error: 'Login service unavailable. Please try again.' }, 503)
  }

  let data: Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>['data'] | undefined
  let signInError: Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>['error'] | undefined
  try {
    const result = await Promise.race([
      supabase.auth.signInWithPassword({ email, password }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('auth_timeout')), 12_000)),
    ])
    data = result.data
    signInError = result.error
  } catch {
    return noStoreJson({ error: 'Login is taking too long to respond. Please try again.' }, 503)
  }

  if (signInError || !data) {
    const failCount = emailFailures.increment(failKey)
    if (failCount >= 3) await new Promise((resolve) => setTimeout(resolve, 1000))
    return noStoreJson({ error: 'Invalid email or password.' }, 401)
  }

  emailFailures.clear(failKey)

  const user = data.user
  const session = data.session

  if (user?.app_metadata?.provider === 'email' && !user?.email_confirmed_at) {
    if (session?.access_token && session.refresh_token) {
      await supabase.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      }).catch(() => undefined)
    }
    await supabase.auth.signOut({ scope: 'global' }).catch(() => undefined)
    return noStoreJson(
      { error: 'unverified', message: 'Please verify your email before signing in. Check your inbox for a confirmation link.' },
      403,
    )
  }

  if (!session) {
    return noStoreJson({ error: 'Login service unavailable. Please try again.' }, 503)
  }

  return noStoreJson({
    ok: true,
    session: {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    },
  })
}
