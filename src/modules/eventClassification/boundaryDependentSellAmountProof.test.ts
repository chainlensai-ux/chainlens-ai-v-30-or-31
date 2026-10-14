// TESTS — unmatched-sell reduction (audit section G).
// R1 shortfall routing, R2 prioritised fetch cap, R3 amount check, oldest-first capped page,
// unknown amounts, empty toAddress, cross-token / cross-chain / after-sell isolation, cumulative
// inventory, and historyCoverageStatus never flipped by per-sell proof.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NormalizedEvent } from '../normalization/types'
import type { UnmatchedEventIdentity } from '../fifoEngine/types'
import type { RawProviderEvent } from '../providerFetchWindow/types'
import type { AlchemyTokenHistoryStrictResult } from '../recoveryPolicy/utils'
import { buildLots, matchLotsFIFO } from '../fifoEngine/index'
import { classifyEvents, computeUnmatchedEvidenceAudit } from './index'
import {
  MAX_BOUNDARY_DEPENDENT_TOKEN_FETCHES,
  resolveBoundaryDependentSells,
  unmatchedSellProofKey,
  type PreResolverBucket,
  type TokenHistoryFetcher,
} from './boundaryDependentSellResolution'

const WALLET = '0x4dbb3835744b2976560e0259cb218cab89abef96'
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const DAY = 24 * 60 * 60 * 1000
const WINDOW_START = Date.parse('2026-06-14T00:00:00.000Z')
const PRE_WINDOW_TS = WINDOW_START - 7 * DAY
const IN_WINDOW_TS = WINDOW_START + 10 * DAY
const iso = (ts: number) => new Date(ts).toISOString()
const noRouters = { knownDexRouterAddresses: new Set<string>() }
const partialCtx = { windowStartTimestamp: WINDOW_START, scanWindowDays: 90, anyProviderFetchFailed: true, anyProviderAtEventCap: false }

let seq = 0
function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  seq += 1
  return {
    provider: 'alchemy', chain: 'base', txHash: `0xev${seq}`, timestamp: iso(IN_WINDOW_TS),
    fromAddress: WALLET, toAddress: '0xrouter', contract: TOKEN_A, symbol: 'TOK',
    amount: 5, amountRaw: '5000000', tokenDecimals: 6, direction: 'outbound',
    ...overrides,
  }
}
function sellId(overrides: Partial<UnmatchedEventIdentity> = {}): UnmatchedEventIdentity {
  return {
    chain: 'base', txHash: '0xsell1', token: TOKEN_A, timestamp: IN_WINDOW_TS, direction: 'outbound',
    amount: 5, fromAddress: WALLET, toAddress: '0xrouter', amountRaw: '5000000',
    unmatchedRaw: '5000000', sellRaw: '5000000',
    ...overrides,
  }
}
function rawIn(overrides: Partial<RawProviderEvent> = {}): RawProviderEvent {
  return {
    provider: 'alchemy', chain: 'base', txHash: '0xbuy-pre', timestamp: iso(PRE_WINDOW_TS),
    fromAddress: '0xother', toAddress: WALLET, contract: TOKEN_A, symbol: 'TOK', amountRaw: '5000000', tokenDecimals: 6,
    ...overrides,
  }
}
function history(overrides: Partial<AlchemyTokenHistoryStrictResult> = {}): AlchemyTokenHistoryStrictResult {
  // Default: both directions read to exhaustion, no outbound transfers (the wallet never sent the token).
  return {
    ok: true, inboundQueryOk: true, outboundQueryOk: true, events: [], inboundPageCapped: false, inboundPageExhausted: true, providerCalls: 2, order: 'asc',
    inboundStatus: 'complete', outboundStatus: 'empty', outboundEvents: [],
    ...overrides,
  }
}
const fetcherFor = (byToken: Record<string, AlchemyTokenHistoryStrictResult>, calls: string[] = []): TokenHistoryFetcher =>
  async (chain, _wallet, token) => { calls.push(`${chain}:${token.toLowerCase()}`); return byToken[token.toLowerCase()] ?? history() }

test('FIFO: unmatched sells carry unmatchedRaw (the uncovered remainder) and sellRaw (the full outbound), additively', () => {
  const buy = event({ txHash: '0xbuy', direction: 'inbound', fromAddress: '0xpool', toAddress: WALLET, amount: 3, amountRaw: '3000000', timestamp: iso(IN_WINDOW_TS - DAY) })
  const sell = event({ txHash: '0xsell', amount: 5, amountRaw: '5000000' })
  const result = matchLotsFIFO(buildLots([buy], []), [sell])
  assert.equal(result.unmatchedSellEvents.length, 1)
  const u = result.unmatchedSellEvents[0]!
  assert.deepEqual([u.unmatchedRaw, u.sellRaw, u.amountRaw, u.amount], ['2000000', '5000000', '5000000', 2])
})

test('R3: a 1-wei pre-window inbound no longer proves a 1,000,000-token exit (amount check, blocking)', async () => {
  const classified = classifyEvents([event({ txHash: '0xsell1', amount: 1_000_000, amountRaw: '1000000000000' })], noRouters)
  const sell = sellId({ amount: 1_000_000, amountRaw: '1000000000000', unmatchedRaw: '1000000000000', sellRaw: '1000000000000' })
  const r = await resolveBoundaryDependentSells({
    sells: [sell], classified, recoveredRawEvents: [rawIn({ amountRaw: '1' })],
    windowStartTimestamp: WINDOW_START, walletAddress: WALLET, fetchTokenHistory: fetcherFor({}),
  })
  const row = r.rows[0]!
  assert.equal(row.finalDisposition, 'pre_window_inventory_insufficient')
  assert.equal(row.gateImpact, 'blocking')
  assert.equal(row.preWindowAmountCheck, 'insufficient')
  assert.deepEqual([row.preWindowInboundRaw, row.requiredRaw], ['1', '1000000000000'])
  assert.deepEqual(r.provenPreWindowInventoryExits, [])
  const after = computeUnmatchedEvidenceAudit(classified, 0, [], [sell], { ...partialCtx, provenPreWindowInventoryExits: new Set(r.provenPreWindowInventoryExits) })
  assert.equal(after.structurallyInvalidOrUnknownSells, 1)
})

test('amount check: pre-window inbounds (local + provider, de-duplicated by tx+amount) minus pre-window outbounds must cover the sell', async () => {
  const classified = classifyEvents([event({ txHash: '0xsell1' })], noRouters)
  // Local raw inbound 3 + provider inbound 3 (the SAME transfer → counted once) + provider inbound 4 = 7;
  // a pre-window outbound of 1 leaves 6 ≥ 5 → covered.
  const local = [rawIn({ txHash: '0xin1', amountRaw: '3000000' }), { ...rawIn({ txHash: '0xout1', amountRaw: '1000000' }), fromAddress: WALLET, toAddress: '0xelse' }]
  const provider = history({ events: [rawIn({ txHash: '0xin1', amountRaw: '3000000' }), rawIn({ txHash: '0xin2', amountRaw: '4000000' })] })
  const r = await resolveBoundaryDependentSells({
    sells: [sellId()], classified, recoveredRawEvents: local,
    windowStartTimestamp: WINDOW_START, walletAddress: WALLET, fetchTokenHistory: fetcherFor({ [TOKEN_A]: provider }),
  })
  const row = r.rows[0]!
  assert.equal(row.finalDisposition, 'pre_window_inventory_exit_proven')
  assert.deepEqual([row.preWindowInboundRaw, row.preWindowOutboundRaw, row.preWindowAmountCheck], ['7000000', '1000000', 'covered'])

  // Without the de-duplication the same transfer would have counted twice (3+3 = 6 ≥ 5 even with no 0xin2).
  const dupOnly = await resolveBoundaryDependentSells({
    sells: [sellId()], classified, recoveredRawEvents: [rawIn({ txHash: '0xin1', amountRaw: '3000000' })],
    windowStartTimestamp: WINDOW_START, walletAddress: WALLET,
    fetchTokenHistory: fetcherFor({ [TOKEN_A]: history({ events: [rawIn({ txHash: '0xin1', amountRaw: '3000000' })] }) }),
  })
  assert.equal(dupOnly.rows[0]!.finalDisposition, 'pre_window_inventory_insufficient')
})

test('unknown amounts keep blocking: an unknown pre-window outbound or an unknown inbound that leaves a shortfall', async () => {
  const classified = classifyEvents([event({ txHash: '0xsell1' })], noRouters)
  const unknownOut = await resolveBoundaryDependentSells({
    sells: [sellId()], classified,
    recoveredRawEvents: [rawIn({ amountRaw: '9000000' }), { ...rawIn({ txHash: '0xout', amountRaw: null }), fromAddress: WALLET, toAddress: '0xelse' }],
    windowStartTimestamp: WINDOW_START, walletAddress: WALLET, fetchTokenHistory: fetcherFor({}),
  })
  assert.deepEqual([unknownOut.rows[0]!.preWindowAmountCheck, unknownOut.rows[0]!.gateImpact], ['unknown', 'blocking'])

  const unknownIn = await resolveBoundaryDependentSells({
    sells: [sellId()], classified, recoveredRawEvents: [rawIn({ amountRaw: null })],
    windowStartTimestamp: WINDOW_START, walletAddress: WALLET, fetchTokenHistory: fetcherFor({}),
  })
  assert.deepEqual([unknownIn.rows[0]!.preWindowAmountCheck, unknownIn.rows[0]!.gateImpact], ['unknown', 'blocking'])

  const unknownRequired = await resolveBoundaryDependentSells({
    sells: [sellId({ unmatchedRaw: undefined, sellRaw: undefined, amountRaw: null })], classified, recoveredRawEvents: [rawIn({ amountRaw: '9000000' })],
    windowStartTimestamp: WINDOW_START, walletAddress: WALLET, fetchTokenHistory: fetcherFor({}),
  })
  assert.deepEqual([unknownRequired.rows[0]!.preWindowAmountCheck, unknownRequired.rows[0]!.gateImpact], ['unknown', 'blocking'])
})

test('empty toAddress is no longer accepted as an inbound to this wallet', async () => {
  const sell = event({ txHash: '0xsell1' })
  const noTo = event({ txHash: '0xin-empty', direction: 'inbound', fromAddress: '0xother', toAddress: '', timestamp: iso(PRE_WINDOW_TS), amountRaw: '9000000', amount: 9 })
  const r = await resolveBoundaryDependentSells({
    sells: [sellId()], classified: classifyEvents([sell], noRouters), recoveredClassified: classifyEvents([noTo], noRouters),
    windowStartTimestamp: WINDOW_START, walletAddress: WALLET, fetchTokenHistory: fetcherFor({}),
  })
  assert.equal(r.rows[0]!.finalDisposition, 'genuine_unmatched_sell')
  assert.equal(r.rows[0]!.preWindowEvidenceFound, false)
})

test('never across tokens or chains, never an acquisition after the sell', async () => {
  const classified = classifyEvents([event({ txHash: '0xsell1' })], noRouters)
  const r = await resolveBoundaryDependentSells({
    sells: [sellId()], classified,
    recoveredRawEvents: [
      rawIn({ txHash: '0xother-token', contract: TOKEN_B, amountRaw: '9000000' }),
      rawIn({ txHash: '0xother-chain', chain: 'eth', amountRaw: '9000000' }),
      rawIn({ txHash: '0xafter', timestamp: iso(IN_WINDOW_TS + DAY), amountRaw: '9000000' }),
    ],
    windowStartTimestamp: WINDOW_START, walletAddress: WALLET,
    fetchTokenHistory: fetcherFor({ [TOKEN_A]: history({ events: [rawIn({ txHash: '0xprov-b', contract: TOKEN_B, amountRaw: '9000000' }), rawIn({ txHash: '0xprov-eth', chain: 'eth', amountRaw: '9000000' })] }) }),
  })
  assert.equal(r.rows[0]!.finalDisposition, 'genuine_unmatched_sell')
  assert.equal(r.rows[0]!.preWindowEvidenceFound, false)
})

test('cumulative inventory: two sells of the same token cannot both claim the same pre-window balance', async () => {
  const s1 = sellId({ txHash: '0xsell1', timestamp: IN_WINDOW_TS })
  // Different amounts: identical repeated amounts would be classified as a distribution.
  const s2 = sellId({ txHash: '0xsell2', timestamp: IN_WINDOW_TS + DAY, amount: 4, amountRaw: '4000000', unmatchedRaw: '4000000', sellRaw: '4000000' })
  const classified = classifyEvents([event({ txHash: '0xsell1' }), event({ txHash: '0xsell2', amount: 4, amountRaw: '4000000', timestamp: iso(IN_WINDOW_TS + DAY) })], noRouters)
  const r = await resolveBoundaryDependentSells({
    sells: [s2, s1], classified, recoveredRawEvents: [rawIn({ amountRaw: '6000000' })],
    windowStartTimestamp: WINDOW_START, walletAddress: WALLET, fetchTokenHistory: fetcherFor({}),
  })
  const byTx = new Map(r.rows.map((row) => [row.txHash, row]))
  assert.equal(byTx.get('0xsell1')!.finalDisposition, 'pre_window_inventory_exit_proven')
  assert.equal(byTx.get('0xsell2')!.finalDisposition, 'pre_window_inventory_insufficient')
  assert.equal(byTx.get('0xsell2')!.requiredRaw, '9000000')
  assert.deepEqual(r.rows.map((row) => row.txHash), ['0xsell2', '0xsell1'], 'rows keep the caller order')
})

test('oldest-first: a capped page that contains a pre-window inbound is conclusive; a capped page without one stays unresolved', async () => {
  const classified = classifyEvents([event({ txHash: '0xsell1' })], noRouters)
  const capped = history({ inboundPageCapped: true, inboundPageExhausted: false, events: [rawIn({ txHash: '0xoldest', amountRaw: '5000000' })] })
  const proven = await resolveBoundaryDependentSells({
    sells: [sellId()], classified, windowStartTimestamp: WINDOW_START, walletAddress: WALLET, fetchTokenHistory: fetcherFor({ [TOKEN_A]: capped }),
  })
  assert.deepEqual([proven.rows[0]!.finalDisposition, proven.rows[0]!.targetedRecoveryOutcome], ['pre_window_inventory_exit_proven', 'inbound_found'])

  const cappedNoPre = history({ inboundPageCapped: true, inboundPageExhausted: false, events: [rawIn({ txHash: '0xinwin', timestamp: iso(IN_WINDOW_TS - DAY) })] })
  const unresolved = await resolveBoundaryDependentSells({
    sells: [sellId()], classified, windowStartTimestamp: WINDOW_START, walletAddress: WALLET, fetchTokenHistory: fetcherFor({ [TOKEN_A]: cappedNoPre }),
  })
  assert.deepEqual([unresolved.rows[0]!.finalDisposition, unresolved.rows[0]!.targetedRecoveryOutcome], ['still_unresolved_boundary', 'page_capped'])
})

test('R2: the 8-token cap is prioritised by blocking-sell count, then unmatched raw, then address; skipped tokens are recorded', async () => {
  const tokens = Array.from({ length: 10 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`)
  const sells: UnmatchedEventIdentity[] = []
  const events: NormalizedEvent[] = []
  tokens.forEach((token, i) => {
    // token[9] has two blocking sells; token[8] has the largest single sell; tokens 0..7 are small.
    const count = i === 9 ? 2 : 1
    for (let k = 0; k < count; k += 1) {
      const tx = `0xs${i}-${k}`
      const raw = i === 8 ? '900000000' : String(1_000_000 + i * 10 + k)
      sells.push(sellId({ txHash: tx, token, amountRaw: raw, unmatchedRaw: raw, sellRaw: raw, timestamp: IN_WINDOW_TS + i * 1000 + k }))
      events.push(event({ txHash: tx, contract: token, amount: Number(raw) / 1e6, amountRaw: raw, timestamp: iso(IN_WINDOW_TS + i * 1000 + k) }))
    }
  })
  const calls: string[] = []
  const r = await resolveBoundaryDependentSells({
    sells, classified: classifyEvents(events, noRouters), windowStartTimestamp: WINDOW_START, walletAddress: WALLET, fetchTokenHistory: fetcherFor({}, calls),
  })
  assert.equal(calls.length, MAX_BOUNDARY_DEPENDENT_TOKEN_FETCHES)
  assert.equal(calls[0], `base:${tokens[9]}`, 'most blocking sells first')
  assert.equal(calls[1], `base:${tokens[8]}`, 'then largest unmatched raw')
  // The remaining six slots go to the largest raw of tokens 0..7 → tokens 7..2; tokens 1 and 0 are skipped.
  assert.deepEqual(r.tokensSkippedByFetchCap, [`base:${tokens[1]}`, `base:${tokens[0]}`])
  const skippedRows = r.rows.filter((row) => row.tokenSkippedByFetchCap)
  assert.deepEqual(skippedRows.map((row) => row.token).sort(), [tokens[0], tokens[1]].sort())
  assert.ok(skippedRows.every((row) => row.targetedRecoveryOutcome === 'not_attempted' && row.gateImpact === 'blocking'))
})

test('R1: a shortfall sell (earlier in-window buy) is resolved only by amount, via provenPreWindowShortfalls, and coverage status never flips', async () => {
  const buy = event({ txHash: '0xbuy-in', direction: 'inbound', fromAddress: '0xpool', toAddress: WALLET, amount: 3, amountRaw: '3000000', timestamp: iso(IN_WINDOW_TS - DAY) })
  const sell = event({ txHash: '0xsell1', amount: 5, amountRaw: '5000000' })
  const classified = classifyEvents([buy, sell], noRouters)
  const fifo = matchLotsFIFO(buildLots([buy], []), [sell])
  const shortfall = fifo.unmatchedSellEvents[0]!
  assert.equal(shortfall.unmatchedRaw, '2000000')

  const before = computeUnmatchedEvidenceAudit(classified, fifo.matchedLots.length, [], [shortfall], partialCtx)
  assert.deepEqual(before.boundaryProofDiagnostics.boundaryIndependentSells.map((s) => s.reason), ['earlier_buy_in_window'])
  const buckets = new Map<string, PreResolverBucket>([[unmatchedSellProofKey(shortfall), 'earlier_buy_in_window']])

  // 2 tokens of pre-window inventory cover the 2-token remainder (not the 5-token sell).
  const covered = await resolveBoundaryDependentSells({
    sells: [shortfall], classified, recoveredRawEvents: [rawIn({ amountRaw: '2000000' })], preResolverBuckets: buckets,
    windowStartTimestamp: WINDOW_START, walletAddress: WALLET, fetchTokenHistory: fetcherFor({}),
  })
  assert.deepEqual(covered.provenPreWindowShortfalls, [unmatchedSellProofKey(shortfall)])
  assert.deepEqual(covered.provenPreWindowInventoryExits, [])
  const after = computeUnmatchedEvidenceAudit(classified, fifo.matchedLots.length, [], [shortfall], {
    ...partialCtx, provenPreWindowShortfalls: new Set(covered.provenPreWindowShortfalls),
  })
  assert.equal(after.structurallyInvalidOrUnknownSells, 0)
  assert.equal(after.preWindowShortfallsProven, 1)
  assert.equal(after.historyCoverageStatus, before.historyCoverageStatus)
  assert.equal(after.windowBoundaryProven, false)

  // 1 token is not enough → stays earlier_buy_in_window and blocking.
  const short = await resolveBoundaryDependentSells({
    sells: [shortfall], classified, recoveredRawEvents: [rawIn({ amountRaw: '1000000' })], preResolverBuckets: buckets,
    windowStartTimestamp: WINDOW_START, walletAddress: WALLET, fetchTokenHistory: fetcherFor({}),
  })
  assert.equal(short.rows[0]!.finalDisposition, 'pre_window_inventory_insufficient')
  const stillBlocking = computeUnmatchedEvidenceAudit(classified, fifo.matchedLots.length, [], [shortfall], {
    ...partialCtx, provenPreWindowShortfalls: new Set(short.provenPreWindowShortfalls),
  })
  assert.equal(stillBlocking.structurallyInvalidOrUnknownSells, 1)
  assert.deepEqual(stillBlocking.boundaryProofDiagnostics.boundaryIndependentSells.map((s) => s.reason), ['earlier_buy_in_window'])

  // A shortfall proof is never accepted for a sell outside the shortfall bucket, and vice versa.
  const notShortfall = computeUnmatchedEvidenceAudit(classified, fifo.matchedLots.length, [], [shortfall], {
    ...partialCtx, provenPreWindowShortfalls: new Set(['base:0xnot-this:' + TOKEN_A]),
  })
  assert.equal(notShortfall.structurallyInvalidOrUnknownSells, 1)
})

test('receipt proof reaching the resolver: one-way transfer proof is non-trade; exact_swap stays blocking', async () => {
  const classified = classifyEvents([event({ txHash: '0xsell1' }), event({ txHash: '0xsell2', contract: TOKEN_B })], noRouters)
  const r = await resolveBoundaryDependentSells({
    sells: [sellId({ txHash: '0xsell1' }), sellId({ txHash: '0xsell2', token: TOKEN_B })], classified,
    receiptProofByTx: new Map([['0xsell1', 'one_way_transfer_only'], ['0xsell2', 'exact_swap']]),
    windowStartTimestamp: WINDOW_START, walletAddress: WALLET, fetchTokenHistory: fetcherFor({}),
  })
  const byTx = new Map(r.rows.map((row) => [row.txHash, row]))
  assert.equal(byTx.get('0xsell1')!.finalDisposition, 'non_trade_transfer_proven')
  assert.equal(byTx.get('0xsell2')!.finalDisposition, 'supported_swap_with_missing_pre_window_buy')
  assert.equal(byTx.get('0xsell2')!.gateImpact, 'blocking')
})

test('determinism: the same sells in a different order give identical rows (by identity) and identical proof sets', async () => {
  const sells = [sellId({ txHash: '0xsell1' }), sellId({ txHash: '0xsell2', timestamp: IN_WINDOW_TS + DAY }), sellId({ txHash: '0xsell3', token: TOKEN_B })]
  const classified = classifyEvents([
    event({ txHash: '0xsell1' }), event({ txHash: '0xsell2', timestamp: iso(IN_WINDOW_TS + DAY) }), event({ txHash: '0xsell3', contract: TOKEN_B }),
  ], noRouters)
  const run = (order: UnmatchedEventIdentity[]) => resolveBoundaryDependentSells({
    sells: order, classified, recoveredRawEvents: [rawIn({ amountRaw: '7000000' })],
    windowStartTimestamp: WINDOW_START, walletAddress: WALLET, fetchTokenHistory: fetcherFor({}),
  })
  const a = await run(sells)
  const b = await run([...sells].reverse())
  const byId = (rows: typeof a.rows) => [...rows].sort((x, y) => x.identity.localeCompare(y.identity))
  assert.deepEqual(byId(a.rows), byId(b.rows))
  assert.deepEqual([...a.provenPreWindowInventoryExits].sort(), [...b.provenPreWindowInventoryExits].sort())
  assert.deepEqual(a.tokensSkippedByFetchCap, b.tokensSkippedByFetchCap)
})
