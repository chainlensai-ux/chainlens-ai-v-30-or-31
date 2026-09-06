import { SCAN_DAILY_LIMITS, deepScanQuotaPeriod, type UserPlan } from './pricingPlans'
import { incrementDurableQuota, readDurableQuota, __resetDurableQuotaForTest } from './durableQuota'

// Deep-scan quota for Wallet Scanner deep mode only.
// Token Scanner uses its own per-minute rate limit in /api/token and must not
// call consumeDailyScan — otherwise Free's advertised 3 deep scans are burned
// by a token lookup. `null` limit = unlimited (Elite). Do not coalesce null
// with `??` (that would treat Elite as Free).
// Free and Pro reset monthly (1st of next UTC month). Normal wallet scans never
// consume this pool.

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

export async function snapshotDailyScan(plan: UserPlan, actor: string): Promise<DeepScanQuotaSnapshot> {
  const peeked = await peekDailyScan(plan, actor)
  return {
    plan,
    limit: peeked.limit,
    remaining: peeked.remaining,
    used: peeked.count,
    unlimited: peeked.limit == null,
    period: deepScanQuotaPeriod(plan),
  }
}

export async function consumeDailyScan(plan: UserPlan, actor: string): Promise<{ allowed: boolean; limit: number | null; remaining: number | null }> {
  const limit = planScanLimit(plan)
  if (limit == null) return { allowed: true, limit: null, remaining: null }
  const period = deepScanQuotaPeriod(plan) ?? 'day'
  const now = nowFn()
  const resetAt = utcPeriodReset(period, now)
  const periodStamp = period === 'month' ? new Date(now).toISOString().slice(0, 7) : new Date(now).toISOString().slice(0, 10)
  const count = await incrementDurableQuota(`wallet-scan:${period}:${periodStamp}:${plan}:${actor}`, Math.max(60, Math.ceil((resetAt - now) / 1000)))
  return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count) }
}

export async function peekDailyScan(plan: UserPlan, actor: string): Promise<{ count: number; limit: number | null; remaining: number | null }> {
  const limit = planScanLimit(plan)
  if (limit == null) return { count: 0, limit: null, remaining: null }
  const now = nowFn()
  const period = deepScanQuotaPeriod(plan) ?? 'day'
  const periodStamp = period === 'month' ? new Date(now).toISOString().slice(0, 7) : new Date(now).toISOString().slice(0, 10)
  const count = await readDurableQuota(`wallet-scan:${period}:${periodStamp}:${plan}:${actor}`)
  return { count, limit, remaining: Math.max(0, limit - count) }
}

export function __resetScanQuotaForTest(): void {
  __resetDurableQuotaForTest()
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
