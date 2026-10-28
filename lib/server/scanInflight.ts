// SHARED SCAN DEDUPE (GeckoTerminal P0 follow-up). A full Token Scanner scan costs ~12 GoldRush requests,
// a Honeypot simulation and ~24 RPC calls. When several users (or Base Radar drawers) ask for the same
// token at once, only the first should run it; the others wait briefly for its result to land in the
// shared scan cache and are served from there through the normal cache path (same validation, plan gate
// and labels). Coordination uses the existing Upstash client (get/set only, so a narrow race can let a
// second scan through — bounded, never blocking); without Upstash it is per instance.
//
// Waiting is bounded: a waiter gives up after SCAN_INFLIGHT_MAX_WAIT_MS and runs its own scan, so a
// crashed or slow leader can never stall anyone for longer than that.

import { redis, redisConfigured } from './cache/redisClient'

export const SCAN_INFLIGHT_TTL_S = 20
export const SCAN_INFLIGHT_MAX_WAIT_MS = 6_000
export const SCAN_INFLIGHT_POLL_MS = 300

type Kv = { configured(): boolean; get<T>(key: string): Promise<T | null>; set(key: string, value: unknown, opts: { ex: number }): Promise<void> }
export type ScanInflightDeps = { kv: Kv; now: () => number; sleep: (ms: number) => Promise<void> }
const defaultDeps: ScanInflightDeps = {
  kv: { configured: () => redisConfigured(), get: (k) => redis.get(k), set: (k, v, o) => redis.set(k, v, o) },
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}
const local = new Map<string, { owner: string; until: number }>()
type Marker = { owner: string; until: number }
const isMarker = (v: unknown): v is Marker => Boolean(v) && typeof (v as Marker).owner === 'string' && typeof (v as Marker).until === 'number'

/**
 * If another request is already scanning `cacheKey`, waits (bounded) for `tryServe` to find its result
 * in the cache and returns that. Otherwise marks this request as the scanner and returns null; the caller
 * runs the scan and calls `release` once its result is cached (the marker also expires on its own).
 */
export async function awaitOrClaimScan<T>(cacheKey: string, owner: string, tryServe: () => Promise<T | null>, deps: ScanInflightDeps = defaultDeps): Promise<{ served: T | null; waitedMs: number; claimed: boolean }> {
  const key = `tokenScan:inflight:${cacheKey}`
  const start = deps.now()
  const read = async (): Promise<Marker | null> => {
    const l = local.get(key)
    if (l && l.until > deps.now() && l.owner !== owner) return l
    if (!deps.kv.configured()) return null
    try { const v = await deps.kv.get<unknown>(key); return isMarker(v) && v.until > deps.now() && v.owner !== owner ? v : null } catch { return null }
  }
  let marker = await read()
  if (marker) {
    while (deps.now() - start < SCAN_INFLIGHT_MAX_WAIT_MS) {
      await deps.sleep(SCAN_INFLIGHT_POLL_MS)
      const served = await tryServe()
      if (served) return { served, waitedMs: deps.now() - start, claimed: false }
      marker = await read()
      if (!marker) break // the other scan finished without a cacheable result, or expired
    }
  }
  const claim = { owner, until: deps.now() + SCAN_INFLIGHT_TTL_S * 1000 }
  local.set(key, claim)
  if (deps.kv.configured()) { try { await deps.kv.set(key, claim, { ex: SCAN_INFLIGHT_TTL_S }) } catch { /* per-instance only */ } }
  return { served: null, waitedMs: deps.now() - start, claimed: true }
}

/** Ends this request's claim so waiters stop polling. Never throws. */
export async function releaseScanClaim(cacheKey: string, owner: string, deps: ScanInflightDeps = defaultDeps): Promise<void> {
  const key = `tokenScan:inflight:${cacheKey}`
  const l = local.get(key)
  if (l?.owner === owner) local.delete(key)
  if (!deps.kv.configured()) return
  try {
    const v = await deps.kv.get<unknown>(key)
    if (isMarker(v) && v.owner === owner) await deps.kv.set(key, { owner: '', until: 0 }, { ex: 1 })
  } catch { /* the marker expires on its own */ }
}

/** Tests only. */
export function __resetScanInflightForTest(): void { local.clear() }
