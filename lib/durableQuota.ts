import { kv } from '@vercel/kv'

const memoryFallback = new Map<string, number>()

export async function readDurableQuota(key: string): Promise<number> {
  try {
    const count = await kv.get<number>(key)
    return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : 0
  } catch {
    return memoryFallback.get(key) ?? 0
  }
}

export async function incrementDurableQuota(key: string, ttlSeconds: number): Promise<number> {
  try {
    const count = await kv.incr(key)
    if (count === 1) await kv.expire(key, ttlSeconds)
    return count
  } catch {
    const count = (memoryFallback.get(key) ?? 0) + 1
    memoryFallback.set(key, count)
    return count
  }
}

export function __resetDurableQuotaForTest(): void {
  memoryFallback.clear()
}
