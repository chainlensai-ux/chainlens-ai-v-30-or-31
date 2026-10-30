// The public PnL status counts only lots priced from their own transactions on both sides when a
// SidePricingBasisLookup is supplied: a lot priced from a provider's market price is never presented as
// verified. Without the lookup, the status is computed exactly as before.
//   npx tsx --test src/modules/fifoEngine/pricingBasisStatus.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFifoOutput } from './index'
import type { NormalizedEvent } from '../normalization/types'
import type { SidePricingBasis } from './types'

const WALLET = '0x1111111111111111111111111111111111111111'
const POOL = '0x2222222222222222222222222222222222222222'
const ev = (i: number, direction: 'inbound' | 'outbound'): NormalizedEvent => ({
  provider: 'goldrush', chain: 'base', txHash: `0x${direction === 'inbound' ? 'b' : 's'}${String(i).padStart(3, '0')}`,
  timestamp: new Date(1_700_000_000_000 + i * 1000 + (direction === 'outbound' ? 500 : 0)).toISOString(),
  fromAddress: direction === 'inbound' ? POOL : WALLET, toAddress: direction === 'inbound' ? WALLET : POOL,
  contract: `0x${(0x3000 + i).toString(16).padStart(40, '0')}`, symbol: 'T', amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction,
})
const events = Array.from({ length: 12 }, (_, i) => [ev(i, 'inbound'), ev(i, 'outbound')]).flat()
const priced = (e: NormalizedEvent) => (e.direction === 'inbound' ? 10 : 12)
const run = (basis?: (txHash: string, side: 'entry' | 'exit') => SidePricingBasis | null) =>
  buildFifoOutput({ normalizedEvents: events, recoveredRawEvents: [], walletAddress: WALLET, priceUsdLookup: priced, ...(basis ? { sidePricingBasisLookup: (_c, tx, side) => basis(tx, side) } : {}) })

test('without a basis lookup: 12 fully priced lots give the existing "ok" status', () => {
  const out = run()
  assert.equal(out.publicPnlStatus, 'ok')
  assert.equal(out.pricingBasis, undefined)
})

test('all lots priced from market estimates: never "ok", reported as unavailable', () => {
  const out = run(() => 'estimate')
  assert.equal(out.publicPnlStatus, 'unavailable')
  assert.deepEqual(out.pricingBasis, { transactionPricedVerifiedLots: 0, estimatedVerifiedLots: 12 })
  assert.equal(out.realizedPnlUsd, 24, 'the FIFO figure itself is unchanged; only its status is gated')
})

test('a lot counts only when BOTH sides are transaction-priced', () => {
  const out = run((tx, side) => (side === 'entry' ? 'transaction' : tx.endsWith('000') ? 'transaction' : 'estimate'))
  assert.deepEqual(out.pricingBasis, { transactionPricedVerifiedLots: 1, estimatedVerifiedLots: 11 })
  assert.equal(out.publicPnlStatus, 'limited_verified_sample')
})

test('all lots transaction-priced: "ok" as before', () => {
  const out = run(() => 'transaction')
  assert.equal(out.publicPnlStatus, 'ok')
  assert.deepEqual(out.pricingBasis, { transactionPricedVerifiedLots: 12, estimatedVerifiedLots: 0 })
})
