import { TOKEN_SCAN_WEEKLY_LIMITS, type UserPlan } from './pricingPlans'

// Weekly Token Scanner quota. Free = 3 / week (UTC week starting Monday).
// Pro/Elite unlimited (`null`). Per-minute TOKEN_RATE_BY_PLAN in /api/token stays separate.
// Do not coalesce null with `??` (that would treat Elite as Free).

const buckets = new Map<string, { count: number; resetAt: number }>()
let nowFn = () => Date.now()

function utcWeekReset(now: number): number {
  const d = new Date(now)
  // Monday 00:00 UTC of the next week (ISO week: Mon=1 … Sun=0→7)
  const day = d.getUTCDay() // 0 Sun … 6 Sat
  const daysSinceMonday = (day + 6) % 7
  const mondayThisWeek = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday, 0, 0, 0, 0)
  return mondayThisWeek + 7 * 24 * 60 * 60 * 1000
}

function planLimit(plan: UserPlan): number | null {
  if (Object.prototype.hasOwnProperty.call(TOKEN_SCAN_WEEKLY_LIMITS, plan)) return TOKEN_SCAN_WEEKLY_LIMITS[plan]
  return TOKEN_SCAN_WEEKLY_LIMITS.free
}

export type TokenScanQuotaSnapshot = {
  plan: UserPlan
  limit: number | null
  remaining: number | null
  used: number
  unlimited: boolean
  period: 'week' | null
}

export function snapshotTokenScan(plan: UserPlan, actor: string): TokenScanQuotaSnapshot {
  const peeked = peekTokenScan(plan, actor)
  return {
    plan,
    limit: peeked.limit,
    remaining: peeked.remaining,
    used: peeked.count,
    unlimited: peeked.limit == null,
    period: peeked.limit == null ? null : 'week',
  }
}

export function consumeTokenScan(plan: UserPlan, actor: string): { allowed: boolean; limit: number | null; remaining: number | null } {
  const limit = planLimit(plan)
  if (limit == null) return { allowed: true, limit: null, remaining: null }
  const now = nowFn()
  const key = `${plan}:${actor}`
  const cur = buckets.get(key)
  if (!cur || cur.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: utcWeekReset(now) })
    return { allowed: true, limit, remaining: Math.max(0, limit - 1) }
  }
  if (cur.count >= limit) return { allowed: false, limit, remaining: 0 }
  cur.count += 1
  return { allowed: true, limit, remaining: Math.max(0, limit - cur.count) }
}

export function peekTokenScan(plan: UserPlan, actor: string): { count: number; limit: number | null; remaining: number | null } {
  const limit = planLimit(plan)
  if (limit == null) return { count: 0, limit: null, remaining: null }
  const cur = buckets.get(`${plan}:${actor}`)
  if (!cur || cur.resetAt <= nowFn()) return { count: 0, limit, remaining: limit }
  return { count: cur.count, limit, remaining: Math.max(0, limit - cur.count) }
}

export function __resetTokenScanQuotaForTest(): void {
  buckets.clear()
  nowFn = () => Date.now()
}

export function __setTokenScanQuotaNowForTest(now: number): void {
  nowFn = () => now
}

export function __tokenScanResetAtForTest(now: number): number {
  return utcWeekReset(now)
}
