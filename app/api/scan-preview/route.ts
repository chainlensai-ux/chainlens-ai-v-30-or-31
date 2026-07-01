// POST /api/scan-preview — PREVIEW-ONLY route for the V2 Scanner Preview.
//
// This is a SEPARATE route from the real, production-reachable POST /api/scan
// (app/api/scan/route.ts, unchanged by this file). It calls runWalletScanWithHoldings() — the
// preview-only extended orchestrator that adds holdings/portfolio data on top of the unmodified
// runWalletScan() — so production's /api/scan keeps returning exactly the Step 5 shape it always
// has, while this route is where holdings/portfolio value are actually available for testing.
//
// Reuses the deployment layer's request validation, rate limiting, and error/report sanitization
// (src/deployment/validator.ts, rateLimiter.ts, api.ts) rather than duplicating that logic —
// those modules are pure/stateless helpers, not the router itself, so reusing them here does not
// touch or affect the real /api/scan route's behavior in any way.

import { validateRequestShape, sanitizeInput } from '@/src/deployment/validator'
import { isRateLimited, recordRequest } from '@/src/deployment/rateLimiter'
import { sanitizeReport, maskSensitiveFields, handleApiError } from '@/src/deployment/api'
import { runWalletScanWithHoldings } from '@/src/pipeline/runWalletScanWithHoldings'

export async function POST(req: Request): Promise<Response> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'

  if (isRateLimited(ip)) {
    return Response.json(
      { success: false, error: { message: 'Rate limit exceeded. Please try again shortly.', category: 'rate_limited' } },
      { status: 429 },
    )
  }
  recordRequest(ip)

  try {
    const rawBody = await req.json().catch(() => null)
    const validation = validateRequestShape(sanitizeInput(rawBody))
    if (!validation.valid || !validation.sanitized) {
      return Response.json(
        { success: false, error: { message: 'Invalid request.', category: 'validation', details: validation.errors } },
        { status: 400 },
      )
    }

    const report = await runWalletScanWithHoldings(validation.sanitized)
    const { holdings, portfolio, ...baseReport } = report
    const sanitizedBase = maskSensitiveFields(sanitizeReport(baseReport))

    return Response.json({ success: true, data: { ...sanitizedBase, holdings, portfolio } }, { status: 200 })
  } catch (err) {
    return Response.json(handleApiError(err), { status: 500 })
  }
}
