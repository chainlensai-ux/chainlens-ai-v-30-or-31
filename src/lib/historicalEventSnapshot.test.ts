// Repeated-scan structural determinism — a transient provider failure must not delete history.
//
// Production: scan 1 (GoldRush 31 + Alchemy 212 Base events) → 13 structural / 10 verified / $495.84; scan 2
// (GoldRush timeout, same Alchemy 212) → 12 / 9 / $495.79, matchedLotFingerprint changed. One buy and one sell
// existed only in GoldRush's response (Alchemy's history call is erc20-only and capped at the 200 most
// recent transfers per direction). This fixture reproduces that shape exactly with the real normalizer
// and the real FIFO engine.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  HISTORICAL_EVENT_SNAPSHOT_VERSION,
  historicalEventIdentityKey,
  historicalEventSnapshotKey,
  mergeWithPersistedHistory,
  stabilizeChainHistory,
  type HistoricalEventSnapshot,
} from './historicalEventSnapshot.ts'
import { normalizeEvents } from '../modules/normalization/index'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import { mergeProviderResults } from '../modules/providerFetchWindow/index'
import type { RawProviderEvent } from '../modules/providerFetchWindow/types'
import type { NormalizedEvent } from '../modules/normalization/types'
import { buildScanDeterminismAudit, sortLotsByCanonicalIdentity, sumQuantizedUsd } from './scanDeterminismAudit.ts'
import { isCanonicalVerifiedPublishedLot } from './canonicalVerifiedLot.ts'
import { auditAndRecordRepeatScan, buildRepeatScanSnapshot, repeatScanScope } from './pnlRepeatScanDeterminism.ts'

const WALLET = '0x343f5a0bd465f8ffec69cf2e90152c80397470b9'
const CLAW = '0x61d91cff0fc9fbbdb89f505cf8a7422bf95fdba3'
const POOL = `0x${'5'.repeat(40)}`
const NOW = Date.parse('2026-10-01T00:00:00Z')
const WINDOW_DAYS = 90
const hash = (tag: string, i: number) => `0x${tag}${String(i).padStart(64 - tag.length, '0')}`
const at = (i: number, minutes: number) => new Date(Date.parse('2026-09-01T00:00:00Z') + i * 3_600_000 + minutes * 60_000).toISOString()
const units = (n: number) => (BigInt(n) * BigInt(10) ** BigInt(18)).toString()

function raw(provider: 'goldrush' | 'alchemy', txHash: string, timestamp: string, inbound: boolean, amount: number): RawProviderEvent {
  return { provider, chain: 'base', txHash, timestamp, fromAddress: inbound ? POOL : WALLET, toAddress: inbound ? WALLET : POOL, contract: CLAW, symbol: '1clawAI', amountRaw: units(amount), tokenDecimals: 18 }
}
/** Pair i: buy at hour i, full sell 30 minutes later. */
function pair(provider: 'goldrush' | 'alchemy', i: number): RawProviderEvent[] {
  return [raw(provider, hash('b', i), at(i, 0), true, 100 + i), raw(provider, hash('5', i), at(i, 30), false, 100 + i)]
}
const alchemyEvents = () => Array.from({ length: 12 }, (_, i) => pair('alchemy', i + 1)).flat()
// GoldRush returns pair 12 (overlapping Alchemy) and pair 13, which ONLY GoldRush has.
const goldrushEvents = () => [...pair('goldrush', 12), ...pair('goldrush', 13)]

// Prices: pairs 1-3 have no verified entry price (3 unverified lots); pair 13's exit makes realized $495.84.
const costUsd: Record<string, number | null> = {}
const proceedsUsd: Record<string, number | null> = {}
for (let i = 4; i <= 13; i += 1) costUsd[hash('b', i)] = 10 * i
for (let i = 1; i <= 13; i += 1) proceedsUsd[hash('5', i)] = 10 * i + 55
proceedsUsd[hash('5', 12)] = 120 + 55.79 // lots 4-11: $55 each; lot 12: $55.79 → $495.79 without lot 13
proceedsUsd[hash('5', 13)] = 130 + 0.05 // realized of the GoldRush-only lot: $0.05 (production delta 495.84 → 495.79)
const priceLookup = (e: NormalizedEvent) => (e.direction === 'inbound' ? costUsd[e.txHash] : proceedsUsd[e.txHash]) ?? null

function scan(rawEvents: RawProviderEvent[]) {
  const { normalizedEvents } = normalizeEvents(rawEvents, WALLET)
  const lots = matchLotsFIFO(buildLots(normalizedEvents, [], priceLookup), normalizedEvents.filter((e) => e.direction === 'outbound'), priceLookup).matchedLots
  const verified = lots.filter(isCanonicalVerifiedPublishedLot)
  const realized = sumQuantizedUsd(sortLotsByCanonicalIdentity(verified).map((l) => l.realizedPnlUsd))
  const fp = buildScanDeterminismAudit({ matchedLots: lots, realizedPnlUsd: realized, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
  return { lots, structural: lots.length, verified: verified.length, realized, fp, normalizedEvents }
}

function memoryKv() {
  const store = new Map<string, unknown>()
  return { store, get: async <T>(k: string) => (store.get(k) as T | undefined) ?? null, set: async (k: string, v: unknown) => { store.set(k, v); return 'OK' } }
}

async function runScan(kv: ReturnType<typeof memoryKv> | null, goldrushOk: boolean, now = NOW) {
  const fresh = goldrushOk ? mergeProviderResults(goldrushEvents(), alchemyEvents()) : mergeProviderResults([], alchemyEvents())
  const stability = await stabilizeChainHistory(kv, { wallet: WALLET, chain: 'base', providerStatus: goldrushOk ? 'ok' : 'partial', freshEvents: fresh, windowDays: WINDOW_DAYS, now })
  return { ...scan(stability.canonicalEvents), stability, fresh }
}

describe('repeated-scan structural determinism under a GoldRush timeout', () => {
  it('audit: identifies the exact GoldRush-only event pair and the lot it formed (fresh-only recompute = production 12/9/$495.79)', () => {
    const scanA = scan(mergeProviderResults(goldrushEvents(), alchemyEvents()))
    const scanBFreshOnly = scan(mergeProviderResults([], alchemyEvents()))
    assert.deepEqual([scanA.structural, scanA.verified, scanA.realized], [13, 10, 495.84])
    assert.deepEqual([scanBFreshOnly.structural, scanBFreshOnly.verified, scanBFreshOnly.realized], [12, 9, 495.79])
    const lostKeys = new Set(scanBFreshOnly.normalizedEvents.map((e) => `${e.txHash}|${e.direction}`))
    const missingEvents = scanA.normalizedEvents.filter((e) => !lostKeys.has(`${e.txHash}|${e.direction}`))
    assert.deepEqual(missingEvents.map((e) => [e.txHash, e.direction]), [[hash('b', 13), 'inbound'], [hash('5', 13), 'outbound']])
    const missingLot = scanA.lots.find((l) => !scanBFreshOnly.lots.some((b) => b.lotId === l.lotId))!
    assert.equal(missingLot.openedTxHash, hash('b', 13))
    assert.equal(missingLot.closedTxHash, hash('5', 13))
    assert.equal(Math.round(missingLot.realizedPnlUsd! * 100) / 100, 0.05)
    assert.notEqual(scanA.fp.matchedLotFingerprint, scanBFreshOnly.fp.matchedLotFingerprint, 'this is the production fingerprint change')
  })

  it('1-3. scan A (both providers) → 13 lots; scan B (GoldRush timeout) restores the persisted verified events → 10/13/$495.84, deterministic', async () => {
    const kv = memoryKv()
    const repeatKv = memoryKv()
    const scope = repeatScanScope(WALLET, ['base'], WINDOW_DAYS)
    const record = (s: Awaited<ReturnType<typeof runScan>>, t: number) => auditAndRecordRepeatScan(repeatKv, buildRepeatScanSnapshot(scope, {
      matchedLotFingerprint: s.fp.matchedLotFingerprint, verifiedLotIdentityFingerprint: s.fp.verifiedLotIdentityFingerprint,
      acceptedHistoricalPriceFingerprint: s.fp.acceptedHistoricalPriceFingerprint, realizedPnlFingerprint: s.fp.realizedPnlFingerprint,
      verifiedLotCount: s.verified, structuralLotCount: s.structural, realizedPnlUsd: s.realized,
    }, t))
    const a = await runScan(kv, true)
    assert.deepEqual([a.structural, a.verified, a.realized], [13, 10, 495.84])
    await record(a, 1)
    const b = await runScan(kv, false, NOW + 60_000)
    assert.deepEqual([b.structural, b.verified, b.realized], [13, 10, 495.84])
    assert.equal(b.fp.matchedLotFingerprint, a.fp.matchedLotFingerprint, 'same manifest key (matchedLotFingerprint) as scan A')
    assert.equal(b.fp.verifiedLotIdentityFingerprint, a.fp.verifiedLotIdentityFingerprint)
    const audit = await record(b, 2)
    assert.equal(audit.deterministic, true)
    assert.equal(audit.firstDifference, null)
    assert.equal(b.stability.audit.restoredPersistedEventCount, 2)
    const restored = b.stability.audit.eventsMissingFreshButRestored.map((e) => [e.txHash, e.direction, e.originalProvider].join('|')).sort()
    assert.deepEqual(restored, [`${hash('5', 13)}|outbound|goldrush`, `${hash('b', 13)}|inbound|goldrush`].sort())
    assert.equal(b.stability.audit.structuralFingerprintBefore, b.stability.audit.structuralFingerprintAfter)
  })

  it('4. a persisted copy and a fresh copy of the same transfer dedupe to one event', async () => {
    const kv = memoryKv()
    await runScan(kv, true)
    const again = await runScan(kv, true, NOW + 60_000)
    assert.equal(again.stability.audit.restoredPersistedEventCount, 0)
    assert.equal(again.stability.audit.finalCanonicalEventCount, 26)
    assert.equal(again.structural, 13)
    const snapshot = kv.store.get(historicalEventSnapshotKey(WALLET, 'base')) as HistoricalEventSnapshot
    assert.equal(snapshot.events.length, 26)
    assert.equal(new Set(snapshot.events.map((e) => e.key)).size, 26)
  })

  it('5. an event that has left the configured window is removed', async () => {
    const kv = memoryKv()
    await runScan(kv, true)
    // 120 days later every event is outside the 90-day window; nothing is restored.
    const later = await runScan(kv, false, NOW + 120 * 24 * 3_600_000)
    assert.equal(later.stability.audit.restoredPersistedEventCount, 0)
    assert.equal(later.stability.audit.dropReasons.outside_window, 26)
  })

  it('6. a persisted event with an identity conflict is rejected, never restored', () => {
    const good = mergeWithPersistedHistory({ wallet: WALLET, chain: 'base', providerStatus: 'ok', freshEvents: mergeProviderResults(goldrushEvents(), alchemyEvents()), snapshot: null, windowDays: WINDOW_DAYS, now: NOW }).nextSnapshot
    const byTx = (tx: string) => good.events.find((e) => e.txHash === tx)!
    const tampered: HistoricalEventSnapshot = {
      ...good,
      events: [
        { ...byTx(hash('5', 13)), amountRaw: units(999) }, // key no longer matches its own fields
        { ...byTx(hash('b', 13)), fromAddress: POOL, toAddress: `0x${'7'.repeat(40)}`, key: historicalEventIdentityKey({ ...byTx(hash('b', 13)), fromAddress: POOL, toAddress: `0x${'7'.repeat(40)}` }) }, // wallet not a party
        { ...byTx(hash('b', 12)), chain: 'eth' as never }, // wrong chain
      ],
    }
    const merged = mergeWithPersistedHistory({ wallet: WALLET, chain: 'base', providerStatus: 'partial', freshEvents: mergeProviderResults([], alchemyEvents()), snapshot: tampered, windowDays: WINDOW_DAYS, now: NOW })
    assert.equal(merged.audit.restoredPersistedEventCount, 0)
    assert.deepEqual(merged.audit.dropReasons, { identity_key_mismatch: 1, wallet_not_party: 1, chain_mismatch: 1 })
    assert.equal(scan(merged.canonicalEvents).structural, 12)
    // A snapshot written for another wallet is ignored entirely.
    const foreign = mergeWithPersistedHistory({ wallet: `0x${'1'.repeat(40)}`, chain: 'base', providerStatus: 'partial', freshEvents: [], snapshot: good, windowDays: WINDOW_DAYS, now: NOW })
    assert.equal(foreign.canonicalEvents.length, 0)
  })

  it('7. a first-ever scan with a provider failure does not invent missing history', async () => {
    const kv = memoryKv()
    const first = await runScan(kv, false)
    assert.deepEqual([first.structural, first.verified, first.realized], [12, 9, 495.79])
    assert.equal(first.stability.audit.restoredPersistedEventCount, 0)
    assert.equal(first.stability.audit.structuralHistoryStatus, 'recomputed_from_partial_inputs')
    assert.equal(first.stability.audit.structuralFingerprintBefore, null)
  })

  it('8. provider-partial status stays disclosed even when the structure is stabilized', async () => {
    const kv = memoryKv()
    await runScan(kv, true)
    const b = await runScan(kv, false, NOW + 60_000)
    assert.equal(b.stability.audit.providerStatus, 'partial', 'the fresh fetch is still reported partial')
    assert.equal(b.stability.audit.structuralHistoryStatus, 'stable_from_persisted_verified_history')
    assert.equal(b.stability.audit.freshCanonicalEventCount, 24)
    assert.equal(b.stability.audit.finalCanonicalEventCount, 26)
    // The snapshot keeps the original provider provenance and never rewrites a restored event as fresh.
    const snap = kv.store.get(historicalEventSnapshotKey(WALLET, 'base')) as HistoricalEventSnapshot
    const restored = snap.events.find((e) => e.txHash === hash('5', 13))!
    assert.equal(restored.originalProvider, 'goldrush')
    assert.equal(restored.lastObservedAt, NOW, 'not re-stamped as observed by the scan that could not see it')
    assert.equal(snap.v, HISTORICAL_EVENT_SNAPSHOT_VERSION)
  })

  it('a KV failure degrades to fresh-only and never throws', async () => {
    const broken = { get: async () => { throw new Error('kv down') }, set: async () => { throw new Error('kv down') } }
    const r = await stabilizeChainHistory(broken as never, { wallet: WALLET, chain: 'base', providerStatus: 'partial', freshEvents: alchemyEvents(), windowDays: WINDOW_DAYS, now: NOW })
    assert.equal(r.canonicalEvents.length, 24)
  })
})

