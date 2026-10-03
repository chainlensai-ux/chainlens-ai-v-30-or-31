// lib/pricing/currentPriceResolver.ts — ONE canonical CURRENT-price resolver with evidence (server-side).
//
// REUSE AUDIT (what this module builds on vs adds):
//   reused  - canonical stablecoin + canonical WETH + native pseudo-address registries
//             (src/modules/quoteLegPricing: isVerifiedStablecoinAddress / isCanonicalWethAddress /
//             isNativePseudoAddress) — the same address-verified registries quote-leg pricing trusts;
//           - DexScreener: fetchDexscreenerPriceShared (src/lib/dexscreenerRequestCache.ts) — the shared,
//             request-scoped cache; its pair rules (exact chain, requested token = base side, positive
//             price, liquidity >= $1k, ranked liquidity → 24h volume) live in pricingAtTimeEngine/sources/
//             dexscreener.ts and are not duplicated here;
//           - GeckoTerminal: src/modules/fallbackPricing/geckoTerminalClient.ts (extended there with an
//             identity-checked pool listing — not a second client);
//           - ETH/USD: lib/server/coingeckoOnchainOhlcv.ts fetchCoingeckoEthUsdRecent, else DexScreener on the
//             chain's canonical WETH address (exact address, never a symbol search);
//           - RPC client + on-chain decimals(): lib/engine/modules/pricing/rpcDecimals.ts;
//           - V4 PoolManager addresses already in the repo (lib/server/v4SwapCandlesRpc.ts / uniswapV4BaseRpc.ts).
//   added   - pure pool math (lib/pricing/poolMath.ts), a small current-state pool reader
//             (lib/pricing/onchainPoolSource.ts), this ladder, multihop routing and the shared cache.
//             No existing CURRENT pool reader existed: basedex.ts is block-pinned, Base-only, historical.
//
// LADDER: B provider price → A canonical stable / native / WETH → C shared cache (L1 process → L2 KV) →
// D DexScreener →
// E GeckoTerminal → F direct on-chain pool (V2 / V3 / V4) → G bounded multihop (≤ 2 DEX hops, ≤ 3 assets
// before USD). A–C are CHEAP (no per-token network call); D–G are EXPENSIVE and only run when the caller
// allows them (Wallet Scanner gates them behind its fallback budget). NEVER FABRICATES: every miss is an
// 'unavailable' evidence with a reason; only 'high' or 'medium' confidence prices are ever returned.

import { isVerifiedStablecoinAddress, isCanonicalWethAddress, isNativePseudoAddress, canonicalQuoteAssetAddresses } from '@/src/modules/quoteLegPricing/index'
import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'
import { sqrtPriceX96ToPriceInQuote, v2PriceInQuote, v2QuoteReserve, concentratedVirtualQuoteReserve } from './poolMath'

export type CurrentPriceSource =
  | 'canonical_stable'
  | 'canonical_native'
  | 'provider'
  | 'shared_cache'
  | 'dexscreener'
  | 'geckoterminal'
  | 'onchain_v2'
  | 'onchain_v3'
  | 'onchain_v4'
  | 'multihop'

export type CurrentPriceEvidence = {
  priceUsd: number | null
  status: 'verified' | 'unavailable'
  source: CurrentPriceSource | null
  /** Asset path ending in 'USD', e.g. [token, weth, 'USD']. For a cache hit, the original route. */
  route: string[]
  poolAddress: string | null
  liquidityUsd: number | null
  observedAt: number | null
  confidence: 'high' | 'medium' | null
  reason: string | null
  /** For a shared-cache hit: the source that originally produced the price. */
  originalSource?: CurrentPriceSource | null
}

export type SourceAttempt = { attempted: boolean; ok: boolean; reason: string | null }

export type CurrentPriceAttempts = {
  cache: 'hit' | 'miss' | 'stale' | 'negative' | null
  /** Which cache layer answered a hit. */
  cacheLayer?: 'l1' | 'l2' | null
  dexscreener: SourceAttempt | null
  geckoterminal: SourceAttempt | null
  onchain: (SourceAttempt & { poolsInspected: number }) | null
  multihop: (SourceAttempt & { routesInspected: number }) | null
}

export type CurrentPriceResult = { evidence: CurrentPriceEvidence; attempts: CurrentPriceAttempts }

export type ResolveCurrentPriceInput = {
  chainId: number
  tokenAddress: string
  providerPriceUsd?: number | null
  providerValueUsd?: number | null
  balanceRaw?: string | null
  decimals?: number | null
}

// ─── source contracts (injected; production defaults live in currentPriceSources.ts) ──────────────────
export type DexscreenerLookup = (chainId: number, token: string) => Promise<{ priceUsd: number | null; reason: string | null; pairAddress?: string | null; liquidityUsd?: number | null }>

export type GeckoTerminalPool = {
  poolAddress: string
  dexId: string | null
  network: string
  baseTokenAddress: string
  quoteTokenAddress: string
  basePriceUsd: number | null
  quotePriceUsd: number | null
  reserveUsd: number | null
  volume24hUsd: number | null
}
export type GeckoTerminalLookup = (chainId: number, token: string) => Promise<{ network: string | null; pools: GeckoTerminalPool[]; reason: string | null }>

export type OnchainPoolKind = 'v2' | 'v3' | 'v4'
export type OnchainPoolState = {
  kind: OnchainPoolKind
  /** Pair/pool address, or the V4 poolId. */
  poolAddress: string
  token0: string
  token1: string
  reserve0?: bigint | null
  reserve1?: bigint | null
  sqrtPriceX96?: bigint | null
  liquidity?: bigint | null
  /** V3: the quote token's real balance held by the pool (raw), when read. */
  quoteBalanceRaw?: bigint | null
}
export type OnchainPoolLookup = {
  /** Pools pairing `token` with any of `counterparts` (identity read on-chain). Must never throw. */
  listPools: (chainId: number, token: string, counterparts: string[]) => Promise<OnchainPoolState[]>
  decimals: (chainId: number, token: string) => Promise<number | null>
}
export type EthUsdLookup = (chainId: number) => Promise<{ priceUsd: number; observedAt: number; source: string } | null>

/**
 * L2 (cross-instance) store for current prices. Implementations THROW on failure (timeout, outage) so the
 * resolver can count it and fall through; a missing key resolves to null.
 */
export type CurrentPriceL2Store = {
  mget: (keys: string[]) => Promise<Array<unknown | null>>
  set: (key: string, value: PersistedCurrentPrice, ttlSeconds: number) => Promise<void>
}

/** The only evidence persisted to L2 — enough to reuse, never enough to look newly observed. */
export type PersistedCurrentPrice = {
  v: typeof CURRENT_PRICE_CACHE_VERSION
  chainId: number
  tokenAddress: string
  priceUsd: number
  originalSource: CurrentPriceSource
  route: string[]
  poolAddress: string | null
  liquidityUsd: number | null
  observedAt: number
  confidence: 'high' | 'medium'
  expiresAt: number
}

export type CurrentPriceResolverDeps = {
  /** L2 shared cache (production: Vercel KV). null/undefined = L1 only. */
  l2?: CurrentPriceL2Store | null
  dexscreener?: DexscreenerLookup | null
  geckoterminal?: GeckoTerminalLookup | null
  onchain?: OnchainPoolLookup | null
  ethUsd?: EthUsdLookup | null
  now?: () => number
}

// ─── constants ────────────────────────────────────────────────────────────────────────────────────────
export const GT_MIN_RESERVE_USD = 1_000 // same floor as the DexScreener source
export const ONCHAIN_MIN_LIQUIDITY_USD = 10_000 // per hop; stricter than indexed markets
export const MULTIHOP_MAX_DEX_HOPS = 2
export const MULTIHOP_MAX_INTERMEDIATES = 2
export const CURRENT_PRICE_TTL_LIQUID_MS = 120_000
export const CURRENT_PRICE_TTL_ILLIQUID_MS = 30_000
export const CURRENT_PRICE_TTL_NEGATIVE_MS = 15_000
const LIQUID_THRESHOLD_USD = 100_000
export const V4_NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000'

const CHAIN_ID_TO_CHAIN: Record<number, SupportedChain> = { 1: 'eth', 8453: 'base', 42161: 'arbitrum' }
/** Chains whose native currency is ETH (ETH/USD prices the native asset and canonical WETH). */
const ETH_NATIVE_CHAIN_IDS = new Set([1, 8453, 42161])

const lc = (a: string) => a.toLowerCase()

export const CURRENT_PRICE_CACHE_VERSION = 'v1'

/** Exact chain + token key (L1 and L2). A different chain is a different key — never a fallback. */
export function currentPriceCacheKey(chainId: number, tokenAddress: string): string {
  return `current-price:${CURRENT_PRICE_CACHE_VERSION}:${chainId}:${lc(tokenAddress)}`
}

// ─── anchors (address-verified only — never a symbol) ─────────────────────────────────────────────────
export function isCanonicalStable(chainId: number, token: string): boolean {
  const chain = CHAIN_ID_TO_CHAIN[chainId]
  return chain != null && isVerifiedStablecoinAddress(chain, token)
}

export function isCanonicalEthAsset(chainId: number, token: string): boolean {
  if (!ETH_NATIVE_CHAIN_IDS.has(chainId)) return false
  if (isNativePseudoAddress(token) || lc(token) === V4_NATIVE_CURRENCY) return true
  const chain = CHAIN_ID_TO_CHAIN[chainId]
  return chain != null && isCanonicalWethAddress(chain, token)
}

/** Canonical WETH + stables for a chain (the on-chain quote set). */
export function canonicalAnchorAddresses(chainId: number, registry: { weth: string[]; stables: string[] }): string[] {
  return [...registry.weth, ...registry.stables, ...(ETH_NATIVE_CHAIN_IDS.has(chainId) ? [V4_NATIVE_CURRENCY] : [])].map(lc)
}

// ─── shared cache + singleflight ──────────────────────────────────────────────────────────────────────
type CacheEntry = { evidence: CurrentPriceEvidence; expiresAt: number }
const sharedCache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<CurrentPriceResult>>()
const MAX_CACHE_ENTRIES = 20_000

export function __resetCurrentPriceCacheForTest(): void {
  sharedCache.clear()
  inflight.clear()
}

function ttlFor(e: CurrentPriceEvidence): number {
  if (e.status !== 'verified') return CURRENT_PRICE_TTL_NEGATIVE_MS
  if (e.source === 'canonical_stable' || e.source === 'canonical_native' || e.source === 'provider') return CURRENT_PRICE_TTL_LIQUID_MS
  return (e.liquidityUsd ?? 0) >= LIQUID_THRESHOLD_USD ? CURRENT_PRICE_TTL_LIQUID_MS : CURRENT_PRICE_TTL_ILLIQUID_MS
}

/** Write-through for any verified current price (also usable by Token Scanner). Chain-strict key. */
export function recordCurrentPrice(chainId: number, tokenAddress: string, evidence: CurrentPriceEvidence, now = Date.now()): void {
  if (evidence.source === 'shared_cache') return // never re-stamp a cached value as fresh
  if (evidence.status === 'verified' && !(evidence.priceUsd != null && evidence.priceUsd > 0 && evidence.confidence != null)) return
  sharedCache.set(currentPriceCacheKey(chainId, tokenAddress), { evidence, expiresAt: now + ttlFor(evidence) })
  if (sharedCache.size > MAX_CACHE_ENTRIES) {
    const oldest = sharedCache.keys().next().value
    if (oldest !== undefined) sharedCache.delete(oldest)
  }
}

export function readCurrentPriceCache(chainId: number, tokenAddress: string, now = Date.now()): { state: 'hit' | 'negative' | 'stale' | 'miss'; evidence: CurrentPriceEvidence | null } {
  const entry = sharedCache.get(currentPriceCacheKey(chainId, tokenAddress))
  if (!entry) return { state: 'miss', evidence: null }
  if (now >= entry.expiresAt) {
    sharedCache.delete(currentPriceCacheKey(chainId, tokenAddress))
    return { state: 'stale', evidence: null }
  }
  return { state: entry.evidence.status === 'verified' ? 'hit' : 'negative', evidence: entry.evidence }
}

/** Sources worth sharing across instances: the network-expensive ones. Provider / canonical prices are
 *  free to recompute on every scan, so they never cost an L2 roundtrip. */
const L2_PERSISTED_SOURCES = new Set<CurrentPriceSource>(['dexscreener', 'geckoterminal', 'onchain_v2', 'onchain_v3', 'onchain_v4', 'multihop'])

export function toPersistedCurrentPrice(chainId: number, tokenAddress: string, e: CurrentPriceEvidence, now: number): PersistedCurrentPrice | null {
  if (e.status !== 'verified' || e.source == null || !L2_PERSISTED_SOURCES.has(e.source)) return null
  if (!finitePositive(e.priceUsd) || (e.confidence !== 'high' && e.confidence !== 'medium')) return null
  return {
    v: CURRENT_PRICE_CACHE_VERSION, chainId, tokenAddress: lc(tokenAddress), priceUsd: e.priceUsd, originalSource: e.source,
    route: e.route, poolAddress: e.poolAddress, liquidityUsd: e.liquidityUsd, observedAt: e.observedAt ?? now, confidence: e.confidence,
    expiresAt: now + ttlFor(e),
  }
}

/**
 * Validates an L2 value for (chainId, token) at `now`. Anything malformed, for another chain/token, or
 * expired is rejected — a stale entry is never served.
 */
export function parsePersistedCurrentPrice(raw: unknown, chainId: number, tokenAddress: string, now: number): { state: 'valid' | 'stale' | 'invalid'; value: PersistedCurrentPrice | null } {
  const r = raw as Partial<PersistedCurrentPrice> | null
  if (!r || typeof r !== 'object' || r.v !== CURRENT_PRICE_CACHE_VERSION) return { state: 'invalid', value: null }
  if (r.chainId !== chainId || typeof r.tokenAddress !== 'string' || lc(r.tokenAddress) !== lc(tokenAddress)) return { state: 'invalid', value: null }
  if (!finitePositive(r.priceUsd) || (r.confidence !== 'high' && r.confidence !== 'medium') || !r.originalSource || !L2_PERSISTED_SOURCES.has(r.originalSource)) return { state: 'invalid', value: null }
  if (typeof r.expiresAt !== 'number' || typeof r.observedAt !== 'number' || !Array.isArray(r.route)) return { state: 'invalid', value: null }
  if (now >= r.expiresAt) return { state: 'stale', value: null }
  return { state: 'valid', value: r as PersistedCurrentPrice }
}

function fromPersisted(p: PersistedCurrentPrice): CurrentPriceEvidence {
  // Original source + original observedAt: a cached value is never relabeled as newly observed.
  return { priceUsd: p.priceUsd, status: 'verified', source: p.originalSource, route: p.route, poolAddress: p.poolAddress, liquidityUsd: p.liquidityUsd, observedAt: p.observedAt, confidence: p.confidence, reason: null }
}

function seedL1FromPersisted(p: PersistedCurrentPrice): void {
  sharedCache.set(currentPriceCacheKey(p.chainId, p.tokenAddress), { evidence: fromPersisted(p), expiresAt: p.expiresAt })
}

// ─── evidence helpers ─────────────────────────────────────────────────────────────────────────────────
function unavailable(reason: string): CurrentPriceEvidence {
  return { priceUsd: null, status: 'unavailable', source: null, route: [], poolAddress: null, liquidityUsd: null, observedAt: null, confidence: null, reason }
}

function verified(p: Omit<CurrentPriceEvidence, 'status' | 'reason'>): CurrentPriceEvidence {
  return { ...p, status: 'verified', reason: null }
}

const finitePositive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0

function emptyAttempts(): CurrentPriceAttempts {
  return { cache: null, dexscreener: null, geckoterminal: null, onchain: null, multihop: null }
}

// ─── resolver ─────────────────────────────────────────────────────────────────────────────────────────
export type ExpensiveAllowance = { dexscreener: boolean; geckoterminal: boolean; onchain: boolean }

export type AnchorRegistry = (chainId: number) => { weth: string[]; stables: string[] }

export const defaultAnchorRegistry: AnchorRegistry = (chainId) => {
  const chain = CHAIN_ID_TO_CHAIN[chainId]
  return chain ? canonicalQuoteAssetAddresses(chain) : { weth: [], stables: [] }
}

export function createCurrentPriceResolver(deps: CurrentPriceResolverDeps, anchors: AnchorRegistry = defaultAnchorRegistry) {
  const now = () => (deps.now ?? Date.now)()
  // Request-scoped ETH/USD memo (one anchor lookup per chain per resolver instance).
  const ethUsdMemo = new Map<number, Promise<{ priceUsd: number; observedAt: number; source: string } | null>>()
  const counters = {
    anchorCalls: 0, dexscreenerCalls: 0, geckoterminalCalls: 0, onchainTokenAttempts: 0, onchainPoolReads: 0,
    l1Hits: 0, l2Hits: 0, l2Misses: 0, l2ReadFailures: 0, l2WriteFailures: 0, networkAvoidedByCache: 0,
  }
  const pendingL2Writes = new Set<Promise<void>>()
  // Keys already looked up in L2 by this resolver (a prefetch miss is not re-read per token).
  const l2Checked = new Set<string>()
  // Keys this resolver seeded into L1 from L2 (so a later L1 read is attributed to L2).
  const l2SeededKeys = new Set<string>()

  /** Batched L2 read (one roundtrip) for keys that L1 does not already answer; seeds L1 on a hit. */
  async function prefetchShared(items: ReadonlyArray<{ chainId: number; tokenAddress: string }>): Promise<void> {
    if (!deps.l2) return
    const t = now()
    const todo = new Map<string, { chainId: number; tokenAddress: string }>()
    for (const it of items) {
      const key = currentPriceCacheKey(it.chainId, it.tokenAddress)
      if (l2Checked.has(key) || todo.has(key)) continue
      if (readCurrentPriceCache(it.chainId, it.tokenAddress, t).state === 'hit') continue // L1 answers it
      todo.set(key, it)
    }
    if (todo.size === 0) return
    const keys = [...todo.keys()]
    keys.forEach((k) => l2Checked.add(k))
    let values: Array<unknown | null>
    try {
      values = await deps.l2.mget(keys)
    } catch {
      counters.l2ReadFailures += keys.length
      return // non-fatal: falls through to the network
    }
    keys.forEach((key, i) => {
      const it = todo.get(key)!
      const parsed = parsePersistedCurrentPrice(values[i] ?? null, it.chainId, it.tokenAddress, t)
      if (parsed.state === 'valid' && parsed.value) {
        seedL1FromPersisted(parsed.value)
        l2SeededKeys.add(key)
        counters.l2Hits += 1
      } else {
        counters.l2Misses += 1
      }
    })
  }

  function persistL2(chainId: number, token: string, evidence: CurrentPriceEvidence): void {
    if (!deps.l2) return
    const t = now()
    const value = toPersistedCurrentPrice(chainId, token, evidence, t)
    if (!value) return
    const ttlSeconds = Math.max(1, Math.ceil((value.expiresAt - t) / 1000))
    const w = deps.l2.set(currentPriceCacheKey(chainId, token), value, ttlSeconds)
      .catch(() => { counters.l2WriteFailures += 1 })
      .finally(() => { pendingL2Writes.delete(w) })
    pendingL2Writes.add(w)
  }

  /** Await in-flight L2 writes (tests / graceful shutdown). Writes never block resolution. */
  async function flushL2Writes(): Promise<void> {
    await Promise.all([...pendingL2Writes])
  }
  // GeckoTerminal pools per token (request-scoped): a later on-chain phase reuses them as multihop
  // intermediates without a second GeckoTerminal call.
  const gtPoolsMemo = new Map<string, GeckoTerminalPool[]>()

  function ethUsd(chainId: number) {
    if (!deps.ethUsd || !ETH_NATIVE_CHAIN_IDS.has(chainId)) return Promise.resolve(null)
    let p = ethUsdMemo.get(chainId)
    if (!p) {
      counters.anchorCalls += 1
      p = deps.ethUsd(chainId).then((r) => (r && finitePositive(r.priceUsd) ? r : null)).catch(() => null)
      ethUsdMemo.set(chainId, p)
    }
    return p
  }

  /** USD price of an anchor asset (canonical stable = $1, native/WETH = ETH/USD), else null. */
  async function anchorUsd(chainId: number, token: string): Promise<number | null> {
    if (isCanonicalStable(chainId, token)) return 1
    if (isCanonicalEthAsset(chainId, token)) return (await ethUsd(chainId))?.priceUsd ?? null
    return null
  }

  /** Provider → canonical → cache. No per-token market call: the ETH/USD anchor is one memoized lookup per
   *  chain, and L2 is one batched KV read when the caller prefetched (else one read per L1 miss). */
  async function resolveCheap(input: ResolveCurrentPriceInput): Promise<CurrentPriceResult> {
    const attempts = emptyAttempts()
    const token = lc(input.tokenAddress)
    const t = now()
    // PRECEDENCE (self-contained — never relies on a caller pre-filtering): a valid provider price is
    // this exact holding's own market evidence and wins; the canonical registry is the fallback when no
    // provider price exists (e.g. a canonical USDC the provider returned 0.9987 for stays 0.9987).
    // B. provider price.
    if (finitePositive(input.providerPriceUsd)) {
      const evidence = verified({ priceUsd: input.providerPriceUsd, source: 'provider', route: [token, 'USD'], poolAddress: null, liquidityUsd: null, observedAt: t, confidence: 'high' })
      recordCurrentPrice(input.chainId, token, evidence, t)
      return { evidence, attempts }
    }
    // A. canonical stable / native / WETH — exact address only.
    if (isCanonicalStable(input.chainId, token)) {
      return { evidence: verified({ priceUsd: 1, source: 'canonical_stable', route: [token, 'USD'], poolAddress: null, liquidityUsd: null, observedAt: t, confidence: 'high' }), attempts }
    }
    if (isCanonicalEthAsset(input.chainId, token)) {
      const eth = await ethUsd(input.chainId)
      if (eth) return { evidence: verified({ priceUsd: eth.priceUsd, source: 'canonical_native', route: [token, `ETH/USD:${eth.source}`, 'USD'], poolAddress: null, liquidityUsd: null, observedAt: eth.observedAt, confidence: 'high' }), attempts }
    }
    // C. shared cache: L1 (process) → L2 (KV, one batched read if the caller prefetched) → network.
    // Chain-strict keys, TTL-bounded; a stale entry is discarded, never served.
    let cached = readCurrentPriceCache(input.chainId, token, t)
    let layer: 'l1' | 'l2' | null = cached.state === 'hit' ? 'l1' : null
    if (cached.state !== 'hit' && cached.state !== 'negative' && deps.l2) {
      const before = counters.l2Hits
      await prefetchShared([{ chainId: input.chainId, tokenAddress: token }])
      if (counters.l2Hits > before) {
        cached = readCurrentPriceCache(input.chainId, token, now())
        if (cached.state === 'hit') layer = 'l2'
      }
    } else if (layer === 'l1' && l2SeededKeys.has(currentPriceCacheKey(input.chainId, token))) {
      layer = 'l2' // seeded by this resolver's batched prefetch
    }
    attempts.cache = cached.state
    attempts.cacheLayer = layer
    if (cached.state === 'hit' && cached.evidence) {
      if (layer === 'l1') counters.l1Hits += 1
      counters.networkAvoidedByCache += 1
      return { evidence: { ...cached.evidence, source: 'shared_cache', originalSource: cached.evidence.source }, attempts }
    }
    return { evidence: unavailable(cached.state === 'negative' ? 'negative_cache' : 'no_cheap_price'), attempts }
  }

  async function viaDexscreener(chainId: number, token: string, attempts: CurrentPriceAttempts): Promise<CurrentPriceEvidence | null> {
    if (!deps.dexscreener) return null
    counters.dexscreenerCalls += 1
    const r = await deps.dexscreener(chainId, token).catch((e) => ({ priceUsd: null, reason: `error:${e instanceof Error ? e.message : 'unknown'}` }))
    const ok = finitePositive(r.priceUsd)
    attempts.dexscreener = { attempted: true, ok, reason: ok ? null : r.reason ?? 'no_price' }
    if (!ok) return null
    const pr = r as { pairAddress?: string | null; liquidityUsd?: number | null }
    return verified({ priceUsd: r.priceUsd as number, source: 'dexscreener', route: [token, 'USD'], poolAddress: pr.pairAddress ?? null, liquidityUsd: pr.liquidityUsd ?? null, observedAt: now(), confidence: 'high' })
  }

  async function viaGeckoTerminal(chainId: number, token: string, attempts: CurrentPriceAttempts): Promise<{ evidence: CurrentPriceEvidence | null; pools: GeckoTerminalPool[] }> {
    if (!deps.geckoterminal) return { evidence: null, pools: [] }
    counters.geckoterminalCalls += 1
    const r = await deps.geckoterminal(chainId, token).catch(() => ({ network: null, pools: [] as GeckoTerminalPool[], reason: 'error' }))
    const pick = selectGeckoTerminalPool(r.pools, token, r.network)
    attempts.geckoterminal = { attempted: true, ok: pick.pool != null, reason: pick.pool ? null : r.reason ?? pick.reason }
    if (!pick.pool || pick.priceUsd == null) return { evidence: null, pools: r.pools }
    return {
      evidence: verified({ priceUsd: pick.priceUsd, source: 'geckoterminal', route: [token, 'USD'], poolAddress: pick.pool.poolAddress, liquidityUsd: pick.pool.reserveUsd, observedAt: now(), confidence: 'high' }),
      pools: r.pools,
    }
  }

  type Hop = { pool: OnchainPoolState; from: string; to: string; priceInTo: number; liquidityUsd: number }

  /** One hop: price `token` in USD through `pool` whose counterpart has a verified USD price. */
  async function hopPrice(chainId: number, token: string, pool: OnchainPoolState, counterpartUsd: number): Promise<{ hop: Hop | null; reason: string | null }> {
    const t0 = lc(pool.token0)
    const t1 = lc(pool.token1)
    if (t0 !== token && t1 !== token) return { hop: null, reason: 'pool_does_not_contain_token' }
    const counterpart = t0 === token ? t1 : t0
    if (counterpart === token) return { hop: null, reason: 'malformed_pool_state' }
    const [tokenDecimals, quoteDecimals] = await Promise.all([
      deps.onchain!.decimals(chainId, token),
      counterpart === V4_NATIVE_CURRENCY ? Promise.resolve(18) : deps.onchain!.decimals(chainId, counterpart),
    ])
    if (tokenDecimals == null || quoteDecimals == null) return { hop: null, reason: 'decimals_unverified' }
    const input = { tokenIsToken0: t0 === token, tokenDecimals, quoteDecimals }
    let priceInQuote: number | null = null
    let quoteReserve: number | null = null
    if (pool.kind === 'v2') {
      if (pool.reserve0 == null || pool.reserve1 == null) return { hop: null, reason: 'malformed_pool_state' }
      priceInQuote = v2PriceInQuote(pool.reserve0, pool.reserve1, input)
      quoteReserve = v2QuoteReserve(pool.reserve0, pool.reserve1, input)
    } else {
      if (pool.sqrtPriceX96 == null || pool.liquidity == null) return { hop: null, reason: 'malformed_pool_state' }
      if (pool.liquidity <= BigInt(0)) return { hop: null, reason: 'zero_liquidity' }
      priceInQuote = sqrtPriceX96ToPriceInQuote(pool.sqrtPriceX96, input)
      quoteReserve = pool.kind === 'v3' && pool.quoteBalanceRaw != null && pool.quoteBalanceRaw > BigInt(0)
        ? Number(pool.quoteBalanceRaw) / 10 ** quoteDecimals
        : concentratedVirtualQuoteReserve(pool.liquidity, pool.sqrtPriceX96, input)
    }
    if (priceInQuote == null) return { hop: null, reason: 'malformed_pool_state' }
    if (quoteReserve == null || quoteReserve <= 0) return { hop: null, reason: 'zero_liquidity' }
    const liquidityUsd = quoteReserve * counterpartUsd * 2
    if (!(liquidityUsd >= ONCHAIN_MIN_LIQUIDITY_USD)) return { hop: null, reason: 'liquidity_below_minimum' }
    return { hop: { pool, from: token, to: counterpart, priceInTo: priceInQuote, liquidityUsd }, reason: null }
  }

  type Route = { hops: Hop[]; priceUsd: number; minLiquidityUsd: number; anchor: string }

  function rankRoutes(routes: Route[]): Route[] {
    return [...routes].sort((a, b) => a.hops.length - b.hops.length
      || b.minLiquidityUsd - a.minLiquidityUsd
      || a.hops.map((h) => lc(h.pool.poolAddress)).join('>').localeCompare(b.hops.map((h) => lc(h.pool.poolAddress)).join('>')))
  }

  /** F + G: direct pools to anchors first; then ≤ 2-hop routes via intermediates (no cycles). */
  async function viaOnchain(chainId: number, token: string, intermediates: string[], attempts: CurrentPriceAttempts): Promise<CurrentPriceEvidence | null> {
    if (!deps.onchain) return null
    counters.onchainTokenAttempts += 1
    const anchorList = canonicalAnchorAddresses(chainId, anchors(chainId))
    const anchorUsdCache = new Map<string, number | null>()
    const usdOfAnchor = async (a: string) => {
      if (!anchorUsdCache.has(a)) anchorUsdCache.set(a, await anchorUsd(chainId, a))
      return anchorUsdCache.get(a) ?? null
    }
    const inters = intermediates.map(lc).filter((a) => a !== token && !anchorList.includes(a)).slice(0, MULTIHOP_MAX_INTERMEDIATES)
    let pools: OnchainPoolState[] = []
    try {
      counters.onchainPoolReads += 1
      pools = await deps.onchain.listPools(chainId, token, [...anchorList, ...inters])
    } catch {
      pools = []
    }
    const direct: Route[] = []
    const reasons: string[] = []
    for (const pool of pools) {
      const counterpart = lc(pool.token0) === token ? lc(pool.token1) : lc(pool.token0)
      if (!anchorList.includes(counterpart)) continue
      const usd = await usdOfAnchor(counterpart)
      if (usd == null) { reasons.push('quote_asset_unpriced'); continue }
      const { hop, reason } = await hopPrice(chainId, token, pool, usd)
      if (!hop) { reasons.push(reason ?? 'rejected'); continue }
      direct.push({ hops: [hop], priceUsd: hop.priceInTo * usd, minLiquidityUsd: hop.liquidityUsd, anchor: counterpart })
    }
    attempts.onchain = { attempted: true, ok: direct.length > 0, reason: direct.length > 0 ? null : (reasons[0] ?? 'no_pool_found'), poolsInspected: pools.length }
    if (direct.length > 0) {
      const best = rankRoutes(direct)[0]
      const kind = best.hops[0].pool.kind
      return verified({
        priceUsd: best.priceUsd,
        source: kind === 'v2' ? 'onchain_v2' : kind === 'v3' ? 'onchain_v3' : 'onchain_v4',
        route: [token, best.anchor, 'USD'],
        poolAddress: best.hops[0].pool.poolAddress,
        liquidityUsd: best.minLiquidityUsd,
        observedAt: now(),
        confidence: 'high',
      })
    }

    // G. multihop: token → B (intermediate) → anchor → USD. Hop cap = 2; cycles rejected.
    const multihopRoutes: Route[] = []
    let routesInspected = 0
    const firstHops = pools.filter((p) => {
      const counterpart = lc(p.token0) === token ? lc(p.token1) : lc(p.token0)
      return inters.includes(counterpart)
    })
    const mhReasons: string[] = []
    for (const p1 of firstHops) {
      const b = lc(p1.token0) === token ? lc(p1.token1) : lc(p1.token0)
      let bPools: OnchainPoolState[] = []
      try {
        counters.onchainPoolReads += 1
        bPools = await deps.onchain.listPools(chainId, b, anchorList)
      } catch {
        bPools = []
      }
      for (const p2 of bPools) {
        routesInspected += 1
        const c = lc(p2.token0) === b ? lc(p2.token1) : lc(p2.token0)
        if (c === token || c === b) { mhReasons.push('circular_route'); continue }
        if (!anchorList.includes(c)) { mhReasons.push('route_exceeds_hop_cap'); continue }
        const cUsd = await usdOfAnchor(c)
        if (cUsd == null) { mhReasons.push('quote_asset_unpriced'); continue }
        const h2 = await hopPrice(chainId, b, p2, cUsd)
        if (!h2.hop) { mhReasons.push(h2.reason ?? 'rejected'); continue }
        const bUsd = h2.hop.priceInTo * cUsd
        const h1 = await hopPrice(chainId, token, p1, bUsd)
        if (!h1.hop) { mhReasons.push(h1.reason ?? 'rejected'); continue }
        multihopRoutes.push({ hops: [h1.hop, h2.hop], priceUsd: h1.hop.priceInTo * bUsd, minLiquidityUsd: Math.min(h1.hop.liquidityUsd, h2.hop.liquidityUsd), anchor: c })
      }
    }
    if (firstHops.length > 0 || inters.length > 0) {
      attempts.multihop = { attempted: true, ok: multihopRoutes.length > 0, reason: multihopRoutes.length > 0 ? null : (mhReasons[0] ?? 'no_route'), routesInspected }
    }
    if (multihopRoutes.length === 0) return null
    const best = rankRoutes(multihopRoutes)[0]
    return verified({
      priceUsd: best.priceUsd,
      source: 'multihop',
      route: [token, best.hops[0].to, best.anchor, 'USD'],
      poolAddress: best.hops[0].pool.poolAddress,
      liquidityUsd: best.minLiquidityUsd,
      observedAt: now(),
      confidence: 'medium',
    })
  }

  /** D–G. Only the sources the caller allows; result written to the shared cache (incl. short negatives). */
  async function resolveExpensive(input: ResolveCurrentPriceInput, allow: ExpensiveAllowance, opts: { recordNegative?: boolean } = {}): Promise<CurrentPriceResult> {
    const recordNegative = opts.recordNegative ?? true
    const token = lc(input.tokenAddress)
    const key = currentPriceCacheKey(input.chainId, token)
    const existing = inflight.get(key)
    if (existing) return existing
    const run = (async (): Promise<CurrentPriceResult> => {
      const attempts = emptyAttempts()
      const finish = (evidence: CurrentPriceEvidence): CurrentPriceResult => {
        if (evidence.status === 'verified' || recordNegative) recordCurrentPrice(input.chainId, token, evidence, now())
        // L2: verified expensive-source evidence only. Negatives stay L1-only (15s), so a failure on one
        // instance can never suppress valid evidence on another.
        if (evidence.status === 'verified') persistL2(input.chainId, token, evidence)
        return { evidence, attempts }
      }
      if (allow.dexscreener) {
        const ds = await viaDexscreener(input.chainId, token, attempts)
        if (ds) return finish(ds)
      }
      let gtPools: GeckoTerminalPool[] = gtPoolsMemo.get(key) ?? []
      if (allow.geckoterminal) {
        const gt = await viaGeckoTerminal(input.chainId, token, attempts)
        gtPools = gt.pools
        gtPoolsMemo.set(key, gt.pools)
        if (gt.evidence) return finish(gt.evidence)
      }
      if (allow.onchain) {
        // Multihop intermediates: the counterpart tokens of GeckoTerminal's own pools for this token
        // (exact identity from the indexer), strongest reserve first. Never a symbol.
        const intermediates = gtPools
          .filter((p) => lc(p.baseTokenAddress) === token || lc(p.quoteTokenAddress) === token)
          .sort((a, b) => (b.reserveUsd ?? 0) - (a.reserveUsd ?? 0) || lc(a.poolAddress).localeCompare(lc(b.poolAddress)))
          .map((p) => (lc(p.baseTokenAddress) === token ? lc(p.quoteTokenAddress) : lc(p.baseTokenAddress)))
        const oc = await viaOnchain(input.chainId, token, Array.from(new Set(intermediates)), attempts)
        if (oc) return finish(oc)
      }
      const anyAttempted = allow.dexscreener || allow.geckoterminal || allow.onchain
      const reason = attempts.multihop?.reason ?? attempts.onchain?.reason ?? attempts.geckoterminal?.reason ?? attempts.dexscreener?.reason ?? 'not_attempted'
      return anyAttempted ? finish(unavailable(reason)) : { evidence: unavailable(reason), attempts }
    })()
    inflight.set(key, run)
    try {
      return await run
    } finally {
      inflight.delete(key)
    }
  }

  /** Full ladder (cheap, then every expensive source allowed). */
  async function resolveCurrentTokenPrice(input: ResolveCurrentPriceInput, allow: ExpensiveAllowance = { dexscreener: true, geckoterminal: true, onchain: true }): Promise<CurrentPriceResult> {
    const cheap = await resolveCheap(input)
    if (cheap.evidence.status === 'verified') return cheap
    if (cheap.attempts.cache === 'negative') return cheap // a very short negative cache only
    const expensive = await resolveExpensive(input, allow)
    return { evidence: expensive.evidence, attempts: { ...expensive.attempts, cache: cheap.attempts.cache } }
  }

  return { resolveCheap, resolveExpensive, resolveCurrentTokenPrice, prefetchShared, flushL2Writes, counters }
}

/**
 * GeckoTerminal pool choice: exact network, exact token identity (the token must be the pool's base or
 * quote token — its OWN side's price is used), positive finite price, reserve ≥ GT_MIN_RESERVE_USD; the
 * strongest market wins (reserve, then 24h volume, then pool address).
 */
export function selectGeckoTerminalPool(pools: ReadonlyArray<GeckoTerminalPool>, token: string, network: string | null): { pool: GeckoTerminalPool | null; priceUsd: number | null; reason: string } {
  const t = lc(token)
  const valid = pools
    .filter((p) => network != null && p.network === network)
    .map((p) => {
      const side = lc(p.baseTokenAddress) === t ? 'base' : lc(p.quoteTokenAddress) === t ? 'quote' : null
      const priceUsd = side === 'base' ? p.basePriceUsd : side === 'quote' ? p.quotePriceUsd : null
      return { p, priceUsd }
    })
    .filter((x): x is { p: GeckoTerminalPool; priceUsd: number } => finitePositive(x.priceUsd) && (x.p.reserveUsd ?? 0) >= GT_MIN_RESERVE_USD)
    .sort((a, b) => (b.p.reserveUsd ?? 0) - (a.p.reserveUsd ?? 0) || (b.p.volume24hUsd ?? 0) - (a.p.volume24hUsd ?? 0) || lc(a.p.poolAddress).localeCompare(lc(b.p.poolAddress)))
  if (valid.length === 0) return { pool: null, priceUsd: null, reason: pools.length === 0 ? 'no_pool_found' : 'no_valid_pool_for_token' }
  return { pool: valid[0].p, priceUsd: valid[0].priceUsd, reason: 'ok' }
}
