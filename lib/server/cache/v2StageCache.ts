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

// BOUNDED, FAIL-OPEN TIMEOUT, DISCLOSED: this file's own header still means what it says — no
// retries, no circuit breaker, no chunking, no degraded-mode handling — but an UNBOUNDED await on
// a real network call (kv.get()/kv.set() have no built-in timeout) means a single slow/unreachable
// KV endpoint hangs every caller of withStageCache indefinitely, which — for
// `v2:providerFetchWindow:*` (called once per chain, per scan, at the very start of the pipeline,
// see src/pipeline/index.ts) — stalls the ENTIRE scan on a single stuck await until the outer
// 270s worker-global timeout fires. A single bounded timeout per call (matching this codebase's
// other KV-adjacent timeout of 300ms, e.g. src/lib/kvClient.ts's own default) preserves "always
// fail open, compute() is the only source of truth" while removing the possibility of an
// indefinite hang. This adds a ceiling, not new retry/backoff/breaker complexity.
const KV_CALL_TIMEOUT_MS = 300

function withKvTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('kv_timeout')), KV_CALL_TIMEOUT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Returns the cached value or null using a direct KV get. No retries, throttling, degraded-mode
// handling, budget checks, chunk reassembly, or fallback substitution are applied — only a bounded
// timeout (see withKvTimeout above) so a slow/unreachable KV endpoint can never hang the caller.
async function getStageCache<T>(key: string): Promise<T | null> {
  if (!kvConfigured()) return null
  try {
    const raw = await withKvTimeout(kv.get<unknown>(key))
    if (raw == null) return null
    return raw as T
  } catch {
    return null
  }
}

// Simple direct KV write. Every caller writes the complete payload to the single requested key.
// There is no chunking, throttling, budget enforcement, degraded mode, adaptive sizing,
// write-frequency reduction, partial write mode, or large-payload skipping — only a bounded
// timeout (see withKvTimeout above) so a slow/unreachable KV endpoint can never HANG the caller.
// Genuine KV set failures still propagate untouched (this function's own test,
// "propagates KV set failures without retrying", requires this) — its only caller
// (withStageCache's no-writer branch, below) already attaches its own `.catch()`.
async function setStageCache<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  if (!kvConfigured()) return
  await withKvTimeout(kv.set(key, value, { ex: ttlSeconds }))
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
    if (options.awaitWrite) {
      await writePromise
    } else {
      // UNHANDLED-REJECTION GUARD, DISCLOSED: `writer.write()` is intentionally left free to
      // propagate real KV failures when its caller awaits it (see this file's own writer tests —
      // "propagates KV set failures without retrying" — writer.write() itself must never swallow
      // errors). But when NOT awaited (the default here, e.g. holdings — see
      // src/pipeline/runWalletScanV2.ts), an unhandled `writePromise` rejection becomes a process-
      // level unhandled promise rejection, not just a lost cache write — this `.catch()` only
      // prevents that at the fire-and-forget call site; it does not change writer.write()'s own
      // throwing behavior for any caller that does await it.
      writePromise.catch(() => undefined)
    }
  } else {
    void setStageCache(key, result, effectiveTtl).catch(() => undefined)
  }
  return result
}
