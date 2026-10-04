// lib/walletScan/valuationSnapshot.ts — the last valuation of a wallet's material holdings, and the
// `[portfolio-value-discontinuity-audit]` that compares a new scan against it.
//
// Repeated-scan portfolio-value audit: a ~$900 drop between two scans of the same wallet was one dominant
// holding (ClawBank, 94% of value) whose BALANCE was unchanged but whose PRICE was not re-established. That is
// lost valuation evidence, not a lost asset — the audit classifies it explicitly so the two can never be
// confused again. Per wallet, monotonic by scan start: an older scan finishing late never replaces a newer one.

import { kv as vercelKv } from '@vercel/kv'
import { getKvCircuitBreakerState } from '@/lib/server/cache/tokenCache'
import type { PricedHolding } from '@/lib/engine/modules/pricing/types'

export const VALUATION_SNAPSHOT_VERSION = 'v1'
const SNAPSHOT_TTL_SECONDS = 7 * 24 * 60 * 60
/** Holdings kept per snapshot: the most valuable ones (enough to cover every ≥10% holding). */
const MAX_SNAPSHOT_HOLDINGS = 25
export const DISCONTINUITY_SHARE_THRESHOLD = 0.10

export type ValuationSnapshotHolding = {
  chainId: number
  tokenAddress: string
  symbol: string
  quantity: number
  priceUsd: number
  priceSource: string | null
  priceStatus: 'verified' | 'stale_verified'
  priceObservedAt: number | null
  valueUsd: number
}

export type WalletValuationSnapshot = {
  v: typeof VALUATION_SNAPSHOT_VERSION
  wallet: string
  /** Monotonic identity: the scan's start time (a later-started scan always wins). */
  scanStartedAt: number
  /** Fresh + stale-verified supported value of every valued holding in that scan. */
  supportedSubtotalUsd: number
  holdings: ValuationSnapshotHolding[]
}

export function valuationSnapshotKey(wallet: string): string {
  return `wallet-valuation-snapshot:${VALUATION_SNAPSHOT_VERSION}:${wallet.toLowerCase()}`
}

const holdingKey = (chainId: number, token: string) => `${chainId}:${token.toLowerCase()}`

/** Builds the snapshot from a pricing pass (fresh or stale-verified values only — never an unpriced guess). */
export function buildValuationSnapshot(wallet: string, scanStartedAt: number, priced: ReadonlyArray<PricedHolding>): WalletValuationSnapshot {
  const byKey = new Map<string, ValuationSnapshotHolding>()
  let subtotal = 0
  for (const p of priced) {
    const fresh = p.valueUsd != null && p.priceUsd != null
    const stale = !fresh && p.staleVerifiedValueUsd != null && p.staleVerifiedPriceUsd != null
    if (!fresh && !stale) continue
    const valueUsd = fresh ? p.valueUsd! : p.staleVerifiedValueUsd!
    const key = holdingKey(p.chainId, p.tokenAddress)
    if (byKey.has(key)) continue // one entry per token (duplicates are not double counted)
    subtotal += valueUsd
    byKey.set(key, {
      chainId: p.chainId, tokenAddress: p.tokenAddress.toLowerCase(), symbol: p.symbol, quantity: Number(p.quantity),
      priceUsd: fresh ? p.priceUsd! : p.staleVerifiedPriceUsd!, priceSource: p.priceSource ?? null,
      priceStatus: fresh ? 'verified' : 'stale_verified', priceObservedAt: p.priceObservedAt ?? null, valueUsd,
    })
  }
  const holdings = [...byKey.values()].sort((a, b) => b.valueUsd - a.valueUsd || holdingKey(a.chainId, a.tokenAddress).localeCompare(holdingKey(b.chainId, b.tokenAddress))).slice(0, MAX_SNAPSHOT_HOLDINGS)
  return { v: VALUATION_SNAPSHOT_VERSION, wallet: wallet.toLowerCase(), scanStartedAt, supportedSubtotalUsd: subtotal, holdings }
}

export function parseValuationSnapshot(raw: unknown, wallet: string): WalletValuationSnapshot | null {
  const r = raw as Partial<WalletValuationSnapshot> | null
  if (!r || typeof r !== 'object' || r.v !== VALUATION_SNAPSHOT_VERSION || r.wallet !== wallet.toLowerCase()) return null
  if (typeof r.scanStartedAt !== 'number' || typeof r.supportedSubtotalUsd !== 'number' || !Array.isArray(r.holdings)) return null
  return r as WalletValuationSnapshot
}

/** Monotonic replacement rule: only a strictly newer scan replaces the stored snapshot. */
export function shouldReplaceValuationSnapshot(existing: WalletValuationSnapshot | null, incoming: WalletValuationSnapshot): boolean {
  return existing == null || incoming.scanStartedAt > existing.scanStartedAt
}

export type DiscontinuityClassification = 'valuation_evidence_lost' | 'asset_value_dropped' | 'balance_removed'

export type PortfolioValueDiscontinuity = {
  token: string
  symbol: string
  chain: number
  previousBalance: number
  currentBalance: number | null
  previousPrice: number
  currentPrice: number | null
  previousValueUsd: number
  currentValueUsd: number | null
  balanceChanged: boolean
  priceEvidenceChanged: boolean
  previousPriceSource: string | null
  currentPriceSource: string | null
  priceFailureReason: string | null
  priorPriceAgeMs: number | null
  subtotalDeltaUsd: number
  classification: DiscontinuityClassification
}

const BALANCE_TOLERANCE = 1e-9

/**
 * Pure. For every holding worth ≥10% of the previous supported subtotal whose PRICE was lost (no fresh price),
 * or whose balance went away: one record. Lost price on an unchanged-or-present balance is
 * `valuation_evidence_lost` (the asset is still there — only the evidence for its value is missing); a balance
 * that is gone is `balance_removed`; a fresh price that values it much lower is `asset_value_dropped`.
 */
export function buildPortfolioValueDiscontinuityAudit(
  previous: WalletValuationSnapshot | null,
  current: ReadonlyArray<PricedHolding>,
  now: number,
): PortfolioValueDiscontinuity[] {
  if (!previous || !(previous.supportedSubtotalUsd > 0)) return []
  const currentByKey = new Map<string, PricedHolding>()
  for (const p of current) {
    const k = holdingKey(p.chainId, p.tokenAddress)
    if (!currentByKey.has(k)) currentByKey.set(k, p)
  }
  let currentSubtotal = 0
  const seen = new Set<string>()
  for (const p of current) {
    const k = holdingKey(p.chainId, p.tokenAddress)
    if (seen.has(k)) continue
    seen.add(k)
    currentSubtotal += p.valueUsd ?? p.staleVerifiedValueUsd ?? 0
  }
  const subtotalDeltaUsd = currentSubtotal - previous.supportedSubtotalUsd
  const out: PortfolioValueDiscontinuity[] = []
  for (const prev of previous.holdings) {
    if (prev.valueUsd < DISCONTINUITY_SHARE_THRESHOLD * previous.supportedSubtotalUsd) continue
    const cur = currentByKey.get(holdingKey(prev.chainId, prev.tokenAddress)) ?? null
    const currentBalance = cur ? Number(cur.quantity) : null
    const balanceGone = cur == null || !(currentBalance != null && currentBalance > 0)
    const freshPrice = cur?.priceUsd ?? null
    const currentValueUsd = cur ? (cur.valueUsd ?? cur.staleVerifiedValueUsd ?? null) : null
    const balanceChanged = currentBalance == null || Math.abs(currentBalance - prev.quantity) > BALANCE_TOLERANCE * Math.max(1, Math.abs(prev.quantity))
    let classification: DiscontinuityClassification | null = null
    if (balanceGone) classification = 'balance_removed'
    else if (freshPrice == null) classification = 'valuation_evidence_lost'
    else if (currentValueUsd != null && currentValueUsd < prev.valueUsd * 0.5) classification = 'asset_value_dropped'
    if (!classification) continue
    const currentPriceSource = cur ? (cur.priceStatus === 'stale_verified' ? `stale_verified:${cur.priceSource ?? 'unknown'}` : cur.priceSource ?? null) : null
    const usedObservedAt = cur?.priceStatus === 'stale_verified' ? (cur.priceObservedAt ?? null) : prev.priceObservedAt
    out.push({
      token: prev.tokenAddress, symbol: prev.symbol, chain: prev.chainId,
      previousBalance: prev.quantity, currentBalance,
      previousPrice: prev.priceUsd, currentPrice: freshPrice ?? cur?.staleVerifiedPriceUsd ?? null,
      previousValueUsd: prev.valueUsd, currentValueUsd,
      balanceChanged, priceEvidenceChanged: freshPrice == null || cur?.priceSource !== prev.priceSource,
      previousPriceSource: prev.priceSource, currentPriceSource,
      priceFailureReason: cur?.priceFailureReason ?? (cur ? null : 'holding_absent'),
      priorPriceAgeMs: usedObservedAt != null ? now - usedObservedAt : null,
      subtotalDeltaUsd, classification,
    })
  }
  return out
}

// ─── store: process L1 + KV, monotonic writes ────────────────────────────────────────────────────────
export type ValuationSnapshotStore = {
  read: (wallet: string) => Promise<WalletValuationSnapshot | null>
  /** Writes only when strictly newer than what is stored (L1 and L2 both checked). Never throws. */
  write: (snapshot: WalletValuationSnapshot) => Promise<boolean>
}

export type ValuationSnapshotKv = {
  get: (key: string) => Promise<unknown | null>
  set: (key: string, value: WalletValuationSnapshot, ttlSeconds: number) => Promise<void>
}

export function createValuationSnapshotStore(kv: ValuationSnapshotKv | null): ValuationSnapshotStore {
  const l1 = new Map<string, WalletValuationSnapshot>()
  const newest = (a: WalletValuationSnapshot | null, b: WalletValuationSnapshot | null) => (a && b ? (b.scanStartedAt > a.scanStartedAt ? b : a) : a ?? b)
  async function read(wallet: string): Promise<WalletValuationSnapshot | null> {
    const key = valuationSnapshotKey(wallet)
    let remote: WalletValuationSnapshot | null = null
    if (kv) {
      try { remote = parseValuationSnapshot(await kv.get(key), wallet) } catch { remote = null }
    }
    const best = newest(l1.get(key) ?? null, remote)
    if (best) l1.set(key, best)
    return best
  }
  return {
    read,
    async write(snapshot) {
      try {
        const existing = await read(snapshot.wallet)
        if (!shouldReplaceValuationSnapshot(existing, snapshot)) return false
        const key = valuationSnapshotKey(snapshot.wallet)
        l1.set(key, snapshot)
        if (kv) await kv.set(key, snapshot, SNAPSHOT_TTL_SECONDS)
        return true
      } catch {
        return false
      }
    },
  }
}

const KV_TIMEOUT_MS = 500
function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([p, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('kv_timeout')), KV_TIMEOUT_MS) })]).finally(() => clearTimeout(timer))
}

let defaultStore: ValuationSnapshotStore | null = null
export function defaultValuationSnapshotStore(): ValuationSnapshotStore {
  if (!defaultStore) {
    const configured = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
    defaultStore = createValuationSnapshotStore(configured
      ? {
          async get(key) {
            if (getKvCircuitBreakerState().state === 'open') throw new Error('kv_circuit_open')
            return await withTimeout(vercelKv.get(key))
          },
          async set(key, value, ttlSeconds) {
            if (getKvCircuitBreakerState().state === 'open') throw new Error('kv_circuit_open')
            await withTimeout(vercelKv.set(key, value, { ex: ttlSeconds }))
          },
        }
      : null)
  }
  return defaultStore
}
