// MODULE 6 — fifoEngine: pure helper functions. No provider calls, no side effects, no mutation
// of any input array — every function here returns new arrays/objects.

import type { SupportedChain } from '../providerFetchWindow/types'
import type { NormalizedEvent } from '../normalization/types'

export function normalizedDedupeKey(event: NormalizedEvent): string {
  return `${event.txHash}|${event.contract.toLowerCase()}|${event.fromAddress.toLowerCase()}|${event.toAddress.toLowerCase()}|${event.amountRaw ?? event.amount}`
}

// PURE. Merges base + recovered normalized events, deduplicating any overlap (a recovered event
// that duplicates one already present in the base set is dropped in favor of the original —
// mirrors Architecture Step 4 §4 / Step 9 §1: recovery must never overwrite an existing event).
export function mergeNormalizedEvents(base: NormalizedEvent[], recovered: NormalizedEvent[]): NormalizedEvent[] {
  const seen = new Set(base.map(normalizedDedupeKey))
  const merged = [...base]
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
