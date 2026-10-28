// DETERMINISTIC GECKOTERMINAL RATE-LIMIT SIMULATOR (P0 incident). Test-only.
//
// Virtual clock, a fake GeckoTerminal that enforces a fixed per-minute window shared by every server
// instance (it limits by egress IP, like the real public API), a fake Upstash store that can fail,
// a fake DexScreener, and N simulated users on Token Scanner or Base Radar.
//
// "after" sends every GeckoTerminal request through the real guard (createGeckoTerminalGuard), one
// guard per simulated server instance. "before" replays the previous call pattern: immediate retry
// of any non-404 failure, chain probe before the scan cache, viewport preloading. The per-scan call
// sequence matches the real /api/token handler; tests/geckoterminal-token-route.test.ts measures the
// handler itself (1 vs 12 GeckoTerminal requests for one rate-limited scan).

import { createGeckoTerminalGuard, newGtRequestStats, runWithGtStats, type GeckoTerminalGuard, type GtRequestStats } from '../../lib/server/providers/geckoTerminalGuard'

// ── Virtual clock ────────────────────────────────────────────────────────────────────────────────
export class Clock {
  t = 0
  private seq = 0
  private timers: Array<{ at: number; seq: number; resolve: () => void }> = []
  sleep = (ms: number) => new Promise<void>((resolve) => { this.timers.push({ at: this.t + Math.max(0, ms), seq: ++this.seq, resolve }) })
  async run(untilMs: number): Promise<void> {
    for (;;) {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
      if (this.timers.length === 0) return
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq)
      const next = this.timers[0]
      if (next.at > untilMs) return
      this.timers.shift()
      this.t = next.at
      next.resolve()
    }
  }
}

/** Seeded PRNG (mulberry32) so every run is identical. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

export type SimConfig = {
  variant: 'before' | 'after'
  /** GeckoTerminal requests allowed per 60s window across all instances. */
  gtLimitPerMinute: number
  /** Whether a 429 carries Retry-After (seconds until the window resets). */
  retryAfter: boolean
  /** KV (Upstash) available. When false, caches and the cooldown are per instance. */
  kvUp: boolean
  /** DexScreener returns market data for every token. */
  dexscreenerUp: boolean
  instances: number
  seed: number
}
export const DEFAULT_CONFIG: Omit<SimConfig, 'variant'> = { gtLimitPerMinute: 30, retryAfter: true, kvUp: true, dexscreenerUp: true, instances: 4, seed: 7 }

const GT_LATENCY_MS = 300
const DS_LATENCY_MS = 200
/** Other providers in a scan (GoldRush, RPC, Honeypot, …) run in parallel with the main pools/token reads. */
const OTHER_PROVIDERS_MS = 1_500
const SCAN_CACHE_TTL_MS = 45_000
/** after: degraded scans are cached briefly, with their rate-limited label. */
const DEGRADED_CACHE_TTL_MS = 15_000
const ENRICH_CACHE_TTL_MS = 60_000
const BROWSER_WARM_TTL_MS = 60_000
const HOVER_INTENT_MS = 150

export type SimMetrics = {
  gtRequests: number
  gt429: number
  gtAvoided: number
  scans: number
  scanCacheHits: number
  scanLatencies: number[]
  drawerLatencies: number[]
  marketUnavailable: number
  /** Scans whose pools/market data came from GeckoTerminal itself (not a fallback). */
  primaryMarketOk: number
  /** Drawer opens whose enrichment data was degraded by a GeckoTerminal 429 or cooldown. */
  drawerDegraded: number
  degradedServedFromCache: number
  /** Degraded results served from a cache with no rate-limited label (shown as healthy data). */
  degradedServedUnlabelled: number
  dexscreenerCalls: number
  chartRequests: number
  chartUpstream: number
}

export function summarize(m: SimMetrics) {
  const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] }
  return {
    gtRequests: m.gtRequests, gt429: m.gt429, gtAvoided: m.gtAvoided,
    rateLimitedShare: m.gtRequests ? Math.round((m.gt429 / m.gtRequests) * 1000) / 10 : 0,
    scans: m.scans, scanCacheHitRate: m.scans ? Math.round((m.scanCacheHits / m.scans) * 1000) / 10 : 0,
    scanP50: pct(m.scanLatencies, 50), scanP95: pct(m.scanLatencies, 95),
    drawerOpens: m.drawerLatencies.length, drawerP50: pct(m.drawerLatencies, 50), drawerP95: pct(m.drawerLatencies, 95),
    primaryMarketRate: m.scans ? Math.round((m.primaryMarketOk / m.scans) * 1000) / 10 : 0, drawerDegraded: m.drawerDegraded, marketUnavailable: m.marketUnavailable, degradedServedFromCache: m.degradedServedFromCache, degradedServedUnlabelled: m.degradedServedUnlabelled, dexscreenerCalls: m.dexscreenerCalls,
    chartRequests: m.chartRequests, chartUpstream: m.chartUpstream,
  }
}

type ScanResult = { latencyMs: number; marketAvailable: boolean; degraded: boolean; cacheHit: boolean; labelled?: boolean }

export function createWorld(config: SimConfig) {
  const clock = new Clock()
  const random = rng(config.seed)
  const m: SimMetrics = { gtRequests: 0, gt429: 0, gtAvoided: 0, scans: 0, scanCacheHits: 0, scanLatencies: [], drawerLatencies: [], marketUnavailable: 0, primaryMarketOk: 0, drawerDegraded: 0, degradedServedUnlabelled: 0, degradedServedFromCache: 0, dexscreenerCalls: 0, chartRequests: 0, chartUpstream: 0 }

  // Fake GeckoTerminal: one fixed 60s window shared by every instance (same egress IP pool).
  let windowStart = 0, windowCount = 0
  const gtFetch = async (url: string): Promise<Response> => {
    m.gtRequests++
    if (clock.t - windowStart >= 60_000) { windowStart = clock.t - ((clock.t - windowStart) % 60_000); windowCount = 0 }
    windowCount++
    const limited = windowCount > config.gtLimitPerMinute
    await clock.sleep(GT_LATENCY_MS)
    if (limited) {
      m.gt429++
      const resetSec = Math.max(1, Math.ceil((windowStart + 60_000 - clock.t) / 1000))
      return new Response('{}', { status: 429, headers: config.retryAfter ? { 'retry-after': String(resetSec) } : {} })
    }
    if (/\/pools\?/.test(url) && !/networks\/base\//.test(url)) return Response.json({ data: [] })
    return Response.json({ data: [{ id: 'pool' }] })
  }

  // Fake Upstash: shared map; down means every call throws.
  const kvStore = new Map<string, unknown>()
  const kv = { configured: () => true, get: async <T>(k: string) => { if (!config.kvUp) throw new Error('kv down'); return (kvStore.get(k) as T) ?? null }, set: async (k: string, v: unknown) => { if (!config.kvUp) throw new Error('kv down'); kvStore.set(k, structuredClone(v)) } }
  const guards: GeckoTerminalGuard[] = Array.from({ length: config.instances }, () => createGeckoTerminalGuard({
    kv, now: () => clock.t, sleep: clock.sleep, random, log: () => undefined,
    fetch: (async (input: RequestInfo | URL) => gtFetch(String(input))) as typeof fetch,
  }))

  // Scan cache: Upstash-backed (shared) when KV is up, else the per-instance memory fallback.
  type ScanCacheEntry = { until: number; degraded: boolean; marketAvailable: boolean; labelled: boolean }
  const sharedScanCache = new Map<string, ScanCacheEntry>()
  const instanceScanCache = guards.map(() => new Map<string, ScanCacheEntry>())
  const scanCacheFor = (inst: number) => (config.kvUp ? sharedScanCache : instanceScanCache[inst])
  // Base Radar enrichment: in-memory per instance, as in the route.
  const enrichCache = guards.map(() => new Map<string, { until: number; result: ScanResult }>())
  const enrichInFlight = guards.map(() => new Map<string, Promise<ScanResult>>())
  let rr = 0
  const pickInstance = () => (rr++ % config.instances)

  // "before": the old fetchGeckoTerminalWithRetry — any non-404 failure retried at once.
  const legacyGt = async (url: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await gtFetch(url)
      if (res.ok) return true
      if (res.status === 404) return false
    }
    return false
  }
  const guardedGt = async (inst: number, url: string): Promise<boolean> => (await guards[inst].fetch(url, {}, { route: 'token' })).ok
  const dexscreener = async (): Promise<boolean> => { m.dexscreenerCalls++; await clock.sleep(DS_LATENCY_MS); return config.dexscreenerUp }

  /** One /api/token scan on `inst`, following the real handler's GeckoTerminal sequence. */
  async function scan(inst: number, token: string): Promise<ScanResult> {
    const start = clock.t
    m.scans++
    const pools = (chain: string) => `https://api.geckoterminal.com/api/v2/networks/${chain}/tokens/${token}/pools?page=1`
    const info = `https://api.geckoterminal.com/api/v2/networks/base/tokens/${token}`
    const cache = scanCacheFor(inst)
    const finish = (r: Omit<ScanResult, 'latencyMs'>): ScanResult => {
      const out = { ...r, latencyMs: clock.t - start }
      m.scanLatencies.push(out.latencyMs)
      if (!out.marketAvailable) m.marketUnavailable++
      if (!out.degraded) m.primaryMarketOk++
      if (out.cacheHit) { m.scanCacheHits++; if (out.degraded) { m.degradedServedFromCache++; if (!out.labelled) m.degradedServedUnlabelled++ } }
      return out
    }
    if (config.variant === 'before') {
      const probeOk = await legacyGt(pools('base'))           // chain probe before the cache read
      const hit = cache.get(token)
      if (hit && hit.until > clock.t) { await clock.sleep(20); return finish({ marketAvailable: hit.marketAvailable, degraded: hit.degraded, cacheHit: true, labelled: hit.labelled }) }
      let poolsOk = probeOk
      if (!probeOk) {
        await Promise.all(['eth', 'bsc', 'robinhood'].map((c) => legacyGt(pools(c))))
        const [again] = await Promise.all([legacyGt(pools('base')), legacyGt(info), clock.sleep(OTHER_PROVIDERS_MS)])
        poolsOk = again
      } else await Promise.all([legacyGt(info), clock.sleep(OTHER_PROVIDERS_MS)])
      const marketAvailable = poolsOk || await dexscreener()
      const degraded = !poolsOk
      cache.set(token, { until: clock.t + SCAN_CACHE_TTL_MS, degraded, marketAvailable, labelled: false })
      return finish({ marketAvailable, degraded, cacheHit: false })
    }
    const hit = cache.get(token)
    if (hit && hit.until > clock.t) { await clock.sleep(20); return finish({ marketAvailable: hit.marketAvailable, degraded: hit.degraded, cacheHit: true, labelled: hit.labelled }) }
    const stats: GtRequestStats = newGtRequestStats()
    return runWithGtStats(async () => {
      let poolsOk = await guardedGt(inst, pools('base'))
      if (!poolsOk) {
        await Promise.all(['eth', 'bsc', 'robinhood'].map((c) => guardedGt(inst, pools(c))))
        const [again] = await Promise.all([guardedGt(inst, pools('base')), guardedGt(inst, info), clock.sleep(OTHER_PROVIDERS_MS)])
        poolsOk = again
      } else await Promise.all([guardedGt(inst, info), clock.sleep(OTHER_PROVIDERS_MS)])
      const marketAvailable = poolsOk || await dexscreener()
      const degraded = stats.rateLimited > 0 || stats.avoided > 0
      m.gtAvoided += stats.avoided
      cache.set(token, { until: clock.t + (degraded ? DEGRADED_CACHE_TTL_MS : SCAN_CACHE_TTL_MS), degraded, marketAvailable, labelled: true })
      return finish({ marketAvailable, degraded, cacheHit: false })
    }, stats)
  }

  /** /api/base-radar/enrichment: per-instance cache and in-flight dedupe, then a full scan. */
  function enrich(token: string): Promise<ScanResult> {
    const inst = pickInstance()
    const cached = enrichCache[inst].get(token)
    if (cached && cached.until > clock.t) return clock.sleep(15).then(() => ({ latencyMs: 15, marketAvailable: cached.result.marketAvailable, degraded: cached.result.degraded, cacheHit: true, labelled: config.variant === 'after' }))
    const pending = enrichInFlight[inst].get(token)
    if (pending) return pending
    const p = scan(inst, token).then((r) => { enrichCache[inst].set(token, { until: clock.t + (r.degraded && config.variant === 'after' ? DEGRADED_CACHE_TTL_MS : ENRICH_CACHE_TTL_MS), result: r }); enrichInFlight[inst].delete(token); return r })
    enrichInFlight[inst].set(token, p)
    return p
  }

  /** /api/token/chart-candles timeframe switch: one GeckoTerminal OHLCV read. */
  async function chartRequest(): Promise<boolean> {
    m.chartRequests++
    const url = 'https://api.geckoterminal.com/api/v2/networks/base/pools/0xpool/ohlcv/hour?aggregate=1'
    const before = m.gtRequests
    const ok = config.variant === 'before' ? (await gtFetch(url)).ok : (await guards[pickInstance()].fetch(url, {}, { route: 'chart_candles', retry: false })).ok
    m.chartUpstream += m.gtRequests - before
    return ok
  }

  return { clock, random, m, scan: (token: string) => scan(pickInstance(), token), enrich, chartRequest, guards }
}

// ── Scenarios ────────────────────────────────────────────────────────────────────────────────────
const tokenAddr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`

/** N users scan within the first minute: the same token, or each user two different tokens. */
export async function tokenScannerScenario(config: SimConfig, users: number, sameToken: boolean): Promise<SimMetrics> {
  const w = createWorld(config)
  for (let u = 0; u < users; u++) {
    const startAt = Math.floor(w.random() * 60_000)
    void (async () => {
      await w.clock.sleep(startAt)
      await w.scan(sameToken ? tokenAddr(1) : tokenAddr(1000 + u * 2))
      if (!sameToken) { await w.clock.sleep(30_000); await w.scan(tokenAddr(1001 + u * 2)) }
    })()
  }
  await w.clock.run(10 * 60_000)
  return w.m
}

/** One token rescanned at fixed times: cache expiry behaviour. */
export async function cacheExpiryScenario(config: SimConfig): Promise<SimMetrics> {
  const w = createWorld(config)
  for (const at of [0, 30_000, 44_000, 46_000, 90_000, 200_000]) void (async () => { await w.clock.sleep(at); await w.scan(tokenAddr(7)) })()
  await w.clock.run(10 * 60_000)
  return w.m
}

/**
 * Base Radar browsing for 5 minutes. Each user loads the feed (14 rows in the preload margin), scrolls
 * to 26 and then 40 rows, sees the feed refresh every 120s, sweeps the pointer across 6 rows (60ms
 * each), rests on 2 rows per minute (1.5s), and opens 1 drawer per minute after resting 800ms on it.
 * All users see the same 40-token feed.
 */
export async function baseRadarScenario(config: SimConfig, users: number): Promise<SimMetrics> {
  const w = createWorld(config)
  const feed = Array.from({ length: 40 }, (_, i) => tokenAddr(500 + i))
  for (let u = 0; u < users; u++) {
    const offset = Math.floor(w.random() * 60_000)
    const warm = new Map<string, { until: number; done: Promise<ScanResult> }>()
    const preload = (token: string) => {
      const existing = warm.get(token)
      if (existing && existing.until > w.clock.t) return existing.done
      const done = w.enrich(token)
      warm.set(token, { until: w.clock.t + BROWSER_WARM_TTL_MS, done })
      return done
    }
    const visible = (count: number) => { if (config.variant === 'before') for (const t of feed.slice(0, count)) void preload(t) }
    const hover = async (token: string, dwellMs: number) => {
      if (config.variant === 'before') { void preload(token); return }
      if (dwellMs >= HOVER_INTENT_MS) { await w.clock.sleep(HOVER_INTENT_MS); void preload(token) }
    }
    const openDrawer = async (token: string) => {
      const t0 = w.clock.t
      const r = await preload(token)
      w.m.drawerLatencies.push(w.clock.t - t0)
      if (r.degraded) { w.m.drawerDegraded++; if (!r.labelled && config.variant === 'before') w.m.degradedServedUnlabelled++ }
    }
    void (async () => {
      await w.clock.sleep(offset)
      const sessionStart = w.clock.t
      visible(14)
      void (async () => { await w.clock.sleep(20_000); visible(26); await w.clock.sleep(40_000); visible(40) })()
      void (async () => { for (let r = 1; r <= 2; r++) { await w.clock.sleep(120_000); visible(14) } })()
      for (let minute = 0; minute < 5; minute++) {
        const base = sessionStart + minute * 60_000
        await w.clock.sleep(Math.max(0, base + 5_000 - w.clock.t))
        for (let s = 0; s < 6; s++) { void hover(feed[(minute * 7 + s) % 40], 60); await w.clock.sleep(60) }
        await w.clock.sleep(10_000)
        for (const k of [0, 1]) { const tok = feed[(minute * 5 + k * 3 + u) % 40]; void hover(tok, 1_500); await w.clock.sleep(1_500) }
        await w.clock.sleep(10_000)
        const target = feed[(minute * 11 + u * 3) % 40]
        void hover(target, 800)
        await w.clock.sleep(800)
        await openDrawer(target)
      }
    })()
  }
  await w.clock.run(8 * 60_000)
  return w.m
}

/** A 429 opens the cooldown; chart requests during it must not reach GeckoTerminal. */
export async function chartDuringCooldownScenario(config: SimConfig): Promise<SimMetrics> {
  const w = createWorld({ ...config, gtLimitPerMinute: 2 })
  void (async () => {
    for (let i = 0; i < 3; i++) await w.scan(tokenAddr(900 + i))
    for (let i = 0; i < 10; i++) { await w.chartRequest(); await w.clock.sleep(1_000) }
  })()
  await w.clock.run(5 * 60_000)
  return w.m
}
