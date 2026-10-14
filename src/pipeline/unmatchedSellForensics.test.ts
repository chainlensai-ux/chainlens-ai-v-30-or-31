// Pipeline-level: the unmatched-sell chain the pipeline runs (FIFO → evidence audit → per-sell
// resolver → evidence audit → forensics) produces persisted, deterministic per-sell rows, and the
// pipeline wiring keeps the receipt fetch off the promotion-flag path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { RawProviderEvent } from '../modules/providerFetchWindow/types'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import { classifyEvents, computeUnmatchedEvidenceAudit } from '../modules/eventClassification/index'
import { resolveBoundaryDependentSells, unmatchedSellProofKey, type PreResolverBucket } from '../modules/eventClassification/boundaryDependentSellResolution'
import { buildUnmatchedSellForensics, MAX_UNMATCHED_SELL_FORENSIC_ROWS } from '../lib/unmatchedSellForensics'

const WALLET = '0x4dbb3835744b2976560e0259cb218cab89abef96'
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const C = '0xcccccccccccccccccccccccccccccccccccccccc'
const D = '0xdddddddddddddddddddddddddddddddddddddddd'
const DAY = 86_400_000
const WINDOW_START = Date.parse('2026-06-14T00:00:00.000Z')
const iso = (ts: number) => new Date(ts).toISOString()
const ctx = { windowStartTimestamp: WINDOW_START, scanWindowDays: 90, anyProviderFetchFailed: true, anyProviderAtEventCap: false }

function ev(o: Partial<NormalizedEvent>): NormalizedEvent {
  return { provider: 'alchemy', chain: 'base', txHash: '0x', timestamp: iso(WINDOW_START + 10 * DAY), fromAddress: WALLET, toAddress: '0xpool', contract: A, symbol: 'T', amount: 5, amountRaw: '5000000', tokenDecimals: 6, direction: 'outbound', ...o }
}
const events: NormalizedEvent[] = [
  // A: shortfall — buy 3, sell 5 (2 uncovered); pre-window inventory of 2 covers it.
  ev({ txHash: '0xa-buy', direction: 'inbound', fromAddress: '0xpool', toAddress: WALLET, amount: 3, amountRaw: '3000000', timestamp: iso(WINDOW_START + 5 * DAY) }),
  ev({ txHash: '0xa-sell', contract: A }),
  // B: no buy at all, pre-window inventory of 1 wei only → insufficient.
  ev({ txHash: '0xb-sell', contract: B, amount: 7, amountRaw: '7000000', timestamp: iso(WINDOW_START + 11 * DAY) }),
  // C: no buy, receipt proves a one-way transfer → non-trade.
  // D: no buy, receipt has Transfers plus an unrecognised event (e.g. a V4 swap) → still blocking.
  ev({ txHash: '0xc-sell', contract: C, amount: 9, amountRaw: '9000000', timestamp: iso(WINDOW_START + 12 * DAY) }),
  ev({ txHash: '0xd-sell', contract: D, amount: 11, amountRaw: '11000000', timestamp: iso(WINDOW_START + 13 * DAY) }),
]
const recoveredRaw: RawProviderEvent[] = [
  { provider: 'alchemy', chain: 'base', txHash: '0xa-pre', timestamp: iso(WINDOW_START - 3 * DAY), fromAddress: '0xother', toAddress: WALLET, contract: A, symbol: 'T', amountRaw: '2000000', tokenDecimals: 6 },
  { provider: 'alchemy', chain: 'base', txHash: '0xb-pre', timestamp: iso(WINDOW_START - 3 * DAY), fromAddress: '0xother', toAddress: WALLET, contract: B, symbol: 'T', amountRaw: '1', tokenDecimals: 6 },
]

async function runChain(input: NormalizedEvent[]) {
  const classified = classifyEvents(input, { knownDexRouterAddresses: new Set() })
  const fifo = matchLotsFIFO(buildLots(input.filter((e) => e.direction === 'inbound'), []), input.filter((e) => e.direction === 'outbound'))
  const receiptProofByTxHash = new Map([['0xc-sell', 'one_way_transfer_only'], ['0xd-sell', 'transfer_with_unrecognised_events']])
  const first = computeUnmatchedEvidenceAudit(classified, fifo.matchedLots.length, [], fifo.unmatchedSellEvents, ctx)
  const buckets = new Map<string, PreResolverBucket>([
    ...first.boundaryProofDiagnostics.boundaryRequiredSells.map((s) => [unmatchedSellProofKey(s), s.reason] as const),
    ...first.boundaryProofDiagnostics.boundaryIndependentSells.filter((s) => s.reason === 'earlier_buy_in_window').map((s) => [unmatchedSellProofKey(s), 'earlier_buy_in_window'] as const),
  ])
  const resolution = await resolveBoundaryDependentSells({
    sells: fifo.unmatchedSellEvents.filter((s) => buckets.has(unmatchedSellProofKey(s))),
    classified, recoveredRawEvents: recoveredRaw, windowStartTimestamp: WINDOW_START, walletAddress: WALLET,
    receiptProofByTx: receiptProofByTxHash, preResolverBuckets: buckets, allUnmatchedSells: fifo.unmatchedSellEvents,
    fetchTokenHistory: async () => ({ ok: true, inboundQueryOk: true, outboundQueryOk: false, events: [], inboundPageCapped: false, inboundPageExhausted: true, providerCalls: 1 }),
  })
  const final = computeUnmatchedEvidenceAudit(classified, fifo.matchedLots.length, [], fifo.unmatchedSellEvents, {
    ...ctx,
    provenPreWindowInventoryExits: new Set(resolution.provenPreWindowInventoryExits),
    provenNonTradeTransfers: new Set(resolution.provenNonTradeTransfers),
    provenGenuineUnmatchedSells: new Set(resolution.provenGenuineUnmatchedSells),
    provenPreWindowShortfalls: new Set(resolution.provenPreWindowShortfalls),
  })
  const forensics = buildUnmatchedSellForensics({
    unmatchedSellEvents: fifo.unmatchedSellEvents, boundaryProofDiagnostics: final.boundaryProofDiagnostics,
    resolverRows: resolution.rows, receiptProofByTxHash, historyCoverageStatus: final.historyCoverageStatus,
    tokensSkippedByFetchCap: resolution.tokensSkippedByFetchCap,
  })
  return { first, final, forensics }
}

test('forensics: one row per unmatched sell with raw amounts, bucket, receipt proof, recovery outcome and final disposition', async () => {
  const { first, final, forensics } = await runChain(events)
  assert.equal(first.structurallyInvalidOrUnknownSells, 4)
  assert.equal(final.structurallyInvalidOrUnknownSells, 2, 'the 1-wei-backed B sell and the unrecognised-venue D sell still block')
  assert.equal(final.historyCoverageStatus, first.historyCoverageStatus, 'per-sell proof never flips coverage')
  const byTx = new Map(forensics.rows.map((r) => [r.txHash, r]))
  assert.deepEqual(forensics.rows.map((r) => r.txHash), ['0xa-sell', '0xb-sell', '0xc-sell', '0xd-sell'])
  const a = byTx.get('0xa-sell')!
  assert.deepEqual([a.unmatchedRaw, a.sellRaw, a.bucket, a.finalDisposition], ['2000000', '5000000', 'non_blocking', 'pre_window_inventory_exit_proven'])
  const b = byTx.get('0xb-sell')!
  assert.deepEqual([b.unmatchedRaw, b.bucket, b.finalDisposition, b.targetedRecoveryOutcome], ['7000000', 'window_boundary_unproven', 'pre_window_inventory_insufficient', 'inbound_found'])
  const c = byTx.get('0xc-sell')!
  assert.deepEqual([c.receiptProof, c.bucket, c.finalDisposition], ['one_way_transfer_only', 'non_blocking', 'non_trade_transfer_proven'])
  const d = byTx.get('0xd-sell')!
  assert.deepEqual([d.receiptProof, d.bucket, d.finalDisposition], ['transfer_with_unrecognised_events', 'genuine_unmatched_sell', 'genuine_unmatched_sell'])
  assert.ok(forensics.rows.every((r) => r.historyCoverageStatus === 'partial' && r.chain === 'base'))
  assert.deepEqual([forensics.totalUnmatchedSells, forensics.truncated], [4, false])
})

test('forensics determinism: shuffled provider event order gives byte-identical forensics', async () => {
  const a = await runChain(events)
  const b = await runChain([events[4]!, events[3]!, events[2]!, events[0]!, events[1]!])
  assert.equal(JSON.stringify(a.forensics), JSON.stringify(b.forensics))
})

test('forensics is capped at 100 rows and reports the truncation', () => {
  const sells = Array.from({ length: 130 }, (_, i) => ({
    chain: 'base' as const, txHash: `0x${i.toString(16).padStart(4, '0')}`, token: A, timestamp: WINDOW_START + i, direction: 'outbound' as const,
    amount: 1, fromAddress: WALLET, toAddress: '0xpool', amountRaw: '1', unmatchedRaw: '1', sellRaw: '1',
  }))
  const f = buildUnmatchedSellForensics({
    unmatchedSellEvents: sells, boundaryProofDiagnostics: { boundaryRequiredSells: [], boundaryIndependentSells: [] },
    resolverRows: [], receiptProofByTxHash: new Map(), historyCoverageStatus: 'truncated',
  })
  assert.deepEqual([f.rows.length, f.rowsReturned, f.totalUnmatchedSells, f.truncated], [MAX_UNMATCHED_SELL_FORENSIC_ROWS, 100, 130, true])
})

test('pipeline wiring: receipt fetch only when promotion is off, before the resolver, deferred block never awaited; shortfalls routed; forensics on the result', () => {
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const fill = src.indexOf('fillUnmatchedSellReceiptProofs({')
  const resolve = src.indexOf('resolveBoundaryDependentSells({')
  assert.ok(fill > 0 && resolve > fill, 'targeted receipt fetch runs before the resolver')
  assert.match(src, /if \(!receiptSwapCanonicalPromotionEnabled && process\.env\.RECEIPT_SWAP_DECODER_SHADOW_DISABLED !== 'true'\) \{\n\s+const resolveKeys/)
  assert.match(src, /setImmediate\(\(\) => \{ runShadowReceiptDecodeBlock\(\)\.catch\(\(\) => \{\}\) \}\)/, 'deferred block stays deferred')
  assert.equal((src.match(/await runShadowReceiptDecodeBlock\(\)/g) ?? []).length, 1, 'awaited only on the flag-on path')
  assert.match(src, /reason === 'earlier_buy_in_window'/)
  assert.match(src, /provenPreWindowShortfalls: new Set\(boundaryDependentSellResolutionAudit\.provenPreWindowShortfalls\)/)
  assert.match(src, /allUnmatchedSells: fifoAndPnl\.unmatchedSellEvents/)
  assert.match(src, /sampleUpdated,\n\s+unmatchedSellForensics,/)
})
