// TESTS — boundary-dependent unmatched sells.
// (1) unmatched sell + earlier inbound outside window → pre-window, non-blocking
// (2) unmatched sell + no earlier inbound + complete history → genuine unmatched, blocking
// (3) provider timeout cannot resolve as no-history
// (4) global window-boundary requirement unchanged

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NormalizedEvent } from '../normalization/types'
import type { UnmatchedEventIdentity } from '../fifoEngine/types'
import type { RawProviderEvent } from '../providerFetchWindow/types'
import type { AlchemyTokenHistoryStrictResult } from '../recoveryPolicy/utils'
import { classifyEvents, computeUnmatchedEvidenceAudit } from './index'
import {
  resolveBoundaryDependentSells,
  unmatchedSellProofKey,
  type TokenHistoryFetcher,
} from './boundaryDependentSellResolution'

const WALLET = '0x4dbb3835744b2976560e0259cb218cab89abef96'
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const NOW_ISO = '2026-09-12T00:00:00.000Z'
const WINDOW_DAYS = 90
const WINDOW_START = Date.parse(NOW_ISO) - WINDOW_DAYS * 24 * 60 * 60 * 1000
const PRE_WINDOW_TS = WINDOW_START - 7 * 24 * 60 * 60 * 1000
const IN_WINDOW_TS = WINDOW_START + 10 * 24 * 60 * 60 * 1000
const noRouters = { knownDexRouterAddresses: new Set<string>() }

let seq = 0
function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  seq += 1
  return {
    provider: 'alchemy',
    chain: 'base',
    txHash: `0xtx${seq}`,
    timestamp: new Date(IN_WINDOW_TS).toISOString(),
    fromAddress: WALLET,
    toAddress: '0xrouter',
    contract: TOKEN_A,
    symbol: 'TOK',
    amount: 5,
    amountRaw: '5000000',
    tokenDecimals: 6,
    direction: 'outbound',
    ...overrides,
  }
}

function identity(overrides: Partial<UnmatchedEventIdentity> = {}): UnmatchedEventIdentity {
  return {
    chain: 'base',
    txHash: '0xsell1',
    token: TOKEN_A,
    timestamp: IN_WINDOW_TS,
    direction: 'outbound',
    amount: 5,
    fromAddress: WALLET,
    toAddress: '0xrouter',
    amountRaw: '5000000',
    ...overrides,
  }
}

function rawInbound(overrides: Partial<RawProviderEvent> = {}): RawProviderEvent {
  return {
    provider: 'alchemy',
    chain: 'base',
    txHash: '0xbuy1',
    timestamp: new Date(PRE_WINDOW_TS).toISOString(),
    fromAddress: '0xother',
    toAddress: WALLET,
    contract: TOKEN_A,
    symbol: 'TOK',
    amountRaw: '5000000',
    tokenDecimals: 6,
    ...overrides,
  }
}

function historyResult(overrides: Partial<AlchemyTokenHistoryStrictResult> = {}): AlchemyTokenHistoryStrictResult {
  return {
    ok: true,
    inboundQueryOk: true,
    outboundQueryOk: false,
    events: [],
    inboundPageCapped: false,
    inboundPageExhausted: true,
    providerCalls: 1,
    ...overrides,
  }
}

const partialCtx = {
  windowStartTimestamp: WINDOW_START,
  scanWindowDays: WINDOW_DAYS,
  anyProviderFetchFailed: true,
  anyProviderAtEventCap: false,
}

test('HARD ASSERTION (1): unmatched sell + earlier inbound outside the window is pre_window_inventory_exit_proven and non-blocking', async () => {
  const sell = event({ txHash: '0xsell-pre', direction: 'outbound', contract: TOKEN_A, fromAddress: WALLET, timestamp: new Date(IN_WINDOW_TS).toISOString() })
  const inbound = event({
    txHash: '0xbuy-pre', direction: 'inbound', contract: TOKEN_A, fromAddress: '0xother', toAddress: WALLET,
    timestamp: new Date(PRE_WINDOW_TS).toISOString(),
  })
  // Canonical classified set is the bounded window (the sell only). The earlier inbound is
  // recovered/pre-window evidence — the production shape, not an in-window buy.
  const classified = classifyEvents([sell], noRouters)
  const recoveredClassified = classifyEvents([inbound], noRouters)
  const sellId = identity({ txHash: '0xsell-pre', token: TOKEN_A, timestamp: IN_WINDOW_TS })
  const fetchCalls: string[] = []
  const fetchTokenHistory: TokenHistoryFetcher = async (chain, _wallet, token) => {
    fetchCalls.push(`${chain}:${token}`)
    return historyResult()
  }
  const resolution = await resolveBoundaryDependentSells({
    sells: [sellId],
    classified,
    recoveredClassified,
    windowStartTimestamp: WINDOW_START,
    walletAddress: WALLET,
    fetchTokenHistory,
  })
  assert.equal(resolution.rows.length, 1)
  assert.equal(resolution.rows[0]!.disposition, 'pre_window_inventory_exit_proven')
  assert.equal(resolution.rows[0]!.gateImpact, 'non_blocking')
  assert.equal(resolution.rows[0]!.preWindowEvidenceFound, true)
  assert.equal(resolution.rows[0]!.inboundTx, '0xbuy-pre')
  assert.equal(fetchCalls.length, 0, 'local inbound proof must not spend a provider call')

  const before = computeUnmatchedEvidenceAudit(classified, 98, [], [sellId], partialCtx)
  assert.equal(before.windowBoundaryProven, false)
  assert.equal(before.historyCoverageStatus, 'partial')
  assert.equal(before.unknownSells, 1)
  assert.equal(before.boundaryProofDiagnostics.sellsBlockedSolelyByUnprovenBoundary, 1)

  const after = computeUnmatchedEvidenceAudit(classified, 98, [], [sellId], {
    ...partialCtx,
    provenPreWindowInventoryExits: new Set(resolution.provenPreWindowInventoryExits),
  })
  assert.equal(after.windowBoundaryProven, false, 'per-sell proof must not flip the global boundary flag')
  assert.equal(after.historyCoverageStatus, 'partial')
  assert.equal(after.preWindowInventoryExits, 1)
  assert.equal(after.unknownSells, 0)
  assert.equal(after.structurallyInvalidOrUnknownSells, 0)
  assert.equal(after.boundaryProofDiagnostics.sellsBlockedSolelyByUnprovenBoundary, 0)
  assert.equal(after.structuralCoverageDenominator, 98)
})

test('HARD ASSERTION (2): unmatched sell + no earlier inbound + complete history is genuine_unmatched_sell and stays blocking', async () => {
  const sell = event({ txHash: '0xsell-none', direction: 'outbound', contract: TOKEN_A, fromAddress: WALLET })
  const classified = classifyEvents([sell], noRouters)
  const sellId = identity({ txHash: '0xsell-none', token: TOKEN_A })
  const resolution = await resolveBoundaryDependentSells({
    sells: [sellId],
    classified,
    windowStartTimestamp: WINDOW_START,
    walletAddress: WALLET,
    fetchTokenHistory: async () => historyResult({ events: [], inboundPageExhausted: true, inboundPageCapped: false }),
  })
  assert.equal(resolution.rows[0]!.disposition, 'genuine_unmatched_sell')
  assert.equal(resolution.rows[0]!.gateImpact, 'blocking')
  assert.equal(resolution.rows[0]!.preWindowEvidenceFound, false)

  const after = computeUnmatchedEvidenceAudit(classified, 98, [], [sellId], {
    ...partialCtx,
    provenGenuineUnmatchedSells: new Set(resolution.provenGenuineUnmatchedSells),
  })
  assert.equal(after.unknownSells, 1, 'genuine unmatched sells stay blocking')
  assert.equal(after.boundaryProofDiagnostics.sellsBlockedSolelyByUnprovenBoundary, 0, 'no longer attributed to the unproven boundary')
  assert.equal(after.windowBoundaryProven, false)
  assert.equal(after.structuralCoverageDenominator, 99)
  assert.equal(after.boundaryProofDiagnostics.boundaryIndependentSells[0]!.reason, 'genuine_unmatched_sell')
})

test('HARD ASSERTION (3): provider timeout cannot resolve as no-history', async () => {
  const sell = event({ txHash: '0xsell-to', direction: 'outbound', contract: TOKEN_A, fromAddress: WALLET })
  const classified = classifyEvents([sell], noRouters)
  const sellId = identity({ txHash: '0xsell-to', token: TOKEN_A })
  const resolution = await resolveBoundaryDependentSells({
    sells: [sellId],
    classified,
    windowStartTimestamp: WINDOW_START,
    walletAddress: WALLET,
    fetchTokenHistory: async () => historyResult({
      ok: false, inboundQueryOk: false, events: [], inboundPageExhausted: false, inboundPageCapped: false, providerCalls: 1,
    }),
  })
  assert.equal(resolution.rows[0]!.disposition, 'still_unresolved_boundary')
  assert.equal(resolution.rows[0]!.gateImpact, 'blocking')
  assert.notEqual(resolution.rows[0]!.disposition, 'genuine_unmatched_sell')
  assert.notEqual(resolution.rows[0]!.disposition, 'pre_window_inventory_exit_proven')
  assert.notEqual(resolution.rows[0]!.disposition, 'non_trade_transfer_proven')
  assert.equal(resolution.provenPreWindowInventoryExits.length, 0)
  assert.equal(resolution.provenGenuineUnmatchedSells.length, 0)

  const after = computeUnmatchedEvidenceAudit(classified, 98, [], [sellId], partialCtx)
  assert.equal(after.unknownSells, 1)
  assert.equal(after.boundaryProofDiagnostics.sellsBlockedSolelyByUnprovenBoundary, 1)
  assert.equal(after.windowBoundaryProven, false)
})

test('HARD ASSERTION (4): global window-boundary requirement is unchanged — partial coverage still fails closed without per-sell proofs', () => {
  const sellA = event({ txHash: '0xsell-a', direction: 'outbound', contract: TOKEN_A, fromAddress: WALLET })
  const sellB = event({ txHash: '0xsell-b', direction: 'outbound', contract: TOKEN_B, fromAddress: WALLET })
  const classified = classifyEvents([sellA, sellB], noRouters)
  const identities = [
    identity({ txHash: '0xsell-a', token: TOKEN_A }),
    identity({ txHash: '0xsell-b', token: TOKEN_B }),
  ]
  const audit = computeUnmatchedEvidenceAudit(classified, 98, [], identities, partialCtx)
  assert.equal(audit.historyCoverageStatus, 'partial')
  assert.equal(audit.windowBoundaryProven, false)
  assert.equal(audit.boundedSampleWindowSafe, false)
  assert.equal(audit.preWindowInventoryExits, 0)
  assert.equal(audit.unknownSells, 2)
  assert.equal(audit.boundaryProofDiagnostics.sellsBlockedSolelyByUnprovenBoundary, 2)
  assert.ok(audit.boundaryProofDiagnostics.boundaryRequiredSells.every((row) => row.reason === 'window_boundary_unproven'))
})

test('a proven pre-window exit for one token does not waive the boundary for a different unmatched sell', async () => {
  const sellA = event({ txHash: '0xsell-a2', direction: 'outbound', contract: TOKEN_A, fromAddress: WALLET })
  const sellB = event({ txHash: '0xsell-b2', direction: 'outbound', contract: TOKEN_B, fromAddress: WALLET })
  const inboundA = event({
    txHash: '0xbuy-a2', direction: 'inbound', contract: TOKEN_A, fromAddress: '0xother', toAddress: WALLET,
    timestamp: new Date(PRE_WINDOW_TS).toISOString(),
  })
  const classified = classifyEvents([inboundA, sellA, sellB], noRouters)
  const identities = [
    identity({ txHash: '0xsell-a2', token: TOKEN_A }),
    identity({ txHash: '0xsell-b2', token: TOKEN_B }),
  ]
  const resolution = await resolveBoundaryDependentSells({
    sells: identities,
    classified,
    windowStartTimestamp: WINDOW_START,
    walletAddress: WALLET,
    fetchTokenHistory: async () => historyResult({ ok: false, inboundQueryOk: false, inboundPageExhausted: false, providerCalls: 1 }),
  })
  assert.equal(resolution.rows.find((row) => row.token === TOKEN_A)!.disposition, 'pre_window_inventory_exit_proven')
  assert.equal(resolution.rows.find((row) => row.token === TOKEN_B)!.disposition, 'still_unresolved_boundary')

  const after = computeUnmatchedEvidenceAudit(classified, 98, [], identities, {
    ...partialCtx,
    provenPreWindowInventoryExits: new Set(resolution.provenPreWindowInventoryExits),
  })
  assert.equal(after.windowBoundaryProven, false)
  assert.equal(after.preWindowInventoryExits, 1)
  assert.equal(after.unknownSells, 1)
  assert.equal(after.boundaryProofDiagnostics.sellsBlockedSolelyByUnprovenBoundary, 1)
  assert.equal(after.structuralCoverageDenominator, 99)
})

test('plain_transfer_no_swap_event receipt proof is non_trade_transfer_proven — never inferred from a missing buy', async () => {
  const sell = event({ txHash: '0xsell-xfer', direction: 'outbound', contract: TOKEN_A, fromAddress: WALLET })
  const classified = classifyEvents([sell], noRouters)
  const sellId = identity({ txHash: '0xsell-xfer', token: TOKEN_A })
  const resolution = await resolveBoundaryDependentSells({
    sells: [sellId],
    classified,
    windowStartTimestamp: WINDOW_START,
    walletAddress: WALLET,
    receiptProofByTx: new Map([['0xsell-xfer', 'plain_transfer_no_swap_event']]),
    fetchTokenHistory: async () => {
      throw new Error('must not fetch when receipt already proves non-trade')
    },
  })
  assert.equal(resolution.rows[0]!.disposition, 'non_trade_transfer_proven')
  assert.equal(resolution.rows[0]!.gateImpact, 'non_blocking')
  assert.equal(resolution.rows[0]!.receiptProof, 'plain_transfer_no_swap_event')

  const after = computeUnmatchedEvidenceAudit(classified, 98, [], [sellId], {
    ...partialCtx,
    provenNonTradeTransfers: new Set(resolution.provenNonTradeTransfers),
  })
  assert.equal(after.unknownSells, 0)
  assert.equal(after.transferDistributionSells.ordinary_transfer, 1)
  assert.equal(after.boundaryProofDiagnostics.sellsBlockedSolelyByUnprovenBoundary, 0)
  assert.equal(after.windowBoundaryProven, false)
})

test('missing buy alone is never marked non-trade — complete empty history stays genuine_unmatched_sell', async () => {
  const sell = event({ txHash: '0xsell-nobuy', direction: 'outbound', contract: TOKEN_A, fromAddress: WALLET })
  const classified = classifyEvents([sell], noRouters)
  const sellId = identity({ txHash: '0xsell-nobuy', token: TOKEN_A })
  const resolution = await resolveBoundaryDependentSells({
    sells: [sellId],
    classified,
    windowStartTimestamp: WINDOW_START,
    walletAddress: WALLET,
    fetchTokenHistory: async () => historyResult({ events: [] }),
  })
  assert.equal(resolution.rows[0]!.disposition, 'genuine_unmatched_sell')
  assert.notEqual(resolution.rows[0]!.disposition, 'non_trade_transfer_proven')
})

test('capped inbound page with no pre-window hit stays still_unresolved_boundary — not treated as no history', async () => {
  const sell = event({ txHash: '0xsell-cap', direction: 'outbound', contract: TOKEN_A, fromAddress: WALLET })
  const classified = classifyEvents([sell], noRouters)
  const sellId = identity({ txHash: '0xsell-cap', token: TOKEN_A })
  const recentInbound = rawInbound({
    txHash: '0xrecent',
    timestamp: new Date(IN_WINDOW_TS - 1000).toISOString(),
  })
  const resolution = await resolveBoundaryDependentSells({
    sells: [sellId],
    classified,
    windowStartTimestamp: WINDOW_START,
    walletAddress: WALLET,
    fetchTokenHistory: async () => historyResult({
      events: [recentInbound],
      inboundPageCapped: true,
      inboundPageExhausted: false,
    }),
  })
  assert.equal(resolution.rows[0]!.disposition, 'still_unresolved_boundary')
  assert.equal(resolution.provenGenuineUnmatchedSells.length, 0)
})

test('recovered raw inbound before the window proves pre-window inventory without a provider call', async () => {
  const sell = event({ txHash: '0xsell-rec', direction: 'outbound', contract: TOKEN_A, fromAddress: WALLET })
  const classified = classifyEvents([sell], noRouters)
  const sellId = identity({ txHash: '0xsell-rec', token: TOKEN_A })
  const resolution = await resolveBoundaryDependentSells({
    sells: [sellId],
    classified,
    recoveredRawEvents: [rawInbound({ txHash: '0xrecovered-buy' })],
    windowStartTimestamp: WINDOW_START,
    walletAddress: WALLET,
    fetchTokenHistory: async () => {
      throw new Error('must not fetch when recovered history already proves the inbound')
    },
  })
  assert.equal(resolution.rows[0]!.disposition, 'pre_window_inventory_exit_proven')
  assert.equal(resolution.rows[0]!.inboundTx, '0xrecovered-buy')
  assert.equal(resolution.rows[0]!.inboundSource, 'recovered_raw')
})

test('exact_swap receipt + complete empty history is supported_swap_with_missing_pre_window_buy (blocking)', async () => {
  const sell = event({ txHash: '0xsell-swap', direction: 'outbound', contract: TOKEN_A, fromAddress: WALLET })
  const classified = classifyEvents([sell], noRouters)
  const sellId = identity({ txHash: '0xsell-swap', token: TOKEN_A })
  const resolution = await resolveBoundaryDependentSells({
    sells: [sellId],
    classified,
    windowStartTimestamp: WINDOW_START,
    walletAddress: WALLET,
    receiptProofByTx: new Map([['0xsell-swap', 'exact_swap']]),
    fetchTokenHistory: async () => historyResult({ events: [] }),
  })
  assert.equal(resolution.rows[0]!.disposition, 'supported_swap_with_missing_pre_window_buy')
  assert.equal(resolution.rows[0]!.gateImpact, 'blocking')
})

test('alchemy inbound before window start is accepted as pre-window proof', async () => {
  const sell = event({ txHash: '0xsell-alc', direction: 'outbound', contract: TOKEN_A, fromAddress: WALLET })
  const classified = classifyEvents([sell], noRouters)
  const sellId = identity({ txHash: '0xsell-alc', token: TOKEN_A })
  const resolution = await resolveBoundaryDependentSells({
    sells: [sellId],
    classified,
    windowStartTimestamp: WINDOW_START,
    walletAddress: WALLET,
    fetchTokenHistory: async () => historyResult({
      events: [rawInbound({ txHash: '0xalc-buy', timestamp: new Date(PRE_WINDOW_TS).toISOString() })],
    }),
  })
  assert.equal(resolution.rows[0]!.disposition, 'pre_window_inventory_exit_proven')
  assert.equal(resolution.rows[0]!.inboundSource, 'alchemy_inbound')
  assert.equal(resolution.providerCalls, 1)
})

test('unmatchedSellProofKey is chain:txHash:token lowercased', () => {
  assert.equal(
    unmatchedSellProofKey({ chain: 'base', txHash: '0xABC', token: '0xDEF' }),
    'base:0xabc:0xdef',
  )
})
