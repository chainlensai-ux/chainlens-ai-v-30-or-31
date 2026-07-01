// PRODUCTION HARDENING — health
//
// Purely additive, read-only report inspection. This module only ever READS a FinalReport object
// already produced by runWalletScan()/finalReportAssembler — it imports their types for that
// purpose only, never their implementations, and never mutates the report it's given (every
// function here is a pure function of its input, returning a brand-new health object).

import type { FinalReport } from '../modules/finalReportAssembler/types'

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy'

export type ConfidenceHealth = {
  status: HealthStatus
  confidence: FinalReport['behaviorIntel']['confidence']
  reasons: string[]
}

export type IntegrityHealth = {
  status: HealthStatus
  reasons: string[]
}

export type FallbackHealth = {
  status: HealthStatus
  dustChainRatio: number
  recoverySkipped: boolean
  reasons: string[]
}

export type PipelineHealth = {
  status: HealthStatus
  reasons: string[]
}

export type HealthSummary = {
  pipeline: PipelineHealth
  confidence: ConfidenceHealth
  integrity: IntegrityHealth
  fallback: FallbackHealth
}

function worst(a: HealthStatus, b: HealthStatus): HealthStatus {
  const rank: Record<HealthStatus, number> = { healthy: 0, degraded: 1, unhealthy: 2 }
  return rank[a] >= rank[b] ? a : b
}

// PURE. Confidence health is read directly from behaviorIntel.confidence — never recomputed or
// second-guessed here; this module reports what the pipeline already concluded, it doesn't judge
// whether that conclusion was "good enough" beyond the confidence label itself.
export function computeConfidenceHealth(report: FinalReport): ConfidenceHealth {
  const confidence = report.behaviorIntel.confidence
  const reasons: string[] = [`behaviorIntel.confidence = ${confidence}`]
  const status: HealthStatus = confidence === 'high' ? 'healthy' : confidence === 'medium' ? 'degraded' : 'unhealthy'
  return { status, confidence, reasons }
}

// PURE. Verifies the same publicPnlStatus/integrityFlags consistency Architecture Step 6/9
// require — reported here as an observable health signal, never altered.
export function computeIntegrityHealth(report: FinalReport): IntegrityHealth {
  const { integrityFlags, publicPnlStatus } = report.fifoAndPnl
  const reasons: string[] = []
  let status: HealthStatus = 'healthy'

  if (integrityFlags.hardInvalid) {
    reasons.push('fifoAndPnl.integrityFlags.hardInvalid is true')
    status = 'unhealthy'
    if (publicPnlStatus !== 'unavailable') {
      reasons.push('INCONSISTENCY: hardInvalid=true but publicPnlStatus is not "unavailable"')
    }
  } else if (publicPnlStatus === 'limited_verified_sample') {
    reasons.push('publicPnlStatus is a limited verified sample')
    status = 'degraded'
  } else if (publicPnlStatus === 'unavailable') {
    reasons.push('publicPnlStatus is unavailable')
    status = 'degraded'
  } else {
    reasons.push('publicPnlStatus is ok')
  }

  if (integrityFlags.syntheticLotsExcluded > 0) {
    reasons.push(`INCONSISTENCY: syntheticLotsExcluded is ${integrityFlags.syntheticLotsExcluded}, expected 0 (fifoEngine must never fabricate a lot)`)
    status = 'unhealthy'
  }

  return { status, reasons }
}

// PURE. Surfaces how much of the scan relied on fallback behavior (dust-heavy chain coverage,
// skipped recovery) — informational, never a judgment about whether the fallback itself was wrong.
export function computeFallbackHealth(report: FinalReport): FallbackHealth {
  const { activeChainCount, dustChainCount } = report.chainSelection
  const totalChains = activeChainCount + dustChainCount
  const dustChainRatio = totalChains > 0 ? dustChainCount / totalChains : 0
  const recoverySkipped = report.recoveryPolicy.totalPagesUsedThisWallet === 0

  const reasons: string[] = [`${dustChainCount}/${totalChains} chains are dust_low_signal`]
  let status: HealthStatus = 'healthy'

  if (totalChains === 0) {
    reasons.push('no chains were scanned at all')
    status = 'unhealthy'
  } else if (dustChainRatio >= 0.5) {
    reasons.push('at least half of scanned chains are dust — coverage is thin')
    status = 'degraded'
  }

  if (recoverySkipped) reasons.push('no recovery pages were used this scan')

  return { status, dustChainRatio, recoverySkipped, reasons }
}

// PURE. Aggregates the three narrower health checks into one overall pipeline status — the worst
// individual status wins, so a report is never reported "healthy" overall while one dimension is
// unhealthy.
export function computePipelineHealth(report: FinalReport): PipelineHealth {
  const confidence = computeConfidenceHealth(report)
  const integrity = computeIntegrityHealth(report)
  const fallback = computeFallbackHealth(report)

  const status = worst(worst(confidence.status, integrity.status), fallback.status)
  const reasons = [...confidence.reasons, ...integrity.reasons, ...fallback.reasons]

  return { status, reasons }
}

export function buildHealthSummary(report: FinalReport): HealthSummary {
  return {
    pipeline: computePipelineHealth(report),
    confidence: computeConfidenceHealth(report),
    integrity: computeIntegrityHealth(report),
    fallback: computeFallbackHealth(report),
  }
}
