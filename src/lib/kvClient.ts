import { kv as realKv } from '@vercel/kv'
import type { PriceSourceFn } from '../modules/pricingAtTimeEngine/types'

export type CircuitBreakerState = 'closed' | 'open' | 'half_open'
export type KVError = { kind: 'timeout' | 'breaker_open' | 'error'; message: string }
export type KVResult<T> = { ok: true; value: T | null; cacheHit: boolean } | { ok: false; error: KVError }

type KvLike = Pick<typeof realKv, 'get' | 'set'>
type BreakerConfig = { maxConsecutiveTimeouts: number; cooldownMs: number; halfOpenMaxRequests: number; timeoutMs: number; maxRetries: number }
export type PriceKvClientOptions = Partial<BreakerConfig> & { maxConcurrent?: number; ttlSeconds?: number; kv?: KvLike; now?: () => number; random?: () => number; maxLookupsPerToken?: number; historicalReadOnly?: boolean }
export type PriceKvStats = { totalCalls: number; remoteGets: number; remoteSets: number; cacheHits: number; coalesced: number; timeouts: number; breakerSkips: number; cappedLookups: number }

const DEFAULTS: BreakerConfig = { maxConsecutiveTimeouts: 5, cooldownMs: 5000, halfOpenMaxRequests: 2, timeoutMs: 300, maxRetries: 0 }
const DEFAULT_MAX_CONCURRENT = 8
const DEFAULT_TTL_SECONDS = 45
const DEFAULT_MAX_LOOKUPS_PER_TOKEN = 2

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }
function priceKey(label: 'primary' | 'chain-aware-historical', token: string, chain: string, timestamp: number): string {
  return label === 'primary' ? `v2:price:primary:${chain}:${token.toLowerCase()}:${timestamp}` : `v2:price:chain-aware-historical:${chain}:${token.toLowerCase()}:${timestamp}`
}
function tokenCapKey(token: string, chain: string): string { return `${chain}:${token.toLowerCase()}` }

class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active++
    try { return await fn() } finally { this.active--; this.queue.shift()?.() }
  }
}

class CircuitBreaker {
  state: CircuitBreakerState = 'closed'
  consecutiveTimeouts = 0
  private nextRetryAt = 0
  private currentCooldownMs: number
  private halfOpenInFlight = 0
  constructor(private readonly cfg: BreakerConfig, private readonly now: () => number) { this.currentCooldownMs = cfg.cooldownMs }
  allow(key: string): boolean {
    if (this.state === 'open') {
      if (this.now() < this.nextRetryAt) {
        console.warn('kv_disabled_for_request', { reason: 'circuit_breaker_open', key, state: this.state, nextRetryAt: this.nextRetryAt, currentCooldownMs: this.currentCooldownMs })
        return false
      }
      this.transition('half_open', { key })
    }
    if (this.state === 'half_open') {
      if (this.halfOpenInFlight >= this.cfg.halfOpenMaxRequests) {
        console.warn('kv_disabled_for_request', { reason: 'circuit_breaker_half_open_probe_limit', key, state: this.state })
        return false
      }
      this.halfOpenInFlight++
    }
    return true
  }
  success(): void { if (this.state === 'half_open') this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1); this.consecutiveTimeouts = 0; this.currentCooldownMs = this.cfg.cooldownMs; if (this.state !== 'closed') this.transition('closed') }
  timeout(): void { if (this.state === 'half_open') this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1); this.consecutiveTimeouts++; const threshold = this.state === 'half_open' ? Math.max(2, this.cfg.maxConsecutiveTimeouts) : this.cfg.maxConsecutiveTimeouts; if (this.consecutiveTimeouts >= threshold) this.open() }
  failure(): void { if (this.state === 'half_open') this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1) }
  private open(): void { const cooldown = this.currentCooldownMs; this.nextRetryAt = this.now() + cooldown; this.currentCooldownMs = Math.min(this.currentCooldownMs * 2, this.cfg.cooldownMs * 16); this.transition('open', { consecutiveTimeouts: this.consecutiveTimeouts, cooldownMs: cooldown }) }
  private transition(to: CircuitBreakerState, extra: Record<string, unknown> = {}): void { const from = this.state; this.state = to; console.warn('kv_circuit_breaker_transition', { from, to, consecutiveTimeouts: this.consecutiveTimeouts, ...extra }) }
}

export type RecoveryLaneStats = {
  recoveryLookupsRequested: number
  recoveryCacheHits: number
  recoveryLiveFetches: number
  recoveryCappedLookups: number
}

export class RequestPriceKvClient {
  private readonly cfg: BreakerConfig
  private readonly kv: KvLike
  private readonly semaphore: Semaphore
  private readonly ttlSeconds: number
  private readonly random: () => number
  private readonly readBreaker: CircuitBreaker
  private readonly writeBreaker: CircuitBreaker
  private readonly memory = new Map<string, number | null>()
  private readonly inFlight = new Map<string, Promise<number | null>>()
  private readonly lookupsByToken = new Map<string, number>()
  readonly stats: PriceKvStats = { totalCalls: 0, remoteGets: 0, remoteSets: 0, cacheHits: 0, coalesced: 0, timeouts: 0, breakerSkips: 0, cappedLookups: 0 }
  readonly maxLookupsPerToken: number
  private readonly historicalReadOnly: boolean
  // RECOVERY LANE, DISCLOSED (provider-call-audit follow-up task, confirmed root cause of
  // "recovery attempted 40 candidates but made zero live source attempts"): the normal per-token
  // cap (`lookupsByToken`/`maxLookupsPerToken`, shared with the main pricingAtTime pass) is a
  // SHARED, cumulative-per-request budget — by the time pnlReconciliation's recovery pass runs
  // (well after the main pass has already spent that budget on the same tokens), every recovery
  // candidate's lookup was silently short-circuited by `cappedLookups` BEFORE resolveMiss (and
  // therefore before the injected fetcher, detailed or plain) ever ran — a real, confirmed
  // starvation, not a wiring gap. This lane gives recovery its OWN separate, bounded allowance —
  // reusing the exact same `memory` cache, `inFlight` coalescing map, breaker, and `priceKey()`
  // format as the normal lane (so a recovery lookup for a token the main pass already resolved
  // still hits the shared cache/coalesces with an in-flight normal-pass call for free) — but never
  // touching or being touched by `lookupsByToken`/`maxLookupsPerToken`, so neither budget can starve
  // the other.
  private recoveryLookupsBudget: number | null = null
  private recoveryLookupsUsed = 0
  readonly recoveryStats: RecoveryLaneStats = { recoveryLookupsRequested: 0, recoveryCacheHits: 0, recoveryLiveFetches: 0, recoveryCappedLookups: 0 }
  constructor(options: PriceKvClientOptions = {}) {
    this.cfg = { ...DEFAULTS, ...options }
    this.kv = options.kv ?? realKv
    this.semaphore = new Semaphore(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS
    this.random = options.random ?? Math.random
    const now = options.now ?? Date.now
    this.readBreaker = new CircuitBreaker(this.cfg, now)
    this.writeBreaker = new CircuitBreaker(this.cfg, now)
    this.maxLookupsPerToken = options.maxLookupsPerToken ?? DEFAULT_MAX_LOOKUPS_PER_TOKEN
    this.historicalReadOnly = options.historicalReadOnly ?? false
  }
  async getPricePrimary(token: string, chain: string, timestamp: number, fetcher: PriceSourceFn): Promise<number | null> { return this.getWithCache(priceKey('primary', token, chain, timestamp), token, chain, timestamp, fetcher) }
  async getPriceHistorical(token: string, chain: string, timestamp: number, fetcher: PriceSourceFn): Promise<number | null> { return this.getWithCache(priceKey('chain-aware-historical', token, chain, timestamp), token, chain, timestamp, fetcher, this.historicalReadOnly) }
  async setPriceHistorical(token: string, chain: string, timestamp: number, price: number): Promise<void> { await this.setRemote(priceKey('chain-aware-historical', token, chain, timestamp), price) }
  wrapPriceSource(fetcher: PriceSourceFn, label: 'primary' | 'chain-aware-historical'): PriceSourceFn { return (token, chain, timestamp) => label === 'primary' ? this.getPricePrimary(token, chain, timestamp, fetcher) : this.getPriceHistorical(token, chain, timestamp, fetcher) }
  logStats(label = 'price_kv_client_stats'): void { console.warn(label, { ...this.stats }) }

  // RECOVERY LANE ENTRY POINT, DISCLOSED: `maxRecoveryLookups` is the total live-fetch allowance for
  // THIS client's ENTIRE recovery pass (derived by the caller strictly from its own
  // MAX_RECOVERY_ATTEMPTS budget — never unlimited) — set on the FIRST call and reused for every
  // later call in the same pass; later calls' own `maxRecoveryLookups` argument is ignored once set,
  // so every caller in one recovery pass must agree on the same real budget (they do — one
  // recoverPrices() call computes it once). A cache hit or in-flight coalesce consumes ZERO of this
  // allowance — only a genuine new live fetch does.
  async getPriceRecovery(token: string, chain: string, timestamp: number, fetcher: PriceSourceFn, label: 'primary' | 'chain-aware-historical', maxRecoveryLookups: number): Promise<number | null> {
    if (this.recoveryLookupsBudget === null) this.recoveryLookupsBudget = Math.max(0, maxRecoveryLookups)
    const key = priceKey(label, token, chain, timestamp)
    this.recoveryStats.recoveryLookupsRequested++
    this.stats.totalCalls++
    if (this.memory.has(key)) { this.stats.cacheHits++; this.recoveryStats.recoveryCacheHits++; return this.memory.get(key) ?? null }
    const existing = this.inFlight.get(key)
    if (existing) { this.stats.coalesced++; this.recoveryStats.recoveryCacheHits++; return existing }
    // IN-FLIGHT REGISTERED BEFORE THE REMOTE CHECK, DISCLOSED: so concurrent identical recovery
    // calls still coalesce onto this exact promise regardless of whether it resolves via a remote
    // KV hit or a real live fetch.
    const promise = this.resolveRecoveryMiss(key, token, chain, timestamp, fetcher, label).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, promise)
    return promise
  }

  // A REMOTE KV HIT NEVER CONSUMES THE RECOVERY BUDGET, DISCLOSED (this task's explicit "a cache hit
  // must not consume recovery live-fetch allowance" requirement): unlike the normal lane's
  // resolveMiss (which has no budget concept at all), this checks the remote KV FIRST, for free —
  // the bounded allowance is spent ONLY on an actual real call to the injected `fetcher`, never on
  // asking the shared, already-real cache whether it happens to already know the answer.
  private async resolveRecoveryMiss(key: string, token: string, chain: string, timestamp: number, fetcher: PriceSourceFn, label: 'primary' | 'chain-aware-historical'): Promise<number | null> {
    const readOnly = label === 'chain-aware-historical' && this.historicalReadOnly
    const cached = await this.getRemote<number>(key)
    if (cached.ok && cached.value !== null) { this.memory.set(key, cached.value); this.recoveryStats.recoveryCacheHits++; return cached.value }
    if (this.recoveryLookupsUsed >= this.recoveryLookupsBudget!) { this.recoveryStats.recoveryCappedLookups++; return null }
    this.recoveryLookupsUsed += 1
    this.recoveryStats.recoveryLiveFetches += 1
    const price = await fetcher(token, chain as Parameters<PriceSourceFn>[1], timestamp)
    const safe = typeof price === 'number' && Number.isFinite(price) ? price : null
    this.memory.set(key, safe)
    if (safe !== null && !readOnly) await this.setRemote(key, safe)
    return safe
  }

  private async getWithCache(key: string, token: string, chain: string, timestamp: number, fetcher: PriceSourceFn, readOnly = false): Promise<number | null> {
    this.stats.totalCalls++
    if (this.memory.has(key)) { this.stats.cacheHits++; return this.memory.get(key) ?? null }
    const existing = this.inFlight.get(key)
    if (existing) { this.stats.coalesced++; return existing }
    const tk = tokenCapKey(token, chain); const prior = this.lookupsByToken.get(tk) ?? 0
    if (prior >= this.maxLookupsPerToken) { this.stats.cappedLookups++; return null }
    this.lookupsByToken.set(tk, prior + 1)
    const promise = this.resolveMiss(key, token, chain, timestamp, fetcher, readOnly).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, promise)
    return promise
  }
  private async resolveMiss(key: string, token: string, chain: string, timestamp: number, fetcher: PriceSourceFn, readOnly: boolean): Promise<number | null> {
    const cached = await this.getRemote<number>(key)
    if (cached.ok && cached.value !== null) { this.memory.set(key, cached.value); return cached.value }
    const price = await fetcher(token, chain as Parameters<PriceSourceFn>[1], timestamp)
    const safe = typeof price === 'number' && Number.isFinite(price) ? price : null
    this.memory.set(key, safe)
    if (safe !== null && !readOnly) await this.setRemote(key, safe)
    return safe
  }
  private async getRemote<T>(key: string): Promise<KVResult<T>> {
    if (!this.readBreaker.allow(key)) { this.stats.breakerSkips++; return { ok: false, error: { kind: 'breaker_open', message: 'read breaker open' } } }
    return this.semaphore.run(async () => { this.stats.remoteGets++; const result = await this.withRetries(() => this.kv.get<T>(key), `get:${key}`, this.readBreaker); return result === undefined ? { ok: false, error: { kind: 'timeout', message: 'kv read failed' } } : { ok: true, value: result, cacheHit: result !== null } })
  }
  private async setRemote(key: string, value: number): Promise<void> {
    if (!this.writeBreaker.allow(key)) { this.stats.breakerSkips++; return }
    await this.semaphore.run(async () => { this.stats.remoteSets++; try { await this.withTimeout(this.kv.set(key, value, { ex: this.ttlSeconds })) } catch {} })
  }
  private async withRetries<T>(attempt: () => Promise<T>, label: string, breaker: CircuitBreaker): Promise<T | undefined> {
    for (let i = 0; i <= this.cfg.maxRetries; i++) {
      try { const value = await this.withTimeout(attempt()); breaker.success(); return value } catch (err) {
        const isTimeout = err instanceof Error && err.message === 'kv_timeout'
        if (isTimeout) { this.stats.timeouts++; breaker.timeout() } else breaker.failure()
        console[isTimeout ? 'warn' : 'error'](isTimeout ? 'kv_timeout_safe' : 'KV ERROR', { label, attempt: i + 1, totalAttempts: this.cfg.maxRetries + 1, ...(isTimeout ? {} : { error: err instanceof Error ? err.message : String(err) }) })
        if (i < this.cfg.maxRetries) await sleep((100 * 2 ** i) + Math.floor(this.random() * 50))
      }
    }
    return undefined
  }
  private withTimeout<T>(promise: Promise<T>): Promise<T> { let timer: ReturnType<typeof setTimeout>; const timeout = new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('kv_timeout')), this.cfg.timeoutMs) }); return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) }
}

export function createRequestPriceKvClient(options?: PriceKvClientOptions): RequestPriceKvClient { return new RequestPriceKvClient(options) }
