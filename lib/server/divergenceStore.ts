// lib/server/divergenceStore.ts — DIAGNOSTIC-ONLY persistence for engine-comparison divergence
// entries (see lib/server/engineComparison.ts). Purely additive storage: never reads from or
// influences any real pipeline output, PnL number, pricing number, or FIFO behavior. Not a
// cutover, not a unification — just a durable record of what lib/server/engineComparison.ts
// already logs, so divergence rate can be analyzed over time instead of only via ephemeral logs.
//
// STORAGE, DISCLOSED: reuses the real, existing lib/server/cache/redisClient.ts (@upstash/redis REST) rather than a new client — same reasoning as src/modules/scanJobs.ts. That client
// only exposes get/set (no native Redis list primitives like LPUSH/LTRIM), so the capped list
// below is a plain read-modify-write over a single JSON array value — not atomic under concurrent
// writes (two simultaneous divergence events could race and one could be dropped), which is an
// acceptable tradeoff for a best-effort diagnostic log, not a correctness-critical data store.
// Fails open (silently no-ops) exactly like every other real caller of this client, consistent
// with this whole system's established convention.
//
// SAMPLES, NOT FULL ARRAYS, DISCLOSED: per this task's own instruction, only small summaries are
// stored (a handful of scalar fields), never the full matchedLots/closedLots arrays — keeps each
// entry small and keeps no more wallet trade detail in this diagnostic store than the comparison
// log itself already prints.

import { redis } from '@/lib/server/cache/redisClient'

const MAX_ENTRIES = 200
const DIVERGENCE_LIST_KEY = 'v2:divergence:log'
const LIST_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days — a diagnostic log, not permanent storage

export type PricingDivergenceEntry = {
  type: 'pricing'
  timestamp: number
  walletAddress: string
  chain?: string
  legacySample: unknown
  newSample: unknown
}

export type FifoDivergenceEntry = {
  type: 'fifo'
  timestamp: number
  walletAddress: string
  fifoA: { realizedPnlUsd: number | null; closedLots: number | null }
  fifoB: { realizedPnlUsd: number | null; closedLots: number | null }
  fifoC: { realizedPnlUsd: number | null; unrealizedPnlUsd: number | null }
}

export type DivergenceEntry = PricingDivergenceEntry | FifoDivergenceEntry

async function appendCapped(entry: DivergenceEntry): Promise<void> {
  try {
    const existing = (await redis.get<DivergenceEntry[]>(DIVERGENCE_LIST_KEY)) ?? []
    const next = [...existing, entry].slice(-MAX_ENTRIES) // keep the most recent MAX_ENTRIES
    await redis.set(DIVERGENCE_LIST_KEY, next, { ex: LIST_TTL_SECONDS })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[divergenceStore] append failed', err instanceof Error ? err.message : String(err))
  }
}

// PRICING-LEVEL COMPARISON, SCOPE DISCLOSED: this function is complete and ready to use, but has
// no real call site yet — a true per-trade pricing sample would need
// src/pipeline/priceLotsForWallet.ts's raw price lookups exposed as a new field on
// src/pipeline/index.ts's output, which an earlier task in this same diagnostic-only effort
// explicitly forbade changing. Implemented here so it's ready the moment that data becomes
// available (e.g. once src/pipeline/index.ts's output shape question is revisited on its own),
// rather than left unbuilt.
export async function recordPricingDivergence(
  walletAddress: string,
  legacySample: unknown,
  newSample: unknown,
  chain?: string,
): Promise<void> {
  await appendCapped({ type: 'pricing', timestamp: Date.now(), walletAddress, chain, legacySample, newSample })
}

export async function recordFifoDivergence(
  walletAddress: string,
  fifoA: FifoDivergenceEntry['fifoA'],
  fifoB: FifoDivergenceEntry['fifoB'],
  fifoC: FifoDivergenceEntry['fifoC'],
): Promise<void> {
  await appendCapped({ type: 'fifo', timestamp: Date.now(), walletAddress, fifoA, fifoB, fifoC })
}

// Never throws — a read failure resolves to an empty list (same fail-open contract as every other
// real caller of the shared redis client).
export async function getDivergenceLog(): Promise<DivergenceEntry[]> {
  try {
    return (await redis.get<DivergenceEntry[]>(DIVERGENCE_LIST_KEY)) ?? []
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[divergenceStore] read failed', err instanceof Error ? err.message : String(err))
    return []
  }
}

// TEST-SUPPORT EXPORT, DISCLOSED: same pattern as this session's other test-support resets — lets
// a test start from a clean state. Not called anywhere in real request handling.
export async function __clearDivergenceLogForTest(): Promise<void> {
  await redis.set(DIVERGENCE_LIST_KEY, [], { ex: LIST_TTL_SECONDS })
}
