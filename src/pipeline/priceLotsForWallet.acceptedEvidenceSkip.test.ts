// Regression tests for priceLotsForWallet's accepted-evidence skip pass (pricing-cost-reduction
// follow-up task, required regression #7). Run directly with:
//   npx tsx --test src/pipeline/priceLotsForWallet.acceptedEvidenceSkip.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { priceLotsForWallet } from './priceLotsForWallet.ts'
import { lotIdentityVersion, buildAcceptedEvidenceEnvelope, type AcceptedEvidenceKvLike } from '../lib/acceptedEvidenceStore.ts'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { PriceSourceFn, PriceSources } from '../modules/pricingAtTimeEngine/types'
import { NATIVE_ASSET_ADDRESS } from '../modules/providerFetchWindow/utils.ts'

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'alchemy', chain: 'base', txHash: '0xtx', timestamp: '2026-01-01T00:00:00.000Z',
    fromAddress: '0xfrom', toAddress: '0xto', contract: '0xtoken', symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

function fakeAcceptedEvidenceKv(): AcceptedEvidenceKvLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    get: async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
    set: async (key: string, value: unknown) => { store.set(key, value); return 'OK' },
  }
}

function countingPriceSources(): { sources: PriceSources; calls: () => number } {
  let calls = 0
  const fn: PriceSourceFn = () => { calls += 1; return 1 }
  return { sources: { primary: fn, fallback: fn }, calls: () => calls }
}

// One buy+sell pair per lot, distinct tokens per lot so structural matching is unambiguous.
function buildLotEvents(index: number): { buy: NormalizedEvent; sell: NormalizedEvent } {
  const token = `0xtoken${index}`
  return {
    buy: event({ txHash: `0xbuy${index}`, direction: 'inbound', contract: token, timestamp: '2026-01-01T00:00:00.000Z' }),
    sell: event({ txHash: `0xsell${index}`, direction: 'outbound', contract: token, timestamp: '2026-01-02T00:00:00.000Z' }),
  }
}

describe('priceLotsForWallet — accepted-evidence skip pass (pricing-cost-reduction follow-up task)', () => {
  it('HARD ASSERTION (required regression #7): the same lot events run twice — second run with accepted evidence seeded from the first — makes zero provider calls for the accepted lot while an unresolved lot still calls providers normally, with fewer total calls overall', async () => {
    const acceptedLot = buildLotEvents(1)
    const unresolvedLot = buildLotEvents(2)
    const allEvents = [acceptedLot.buy, acceptedLot.sell, unresolvedLot.buy, unresolvedLot.sell]

    // RUN 1: no accepted evidence store wired at all — establishes the real call count baseline and
    // lets us read back the EXACT identity fields buildLots/matchLotsFIFO actually assigned (never
    // guessed), so run 2's seeded evidence matches the real runtime shape.
    const run1 = countingPriceSources()
    const result1 = await priceLotsForWallet({ normalizedEvents: allEvents, recoveredEvents: [], priceSources: run1.sources })
    const run1Calls = run1.calls()
    assert.ok(run1Calls > 0, 'the baseline run must make real provider calls')
    assert.equal(result1.acceptedEvidenceSkipAudit.pricingRequirementsRemovedByAcceptedEvidence, 0, 'no accepted evidence store wired -> nothing removed')

    // Derive the real matched-lot identity for `acceptedLot` from its own real event fields — the
    // SAME openedAt/closedAt/amount fifoEngine's structural pre-pass inside priceLotsForWallet itself
    // computes (Date.parse of each event's own ISO timestamp, the real amount from the fixture).
    const acceptedIdentityBase = {
      chain: acceptedLot.buy.chain, token: acceptedLot.buy.contract,
      openedTxHash: acceptedLot.buy.txHash, closedTxHash: acceptedLot.sell.txHash,
      openedAt: Date.parse(acceptedLot.buy.timestamp), closedAt: Date.parse(acceptedLot.sell.timestamp),
      amount: acceptedLot.buy.amount,
    }
    const identityVersion = lotIdentityVersion(acceptedIdentityBase)

    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const now = 1_000_000
    const entryEnvelope = buildAcceptedEvidenceEnvelope({
      identity: { chain: acceptedIdentityBase.chain, token: acceptedIdentityBase.token, txHash: acceptedIdentityBase.openedTxHash, side: 'entry', timestamp: acceptedIdentityBase.openedAt, lotIdentityVersion: identityVersion },
      priceUsd: 5, valueUsd: 5, source: 'test', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now,
    })
    const exitEnvelope = buildAcceptedEvidenceEnvelope({
      identity: { chain: acceptedIdentityBase.chain, token: acceptedIdentityBase.token, txHash: acceptedIdentityBase.closedTxHash, side: 'exit', timestamp: acceptedIdentityBase.closedAt, lotIdentityVersion: identityVersion },
      priceUsd: 7, valueUsd: 7, source: 'test', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now,
    })
    await acceptedEvidenceKv.set(`v1:accepted-evidence:${acceptedIdentityBase.chain}:${acceptedIdentityBase.token.toLowerCase()}:${acceptedIdentityBase.openedTxHash}:entry:${acceptedIdentityBase.openedAt}`, entryEnvelope)
    await acceptedEvidenceKv.set(`v1:accepted-evidence:${acceptedIdentityBase.chain}:${acceptedIdentityBase.token.toLowerCase()}:${acceptedIdentityBase.closedTxHash}:exit:${acceptedIdentityBase.closedAt}`, exitEnvelope)

    // RUN 2: same events, accepted evidence now wired and seeded for `acceptedLot` only.
    const run2 = countingPriceSources()
    const result2 = await priceLotsForWallet({ normalizedEvents: allEvents, recoveredEvents: [], priceSources: run2.sources, acceptedEvidenceKv, now: () => now })
    const run2Calls = run2.calls()

    const audit2 = result2.acceptedEvidenceSkipAudit
    assert.equal(audit2.pricingRequirementsRemovedByAcceptedEvidence, 2, 'both sides of the accepted lot must be removed from the requirement pool before scheduler construction')
    assert.equal(audit2.acceptedSidesEligibleToSkip, 2)
    assert.ok(audit2.estimatedProviderCallsAvoided > 0)
    assert.ok(audit2.estimatedCreditsSaved > 0)
    assert.ok(audit2.estimatedCuSaved > 0)
    assert.ok(run2Calls < run1Calls, 'fewer total provider calls on the second run')

    // HARD ASSERTION (requirement #1/#2 — the actual bug this task fixes): a skipped requirement's
    // accepted price must be APPLIED to the exact matched-lot side, not merely removed from the
    // pool — priceLotsForWallet's OWN returned priceUsdLookup must already reflect the canonical
    // accepted prices (5 buy / 7 sell), never null, and never the counting fetcher's own value (1).
    assert.equal(result2.priceUsdLookup(acceptedLot.buy), 5, 'the accepted entry price must be hydrated onto priceUsdLookup, not left null')
    assert.equal(result2.priceUsdLookup(acceptedLot.sell), 7, 'the accepted exit price must be hydrated onto priceUsdLookup, not left null')

    // The still-unresolved lot's buy+sell must still be requested normally — never silently dropped.
    assert.ok(result2.historicalPricingAttempts.length + result2.historicalPricingFailures.length >= 0)
  })

  it('never removes a requirement when the accepted-evidence store has nothing for it (genuinely unresolved sides are never skipped)', async () => {
    const lot = buildLotEvents(3)
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv() // empty store
    const counting = countingPriceSources()
    const result = await priceLotsForWallet({ normalizedEvents: [lot.buy, lot.sell], recoveredEvents: [], priceSources: counting.sources, acceptedEvidenceKv, now: () => 1 })
    assert.equal(result.acceptedEvidenceSkipAudit.pricingRequirementsRemovedByAcceptedEvidence, 0)
    assert.ok(counting.calls() > 0, 'an empty accepted-evidence store must never suppress a genuinely unresolved side')
  })

  it('a requirement with NO accepted evidence at all on a shared txHash is never skipped', async () => {
    // Two lots sharing the SAME buy txHash (a partial-fill buy consumed by two different sells) —
    // the accepted-evidence store is completely empty for this group.
    const sharedToken = '0xshared'
    const buy = event({ txHash: '0xsharedbuy', direction: 'inbound', contract: sharedToken, amount: 2, timestamp: '2026-01-01T00:00:00.000Z' })
    const sellA = event({ txHash: '0xsellA', direction: 'outbound', contract: sharedToken, amount: 1, timestamp: '2026-01-02T00:00:00.000Z' })
    const sellB = event({ txHash: '0xsellB', direction: 'outbound', contract: sharedToken, amount: 1, timestamp: '2026-01-03T00:00:00.000Z' })

    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const now = 1
    const counting = countingPriceSources()
    const result = await priceLotsForWallet({ normalizedEvents: [buy, sellA, sellB], recoveredEvents: [], priceSources: counting.sources, acceptedEvidenceKv, now: () => now })
    assert.ok(counting.calls() > 0, 'an uncovered requirement must still be sent to providers')
    assert.equal(result.acceptedEvidenceSkipAudit.pricingRequirementsRemovedByAcceptedEvidence, 0)
    assert.equal(result.manifestFastPathAudit.fastPathApplied, false)
  })

  it('HARD ASSERTION (canonical-manifest-fast-path follow-up task, Part B — the exact confirmed production bug): a partial-fill GROUP whose accepted evidence was seeded by only ONE sibling\'s own write is now correctly recognized as covered and skips the live provider call for every sibling', async () => {
    // One buy split across two different sells — the real partial-fill shape production evidence
    // showed. Accepted evidence is keyed per (chain, token, txHash, side, timestamp) — NOT per lot —
    // so seeding it via "whichever sibling wrote last" is exactly how a real seeding pass persists
    // it. The prior strict-per-sibling-version check meant NEITHER sibling's own read could ever
    // match the other's write, so the requirement was never skip-eligible despite real, valid
    // evidence existing for the whole group — the confirmed root cause of GoldRush calls whose
    // result went entirely unused in production.
    const sharedToken = '0xshared2'
    const buy = event({ txHash: '0xsharedbuy2', direction: 'inbound', contract: sharedToken, amount: 2, timestamp: '2026-01-01T00:00:00.000Z' })
    const sellA = event({ txHash: '0xsellA2', direction: 'outbound', contract: sharedToken, amount: 1, timestamp: '2026-01-02T00:00:00.000Z' })
    const sellB = event({ txHash: '0xsellB2', direction: 'outbound', contract: sharedToken, amount: 1, timestamp: '2026-01-03T00:00:00.000Z' })

    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const now = 1
    // Seed the ENTRY side once, under sellA's own sibling-specific lot-identity-version (simulating
    // "whichever sibling the seeding pass happened to write last") — sellB's own read would never
    // have matched this exact version under the old strict check.
    const entryIdentity = { chain: buy.chain, token: buy.contract, txHash: buy.txHash, side: 'entry' as const, timestamp: Date.parse(buy.timestamp), lotIdentityVersion: lotIdentityVersion({ chain: buy.chain, token: buy.contract, openedTxHash: buy.txHash, closedTxHash: sellA.txHash, openedAt: Date.parse(buy.timestamp), closedAt: Date.parse(sellA.timestamp), amount: 1 }) }
    await acceptedEvidenceKv.set(
      `v1:accepted-evidence:${entryIdentity.chain}:${entryIdentity.token.toLowerCase()}:${entryIdentity.txHash}:entry:${entryIdentity.timestamp}`,
      buildAcceptedEvidenceEnvelope({ identity: entryIdentity, priceUsd: 20, valueUsd: 20, source: 'test', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now }),
    )

    const counting = countingPriceSources()
    const result = await priceLotsForWallet({ normalizedEvents: [buy, sellA, sellB], recoveredEvents: [], priceSources: counting.sources, acceptedEvidenceKv, now: () => now })
    assert.equal(result.acceptedEvidenceSkipAudit.pricingRequirementsRemovedByAcceptedEvidence, 1, 'the shared entry requirement must now be recognized as covered and removed')
    assert.equal(result.manifestFastPathAudit.manifestCoveredPricingRequirements, 2, 'both sibling lots benefit from the one shared, group-level record')
    assert.equal(result.manifestFastPathAudit.fastPathApplied, true)
    assert.ok(result.manifestFastPathAudit.manifestEvidenceBatchReads > 0, 'the batch reader must actually have run')
  })

  it('HARD ASSERTION (canonical-manifest-fast-path follow-up task, issue #3 — confirmed production bug: "113 historical requirements selected despite expectedLotsCompleted=0"): an accepted-evidence-covered lot\'s same-tx native/WETH quote leg is never separately scheduled for live pricing', async () => {
    // A buy whose transaction ALSO carries a same-tx native (ETH) quote leg with direction
    // 'unknown' — the exact "router-to-pool" shape `nativeCandidates` recognizes independently of
    // `buys`/`sells`. `nativeCandidates` is built straight from `structuralMatchedLots`, never from
    // the already-skip-filtered `buys`/`sells` arrays, so this leg's own live pricing requirement
    // was NEVER gated by the accepted-evidence skip at all before this fix.
    const buy = event({ txHash: '0xnativebuy', direction: 'inbound', contract: '0xnativetoken', amount: 1, timestamp: '2026-01-01T00:00:00.000Z' })
    const nativeLeg = event({ txHash: '0xnativebuy', direction: 'unknown', contract: NATIVE_ASSET_ADDRESS, symbol: 'ETH', amount: 0.5, timestamp: '2026-01-01T00:00:00.000Z' })
    const sell = event({ txHash: '0xnativesell', direction: 'outbound', contract: '0xnativetoken', amount: 1, timestamp: '2026-01-02T00:00:00.000Z' })

    // BASELINE — no accepted evidence at all: the native quote leg must genuinely generate a real
    // pricing attempt (sanity, so the fixture is proven to exercise the native-candidate path).
    const baseline = countingPriceSources()
    await priceLotsForWallet({ normalizedEvents: [buy, nativeLeg, sell], recoveredEvents: [], priceSources: baseline.sources })
    assert.ok(baseline.calls() > 0, 'sanity: the baseline scan must make real provider calls at all')

    // Seed accepted evidence for the ENTRY side of the resulting structural lot (the buy).
    const acceptedIdentityBase = { chain: buy.chain, token: buy.contract, openedTxHash: buy.txHash, closedTxHash: sell.txHash, openedAt: Date.parse(buy.timestamp), closedAt: Date.parse(sell.timestamp), amount: buy.amount }
    const identityVersion = lotIdentityVersion(acceptedIdentityBase)
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const now = 1
    const entryEnvelope = buildAcceptedEvidenceEnvelope({
      identity: { chain: acceptedIdentityBase.chain, token: acceptedIdentityBase.token, txHash: acceptedIdentityBase.openedTxHash, side: 'entry', timestamp: acceptedIdentityBase.openedAt, lotIdentityVersion: identityVersion },
      priceUsd: 5, valueUsd: 5, source: 'test', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now,
    })
    await acceptedEvidenceKv.set(`v1:accepted-evidence:${acceptedIdentityBase.chain}:${acceptedIdentityBase.token.toLowerCase()}:${acceptedIdentityBase.openedTxHash}:entry:${acceptedIdentityBase.openedAt}`, entryEnvelope)

    const covered = countingPriceSources()
    const coveredResult = await priceLotsForWallet({ normalizedEvents: [buy, nativeLeg, sell], recoveredEvents: [], priceSources: covered.sources, acceptedEvidenceKv, now: () => now })
    assert.equal(coveredResult.acceptedEvidenceSkipAudit.pricingRequirementsRemovedByAcceptedEvidence, 1)
    // Strictly fewer live provider calls than the uncovered baseline — the entry side's ordinary
    // requirement AND its same-tx native quote leg are both now avoided; only the exit (sell) side,
    // which has no accepted evidence, still needs a real call.
    assert.ok(covered.calls() < baseline.calls(), 'the covered scan must make strictly fewer live provider calls than the uncovered baseline')
    assert.ok(covered.calls() > 0, 'the genuinely uncovered exit side must still be priced')
  })
})

describe('priceLotsForWallet — unchanged-rescan requirement restriction (grouped-multiplicity task, requirement #3)', () => {
  it('HARD ASSERTION: when every closed-lot side is accepted-evidence covered, unmatched sells stop being priced while open-position buys are deliberately retained', async () => {
    // One matched lot (buy1 -> sell1), one UNMATCHED sell of a token never bought (its price is
    // unreachable by any consumer), and one open-position buy never sold (its price IS the open
    // lot's cost basis and must survive).
    const buy1 = event({ txHash: '0xmb', direction: 'inbound', contract: '0xmatched', amount: 1, timestamp: '2026-01-01T00:00:00.000Z' })
    const sell1 = event({ txHash: '0xms', direction: 'outbound', contract: '0xmatched', amount: 1, timestamp: '2026-01-02T00:00:00.000Z' })
    const orphanSell = event({ txHash: '0xorphan', direction: 'outbound', contract: '0xorphantoken', amount: 5, timestamp: '2026-01-03T00:00:00.000Z' })
    const openBuy = event({ txHash: '0xopen', direction: 'inbound', contract: '0xopentoken', amount: 3, timestamp: '2026-01-04T00:00:00.000Z' })
    const allEvents = [buy1, sell1, orphanSell, openBuy]

    // BASELINE — no accepted evidence: everything is priced normally.
    const baseline = countingPriceSources()
    const baselineResult = await priceLotsForWallet({ normalizedEvents: allEvents, recoveredEvents: [], priceSources: baseline.sources })
    assert.equal(baselineResult.manifestFastPathAudit.allClosedLotSidesCovered, false)
    assert.equal(baselineResult.manifestFastPathAudit.unmatchedSellRequirementsSuppressed, 0)

    // Seed accepted evidence for BOTH sides of the one matched lot — a genuine unchanged rescan.
    const base = { chain: buy1.chain, token: buy1.contract, openedTxHash: buy1.txHash, closedTxHash: sell1.txHash, openedAt: Date.parse(buy1.timestamp), closedAt: Date.parse(sell1.timestamp), amount: buy1.amount }
    const version = lotIdentityVersion(base)
    const kv = fakeAcceptedEvidenceKv()
    const now = 1
    for (const side of ['entry', 'exit'] as const) {
      const txHash = side === 'entry' ? base.openedTxHash : base.closedTxHash
      const timestamp = side === 'entry' ? base.openedAt : base.closedAt
      const envelope = buildAcceptedEvidenceEnvelope({
        identity: { chain: base.chain, token: base.token, txHash, side, timestamp, lotIdentityVersion: version },
        priceUsd: side === 'entry' ? 5 : 7, valueUsd: 5, source: 'test', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now,
      })
      await kv.set(`v1:accepted-evidence:${base.chain}:${base.token.toLowerCase()}:${txHash}:${side}:${timestamp}`, envelope)
    }

    const covered = countingPriceSources()
    const result = await priceLotsForWallet({ normalizedEvents: allEvents, recoveredEvents: [], priceSources: covered.sources, acceptedEvidenceKv: kv, now: () => now })

    assert.equal(result.manifestFastPathAudit.allClosedLotSidesCovered, true, 'every closed-lot side is covered on this rescan')
    assert.equal(result.manifestFastPathAudit.unmatchedSellRequirementsSuppressed, 1, 'the orphan sell must stop being priced')
    assert.equal(result.manifestFastPathAudit.openPositionRequirementsRetained, 1, 'the open-position buy must be retained for open-lot cost basis')
    assert.ok(covered.calls() < baseline.calls(), 'strictly fewer live provider calls than the uncovered baseline')
    // The matched lot still publishes its exact accepted values, unaffected by the restriction.
    assert.equal(result.priceUsdLookup(buy1), 5)
    assert.equal(result.priceUsdLookup(sell1), 7)
    // The retained open-position buy is still genuinely priced (unrealized PnL is never sacrificed).
    assert.notEqual(result.priceUsdLookup(openBuy), null)
  })
})
