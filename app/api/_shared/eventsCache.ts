// app/api/_shared/eventsCache.ts — request-scoped raw-provider-event cache, added to fix the real
// duplication finding from docs/CU_AUDIT.md (Finding #1): app/api/scan-v2/full-scan/route.ts calls
// both lib/engine/modules/pnl/computePnl.ts's fetchParsedTrades and lib/engine/modules/activity/
// computeChainActivity.ts's computeChainActivity for the same wallet+chains in the same request, and
// both independently reach the real fetchRawEventsForChain (app/api/_shared/
// walletChainPipeline.ts) per chain — roughly 2x the real GoldRush/Alchemy calls per request.
//
// DESIGN DEVIATION FROM THE LITERAL SPEC, DISCLOSED: the task asked for a single module-level
// `export const eventsCache = new Map()` cleared at the start of each request via
// `eventsCache.clear()`. That design has a real correctness bug in a serverless/Node context: a
// bare module-level singleton is shared by every concurrent invocation routed to the same warm
// instance — one request's `clear()` can wipe another CONCURRENT request's in-flight cache entries,
// silently corrupting or discarding real data across unrelated requests. This file instead exports
// a FACTORY (`createEventsCache()`) that returns a fresh cache object — the caller (the full-scan
// route) creates exactly one per request and threads it through as a plain parameter, so there is
// no shared mutable state between concurrent requests at all. This achieves the same real goal (one
// provider fetch per (wallet, chain) per request) without the concurrency risk of a shared,
// manually-cleared singleton.
//
// CACHED SHAPE, DISCLOSED: the task's own pseudocode assumed a `{trades, transfers, approvals,
// rawEvents}` value shape — no "approvals" concept exists anywhere in this pipeline (verified by
// search), and "trades"/"transfers" as separate pre-computed arrays don't correspond to any single
// real intermediate value either (pnl needs pricing-backed TradeEntry[], activity needs raw events
// AND non-priced TradeWithIntent[] — genuinely different downstream shapes). The actual real,
// single duplicated value is `RawProviderEvent[]` (from fetchRawEventsForChain) — that is what this
// cache stores; each consumer still runs its own downstream classification (normalizeTrades/
// classifyTradeIntent/pricing) over the SAME cached raw events instead of re-fetching them.

import type { RawProviderEvent, SupportedChain } from '@/src/modules/providerFetchWindow/types'

export type EventsCache = {
  get(chain: SupportedChain, walletAddress: string): RawProviderEvent[] | undefined
  set(chain: SupportedChain, walletAddress: string, events: RawProviderEvent[]): void
  hitCount: number
}

function cacheKey(chain: SupportedChain, walletAddress: string): string {
  return `${walletAddress.toLowerCase()}:${chain}`
}

// One call per request (e.g. in app/api/scan-v2/full-scan/route.ts) — never a shared module-level
// singleton, per this file's own "DESIGN DEVIATION" disclosure above.
export function createEventsCache(): EventsCache {
  const store = new Map<string, RawProviderEvent[]>()
  const cache: EventsCache = {
    hitCount: 0,
    get(chain, walletAddress) {
      const key = cacheKey(chain, walletAddress)
      const cached = store.get(key)
      if (cached) {
        cache.hitCount += 1
        // eslint-disable-next-line no-console
        console.debug('[CU-HARDENING] Using cached events for', key)
      }
      return cached
    },
    set(chain, walletAddress, events) {
      store.set(cacheKey(chain, walletAddress), events)
    },
  }
  return cache
}
