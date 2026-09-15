// REGRESSION: accepted-evidence TTL was never refreshed on successful reuse.
//
// PRODUCTION FAILURE THIS REPRODUCES (wallet 0x4dbb…ef96): a wallet whose canonical manifest held 98
// verified lots started reporting only 70 verified candidates / 71.43% pricing coverage, with 28
// lots classified `missing_price` and GoldRush making 19 live historical calls whose results were
// all unused. Realized PnL stayed exactly -70794.97 and the manifest refused to shrink
// (`growthBlockedReason=would_shrink_manifest`), proving the stored manifest and the published
// result were still intact — the loss was entirely on the CANDIDATE side.
//
// ROOT CAUSE, PROVEN BELOW: `ACCEPTED_EVIDENCE_TTL_SECONDS` is 30 days, and the canonical seeding
// pass (`seedAcceptedEvidenceForVerifiedLots` in pnlReconciliation.ts) returns WITHOUT writing
// whenever an existing record already covers the identical composition ("skip_already_covers"). The
// envelope's `expiresAt` and the KV `ex` are only ever set by a write — so a record that is
// successfully reused by every single scan still dies exactly 30 days after its FIRST write. Once it
// expires, `classifyAcceptedEvidence` returns `stale`, the priceLotsForWallet fast path finds
// nothing to hydrate, those sides fall through to live historical pricing, and old trades that no
// provider can still price become `missing_price` candidates. It is a time bomb on a 30-day fuse
// that fires for EVERY wallet, entirely independently of any performance change.
//
// THE FIX IS NOT A WEAKENING: the TTL is extended only for a record whose identity, composition
// fingerprint AND value this scan has just re-verified as unchanged. No threshold moves, no
// unverified price is promoted, no stronger record is overwritten — the same envelope is re-persisted
// with a later expiry (sliding expiration on proven reuse).
//
// Run directly with: npx tsx --test src/lib/acceptedEvidenceTtlRefresh.test.ts

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FifoOutput, MatchedLot } from '../modules/fifoEngine/types'
import { emptyUnrealizedReconciliation } from '../modules/fifoEngine/types'
import type { PnlSummaryResult } from '../modules/pnlEngine/types'
import { createPnlReconciliation } from './pnlReconciliation.ts'
import {
  ACCEPTED_EVIDENCE_TTL_SECONDS,
  buildAcceptedEvidenceKey,
  lotIdentityVersion as realLotIdentityVersion,
  type AcceptedEvidenceEnvelope,
} from './acceptedEvidenceStore.ts'

const quiet = { warn() {} }
const DAY_MS = 24 * 60 * 60 * 1000
const TTL_MS = ACCEPTED_EVIDENCE_TTL_SECONDS * 1000
const T0 = 1_700_000_000_000

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return {
    lotId: 'lot-1', token: '0xtoken', chain: 'base', openedAt: 1, closedAt: 2,
    openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 1,
    costBasisUsd: 10, proceedsUsd: 12, realizedPnlUsd: 2, evidenceQuality: 'verified',
    ...overrides,
  }
}
function fifo(overrides: Partial<FifoOutput> = {}): FifoOutput {
  return {
    matchedLots: [lot()], unmatchedBuys: 0, unmatchedSells: 0, unmatchedBuyEvents: [], unmatchedSellEvents: [],
    realizedPnlUsd: 2, unrealizedPnlUsd: 0, costBasisUsd: 10, publicPnlStatus: 'ok',
    integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 },
    unrealizedPnlExcludedTokens: [], unrealizedReconciliation: emptyUnrealizedReconciliation(), ...overrides,
  }
}
function pnl(closedLots = 1): PnlSummaryResult {
  return {
    realizedPnlUsd: 2,
    closedLots: Array.from({ length: closedLots }, (_, i) => ({
      lotId: `closed-${i}`, matchedBuyLotId: null, token: '0xtoken', symbol: 'TOK', chain: 'base',
      timestamp: 2 + i, txHash: `0xsell${i}`, amount: '1', costUsdEstimate: 10, proceedsUsdEstimate: 12,
      realizedPnlUsd: 2, confidence: 'high', evidence: 'complete',
    })),
    winLossRate: { wins: 1, losses: 0, evaluated: 1, rate: 1 },
    chainBreakdown: [], confidenceBasis: { high: 1, medium: 0, low: 0, aggregate: 'high' }, evidenceMissingCount: 0,
  }
}

function fakeKv(): { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<string>; store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    get: async (key: string) => (store.has(key) ? store.get(key) : null),
    set: async (key: string, value: unknown) => { store.set(key, value); return 'OK' },
  }
}

/** Runs one scan of the real reconciliation at a specific wall-clock instant. */
async function scanAt(nowMs: number, kv: ReturnType<typeof fakeKv>, lots: MatchedLot[]) {
  const r = createPnlReconciliation({
    logger: quiet,
    acceptedEvidenceKv: kv as never,
    now: () => nowMs,
  })
  return r.reconcile({
    fifoEngineResult: fifo({ matchedLots: lots }),
    pnlEngineResult: pnl(lots.length),
    syntheticPnlAssemblyOutput: null,
  })
}

function storedEntryEnvelope(kv: ReturnType<typeof fakeKv>, sourceLot: MatchedLot): AcceptedEvidenceEnvelope | undefined {
  const key = buildAcceptedEvidenceKey({
    chain: sourceLot.chain, token: sourceLot.token, txHash: sourceLot.openedTxHash,
    side: 'entry', timestamp: sourceLot.openedAt, lotIdentityVersion: realLotIdentityVersion(sourceLot),
  })
  return kv.store.get(key) as AcceptedEvidenceEnvelope | undefined
}

describe('accepted evidence — TTL must slide on proven reuse (28-lost-lot regression)', () => {
  it('seeds a record whose expiry is one full TTL from the first write', async () => {
    const kv = fakeKv()
    const subject = lot()
    await scanAt(T0, kv, [subject])
    const stored = storedEntryEnvelope(kv, subject)
    assert.ok(stored, 'the first scan must persist entry-side accepted evidence')
    assert.equal(stored.expiresAt, T0 + TTL_MS, 'the initial seed expires one full TTL after the first write')
  })

  it('HARD ASSERTION (the regression): a record reused by a later scan has its expiry EXTENDED, never left on the original fuse', async () => {
    const kv = fakeKv()
    const subject = lot()
    await scanAt(T0, kv, [subject])
    const afterSeed = storedEntryEnvelope(kv, subject)!
    assert.equal(afterSeed.expiresAt, T0 + TTL_MS)

    // A second scan 20 days later. The lot is identical and still fully priced, so the seeding pass
    // takes its "already covers this composition" path — the exact path that used to return without
    // writing, leaving the original expiry untouched and guaranteeing death at T0 + 30d.
    const twentyDaysLater = T0 + 20 * DAY_MS
    await scanAt(twentyDaysLater, kv, [lot()])
    const afterReuse = storedEntryEnvelope(kv, subject)!

    assert.equal(
      afterReuse.expiresAt, twentyDaysLater + TTL_MS,
      'proven reuse must slide the expiry forward a full TTL from the reuse instant — otherwise every record dies 30 days after its first write no matter how often it is successfully reused',
    )
    assert.ok(
      afterReuse.expiresAt > afterSeed.expiresAt,
      'the refreshed record must outlive the original fuse',
    )
  })

  it('the refreshed record is byte-identical apart from its expiry — no value, identity or provenance drift', async () => {
    const kv = fakeKv()
    const subject = lot()
    await scanAt(T0, kv, [subject])
    const before = { ...storedEntryEnvelope(kv, subject)! }

    await scanAt(T0 + 20 * DAY_MS, kv, [lot()])
    const after = storedEntryEnvelope(kv, subject)!

    // The value and every identity/provenance field must survive untouched — a TTL refresh is not a
    // licence to re-derive or launder the record.
    assert.equal(after.priceUsd, before.priceUsd, 'priceUsd must not move')
    assert.equal(after.valueUsd, before.valueUsd, 'valueUsd must not move')
    assert.equal(after.chain, before.chain)
    assert.equal(after.token, before.token)
    assert.equal(after.txHash, before.txHash)
    assert.equal(after.side, before.side)
    assert.equal(after.timestamp, before.timestamp)
    assert.equal(after.lotIdentityVersion, before.lotIdentityVersion)
    assert.equal(after.verificationStatus, before.verificationStatus)
    assert.equal(after.schemaVersion, before.schemaVersion)
    assert.equal(after.coveredLotCount, before.coveredLotCount)
    assert.equal(after.coverageFingerprint, before.coverageFingerprint)
    assert.equal(after.originWriter, before.originWriter, 'origin provenance must never be relabelled by a TTL refresh')
    assert.equal(after.valueType, before.valueType)
  })

  it('HARD ASSERTION (the production symptom): a lot reused every 20 days still rehydrates past the original 30-day fuse instead of degrading to missing_price', async () => {
    const kv = fakeKv()
    await scanAt(T0, kv, [lot()])
    // Reused at day 20 — well inside the original fuse, so the record is genuinely still valid here.
    await scanAt(T0 + 20 * DAY_MS, kv, [lot()])

    // Day 35: PAST the original T0 + 30d expiry. Upstream pricing is fully dead (every source returns
    // null), so the ONLY way this lot can still publish a trusted price is the persisted accepted
    // evidence. Before the fix the record was stale here and the lot fell through to live pricing —
    // exactly the 28 `missing_price` candidates and the 19 unused GoldRush calls seen in production.
    const dayThirtyFive = T0 + 35 * DAY_MS
    const starved = createPnlReconciliation({
      logger: quiet,
      acceptedEvidenceKv: kv as never,
      now: () => dayThirtyFive,
      priceKvClient: { getPriceHistorical: async () => null, getPricePrimary: async () => null },
      priceSources: { primary: async () => null },
    })
    const unpriced = lot({ costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const summary = await starved.reconcile({
      fifoEngineResult: fifo({ matchedLots: [unpriced] }),
      pnlEngineResult: pnl(1),
      syntheticPnlAssemblyOutput: null,
    })
    const published = summary.publishedMatchedLots.find((l) => l.lotId === 'lot-1')
    assert.ok(published, 'the lot must still publish at day 35, rehydrated from the refreshed accepted evidence')
    assert.equal(published.costBasisUsd, 10, 'the original, unchanged $10 entry value must be restored — never re-derived, never lost')
    assert.equal(published.proceedsUsd, 12, 'the original, unchanged $12 exit value must be restored')
    assert.equal(published.evidenceQuality, 'verified', 'the lot must remain VERIFIED, not degrade to missing_price')
  })
})
