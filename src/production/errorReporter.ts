// PRODUCTION HARDENING — errorReporter
//
// Purely additive error capture. No dependency on src/modules or src/pipeline, no provider calls.
// Every error passed through here is sanitized before being stored or logged — this module never
// stores or forwards a raw, unsanitized error object, and never fabricates a cause when one isn't
// known (classifyError falls back to 'unknown' rather than guessing).

import { logError } from './logger'

export type ErrorCategory = 'network' | 'timeout' | 'validation' | 'parsing' | 'unknown'

export type SanitizedError = {
  message: string
  stack: string | null
}

export type ReportedError = {
  stageName: string
  category: ErrorCategory
  error: SanitizedError
  reportedAt: string
}

const reportedErrors: ReportedError[] = []

// Redacts anything that looks like a secret/credential/token from an error's text before it is
// ever stored or logged (Architecture-wide rule: never log key values, only names/booleans).
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk)_[a-zA-Z0-9_-]{10,}\b/g, // common API-key-shaped tokens
  /\bBearer\s+[a-zA-Z0-9._-]{10,}\b/gi,
  /\b0x[a-fA-F0-9]{64}\b/g, // 32-byte hex values (private keys / raw secrets shaped like this)
  /\b(api[_-]?key|apikey|authorization|secret|token)\s*[:=]\s*['"]?[a-zA-Z0-9._-]{8,}['"]?/gi,
]

function redact(text: string): string {
  let redacted = text
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]')
  }
  return redacted
}

// PURE (aside from the redaction it performs). Never returns the original error object — only a
// plain, redacted { message, stack } pair, so nothing beyond text ever leaves this function.
export function sanitizeError(error: unknown): SanitizedError {
  if (error instanceof Error) {
    return {
      message: redact(error.message ?? 'unknown error'),
      stack: error.stack ? redact(error.stack) : null,
    }
  }
  if (typeof error === 'string') {
    return { message: redact(error), stack: null }
  }
  return { message: 'non-error value thrown', stack: null }
}

// PURE, best-effort categorization from message text. Never invents a specific cause it can't
// support from the text — anything that doesn't match a known pattern is 'unknown'.
export function classifyError(error: unknown): ErrorCategory {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const lower = message.toLowerCase()
  if (/timeout|timed out|aborted/.test(lower)) return 'timeout'
  if (/fetch failed|network|econnrefused|enotfound|dns/.test(lower)) return 'network'
  if (/invalid|must be|required|validation/.test(lower)) return 'validation'
  if (/json|parse|unexpected token|syntax/.test(lower)) return 'parsing'
  return 'unknown'
}

export function reportError(stageName: string, error: unknown): ReportedError {
  const sanitized = sanitizeError(error)
  const category = classifyError(error)
  const reported: ReportedError = { stageName, category, error: sanitized, reportedAt: new Date().toISOString() }
  reportedErrors.push(reported)
  logError(`[${stageName}] (${category}) ${sanitized.message}`)
  return reported
}

export type ErrorSummary = {
  totalErrors: number
  byStage: Record<string, number>
  byCategory: Record<ErrorCategory, number>
  recentErrors: ReportedError[]
}

export function buildErrorSummary(recentLimit = 20): ErrorSummary {
  const byStage: Record<string, number> = {}
  const byCategory: Record<ErrorCategory, number> = { network: 0, timeout: 0, validation: 0, parsing: 0, unknown: 0 }

  for (const entry of reportedErrors) {
    byStage[entry.stageName] = (byStage[entry.stageName] ?? 0) + 1
    byCategory[entry.category] += 1
  }

  return {
    totalErrors: reportedErrors.length,
    byStage,
    byCategory,
    recentErrors: reportedErrors.slice(-recentLimit),
  }
}

export function resetErrorReports(): void {
  reportedErrors.length = 0
}
