type WhaleFeedCacheEntry = { exp: number; payload: unknown }

export const whaleFeedCache = new Map<string, WhaleFeedCacheEntry>()

/** Used by the sync handler to invalidate the feed cache after it writes new alerts. */
export function clearWhaleFeedCache(): void {
  whaleFeedCache.clear()
}
