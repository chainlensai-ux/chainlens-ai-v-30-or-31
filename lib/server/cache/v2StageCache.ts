// Shared KV read-before/write-after wrapper for V2 engine hot paths (providerFetchWindow,
// recoveryPolicy, holdings, pricingAtTimeEngine's price sources).
//
// SCOPE NOTE, DISCLOSED: the literal request was to add KV caching "inside" those 4 modules
// (src/modules/providerFetchWindow, src/modules/recoveryPolicy, src/modules/holdings,
// src/modules/pricingAtTimeEngine). That was explicitly declined and reconfirmed with the user —
// it would mean editing V2 engine internals, contradicting the standing "do not modify V2 engine
// internals (src/pipeline, src/modules/*)" rule set one turn earlier in this same session, and
// these modules are pure, carefully tested (Architecture Step contract + a dedicated runtime test
// suite) — adding I/O inside them would change their signatures and risk breaking that contract.
// The user chose the alternative: cache each of these 4 stages from the PIPELINE orchestration
// layer instead (src/pipeline/index.ts, src/pipeline/runWalletScanV2.ts — the only two files this
// touches), wrapping each stage's existing call site with KV read-before/write-after. No module's
// own source file is modified anywhere in this change.
//
// Reuses lib/server/cache/tokenCache.ts's real, already-verified KV client rather than
// constructing a second one — same fail-open guarantee: no KV_REST_API_URL/TOKEN configured, or
// any KV error/timeout, means "treat as cache miss" / "skip the write", never a thrown error.

import { getTokenCache, setTokenCache } from './tokenCache'

// Reads cache, computes on a miss, writes cache only on a genuine success. Never caches an error:
// if `compute` throws, the cache is left untouched and the error propagates to the caller exactly
// as it did before this wrapper existed — every one of this pipeline's 4 wrapped call sites is
// already inside its own existing try/catch or fallback-safe wrapper (Architecture Step 7), so
// this preserves that behavior unchanged.
export async function withStageCache<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
  const cached = await getTokenCache<T>(key)
  if (cached !== null) return cached

  const result = await compute()
  await setTokenCache(key, result, ttlSeconds)
  return result
}
