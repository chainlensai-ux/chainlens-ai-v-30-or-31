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

// DEV-ONLY KV WARM MODE: extends the effective TTL to at least 10 minutes when NODE_ENV is not
// "production" — reduces repeat GoldRush/Alchemy CU burn while iteratively testing the same wallet
// locally or on a preview deployment. Production behavior is byte-for-byte unchanged: when
// NODE_ENV === "production" this always returns the caller's own ttlSeconds, untouched.
// Read behavior (the cache-hit path in withStageCache below) never changes either way — this only
// widens the window a value stays cached once written, it never fabricates a cache hit that
// wouldn't otherwise occur.
const DEV_WARM_TTL_SECONDS = 600 // 10 minutes

// Exported as a pure, isolated function specifically so this TTL-selection logic can be unit
// tested without needing to mock the real KV client.
export function resolveEffectiveTtl(ttlSeconds: number, nodeEnv: string | undefined): number {
  return nodeEnv !== 'production' ? Math.max(ttlSeconds, DEV_WARM_TTL_SECONDS) : ttlSeconds
}

// Reads cache, computes on a miss, writes cache only on a genuine success. Never caches an error:
// if `compute` throws, the cache is left untouched and the error propagates to the caller exactly
// as it did before this wrapper existed — every one of this pipeline's 4 wrapped call sites is
// already inside its own existing try/catch or fallback-safe wrapper (Architecture Step 7), so
// this preserves that behavior unchanged.
export async function withStageCache<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
  const cached = await getTokenCache<T>(key)
  if (cached !== null) return cached

  const result = await compute()
  await setTokenCache(key, result, resolveEffectiveTtl(ttlSeconds, process.env.NODE_ENV))
  return result
}
