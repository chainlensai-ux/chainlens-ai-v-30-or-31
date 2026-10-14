// The WALLET_DEBUG funnel counts each stage correctly on a synthetic scan (no providers needed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWalletDebugFunnel, isWalletDebugEnabled } from './walletDebugFunnel'
import { normalizeEvents } from '../modules/normalization/index'
import { buildTimelines } from '../modules/timelineBuilder/index'
import { filterToFifoEligible } from '../modules/eventClassification/index'
import type { RawProviderEvent, ProviderFetchWindowResult } from '../modules/providerFetchWindow/types'
import type { ChainSelectionResult } from '../modules/chainSelection/types'
import type { FifoOutput } from '../modules/fifoEngine/types'

const W = '0x' + '1'.repeat(40)
const ROUTER = '0x' + '9'.repeat(40)
const POOL = '0x' + '8'.repeat(40)
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const TOKEN = '0x' + 'a'.repeat(40)
const raw = (tx: string, from: string, to: string, contract: string, amountRaw = '1000000'): RawProviderEvent => ({
  provider: 'alchemy', chain: 'base', txHash: tx, timestamp: '2026-10-01T00:00:00Z',
  fromAddress: from, toAddress: to, contract, symbol: 'T', amountRaw, tokenDecimals: 6,
})

const alchemyEvents = [
  raw('0xswap', W, POOL, USDC), raw('0xswap', POOL, W, TOKEN),   // paired buy (USDC → TOKEN)
  raw('0xsell', W, ROUTER, TOKEN),                                 // token → ETH sell: ETH leg invisible
  raw('0xdrop', '0x' + '7'.repeat(40), W, TOKEN),                  // inbound-only (airdrop/transfer)
  raw('0xzero', W, POOL, TOKEN, '0'),                              // dropped: zero amount
]
const providerResult = {
  chain: 'base', providerStatus: 'partial', rawEvents: alchemyEvents, providerFetchWindowDays: 90,
  providerResults: {
    goldrush: { provider: 'goldrush', ok: false, events: [], errorReason: 'provider_budget_exhausted' },
    alchemy: { provider: 'alchemy', ok: true, events: alchemyEvents, errorReason: null,
      pagination: { pagesRequested: 2, pagesSucceeded: 2, paginationExhausted: false, nextPageKeyPresent: true, providerCapReached: true } },
  },
} as unknown as ProviderFetchWindowResult
const chainSelection = { chains: [{ chain: 'base', status: 'active_intelligence', gates: { valueGate: true, activityGate: true, swapGate: true } }], activeChainCount: 1, dustChainCount: 0 } as unknown as ChainSelectionResult

test('isWalletDebugEnabled only for WALLET_DEBUG=1', () => {
  const prev = process.env.WALLET_DEBUG
  process.env.WALLET_DEBUG = '1'; assert.equal(isWalletDebugEnabled(), true)
  process.env.WALLET_DEBUG = 'true'; assert.equal(isWalletDebugEnabled(), false)
  delete process.env.WALLET_DEBUG; assert.equal(isWalletDebugEnabled(), false)
  if (prev !== undefined) process.env.WALLET_DEBUG = prev
})

test('funnel counts every stage and attributes drops', () => {
  const { normalizedEvents, normalizationErrors } = normalizeEvents(alchemyEvents, W)
  const timelines = buildTimelines(normalizedEvents, chainSelection)
  const ctx = { knownDexRouterAddresses: new Set([ROUTER]) }
  const fifo = { matchedLots: [], unmatchedBuys: 2, unmatchedSells: 1, unmatchedBuyEvents: [], unmatchedSellEvents: [],
    realizedPnlUsd: null, unrealizedPnlUsd: null, costBasisUsd: null, publicPnlStatus: 'unavailable',
    integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 },
    unrealizedPnlExcludedTokens: [], unrealizedReconciliation: {} } as unknown as FifoOutput
  const f = buildWalletDebugFunnel({
    walletAddress: W, windowDays: 90, providerResults: [providerResult], stabilizedRawEventCount: alchemyEvents.length,
    normalizedEvents, normalizationErrors, timelines, fifo, fifoEligibleEvents: filterToFifoEligible(normalizedEvents, ctx), classificationContext: ctx,
  })
  const alchemy = f.stage1_providers.find(p => p.provider === 'alchemy')!
  assert.equal(alchemy.pagination.stoppedBecause, 'page_cap_more_available')
  assert.deepEqual(alchemy.rawByDirection, { outbound: 3, inbound: 2, other: 0 })
  assert.equal(f.stage1_providers.find(p => p.provider === 'goldrush')!.budgetRefusals, 1)
  assert.deepEqual(f.stage3_normalization, { in: 5, out: 4, droppedByReason: { zero_amount: 1 } })
  assert.deepEqual(
    [f.stage5_txPairing.pairedSwapTxs, f.stage5_txPairing.inboundOnlyTxs, f.stage5_txPairing.outboundOnlyTxs, f.stage5_txPairing.outboundOnlyNativeQuoteInvisible],
    [1, 1, 1, 1])
  // Current behaviour, recorded as found: the USDC payment leg of the buy is counted as a "sell"
  // (outbound paired with a different inbound token), while the real token→ETH sell is not.
  assert.deepEqual([f.stage7_timelines.buyTimeline, f.stage7_timelines.sellTimeline, f.stage7_timelines.outboundNotSellShaped], [2, 1, 1])
  assert.deepEqual([f.dropReasons.one_legged, f.dropReasons.cost_gate, f.dropReasons.depth_limit, f.dropReasons.unmatched_sell_no_prior_buy], [1, 1, 1, 1])
})
