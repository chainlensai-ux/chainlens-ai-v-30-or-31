// POST /api/scan-v2 — the V2 engine route (holdings + portfolio + Step 5 report).
//
// This is a SEPARATE route from POST /api/scan (app/api/scan/route.ts, unchanged by this file).
// It calls runWalletScanV2() (src/pipeline/runWalletScanV2.ts) instead of runWalletScan(), and
// reuses the exact same validation, rate limiting, and error-handling building blocks /api/scan
// uses — src/deployment/validator.ts, rateLimiter.ts, api.ts — which are stateless, pure helpers,
// not the router itself, so reusing them here changes nothing about /api/scan's behavior.
//
// src/deployment/router.ts's handleScanRequest() is not reused directly because it is hard-wired
// to call runWalletScan() and sanitize a plain FinalReport — extending it to also support V2's
// holdings/portfolio fields would mean modifying that shared file, which /api/scan also depends
// on. Duplicating the thin routing logic here (rate-limit check -> validate -> call -> sanitize)
// keeps /api/scan completely untouched.

import { validateRequestShape, sanitizeInput } from '@/src/deployment/validator'
import { isRateLimited, recordRequest } from '@/src/deployment/rateLimiter'
import { sanitizeReport, maskSensitiveFields, handleApiError } from '@/src/deployment/api'
import { runWalletScanV2 } from '@/src/pipeline/runWalletScanV2'

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

    const report = await runWalletScanV2(validation.sanitized)
    const { holdings, portfolio, ...baseReport } = report
    const sanitizedBase = maskSensitiveFields(sanitizeReport(baseReport))

    return Response.json({ success: true, data: { ...sanitizedBase, holdings, portfolio } }, { status: 200 })
  } catch (err) {
    return Response.json(handleApiError(err), { status: 500 })
  }
}
