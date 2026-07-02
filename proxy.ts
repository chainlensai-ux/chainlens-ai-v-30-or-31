// Preview-only password gate.
//
// NAMED proxy.ts, NOT middleware.ts: verified against this repo's installed Next.js version
// (16.2.2, see node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md)
// — the `middleware.ts` file convention is deprecated as of v16.0.0 and renamed to `proxy.ts`
// (exporting a `proxy` function instead of `middleware`). A middleware.ts file would still be
// picked up per the deprecation notice, but this project's own AGENTS.md explicitly requires
// reading the real docs and heeding deprecation notices before writing code, so this uses the
// current, non-deprecated convention.
//
// Production is never affected by default: the VERCEL_ENV check alone runs this gate for every
// preview deployment, everywhere. Locally (VERCEL_ENV unset) and on production (VERCEL_ENV ===
// 'production'), every request is passed through untouched — UNLESS the hostname is explicitly
// listed in ALWAYS_GATED_HOSTNAMES below.
//
// ALWAYS_GATED_HOSTNAMES exists for one specific, deliberate case: chainlens-vthirty.vercel.app is
// Vercel's project-level *.vercel.app alias (no random preview hash), which can end up serving the
// currently-promoted deployment with VERCEL_ENV === 'production' even though it isn't this app's
// real public custom domain (www.chainlensai.app, see .env.example) — the user wants that specific
// URL to always require the password regardless of what Vercel calls its environment. The real
// custom domain is never in this list and stays fully ungated.
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { PREVIEW_AUTH_COOKIE_NAME, PREVIEW_AUTH_COOKIE_VALUE } from '@/lib/previewAuth'

const ALWAYS_GATED_HOSTNAMES = ['chainlens-vthirty.vercel.app']

export function proxy(request: NextRequest) {
  // request.nextUrl.hostname is unreliable for this check under `next start` (it can reflect the
  // bind address, e.g. localhost, rather than the Host header a reverse proxy/Vercel's edge
  // received) — verified live: a request with a real `Host: chainlens-vthirty.vercel.app` header
  // did not match via nextUrl.hostname but does via the raw Host header below. Vercel's own edge
  // always sets a real Host header, so this is the reliable source of truth in production too.
  const hostHeader = (request.headers.get('host') ?? '').split(':')[0].toLowerCase()
  const isPreviewDeployment = process.env.VERCEL_ENV === 'preview'
  const isAlwaysGatedHostname = ALWAYS_GATED_HOSTNAMES.includes(hostHeader)

  if (!isPreviewDeployment && !isAlwaysGatedHostname) {
    return NextResponse.next()
  }

  const authCookie = request.cookies.get(PREVIEW_AUTH_COOKIE_NAME)
  if (authCookie?.value === PREVIEW_AUTH_COOKIE_VALUE) {
    return NextResponse.next()
  }

  return NextResponse.redirect(new URL('/preview-login', request.url))
}

export const config = {
  matcher: [
    // Excludes: /api/* (never gated — this codebase's own API routes, including the wallet
    // scanner, must keep working the same way on preview as on production), /preview-login itself
    // (or every visit would redirect to itself), Next's internal static/image assets, and any
    // request for a file with an extension (favicon.ico, robots.txt, images, fonts, etc.).
    '/((?!api/|preview-login|_next/static|_next/image|.*\\..*).*)',
  ],
}
