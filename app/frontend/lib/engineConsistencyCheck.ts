// engineConsistencyCheck — READ-ONLY, DEV-ONLY internal debug helper. Never rendered to users.
//
// Compares real counts already present on WalletV2Report across three independent engines that
// each compute their own notion of "how many sells happened":
//   - fifoEngine.matchedLots / unmatchedSells   (src/modules/fifoEngine)
//   - pricingAtTimeEngine.proceedsUsd fan-out   (src/modules/pricingAtTimeEngine — keyed by txHash,
//     proceeds are only ever computed for SELL entries, so a non-null proceedsUsd entry count is a
//     real signal of "how many sells pricingAtTimeEngine actually priced")
//   - sellTimelineV2.totalSells                  (src/modules/sellTimeline)
//
// Purely a diagnostic: this module reads report fields, never writes them, and is not imported by
// any protected module. If it finds a mismatch that's clearly a UI-layer wiring bug (e.g. this file
// itself reading the wrong field), that's a bug in THIS file to fix. If the mismatch looks
// engine-level, it must NOT be "fixed" here — src/modules/** stays untouched; the mismatch is only
// ever logged for a human to investigate.
import type { FinalReport } from '@/src/modules/finalReportAssembler/types'

export type EngineConsistencyReport = {
  fifoMatchedLots: number
  fifoUnmatchedSells: number
  pricingAtTimeSellsPriced: number
  sellTimelineV2Total: number
  // true when the three counts disagree by more than what unmatched/unpriced sells alone explain —
  // a loose heuristic for a human to look at, not a pass/fail assertion.
  possibleMismatch: boolean
}

export function checkEngineConsistency(report: Pick<FinalReport, 'fifoAndPnl' | 'pricingAtTime' | 'timelines'>): EngineConsistencyReport {
  const fifoMatchedLots = report.fifoAndPnl?.matchedLots?.length ?? 0
  const fifoUnmatchedSells = report.fifoAndPnl?.unmatchedSells ?? 0
  const pricingAtTimeSellsPriced = Object.values(report.pricingAtTime?.proceedsUsd ?? {}).filter((v) => v != null).length
  const sellTimelineV2Total = report.timelines?.sellTimelineV2?.totalSells ?? 0

  const fifoTotalSells = fifoMatchedLots + fifoUnmatchedSells
  // sellTimelineV2 is a superset in principle (it reconstructs sells via multiple mechanisms fifoEngine
  // doesn't use) — a mismatch is only "possible" when sellTimelineV2 reports FEWER sells than fifoEngine,
  // which would mean fifoEngine saw sells sellTimelineV2 didn't.
  const possibleMismatch = sellTimelineV2Total < fifoTotalSells

  return { fifoMatchedLots, fifoUnmatchedSells, pricingAtTimeSellsPriced, sellTimelineV2Total, possibleMismatch }
}

// Dev-only console diagnostic — never called in production, never rendered to users.
export function logEngineConsistencyIfDev(report: Pick<FinalReport, 'fifoAndPnl' | 'pricingAtTime' | 'timelines'>): void {
  if (process.env.NODE_ENV === 'production') return
  const check = checkEngineConsistency(report)
  if (check.possibleMismatch) {
    // eslint-disable-next-line no-console
    console.debug('[engineConsistencyCheck] possible sell-count mismatch across engines', check)
  }
}
