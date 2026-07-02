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
// Production is never affected: this only runs its check at all when VERCEL_ENV === 'preview'.
// Locally (VERCEL_ENV unset) and in production (VERCEL_ENV === 'production'), every request is
// passed through untouched.

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { PREVIEW_AUTH_COOKIE_NAME, PREVIEW_AUTH_COOKIE_VALUE } from '@/lib/previewAuth'

export function proxy(request: NextRequest) {
  if (process.env.VERCEL_ENV !== 'preview') {
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
