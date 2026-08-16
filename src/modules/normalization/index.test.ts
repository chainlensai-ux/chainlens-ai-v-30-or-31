// TESTS — Wallet Scanner graph/API + DEX model support audit task.
//
// Covers normalizeEvents()'s dedupe behavior, specifically the chain-scoped dedupe key fix (see
// normalizedDedupeKey's own disclosure in utils.ts): src/pipeline/index.ts fetches every requested
// chain concurrently and flattens ALL chains' raw events into one array before this dedupe key is
// ever applied, so the key must be chain-scoped or two structurally distinct events on different
// chains that happen to share the same txHash/contract/from/to/amountRaw would incorrectly collide.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEvents } from './index'
import { normalizedDedupeKey } from './utils'
import type { RawProviderEvent } from '../providerFetchWindow/types'

const WALLET = '0x111111111111111111111111111111111111111a'
const TOKEN = '0x222222222222222222222222222222222222222b'
const OTHER = '0x333333333333333333333333333333333333333c'

function rawEvent(overrides: Partial<RawProviderEvent> = {}): RawProviderEvent {
  return {
    provider: 'goldrush',
    chain: 'base',
    txHash: '0xabc',
    timestamp: '2024-01-01T00:00:00.000Z',
    fromAddress: OTHER,
    toAddress: WALLET,
    contract: TOKEN,
    symbol: 'TOK',
    amountRaw: '1000000000000000000',
    tokenDecimals: 18,
    ...overrides,
  }
}

test('a genuine cross-provider duplicate (same chain, same tx/contract/from/to/amount) is deduped exactly once', () => {
  const events = [
    rawEvent({ provider: 'goldrush' }),
    rawEvent({ provider: 'alchemy' }),
  ]
  const { normalizedEvents, normalizationErrors } = normalizeEvents(events, WALLET)

  assert.equal(normalizedEvents.length, 1, 'the second provider reporting the SAME real event must not double it')
  assert.equal(normalizationErrors.filter((e) => e.reason === 'duplicate_event').length, 1)
})

test('CHAIN-SCOPED DEDUPE FIX: two structurally-identical events on DIFFERENT chains are both kept, never collapsed into one', () => {
  // Same txHash/contract/from/to/amountRaw, but genuinely different chains — the exact shape the
  // pipeline can produce when it flattens providerResults across multiple requested chains into one
  // array before normalizeEvents ever runs (see src/pipeline/index.ts's own `allRawEvents`).
  const events = [
    rawEvent({ chain: 'base' }),
    rawEvent({ chain: 'eth' }),
  ]
  const { normalizedEvents, normalizationErrors } = normalizeEvents(events, WALLET)

  assert.equal(normalizedEvents.length, 2, 'a real event on chain B must never be dropped as a duplicate of chain A\'s event')
  assert.equal(normalizationErrors.filter((e) => e.reason === 'duplicate_event').length, 0)
  assert.deepEqual(normalizedEvents.map((e) => e.chain).sort(), ['base', 'eth'])
})

test('normalizedDedupeKey itself differs across chains for otherwise-identical events', () => {
  const base = normalizedDedupeKey(rawEvent({ chain: 'base' }))
  const eth = normalizedDedupeKey(rawEvent({ chain: 'eth' }))
  assert.notEqual(base, eth)
})

test('DETERMINISTIC MULTI-PROVIDER MERGE: normalizing the same event set twice, and in reversed provider order, yields the same surviving events', () => {
  const forward = [rawEvent({ provider: 'goldrush', txHash: '0x1' }), rawEvent({ provider: 'alchemy', txHash: '0x1' })]
  const reversed = [rawEvent({ provider: 'alchemy', txHash: '0x1' }), rawEvent({ provider: 'goldrush', txHash: '0x1' })]

  const a = normalizeEvents(forward, WALLET)
  const b = normalizeEvents(reversed, WALLET)

  assert.equal(a.normalizedEvents.length, 1)
  assert.equal(b.normalizedEvents.length, 1)
  // Content is identical either way (dedupe key doesn't include provider), only which provider
  // "won" the race to be first can differ — the surviving economic event itself is deterministic.
  assert.equal(a.normalizedEvents[0].txHash, b.normalizedEvents[0].txHash)
  assert.equal(a.normalizedEvents[0].amount, b.normalizedEvents[0].amount)
})

test('a real second leg (different amount) on the same chain/tx/contract/pair is NOT deduped away', () => {
  const events = [
    rawEvent({ amountRaw: '1000000000000000000' }),
    rawEvent({ amountRaw: '2000000000000000000' }),
  ]
  const { normalizedEvents } = normalizeEvents(events, WALLET)
  assert.equal(normalizedEvents.length, 2, 'two genuinely different amounts in the same tx are two real legs, never a duplicate')
})
