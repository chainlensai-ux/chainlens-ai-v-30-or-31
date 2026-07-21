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
