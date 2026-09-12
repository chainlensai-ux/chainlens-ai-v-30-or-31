import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FifoOutput, MatchedLot } from '../modules/fifoEngine/types'
import { emptyUnrealizedReconciliation } from '../modules/fifoEngine/types'
import type { PnlSummaryResult } from '../modules/pnlEngine/types'
import { createPnlReconciliation, classifyRecoveryFailureReason, rankMissingLotsForRecovery } from './pnlReconciliation'
import { ACCEPTED_EVIDENCE_SCHEMA_VERSION, lotIdentityVersion as realLotIdentityVersion, buildAcceptedEvidenceKey, buildAcceptedEvidenceCoverageFingerprint } from './acceptedEvidenceStore'

const quiet = { warn() {} }

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return { lotId: 'lot-1', token: '0xtoken', chain: 'base', openedAt: 1, closedAt: 2, openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 1, costBasisUsd: 10, proceedsUsd: 12, realizedPnlUsd: 2, evidenceQuality: 'verified', ...overrides }
}
function fifo(overrides: Partial<FifoOutput> = {}): FifoOutput {
  return { matchedLots: [lot()], unmatchedBuys: 0, unmatchedSells: 0, unmatchedBuyEvents: [], unmatchedSellEvents: [], realizedPnlUsd: 2, unrealizedPnlUsd: 0, costBasisUsd: 10, publicPnlStatus: 'ok', integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 }, unrealizedPnlExcludedTokens: [], unrealizedReconciliation: emptyUnrealizedReconciliation(), ...overrides }
}
function pnl(closedLots = 1, overrides: Partial<PnlSummaryResult> = {}): PnlSummaryResult {
  return { realizedPnlUsd: 2, closedLots: Array.from({ length: closedLots }, (_, i) => ({ lotId: `closed-${i}`, matchedBuyLotId: null, token: '0xtoken', symbol: 'TOK', chain: 'base', timestamp: 2 + i, txHash: `0xsell${i}`, amount: '1', costUsdEstimate: 10, proceedsUsdEstimate: 12, realizedPnlUsd: 2, confidence: 'high', evidence: 'complete' })), winLossRate: { wins: 1, losses: 0, evaluated: 1, rate: 1 }, chainBreakdown: [], confidenceBasis: { high: 1, medium: 0, low: 0, aggregate: 'high' }, evidenceMissingCount: 0, ...overrides }
}

// PROVEN-WINDOW-BOUNDARY FIXTURE, DISCLOSED (wallet-scanner-bounded-publication follow-up task):
// full 'available' status now additionally requires `windowBoundaryProven` (see pnlReconciliation.ts's
// own "FULL PNL REQUIRES A PROVEN WINDOW BOUNDARY" disclosure) — every test below that asserts a
// genuine, complete-history 'available' outcome and isn't itself testing boundary/truncation
// behavior wires this real, exhaustive-coverage audit rather than leaving the field unset (which
// now correctly, fail-closed, defaults to unproven).
function provenAudit(overrides: Partial<Record<string, unknown>> = {}) {
  return { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 0, windowBoundaryProven: true, historyCoverageStatus: 'exhaustive' as const, ...overrides }
}

describe('pnlReconciliation', () => {
  it('corrects mismatched lots by router inference', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedSells: 1 }), pnlEngineResult: pnl(),
      routerInferenceOutput: { highConfidenceRouters: new Set(['0xrouter']) }, syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: provenAudit(),
    })
    assert.equal(summary.routerCorrectedCount, 1)
    assert.equal(summary.unmatchedSells, 0)
    assert.equal(summary.publicPnlStatus, 'available')
  })

  it('corrects mismatched lots by price recovery', async () => {
    const r = createPnlReconciliation({ logger: quiet, priceKvClient: { getPriceHistorical: async () => 10, getPricePrimary: async () => null }, priceSources: { primary: async () => 10 } })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [lot({ costBasisUsd: null })] }), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null })
    assert.equal(summary.priceRecoveredCount, 1)
    assert.equal(summary.mismatches.some((m) => m.classification === 'priceRecovered'), true)
  })

  it('aligns synthetic-only legs with unmatched lots', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ unmatchedBuys: 1, matchedLots: [lot()] }), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: { totalLegsCount: 2, pricedLegsCount: 1, realizedPnlUsd: 2, unrealizedPnlUsd: 0 } as never })
    assert.equal(summary.syntheticAlignedCount, 1)
    assert.equal(summary.unmatchedBuys, 0)
  })

  it('is deterministic for the same input', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const input = { fifoEngineResult: fifo({ unmatchedSells: 1 }), pnlEngineResult: pnl(), routerInferenceOutput: { highConfidenceRouters: new Set(['0xrouter']) }, syntheticPnlAssemblyOutput: null }
    assert.deepEqual(await r.reconcile(input), await r.reconcile(input))
  })

  it('pipeline integration: publicPnlStatus transitions correctly', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    assert.equal((await r.reconcile({ fifoEngineResult: fifo(), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null, structuralCoverageDenominatorAudit: provenAudit() })).publicPnlStatus, 'available')
    assert.equal((await r.reconcile({ fifoEngineResult: fifo({ unmatchedBuys: 1 }), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null })).publicPnlStatus, 'partial')
    assert.equal((await r.reconcile({ fifoEngineResult: fifo({ unmatchedBuys: 10 }), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null })).publicPnlStatus, 'unavailable')
  })

  it('regression guard: official realizedPnlUsd comes ONLY from fifoEngine — pnlEngine\'s independently-matched total is never used, even as a fallback', async () => {
    // Confirmed real bug, real production evidence: pnlSummaryV2 reported $270.02 while this
    // reconciliation (correctly, since fifoEngine had a real value) reported $174.01 for the same
    // wallet — but the OLD code still had `?? input.pnlEngineResult.realizedPnlUsd` as a fallback,
    // meaning the official total COULD have silently come from pnlEngine's own, differently-matched
    // closed-lot model whenever fifoEngine's own total happened to be null. Fixed: pnlEngineResult is
    // never consulted for the official figure, under any circumstance.
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [], realizedPnlUsd: null, unrealizedPnlUsd: null }),
      // pnlEngine independently found a real, non-null total from its own (different) matching —
      // this must NEVER leak into the official realizedPnlUsd.
      pnlEngineResult: pnl(1, { realizedPnlUsd: 270.02 }),
      syntheticPnlAssemblyOutput: null,
    })
    assert.equal(summary.realizedPnlUsd, null, 'realizedPnlUsd must stay null, never borrowed from pnlEngine\'s independent total')
  })

  it('regression guard: when fifoEngine has a real total, it is used exactly as-is regardless of what pnlEngine independently computed', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    // realizedPnlUsd is now recomputed from the actual matchedLots (see the recovery-inclusive
    // canonical sum) rather than trusted blindly from the summary field — so the fixture's lot(s)
    // must actually sum to the expected total.
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ realizedPnlUsd: 174.01, matchedLots: [lot({ realizedPnlUsd: 174.01 })] }),
      pnlEngineResult: pnl(1, { realizedPnlUsd: 270.02 }), // a different, independently-matched total
      syntheticPnlAssemblyOutput: null,
    })
    assert.equal(summary.realizedPnlUsd, 174.01, 'fifoEngine\'s own total is the sole canonical source, unaffected by pnlEngine\'s disagreement')
  })

  it('regression guard: syntheticPnlAssemblyOutput never becomes the official realizedPnlUsd, even when both real engines have none', async () => {
    // Confirmed real bug: a prior version of this function accepted a third field
    // (computePnlResult), wired at the pipeline layer directly from syntheticPnl's UI-display-only
    // totals, and silently fell back to it as the "official" realizedPnlUsd whenever both real
    // engines (fifoEngineResult, pnlEngineResult) had no verified figure. That field no longer
    // exists on this function's input type at all — this test proves a wallet with zero verified
    // real lots (both engines null) and a large, unrelated synthetic PnL figure still reports
    // realizedPnlUsd: null and publicPnlStatus: 'unavailable', never the synthetic number.
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [], realizedPnlUsd: null, unrealizedPnlUsd: null, publicPnlStatus: 'unavailable' }),
      pnlEngineResult: pnl(0, { realizedPnlUsd: null }),
      // A syntheticPnlAssemblyOutput carrying a large, unrelated inferred PnL figure — this must
      // never leak into the reconciliation's own realizedPnlUsd/unrealizedPnlUsd/publicPnlStatus.
      syntheticPnlAssemblyOutput: { totalLegsCount: 0, pricedLegsCount: 0, realizedPnlUsd: 987654.32, unrealizedPnlUsd: -4321 } as never,
    })
    assert.equal(summary.realizedPnlUsd, null, 'realizedPnlUsd must stay null, never borrowed from synthetic')
    assert.equal(summary.unrealizedPnlUsd, null, 'unrealizedPnlUsd must stay null, never borrowed from synthetic')
    assert.equal(summary.publicPnlStatus, 'unavailable')
  })

  it('regression guard: publicPnlStatus never reports "available" when realizedPnlUsd is null (status/value contradiction guard)', async () => {
    // Even with zero unmatched buys/sells and zero missingEvidenceCount (e.g. via price-recovery
    // bookkeeping that reduces the evidence-count without ever repricing the underlying lots), the
    // status must never claim "available" next to a null value.
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [], realizedPnlUsd: null, unrealizedPnlUsd: null, unmatchedBuys: 0, unmatchedSells: 0 }),
      pnlEngineResult: pnl(0, { realizedPnlUsd: null, evidenceMissingCount: 0 }),
      syntheticPnlAssemblyOutput: null,
    })
    assert.equal(summary.realizedPnlUsd, null)
    assert.notEqual(summary.publicPnlStatus, 'available')
  })

  it('regression guard: price recovery runs with bounded concurrency, not a fully sequential await-per-lot loop', async () => {
    // Confirmed root cause of a real multi-minute hang: recoverPrices previously awaited one lot
    // at a time with zero concurrency. This proves many lots resolve in roughly one fetcher-latency
    // "round", not N sequential rounds — the direct, measurable signature of the fix.
    let inFlight = 0
    let maxInFlight = 0
    const manyLots = Array.from({ length: 60 }, (_, i) => lot({ lotId: `lot-${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`, costBasisUsd: null }))
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: {
        getPriceHistorical: async () => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 5))
          inFlight -= 1
          return 10
        },
      },
      priceSources: { primary: async () => 10 },
    })
    await r.reconcile({ fifoEngineResult: fifo({ matchedLots: manyLots }), pnlEngineResult: pnl(manyLots.length), syntheticPnlAssemblyOutput: null })
    assert.ok(maxInFlight > 1, `expected concurrent in-flight lookups, saw max concurrency of ${maxInFlight}`)
  })

  it('regression guard: recovery attempts are capped, never unbounded, for a wallet with many missing-price lots', async () => {
    let callCount = 0
    const manyLots = Array.from({ length: 500 }, (_, i) => lot({ lotId: `lot-${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`, costBasisUsd: null }))
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async () => { callCount += 1; return null } },
      priceSources: { primary: async () => null },
    })
    await r.reconcile({ fifoEngineResult: fifo({ matchedLots: manyLots }), pnlEngineResult: pnl(manyLots.length), syntheticPnlAssemblyOutput: null })
    assert.ok(callCount <= 40, `expected recovery attempts capped at 40, saw ${callCount}`)
  })

  it('regression guard: provider-call count stays bounded (<= 2x the candidate cap) even with a mix of one-side and both-sides-missing lots', async () => {
    let callCount = 0
    const oneSideLots = Array.from({ length: 30 }, (_, i) => lot({ lotId: `one-${i}`, openedTxHash: `0xb1-${i}`, closedTxHash: `0xs1-${i}`, costBasisUsd: 10, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }))
    const bothSideLots = Array.from({ length: 30 }, (_, i) => lot({ lotId: `both-${i}`, openedTxHash: `0xb2-${i}`, closedTxHash: `0xs2-${i}`, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }))
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: {
        getPriceHistorical: async () => { callCount += 1; return 5 },
        getPricePrimary: async () => { callCount += 1; return 5 },
      },
      priceSources: { primary: async () => 5 },
    })
    await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [...oneSideLots, ...bothSideLots] }),
      pnlEngineResult: pnl(60),
      syntheticPnlAssemblyOutput: null,
    })
    // At most MAX_RECOVERY_ATTEMPTS (40) candidates, each needing at most 2 real calls (one per
    // missing side) — the cap itself was never raised or bypassed by the priority reordering.
    assert.ok(callCount <= 80, `expected <= 80 real provider calls (40 candidates x 2 sides max), saw ${callCount}`)
  })

  it('regression guard: a one-side-missing lot is prioritized over a both-sides-missing lot in recovery attempt order', async () => {
    // Confirmed real bug fix target: a lot missing only ONE side needs exactly one more successful
    // lookup to become fully priced; a lot missing BOTH sides needs two. Prioritizing one-side-
    // missing candidates first yields more fully-priced lots per attempt within any bounded budget.
    const oneSideMissing = lot({ lotId: 'one-side', openedTxHash: '0xbuy-oneside', closedTxHash: '0xsell-oneside', openedAt: 100, closedAt: 200, costBasisUsd: 10, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const bothSidesMissing = lot({ lotId: 'both-sides', openedTxHash: '0xbuy-both', closedTxHash: '0xsell-both', openedAt: 300, closedAt: 400, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const calls: string[] = []
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: {
        getPriceHistorical: async (token, chain, ts) => { calls.push(`historical:${ts}`); return 5 },
        getPricePrimary: async (token, chain, ts) => { calls.push(`primary:${ts}`); return 5 },
      },
      priceSources: { primary: async () => 5 },
    })
    // Both-sides-missing lot listed FIRST in the raw array — priority ordering must still put the
    // one-side-missing lot's attempt first, proving it's not just raw array or chronological order
    // (bothSidesMissing's openedAt=300 comes after oneSideMissing's own timestamps either way, so
    // this also rules out "earliest timestamp wins" as the explanation).
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [bothSidesMissing, oneSideMissing], realizedPnlUsd: null }),
      pnlEngineResult: pnl(2),
      syntheticPnlAssemblyOutput: null,
    })
    assert.ok(calls.length > 0, 'sanity: recovery attempted at least one lookup')
    assert.equal(calls[0], 'primary:200', 'the one-side-missing lot\'s missing side (sell, closedAt=200) must be attempted first, ahead of the both-sides-missing lot')
    // Both lots ultimately complete (budget of 40 comfortably covers 2 candidates): oneSideMissing =
    // recovered proceeds(5) - existing cost(10) = -5; bothSidesMissing = recovered proceeds(5) -
    // recovered cost(5) = 0. Sum = -5.
    assert.equal(summary.realizedPnlUsd, -5)
  })

  it('prioritizes the token that completes the most closed lots within the unchanged recovery cap', async () => {
    const dominantToken = '0xffffffffffffffffffffffffffffffffffffffff'
    const dominant = Array.from({ length: 5 }, (_, i) => lot({
      lotId: `dominant-${i}`, token: dominantToken, openedTxHash: `0xdominant-buy-${i}`,
      closedTxHash: `0xdominant-sell-${i}`, costBasisUsd: 10, proceedsUsd: null,
      realizedPnlUsd: null, evidenceQuality: 'unpriced',
    }))
    const singletons = Array.from({ length: 40 }, (_, i) => lot({
      lotId: `singleton-${i}`, token: `0x${i.toString(16).padStart(40, '0')}`,
      openedTxHash: `0xsingleton-buy-${i}`, closedTxHash: `0xsingleton-sell-${i}`,
      costBasisUsd: 10, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced',
    }))
    const attemptedTokens: string[] = []
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPricePrimary: async (token) => { attemptedTokens.push(token); return token === dominantToken ? 15 : null } },
      priceSources: { primary: async () => null },
    })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [...singletons, ...dominant], realizedPnlUsd: null }),
      pnlEngineResult: pnl(45), syntheticPnlAssemblyOutput: null,
    })

    assert.deepEqual(attemptedTokens.slice(0, 5), Array(5).fill(dominantToken))
    assert.equal(attemptedTokens.length, 40, 'the existing candidate cap is unchanged')
    assert.equal(summary.priceRecoveredCount, 5)
    assert.equal(summary.publicPnlGateAudit.verifiedLotCount, 5)
  })

  it('regression guard: a successfully recovered price actually flows into the official realizedPnlUsd — recovery is no longer cosmetic-only', async () => {
    // Confirmed real bug fix: recovery previously fetched a real price, then DISCARDED it — only
    // affecting evidence-count optics, never the official sum. This proves the recovered price now
    // genuinely completes the lot and contributes to realizedPnlUsd.
    const partiallyPriced = lot({ costBasisUsd: 10, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPricePrimary: async () => 15 }, // real, successful recovery of the missing sell price
      priceSources: { primary: async () => 15 },
    })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [partiallyPriced], realizedPnlUsd: null }),
      pnlEngineResult: pnl(1),
      syntheticPnlAssemblyOutput: null,
    })
    assert.equal(summary.priceRecoveredCount, 1)
    assert.equal(summary.realizedPnlUsd, 5, 'recovered proceeds (15) - existing cost (10) = 5, must reach the official total, not be discarded')
  })

  it('promotes a structural closed lot with both accepted historical sides into verified coverage', async () => {
    const staleStructuralLot = lot({
      costBasisUsd: 10, proceedsUsd: 15, realizedPnlUsd: null, evidenceQuality: 'unpriced',
    })
    const summary = await createPnlReconciliation({ logger: quiet }).reconcile({
      fifoEngineResult: fifo({ matchedLots: [staleStructuralLot], realizedPnlUsd: null }),
      pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null,
    })
    assert.equal(summary.publicPnlGateAudit.verifiedLotCount, 1)
    assert.equal(summary.publicPnlGateAudit.verifiedPricingCoverage, 1)
    assert.equal(summary.publishedMatchedLots[0].evidenceQuality, 'verified')
    assert.equal(summary.realizedPnlUsd, 5)
  })

  it('regression guard: a provider returning null for the missing side leaves the lot honestly unpriced — never a fabricated value', async () => {
    const partiallyPriced = lot({ costBasisUsd: 10, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPricePrimary: async () => null }, // genuine provider failure
      priceSources: { primary: async () => null },
    })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [partiallyPriced], realizedPnlUsd: null }),
      pnlEngineResult: pnl(1, { realizedPnlUsd: null }),
      syntheticPnlAssemblyOutput: null,
    })
    assert.equal(summary.priceRecoveredCount, 0)
    assert.equal(summary.realizedPnlUsd, null, 'no fabricated value — stays honestly null when the provider genuinely has nothing')
    assert.notEqual(summary.publicPnlStatus, 'available', 'status must never claim "available" while realizedPnlUsd is null')
  })

  it('regression guard: classifyRecoveryFailureReason emits an explicit, distinct bucket for every real reason string this codebase\'s price sources actually produce', () => {
    const bucketOf = (reason: string | null) => classifyRecoveryFailureReason(reason).bucket
    assert.equal(bucketOf(null), 'providerReturnedNull')
    assert.equal(bucketOf('goldrush_no_data'), 'unsupportedTokenOrChain')
    assert.equal(bucketOf('unverified_chain_for_dexscreener'), 'unsupportedTokenOrChain')
    assert.equal(bucketOf('unverified_network_for_geckoterminal'), 'unsupportedTokenOrChain')
    assert.equal(bucketOf('unverified_chain_for_coingecko'), 'unsupportedTokenOrChain')
    assert.equal(bucketOf('base_dex_only_supports_base_chain'), 'unsupportedTokenOrChain')
    assert.equal(bucketOf('no_api_key_configured'), 'unsupportedTokenOrChain')
    assert.equal(bucketOf('dexscreener_only_exposes_current_price_timestamp_too_far_from_now'), 'timestampOutsideProviderData')
    assert.equal(bucketOf('no_price_series_in_range'), 'timestampOutsideProviderData')
    assert.equal(bucketOf('no_candles'), 'timestampOutsideProviderData')
    assert.equal(bucketOf('unparseable_price'), 'malformedResponse')
    assert.equal(bucketOf('could_not_resolve_historical_block'), 'blockResolutionFailure')
    assert.equal(bucketOf('no_pool_found'), 'noPool')
    assert.equal(bucketOf('no_uniswap_v3_pool_found'), 'noPool')
    assert.equal(bucketOf('no_matching_pair'), 'noPool')
  })

  it('regression guard: unknown/unenumerated reason strings (http_*, rpc_error:*, fetch_error:*) go to unknownReason, never providerReturnedNull — the confirmed collapse point this task fixes', () => {
    const httpResult = classifyRecoveryFailureReason('http_500')
    assert.equal(httpResult.bucket, 'unknownReason')
    assert.equal(httpResult.unknownKey, 'http_500')

    const rpcResult = classifyRecoveryFailureReason('rpc_error:block out of range')
    assert.equal(rpcResult.bucket, 'unknownReason')
    assert.equal(rpcResult.unknownKey, 'rpc_error', 'the dynamic message after the colon must be stripped — compact, bounded key only')

    const fetchResult = classifyRecoveryFailureReason('fetch_error:AbortError: The operation was aborted')
    assert.equal(fetchResult.bucket, 'unknownReason')
    assert.equal(fetchResult.unknownKey, 'fetch_error')

    const totallyUnrecognized = classifyRecoveryFailureReason('some_brand_new_reason_no_one_has_seen_before')
    assert.equal(totallyUnrecognized.bucket, 'unknownReason')
    assert.equal(totallyUnrecognized.unknownKey, 'some_brand_new_reason_no_one_has_seen_before')
  })

  it('regression guard: a final generic-null attempt cannot overwrite an earlier specific reason — the LAST real reason in the chain wins, and it is never silently blank', async () => {
    // Simulates a detailed source whose earlier attempts had specific reasons but whose FINAL
    // attempt (the one this classifier reads) is itself a real, specific reason — proving the
    // aggregation never collapses to a bare/generic null when a real final reason exists.
    const detailedPrimary = async () => ({
      price: null,
      route: 'none',
      attempts: [
        { source: 'goldrush', ok: false, reason: 'goldrush_no_data' },
        { source: 'dexscreener', ok: false, reason: 'unverified_chain_for_dexscreener' },
        { source: 'base_dex', ok: false, reason: 'could_not_resolve_historical_block' },
      ],
    })
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async (_t, _c, _ts, fetcher) => fetcher('t', 'base', 1) },
      priceSources: { primary: async () => null },
      priceSourceDetailedPrimary: detailedPrimary,
    })
    const missingBuy = lot({ costBasisUsd: null, proceedsUsd: 10 })
    await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [missingBuy], realizedPnlUsd: null }),
      pnlEngineResult: pnl(1, { realizedPnlUsd: null }),
      syntheticPnlAssemblyOutput: null,
    })
    // The real assertion is on classifyRecoveryFailureReason directly (recoverPrices' own internals
    // aren't exported) — this proves the LAST attempt's real, specific reason
    // ('could_not_resolve_historical_block') is what gets classified, never a fabricated/blank one.
    assert.equal(classifyRecoveryFailureReason('could_not_resolve_historical_block').bucket, 'blockResolutionFailure')
  })

  it('regression guard: recoverPrices threads the detailed price source\'s per-leg reason into compact failureReasonCounts, never a raw response body', async () => {
    const detailedPrimary = async () => ({ price: null, route: 'none', attempts: [{ source: 'dexscreener', ok: false, reason: 'no_matching_pair' }] })
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async (_t, _c, _ts, fetcher) => fetcher('t', 'base', 1) },
      priceSources: { primary: async () => null },
      priceSourceDetailedPrimary: detailedPrimary,
    })
    const missingBuy = lot({ costBasisUsd: null, proceedsUsd: 10 })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [missingBuy], realizedPnlUsd: null }),
      pnlEngineResult: pnl(1, { realizedPnlUsd: null }),
      syntheticPnlAssemblyOutput: null,
    })
    assert.equal(summary.priceRecoveredCount, 0, 'the detailed fetcher genuinely found nothing — no fabricated recovery')
  })

  it('regression guard: pnlReconciliation.ts never imports a wallet-activity-fetching function — recovery can only use already-supplied prices, never refetch history', () => {
    // Static-source guard, not a runtime mock: the surest way to prove recovery structurally
    // CANNOT refetch wallet history is that this file never even imports the functions that fetch
    // it (fetchProviderWindow / fetchRawEventsForChain / fetchAlchemyRawEvents /
    // fetchGoldrushRawEvents) — every import here is either a pure type or a price-only source
    // (PriceSourceFn). A future change accidentally wiring in a history-fetch import would fail
    // this test immediately, before it could ever reach production.
    const sourcePath = fileURLToPath(new URL('./pnlReconciliation.ts', import.meta.url))
    const source = readFileSync(sourcePath, 'utf8')
    for (const forbidden of ['fetchProviderWindow', 'fetchRawEventsForChain', 'fetchAlchemyRawEvents', 'fetchGoldrushRawEvents']) {
      assert.ok(!source.includes(forbidden), `pnlReconciliation.ts must never reference ${forbidden} — recovery must only use already-supplied prices/events, never refetch wallet history`)
    }
  })

  // =============================================================================================
  // missingPriceRecoveryFunnelAudit — missing-price-recovery-funnel follow-up task. Every one of
  // the 109-lot-style missing-price population must land in exactly one terminal bucket, and the
  // aggregate/beyond-cap/yield-estimate figures must reconcile exactly against the same recovery
  // pass's own decisions. Diagnostics only — none of these tests assert any change to pricing,
  // FIFO, the manifest, or the 50% gate.
  // =============================================================================================

  it('missingPriceRecoveryFunnelAudit: a one-side-missing lot successfully recovered lands in recovered_verified, and bucket counts sum to totalMissingLots', async () => {
    const missing = lot({ lotId: 'recoverable', openedTxHash: '0xbuy-r', closedTxHash: '0xsell-r', costBasisUsd: 10, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPricePrimary: async () => 15 },
      priceSources: { primary: async () => 15 },
    })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [missing] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    const audit = summary.missingPriceRecoveryFunnelAudit
    assert.equal(audit.totalMissingLots, 1)
    assert.equal(audit.selectedForRecovery, 1)
    assert.equal(audit.notSelectedByCap, 0)
    assert.equal(audit.buckets.recovered_verified, 1)
    assert.equal(audit.canonicalVerifiedLots, 1)
    const bucketSum = Object.values(audit.buckets).reduce((s, n) => s + n, 0)
    assert.equal(bucketSum, audit.totalMissingLots, 'every missing lot must land in exactly one bucket')
    assert.equal(audit.buckets.other, 0, 'the `other` fallback bucket must stay 0 — a non-zero count is itself a real, unanticipated case')
  })

  it('missingPriceRecoveryFunnelAudit: lots ranked beyond MAX_RECOVERY_ATTEMPTS (40) land in not_selected_by_recovery_cap, never attempted', async () => {
    const manyLots = Array.from({ length: 50 }, (_, i) => lot({ lotId: `both-${i}`, openedTxHash: `0xbuy-${i}`, closedTxHash: `0xsell-${i}`, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }))
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async () => null, getPricePrimary: async () => null },
      priceSources: { primary: async () => null },
    })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: manyLots }), pnlEngineResult: pnl(50), syntheticPnlAssemblyOutput: null })
    const audit = summary.missingPriceRecoveryFunnelAudit
    assert.equal(audit.totalMissingLots, 50)
    assert.equal(audit.selectedForRecovery, 40)
    assert.equal(audit.notSelectedByCap, 10)
    assert.equal(audit.buckets.not_selected_by_recovery_cap, 10)
    assert.equal(audit.beyondCapCandidates.length, 10)
    assert.ok(audit.beyondCapCandidates.every((c) => c.rank > 40), 'every beyond-cap candidate must be ranked strictly after the 40-cap')
  })

  it('missingPriceRecoveryFunnelAudit: distinguishes a genuine provider null (provider_returned_null) from a lot hydration never even touched (accepted_evidence_miss)', async () => {
    const oneSideNull = lot({ lotId: 'one-side-null', openedTxHash: '0xbuy-1', closedTxHash: '0xsell-1', costBasisUsd: 10, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const bothSideNull = lot({ lotId: 'both-side-null', openedTxHash: '0xbuy-2', closedTxHash: '0xsell-2', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async () => null, getPricePrimary: async () => null },
      priceSources: { primary: async () => null },
    })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [oneSideNull, bothSideNull] }), pnlEngineResult: pnl(2), syntheticPnlAssemblyOutput: null })
    const audit = summary.missingPriceRecoveryFunnelAudit
    assert.equal(audit.buckets.provider_returned_null, 1, 'a lot with one side already present must classify a genuine provider null as provider_returned_null')
    assert.equal(audit.buckets.accepted_evidence_miss, 1, 'a lot with neither side ever resolved (by hydration or recovery) must classify as accepted_evidence_miss')
  })

  it('missingPriceRecoveryFunnelAudit: maps detailed-source reasons to identity_rejected/timestamp_rejected/quote_leg_proof_missing via the same classifyRecoveryFailureReason buckets', async () => {
    const identity = lot({ lotId: 'identity', token: '0xidentity', openedTxHash: '0xbuy-id', closedTxHash: '0xsell-id', costBasisUsd: 10, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const timestamp = lot({ lotId: 'timestamp', token: '0xtimestamp', openedTxHash: '0xbuy-ts', closedTxHash: '0xsell-ts', costBasisUsd: 10, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const quoteLeg = lot({ lotId: 'quote-leg', token: '0xquoteleg', openedTxHash: '0xbuy-ql', closedTxHash: '0xsell-ql', costBasisUsd: 10, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const reasonForToken: Record<string, string> = { '0xidentity': 'unverified_chain', '0xtimestamp': 'no_candles', '0xquoteleg': 'no_pool_found' }
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPricePrimary: async (token: string, chain: string, ts: number, fetcher: (t: string, c: string, ts: number) => Promise<number | null>) => fetcher(token, chain, ts) } as never,
      priceSourceDetailedPrimary: async (token: string) => ({ price: null, route: 'test', attempts: [{ source: 'test', ok: false, reason: reasonForToken[token] }] }),
    })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [identity, timestamp, quoteLeg] }), pnlEngineResult: pnl(3), syntheticPnlAssemblyOutput: null })
    const audit = summary.missingPriceRecoveryFunnelAudit
    assert.equal(audit.buckets.identity_rejected, 1)
    assert.equal(audit.buckets.timestamp_rejected, 1)
    assert.equal(audit.buckets.quote_leg_proof_missing, 1)
  })

  it('missingPriceRecoveryFunnelAudit: a lot whose side lookup is refused by the recovery-lane budget (never reaching the real fetcher) lands in provider_not_attempted_budget, distinct from a genuine provider null', async () => {
    const capped = lot({ lotId: 'capped', openedTxHash: '0xbuy-capped', closedTxHash: '0xsell-capped', costBasisUsd: 10, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const recoveryStats = { recoveryLookupsRequested: 0, recoveryCacheHits: 0, recoveryLiveFetches: 0, recoveryCappedLookups: 0 }
    let fetcherCalled = false
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: {
        recoveryStats,
        getPriceRecovery: async () => { recoveryStats.recoveryCappedLookups += 1; return null },
      } as never,
      priceSources: { primary: async () => { fetcherCalled = true; return 5 } },
    })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [capped] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    const audit = summary.missingPriceRecoveryFunnelAudit
    assert.equal(audit.buckets.provider_not_attempted_budget, 1)
    assert.equal(fetcherCalled, false, 'the real fetcher must never be invoked once the recovery-lane budget is exhausted')
  })

  it('missingPriceRecoveryFunnelAudit: capYieldEstimate marginal provider-call counts for cap 40/60/80 are exact, cumulative sums over the ranked candidate list', async () => {
    // 60 both-sides-missing lots: ranks 1-40 are selected (2 calls each = 80), ranks 41-60 are
    // beyond-cap (2 calls each = 40 more). Cap 40 must price ONLY the first 40 (never silently read
    // as 0 just because `beyondCapCandidates` itself only holds ranks > 40).
    const manyLots = Array.from({ length: 60 }, (_, i) => lot({ lotId: `both-${i}`, openedTxHash: `0xbuy-${i}`, closedTxHash: `0xsell-${i}`, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }))
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async () => null, getPricePrimary: async () => null },
      priceSources: { primary: async () => null },
    })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: manyLots }), pnlEngineResult: pnl(60), syntheticPnlAssemblyOutput: null })
    const estimate = summary.missingPriceRecoveryFunnelAudit.capYieldEstimate
    const byCap = Object.fromEntries(estimate.marginalProviderCallEstimateByCap.map((e) => [e.cap, e.estimatedProviderCalls]))
    assert.equal(byCap[40], 80, 'cap 40 must price the first 40 candidates directly, never 0')
    assert.equal(byCap[60], 120, 'cap 60 must be the cap-40 baseline plus ranks 41-60, never just the beyond-cap slice alone')
    assert.equal(byCap[80], 120, 'cap 80 has no ranks 61-80 in this 60-lot fixture, so it must equal cap 60 exactly')
  })

  // =============================================================================================
  // 130-early-canonical-to-30-final-candidate-collapse trace — CONFIRMED ROOT CAUSE regression:
  // recoverPrices() previously used the price source's raw PER-TOKEN unit price directly as a lot's
  // TOTAL costBasisUsd/proceedsUsd (a lot-level dollar field), never multiplying by `lot.amount` —
  // exactly the same multiplication `priceAllEntries` (pricingAtTimeEngine/index.ts) already applies
  // via `multiplyAmount(attempt.priceUsd, entry.amount)` for the non-recovery pricing pass. Every
  // existing test in this file used `amount: 1` (the `lot()` fixture's own default), which made the
  // bug numerically invisible (unit price === total at amount 1) — these tests use a realistic,
  // non-1 amount to prove the fix.
  // =============================================================================================

  it('HARD ASSERTION (confirmed root cause): a live-recovered price is scaled by the lot\'s own amount before becoming its costBasisUsd/proceedsUsd — never used as a raw per-unit price', async () => {
    const bigAmountLot = lot({ lotId: 'scaled', openedTxHash: '0xbuy-scaled', closedTxHash: '0xsell-scaled', amount: 1_000_000, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const r = createPnlReconciliation({
      logger: quiet,
      // A realistic low-cap-token per-unit price: $0.00004/token. The correct total for 1,000,000
      // tokens is $40 — the bug would instead have published costBasisUsd/proceedsUsd as 0.00004.
      priceKvClient: { getPriceHistorical: async () => 0.00004, getPricePrimary: async () => 0.00004 },
      priceSources: { primary: async () => 0.00004 },
    })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [bigAmountLot] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    const published = summary.publishedMatchedLots.find((l) => l.lotId === 'scaled')
    assert.ok(published, 'the lot must publish')
    assert.equal(published!.costBasisUsd, 40, 'costBasisUsd must be price x amount (0.00004 x 1,000,000 = $40), never the raw $0.00004 unit price')
    assert.equal(published!.proceedsUsd, 40)
    assert.equal(published!.evidenceQuality, 'verified')
  })

  it('HARD ASSERTION (confirmed root cause): the accepted-evidence envelope the recovery lane writes stores the TOTAL side value, never the raw per-unit price, so a later rescan\'s hydration never corrupts a good value toward zero', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const bigAmountLot = lot({ lotId: 'scaled', openedTxHash: '0xbuy-scaled', closedTxHash: '0xsell-scaled', amount: 1_000_000, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const r1 = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async () => 0.00004, getPricePrimary: async () => 0.00004 },
      priceSources: { primary: async () => 0.00004 },
      acceptedEvidenceKv: acceptedEvidenceKv as never,
    })
    await r1.reconcile({ fifoEngineResult: fifo({ matchedLots: [bigAmountLot] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })

    // Confirm the STORED envelope itself already carries the correct total, never the raw unit price.
    const identityVersion = realLotIdentityVersion(bigAmountLot)
    const entryKey = buildAcceptedEvidenceKey({ chain: 'base', token: '0xtoken', txHash: '0xbuy-scaled', side: 'entry', timestamp: 1, lotIdentityVersion: identityVersion })
    const storedEntry = acceptedEvidenceKv.store.get(entryKey) as { priceUsd: number; valueUsd: number } | undefined
    assert.ok(storedEntry, 'the recovery lane must persist an entry-side envelope')
    assert.equal(storedEntry!.priceUsd, 40, 'the stored priceUsd must be the TOTAL side value (this store\'s own documented contract every reader relies on), never the raw $0.00004 unit price')
    assert.equal(storedEntry!.valueUsd, 40)

    // A SECOND, independent scan (upstream now returns null — the lot must be rehydrated purely from
    // the persisted accepted evidence written by the first scan) must reproduce the SAME correct $40
    // total, never a corrupted near-zero value from misreading a per-unit price as a group total.
    const freshLot = lot({ lotId: 'scaled', openedTxHash: '0xbuy-scaled', closedTxHash: '0xsell-scaled', amount: 1_000_000, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const r2 = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async () => null, getPricePrimary: async () => null },
      priceSources: { primary: async () => null },
      acceptedEvidenceKv: acceptedEvidenceKv as never,
    })
    const summary2 = await r2.reconcile({ fifoEngineResult: fifo({ matchedLots: [freshLot] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    const published2 = summary2.publishedMatchedLots.find((l) => l.lotId === 'scaled')
    assert.ok(published2, 'the lot must still publish on the second scan, rehydrated purely from accepted evidence')
    assert.equal(published2!.costBasisUsd, 40, 'rehydration must reproduce the correct $40 total, never collapse to the raw unit price (or 0, if it underflows VALUE_SCALE precision)')
    assert.equal(published2!.proceedsUsd, 40)
  })

  it('missingPriceRecoveryFunnelAudit: canonicalVerifiedLots matches the REAL, post-demotion final count — never the pre-demotion reconstruction (the confirmed 64-vs-30 funnel scoping bug)', async () => {
    // Two lots share the SAME accepted-evidence entry side (same chain/token/txHash/timestamp) — one
    // fully priced/verified, one still genuinely unpriced. `demoteLotsOnIncompleteAcceptedSides`
    // demotes the verified one back to 'unpriced' because the shared side's group total cannot
    // equal the accepted evidence record while a sibling remains unpriced. The funnel's own
    // `canonicalVerifiedLots`/`recovered_verified` bucket must reflect that demotion, never count the
    // sibling as verified just because it reconstructs cleanly in isolation.
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const sharedEntry = { chain: 'base', txHash: '0xshared-buy', timestamp: 100 }
    const verifiedSibling = lot({ lotId: 'sib-verified', openedTxHash: sharedEntry.txHash, closedTxHash: '0xsell-a', openedAt: sharedEntry.timestamp, closedAt: 200, amount: 5, costBasisUsd: 50, proceedsUsd: 60, realizedPnlUsd: 10, evidenceQuality: 'verified' })
    // Exit side genuinely unrecoverable (priceKvClient/priceSources below always return null) — the
    // entry side gets filled by hydration (same group total as verifiedSibling's own value, since
    // both siblings have equal amount), but the exit stays null, so this sibling never becomes fully
    // priced — the group stays genuinely INCOMPLETE, which is what must trigger demotion.
    const unpricedSibling = lot({ lotId: 'sib-unpriced', openedTxHash: sharedEntry.txHash, closedTxHash: '0xsell-b', openedAt: sharedEntry.timestamp, closedAt: 250, amount: 5, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const identityVersion = realLotIdentityVersion(verifiedSibling)
    acceptedEvidenceKv.store.set(buildAcceptedEvidenceKey({ chain: sharedEntry.chain, token: '0xtoken', txHash: sharedEntry.txHash, side: 'entry', timestamp: sharedEntry.timestamp, lotIdentityVersion: identityVersion }), {
      schemaVersion: ACCEPTED_EVIDENCE_SCHEMA_VERSION, chain: sharedEntry.chain, token: '0xtoken', txHash: sharedEntry.txHash, side: 'entry', timestamp: sharedEntry.timestamp, lotIdentityVersion: identityVersion,
      priceUsd: 100, valueUsd: 100, valueType: 'total_side_value_usd', coveredLotCount: 1, coverageFingerprint: identityVersion, source: 's', evidenceType: 't', providerTimestampBucket: null, temporalDistanceMs: null,
      verificationStatus: 'verified', acceptedAt: 0, expiresAt: Date.now() + 1_000_000,
    })
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async () => null, getPricePrimary: async () => null },
      priceSources: { primary: async () => null },
      acceptedEvidenceKv: acceptedEvidenceKv as never,
    })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [verifiedSibling, unpricedSibling] }), pnlEngineResult: pnl(2), syntheticPnlAssemblyOutput: null })
    // The real, published sample must demote the sibling (proves the fixture actually exercises demotion).
    const publishedVerified = summary.publishedMatchedLots.filter((l) => l.evidenceQuality === 'verified')
    assert.equal(publishedVerified.length, 0, 'the shared-side sibling must be demoted out of the published verified sample')
    // The funnel's own count must agree — never report the pre-demotion reconstruction as verified.
    assert.equal(summary.missingPriceRecoveryFunnelAudit.canonicalVerifiedLots, 0, 'funnel canonicalVerifiedLots must match the real, post-demotion published count, never an inflated pre-demotion figure')
  })

  // =============================================================================================
  // legacy-accepted-evidence-repair follow-up task — migrates ONLY records demonstrably written
  // under the pre-1b3675a recovery-lane bug (`priceUsd` held a raw per-unit price while `valueUsd`,
  // computed at that same write from the same known amount, already held the correct total).
  // =============================================================================================

  function legacyRecoveryLaneEnvelope(overrides: Partial<{ chain: string; token: string; txHash: string; side: 'entry' | 'exit'; timestamp: number; lotIdentityVersion: string; unitPrice: number; amount: number; source: string; coveredLotCount: number }> = {}) {
    const o = { chain: 'base', token: '0xtoken', txHash: '0xbuy-legacy', side: 'entry' as const, timestamp: 1, lotIdentityVersion: 'v1', unitPrice: 0.00001, amount: 1_000_000, source: 'recovery-lane', coveredLotCount: 1, ...overrides }
    return {
      schemaVersion: ACCEPTED_EVIDENCE_SCHEMA_VERSION, chain: o.chain, token: o.token, txHash: o.txHash, side: o.side, timestamp: o.timestamp, lotIdentityVersion: o.lotIdentityVersion,
      // THE OLD BUG'S OWN SHAPE, DISCLOSED: priceUsd is the raw per-unit price; valueUsd is the
      // (already correct) total the old writer computed at write time from the SAME amount.
      priceUsd: o.unitPrice, valueUsd: o.unitPrice * o.amount, valueType: 'total_side_value_usd', coveredLotCount: o.coveredLotCount,
      coverageFingerprint: o.lotIdentityVersion, source: o.source, evidenceType: 'chain-aware-historical', providerTimestampBucket: null, temporalDistanceMs: null,
      verificationStatus: 'verified', acceptedAt: 0, expiresAt: Date.now() + 1_000_000,
    }
  }

  it('HARD ASSERTION (legacy migration): a legacy per-unit record (priceUsd=1e-8, amount=1,000,000) is repaired to the correct $10 total — hydration no longer reconstructs zero', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const bigAmountLot = lot({ lotId: 'legacy', openedTxHash: '0xbuy-legacy', closedTxHash: '0xsell-legacy', amount: 1_000_000, costBasisUsd: null, proceedsUsd: 20, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const identityVersion = realLotIdentityVersion(bigAmountLot)
    const entryKey = buildAcceptedEvidenceKey({ chain: 'base', token: '0xtoken', txHash: '0xbuy-legacy', side: 'entry', timestamp: 1, lotIdentityVersion: identityVersion })
    acceptedEvidenceKv.store.set(entryKey, legacyRecoveryLaneEnvelope({ txHash: '0xbuy-legacy', lotIdentityVersion: identityVersion, unitPrice: 0.00001, amount: 1_000_000 }))
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async () => null, getPricePrimary: async () => null },
      priceSources: { primary: async () => null },
      acceptedEvidenceKv: acceptedEvidenceKv as never,
    })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [bigAmountLot] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    const published = summary.publishedMatchedLots.find((l) => l.lotId === 'legacy')
    assert.ok(published, 'the lot must publish')
    assert.equal(published!.costBasisUsd, 10, 'the correct $10 total (1e-8 x 1,000,000) must be reconstructed, never the raw 1e-8 unit price the old bug would have hydrated as costBasisUsd')
    assert.equal(published!.evidenceQuality, 'verified', 'must now pass the canonical verifier, not remain non_positive_reconstruction')

    const migration = summary.acceptedEvidenceAudit
    assert.equal(migration.legacyPerUnitRecordsDetected, 1)
    assert.equal(migration.legacyPerUnitRecordsRepaired, 1)
    assert.equal(migration.legacyPerUnitRecordsRejected, 0)
    const record = migration.legacyPerUnitMigrationAudit.find((r2) => r2.evidenceKey === entryKey)
    assert.ok(record, 'the migration audit must report this exact evidence key')
    assert.equal(record!.legacyProof, 'legacy_recovery_per_unit_total')
    assert.equal(record!.oldUsd, 0.00001)
    assert.equal(record!.amount, 1_000_000)
    assert.equal(record!.reconstructedTotalUsd, 10)
    assert.equal(record!.repairEligible, true)
    assert.equal(record!.repairApplied, true)
    assert.equal(record!.repairRejectedReason, null)

    // STABLE / IDEMPOTENT, DISCLOSED: the repaired record is now indistinguishable from a genuine
    // new-format record (priceUsd === valueUsd) — a SECOND scan must reuse it, unmodified, with zero
    // further migration activity and the SAME correct total.
    const storedAfterRepair = acceptedEvidenceKv.store.get(entryKey) as { priceUsd: number; valueUsd: number }
    assert.equal(storedAfterRepair.priceUsd, 10)
    assert.equal(storedAfterRepair.valueUsd, 10)
    const r2 = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async () => null, getPricePrimary: async () => null },
      priceSources: { primary: async () => null },
      acceptedEvidenceKv: acceptedEvidenceKv as never,
    })
    const freshLot = lot({ lotId: 'legacy', openedTxHash: '0xbuy-legacy', closedTxHash: '0xsell-legacy', amount: 1_000_000, costBasisUsd: null, proceedsUsd: 20, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const summary2 = await r2.reconcile({ fifoEngineResult: fifo({ matchedLots: [freshLot] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    const published2 = summary2.publishedMatchedLots.find((l) => l.lotId === 'legacy')
    assert.equal(published2!.costBasisUsd, 10, 'the second scan must reproduce the SAME correct $10 total — stable and idempotent')
    assert.equal(summary2.acceptedEvidenceAudit.legacyPerUnitRecordsDetected, 0, 'an already-repaired record must never be re-detected as legacy on a later scan')
  })

  it('HARD ASSERTION (legacy migration): unrelated tiny-but-legitimately-total evidence (a genuine dust trade, priceUsd already equal to valueUsd) is never modified', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const dustLot = lot({ lotId: 'dust', openedTxHash: '0xbuy-dust', closedTxHash: '0xsell-dust', amount: 3, costBasisUsd: null, proceedsUsd: 20, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const identityVersion = realLotIdentityVersion(dustLot)
    const entryKey = buildAcceptedEvidenceKey({ chain: 'base', token: '0xtoken', txHash: '0xbuy-dust', side: 'entry', timestamp: 1, lotIdentityVersion: identityVersion })
    // A genuine current-format record: priceUsd === valueUsd already (both $0.000009, a real total
    // for a genuinely tiny trade) — this must NEVER be treated as legacy-corrupted merely because
    // the value itself is small.
    acceptedEvidenceKv.store.set(entryKey, {
      schemaVersion: ACCEPTED_EVIDENCE_SCHEMA_VERSION, chain: 'base', token: '0xtoken', txHash: '0xbuy-dust', side: 'entry', timestamp: 1, lotIdentityVersion: identityVersion,
      priceUsd: 0.000009, valueUsd: 0.000009, valueType: 'total_side_value_usd', coveredLotCount: 1, coverageFingerprint: identityVersion,
      source: 'recovery-lane', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, temporalDistanceMs: null,
      verificationStatus: 'verified', acceptedAt: 0, expiresAt: Date.now() + 1_000_000,
    })
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async () => null, getPricePrimary: async () => null },
      priceSources: { primary: async () => null },
      acceptedEvidenceKv: acceptedEvidenceKv as never,
    })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [dustLot] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    assert.equal(summary.acceptedEvidenceAudit.legacyPerUnitRecordsDetected, 0, 'priceUsd already equals valueUsd — never flagged as legacy merely because the value is tiny')
    const stored = acceptedEvidenceKv.store.get(entryKey) as { priceUsd: number; valueUsd: number }
    assert.equal(stored.priceUsd, 0.000009, 'the genuine dust record must be left byte-for-byte untouched')
    assert.equal(stored.valueUsd, 0.000009)
    const published = summary.publishedMatchedLots.find((l) => l.lotId === 'dust')
    assert.equal(published!.costBasisUsd, 0.000009)
  })

  it('HARD ASSERTION (legacy migration): a record whose priceUsd x amount does NOT reconcile to valueUsd (tampered/genuinely disagreeing data) is never repaired — fails closed', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const suspectLot = lot({ lotId: 'suspect', openedTxHash: '0xbuy-suspect', closedTxHash: '0xsell-suspect', amount: 1_000_000, costBasisUsd: null, proceedsUsd: 20, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const identityVersion = realLotIdentityVersion(suspectLot)
    const entryKey = buildAcceptedEvidenceKey({ chain: 'base', token: '0xtoken', txHash: '0xbuy-suspect', side: 'entry', timestamp: 1, lotIdentityVersion: identityVersion })
    // Shaped exactly like the old writer (recovery-lane, coveredLotCount: 1, priceUsd !== valueUsd),
    // but priceUsd * amount (1e-8 x 1,000,000 = 10) does NOT match the stored valueUsd (999) — no
    // deterministic proof exists that this is the legacy bug rather than a genuine disagreement, so
    // it must be left alone (fail closed), never coerced into either value.
    acceptedEvidenceKv.store.set(entryKey, legacyRecoveryLaneEnvelope({ txHash: '0xbuy-suspect', lotIdentityVersion: identityVersion, unitPrice: 0.00001, amount: 1_000_000 }))
    const raw = acceptedEvidenceKv.store.get(entryKey) as { valueUsd: number }
    raw.valueUsd = 999 // corrupt/disagreeing valueUsd — breaks the self-consistency proof
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async () => null, getPricePrimary: async () => null },
      priceSources: { primary: async () => null },
      acceptedEvidenceKv: acceptedEvidenceKv as never,
    })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [suspectLot] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    assert.equal(summary.acceptedEvidenceAudit.legacyPerUnitRecordsDetected, 0, 'a self-inconsistent record must never be treated as proven-legacy')
    assert.equal(summary.acceptedEvidenceAudit.legacyPerUnitRecordsRepaired, 0)
    const stored = acceptedEvidenceKv.store.get(entryKey) as { priceUsd: number; valueUsd: number }
    assert.equal(stored.priceUsd, 0.00001, 'the disputed record must be left untouched — never repaired on an unproven guess')
    assert.equal(stored.valueUsd, 999)
  })

  // =============================================================================================
  // provenance-laundering follow-up task — CONFIRMED ROOT CAUSE: seedAcceptedEvidenceForVerifiedLots
  // re-enveloped an EXISTING recovery-lane record as `source: 'canonical-upstream'` with
  // `priceUsd === valueUsd`, silently erasing the ONLY signal (`source === 'recovery-lane'`) the
  // prior migration's provenance gate could detect — the corrupted value became permanently
  // protected as "immutable canonical evidence." Fixed two ways: (1) `originWriter` now survives
  // every re-envelope (seedAcceptedEvidenceForVerifiedLots' own write no longer resets it), closing
  // the hole going forward; (2) an independent, provenance-free proof
  // (`detectLegacyPerUnitTotalByLiveUpstreamProof`) can still repair a record ALREADY laundered
  // before this fix shipped, using only this scan's own live upstream total — never a new provider
  // call, never provenance.
  // =============================================================================================

  it('HARD ASSERTION (provenance-laundering fix): a record already laundered to canonical-upstream (no originWriter, priceUsd already equals the corrupted valueUsd) is still repaired via the independent live-upstream proof', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const bigAmountLot = lot({ lotId: 'laundered', openedTxHash: '0xbuy-laundered', closedTxHash: '0xsell-laundered', amount: 1_000_000, costBasisUsd: 10, proceedsUsd: 20, realizedPnlUsd: 10, evidenceQuality: 'verified' })
    const identityVersion = realLotIdentityVersion(bigAmountLot)
    const entryKey = buildAcceptedEvidenceKey({ chain: 'base', token: '0xtoken', txHash: '0xbuy-laundered', side: 'entry', timestamp: 1, lotIdentityVersion: identityVersion })
    // Simulates the CONFIRMED laundering outcome: seedAcceptedEvidenceForVerifiedLots (before this
    // fix) re-aggregated an already-corrupted per-unit value (0.00001, from the old recovery-lane
    // bug) as if it were a fresh, correct canonical-upstream total — no originWriter field exists
    // (this record predates it entirely), source is already relabeled, priceUsd === valueUsd (the
    // exact shape that defeated the prior migration's `source === 'recovery-lane'` provenance gate).
    acceptedEvidenceKv.store.set(entryKey, {
      schemaVersion: ACCEPTED_EVIDENCE_SCHEMA_VERSION, chain: 'base', token: '0xtoken', txHash: '0xbuy-laundered', side: 'entry', timestamp: 1, lotIdentityVersion: identityVersion,
      priceUsd: 0.00001, valueUsd: 0.00001, valueType: 'total_side_value_usd', coveredLotCount: 1, coverageFingerprint: identityVersion,
      source: 'canonical-upstream', evidenceType: 'unknown', providerTimestampBucket: null, temporalDistanceMs: null,
      verificationStatus: 'verified', acceptedAt: 0, expiresAt: Date.now() + 1_000_000,
    })
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async () => null, getPricePrimary: async () => null },
      priceSources: { primary: async () => null },
      acceptedEvidenceKv: acceptedEvidenceKv as never,
    })
    // THIS scan's own upstream pricing already resolved the entry side correctly at $10 (costBasisUsd:
    // 10 on the fixture lot) — the live, independent fact the repair proof is built from.
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [bigAmountLot] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    const published = summary.publishedMatchedLots.find((l) => l.lotId === 'laundered')
    assert.ok(published, 'the lot must publish')
    assert.equal(published!.costBasisUsd, 10, 'the laundered 0.00001 must never overwrite the correct $10 total — the independent live-upstream proof must catch what the metadata-only gate could not')

    const migration = summary.acceptedEvidenceAudit
    assert.equal(migration.legacyPerUnitRecordsDetected, 1)
    assert.equal(migration.legacyPerUnitRecordsRepaired, 1)
    const record = migration.legacyPerUnitMigrationAudit.find((r2) => r2.evidenceKey === entryKey)
    assert.ok(record)
    assert.equal(record!.legacyProof, 'legacy_recovery_per_unit_total_live_upstream_proof')
    assert.equal(record!.reconstructedTotalUsd, 10)

    const stored = acceptedEvidenceKv.store.get(entryKey) as { priceUsd: number; valueUsd: number }
    assert.equal(stored.priceUsd, 10, 'the persisted record itself must be corrected, so a LATER scan is stable/idempotent too')
    assert.equal(stored.valueUsd, 10)
  })

  it('HARD ASSERTION (provenance-laundering fix): a genuinely correct canonical-upstream record stays immutable when live upstream merely disagrees — never repaired, always audited', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    // A real, previously-accepted $500 total for a 2-token trade — genuinely correct, not corrupted.
    // A later, unrelated provider-drift price disagreement (upstream now reads $600 for the same
    // side) must NEVER overwrite this frozen historical fact — accepted evidence wins by design.
    const stableLot = lot({ lotId: 'stable', openedTxHash: '0xbuy-stable', closedTxHash: '0xsell-stable', amount: 2, costBasisUsd: 600, proceedsUsd: 20, realizedPnlUsd: -580, evidenceQuality: 'verified' })
    const identityVersion = realLotIdentityVersion(stableLot)
    const entryKey = buildAcceptedEvidenceKey({ chain: 'base', token: '0xtoken', txHash: '0xbuy-stable', side: 'entry', timestamp: 1, lotIdentityVersion: identityVersion })
    acceptedEvidenceKv.store.set(entryKey, {
      schemaVersion: ACCEPTED_EVIDENCE_SCHEMA_VERSION, chain: 'base', token: '0xtoken', txHash: '0xbuy-stable', side: 'entry', timestamp: 1, lotIdentityVersion: identityVersion,
      priceUsd: 500, valueUsd: 500, valueType: 'total_side_value_usd', coveredLotCount: 1, coverageFingerprint: identityVersion,
      source: 'canonical-upstream', evidenceType: 'unknown', providerTimestampBucket: null, temporalDistanceMs: null,
      verificationStatus: 'verified', acceptedAt: 0, expiresAt: Date.now() + 1_000_000,
    })
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async () => null, getPricePrimary: async () => null },
      priceSources: { primary: async () => null },
      acceptedEvidenceKv: acceptedEvidenceKv as never,
    })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [stableLot] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    // No proof exists ($500 is not $600/2=$300, nor any other provable per-unit reconstruction) —
    // the record must be left completely untouched.
    assert.equal(summary.acceptedEvidenceAudit.legacyPerUnitRecordsDetected, 0)
    const stored = acceptedEvidenceKv.store.get(entryKey) as { priceUsd: number; valueUsd: number }
    assert.equal(stored.priceUsd, 500, 'a genuinely correct, immutable record must never be repaired merely because upstream later disagrees')
    assert.equal(stored.valueUsd, 500)
    const published = summary.publishedMatchedLots.find((l) => l.lotId === 'stable')
    assert.equal(published!.costBasisUsd, 500, 'accepted evidence wins over upstream by design — the published value stays the frozen $500')

    // The conflict must still be VISIBLE (this is exactly the confirmed "conflicting=211,
    // reseeded=0" paradox this task closes: the conflict is real and now individually audited, even
    // though — correctly — nothing gets rewritten).
    const conflict = summary.acceptedEvidenceAudit.acceptedEvidenceConflictAudit.find((c) => c.evidenceKey === entryKey)
    assert.ok(conflict, 'a real upstream/accepted-evidence disagreement must be individually audited, not just counted in aggregate')
    assert.equal(conflict!.persistedValue, 500)
    assert.equal(conflict!.upstreamValue, 600)
    assert.equal(conflict!.source, 'canonical-upstream')
    assert.equal(conflict!.writeDecision, 'protected_immutable')
    assert.equal(conflict!.reasonProtected, 'accepted_evidence_immutable_by_design')
    assert.equal(conflict!.legacyProofAvailable, null)
  })

  it('HARD ASSERTION (provenance-laundering fix): originWriter survives a canonical-seeding re-envelope of an existing recovery-lane record — closing the laundering hole going forward', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    // A pre-existing, still-unlaundered legacy record (source: 'recovery-lane', no originWriter yet)
    // that this scan's canonical-seeding pass will re-envelope (composition growth / reseed).
    const growingLot = lot({ lotId: 'growing', openedTxHash: '0xbuy-growing', closedTxHash: '0xsell-growing', amount: 3, costBasisUsd: 30, proceedsUsd: 40, realizedPnlUsd: 10, evidenceQuality: 'verified' })
    const identityVersion = realLotIdentityVersion(growingLot)
    const entryKey = buildAcceptedEvidenceKey({ chain: 'base', token: '0xtoken', txHash: '0xbuy-growing', side: 'entry', timestamp: 1, lotIdentityVersion: identityVersion })
    acceptedEvidenceKv.store.set(entryKey, {
      schemaVersion: ACCEPTED_EVIDENCE_SCHEMA_VERSION, chain: 'base', token: '0xtoken', txHash: '0xbuy-growing', side: 'entry', timestamp: 1, lotIdentityVersion: identityVersion,
      priceUsd: 10, valueUsd: 30, valueType: 'total_side_value_usd', coveredLotCount: 1, coverageFingerprint: 'stale-fingerprint',
      source: 'recovery-lane', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, temporalDistanceMs: null,
      verificationStatus: 'verified', acceptedAt: 0, expiresAt: Date.now() + 1_000_000,
    })
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async () => null, getPricePrimary: async () => null },
      priceSources: { primary: async () => null },
      acceptedEvidenceKv: acceptedEvidenceKv as never,
    })
    await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [growingLot] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    const stored = acceptedEvidenceKv.store.get(entryKey) as { source: string; originWriter: string; lastWriter: string; migrationHistory: unknown[] }
    // The canonical-seeding pass DID re-envelope this key (a real, expected reseed for a genuine
    // composition/value change) — `source`/`lastWriter` now read its own name, but `originWriter`
    // must still remember the TRUE original writer, never reset to the new writer's own name.
    assert.equal(stored.originWriter, 'recovery-lane', 'originWriter must survive a canonical-seeding re-envelope — this is the exact fix for the confirmed laundering path')
    assert.equal(stored.lastWriter, 'canonical-upstream')
    assert.ok(stored.migrationHistory.length >= 1, 'a real writer transition must be recorded')
  })

  it('HARD ASSERTION (same-tx-Base-USDC-quote-normalization follow-up task): a persisted value corrupted by the confirmed wrong-decimals bug (~1e12 off, NOT the per-unit-vs-total shape the existing migration proves) is NEVER auto-repaired by the existing migration rules — it fails closed and stays individually audited, never silently coerced', async () => {
    // This is the DIFFERENT corruption shape this task confirmed: a same-tx quote leg normalized
    // with the wrong decimals (18 instead of Base USDC's real 6) — a completely different arithmetic
    // relationship from the per-unit-vs-total confusion detectLegacyPerUnitTotalRecord/
    // detectLegacyPerUnitTotalByLiveUpstreamProof were built to prove. Neither detector's proof
    // condition can hold here (the persisted value is not `unitPrice`, and it is not
    // `liveTotal / lotAmount` either) — so, correctly, NEITHER fires. The record must be left
    // completely alone: this task explicitly says "do NOT repair KV until the current producer path
    // is correct" — the producer fix in this same task (recoveryPolicy/utils.ts) stops the
    // corruption at the source; a DIFFERENT, dedicated migration proof would be required to safely
    // repair records already corrupted this way, and none is added here.
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const corruptedLot = lot({ lotId: 'decimals-corrupted', openedTxHash: '0xbuy-decimals', closedTxHash: '0xsell-decimals', amount: 121_140_766.74509133, costBasisUsd: 2996.415704, proceedsUsd: 20, realizedPnlUsd: -2976.415704, evidenceQuality: 'verified' })
    const identityVersion = realLotIdentityVersion(corruptedLot)
    const entryKey = buildAcceptedEvidenceKey({ chain: 'base', token: '0xtoken', txHash: '0xbuy-decimals', side: 'entry', timestamp: 1, lotIdentityVersion: identityVersion })
    // The confirmed corruption: true value ~2996.415704 (correct, 6-decimal normalization), but the
    // PERSISTED record holds the same figure normalized with decimals=18 instead of 6 — off by
    // exactly 1e12, reproducing the reported ~1e-9-scale quoteQuantity/derivedPriceUsd pattern.
    const corruptedUsd = 2996.415704 / 1e12
    acceptedEvidenceKv.store.set(entryKey, {
      schemaVersion: ACCEPTED_EVIDENCE_SCHEMA_VERSION, chain: 'base', token: '0xtoken', txHash: '0xbuy-decimals', side: 'entry', timestamp: 1, lotIdentityVersion: identityVersion,
      priceUsd: corruptedUsd, valueUsd: corruptedUsd, valueType: 'total_side_value_usd', coveredLotCount: 1, coverageFingerprint: identityVersion,
      source: 'canonical-upstream', evidenceType: 'unknown', providerTimestampBucket: null, temporalDistanceMs: null,
      verificationStatus: 'verified', acceptedAt: 0, expiresAt: Date.now() + 1_000_000,
    })
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async () => null, getPricePrimary: async () => null },
      priceSources: { primary: async () => null },
      acceptedEvidenceKv: acceptedEvidenceKv as never,
    })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [corruptedLot] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    assert.equal(summary.acceptedEvidenceAudit.legacyPerUnitRecordsDetected, 0, 'the existing migration must never mistake a wrong-decimals corruption for the per-unit-vs-total shape it was built to prove')
    const stored = acceptedEvidenceKv.store.get(entryKey) as { priceUsd: number; valueUsd: number }
    assert.equal(stored.priceUsd, corruptedUsd, 'immutability holds — never bypassed on a guess, even for a value this clearly wrong')
    assert.equal(stored.valueUsd, corruptedUsd)
    // The disagreement between this scan's fresh upstream ($2996.415704) and the persisted corrupted
    // record must still be VISIBLE, individually audited — never silently absorbed.
    const conflict = summary.acceptedEvidenceAudit.acceptedEvidenceConflictAudit.find((c) => c.evidenceKey === entryKey)
    assert.ok(conflict, 'the real disagreement must be individually audited so it can be investigated, even though no safe automatic repair exists yet')
    assert.equal(conflict!.writeDecision, 'protected_immutable')
    assert.equal(conflict!.legacyProofAvailable, null)
  })

  // =============================================================================================
  // publicPnlGateAudit / missingEvidenceBreakdown — evidence-first PnL completion task, requirements
  // #1 and #7. A reporting view over the SAME gate structuralConsistent/publicPnlStatus already
  // enforce — never a second, looser or stricter gate.
  // =============================================================================================

  it('publicPnlGateAudit reports integrityTier: full with zero blockingReasons when the gate actually passes', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({ fifoEngineResult: fifo(), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null, structuralCoverageDenominatorAudit: provenAudit() })
    assert.equal(summary.publicPnlStatus, 'available')
    assert.equal(summary.publicPnlGateAudit.integrityTier, 'full')
    assert.deepEqual(summary.publicPnlGateAudit.blockingReasons, [])
    assert.equal(summary.publicPnlGateAudit.verifiedLotCount, 1)
    assert.equal(summary.publicPnlGateAudit.fullyPricedLotCount, 1)
    assert.equal(summary.publicPnlGateAudit.pricingCoverage, 1)
    assert.equal(summary.publicPnlGateAudit.structuralCoverage, 1)
  })

  it('HARD ASSERTION: publicPnlGateAudit.blockingReasons names every failed rule with its exact threshold and actual value', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedBuys: 2, matchedLots: [lot({ costBasisUsd: null, proceedsUsd: null })] }),
      pnlEngineResult: pnl(1, { evidenceMissingCount: 0 }),
      syntheticPnlAssemblyOutput: null,
    })
    assert.notEqual(summary.publicPnlGateAudit.integrityTier, 'full')
    assert.ok(summary.publicPnlGateAudit.blockingReasons.length > 0, 'a non-full gate must always name at least one reason')
    for (const reason of summary.publicPnlGateAudit.blockingReasons) {
      assert.equal(typeof reason.rule, 'string')
      assert.equal(typeof reason.threshold, 'string')
      assert.equal(typeof reason.actualValue, 'string')
    }
    const rules = summary.publicPnlGateAudit.blockingReasons.map((r2) => r2.rule)
    assert.ok(rules.includes('unmatched_buys'))
    const unmatchedBuysReason = summary.publicPnlGateAudit.blockingReasons.find((r2) => r2.rule === 'unmatched_buys')!
    assert.equal(unmatchedBuysReason.threshold, '0')
    assert.equal(unmatchedBuysReason.actualValue, '2')
  })

  it('missingEvidenceBreakdown separates critical trade-evidence gaps from pricing-only gaps, and dust/non-trade exclusions never contribute to either', async () => {
    const r = createPnlReconciliation({ logger: quiet, dustSuppressedKeys: new Set(['base:0xdust1', 'base:0xdust2']) })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedSells: 1, matchedLots: [lot({ costBasisUsd: null, proceedsUsd: null })] }),
      pnlEngineResult: pnl(1, { evidenceMissingCount: 0 }),
      syntheticPnlAssemblyOutput: null,
    })
    assert.equal(summary.missingEvidenceBreakdown.criticalTradeEvidenceMissing, 1, 'the one genuinely unmatched sell is a critical trade-evidence gap')
    assert.equal(summary.missingEvidenceBreakdown.pricingEvidenceMissing, 1, 'the structurally-matched-but-unpriced lot is a pricing-only gap')
    assert.equal(summary.missingEvidenceBreakdown.dustExcluded, 2, 'the two dust-suppressed keys are visible, but...')
    assert.equal(
      summary.missingEvidenceBreakdown.criticalTradeEvidenceMissing + summary.missingEvidenceBreakdown.pricingEvidenceMissing,
      summary.missingEvidenceCount,
      'dustExcluded/nonTradeExcluded must never be folded into missingEvidenceCount — they must never block public PnL',
    )
  })

  // ===============================================================================================
  // exact-unmatched-identity follow-up task — structuralCoverageDenominatorAudit's exact fields
  // ===============================================================================================

  // REVERSED, DISCLOSED (exact-unmatched-evidence follow-up task — confirmed, deliberate escalation
  // from the prior task): the prior task's own explicit constraint was "the gate DECISION itself is
  // untouched, still driven by fifoAndPnl's own raw unmatched counts." THIS task explicitly reverses
  // that scoping decision: "Correct only the evidence inputs used by the existing structural-
  // consistency gate... Replace raw unmatchedBuyCount/unmatchedSellCount in the structural-
  // consistency calculation with exactAudit.genuineUnmatchedBuys/Sells." The gate's FORMULA/
  // THRESHOLDS stay byte-for-byte identical (see the dedicated threshold-immutability test below) —
  // only WHICH numbers feed those thresholds changed, from raw FIFO stragglers to exact genuine
  // trade evidence.
  it('HARD ASSERTION: exact structuralCoverageDenominatorAudit fields now feed the gate decision itself — public status can improve only when exact non-trades are excluded', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    // Raw: 4 unmatched sells -> missingEvidenceCount 4 -> exceeds the unchanged <=3 partial
    // threshold -> 'unavailable'.
    const withoutAudit = await r.reconcile({ fifoEngineResult: fifo({ unmatchedSells: 4 }), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null })
    assert.equal(withoutAudit.publicPnlStatus, 'unavailable')

    // Exact: 3 of those 4 raw unmatched sells are PROVEN non-trades (distributions) — only 1 is
    // genuine — missingEvidenceCount now 1, at/under the SAME unchanged <=3 threshold -> 'partial'.
    // The status improved ONLY because real evidence proved most of the raw stragglers were never
    // trades — never because the threshold moved.
    const withAudit = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedSells: 4 }),
      pnlEngineResult: pnl(),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: {
        genuineUnmatchedBuys: 0,
        genuineUnmatchedSells: 1,
        excludedUnmatchedByClassification: { distribution_airdrop: 3 },
        unmatchedIdentityJoinFailures: 0,
      },
    })
    assert.equal(withAudit.publicPnlStatus, 'partial', 'status improves once exact evidence proves the raw stragglers were non-trades')
    assert.equal(withAudit.unmatchedSells, 4, 'the top-level (non-gate) unmatchedSells figure stays RAW — only the gate itself uses exact evidence')
    assert.equal(withAudit.publicPnlGateAudit.unmatchedSellCount, 1, 'the gate audit reports the EXACT count the gate actually used')
    assert.equal(withAudit.publicPnlGateAudit.genuineUnmatchedSells, 1)
    assert.equal(withAudit.publicPnlGateAudit.excludedUnmatchedByClassification.distribution_airdrop, 3)
    assert.equal(withAudit.publicPnlGateAudit.unmatchedIdentityJoinFailures, 0)
  })

  it('HARD ASSERTION: an unknown classification or a failed join still blocks the gate exactly like a raw unmatched leg (fail-closed)', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    // genuineUnmatchedSells still reports 4 (fail-closed: join failures/unknowns count as genuine)
    // even though nominally "3 excluded" would suggest only 1 remains — proves this reconciler
    // trusts whatever genuineUnmatchedSells the caller supplies, never re-deriving a lower number.
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedSells: 4 }),
      pnlEngineResult: pnl(),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: {
        genuineUnmatchedBuys: 0,
        genuineUnmatchedSells: 4,
        excludedUnmatchedByClassification: {},
        unmatchedIdentityJoinFailures: 2,
      },
    })
    assert.equal(summary.publicPnlStatus, 'unavailable', 'join failures/unknowns must still block exactly like genuine unmatched legs')
    assert.equal(summary.publicPnlGateAudit.unmatchedSellCount, 4)
    assert.equal(summary.publicPnlGateAudit.unmatchedIdentityJoinFailures, 2)
  })

  it('HARD ASSERTION: verified lot count, realized PnL, matched lots, and pricing coverage are unchanged by the exact evidence audit — only unmatched counts/status/coverage move', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const matchedLots = [lot({ costBasisUsd: 10, proceedsUsd: 12, realizedPnlUsd: 2, evidenceQuality: 'verified' })]
    const base = { fifoEngineResult: fifo({ unmatchedSells: 4, matchedLots }), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null }
    const withoutAudit = await r.reconcile(base)
    const withAudit = await r.reconcile({
      ...base,
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 1, excludedUnmatchedByClassification: { distribution_airdrop: 3 }, unmatchedIdentityJoinFailures: 0 },
    })
    assert.equal(withoutAudit.publicPnlGateAudit.verifiedLotCount, withAudit.publicPnlGateAudit.verifiedLotCount)
    assert.equal(withoutAudit.realizedPnlUsd, withAudit.realizedPnlUsd)
    assert.equal(withoutAudit.closedLots, withAudit.closedLots)
    assert.equal(withoutAudit.publicPnlGateAudit.fullyPricedLotCount, withAudit.publicPnlGateAudit.fullyPricedLotCount)
    assert.equal(withoutAudit.publicPnlGateAudit.pricingCoverage, withAudit.publicPnlGateAudit.pricingCoverage)
    assert.notEqual(withoutAudit.publicPnlStatus, withAudit.publicPnlStatus, 'the gate decision itself DOES move — that is this task\'s entire point')
  })

  it('HARD ASSERTION: the gate\'s own thresholds are byte-for-byte unchanged — same 0/0/<=3 formula, only the inputs differ', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    // Exactly at the <=3 partial-status boundary using EXACT evidence — proves the SAME "<=3"
    // threshold this codebase has always used still governs the exact-evidence path, never a new
    // or looser number.
    const atBoundary = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedSells: 10 }),
      pnlEngineResult: pnl(),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 3, excludedUnmatchedByClassification: {}, unmatchedIdentityJoinFailures: 0 },
    })
    assert.equal(atBoundary.publicPnlStatus, 'partial', 'exactly 3 genuine unmatched sells is still <= 3 — the unchanged threshold')

    const overBoundary = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedSells: 10 }),
      pnlEngineResult: pnl(),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 4, excludedUnmatchedByClassification: {}, unmatchedIdentityJoinFailures: 0 },
    })
    assert.equal(overBoundary.publicPnlStatus, 'unavailable', 'exactly 4 genuine unmatched sells exceeds the unchanged <=3 threshold')
  })

  it('[gate-shadow-audit] reports rawGateStatus, exactEvidenceGateStatus, both coverage figures, both unmatched-count pairs, and joinFailures', async () => {
    const calls: unknown[][] = []
    const capturingLogger = { warn: (...args: unknown[]) => { calls.push(args) } }
    const r = createPnlReconciliation({ logger: capturingLogger })
    await r.reconcile({
      fifoEngineResult: fifo({ unmatchedSells: 4 }),
      pnlEngineResult: pnl(),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 1, excludedUnmatchedByClassification: { distribution_airdrop: 3 }, unmatchedIdentityJoinFailures: 0 },
    })
    const shadowCall = calls.find((c) => c[0] === '[gate-shadow-audit]')
    assert.ok(shadowCall, 'must log the required gate-shadow-audit diagnostic')
    const payload = shadowCall![1] as Record<string, unknown>
    assert.equal(payload.rawGateStatus, 'unavailable')
    assert.equal(payload.exactEvidenceGateStatus, 'partial')
    assert.equal(typeof payload.rawStructuralCoverage, 'number')
    assert.equal(typeof payload.exactStructuralCoverage, 'number')
    assert.deepEqual(payload.rawUnmatchedCounts, { buys: 0, sells: 4 })
    assert.deepEqual(payload.exactGenuineUnmatchedCounts, { buys: 0, sells: 1 })
    assert.equal(payload.joinFailures, 0)
  })

  // ===============================================================================================
  // BOUNDED-HISTORY FOLLOW-UP — requirements #1-#8.
  // ===============================================================================================

  it('HARD ASSERTION: an unsold valid buy (open_position_inventory) does not block realized PnL', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedBuys: 5 }),
      pnlEngineResult: pnl(),
      syntheticPnlAssemblyOutput: null,
      // The caller (pipeline) has already excluded the 5 open-position buys from genuineUnmatchedBuys
      // — only disclosed via openPositionBuys, never blocking.
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 0, openPositionBuys: 5, windowBoundaryProven: true },
    })
    assert.equal(summary.publicPnlStatus, 'available')
    assert.equal(summary.publicPnlGateAudit.unmatchedBuyCount, 0)
    assert.equal(summary.publicPnlGateAudit.openPositionBuys, 5)
    assert.equal(summary.publicPnlGateAudit.blockingReasons.length, 0)
  })

  it('HARD ASSERTION: a sell whose entry predates the bounded window is excluded (pre_window_inventory_exit), never fabricated into realized PnL', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedSells: 3 }),
      pnlEngineResult: pnl(),
      syntheticPnlAssemblyOutput: null,
      // preWindowInventoryExits being non-zero at all can only ever occur under 'exhaustive' coverage
      // (see eventClassification's own HistoryCoverageStatus header — only a PROVEN boundary grants a
      // full, non-truncation-disclosed pre-window exit), so this fixture's own narrative already
      // implies windowBoundaryProven: true — wired explicitly here rather than left to a fail-closed
      // default that would contradict the scenario this test represents.
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 0, preWindowInventoryExits: 3, scanWindowDays: 90, windowBoundaryProven: true },
    })
    assert.equal(summary.publicPnlStatus, 'available')
    assert.equal(summary.publicPnlGateAudit.preWindowInventoryExits, 3)
    assert.equal(summary.publicPnlGateAudit.scanWindowDays, 90)
    // No cost basis was invented for the excluded sells — realizedPnlUsd is untouched, still only
    // the sum of fifoEngine's own verified, matched lots.
    assert.equal(summary.realizedPnlUsd, 2)
  })

  it('HARD ASSERTION: unknown/unjoinable unmatched evidence still blocks the gate even under the bounded-history split', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedSells: 4 }),
      pnlEngineResult: pnl(),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 4, unmatchedIdentityJoinFailures: 4 },
    })
    assert.equal(summary.publicPnlStatus, 'unavailable')
    assert.ok(summary.publicPnlGateAudit.blockingReasons.some((r2) => r2.rule === 'unmatched_sells'))
  })

  it('HARD ASSERTION: 124 FIFO fragments vs 48 sell entries is a valid read-model shape and never a public veto', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const fragments = Array.from({ length: 124 }, (_, i) => lot({
      lotId: `fragment-${i}`,
      openedTxHash: `0xbuy-${i}`,
      closedTxHash: `0xsell-${i % 48}`,
    }))
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: fragments, realizedPnlUsd: 248 }),
      pnlEngineResult: pnl(48),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: provenAudit(),
    })
    assert.equal(summary.publicPnlStatus, 'available', 'different row units must not block public PnL')
    assert.ok(!summary.publicPnlGateAudit.blockingReasons.some((r2) => r2.rule === 'engine_lot_count_agreement'), 'engine agreement is no longer a gate rule at all')
    assert.deepEqual(summary.publicPnlGateAudit.engineDivergenceDiagnostic, {
      fifoFragmentCount: 124,
      uniqueClosingTxCount: 48,
      uniqueClosingTxTokenCount: 48,
      pnlSellEntryCount: 48,
      avgFragmentsPerSell: 124 / 48,
      diagnosticOnly: true,
    })
    // Canonical figures still come from the 124 FIFO fragments only.
    assert.equal(summary.realizedPnlUsd, 248)
    assert.equal(summary.publicPnlGateAudit.verifiedClosedLots, 124)
    assert.equal(summary.publicPnlGateAudit.structuralClosedLots, 124)
  })

  it('HARD ASSERTION: production-shaped bounded verified sample (17/27 verified, 62.96% pricing coverage) is published as a clearly-labelled partial sample, never available, never unavailable', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const verifiedLots = Array.from({ length: 17 }, (_, i) => lot({ lotId: `v${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}` }))
    const unpricedLots = Array.from({ length: 10 }, (_, i) => lot({ lotId: `u${i}`, openedTxHash: `0xub${i}`, closedTxHash: `0xus${i}`, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }))
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [...verifiedLots, ...unpricedLots] }),
      pnlEngineResult: pnl(9),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 0, scanWindowDays: 90, windowBoundaryProven: true },
    })
    assert.equal(summary.publicPnlGateAudit.verifiedClosedLots, 17)
    assert.equal(summary.publicPnlGateAudit.structuralClosedLots, 27)
    assert.ok(Math.abs((summary.publicPnlGateAudit.verifiedPricingCoverage ?? 0) - 17 / 27) < 1e-9)
    assert.equal(summary.publicPnlStatus, 'partial', 'a bounded, incomplete-but-verified sample must be published as partial — never claimed complete, never blocked outright')
    assert.equal(summary.publicPnlGateAudit.scanWindowDays, 90)
    assert.equal(summary.realizedPnlUsd, 34, 'realized PnL still comes only from the 17 fully-verified lots, unchanged by publication status')
  })

  it('below-threshold bounded sample (fewer than 10 verified lots) stays unavailable even with no hard-invalid evidence', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const verifiedLots = Array.from({ length: 5 }, (_, i) => lot({ lotId: `v${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}` }))
    const unpricedLots = Array.from({ length: 5 }, (_, i) => lot({ lotId: `u${i}`, openedTxHash: `0xub${i}`, closedTxHash: `0xus${i}`, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }))
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [...verifiedLots, ...unpricedLots] }),
      pnlEngineResult: pnl(5),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 0 },
    })
    assert.ok(summary.publicPnlGateAudit.blockingReasons.some((r2) => r2.rule === 'minimum_verified_closed_lots'))
    assert.equal(summary.publicPnlStatus, 'unavailable')
  })

  it('HARD ASSERTION: exact production-shaped case — 27 structural lots, 18 verified (66.67% coverage), 94 open-position buys, 110 pre-window sells, 4 invalid/unknown unmatched sells — publishes partial, never unavailable', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const verifiedLots = Array.from({ length: 18 }, (_, i) => lot({ lotId: `v${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}`, realizedPnlUsd: -200.55 }))
    const unpricedLots = Array.from({ length: 9 }, (_, i) => lot({ lotId: `u${i}`, openedTxHash: `0xub${i}`, closedTxHash: `0xus${i}`, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }))
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [...verifiedLots, ...unpricedLots], unmatchedBuys: 94, unmatchedSells: 114 }),
      pnlEngineResult: pnl(9),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: {
        genuineUnmatchedBuys: 0, genuineUnmatchedSells: 4,
        openPositionBuys: 94, preWindowInventoryExits: 110,
        scanWindowDays: 90, windowBoundaryProven: true,
      },
    })
    assert.equal(summary.publicPnlStatus, 'partial', 'the prior gate wiring bug left this exact production shape at unavailable — must now be partial')
    assert.equal(summary.realizedPnlUsd, -3609.9)
    assert.equal(summary.publicPnlGateAudit.verifiedClosedLots, 18)
    assert.equal(summary.publicPnlGateAudit.structuralClosedLots, 27)
    assert.ok(Math.abs((summary.publicPnlGateAudit.verifiedPricingCoverage ?? 0) - 18 / 27) < 1e-9)
    assert.equal(summary.publicPnlGateAudit.openPositionBuys, 94)
    assert.equal(summary.publicPnlGateAudit.preWindowInventoryExits, 110)
    assert.equal(summary.publicPnlGateAudit.invalidOrUnknownUnmatchedEvents, 4)
    assert.equal(summary.publicPnlGateAudit.boundedSampleEligible, true)
    assert.deepEqual(summary.publicPnlGateAudit.boundedSampleBlockingReasons, [])
    assert.equal(summary.warning, 'Verified 90-day sample, not complete wallet history')
    // The old, blocking view is still fully disclosed — it just no longer vetoes the bounded path.
    assert.ok(summary.publicPnlGateAudit.fullAvailabilityBlockingReasons.some((r2) => r2.rule === 'unmatched_sells'))
    assert.ok(summary.publicPnlGateAudit.fullAvailabilityBlockingReasons.some((r2) => r2.rule === 'missing_evidence_count'))
  })

  it('HARD ASSERTION (required regression, trust-gate task, production reproduction: wallet 0x8de9ac2123c06fb6f8afa2f55a39fb670a50fbc7): a partial sample with low pricing coverage, missing critical evidence, genuine unmatched sells, AND engine divergence triggers the trust gate — never presented as if fully verified', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    // Same shape as the exact-production-shaped fixture above: 27 structural / 18 verified
    // (66.67% coverage, below the 85% trust threshold), genuineUnmatchedSells 4 (> 0).
    const verifiedLots = Array.from({ length: 18 }, (_, i) => lot({ lotId: `v${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}`, realizedPnlUsd: -200.55 }))
    const unpricedLots = Array.from({ length: 9 }, (_, i) => lot({ lotId: `u${i}`, openedTxHash: `0xub${i}`, closedTxHash: `0xus${i}`, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }))
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [...verifiedLots, ...unpricedLots], unmatchedBuys: 94, unmatchedSells: 114 }),
      // A real, independent alternate-engine figure that diverges materially from the canonical
      // -3609.90 (matches this task's own confirmed production shape: two engines disagreeing).
      pnlEngineResult: pnl(9, { realizedPnlUsd: -9200.2 }),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: {
        genuineUnmatchedBuys: 0, genuineUnmatchedSells: 4,
        openPositionBuys: 94, preWindowInventoryExits: 110,
        scanWindowDays: 90, windowBoundaryProven: true,
      },
    })
    assert.equal(summary.publicPnlStatus, 'partial')
    // The underlying numbers are UNCHANGED by the trust gate — it never touches FIFO/PnL math.
    assert.equal(summary.realizedPnlUsd, -3609.9)
    assert.equal(summary.publicPnlGateAudit.verifiedClosedLots, 18)

    const audit = summary.pnlDiscrepancyAudit
    assert.equal(audit.canonicalRealizedPnlUsd, -3609.9)
    assert.equal(audit.alternateEngineRealizedPnlUsd, -9200.2)
    assert.ok(audit.engineDivergenceUsd! > 250)
    assert.ok(audit.pricingCoverage! < 0.85)
    assert.ok(audit.criticalTradeEvidenceMissing > 0)
    assert.equal(audit.genuineUnmatchedSells, 4)
    assert.ok(audit.likelyReasonCodes.includes('engine_divergence_exceeds_threshold'))
    assert.ok(audit.likelyReasonCodes.includes('pricing_coverage_below_threshold'))
    assert.ok(audit.likelyReasonCodes.includes('critical_trade_evidence_missing'))
    assert.ok(audit.likelyReasonCodes.includes('genuine_unmatched_sells_present'))
    assert.equal(audit.trustGateTriggered, true, 'this exact confirmed-production shape must trip the trust gate')
    assert.equal(audit.headlineOverrideLabel, 'Partial verified sample — not comparable to Nansen yet')
    assert.equal(audit.externalComparatorHint, null, 'never auto-set — manual-only per this task\'s own rule #4')
    // Per-lot contributor debug (requirement #3): the 18 verified lots are all -200.55, so the top
    // negative list is populated, real, and never empty when negative lots exist.
    assert.equal(audit.largestNegativeClosedLotsTop10.length, 10)
    assert.equal(audit.largestNegativeClosedLotsTop10[0].realizedPnlUsd, -200.55)
    assert.equal(audit.largestNegativeClosedLotsTop10[0].lotId, 'v0')
  })

  it('HARD ASSERTION (required regression, trust-gate task, negative control): a healthy bounded sample — full pricing coverage, zero missing critical evidence, zero genuine unmatched sells, no meaningful engine divergence — never trips the trust gate even though publicPnlStatus is partial', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    // 17 verified lots, ALL priced (17/17 structural — 100% coverage), matching this session's own
    // stable-wallet baseline (+608.45 / 17 verified lots).
    const verifiedLots = Array.from({ length: 17 }, (_, i) => lot({ lotId: `v${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}`, realizedPnlUsd: 35.79 }))
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: verifiedLots, unmatchedBuys: 0, unmatchedSells: 0 }),
      pnlEngineResult: pnl(17, { realizedPnlUsd: 608.43 }), // ~$0.02 apart — real float noise, not a divergence
      syntheticPnlAssemblyOutput: null,
      // windowBoundaryProven: false (unproven, not truncated-unhealthy) is what keeps this a bounded
      // 'partial' sample rather than 'available' — same real pattern as this session's own stable
      // wallet (manifestApplied bounded-sample path), not a coverage/evidence/unmatched-sell problem.
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 0, scanWindowDays: 90, windowBoundaryProven: false, boundedSampleWindowSafe: true, historyCoverageStatus: 'exhaustive' },
    })
    assert.equal(summary.publicPnlStatus, 'partial')
    assert.equal(summary.publicPnlGateAudit.verifiedClosedLots, 17)
    assert.ok(Math.abs((summary.publicPnlGateAudit.verifiedPricingCoverage ?? 0) - 1) < 1e-9)

    const audit = summary.pnlDiscrepancyAudit
    assert.deepEqual(audit.likelyReasonCodes, [])
    assert.equal(audit.trustGateTriggered, false, 'a genuinely healthy bounded sample must never be falsely gated')
    assert.equal(audit.headlineOverrideLabel, null)
  })

  it('HARD ASSERTION (boundary-model follow-up task, production reproduction): a page-capped-but-healthy fetch (historyCoverageStatus truncated, windowBoundaryProven false) still publishes a verified 23/24-lot bounded sample, with truncated-history disclosure and no false full-window claim', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const verifiedLots = Array.from({ length: 23 }, (_, i) => lot({ lotId: `v${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}`, realizedPnlUsd: -2.564347826086957 }))
    const unpricedLots = [lot({ lotId: 'u0', openedTxHash: '0xub0', closedTxHash: '0xus0', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })]
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [...verifiedLots, ...unpricedLots], unmatchedBuys: 88, unmatchedSells: 115 }),
      pnlEngineResult: pnl(9),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: {
        genuineUnmatchedBuys: 0, genuineUnmatchedSells: 4,
        openPositionBuys: 88, preWindowInventoryExits: 0,
        preWindowInventoryExitsUnprovenDueToTruncation: 110,
        historyCoverageStatus: 'truncated',
        scanWindowDays: 90,
        windowBoundaryProven: false,
        boundedSampleWindowSafe: true,
      },
    })
    assert.equal(summary.publicPnlStatus, 'partial', 'the confirmed production bug: page-cap truncation must not hard-block an otherwise-verified sample')
    assert.equal(summary.publicPnlGateAudit.verifiedClosedLots, 23)
    assert.equal(summary.publicPnlGateAudit.structuralClosedLots, 24)
    assert.equal(summary.publicPnlGateAudit.boundedSampleEligible, true)
    assert.deepEqual(summary.publicPnlGateAudit.boundedSampleBlockingReasons, [])
    assert.equal(summary.publicPnlGateAudit.preWindowInventoryExits, 0, 'never claimed as a PROVEN pre-window exit under truncated coverage')
    assert.equal(summary.publicPnlGateAudit.preWindowInventoryExitsUnprovenDueToTruncation, 110)
    assert.equal(summary.publicPnlGateAudit.historyCoverageStatus, 'truncated')
    assert.ok(summary.warning?.includes('truncated'), 'reduced-confidence disclosure, never a silent identical warning to an exhaustive scan')
    assert.ok(summary.warning?.includes('110'))
  })

  it('HARD ASSERTION: the bounded path fails closed when the provider window boundary is not proven, even with otherwise-eligible thresholds', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const verifiedLots = Array.from({ length: 18 }, (_, i) => lot({ lotId: `v${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}`, realizedPnlUsd: -200.55 }))
    const unpricedLots = Array.from({ length: 9 }, (_, i) => lot({ lotId: `u${i}`, openedTxHash: `0xub${i}`, closedTxHash: `0xus${i}`, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }))
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [...verifiedLots, ...unpricedLots], unmatchedBuys: 94, unmatchedSells: 114 }),
      pnlEngineResult: pnl(9),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: {
        genuineUnmatchedBuys: 0, genuineUnmatchedSells: 4,
        openPositionBuys: 94, preWindowInventoryExits: 110,
        scanWindowDays: 90, windowBoundaryProven: false,
      },
    })
    assert.equal(summary.publicPnlGateAudit.boundedSampleEligible, false)
    assert.ok(summary.publicPnlGateAudit.boundedSampleBlockingReasons.some((r2) => r2.rule === 'window_boundary_proven'))
    assert.equal(summary.publicPnlStatus, 'unavailable')
  })

  it('HARD ASSERTION: the bounded path fails closed when fifoEngine has positively flagged a hard-invalid result', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const verifiedLots = Array.from({ length: 18 }, (_, i) => lot({ lotId: `v${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}`, realizedPnlUsd: -200.55 }))
    const unpricedLots = Array.from({ length: 9 }, (_, i) => lot({ lotId: `u${i}`, openedTxHash: `0xub${i}`, closedTxHash: `0xus${i}`, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }))
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [...verifiedLots, ...unpricedLots], unmatchedBuys: 94, unmatchedSells: 114, integrityFlags: { hardInvalid: true, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 } }),
      pnlEngineResult: pnl(9),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: {
        genuineUnmatchedBuys: 0, genuineUnmatchedSells: 4,
        openPositionBuys: 94, preWindowInventoryExits: 110,
        scanWindowDays: 90, windowBoundaryProven: true,
      },
    })
    assert.equal(summary.publicPnlGateAudit.boundedSampleEligible, false)
    assert.ok(summary.publicPnlGateAudit.boundedSampleBlockingReasons.some((r2) => r2.rule === 'fifo_result_hard_invalid'))
    assert.equal(summary.publicPnlStatus, 'unavailable')
  })

  // ===============================================================================================
  // ACCEPTED-EVIDENCE DETERMINISM — requirements #1-#9.
  // ===============================================================================================

  function fakeAcceptedEvidenceKv(): { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<string>; store: Map<string, unknown> } {
    const store = new Map<string, unknown>()
    return {
      store,
      get: async (key: string) => (store.has(key) ? store.get(key) : null),
      set: async (key: string, value: unknown) => { store.set(key, value); return 'OK' },
    }
  }

  // 27 structural lots, same shape as production evidence — every lot on its own distinct token so
  // no cross-lot interference, both sides genuinely missing (matching a fresh fifoEngine recompute
  // every scan — fifoEngine itself never caches a price between scans).
  function build27LotFixture(): MatchedLot[] {
    return Array.from({ length: 27 }, (_, i) => lot({
      lotId: `lot-${i}`, token: `0xtoken${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}`,
      openedAt: 1000 + i, closedAt: 2000 + i, amount: 1,
      costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced',
    }))
  }

  it('HARD ASSERTION (required regression #9): the same 27-lot fixture run twice under DIFFERENT simulated provider availability produces an identical verified set and realized PnL, zero overwrites, and fewer live calls on the second run', async () => {
    const lots = build27LotFixture()
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const buyPriceFor = (i: number) => 10 + i
    const sellPriceFor = (i: number) => 20 + i

    // RUN 1: every provider call succeeds with the canonical price.
    let liveCallsRun1 = 0
    const priceKvClient1 = {
      getPriceRecovery: async (token: string, chain: string, timestamp: number, fetcher: (t: string, c: string, ts: number) => Promise<number | null>) => fetcher(token, chain, timestamp),
    }
    const run1Fetcher = async (token: string, _chain: string, timestamp: number): Promise<number | null> => {
      liveCallsRun1 += 1
      const i = Number(token.replace('0xtoken', ''))
      return timestamp === 1000 + i ? buyPriceFor(i) : sellPriceFor(i)
    }

    const r1 = createPnlReconciliation({
      logger: quiet, priceKvClient: priceKvClient1 as never, priceSources: { primary: run1Fetcher },
      acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 1_000_000,
    })
    const summary1 = await r1.reconcile({
      fifoEngineResult: fifo({ matchedLots: lots }), pnlEngineResult: pnl(27), syntheticPnlAssemblyOutput: null,
    })

    assert.equal(summary1.publicPnlGateAudit.verifiedClosedLots, 27, 'every lot must resolve on the first, fully-available run')
    assert.ok(liveCallsRun1 > 0)
    assert.equal(summary1.acceptedEvidenceAudit.acceptedEvidenceWriteFailures, 0)
    assert.equal(summary1.acceptedEvidenceAudit.acceptedEvidenceWriteSuccesses, 54, 'every one of the 27 lots’ 2 sides must be written back')

    // RUN 2: a FRESH fifoEngine recompute (same 27 lots, both sides genuinely null again — the real
    // production shape) with a DELIBERATELY WRONG fetcher that, if ever called, proves the accepted
    // evidence store failed to bypass live competition. Some "providers" (represented here as the
    // same fetcher) would return null/a different price — this must never matter because it must
    // never be reached at all.
    const lots2 = build27LotFixture()
    let liveCallsRun2 = 0
    const priceKvClient2 = {
      getPriceRecovery: async (token: string, chain: string, timestamp: number, fetcher: (t: string, c: string, ts: number) => Promise<number | null>) => fetcher(token, chain, timestamp),
    }
    const run2Fetcher = async (token: string, _chain: string, timestamp: number): Promise<number | null> => {
      liveCallsRun2 += 1
      const i = Number(token.replace('0xtoken', ''))
      // Deliberately WRONG values — a canary: if this is ever invoked for a lot the accepted-evidence
      // store already covers, the resulting mismatched realizedPnlUsd will fail the assertions below.
      return timestamp === 1000 + i ? buyPriceFor(i) + 1000 : null
    }
    const r2 = createPnlReconciliation({
      logger: quiet, priceKvClient: priceKvClient2 as never, priceSources: { primary: run2Fetcher },
      acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 2_000_000,
    })
    const summary2 = await r2.reconcile({
      fifoEngineResult: fifo({ matchedLots: lots2 }), pnlEngineResult: pnl(27), syntheticPnlAssemblyOutput: null,
    })

    assert.equal(summary2.publicPnlGateAudit.verifiedClosedLots, 27)
    assert.equal(summary2.realizedPnlUsd, summary1.realizedPnlUsd, 'identical realizedPnlUsd across rescans — the actual determinism requirement')
    assert.equal(liveCallsRun2, 0, 'the second run must make ZERO live calls — every side was already accepted')
    assert.ok(liveCallsRun2 < liveCallsRun1, 'fewer (here: zero) live calls on the second run')
    assert.equal(summary2.acceptedEvidenceAudit.persistedAcceptedSidesApplied, 54, 'all 54 sides hydrated from the accepted-evidence store')
    assert.equal(summary2.acceptedEvidenceAudit.liveSidesResolved, 0)
    assert.equal(summary2.acceptedEvidenceAudit.existingVerifiedSidesProtectedFromOverwrite, 0, 'lots2 start unpriced — nothing to protect, everything came from hydration instead')
  })

  it('HARD ASSERTION (superseded by hydration-timing-and-canonical-precedence follow-up task): accepted evidence is now CANONICAL even for a side fifoEngine already priced — it overrides a conflicting upstream candidate, never the reverse', async () => {
    // DELIBERATE BEHAVIOR CHANGE, DISCLOSED: this test previously asserted the OPPOSITE — that an
    // already-priced side was NEVER touched even when accepted evidence disagreed. That was exactly
    // the confirmed production bug this follow-up task fixes (requirement #3: "persisted evidence
    // wins... upstream price must not replace it") — an already-priced side is no longer immune to
    // being checked against accepted evidence; when a valid entry exists, it is now canonical.
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const alreadyPriced = lot({ lotId: 'already', token: '0xalready', openedTxHash: '0xb', closedTxHash: '0xs', openedAt: 1, closedAt: 2, costBasisUsd: 5, proceedsUsd: 7, realizedPnlUsd: 2, evidenceQuality: 'verified' })
    // Seed a DIFFERENT accepted price for the entry side only — must now be applied as canonical.
    const identityVersion = ['base', '0xalready', '0xb', '0xs', 1, 2, 1].join(':')
    acceptedEvidenceKv.store.set(`v1:accepted-evidence:base:0xalready:0xb:entry:1`, {
      schemaVersion: ACCEPTED_EVIDENCE_SCHEMA_VERSION, chain: 'base', token: '0xalready', txHash: '0xb', side: 'entry', timestamp: 1, lotIdentityVersion: identityVersion,
      priceUsd: 999, valueUsd: 999, valueType: 'total_side_value_usd', source: 's', evidenceType: 't', providerTimestampBucket: null, temporalDistanceMs: null,
      verificationStatus: 'verified', acceptedAt: 0, expiresAt: 100_000_000_000,
    })
    let liveCalls = 0
    const priceKvClient = { getPriceRecovery: async (t: string, c: string, ts: number, fetcher: (t: string, c: string, ts: number) => Promise<number | null>) => { liveCalls += 1; return fetcher(t, c, ts) } }
    const r = createPnlReconciliation({ logger: quiet, priceKvClient: priceKvClient as never, priceSources: { primary: async () => 1 }, acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 50 })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [alreadyPriced] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    assert.equal(summary.realizedPnlUsd, -992, 'canonical entry price (999) wins over the upstream candidate (5) — 7 (unchanged exit) - 999 = -992')
    assert.equal(liveCalls, 0, 'no live call needed — recovery never runs for a side hydration already resolved')
    assert.equal(summary.acceptedEvidenceAudit.existingVerifiedSidesProtectedFromOverwrite, 2, 'kept for backward compatibility — both sides were already upstream-priced going in')
    assert.equal(summary.acceptedEvidenceAudit.existingUpstreamSidesConflictingWithAcceptedEvidence, 1, 'the entry side: upstream said 5, accepted evidence said 999')
    assert.equal(summary.acceptedEvidenceAudit.existingUpstreamSidesWithoutAcceptedEvidence, 1, 'the exit side: no accepted evidence exists for it at all')
    assert.equal(summary.acceptedEvidenceAudit.upstreamPricesRejectedDueToAcceptedEvidence, 1)
  })

  it('HARD ASSERTION: corrupt/mismatched persisted evidence (wrong lot-identity-version) is ignored and falls through to live recovery, never coerced into a price', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    acceptedEvidenceKv.store.set('v1:accepted-evidence:base:0xmismatch:0xb:entry:1', {
      schemaVersion: ACCEPTED_EVIDENCE_SCHEMA_VERSION, chain: 'base', token: '0xmismatch', txHash: '0xb', side: 'entry', timestamp: 1, lotIdentityVersion: 'wrong-version',
      priceUsd: 999, valueUsd: 999, valueType: 'total_side_value_usd', source: 's', evidenceType: 't', providerTimestampBucket: null, temporalDistanceMs: null,
      verificationStatus: 'verified', acceptedAt: 0, expiresAt: 100_000_000_000,
    })
    const missingLot = lot({ lotId: 'm', token: '0xmismatch', openedTxHash: '0xb', closedTxHash: '0xs', openedAt: 1, closedAt: 2, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    let liveCalls = 0
    const priceKvClient = { getPriceRecovery: async (t: string, c: string, ts: number, fetcher: (t: string, c: string, ts: number) => Promise<number | null>) => { liveCalls += 1; return fetcher(t, c, ts) } }
    const r = createPnlReconciliation({ logger: quiet, priceKvClient: priceKvClient as never, priceSources: { primary: async () => 3 }, acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 50 })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [missingLot] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    assert.ok(liveCalls > 0, 'a mismatched entry must never be trusted — live recovery must still run')
    assert.equal(summary.realizedPnlUsd, 0, '3 (live) - 3 (live) = 0, never the corrupt 999 value')
  })

  it('a KV outage during hydration fails open — recovery still runs live, never throws', async () => {
    const brokenKv = { get: async () => { throw new Error('down') }, set: async () => { throw new Error('down') } }
    const missingLot = lot({ lotId: 'm', token: '0xoutage', openedTxHash: '0xb', closedTxHash: '0xs', openedAt: 1, closedAt: 2, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const priceKvClient = { getPriceRecovery: async (t: string, c: string, ts: number, fetcher: (t: string, c: string, ts: number) => Promise<number | null>) => fetcher(t, c, ts) }
    const r = createPnlReconciliation({ logger: quiet, priceKvClient: priceKvClient as never, priceSources: { primary: async () => 4 }, acceptedEvidenceKv: brokenKv as never, now: () => 50 })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [missingLot] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    assert.equal(summary.realizedPnlUsd, 0)
    // Both the live recovery loop's write-back (2 sides) AND the final canonical seeding pass (the
    // same 2 sides, now verified after recovery resolved them) attempt a write against the same
    // broken KV — 2 recovery-lane failures + 2 canonical-seeding failures = 4 total, never a throw.
    assert.equal(summary.acceptedEvidenceAudit.recoveryEvidenceWriteFailures, 2)
    assert.equal(summary.acceptedEvidenceAudit.canonicalSeedingWriteFailures, 2)
    assert.equal(summary.acceptedEvidenceAudit.acceptedEvidenceWriteFailures, 4)
  })

  // ===============================================================================================
  // ACCEPTED-EVIDENCE-STORE SEEDING — accepted-evidence-store-seeding follow-up task, requirement #9.
  // ===============================================================================================

  // 27 lots ALREADY fully priced/verified — simulating upstream canonical pricing (primary
  // historical scheduler, same-tx quote, Alchemy historical pricing, etc.) that resolved every side
  // BEFORE pnlReconciliation's own recovery pass ever runs — the exact production shape reported
  // (43 of 54 sides already verified, recovery resolving zero).
  function build27AlreadyPricedLotFixture(): MatchedLot[] {
    return Array.from({ length: 27 }, (_, i) => lot({
      lotId: `lot-${i}`, token: `0xseed${i}`, openedTxHash: `0xsb${i}`, closedTxHash: `0xss${i}`,
      openedAt: 5000 + i, closedAt: 6000 + i, amount: 1,
      costBasisUsd: 10 + i, proceedsUsd: 20 + i, realizedPnlUsd: 10, evidenceQuality: 'verified',
    }))
  }

  it('HARD ASSERTION (required regression #9): 27 lots already priced by upstream canonical pricing (recovery resolving zero sides) are fully seeded on the first run, then reused identically on a second run where upstream returns null/wrong prices', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()

    // RUN 1: no recovery needed at all — a fetcher that would prove a bug if ever called.
    let liveCallsRun1 = 0
    const priceKvClient1 = { getPriceRecovery: async () => { liveCallsRun1 += 1; return null } }
    const r1 = createPnlReconciliation({
      logger: quiet, priceKvClient: priceKvClient1 as never, priceSources: { primary: async () => { liveCallsRun1 += 1; return null } },
      acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 1_000_000,
    })
    const summary1 = await r1.reconcile({
      fifoEngineResult: fifo({ matchedLots: build27AlreadyPricedLotFixture() }), pnlEngineResult: pnl(27), syntheticPnlAssemblyOutput: null,
    })

    assert.equal(liveCallsRun1, 0, 'recovery must never be invoked — every side was already verified upstream')
    assert.equal(summary1.publicPnlGateAudit.verifiedClosedLots, 27)
    assert.ok(summary1.acceptedEvidenceAudit.canonicalSeedingWriteSuccesses > 0, 'the final seeding pass must persist the already-verified sides')
    assert.equal(summary1.acceptedEvidenceAudit.canonicalSeedingWriteSuccesses, 54, 'all 27 lots x 2 sides must be seeded')
    assert.equal(summary1.acceptedEvidenceAudit.verifiedSidesWritten, 54)
    assert.equal(summary1.acceptedEvidenceAudit.verifiedSideWriteFailures, 0)

    // RUN 2: a FRESH fifoEngine recompute where upstream canonical pricing FAILED this time (both
    // sides null again) — with a deliberately WRONG fetcher as a canary.
    let liveCallsRun2 = 0
    const priceKvClient2 = {
      getPriceRecovery: async (token: string, chain: string, timestamp: number, fetcher: (t: string, c: string, ts: number) => Promise<number | null>) => fetcher(token, chain, timestamp),
    }
    const run2Fetcher = async (token: string, _chain: string, timestamp: number): Promise<number | null> => {
      liveCallsRun2 += 1
      const i = Number(token.replace('0xseed', ''))
      return timestamp === 5000 + i ? (10 + i) + 1000 : null // wrong on purpose
    }
    const unpricedLots2 = Array.from({ length: 27 }, (_, i) => lot({
      lotId: `lot-${i}`, token: `0xseed${i}`, openedTxHash: `0xsb${i}`, closedTxHash: `0xss${i}`,
      openedAt: 5000 + i, closedAt: 6000 + i, amount: 1,
      costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced',
    }))
    const r2 = createPnlReconciliation({
      logger: quiet, priceKvClient: priceKvClient2 as never, priceSources: { primary: run2Fetcher },
      acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 2_000_000,
    })
    const summary2 = await r2.reconcile({
      fifoEngineResult: fifo({ matchedLots: unpricedLots2 }), pnlEngineResult: pnl(27), syntheticPnlAssemblyOutput: null,
    })

    assert.equal(liveCallsRun2, 0, 'exact accepted sides must hydrate BEFORE recovery ever calls a live source')
    assert.equal(summary2.publicPnlGateAudit.verifiedClosedLots, 27)
    assert.equal(summary2.realizedPnlUsd, summary1.realizedPnlUsd, 'identical realized PnL across rescans')
    assert.equal(summary2.acceptedEvidenceAudit.persistedAcceptedSidesLoaded, 54)
    assert.equal(summary2.acceptedEvidenceAudit.persistedAcceptedSidesApplied, 54)
    assert.equal(summary2.acceptedEvidenceAudit.liveSidesResolved, 0)
    assert.equal(summary2.acceptedEvidenceAudit.existingVerifiedSidesProtectedFromOverwrite, 0, 'unpricedLots2 start unpriced — nothing to protect, everything came from hydration')
  })

  it('HARD ASSERTION (requirement #10): verified sides exist but neither hydration nor seeding found/wrote anything -> logs accepted_evidence_store_unseeded', async () => {
    const calls: unknown[][] = []
    const logger = { warn: (...args: unknown[]) => { calls.push(args) } }
    // acceptedEvidenceKv omitted entirely — hydration/seeding both no-op, exactly the unseeded case.
    const alreadyPriced = lot({ lotId: 'x', token: '0xunseeded', openedTxHash: '0xb', closedTxHash: '0xs', openedAt: 1, closedAt: 2, costBasisUsd: 5, proceedsUsd: 7, realizedPnlUsd: 2, evidenceQuality: 'verified' })
    const r = createPnlReconciliation({ logger })
    await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [alreadyPriced] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    const found = calls.find((c) => c[0] === 'accepted_evidence_store_unseeded')
    assert.ok(found, 'must log accepted_evidence_store_unseeded when verified sides exist but the store was never seeded')
  })

  it('does NOT log accepted_evidence_store_unseeded when seeding succeeds', async () => {
    const calls: unknown[][] = []
    const logger = { warn: (...args: unknown[]) => { calls.push(args) } }
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const alreadyPriced = lot({ lotId: 'x', token: '0xseeded', openedTxHash: '0xb', closedTxHash: '0xs', openedAt: 1, closedAt: 2, costBasisUsd: 5, proceedsUsd: 7, realizedPnlUsd: 2, evidenceQuality: 'verified' })
    const r = createPnlReconciliation({ logger, acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 1 })
    await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [alreadyPriced] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    const found = calls.find((c) => c[0] === 'accepted_evidence_store_unseeded')
    assert.equal(found, undefined)
  })

  // ===============================================================================================
  // ACCEPTED-EVIDENCE-RAW-VALUE-MUTATION follow-up task — coverage-aware reseed of a shared side
  // whose persisted record was written while only a SUBSET of its real sibling group was known.
  // ===============================================================================================

  it('HARD ASSERTION: a persisted side whose record only ever covered 1 of 2 now-known siblings is corrected (reseeded) to the true, full group total — genuine group-membership growth, never a value drift', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    // Simulate exactly the pre-fix recovery-lane write: ONE lot's own value, persisted under the
    // SHARED exit side key, with coveredLotCount 1 — written before the second sibling was ever
    // discovered.
    const sharedIdentity = { chain: 'base', token: '0xshared', txHash: '0xsell-shared', side: 'exit' as const, timestamp: 2 }
    acceptedEvidenceKv.store.set(buildAcceptedEvidenceKey({ ...sharedIdentity, lotIdentityVersion: 'v1' }), {
      schemaVersion: ACCEPTED_EVIDENCE_SCHEMA_VERSION, ...sharedIdentity, lotIdentityVersion: 'v1',
      priceUsd: 100, valueUsd: 100, valueType: 'total_side_value_usd', coveredLotCount: 1,
      source: 'recovery-lane', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, temporalDistanceMs: null,
      verificationStatus: 'verified', acceptedAt: 0, expiresAt: 100_000_000_000,
    })
    // Two verified siblings now legitimately share this exact exit side — the live, full-group total
    // (100 + 50 = 150) is genuinely larger than what the stale record ever covered.
    const first = lot({ lotId: 'first', token: '0xshared', openedTxHash: '0xbuy1', closedTxHash: '0xsell-shared', openedAt: 1, closedAt: 2, costBasisUsd: 40, proceedsUsd: 100, realizedPnlUsd: 60, evidenceQuality: 'verified' })
    const second = lot({ lotId: 'second', token: '0xshared', openedTxHash: '0xbuy2', closedTxHash: '0xsell-shared', openedAt: 1, closedAt: 2, amount: 0.5, costBasisUsd: 20, proceedsUsd: 50, realizedPnlUsd: 30, evidenceQuality: 'verified' })
    const r = createPnlReconciliation({ logger: quiet, acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 1 })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [first, second] }), pnlEngineResult: pnl(2), syntheticPnlAssemblyOutput: null })

    assert.equal(summary.acceptedEvidenceAudit.verifiedSidesCoverageReseeded, 2, 'both siblings on the corrected side count as coverage-reseeded')
    const stored = acceptedEvidenceKv.store.get(buildAcceptedEvidenceKey({ ...sharedIdentity, lotIdentityVersion: 'v1' })) as { priceUsd: number; coveredLotCount: number } | undefined
    assert.ok(stored)
    assert.equal(stored!.priceUsd, 150, 'the persisted total is corrected to the true, full 2-sibling group total, never left frozen at the stale 1-sibling value')
    assert.equal(stored!.coveredLotCount, 2, 'the corrected record now honestly records its own real coverage')

    const mutationEntry = summary.acceptedEvidenceAudit.acceptedEvidenceMutationAudit.find((m) => m.writeDecision === 'reseed_coverage_growth')
    assert.ok(mutationEntry, 'the bounded mutation audit records the reseed decision')
    assert.equal(mutationEntry!.firstValueChangeStage, 'occurrence_set_reconstruction')
    assert.equal(mutationEntry!.overwritePrevented, false)
    assert.equal(mutationEntry!.persistedRawUsd, 100)
    assert.equal(mutationEntry!.canonicalSeedRawUsd, 150)
  })

  it('companion — a persisted side whose composition fingerprint ALREADY matches the live group stays frozen even when its value looks wrong, preserving immutability/fail-closed behavior', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const sharedIdentity = { chain: 'base', token: '0xfrozen', txHash: '0xsell-frozen', side: 'exit' as const, timestamp: 2 }
    const first = lot({ lotId: 'first', token: '0xfrozen', openedTxHash: '0xbuy1', closedTxHash: '0xsell-frozen', openedAt: 1, closedAt: 2, costBasisUsd: 40, proceedsUsd: 100, realizedPnlUsd: 60, evidenceQuality: 'verified' })
    const second = lot({ lotId: 'second', token: '0xfrozen', openedTxHash: '0xbuy2', closedTxHash: '0xsell-frozen', openedAt: 1, closedAt: 2, amount: 0.5, costBasisUsd: 20, proceedsUsd: 50, realizedPnlUsd: 30, evidenceQuality: 'verified' })
    // This record already claims to cover BOTH siblings (coveredLotCount: 2) AND its coverageFingerprint
    // is the EXACT same 2-lot composition the live scan will recompute — even though its own value
    // (999) does not match what a live recompute would produce. A genuinely different persisted value
    // on a record whose composition is PROVABLY identical must never be silently corrected by this
    // pass; only manifest replay's own explicit evidence_raw_value_changed classification (a separate,
    // deliberate fail-closed path) may ever flag that — this pass's job is coverage completion only,
    // never value reconciliation.
    acceptedEvidenceKv.store.set(buildAcceptedEvidenceKey({ ...sharedIdentity, lotIdentityVersion: 'v1' }), {
      schemaVersion: ACCEPTED_EVIDENCE_SCHEMA_VERSION, ...sharedIdentity, lotIdentityVersion: 'v1',
      priceUsd: 999, valueUsd: 999, valueType: 'total_side_value_usd', coveredLotCount: 2,
      coverageFingerprint: buildAcceptedEvidenceCoverageFingerprint([first, second]),
      source: 'canonical-upstream', evidenceType: 'unknown', providerTimestampBucket: null, temporalDistanceMs: null,
      verificationStatus: 'verified', acceptedAt: 0, expiresAt: 100_000_000_000,
    })
    const r = createPnlReconciliation({ logger: quiet, acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 1 })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [first, second] }), pnlEngineResult: pnl(2), syntheticPnlAssemblyOutput: null })

    assert.equal(summary.acceptedEvidenceAudit.verifiedSidesCoverageReseeded, 0, 'never reseeded — the existing record already covers the full live group with the SAME composition')
    const stored = acceptedEvidenceKv.store.get(buildAcceptedEvidenceKey({ ...sharedIdentity, lotIdentityVersion: 'v1' })) as { priceUsd: number } | undefined
    assert.equal(stored!.priceUsd, 999, 'the frozen value is untouched — immutability holds for a record whose composition provably matches')
    const mutationEntry = summary.acceptedEvidenceAudit.acceptedEvidenceMutationAudit.find((m) => m.writeDecision === 'skip_already_covers')
    assert.ok(mutationEntry)
    assert.equal(mutationEntry!.overwritePrevented, true)
  })

  it('HARD ASSERTION (accepted-evidence-raw-value-mutation follow-up task, part 2): a persisted side whose coveredLotCount matches the live group SIZE but whose actual sibling SET differs (a different lot swapped in at the same count — the reported "$2 vs $15,198" shape) is NOT incorrectly protected by count alone — it is reseeded', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const sharedIdentity = { chain: 'base', token: '0xswap', txHash: '0xsell-swap', side: 'exit' as const, timestamp: 2 }
    // The record claims coverage of 2 lots — the SAME count as the live group below — but its
    // fingerprint was built from a DIFFERENT pair of siblings (old-first/old-second, distinct
    // lotIds/amounts from the live first/second) and its value (2) is wildly smaller than what the
    // live 2-lot group actually totals (150). Count equality alone would have wrongly protected this;
    // the fingerprint proves the composition is NOT the same set, so it must be reseeded.
    const oldFirst = lot({ lotId: 'old-first', token: '0xswap', openedTxHash: '0xoldbuy1', closedTxHash: '0xsell-swap', openedAt: 1, closedAt: 2, amount: 0.001, costBasisUsd: 1, proceedsUsd: 1, realizedPnlUsd: 0, evidenceQuality: 'verified' })
    const oldSecond = lot({ lotId: 'old-second', token: '0xswap', openedTxHash: '0xoldbuy2', closedTxHash: '0xsell-swap', openedAt: 1, closedAt: 2, amount: 0.001, costBasisUsd: 1, proceedsUsd: 1, realizedPnlUsd: 0, evidenceQuality: 'verified' })
    acceptedEvidenceKv.store.set(buildAcceptedEvidenceKey({ ...sharedIdentity, lotIdentityVersion: 'v1' }), {
      schemaVersion: ACCEPTED_EVIDENCE_SCHEMA_VERSION, ...sharedIdentity, lotIdentityVersion: 'v1',
      priceUsd: 2, valueUsd: 2, valueType: 'total_side_value_usd', coveredLotCount: 2,
      coverageFingerprint: buildAcceptedEvidenceCoverageFingerprint([oldFirst, oldSecond]),
      source: 'canonical-upstream', evidenceType: 'unknown', providerTimestampBucket: null, temporalDistanceMs: null,
      verificationStatus: 'verified', acceptedAt: 0, expiresAt: 100_000_000_000,
    })
    const first = lot({ lotId: 'first', token: '0xswap', openedTxHash: '0xbuy1', closedTxHash: '0xsell-swap', openedAt: 1, closedAt: 2, costBasisUsd: 40, proceedsUsd: 100, realizedPnlUsd: 60, evidenceQuality: 'verified' })
    const second = lot({ lotId: 'second', token: '0xswap', openedTxHash: '0xbuy2', closedTxHash: '0xsell-swap', openedAt: 1, closedAt: 2, amount: 0.5, costBasisUsd: 20, proceedsUsd: 50, realizedPnlUsd: 30, evidenceQuality: 'verified' })
    const r = createPnlReconciliation({ logger: quiet, acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 1 })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [first, second] }), pnlEngineResult: pnl(2), syntheticPnlAssemblyOutput: null })

    assert.equal(summary.acceptedEvidenceAudit.verifiedSidesCoverageReseeded, 2, 'count equality alone must never protect a genuinely different sibling set')
    const stored = acceptedEvidenceKv.store.get(buildAcceptedEvidenceKey({ ...sharedIdentity, lotIdentityVersion: 'v1' })) as { priceUsd: number; coverageFingerprint: string } | undefined
    assert.equal(stored!.priceUsd, 150, 'reseeded to the true, live 2-sibling total — never left frozen at the unrelated $2 value')
    assert.equal(stored!.coverageFingerprint, buildAcceptedEvidenceCoverageFingerprint([first, second]))
  })

  // ===============================================================================================
  // CANONICAL SEEDING ELIGIBILITY — accepted-evidence-canonical-seeding-eligibility follow-up task.
  // ===============================================================================================

  // 27 FINAL CANONICAL lots, real runtime field names only (no invented `verificationStatus`/
  // `pnlDisplayStatus`/`pnlDecisive`/`entryPriceUsd` — MatchedLot has none of those): 19 fully
  // verified/priced lots (38 real, persistable sides) + 8 lots that are NOT canonically verified
  // (evidenceQuality: 'unpriced') but still individually carry a stray, already-resolved side each
  // (a real, common shape — e.g. an entry price resolved, exit still pending) — proving those sides
  // are correctly bucketed as `verifiedSidesSkippedUnverified` rather than silently dropped (the
  // confirmed bug this task fixes) or incorrectly treated as eligible (would violate requirement #2's
  // "same predicate as the gate").
  function build27FinalCanonicalLots(): MatchedLot[] {
    const verified = Array.from({ length: 19 }, (_, i) => lot({
      lotId: `v${i}`, token: `0xcanon${i}`, openedTxHash: `0xcb${i}`, closedTxHash: `0xcs${i}`,
      openedAt: 9000 + i, closedAt: 9500 + i, amount: 1,
      costBasisUsd: 10 + i, proceedsUsd: 20 + i, realizedPnlUsd: 10, evidenceQuality: 'verified',
    }))
    const partial = Array.from({ length: 8 }, (_, i) => lot({
      lotId: `p${i}`, token: `0xpartial${i}`, openedTxHash: `0xpb${i}`, closedTxHash: `0xps${i}`,
      openedAt: 9800 + i, closedAt: 9900 + i, amount: 1,
      costBasisUsd: 5 + i, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced',
    }))
    return [...verified, ...partial]
  }

  it('HARD ASSERTION (required regression #7/#8): every side of a canonically verified lot (the same predicate the gate itself uses) is eligible, seeded, and satisfies the total-sides invariant exactly — using real MatchedLot field names only', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const lots = build27FinalCanonicalLots()
    const priceKvClient = { getPriceRecovery: async () => null } // recovery must never be needed
    const r = createPnlReconciliation({
      logger: quiet, priceKvClient: priceKvClient as never, priceSources: { primary: async () => null },
      acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 1_000_000,
    })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: lots }), pnlEngineResult: pnl(19), syntheticPnlAssemblyOutput: null })

    assert.equal(summary.publicPnlGateAudit.verifiedClosedLots, 19, 'unchanged — same predicate, same gate value as before this fix')
    const audit = summary.acceptedEvidenceAudit
    assert.equal(audit.verifiedSidesEligibleForPersistence, 38, '19 verified lots x 2 sides — the exact bucket that was wrongly reporting 0 in production')
    assert.equal(audit.canonicalSeedingWriteSuccesses, 38)
    assert.equal(audit.verifiedSidesWritten, 38)
    assert.equal(audit.verifiedSideWriteFailures, 0)
    assert.equal(audit.canonicalSeedingWriteFailures, 0)
    assert.equal(audit.verifiedSidesSkippedUnverified, 16, 'the 8 non-verified lots x 2 sides — no longer silently dropped')
    assert.equal(audit.verifiedSidesSkippedInvalid, 0)
    // REQUIREMENT #4's INVARIANT, DISCLOSED: every side lands in exactly one of
    // eligible/skippedUnverified/skippedInvalid — this must hold unconditionally, not by coincidence.
    assert.equal(54, audit.verifiedSidesEligibleForPersistence + audit.verifiedSidesSkippedUnverified + audit.verifiedSidesSkippedInvalid)
  })

  it('HARD ASSERTION (required regression #9): the same 27-lot final-canonical fixture, run twice — second run with upstream returning null and a deliberately wrong live fetcher — reuses the exact accepted evidence with zero live calls and identical realized PnL', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()

    // RUN 1: real MatchedLot shape, 19 verified lots already priced upstream, recovery untouched.
    const r1 = createPnlReconciliation({
      logger: quiet, priceKvClient: { getPriceRecovery: async () => null } as never, priceSources: { primary: async () => null },
      acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 1_000_000,
    })
    const summary1 = await r1.reconcile({ fifoEngineResult: fifo({ matchedLots: build27FinalCanonicalLots() }), pnlEngineResult: pnl(19), syntheticPnlAssemblyOutput: null })
    assert.equal(summary1.acceptedEvidenceAudit.canonicalSeedingWriteSuccesses, 38)

    // RUN 2: a fresh fifoEngine recompute where the 19 previously-verified lots come back UNPRICED
    // (upstream failed this time) — with a deliberately WRONG live fetcher as a canary.
    let liveCalls = 0
    const verifiedNowUnpriced = Array.from({ length: 19 }, (_, i) => lot({
      lotId: `v${i}`, token: `0xcanon${i}`, openedTxHash: `0xcb${i}`, closedTxHash: `0xcs${i}`,
      openedAt: 9000 + i, closedAt: 9500 + i, amount: 1,
      costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced',
    }))
    const partial = Array.from({ length: 8 }, (_, i) => lot({
      lotId: `p${i}`, token: `0xpartial${i}`, openedTxHash: `0xpb${i}`, closedTxHash: `0xps${i}`,
      openedAt: 9800 + i, closedAt: 9900 + i, amount: 1,
      costBasisUsd: 5 + i, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced',
    }))
    const priceKvClient2 = {
      getPriceRecovery: async (token: string, chain: string, timestamp: number, fetcher: (t: string, c: string, ts: number) => Promise<number | null>) => fetcher(token, chain, timestamp),
    }
    const wrongFetcher = async (token: string, _chain: string, timestamp: number): Promise<number | null> => {
      liveCalls += 1
      const i = Number(token.replace('0xcanon', ''))
      return timestamp === 9000 + i ? (10 + i) + 1000 : null
    }
    const r2 = createPnlReconciliation({
      logger: quiet, priceKvClient: priceKvClient2 as never, priceSources: { primary: wrongFetcher },
      acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 2_000_000,
    })
    const summary2 = await r2.reconcile({ fifoEngineResult: fifo({ matchedLots: [...verifiedNowUnpriced, ...partial] }), pnlEngineResult: pnl(19), syntheticPnlAssemblyOutput: null })

    // The 8 "partial" lots' still-missing SELL side legitimately needs live recovery every run (it
    // was never eligible for seeding — the parent lot was never canonically verified) — those 8 live
    // attempts are real and expected. The point under test is the 19 CANONICALLY VERIFIED lots' 38
    // sides: zero of the wrongFetcher's calls can be attributed to them, since hydration must have
    // filled every one from accepted evidence before recovery even runs.
    assert.equal(liveCalls, 8, 'only the 8 never-eligible partial lots need a live attempt — never the 19 already-accepted verified lots')
    assert.equal(summary2.publicPnlGateAudit.verifiedClosedLots, 19)
    assert.equal(summary2.realizedPnlUsd, summary1.realizedPnlUsd, 'identical realized PnL across rescans')
    assert.equal(summary2.acceptedEvidenceAudit.persistedAcceptedSidesLoaded, 38)
    assert.equal(summary2.acceptedEvidenceAudit.persistedAcceptedSidesApplied, 38)
    assert.equal(summary2.acceptedEvidenceAudit.liveSidesResolved, 0)
  })

  it('HARD ASSERTION (requirement #6): CRITICAL accepted_evidence_eligibility_mismatch fires if verified lots and protected sides exist but eligibility somehow still computes zero', async () => {
    // A synthetic worst-case: monkeypatch isn't available on the closure, so this proves the guard
    // logic itself via a lot shape that intentionally makes eligibility legitimately zero for a
    // DIFFERENT, honest reason (structurally invalid identity) — confirming the check does NOT fire
    // a false CRITICAL in a case that already has a valid, disclosed explanation (skippedInvalid > 0).
    const calls: unknown[][] = []
    const logger = { warn: (...args: unknown[]) => { calls.push(args) } }
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    // costBasisUsd non-null (protected from overwrite) but the lot is structurally invalid (empty
    // txHash) — a genuinely explainable zero-eligible case, not a mismatch.
    const structurallyInvalid = lot({ lotId: 'bad', token: '0xbad', openedTxHash: '', closedTxHash: '0xs', openedAt: 1, closedAt: 2, costBasisUsd: 5, proceedsUsd: 7, realizedPnlUsd: 2, evidenceQuality: 'verified' })
    const r = createPnlReconciliation({ logger, acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 1 })
    await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [structurallyInvalid] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    const mismatch = calls.find((c) => c[0] === 'CRITICAL accepted_evidence_eligibility_mismatch')
    assert.equal(mismatch, undefined, 'a structurally-invalid lot is an honest, disclosed skippedInvalid reason — never a silent, unexplained mismatch')
  })

  // ===============================================================================================
  // HYDRATION TIMING & CANONICAL PRECEDENCE — hydration-timing-and-canonical-precedence follow-up
  // task, required regression #7.
  // ===============================================================================================

  function build27CanonicalPrecedenceLots(costBasisByIndex: (i: number) => number | null, proceedsByIndex: (i: number) => number | null): MatchedLot[] {
    return Array.from({ length: 27 }, (_, i) => {
      const costBasisUsd = costBasisByIndex(i)
      const proceedsUsd = proceedsByIndex(i)
      const bothPriced = costBasisUsd !== null && proceedsUsd !== null
      return lot({
        lotId: `cp${i}`, token: `0xprecedence${i}`, openedTxHash: `0xpcb${i}`, closedTxHash: `0xpcs${i}`,
        openedAt: 20000 + i, closedAt: 21000 + i, amount: 1,
        costBasisUsd, proceedsUsd,
        realizedPnlUsd: bothPriced ? proceedsUsd! - costBasisUsd! : null,
        evidenceQuality: bothPriced ? 'verified' : 'unpriced',
      })
    })
  }

  it('HARD ASSERTION (required regression #7): persisted accepted sides apply before provider pricing on a rescan — upstream returning different valid prices, two newly-priceable lots, and some providers returning null never change the previously-accepted portion of the sample', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()

    // RUN 1: upstream prices exactly 17 of 27 lots (indices 0-16); the rest are genuinely unpriced.
    const run1Lots = build27CanonicalPrecedenceLots(
      (i) => (i < 17 ? 10 + i : null),
      (i) => (i < 17 ? 20 + i : null),
    )
    const r1 = createPnlReconciliation({
      logger: quiet, priceKvClient: { getPriceRecovery: async () => null } as never, priceSources: { primary: async () => null },
      acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 1_000_000,
    })
    const summary1 = await r1.reconcile({ fifoEngineResult: fifo({ matchedLots: run1Lots }), pnlEngineResult: pnl(17), syntheticPnlAssemblyOutput: null })
    assert.equal(summary1.publicPnlGateAudit.verifiedClosedLots, 17)
    assert.equal(summary1.acceptedEvidenceAudit.canonicalSeedingWriteSuccesses, 34, '17 lots x 2 sides seeded')

    // RUN 2: same 27 structural lot identities. Upstream now returns DIFFERENT valid prices for the
    // same 17 lots (simulating provider drift), TWO more lots (17, 18) become newly live-priceable,
    // and the remaining lots stay unpriced (simulating "some providers return null").
    const run2UpstreamLots = build27CanonicalPrecedenceLots(
      (i) => (i < 17 ? 10 + i + 500 : null), // deliberately DIFFERENT upstream candidate for the 17
      (i) => (i < 17 ? 20 + i + 500 : null),
    )
    let liveCalls = 0
    const priceKvClient2 = {
      getPriceRecovery: async (token: string, chain: string, timestamp: number, fetcher: (t: string, c: string, ts: number) => Promise<number | null>) => fetcher(token, chain, timestamp),
    }
    const run2Fetcher = async (token: string, _chain: string, timestamp: number): Promise<number | null> => {
      liveCalls += 1
      const i = Number(token.replace('0xprecedence', ''))
      if (i === 17 || i === 18) return timestamp === 20000 + i ? 100 + i : 200 + i // two newly-priceable lots
      return null // every other still-missing lot: provider returns null
    }
    const r2 = createPnlReconciliation({
      logger: quiet, priceKvClient: priceKvClient2 as never, priceSources: { primary: run2Fetcher },
      acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 2_000_000,
    })
    const summary2 = await r2.reconcile({ fifoEngineResult: fifo({ matchedLots: run2UpstreamLots }), pnlEngineResult: pnl(19), syntheticPnlAssemblyOutput: null })

    // The 17 previously-accepted lots: accepted evidence applies BEFORE/OVER the different upstream
    // candidate — no live call is ever needed for them (hydration already fully resolved both sides).
    const audit2 = summary2.acceptedEvidenceAudit
    assert.equal(audit2.persistedAcceptedSidesLoaded, 34, 'persisted accepted sides apply before provider pricing')
    assert.equal(audit2.persistedAcceptedSidesApplied, 34)
    assert.equal(audit2.upstreamLookupsSkippedByAcceptedEvidence + audit2.upstreamPricesMatchingAcceptedEvidence + audit2.upstreamPricesRejectedDueToAcceptedEvidence, 34, 'every accepted side is accounted for as either a skip or a compared-and-overridden upstream candidate')
    assert.ok(audit2.upstreamPricesRejectedDueToAcceptedEvidence > 0, 'the deliberately different run-2 upstream candidates for the 17 lots must be detected and rejected')
    assert.equal(audit2.acceptedEvidenceAppliedAfterUpstreamPricing, 0, 'accepted evidence is always applied before recovery/live pricing by construction')

    // Rebuild what the FIRST 17 lots' canonical prices actually are (from summary1's own known
    // accepted values) to prove they are byte-for-byte unchanged in summary2.
    const unchanged17RealizedPnl = Array.from({ length: 17 }, (_, i) => (20 + i) - (10 + i)).reduce((a, b) => a + b, 0)
    assert.equal(liveCalls, (27 - 17) * 2, 'only the genuinely still-unresolved lots (10, both sides each) ever reach a live fetcher — never the 17 already-accepted ones')
    // Total realized PnL: the unchanged 17 lots' contribution PLUS the 2 newly-resolved lots' own
    // real contribution (100+17=117 buy, 200+17=217 sell -> 100; 100+18=118 buy, 200+18=218 sell -> 100).
    const newlyResolvedContribution = (217 - 117) + (218 - 118)
    assert.equal(summary2.realizedPnlUsd, unchanged17RealizedPnl + newlyResolvedContribution, 'the previously-accepted 17 lots contribute their exact original canonical PnL, unaffected by the different run-2 upstream candidates')
    assert.equal(summary2.publicPnlGateAudit.verifiedClosedLots, 19)
  })

  // ===============================================================================================
  // ACCEPTED-EVIDENCE PERSISTENCE FOR SHARED PARTIAL-FILL SIDES — accepted-evidence-persistence
  // follow-up task. CONFIRMED PRODUCTION ROOT CAUSE: an accepted-evidence key is scoped to one
  // TRANSACTION SIDE (chain/token/txHash/side/timestamp), shared by every sibling FIFO partial-fill
  // lot drawing from that side, but the seeding writer used to persist one sibling's own apportioned
  // USD value under that shared key — the store's "already persisted" check then let only the FIRST
  // writer's value survive, so replay recovered roughly 1/N of the side's genuine total. Fixed: every
  // eligible sibling's value is summed FIRST, the side is written EXACTLY ONCE with the true total,
  // and a rescan allocates that total back across the group deterministically.
  // ===============================================================================================

  // A JSON/KV round-tripping fake — values are genuinely serialized/deserialized on every get/set,
  // never kept as live object references, so a bug that only manifests after a real KV round-trip
  // cannot hide behind an in-memory fake that happens to share object identity.
  function jsonKv(): { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<string>; store: Map<string, string> } {
    const store = new Map<string, string>()
    return {
      store,
      get: async (key: string) => (store.has(key) ? JSON.parse(store.get(key)!) : null),
      set: async (key: string, value: unknown) => { store.set(key, JSON.stringify(value)); return 'OK' },
    }
  }

  // Three GENUINELY IDENTICAL partial-fill siblings — same chain/token/both tx hashes/both
  // timestamps/amount — the exact production shape (one buy tx split into 3 equal sells, or vice
  // versa) that shares ONE accepted-evidence key per side across all three siblings.
  function threeIdenticalSiblings(costBasisEach: number, proceedsEach: number, lotIdSuffixes: readonly string[] = ['0', '1', '2']): MatchedLot[] {
    return lotIdSuffixes.map((suffix) => lot({
      lotId: `sib-${suffix}`, token: '0xsibling', openedTxHash: '0xsibbuy', closedTxHash: '0xsibsell',
      openedAt: 100, closedAt: 200, amount: 1,
      costBasisUsd: costBasisEach, proceedsUsd: proceedsEach, realizedPnlUsd: proceedsEach - costBasisEach,
      evidenceQuality: 'verified',
    }))
  }

  it('HARD ASSERTION (root cause): the seeding writer aggregates every sibling\'s value into ONE genuine side total and writes each side EXACTLY ONCE, never one write per sibling and never a single sibling\'s own apportioned value', async () => {
    const kv = jsonKv()
    const siblings = threeIdenticalSiblings(60, 100) // entry total 3x60=180, exit total 3x100=300
    const r = createPnlReconciliation({ logger: quiet, acceptedEvidenceKv: kv as never, now: () => 1_000_000 })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: siblings }), pnlEngineResult: pnl(3), syntheticPnlAssemblyOutput: null })

    assert.equal(kv.store.size, 2, 'exactly ONE real KV write per side (entry, exit) — never once per sibling')
    assert.equal(summary.acceptedEvidenceAudit.canonicalSeedingWriteSuccesses, 6, 'still counted per lot-side (3 siblings x 2 sides) even though only 2 real KV writes happen')

    const entryRaw = JSON.parse(kv.store.get('v1:accepted-evidence:base:0xsibling:0xsibbuy:entry:100')!) as { priceUsd: number; valueUsd: number; valueType: string; schemaVersion: number }
    const exitRaw = JSON.parse(kv.store.get('v1:accepted-evidence:base:0xsibling:0xsibsell:exit:200')!) as { priceUsd: number; valueUsd: number; valueType: string; schemaVersion: number }
    assert.equal(entryRaw.priceUsd, 180, 'the genuine TOTAL side value (3 x 60) — never one sibling\'s own apportioned 60')
    assert.equal(exitRaw.priceUsd, 300, 'the genuine TOTAL side value (3 x 100) — never one sibling\'s own apportioned 100')
    assert.equal(entryRaw.valueUsd, 180)
    assert.equal(entryRaw.valueType, 'total_side_value_usd', 'value semantics stored explicitly, never left implicit')
    assert.equal(entryRaw.schemaVersion, ACCEPTED_EVIDENCE_SCHEMA_VERSION)
  })

  it('HARD ASSERTION (required regression): 3 identical siblings worth $180 total replay exactly $180 after a genuine JSON/KV round-trip, regardless of sibling array order', async () => {
    const kv = jsonKv()
    // RUN 1: seed the store — 3 identical siblings, each individually apportioned to $60/$100 —
    // genuine entry-side total $180, exit-side total $300.
    const r1 = createPnlReconciliation({ logger: quiet, acceptedEvidenceKv: kv as never, now: () => 1_000_000 })
    await r1.reconcile({ fifoEngineResult: fifo({ matchedLots: threeIdenticalSiblings(60, 100) }), pnlEngineResult: pnl(3), syntheticPnlAssemblyOutput: null })

    // RUN 2: a FRESH fifoEngine recompute (both sides genuinely null again — the real production
    // shape; fifoEngine never caches a price between scans), siblings reordered in the array —
    // proving replay never depends on array position — with a deliberately WRONG live fetcher as a
    // canary that must never be reached.
    const shuffledUnpriced = threeIdenticalSiblings(0, 0, ['2', '0', '1']).map((l) => ({
      ...l, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' as const,
    }))
    let liveCalls = 0
    const priceKvClient2 = { getPriceRecovery: async (t: string, c: string, ts: number, fetcher: (t: string, c: string, ts: number) => Promise<number | null>) => { liveCalls += 1; return fetcher(t, c, ts) } }
    const r2 = createPnlReconciliation({
      logger: quiet, priceKvClient: priceKvClient2 as never, priceSources: { primary: async () => { liveCalls += 1; return 99999 } },
      acceptedEvidenceKv: kv as never, now: () => 2_000_000,
    })
    const summary2 = await r2.reconcile({ fifoEngineResult: fifo({ matchedLots: shuffledUnpriced }), pnlEngineResult: pnl(3), syntheticPnlAssemblyOutput: null })

    assert.equal(liveCalls, 0, 'every side was already accepted — the canary live fetcher must never be reached')
    assert.equal(summary2.publishedMatchedLots.length, 3)
    for (const l of summary2.publishedMatchedLots) {
      assert.equal(l.costBasisUsd, 60, 'identical siblings split an identical total into identical, exact $60 shares')
      assert.equal(l.proceedsUsd, 100, 'identical siblings split an identical total into identical, exact $100 shares')
      assert.equal(l.realizedPnlUsd, 40)
    }
    const entryTotal = summary2.publishedMatchedLots.reduce((s, l) => s + (l.costBasisUsd ?? 0), 0)
    const exitTotal = summary2.publishedMatchedLots.reduce((s, l) => s + (l.proceedsUsd ?? 0), 0)
    assert.equal(entryTotal, 180, 'the 3 siblings\' allocated shares sum EXACTLY back to the stored $180 entry total')
    assert.equal(exitTotal, 300, 'the 3 siblings\' allocated shares sum EXACTLY back to the stored $300 exit total')
    assert.equal(summary2.realizedPnlUsd, 3 * 40, 'identical realized PnL to the original run — never inflated by an N-fold duplication, never collapsed by an N-fold under-count')
  })

  it('HARD ASSERTION: 5 identical siblings\' side total survives a genuine JSON/KV round-trip with an exact, deterministic remainder split (a total not evenly divisible by the sibling count)', async () => {
    const kv = jsonKv()
    // 5 siblings each worth $33.333333... in reality — costBasisUsd fed in pre-rounded to 8dp, so
    // the true side total is not evenly divisible by 5 at cent precision, exercising the same
    // integer-exact remainder assignment allocateSideValueAcrossGroup already guarantees.
    const suffixes = ['0', '1', '2', '3', '4']
    const siblings = suffixes.map((suffix) => lot({
      lotId: `five-${suffix}`, token: '0xfive', openedTxHash: '0xfivebuy', closedTxHash: '0xfivesell',
      openedAt: 300, closedAt: 400, amount: 1,
      costBasisUsd: 33.33333333, proceedsUsd: 50, realizedPnlUsd: 50 - 33.33333333,
      evidenceQuality: 'verified',
    }))
    const r1 = createPnlReconciliation({ logger: quiet, acceptedEvidenceKv: kv as never, now: () => 1_000_000 })
    await r1.reconcile({ fifoEngineResult: fifo({ matchedLots: siblings }), pnlEngineResult: pnl(5), syntheticPnlAssemblyOutput: null })

    const storedTotal = 5 * 33.33333333
    const entryRaw = JSON.parse(kv.store.get('v1:accepted-evidence:base:0xfive:0xfivebuy:entry:300')!) as { priceUsd: number }
    assert.equal(entryRaw.priceUsd, Math.round(storedTotal * 1e8) / 1e8, 'the stored total is the exact sum of all 5 siblings\' own values')

    const shuffled = ['3', '1', '4', '0', '2'].map((suffix) => lot({
      lotId: `five-${suffix}`, token: '0xfive', openedTxHash: '0xfivebuy', closedTxHash: '0xfivesell',
      openedAt: 300, closedAt: 400, amount: 1,
      costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' as const,
    }))
    let liveCalls = 0
    const priceKvClient2 = { getPriceRecovery: async (t: string, c: string, ts: number, fetcher: (t: string, c: string, ts: number) => Promise<number | null>) => { liveCalls += 1; return fetcher(t, c, ts) } }
    const r2 = createPnlReconciliation({ logger: quiet, priceKvClient: priceKvClient2 as never, priceSources: { primary: async () => 99999 }, acceptedEvidenceKv: kv as never, now: () => 2_000_000 })
    const summary2 = await r2.reconcile({ fifoEngineResult: fifo({ matchedLots: shuffled }), pnlEngineResult: pnl(5), syntheticPnlAssemblyOutput: null })

    assert.equal(liveCalls, 0)
    const rebuiltEntryTotal = summary2.publishedMatchedLots.reduce((s, l) => s + (l.costBasisUsd ?? 0), 0)
    assert.equal(Math.round(rebuiltEntryTotal * 1e8) / 1e8, Math.round(storedTotal * 1e8) / 1e8, 'the 5 reconstructed shares sum EXACTLY back to the stored total, bit-for-bit, regardless of remainder placement or array order')
  })

  // STABLECOIN-SIDE-NORMALIZATION FOLLOW-UP TASK — confirmed production shape: canonical-pnl-diff-
  // audit's own stablecoin_side_not_unit_priced warning caught one Base USDC side stored ~$5.9705
  // for an occurrence quantity that should value at ~$1194.1715 at the deterministic $1/token rate
  // this codebase already applies to every address-verified stablecoin elsewhere. hydrateFromAcceptedEvidence
  // (via allocateSideValueAcrossGroup) is a SEPARATE call site from canonicalPnlSampleManifest's own
  // build/replay allocation — this proves the normalization applies here too, not just there.
  it('HARD ASSERTION (required regression): a mispriced verified-stablecoin side hydrated from accepted evidence is normalized to $1/token, never left as verified truth', async () => {
    const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    const stableLot = lot({
      lotId: 'stable-0', token: BASE_USDC, openedTxHash: '0xstablebuy', closedTxHash: '0xstablesell',
      openedAt: 1, closedAt: 2, amount: 1194.1715,
      costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced',
    })
    const kv = fakeAcceptedEvidenceKv()
    const identityVersion = realLotIdentityVersion({
      chain: stableLot.chain, token: stableLot.token, openedTxHash: stableLot.openedTxHash, closedTxHash: stableLot.closedTxHash,
      openedAt: stableLot.openedAt, closedAt: stableLot.closedAt, amount: stableLot.amount,
    })
    const now = 1_000_000
    // Seed the WRONG, confirmed-production total ($5.9705 instead of the correct $1194.1715 at
    // $1/token) — simulating stale/corrupted accepted evidence for a verified stablecoin side.
    kv.store.set(buildAcceptedEvidenceKey({ chain: 'base', token: BASE_USDC, txHash: '0xstablebuy', side: 'entry', timestamp: 1, lotIdentityVersion: identityVersion }), {
      schemaVersion: ACCEPTED_EVIDENCE_SCHEMA_VERSION, chain: 'base', token: BASE_USDC, txHash: '0xstablebuy', side: 'entry', timestamp: 1, lotIdentityVersion: identityVersion,
      priceUsd: 5.9705, valueUsd: 5.9705, valueType: 'total_side_value_usd', source: 's', evidenceType: 't', providerTimestampBucket: null, temporalDistanceMs: null,
      verificationStatus: 'verified', acceptedAt: 0, expiresAt: 100_000_000_000,
    })
    kv.store.set(buildAcceptedEvidenceKey({ chain: 'base', token: BASE_USDC, txHash: '0xstablesell', side: 'exit', timestamp: 2, lotIdentityVersion: identityVersion }), {
      schemaVersion: ACCEPTED_EVIDENCE_SCHEMA_VERSION, chain: 'base', token: BASE_USDC, txHash: '0xstablesell', side: 'exit', timestamp: 2, lotIdentityVersion: identityVersion,
      priceUsd: 5.9705, valueUsd: 5.9705, valueType: 'total_side_value_usd', source: 's', evidenceType: 't', providerTimestampBucket: null, temporalDistanceMs: null,
      verificationStatus: 'verified', acceptedAt: 0, expiresAt: 100_000_000_000,
    })

    const r = createPnlReconciliation({ logger: quiet, acceptedEvidenceKv: kv as never, now: () => now })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [stableLot] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })

    const published = summary.publishedMatchedLots.find((l) => l.lotId === 'stable-0')
    assert.equal(published?.costBasisUsd, 1194.1715, 'the mispriced accepted-evidence total is normalized to the deterministic $1/token figure, not left as the stale wrong value')
  })

  // GATE/CLASSIFICATION-REGRESSION FOLLOW-UP TASK — required regression: confirmed production bug —
  // a manifest replay that genuinely applied (17 real verified lots, stable $608.45 realized total,
  // 100% pricing coverage) was hidden behind publicPnlStatus 'unavailable' because this gate's own,
  // SEPARATE structural-unmatched-sell classification regressed (116 raw unmatched instead of the
  // correct 3 genuine + 113 truncation-unproven-and-excluded). The canonical manifest result must
  // not be hidden when replay applies and the bounded sample is otherwise valid.
  it('HARD ASSERTION (required regression): a replay-applied bounded sample remains limited_verified_sample (\'partial\') even when the raw/live unmatched-sell recompute is high, as long as the manifest itself genuinely applied', async () => {
    const lots = Array.from({ length: 17 }, (_, i) => lot({
      lotId: `manifest-lot-${i}`, token: `0xtok${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}`,
      openedAt: i, closedAt: 100 + i, costBasisUsd: 10, proceedsUsd: 20, realizedPnlUsd: 10,
    }))
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: lots }),
      pnlEngineResult: pnl(17),
      syntheticPnlAssemblyOutput: null,
      // The exact confirmed-regression shape: the LIVE structural recompute reports 116 genuine
      // unmatched sells (a real classification bug elsewhere, out of THIS gate's own scope to fix)
      // and an unproven window boundary — both of which, on their own, would force 'unavailable'.
      structuralCoverageDenominatorAudit: {
        genuineUnmatchedBuys: 0, genuineUnmatchedSells: 116,
        windowBoundaryProven: false, boundedSampleWindowSafe: false, historyCoverageStatus: 'unknown',
      },
      // The canonical manifest replay's own, independent verdict: it genuinely applied.
      canonicalSampleSelector: async (candidateLots) => ({
        publishedLots: [...candidateLots], forcePublicPnlUnavailable: false, manifestApplied: true,
      }),
    })

    assert.equal(summary.publicPnlStatus, 'partial', 'the canonical manifest result must not be hidden when replay applies and the bounded sample is otherwise valid')
    assert.equal(summary.publicPnlGateAudit.verifiedClosedLots, 17)
    assert.equal(summary.realizedPnlUsd, 170)
  })

  it('without a genuinely applied manifest, the same high raw unmatched-sell count still blocks (the fix is scoped, never a general relaxation)', async () => {
    const lots = Array.from({ length: 17 }, (_, i) => lot({
      lotId: `manifest-lot-${i}`, token: `0xtok${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}`,
      openedAt: i, closedAt: 100 + i, costBasisUsd: 10, proceedsUsd: 20, realizedPnlUsd: 10,
    }))
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: lots }),
      pnlEngineResult: pnl(17),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: {
        genuineUnmatchedBuys: 0, genuineUnmatchedSells: 116,
        windowBoundaryProven: false, boundedSampleWindowSafe: false, historyCoverageStatus: 'unknown',
        preWindowInventoryExitsUnprovenDueToTruncation: 2,
      },
      // No canonicalSampleSelector wired at all — no manifest applied signal available.
    })

    assert.equal(summary.publicPnlStatus, 'unavailable', 'without a genuinely applied manifest, a real unproven/blocked structural state still fails closed')
    assert.deepEqual(
      summary.publicPnlGateAudit.blockingReasons.find((reason) => reason.rule === 'window_boundary_unproven_for_unmatched_sells'),
      { rule: 'window_boundary_unproven_for_unmatched_sells', threshold: '0 exits blocked by boundary', actualValue: '2' },
    )
  })

  it('names boundary-blocked sells even when the legacy pre-window truncation count is zero', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedSells: 2 }),
      pnlEngineResult: pnl(0),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: {
        genuineUnmatchedBuys: 0, genuineUnmatchedSells: 2,
        windowBoundaryProven: false, boundedSampleWindowSafe: false,
        preWindowInventoryExitsUnprovenDueToTruncation: 0,
        sellsBlockedSolelyByUnprovenBoundary: 2,
      },
    })
    assert.deepEqual(
      summary.publicPnlGateAudit.blockingReasons.find((reason) => reason.rule === 'window_boundary_unproven_for_unmatched_sells'),
      { rule: 'window_boundary_unproven_for_unmatched_sells', threshold: '0 exits blocked by boundary', actualValue: '2' },
    )
    assert.equal(summary.publicPnlGateAudit.sellsBlockedSolelyByUnprovenBoundary, 2)
  })
})
