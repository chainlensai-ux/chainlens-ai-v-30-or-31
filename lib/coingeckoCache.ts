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

function getStore(): CacheStore {
  const g = globalThis as typeof globalThis & { __chainlensGeckoCache?: CacheStore }
  if (!g.__chainlensGeckoCache) g.__chainlensGeckoCache = new Map<string, CacheEntry<unknown>>()
  return g.__chainlensGeckoCache
}

function isFresh(entry: CacheEntry<unknown>): boolean {
  return Date.now() - entry.timestamp < entry.ttlMs
}

export async function getOrFetchCached<T>(params: {
  key: string
  ttlMs: number
  fetcher: () => Promise<T>
  onLog?: (message: string) => void
}): Promise<CacheFetchResult<T>> {
  const { key, ttlMs, fetcher, onLog } = params
  const store = getStore()
  const cached = store.get(key) as CacheEntry<T> | undefined

  if (cached && isFresh(cached)) {
    onLog?.(`[cache] HIT ${key}`)
    return { data: cached.data, cache: 'HIT' }
  }

  onLog?.(`[cache] MISS ${key}`)

  try {
    const data = await fetcher()
    store.set(key, { data, timestamp: Date.now(), ttlMs })
    return { data, cache: 'MISS' }
  } catch (error) {
    if (cached) {
      onLog?.(`[cache] STALE ${key}`)
      return { data: cached.data, cache: 'STALE', warning: CACHE_WARNING }
    }
    throw error
  }
}
