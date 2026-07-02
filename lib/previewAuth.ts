// Shared contract for the preview-deployment password gate — used by both proxy.ts (read-only
// cookie check on every request) and app/preview-login (password validation + cookie set), kept
// in one place so the cookie name/value/options can never drift between the two call sites.

export const PREVIEW_AUTH_COOKIE_NAME = 'preview_auth'
export const PREVIEW_AUTH_COOKIE_VALUE = 'ok'

const PREVIEW_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180 // 180 days

// Never allows access when PREVIEW_PASSWORD isn't configured — an unset password must fail closed,
// not silently accept any input.
export function isPreviewPasswordCorrect(submittedPassword: string): boolean {
  const expected = process.env.PREVIEW_PASSWORD
  if (!expected) return false
  return submittedPassword === expected
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
