// PRODUCTION HARDENING — providerCallTracker
//
// Purely additive, opt-in call accounting. This module does NOT intercept real network calls
// inside providerFetchWindow/recoveryPolicy (doing so would require modifying those modules,
// which is explicitly forbidden). Instead, it is a manual instrumentation point: a caller wraps
// its own invocations of fetchProviderWindow / buildRecoveryPolicyObject with
// setCurrentStage(...) + incrementProviderCall(...), and assertNoUnexpectedCalls() then verifies
// every recorded call happened while an allowed stage was marked current.
//
// This adds NO provider calls of its own and changes NO pipeline behavior — it only observes
// calls the caller chooses to report to it.

const ALLOWED_STAGES = ['providerFetchWindow', 'recoveryPolicy'] as const
export type AllowedStage = (typeof ALLOWED_STAGES)[number]

export type ProviderCallRecord = { provider: string; chain: string; stage: string | null; recordedAt: string }

let currentStage: string | null = null
const callLog: ProviderCallRecord[] = []

// Marks which pipeline stage is currently executing, so subsequent incrementProviderCall() calls
// can be checked against it. Callers are responsible for clearing this (pass null) once a stage
// finishes — this module never guesses when a stage ends.
export function setCurrentStage(stageName: string | null): void {
  currentStage = stageName
}

export function incrementProviderCall(provider: string, chain: string): void {
  callLog.push({ provider, chain, stage: currentStage, recordedAt: new Date().toISOString() })
}

export function getProviderCallCounts(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const record of callLog) {
    const key = `${record.provider}:${record.chain}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

export type ProviderCallViolation = { provider: string; chain: string; stage: string | null; recordedAt: string }

export type NoUnexpectedCallsResult = {
  ok: boolean
  violations: ProviderCallViolation[]
}

// Verifies every recorded provider call happened while an allowed stage
// ("providerFetchWindow" or "recoveryPolicy") was marked current. A call recorded with
// stage=null, or any stage outside the allowed set, is a violation — never silently accepted.
export function assertNoUnexpectedCalls(): NoUnexpectedCallsResult {
  const violations = callLog.filter((record) => !record.stage || !ALLOWED_STAGES.includes(record.stage as AllowedStage))
  return { ok: violations.length === 0, violations }
}

export function resetProviderCallTracker(): void {
  currentStage = null
  callLog.length = 0
}
