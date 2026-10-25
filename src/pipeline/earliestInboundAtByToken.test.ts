import { test } from 'node:test'
import assert from 'node:assert/strict'
import { earliestInboundAtByToken } from './index'
import { analyzeDistributorRouterFlows } from '../modules/distributorRecovery/index'
import type { NormalizedEvent } from '../modules/normalization/types'

const ROUTER = '0x2626664c2603336e57b271c5c0b26f421741e481'
let seq = 0
function evt(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  seq += 1
  return {
    provider: 'goldrush', chain: 'base', txHash: `0xtx${seq}`, timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    fromAddress: '0xfrom', toAddress: '0xto', contract: '0xtoken', symbol: 'TOK', amount: 1, amountRaw: '1', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

test('earliest inbound per chain:token — case-insensitive, outbound and unparseable timestamps ignored', () => {
  const map = earliestInboundAtByToken([
    evt({ contract: '0xAbC', timestamp: '2024-01-03T00:00:00Z' }),
    evt({ contract: '0xabc', timestamp: '2024-01-02T00:00:00Z' }),
    evt({ contract: '0xabc', timestamp: '2024-01-01T00:00:00Z', direction: 'outbound' }),
    evt({ contract: '0xabc', timestamp: 'not-a-date' }),
    evt({ contract: '0xabc', chain: 'eth', timestamp: '2023-01-01T00:00:00Z' }),
  ])
  assert.equal(map.get('base:0xabc'), Date.parse('2024-01-02T00:00:00Z'))
  assert.equal(map.get('eth:0xabc'), Date.parse('2023-01-01T00:00:00Z'))
  assert.equal(map.size, 2)
})

test('distributor recovery: same-tx inbound leg of a different token is found by lookup, first in event order', () => {
  const out = evt({ txHash: '0xswap', direction: 'outbound', contract: '0xA', toAddress: ROUTER })
  const sameToken = evt({ txHash: '0xswap', contract: '0xa' })
  const first = evt({ txHash: '0xswap', contract: '0xB' })
  const second = evt({ txHash: '0xswap', contract: '0xC' })
  const otherChain = evt({ txHash: '0xswap', chain: 'eth', contract: '0xD' })
  const lonely = evt({ txHash: '0xlonely', direction: 'outbound', contract: '0xA', toAddress: ROUTER })
  const result = analyzeDistributorRouterFlows([otherChain, out, sameToken, first, second, lonely], new Set([ROUTER]), true)
  assert.equal(result.groups[0]?.matchedInboundEvent, first)
  assert.equal(result.groups[1]?.matchedInboundEvent, null)
  assert.equal(result.missingEvidenceCount, 1)
})

test('busy wallet: 60k router sells resolve in well under a second (was quadratic)', () => {
  const events: NormalizedEvent[] = []
  for (let i = 0; i < 60_000; i++) {
    events.push(evt({ txHash: `0xbig${i}`, direction: 'outbound', contract: `0xt${i % 1300}`, toAddress: ROUTER }))
    events.push(evt({ txHash: `0xbig${i}`, contract: `0xq${i % 7}` }))
  }
  const t0 = performance.now()
  earliestInboundAtByToken(events)
  const result = analyzeDistributorRouterFlows(events, new Set([ROUTER]), true)
  assert.equal(result.missingEvidenceCount, 0)
  assert.ok(performance.now() - t0 < 2_000, `took ${performance.now() - t0}ms`)
})
