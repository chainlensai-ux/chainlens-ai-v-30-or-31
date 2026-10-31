import { NextRequest } from 'next/server'
import { createAnonSupabaseClient } from '@/lib/supabase/userSettings'
import { passwordPolicyFailure } from '@/lib/authPolicy'
import { authRedirectUrl, normalizeAuthEmail, trustedAuthOrigin } from '@/lib/authFlow'
import { clientIpFromHeaders, createFixedWindowCounter } from '@/lib/authRateLimit'
import { noStoreJson } from '@/lib/authHttp'

const signupAttempts = createFixedWindowCounter(5, 10 * 60 * 1000)

export async function POST(request: NextRequest) {
  const length = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > 16_384) {
    return noStoreJson(
      { error: 'signup_unavailable', message: 'Unable to create account. Please try again.' },
      400,
    )
  }

  const ip = clientIpFromHeaders(request.headers)
  if (signupAttempts.isBlocked(`signup:${ip}`)) {
    return noStoreJson(
      { error: 'rate_limited', message: 'Too many signup attempts. Please wait 10 minutes and try again.' },
      429,
    )
  }
  signupAttempts.increment(`signup:${ip}`)

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return noStoreJson(
      { error: 'signup_unavailable', message: 'Unable to create account. Please try again.' },
      400,
    )
  }

  const email = normalizeAuthEmail(body.email, true)
  const policyError = passwordPolicyFailure(body.password)
  if (!email) {
    return noStoreJson(
      { error: 'invalid_email', message: 'Please enter a valid email address.' },
      400,
    )
  }
  if (policyError) {
    return noStoreJson({ error: 'weak_password', message: policyError }, 400)
  }

  const supabase = createAnonSupabaseClient()
  if (!supabase) {
    return noStoreJson(
      { error: 'signup_unavailable', message: 'Unable to create account. Please try again.' },
      503,
    )
  }

  const origin = trustedAuthOrigin(request.nextUrl.host)
  if (!origin) {
    return noStoreJson(
      { error: 'signup_unavailable', message: 'Unable to create account. Please try again.' },
      400,
    )
  }

  let redirectTo: string
  try {
    redirectTo = authRedirectUrl(origin, '/auth/callback')
  } catch {
    return noStoreJson(
      { error: 'signup_unavailable', message: 'Unable to create account. Please try again.' },
      400,
    )
  }

  const { error: signUpError } = await supabase.auth.signUp({
    email,
    password: body.password as string,
    options: { emailRedirectTo: redirectTo },
  })

  if (signUpError) {
    const msg = signUpError.message.toLowerCase()
    console.error('[signup] error status:', signUpError.status)

    // Same body as a brand-new signup. A distinct "already registered" response let
    // callers learn which emails already have an account.
    if (msg.includes('already registered') || msg.includes('already exists') || msg.includes('user already')) {
      return noStoreJson({ ok: true, requiresEmailVerification: true })
    }
    if (msg.includes('invalid email') || msg.includes('valid email') || msg.includes('email address')) {
      return noStoreJson(
        { error: 'invalid_email', message: 'Please enter a valid email address.' },
        400,
      )
    }
    if (msg.includes('rate limit') || msg.includes('too many')) {
      return noStoreJson(
        { error: 'rate_limited', message: 'Too many signup attempts. Please wait a moment and try again.' },
        429,
      )
    }
    return noStoreJson(
      { error: 'signup_unavailable', message: 'Unable to create account. Please try again.' },
      500,
    )
  }

  // Always the same success body. Do not return confirmation state or identity
  // lists — those differ for an existing account and were an enumeration oracle.
  return noStoreJson({ ok: true, requiresEmailVerification: true })
}
