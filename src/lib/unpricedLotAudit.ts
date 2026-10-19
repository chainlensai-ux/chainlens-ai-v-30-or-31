// Unpriced lot audit: says why each closed FIFO lot that is not verified lacks a price.
//
// FIFO marks a lot verified only when both of its sides read a price from the guarded lookup. For
// every other lot this traces each missing side back through the lookup chain and names the first
// stage that left it empty:
//   no_matching_event — FIFO matched a tx the given events do not contain for that token/direction
//   no_price          — the pricing stage never priced the event
//   liquidity_guard   — priced, but read as a liquidity deposit/withdrawal leg
//   outlier_guard     — priced, but rejected as far from the token's other trades
// Diagnostic only: nothing here changes a lot or a price.

import type { MatchedLot, PriceUsdLookup } from '../modules/fifoEngine/types'
import type { NormalizedEvent } from '../modules/normalization/types'

export type UnpricedSideReason = 'no_matching_event' | 'no_price' | 'liquidity_guard' | 'outlier_guard' | 'priced'

export type UnpricedLotAudit = {
  closedLots: number
  verifiedLots: number
  unverifiedLots: number
  missingSides: { entryOnly: number; exitOnly: number; both: number }
  sideReasons: Record<UnpricedSideReason, number>
  byToken: { token: string; lots: number; entry: Partial<Record<UnpricedSideReason, number>>; exit: Partial<Record<UnpricedSideReason, number>> }[]
  samples: { lotId: string; token: string; entry: UnpricedSideReason | null; exit: UnpricedSideReason | null; openedTxHash: string; closedTxHash: string }[]
}

const TOP_TOKENS = 10
const SAMPLES = 8

export function buildUnpricedLotAudit(params: {
  lots: readonly MatchedLot[]
  events: readonly NormalizedEvent[]
  rawLookup: PriceUsdLookup
  liquidityGuardedLookup: PriceUsdLookup
  guardedLookup: PriceUsdLookup
}): UnpricedLotAudit {
  const byKey = new Map<string, NormalizedEvent[]>()
  for (const e of params.events) {
    const key = `${e.chain}:${e.txHash.toLowerCase()}:${e.contract.toLowerCase()}:${e.direction}`
    const list = byKey.get(key)
    if (list) list.push(e)
    else byKey.set(key, [e])
  }

  const sideReason = (lot: MatchedLot, side: 'entry' | 'exit'): UnpricedSideReason => {
    const txHash = side === 'entry' ? lot.openedTxHash : lot.closedTxHash
    const direction = side === 'entry' ? 'inbound' : 'outbound'
    const events = byKey.get(`${lot.chain}:${txHash.toLowerCase()}:${lot.token.toLowerCase()}:${direction}`) ?? []
    if (events.length === 0) return 'no_matching_event'
    for (const e of events) {
      if (params.guardedLookup(e) != null) continue
      if (params.rawLookup(e) == null) return 'no_price'
      if (params.liquidityGuardedLookup(e) == null) return 'liquidity_guard'
      return 'outlier_guard'
    }
    return 'priced'
  }

  const sideReasons: Record<UnpricedSideReason, number> = { no_matching_event: 0, no_price: 0, liquidity_guard: 0, outlier_guard: 0, priced: 0 }
  const missingSides = { entryOnly: 0, exitOnly: 0, both: 0 }
  const tokens = new Map<string, UnpricedLotAudit['byToken'][number]>()
  const samples: UnpricedLotAudit['samples'] = []
  let unverified = 0

  for (const lot of params.lots) {
    if (lot.evidenceQuality === 'verified') continue
    unverified += 1
    const entry = lot.costBasisUsd == null ? sideReason(lot, 'entry') : null
    const exit = lot.proceedsUsd == null ? sideReason(lot, 'exit') : null
    if (entry && exit) missingSides.both += 1
    else if (entry) missingSides.entryOnly += 1
    else if (exit) missingSides.exitOnly += 1
    const tokenKey = `${lot.chain}:${lot.token.toLowerCase()}`
    const row = tokens.get(tokenKey) ?? { token: tokenKey, lots: 0, entry: {}, exit: {} }
    row.lots += 1
    if (entry) { sideReasons[entry] += 1; row.entry[entry] = (row.entry[entry] ?? 0) + 1 }
    if (exit) { sideReasons[exit] += 1; row.exit[exit] = (row.exit[exit] ?? 0) + 1 }
    tokens.set(tokenKey, row)
    if (samples.length < SAMPLES) samples.push({ lotId: lot.lotId, token: tokenKey, entry, exit, openedTxHash: lot.openedTxHash, closedTxHash: lot.closedTxHash })
  }

  return {
    closedLots: params.lots.length,
    verifiedLots: params.lots.length - unverified,
    unverifiedLots: unverified,
    missingSides,
    sideReasons,
    byToken: [...tokens.values()].sort((a, b) => b.lots - a.lots).slice(0, TOP_TOKENS),
    samples,
  }
}
