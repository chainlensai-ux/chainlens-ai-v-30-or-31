import type { NextRequest } from 'next/server'

interface Bucket {
  count: number
  resetAt: number
}

export function createRateLimiter(opts: { windowMs: number; max: number }) {
  const store = new Map<string, Bucket>()

  return {
    check(key: string): boolean {
      const now = Date.now()
      const cur = store.get(key)
      if (!cur || cur.resetAt <= now) {
        store.set(key, { count: 1, resetAt: now + opts.windowMs })
        return true
      }
      if (cur.count >= opts.max) return false
      cur.count += 1
      return true
    },
  }
}

export function getClientIp(req: NextRequest | Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  return fwd?.split(',')[0]?.trim() ?? 'unknown'
}
