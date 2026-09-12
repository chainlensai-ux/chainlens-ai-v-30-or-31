import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { clearCoinPaprikaCachesForTests } from '../../lib/server/coinPaprikaHistorical'
import { lotIdentityVersion, buildAcceptedEvidenceEnvelope, type AcceptedEvidenceKvLike } from '../lib/acceptedEvidenceStore'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { PriceSourceFn, PriceSources } from '../modules/pricingAtTimeEngine/types'
import { priceLotsForWallet } from './priceLotsForWallet'

const TOKEN = '0x1111111111111111111111111111111111111111'
const priorKey = process.env.COINPAPRIKA_API_KEY
const priorEnabled = process.env.COINPAPRIKA_HISTORICAL_ENABLED
const priorBudget = process.env.COINPAPRIKA_MAX_CALLS_PER_SCAN

afterEach(() => {
  clearCoinPaprikaCachesForTests()
  if (priorKey === undefined) delete process.env.COINPAPRIKA_API_KEY; else process.env.COINPAPRIKA_API_KEY = priorKey
  if (priorEnabled === undefined) delete process.env.COINPAPRIKA_HISTORICAL_ENABLED; else process.env.COINPAPRIKA_HISTORICAL_ENABLED = priorEnabled
  if (priorBudget === undefined) delete process.env.COINPAPRIKA_MAX_CALLS_PER_SCAN; else process.env.COINPAPRIKA_MAX_CALLS_PER_SCAN = priorBudget
})

function event(i: number, direction: 'inbound' | 'outbound'): NormalizedEvent {
  return {
    provider: 'goldrush', chain: 'base', txHash: `0x${direction}${i}`,
    timestamp: `2024-01-${String(i + 1).padStart(2, '0')}T${direction === 'inbound' ? '00' : '12'}:00:00.000Z`,
    fromAddress: '0xfrom', toAddress: '0xto', contract: TOKEN, symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction,
  }
}
const misses: PriceSources = { primary: (async () => null) as PriceSourceFn, fallback: (async () => null) as PriceSourceFn }
const paprikaFetch = async (input: string | URL | Request) => String(input).includes('/contracts/')
  ? Response.json({ id: 'tok-token', platform_id: 'base-base', contract_address: TOKEN })
  : Response.json([{ time_open: '2024-01-01T00:00:00Z', close: 2 }])

function fakeAcceptedEvidenceKv(): AcceptedEvidenceKvLike & { store: Map<string, unknown> } {
  const raw = new Map<string, unknown>()
  return {
    store: raw,
    get: async <T>(key: string) => (raw.has(key) ? raw.get(key) as T : null),
    set: async (key: string, value: unknown) => { raw.set(key, JSON.parse(JSON.stringify(value))); return 'OK' },
  }
}

describe('priceLotsForWallet CoinPaprika canonical fallback wiring', () => {
  it('passes 22 unresolved stronger-source failures to identity lookup after stronger providers fail', async () => {
    process.env.COINPAPRIKA_API_KEY = 'test'
    const events = Array.from({ length: 11 }, (_, i) => [event(i, 'inbound'), event(i, 'outbound')]).flat()
    const result = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: misses, coinPaprikaFetchImpl: paprikaFetch })
    assert.equal(result.coinPaprikaHistoricalAudit.unresolvedRequirementsReceived, 22)
    assert.ok(result.coinPaprikaHistoricalAudit.identityLookupsAttempted > 0)
    assert.ok(result.coinPaprikaHistoricalAudit.callsAttempted > 0)
    assert.equal(result.coinPaprikaHistoricalAudit.pricesApplied, 0)
    assert.equal(result.priceUsdLookup(events[0]), null, 'partial daily evidence must not become canonical verified pricing')
  })

  it('always returns an exact audit when no closed-lot candidate exists', async () => {
    process.env.COINPAPRIKA_API_KEY = 'test'
    let paprikaCalls = 0
    const result = await priceLotsForWallet({
      normalizedEvents: [event(0, 'inbound')],
      recoveredEvents: [],
      priceSources: misses,
      coinPaprikaFetchImpl: async () => { paprikaCalls += 1; return paprikaFetch('https://example.invalid') },
    })
    assert.equal(result.coinPaprikaHistoricalAudit.eligibleAfterFilters, 0)
    assert.equal(result.coinPaprikaHistoricalAudit.firstDropStage, 'eligibility')
    assert.equal(result.coinPaprikaHistoricalAudit.exactDropReason, 'zero_unresolved_requirements_received')
    assert.equal(result.coinPaprikaHistoricalAudit.unresolvedRequirementsReceived, 0)
    assert.equal(result.coinPaprikaHistoricalAudit.callsAttempted, 0)
    assert.equal(paprikaCalls, 0)
  })

  it('passes 60 unresolved requirements into keyless eligibility and identity lookup', async () => {
    delete process.env.COINPAPRIKA_API_KEY
    let calls = 0
    const events = Array.from({ length: 30 }, (_, i) => [event(i, 'inbound'), event(i, 'outbound')]).flat()
    const result = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: misses, coinPaprikaFetchImpl: async () => { calls++; return new Response('', { status: 500 }) } })
    assert.equal(result.coinPaprikaHistoricalAudit.unresolvedRequirementsReceived, 60)
    assert.equal(result.coinPaprikaHistoricalAudit.eligibleAfterFilters, 60)
    assert.equal(result.coinPaprikaHistoricalAudit.mode, 'keyless_free')
    assert.equal(result.coinPaprikaHistoricalAudit.configured, true)
    assert.ok(result.coinPaprikaHistoricalAudit.identityLookupsAttempted > 0)
    assert.ok(calls > 0)
  })

  it('contains CoinPaprika failures without failing Wallet Scanner pricing', async () => {
    delete process.env.COINPAPRIKA_API_KEY
    const events = [event(0, 'inbound'), event(0, 'outbound')]
    const result = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: misses, coinPaprikaFetchImpl: async () => { throw new Error('provider unavailable') } })
    assert.ok(result.coinPaprikaHistoricalAudit.callsFailed > 0)
    assert.equal(result.coinPaprikaHistoricalAudit.pricesApplied, 0)
    assert.equal(result.priceUsdLookup(events[0]), null)
  })

  it('keeps a numeric provider result unresolved until canonical evidence verifies that side', async () => {
    process.env.COINPAPRIKA_API_KEY = 'test'
    const buy = event(0, 'inbound'); const sell = event(0, 'outbound')
    const stronger: PriceSourceFn = (_token, _chain, timestamp) => timestamp === Date.parse(buy.timestamp) ? 3 : null
    const result = await priceLotsForWallet({ normalizedEvents: [buy, sell], recoveredEvents: [], priceSources: { primary: stronger, fallback: stronger }, coinPaprikaFetchImpl: paprikaFetch })
    assert.equal(result.coinPaprikaHistoricalAudit.unresolvedRequirementsReceived, 2)
    assert.equal(result.priceLotsCanonicalGapAudit.numericPricedLots, 0)
    assert.equal(result.priceLotsCanonicalGapAudit.canonicalVerifiedLots, 0)
    assert.equal(result.priceUsdLookup(buy), 3)
  })

  it('separates numeric pricing from canonical verification and sends both unresolved sides to CoinPaprika', async () => {
    process.env.COINPAPRIKA_API_KEY = 'test'
    const events = [event(0, 'inbound'), event(0, 'outbound')]
    const numeric: PriceSourceFn = () => 3
    const result = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: { primary: numeric, fallback: numeric }, coinPaprikaFetchImpl: paprikaFetch })
    assert.equal(result.priceLotsCanonicalGapAudit.structuralLots, 1)
    assert.equal(result.priceLotsCanonicalGapAudit.numericPricedLots, 1)
    assert.equal(result.priceLotsCanonicalGapAudit.locallyMarkedVerifiedLots, 1)
    assert.equal(result.priceLotsCanonicalGapAudit.canonicalVerifiedLots, 0)
    assert.equal(result.priceLotsCanonicalGapAudit.falseVerifiedLots, 1)
    assert.equal(result.priceLotsCanonicalGapAudit.unresolvedCanonicalLots, 1)
    assert.equal(result.coinPaprikaHistoricalAudit.unresolvedRequirementsReceived, 2)
    assert.equal(result.coinPaprikaHistoricalAudit.pricesApplied, 0)
  })

  it('HARD ASSERTION: accepted-evidence warm rescan makes zero CoinPaprika HTTP calls', async () => {
    process.env.COINPAPRIKA_API_KEY = 'test'
    const buy = event(0, 'inbound')
    const sell = event(0, 'outbound')
    const identityBase = {
      chain: buy.chain, token: buy.contract,
      openedTxHash: buy.txHash, closedTxHash: sell.txHash,
      openedAt: Date.parse(buy.timestamp), closedAt: Date.parse(sell.timestamp),
      amount: buy.amount,
    }
    const version = lotIdentityVersion(identityBase)
    const now = 1_000_000
    const kv = fakeAcceptedEvidenceKv()
    for (const side of ['entry', 'exit'] as const) {
      const txHash = side === 'entry' ? buy.txHash : sell.txHash
      const timestamp = side === 'entry' ? identityBase.openedAt : identityBase.closedAt
      await kv.set(
        `v1:accepted-evidence:${buy.chain}:${buy.contract.toLowerCase()}:${txHash}:${side}:${timestamp}`,
        buildAcceptedEvidenceEnvelope({
          identity: { chain: buy.chain, token: buy.contract, txHash, side, timestamp, lotIdentityVersion: version },
          priceUsd: side === 'entry' ? 5 : 7, valueUsd: side === 'entry' ? 5 : 7,
          source: 'test', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now,
        }),
      )
    }
    let paprikaCalls = 0
    const result = await priceLotsForWallet({
      normalizedEvents: [buy, sell],
      recoveredEvents: [],
      priceSources: misses,
      acceptedEvidenceKv: kv,
      now: () => now,
      coinPaprikaFetchImpl: async () => { paprikaCalls += 1; return new Response('', { status: 500 }) },
    })
    assert.equal(result.coinPaprikaHistoricalAudit.unresolvedRequirementsReceived, 0)
    assert.equal(result.coinPaprikaHistoricalAudit.callsAttempted, 0)
    assert.equal(result.coinPaprikaHistoricalAudit.identityLookupsAttempted, 0)
    assert.equal(paprikaCalls, 0)
    assert.equal(result.priceLotsCanonicalGapAudit.canonicalVerifiedLots, 1)
  })
})
