// TESTS — cost-audit follow-up task: the current-price ("now") pass for open positions goes through
// the SAME real GoldRush price source/process-lifetime call counter as the at-trade-time historical
// pass, but was invisible to `goldrushActualLiveCalls` (snapshotted before this pass ever runs).
// Confirmed production shape: manifest replay applies (0 historical live calls), yet
// [wallet-provider-cost-audit] still shows real goldrush_getTokenPrices calls with 0 used — those
// calls are the open-position current-price pass, real and legitimate, just previously unlabelled.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { priceLotsForWallet } from './priceLotsForWallet'
import { lotIdentityVersion, buildAcceptedEvidenceEnvelope, type AcceptedEvidenceKvLike } from '../lib/acceptedEvidenceStore'
import type { NormalizedEvent } from '../modules/normalization/types'
import {
  goldrushPriceSource, resetGoldrushPriceSourceCallCount, __resetGoldrushPriceSourceCachesForTest,
} from '../modules/pricingAtTimeEngine/sources/goldrushPriceSource'
import { resetWalletProviderCostLedger } from '../modules/providerCost/walletProviderCostLedger'

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'alchemy', chain: 'base', txHash: '0xtx', timestamp: '2026-01-01T00:00:00.000Z',
    fromAddress: '0xfrom', toAddress: '0xto', contract: '0xtoken', symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

function fakeAcceptedEvidenceKv(): AcceptedEvidenceKvLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    get: async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
    set: async (key: string, value: unknown) => { store.set(key, value); return 'OK' },
  }
}

// A minimal fake matching only the two GoldRushClient members goldrushPriceSource actually reads —
// real enough to exercise the real tryConsume/recordCallOutcome/call-count wiring end to end.
function fakeGoldRushClient(priceUsd: number) {
  return {
    PricingService: {
      getTokenPrices: async () => ({ data: [{ items: [{ price: priceUsd }] }] }),
    },
  } as unknown as Parameters<typeof goldrushPriceSource>[0]
}

test('HARD ASSERTION: a real open-position current-price call is counted separately from the (zero) replay-covered historical figure', async () => {
  resetGoldrushPriceSourceCallCount()
  __resetGoldrushPriceSourceCachesForTest()
  resetWalletProviderCostLedger()

  const closedBuy = event({ txHash: '0xclosedbuy', direction: 'inbound', contract: '0xclosed', amount: 1, timestamp: '2026-01-01T00:00:00.000Z' })
  const closedSell = event({ txHash: '0xclosedsell', direction: 'outbound', contract: '0xclosed', amount: 1, timestamp: '2026-01-02T00:00:00.000Z' })
  const openBuy = event({ txHash: '0xopenbuy', direction: 'inbound', contract: '0xopen', amount: 1, timestamp: '2026-01-03T00:00:00.000Z' })
  const allEvents = [closedBuy, closedSell, openBuy]

  const kv = fakeAcceptedEvidenceKv()
  const now = 1
  const base = {
    chain: closedBuy.chain, token: closedBuy.contract, openedTxHash: closedBuy.txHash, closedTxHash: closedSell.txHash,
    openedAt: Date.parse(closedBuy.timestamp), closedAt: Date.parse(closedSell.timestamp), amount: closedBuy.amount,
  }
  const version = lotIdentityVersion(base)
  for (const side of ['entry', 'exit'] as const) {
    const txHash = side === 'entry' ? base.openedTxHash : base.closedTxHash
    const timestamp = side === 'entry' ? base.openedAt : base.closedAt
    const envelope = buildAcceptedEvidenceEnvelope({
      identity: { chain: base.chain, token: base.token, txHash, side, timestamp, lotIdentityVersion: version },
      priceUsd: side === 'entry' ? 5 : 7, valueUsd: 5, source: 'test', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now,
    })
    await kv.set(`v1:accepted-evidence:${base.chain}:${base.token.toLowerCase()}:${txHash}:${side}:${timestamp}`, envelope)
  }

  const realGoldrush = goldrushPriceSource(fakeGoldRushClient(9))
  const result = await priceLotsForWallet({
    normalizedEvents: allEvents, recoveredEvents: [],
    priceSources: { primary: realGoldrush, fallback: () => null },
    acceptedEvidenceKv: kv, now: () => now,
  })

  // The CLOSED lot's own sides are fully accepted-evidence covered and contribute zero calls to
  // either figure. The single real historical call that DOES fire is the open position's own entry
  // (cost-basis) side — never accepted-evidence-coverable (never seeded for an open position) and
  // genuinely necessary, correctly attributed to the historical figure, never hidden.
  assert.equal(result.acceptedEvidenceSkipAudit.goldrushActualLiveCalls, 1, 'the one real historical call is the open position\'s own cost-basis lookup, not the covered closed lot')
  // The open position's CURRENT price is a SEPARATE, genuinely additional, real, unavoidable live
  // call — this is the one that was previously invisible to goldrushActualLiveCalls entirely.
  assert.equal(result.acceptedEvidenceSkipAudit.currentPriceGoldrushLiveCalls, 1, 'the current-price pass for the one open position makes exactly one real, separately-attributed GoldRush call')
  assert.equal(result.manifestFastPathAudit.openPositionRequirementsRetained, 1)
  assert.equal(result.priceUsdLookup(closedBuy), 5)
  assert.equal(result.priceUsdLookup(closedSell), 7)
  assert.equal(result.currentPriceUsdLookup(openBuy.contract, openBuy.chain), 9, 'the real live current price is genuinely used, never discarded')
})
