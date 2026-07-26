// Regression tests for bounded, shadow-mode Alchemy historical closed-lot pricing —
// alchemyHistoricalPriceSource.ts. SHADOW MODE, DISCLOSED: this module only ever records what
// Alchemy's real historical-price endpoint would resolve; it never writes into FIFO/PnL/coverage.
//
// Run with:
//   npx tsx --test src/modules/pricingAtTimeEngine/sources/alchemyHistoricalPriceSource.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveAlchemyHistoricalPricesShadow,
  resetAlchemyHistoricalPricingState,
  MAX_ALCHEMY_HISTORICAL_REQUESTS_PER_SCAN,
  type AlchemyPricingRequirement,
} from './alchemyHistoricalPriceSource'

const originalFetch = global.fetch
const originalKey = process.env.ALCHEMY_API_KEY

beforeEach(() => {
  resetAlchemyHistoricalPricingState()
  process.env.ALCHEMY_API_KEY = 'test-alchemy-key'
})

afterEach(() => {
  global.fetch = originalFetch
  if (originalKey === undefined) delete process.env.ALCHEMY_API_KEY
  else process.env.ALCHEMY_API_KEY = originalKey
})

const MEME = '0x0000000000000000000000000000000000000900'

function req(overrides: Partial<AlchemyPricingRequirement> = {}): AlchemyPricingRequirement {
  return {
    chain: 'eth',
    token: MEME,
    txHash: '0xtx',
    timestamp: Date.parse('2026-01-01T00:00:00.000Z'),
    oneSideMissing: true,
    ...overrides,
  }
}

function mockAlchemySuccess(priceUsd: number): { calls: number; getCalls: () => number } {
  const state = { calls: 0 }
  global.fetch = (async () => {
    state.calls += 1
    return new Response(JSON.stringify({ data: [{ timestamp: '2026-01-01T00:00:00.000Z', value: String(priceUsd) }] }), { status: 200 })
  }) as unknown as typeof fetch
  return { calls: state.calls, getCalls: () => state.calls }
}

describe('alchemyHistoricalPriceSource — bounded, shadow-mode', () => {
  it('1. 40 ETH trades of the SAME token collapse into one bounded range = 1 call, not 40', async () => {
    const { getCalls } = mockAlchemySuccess(3500)
    const requirements: AlchemyPricingRequirement[] = Array.from({ length: 40 }, (_, i) =>
      req({ txHash: `0xtrade${i}`, timestamp: Date.parse('2026-01-01T00:00:00.000Z') + i * 60_000, oneSideMissing: true }),
    )

    const { audit } = await resolveAlchemyHistoricalPricesShadow(requirements)

    assert.equal(getCalls(), 1, 'exactly one real HTTP request for 40 trades of the same asset')
    assert.equal(audit.liveRequests, 1)
    assert.equal(audit.eligibleRequirements, 40)
    assert.equal(audit.uniqueAssets, 1)
  })

  it('2. duplicate concurrent requests for the same asset coalesce', async () => {
    let liveCalls = 0
    global.fetch = (async () => {
      liveCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return new Response(JSON.stringify({ data: [{ timestamp: '2026-01-01T00:00:00.000Z', value: '3500' }] }), { status: 200 })
    }) as unknown as typeof fetch

    const requirements: AlchemyPricingRequirement[] = [
      req({ txHash: '0xa', timestamp: Date.parse('2026-01-01T00:00:00.000Z') }),
      req({ txHash: '0xb', timestamp: Date.parse('2026-01-01T00:00:00.000Z') }),
    ]

    const [{ audit: auditA }, { audit: auditB }] = await Promise.all([
      resolveAlchemyHistoricalPricesShadow([requirements[0]]),
      resolveAlchemyHistoricalPricesShadow([requirements[1]]),
    ])

    assert.equal(liveCalls, 1, 'two concurrent requests for the identical (asset, range) must share one live call')
    assert.ok(auditA.liveRequests + auditA.coalescedHits >= 1)
    assert.ok(auditB.liveRequests + auditB.coalescedHits >= 1)
  })

  it('3. already-priced/holdings-only/dust tokens produce zero calls (never submitted as requirements)', async () => {
    let calls = 0
    global.fetch = (async () => { calls += 1; return new Response(JSON.stringify({ data: [] }), { status: 200 }) }) as unknown as typeof fetch

    const { audit } = await resolveAlchemyHistoricalPricesShadow([])

    assert.equal(calls, 0)
    assert.equal(audit.liveRequests, 0)
    assert.equal(audit.eligibleRequirements, 0)
  })

  it('4. 11 unique assets caps at 10 live calls / 400 CU', async () => {
    let liveCalls = 0
    global.fetch = (async () => {
      liveCalls += 1
      return new Response(JSON.stringify({ data: [{ timestamp: '2026-01-01T00:00:00.000Z', value: '1' }] }), { status: 200 })
    }) as unknown as typeof fetch

    const requirements: AlchemyPricingRequirement[] = Array.from({ length: 11 }, (_, i) =>
      req({ token: `0x${(1000 + i).toString().padStart(40, '0')}`, txHash: `0xasset${i}`, oneSideMissing: false }),
    )

    const { audit } = await resolveAlchemyHistoricalPricesShadow(requirements)

    assert.equal(liveCalls, MAX_ALCHEMY_HISTORICAL_REQUESTS_PER_SCAN)
    assert.equal(audit.liveRequests, 10)
    assert.equal(audit.estimatedCu, 400)
    assert.equal(audit.cappedRequests, 1, 'the 11th distinct asset must be capped, not fetched')
    assert.equal(audit.uniqueAssets, 11)
  })

  it('5. duplicateRequestCount stays 0 when every asset+range combination is genuinely unique this scan', async () => {
    mockAlchemySuccess(3500)
    const requirements: AlchemyPricingRequirement[] = [
      req({ token: '0x0000000000000000000000000000000000000a01', txHash: '0xu1' }),
      req({ token: '0x0000000000000000000000000000000000000a02', txHash: '0xu2' }),
    ]

    const { audit } = await resolveAlchemyHistoricalPricesShadow(requirements)

    assert.equal(audit.duplicateRequestCount, 0)
  })

  it('priority order: ETH/WETH/stables first, then one-side-missing, then everything else', async () => {
    const requestedAssets: string[] = []
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {}
      requestedAssets.push(body.address)
      return new Response(JSON.stringify({ data: [{ timestamp: '2026-01-01T00:00:00.000Z', value: '1' }] }), { status: 200 })
    }) as unknown as typeof fetch

    const WETH_ETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
    const otherToken = '0x0000000000000000000000000000000000000b01'
    const oneSideMissingToken = '0x0000000000000000000000000000000000000b02'

    const requirements: AlchemyPricingRequirement[] = [
      req({ token: WETH_ETH.toLowerCase(), txHash: '0xweth', oneSideMissing: false }),
      req({ token: otherToken, txHash: '0xother', oneSideMissing: false }),
      req({ token: oneSideMissingToken, txHash: '0xmissing', oneSideMissing: true }),
    ]

    await resolveAlchemyHistoricalPricesShadow(requirements)

    assert.equal(requestedAssets[0], WETH_ETH.toLowerCase(), 'ETH/WETH/stables must be requested first')
    assert.equal(requestedAssets[1], oneSideMissingToken, 'one-side-missing lots come next')
    assert.equal(requestedAssets[2], otherToken, 'everything else comes last')
  })

  it('priority: an asset with a prior Alchemy success this scan is requested before an untested one, but still after ETH/WETH/stables and one-side-missing', async () => {
    const requestedAssets: string[] = []
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {}
      requestedAssets.push(body.address)
      return new Response(JSON.stringify({ data: [{ timestamp: '2026-01-01T00:00:00.000Z', value: '1' }] }), { status: 200 })
    }) as unknown as typeof fetch

    const provenToken = '0x0000000000000000000000000000000000000c01'
    const untestedToken = '0x0000000000000000000000000000000000000c02'

    // First call establishes "prior success" for provenToken.
    await resolveAlchemyHistoricalPricesShadow([req({ token: provenToken, txHash: '0xproven1', oneSideMissing: false })])
    requestedAssets.length = 0

    // Second call: an untested asset arrives alongside a fresh requirement for the proven asset, at
    // a NEW timestamp so its range differs from call 1's (cached) range and produces a genuine new
    // live fetch — otherwise it would silently reuse the cache and never appear in requestedAssets.
    await resolveAlchemyHistoricalPricesShadow([
      req({ token: untestedToken, txHash: '0xuntested', oneSideMissing: false }),
      req({ token: provenToken, txHash: '0xproven2', oneSideMissing: false, timestamp: Date.parse('2026-02-01T00:00:00.000Z') }),
    ])

    assert.equal(requestedAssets[0], provenToken, 'the asset with a prior success this scan is requested first among equals')
    assert.equal(requestedAssets[1], untestedToken)
  })

  it('priority: unknown Base microcaps sort after other tier-4 assets', async () => {
    const requestedAssets: string[] = []
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {}
      requestedAssets.push(body.address)
      return new Response(JSON.stringify({ data: [{ timestamp: '2026-01-01T00:00:00.000Z', value: '1' }] }), { status: 200 })
    }) as unknown as typeof fetch

    const baseMicrocap = '0x0000000000000000000000000000000000000d01'
    const ethOther = '0x0000000000000000000000000000000000000d02'

    await resolveAlchemyHistoricalPricesShadow([
      req({ chain: 'base', token: baseMicrocap, txHash: '0xbasemicro', oneSideMissing: false }),
      req({ chain: 'eth', token: ethOther, txHash: '0xethother', oneSideMissing: false }),
    ])

    assert.equal(requestedAssets[0], ethOther, 'a non-Base tier-4 asset is requested before an unknown Base microcap')
    assert.equal(requestedAssets[1], baseMicrocap)
  })

  it('shadow mode never produces a price value the caller could accidentally use as an official one without opting in — it is returned separately from any FIFO/PnL structure', async () => {
    mockAlchemySuccess(3500)
    const requirements: AlchemyPricingRequirement[] = [req({ txHash: '0xshadow1' })]
    const { shadowPricesByTxHash } = await resolveAlchemyHistoricalPricesShadow(requirements)
    assert.equal(shadowPricesByTxHash.get('0xshadow1'), 3500)
    // The function returns a plain, separate Map — never mutates any FIFO/PnL object; there is
    // nothing here for a caller to accidentally consume without explicitly reading this return value.
  })

  it('temporal acceptance: a non-tier2 token price found more than 6 hours away is rejected', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ timestamp: '2026-01-01T00:00:00.000Z', value: '3500' }] }), { status: 200 })) as unknown as typeof fetch

    const requirements: AlchemyPricingRequirement[] = [
      req({ txHash: '0xfar', timestamp: Date.parse('2026-01-01T00:00:00.000Z') + 7 * 60 * 60 * 1000 }),
    ]
    const { shadowPricesByTxHash, audit } = await resolveAlchemyHistoricalPricesShadow(requirements)

    assert.equal(shadowPricesByTxHash.has('0xfar'), false, 'a price 7 hours away must be rejected for a non-tier2 asset (6h max)')
    assert.equal(audit.rejectedByTemporalDistance, 1)
    assert.equal(audit.acceptedRequirementsResolved, 0)
    assert.equal(audit.failureReasons.temporal_distance_exceeded, 1)
  })

  it('temporal acceptance: a non-tier2 token price found within 6 hours is accepted', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ timestamp: '2026-01-01T00:00:00.000Z', value: '3500' }] }), { status: 200 })) as unknown as typeof fetch

    const requirements: AlchemyPricingRequirement[] = [
      req({ txHash: '0xclose', timestamp: Date.parse('2026-01-01T00:00:00.000Z') + 5 * 60 * 60 * 1000 }),
    ]
    const { shadowPricesByTxHash, audit } = await resolveAlchemyHistoricalPricesShadow(requirements)

    assert.equal(shadowPricesByTxHash.get('0xclose'), 3500)
    assert.equal(audit.rejectedByTemporalDistance, 0)
    assert.equal(audit.acceptedRequirementsResolved, 1)
  })

  it('temporal acceptance: ETH/WETH/stables get a wider 24-hour window than other tokens', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ timestamp: '2026-01-01T00:00:00.000Z', value: '3500' }] }), { status: 200 })) as unknown as typeof fetch

    const WETH_ETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
    const requirements: AlchemyPricingRequirement[] = [
      req({ token: WETH_ETH, txHash: '0xwethfar', timestamp: Date.parse('2026-01-01T00:00:00.000Z') + 20 * 60 * 60 * 1000, oneSideMissing: false }),
    ]
    const { shadowPricesByTxHash, audit } = await resolveAlchemyHistoricalPricesShadow(requirements)

    assert.equal(shadowPricesByTxHash.get('0xwethfar'), 3500, 'a 20h distance is within WETH/stables 24h window, unlike other tokens')
    assert.equal(audit.rejectedByTemporalDistance, 0)
  })

  it('logs a typed http_400 diagnostic (chain, token, network, range, interval, error code/message) without ever logging the API key', async () => {
    process.env.ALCHEMY_API_KEY = 'super-secret-key-value'
    global.fetch = (async () =>
      new Response(JSON.stringify({ code: 'INVALID_RANGE', message: 'startTime must be before endTime' }), { status: 400 })) as unknown as typeof fetch

    const logs: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { logs.push(args) }
    try {
      await resolveAlchemyHistoricalPricesShadow([req({ txHash: '0xbad' })])
    } finally {
      console.warn = originalWarn
    }

    const http400Log = logs.find((args) => args[0] === '[alchemy-historical-pricing-shadow] http_400')
    assert.ok(http400Log, 'expected an http_400 diagnostic log entry')
    const detail = http400Log?.[1] as Record<string, unknown>
    assert.equal(detail.chain, 'eth')
    assert.equal(detail.token, MEME)
    assert.equal(detail.network, 'eth-mainnet')
    assert.equal(detail.interval, '1d')
    assert.equal(detail.errorCode, 'INVALID_RANGE')
    assert.equal(detail.errorMessage, 'startTime must be before endTime')
    assert.equal(detail.classifiedReason, 'invalid_request', 'an INVALID_RANGE code must classify as invalid_request')
    assert.ok(typeof detail.startTime === 'string' && typeof detail.endTime === 'string')

    const serialized = JSON.stringify(logs)
    assert.equal(serialized.includes('super-secret-key-value'), false, 'the API key must never appear in any log output')
  })

  it('classifies a "Token not found" 400 body as token_not_found', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ message: 'Token not found' }), { status: 400 })) as unknown as typeof fetch

    const { audit } = await resolveAlchemyHistoricalPricesShadow([req({ txHash: '0xnotfound' })])

    assert.equal(audit.failureReasons.token_not_found, 1)
  })

  it('classifies the REAL production shape { errorMessage: { message: "Token not found: 0x..." } } as token_not_found', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ errorMessage: { message: `Token not found: ${MEME}` } }), { status: 400 })) as unknown as typeof fetch

    const { audit } = await resolveAlchemyHistoricalPricesShadow([req({ txHash: '0xrealshape' })])

    assert.equal(audit.failureReasons.token_not_found, 1, 'the real production { errorMessage: { message } } shape must classify correctly')
  })

  it('classifies { error: { message: "Token NOT FOUND" } } (case-insensitive, nested error.message shape) as token_not_found', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'Token NOT FOUND' } }), { status: 400 })) as unknown as typeof fetch

    const { audit } = await resolveAlchemyHistoricalPricesShadow([req({ txHash: '0xnestederror' })])

    assert.equal(audit.failureReasons.token_not_found, 1)
  })

  it('classifies a bare string 400 body as token_not_found when it says "not found"', async () => {
    global.fetch = (async () => new Response(JSON.stringify('Not Found'), { status: 400 })) as unknown as typeof fetch

    const { audit } = await resolveAlchemyHistoricalPricesShadow([req({ txHash: '0xbarestring' })])

    assert.equal(audit.failureReasons.token_not_found, 1)
  })

  it('a token_not_found classification from the real production shape enters the negative cache', async () => {
    let calls = 0
    global.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ errorMessage: { message: `Token not found: ${MEME}` } }), { status: 400 })
    }) as unknown as typeof fetch

    await resolveAlchemyHistoricalPricesShadow([req({ txHash: '0xneg1', timestamp: Date.parse('2026-01-01T00:00:00.000Z') })])
    assert.equal(calls, 1)

    const { audit } = await resolveAlchemyHistoricalPricesShadow([
      req({ txHash: '0xneg2', timestamp: Date.parse('2026-03-01T00:00:00.000Z') }),
    ])

    assert.equal(calls, 1, 'the negative cache must prevent a second live call for the same token, even with a different range')
    assert.ok(audit.negativeCacheHits >= 1)
  })

  it('classifies an unrecognized 400 body as http_400_unknown', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ message: 'rate limited for some other reason' }), { status: 400 })) as unknown as typeof fetch

    const { audit } = await resolveAlchemyHistoricalPricesShadow([req({ txHash: '0xweird' })])

    assert.equal(audit.failureReasons.http_400_unknown, 1)
  })

  it('negative cache: a token_not_found asset is never requested again this scan, even for a fresh requirement/range', async () => {
    let calls = 0
    global.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ message: 'Token not found' }), { status: 400 })
    }) as unknown as typeof fetch

    const notFoundToken = '0x0000000000000000000000000000000000000e01'
    await resolveAlchemyHistoricalPricesShadow([req({ token: notFoundToken, txHash: '0xnf1', timestamp: Date.parse('2026-01-01T00:00:00.000Z') })])
    assert.equal(calls, 1)

    const { audit } = await resolveAlchemyHistoricalPricesShadow([
      req({ token: notFoundToken, txHash: '0xnf2', timestamp: Date.parse('2026-02-01T00:00:00.000Z') }),
    ])

    assert.equal(calls, 1, 'a second call with a different range for the same negatively-cached token must not hit the network again')
    assert.ok(audit.negativeCacheHits >= 1)
  })
})
