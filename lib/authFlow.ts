import type { Session } from '@supabase/supabase-js'
import { isSafeInternalPath } from './safeNextPath'

type AuthErrorLike = { message: string } | null

export type AuthCallbackClient = {
  auth: {
    exchangeCodeForSession(code: string): Promise<{
      data: { session: Session | null } | null
      error: AuthErrorLike
    }>
    getSession(): Promise<{
      data: { session: Session | null }
      error: AuthErrorLike
    }>
  }
}

export type AuthCallbackResult = {
  session: Session | null
  error: string | null
  isRecovery: boolean
  flow: 'pkce' | 'implicit-or-existing'
}

function parameters(url: URL): URLSearchParams[] {
  return [url.searchParams, new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash)]
}

export function hasRecoveryIntent(href: string): boolean {
  const url = new URL(href)
  return parameters(url).some((params) => params.get('type') === 'recovery')
}

export function authCallbackError(href: string): string | null {
  const url = new URL(href)
  for (const params of parameters(url)) {
    const message = params.get('error_description') ?? params.get('error')
    if (message) return message.replace(/\+/g, ' ')
  }
  return null
}

// Supabase supports two callback shapes. PKCE returns ?code= and requires exchanging only that
// code. The configured browser client currently uses the implicit flow, where the SDK consumes
// the URL fragment during initialization and getSession() returns the resulting session.
export async function resolveSupabaseAuthCallback(
  client: AuthCallbackClient,
  href: string,
): Promise<AuthCallbackResult> {
  const url = new URL(href)
  const providerError = authCallbackError(href)
  const isRecovery = hasRecoveryIntent(href)
  if (providerError) {
    return { session: null, error: providerError, isRecovery, flow: 'implicit-or-existing' }
  }

  const code = url.searchParams.get('code')
  if (code) {
    const { data, error } = await client.auth.exchangeCodeForSession(code)
    return {
      session: data?.session ?? null,
      error: error?.message ?? (!data?.session ? 'No session was returned.' : null),
      isRecovery,
      flow: 'pkce',
    }
  }

  const { data, error } = await client.auth.getSession()
  return {
    session: data.session,
    error: error?.message ?? (!data.session ? 'No session was returned.' : null),
    isRecovery,
    flow: 'implicit-or-existing',
  }
}

export function authRedirectUrl(origin: string, path: string): string {
  if (!isSafeInternalPath(path)) throw new Error('Auth redirect path must be internal.')
  const base = new URL(origin)
  if ((base.protocol !== 'https:' && base.protocol !== 'http:') || base.username || base.password) {
    throw new Error('Auth redirect origin is invalid.')
  }
  return new URL(path, base.origin).toString()
}

export function initialAuthMode(pathname: string): 'signin' | 'signup' {
  return pathname === '/sign-up' ? 'signup' : 'signin'
}

/** Optimistic presence cookie for proxy.ts /terminal guard. Not a trust boundary. */
export const SIGNED_IN_PRESENCE_COOKIE = 'cl_signed_in'

export function setSignedInPresenceCookie(signedIn: boolean): void {
  if (typeof document === 'undefined') return
  try {
    if (signedIn) {
      document.cookie = `${SIGNED_IN_PRESENCE_COOKIE}=1; Max-Age=${60 * 60 * 24 * 30}; Path=/; SameSite=Lax`
    } else {
      document.cookie = `${SIGNED_IN_PRESENCE_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`
    }
  } catch {
    // ignore cookie write failures (privacy mode / SSR edge)
  }
}
