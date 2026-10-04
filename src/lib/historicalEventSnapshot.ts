// src/lib/historicalEventSnapshot.ts — persisted, provider-verified historical transfer events per
// wallet + chain, so a transient provider failure cannot delete history a previous scan proved.
//
// CONFIRMED PRODUCTION SHAPE (repeated-scan structural determinism task): scan 1 had GoldRush 31 + Alchemy
// 212 Base events → 204 buys / 6 sells → 13 structural lots (10 verified, $495.84); scan 2 GoldRush timed
// out (providerStatus 'partial') → 212 events → 203 / 5 → 12 lots (9 verified, $495.79), and
// `[pnl-repeat-scan-determinism]` reported `matchedLotFingerprint` changed. Root cause: one buy and one
// sell existed ONLY in GoldRush's response — Alchemy's history call is `category: ['erc20']` (never native
// ETH transfers) and capped at the 200 most recent transfers per direction — so when GoldRush timed out
// the canonical event set was recomputed from incomplete fresh inputs and the lot they formed vanished.
//
// Rule implemented here: canonical events = fresh provider events ∪ previously provider-verified events
// still inside the window. A persisted event is dropped only when it is outside the configured window or
// fails identity validation (malformed, wrong chain/wallet, key that does not match its own fields). An
// event a provider merely did not return (timeout, 429, 5xx, circuit-open, partial pagination, or a
// complete response that omits it) is never deleted. Only real provider events are persisted — never
// recovered/inferred ones — and nothing is ever invented: a first scan with no snapshot restores nothing.

import { createHash } from 'node:crypto'
import type { RawProviderEvent, SupportedChain } from '../modules/providerFetchWindow/types'

export const HISTORICAL_EVENT_SNAPSHOT_VERSION = 1 as const
/** Hard cap per wallet+chain snapshot (KV value size); the newest events are kept. */
export const MAX_PERSISTED_EVENTS_PER_CHAIN = 3_000
const DAY_MS = 24 * 60 * 60 * 1000

export type PersistedHistoricalEvent = {
  key: string
  chain: SupportedChain
  txHash: string
  timestamp: string
  fromAddress: string
  toAddress: string
  contract: string
  symbol: string | null
  amountRaw: string
  tokenDecimals: number | null
  /** Provider that first returned this exact transfer. */
  originalProvider: RawProviderEvent['provider']
  evidenceStatus: 'provider_verified'
  firstObservedAt: number
  lastObservedAt: number
}

export type HistoricalEventSnapshot = {
  v: typeof HISTORICAL_EVENT_SNAPSHOT_VERSION
  wallet: string
  chain: SupportedChain
  events: PersistedHistoricalEvent[]
  updatedAt: number
}

export function historicalEventSnapshotKey(wallet: string, chain: string): string {
  return `historical-events:v${HISTORICAL_EVENT_SNAPSHOT_VERSION}:${wallet.toLowerCase()}:${chain}`
}

/** Exact immutable transfer identity: chain + tx + token + from + to + raw amount (provider-agnostic). */
export function historicalEventIdentityKey(e: Pick<RawProviderEvent, 'chain' | 'txHash' | 'contract' | 'fromAddress' | 'toAddress' | 'amountRaw'>): string {
  return [e.chain, (e.txHash ?? '').toLowerCase(), (e.contract ?? '').toLowerCase(), (e.fromAddress ?? '').toLowerCase(), (e.toAddress ?? '').toLowerCase(), e.amountRaw ?? ''].join('|')
}

export type PersistedEventRejection = 'malformed' | 'chain_mismatch' | 'wallet_not_party' | 'identity_key_mismatch' | 'outside_window'

/** Validates a persisted record against its own identity, this chain and this wallet. */
export function validatePersistedEvent(raw: unknown, chain: string, wallet: string, windowStartMs: number): { event: PersistedHistoricalEvent | null; rejection: PersistedEventRejection | null } {
  const e = raw as Partial<PersistedHistoricalEvent> | null
  if (!e || typeof e !== 'object') return { event: null, rejection: 'malformed' }
  if (typeof e.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(e.txHash)) return { event: null, rejection: 'malformed' }
  if (typeof e.contract !== 'string' || e.contract === '' || typeof e.fromAddress !== 'string' || typeof e.toAddress !== 'string') return { event: null, rejection: 'malformed' }
  if (typeof e.amountRaw !== 'string' || !/^\d+$/.test(e.amountRaw) || /^0+$/.test(e.amountRaw)) return { event: null, rejection: 'malformed' }
  if (typeof e.timestamp !== 'string' || !Number.isFinite(Date.parse(e.timestamp))) return { event: null, rejection: 'malformed' }
  if (e.tokenDecimals !== null && e.tokenDecimals !== undefined && !(Number.isInteger(e.tokenDecimals) && e.tokenDecimals >= 0 && e.tokenDecimals <= 36)) return { event: null, rejection: 'malformed' }
  if (e.evidenceStatus !== 'provider_verified') return { event: null, rejection: 'malformed' }
  if (e.chain !== chain) return { event: null, rejection: 'chain_mismatch' }
  const w = wallet.toLowerCase()
  if (e.fromAddress.toLowerCase() !== w && e.toAddress.toLowerCase() !== w) return { event: null, rejection: 'wallet_not_party' }
  if (e.key !== historicalEventIdentityKey(e as PersistedHistoricalEvent)) return { event: null, rejection: 'identity_key_mismatch' }
  if (Date.parse(e.timestamp) < windowStartMs) return { event: null, rejection: 'outside_window' }
  return { event: e as PersistedHistoricalEvent, rejection: null }
}

function toRawEvent(p: PersistedHistoricalEvent): RawProviderEvent {
  return { provider: p.originalProvider, chain: p.chain, txHash: p.txHash, timestamp: p.timestamp, fromAddress: p.fromAddress, toAddress: p.toAddress, contract: p.contract, symbol: p.symbol, amountRaw: p.amountRaw, tokenDecimals: p.tokenDecimals }
}

function persistable(e: RawProviderEvent): boolean {
  return !!e.txHash && !!e.timestamp && Number.isFinite(Date.parse(e.timestamp)) && !!e.contract && !!e.fromAddress && !!e.toAddress && !!e.amountRaw && /^\d+$/.test(e.amountRaw) && !/^0+$/.test(e.amountRaw)
}

export function fingerprintEventKeys(keys: Iterable<string>): string {
  return createHash('sha256').update([...keys].sort().join('\n')).digest('hex').slice(0, 16)
}

export type StructuralHistoryStatus =
  | 'fresh_complete'
  | 'stable_from_persisted_verified_history'
  | 'fresh_partial_no_persisted_gap'
  | 'recomputed_from_partial_inputs'

export type HistoricalEventStabilityAudit = {
  chain: string
  /** The provider status of THIS scan's fresh fetch — always disclosed, never overwritten. */
  providerStatus: string
  structuralHistoryStatus: StructuralHistoryStatus
  previousCanonicalEventCount: number
  freshCanonicalEventCount: number
  restoredPersistedEventCount: number
  finalCanonicalEventCount: number
  eventsMissingFreshButRestored: Array<{ txHash: string; token: string; direction: 'inbound' | 'outbound' | 'unknown'; amountRaw: string; timestamp: string; originalProvider: string }>
  eventsDropped: Array<{ txHash: string; reason: PersistedEventRejection }>
  dropReasons: Partial<Record<PersistedEventRejection, number>>
  structuralFingerprintBefore: string | null
  structuralFingerprintAfter: string
}

const AUDIT_ROW_LIMIT = 25

/**
 * Pure merge: fresh provider events ∪ valid persisted events within the window. Fresh copies win on an
 * identical identity (deduped once); persisted-only events are restored. Returns the canonical raw events
 * and the snapshot to write back (never containing anything that was not a real provider event).
 */
export function mergeWithPersistedHistory(params: {
  wallet: string
  chain: SupportedChain
  providerStatus: string
  freshEvents: readonly RawProviderEvent[]
  snapshot: HistoricalEventSnapshot | null
  windowDays: number
  now: number
}): { canonicalEvents: RawProviderEvent[]; nextSnapshot: HistoricalEventSnapshot; audit: HistoricalEventStabilityAudit } {
  const windowStartMs = params.now - params.windowDays * DAY_MS
  const wallet = params.wallet.toLowerCase()
  const rejections: Array<{ txHash: string; reason: PersistedEventRejection }> = []
  const previous = new Map<string, PersistedHistoricalEvent>()
  const snapshotValid = params.snapshot !== null && params.snapshot.v === HISTORICAL_EVENT_SNAPSHOT_VERSION
    && params.snapshot.wallet === wallet && params.snapshot.chain === params.chain && Array.isArray(params.snapshot.events)
  if (snapshotValid) {
    for (const raw of params.snapshot!.events) {
      const { event, rejection } = validatePersistedEvent(raw, params.chain, wallet, windowStartMs)
      if (event) previous.set(event.key, event)
      else rejections.push({ txHash: String((raw as { txHash?: unknown })?.txHash ?? ''), reason: rejection! })
    }
  }

  const canonical = new Map<string, RawProviderEvent>()
  const next = new Map<string, PersistedHistoricalEvent>()
  for (const fresh of params.freshEvents) {
    const key = historicalEventIdentityKey(fresh)
    if (!canonical.has(key)) canonical.set(key, fresh)
    if (!persistable(fresh) || next.has(key)) continue
    const prior = previous.get(key)
    next.set(key, {
      key, chain: params.chain, txHash: fresh.txHash!, timestamp: fresh.timestamp!, fromAddress: fresh.fromAddress!, toAddress: fresh.toAddress!,
      contract: fresh.contract!, symbol: fresh.symbol, amountRaw: fresh.amountRaw!, tokenDecimals: fresh.tokenDecimals ?? prior?.tokenDecimals ?? null,
      originalProvider: prior?.originalProvider ?? fresh.provider, evidenceStatus: 'provider_verified',
      firstObservedAt: prior?.firstObservedAt ?? params.now, lastObservedAt: params.now,
    })
  }
  const restored: PersistedHistoricalEvent[] = []
  for (const [key, prior] of previous) {
    if (canonical.has(key)) continue
    canonical.set(key, toRawEvent(prior))
    next.set(key, prior)
    restored.push(prior)
  }

  const nextEvents = [...next.values()]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || a.key.localeCompare(b.key))
    .slice(0, MAX_PERSISTED_EVENTS_PER_CHAIN)
  const status: StructuralHistoryStatus = restored.length > 0
    ? 'stable_from_persisted_verified_history'
    : params.providerStatus === 'ok'
      ? 'fresh_complete'
      : snapshotValid ? 'fresh_partial_no_persisted_gap' : 'recomputed_from_partial_inputs'
  const dropReasons: Partial<Record<PersistedEventRejection, number>> = {}
  for (const r of rejections) dropReasons[r.reason] = (dropReasons[r.reason] ?? 0) + 1
  const direction = (e: PersistedHistoricalEvent) => (e.toAddress.toLowerCase() === wallet ? 'inbound' as const : e.fromAddress.toLowerCase() === wallet ? 'outbound' as const : 'unknown' as const)
  return {
    canonicalEvents: [...canonical.values()],
    nextSnapshot: { v: HISTORICAL_EVENT_SNAPSHOT_VERSION, wallet, chain: params.chain, events: nextEvents, updatedAt: params.now },
    audit: {
      chain: params.chain,
      providerStatus: params.providerStatus,
      structuralHistoryStatus: status,
      previousCanonicalEventCount: previous.size,
      freshCanonicalEventCount: new Set(params.freshEvents.map(historicalEventIdentityKey)).size,
      restoredPersistedEventCount: restored.length,
      finalCanonicalEventCount: canonical.size,
      eventsMissingFreshButRestored: restored.slice(0, AUDIT_ROW_LIMIT).map((e) => ({ txHash: e.txHash, token: e.contract, direction: direction(e), amountRaw: e.amountRaw, timestamp: e.timestamp, originalProvider: e.originalProvider })),
      eventsDropped: rejections.slice(0, AUDIT_ROW_LIMIT),
      dropReasons,
      structuralFingerprintBefore: snapshotValid ? fingerprintEventKeys(previous.keys()) : null,
      structuralFingerprintAfter: fingerprintEventKeys(canonical.keys()),
    },
  }
}

export type HistoricalEventKv = {
  get: <T = unknown>(key: string) => Promise<T | null>
  set: (key: string, value: unknown, opts?: { ex?: number }) => Promise<unknown>
}

/** Reads, merges and writes back one wallet+chain snapshot. A KV failure degrades to fresh-only; never throws. */
export async function stabilizeChainHistory(kv: HistoricalEventKv | null, params: Omit<Parameters<typeof mergeWithPersistedHistory>[0], 'snapshot'>): Promise<ReturnType<typeof mergeWithPersistedHistory>> {
  const key = historicalEventSnapshotKey(params.wallet, params.chain)
  let snapshot: HistoricalEventSnapshot | null = null
  if (kv) {
    try { snapshot = (await kv.get<HistoricalEventSnapshot>(key)) ?? null } catch { snapshot = null }
  }
  const result = mergeWithPersistedHistory({ ...params, snapshot })
  if (kv && result.nextSnapshot.events.length > 0) {
    try {
      await kv.set(key, result.nextSnapshot, { ex: Math.ceil((params.windowDays + 30) * 24 * 60 * 60) })
    } catch { /* fresh-only next time; never fails the scan */ }
  }
  return result
}
