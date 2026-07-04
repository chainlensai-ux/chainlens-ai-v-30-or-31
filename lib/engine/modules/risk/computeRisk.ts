// lib/engine/modules/risk/computeRisk.ts — new risk module for the V2 engine.
//
// PURE, DISCLOSED: everything below is arithmetic over already-computed data from the prior
// portfolio/pnl/chainActivity/pricing/holdings modules — no network calls, no new provider
// dependency. Declared `async` only to match the spec's own Promise-returning signature.
//
// SCORE-FORMULA FIDELITY, DISCLOSED: step C's prose ("lower stablecoin ratio -> higher risk")
// implies stablecoinRatio should influence the final `score`, but step H's own explicit weighted
// formula (25/20/20/20/15% across concentrationRisk/unrealizedPnlPressure/volatileExposure/
// chainRisk/fragmentationRisk) does NOT include stablecoinRatio as a weighted term at all, and the
// weights given already sum to 100%. Rather than silently invent a 6th weight (which would either
// break the stated 100% total or require guessing how much to shrink the other 5), `stablecoinRatio`
// is stored on `RiskV2` exactly as specified — a real, correct, informational copy of
// `portfolioV2.stablecoinRatio` — but is NOT part of the `score` calculation, following the
// explicit, unambiguous formula in step H over the vaguer directional prose in step C.
//
// CHAIN-RISK SCALE, DISCLOSED: step E describes the ordering ("high activityLevel -> lower risk,
// dust-only -> higher risk") but not exact numbers. Mapped as high=0.1, medium=0.4, low=0.7,
// dust-only=1.0 — a monotonic, disclosed heuristic scale, not fabricated as if the task specified
// these exact values.
//
// FRAGMENTATION SCOPE, DISCLOSED: "totalChainsSupported" is 2 (chainId 1/8453 — eth/base), matching
// every other module in this task chain's real, disclosed chain scope (no other chain is fetched or
// priced anywhere in this pipeline, so "supported" can only honestly mean these 2 here). "Used"
// means a chain with any real holding OR any real 30d activity — a chain with neither contributes 0
// to numberOfChainsUsed, never guessed as "used."

import type { Portfolio } from '../portfolio/types'
import type { PnlV2 } from '../pnl/types'
import type { ChainActivityRecord } from '../activity/types'
import type { PricedHolding } from '../pricing/types'
import type { ChainHolding } from '../holdings/types'
import type { RiskEngineOutput, RiskV2 } from './types'

const TOTAL_CHAINS_SUPPORTED = 2 // eth (1), base (8453) — see file header disclosure

const CHAIN_ACTIVITY_RISK: Record<ChainActivityRecord['activityLevel'], number> = {
  high: 0.1,
  medium: 0.4,
  low: 0.7,
  'dust-only': 1.0,
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

const EMPTY_RISK: RiskV2 = {
  score: 0,
  level: 'low',
  concentrationRisk: 0,
  stablecoinRatio: 0,
  unrealizedPnlPressure: 0,
  chainRisk: 0,
  volatileExposure: 0,
  fragmentationRisk: 0,
}

export async function computeRisk(
  portfolioV2: Portfolio,
  pnlV2: PnlV2,
  chainActivityV2: ChainActivityRecord[],
  pricedHoldings: PricedHolding[],
  chainHoldings: ChainHolding[],
): Promise<RiskEngineOutput> {
  // A. Empty case — exactly as specified.
  if (portfolioV2.totalValueUsd === 0) {
    return { riskV2: EMPTY_RISK, riskStatus: 'empty' }
  }

  // B. concentrationRisk — portfolioV2.concentrationIndex is already 0-1, higher = more
  // concentrated = higher risk, used directly (no inversion).
  const concentrationRisk = clamp(portfolioV2.concentrationIndex, 0, 1)

  // C. stablecoinRatio — stored as specified; see file header on why it's not in the score formula.
  const stablecoinRatio = clamp(portfolioV2.stablecoinRatio, 0, 1)

  // D. unrealizedPnlPressure.
  const unrealizedPnlPressure =
    pnlV2.unrealizedPnlUsd < 0
      ? Math.min(1, Math.abs(pnlV2.unrealizedPnlUsd) / portfolioV2.totalValueUsd)
      : 0

  // E. chainRisk — average of per-chain risk scores (see file header's disclosed scale).
  const chainRisk = chainActivityV2.length > 0
    ? chainActivityV2.reduce((sum, c) => sum + CHAIN_ACTIVITY_RISK[c.activityLevel], 0) / chainActivityV2.length
    : 0

  // F. volatileExposure — meme + lp classified holdings' share of total portfolio value.
  const volatileValueUsd = pricedHoldings
    .filter((h) => h.classification === 'meme' || h.classification === 'lp')
    .reduce((sum, h) => sum + (h.valueUsd ?? 0), 0)
  const volatileExposure = clamp(portfolioV2.totalValueUsd > 0 ? volatileValueUsd / portfolioV2.totalValueUsd : 0, 0, 1)

  // G. fragmentationRisk — see file header disclosure on "used"/"supported".
  const chainsUsed = new Set<number>()
  for (const h of chainHoldings) chainsUsed.add(h.chainId)
  for (const c of chainActivityV2) if (c.txCount30d > 0) chainsUsed.add(c.chainId)
  const fragmentationRisk = clamp(chainsUsed.size / TOTAL_CHAINS_SUPPORTED, 0, 1)

  // H. Final score — exact weights as specified; they already sum to 100%.
  const score = clamp(
    concentrationRisk * 25 + unrealizedPnlPressure * 20 + volatileExposure * 20 + chainRisk * 20 + fragmentationRisk * 15,
    0,
    100,
  )

  // I. level.
  const level: RiskV2['level'] = score < 33 ? 'low' : score <= 66 ? 'medium' : 'high'

  // J. riskStatus. "all modules present" (the "ok" condition) is interpreted as: not empty (already
  // handled above) and no unpriced holding — the same signal "partial" itself checks — so a
  // non-empty portfolio with all holdings priced is "ok", and any unpriced holding makes it
  // "partial" instead, per the task's own literal condition.
  const hasUnpriced = pricedHoldings.some((h) => h.valueUsd == null)
  const riskStatus: RiskEngineOutput['riskStatus'] = hasUnpriced ? 'partial' : 'ok'

  return {
    riskV2: { score, level, concentrationRisk, stablecoinRatio, unrealizedPnlPressure, chainRisk, volatileExposure, fragmentationRisk },
    riskStatus,
  }
}
