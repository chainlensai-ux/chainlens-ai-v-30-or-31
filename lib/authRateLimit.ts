// Shared auth throttles. In-memory only — each serverless isolate has its own map.
// That is weaker than Redis, but it still stops a single instance from being
// sprayed, and it no longer trusts a client-supplied X-Forwarded-For hop.

type Bucket = { count: number; resetAt: number }

function firstHop(value: string | null): string | null {
  if (!value) return null
  const hop = value.split(',')[0]?.trim() ?? ''
  if (!hop || hop.length > 64 || /\s/.test(hop)) return null
  return hop
}

/** Platform-set client IP. Never the left-most X-Forwarded-For value, which the caller can forge. */
export function clientIpFromHeaders(headers: { get(name: string): string | null }): string {
  return firstHop(headers.get('x-vercel-forwarded-for'))
    ?? firstHop(headers.get('x-real-ip'))
    ?? 'unknown'
}

export function createFixedWindowCounter(limit: number, windowMs: number) {
  const buckets = new Map<string, Bucket>()

  function prune(now: number) {
    if (buckets.size < 4000) return
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key)
    }
    while (buckets.size > 4000) {
      const oldest = buckets.keys().next().value
      if (oldest === undefined) break
      buckets.delete(oldest)
    }
  }

  return {
    isBlocked(key: string): boolean {
      const now = Date.now()
      const bucket = buckets.get(key)
      return Boolean(bucket && now < bucket.resetAt && bucket.count >= limit)
    },
    increment(key: string): number {
      const now = Date.now()
      prune(now)
      const bucket = buckets.get(key)
      if (!bucket || now >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: now + windowMs })
        return 1
      }
      bucket.count += 1
      return bucket.count
    },
    clear(key: string) {
      buckets.delete(key)
    },
  }
}
