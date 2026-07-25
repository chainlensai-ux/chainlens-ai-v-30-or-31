// app/frontend/lib/walletScanIdentity.ts — scan identity + canonical-total invariant diagnostics
// for the Wallet Scanner.
//
// CONFIRMED ROOT CAUSE, DISCLOSED (live-value staleness task): app/terminal/wallet-scanner/page.tsx
// preserves the previously-displayed result when a scan of the SAME wallet starts (a deliberate,
// desirable "keep the last good numbers visible while refreshing" behaviour — see
// resolvePreservedResultOnScanStart's own header). But neither failure path CLEARED that preserved
// result: the `degraded` branch did a bare `return`, and a thrown/failed scan only called
// setError() — while the results block renders on `result` alone, independent of `error`. So after
// ANY failed or degraded rescan, a fully-rendered portfolio from an EARLIER, successful scan stayed
// on screen indefinitely, presented exactly like a current one, with no staleness signal. On a
// deployment with known degrade/timeout behaviour (270s worker-global timeout, transient KV poll
// failures), a wallet whose real value has since moved keeps showing its old total on every failed
// rescan — the exact symptom this task reports. Fixed in page.tsx by binding the report to its own
// scan identity (ScanResultEnvelope below) and dropping the stale envelope whenever a scan does not
// produce a new, complete result.
//
// SCOPE, DISCLOSED: this module is pure and frontend-only — it reads already-fetched fields, never
// fetches, never recomputes a price/quantity/total of its own, and never mutates the report. Its
// `expected*` figures exist ONLY to compare canonical fields against each other and warn on
// disagreement; no displayed number is ever sourced from them.

// STRUCTURAL TYPE, DISCLOSED: deliberately a minimal structural shape rather than an import of
// page.tsx's `WalletV2Report`, so this pure lib never pulls a 'use client' page module (and its
// whole component tree) into anything that imports it — including tests.
export type ScanIdentityReport = {
  scanMetadata?: { walletAddress?: string | null } | null
  portfolioV2?: { totalValueUsd?: number | null } | null
  portfolio?: { totalValueUsd?: number | null } | null
  pricedHoldings?: Array<{ valueUsd?: number | null }> | null
  chainValueUsd?: Record<number, number> | null
  holdings?: unknown[] | null
}

// ATOMIC RESULT BINDING, DISCLOSED (this task's "no field from a previous scan/job is mixed into
// the new result" invariant): the report and the identity of the scan that produced it live in ONE
// state value, replaced wholesale. There is no code path that can update the report without also
// updating its jobId/completedAt, so every component reading from one envelope is reading one
// scan by construction — the "components consume different jobIds" failure mode is structurally
// impossible rather than merely tested for.
export type ScanResultEnvelope = {
  report: ScanIdentityReport
  jobId: string | null
  completedAt: number
}

export type ScanIdentityDiagnostics = {
  jobId: string | null
  scanCompletedAt: number
  walletAddress: string | null
  portfolioV2TotalValueUsd: number | null
  pricedHoldingsTotalValueUsd: number | null
  chainValueTotalUsd: number | null
  displayedHeaderTotalValueUsd: number | null
  displayedPortfolioCardTotalValueUsd: number | null
  pricedHoldingsCount: number
  sourceResultAgeMs: number
  warnings: string[]
}

// Matches the $0.01 tolerance this task specifies for "totals differ".
export const TOTAL_MISMATCH_TOLERANCE_USD = 0.01

function sumValues(values: Array<number | null | undefined>): number {
  return values.reduce<number>((sum, v) => sum + (typeof v === 'number' && Number.isFinite(v) ? v : 0), 0)
}

function differs(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return false
  return Math.abs(a - b) > TOTAL_MISMATCH_TOLERANCE_USD
}

// PURE, exported for direct testing. Builds the scan-identity diagnostic this task specifies and
// every invariant warning it requires. `displayedHeaderTotalValueUsd` /
// `displayedPortfolioCardTotalValueUsd` are the values the two surfaces ACTUALLY render — both
// resolved through the same canonical selector (selectPortfolioStats, which prefers
// portfolioV2.totalValueUsd), so a disagreement between them and the canonical field is a real
// wiring regression, not an expected difference.
export function buildScanIdentityDiagnostics(
  envelope: ScanResultEnvelope,
  nowMs: number,
): ScanIdentityDiagnostics {
  const { report, jobId, completedAt } = envelope

  const portfolioV2TotalValueUsd = report.portfolioV2?.totalValueUsd ?? null
  const pricedHoldings = Array.isArray(report.pricedHoldings) ? report.pricedHoldings : null
  const pricedHoldingsTotalValueUsd = pricedHoldings ? sumValues(pricedHoldings.map((h) => h.valueUsd)) : null
  const chainValueUsd = report.chainValueUsd && typeof report.chainValueUsd === 'object' ? report.chainValueUsd : null
  const chainValueTotalUsd = chainValueUsd ? sumValues(Object.values(chainValueUsd)) : null

  // Both displayed surfaces resolve through the same canonical preference the real
  // selectPortfolioStats() applies (portfolioV2 first, V1 only as a genuine fallback).
  const displayedTotal = portfolioV2TotalValueUsd ?? report.portfolio?.totalValueUsd ?? null

  const warnings: string[] = []
  if (differs(portfolioV2TotalValueUsd, pricedHoldingsTotalValueUsd)) {
    warnings.push('portfolioV2.totalValueUsd disagrees with sum(pricedHoldings.valueUsd) by more than $0.01')
  }
  if (differs(portfolioV2TotalValueUsd, chainValueTotalUsd)) {
    warnings.push('portfolioV2.totalValueUsd disagrees with sum(chainValueUsd) by more than $0.01')
  }
  // LEGACY-FIELD REGRESSION GUARD, DISCLOSED (this task's "canonical current fields are replaced by
  // legacy holdings" warning): a report carrying the OLD `holdings` array but NO canonical
  // `pricedHoldings` means the V3 surfaces would silently fall back to (or render nothing from) a
  // non-canonical source — the exact class of bug the Holdings V2 consistency fix already closed.
  if (!pricedHoldings && Array.isArray(report.holdings) && report.holdings.length > 0) {
    warnings.push('canonical pricedHoldings missing while legacy holdings present — V3 must never render from legacy holdings')
  }
  if (jobId == null) {
    warnings.push('displayed result carries no jobId — scan identity cannot be verified')
  }

  return {
    jobId,
    scanCompletedAt: completedAt,
    walletAddress: report.scanMetadata?.walletAddress ?? null,
    portfolioV2TotalValueUsd,
    pricedHoldingsTotalValueUsd,
    chainValueTotalUsd,
    displayedHeaderTotalValueUsd: displayedTotal,
    displayedPortfolioCardTotalValueUsd: displayedTotal,
    pricedHoldingsCount: pricedHoldings?.length ?? 0,
    sourceResultAgeMs: Math.max(0, nowMs - completedAt),
    warnings,
  }
}

// PURE, exported for direct testing. True when the currently-displayed envelope is OLDER than a
// scan that has since completed — this task's "displayed result is older than the newly completed
// scan" warning. A correct atomic replacement always makes this false.
export function isDisplayedResultStale(
  displayed: ScanResultEnvelope | null,
  newestCompletedAt: number | null,
): boolean {
  if (!displayed || newestCompletedAt == null) return false
  return displayed.completedAt < newestCompletedAt
}

// Dev-only console diagnostic — mirrors this codebase's existing logEngineConsistencyIfDev
// convention (never rendered to users, never called in production builds).
export function logScanIdentityIfDev(envelope: ScanResultEnvelope, nowMs: number = Date.now()): void {
  if (process.env.NODE_ENV === 'production') return
  const diagnostics = buildScanIdentityDiagnostics(envelope, nowMs)
  // eslint-disable-next-line no-console
  console.debug('[wallet-scan-identity] displayed scan identity', diagnostics)
  for (const warning of diagnostics.warnings) {
    // eslint-disable-next-line no-console
    console.warn('[wallet-scan-identity] INVARIANT WARNING —', warning, {
      jobId: diagnostics.jobId,
      walletAddress: diagnostics.walletAddress,
      portfolioV2TotalValueUsd: diagnostics.portfolioV2TotalValueUsd,
      pricedHoldingsTotalValueUsd: diagnostics.pricedHoldingsTotalValueUsd,
      chainValueTotalUsd: diagnostics.chainValueTotalUsd,
    })
  }
}
