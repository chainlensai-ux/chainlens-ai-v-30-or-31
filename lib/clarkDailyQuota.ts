import { kv } from '@vercel/kv'
import { CLARK_DAILY_BY_PLAN } from './pricingPlans'

function utcDayStamp(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

function secondsUntilNextUtcMidnight(now = Date.now()): number {
  const d = new Date(now)
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0)
  return Math.max(60, Math.ceil((next - now) / 1000))
}

export function clarkDailyQuotaKey(actor: string, planKey: string, day = utcDayStamp()): string {
  return `clark:daily:${planKey}:${actor}:${day}`
}

export function clarkDailyLimit(planKey: string): number {
  return CLARK_DAILY_BY_PLAN[planKey] ?? CLARK_DAILY_BY_PLAN.free ?? 3
}

const memoryFallback = new Map<string, { count: number; day: string }>()

async function readCount(key: string, day: string): Promise<number> {
  try {
    const n = await kv.get<number>(key)
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n
    return 0
  } catch {
    const cur = memoryFallback.get(key)
    if (!cur || cur.day !== day) return 0
    return cur.count
  }
}

async function incrCount(key: string, day: string, ttlSec: number): Promise<number> {
  try {
    const n = await kv.incr(key)
    if (n === 1) await kv.expire(key, ttlSec)
    return n
  } catch {
    const cur = memoryFallback.get(key)
    const count = !cur || cur.day !== day ? 1 : cur.count + 1
    memoryFallback.set(key, { count, day })
    return count
  }
}

export async function peekClarkDailyQuota(actor: string, planKey: string): Promise<{ count: number; limit: number; remaining: number }> {
  const limit = clarkDailyLimit(planKey)
  const day = utcDayStamp()
  const count = await readCount(clarkDailyQuotaKey(actor, planKey, day), day)
  return { count, limit, remaining: Math.max(0, limit - count) }
}

export async function commitClarkDailyQuota(actor: string, planKey: string): Promise<{ count: number; limit: number; remaining: number }> {
  const limit = clarkDailyLimit(planKey)
  const day = utcDayStamp()
  const count = await incrCount(clarkDailyQuotaKey(actor, planKey, day), day, secondsUntilNextUtcMidnight())
  return { count, limit, remaining: Math.max(0, limit - count) }
}

export function __resetClarkDailyQuotaForTest(): void {
  memoryFallback.clear()
}
