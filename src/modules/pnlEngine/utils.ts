// MODULE — pnlEngine: pure helper functions.

import type { ChainBreakdownEntry, ClosedLot, PnlConfidenceBasis, WinLossRate } from './types'

export function evaluateWinLoss(closedLots: ClosedLot[]): WinLossRate {
  const complete = closedLots.filter((l) => l.evidence === 'complete')
  let wins = 0
  let losses = 0
  for (const lot of complete) {
    if (lot.proceedsUsdEstimate! > lot.costUsdEstimate!) wins += 1
    else if (lot.proceedsUsdEstimate! < lot.costUsdEstimate!) losses += 1
    // proceeds === cost is neither a win nor a loss — excluded from both counts, still "evaluated".
  }
  return { wins, losses, evaluated: complete.length, rate: complete.length > 0 ? wins / complete.length : null }
}

export function buildChainBreakdown(closedLots: ClosedLot[]): ChainBreakdownEntry[] {
  const byChain = new Map<string, ClosedLot[]>()
  for (const lot of closedLots) {
    const group = byChain.get(lot.chain) ?? []
    group.push(lot)
    byChain.set(lot.chain, group)
  }

  return [...byChain.entries()].map(([chain, lots]) => {
    const complete = lots.filter((l) => l.evidence === 'complete')
    return {
      chain: chain as ChainBreakdownEntry['chain'],
      closedLotCount: lots.length,
      realizedPnlUsd: complete.length > 0 ? complete.reduce((sum, l) => sum + l.realizedPnlUsd!, 0) : null,
    }
  })
}

export function buildConfidenceBasis(closedLots: ClosedLot[]): PnlConfidenceBasis {
  const counts = closedLots.reduce(
    (acc, l) => {
      acc[l.confidence] += 1
      return acc
    },
    { high: 0, medium: 0, low: 0 },
  )

  const total = closedLots.length
  let aggregate: PnlConfidenceBasis['aggregate']
  if (total === 0) aggregate = 'unavailable'
  else if (counts.high > total / 2) aggregate = 'high'
  else if (counts.low > total / 2) aggregate = 'low'
  else aggregate = 'medium'

  return { ...counts, aggregate }
}
