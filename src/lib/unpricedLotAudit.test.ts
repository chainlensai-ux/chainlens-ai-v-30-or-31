// Each unverified lot's missing side is traced to the stage that left it without a price.
//   npx tsx --test src/lib/unpricedLotAudit.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { MatchedLot } from '../modules/fifoEngine/types'
import type { NormalizedEvent } from '../modules/normalization/types'
import { buildUnpricedLotAudit } from './unpricedLotAudit'

const TOKEN = '0xtoken'
const ev = (txHash: string, direction: 'inbound' | 'outbound'): NormalizedEvent => ({
  provider: 'alchemy' as never, chain: 'base', txHash, timestamp: '2026-10-19T00:00:00.000Z',
  fromAddress: '0xa', toAddress: '0xb', contract: TOKEN, symbol: 'T', amount: 1, amountRaw: null, tokenDecimals: 18, direction,
})
const lot = (id: string, open: string, close: string, cost: number | null, proceeds: number | null): MatchedLot => ({
  lotId: id, token: TOKEN, chain: 'base', openedAt: 1, closedAt: 2, openedTxHash: open, closedTxHash: close, amount: 1,
  costBasisUsd: cost, proceedsUsd: proceeds, realizedPnlUsd: cost != null && proceeds != null ? proceeds - cost : null,
  evidenceQuality: cost != null && proceeds != null ? 'verified' : 'unpriced',
})

describe('buildUnpricedLotAudit', () => {
  it('names the first stage that dropped each missing side', () => {
    const events = [ev('0xbuy', 'inbound'), ev('0xsell', 'outbound'), ev('0xlp', 'inbound'), ev('0xodd', 'outbound'), ev('0xnone', 'inbound')]
    const raw = (e: NormalizedEvent) => (e.txHash === '0xnone' ? null : 10)
    const liquidity = (e: NormalizedEvent) => (e.txHash === '0xlp' ? null : raw(e))
    const guarded = (e: NormalizedEvent) => (e.txHash === '0xodd' ? null : liquidity(e))
    const audit = buildUnpricedLotAudit({
      lots: [
        lot('ok', '0xbuy', '0xsell', 10, 10),
        lot('lp', '0xlp', '0xsell', null, 10),
        lot('odd', '0xbuy', '0xodd', 10, null),
        lot('none', '0xnone', '0xmissing', null, null),
      ],
      events, rawLookup: raw, liquidityGuardedLookup: liquidity, guardedLookup: guarded,
    })
    assert.equal(audit.verifiedLots, 1)
    assert.equal(audit.unverifiedLots, 3)
    assert.deepEqual(audit.sideReasons, { no_matching_event: 1, no_price: 1, liquidity_guard: 1, outlier_guard: 1, priced: 0 })
    assert.deepEqual(audit.missingSides, { entryOnly: 1, exitOnly: 1, both: 1 })
    assert.equal(audit.byToken[0].lots, 3)
  })
})
