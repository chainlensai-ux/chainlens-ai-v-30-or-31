// MODULE — short-TTL, monotonic (union) active-chain cache + request-scoped singleflight for
// activeChainDiscovery.ts.
//
// MONOTONIC UNION, DISCLOSED: writing to this cache never replaces the stored chain list, it merges
// (union) new chains into whatever was already cached for that wallet — "never remove a chain
// already proven active" holds structurally, not just by convention. The TTL controls how long a
// cache HIT is trusted to skip recomputing discovery from fresh evidence, not how long a chain
// "remains active" — a proven-active chain stays in the accumulated set indefinitely (until process
// restart; this is an in-memory, per-instance cache, same limitation as every other in-memory cache
// in this codebase before KV caching existed).
//
// SINGLEFLIGHT, DISCLOSED: concurrent discovery requests for the SAME wallet within one request
// batch coalesce into one in-flight computation — same convention as receiptAcquisition.ts /
// uniswapV3PoolValidator.ts's own request-scoped cache+singleflight pattern.

const DEFAULT_TTL_MS = 5 * 60 * 1000

export type ActiveChainCacheEntry = { chains: string[]; cachedAt: number; expiresAt: number }

export class ActiveChainCache {
  private readonly store = new Map<string, ActiveChainCacheEntry>()
  private readonly inFlight = new Map<string, Promise<string[]>>()

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  private key(walletAddress: string): string {
    return walletAddress.toLowerCase()
  }

  // A cache HIT (fresh, unexpired) returns the accumulated chain list directly. An expired or
  // absent entry returns null — the caller should re-run discovery from live evidence, then call
  // `merge` with the result (which still unions against whatever was stored, expired or not).
  get(walletAddress: string): string[] | null {
    const entry = this.store.get(this.key(walletAddress))
    if (!entry || entry.expiresAt <= Date.now()) return null
    return entry.chains
  }

  // Chains previously accumulated for this wallet, REGARDLESS of TTL expiry — used by
  // discoverActiveChains's own "never remove a proven-active chain" merge, distinct from `get`
  // (which is TTL-gated and used only to decide whether to skip recomputation).
  getAccumulated(walletAddress: string): string[] {
    return this.store.get(this.key(walletAddress))?.chains ?? []
  }

  merge(walletAddress: string, chains: readonly string[]): string[] {
    const key = this.key(walletAddress)
    const existing = new Set(this.store.get(key)?.chains ?? [])
    chains.forEach((c) => existing.add(c))
    const merged = [...existing]
    const now = Date.now()
    this.store.set(key, { chains: merged, cachedAt: now, expiresAt: now + this.ttlMs })
    return merged
  }

  // Coalesces concurrent computations for the same wallet into one in-flight promise — never a
  // duplicate call to `compute` while one is already running for this exact wallet.
  async singleflight(walletAddress: string, compute: () => Promise<string[]>): Promise<string[]> {
    const key = this.key(walletAddress)
    const existing = this.inFlight.get(key)
    if (existing) return existing
    const promise = compute().finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, promise)
    return promise
  }
}

// Module-level singleton, disclosed: mirrors every other in-memory, per-instance cache in this
// codebase (rateMap, portfolioCache, onChainCache, etc.) — never a request-scoped instance, since
// the whole point is to persist accumulated active chains ACROSS requests within a warm instance.
export const activeChainCache = new ActiveChainCache()
