// Shared validator for "?next=" style post-auth redirect targets (app/auth/page.tsx,
// app/auth/callback/page.tsx). A plain `path.startsWith('/')` check is NOT sufficient:
// "//evil.com" is protocol-relative, and control characters or backslashes are parsed
// as a different host by some URL parsers. The value comes from the query string.
const INTERNAL_ORIGIN = 'https://chainlens.invalid'

export function isSafeInternalPath(path: string | null | undefined): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 2048) return false
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return false
  if (/[\u0000-\u001F\u007F\\]/.test(path)) return false
  if (path.includes('://')) return false
  let resolved: URL
  try {
    resolved = new URL(path, INTERNAL_ORIGIN)
  } catch {
    return false
  }
  return resolved.origin === INTERNAL_ORIGIN
}
