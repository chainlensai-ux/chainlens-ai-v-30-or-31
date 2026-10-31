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

function nonEmpty(value: string | null): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

// `?type=recovery` by itself is only a hint. A real reset link also carries a one-time
// code, token hash, or implicit access token. Without that credential, an existing
// session must not be allowed to change the password.
export function hasRecoveryCredential(href: string): boolean {
  if (!hasRecoveryIntent(href)) return false
  const url = new URL(href)
  const hash = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash)
  return (
    nonEmpty(url.searchParams.get('code')) ||
    nonEmpty(url.searchParams.get('token_hash')) ||
    nonEmpty(hash.get('access_token')) ||
    nonEmpty(hash.get('token_hash'))
  )
}

export function accessTokenSubject(href: string): string | null {
  let token: string | null = null
  try {
    const url = new URL(href)
    const hash = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash)
    token = hash.get('access_token')
  } catch {
    return null
  }
  if (!token) return null
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const json = JSON.parse(atob(padded)) as { sub?: unknown }
    return typeof json.sub === 'string' && json.sub.length > 0 && json.sub.length < 128 ? json.sub : null
  } catch {
    return null
  }
}

const RECOVERY_FLAG = 'cl_password_recovery'
const RECOVERY_FLAG_MAX_AGE_MS = 15 * 60 * 1000

export function markPasswordRecovery(userId: string): void {
  if (typeof sessionStorage === 'undefined' || !userId) return
  try {
    sessionStorage.setItem(RECOVERY_FLAG, JSON.stringify({ userId, at: Date.now() }))
  } catch {
    // privacy mode
  }
}

export function readPasswordRecovery(): { userId: string } | null {
  if (typeof sessionStorage === 'undefined') return null
  let raw: string | null = null
  try { raw = sessionStorage.getItem(RECOVERY_FLAG) } catch { return null }
  // Legacy flag was the literal "1", which authorized whatever session happened to be signed in.
  if (!raw || raw === '1') {
    if (raw) clearPasswordRecovery()
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { userId?: unknown; at?: unknown }
    if (typeof parsed.userId !== 'string' || parsed.userId.length === 0 || parsed.userId.length > 128) return null
    if (typeof parsed.at !== 'number' || Date.now() - parsed.at > RECOVERY_FLAG_MAX_AGE_MS) {
      clearPasswordRecovery()
      return null
    }
    return { userId: parsed.userId }
  } catch {
    clearPasswordRecovery()
    return null
  }
}

export function clearPasswordRecovery(): void {
  if (typeof sessionStorage === 'undefined') return
  try { sessionStorage.removeItem(RECOVERY_FLAG) } catch { /* ignore */ }
}

const LOCAL_AUTH_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

export function isTrustedAuthHost(hostname: string, extraHosts: readonly string[] = []): boolean {
  const host = hostname.trim().toLowerCase()
  if (!host || host.length > 253) return false
  if (host === 'www.chainlensai.app' || host === 'chainlensai.app' || host === 'chainlens-vthirty.vercel.app') return true
  if (LOCAL_AUTH_HOSTS.has(host)) return true
  if (host.endsWith('.vercel.app') && host.includes('chainlens')) return true
  return extraHosts.some((extra) => extra.trim().toLowerCase() === host)
}

export function trustedAuthOrigin(hostHeader: string | null, extraHosts: readonly string[] = []): string | null {
  const host = (hostHeader ?? '').split(',')[0]?.trim().toLowerCase() ?? ''
  if (!host || /[\s/\\@]/.test(host)) return null
  const hostname = host.startsWith('[')
    ? host.slice(1, Math.max(host.indexOf(']'), 1))
    : host.split(':')[0]
  if (!hostname || !isTrustedAuthHost(hostname, extraHosts)) return null
  const local = LOCAL_AUTH_HOSTS.has(hostname)
  return `${local ? 'http' : 'https'}://${host}`
}

export function normalizeAuthEmail(email: unknown, strict = false): string | null {
  if (typeof email !== 'string') return null
  const clean = email.trim().toLowerCase()
  if (clean.length < 3 || clean.length > 254) return null
  if (/[\u0000-\u001F\u007F\s]/.test(clean)) return null
  const at = clean.indexOf('@')
  if (at <= 0 || at !== clean.lastIndexOf('@') || at === clean.length - 1) return null
  if (strict && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return null
  return clean
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
