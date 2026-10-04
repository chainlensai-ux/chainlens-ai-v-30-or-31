// Same-tx outbound overcount + repeated-scan determinism — regression tests.
//
// Proven root cause (see txSideEventAllocation.ts): the at-trade-time dictionaries hold one USD value per
// txHash, several writers store the WHOLE tx-side value there, and fifoEngine applied that value to EACH
// same-token transfer event of the side, prorating by that event's own amount. A sell tx with a 900-token
// swap transfer + 100-token fee transfer quoted at $90 produced $180 of proceeds.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  allocateTxSideValue,
  buildSameTxMultiEventAudit,
  buildTxSideEventPriceLookup,
  multiEventTxSideKeys,
  txSideKey,
} from './txSideEventAllocation.ts'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import { mergeNormalizedEvents } from '../modules/fifoEngine/utils'
import type { MatchedLot } from '../modules/fifoEngine/types'
import type { NormalizedEvent } from '../modules/normalization/types'
import { collapseSameTxSideEntries, priceLotsForWallet, resolveEventPriceUsd } from '../pipeline/priceLotsForWallet.ts'
import {
  ACCEPTED_EVIDENCE_SCHEMA_VERSION,
  TX_SIDE_EVENT_ALLOCATION_METHOD,
  buildAcceptedEvidenceCoverageFingerprint,
  buildAcceptedEvidenceEnvelope,
  buildAcceptedEvidenceKey,
  lotIdentityVersion,
  type AcceptedEvidenceEnvelope,
  type AcceptedEvidenceKvLike,
} from './acceptedEvidenceStore.ts'
import { createPnlReconciliation } from './pnlReconciliation.ts'
import { emptyUnrealizedReconciliation, type FifoOutput } from '../modules/fifoEngine/types'
import type { PnlSummaryResult } from '../modules/pnlEngine/types'
import { auditAndRecordRepeatScan, buildRepeatScanSnapshot, repeatScanScope } from './pnlRepeatScanDeterminism.ts'
import { buildScanDeterminismAudit, sumQuantizedUsd, sortLotsByCanonicalIdentity } from './scanDeterminismAudit.ts'
import { isCanonicalVerifiedPublishedLot } from './canonicalVerifiedLot.ts'
import {
  acceptedEvidenceIdentityKeysForLot,
  buildManifestFromCandidate,
  buildManifestIdentity,
  replayManifest,
  shouldRefreshPartiallyUnreproducibleManifest,
  type AcceptedEvidenceLoader,
} from './canonicalPnlSampleManifest.ts'

const CLAW = '0x61d91cff0fc9fbbdb89f505cf8a7422bf95fdba3'
const WALLET = `0x${'9'.repeat(40)}`
const BUY = '2026-04-01T00:00:00.000Z'
const SELL = '2026-04-02T00:00:00.000Z'

function ev(txHash: string, direction: 'inbound' | 'outbound', amount: number, at: string, counterparty = '0xpool'): NormalizedEvent {
  return {
    chain: 'base', txHash, contract: CLAW, direction, amount, timestamp: at, tokenDecimals: 18,
    fromAddress: direction === 'inbound' ? counterparty : WALLET,
    toAddress: direction === 'inbound' ? WALLET : counterparty,
    amountRaw: (BigInt(Math.round(amount * 1e6)) * BigInt(10) ** BigInt(12)).toString(),
  } as unknown as NormalizedEvent
}

function fifo(events: NormalizedEvent[], costUsd: Record<string, number | null>, proceedsUsd: Record<string, number | null>, legacy = false) {
  const merged = mergeNormalizedEvents(events, [])
  const lookup = legacy
    ? (e: NormalizedEvent) => resolveEventPriceUsd(e, costUsd, proceedsUsd)
    : buildTxSideEventPriceLookup(merged, costUsd, proceedsUsd).lookup
  return matchLotsFIFO(buildLots(merged, [], lookup), merged.filter((e) => e.direction === 'outbound'), lookup).matchedLots
}

const sum = (values: Array<number | null>) => Math.round(values.reduce((s: number, v) => s + (v ?? 0), 0) * 1e8) / 1e8
const exitSum = (lots: readonly MatchedLot[], tx: string) => sum(lots.filter((l) => l.closedTxHash === tx).map((l) => l.proceedsUsd))
const entrySum = (lots: readonly MatchedLot[], tx: string) => sum(lots.filter((l) => l.openedTxHash === tx).map((l) => l.costBasisUsd))

/** Production shape: buys 0xb1 (700) / 0xb2 (300); sell tx 0xsx = swap 900 + fee transfer 100, quoted $90 for the side. */
function swapPlusFeeEvents() {
  return [
    ev('0xb1', 'inbound', 700, BUY), ev('0xb2', 'inbound', 300, BUY),
    ev('0xsx', 'outbound', 900, SELL, '0xpool'), ev('0xsx', 'outbound', 100, SELL, '0xfeewallet'),
  ]
}
const COST = { '0xb1': 70, '0xb2': 30 }
const QUOTE = 90

describe('Goal A — one tx-side value, applied once', () => {
  it('1. one sell tx, one outbound event → unchanged (identical to the old per-event lookup)', () => {
    const events = [ev('0xb1', 'inbound', 700, BUY), ev('0xb2', 'inbound', 300, BUY), ev('0xsx', 'outbound', 1000, SELL)]
    const fixed = fifo(events, COST, { '0xsx': QUOTE })
    const legacy = fifo(events, COST, { '0xsx': QUOTE }, true)
    assert.deepEqual(fixed.map((l) => [l.amount, l.costBasisUsd, l.proceedsUsd]), legacy.map((l) => [l.amount, l.costBasisUsd, l.proceedsUsd]))
    assert.equal(exitSum(fixed, '0xsx'), QUOTE)
  })

  it('2. one sell tx, swap + fee outbound events → the quote is applied once ($90, not $180)', () => {
    const legacy = fifo(swapPlusFeeEvents(), COST, { '0xsx': QUOTE }, true)
    assert.equal(exitSum(legacy, '0xsx'), 180, 'reproduces the overcount: quote × number of outbound events')
    const fixed = fifo(swapPlusFeeEvents(), COST, { '0xsx': QUOTE })
    assert.equal(exitSum(fixed, '0xsx'), QUOTE)
    assert.equal(sum(fixed.map((l) => l.realizedPnlUsd)), QUOTE - 100, 'realized = $90 proceeds − $100 cost')
    assert.equal(sum(legacy.map((l) => l.realizedPnlUsd)), 80, 'old realized was inflated by exactly one extra $90')
  })

  it('3. three FIFO fragments from one tx side → assigned proceeds sum exactly to the side quote', () => {
    const fixed = fifo(swapPlusFeeEvents(), COST, { '0xsx': QUOTE })
    const fragments = fixed.filter((l) => l.closedTxHash === '0xsx')
    assert.equal(fragments.length, 3, '700 (b1, swap), 200 (b2, swap), 100 (b2, fee)')
    assert.deepEqual(fragments.map((l) => [l.amount, l.proceedsUsd]), [[700, 63], [200, 18], [100, 9]])
    const shares = allocateTxSideValue(1 / 3, [ev('0xt', 'outbound', 1, SELL, '0xa'), ev('0xt', 'outbound', 1, SELL, '0xb'), ev('0xt', 'outbound', 1, SELL, '0xc')])
    assert.equal(shares.reduce((s, v) => s + Math.round(v * 1e8), 0), Math.round((1 / 3) * 1e8), 'fixed-point shares conserve the total exactly')
    const audit = buildSameTxMultiEventAudit({ events: mergeNormalizedEvents(swapPlusFeeEvents(), []), matchedLots: fixed, costUsd: COST, proceedsUsd: { '0xsx': QUOTE } })
    assert.equal(audit.length, 1)
    assert.equal(audit[0].eventCount, 2)
    assert.deepEqual(audit[0].eventAmounts, [900, 100])
    assert.deepEqual(audit[0].assignedPerEvent, [81, 9])
    assert.equal(audit[0].summedAssignedUsd, QUOTE)
    assert.equal(audit[0].conservationDeltaUsd, 0)
    assert.equal(audit[0].legacyOvercountUsd, QUOTE)
  })

  it('4. entry side: one buy tx with two inbound transfer events → cost basis applied once', () => {
    const events = [ev('0xbx', 'inbound', 600, BUY, '0xpool'), ev('0xbx', 'inbound', 400, BUY, '0xrouter'), ev('0xs1', 'outbound', 500, SELL), ev('0xs2', 'outbound', 500, SELL)]
    const costs = { '0xbx': 100 }
    const proceeds = { '0xs1': 60, '0xs2': 60 }
    assert.equal(entrySum(fifo(events, costs, proceeds, true), '0xbx'), 200, 'old: $100 per inbound event')
    const fixed = fifo(events, costs, proceeds)
    assert.equal(entrySum(fixed, '0xbx'), 100)
    assert.equal(sum(fixed.map((l) => l.realizedPnlUsd)), 20)
  })

  it('5. two unrelated same-token actions in one tx are never merged across tokens or directions, and per-unit valuations stay per event', () => {
    // A same-tx sell (900) and an unrelated transfer-out (100) priced from a per-unit market price: the
    // side value is p × 1000 and each event keeps exactly p × its own amount — nothing moves between them.
    const p = 0.05
    const events = [ev('0xb1', 'inbound', 1000, BUY), ev('0xsx', 'outbound', 900, SELL, '0xpool'), ev('0xsx', 'outbound', 100, SELL, '0xfriend'),
      { ...ev('0xsx', 'inbound', 5, SELL, '0xairdrop'), contract: '0x' + '4'.repeat(40) } as NormalizedEvent]
    const { lookup, allocation } = buildTxSideEventPriceLookup(mergeNormalizedEvents(events, []), { '0xb1': 50 }, { '0xsx': p * 1000 })
    assert.equal(lookup(events[1]), p * 900)
    assert.equal(lookup(events[2]), p * 100)
    assert.equal(allocation.groups.size, 3, 'same tx: one outbound CLAW side, one inbound CLAW buy side, one inbound OTHER-token side — never combined')
    assert.deepEqual([...multiEventTxSideKeys(events)], [txSideKey('base', '0xsx', 'outbound', CLAW)])
    // Engine entries for the sell side collapse to ONE priced entry of the summed quantity (no quantity dropped).
    const collapsed = collapseSameTxSideEntries([
      { txHash: '0xsx', token: CLAW, chain: 'base', timestamp: 1, amount: '900', pairRank: 1 },
      { txHash: '0xsx', token: CLAW, chain: 'base', timestamp: 1, amount: '100', pairRank: 0 },
      { txHash: '0xsx', token: '0x' + '4'.repeat(40), chain: 'base', timestamp: 1, amount: '5', pairRank: undefined },
    ])
    assert.deepEqual(collapsed.map((e) => [e.token.slice(0, 4), e.amount, e.pairRank]), [['0x61', '1000', 0], ['0x44', '5', undefined]])
  })

  it('6. a duplicate provider/normalized transfer does not double count', () => {
    const events = [...swapPlusFeeEvents(), ev('0xsx', 'outbound', 900, SELL, '0xpool')] // same transfer reported twice
    const fixed = fifo(events, COST, { '0xsx': QUOTE })
    assert.equal(exitSum(fixed, '0xsx'), QUOTE)
    assert.equal(fixed.reduce((s, l) => s + l.amount, 0), 1000)
  })
})

// ─── real priceLotsForWallet: engine pricing + accepted evidence fast path ──────────────────────────
function fakeKv(): AcceptedEvidenceKvLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return { store, get: async <T>(k: string) => (store.has(k) ? (store.get(k) as T) : null), set: async (k: string, v: unknown) => { store.set(k, v); return 'OK' } } as never
}

async function priceScan(events: NormalizedEvent[], perUnit: number | null, kv: AcceptedEvidenceKvLike) {
  const warn = console.warn
  console.warn = () => {}
  const prior = process.env.COINPAPRIKA_HISTORICAL_ENABLED
  process.env.COINPAPRIKA_HISTORICAL_ENABLED = 'false'
  try {
    const source = async (_token: string, _chain: string, timestamp: number) => (perUnit === null ? null : timestamp < Date.parse(SELL) ? perUnit * 0.1 / 0.09 : perUnit)
    const lookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: { primary: source as never, fallback: (async () => null) as never }, acceptedEvidenceKv: kv, now: () => Date.now() })
    const lots = matchLotsFIFO(buildLots(events, [], lookups.priceUsdLookup), events.filter((e) => e.direction === 'outbound'), lookups.priceUsdLookup).matchedLots
    return { lookups, lots }
  } finally {
    console.warn = warn
    if (prior === undefined) delete process.env.COINPAPRIKA_HISTORICAL_ENABLED
    else process.env.COINPAPRIKA_HISTORICAL_ENABLED = prior
  }
}

function seedMarked(kv: AcceptedEvidenceKvLike & { store: Map<string, unknown> }, lots: readonly MatchedLot[], marker = true) {
  const groups = new Map<string, { lots: MatchedLot[]; total: number; side: 'entry' | 'exit'; tx: string; ts: number }>()
  for (const l of lots.filter(isCanonicalVerifiedPublishedLot)) {
    const [ek, xk] = acceptedEvidenceIdentityKeysForLot(l)
    for (const [k, side, tx, ts, v] of [[ek, 'entry', l.openedTxHash, l.openedAt, l.costBasisUsd!], [xk, 'exit', l.closedTxHash, l.closedAt, l.proceedsUsd!]] as const) {
      const g = groups.get(k) ?? { lots: [], total: 0, side, tx, ts }
      g.lots.push(l); g.total += v; groups.set(k, g)
    }
  }
  for (const [k, g] of groups) {
    const total = Math.round(g.total * 1e8) / 1e8
    kv.store.set(k, buildAcceptedEvidenceEnvelope({
      identity: { chain: 'base', token: CLAW, txHash: g.tx, side: g.side, timestamp: g.ts, lotIdentityVersion: g.lots.map(lotIdentityVersion).sort()[0] },
      priceUsd: total, valueUsd: total, coveredLotCount: g.lots.length, coverageFingerprint: buildAcceptedEvidenceCoverageFingerprint(g.lots),
      source: 'canonical-upstream', evidenceType: 'unknown', providerTimestampBucket: null, now: Date.now(),
      ...(marker ? { allocationMethod: TX_SIDE_EVENT_ALLOCATION_METHOD } : {}),
    }))
  }
}

describe('Goal A — through the real pricing stage', () => {
  it('engine-priced swap + fee side is priced once for the whole side quantity (the old last-write valued only one event)', async () => {
    const { lots, lookups } = await priceScan(swapPlusFeeEvents(), 0.09, fakeKv())
    assert.equal(exitSum(lots, '0xsx'), 90, '0.09/token × 1000 tokens')
    assert.deepEqual(lookups.txSideAllocation!.multiEventTxSideKeys, [txSideKey('base', '0xsx', 'outbound', CLAW)])
  })

  // One buy + a swap+fee sell: every side priced within the per-token lookup cap (2 entries).
  const oneBuySwapPlusFee = () => [ev('0xb1', 'inbound', 1000, BUY), ev('0xsx', 'outbound', 900, SELL, '0xpool'), ev('0xsx', 'outbound', 100, SELL, '0xfeewallet')]

  it('8. second scan with a provider miss but persisted accepted evidence gives the same historical sample', async () => {
    const kv = fakeKv()
    const first = await priceScan(oneBuySwapPlusFee(), 0.09, kv)
    assert.ok(first.lots.every(isCanonicalVerifiedPublishedLot))
    seedMarked(kv, first.lots)
    const second = await priceScan(oneBuySwapPlusFee(), null, kv) // every provider misses
    const r8 = (v: number | null) => (v === null ? null : Math.round(v * 1e8) / 1e8) // canonical 1e-8 USD precision
    assert.deepEqual(second.lots.map((l) => [l.lotId, r8(l.costBasisUsd), r8(l.proceedsUsd)]), first.lots.map((l) => [l.lotId, r8(l.costBasisUsd), r8(l.proceedsUsd)]))
    assert.equal(exitSum(second.lots, '0xsx'), 90)
  })

  it('9a. a pre-fix accepted record on a multi-event side is not trusted: re-priced, audited, never the overcounted value', async () => {
    const kv = fakeKv()
    const legacyLots = fifo(oneBuySwapPlusFee(), { '0xb1': 100 }, { '0xsx': QUOTE }, true) // the old $180 fragments
    assert.equal(exitSum(legacyLots, '0xsx'), 180)
    seedMarked(kv, legacyLots, false)
    const scan = await priceScan(oneBuySwapPlusFee(), 0.09, kv)
    assert.equal(scan.lookups.txSideAllocation!.legacyMultiEventEvidenceDistrusted.length, 1)
    assert.equal(exitSum(scan.lots, '0xsx'), 90, 'live re-pricing, not the persisted $180')
  })
})

// ─── real reconcile(): hydration ignores, seeding repairs (genuinely changed evidence is audited) ────
function fifoOutput(lots: MatchedLot[]): FifoOutput {
  return { matchedLots: lots, unmatchedBuys: 0, unmatchedSells: 0, unmatchedBuyEvents: [], unmatchedSellEvents: [], realizedPnlUsd: sum(lots.map((l) => l.realizedPnlUsd)), unrealizedPnlUsd: 0, costBasisUsd: 0, publicPnlStatus: 'ok', integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 }, unrealizedPnlExcludedTokens: [], unrealizedReconciliation: emptyUnrealizedReconciliation() }
}
function pnlSummary(n: number): PnlSummaryResult {
  return { realizedPnlUsd: 0, closedLots: [], winLossRate: { wins: 0, losses: 0, evaluated: n, rate: 0 }, chainBreakdown: [], confidenceBasis: { high: 0, medium: 0, low: 0, aggregate: 'high' }, evidenceMissingCount: 0 } as never
}

describe('9. genuinely changed accepted evidence changes the output and is audited', () => {
  it('hydration ignores the legacy multi-event record, seeding rewrites it with the corrected total (old total kept), single-event records untouched', async () => {
    const kv = fakeKv()
    const legacyLots = fifo(swapPlusFeeEvents(), COST, { '0xsx': QUOTE }, true)
    seedMarked(kv, legacyLots, false)
    const exitKey = acceptedEvidenceIdentityKeysForLot(legacyLots.find((l) => l.closedTxHash === '0xsx')!)[1]
    assert.equal((kv.store.get(exitKey) as AcceptedEvidenceEnvelope).priceUsd, 180)
    const corrected = fifo(swapPlusFeeEvents(), COST, { '0xsx': QUOTE })
    const r = createPnlReconciliation({ logger: { warn() {} }, acceptedEvidenceKv: kv as never, multiEventTxSideKeys: multiEventTxSideKeys(swapPlusFeeEvents()) })
    const summary = await r.reconcile({ fifoEngineResult: fifoOutput(corrected), pnlEngineResult: pnlSummary(corrected.length), syntheticPnlAssemblyOutput: null })
    const published = summary.publishedMatchedLots
    assert.equal(exitSum(published, '0xsx'), 90, 'the overcounted persisted $180 is never hydrated back')
    const repaired = kv.store.get(exitKey) as AcceptedEvidenceEnvelope
    assert.equal(repaired.priceUsd, 90)
    assert.equal(repaired.allocationMethod, TX_SIDE_EVENT_ALLOCATION_METHOD)
    assert.equal(repaired.allocationRepairedFromUsd, 180, 'the replaced value stays on the record')
    assert.equal(repaired.originWriter, 'canonical-upstream', 'provenance preserved')
    // The single-event entry sides were trusted and left exactly as they were.
    const entryKey = acceptedEvidenceIdentityKeysForLot(legacyLots[0])[0]
    assert.equal((kv.store.get(entryKey) as AcceptedEvidenceEnvelope).allocationMethod, undefined)
    // A later scan reproduces the repaired value from evidence alone.
    const again = await createPnlReconciliation({ logger: { warn() {} }, acceptedEvidenceKv: kv as never, multiEventTxSideKeys: multiEventTxSideKeys(swapPlusFeeEvents()) })
      .reconcile({ fifoEngineResult: fifoOutput(fifo(swapPlusFeeEvents(), {}, {}).map((l) => ({ ...l }))), pnlEngineResult: pnlSummary(3), syntheticPnlAssemblyOutput: null })
    assert.equal(exitSum(again.publishedMatchedLots, '0xsx'), 90)
  })
})

// ─── Goal B + manifest ─────────────────────────────────────────────────────────────────────────────
function fingerprints(lots: readonly MatchedLot[], realizedPnlUsd: number | null) {
  const a = buildScanDeterminismAudit({ matchedLots: lots, realizedPnlUsd, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
  return { verifiedLotIdentityFingerprint: a.verifiedLotIdentityFingerprint, acceptedHistoricalPriceFingerprint: a.acceptedHistoricalPriceFingerprint, realizedPnlFingerprint: a.realizedPnlFingerprint, scanFingerprint: a.scanFingerprint }
}
const loaderOf = (kv: { store: Map<string, unknown> }): AcceptedEvidenceLoader => async (id) => {
  const e = (kv.store.get(buildAcceptedEvidenceKey({ ...id, lotIdentityVersion: '' })) as AcceptedEvidenceEnvelope | undefined) ?? null
  return e && (id.lotIdentityVersion === null || e.lotIdentityVersion === id.lotIdentityVersion) ? e : null
}
const identity = buildManifestIdentity({ walletAddress: WALLET, chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'same-tx' })
const realizedOf = (lots: readonly MatchedLot[]) => sumQuantizedUsd(sortLotsByCanonicalIdentity(lots.filter(isCanonicalVerifiedPublishedLot)).map((l) => l.realizedPnlUsd))

describe('Goal B — repeated scans reproduce', () => {
  it('7. repeated identical scans give identical verified count, PnL and fingerprints (audit says deterministic)', async () => {
    const kv = fakeKv()
    const scope = repeatScanScope(WALLET, ['base'], 90)
    const audits = []
    for (let i = 0; i < 3; i += 1) {
      const lots = fifo(swapPlusFeeEvents(), COST, { '0xsx': QUOTE })
      const fp = buildScanDeterminismAudit({ matchedLots: lots, realizedPnlUsd: realizedOf(lots), persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
      audits.push(await auditAndRecordRepeatScan(kv as never, buildRepeatScanSnapshot(scope, {
        matchedLotFingerprint: fp.matchedLotFingerprint, verifiedLotIdentityFingerprint: fp.verifiedLotIdentityFingerprint,
        acceptedHistoricalPriceFingerprint: fp.acceptedHistoricalPriceFingerprint, realizedPnlFingerprint: fp.realizedPnlFingerprint,
        verifiedLotCount: lots.filter(isCanonicalVerifiedPublishedLot).length, structuralLotCount: lots.length, realizedPnlUsd: realizedOf(lots),
      }, i)))
    }
    assert.equal(audits[0].deterministic, null, 'first scan has nothing to compare')
    for (const a of audits.slice(1)) {
      assert.equal(a.deterministic, true)
      assert.equal(a.firstDifference, null)
      assert.equal(a.verifiedLotCount, 3)
      assert.equal(a.realizedPnlUsd, -10)
      assert.equal(a.previousRealizedPnlUsd, -10)
    }
    // A genuine evidence change is reported with the first moved field.
    const legacy = fifo(swapPlusFeeEvents(), COST, { '0xsx': QUOTE }, true)
    const fp = buildScanDeterminismAudit({ matchedLots: legacy, realizedPnlUsd: realizedOf(legacy), persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
    const changed = await auditAndRecordRepeatScan(kv as never, buildRepeatScanSnapshot(scope, {
      matchedLotFingerprint: fp.matchedLotFingerprint, verifiedLotIdentityFingerprint: fp.verifiedLotIdentityFingerprint,
      acceptedHistoricalPriceFingerprint: fp.acceptedHistoricalPriceFingerprint, realizedPnlFingerprint: fp.realizedPnlFingerprint,
      verifiedLotCount: 3, structuralLotCount: 3, realizedPnlUsd: realizedOf(legacy),
    }, 9))
    assert.equal(changed.deterministic, false)
    assert.equal(changed.firstDifference!.field, 'acceptedHistoricalPriceFingerprint')
    assert.equal(changed.differenceKind, 'accepted_evidence_changed')
  })

  it('10. canonical manifest replay stays verified (N→N), and a manifest frozen on the old overcount self-heals once the side record is repaired', async () => {
    const kv = fakeKv()
    const lots = fifo(swapPlusFeeEvents(), COST, { '0xsx': QUOTE })
    seedMarked(kv, lots)
    const manifest = await buildManifestFromCandidate({ identity, allCandidateLots: lots, candidateVerifiedLots: lots, structuralLotCount: lots.length, fingerprints: fingerprints(lots, null), realizedPnlUsd: null, verifiedPricingCoverage: 1, now: 1, loadEvidence: loaderOf(kv), computeFingerprints: fingerprints })
    for (let i = 0; i < 2; i += 1) {
      const replay = await replayManifest({ manifest, allCandidateLots: fifo(swapPlusFeeEvents(), COST, { '0xsx': QUOTE }), loadEvidence: loaderOf(kv), computeFingerprints: fingerprints })
      assert.equal(replay.outcome, 'applied')
      assert.equal(replay.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 3)
      assert.equal(replay.recomputedRealizedPnlUsd, -10)
    }
    // Old world: manifest frozen on the overcounted $180 side total.
    const oldKv = fakeKv()
    const legacy = fifo(swapPlusFeeEvents(), COST, { '0xsx': QUOTE }, true)
    seedMarked(oldKv, legacy, false)
    const oldManifest = await buildManifestFromCandidate({ identity, allCandidateLots: legacy, candidateVerifiedLots: legacy, structuralLotCount: 3, fingerprints: fingerprints(legacy, null), realizedPnlUsd: null, verifiedPricingCoverage: 1, now: 1, loadEvidence: loaderOf(oldKv), computeFingerprints: fingerprints })
    assert.equal(oldManifest.realizedPnlUsd, 80)
    // The repair scan rewrites the side record (reconcile seeding, as in test 9), then replays.
    await createPnlReconciliation({ logger: { warn() {} }, acceptedEvidenceKv: oldKv as never, multiEventTxSideKeys: multiEventTxSideKeys(swapPlusFeeEvents()) })
      .reconcile({ fifoEngineResult: fifoOutput(lots.map((l) => ({ ...l }))), pnlEngineResult: pnlSummary(3), syntheticPnlAssemblyOutput: null })
    const replay = await replayManifest({ manifest: oldManifest, allCandidateLots: lots, loadEvidence: loaderOf(oldKv), computeFingerprints: fingerprints })
    assert.equal(replay.outcome, 'unavailable', 'the frozen $80 sample is never re-published')
    assert.equal(replay.structuralIntegrityFailure, false)
    assert.ok((replay.manifestStructuralFailureAudit.staleEvidenceReasons.accepted_evidence_tx_side_allocation_repaired ?? 0) > 0)
    assert.equal(shouldRefreshPartiallyUnreproducibleManifest(replay, 3), true, 'refresh-eligible → rebuilt from the corrected evidence')
    // A tampered total that is NOT the documented repair stays a genuine conflict.
    const exitKey = acceptedEvidenceIdentityKeysForLot(lots.find((l) => l.closedTxHash === '0xsx')!)[1]
    oldKv.store.set(exitKey, { ...(oldKv.store.get(exitKey) as object), priceUsd: 95, valueUsd: 95 })
    const tampered = await replayManifest({ manifest: oldManifest, allCandidateLots: lots, loadEvidence: loaderOf(oldKv), computeFingerprints: fingerprints })
    assert.equal(tampered.structuralIntegrityFailure, true)
    assert.equal(ACCEPTED_EVIDENCE_SCHEMA_VERSION > 0, true)
  })
})
