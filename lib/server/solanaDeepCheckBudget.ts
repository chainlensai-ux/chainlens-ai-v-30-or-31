// SOLANA DEEP-CHECK BUDGET (P0 cost-safety fix).
//
// Deep Creator / Deep Cluster checks call Helius Enhanced Transactions (100 credits per call). They
// used to be request flags with no plan gate, and Pro/Elite token scans are unlimited, so Helius
// spend had no ceiling. Every deep check now has to RESERVE its worst-case credits before any
// provider call is made:
//
//  1. Per-user lock — one deep check in flight per user (parallel requests get `in_progress`).
//  2. Per-user daily credit budget by plan (UTC day).
//  3. Global daily credit budget across all users (HELIUS_DEEP_DAILY_CREDIT_CAP).
//
// Reservations are atomic increments, so concurrent requests cannot both squeeze under a limit. After
// the scan the unused part of the reservation (worst case minus what the scan's ledger actually
// billed) is refunded, so cached or short reads cost the user only what they really used.
//
// Shared state lives in Vercel KV. Without KV (local dev, tests) an in-process store is used. On a
// Vercel deployment with no KV, or when KV errors, deep checks are REFUSED (`budget_unavailable`):
// a per-instance counter would let users bypass the limits across instances.

import { kv } from '@vercel/kv'
import type { UserPlan } from '@/lib/pricingPlans'
import { SOLANA_DEEP_CLUSTER_CHECK_MAX_CREDITS, SOLANA_DEEP_CREATOR_CHECK_MAX_CREDITS } from './solanaProviders.ts'
import { HeliusCreditLedger, type HeliusDeepCache } from './solana/heliusCredits.ts'
import { getTokenCache, setTokenCache } from './cache/tokenCache.ts'

export type SolanaDeepCheckKind = 'creator' | 'cluster'

/** Full Deep Cluster Checks a user can run per UTC day; the credit budget is this × the cluster worst case. */
export const SOLANA_DEEP_CLUSTER_CHECKS_PER_DAY: Record<UserPlan, number> = { free: 2, pro: 15, elite: 40 }

export const SOLANA_DEEP_DAILY_CREDITS: Record<UserPlan, number> = {
  free: SOLANA_DEEP_CLUSTER_CHECKS_PER_DAY.free * SOLANA_DEEP_CLUSTER_CHECK_MAX_CREDITS,
  pro: SOLANA_DEEP_CLUSTER_CHECKS_PER_DAY.pro * SOLANA_DEEP_CLUSTER_CHECK_MAX_CREDITS,
  elite: SOLANA_DEEP_CLUSTER_CHECKS_PER_DAY.elite * SOLANA_DEEP_CLUSTER_CHECK_MAX_CREDITS,
}

/** Default all-users ceiling on deep-check Helius credits per UTC day (≈600k/month at most). */
export const SOLANA_DEEP_GLOBAL_DAILY_CREDITS_DEFAULT = 20_000

// Longer than the token route's maxDuration (300s), so a crashed request's lock always expires on its own.
export const SOLANA_DEEP_LOCK_TTL_SECONDS = 330
const DAY_KEY_TTL_SECONDS = 2 * 24 * 60 * 60

export function solanaDeepCheckMaxCredits(kind: SolanaDeepCheckKind): number {
  return kind === 'cluster' ? SOLANA_DEEP_CLUSTER_CHECK_MAX_CREDITS : SOLANA_DEEP_CREATOR_CHECK_MAX_CREDITS
}

function planCredits(plan: UserPlan): number {
  return Object.prototype.hasOwnProperty.call(SOLANA_DEEP_DAILY_CREDITS, plan) ? SOLANA_DEEP_DAILY_CREDITS[plan] : SOLANA_DEEP_DAILY_CREDITS.free
}

export function solanaDeepGlobalDailyCredits(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.HELIUS_DEEP_DAILY_CREDIT_CAP)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : SOLANA_DEEP_GLOBAL_DAILY_CREDITS_DEFAULT
}

// ── Store ────────────────────────────────────────────────────────────────────────────────────────
export interface DeepBudgetStore {
  incrBy(key: string, by: number, ttlSeconds: number): Promise<number>
  decrBy(key: string, by: number): Promise<void>
  get(key: string): Promise<number>
  /** SET key value NX EX ttl. True when the key was set. */
  setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>
  /** Deletes the key only while it still holds `value`. */
  delIfEquals(key: string, value: string): Promise<void>
}

export function createMemoryDeepBudgetStore(now: () => number = Date.now): DeepBudgetStore {
  const counters = new Map<string, number>()
  const locks = new Map<string, { value: string; until: number }>()
  return {
    async incrBy(key, by) { const n = (counters.get(key) ?? 0) + by; counters.set(key, n); return n },
    async decrBy(key, by) { counters.set(key, (counters.get(key) ?? 0) - by) },
    async get(key) { return counters.get(key) ?? 0 },
    async setNx(key, value, ttlSeconds) {
      const held = locks.get(key)
      if (held && held.until > now()) return false
      locks.set(key, { value, until: now() + ttlSeconds * 1000 })
      return true
    },
    async delIfEquals(key, value) { if (locks.get(key)?.value === value) locks.delete(key) },
  }
}

const kvStore: DeepBudgetStore = {
  async incrBy(key, by, ttlSeconds) {
    const n = await kv.incrby(key, by)
    if (n === by) await kv.expire(key, ttlSeconds)
    return n
  },
  async decrBy(key, by) { await kv.decrby(key, by) },
  async get(key) { const n = await kv.get<number>(key); return typeof n === 'number' && Number.isFinite(n) ? n : 0 },
  async setNx(key, value, ttlSeconds) { return (await kv.set(key, value, { nx: true, ex: ttlSeconds })) === 'OK' },
  async delIfEquals(key, value) { if ((await kv.get<string>(key)) === value) await kv.del(key) },
}

const processStore = createMemoryDeepBudgetStore()
let storeOverride: DeepBudgetStore | null = null

function kvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
}

/** The shared store, or null when only a per-instance store is available on a real deployment. */
function activeStore(): DeepBudgetStore | null {
  if (storeOverride) return storeOverride
  if (kvConfigured()) return kvStore
  return process.env.VERCEL_ENV ? null : processStore
}

export function __setDeepBudgetStoreForTest(store: DeepBudgetStore | null): void {
  storeOverride = store
}

// ── Keys ─────────────────────────────────────────────────────────────────────────────────────────
function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}
function nextUtcMidnight(nowMs: number): string {
  const d = new Date(nowMs)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString()
}
const userKey = (day: string, userId: string) => `solana-deep:credits:user:${day}:${userId}`
const globalKey = (day: string) => `solana-deep:credits:global:${day}`
const lockKey = (userId: string) => `solana-deep:lock:${userId}`

// ── Reserve / settle ─────────────────────────────────────────────────────────────────────────────
export type SolanaDeepRefusal = 'in_progress' | 'user_daily_limit' | 'global_daily_limit' | 'budget_unavailable'

export type SolanaDeepBudgetSnapshot = {
  plan: UserPlan
  limitCredits: number
  usedCredits: number
  remainingCredits: number
  /** How many more of each check fit in what is left today (worst-case cost). */
  clusterChecksRemaining: number
  creatorChecksRemaining: number
  resetsAt: string
}

export type SolanaDeepReservation = {
  kind: SolanaDeepCheckKind
  reservedCredits: number
  /** Sized to the reservation; pass to the scan so it can never bill more than was reserved. */
  ledger: HeliusCreditLedger
  /** Refunds what the ledger did not spend and releases the lock. Safe to call more than once. */
  settle(): Promise<{ reservedCredits: number; spentCredits: number; refundedCredits: number }>
}

export type SolanaDeepReserveResult =
  | { ok: true; reservation: SolanaDeepReservation }
  | { ok: false; reason: SolanaDeepRefusal; snapshot: SolanaDeepBudgetSnapshot | null }

export async function reserveSolanaDeepCheck(input: {
  plan: UserPlan
  userId: string
  kind: SolanaDeepCheckKind
  now?: () => number
  env?: Record<string, string | undefined>
}): Promise<SolanaDeepReserveResult> {
  const now = input.now ?? Date.now
  const store = activeStore()
  if (!store) {
    console.warn('[solana-deep-budget] refused: no shared budget store (KV not configured on this deployment)')
    return { ok: false, reason: 'budget_unavailable', snapshot: null }
  }
  const cost = solanaDeepCheckMaxCredits(input.kind)
  const day = utcDay(now())
  const uKey = userKey(day, input.userId)
  const gKey = globalKey(day)
  const lKey = lockKey(input.userId)
  const token = `${now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const userLimit = planCredits(input.plan)
  const globalLimit = solanaDeepGlobalDailyCredits(input.env)

  let locked = false
  let userCharged = false
  let globalCharged = false
  try {
    locked = await store.setNx(lKey, token, SOLANA_DEEP_LOCK_TTL_SECONDS)
    if (!locked) return { ok: false, reason: 'in_progress', snapshot: await snapshotSolanaDeepBudget(input.plan, input.userId, { now, store }) }

    const userTotal = await store.incrBy(uKey, cost, DAY_KEY_TTL_SECONDS)
    userCharged = true
    if (userTotal > userLimit) {
      await store.decrBy(uKey, cost); userCharged = false
      await store.delIfEquals(lKey, token); locked = false
      return { ok: false, reason: 'user_daily_limit', snapshot: await snapshotSolanaDeepBudget(input.plan, input.userId, { now, store }) }
    }
    const globalTotal = await store.incrBy(gKey, cost, DAY_KEY_TTL_SECONDS)
    globalCharged = true
    if (globalTotal > globalLimit) {
      await store.decrBy(gKey, cost); globalCharged = false
      await store.decrBy(uKey, cost); userCharged = false
      await store.delIfEquals(lKey, token); locked = false
      return { ok: false, reason: 'global_daily_limit', snapshot: await snapshotSolanaDeepBudget(input.plan, input.userId, { now, store }) }
    }
  } catch (err) {
    // Undo whatever part of the reservation went through; then refuse (fail closed).
    try {
      if (globalCharged) await store.decrBy(gKey, cost)
      if (userCharged) await store.decrBy(uKey, cost)
      if (locked) await store.delIfEquals(lKey, token)
    } catch { /* counters expire with the day; the lock expires with its TTL */ }
    console.warn('[solana-deep-budget] refused: budget store error', err instanceof Error ? err.message : String(err))
    return { ok: false, reason: 'budget_unavailable', snapshot: null }
  }

  const ledger = new HeliusCreditLedger(cost)
  let settled: { reservedCredits: number; spentCredits: number; refundedCredits: number } | null = null
  return {
    ok: true,
    reservation: {
      kind: input.kind,
      reservedCredits: cost,
      ledger,
      async settle() {
        if (settled) return settled
        const spent = Math.min(cost, ledger.spentCredits)
        const refund = cost - spent
        settled = { reservedCredits: cost, spentCredits: spent, refundedCredits: refund }
        try {
          if (refund > 0) {
            await store.decrBy(uKey, refund)
            await store.decrBy(gKey, refund)
          }
        } catch { /* a failed refund only over-counts; never under-counts */ }
        try { await store.delIfEquals(lKey, token) } catch { /* lock expires with its TTL */ }
        return settled
      },
    },
  }
}

export async function snapshotSolanaDeepBudget(
  plan: UserPlan,
  userId: string,
  opts: { now?: () => number; store?: DeepBudgetStore } = {},
): Promise<SolanaDeepBudgetSnapshot | null> {
  const now = opts.now ?? Date.now
  const store = opts.store ?? activeStore()
  if (!store) return null
  const limit = planCredits(plan)
  let used = 0
  try { used = Math.max(0, await store.get(userKey(utcDay(now()), userId))) } catch { return null }
  const remaining = Math.max(0, limit - used)
  return {
    plan,
    limitCredits: limit,
    usedCredits: used,
    remainingCredits: remaining,
    clusterChecksRemaining: Math.floor(remaining / SOLANA_DEEP_CLUSTER_CHECK_MAX_CREDITS),
    creatorChecksRemaining: Math.floor(remaining / SOLANA_DEEP_CREATOR_CHECK_MAX_CREDITS),
    resetsAt: nextUtcMidnight(now()),
  }
}

export function solanaDeepRefusalMessage(reason: SolanaDeepRefusal, plan: UserPlan): string {
  switch (reason) {
    case 'in_progress': return 'A deep check is already running for your account. Wait for it to finish, then try again.'
    case 'user_daily_limit': return `Daily Solana deep-check limit reached on ${plan} (${SOLANA_DEEP_CLUSTER_CHECKS_PER_DAY[plan] ?? SOLANA_DEEP_CLUSTER_CHECKS_PER_DAY.free} Deep Cluster Checks or the equivalent per day). It resets at 00:00 UTC.`
    case 'global_daily_limit': return 'Solana deep checks are paused for today because the shared daily provider budget is used up. They resume at 00:00 UTC.'
    case 'budget_unavailable': return 'Solana deep checks are temporarily unavailable because usage limits cannot be verified right now. Try again shortly.'
  }
}

/** Cross-scan cache for immutable deep-check reads (shared KV cache; fails open to a miss). */
export const solanaDeepCheckCache: HeliusDeepCache = {
  get: (key) => getTokenCache(key),
  set: async (key, value, ttlSeconds) => { await setTokenCache(key, value, ttlSeconds) },
}

/** Which deep check (if any) a token-scan request body asks for. Mirrors the route's own flag rules. */
export function solanaDeepCheckKindFromBody(body: unknown): SolanaDeepCheckKind | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (String(b.chain ?? 'base').toLowerCase() !== 'solana') return null
  if (b.deepCluster === true) return 'cluster'
  if (b.deepDev === true) return 'creator'
  return null
}
