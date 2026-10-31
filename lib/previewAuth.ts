// Shared contract for the preview-deployment password gate — used by both proxy.ts (read-only
// cookie check on every request) and app/preview-login (password validation + cookie set), kept
// in one place so the cookie name/value/options can never drift between the two call sites.
//
// Web Crypto only: proxy.ts runs on the edge, where node:crypto is not available.

export const PREVIEW_AUTH_COOKIE_NAME = 'preview_auth'

const PREVIEW_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180 // 180 days
const textEncoder = new TextEncoder()

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value))
  return new Uint8Array(digest)
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!
  return diff === 0
}

// Never allows access when PREVIEW_PASSWORD isn't configured — an unset password must fail closed,
// not silently accept any input. Compare hashes so a short guess does not return early on length.
export async function isPreviewPasswordCorrect(submittedPassword: string): Promise<boolean> {
  const expected = process.env.PREVIEW_PASSWORD
  if (!expected || typeof submittedPassword !== 'string' || submittedPassword.length === 0) return false
  if (submittedPassword.length > 1024) return false
  return timingSafeEqualBytes(await sha256(submittedPassword), await sha256(expected))
}

// HMAC of a fixed label, keyed by the preview password. The old cookie value was the literal
// "ok", so anyone who set preview_auth=ok skipped the password entirely.
export async function previewAuthCookieValue(): Promise<string | null> {
  const expected = process.env.PREVIEW_PASSWORD
  if (!expected) return null
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(expected),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode('chainlens-preview-gate-v1'))
  return bytesToBase64Url(new Uint8Array(signature))
}

export function previewAuthCookieMatches(got: string | undefined, expected: string | null): boolean {
  if (!got || !expected) return false
  return timingSafeEqualBytes(textEncoder.encode(got), textEncoder.encode(expected))
}

// Secure mirrors NODE_ENV here (not VERCEL_ENV) — this cookie is only ever set on a preview
// deployment's login page in practice (proxy.ts only redirects there when VERCEL_ENV === 'preview'),
// and Vercel preview builds run with NODE_ENV === 'production' the same as production builds, so
// this already correctly sets Secure on Vercel while staying non-Secure for local http:// dev.
export function previewAuthCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    maxAge: PREVIEW_AUTH_COOKIE_MAX_AGE_SECONDS,
    path: '/',
  }
}
