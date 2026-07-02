// DEPLOYMENT LAYER — api
//
// Builds the outward-facing API response from a V2 engine report, and turns any thrown error into
// a safe, client-facing error payload. Never includes a stack trace, a raw provider event, or an
// env value in anything returned from this file.

import type { FinalReport } from '../modules/finalReportAssembler/types'
import type { RecoveryEvaluationEntry } from '../modules/recoveryPolicy/types'
import type { RunWalletScanV2Result } from '../pipeline/runWalletScanV2'
import { classifyError, sanitizeError } from '../production/errorReporter'

export type SanitizedRecoveryEvaluationEntry = Omit<RecoveryEvaluationEntry, 'recoveredEvents'> & {
  recoveredEventsCount: number
}

export type SanitizedReport = Omit<FinalReport, 'recoveryPolicy'> & {
  recoveryPolicy: Omit<FinalReport['recoveryPolicy'], 'evaluation'> & {
    evaluation: SanitizedRecoveryEvaluationEntry[]
  }
}

export type SanitizedReportV2 = SanitizedReport & Pick<RunWalletScanV2Result, 'holdings' | 'portfolio'>

// PURE. The only place recoveryPolicy.evaluation[].recoveredEvents (raw, provider-shaped
// transfer data) is touched — replaced with a count so the client never receives raw provider
// payloads, while still learning how much evidence recovery actually found for a token. Accepts
// either the plain Step 5 report or the V2-extended report (holdings/portfolio, when present,
// pass through untouched via the spread — this module never fabricates or drops them).
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

// Deliberately does NOT match the bare word "token" — this domain's report legitimately contains
// ERC20-token fields (e.g. recoveryPolicy.triggerRecoveryWhen.token_value_usd_gte,
// caps.maxHistoricalPagesPerToken) that must never be stripped. Only credential/session-shaped
// "*token" compounds are treated as sensitive.
const FORBIDDEN_KEY_PATTERN = /api[_-]?key|secret|password|private[_-]?key|stack|authorization|env(?:ironment)?vars?|(?:access|auth|bearer|session|refresh|api)[_-]?token/i

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
  data: SanitizedReportV2
}

// Builds the production /api/scan response — the V2 engine's holdings/portfolio fields are
// carried through sanitizeReport's object spread (they're just plain data, no raw provider
// payload among them) and explicitly re-typed here as SanitizedReportV2 so callers get accurate
// static types for them, not just an untyped passthrough.
export function buildApiResponse(report: RunWalletScanV2Result): ApiSuccessResponse {
  const sanitized = sanitizeReport(report) as SanitizedReportV2
  return { success: true, data: maskSensitiveFields(sanitized) }
}

// The 9 module keys this layer exposes, mapping each to its field on SanitizedReportV2. Splitting
// is purely a reshaping of the already-sanitized report — no field is recomputed, renamed, or
// dropped; each module is exactly `sanitized[field]`.
export const MODULE_FIELDS = {
  scanMetadata: 'scanMetadata',
  chainSelection: 'chainSelection',
  timelines: 'timelines',
  holdings: 'holdings',
  portfolio: 'portfolio',
  behaviorIntel: 'behaviorIntel',
  recoveryPolicy: 'recoveryPolicy',
  windowCoverage: 'windowCoverage',
  finalSummary: 'finalSummary',
  bridgeTimeline: 'bridgeTimeline',
  providerDiagnostics: 'providerDiagnostics',
} as const

export type ModuleKey = keyof typeof MODULE_FIELDS

export type ScanModules = {
  scanMetadata: SanitizedReportV2['scanMetadata']
  chainSelection: SanitizedReportV2['chainSelection']
  timelines: SanitizedReportV2['timelines']
  holdings: SanitizedReportV2['holdings']
  portfolio: SanitizedReportV2['portfolio']
  behaviorIntel: SanitizedReportV2['behaviorIntel']
  recoveryPolicy: SanitizedReportV2['recoveryPolicy']
  windowCoverage: SanitizedReportV2['windowCoverage']
  finalSummary: SanitizedReportV2['finalSummary']
  bridgeTimeline: SanitizedReportV2['bridgeTimeline']
  providerDiagnostics: SanitizedReportV2['providerDiagnostics']
}

// Splits an already-sanitized+masked V2 report into the 9 standalone modules. Pure reshaping —
// runWalletScanV2's output and sanitizeReport/maskSensitiveFields are both untouched by this.
export function buildModules(sanitized: SanitizedReportV2): ScanModules {
  return {
    scanMetadata: sanitized.scanMetadata,
    chainSelection: sanitized.chainSelection,
    timelines: sanitized.timelines,
    holdings: sanitized.holdings,
    portfolio: sanitized.portfolio,
    behaviorIntel: sanitized.behaviorIntel,
    recoveryPolicy: sanitized.recoveryPolicy,
    windowCoverage: sanitized.windowCoverage,
    finalSummary: sanitized.finalSummary,
    bridgeTimeline: sanitized.bridgeTimeline,
    providerDiagnostics: sanitized.providerDiagnostics,
  }
}

function sanitizeAndMask(report: RunWalletScanV2Result): SanitizedReportV2 {
  const sanitized = sanitizeReport(report) as SanitizedReportV2
  return maskSensitiveFields(sanitized)
}

export type ApiModulesResponse = {
  success: true
  modules: ScanModules
}

// Builds the /api/scan-v2 response as split modules instead of one flat report — same
// sanitize+mask pipeline as buildApiResponse, just reshaped at the end.
export function buildModulesResponse(report: RunWalletScanV2Result): ApiModulesResponse {
  return { success: true, modules: buildModules(sanitizeAndMask(report)) }
}

export type ApiModuleResponse = {
  success: true
  module: ModuleKey
  data: ScanModules[ModuleKey]
}

// Builds the response for a single-module endpoint (e.g. /api/scan-v2/modules/holdings).
export function buildSingleModuleResponse(report: RunWalletScanV2Result, moduleKey: ModuleKey): ApiModuleResponse {
  const modules = buildModules(sanitizeAndMask(report))
  return { success: true, module: moduleKey, data: modules[moduleKey] }
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
