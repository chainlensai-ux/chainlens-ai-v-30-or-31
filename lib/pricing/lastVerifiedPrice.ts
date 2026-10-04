// lib/pricing/lastVerifiedPrice.ts — the last VERIFIED current price per exact (chainId, token), kept longer
// than the current-price cache so a later scan of the same wallet still knows what a holding was worth.
//
// Why (repeated-scan portfolio-value audit): the current-price cache keeps an illiquid token's price for 30s,
// so a scan a few minutes later has no memory of it. When that token's lookup then fails transiently (an
// http_429 / fetch error / timeout) or is not even selected (it competed for 8 exploratory slots on raw unit
// count), the dominant holding silently disappears from the total. This store gives the pricing pass two
// bounded, evidence-backed uses for the previous price:
//   1. LOOKUP PRIORITY — prior price × current balance makes a holding "previously material", so it is
//      looked up in the material lane instead of competing with spam (never a value by itself);
//   2. STALE_VERIFIED REUSE — only after a TRANSIENT failure, only within STALE_VERIFIED_PRICE_MAX_AGE_MS of
//      the price's ORIGINAL observedAt, only with identical decimals, and always labelled `stale_verified`.
// observedAt is never rewritten: a reuse never writes back, and a record only replaces an older one.

import { kv as vercelKv } from '@vercel/kv'
import { getKvCircuitBreakerState } from '@/lib/server/cache/tokenCache'

export const LAST_VERIFIED_PRICE_VERSION = 'v1'
/** Conservative reuse window, measured from the price's original observation. */
export const STALE_VERIFIED_PRICE_MAX_AGE_MS = 60 * 60 * 1000
/** How long a record is remembered (lookup priority / discontinuity evidence only — never a value past the reuse window). */
export const LAST_VERIFIED_PRICE_MEMORY_MS = 24 * 60 * 60 * 1000

export type LastVerifiedPrice = {
  v: typeof LAST_VERIFIED_PRICE_VERSION
  chainId: number
  tokenAddress: string
  priceUsd: number
  /** The source that actually observed the price (never 'shared_cache'). */
  source: string
  observedAt: number
  confidence: 'high' | 'medium'
  /** The decimals the priced quantity was computed with — a reuse requires the same decimals. */
  decimals: number
}

export type LastVerifiedPriceL2 = {
  mget: (keys: string[]) => Promise<Array<unknown | null>>
  set: (key: string, value: LastVerifiedPrice, ttlSeconds: number) => Promise<void>
}

const lc = (s: string) => s.toLowerCase()
const finitePositive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0

export function lastVerifiedPriceKey(chainId: number, tokenAddress: string): string {
  return `last-verified-price:${LAST_VERIFIED_PRICE_VERSION}:${chainId}:${lc(tokenAddress)}`
}

/** Validates a stored record for exactly (chainId, token); anything malformed, foreign or past memory is rejected. */
export function parseLastVerifiedPrice(raw: unknown, chainId: number, tokenAddress: string, now: number): LastVerifiedPrice | null {
  const r = raw as Partial<LastVerifiedPrice> | null
  if (!r || typeof r !== 'object' || r.v !== LAST_VERIFIED_PRICE_VERSION) return null
  if (r.chainId !== chainId || typeof r.tokenAddress !== 'string' || lc(r.tokenAddress) !== lc(tokenAddress)) return null
  if (!finitePositive(r.priceUsd) || typeof r.source !== 'string' || r.source === '' || r.source === 'shared_cache') return null
  if (r.confidence !== 'high' && r.confidence !== 'medium') return null
  if (typeof r.observedAt !== 'number' || !Number.isFinite(r.observedAt) || r.observedAt > now) return null
  if (typeof r.decimals !== 'number' || !Number.isInteger(r.decimals) || r.decimals < 0 || r.decimals > 36) return null
  if (now - r.observedAt > LAST_VERIFIED_PRICE_MEMORY_MS) return null
  return r as LastVerifiedPrice
}

export type LastVerifiedPriceStore = {
  /** One batched L2 read for the keys L1 does not hold. Never throws. */
  prefetch: (items: ReadonlyArray<{ chainId: number; tokenAddress: string }>) => Promise<void>
  get: (chainId: number, tokenAddress: string) => LastVerifiedPrice | null
  /**
   * Keeps the record with the NEWER observedAt; an equal/older observation is a no-op (no re-stamp, no write).
   * Returns THIS write's outcome (never rejects), so a caller can await exactly its own writes.
   */
  record: (entry: Omit<LastVerifiedPrice, 'v'>) => Promise<LastVerifiedWriteOutcome>
  /** Awaits every pending write of this store (all callers). Prefer awaiting the promises `record` returned. */
  flush: () => Promise<void>
}

export type LastVerifiedWriteOutcome = 'persisted' | 'failed' | 'l1_only' | 'skipped'

export type LastVerifiedPersistenceSummary = { queued: number; persisted: number; failed: number; pending: number }

/** Upper bound on awaiting a scan's last-verified writes: the KV write timeout plus slack (never indefinite). */
export const LAST_VERIFIED_FLUSH_MAX_MS = 1_250

/**
 * Awaits the given writes (one scan's own), bounded by `maxMs`. Never throws; a write still running at the bound
 * is reported as `pending` and left to finish on its own (it already has its own KV timeout).
 */
export async function awaitLastVerifiedWrites(writes: ReadonlyArray<Promise<LastVerifiedWriteOutcome>>, maxMs = LAST_VERIFIED_FLUSH_MAX_MS): Promise<LastVerifiedPersistenceSummary> {
  const settled: LastVerifiedWriteOutcome[] = []
  const tracked = writes.map((w) => w.then((o) => { settled.push(o) }, () => { settled.push('failed') }))
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([Promise.all(tracked), new Promise<void>((r) => { timer = setTimeout(r, Math.max(0, maxMs)) })])
  if (timer) clearTimeout(timer)
  const count = (o: LastVerifiedWriteOutcome) => settled.filter((x) => x === o).length
  return { queued: writes.length, persisted: count('persisted'), failed: count('failed'), pending: writes.length - settled.length }
}

export function createLastVerifiedPriceStore(opts: { l2?: LastVerifiedPriceL2 | null; now?: () => number } = {}): LastVerifiedPriceStore {
  const now = opts.now ?? Date.now
  const l1 = new Map<string, LastVerifiedPrice>()
  const pending = new Set<Promise<void>>()
  const MAX_ENTRIES = 20_000
  return {
    async prefetch(items) {
      const l2 = opts.l2
      if (!l2) return
      const t = now()
      const todo = new Map<string, { chainId: number; tokenAddress: string }>()
      for (const it of items) {
        const key = lastVerifiedPriceKey(it.chainId, it.tokenAddress)
        if (!todo.has(key) && !l1.has(key)) todo.set(key, it)
      }
      if (todo.size === 0) return
      const keys = [...todo.keys()]
      let values: Array<unknown | null>
      try {
        values = await l2.mget(keys)
      } catch {
        return // non-fatal: no memory this scan
      }
      keys.forEach((key, i) => {
        const it = todo.get(key)!
        const parsed = parseLastVerifiedPrice(values[i] ?? null, it.chainId, it.tokenAddress, t)
        const existing = l1.get(key)
        if (parsed && (!existing || parsed.observedAt > existing.observedAt)) l1.set(key, parsed)
      })
    },
    get(chainId, tokenAddress) {
      const key = lastVerifiedPriceKey(chainId, tokenAddress)
      const entry = l1.get(key)
      if (!entry) return null
      const valid = parseLastVerifiedPrice(entry, chainId, tokenAddress, now())
      if (!valid) l1.delete(key)
      return valid
    },
    record(entry) {
      const value: LastVerifiedPrice = { v: LAST_VERIFIED_PRICE_VERSION, ...entry, tokenAddress: lc(entry.tokenAddress) }
      if (!parseLastVerifiedPrice(value, entry.chainId, entry.tokenAddress, now())) return Promise.resolve('skipped')
      const key = lastVerifiedPriceKey(entry.chainId, entry.tokenAddress)
      const existing = l1.get(key)
      if (existing && existing.observedAt >= value.observedAt) return Promise.resolve('skipped')
      l1.set(key, value)
      if (l1.size > MAX_ENTRIES) {
        const oldest = l1.keys().next().value
        if (oldest !== undefined) l1.delete(oldest)
      }
      const l2 = opts.l2
      if (!l2) return Promise.resolve('l1_only')
      const ttlSeconds = Math.max(1, Math.ceil((value.observedAt + LAST_VERIFIED_PRICE_MEMORY_MS - now()) / 1000))
      let w: Promise<LastVerifiedWriteOutcome>
      try {
        w = l2.set(key, value, ttlSeconds).then((): LastVerifiedWriteOutcome => 'persisted', (): LastVerifiedWriteOutcome => 'failed')
      } catch {
        w = Promise.resolve('failed')
      }
      const tracked: Promise<void> = w.then(() => {}).finally(() => { pending.delete(tracked) })
      pending.add(tracked)
      return w
    },
    async flush() {
      await Promise.all([...pending])
    },
  }
}

// ─── production instance: process L1 + the existing Vercel KV (same adapter conventions as currentPriceSources) ──
const L2_READ_TIMEOUT_MS = 250
const L2_WRITE_TIMEOUT_MS = 1_000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([p, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('kv_timeout')), ms) })]).finally(() => clearTimeout(timer))
}

const vercelKvLastVerifiedL2: LastVerifiedPriceL2 = {
  async mget(keys) {
    if (keys.length === 0) return []
    if (getKvCircuitBreakerState().state === 'open') throw new Error('kv_circuit_open')
    return await withTimeout(vercelKv.mget<unknown[]>(...keys), L2_READ_TIMEOUT_MS)
  },
  async set(key, value, ttlSeconds) {
    if (getKvCircuitBreakerState().state === 'open') throw new Error('kv_circuit_open')
    await withTimeout(vercelKv.set(key, value, { ex: ttlSeconds }), L2_WRITE_TIMEOUT_MS)
  },
}

let defaultStore: LastVerifiedPriceStore | null = null
export function defaultLastVerifiedPriceStore(): LastVerifiedPriceStore {
  if (!defaultStore) {
    const kvConfigured = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
    defaultStore = createLastVerifiedPriceStore({ l2: kvConfigured ? vercelKvLastVerifiedL2 : null })
  }
  return defaultStore
}

// ─── failure classification ──────────────────────────────────────────────────────────────────────────
// TRANSIENT: the source could not answer (rate limit, 5xx, network, timeout, a budget/coverage miss) — no new
// evidence about the market. PERMANENT: the source answered and says there is no usable market for this exact
// token (no pair, wrong pair / identity mismatch, zero or too-thin liquidity, unparseable price, unverified
// decimals). Anything unrecognised is treated as NOT transient (no reuse).
export type PriceFailureKind = 'transient' | 'permanent' | 'not_attempted' | 'unknown'

const PERMANENT_REASONS = new Set([
  'no_matching_pair', 'no_pair_meets_minimum_liquidity', 'zero_liquidity', 'liquidity_below_minimum', 'unparseable_price',
  'no_pool_found', 'no_valid_pool_for_token', 'pool_does_not_contain_token', 'decimals_unverified', 'malformed_pool_state',
  'unsupported_chain', 'unverified_chain_for_dexscreener', 'no_price', 'no_route', 'quote_asset_unpriced', 'rejected',
])

export function classifyPriceFailureReason(reason: string | null | undefined): PriceFailureKind {
  if (!reason) return 'unknown'
  if (PERMANENT_REASONS.has(reason)) return 'permanent'
  if (/^http_(408|425|429|5\d\d)$/.test(reason)) return 'transient'
  if (/^(fetch_error|error)(:|$)/.test(reason)) return 'transient'
  // A holding that was never looked up (`not_looked_up_budget`) has NO failure evidence at all — no fresh lookup
  // happened — so it is never transient. A budget/timeout reason returned BY an attempted source path is.
  if (reason === 'not_looked_up_budget') return 'not_attempted'
  if (/timeout|budget_exhausted|^kv_/.test(reason)) return 'transient'
  return 'unknown'
}
