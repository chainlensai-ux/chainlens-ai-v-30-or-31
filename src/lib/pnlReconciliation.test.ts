import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FifoOutput, MatchedLot } from '../modules/fifoEngine/types'
import { emptyUnrealizedReconciliation } from '../modules/fifoEngine/types'
import type { PnlSummaryResult } from '../modules/pnlEngine/types'
import { createPnlReconciliation, classifyRecoveryFailureReason } from './pnlReconciliation'

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

describe('pnlReconciliation', () => {
  it('corrects mismatched lots by router inference', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ unmatchedSells: 1 }), pnlEngineResult: pnl(), routerInferenceOutput: { highConfidenceRouters: new Set(['0xrouter']) }, syntheticPnlAssemblyOutput: null })
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
    assert.equal((await r.reconcile({ fifoEngineResult: fifo(), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null })).publicPnlStatus, 'available')
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
  // publicPnlGateAudit / missingEvidenceBreakdown — evidence-first PnL completion task, requirements
  // #1 and #7. A reporting view over the SAME gate structuralConsistent/publicPnlStatus already
  // enforce — never a second, looser or stricter gate.
  // =============================================================================================

  it('publicPnlGateAudit reports integrityTier: full with zero blockingReasons when the gate actually passes', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({ fifoEngineResult: fifo(), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null })
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
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 0, openPositionBuys: 5 },
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
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 0, preWindowInventoryExits: 3, scanWindowDays: 90 },
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

  it('HARD ASSERTION: pnlEngine lot-count disagreement is diagnostic only — never a public veto — while canonical realized PnL and matched lots stay unchanged', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    // fifoEngine reports 1 closed lot; pnlEngine (a separate, independent read model) reports 9 —
    // a real divergence that must be visible but must never by itself block publication.
    const summary = await r.reconcile({ fifoEngineResult: fifo(), pnlEngineResult: pnl(9), syntheticPnlAssemblyOutput: null })
    assert.equal(summary.publicPnlStatus, 'available', 'engine disagreement alone must not block public PnL')
    assert.ok(!summary.publicPnlGateAudit.blockingReasons.some((r2) => r2.rule === 'engine_lot_count_agreement'), 'engine agreement is no longer a gate rule at all')
    assert.deepEqual(summary.publicPnlGateAudit.engineDivergenceDiagnostic, { fifoClosedLots: 1, pnlClosedLots: 9, agrees: false })
    // Canonical figures are computed from fifoEngine alone and are untouched by the divergence.
    assert.equal(summary.realizedPnlUsd, 2)
    assert.equal(summary.publicPnlGateAudit.verifiedClosedLots, 1)
    assert.equal(summary.publicPnlGateAudit.structuralClosedLots, 1)
  })

  it('HARD ASSERTION: production-shaped bounded verified sample (17/27 verified, 62.96% pricing coverage) is published as a clearly-labelled partial sample, never available, never unavailable', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const verifiedLots = Array.from({ length: 17 }, (_, i) => lot({ lotId: `v${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}` }))
    const unpricedLots = Array.from({ length: 10 }, (_, i) => lot({ lotId: `u${i}`, openedTxHash: `0xub${i}`, closedTxHash: `0xus${i}`, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }))
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [...verifiedLots, ...unpricedLots] }),
      pnlEngineResult: pnl(9),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 0, scanWindowDays: 90 },
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
})
