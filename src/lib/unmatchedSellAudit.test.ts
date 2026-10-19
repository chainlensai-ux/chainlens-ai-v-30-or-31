// Unmatched sells are grouped by token, with the token's first inbound leg for context.
//   npx tsx --test src/lib/unmatchedSellAudit.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { UnmatchedEventIdentity } from '../modules/fifoEngine/types'
import type { NormalizedEvent } from '../modules/normalization/types'
import { buildUnmatchedSellAudit } from './unmatchedSellAudit'

const ev = (txHash: string, contract: string, timestamp: string): NormalizedEvent => ({
  provider: 'alchemy' as never, chain: 'base', txHash, timestamp,
  fromAddress: '0xa', toAddress: '0xb', contract, symbol: 'T', amount: 1, amountRaw: null, tokenDecimals: 18, direction: 'inbound',
})
const sell = (token: string, timestamp: string, partial = false): UnmatchedEventIdentity => ({
  chain: 'base', txHash: '0xs', token, timestamp: Date.parse(timestamp), direction: 'outbound', amount: 1,
  fromAddress: '0xa', toAddress: '0xb', amountRaw: null, unmatchedRaw: partial ? '1' : '2', sellRaw: '2',
})

describe('buildUnmatchedSellAudit', () => {
  it('groups by token and tells history gaps from short inbound amounts', () => {
    const audit = buildUnmatchedSellAudit({
      unmatchedSells: [
        sell('0xA', '2026-10-01T00:00:00.000Z'),
        sell('0xa', '2026-10-02T00:00:00.000Z', true),
        sell('0xb', '2026-10-01T00:00:00.000Z'),
      ],
      events: [
        ev('0xbuy', '0xa', '2026-09-30T00:00:00.000Z'),
        ev('0xlp', '0xb', '2026-09-30T00:00:00.000Z'),
      ],
      excludedTxKeys: new Set(['base:0xlp']),
    })
    assert.equal(audit.unmatchedSells, 3)
    assert.equal(audit.partial, 1)
    assert.equal(audit.noInboundBeforeFirstSell, 1, 'only 0xb: its one inbound is a liquidity tx')
    assert.deepEqual(audit.byToken.map((r) => [r.token, r.sells, r.firstInboundAt]), [
      ['base:0xa', 2, '2026-09-30T00:00:00.000Z'],
      ['base:0xb', 1, null],
    ])
  })
})
