// MODULE 6 — fifoEngine: pure helper functions. No provider calls, no side effects, no mutation
// of any input array — every function here returns new arrays/objects.

import type { SupportedChain } from '../providerFetchWindow/types'
import type { NormalizedEvent } from '../normalization/types'

// DIRECTION INCLUDED, DISCLOSED (duplicate-economic-lot follow-up task — confirmed regression while
// fixing the confirmed duplicate-match production bug: extending this key's use to dedupe `base`
// against itself, not just `recovered` against `base`, exposed that the key never included
// `direction`. A genuine same-tx, same-contract, opposite-direction pair — a real "pass-through hop"
// where a token legitimately moves both in and out of the same address within one transaction, a
// pattern this codebase already handles carefully elsewhere for swap/quote legs — shares every OTHER
// field this key checks, and would have collided into a single event, silently discarding one real
// leg. `direction` is a genuine, independent identity field (this event is either the inbound or the
// outbound half of whatever happened at this address, never both), so including it here fixes both
// bugs at once: real duplicates (same txHash/contract/from/to/amountRaw/direction) are still caught,
// and legitimate opposite-direction same-tx legs are never collapsed.
export function normalizedDedupeKey(event: NormalizedEvent): string {
  return `${event.txHash}|${event.contract.toLowerCase()}|${event.fromAddress.toLowerCase()}|${event.toAddress.toLowerCase()}|${event.amountRaw ?? event.amount}|${event.direction}`
}

// PURE. Merges base + recovered normalized events, deduplicating any overlap (a recovered event
// that duplicates one already present in the base set is dropped in favor of the original —
// mirrors Architecture Step 4 §4 / Step 9 §1: recovery must never overwrite an existing event).
//
// INTERNAL BASE DEDUPE, DISCLOSED (duplicate-economic-lot follow-up task — confirmed production
// bug: publishedMatchedLots carried two structurally-identical matched lots — same token/openedAt/
// closedAt/openedTxHash/closedTxHash/amount/costBasisUsd/proceedsUsd/realizedPnlUsd — distinguished
// only by the occurrence-suffixed lotId this codebase's own prior fix added, e.g. base id and `#3`
// for the exact same match). Root cause traced to THIS function: `seen` was seeded from `base` but
// never used to filter `base` itself — only to filter `recovered` against `base`. Any duplicate
// ALREADY present within `base` (e.g. the exact same buy or sell event appearing twice from an
// upstream provider/promotion pass — receipt-swap canonical promotion, multi-provider event
// merging, etc.) survived untouched, reached `buildLots`/`matchLotsFIFO` as two distinct event
// objects, and produced two real, distinct-looking but economically identical matches. `base` is
// now deduped against itself the same way `recovered` already was against `base` — the exact same
// real transaction (same txHash/contract/from/to/amountRaw) is never counted twice, regardless of
// which array it originated from.
export function mergeNormalizedEvents(base: NormalizedEvent[], recovered: NormalizedEvent[]): NormalizedEvent[] {
  const seen = new Set<string>()
  const merged: NormalizedEvent[] = []
  for (const event of base) {
    const key = normalizedDedupeKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(event)
  }
  for (const event of recovered) {
    const key = normalizedDedupeKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(event)
  }
  return merged
}

export function tokenKey(token: string, chain: SupportedChain): string {
  return `${chain}:${token.toLowerCase()}`
}

export function buildLotId(chain: SupportedChain, token: string, txHash: string, timestamp: number): string {
  return `lot_${chain}_${token.toLowerCase()}_${timestamp}_${txHash.slice(0, 10)}`
}

export function groupByToken<T extends { token: string; chain: SupportedChain }>(items: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const item of items) {
    const key = tokenKey(item.token, item.chain)
    const list = grouped.get(key) ?? []
    list.push(item)
    grouped.set(key, list)
  }
  return grouped
}
