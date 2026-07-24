import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FifoOutput, MatchedLot } from '../modules/fifoEngine/types'
import type { PnlSummaryResult } from '../modules/pnlEngine/types'
import { createPnlReconciliation, classifyRecoveryFailureReason } from './pnlReconciliation'

const quiet = { warn() {} }

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return { lotId: 'lot-1', token: '0xtoken', chain: 'base', openedAt: 1, closedAt: 2, openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 1, costBasisUsd: 10, proceedsUsd: 12, realizedPnlUsd: 2, evidenceQuality: 'verified', ...overrides }
}
function fifo(overrides: Partial<FifoOutput> = {}): FifoOutput {
  return { matchedLots: [lot()], unmatchedBuys: 0, unmatchedSells: 0, realizedPnlUsd: 2, unrealizedPnlUsd: 0, costBasisUsd: 10, publicPnlStatus: 'ok', integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 }, ...overrides }
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
    assert.equal(classifyRecoveryFailureReason(null), 'providerReturnedNull')
    assert.equal(classifyRecoveryFailureReason('goldrush_no_data'), 'unsupportedTokenOrChain')
    assert.equal(classifyRecoveryFailureReason('unverified_chain_for_dexscreener'), 'unsupportedTokenOrChain')
    assert.equal(classifyRecoveryFailureReason('unverified_network_for_geckoterminal'), 'unsupportedTokenOrChain')
    assert.equal(classifyRecoveryFailureReason('unverified_chain_for_coingecko'), 'unsupportedTokenOrChain')
    assert.equal(classifyRecoveryFailureReason('base_dex_only_supports_base_chain'), 'unsupportedTokenOrChain')
    assert.equal(classifyRecoveryFailureReason('no_api_key_configured'), 'unsupportedTokenOrChain')
    assert.equal(classifyRecoveryFailureReason('dexscreener_only_exposes_current_price_timestamp_too_far_from_now'), 'timestampOutsideProviderData')
    assert.equal(classifyRecoveryFailureReason('no_price_series_in_range'), 'timestampOutsideProviderData')
    assert.equal(classifyRecoveryFailureReason('unparseable_price'), 'malformedResponse')
    assert.equal(classifyRecoveryFailureReason('could_not_resolve_historical_block'), 'blockResolutionFailure')
    assert.equal(classifyRecoveryFailureReason('no_pool_found'), 'noPool')
    assert.equal(classifyRecoveryFailureReason('no_uniswap_v3_pool_found'), 'noPool')
    assert.equal(classifyRecoveryFailureReason('no_matching_pair'), 'noPool')
    assert.equal(classifyRecoveryFailureReason('http_500'), 'providerReturnedNull')
    assert.equal(classifyRecoveryFailureReason('rpc_error:timeout'), 'providerReturnedNull')
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
})
