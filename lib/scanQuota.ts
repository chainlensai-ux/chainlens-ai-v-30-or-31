import { SCAN_DAILY_LIMITS, type UserPlan } from './pricingPlans'

const daily = new Map<string, { count: number; resetAt: number }>()

function utcMidnightReset(now = Date.now()): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0)
}

function planScanLimit(plan: UserPlan): number | null {
  if (Object.prototype.hasOwnProperty.call(SCAN_DAILY_LIMITS, plan)) return SCAN_DAILY_LIMITS[plan]
  return SCAN_DAILY_LIMITS.free
}

export function consumeDailyScan(plan: UserPlan, actor: string): { allowed: boolean; limit: number | null; remaining: number | null } {
  const limit = planScanLimit(plan)
  if (limit == null) return { allowed: true, limit: null, remaining: null }
  const now = Date.now()
  const key = `${plan}:${actor}`
  const cur = daily.get(key)
  if (!cur || cur.resetAt <= now) {
    daily.set(key, { count: 1, resetAt: utcMidnightReset(now) })
    return { allowed: true, limit, remaining: Math.max(0, limit - 1) }
  }
  if (cur.count >= limit) return { allowed: false, limit, remaining: 0 }
  cur.count += 1
  return { allowed: true, limit, remaining: Math.max(0, limit - cur.count) }
}

export function peekDailyScan(plan: UserPlan, actor: string): { count: number; limit: number | null; remaining: number | null } {
  const limit = planScanLimit(plan)
  if (limit == null) return { count: 0, limit: null, remaining: null }
  const cur = daily.get(`${plan}:${actor}`)
  if (!cur || cur.resetAt <= Date.now()) return { count: 0, limit, remaining: limit }
  return { count: cur.count, limit, remaining: Math.max(0, limit - cur.count) }
}

export function __resetScanQuotaForTest(): void {
  daily.clear()
}