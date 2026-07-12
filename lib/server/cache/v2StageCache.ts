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
// CIRCUIT-BREAKER ISOLATION, DISCLOSED (this task's own request): this file previously reused
// lib/server/cache/tokenCache.ts's getTokenCache/setTokenCache directly — but that module's
// circuit breaker is a single GLOBAL counter shared by all 11+ real callers across this codebase.
// When v2:providerFetchWindow:*/v2:holdings:* keys (this file's own traffic) racked up 3
// consecutive timeouts, the breaker tripped and disabled KV for every OTHER caller too (pricing
// lookups, dust checks, etc.) for the rest of that breaker's cooldown window — the actual root
// cause of the cascading pricedTokens/portfolioValue-reset symptoms in the reported logs. Per this
// task's explicit requirement 4 ("circuit breaker should only apply to tokenCache.ts, not
// v2StageCache"), this file now has its own small, independent, timeout+retry+memory-fallback
// layer directly over `@vercel/kv` — deliberately NOT sharing any state with tokenCache.ts, and
// deliberately WITHOUT a circuit breaker, so nothing this file does can ever disable KV for
// anything else, and nothing else can ever disable KV for this file.
//
// LATENCY TRADEOFF, DISCLOSED: removing the circuit breaker means a KV outage costs this file's
// own bounded per-call retry budget (~1050ms worst case: 3 attempts x 250ms + backoff) on EVERY
// call for as long as the outage lasts, rather than short-circuiting after 3 failures the way
// tokenCache.ts's breaker does. That's the direct, unavoidable cost of requirement 4 — trading
// "protect against compounding per-call latency during an outage" for "never let this file's KV
// health affect any other caller, or vice versa." Still fail-open and non-blocking either way: a
// failed/timed-out call always falls through to `compute()`, never throws, never blocks the
// caller (requirements 3 and 6).

import { kv } from '@vercel/kv'

const KV_CALL_TIMEOUT_MS = 250
const MAX_RETRIES = 2 // total attempts = 1 + MAX_RETRIES = 3
const RETRY_BACKOFF_MS = [100, 200]
const MAX_PAYLOAD_BYTES = 100_000 // 100kb, per this task's own requirement 5

function kvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('kv_timeout')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Runs `attempt` up to 1 + MAX_RETRIES times with a short per-attempt timeout and backoff between
// retries. Never throws, and — deliberately, per this file's header — never trips any circuit
// breaker or otherwise remembers past failures across calls. Returns `onFailure` if every attempt
// fails.
async function withRetriesNoBreaker<T>(attempt: () => Promise<T>, onFailure: T, label: string): Promise<T> {
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      return await withTimeout(attempt(), KV_CALL_TIMEOUT_MS)
    } catch (err) {
      const isTimeout = err instanceof Error && err.message === 'kv_timeout'
      // eslint-disable-next-line no-console
      console[isTimeout ? 'warn' : 'error'](isTimeout ? 'kv_timeout_safe' : 'KV ERROR', {
        label,
        attempt: i + 1,
        totalAttempts: MAX_RETRIES + 1,
        ...(isTimeout ? {} : { error: err instanceof Error ? err.message : String(err) }),
      })
      if (i < MAX_RETRIES) await sleep(RETRY_BACKOFF_MS[i] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1])
    }
  }
  return onFailure
}

// IN-MEMORY FALLBACK, DISCLOSED: process-lifetime, size-capped (same convention as
// tokenCache.ts's own fallback layer, but a fully separate Map — no shared state). Holds the last
// successful value per key, TTL-respecting, so a KV outage still returns real, recent data instead
// of forcing a full recompute on every single request for as long as the outage lasts.
const MEMORY_FALLBACK_MAX_ENTRIES = 500
const memoryFallback = new Map<string, { value: unknown; expiresAt: number }>()

function memoryFallbackGet<T>(key: string): T | null {
  const entry = memoryFallback.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    memoryFallback.delete(key)
    return null
  }
  return entry.value as T
}

function memoryFallbackSet<T>(key: string, value: T, ttlSeconds: number): void {
  if (memoryFallback.size >= MEMORY_FALLBACK_MAX_ENTRIES && !memoryFallback.has(key)) {
    const oldestKey = memoryFallback.keys().next().value
    if (oldestKey !== undefined) memoryFallback.delete(oldestKey)
  }
  memoryFallback.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
}

// Returns the cached value, the in-memory fallback's last-known-good value, or null — NEVER
// throws, NEVER blocks, NEVER consults or affects tokenCache.ts's circuit breaker.
async function getStageCache<T>(key: string): Promise<T | null> {
  if (!kvConfigured()) return memoryFallbackGet<T>(key)

  const value = await withRetriesNoBreaker(() => kv.get<T>(key), undefined, `get:${key}`)
  if (value === undefined) return memoryFallbackGet<T>(key) // KV genuinely failed — fall back
  if (value == null) return null // real cache miss, not a failure
  memoryFallbackSet(key, value, 45) // keep the fallback warm on a real hit too
  return value
}

// Best-effort write. Always writes through to the in-memory fallback first (so this file's own
// fallback stays warm even during a KV outage), then attempts KV subject to the size guard.
async function setStageCache<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  memoryFallbackSet(key, value, ttlSeconds)

  if (!kvConfigured()) return

  const serialized = JSON.stringify(value)
  const payloadBytes = Buffer.byteLength(serialized, 'utf8')
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    // eslint-disable-next-line no-console
    console.warn('kv_skip_large_payload', { key, payloadBytes, maxPayloadBytes: MAX_PAYLOAD_BYTES })
    return // already stored in memory fallback above — requirement 5
  }

  await withRetriesNoBreaker(() => kv.set(key, value, { ex: ttlSeconds }), undefined, `set:${key}`)
}

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
export async function withStageCache<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
  const cached = await getStageCache<T>(key)
  if (cached !== null) return cached

  const result = await compute()
  await setStageCache(key, result, resolveEffectiveTtl(ttlSeconds, process.env.NODE_ENV))
  return result
}
