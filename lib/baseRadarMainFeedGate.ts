// MAIN-FEED-QUALITY-GATE, DISCLOSED (requested: stricter main-feed gate for Base Radar — $45K
// minimum valuation, 30 minimum holders, real holder evidence required, no dead-liquidity coins
// ranking as radar opportunities). Pulled into its own lib file — same pattern as this codebase's
// other Base Radar pure-logic modules (baseRadarValuation.ts, baseRadarSimulation.ts,
// baseRadarSignals.ts) — purely so these exact gate predicates can be unit tested directly
// (scripts/test-base-radar-main-feed-gate.mjs) without mocking GeckoTerminal/GoldRush/DexScreener
// HTTP calls. app/api/radar/route.ts imports and calls these; nothing here re-implements them.

export const MAIN_FEED_MIN_VALUATION_USD = 45_000
export const MAIN_FEED_MIN_HOLDERS = 30

/**
 * A candidate's resolved valuation (verified market cap, or FDV used as fallback — see
 * getRadarValuationBasis in baseRadarValuation.ts for that flattening) must be a finite number
 * at or above MAIN_FEED_MIN_VALUATION_USD. null/undefined/NaN (valuation unavailable) never passes.
 */
export function passesMainFeedValuationGate(valuationValueUsd: number | null | undefined): boolean {
  return typeof valuationValueUsd === 'number' && Number.isFinite(valuationValueUsd) && valuationValueUsd >= MAIN_FEED_MIN_VALUATION_USD
}

/**
 * Holder evidence must be a real resolved number at or above MAIN_FEED_MIN_HOLDERS. null/undefined/
 * NaN (open check / unavailable / unknown) must never count as passing — the caller is responsible
 * for treating "unresolved" and "resolved but below the floor" as distinct reasons (see
 * droppedByHoldersUnavailable vs droppedByHoldersBelow30 in app/api/radar/route.ts).
 */
export function passesMainFeedHolderGate(holderCount: number | null | undefined): boolean {
  return typeof holderCount === 'number' && Number.isFinite(holderCount) && holderCount >= MAIN_FEED_MIN_HOLDERS
}

/**
 * True when a candidate's valuation number came from a real marketCapUsd rather than being
 * FDV-derived. getRadarValuationBasis (baseRadarValuation.ts) flattens a real market cap and an
 * FDV fallback into a single "verified_market_cap" basis by explicit prior product decision (FDV
 * is shown as "Market Cap" everywhere with no distinct fallback label in the shared display) — that
 * shared behavior is intentionally left untouched. This function is used only to decide whether an
 * FDV-fallback evidence gap should be attached to a candidate, so an FDV-sourced valuation that
 * cleared the $45K gate is never indistinguishable, in that candidate's own evidence gaps, from a
 * real confirmed market cap.
 */
export function isRealVerifiedMarketCapValue(marketCapStatus: string | null | undefined, marketCapUsd: number | null | undefined): boolean {
  return marketCapStatus === 'verified' && typeof marketCapUsd === 'number' && Number.isFinite(marketCapUsd) && marketCapUsd > 0
}

// HOLDER-COUNT-VS-CONCENTRATION, DISCLOSED (requested: don't reject a candidate from the main feed
// just because top1/10/20 concentration is unavailable — the feed only ever fetches holder COUNT,
// never the full concentration breakdown, which needs a heavier per-holder-balance pull this route
// intentionally doesn't make). A candidate that clears passesMainFeedHolderGate is never hidden for
// missing concentration — this evidence-gap string is attached to every displayed candidate instead,
// so a passing holder count never looks identical to a token whose full concentration was checked.
export const CONCENTRATION_UNAVAILABLE_EVIDENCE_GAP = 'Concentration unavailable — deeper Token Scanner confirmation required'

// STARVATION FIX #2, DISCLOSED (reported: raising the old fixed holder-check limit from 20 to 30
// still left the feed starved to 1 token). A FIXED top-N cutoff is wrong no matter how big N is —
// candidates are ranked by a momentum score unrelated to valuation/holders, so on a day where most
// high-momentum Base pools happen to be low-holder tokens, the top N by momentum can legitimately
// contain almost no 30+-holder candidates even though plenty exist further down the ranked list.
// Replaced with a budget-driven loop (app/api/radar/route.ts): check ranked candidates in batches,
// in momentum order, until either DISPLAY_TARGET have actually passed the holder gate (no reason to
// keep spending provider calls once the feed has enough) or HOLDER_CHECK_BUDGET_CAP total checks
// have been made (a hard ceiling so a genuinely thin market can't turn into an unbounded/slow
// request). shouldContinueHolderChecking is the exact stopping condition the loop uses — exported so
// it's unit-testable directly instead of only inferable from route.ts's source.
export const DISPLAY_TARGET = 8
export const HOLDER_CHECK_BUDGET_CAP = 60
export const HOLDER_CHECK_BATCH_SIZE = 15

export interface HolderCheckLoopState {
  passingCount: number
  attemptedCount: number
  cursor: number
  poolSize: number
}

export function shouldContinueHolderChecking(state: HolderCheckLoopState): boolean {
  return state.passingCount < DISPLAY_TARGET && state.attemptedCount < HOLDER_CHECK_BUDGET_CAP && state.cursor < state.poolSize
}
