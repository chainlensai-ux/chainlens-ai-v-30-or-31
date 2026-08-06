// TESTS — fifoEngine/utils.ts's mergeNormalizedEvents (duplicate-economic-lot follow-up task —
// confirmed production bug: publishedMatchedLots carried two structurally-identical matched lots,
// distinguished only by an occurrence-suffixed lotId. Root cause: `base` was deduped only AGAINST
// `recovered`, never against itself — a duplicate already present within `base` (e.g. from an
// upstream provider/promotion pass) survived and reached matchLotsFIFO as two distinct events).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeNormalizedEvents, normalizedDedupeKey } from './utils'
import type { NormalizedEvent } from '../normalization/types'

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'goldrush', chain: 'base', txHash: '0xtx', timestamp: '2026-01-01T00:00:00.000Z',
    fromAddress: '0xfrom', toAddress: '0xto', contract: '0xtoken', symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

test('HARD ASSERTION (required regression): a duplicate event already present within `base` is deduped, never just recovered-against-base', () => {
  const original = event({ txHash: '0xdup' })
  const duplicate = event({ txHash: '0xdup' }) // same txHash/contract/from/to/amountRaw — a real dupe
  const merged = mergeNormalizedEvents([original, duplicate], [])

  assert.equal(merged.length, 1, 'the exact same real transaction must never be counted twice, regardless of which array it came from')
})

test('two genuinely different base events (different txHash) both survive', () => {
  const a = event({ txHash: '0xa' })
  const b = event({ txHash: '0xb' })
  const merged = mergeNormalizedEvents([a, b], [])
  assert.equal(merged.length, 2)
})

test('a recovered event duplicating a base event is still dropped in favor of the original (unchanged prior behavior)', () => {
  const base = event({ txHash: '0xshared' })
  const recovered = event({ txHash: '0xshared' })
  const merged = mergeNormalizedEvents([base], [recovered])
  assert.equal(merged.length, 1)
  assert.equal(merged[0], base, 'the original base event object is kept, never overwritten by recovery')
})

test('a recovered event that duplicates ANOTHER recovered event (not base) is also deduped', () => {
  const base = event({ txHash: '0xbase' })
  const recoveredA = event({ txHash: '0xrecovered' })
  const recoveredB = event({ txHash: '0xrecovered' })
  const merged = mergeNormalizedEvents([base], [recoveredA, recoveredB])
  assert.equal(merged.length, 2)
  assert.equal(merged.filter((e) => normalizedDedupeKey(e) === normalizedDedupeKey(recoveredA)).length, 1)
})

test('HARD ASSERTION (required regression): a legitimate same-tx, same-contract, opposite-direction pair (a real pass-through hop) is never collapsed by the base self-dedupe', () => {
  const inLeg = event({ txHash: '0xhop', contract: '0xtoken', direction: 'inbound' })
  const outLeg = event({ txHash: '0xhop', contract: '0xtoken', direction: 'outbound' })
  const merged = mergeNormalizedEvents([inLeg, outLeg], [])
  assert.equal(merged.length, 2, 'direction is a genuine identity field — two opposite-direction legs of the same tx are never the same real event')
})

test('a true duplicate (identical direction too) is still deduped', () => {
  const original = event({ txHash: '0xdup2', direction: 'inbound' })
  const duplicate = event({ txHash: '0xdup2', direction: 'inbound' })
  const merged = mergeNormalizedEvents([original, duplicate], [])
  assert.equal(merged.length, 1)
})

test('output order is base (deduped) first, then recovered (deduped, non-overlapping)', () => {
  const base = [event({ txHash: '0xb1' }), event({ txHash: '0xb1' }), event({ txHash: '0xb2' })]
  const recovered = [event({ txHash: '0xr1' })]
  const merged = mergeNormalizedEvents(base, recovered)
  assert.deepEqual(merged.map((e) => e.txHash), ['0xb1', '0xb2', '0xr1'])
})
