// lib/server/engineComparison.ts — DIAGNOSTIC-ONLY comparison between this codebase's real,
// currently-coexisting pricing/PnL/FIFO outputs. Zero behavior change: this module only reads
// already-computed values and logs when they disagree — it never influences which value the
// response actually returns, never calls any provider, and never throws out of the caller.
//
// WHAT'S BEING COMPARED, DISCLOSED (three real, already-existing outputs, not three newly-invoked
// engines — all three already run unconditionally on every scan today, so this adds zero new CU):
//   - fifoAndPnl (body.data.fifoAndPnl): the OLD pipeline's real output, from
//     src/modules/fifoEngine (via src/pipeline/index.ts's safeRunFifoEngine), priced by
//     src/pipeline/priceLotsForWallet.ts + src/modules/pricingAtTimeEngine.
//   - pnlSummaryV2 (body.data.pnlSummaryV2): a SEPARATE OLD-pipeline read-model, from
//     src/modules/pnlEngine's buildPnlSummary, over sellTimelineV2/buyTimeline entries.
//   - pnlV2 (from the NEW chain's computePnl, lib/engine/modules/pnl/computePnl.ts): its own
//     inline FIFO, priced by lib/engines/pricingAtTimeEngine.ts + lib/providers/goldrush.ts.
//
// "lotOpener/lotCloser" NOTE, DISCLOSED: lotOpener/lotCloser are not a fourth independently
// comparable PnL output — they're an internal step INSIDE the new chain's own trade-parsing
// (buildTradeTimelineForChain, consumed by computePnl before its own inline FIFO runs), not a
// separate source of a final realizedPnlUsd/closedLots number. There is no isolated "lotOpener/
// lotCloser PnL result" to compare against the other two; comparing pnlV2 (which already reflects
// lotOpener/lotCloser's output as an input) against the two OLD-pipeline outputs is the real,
// available three-way comparison.
//
// PRICING-LEVEL COMPARISON NOT INCLUDED HERE, DISCLOSED: a true per-trade pricing diff ("same
// priced timestamps, same USD value per trade") would need src/pipeline/priceLotsForWallet.ts's
// raw per-trade price lookups exposed as a new field on src/pipeline/index.ts's output — which
// this task's own rules explicitly forbid changing. The realizedPnlUsd/closedLots comparisons
// below are a real, if coarser, proxy: since all three systems consume the same underlying trade/
// timeline inputs and differ mainly in pricing source + FIFO matching, a material PnL divergence
// between them is generally downstream of either a pricing or a FIFO disagreement (or both).

export type FifoPricingComparisonInput = {
  walletAddress: string
  fifoAndPnl: { realizedPnlUsd: number | null; matchedLots?: unknown[]; unmatchedBuys?: number; unmatchedSells?: number } | null | undefined
  pnlSummaryV2: { realizedPnlUsd: number | null; closedLots?: unknown[] } | null | undefined
  pnlV2: { realizedPnlUsd: number; unrealizedPnlUsd: number } | null | undefined
}

// Only flag a real, meaningful divergence — not float-noise. $1 absolute difference (or either
// side being null/the other not) is the bar; tune based on real divergence data once collected.
const REALIZED_PNL_DIVERGENCE_THRESHOLD_USD = 1

function closedLotCount(value: { matchedLots?: unknown[]; closedLots?: unknown[] } | null | undefined): number | null {
  if (!value) return null
  if (Array.isArray(value.matchedLots)) return value.matchedLots.length
  if (Array.isArray(value.closedLots)) return value.closedLots.length
  return null
}

function realizedPnlDiverges(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return a !== b
  return Math.abs(a - b) > REALIZED_PNL_DIVERGENCE_THRESHOLD_USD
}

// Never throws. Purely observational — logs via console.warn only, returns nothing, changes
// nothing. Safe to call unconditionally (callers should still gate/sample per their own cost
// policy — see this repo's call site for the sampling applied there).
export function logFifoPricingDivergence(input: FifoPricingComparisonInput): void {
  try {
    const { walletAddress, fifoAndPnl, pnlSummaryV2, pnlV2 } = input

    const realizedA = fifoAndPnl?.realizedPnlUsd ?? null // old: fifoEngine
    const realizedB = pnlSummaryV2?.realizedPnlUsd ?? null // old: pnlEngine (separate read-model)
    const realizedC = pnlV2?.realizedPnlUsd ?? null // new: computePnl's own inline FIFO

    const diverges =
      realizedPnlDiverges(realizedA, realizedC) ||
      realizedPnlDiverges(realizedB, realizedC) ||
      realizedPnlDiverges(realizedA, realizedB)

    if (!diverges) return

    // eslint-disable-next-line no-console
    console.warn('[fifo-compare] divergence detected', {
      wallet: walletAddress,
      fifoA_fifoEngine: { realizedPnlUsd: realizedA, closedLots: closedLotCount(fifoAndPnl), unmatchedBuys: fifoAndPnl?.unmatchedBuys ?? null, unmatchedSells: fifoAndPnl?.unmatchedSells ?? null },
      fifoB_pnlEngine: { realizedPnlUsd: realizedB, closedLots: closedLotCount(pnlSummaryV2) },
      fifoC_computePnl: { realizedPnlUsd: realizedC, unrealizedPnlUsd: pnlV2?.unrealizedPnlUsd ?? null },
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[fifo-compare] comparison itself failed (never affects the real response)', err instanceof Error ? err.message : String(err))
  }
}

// Part 4 SCOPE/SAMPLING, DISCLOSED: 1-in-N random sampling (default N=5, matching the task's own
// example) to bound the added log volume — this is pure CPU/logging, not a provider call, so the
// "cost" being bounded here is log noise, not CU. Kept simple (Math.random) rather than a
// wallet-value threshold, since portfolio value isn't available at the point in the pipeline
// where this comparison runs without threading additional data through — a real refinement to
// consider once real divergence-rate data comes back from this pass.
export function shouldSampleThisScan(sampleOneInN = 5): boolean {
  return Math.floor(Math.random() * sampleOneInN) === 0
}
