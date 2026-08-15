import { redis, redisConfigured } from '@/lib/server/cache/redisClient'

export interface CacheEntry<T> {
  data: T
  timestamp: number
  ttlMs: number
}

export interface CacheFetchResult<T> {
  data: T
  cache: 'HIT' | 'MISS' | 'STALE'
  warning?: string
}

type CacheStore = Map<string, CacheEntry<unknown>>

const CACHE_WARNING = 'Using stale cached CoinGecko data because live fetch failed.'

// CROSS-INSTANCE-STALE-FALLBACK, DISCLOSED (investigated: Robinhood Radar intermittently showed
// "0/12 pages loaded" while Base Radar rarely did, even though page counts/backoff keys are
// identical and chain-scoped). Root cause: this cache was a plain per-process Map, so the STALE
// fallback below only ever worked if the SAME warm serverless instance had previously fetched that
// exact key. Base Radar's heavy traffic means most instances already have a recent Base page cached
// to fall back to on a 429; Robinhood's much lower traffic means a given instance frequently never
// populated its Robinhood keys, so a 429 there had nothing to fall back to and counted as a hard
// failure. Backing this with the same Redis client already used for discovery backoff
// (lib/server/cache/redisClient.ts) lets a successful fetch from ANY instance rescue a later
// failure on ANY OTHER instance — closing the gap that previously only helped high-traffic Base.
// Retention is intentionally much longer than any realistic ttlMs so stale data stays reachable
// across instances well after it goes stale, not just within one process's freshness window.
// Redis is strictly best-effort here: every read/write is wrapped so a Redis hiccup degrades back
// to the original per-instance-only behavior and never blocks or throws.
const REDIS_KEY_PREFIX = 'gecko:cache:'
const REDIS_STALE_RETENTION_SECONDS = 6 * 60 * 60

function getStore(): CacheStore {
  const g = globalThis as typeof globalThis & { __chainlensGeckoCache?: CacheStore }
  if (!g.__chainlensGeckoCache) g.__chainlensGeckoCache = new Map<string, CacheEntry<unknown>>()
  return g.__chainlensGeckoCache
}

function isFresh(entry: CacheEntry<unknown>): boolean {
  return Date.now() - entry.timestamp < entry.ttlMs
}

async function readRedisEntry<T>(key: string): Promise<CacheEntry<T> | null> {
  if (!redisConfigured()) return null
  try {
    return (await redis.get<CacheEntry<T>>(`${REDIS_KEY_PREFIX}${key}`)) ?? null
  } catch {
    return null
  }
}

async function writeRedisEntry<T>(key: string, entry: CacheEntry<T>): Promise<void> {
  if (!redisConfigured()) return
  try {
    await redis.set(`${REDIS_KEY_PREFIX}${key}`, entry, { ex: REDIS_STALE_RETENTION_SECONDS })
  } catch { /* best-effort — never block discovery on a Redis problem */ }
}

export async function getOrFetchCached<T>(params: {
  key: string
  ttlMs: number
  fetcher: () => Promise<T>
  onLog?: (message: string) => void
}): Promise<CacheFetchResult<T>> {
  const { key, ttlMs, fetcher, onLog } = params
  const store = getStore()
  const localCached = store.get(key) as CacheEntry<T> | undefined

  if (localCached && isFresh(localCached)) {
    onLog?.(`[cache] HIT ${key}`)
    return { data: localCached.data, cache: 'HIT' }
  }

  const redisCached = localCached ? null : await readRedisEntry<T>(key)
  if (redisCached && isFresh(redisCached)) {
    onLog?.(`[cache] HIT (redis) ${key}`)
    store.set(key, redisCached)
    return { data: redisCached.data, cache: 'HIT' }
  }

  onLog?.(`[cache] MISS ${key}`)

  try {
    const data = await fetcher()
    const entry: CacheEntry<T> = { data, timestamp: Date.now(), ttlMs }
    store.set(key, entry)
    await writeRedisEntry(key, entry)
    return { data, cache: 'MISS' }
  } catch (error) {
    const staleEntry = localCached ?? redisCached ?? (await readRedisEntry<T>(key))
    if (staleEntry) {
      onLog?.(`[cache] STALE ${key}`)
      store.set(key, staleEntry)
      return { data: staleEntry.data, cache: 'STALE', warning: CACHE_WARNING }
    }
    throw error
  }
}
