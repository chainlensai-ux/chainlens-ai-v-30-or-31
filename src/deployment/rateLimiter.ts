// DEPLOYMENT LAYER — rateLimiter
//
// In-memory sliding-window rate limiter, keyed by caller IP. Purely additive request accounting —
// no dependency on any pipeline/module file, no provider calls.

import { loadEnv } from './env'

export type RateLimitConfig = { maxRequests: number; windowMs: number }

const requestLog = new Map<string, number[]>()

function defaultConfig(): RateLimitConfig {
  const env = loadEnv()
  return { maxRequests: env.RATE_LIMIT_MAX, windowMs: env.RATE_LIMIT_WINDOW_MS }
}

function pruneAndGet(ip: string, windowMs: number): number[] {
  const cutoff = Date.now() - windowMs
  const existing = requestLog.get(ip) ?? []
  const pruned = existing.filter((ts) => ts > cutoff)
  requestLog.set(ip, pruned)
  return pruned
}

// Records a request attempt for this IP. Callers should call this once per incoming request,
// regardless of whether it is ultimately rate-limited, so the sliding window stays accurate.
export function recordRequest(ip: string, config: RateLimitConfig = defaultConfig()): void {
  const pruned = pruneAndGet(ip, config.windowMs)
  pruned.push(Date.now())
  requestLog.set(ip, pruned)
}

// Read-only check — does NOT itself record a request. Callers decide their own
// check-then-record ordering (router.ts checks first, then records only if not limited).
export function isRateLimited(ip: string, config: RateLimitConfig = defaultConfig()): boolean {
  const pruned = pruneAndGet(ip, config.windowMs)
  return pruned.length >= config.maxRequests
}

export type RateLimitStatus = {
  limit: number
  windowMs: number
  count: number
  remaining: number
  limited: boolean
  resetInMs: number
}

export function getRateLimitStatus(ip: string, config: RateLimitConfig = defaultConfig()): RateLimitStatus {
  const pruned = pruneAndGet(ip, config.windowMs)
  const count = pruned.length
  const oldest = pruned[0]
  const resetInMs = oldest != null ? Math.max(0, config.windowMs - (Date.now() - oldest)) : 0

  return {
    limit: config.maxRequests,
    windowMs: config.windowMs,
    count,
    remaining: Math.max(0, config.maxRequests - count),
    limited: count >= config.maxRequests,
    resetInMs,
  }
}

export function resetRateLimiter(): void {
  requestLog.clear()
}
