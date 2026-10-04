// src/lib/txSideEventAllocation.ts — one transaction-side USD value, allocated ONCE across every
// target-token transfer event of that side.
//
// CONFIRMED ROOT CAUSE (same-tx outbound overcount audit): the at-trade-time dictionaries
// (`costUsd` / `proceedsUsd`) are keyed by txHash, and several writers store the WHOLE transaction-side
// value there — the receipt-quote lane (quote for the sum of every target transfer in the tx), the
// same-tx quote-leg lane, CoinPaprika corroboration (price × side target amount) and accepted evidence
// (the persisted side total). fifoEngine then treated that number as the USD value of EACH outbound
// (or inbound) event it looked up, and prorated it by `amountFromThisLot / thatEvent.amount`. A sell tx
// with a 900-token swap transfer and a 100-token fee transfer, quoted at $90, therefore produced
// fragments worth $90 + $90 = $180. The historical-market writer had the mirror bug: one entry per
// event, last write wins, so the side was valued at only ONE event's amount.
//
// Semantics fixed here, for every writer: a dictionary value is the USD value of the COMPLETE
// transaction side for one token — the sum of all of that token's transfer events in that direction
// in that tx (`sideQuantity`). This module allocates it across those events by exact quantity with
// integer largest-remainder arithmetic, so the event shares conserve back to the side value exactly;
// fifoEngine's own per-lot proration inside one event is unchanged. A side with one event is
// unchanged (its share is the whole value). Different tokens are never combined, and nothing is
// merged across directions.

import type { NormalizedEvent } from '../modules/normalization/types'
import type { MatchedLot, PriceUsdLookup } from '../modules/fifoEngine/types'
import { normalizedDedupeKey } from '../modules/fifoEngine/utils'

export type TxSideDirection = 'inbound' | 'outbound'

const VALUE_SCALE = BigInt(100_000_000) // 1e-8 USD, the same precision as the canonical manifest

export function txSideKey(chain: string, txHash: string, direction: TxSideDirection, token: string): string {
  return `${chain}:${txHash.toLowerCase()}:${direction === 'inbound' ? 'entry' : 'exit'}:${token.toLowerCase()}`
}

export function txSideKeyForEvent(event: Pick<NormalizedEvent, 'chain' | 'txHash' | 'direction' | 'contract'>): string | null {
  if (event.direction !== 'inbound' && event.direction !== 'outbound') return null
  return txSideKey(event.chain, event.txHash, event.direction, event.contract)
}

/** Side key for a matched lot's entry or exit (same key format as `txSideKeyForEvent`). */
export function txSideKeyForLot(lot: Pick<MatchedLot, 'chain' | 'token' | 'openedTxHash' | 'closedTxHash'>, side: 'entry' | 'exit'): string {
  return txSideKey(lot.chain, side === 'entry' ? lot.openedTxHash : lot.closedTxHash, side === 'entry' ? 'inbound' : 'outbound', lot.token)
}

export type TxSideGroup = { key: string; chain: string; txHash: string; direction: TxSideDirection; token: string; events: NormalizedEvent[]; quantity: number }

/** Every (chain, tx, direction, token) side among already-deduplicated FIFO events, in input order. */
export function groupTxSides(events: readonly NormalizedEvent[]): Map<string, TxSideGroup> {
  const groups = new Map<string, TxSideGroup>()
  for (const event of events) {
    const key = txSideKeyForEvent(event)
    if (!key) continue
    const group = groups.get(key)
    if (group) {
      group.events.push(event)
      group.quantity += event.amount
    } else {
      groups.set(key, { key, chain: event.chain, txHash: event.txHash, direction: event.direction as TxSideDirection, token: event.contract, events: [event], quantity: event.amount })
    }
  }
  return groups
}

/** Sides that carry MORE THAN ONE transfer event of the same token (the shape the old lookup overcounted). */
export function multiEventTxSideKeys(events: readonly NormalizedEvent[]): Set<string> {
  return new Set([...groupTxSides(events).values()].filter((g) => g.events.length > 1).map((g) => g.key))
}

function rawQuantities(events: readonly NormalizedEvent[]): bigint[] {
  const allRaw = events.every((e) => typeof e.amountRaw === 'string' && /^\d+$/.test(e.amountRaw))
  return events.map((e) => (allRaw ? BigInt(e.amountRaw as string) : BigInt(Math.round(e.amount * 1e9))))
}

/**
 * Exact allocation of `totalUsd` across `events` by quantity: floor every rational share at 1e-8 USD,
 * then hand the leftover units to the largest remainders (ties by a stable event key). The shares
 * always sum to the scaled total exactly; the order of `events` never changes the result.
 */
export function allocateTxSideValue(totalUsd: number, events: readonly NormalizedEvent[]): number[] {
  if (events.length === 0) return []
  if (events.length === 1) return [totalUsd]
  const quantities = rawQuantities(events)
  const totalQuantity = quantities.reduce((s, q) => s + q, BigInt(0))
  const totalScaled = BigInt(Math.round(totalUsd * Number(VALUE_SCALE)))
  if (totalQuantity <= BigInt(0)) return events.map(() => 0)
  const bases = quantities.map((q) => (totalScaled * q) / totalQuantity)
  const remainders = quantities.map((q, i) => totalScaled * q - bases[i] * totalQuantity)
  let leftover = totalScaled - bases.reduce((s, b) => s + b, BigInt(0))
  const tieKey = (i: number) => `${normalizedDedupeKey(events[i])}#${String(i).padStart(6, '0')}`
  const order = events.map((_, i) => i).sort((a, b) => (remainders[a] !== remainders[b] ? (remainders[b] > remainders[a] ? 1 : -1) : tieKey(a).localeCompare(tieKey(b))))
  const shares = [...bases]
  for (const i of order) {
    if (leftover <= BigInt(0)) break
    shares[i] += BigInt(1)
    leftover -= BigInt(1)
  }
  return shares.map((s) => Number(s) / Number(VALUE_SCALE))
}

export type TxSideAllocation = {
  /** Per-event allocated USD, by fifoEngine's own event dedupe key. */
  shareByEventKey: Map<string, number | null>
  groups: Map<string, TxSideGroup>
}

/**
 * Allocates each side's dictionary value (USD for the COMPLETE side quantity) across its events.
 * `costUsd`/`proceedsUsd` stay keyed by txHash exactly as every writer stores them.
 */
export function allocateTxSideValues(
  events: readonly NormalizedEvent[],
  costUsd: Record<string, number | null>,
  proceedsUsd: Record<string, number | null>,
): TxSideAllocation {
  const groups = groupTxSides(events)
  const shareByEventKey = new Map<string, number | null>()
  for (const group of groups.values()) {
    const dict = group.direction === 'inbound' ? costUsd : proceedsUsd
    const value = dict[group.txHash] ?? null
    if (value === null || !Number.isFinite(value)) {
      for (const e of group.events) shareByEventKey.set(normalizedDedupeKey(e), null)
      continue
    }
    const shares = allocateTxSideValue(value, group.events)
    group.events.forEach((e, i) => shareByEventKey.set(normalizedDedupeKey(e), shares[i]))
  }
  return { shareByEventKey, groups }
}

/** Identity of one tx side, for callers that know only the side (never a specific transfer event). */
export type TxSideIdentity = { chain?: string; txHash: string; direction: TxSideDirection; token?: string }

/**
 * Side-level lookup: the USD value of the COMPLETE side (what the writers stored), or null when that side
 * is not priced. For callers that only need "is this side priced, and at what side value" — e.g. the
 * display-pass dedupe — and must never fabricate a NormalizedEvent to call the event-level allocator.
 * The dictionaries are keyed by txHash (chain/token are accepted for identity but do not narrow the key).
 */
export type TxSideValueLookup = (side: TxSideIdentity) => number | null

export function buildTxSideValueLookup(costUsd: Record<string, number | null>, proceedsUsd: Record<string, number | null>): TxSideValueLookup {
  return (side) => {
    const value = (side.direction === 'inbound' ? costUsd : proceedsUsd)[side.txHash] ?? null
    return value !== null && Number.isFinite(value) ? value : null
  }
}

/**
 * The FIFO price lookup (requires a FULL NormalizedEvent — it allocates per transfer event): an event gets its allocated share of its side's value. An event FIFO sees
 * that was not in the allocated event set (it cannot double count): its quantity-proportional share
 * of the same side value when the side is known, else the side value itself (a lone event).
 */
export function buildTxSideEventPriceLookup(
  events: readonly NormalizedEvent[],
  costUsd: Record<string, number | null>,
  proceedsUsd: Record<string, number | null>,
): { lookup: PriceUsdLookup; allocation: TxSideAllocation } {
  const allocation = allocateTxSideValues(events, costUsd, proceedsUsd)
  const lookup: PriceUsdLookup = (event) => {
    if (event.direction !== 'inbound' && event.direction !== 'outbound') return null
    const key = normalizedDedupeKey(event)
    if (allocation.shareByEventKey.has(key)) return allocation.shareByEventKey.get(key) ?? null
    const value = (event.direction === 'inbound' ? costUsd : proceedsUsd)[event.txHash] ?? null
    if (value === null) return null
    const group = allocation.groups.get(txSideKeyForEvent(event)!)
    return group && group.quantity > 0 ? value * (event.amount / group.quantity) : value
  }
  return { lookup, allocation }
}

// ─── audit ──────────────────────────────────────────────────────────────────────────────────────────
export type SameTxMultiEventAuditRow = {
  txHash: string
  token: string
  side: 'entry' | 'exit'
  eventCount: number
  eventAmounts: number[]
  totalAmount: number
  txSideQuoteUsd: number | null
  quoteEvidenceKey: string
  fifoEventCount: number
  fragmentCount: number
  assignedPerEvent: Array<number | null>
  assignedPerFragment: Array<number | null>
  summedAssignedUsd: number | null
  /** summed fragments − the side value covering the matched quantity (0 when fully conserved). */
  conservationDeltaUsd: number | null
  /** What the pre-fix per-event lookup assigned to the same fragments (side value × events). */
  legacyAssignedUsd: number | null
  legacyOvercountUsd: number | null
}

/**
 * One row per side that carries more than one same-token transfer event, from the final FIFO lots.
 * The invariant is Σ fragments == side value × matched quantity / side quantity (== side value when the
 * whole side is matched), never side value × number of events.
 */
export function buildSameTxMultiEventAudit(params: {
  events: readonly NormalizedEvent[]
  matchedLots: readonly MatchedLot[]
  costUsd: Record<string, number | null>
  proceedsUsd: Record<string, number | null>
}): SameTxMultiEventAuditRow[] {
  const allocation = allocateTxSideValues(params.events, params.costUsd, params.proceedsUsd)
  const rows: SameTxMultiEventAuditRow[] = []
  for (const group of allocation.groups.values()) {
    if (group.events.length < 2) continue
    const side = group.direction === 'inbound' ? 'entry' as const : 'exit' as const
    const value = (group.direction === 'inbound' ? params.costUsd : params.proceedsUsd)[group.txHash] ?? null
    const fragments = params.matchedLots.filter((lot) => txSideKeyForLot(lot, side) === group.key)
    const assignedPerFragment = fragments.map((lot) => (side === 'entry' ? lot.costBasisUsd : lot.proceedsUsd))
    const summed = assignedPerFragment.some((v) => v === null) || fragments.length === 0 ? null : Math.round(assignedPerFragment.reduce((s, v) => s! + v!, 0)! * 1e8) / 1e8
    const matchedQuantity = fragments.reduce((s, lot) => s + lot.amount, 0)
    const expected = value === null || group.quantity <= 0 ? null : value * (matchedQuantity / group.quantity)
    // Legacy: every event valued at the WHOLE side value, prorated by that event's own amount.
    // Fragments do not record which event they came from; for an exit side every fragment drew from
    // the side's events in FIFO order, so the legacy total is value × (matched / eventAmount) summed
    // per event, which equals value × eventCount when the side is fully matched.
    const legacy = value === null ? null : (matchedQuantity >= group.quantity - 1e-9 ? value * group.events.length : null)
    rows.push({
      txHash: group.txHash, token: group.token, side,
      eventCount: group.events.length,
      eventAmounts: group.events.map((e) => e.amount),
      totalAmount: group.quantity,
      txSideQuoteUsd: value,
      quoteEvidenceKey: `v1:accepted-evidence:${group.chain}:${group.token.toLowerCase()}:${group.txHash}:${side}`,
      fifoEventCount: group.events.length,
      fragmentCount: fragments.length,
      assignedPerEvent: group.events.map((e) => allocation.shareByEventKey.get(normalizedDedupeKey(e)) ?? null),
      assignedPerFragment,
      summedAssignedUsd: summed,
      conservationDeltaUsd: summed === null || expected === null ? null : Math.round((summed - expected) * 1e8) / 1e8,
      legacyAssignedUsd: legacy,
      legacyOvercountUsd: legacy === null || value === null ? null : Math.round((legacy - value) * 1e8) / 1e8,
    })
  }
  return rows
}
