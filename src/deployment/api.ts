// DEPLOYMENT LAYER — api
//
// Builds the outward-facing API response from a FinalReport, and turns any thrown error into a
// safe, client-facing error payload. Never includes a stack trace, a raw provider event, or an
// env value in anything returned from this file.

import type { FinalReport } from '../modules/finalReportAssembler/types'
import type { RecoveryEvaluationEntry } from '../modules/recoveryPolicy/types'
import { classifyError, sanitizeError } from '../production/errorReporter'

export type SanitizedRecoveryEvaluationEntry = Omit<RecoveryEvaluationEntry, 'recoveredEvents'> & {
  recoveredEventsCount: number
}

export type SanitizedReport = Omit<FinalReport, 'recoveryPolicy'> & {
  recoveryPolicy: Omit<FinalReport['recoveryPolicy'], 'evaluation'> & {
    evaluation: SanitizedRecoveryEvaluationEntry[]
  }
}

// PURE. The only place recoveryPolicy.evaluation[].recoveredEvents (raw, provider-shaped
// transfer data) is touched — replaced with a count so the client never receives raw provider
// payloads, while still learning how much evidence recovery actually found for a token.
export function sanitizeReport(report: FinalReport): SanitizedReport {
  return {
    ...report,
    recoveryPolicy: {
      ...report.recoveryPolicy,
      evaluation: report.recoveryPolicy.evaluation.map((entry) => {
        const { recoveredEvents, ...rest } = entry
        return { ...rest, recoveredEventsCount: recoveredEvents.length }
      }),
    },
  }
}

const FORBIDDEN_KEY_PATTERN = /api[_-]?key|secret|token|password|private[_-]?key|stack|authorization|env(?:ironment)?vars?/i

// Recursively strips any object key matching a forbidden pattern. Defensive-in-depth: nothing in
// today's FinalReport shape is expected to match, but this guards against a future field
// accidentally leaking a credential-shaped value through this layer without anyone having to
// remember to update this file when that field is added.
function stripForbiddenKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripForbiddenKeysDeep(item)) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY_PATTERN.test(key)) continue
      result[key] = stripForbiddenKeysDeep(val)
    }
    return result as T
  }
  return value
}

export function maskSensitiveFields<T>(value: T): T {
  return stripForbiddenKeysDeep(value)
}

export type ApiSuccessResponse = {
  success: true
  data: SanitizedReport
}

export function buildApiResponse(report: FinalReport): ApiSuccessResponse {
  return { success: true, data: maskSensitiveFields(sanitizeReport(report)) }
}

export type ApiErrorResponse = {
  success: false
  error: {
    message: string
    category: string
  }
}

// Turns any thrown value into a safe, client-facing error payload. Deliberately drops the
// sanitized error's `stack` field entirely before it leaves this function — stack traces are for
// server-side logs (see production/errorReporter.reportError), never for an API response body.
export function handleApiError(error: unknown): ApiErrorResponse {
  const sanitized = sanitizeError(error)
  const category = classifyError(error)
  return { success: false, error: { message: sanitized.message, category } }
}
