// POST /api/scan — the real, reachable Next.js route for the ChainLens 90-Day Intelligence
// Engine. Delegates entirely to src/deployment/router.ts's handleScanRequest(), which already
// performs rate limiting, request validation, and calls runWalletScan() — this file adds no
// additional logic of its own beyond translating between the Next.js Request/Response types and
// that framework-agnostic handler's { status, body } result.
//
// NOTE: this repo's Next.js App Router lives at the root app/ directory (no src/app override —
// confirmed via next.config.ts), so this route MUST live at app/api/scan/route.ts to be
// reachable. A route placed under src/app/api/scan/route.ts would never actually be served.

import { router } from '@/src/deployment/index'
import { handleApiError } from '@/src/deployment/api'

export async function POST(req: Request): Promise<Response> {
  try {
    const rawBody = await req.json().catch(() => null)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'

    const result = await router.handleScanRequest(rawBody, ip)

    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    // Last-resort guard only — handleScanRequest already catches and sanitizes errors from
    // runWalletScan internally. This only fires if something fails before/outside that (e.g. a
    // truly unexpected throw). Reuses the deployment layer's own sanitizer so this outer catch
    // can never leak a raw stack trace or error object, matching the same guarantee every other
    // path through this route already provides.
    return new Response(JSON.stringify(handleApiError(err)), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
