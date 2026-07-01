// PRODUCTION HARDENING — metrics
//
// Purely additive, in-memory metrics collection. No dependency on src/modules or src/pipeline, no
// provider calls, no mutation of any pipeline output — this module only records numbers a caller
// chooses to report to it.

export type ExecutionTimeSample = { stageName: string; ms: number; recordedAt: string }
export type ProviderCallSample = { provider: string; chain: string; recordedAt: string }
export type RecoveryUsageSample = { token: string; pagesUsed: number; recordedAt: string }
export type FallbackSample = { sectionName: string; recordedAt: string }

export type MetricsSnapshot = {
  executionTimes: ExecutionTimeSample[]
  providerCalls: ProviderCallSample[]
  recoveryUsage: RecoveryUsageSample[]
  fallbacks: FallbackSample[]
  totals: {
    providerCallCount: number
    totalRecoveryPagesUsed: number
    fallbackCount: number
  }
}

const executionTimes: ExecutionTimeSample[] = []
const providerCalls: ProviderCallSample[] = []
const recoveryUsage: RecoveryUsageSample[] = []
const fallbacks: FallbackSample[] = []

function nowIso(): string {
  return new Date().toISOString()
}

export function recordExecutionTime(stageName: string, ms: number): void {
  executionTimes.push({ stageName, ms, recordedAt: nowIso() })
}

export function recordProviderCall(provider: string, chain: string): void {
  providerCalls.push({ provider, chain, recordedAt: nowIso() })
}

export function recordRecoveryUsage(token: string, pagesUsed: number): void {
  recoveryUsage.push({ token, pagesUsed, recordedAt: nowIso() })
}

export function recordFallback(sectionName: string): void {
  fallbacks.push({ sectionName, recordedAt: nowIso() })
}

// Returns an immutable-in-spirit snapshot (fresh arrays/objects) of everything recorded so far —
// never a live reference to the internal buffers, so a caller can never mutate collected metrics.
export function exportMetricsSnapshot(): MetricsSnapshot {
  return {
    executionTimes: [...executionTimes],
    providerCalls: [...providerCalls],
    recoveryUsage: [...recoveryUsage],
    fallbacks: [...fallbacks],
    totals: {
      providerCallCount: providerCalls.length,
      totalRecoveryPagesUsed: recoveryUsage.reduce((sum, r) => sum + r.pagesUsed, 0),
      fallbackCount: fallbacks.length,
    },
  }
}

// Additive reset helper — useful between independent test/scan runs so metrics don't accumulate
// unboundedly across an entire process lifetime. Not part of the literal spec but necessary for
// this module to be safely reusable across many scans.
export function resetMetrics(): void {
  executionTimes.length = 0
  providerCalls.length = 0
  recoveryUsage.length = 0
  fallbacks.length = 0
}
