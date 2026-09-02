// Preview-only password gate + account-required /terminal guard.
//
// NAMED proxy.ts, NOT middleware.ts: verified against this repo's installed Next.js version
// (16.2.2, see node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md)
// — the `middleware.ts` file convention is deprecated as of v16.0.0 and renamed to `proxy.ts`
// (exporting a `proxy` function instead of `middleware`). A middleware.ts file would still be
// picked up per the deprecation notice, but this project's own AGENTS.md explicitly requires
// reading the real docs and heeding deprecation notices before writing code, so this uses the
// current, non-deprecated convention.
//
// ONE proxy.ts PER PROJECT, DISCLOSED (account-required task — confirmed live: this file already
// existed as a preview-deployment password gate before this task; Next.js supports only one
// proxy.ts, so the /terminal auth guard below is composed INTO this same function/matcher rather
// than replacing it — the preview gate's own behavior, hostnames, and exclusions are unchanged).
//
// PREVIEW GATE, UNCHANGED: production is never affected by default — the VERCEL_ENV check alone
// runs this gate for every preview deployment, everywhere. Locally (VERCEL_ENV unset) and on
// production (VERCEL_ENV === 'production'), every request skips straight to the /terminal check
// below — UNLESS the hostname is explicitly listed in ALWAYS_GATED_HOSTNAMES.
//
// ALWAYS_GATED_HOSTNAMES exists for one specific, deliberate case: chainlens-vthirty.vercel.app is
// Vercel's project-level *.vercel.app alias (no random preview hash), which can end up serving the
// currently-promoted deployment with VERCEL_ENV === 'production' even though it isn't this app's
// real public custom domain (www.chainlensai.app, see .env.example) — the user wants that specific
// URL to always require the password regardless of what Vercel calls its environment. The real
// custom domain is never in this list and stays fully ungated.
//
// ACCOUNT-REQUIRED /TERMINAL GUARD, DISCLOSED (account-required task — "Nobody should be able to
// use ChainLens without an account"): OPTIMISTIC CHECK, matching Next's own guidance ("Proxy can be
// helpful for optimistic checks such as permission-based redirects... should not be used as a full
// session management or authorization solution"). This app's Supabase session lives only in the
// browser's localStorage (lib/supabaseClient.ts — no cookie-syncing auth helper is wired up), so
// this proxy cannot read or verify the real session server-side. It reads a lightweight,
// non-sensitive PRESENCE cookie (`cl_signed_in`, set/cleared by lib/usePlan.tsx's shared account
// store the moment a real Supabase session is confirmed or cleared — see that file's own header)
// and redirects a /terminal request with no such cookie to /auth, preserving the original path via
// the SAME `?next=` param app/auth/page.tsx already reads to redirect back after a successful
// sign-in. REAL enforcement — the actual trust boundary — is server-side per-request bearer-token
// verification on every protected API route (see lib/server/requireAuth.ts), completely
// independent of this cookie's value.
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { PREVIEW_AUTH_COOKIE_NAME, PREVIEW_AUTH_COOKIE_VALUE } from '@/lib/previewAuth'

const ALWAYS_GATED_HOSTNAMES = ['chainlens-vthirty.vercel.app']
const SIGNED_IN_COOKIE = 'cl_signed_in'

export function proxy(request: NextRequest) {
  // request.nextUrl.hostname is unreliable for this check under `next start` (it can reflect the
  // bind address, e.g. localhost, rather than the Host header a reverse proxy/Vercel's edge
  // received) — verified live: a request with a real `Host: chainlens-vthirty.vercel.app` header
  // did not match via nextUrl.hostname but does via the raw Host header below. Vercel's own edge
  // always sets a real Host header, so this is the reliable source of truth in production too.
  const hostHeader = (request.headers.get('host') ?? '').split(':')[0].toLowerCase()
  const isPreviewDeployment = process.env.VERCEL_ENV === 'preview'
  const isAlwaysGatedHostname = ALWAYS_GATED_HOSTNAMES.includes(hostHeader)

  if (isPreviewDeployment || isAlwaysGatedHostname) {
    const authCookie = request.cookies.get(PREVIEW_AUTH_COOKIE_NAME)
    if (authCookie?.value !== PREVIEW_AUTH_COOKIE_VALUE) {
      return NextResponse.redirect(new URL('/preview-login', request.url))
    }
  }

  // /TERMINAL ACCOUNT GUARD, DISCLOSED: only applies to /terminal/* (this file's matcher below
  // covers far more than that for the preview gate above) — every other path just falls through to
  // NextResponse.next() exactly as before this task.
  if (request.nextUrl.pathname.startsWith('/terminal')) {
    const signedIn = request.cookies.get(SIGNED_IN_COOKIE)?.value === '1'
    if (!signedIn) {
      const redirectUrl = new URL('/auth', request.url)
      redirectUrl.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`)
      return NextResponse.redirect(redirectUrl)
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    // Explicitly excludes every route named in this gate's spec: /api/* (never gated — this
    // codebase's own API routes, including the wallet scanner, must keep working the same way on
    // preview as on production), /_next/static/*, /_next/image/*, /favicon.ico, and /preview-login
    // itself (or every visit would redirect to itself). The trailing `|.*\..*` is kept as
    // defense-in-depth beyond that explicit list — it excludes every OTHER request for a file with
    // an extension too (robots.txt, manifest.webmanifest, images, fonts, etc. under /public),
    // which the literal named list alone would leave gated and broken. /terminal/* is well within
    // this same matcher already, so no separate matcher entry is needed for the account guard.
    '/((?!api/|_next/static/|_next/image/|favicon\\.ico|preview-login|.*\\..*).*)',
  ],
}
