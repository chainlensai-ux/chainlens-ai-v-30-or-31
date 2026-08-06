// DEPLOYMENT LAYER — router
//
// Framework-agnostic handler for POST /scan (app/api/scan/route.ts). This file does not bind to
// any specific HTTP framework (no Next.js Request/Response types) — a real route handler
// translates its { status, body } result into that framework's response type. Keeping this
// framework-agnostic means this file has zero dependency on Next.js internals and stays trivially
// testable.
//
// V2 MIGRATION: this now calls runWalletScanV2() (src/pipeline/runWalletScanV2.ts) instead of the
// plain runWalletScan() — production /api/scan now returns holdings + portfolio value alongside
// the unchanged Step 5 report fields, all through this single call site.

import { buildApiResponse, buildModulesResponse, buildSingleModuleResponse, handleApiError, type ModuleKey } from './api'
import { isRateLimited, recordRequest } from './rateLimiter'
import { getOrRunWalletScanV2 } from './scanCache'
import { sanitizeInput, validateRequestShape } from './validator'
import type { SanitizedScanRequest } from './validator'

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
//   4. call runWalletScanV2() — the ONLY pipeline entry point this router calls
//   5. return a sanitized response (never a raw report, never an internal error)
// Shared by handleScanRequest / handleModulesRequest / handleModuleRequest — rate-limits, records,
// sanitizes and validates the request the same way for every /scan-v2* entry point. Returns either
// a ready-made error RouteResult, or the validated request for the caller to act on.
//
// EXPORTED, DISCLOSED (Wallet Scanner fast-snapshot architecture-audit task, explicit requirement:
// "Do not duplicate auth/rate-limit/user validation unless extracted into a shared function"):
// this is the ONE place rate-limiting/sanitization/shape-validation happens for every /scan-v2*
// entry point — previously module-private, so a caller that needed the sanitized request BEFORE
// the rest of handleScanRequest ran (workers/walletScanV2.ts's own fast-snapshot preflight) had no
// way to reuse it without either duplicating this logic (double-counting isRateLimited/
// recordRequest — a real correctness bug, not just duplication) or calling handleScanRequest twice
// (same double-count). Exporting the EXACT same function, called exactly once per request, is the
// only safe way to share this step. Nothing about its own logic changed.
export function validateIncomingRequest(rawBody: unknown, callerIp: string): { errorResult: RouteResult } | { sanitized: SanitizedScanRequest } {
  if (isRateLimited(callerIp)) {
    return { errorResult: RATE_LIMITED_RESPONSE }
  }
  recordRequest(callerIp)

  const sanitizedInput = sanitizeInput(rawBody)
  const validation = validateRequestShape(sanitizedInput)
  if (!validation.valid || !validation.sanitized) {
    return { errorResult: { status: 400, body: { success: false, error: { message: 'Invalid request.', category: 'validation', details: validation.errors } } } }
  }
  return { sanitized: validation.sanitized }
}

// EXTRACTED, DISCLOSED (same task as validateIncomingRequest's own header): the "run the scan and
// build the response" half of handleScanRequest, taking an ALREADY-validated request. Exported so
// a caller that has already called validateIncomingRequest() itself (workers/walletScanV2.ts) can
// run the actual scan without re-validating/re-rate-limiting. handleScanRequest below is now a
// thin composition of validateIncomingRequest + this — its own external behavior (what status/body
// it returns for a given rawBody/callerIp) is completely unchanged.
export async function runValidatedScanRequest(sanitized: SanitizedScanRequest): Promise<RouteResult> {
  try {
    const report = await getOrRunWalletScanV2(sanitized)
    return { status: 200, body: buildApiResponse(report) }
  } catch (error) {
    return { status: 500, body: handleApiError(error) }
  }
}

export async function handleScanRequest(rawBody: unknown, callerIp: string): Promise<RouteResult> {
  const validated = validateIncomingRequest(rawBody, callerIp)
  if ('errorResult' in validated) return validated.errorResult
  return runValidatedScanRequest(validated.sanitized)
}

// POST /scan-v2 (all modules) — same scan as handleScanRequest, reshaped into { success, modules }.
export async function handleModulesRequest(rawBody: unknown, callerIp: string): Promise<RouteResult> {
  const validated = validateIncomingRequest(rawBody, callerIp)
  if ('errorResult' in validated) return validated.errorResult

  try {
    const report = await getOrRunWalletScanV2(validated.sanitized)
    return { status: 200, body: buildModulesResponse(report) }
  } catch (error) {
    return { status: 500, body: handleApiError(error) }
  }
}

// POST /scan-v2/modules/<moduleKey> — one module. Uses the same cached-or-computed scan as every
// other module request for the identical (walletAddress, chains, scanMode), so requesting all 9
// modules for one wallet triggers exactly one runWalletScanV2() run, not nine.
export async function handleModuleRequest(rawBody: unknown, callerIp: string, moduleKey: ModuleKey): Promise<RouteResult> {
  const validated = validateIncomingRequest(rawBody, callerIp)
  if ('errorResult' in validated) return validated.errorResult

  try {
    const report = await getOrRunWalletScanV2(validated.sanitized)
    return { status: 200, body: buildSingleModuleResponse(report, moduleKey) }
  } catch (error) {
    return { status: 500, body: handleApiError(error) }
  }
}
