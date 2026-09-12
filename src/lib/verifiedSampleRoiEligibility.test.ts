// Tests for src/lib/verifiedSampleRoiEligibility.ts — ROI denominator quote/cash membership.
//
// Run with:
//   npx tsx --test src/lib/verifiedSampleRoiEligibility.test.ts
//   npx tsx --test src/lib/pnlReconciliation.test.ts

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MatchedLot } from '../modules/fifoEngine/types'
import type { NormalizedEvent } from '../modules/normalization/types'
import { computeVerifiedSampleAndFullHistoryPerformance } from './pnlReconciliation'
import { classifyVerifiedSampleRoiEligibility, roiLotKey } from './verifiedSampleRoiEligibility'

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
})
