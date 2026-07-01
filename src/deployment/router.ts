// DEPLOYMENT LAYER — router
//
// Framework-agnostic handler for POST /scan. This file does not bind to any specific HTTP
// framework (no Next.js Request/Response types) — a real route handler (e.g. an
// app/api/.../route.ts, not part of this delivery) would call handleScanRequest() with the
// parsed body and caller IP, and translate its { status, body } result into that framework's
// response type. Keeping this framework-agnostic means this file has zero dependency on Next.js
// internals and stays trivially testable.

import { runWalletScan } from '../pipeline/index'
import { buildApiResponse, handleApiError } from './api'
import { isRateLimited, recordRequest } from './rateLimiter'
import { sanitizeInput, validateRequestShape } from './validator'

export type RouteResult = {
  status: number
  body: unknown
}

const RATE_LIMITED_RESPONSE: RouteResult = {
  status: 429,
  body: { success: false, error: { message: 'Rate limit exceeded. Please try again shortly.', category: 'rate_limited' } },
}

// POST /scan
//
// Steps, in order:
//   1. rate-limit check (before anything else touches the request — a limited caller is
//      rejected before validation or any pipeline work happens)
//   2. record the request against the rate limit window
//   3. sanitize + validate the request shape (never trusts any field beyond
//      walletAddress/chains/scanMode)
//   4. call runWalletScan() — the ONLY pipeline entry point this router calls
//   5. return a sanitized response (never a raw report, never an internal error)
export async function handleScanRequest(rawBody: unknown, callerIp: string): Promise<RouteResult> {
  if (isRateLimited(callerIp)) {
    return RATE_LIMITED_RESPONSE
  }
  recordRequest(callerIp)

  const sanitizedInput = sanitizeInput(rawBody)
  const validation = validateRequestShape(sanitizedInput)
  if (!validation.valid || !validation.sanitized) {
    return { status: 400, body: { success: false, error: { message: 'Invalid request.', category: 'validation', details: validation.errors } } }
  }

  try {
    const report = await runWalletScan(validation.sanitized)
    return { status: 200, body: buildApiResponse(report) }
  } catch (error) {
    return { status: 500, body: handleApiError(error) }
  }
}
