// TESTS — historical OUTBOUND recovery for the pre-window inventory proof.
// Inventory before the window = pre-window inbounds − pre-window outbounds, and it may only prove a
// sell when every outbound before the window start has actually been read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NormalizedEvent } from '../normalization/types'
import type { UnmatchedEventIdentity } from '../fifoEngine/types'
import type { AlchemyTokenHistoryStrictResult, StrictTransferEvent } from '../recoveryPolicy/utils'
import { classifyEvents, computeUnmatchedEvidenceAudit } from './index'
import { resolveBoundaryDependentSells, MAX_BOUNDARY_DEPENDENT_TOKEN_FETCHES, type TokenHistoryFetcher } from './boundaryDependentSellResolution'

const WALLET = '0x4dbb3835744b2976560e0259cb218cab89abef96'
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const DAY = 86_400_000
const WS = Date.parse('2026-06-14T00:00:00.000Z')
const PRE = WS - 30 * DAY
const IN = WS + 10 * DAY
const iso = (ts: number) => new Date(ts).toISOString()
const noRouters = { knownDexRouterAddresses: new Set<string>() }
const ctx = { windowStartTimestamp: WS, scanWindowDays: 90, anyProviderFetchFailed: true, anyProviderAtEventCap: false }

function sellEvent(o: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'alchemy', chain: 'base', txHash: '0xsell', timestamp: iso(IN), fromAddress: WALLET, toAddress: '0xpool',
    contract: A, symbol: 'T', amount: 5, amountRaw: '5000000', tokenDecimals: 6, direction: 'outbound', ...o,
  }
}
function sellId(o: Partial<UnmatchedEventIdentity> = {}): UnmatchedEventIdentity {
  return {
    chain: 'base', txHash: '0xsell', token: A, timestamp: IN, direction: 'outbound', amount: 5,
    fromAddress: WALLET, toAddress: '0xpool', amountRaw: '5000000', unmatchedRaw: '5000000', sellRaw: '5000000', ...o,
  }
}
let n = 0
function xfer(dir: 'in' | 'out', raw: string, ts: number, o: Partial<StrictTransferEvent> = {}): StrictTransferEvent {
  n += 1
  return {
    provider: 'alchemy', chain: 'base', txHash: `0x${dir}${n}`, timestamp: iso(ts),
    fromAddress: dir === 'in' ? '0xcounterparty' : WALLET, toAddress: dir === 'in' ? WALLET : '0xcounterparty',
    contract: A, symbol: 'T', amountRaw: raw, tokenDecimals: 6, blockNumber: null, logIndex: null, uniqueId: null, ...o,
  }
}
function hist(o: Partial<AlchemyTokenHistoryStrictResult> = {}): AlchemyTokenHistoryStrictResult {
  return {
    ok: true, inboundQueryOk: true, outboundQueryOk: true, events: [], inboundPageCapped: false, inboundPageExhausted: true,
    providerCalls: 2, order: 'asc', inboundStatus: 'complete', outboundStatus: 'complete', outboundEvents: [], ...o,
  }
}
const fixed = (h: AlchemyTokenHistoryStrictResult): TokenHistoryFetcher => async () => h
async function resolve(h: AlchemyTokenHistoryStrictResult, sells = [sellId()], events = [sellEvent()]) {
  return resolveBoundaryDependentSells({
    sells, classified: classifyEvents(events, noRouters), windowStartTimestamp: WS, walletAddress: WALLET, fetchTokenHistory: fixed(h),
  })
}

test('1. historical inbound followed by an outbound before the window: tokens that already left cannot cover the sell', async () => {
  const r = await resolve(hist({ events: [xfer('in', '10000000', PRE)], outboundEvents: [xfer('out', '10000000', PRE + DAY)] }))
  const row = r.rows[0]!
  assert.deepEqual([row.finalDisposition, row.gateImpact], ['pre_window_inventory_insufficient', 'blocking'])
  assert.deepEqual([row.preWindowInboundRaw, row.preWindowOutboundRaw, row.requiredRaw], ['10000000', '10000000', '5000000'])
})

test('2. historical inbound, exhausted outbound history with no pre-window outbound, enough inventory: proven', async () => {
  const r = await resolve(hist({ events: [xfer('in', '10000000', PRE)], outboundStatus: 'empty' }))
  const row = r.rows[0]!
  assert.deepEqual([row.finalDisposition, row.preWindowAmountCheck, row.outboundCoversPreWindow, row.preWindowOutboundRaw], ['pre_window_inventory_exit_proven', 'covered', true, '0'])
})

test('3. historical inbound smaller than the sell: insufficient', async () => {
  const r = await resolve(hist({ events: [xfer('in', '4999999', PRE)] }))
  assert.deepEqual([r.rows[0]!.finalDisposition, r.rows[0]!.preWindowAmountCheck], ['pre_window_inventory_insufficient', 'insufficient'])
})

test('4. two sells compete for the same historical inventory: the earlier consumes first', async () => {
  const s1 = sellId({ txHash: '0xs1' })
  const s2 = sellId({ txHash: '0xs2', timestamp: IN + DAY, amount: 4, amountRaw: '4000000', unmatchedRaw: '4000000', sellRaw: '4000000' })
  const r = await resolve(hist({ events: [xfer('in', '12000000', PRE)], outboundEvents: [xfer('out', '3000000', PRE + DAY)] }),
    [s2, s1], [sellEvent({ txHash: '0xs1' }), sellEvent({ txHash: '0xs2', timestamp: iso(IN + DAY), amount: 4, amountRaw: '4000000' })])
  const byTx = Object.fromEntries(r.rows.map((row) => [row.txHash, row]))
  // Net 12 − 3 = 9: s1 needs 5 (covered), s2 needs 5 + 4 = 9 (covered exactly).
  assert.deepEqual([byTx['0xs1']!.finalDisposition, byTx['0xs2']!.finalDisposition, byTx['0xs2']!.requiredRaw], ['pre_window_inventory_exit_proven', 'pre_window_inventory_exit_proven', '9000000'])
  const tighter = await resolve(hist({ events: [xfer('in', '12000000', PRE)], outboundEvents: [xfer('out', '3000001', PRE + DAY)] }),
    [s2, s1], [sellEvent({ txHash: '0xs1' }), sellEvent({ txHash: '0xs2', timestamp: iso(IN + DAY), amount: 4, amountRaw: '4000000' })])
  const t = Object.fromEntries(tighter.rows.map((row) => [row.txHash, row.finalDisposition]))
  assert.deepEqual(t, { '0xs1': 'pre_window_inventory_exit_proven', '0xs2': 'pre_window_inventory_insufficient' })
})

test('5. identical-amount transfers in ONE tx are distinct when the provider gives distinct log positions', async () => {
  const twoIn = [xfer('in', '3000000', PRE, { txHash: '0xdup', blockNumber: 10, logIndex: 1, uniqueId: '0xdup:log:1' }), xfer('in', '3000000', PRE, { txHash: '0xdup', blockNumber: 10, logIndex: 2, uniqueId: '0xdup:log:2' })]
  const covered = await resolve(hist({ events: twoIn }))
  assert.deepEqual([covered.rows[0]!.preWindowInboundRaw, covered.rows[0]!.finalDisposition], ['6000000', 'pre_window_inventory_exit_proven'])
  // The same on the outbound side: two equal outbounds in one tx both leave the wallet.
  const twoOut = [xfer('out', '2000000', PRE + DAY, { txHash: '0xdupout', blockNumber: 11, logIndex: 4 }), xfer('out', '2000000', PRE + DAY, { txHash: '0xdupout', blockNumber: 11, logIndex: 5 })]
  const drained = await resolve(hist({ events: [xfer('in', '8000000', PRE)], outboundEvents: twoOut }))
  assert.deepEqual([drained.rows[0]!.preWindowOutboundRaw, drained.rows[0]!.finalDisposition], ['4000000', 'pre_window_inventory_insufficient'])
})

test('5b. without positions, sources that disagree on a duplicate count are ambiguous and resolved conservatively', async () => {
  // Local recovered data reports two equal outbounds in one tx; the provider row has no log identity
  // and reports one. Outbound side keeps the larger count and the group is flagged.
  const recovered = [
    { provider: 'alchemy' as const, chain: 'base' as const, txHash: '0xamb', timestamp: iso(PRE + DAY), fromAddress: WALLET, toAddress: '0xc', contract: A, symbol: 'T', amountRaw: '3000000', tokenDecimals: 6 },
    { provider: 'alchemy' as const, chain: 'base' as const, txHash: '0xamb', timestamp: iso(PRE + DAY), fromAddress: WALLET, toAddress: '0xc', contract: A, symbol: 'T', amountRaw: '3000000', tokenDecimals: 6 },
  ]
  const r = await resolveBoundaryDependentSells({
    sells: [sellId()], classified: classifyEvents([sellEvent()], noRouters), recoveredRawEvents: recovered,
    windowStartTimestamp: WS, walletAddress: WALLET,
    fetchTokenHistory: fixed(hist({ events: [xfer('in', '10000000', PRE)], outboundEvents: [xfer('out', '3000000', PRE + DAY, { txHash: '0xamb' })] })),
  })
  const row = r.rows[0]!
  assert.deepEqual([row.preWindowOutboundRaw, row.ambiguousDuplicateGroups, row.finalDisposition], ['6000000', 1, 'pre_window_inventory_insufficient'])
})

test('6. only outbounds BEFORE the window are subtracted; outbounds after the target sell never are', async () => {
  const r = await resolve(hist({
    events: [xfer('in', '10000000', PRE)],
    outboundEvents: [xfer('out', '4000000', PRE + DAY), xfer('out', '9000000', IN + 5 * DAY)],
  }))
  assert.deepEqual([r.rows[0]!.preWindowOutboundRaw, r.rows[0]!.finalDisposition], ['4000000', 'pre_window_inventory_exit_proven'])
})

test('7. same-block events: log position decides whether an outbound came before the sell (as-of-sell ledger check)', async () => {
  const sellLog = { txHash: '0xsell', blockNumber: 500, logIndex: 7, uniqueId: '0xsell:log:7' }
  const base = { events: [xfer('in', '5000000', PRE, { blockNumber: 100, logIndex: 0 })], inboundStatus: 'complete' as const, outboundStatus: 'complete' as const }
  // An in-window outbound of 2 in the SAME block, earlier log: only 3 left when the 5-token sell ran.
  const before = await resolve(hist({ ...base, outboundEvents: [xfer('out', '5000000', IN, sellLog), xfer('out', '2000000', IN, { blockNumber: 500, logIndex: 3 })] }))
  assert.deepEqual([before.rows[0]!.ledgerCheck, before.rows[0]!.preWindowAmountBlocker, before.rows[0]!.gateImpact], ['inconsistent', 'ledger_inconsistent', 'blocking'])
  // Same outbound at a LATER log index in that block: it happened after the sell.
  const after = await resolve(hist({ ...base, outboundEvents: [xfer('out', '5000000', IN, sellLog), xfer('out', '2000000', IN, { blockNumber: 500, logIndex: 9 })] }))
  assert.deepEqual([after.rows[0]!.ledgerCheck, after.rows[0]!.finalDisposition], ['passed', 'pre_window_inventory_exit_proven'])
})

test('9. a capped outbound page that stops before the window start leaves the sell blocking', async () => {
  const r = await resolve(hist({
    events: [xfer('in', '10000000', PRE)], outboundStatus: 'capped', outboundCoveredUntil: PRE + DAY,
    outboundEvents: [xfer('out', '1000000', PRE + DAY)],
  }))
  const row = r.rows[0]!
  assert.deepEqual([row.finalDisposition, row.targetedRecoveryOutcome, row.preWindowAmountBlocker, row.outboundCoversPreWindow], ['still_unresolved_boundary', 'outbound_history_incomplete', 'outbound_history_incomplete', false])
  // The same capped status whose oldest-first pages already reached past the window start is complete for it.
  const reached = await resolve(hist({ events: [xfer('in', '10000000', PRE)], outboundStatus: 'capped', outboundCoveredUntil: WS + DAY, outboundEvents: [xfer('out', '1000000', WS + DAY)] }))
  assert.deepEqual([reached.rows[0]!.outboundCoversPreWindow, reached.rows[0]!.finalDisposition], [true, 'pre_window_inventory_exit_proven'])
  // A newest-first (desc) capped page never proves anything about older outbounds.
  const desc = await resolve(hist({ order: 'desc', events: [xfer('in', '10000000', PRE)], outboundStatus: 'capped', outboundCoveredUntil: WS + DAY }))
  assert.equal(desc.rows[0]!.gateImpact, 'blocking')
})

test('10. outbound query failure while the inbound query succeeds: blocking, never "no outbound"', async () => {
  const r = await resolve(hist({ events: [xfer('in', '10000000', PRE)], outboundStatus: 'failed', outboundQueryOk: false, outboundEvents: [] }))
  assert.deepEqual([r.rows[0]!.finalDisposition, r.rows[0]!.outboundHistoryStatus, r.rows[0]!.gateImpact], ['still_unresolved_boundary', 'failed', 'blocking'])
})

test('11. empty but successfully exhausted outbound history proves no outflow', async () => {
  const r = await resolve(hist({ events: [xfer('in', '5000000', PRE)], outboundStatus: 'empty', outboundEvents: [] }))
  assert.deepEqual([r.rows[0]!.finalDisposition, r.rows[0]!.outboundHistoryStatus], ['pre_window_inventory_exit_proven', 'empty'])
})

test('12. unsupported chain / legacy inbound-only history: outbound unknown, sell stays blocking', async () => {
  for (const o of [{ outboundStatus: 'unsupported' as const }, { outboundStatus: undefined, outboundQueryOk: false, outboundEvents: undefined }, { outboundStatus: 'not_requested' as const }]) {
    const r = await resolve(hist({ events: [xfer('in', '10000000', PRE)], ...o }))
    assert.deepEqual([r.rows[0]!.finalDisposition, r.rows[0]!.gateImpact], ['still_unresolved_boundary', 'blocking'], JSON.stringify(o))
  }
})

test('13. budget exhaustion and fetch-cap skips keep sells blocking', async () => {
  const r = await resolve(hist({ events: [xfer('in', '10000000', PRE)], outboundStatus: 'budget_exhausted', outboundQueryOk: false }))
  assert.deepEqual([r.rows[0]!.finalDisposition, r.rows[0]!.outboundHistoryStatus], ['still_unresolved_boundary', 'budget_exhausted'])

  // More tokens than the cap: skipped tokens are never fetched and never proven, even with local evidence.
  const tokens = Array.from({ length: MAX_BOUNDARY_DEPENDENT_TOKEN_FETCHES + 1 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`)
  const sells = tokens.map((token, i) => sellId({ txHash: `0xs${i}`, token, timestamp: IN + i, amountRaw: String(5_000_000 + i), unmatchedRaw: String(5_000_000 + i), sellRaw: String(5_000_000 + i) }))
  const events = tokens.map((token, i) => sellEvent({ txHash: `0xs${i}`, contract: token, timestamp: iso(IN + i), amount: (5_000_000 + i) / 1e6, amountRaw: String(5_000_000 + i) }))
  const recovered = tokens.map((token) => ({ provider: 'alchemy' as const, chain: 'base' as const, txHash: `0xpre-${token}`, timestamp: iso(PRE), fromAddress: '0xc', toAddress: WALLET, contract: token, symbol: 'T', amountRaw: '99000000', tokenDecimals: 6 }))
  const capped = await resolveBoundaryDependentSells({
    sells, classified: classifyEvents(events, noRouters), recoveredRawEvents: recovered, windowStartTimestamp: WS, walletAddress: WALLET,
    fetchTokenHistory: fixed(hist({ outboundStatus: 'empty' })),
  })
  assert.equal(capped.tokensSkippedByFetchCap.length, 1)
  const skipped = capped.rows.find((row) => row.tokenSkippedByFetchCap)!
  assert.deepEqual([skipped.finalDisposition, skipped.targetedRecoveryOutcome, skipped.gateImpact], ['still_unresolved_boundary', 'not_attempted', 'blocking'])
  assert.equal(capped.rows.filter((row) => row.finalDisposition === 'pre_window_inventory_exit_proven').length, MAX_BOUNDARY_DEPENDENT_TOKEN_FETCHES)
})

test('14. deterministic under shuffled input order (sells, events and provider pages)', async () => {
  const s1 = sellId({ txHash: '0xs1' })
  const s2 = sellId({ txHash: '0xs2', token: B })
  const evs = [sellEvent({ txHash: '0xs1' }), sellEvent({ txHash: '0xs2', contract: B })]
  const ins = [xfer('in', '6000000', PRE), xfer('in', '6000000', PRE, { contract: B }), xfer('in', '1000000', PRE - DAY)]
  const outs = [xfer('out', '2000000', PRE + DAY), xfer('out', '2000000', PRE + DAY, { contract: B })]
  const run = (sells: UnmatchedEventIdentity[], e: NormalizedEvent[], i: StrictTransferEvent[], o: StrictTransferEvent[]) =>
    resolve(hist({ events: i, outboundEvents: o }), sells, e)
  const a = await run([s1, s2], evs, ins, outs)
  const b = await run([s2, s1], [...evs].reverse(), [...ins].reverse(), [...outs].reverse())
  const byId = (rows: typeof a.rows) => JSON.stringify([...rows].sort((x, y) => x.identity.localeCompare(y.identity)))
  assert.equal(byId(a.rows), byId(b.rows))
})

test('15. receipt rules from 7400609b are unchanged: unrecognised events never clear a sell; one-way transfers do', async () => {
  const classified = classifyEvents([sellEvent()], noRouters)
  for (const reason of ['plain_transfer_no_swap_event', 'transfer_with_unrecognised_events']) {
    // Outbound history incomplete AND an unrecognised receipt: still blocking.
    const r = await resolveBoundaryDependentSells({
      sells: [sellId()], classified, windowStartTimestamp: WS, walletAddress: WALLET,
      receiptProofByTx: new Map([['0xsell', reason]]),
      fetchTokenHistory: fixed(hist({ events: [xfer('in', '10000000', PRE)], outboundStatus: 'capped', outboundCoveredUntil: PRE })),
    })
    assert.deepEqual([r.rows[0]!.gateImpact, r.provenNonTradeTransfers.length], ['blocking', 0], reason)
  }
  const oneWay = await resolveBoundaryDependentSells({
    sells: [sellId()], classified, windowStartTimestamp: WS, walletAddress: WALLET,
    receiptProofByTx: new Map([['0xsell', 'one_way_transfer_only']]),
    fetchTokenHistory: async () => { throw new Error('non-trade receipt proof needs no history') },
  })
  assert.equal(oneWay.rows[0]!.finalDisposition, 'non_trade_transfer_proven')
})

test('no cost basis and no coverage flip: a proven pre-window exit only changes the blocking count', async () => {
  const classified = classifyEvents([sellEvent()], noRouters)
  const r = await resolve(hist({ events: [xfer('in', '10000000', PRE)], outboundStatus: 'empty' }))
  const before = computeUnmatchedEvidenceAudit(classified, 0, [], [sellId()], ctx)
  const after = computeUnmatchedEvidenceAudit(classified, 0, [], [sellId()], { ...ctx, provenPreWindowInventoryExits: new Set(r.provenPreWindowInventoryExits) })
  assert.deepEqual([before.structurallyInvalidOrUnknownSells, after.structurallyInvalidOrUnknownSells], [1, 0])
  assert.deepEqual([after.historyCoverageStatus, after.windowBoundaryProven, after.structuralCoverageNumerator], [before.historyCoverageStatus, false, 0])
})
