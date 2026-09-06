import { TOKEN_SCAN_WEEKLY_LIMITS, type UserPlan } from './pricingPlans'
import { incrementDurableQuota, readDurableQuota, __resetDurableQuotaForTest } from './durableQuota'

// Weekly Token Scanner quota. Free = 3 / week (UTC week starting Monday).
// Pro/Elite unlimited (`null`). Per-minute TOKEN_RATE_BY_PLAN in /api/token stays separate.
// Do not coalesce null with `??` (that would treat Elite as Free).

let nowFn = () => Date.now()

function weekStamp(now: number): string {
  return new Date(utcWeekReset(now) - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

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

export async function snapshotTokenScan(plan: UserPlan, actor: string): Promise<TokenScanQuotaSnapshot> {
  const peeked = await peekTokenScan(plan, actor)
  return {
    plan,
    limit: peeked.limit,
    remaining: peeked.remaining,
    used: peeked.count,
    unlimited: peeked.limit == null,
    period: peeked.limit == null ? null : 'week',
  }
}

export async function consumeTokenScan(plan: UserPlan, actor: string): Promise<{ allowed: boolean; limit: number | null; remaining: number | null }> {
  const limit = planLimit(plan)
  if (limit == null) return { allowed: true, limit: null, remaining: null }
  const now = nowFn()
  const resetAt = utcWeekReset(now)
  const count = await incrementDurableQuota(`token-scan:week:${weekStamp(now)}:${plan}:${actor}`, Math.max(60, Math.ceil((resetAt - now) / 1000)))
  return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count) }
}

export async function peekTokenScan(plan: UserPlan, actor: string): Promise<{ count: number; limit: number | null; remaining: number | null }> {
  const limit = planLimit(plan)
  if (limit == null) return { count: 0, limit: null, remaining: null }
  const now = nowFn()
  const count = await readDurableQuota(`token-scan:week:${weekStamp(now)}:${plan}:${actor}`)
  return { count, limit, remaining: Math.max(0, limit - count) }
}

export function __resetTokenScanQuotaForTest(): void {
  __resetDurableQuotaForTest()
  nowFn = () => Date.now()
}

export function __setTokenScanQuotaNowForTest(now: number): void {
  nowFn = () => now
}

export function __tokenScanResetAtForTest(now: number): number {
  return utcWeekReset(now)
}
