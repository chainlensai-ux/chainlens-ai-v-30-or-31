// fetchAlchemyTokenHistoryStrict asks for the OLDEST inbounds first, so a capped page still contains
// the earliest acquisitions; newest-first stays available through the explicit parameter.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchAlchemyTokenHistoryStrict, resetRecoveryHistoricalPageRequestCache } from './utils'

const originalFetch = global.fetch
const originalKey = process.env.ALCHEMY_BASE_KEY
const bodies: Array<{ params: Array<Record<string, unknown>> }> = []

beforeEach(() => {
  process.env.ALCHEMY_BASE_KEY = 'test-alchemy-base-key'
  resetRecoveryHistoricalPageRequestCache()
  bodies.length = 0
  global.fetch = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body))
    const transfers = Array.from({ length: 100 }, (_, i) => ({
      hash: `0x${i}`, from: '0xother', to: '0xwallet', asset: 'T', metadata: { blockTimestamp: '2025-01-01T00:00:00Z' },
      rawContract: { address: '0xtoken', value: '0x1', decimal: '0x12' },
    }))
    return new Response(JSON.stringify({ result: { transfers } }), { status: 200 })
  }) as unknown as typeof fetch
})
afterEach(() => {
  global.fetch = originalFetch
  process.env.ALCHEMY_BASE_KEY = originalKey
})

test('default inbound query is oldest-first; capped detection is unchanged', async () => {
  const r = await fetchAlchemyTokenHistoryStrict('base', '0xwallet', '0xtoken')
  assert.equal(bodies[0]!.params[0]!.order, 'asc')
  assert.equal(bodies[0]!.params[0]!.toAddress, '0xwallet')
  assert.deepEqual([r.ok, r.inboundPageCapped, r.inboundPageExhausted, r.order], [true, true, false, 'asc'])
})

test('newest-first is an explicit, separately cached request', async () => {
  await fetchAlchemyTokenHistoryStrict('base', '0xwallet', '0xtoken')
  const desc = await fetchAlchemyTokenHistoryStrict('base', '0xwallet', '0xtoken', 'desc')
  assert.deepEqual(bodies.map((b) => b.params[0]!.order), ['asc', 'desc'])
  assert.equal(desc.order, 'desc')
})
