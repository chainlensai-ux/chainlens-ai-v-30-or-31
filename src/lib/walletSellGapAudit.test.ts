// Logging-only sell-gap audit: reasons must match the real sell timeline decision exactly.
//   npx tsx --test src/lib/walletSellGapAudit.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildReceiptSelectorSellAudit, buildSellGapAudit, shouldLogSellGap } from './walletSellGapAudit'
import { buildSellTimeline } from '../modules/sellTimeline/index'
import { completionSignalsByTxForAudit, selectBaseReceiptCandidates, type CandidateTxEvidence } from '../modules/receiptSwapDecoder/candidateSelector'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { ChainSelectionResult } from '../modules/chainSelection/types'
import { DEFAULT_RECOVERY_CAPS, DEFAULT_TRIGGER_RECOVERY_WHEN } from '../modules/recoveryPolicy/types'

const WALLET = '0xab5801a7d398351b8be11c439e05c5b3259aec9b'
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const POOL = '0xdddddddddddddddddddddddddddddddddddddddd'
const CHAIN_SELECTION: ChainSelectionResult = {
  chains: [{ chain: 'base', visible_value_usd: 1000, wallet_side_transactions: 10, swapCandidateEvents: 5, gates: { valueGate: true, activityGate: true, swapGate: true }, status: 'active_intelligence' }],
  activeChainCount: 1, dustChainCount: 0,
}
const ev = (o: Partial<NormalizedEvent>): NormalizedEvent => ({
  provider: 'alchemy', chain: 'base', txHash: '0x01', timestamp: '2026-01-01T00:00:00Z', fromAddress: WALLET, toAddress: POOL,
  contract: TOKEN_A, symbol: 'TOKA', amount: 100, amountRaw: '100', tokenDecimals: 0, direction: 'outbound', ...o,
})

const events: NormalizedEvent[] = [
  // token → ETH sell whose ETH proceeds are invisible: one-legged outbound to a pool
  ev({ txHash: '0x01' }),
  // buy paid in USDC: USDC out is the payment, TOKA in is the buy
  ev({ txHash: '0x02', contract: USDC_BASE, symbol: 'USDC' }),
  ev({ txHash: '0x02', direction: 'inbound', fromAddress: POOL, toAddress: WALLET }),
  // token → USDC sell: sell-shaped
  ev({ txHash: '0x03', contract: TOKEN_B, symbol: 'TOKB' }),
  ev({ txHash: '0x03', contract: USDC_BASE, symbol: 'USDC', direction: 'inbound', fromAddress: POOL, toAddress: WALLET }),
  // same token out and back in (refund) — not a sell
  ev({ txHash: '0x04' }),
  ev({ txHash: '0x04', direction: 'inbound', fromAddress: POOL, toAddress: WALLET, amount: 1 }),
  // ethereum is not an active chain here
  ev({ txHash: '0x05', chain: 'ethereum' as NormalizedEvent['chain'] }),
]

describe('buildSellGapAudit', () => {
  const ctx = { activeChains: new Set(['base']), knownDexRouterAddresses: new Set<string>(), verifiedSwapTxKeys: new Set<string>() }
  const audit = buildSellGapAudit({
    wallet: WALLET, buys: 83, sells: 0, normalizedEvents: events, ...ctx,
    providerResults: [{ chain: 'base', rawEvents: [
      { provider: 'goldrush', chain: 'base', txHash: '0x09', timestamp: '2026-01-01T00:00:00Z', fromAddress: '0x1111111111111111111111111111111111111111', toAddress: '0x2222222222222222222222222222222222222222', contract: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', symbol: 'ETH', amountRaw: '5', tokenDecimals: 18 },
      { provider: 'alchemy', chain: 'base', txHash: '0x01', timestamp: '2026-01-01T00:00:00Z', fromAddress: WALLET, toAddress: POOL, contract: TOKEN_A, symbol: 'TOKA', amountRaw: '100', tokenDecimals: 0 },
    ], alchemyNativeHistory: { events: 0, calls: 1, failedCalls: 1, moreAvailable: false, lastError: 'internal: unsupported' } }],
    persistedDrops: [{ chain: 'base', eventsDropped: [{ txHash: '0x09', reason: 'wallet_not_party', fromAddress: '0x1111111111111111111111111111111111111111', toAddress: '0x2222222222222222222222222222222222222222', originalProvider: 'goldrush' }, { txHash: '0x0a', reason: 'outside_window' }] }],
  })

  it('gives one reason per outbound non-sell', () => {
    assert.deepEqual(audit.outboundNonSellByReason, { no_inbound_in_tx: 1, buy_payment_leg: 1, inbound_same_token_only: 1, chain_inactive: 1 })
    assert.equal(audit.outboundSellDecisions, 1)
  })
  it('agrees with the real sell timeline on which outbound events are sells', () => {
    const real = buildSellTimeline({ normalizedEvents: events, chainSelection: CHAIN_SELECTION, bridgeTimeline: [], recoveryPolicy: { triggerRecoveryWhen: DEFAULT_TRIGGER_RECOVERY_WHEN, caps: DEFAULT_RECOVERY_CAPS, evaluation: [], totalPagesUsedThisWallet: 0 }, walletAddress: WALLET, ...ctx })
    assert.equal(real.totalSells, audit.outboundSellDecisions)
  })
  it('reports wallet-not-party raw events with provider, from and to', () => {
    assert.deepEqual(audit.walletNotPartyFreshByProvider, { 'base:goldrush:native': 1 })
    assert.equal(audit.walletNotPartyPersistedDrops.length, 1)
    assert.equal(audit.walletNotPartyPersistedDrops[0].originalProvider, 'goldrush')
    assert.equal(audit.alchemyNativeHistoryByChain.base?.lastError, 'internal: unsupported')
  })
  it('logs only for a sell gap', () => {
    assert.equal(shouldLogSellGap(83, 0), true)
    assert.equal(shouldLogSellGap(10, 5), false)
    assert.equal(shouldLogSellGap(0, 0), false)
  })
})

describe('buildReceiptSelectorSellAudit', () => {
  const base = (o: Partial<CandidateTxEvidence>): CandidateTxEvidence => ({
    chain: 'base', txHash: '0x01', legs: [{ contract: TOKEN_A, direction: 'outbound', amount: 1 }], walletInvolved: true,
    isKnownRouter: false, routerConfidence: null, routerOrCounterpartyAddress: POOL, hasVerifiedQuoteAddress: false,
    isExistingSwapCandidate: false, isBridgeCandidate: false, isLpStakingOrBurn: false, missingClosedLotSide: null,
    economicValueUsd: null, hasPriorBuyInventory: false, isUnmatchedOutboundExit: true, ...o,
  })
  const evidence = [
    base({ txHash: '0x01' }),
    base({ txHash: '0x02' }),
    base({ txHash: '0x03', chain: 'ethereum' }),
    base({ txHash: '0x04', legs: [{ contract: TOKEN_A, direction: 'inbound', amount: 1 }], isUnmatchedOutboundExit: false, missingClosedLotSide: 'entry', hasVerifiedQuoteAddress: true }),
  ]
  const selection = selectBaseReceiptCandidates(evidence)
  const audit = buildReceiptSelectorSellAudit({
    evidence, selection, strictSignalsByTx: completionSignalsByTxForAudit(evidence),
    fetchedTxHashes: new Set(['0x01']), exactSwapTxHashes: new Set(), proofByTxHash: new Map([['0x01', 'ordinary_transfer']]), receiptsFetched: 1,
  })
  it('counts non-Base evidence as unsupported_chain, including would-be sells', () => {
    assert.equal(audit.selectorReasonCounts.unsupported_chain, 1)
    assert.equal(audit.evidenceByChain.ethereum.outboundExit, 1)
  })
  it('shows one-sided outbound exits are selected even without strong signals, and what the receipt said', () => {
    assert.equal(audit.baseOutboundExitCandidates.total, 2)
    assert.equal(audit.baseOutboundExitCandidates.selected, 2)
    assert.equal(audit.baseOutboundExitCandidates.receiptFetched, 1)
    assert.equal(audit.baseOutboundExitCandidates.samples[0].receiptOutcome, 'ordinary_transfer')
  })
  it('a single-weak-signal candidate is reported with its side', () => {
    assert.equal(audit.tier1SingleWeakSignal.bySide.entry, 1)
    assert.equal(audit.tier1SingleWeakSignal.bySide.exit, 0)
  })
})
