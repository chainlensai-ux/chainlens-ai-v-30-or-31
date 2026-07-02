// Shared (cross-instance) response cache for the Token Scanner's heavy scan path
// (app/api/token/route.ts POST). Built to fix the CU-usage audit's #1 finding: the previous
// in-memory Map()-based "cache" pattern used elsewhere in this codebase doesn't survive across
// Vercel's serverless instance fleet — each cold/parallel instance gets its own empty Map, so the
// real-world hit rate under concurrent traffic is far lower than the TTL implies. This uses Vercel
// KV (Redis-backed, shared across all instances) instead.
//
// Neither @vercel/kv, @upstash/redis, nor any Redis client was already installed anywhere in this
// codebase (verified via package.json + a full-repo grep before starting) — scaffolded @vercel/kv
// per this task's own fallback instruction ("if neither, scaffold KV").
//
// FAILS OPEN, ALWAYS: if KV_REST_API_URL/KV_REST_API_TOKEN aren't configured (e.g. this sandbox,
// or a deployment that hasn't provisioned a KV store yet) or a KV call errors/times out, both
// functions below resolve to "cache miss" / "no-op" rather than throwing — Token Scanner must keep
// working exactly as it did before this change when KV isn't available, never crash or hang on it.

import { kv } from '@vercel/kv'

const KV_CALL_TIMEOUT_MS = 2_000

function kvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('kv_timeout')), ms)),
  ])
}

// Returns the cached value, or null on a miss, misconfiguration, or any KV error — a caller never
// needs to distinguish these cases; all of them mean "run the real scan."
export async function getTokenCache<T = unknown>(key: string): Promise<T | null> {
  if (!kvConfigured()) {
    console.warn('KV DISABLED: missing env vars')
    return null
  }
  try {
    const value = await withTimeout(kv.get<T>(key), KV_CALL_TIMEOUT_MS)
    if (value == null) {
      console.log('KV MISS', key)
      return null
    }
    console.log('KV HIT', key)
    return value
  } catch (err) {
    console.error('KV ERROR', err)
    return null
  }
}

// Best-effort write — a failure here must never surface to the caller or affect the response
// already being returned to the client.
export async function setTokenCache<T = unknown>(key: string, value: T, ttlSeconds: number): Promise<void> {
  if (!kvConfigured()) {
    console.warn('KV DISABLED: missing env vars')
    return
  }
  try {
    await withTimeout(kv.set(key, value, { ex: ttlSeconds }), KV_CALL_TIMEOUT_MS)
  } catch (err) {
    console.error('KV ERROR', err)
  }
}
