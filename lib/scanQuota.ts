import { SCAN_DAILY_LIMITS, deepScanQuotaPeriod, type UserPlan } from './pricingPlans'

// Deep-scan quota for Wallet Scanner deep mode only.
// Token Scanner uses its own per-minute rate limit in /api/token and must not
// call consumeDailyScan — otherwise Free's advertised 3 deep scans are burned
// by a token lookup. `null` limit = unlimited (Elite). Do not coalesce null
// with `??` (that would treat Elite as Free).
// Free and Pro reset monthly (1st of next UTC month). Normal wallet scans never
// consume this pool.

const buckets = new Map<string, { count: number; resetAt: number }>()
let nowFn = () => Date.now()

function utcPeriodReset(period: 'day' | 'month', now: number): number {
  const d = new Date(now)
  if (period === 'month') {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0)
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0)
}

function planScanLimit(plan: UserPlan): number | null {
  if (Object.prototype.hasOwnProperty.call(SCAN_DAILY_LIMITS, plan)) return SCAN_DAILY_LIMITS[plan]
  return SCAN_DAILY_LIMITS.free
}

export type DeepScanQuotaSnapshot = {
  plan: UserPlan
  limit: number | null
  remaining: number | null
  used: number
  unlimited: boolean
  period: 'day' | 'month' | null
}

export function snapshotDailyScan(plan: UserPlan, actor: string): DeepScanQuotaSnapshot {
  const peeked = peekDailyScan(plan, actor)
  return {
    plan,
    limit: peeked.limit,
    remaining: peeked.remaining,
    used: peeked.count,
    unlimited: peeked.limit == null,
    period: deepScanQuotaPeriod(plan),
  }
}

export function consumeDailyScan(plan: UserPlan, actor: string): { allowed: boolean; limit: number | null; remaining: number | null } {
  const limit = planScanLimit(plan)
  if (limit == null) return { allowed: true, limit: null, remaining: null }
  const period = deepScanQuotaPeriod(plan) ?? 'day'
  const now = nowFn()
  const key = `${plan}:${actor}`
  const cur = buckets.get(key)
  if (!cur || cur.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: utcPeriodReset(period, now) })
    return { allowed: true, limit, remaining: Math.max(0, limit - 1) }
  }
  if (cur.count >= limit) return { allowed: false, limit, remaining: 0 }
  cur.count += 1
  return { allowed: true, limit, remaining: Math.max(0, limit - cur.count) }
}

export function peekDailyScan(plan: UserPlan, actor: string): { count: number; limit: number | null; remaining: number | null } {
  const limit = planScanLimit(plan)
  if (limit == null) return { count: 0, limit: null, remaining: null }
  const cur = buckets.get(`${plan}:${actor}`)
  if (!cur || cur.resetAt <= nowFn()) return { count: 0, limit, remaining: limit }
  return { count: cur.count, limit, remaining: Math.max(0, limit - cur.count) }
}

export function __resetScanQuotaForTest(): void {
  buckets.clear()
  nowFn = () => Date.now()
}

export function __setScanQuotaNowForTest(now: number): void {
  nowFn = () => now
}

export function __scanQuotaResetAtForTest(plan: UserPlan, now: number): number | null {
  const period = deepScanQuotaPeriod(plan)
  if (period == null) return null
  return utcPeriodReset(period, now)
}
