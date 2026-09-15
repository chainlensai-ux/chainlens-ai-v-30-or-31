// REGRESSION FIXTURE: the historical 98-verified-lot canonical state must stay 98 across rescans.
//
// Models the production regression wallet 0x4dbb…ef96's real shape: 98 structural lots, 77 of them
// sharing ONE entry side (the USDC partial-fill group that production reported as
// `lotCount=77, priceRequirements=28, lotsVerified=49`), the other 21 on their own sides. The
// historical expected state is 98 verified / 100% pricing coverage; the regression reported 70
// verified / 71.43% with 28 `missing_price`.
//
// WHAT THIS DEFENDS, DISCLOSED — three independent failure modes, all of which produce the same
// visible symptom (verified lots shrinking) and all of which must stay fixed:
//   1. ACCEPTED-EVIDENCE EXPIRY (the confirmed root cause): evidence is reused but its TTL was never
//      refreshed, so every record died 30 days after its FIRST write and its lots degraded to
//      `missing_price`. Scans 2 and 3 below cross that original fuse with upstream pricing fully
//      dead, so the ONLY thing that can keep them verified is correctly-refreshed persisted
//      evidence.
//   2. SHARED-GROUP ALLOCATION: a 77-sibling side total must allocate a canonical-positive share to
//      every sibling, or the whole group falls through to live pricing.
//   3. The memoization / bounded-concurrency performance work: none of it may change how many lots
//      verify, or their values.
//
// Run directly with: npx tsx --test src/lib/canonical98LotDurability.test.ts

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FifoOutput, MatchedLot } from '../modules/fifoEngine/types'
import { emptyUnrealizedReconciliation } from '../modules/fifoEngine/types'
import type { PnlSummaryResult } from '../modules/pnlEngine/types'
import { createPnlReconciliation } from './pnlReconciliation.ts'

const quiet = { warn() {} }
const DAY_MS = 24 * 60 * 60 * 1000
const T0 = 1_700_000_000_000

const SHARED_ENTRY_TX = '0xshared-usdc-entry'
const SHARED_ENTRY_AT = 1_000
const SHARED_GROUP_SIZE = 77
const INDEPENDENT_LOTS = 21
const TOTAL_LOTS = SHARED_GROUP_SIZE + INDEPENDENT_LOTS // 98

// 98 structural lots. Every lot is individually priced and verified, so the historical expected
// state really is 98/98 at 100% coverage. The 77-lot group shares ONE entry tx side (a genuine
// partial fill) — the exact shape that makes shared-side allocation and single-record evidence
// coverage load-bearing.
function build98Lots(): MatchedLot[] {
  const shared: MatchedLot[] = Array.from({ length: SHARED_GROUP_SIZE }, (_, i) => ({
    lotId: `usdc-${i}`, token: '0xusdc', chain: 'base',
    openedAt: SHARED_ENTRY_AT, closedAt: 2_000 + i,
    openedTxHash: SHARED_ENTRY_TX, closedTxHash: `0xusdc-sell-${i}`,
    amount: 1, costBasisUsd: 10, proceedsUsd: 12, realizedPnlUsd: 2, evidenceQuality: 'verified',
  }))
  const independent: MatchedLot[] = Array.from({ length: INDEPENDENT_LOTS }, (_, i) => ({
    lotId: `solo-${i}`, token: `0xtoken${i}`, chain: 'base',
    openedAt: 3_000 + i, closedAt: 4_000 + i,
    openedTxHash: `0xsolo-buy-${i}`, closedTxHash: `0xsolo-sell-${i}`,
    amount: 1, costBasisUsd: 20, proceedsUsd: 17, realizedPnlUsd: -3, evidenceQuality: 'verified',
  }))
  return [...shared, ...independent]
}

/** The same 98 lots as a fresh fifoEngine recompute sees them: structurally identical, fully UNPRICED. */
function build98LotsUnpriced(): MatchedLot[] {
  return build98Lots().map((l) => ({
    ...l, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' as const,
  }))
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
      lotId: `closed-${i}`, matchedBuyLotId: null, token: '0xusdc', symbol: 'USDC', chain: 'base',
      timestamp: 2_000 + i, txHash: `0xsell${i}`, amount: '1', costUsdEstimate: 10, proceedsUsdEstimate: 12,
      realizedPnlUsd: 2, confidence: 'high', evidence: 'complete',
    })),
    winLossRate: { wins: count, losses: 0, evaluated: count, rate: 1 },
    chainBreakdown: [], confidenceBasis: { high: count, medium: 0, low: 0, aggregate: 'high' }, evidenceMissingCount: 0,
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

/**
 * One scan. `starved: true` kills every upstream price source, so the only way a lot can publish a
 * trusted value is the persisted accepted evidence written by an earlier scan.
 */
async function scanAt(nowMs: number, kv: ReturnType<typeof fakeKv>, lots: MatchedLot[], starved: boolean) {
  const r = createPnlReconciliation({
    logger: quiet,
    acceptedEvidenceKv: kv as never,
    now: () => nowMs,
    ...(starved
      ? {
          priceKvClient: { getPriceHistorical: async () => null, getPricePrimary: async () => null },
          priceSources: { primary: async () => null },
        }
      : {}),
  })
  return r.reconcile({
    fifoEngineResult: fifo(lots),
    pnlEngineResult: pnl(lots.length),
    syntheticPnlAssemblyOutput: null,
  })
}

const verifiedCount = (lots: readonly MatchedLot[]): number =>
  lots.filter((l) => l.evidenceQuality === 'verified' && l.costBasisUsd !== null && l.proceedsUsd !== null).length

const realizedTotal = (lots: readonly MatchedLot[]): number =>
  Math.round(lots.reduce((sum, l) => sum + (l.realizedPnlUsd ?? 0), 0) * 100) / 100

describe('canonical 98-lot state durability across rescans', () => {
  it('scan 1 seeds all 98 verified lots at 100% coverage', async () => {
    const kv = fakeKv()
    const summary = await scanAt(T0, kv, build98Lots(), false)
    assert.equal(summary.publishedMatchedLots.length, TOTAL_LOTS, 'all 98 structural lots must publish')
    assert.equal(verifiedCount(summary.publishedMatchedLots), TOTAL_LOTS, 'the historical expected state is 98 verified, not 70')
  })

  it('HARD ASSERTION: 98 stays 98 past the original 30-day evidence fuse, with PnL identical to the day-0 scan', async () => {
    const kv = fakeKv()

    // Day 0 — the historical canonical state.
    const scan1 = await scanAt(T0, kv, build98Lots(), false)
    const baselineVerified = verifiedCount(scan1.publishedMatchedLots)
    const baselinePnl = realizedTotal(scan1.publishedMatchedLots)
    assert.equal(baselineVerified, TOTAL_LOTS)

    // Day 20 — inside the original fuse. Upstream is dead: every value must come from the persisted
    // evidence, and reaching this branch is what slides the expiry forward.
    const scan2 = await scanAt(T0 + 20 * DAY_MS, kv, build98LotsUnpriced(), true)
    assert.equal(verifiedCount(scan2.publishedMatchedLots), TOTAL_LOTS, 'day 20 must still be 98 verified')
    assert.equal(realizedTotal(scan2.publishedMatchedLots), baselinePnl, 'day 20 realized PnL must be identical')

    // Day 35 — PAST the original T0 + 30d expiry. This is the exact instant the production wallet
    // collapsed 98 -> 70. Upstream is still dead, so only a correctly-refreshed record can carry it.
    const scan3 = await scanAt(T0 + 35 * DAY_MS, kv, build98LotsUnpriced(), true)
    assert.equal(
      verifiedCount(scan3.publishedMatchedLots), TOTAL_LOTS,
      'past the original fuse the wallet must STILL report 98 verified lots — this is the 98 -> 70 regression',
    )
    assert.equal(
      realizedTotal(scan3.publishedMatchedLots), baselinePnl,
      'realized PnL must be reproduced EXACTLY, never re-derived or drifted',
    )
  })

  it('the 77-lot shared USDC group survives intact — every sibling keeps its own unchanged value', async () => {
    const kv = fakeKv()
    await scanAt(T0, kv, build98Lots(), false)
    await scanAt(T0 + 20 * DAY_MS, kv, build98LotsUnpriced(), true) // the reuse that slides the expiry
    const later = await scanAt(T0 + 35 * DAY_MS, kv, build98LotsUnpriced(), true)

    const sharedGroup = later.publishedMatchedLots.filter((l) => l.openedTxHash === SHARED_ENTRY_TX)
    assert.equal(sharedGroup.length, SHARED_GROUP_SIZE, 'all 77 shared-side lots must still publish')
    assert.equal(
      verifiedCount(sharedGroup), SHARED_GROUP_SIZE,
      'production degraded this group to 49 verified + 28 missing_price — every sibling must stay verified',
    )
    for (const l of sharedGroup) {
      assert.equal(l.costBasisUsd, 10, 'each sibling keeps its own unchanged $10 entry share')
      assert.equal(l.proceedsUsd, 12, 'each sibling keeps its own unchanged $12 exit value')
    }
  })

  it('HONEST LIMIT, DISCLOSED: a wallet left unscanned for longer than the whole TTL still loses its evidence', async () => {
    // The guarantee the fix provides is precisely "a record reused at least once per half-TTL never
    // expires" — NOT "evidence lives forever". A wallet with no scan at all inside the full TTL has
    // genuinely expired KV records, and this pipeline correctly refuses to invent values for them
    // rather than pretending. Asserted explicitly so the contract's real edge is documented, not
    // discovered later as a surprise.
    const kv = fakeKv()
    await scanAt(T0, kv, build98Lots(), false)
    const afterLongGap = await scanAt(T0 + 35 * DAY_MS, kv, build98LotsUnpriced(), true)
    assert.equal(
      verifiedCount(afterLongGap.publishedMatchedLots), 0,
      'with no reuse inside the TTL the records are genuinely gone — the pipeline must fail closed, never fabricate',
    )
    assert.equal(afterLongGap.publishedMatchedLots.length, TOTAL_LOTS, 'the lots still exist structurally, just unverified')
  })

  it('a value this scan cannot prove is never invented — a genuinely new, unpriced lot stays unverified', async () => {
    // Guards the fix against becoming a weakening: refreshing a TTL must not make the pipeline
    // willing to publish a lot it has no evidence for.
    const kv = fakeKv()
    await scanAt(T0, kv, build98Lots(), false)
    await scanAt(T0 + 20 * DAY_MS, kv, build98LotsUnpriced(), true)
    const withNewcomer = [...build98LotsUnpriced(), {
      lotId: 'newcomer', token: '0xbrandnew', chain: 'base' as const,
      openedAt: 9_000, closedAt: 9_100, openedTxHash: '0xnew-buy', closedTxHash: '0xnew-sell',
      amount: 1, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' as const,
    }]
    const later = await scanAt(T0 + 35 * DAY_MS, kv, withNewcomer, true)
    const newcomer = later.publishedMatchedLots.find((l) => l.lotId === 'newcomer')
    assert.ok(newcomer, 'the new lot must still appear structurally')
    assert.notEqual(newcomer.evidenceQuality, 'verified', 'a lot with no evidence must NEVER be promoted to verified')
    assert.equal(newcomer.costBasisUsd, null, 'no value may be invented for it')
  })
})
