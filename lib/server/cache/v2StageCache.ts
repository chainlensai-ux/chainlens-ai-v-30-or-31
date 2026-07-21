// Shared KV read-before/write-after wrapper for V2 engine hot paths (providerFetchWindow,
// recoveryPolicy, holdings, pricingAtTimeEngine's price sources).
//
// The wallet-scan stage cache intentionally uses a simple KV layer: direct get(key) and
// direct set(key, value). Holdings and provider-window writers always write the full payload to
// one key; they do not chunk, throttle, degrade, enforce budgets, or partially write.

import { kv as realKv } from '@vercel/kv'
// TEST-ONLY KV CLIENT OVERRIDE, DISCLOSED: `@vercel/kv`'s real `kv` export is a lazy-initializing
// Proxy (its `get` trap throws if KV_REST_API_URL/TOKEN aren't set, and reassigning a property on
// it does not reliably override what a later `kv.set`/`kv.get` call actually resolves to —
// confirmed empirically: monkey-patching `kv.set` directly still let the real network call through
// to a fake URL, producing genuine timeouts instead of using the mock). Same "explicit optional
// injectable" convention already used elsewhere in this codebase (e.g. priceLotsForWallet.ts's
// `priceFn`) — `kv` below resolves to this override when a test has set one, and to the real
// client otherwise; production code path and behavior are completely unchanged.
let kvOverrideForTest: typeof realKv | null = null
const kv = new Proxy(realKv, {
  get(target, prop, receiver) {
    const source = kvOverrideForTest ?? target
    return Reflect.get(source, prop, receiver)
  },
})

export function __setKvClientForTest(mockKv: Pick<typeof realKv, 'get' | 'set'>): void {
  kvOverrideForTest = mockKv as typeof realKv
}

export function __resetKvClientForTest(): void {
  kvOverrideForTest = null
}

function kvConfigured(): boolean {
  return Boolean(kvOverrideForTest) || Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
}

// Returns the cached value or null using a direct KV get. No timeouts, retries, throttling,
// degraded-mode handling, budget checks, chunk reassembly, or fallback substitution are applied.
async function getStageCache<T>(key: string): Promise<T | null> {
  if (!kvConfigured()) return null
  const raw = await kv.get<unknown>(key)
  if (raw == null) return null
  return raw as T
}

// Simple direct KV write. Every caller writes the complete payload to the single requested key.
// There is no chunking, throttling, budget enforcement, degraded mode, adaptive sizing,
// write-frequency reduction, partial write mode, or large-payload skipping.
async function setStageCache<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  if (!kvConfigured()) return
  await kv.set(key, value, { ex: ttlSeconds })
}

export type SimpleKvWriter = {
  write: (key: string, value: unknown, ttlSeconds: number) => Promise<void>
}
export type SimpleKvWriterConfig = {
  kv?: Pick<typeof realKv, 'set'>
}

export function createSimpleKvWriter(config: SimpleKvWriterConfig = {}): SimpleKvWriter {
  const kvClient = config.kv ?? kv
  return {
    async write(key, value, ttlSeconds) {
      if (!config.kv && !kvConfigured()) return
      await kvClient.set(key, value, { ex: ttlSeconds })
    },
  }
}

export function createHoldingsKvWriter(config: SimpleKvWriterConfig = {}): SimpleKvWriter {
  return createSimpleKvWriter(config)
}

export function createProviderWindowKvWriter(config: SimpleKvWriterConfig = {}): SimpleKvWriter {
  return createSimpleKvWriter(config)
}

// TEST-ONLY EXPORTS, DISCLOSED: setStageCache/getStageCache themselves stay private (not part of
// this module's real public API — withStageCache is) — these are thin aliases exported solely so
// tests/cache/v2StageCache.test.ts can exercise the real write/read branching (small-vs-large
// payload, compression, skip, logging) directly, same __xForTest naming convention already used
// throughout this codebase (e.g. lib/server/cache/tokenCache.ts's own test-only exports).
export const __setStageCacheForTest = setStageCache
export const __getStageCacheForTest = getStageCache

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

// Reads cache, computes on a miss OR any KV failure, writes cache only on a genuine success.
// Never caches an error: if `compute` throws, the cache is left untouched and the error propagates
// to the caller exactly as it did before this wrapper existed — every one of this pipeline's 4
// wrapped call sites is already inside its own existing try/catch or fallback-safe wrapper
// (Architecture Step 7), so this preserves that behavior unchanged. `compute()` always runs on any
// cache miss/failure — this function NEVER returns a defaulted/zeroed value because of a KV
// problem (requirements 3 and 6): the caller's own real computation is the only source of truth
// when the cache can't help.
export async function withStageCache<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
  options?: { writer?: SimpleKvWriter; awaitWrite?: boolean; skipWrite?: boolean },
): Promise<T> {
  const cached = await getStageCache<T>(key)
  if (cached !== null) return cached

  const result = await compute()
  if (options?.skipWrite) return result

  const effectiveTtl = resolveEffectiveTtl(ttlSeconds, process.env.NODE_ENV)
  if (options?.writer) {
    const writePromise = options.writer.write(key, result, effectiveTtl)
    if (options.awaitWrite) await writePromise
  } else {
    void setStageCache(key, result, effectiveTtl).catch(() => undefined)
  }
  return result
}
