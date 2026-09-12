// Tests for src/lib/verifiedSampleRoiEligibility.ts — ROI denominator quote/cash membership.
//
// Run with:
//   npx tsx --test src/lib/verifiedSampleRoiEligibility.test.ts
//   npx tsx --test src/lib/pnlReconciliation.test.ts

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FifoOutput, MatchedLot } from '../modules/fifoEngine/types'
import { emptyUnrealizedReconciliation } from '../modules/fifoEngine/types'
import type { NormalizedEvent } from '../modules/normalization/types'
import { computeVerifiedSampleAndFullHistoryPerformance, createPnlReconciliation } from './pnlReconciliation'
import {
  classifyVerifiedSampleRoiEligibility,
  liveRoiQuoteLegProofsToPersist,
  mergeRoiQuoteLegProofs,
  persistRoiQuoteLegProofs,
  roiLotKey,
  sanitizeRoiQuoteLegProofs,
  ROI_QUOTE_LEG_PROOF_METHODOLOGY_VERSION,
  type PersistedRoiQuoteLegProof,
} from './verifiedSampleRoiEligibility'
import {
  buildManifestIdentity,
  isValidCanonicalPnlSampleManifest,
  readCanonicalPnlSampleManifest,
  writeCanonicalPnlSampleManifest,
  CANONICAL_LOT_IDENTITY_SCHEMA_VERSION,
  type CanonicalPnlSampleManifest,
  type CanonicalSampleManifestKvLike,
} from './canonicalPnlSampleManifest'

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const TOKEN = '0x1bc0c42215582d5a085795f4badbac3ff36d1bcb'
const EOA_A = '0x1111111111111111111111111111111111111111'
const EOA_B = '0x2222222222222222222222222222222222222222'
const ZERO = '0x0000000000000000000000000000000000000000'
const SWAP_ROUTER02 = '0x2626664c2603336e57b271c5c0b26f421741e481'
const WALLET = '0x4dbb3835744b2976560e0259cb218cab89abef96'

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return {
    lotId: 'lot-1',
    token: TOKEN,
    chain: 'base',
    openedAt: 1,
    closedAt: 2,
    openedTxHash: '0xbuy',
    closedTxHash: '0xsell',
    amount: 1,
    costBasisUsd: 100,
    proceedsUsd: 80,
    realizedPnlUsd: -20,
    evidenceQuality: 'verified',
    ...overrides,
  }
}

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'alchemy',
    chain: 'base',
    txHash: '0xtx',
    timestamp: '2025-01-01T00:00:00.000Z',
    fromAddress: EOA_A,
    toAddress: WALLET,
    contract: USDC,
    symbol: 'USDC',
    amount: 1000,
    amountRaw: '1000000000',
    tokenDecimals: 6,
    direction: 'inbound',
    ...overrides,
  }
}

function performanceParams(overrides: Partial<Parameters<typeof computeVerifiedSampleAndFullHistoryPerformance>[0]> = {}) {
  return {
    verifiedLots: [] as MatchedLot[],
    structuralLotCount: 0,
    realizedPnlUsd: 0,
    verifiedPricingCoverage: 1,
    pricingCoverageThresholdMet: true,
    excludedUnmatchedSellCount: 0,
    canonicalConsistencyPassed: true,
    includedSamplePricingMissing: 0,
    hardInvalidFifoResult: false,
    canonicalSampleUnavailable: false,
    publicPnlStatus: 'unavailable' as const,
    fullHistoryBlockingReasons: ['unmatched_sells'] as readonly string[],
    ...overrides,
  }
}

describe('verifiedSampleRoiEligibility — quote/cash vs independent stablecoin', () => {
  it('HARD ASSERTION: token/USDC swap must not double-count quote capital in realized ROI', () => {
    const buyTx = '0xswapbuy'
    const sellTx = '0xswapsell'
    const priorUsdcInTx = '0xpriorsell'
    const tokenLot = lot({
      lotId: 'token',
      token: TOKEN,
      openedTxHash: buyTx,
      closedTxHash: sellTx,
      openedAt: 10,
      closedAt: 20,
      amount: 50,
      costBasisUsd: 1000,
      proceedsUsd: 700,
      realizedPnlUsd: -300,
    })
    const usdcQuoteLot = lot({
      lotId: 'usdc-quote',
      token: USDC,
      openedTxHash: priorUsdcInTx,
      closedTxHash: buyTx,
      openedAt: 5,
      closedAt: 10,
      amount: 1000,
      costBasisUsd: 1000,
      proceedsUsd: 1000,
      realizedPnlUsd: 0,
    })
    const events: NormalizedEvent[] = [
      event({ txHash: priorUsdcInTx, contract: TOKEN, symbol: 'CLANKER', direction: 'outbound', fromAddress: WALLET, toAddress: SWAP_ROUTER02 }),
      event({ txHash: priorUsdcInTx, contract: USDC, symbol: 'USDC', direction: 'inbound', fromAddress: SWAP_ROUTER02, toAddress: WALLET, amount: 1000 }),
      event({ txHash: buyTx, contract: USDC, symbol: 'USDC', direction: 'outbound', fromAddress: WALLET, toAddress: SWAP_ROUTER02, amount: 1000 }),
      event({ txHash: buyTx, contract: TOKEN, symbol: 'CLANKER', direction: 'inbound', fromAddress: SWAP_ROUTER02, toAddress: WALLET, amount: 50 }),
      event({ txHash: sellTx, contract: TOKEN, symbol: 'CLANKER', direction: 'outbound', fromAddress: WALLET, toAddress: SWAP_ROUTER02, amount: 50 }),
      event({ txHash: sellTx, contract: USDC, symbol: 'USDC', direction: 'inbound', fromAddress: SWAP_ROUTER02, toAddress: WALLET, amount: 700 }),
    ]

    const eligibility = classifyVerifiedSampleRoiEligibility({
      verifiedLots: [tokenLot, usdcQuoteLot],
      structuralLots: [tokenLot, usdcQuoteLot],
      normalizedEvents: events,
    })
    assert.equal(eligibility.quoteCashLegLots.length, 1)
    assert.equal(eligibility.verifiedSampleRoiEligibleLots.length, 1)
    assert.equal(eligibility.verifiedSampleRoiEligibleLots[0]!.lotId, 'token')
    const usdcRow = eligibility.classifications.find((row) => row.token.toLowerCase() === USDC)
    assert.equal(usdcRow?.roiDenominatorDisposition, 'exclude_quote_cash_leg')
    assert.equal(usdcRow?.isQuoteLeg, true)
    assert.equal(usdcRow?.isIndependentStablecoinTrade, false)
    assert.ok(usdcRow?.pairedRiskAssetLotKeys.includes(roiLotKey(tokenLot)))
    assert.equal(eligibility.roiAvailable, true)
    assert.equal(eligibility.realizedRoiPnlUsd, -300)
    assert.equal(eligibility.realizedRoiCostBasisUsd, 1000)

    const result = computeVerifiedSampleAndFullHistoryPerformance(performanceParams({
      verifiedLots: [tokenLot, usdcQuoteLot],
      structuralLots: [tokenLot, usdcQuoteLot],
      normalizedEvents: events,
      structuralLotCount: 2,
      realizedPnlUsd: -300,
    }))
    assert.equal(result.verifiedSamplePerformance.status, 'verified_bounded_sample')
    assert.equal(result.verifiedSamplePerformance.realizedPnlUsd, -300, 'displayed sample PnL stays on the full verified sample')
    assert.equal(result.verifiedSamplePerformance.realizedCostBasisUsd, 1000, 'ROI denom is token cost only — USDC quote cash is not added')
    assert.equal(result.verifiedSamplePerformance.realizedRoiPct, -30)
    assert.equal(result.verifiedSamplePerformance.verifiedLotCount, 2)
    assert.equal(result.verifiedSamplePerformance.verifiedSampleRoiEligibleLotCount, 1)
    assert.equal(result.verifiedSamplePerformance.quoteCashLegExcludedLotCount, 1)
    assert.equal(result.verifiedSamplePerformance.roiUnavailableReason, null)
    assert.equal(result.fullHistoryPerformance.status, 'unavailable', 'full-history gate unchanged')
    assert.equal(result.fullHistoryPerformance.realizedRoiPct, null)
  })

  it('HARD ASSERTION: genuine independent stablecoin trade remains eligible', () => {
    const openTx = '0xeoain'
    const closeTx = '0xeoaout'
    const independent = lot({
      lotId: 'usdc-independent',
      token: USDC,
      openedTxHash: openTx,
      closedTxHash: closeTx,
      openedAt: 1,
      closedAt: 2,
      amount: 5000,
      costBasisUsd: 5000,
      proceedsUsd: 5000,
      realizedPnlUsd: 0,
    })
    const risk = lot({
      lotId: 'token-unrelated',
      token: TOKEN,
      openedTxHash: '0xothertokenbuy',
      closedTxHash: '0xothertokensell',
      openedAt: 3,
      closedAt: 4,
      amount: 10,
      costBasisUsd: 2000,
      proceedsUsd: 1500,
      realizedPnlUsd: -500,
    })
    const events: NormalizedEvent[] = [
      event({ txHash: openTx, contract: USDC, direction: 'inbound', fromAddress: EOA_A, toAddress: WALLET, amount: 5000 }),
      event({ txHash: closeTx, contract: USDC, direction: 'outbound', fromAddress: WALLET, toAddress: EOA_B, amount: 5000 }),
      event({ txHash: '0xothertokenbuy', contract: TOKEN, symbol: 'CLANKER', direction: 'inbound', fromAddress: SWAP_ROUTER02, toAddress: WALLET }),
      event({ txHash: '0xothertokensell', contract: TOKEN, symbol: 'CLANKER', direction: 'outbound', fromAddress: WALLET, toAddress: SWAP_ROUTER02 }),
    ]

    const eligibility = classifyVerifiedSampleRoiEligibility({
      verifiedLots: [independent, risk],
      structuralLots: [independent, risk],
      normalizedEvents: events,
    })
    const usdcRow = eligibility.classifications.find((row) => row.token.toLowerCase() === USDC)
    assert.equal(usdcRow?.roiDenominatorDisposition, 'include_economic_position')
    assert.equal(usdcRow?.isQuoteLeg, false)
    assert.equal(usdcRow?.isIndependentStablecoinTrade, true)
    assert.equal(usdcRow?.pairedRiskAssetLotKeys.length, 0)
    assert.equal(eligibility.roiAvailable, true)
    assert.equal(eligibility.realizedRoiCostBasisUsd, 7000)
    assert.equal(eligibility.realizedRoiPnlUsd, -500)

    const mint = lot({
      lotId: 'usdc-mint',
      token: USDC,
      openedTxHash: '0xmint',
      closedTxHash: '0xmintout',
      openedAt: 8,
      closedAt: 9,
      amount: 0.62,
      costBasisUsd: 0.62,
      proceedsUsd: 0.62,
      realizedPnlUsd: 0,
    })
    const mintEvents: NormalizedEvent[] = [
      event({ txHash: '0xmint', contract: USDC, direction: 'inbound', fromAddress: ZERO, toAddress: WALLET, amount: 0.62 }),
      event({ txHash: '0xmintout', contract: USDC, direction: 'outbound', fromAddress: WALLET, toAddress: EOA_B, amount: 0.62 }),
    ]
    const mintEligibility = classifyVerifiedSampleRoiEligibility({
      verifiedLots: [mint],
      normalizedEvents: mintEvents,
    })
    assert.equal(mintEligibility.classifications[0]?.roiDenominatorDisposition, 'include_economic_position')
    assert.equal(mintEligibility.classifications[0]?.isIndependentStablecoinTrade, true)
    assert.equal(mintEligibility.roiAvailable, true)
    assert.equal(mintEligibility.realizedRoiCostBasisUsd, 0.62)

    const result = computeVerifiedSampleAndFullHistoryPerformance(performanceParams({
      verifiedLots: [independent, risk],
      structuralLots: [independent, risk],
      normalizedEvents: events,
      structuralLotCount: 2,
      realizedPnlUsd: -500,
    }))
    assert.equal(result.verifiedSamplePerformance.realizedPnlUsd, -500)
    assert.equal(result.verifiedSamplePerformance.realizedCostBasisUsd, 7000)
    assert.ok(result.verifiedSamplePerformance.realizedRoiPct != null)
    assert.ok(Math.abs(result.verifiedSamplePerformance.realizedRoiPct! - (-500 / 7000) * 100) < 1e-9)
    assert.equal(result.verifiedSamplePerformance.verifiedSampleRoiEligibleLotCount, 2)
    assert.equal(result.verifiedSamplePerformance.quoteCashLegExcludedLotCount, 0)
  })

  it('HARD ASSERTION: unresolved quote-leg identity makes ROI unavailable rather than guessing', () => {
    const usdcLot = lot({
      lotId: 'usdc-router-only',
      token: USDC,
      openedTxHash: '0xrouterin',
      closedTxHash: '0xrouterout',
      openedAt: 1,
      closedAt: 2,
      amount: 2500,
      costBasisUsd: 2500,
      proceedsUsd: 2500,
      realizedPnlUsd: 0,
    })
    const risk = lot({
      lotId: 'token',
      token: TOKEN,
      openedTxHash: '0xotherbuy',
      closedTxHash: '0xothersell',
      costBasisUsd: 4000,
      proceedsUsd: 3000,
      realizedPnlUsd: -1000,
    })
    const routerOnlyEvents: NormalizedEvent[] = [
      event({ txHash: '0xrouterin', contract: USDC, direction: 'inbound', fromAddress: SWAP_ROUTER02, toAddress: WALLET, amount: 2500 }),
      event({ txHash: '0xrouterout', contract: USDC, direction: 'outbound', fromAddress: WALLET, toAddress: SWAP_ROUTER02, amount: 2500 }),
    ]

    const eligibility = classifyVerifiedSampleRoiEligibility({
      verifiedLots: [usdcLot, risk],
      structuralLots: [usdcLot, risk],
      normalizedEvents: routerOnlyEvents,
    })
    const usdcRow = eligibility.classifications.find((row) => row.token.toLowerCase() === USDC)
    assert.equal(usdcRow?.roiDenominatorDisposition, 'unresolved')
    assert.equal(usdcRow?.isQuoteLeg, false)
    assert.equal(eligibility.roiAvailable, false)
    assert.equal(eligibility.roiUnavailableReason, 'unresolved_quote_leg_identity')
    assert.equal(eligibility.realizedRoiPnlUsd, null, 'must not guess a numerator')
    assert.equal(eligibility.realizedRoiCostBasisUsd, null, 'must not guess a denominator')

    const result = computeVerifiedSampleAndFullHistoryPerformance(performanceParams({
      verifiedLots: [usdcLot, risk],
      structuralLots: [usdcLot, risk],
      normalizedEvents: routerOnlyEvents,
      structuralLotCount: 2,
      realizedPnlUsd: -1000,
    }))
    assert.equal(result.verifiedSamplePerformance.status, 'verified_bounded_sample')
    assert.equal(result.verifiedSamplePerformance.realizedPnlUsd, -1000, 'sample PnL display is unchanged')
    assert.equal(result.verifiedSamplePerformance.realizedRoiPct, null, 'ROI is unavailable, never a guessed percentage')
    assert.equal(result.verifiedSamplePerformance.roiUnavailableReason, 'unresolved_quote_leg_identity')
    assert.equal(result.verifiedSamplePerformance.unresolvedQuoteLegLotCount, 1)
    assert.equal(result.fullHistoryPerformance.realizedRoiPct, null)

    const noEvents = classifyVerifiedSampleRoiEligibility({
      verifiedLots: [usdcLot],
      structuralLots: [usdcLot],
    })
    assert.equal(noEvents.classifications[0]?.roiDenominatorDisposition, 'unresolved')
    assert.equal(noEvents.roiAvailable, false)
  })

  it('does not exclude a non-stable lot just because a verified stablecoin address exists in the sample', () => {
    const tokenLot = lot({ costBasisUsd: 248837.27, proceedsUsd: 178042.3, realizedPnlUsd: -70794.97 })
    const eligibility = classifyVerifiedSampleRoiEligibility({ verifiedLots: [tokenLot] })
    assert.equal(eligibility.verifiedSampleRoiEligibleLots.length, 1)
    assert.equal(eligibility.quoteCashLegLots.length, 0)
    assert.equal(eligibility.classifications[0]?.roiDenominatorDisposition, 'include_economic_position')
  })

  it('HARD ASSERTION: manifest-replayed historical quote lots stay excluded when bounded events omit those txs', () => {
    // Published verified sample (manifest replay): one risk lot + its USDC quote/cash lot.
    // Structural FIFO also includes an unpriced historical risk lot that financed a second
    // manifest-replayed USDC lot. The current bounded event window contains neither historical
    // tx — the live 72→16 failure mode. FIFO identity is primary; missing events must not
    // reclassify a proven quote leg as independent.
    const liveBuyTx = '0xlivebuy'
    const liveSellTx = '0xlivesell'
    const historicalBuyTx = '0xhistbuy'
    const historicalSellTx = '0xhistsell'
    const historicalUsdcOpenTx = '0xhistusdcopen'
    const publishedRisk = lot({
      lotId: 'published-risk',
      token: TOKEN,
      openedTxHash: liveBuyTx,
      closedTxHash: liveSellTx,
      openedAt: 100,
      closedAt: 110,
      amount: 50,
      costBasisUsd: 1000,
      proceedsUsd: 700,
      realizedPnlUsd: -300,
    })
    const publishedUsdcQuote = lot({
      lotId: 'published-usdc-quote',
      token: USDC,
      openedTxHash: historicalSellTx,
      closedTxHash: liveBuyTx,
      openedAt: 50,
      closedAt: 100,
      amount: 1000,
      costBasisUsd: 1000,
      proceedsUsd: 1000,
      realizedPnlUsd: 0,
    })
    const historicalUsdcQuote = lot({
      lotId: 'historical-usdc-quote',
      token: USDC,
      openedTxHash: historicalUsdcOpenTx,
      closedTxHash: historicalBuyTx,
      openedAt: 10,
      closedAt: 20,
      amount: 400,
      costBasisUsd: 400,
      proceedsUsd: 400,
      realizedPnlUsd: 0,
    })
    const unpricedHistoricalRisk = lot({
      lotId: 'unpriced-historical-risk',
      token: TOKEN,
      openedTxHash: historicalBuyTx,
      closedTxHash: historicalSellTx,
      openedAt: 20,
      closedAt: 50,
      amount: 12,
      costBasisUsd: null,
      proceedsUsd: null,
      realizedPnlUsd: null,
      evidenceQuality: 'unpriced',
    })
    const boundedEvents: NormalizedEvent[] = [
      event({ txHash: liveBuyTx, contract: USDC, direction: 'outbound', fromAddress: WALLET, toAddress: SWAP_ROUTER02, amount: 1000 }),
      event({ txHash: liveBuyTx, contract: TOKEN, symbol: 'CLANKER', direction: 'inbound', fromAddress: SWAP_ROUTER02, toAddress: WALLET, amount: 50 }),
      event({ txHash: liveSellTx, contract: TOKEN, symbol: 'CLANKER', direction: 'outbound', fromAddress: WALLET, toAddress: SWAP_ROUTER02, amount: 50 }),
      event({ txHash: liveSellTx, contract: USDC, direction: 'inbound', fromAddress: SWAP_ROUTER02, toAddress: WALLET, amount: 700 }),
    ]

    const eligibility = classifyVerifiedSampleRoiEligibility({
      verifiedLots: [publishedRisk, publishedUsdcQuote, historicalUsdcQuote],
      structuralLots: [publishedRisk, publishedUsdcQuote, historicalUsdcQuote, unpricedHistoricalRisk],
      normalizedEvents: boundedEvents,
    })

    const publishedUsdcRow = eligibility.classifications.find((row) => row.lotKey === roiLotKey(publishedUsdcQuote))
    const historicalUsdcRow = eligibility.classifications.find((row) => row.lotKey === roiLotKey(historicalUsdcQuote))
    assert.equal(publishedUsdcRow?.roiDenominatorDisposition, 'exclude_quote_cash_leg')
    assert.equal(publishedUsdcRow?.reason, 'fifo_paired_quote_cash')
    assert.equal(publishedUsdcRow?.fifoPairAtOpen, true)
    assert.equal(publishedUsdcRow?.openTxPresentInEvents, false)
    assert.equal(historicalUsdcRow?.roiDenominatorDisposition, 'exclude_quote_cash_leg')
    assert.equal(historicalUsdcRow?.reason, 'fifo_paired_quote_cash')
    assert.equal(historicalUsdcRow?.fifoPairAtClose, true)
    assert.equal(historicalUsdcRow?.openTxPresentInEvents, false)
    assert.equal(historicalUsdcRow?.closeTxPresentInEvents, false)
    assert.equal(historicalUsdcRow?.isIndependentStablecoinTrade, false)
    assert.equal(eligibility.quoteCashLegLots.length, 2)
    assert.equal(eligibility.unresolvedLots.length, 0)
    assert.equal(eligibility.verifiedSampleRoiEligibleLots.length, 1)
    assert.equal(eligibility.roiAvailable, true)
    assert.equal(eligibility.realizedRoiCostBasisUsd, 1000)
    assert.equal(eligibility.realizedRoiPnlUsd, -300)
  })

  it('HARD ASSERTION: missing bounded event context without a FIFO pair is unresolved, never independent', () => {
    const historicalUsdc = lot({
      lotId: 'historical-usdc-unpaired',
      token: USDC,
      openedTxHash: '0xmissingopen',
      closedTxHash: '0xmissingclose',
      openedAt: 1,
      closedAt: 2,
      amount: 800,
      costBasisUsd: 800,
      proceedsUsd: 800,
      realizedPnlUsd: 0,
    })
    const unrelatedRisk = lot({
      lotId: 'unrelated-risk',
      token: TOKEN,
      openedTxHash: '0xotherbuy',
      closedTxHash: '0xothersell',
      costBasisUsd: 2000,
      proceedsUsd: 1500,
      realizedPnlUsd: -500,
    })
    const boundedEvents: NormalizedEvent[] = [
      event({ txHash: '0xotherbuy', contract: TOKEN, symbol: 'CLANKER', direction: 'inbound', fromAddress: SWAP_ROUTER02, toAddress: WALLET }),
      event({ txHash: '0xothersell', contract: TOKEN, symbol: 'CLANKER', direction: 'outbound', fromAddress: WALLET, toAddress: SWAP_ROUTER02 }),
    ]

    const eligibility = classifyVerifiedSampleRoiEligibility({
      verifiedLots: [historicalUsdc, unrelatedRisk],
      structuralLots: [historicalUsdc, unrelatedRisk],
      normalizedEvents: boundedEvents,
    })
    const usdcRow = eligibility.classifications.find((row) => row.token.toLowerCase() === USDC)
    assert.equal(usdcRow?.roiDenominatorDisposition, 'unresolved')
    assert.equal(usdcRow?.reason, 'unresolved_missing_event_context')
    assert.equal(usdcRow?.isIndependentStablecoinTrade, false)
    assert.equal(usdcRow?.openTxPresentInEvents, false)
    assert.equal(usdcRow?.closeTxPresentInEvents, false)
    assert.equal(eligibility.roiAvailable, false)
    assert.equal(eligibility.realizedRoiPnlUsd, null)
    assert.equal(eligibility.realizedRoiCostBasisUsd, null)
  })
})

describe('production reconcile path — unmatched FIFO identities survive into ROI pairing', () => {
  it('HARD ASSERTION: historical unpriced risk counterpart as unmatched sell still excludes the USDC quote lot', async () => {
    const historicalSellTx = '0xhistoricaltokensell'
    const liveBuyTx = '0xliveusdcspend'
    const liveSellTx = '0xlivetokensell'
    const independentOpenTx = '0xeoain'
    const independentCloseTx = '0xeoaout'

    const publishedRisk = lot({
      lotId: 'token-live',
      token: TOKEN,
      openedTxHash: liveBuyTx,
      closedTxHash: liveSellTx,
      openedAt: 20,
      closedAt: 30,
      amount: 50,
      costBasisUsd: 1000,
      proceedsUsd: 700,
      realizedPnlUsd: -300,
    })
    const publishedUsdcQuote = lot({
      lotId: 'usdc-quote-historical-open',
      token: USDC,
      openedTxHash: historicalSellTx,
      closedTxHash: liveBuyTx,
      openedAt: 10,
      closedAt: 20,
      amount: 1000,
      costBasisUsd: 1000,
      proceedsUsd: 1000,
      realizedPnlUsd: 0,
    })
    const independentUsdc = lot({
      lotId: 'usdc-independent',
      token: USDC,
      openedTxHash: independentOpenTx,
      closedTxHash: independentCloseTx,
      openedAt: 1,
      closedAt: 2,
      amount: 5000,
      costBasisUsd: 5000,
      proceedsUsd: 5000,
      realizedPnlUsd: 0,
    })

    const boundedEvents: NormalizedEvent[] = [
      event({ txHash: liveBuyTx, contract: USDC, direction: 'outbound', fromAddress: WALLET, toAddress: SWAP_ROUTER02, amount: 1000 }),
      event({ txHash: liveBuyTx, contract: TOKEN, symbol: 'CLANKER', direction: 'inbound', fromAddress: SWAP_ROUTER02, toAddress: WALLET, amount: 50 }),
      event({ txHash: liveSellTx, contract: TOKEN, symbol: 'CLANKER', direction: 'outbound', fromAddress: WALLET, toAddress: SWAP_ROUTER02, amount: 50 }),
      event({ txHash: liveSellTx, contract: USDC, direction: 'inbound', fromAddress: SWAP_ROUTER02, toAddress: WALLET, amount: 700 }),
      event({ txHash: independentOpenTx, contract: USDC, direction: 'inbound', fromAddress: EOA_A, toAddress: WALLET, amount: 5000 }),
      event({ txHash: independentCloseTx, contract: USDC, direction: 'outbound', fromAddress: WALLET, toAddress: EOA_B, amount: 5000 }),
    ]

    const fifoEngineResult: FifoOutput = {
      matchedLots: [publishedRisk, publishedUsdcQuote, independentUsdc],
      unmatchedBuys: 0,
      unmatchedSells: 1,
      unmatchedBuyEvents: [],
      unmatchedSellEvents: [{
        chain: 'base',
        txHash: historicalSellTx,
        token: TOKEN,
        timestamp: 10,
        direction: 'outbound',
        amount: 50,
        fromAddress: WALLET,
        toAddress: SWAP_ROUTER02,
        amountRaw: '50000000000000000000',
      }],
      realizedPnlUsd: -300,
      unrealizedPnlUsd: 0,
      costBasisUsd: 7000,
      publicPnlStatus: 'unavailable',
      integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 },
      unrealizedPnlExcludedTokens: [],
      unrealizedReconciliation: emptyUnrealizedReconciliation(),
    }

    const classificationLogs: Array<Record<string, unknown>> = []
    const r = createPnlReconciliation({
      logger: {
        warn(message: string, payload?: unknown) {
          if (message === '[roi-quote-leg-classification]' && payload && typeof payload === 'object') {
            classificationLogs.push(payload as Record<string, unknown>)
          }
        },
      },
    })
    const summary = await r.reconcile({
      fifoEngineResult,
      pnlEngineResult: {
        realizedPnlUsd: -300,
        closedLots: [],
        winLossRate: { wins: 0, losses: 1, evaluated: 1, rate: 0 },
        chainBreakdown: [],
        confidenceBasis: { high: 3, medium: 0, low: 0, aggregate: 'high' },
        evidenceMissingCount: 0,
      },
      syntheticPnlAssemblyOutput: null,
      normalizedEvents: boundedEvents,
      structuralCoverageDenominatorAudit: {
        genuineUnmatchedBuys: 0,
        genuineUnmatchedSells: 1,
        windowBoundaryProven: false,
        boundedSampleWindowSafe: true,
        historyCoverageStatus: 'truncated',
        scanWindowDays: 90,
      },
    })

    assert.equal(summary.verifiedSamplePerformance.verifiedLotCount, 3)
    assert.equal(summary.verifiedSamplePerformance.realizedPnlUsd, -300, 'displayed sample PnL stays on the full verified sample')
    assert.equal(summary.verifiedSamplePerformance.quoteCashLegExcludedLotCount, 1)
    assert.equal(summary.verifiedSamplePerformance.unresolvedQuoteLegLotCount, 0)
    assert.equal(summary.verifiedSamplePerformance.verifiedSampleRoiEligibleLotCount, 2)
    assert.equal(summary.verifiedSamplePerformance.roiUnavailableReason, null)
    assert.equal(summary.verifiedSamplePerformance.realizedCostBasisUsd, 6000)
    assert.ok(summary.verifiedSamplePerformance.realizedRoiPct != null)
    assert.ok(Math.abs(summary.verifiedSamplePerformance.realizedRoiPct! - (-300 / 6000) * 100) < 1e-9)
    assert.equal(summary.publishedMatchedLots.length, 3, 'unmatched risk counterpart is pairing-only, never published')
    assert.equal(summary.publishedMatchedLots.filter((row) => row.evidenceQuality === 'verified').length, 3)

    assert.equal(classificationLogs.length, 1)
    const audit = classificationLogs[0]!
    assert.equal(audit.verifiedLotsCount, 3)
    assert.equal(audit.consistentFifoLotsCount, 3)
    assert.equal(audit.publishedFifoLotsCount, 3)
    assert.equal(audit.structuralLotsCount, 4)
    assert.equal(audit.unmatchedSellEventsCount, 1)
    const stableLots = audit.stableLots as Array<Record<string, unknown>>
    const quoteRow = stableLots.find((row) => row.openTx === historicalSellTx)
    const independentRow = stableLots.find((row) => row.openTx === independentOpenTx)
    assert.equal(quoteRow?.disposition, 'exclude_quote_cash_leg')
    assert.equal(quoteRow?.structuralRiskPairAtOpen, true)
    assert.equal(independentRow?.disposition, 'include_economic_position')
  })
})

describe('ROI quote-leg proof persist + bounded-scan replay', () => {
  const historicalUsdcOpenTx = '0xhistusdcopen'
  const historicalBuyTx = '0xhistbuy'
  const historicalSellTx = '0xhistsell'
  const liveBuyTx = '0xlivebuy'
  const liveSellTx = '0xlivesell'
  const independentOpenTx = '0xeoain'
  const independentCloseTx = '0xeoaout'

  const publishedRisk = lot({
    lotId: 'published-risk',
    token: TOKEN,
    openedTxHash: liveBuyTx,
    closedTxHash: liveSellTx,
    openedAt: 100,
    closedAt: 110,
    amount: 50,
    costBasisUsd: 1000,
    proceedsUsd: 700,
    realizedPnlUsd: -300,
  })
  const historicalUsdcQuote = lot({
    lotId: 'historical-usdc-quote',
    token: USDC,
    openedTxHash: historicalUsdcOpenTx,
    closedTxHash: historicalBuyTx,
    openedAt: 10,
    closedAt: 20,
    amount: 400,
    costBasisUsd: 400,
    proceedsUsd: 400,
    realizedPnlUsd: 0,
  })
  const independentUsdc = lot({
    lotId: 'usdc-independent',
    token: USDC,
    openedTxHash: independentOpenTx,
    closedTxHash: independentCloseTx,
    openedAt: 1,
    closedAt: 2,
    amount: 5000,
    costBasisUsd: 5000,
    proceedsUsd: 5000,
    realizedPnlUsd: 0,
  })
  const unpricedHistoricalRisk = lot({
    lotId: 'unpriced-historical-risk',
    token: TOKEN,
    openedTxHash: historicalBuyTx,
    closedTxHash: historicalSellTx,
    openedAt: 20,
    closedAt: 50,
    amount: 12,
    costBasisUsd: null,
    proceedsUsd: null,
    realizedPnlUsd: null,
    evidenceQuality: 'unpriced',
  })

  const fullHistoryEvents: NormalizedEvent[] = [
    event({ txHash: historicalUsdcOpenTx, contract: TOKEN, symbol: 'CLANKER', direction: 'outbound', fromAddress: WALLET, toAddress: SWAP_ROUTER02 }),
    event({ txHash: historicalUsdcOpenTx, contract: USDC, direction: 'inbound', fromAddress: SWAP_ROUTER02, toAddress: WALLET, amount: 400 }),
    event({ txHash: historicalBuyTx, contract: USDC, direction: 'outbound', fromAddress: WALLET, toAddress: SWAP_ROUTER02, amount: 400 }),
    event({ txHash: historicalBuyTx, contract: TOKEN, symbol: 'CLANKER', direction: 'inbound', fromAddress: SWAP_ROUTER02, toAddress: WALLET, amount: 12 }),
    event({ txHash: historicalSellTx, contract: TOKEN, symbol: 'CLANKER', direction: 'outbound', fromAddress: WALLET, toAddress: SWAP_ROUTER02, amount: 12 }),
    event({ txHash: historicalSellTx, contract: USDC, direction: 'inbound', fromAddress: SWAP_ROUTER02, toAddress: WALLET, amount: 400 }),
    event({ txHash: liveBuyTx, contract: USDC, direction: 'outbound', fromAddress: WALLET, toAddress: SWAP_ROUTER02, amount: 1000 }),
    event({ txHash: liveBuyTx, contract: TOKEN, symbol: 'CLANKER', direction: 'inbound', fromAddress: SWAP_ROUTER02, toAddress: WALLET, amount: 50 }),
    event({ txHash: liveSellTx, contract: TOKEN, symbol: 'CLANKER', direction: 'outbound', fromAddress: WALLET, toAddress: SWAP_ROUTER02, amount: 50 }),
    event({ txHash: liveSellTx, contract: USDC, direction: 'inbound', fromAddress: SWAP_ROUTER02, toAddress: WALLET, amount: 700 }),
    event({ txHash: independentOpenTx, contract: USDC, direction: 'inbound', fromAddress: EOA_A, toAddress: WALLET, amount: 5000 }),
    event({ txHash: independentCloseTx, contract: USDC, direction: 'outbound', fromAddress: WALLET, toAddress: EOA_B, amount: 5000 }),
  ]

  // Bounded window still has the USDC legs of the historical quote lot, but the TOKEN counterpart
  // events are gone and counterparties look like EOAs — the live 55-independent failure mode.
  const boundedEvents: NormalizedEvent[] = [
    event({ txHash: historicalUsdcOpenTx, contract: USDC, direction: 'inbound', fromAddress: EOA_A, toAddress: WALLET, amount: 400 }),
    event({ txHash: historicalBuyTx, contract: USDC, direction: 'outbound', fromAddress: WALLET, toAddress: EOA_B, amount: 400 }),
    event({ txHash: liveBuyTx, contract: USDC, direction: 'outbound', fromAddress: WALLET, toAddress: SWAP_ROUTER02, amount: 1000 }),
    event({ txHash: liveBuyTx, contract: TOKEN, symbol: 'CLANKER', direction: 'inbound', fromAddress: SWAP_ROUTER02, toAddress: WALLET, amount: 50 }),
    event({ txHash: liveSellTx, contract: TOKEN, symbol: 'CLANKER', direction: 'outbound', fromAddress: WALLET, toAddress: SWAP_ROUTER02, amount: 50 }),
    event({ txHash: liveSellTx, contract: USDC, direction: 'inbound', fromAddress: SWAP_ROUTER02, toAddress: WALLET, amount: 700 }),
    event({ txHash: independentOpenTx, contract: USDC, direction: 'inbound', fromAddress: EOA_A, toAddress: WALLET, amount: 5000 }),
    event({ txHash: independentCloseTx, contract: USDC, direction: 'outbound', fromAddress: WALLET, toAddress: EOA_B, amount: 5000 }),
  ]

  const verifiedLots = [publishedRisk, historicalUsdcQuote, independentUsdc]

  function jsonKv(): CanonicalSampleManifestKvLike & { raw: Map<string, string> } {
    const raw = new Map<string, string>()
    return {
      raw,
      get: async <T>(key: string) => (raw.has(key) ? (JSON.parse(raw.get(key)!) as T) : null),
      set: async (key: string, value: unknown) => { raw.set(key, JSON.stringify(value)); return 'OK' },
    }
  }

  function seedManifest(proofs?: PersistedRoiQuoteLegProof[]) {
    const identity = buildManifestIdentity({
      walletAddress: WALLET,
      chains: ['base'],
      configuredWindowDays: 90,
      matchedLotFingerprint: 'test-fingerprint',
    })
    const manifest: CanonicalPnlSampleManifest = {
      ...identity,
      lotIdentitySchemaVersion: CANONICAL_LOT_IDENTITY_SCHEMA_VERSION,
      manifestVersion: 1,
      priorManifestVersion: null,
      verifiedLotIdentityKeys: ['k1'],
      verifiedLotRecords: [],
      acceptedEvidenceIdentityKeys: [],
      verifiedLotIdentityFingerprint: 'id-fp',
      acceptedHistoricalPriceFingerprint: 'price-fp',
      realizedPnlFingerprint: 'pnl-fp',
      scanFingerprint: 'scan-fp',
      realizedPnlUsd: -70794.97,
      verifiedLotCount: 3,
      structuralLotCount: 4,
      verifiedPricingCoverage: 1,
      createdAt: 1,
      refreshedAt: 1,
      refreshReason: null,
      ...(proofs && proofs.length > 0 ? { roiQuoteLegProofs: proofs } : {}),
    }
    return { identity, manifest }
  }

  it('HARD ASSERTION: first/full-history scan proves quote identity; bounded rescan without counterpart events keeps the same ROI classification via persisted proof', async () => {
    const first = classifyVerifiedSampleRoiEligibility({
      verifiedLots,
      structuralLots: [...verifiedLots, unpricedHistoricalRisk],
      normalizedEvents: fullHistoryEvents,
    })
    const quoteRow = first.classifications.find((row) => row.lotKey === roiLotKey(historicalUsdcQuote))
    const independentRow = first.classifications.find((row) => row.lotKey === roiLotKey(independentUsdc))
    assert.equal(quoteRow?.roiDenominatorDisposition, 'exclude_quote_cash_leg')
    assert.equal(quoteRow?.reason, 'fifo_paired_quote_cash')
    assert.equal(independentRow?.roiDenominatorDisposition, 'include_economic_position')
    assert.equal(independentRow?.reason, 'independent_eoa_cex_or_mint')
    assert.equal(first.quoteCashLegLots.length, 1)
    assert.equal(first.unresolvedLots.length, 0)
    assert.equal(first.verifiedSampleRoiEligibleLots.length, 2)
    assert.equal(first.roiAvailable, true)
    assert.equal(first.realizedRoiCostBasisUsd, 6000)
    assert.equal(first.realizedRoiPnlUsd, -300)

    const liveProofs = liveRoiQuoteLegProofsToPersist(first)
    assert.equal(liveProofs.filter((proof) => proof.disposition === 'exclude_quote_cash_leg').length, 1)
    assert.equal(liveProofs.filter((proof) => proof.disposition === 'include_economic_position').length, 1)
    const quoteProof = liveProofs.find((proof) => proof.stableLotKey === roiLotKey(historicalUsdcQuote))
    assert.equal(quoteProof?.proofType, 'fifo_structural_lot')
    assert.ok(
      quoteProof?.pairedTxHash === historicalUsdcOpenTx || quoteProof?.pairedTxHash === historicalBuyTx,
      'pairedTxHash must be this lot open or close tx',
    )
    assert.equal(quoteProof?.methodologyVersion, ROI_QUOTE_LEG_PROOF_METHODOLOGY_VERSION)

    const kv = jsonKv()
    const { identity, manifest } = seedManifest()
    assert.equal(isValidCanonicalPnlSampleManifest(manifest, identity), true)
    await writeCanonicalPnlSampleManifest(kv, manifest)
    const persistResult = await persistRoiQuoteLegProofs(kv, identity, liveProofs)
    assert.equal(persistResult.wrote, true)
    assert.equal(persistResult.proofCount, 2)

    const reread = await readCanonicalPnlSampleManifest(kv, identity)
    assert.equal(reread.manifest?.verifiedLotIdentityFingerprint, 'id-fp', 'persist must not rewrite identity fingerprint')
    assert.equal(reread.manifest?.acceptedHistoricalPriceFingerprint, 'price-fp')
    assert.equal(reread.manifest?.realizedPnlFingerprint, 'pnl-fp')
    assert.equal(reread.manifest?.scanFingerprint, 'scan-fp')
    assert.equal(reread.manifest?.realizedPnlUsd, -70794.97, 'displayed sample PnL values stay frozen')
    assert.equal(reread.manifest?.verifiedLotCount, 3)
    assert.equal(reread.manifest?.roiQuoteLegProofs?.length, 2)

    const boundedWithoutProof = classifyVerifiedSampleRoiEligibility({
      verifiedLots,
      structuralLots: verifiedLots,
      normalizedEvents: boundedEvents,
    })
    const collapsed = boundedWithoutProof.classifications.find((row) => row.lotKey === roiLotKey(historicalUsdcQuote))
    assert.equal(collapsed?.roiDenominatorDisposition, 'include_economic_position', 'without proof the historical quote looks independent — the live 72→16 collapse')
    assert.equal(collapsed?.reason, 'independent_eoa_cex_or_mint')
    assert.equal(boundedWithoutProof.quoteCashLegLots.length, 0)
    assert.equal(boundedWithoutProof.verifiedSampleRoiEligibleLots.length, 3)

    const boundedWithProof = classifyVerifiedSampleRoiEligibility({
      verifiedLots,
      structuralLots: verifiedLots,
      normalizedEvents: boundedEvents,
      persistedProofs: reread.manifest?.roiQuoteLegProofs,
    })
    const replayedQuote = boundedWithProof.classifications.find((row) => row.lotKey === roiLotKey(historicalUsdcQuote))
    const replayedIndependent = boundedWithProof.classifications.find((row) => row.lotKey === roiLotKey(independentUsdc))
    assert.equal(replayedQuote?.roiDenominatorDisposition, 'exclude_quote_cash_leg')
    assert.equal(replayedQuote?.reason, 'persisted_quote_cash')
    assert.equal(replayedIndependent?.roiDenominatorDisposition, 'include_economic_position')
    assert.equal(boundedWithProof.quoteCashLegLots.length, first.quoteCashLegLots.length)
    assert.equal(boundedWithProof.unresolvedLots.length, first.unresolvedLots.length)
    assert.equal(boundedWithProof.verifiedSampleRoiEligibleLots.length, first.verifiedSampleRoiEligibleLots.length)
    assert.equal(boundedWithProof.roiAvailable, true)
    assert.equal(boundedWithProof.realizedRoiCostBasisUsd, first.realizedRoiCostBasisUsd)
    assert.equal(boundedWithProof.realizedRoiPnlUsd, first.realizedRoiPnlUsd)

    const boundedLiveProofs = liveRoiQuoteLegProofsToPersist(boundedWithProof)
    const rematch = mergeRoiQuoteLegProofs(reread.manifest!.roiQuoteLegProofs ?? [], boundedLiveProofs)
    assert.equal(rematch.filter((proof) => proof.disposition === 'exclude_quote_cash_leg').length, 1, 'stored quote is not overwritten by bounded independent-looking events')
  })

  it('HARD ASSERTION: stale or mismatched quote-leg proof is unresolved, never guessed into the denominator', () => {
    const staleTx: PersistedRoiQuoteLegProof = {
      stableLotKey: roiLotKey(historicalUsdcQuote),
      disposition: 'exclude_quote_cash_leg',
      pairedRiskToken: TOKEN,
      pairedTxHash: '0xnot-this-lots-open-or-close',
      proofType: 'fifo_structural_lot',
      methodologyVersion: ROI_QUOTE_LEG_PROOF_METHODOLOGY_VERSION,
    }
    const staleVersion: PersistedRoiQuoteLegProof = {
      ...staleTx,
      pairedTxHash: historicalBuyTx,
      methodologyVersion: ROI_QUOTE_LEG_PROOF_METHODOLOGY_VERSION + 1,
    }
    for (const proof of [staleTx, staleVersion]) {
      const result = classifyVerifiedSampleRoiEligibility({
        verifiedLots,
        structuralLots: verifiedLots,
        normalizedEvents: boundedEvents,
        persistedProofs: [proof],
      })
      const row = result.classifications.find((item) => item.lotKey === roiLotKey(historicalUsdcQuote))
      assert.equal(row?.roiDenominatorDisposition, 'unresolved')
      assert.equal(row?.reason, 'unresolved_stale_quote_leg_proof')
      assert.equal(row?.isIndependentStablecoinTrade, false)
      assert.equal(result.roiAvailable, false)
      assert.equal(result.realizedRoiCostBasisUsd, null)
    }
  })

  it('does not treat garbage roiQuoteLegProofs as a reason to reject the canonical manifest', () => {
    const { identity, manifest } = seedManifest()
    const withGarbage = { ...manifest, roiQuoteLegProofs: [{ not: 'a-proof' }, null, 12] }
    assert.equal(isValidCanonicalPnlSampleManifest(withGarbage, identity), true)
    assert.equal(sanitizeRoiQuoteLegProofs(withGarbage.roiQuoteLegProofs).length, 0)
  })

  it('HARD ASSERTION: production reconcile persists live proofs and bounded rescan replays the same ROI classification', async () => {
    const fullFifo: FifoOutput = {
      matchedLots: verifiedLots,
      unmatchedBuys: 0,
      unmatchedSells: 1,
      unmatchedBuyEvents: [],
      unmatchedSellEvents: [{
        chain: 'base',
        txHash: historicalSellTx,
        token: TOKEN,
        timestamp: 50,
        direction: 'outbound',
        amount: 12,
        fromAddress: WALLET,
        toAddress: SWAP_ROUTER02,
        amountRaw: '12000000000000000000',
      }],
      realizedPnlUsd: -300,
      unrealizedPnlUsd: 0,
      costBasisUsd: 6400,
      publicPnlStatus: 'unavailable',
      integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 },
      unrealizedPnlExcludedTokens: [],
      unrealizedReconciliation: emptyUnrealizedReconciliation(),
    }
    const pnlEngineResult = {
      realizedPnlUsd: -300,
      closedLots: [],
      winLossRate: { wins: 0, losses: 1, evaluated: 1, rate: 0 },
      chainBreakdown: [],
      confidenceBasis: { high: 3, medium: 0, low: 0, aggregate: 'high' as const },
      evidenceMissingCount: 0,
    }
    const coverage = {
      genuineUnmatchedBuys: 0,
      genuineUnmatchedSells: 1,
      windowBoundaryProven: false,
      boundedSampleWindowSafe: true,
      historyCoverageStatus: 'truncated' as const,
      scanWindowDays: 90,
    }

    const first = createPnlReconciliation({ logger: { warn() { /* silent */ } } })
    const firstSummary = await first.reconcile({
      fifoEngineResult: {
        ...fullFifo,
        matchedLots: [...verifiedLots, unpricedHistoricalRisk],
      },
      pnlEngineResult,
      syntheticPnlAssemblyOutput: null,
      normalizedEvents: fullHistoryEvents,
      structuralCoverageDenominatorAudit: coverage,
    })
    assert.equal(firstSummary.verifiedSamplePerformance.quoteCashLegExcludedLotCount, 1)
    assert.equal(firstSummary.verifiedSamplePerformance.unresolvedQuoteLegLotCount, 0)
    assert.equal(firstSummary.verifiedSamplePerformance.verifiedSampleRoiEligibleLotCount, 2)
    assert.ok((firstSummary.roiQuoteLegProofsToPersist ?? []).length >= 1)

    const kv = jsonKv()
    const { identity, manifest } = seedManifest()
    await writeCanonicalPnlSampleManifest(kv, manifest)
    await persistRoiQuoteLegProofs(kv, identity, firstSummary.roiQuoteLegProofsToPersist ?? [])
    const stored = await readCanonicalPnlSampleManifest(kv, identity)
    const persistedProofs = stored.manifest?.roiQuoteLegProofs ?? []
    assert.ok(persistedProofs.some((proof) => proof.disposition === 'exclude_quote_cash_leg'))

    const boundedFifo: FifoOutput = {
      ...fullFifo,
      matchedLots: verifiedLots,
      unmatchedSells: 0,
      unmatchedSellEvents: [],
    }
    const second = createPnlReconciliation({ logger: { warn() { /* silent */ } } })
    const secondSummary = await second.reconcile({
      fifoEngineResult: boundedFifo,
      pnlEngineResult,
      syntheticPnlAssemblyOutput: null,
      normalizedEvents: boundedEvents,
      structuralCoverageDenominatorAudit: { ...coverage, genuineUnmatchedSells: 0 },
      canonicalSampleSelector: async (lots) => ({
        publishedLots: [...lots],
        forcePublicPnlUnavailable: false,
        manifestApplied: true,
        roiQuoteLegProofs: persistedProofs,
      }),
    })
    assert.equal(secondSummary.verifiedSamplePerformance.quoteCashLegExcludedLotCount, 1)
    assert.equal(secondSummary.verifiedSamplePerformance.unresolvedQuoteLegLotCount, 0)
    assert.equal(secondSummary.verifiedSamplePerformance.verifiedSampleRoiEligibleLotCount, 2)
    assert.equal(secondSummary.verifiedSamplePerformance.realizedPnlUsd, firstSummary.verifiedSamplePerformance.realizedPnlUsd)
    assert.equal(secondSummary.verifiedSamplePerformance.realizedCostBasisUsd, firstSummary.verifiedSamplePerformance.realizedCostBasisUsd)
    assert.equal(secondSummary.verifiedSamplePerformance.roiUnavailableReason, null)
  })
})
