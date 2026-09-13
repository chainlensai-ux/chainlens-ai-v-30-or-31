// MODULE — verifiedSampleWinLoss
//
// SAMPLE WIN RATE, DISCLOSED: Profit Evidence previously computed
//   winRatePercent = wins / evaluated
// where `evaluated` was every canonical verified published lot, including quote/cash legs and
// other $0 realized-PnL lots. On a 98-lot verified sample that is 8 wins / 13 losses / 77 zeros,
// that is 8/98 ≈ 8% even though the displayed Wins/Losses are 8 and 13 (8/(8+13) ≈ 38%).
//
// INTENDED SEMANTICS: Sample Win Rate is wins / (wins + losses) over the same economic population
// the Wins/Losses tiles show — canonical verified lots with non-zero realized PnL. Zero-PnL and
// quote/cash $0 legs are counted in the audit, never silently used as the rate denominator.
// Displayed sample PnL, ROI membership, FIFO, pricing, and full-wallet gates are untouched.
//
// Fully Priced Trades remains the verified-lot count (every canonically priced closed lot). That
// is a sample-size fact, not the win-rate denominator.

import type { MatchedLot } from '../modules/fifoEngine/types'
import { isCanonicalVerifiedPublishedLot } from './canonicalVerifiedLot'

export const VERIFIED_SAMPLE_WINS_MEMBERSHIP = 'canonical_verified_lots_with_realized_pnl_gt_0'
export const VERIFIED_SAMPLE_LOSSES_MEMBERSHIP = 'canonical_verified_lots_with_realized_pnl_lt_0'
export const VERIFIED_SAMPLE_WIN_RATE_DENOMINATOR_MEMBERSHIP = 'canonical_verified_lots_with_nonzero_realized_pnl'

export type VerifiedSampleWinLoss = {
  wins: number
  losses: number
  evaluatedWinLossLots: number
  winRate: number | null
  verifiedLots: number
  zeroPnlCount: number
}

export type VerifiedSampleWinRateAudit = {
  verifiedLots: number
  winCount: number
  lossCount: number
  zeroPnlCount: number
  excludedQuoteCashCount: number
  unresolvedCount: number
  displayedWinRate: number | null
  denominatorUsed: number
  denominatorMembership: string
  winsMembership: string
  lossesMembership: string
}

export function computeVerifiedSampleWinLoss(
  lots: readonly Pick<MatchedLot, 'evidenceQuality' | 'costBasisUsd' | 'proceedsUsd' | 'realizedPnlUsd' | 'openedAt' | 'closedAt'>[],
): VerifiedSampleWinLoss {
  let verifiedLots = 0
  let wins = 0
  let losses = 0
  let zeroPnlCount = 0
  for (const lot of lots) {
    if (!isCanonicalVerifiedPublishedLot(lot)) continue
    verifiedLots += 1
    const pnl = lot.realizedPnlUsd as number
    if (pnl > 0) wins += 1
    else if (pnl < 0) losses += 1
    else zeroPnlCount += 1
  }
  const evaluatedWinLossLots = wins + losses
  return {
    wins,
    losses,
    evaluatedWinLossLots,
    winRate: evaluatedWinLossLots > 0 ? wins / evaluatedWinLossLots : null,
    verifiedLots,
    zeroPnlCount,
  }
}

export function buildVerifiedSampleWinRateAudit(params: {
  lots: readonly Pick<MatchedLot, 'evidenceQuality' | 'costBasisUsd' | 'proceedsUsd' | 'realizedPnlUsd' | 'openedAt' | 'closedAt'>[]
  excludedQuoteCashCount?: number
  unresolvedCount?: number
}): VerifiedSampleWinRateAudit {
  const wl = computeVerifiedSampleWinLoss(params.lots)
  return {
    verifiedLots: wl.verifiedLots,
    winCount: wl.wins,
    lossCount: wl.losses,
    zeroPnlCount: wl.zeroPnlCount,
    excludedQuoteCashCount: params.excludedQuoteCashCount ?? 0,
    unresolvedCount: params.unresolvedCount ?? 0,
    displayedWinRate: wl.winRate == null ? null : wl.winRate * 100,
    denominatorUsed: wl.evaluatedWinLossLots,
    denominatorMembership: VERIFIED_SAMPLE_WIN_RATE_DENOMINATOR_MEMBERSHIP,
    winsMembership: VERIFIED_SAMPLE_WINS_MEMBERSHIP,
    lossesMembership: VERIFIED_SAMPLE_LOSSES_MEMBERSHIP,
  }
}
