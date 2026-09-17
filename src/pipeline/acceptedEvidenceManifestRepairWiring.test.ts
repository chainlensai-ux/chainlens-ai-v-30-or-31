// STATIC + INTEGRATION: accepted-evidence manifest repair must run on the LIVE scan before
// priceLotsForWallet hydrates verified coverage. Repair semantics are unchanged (seven gates).
//
// Run with:
//   npx tsx --test src/pipeline/acceptedEvidenceManifestRepairWiring.test.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import type { MatchedLot } from '../modules/fifoEngine/types.ts'
import { emptyUnrealizedReconciliation } from '../modules/fifoEngine/types.ts'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index.ts'
import { mergeNormalizedEvents } from '../modules/fifoEngine/utils.ts'
import type { NormalizedEvent } from '../modules/normalization/types.ts'
import type { PriceSourceFn, PriceSources } from '../modules/pricingAtTimeEngine/types.ts'
import { isCanonicalVerifiedPublishedLot } from '../lib/canonicalVerifiedLot.ts'
import {
  buildManifestFromCandidate, buildManifestIdentity, writeCanonicalPnlSampleManifest,
  type AcceptedEvidenceLoader, type CanonicalSampleManifestKvLike,
} from '../lib/canonicalPnlSampleManifest.ts'
import { buildScanDeterminismAudit } from '../lib/scanDeterminismAudit.ts'
import {
  buildAcceptedEvidenceEnvelope, buildAcceptedEvidenceKey, lotIdentityVersion, readAcceptedEvidence,
  readAcceptedEvidenceAnyLotVersion, type AcceptedEvidenceKvLike,
} from '../lib/acceptedEvidenceStore.ts'
import { maybeRepairExpiredAcceptedEvidenceFromManifest } from '../lib/acceptedEvidenceManifestRepair.ts'
import { createPnlReconciliation } from '../lib/pnlReconciliation.ts'
import { priceLotsForWallet } from './priceLotsForWallet.ts'
import type { FifoOutput } from '../modules/fifoEngine/types.ts'
import type { PnlSummaryResult } from '../modules/pnlEngine/types.ts'

const pipelineSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function position(label: string, needle: string): number {
  const index = pipelineSource.indexOf(needle)
  assert.notEqual(index, -1, `${label} must remain in the pipeline`)
  return index
}

it('HARD ASSERTION: live repair runs after structural lots exist and BEFORE priceLotsForWallet', () => {
  const repairCall = position('live repair wrapper', 'maybeRepairExpiredAcceptedEvidenceFromManifest({')
  const priceLotsCall = position('priceLotsForWallet call', 'const walletPriceLookups = await priceLotsForWallet({')
  const selectorDef = position('canonical sample selector', 'const canonicalSampleSelector: CanonicalSampleSelector =')
  assert.ok(repairCall < priceLotsCall, 'repair must run before priceLotsForWallet so the same scan hydrates repaired evidence')
  assert.ok(priceLotsCall < selectorDef, 'priceLotsForWallet must still precede canonical sample selection')
  assert.match(pipelineSource, /\[accepted-evidence-manifest-repair\]/)
  assert.match(pipelineSource, /affectedCurrentScan:/)
  assert.doesNotMatch(
    pipelineSource.slice(selectorDef),
    /maybeRepairExpiredAcceptedEvidenceFromManifest/,
    'repair must not be deferred until after candidate/manifest selection',
  )
})

const NOW = 1_700_000_000_000
const DAY_MS = 24 * 60 * 60 * 1000
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const COUNTERPARTY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const DESTROYED_EXIT_COUNT = 28
const TOTAL_LOTS = 98
const TARGET_REALIZED_PNL_USD = -70794.97
const TOTAL_CENTS = Math.round(TARGET_REALIZED_PNL_USD * 100)
const BASE_CENTS = Math.trunc(TOTAL_CENTS / TOTAL_LOTS)
const REMAINDER_CENTS = TOTAL_CENTS - BASE_CENTS * TOTAL_LOTS

function perLotPnlCents(index: number): number {
  return BASE_CENTS + (index < Math.abs(REMAINDER_CENTS) ? Math.sign(REMAINDER_CENTS) : 0)
}

function fakeKv(): AcceptedEvidenceKvLike & CanonicalSampleManifestKvLike & { store: Map<string, unknown>; writes: string[] } {
  const store = new Map<string, unknown>()
  const writes: string[] = []
  return {
    store,
    writes,
    get: async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
    set: async (key: string, value: unknown) => { writes.push(key); store.set(key, value); return 'OK' },
  }
}

function pricedLots(): MatchedLot[] {
  return Array.from({ length: TOTAL_LOTS }, (_, i) => {
    const pnlUsd = perLotPnlCents(i) / 100
    return {
      lotId: `solo-${i}`, token: `0xtoken${i}`, chain: 'base',
      openedAt: 3_000 + i, closedAt: 4_000 + i,
      openedTxHash: `0xsolo-buy-${i}`, closedTxHash: `0xsolo-sell-${i}`,
      amount: 1, costBasisUsd: 2_000, proceedsUsd: 2_000 + pnlUsd, realizedPnlUsd: pnlUsd,
      evidenceQuality: 'verified' as const,
    }
  })
}

function unpriced(lots: readonly MatchedLot[]): MatchedLot[] {
  return lots.map((l) => ({ ...l, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' as const }))
}

function event(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    provider: 'alchemy', chain: 'base', txHash: '0xtx', timestamp: '1970-01-01T00:00:03.000Z',
    fromAddress: COUNTERPARTY, toAddress: WALLET, contract: '0xtoken', symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

function eventsForLots(lots: readonly MatchedLot[]): NormalizedEvent[] {
  return lots.flatMap((l) => [
    event({
      txHash: l.openedTxHash, contract: l.token, timestamp: new Date(l.openedAt).toISOString(),
      direction: 'inbound', fromAddress: COUNTERPARTY, toAddress: WALLET,
    }),
    event({
      txHash: l.closedTxHash, contract: l.token, timestamp: new Date(l.closedAt).toISOString(),
      direction: 'outbound', fromAddress: WALLET, toAddress: COUNTERPARTY,
    }),
  ])
}

function structuralLotsFromEvents(events: NormalizedEvent[]): MatchedLot[] {
  const lots = buildLots(events, [])
  const sells = mergeNormalizedEvents(events, []).filter((e) => e.direction === 'outbound')
  return matchLotsFIFO(lots, sells).matchedLots
}

function identityFor(l: MatchedLot, side: 'entry' | 'exit') {
  return {
    chain: l.chain, token: l.token,
    txHash: side === 'entry' ? l.openedTxHash : l.closedTxHash,
    side, timestamp: side === 'entry' ? l.openedAt : l.closedAt,
    lotIdentityVersion: lotIdentityVersion(l),
  }
}

function seedEvidence(lots: readonly MatchedLot[], kv: AcceptedEvidenceKvLike & { store: Map<string, unknown> }): AcceptedEvidenceLoader {
  const groupTotals = new Map<string, { identity: ReturnType<typeof identityFor>; totalValueUsd: number }>()
  for (const l of lots) {
    for (const side of ['entry', 'exit'] as const) {
      const priceUsd = (side === 'entry' ? l.costBasisUsd : l.proceedsUsd) as number
      const idn = identityFor(l, side)
      const key = buildAcceptedEvidenceKey(idn)
      const existing = groupTotals.get(key)
      if (existing) existing.totalValueUsd += priceUsd * l.amount
      else groupTotals.set(key, { identity: idn, totalValueUsd: priceUsd * l.amount })
    }
  }
  for (const [key, { identity: idn, totalValueUsd }] of groupTotals) {
    kv.store.set(key, buildAcceptedEvidenceEnvelope({
      identity: idn, priceUsd: totalValueUsd, valueUsd: totalValueUsd,
      source: 'test-source', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: NOW,
    }))
  }
  return ({ lotIdentityVersion: version, ...rest }) =>
    version === null
      ? readAcceptedEvidenceAnyLotVersion(kv, rest, NOW)
      : readAcceptedEvidence(kv, { ...rest, lotIdentityVersion: version }, NOW)
}

function computeFingerprints(lots: readonly MatchedLot[], realizedPnlUsd: number | null) {
  const a = buildScanDeterminismAudit({ matchedLots: lots, realizedPnlUsd, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
  return {
    verifiedLotIdentityFingerprint: a.verifiedLotIdentityFingerprint,
    acceptedHistoricalPriceFingerprint: a.acceptedHistoricalPriceFingerprint,
    realizedPnlFingerprint: a.realizedPnlFingerprint,
    scanFingerprint: a.scanFingerprint,
  }
}

function fifo(matchedLots: MatchedLot[]): FifoOutput {
  const realized = matchedLots.reduce((sum, l) => sum + (l.realizedPnlUsd ?? 0), 0)
  return {
    matchedLots, unmatchedBuys: 0, unmatchedSells: 0, unmatchedBuyEvents: [], unmatchedSellEvents: [],
    realizedPnlUsd: realized, unrealizedPnlUsd: 0, costBasisUsd: 0, publicPnlStatus: 'ok',
    integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 },
    unrealizedPnlExcludedTokens: [], unrealizedReconciliation: emptyUnrealizedReconciliation(),
  }
}

function pnl(count: number): PnlSummaryResult {
  return {
    realizedPnlUsd: 0,
    closedLots: Array.from({ length: count }, (_, i) => ({
      lotId: `closed-${i}`, matchedBuyLotId: null, token: '0xtoken', symbol: 'TOK', chain: 'base',
      timestamp: 4_000 + i, txHash: `0xsolo-sell-${i}`, amount: '1', costUsdEstimate: 2_000, proceedsUsdEstimate: 1_000,
      realizedPnlUsd: perLotPnlCents(i) / 100, confidence: 'high', evidence: 'complete',
    })),
    winLossRate: { wins: 0, losses: count, evaluated: count, rate: 0 },
    chainBreakdown: [], confidenceBasis: { high: count, medium: 0, low: 0, aggregate: 'high' }, evidenceMissingCount: 0,
  }
}

function countingSources(): { sources: PriceSources; calls: () => number } {
  let calls = 0
  const fn: PriceSourceFn = () => { calls += 1; return null }
  return { sources: { primary: fn, fallback: fn }, calls: () => calls }
}

describe('live scan: repair before priceLotsForWallet', () => {
  it('HARD ASSERTION: 70 persisted sides + 98-lot manifest → same-scan priceLotsForWallet verifies 98, PnL -70794.97, no extra provider calls', async () => {
    const prior = process.env.COINPAPRIKA_HISTORICAL_ENABLED
    process.env.COINPAPRIKA_HISTORICAL_ENABLED = 'false'
    try {
      const kv = fakeKv()
      const lots = pricedLots()
      assert.equal(Math.round(lots.reduce((s, l) => s + (l.realizedPnlUsd ?? 0), 0) * 100) / 100, TARGET_REALIZED_PNL_USD)
      const events = eventsForLots(lots)
      const structural = structuralLotsFromEvents(events)
      assert.equal(structural.length, TOTAL_LOTS)

      const fingerprint = buildScanDeterminismAudit({
        matchedLots: structural, realizedPnlUsd: null, persistedEvidenceHits: 0, liveEvidenceMisses: 0,
      }).matchedLotFingerprint
      const identity = buildManifestIdentity({
        walletAddress: WALLET, chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: fingerprint,
      })
      const loader = seedEvidence(lots, kv)
      const realizedPnlUsd = TARGET_REALIZED_PNL_USD
      const manifest = await buildManifestFromCandidate({
        identity, allCandidateLots: lots, candidateVerifiedLots: lots,
        structuralLotCount: lots.length, fingerprints: computeFingerprints(lots, realizedPnlUsd),
        realizedPnlUsd, verifiedPricingCoverage: 1, now: NOW, loadEvidence: loader, computeFingerprints,
      })
      assert.equal(manifest.verifiedLotCount, TOTAL_LOTS)
      assert.equal(await writeCanonicalPnlSampleManifest(kv, manifest), true)

      const baseline = await createPnlReconciliation({
        logger: { warn() {} }, acceptedEvidenceKv: kv as never, now: () => NOW,
      }).reconcile({
        fifoEngineResult: fifo(unpriced(lots)), pnlEngineResult: pnl(TOTAL_LOTS), syntheticPnlAssemblyOutput: null,
      })
      assert.equal(baseline.publishedMatchedLots.filter(isCanonicalVerifiedPublishedLot).length, TOTAL_LOTS)
      const baselinePerformance = baseline.verifiedSamplePerformance

      for (let i = 0; i < DESTROYED_EXIT_COUNT; i += 1) {
        kv.store.delete(buildAcceptedEvidenceKey(identityFor(lots[i], 'exit')))
      }
      kv.writes.length = 0

      const starved = createPnlReconciliation({
        logger: { warn() {} }, acceptedEvidenceKv: kv as never, now: () => NOW + DAY_MS,
        priceKvClient: { getPriceHistorical: async () => null, getPricePrimary: async () => null },
        priceSources: { primary: async () => null },
      })
      const before = await starved.reconcile({
        fifoEngineResult: fifo(unpriced(lots)), pnlEngineResult: pnl(TOTAL_LOTS), syntheticPnlAssemblyOutput: null,
      })
      assert.equal(before.publishedMatchedLots.filter(isCanonicalVerifiedPublishedLot).length, TOTAL_LOTS - DESTROYED_EXIT_COUNT)

      const repair = await maybeRepairExpiredAcceptedEvidenceFromManifest({
        kv, walletAddress: WALLET, chains: ['base'], configuredWindowDays: 90,
        structuralMatchedLots: structural, now: NOW + DAY_MS,
      })
      assert.equal(repair.manifestFound, true)
      assert.equal(repair.affectedCurrentScan, true)
      assert.equal(repair.sidesReseeded, DESTROYED_EXIT_COUNT)
      assert.equal(repair.writeFailures, 0)
      const repairWrites = kv.writes.length
      assert.equal(repairWrites, DESTROYED_EXIT_COUNT, 'bounded writes: only the missing/stale sides')

      const counting = countingSources()
      const priced = await priceLotsForWallet({
        normalizedEvents: events, recoveredEvents: [], priceSources: counting.sources,
        acceptedEvidenceKv: kv, now: () => NOW + DAY_MS,
        coinPaprikaFetchImpl: async () => { throw new Error('provider must not be called'); },
      })
      assert.equal(priced.priceLotsCanonicalGapAudit.structuralLots, TOTAL_LOTS)
      assert.equal(priced.priceLotsCanonicalGapAudit.canonicalVerifiedLots, TOTAL_LOTS, 'PROOF: same-scan hydration sees repaired 98')
      assert.equal(counting.calls(), 0, 'PROOF: no extra provider calls — repaired sides skipped live pricing')

      const after = await starved.reconcile({
        fifoEngineResult: fifo(unpriced(lots)), pnlEngineResult: pnl(TOTAL_LOTS), syntheticPnlAssemblyOutput: null,
      })
      assert.equal(after.publishedMatchedLots.filter(isCanonicalVerifiedPublishedLot).length, TOTAL_LOTS)
      assert.equal(
        Math.round(after.publishedMatchedLots.reduce((s, l) => s + (l.realizedPnlUsd ?? 0), 0) * 100) / 100,
        TARGET_REALIZED_PNL_USD,
      )
      assert.equal(after.verifiedSamplePerformance.verifiedLotCount, TOTAL_LOTS)
      assert.deepEqual(
        after.verifiedSamplePerformance,
        baselinePerformance,
        'ROI/cost-basis/eligibility must be byte-identical to the never-degraded 98-lot sample',
      )
      assert.equal(after.verifiedSampleRealizedRoiPct, baseline.verifiedSampleRealizedRoiPct)

      kv.writes.length = 0
      const second = await maybeRepairExpiredAcceptedEvidenceFromManifest({
        kv, walletAddress: WALLET, chains: ['base'], configuredWindowDays: 90,
        structuralMatchedLots: structural, now: NOW + 2 * DAY_MS,
      })
      assert.equal(second.sidesReseeded, 0)
      assert.equal(second.affectedCurrentScan, false)
      assert.equal(kv.writes.length, 0, 'second warm scan must not duplicate repair writes')
    } finally {
      if (prior === undefined) delete process.env.COINPAPRIKA_HISTORICAL_ENABLED
      else process.env.COINPAPRIKA_HISTORICAL_ENABLED = prior
    }
  })

  it('HARD ASSERTION: fail-closed repair leaves unresolved sides unresolved and does not invent prices', async () => {
    const kv = fakeKv()
    const lots = pricedLots()
    const events = eventsForLots(lots)
    const structural = structuralLotsFromEvents(events)
    const fingerprint = buildScanDeterminismAudit({
      matchedLots: structural, realizedPnlUsd: null, persistedEvidenceHits: 0, liveEvidenceMisses: 0,
    }).matchedLotFingerprint
    const identity = buildManifestIdentity({
      walletAddress: WALLET, chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: fingerprint,
    })
    const loader = seedEvidence(lots, kv)
    const manifest = await buildManifestFromCandidate({
      identity, allCandidateLots: lots, candidateVerifiedLots: lots,
      structuralLotCount: lots.length, fingerprints: computeFingerprints(lots, TARGET_REALIZED_PNL_USD),
      realizedPnlUsd: TARGET_REALIZED_PNL_USD, verifiedPricingCoverage: 1, now: NOW, loadEvidence: loader, computeFingerprints,
    })
    await writeCanonicalPnlSampleManifest(kv, manifest)
    for (let i = 0; i < DESTROYED_EXIT_COUNT; i += 1) {
      kv.store.delete(buildAcceptedEvidenceKey(identityFor(lots[i], 'exit')))
    }

    const mismatched = await maybeRepairExpiredAcceptedEvidenceFromManifest({
      kv, walletAddress: WALLET, chains: ['eth'], configuredWindowDays: 90,
      structuralMatchedLots: structural, now: NOW + DAY_MS,
    })
    assert.equal(mismatched.manifestFound, false)
    assert.equal(mismatched.sidesReseeded, 0)
    assert.equal(mismatched.affectedCurrentScan, false)
    const missing = await readAcceptedEvidenceAnyLotVersion(kv, {
      chain: 'base', token: lots[0].token, txHash: lots[0].closedTxHash, side: 'exit', timestamp: lots[0].closedAt,
    }, NOW + DAY_MS)
    assert.equal(missing, null, 'unresolved side must stay unresolved when repair is refused')
  })
})
