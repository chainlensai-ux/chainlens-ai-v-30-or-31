import type { MatchedLot } from '../modules/fifoEngine/types'
import type { BuildPnlSummaryParams } from '../modules/pnlEngine/types'
import type { SellTimelineEntry } from '../modules/sellTimeline/types'

type Totals = { amount: number; costUsd: number | null; proceedsUsd: number | null }

function baseSellKey(chain: string, token: string, txHash: string): string {
  return `${chain.toLowerCase()}|${token.toLowerCase()}|${txHash.toLowerCase()}|outbound`
}

function amountKey(baseKey: string, amount: string): string {
  return `${baseKey}|${amount}`
}

function addNullable(total: number | null, value: number | null): number | null {
  if (value == null) return total
  return (total ?? 0) + value
}

function approximatelyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-12, Math.max(Math.abs(a), Math.abs(b)) * 1e-9)
}

// PURE. Bridges FIFO fragment economics into pnlEngine's sell-entry read model without ever using
// txHash as a global identity. The base identity is chain + token + closing tx + outbound direction.
// Amount is added when more than one distinct sell entry shares that base identity. If the available
// FIFO fragments cannot unambiguously identify one of those entries, every row in that ambiguous
// group stays unpriced rather than receiving the same aggregate more than once.
export function buildFifoBackedPnlResolvers(
  matchedLots: MatchedLot[],
  sellEntries: SellTimelineEntry[] = [],
): {
  resolveCostUsdEstimate: NonNullable<BuildPnlSummaryParams['resolveCostUsdEstimate']>
  resolveProceedsUsdEstimate: NonNullable<BuildPnlSummaryParams['resolveProceedsUsdEstimate']>
} {
  const totalsByBaseKey = new Map<string, Totals>()
  for (const lot of matchedLots) {
    const key = baseSellKey(lot.chain, lot.token, lot.closedTxHash)
    const current = totalsByBaseKey.get(key) ?? { amount: 0, costUsd: null, proceedsUsd: null }
    current.amount += lot.amount
    current.costUsd = addNullable(current.costUsd, lot.costBasisUsd)
    current.proceedsUsd = addNullable(current.proceedsUsd, lot.proceedsUsd)
    totalsByBaseKey.set(key, current)
  }

  const distinctAmountsByBaseKey = new Map<string, Set<string>>()
  for (const sell of sellEntries) {
    const key = baseSellKey(sell.chain, sell.token, sell.txHash)
    const amounts = distinctAmountsByBaseKey.get(key) ?? new Set<string>()
    amounts.add(sell.amount)
    distinctAmountsByBaseKey.set(key, amounts)
  }

  const totalsBySellKey = new Map<string, Totals>()
  for (const [baseKey, totals] of totalsByBaseKey) {
    const amounts = [...(distinctAmountsByBaseKey.get(baseKey) ?? [])]
    if (amounts.length === 0) {
      // Backward-compatible pure-call path for callers that do not have sell entries. The resolver
      // still remains chain/token/tx/direction scoped and therefore cannot collide across tokens.
      totalsBySellKey.set(baseKey, totals)
      continue
    }
    if (amounts.length === 1) {
      totalsBySellKey.set(amountKey(baseKey, amounts[0]), totals)
      continue
    }

    // Multiple distinct sell amounts share the same chain/token/tx. MatchedLot does not retain a
    // counterparty/log index, so only an amount exactly matching the aggregate is unambiguous.
    const exactAggregateMatches = amounts.filter((amount) => {
      const parsed = Number(amount)
      return Number.isFinite(parsed) && approximatelyEqual(parsed, totals.amount)
    })
    if (exactAggregateMatches.length === 1) {
      totalsBySellKey.set(amountKey(baseKey, exactAggregateMatches[0]), totals)
    }
  }

  const resolve = (sell: SellTimelineEntry): Totals | null => {
    const baseKey = baseSellKey(sell.chain, sell.token, sell.txHash)
    return totalsBySellKey.get(amountKey(baseKey, sell.amount)) ?? totalsBySellKey.get(baseKey) ?? null
  }

  return {
    resolveCostUsdEstimate: (sell) => resolve(sell)?.costUsd ?? null,
    resolveProceedsUsdEstimate: (sell) => resolve(sell)?.proceedsUsd ?? null,
  }
}
