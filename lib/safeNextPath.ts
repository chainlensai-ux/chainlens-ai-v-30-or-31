// Shared validator for "?next=" style post-auth redirect targets (app/auth/page.tsx,
// app/auth/callback/page.tsx). A plain `path.startsWith('/')` check — used at every one of these
// call sites before this fix — is NOT sufficient to keep a redirect internal: a value like
// "//evil.com" also starts with a single '/', but browsers resolve a leading "//" as a
// protocol-relative URL to a DIFFERENT HOST, not an internal path. Since this value is read
// directly from the URL's own "?next=" query parameter (fully attacker-controlled — an attacker
// only has to send a victim a link to this app's own real sign-in page with
// "?next=//attacker.example"), an unvalidated redirect here is a real open-redirect vector
// immediately after a genuine, successful login — the exact pattern phishing campaigns use to
// lend a malicious follow-up page the credibility of having "just come from" a real login.
//
// SECURITY AUDIT, DISCLOSED: found and fixed as part of a focused login/signup security review.
export function isSafeInternalPath(path: string | null | undefined): path is string {
  if (typeof path !== 'string' || path.length === 0) return false
  if (!path.startsWith('/')) return false
  // Reject "//host" (protocol-relative) and "/\host" (some browsers/URL parsers normalize a
  // leading backslash to a forward slash — the same bypass class, one character earlier).
  if (path.startsWith('//') || path.startsWith('/\\')) return false
  return true
}
