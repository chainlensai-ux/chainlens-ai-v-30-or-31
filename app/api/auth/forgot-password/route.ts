import { NextRequest } from 'next/server'
import { createAnonSupabaseClient } from '@/lib/supabase/userSettings'
import { authRedirectUrl, normalizeAuthEmail, trustedAuthOrigin } from '@/lib/authFlow'
import { clientIpFromHeaders, createFixedWindowCounter } from '@/lib/authRateLimit'
import { noStoreJson } from '@/lib/authHttp'

const ipAttempts = createFixedWindowCounter(10, 15 * 60 * 1000)
const emailAttempts = createFixedWindowCounter(5, 15 * 60 * 1000)

const GENERIC_OK = {
  ok: true,
  message: 'If this email has an account, a reset link has been sent.',
}

export async function POST(request: NextRequest) {
  const length = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > 16_384) {
    return noStoreJson({ error: 'invalid_email', message: 'Please enter a valid email address.' }, 400)
  }

  const ip = clientIpFromHeaders(request.headers)
  if (ipAttempts.isBlocked(`forgot:${ip}`)) {
    return noStoreJson(
      { error: 'rate_limited', message: 'Too many reset attempts. Please wait and try again.' },
      429,
    )
  }
  ipAttempts.increment(`forgot:${ip}`)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return noStoreJson({ error: 'invalid_email', message: 'Please enter a valid email address.' }, 400)
  }

  const email = normalizeAuthEmail(
    body && typeof body === 'object' ? (body as { email?: unknown }).email : null,
    true,
  )
  if (!email) {
    return noStoreJson({ error: 'invalid_email', message: 'Please enter a valid email address.' }, 400)
  }

  if (emailAttempts.isBlocked(`forgot-email:${email}`)) {
    return noStoreJson(
      { error: 'rate_limited', message: 'Too many reset attempts. Please wait and try again.' },
      429,
    )
  }
  emailAttempts.increment(`forgot-email:${email}`)

  const origin = trustedAuthOrigin(request.nextUrl.host)
  if (!origin) {
    return noStoreJson(
      { error: 'reset_unavailable', message: 'Unable to send a reset link right now. Please wait a moment and try again.' },
      400,
    )
  }

  let redirectTo: string
  try {
    redirectTo = authRedirectUrl(origin, '/reset-password?type=recovery')
  } catch {
    return noStoreJson(
      { error: 'reset_unavailable', message: 'Unable to send a reset link right now. Please wait a moment and try again.' },
      400,
    )
  }

  const supabase = createAnonSupabaseClient()
  if (!supabase) {
    return noStoreJson(
      { error: 'reset_unavailable', message: 'Unable to send a reset link right now. Please wait a moment and try again.' },
      503,
    )
  }

  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
    if (error) {
      const msg = error.message.toLowerCase()
      if (msg.includes('rate limit') || msg.includes('too many') || msg.includes('once every')) {
        return noStoreJson(
          { error: 'rate_limited', message: 'Too many reset attempts. Please wait and try again.' },
          429,
        )
      }
      if (msg.includes('not found') || msg.includes('no user') || msg.includes('signups not allowed')) {
        return noStoreJson(GENERIC_OK)
      }
      console.error('[forgot-password] error status:', error.status)
      return noStoreJson(
        { error: 'reset_unavailable', message: 'Unable to send a reset link right now. Please wait a moment and try again.' },
        503,
      )
    }
  } catch {
    return noStoreJson(
      { error: 'reset_unavailable', message: 'Unable to send a reset link right now. Please wait a moment and try again.' },
      503,
    )
  }

  return noStoreJson(GENERIC_OK)
}
