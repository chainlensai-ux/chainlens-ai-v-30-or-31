// GECKOTERMINAL GUARD — one shared request path for GeckoTerminal calls (P0 rate-limit incident).
//
// GeckoTerminal's public API refuses requests per source IP. Every Vercel deployment (Production and
// Preview) sends from the same shared egress pool, so its quota is one budget for the whole app, but
// until now only Base Radar's discovery coordinated through Redis. Token Scanner, enrichment and chart
// candles retried 429s immediately and kept calling while Radar was cooling down.
//
// This module gives every covered caller the same rules:
//   - A 429 is never retried. It opens a cooldown shared through Upstash (the existing redis client):
//     the provider's Retry-After when given (capped at 10 min), else 10s doubling per consecutive 429
//     up to 30s. The cooldown applies to GeckoTerminal only — nothing here touches other providers.
//   - During a cooldown no request is sent. The caller gets a synthetic 429 response (header
//     `x-chainlens-gt-cooldown: 1`), which every caller already handles as "rate limited", so callers
//     fall back exactly as they do for a real 429. No market value is ever invented.
//   - Network errors and 5xx get one retry after a short random delay, unless a cooldown opened meanwhile.
//   - If Redis is unconfigured or failing, the cooldown is kept per instance and every log line says
//     `coordination: "local_only"` so the loss of global coordination is visible.
//   - Log lines carry route, endpoint type, status, Retry-After and cooldown only: never URLs (which
//     can carry API keys via GECKO_BASE_URL), headers, tokens or wallet data.

import { AsyncLocalStorage } from 'node:async_hooks'
import { redis, redisConfigured } from '../cache/redisClient'
import { parseRetryAfterMs } from '../../radarDiscoveryResilience'

export const GT_COOLDOWN_KEY = 'provider:geckoterminal:cooldown:v1'
export const GT_COOLDOWN_HEADER = 'x-chainlens-gt-cooldown'
export const GT_COOLDOWN_BASE_MS = 10_000
// Without Retry-After the pause doubles from 10s and stops at 30s: in the simulator, longer self-imposed
// pauses left provider windows unused (fewer scans got GeckoTerminal data) without reducing 429s further.
export const GT_COOLDOWN_MAX_MS = 30_000
export const GT_RETRY_AFTER_CAP_MS = 10 * 60_000
/** A 429 more than this long after the previous one starts a new streak. */
export const GT_STREAK_RESET_MS = 10 * 60_000
/** How long an instance trusts its last Redis read before checking again. */
export const GT_KV_READ_MEMO_MS = 1_000
const RETRY_DELAY_MIN_MS = 300
const RETRY_DELAY_JITTER_MS = 500

export type GtCooldownRecord = { until: number; streak: number; setAt: number; retryAfterMs: number | null; route: string }
export type GtCoordination = 'distributed' | 'local_only'
export type GtCooldownState = { active: boolean; until: number; remainingMs: number; coordination: GtCoordination }

/** Per-request counters, read by routes for their own diagnostics. */
export type GtRequestStats = { upstreamCalls: number; rateLimited: number; avoided: number; retries: number; upstreamErrors: number; coordination: GtCoordination | null; cache?: 'hit' | 'miss' | 'bypass' }

export type GtKv = { configured(): boolean; get<T>(key: string): Promise<T | null>; set(key: string, value: unknown, opts: { ex: number }): Promise<void> }
export type GtDeps = { kv: GtKv; fetch: typeof fetch; now: () => number; sleep: (ms: number) => Promise<void>; random: () => number; log: (line: string) => void }

const defaultDeps: GtDeps = {
  kv: { configured: () => redisConfigured(), get: (key) => redis.get(key), set: (key, value, opts) => redis.set(key, value, opts) },
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
  log: (line) => console.info(line),
}
const stats = new AsyncLocalStorage<GtRequestStats>()

export function newGtRequestStats(): GtRequestStats {
  return { upstreamCalls: 0, rateLimited: 0, avoided: 0, retries: 0, upstreamErrors: 0, coordination: null }
}

/** Runs `fn` with per-request GeckoTerminal counters available through currentGtStats(). */
export function runWithGtStats<T>(fn: () => Promise<T>, s: GtRequestStats = newGtRequestStats()): Promise<T> {
  return stats.run(s, fn)
}
export function currentGtStats(): GtRequestStats | null { return stats.getStore() ?? null }
const bump = (key: Exclude<keyof GtRequestStats, 'coordination' | 'cache'>) => { const s = stats.getStore(); if (s) s[key] += 1 }

/** Endpoint type for logs: never the URL, which can contain a key or a wallet address. */
export function classifyGtEndpoint(url: string): string {
  const path = (() => { try { return new URL(url).pathname } catch { return '' } })()
  if (/\/ohlcv\//.test(path)) return 'pool_ohlcv'
  if (/\/trades$/.test(path)) return 'pool_trades'
  if (/\/tokens\/[^/]+\/pools$/.test(path)) return 'token_pools'
  if (/\/tokens\/[^/]+\/info$/.test(path)) return 'token_info'
  if (/\/tokens\/multi\//.test(path)) return 'tokens_multi'
  if (/\/tokens\/[^/]+$/.test(path)) return 'token'
  if (/\/new_pools$/.test(path)) return 'new_pools'
  if (/\/trending_pools$/.test(path)) return 'trending_pools'
  if (/\/pools\/multi\//.test(path)) return 'pools_multi'
  if (/\/pools\/[^/]+$/.test(path)) return 'pool'
  if (/\/pools$/.test(path)) return 'pools'
  if (/\/search\//.test(path)) return 'search'
  return 'other'
}

function isRecord(v: unknown): v is GtCooldownRecord {
  return Boolean(v) && typeof v === 'object' && typeof (v as GtCooldownRecord).until === 'number' && typeof (v as GtCooldownRecord).streak === 'number'
}

/** The response every caller receives instead of a request during a cooldown. Carries no market data. */
export function geckoTerminalCooldownResponse(state: Pick<GtCooldownState, 'remainingMs'>): Response {
  return new Response(JSON.stringify({ errors: [{ status: '429', title: 'GeckoTerminal requests paused by ChainLens cooldown' }] }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': String(Math.max(1, Math.ceil(state.remainingMs / 1000))), [GT_COOLDOWN_HEADER]: '1' },
  })
}

export function isGeckoTerminalCooldownResponse(res: Response | null | undefined): boolean {
  return res?.headers.get(GT_COOLDOWN_HEADER) === '1'
}

export type GtFetchOptions = {
  /** Calling route, for logs and metrics (e.g. 'token', 'radar', 'chart_candles'). */
  route: string
  /** Request timeout; aborts the attempt. */
  timeoutMs?: number
  /** One bounded retry for network errors and 5xx (default true). 429 and other 4xx are never retried. */
  retry?: boolean
}

export type GeckoTerminalGuard = {
  cooldown(): Promise<GtCooldownState>
  recordRateLimit(input: { route: string; endpoint: string; retryAfterHeader: string | null }): Promise<{ cooldownMs: number; streak: number; coordination: GtCoordination }>
  fetch(url: string, init: RequestInit | undefined, options: GtFetchOptions): Promise<Response>
}

/**
 * One guard per server instance. Its local record mirrors the shared Redis cooldown; with Redis
 * unavailable it is the only record, so coordination falls back to this instance alone.
 */
export function createGeckoTerminalGuard(deps: GtDeps): GeckoTerminalGuard {
  let local: GtCooldownRecord | null = null
  let lastKvReadAt = -Infinity
  let lastCoordination: GtCoordination = 'local_only'
  const emit = (record: Record<string, unknown>) => {
    try { deps.log(JSON.stringify({ provider: 'geckoterminal', ...record })) } catch { /* logging never breaks a request */ }
  }

  async function cooldown(): Promise<GtCooldownState> {
    const now = deps.now()
    const fromLocal = (coordination: GtCoordination): GtCooldownState => {
      const until = local && local.until > now ? local.until : 0
      return { active: until > now, until, remainingMs: Math.max(0, until - now), coordination }
    }
    if (local && local.until > now) return fromLocal(lastCoordination)
    if (!deps.kv.configured()) { lastCoordination = 'local_only'; return fromLocal('local_only') }
    if (now - lastKvReadAt < GT_KV_READ_MEMO_MS) return fromLocal(lastCoordination)
    lastKvReadAt = now
    try {
      const shared = await deps.kv.get<unknown>(GT_COOLDOWN_KEY)
      lastCoordination = 'distributed'
      if (isRecord(shared) && (!local || shared.until > local.until || shared.setAt > local.setAt)) local = shared
      return fromLocal('distributed')
    } catch {
      lastCoordination = 'local_only'
      return fromLocal('local_only')
    }
  }

  async function recordRateLimit(input: { route: string; endpoint: string; retryAfterHeader: string | null }) {
    // Refresh from Redis first so the streak continues across instances.
    lastKvReadAt = -Infinity
    await cooldown()
    const now = deps.now()
    const retryAfterMs = parseRetryAfterMs(input.retryAfterHeader, now)
    const previous = local
    const streak = previous && now - previous.setAt < GT_STREAK_RESET_MS ? previous.streak + 1 : 1
    const escalated = Math.min(GT_COOLDOWN_MAX_MS, GT_COOLDOWN_BASE_MS * 2 ** (streak - 1))
    const cooldownMs = retryAfterMs != null ? Math.min(GT_RETRY_AFTER_CAP_MS, Math.max(retryAfterMs, 1_000)) : escalated
    const until = Math.max(now + cooldownMs, previous?.until ?? 0)
    local = { until, streak, setAt: now, retryAfterMs, route: input.route }
    let coordination: GtCoordination = 'local_only'
    if (deps.kv.configured()) {
      try {
        await deps.kv.set(GT_COOLDOWN_KEY, local, { ex: Math.ceil((until - now + GT_STREAK_RESET_MS) / 1000) })
        coordination = 'distributed'
      } catch { coordination = 'local_only' }
    }
    lastCoordination = coordination
    emit({ evt: 'gt_cooldown_opened', route: input.route, endpoint: input.endpoint, status: 429, retryAfterSec: retryAfterMs != null ? Math.round(retryAfterMs / 1000) : null, cooldownSec: Math.round((until - now) / 1000), streak, coordination })
    return { cooldownMs: until - now, streak, coordination }
  }

  async function guardedFetch(url: string, init: RequestInit = {}, options: GtFetchOptions): Promise<Response> {
    const endpoint = classifyGtEndpoint(url)
    const s = stats.getStore()
    const skip = async (): Promise<Response | null> => {
      const state = await cooldown()
      if (s) s.coordination = state.coordination
      if (!state.active) return null
      bump('avoided')
      emit({ evt: 'gt_call_avoided', route: options.route, endpoint, cooldownRemainingSec: Math.ceil(state.remainingMs / 1000), coordination: state.coordination })
      return geckoTerminalCooldownResponse(state)
    }
    const attempt = async (): Promise<Response> => {
      bump('upstreamCalls')
      const signal = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : init.signal
      return deps.fetch(url, { ...init, headers: init.headers ?? { Accept: 'application/json;version=20230302' }, ...(signal ? { signal } : {}) })
    }
    const pause = () => deps.sleep(RETRY_DELAY_MIN_MS + Math.floor(deps.random() * RETRY_DELAY_JITTER_MS))
    for (let n = 0; n < 2; n++) {
      const skipped = await skip()
      if (skipped) return skipped
      let res: Response
      try {
        res = await attempt()
      } catch (error) {
        bump('upstreamErrors')
        const retrying = n === 0 && options.retry !== false
        emit({ evt: 'gt_upstream_error', route: options.route, endpoint, status: null, errorName: error instanceof Error ? error.name : 'unknown_error', retrying })
        if (!retrying) throw error
        bump('retries')
        await pause()
        continue
      }
      if (res.status === 429) {
        bump('rateLimited')
        await recordRateLimit({ route: options.route, endpoint, retryAfterHeader: res.headers.get('retry-after') })
        return res
      }
      if (res.status >= 500) {
        bump('upstreamErrors')
        const retrying = n === 0 && options.retry !== false
        emit({ evt: 'gt_upstream_error', route: options.route, endpoint, status: res.status, retrying })
        if (!retrying) return res
        bump('retries')
        await res.body?.cancel().catch(() => undefined)
        await pause()
        continue
      }
      return res
    }
    // Unreachable: the second iteration always returns or throws.
    throw new Error('geckoterminal_fetch_exhausted')
  }

  return { cooldown, recordRateLimit, fetch: guardedFetch }
}

let defaultGuard = createGeckoTerminalGuard(defaultDeps)

/** Tests only: rebuild this process's guard with replaced clock, fetch, KV, sleep, random or log. */
export function __setGeckoTerminalGuardForTest(overrides: Partial<GtDeps> | null): void {
  defaultGuard = createGeckoTerminalGuard(overrides ? { ...defaultDeps, ...overrides } : defaultDeps)
}

/** Current cooldown. Reads Redis at most once per GT_KV_READ_MEMO_MS per instance; never throws. */
export function geckoTerminalCooldown(): Promise<GtCooldownState> { return defaultGuard.cooldown() }

/** Opens or extends the shared cooldown after a real 429. */
export function recordGeckoTerminalRateLimit(input: { route: string; endpoint: string; retryAfterHeader: string | null }) { return defaultGuard.recordRateLimit(input) }

/**
 * fetch() for GeckoTerminal. Same contract as fetch: resolves with the response (including 4xx/5xx)
 * and rejects on network failure, so callers keep their own error handling.
 */
export function geckoTerminalFetch(url: string, init: RequestInit = {}, options: GtFetchOptions): Promise<Response> { return defaultGuard.fetch(url, init, options) }

/** One line per request with the route's GeckoTerminal usage; skipped for requests that never touched it. */
export function logGtRequestSummary(route: string, s: GtRequestStats | null, log: (line: string) => void = (line) => console.info(line)): void {
  if (!s || (s.upstreamCalls === 0 && s.avoided === 0 && s.cache == null)) return
  try { log(JSON.stringify({ provider: 'geckoterminal', evt: 'gt_request_summary', route, cache: s.cache ?? null, upstreamCalls: s.upstreamCalls, rateLimited: s.rateLimited, avoided: s.avoided, retries: s.retries, upstreamErrors: s.upstreamErrors, coordination: s.coordination })) } catch { /* never breaks a request */ }
}
