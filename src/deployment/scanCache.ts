// DEPLOYMENT LAYER — scanCache
//
// Short-lived in-memory de-dupe cache for runWalletScanV2() results, keyed by the sanitized
// request (walletAddress + sorted chains + scanMode). Exists solely so that the 9 per-module
// endpoints under /api/scan-v2/modules/* — which the frontend now calls in parallel for a single
// logical scan — reuse ONE computed scan instead of each triggering its own full
// runWalletScanV2() run. Does not change runWalletScanV2 logic, does not cache across distinct
// wallets/chains/scanModes, and expires quickly so results never go meaningfully stale.
//
// Best-effort only: this is a per-instance in-memory Map, not a shared/distributed cache. On
// Vercel that means de-dupe only helps when concurrent module requests land on the same warm
// instance — a reasonable, honest trade-off for a serverless deployment, not a correctness
// guarantee. Each module route still validates/rate-limits independently; this cache only saves
// re-running the (expensive, provider-calling) scan itself.

import type { RunWalletScanParams } from '../pipeline/types'
import { runWalletScanV2, type RunWalletScanV2Result } from '../pipeline/runWalletScanV2'

const SCAN_CACHE_TTL_MS = 30_000

type CacheEntry = {
  expiresAt: number
  promise: Promise<RunWalletScanV2Result>
}

const cache = new Map<string, CacheEntry>()

function cacheKey(params: RunWalletScanParams): string {
  const sortedChains = [...params.chains].sort()
  return `${params.walletAddress.toLowerCase()}|${sortedChains.join(',')}|${params.scanMode}`
}

// Returns a cached in-flight/completed scan for identical (walletAddress, chains, scanMode) if
// one was started within the last SCAN_CACHE_TTL_MS, otherwise starts a new one and caches it.
// A rejected scan is never cached — a failed request must not poison subsequent module fetches.
export function getOrRunWalletScanV2(params: RunWalletScanParams): Promise<RunWalletScanV2Result> {
  const key = cacheKey(params)
  const existing = cache.get(key)
  if (existing && existing.expiresAt > Date.now()) {
    return existing.promise
  }

  const promise = runWalletScanV2(params)
  cache.set(key, { expiresAt: Date.now() + SCAN_CACHE_TTL_MS, promise })
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key)
  })
  return promise
}

export function resetScanCache(): void {
  cache.clear()
}
