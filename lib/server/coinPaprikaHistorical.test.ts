import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearCoinPaprikaCachesForTests,
  coinPaprikaPlatformForChain,
  isCoinPaprikaEligible,
  rankCoinPaprikaRequirements,
  resolveCoinPaprikaHistorical,
  COINPAPRIKA_HARD_MAX_CALLS,
  type CoinPaprikaRequirement,
} from './coinPaprikaHistorical'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const requirement = (overrides: Partial<CoinPaprikaRequirement> = {}): CoinPaprikaRequirement => ({
  chainId: '8453', contractAddress: ADDRESS, symbol: 'SAME', timestamp: '2024-01-02T12:00:00.000Z',
  lotCount: 1, lotsCompletedIfResolved: 1, sidesCompleted: 1, coverageGain: 10, notionalUsd: 100,
  hasRealTradeEvidence: true, canCompleteClosedLot: true, strongerSourcesExhausted: true, ...overrides,
})

function uniqueAddress(i: number): string {
  return `0x${(i + 1).toString(16).padStart(40, '0')}`
}

async function contractAndDailyPriceFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input)
  if (url.includes('/contracts/')) {
    const addr = (url.match(/0x[0-9a-f]{40}/i)?.[0] ?? ADDRESS).toLowerCase()
    return Response.json({ id: `coin-${addr.slice(2, 10)}`, platform_id: 'base-base', contract_address: addr })
  }
  return Response.json([{ time_open: '2024-01-02T00:00:00Z', close: 2.5 }])
}

test('no API key selects configured keyless Free mode without an Authorization header', async () => {
  clearCoinPaprikaCachesForTests()
  delete process.env.COINPAPRIKA_API_KEY
  delete process.env.COINPAPRIKA_API_BASE_URL
  delete process.env.COINPAPRIKA_ENABLED
  delete process.env.COINPAPRIKA_HISTORICAL_ENABLED
  let requestUrl = ''
  let requestHeaders: HeadersInit | undefined
  const result = await resolveCoinPaprikaHistorical([requirement()], { fetchImpl: async (input, init) => {
    requestUrl = String(input)
    requestHeaders = init?.headers
    return new Response('', { status: 500 })
  } })
  assert.equal(result.audit.mode, 'keyless_free')
  assert.equal(result.audit.apiKeyPresent, false)
  assert.equal(result.audit.configured, true)
  assert.equal(result.audit.baseUrlMode, 'free_default')
  assert.match(requestUrl, /^https:\/\/api\.coinpaprika\.com\/v1\/contracts\//)
  assert.equal(new Headers(requestHeaders).has('Authorization'), false)
})

test('API key selects authenticated mode and sends a Bearer header', async () => {
  clearCoinPaprikaCachesForTests()
  process.env.COINPAPRIKA_API_KEY = 'paid-test-key'
  delete process.env.COINPAPRIKA_API_BASE_URL
  let requestUrl = ''
  let authorization: string | null = null
  const result = await resolveCoinPaprikaHistorical([requirement()], { fetchImpl: async (input, init) => {
    requestUrl = String(input)
    authorization = new Headers(init?.headers).get('Authorization')
    return new Response('', { status: 500 })
  } })
  assert.equal(result.audit.mode, 'authenticated')
  assert.equal(result.audit.apiKeyPresent, true)
  assert.equal(result.audit.configured, true)
  assert.equal(result.audit.baseUrlMode, 'paid_default')
  assert.match(requestUrl, /^https:\/\/api-pro\.coinpaprika\.com\/v1\/contracts\//)
  assert.equal(authorization, 'Bearer paid-test-key')
})

test('disabled flag and zero budget still prevent provider calls', async () => {
  clearCoinPaprikaCachesForTests()
  delete process.env.COINPAPRIKA_API_KEY
  let calls = 0
  const fetchImpl = async () => { calls++; return new Response() }
  process.env.COINPAPRIKA_ENABLED = 'false'
  let result = await resolveCoinPaprikaHistorical([requirement()], { fetchImpl })
  assert.equal(result.audit.enabled, false)
  assert.equal(calls, 0)

  delete process.env.COINPAPRIKA_ENABLED
  process.env.COINPAPRIKA_MAX_CALLS_PER_SCAN = '0'
  result = await resolveCoinPaprikaHistorical([requirement()], { fetchImpl })
  assert.equal(result.audit.stoppedBecauseBudget, true)
  assert.equal(result.audit.configured, false)
  assert.equal(calls, 0)
  delete process.env.COINPAPRIKA_MAX_CALLS_PER_SCAN
})

test('maps only supported exact Base and Ethereum platforms', () => {
  assert.equal(coinPaprikaPlatformForChain('8453'), 'base-base')
  assert.equal(coinPaprikaPlatformForChain('1'), 'eth-ethereum')
  assert.equal(coinPaprikaPlatformForChain('137'), null)
})

test('dust, airdrop and ordinary transfers make zero calls', async () => {
  process.env.COINPAPRIKA_API_KEY = 'test'
  for (const excluded of [requirement({ dustNonEconomic: true }), requirement({ airdropOnly: true }), requirement({ ordinaryTransferOnly: true })]) {
    let calls = 0
    const result = await resolveCoinPaprikaHistorical([excluded], { fetchImpl: async () => { calls++; return new Response() } })
    assert.equal(calls, 0)
    assert.equal(result.audit.eligibleRequirements, 0)
  }
  assert.equal(isCoinPaprikaEligible(requirement()).eligible, true)
})

test('priority favors requirements completing more lots and useless sides are ineligible', () => {
  const one = requirement({ contractAddress: '0x2222222222222222222222222222222222222222', lotsCompletedIfResolved: 1 })
  const twenty = requirement({ lotsCompletedIfResolved: 20 })
  assert.equal(rankCoinPaprikaRequirements([one, twenty])[0], twenty)
  assert.equal(isCoinPaprikaEligible(requirement({ canCompleteClosedLot: false })).eligible, false)
})

test('exact contract identity and daily timestamp produce partial evidence; duplicates coalesce', async () => {
  clearCoinPaprikaCachesForTests(); process.env.COINPAPRIKA_API_KEY = 'test'
  let calls = 0
  const fetchImpl = async (input: string | URL | Request) => {
    calls++
    const url = String(input)
    if (url.includes('/contracts/')) return Response.json({ id: 'same-coin', platform_id: 'base-base', contract_address: ADDRESS })
    return Response.json([{ time_open: '2024-01-02T00:00:00Z', close: 2.5 }])
  }
  const result = await resolveCoinPaprikaHistorical([requirement(), requirement()], { fetchImpl })
  assert.equal(calls, 2)
  assert.equal(result.audit.uniqueRequestsAfterDedupe, 1)
  assert.equal(result.audit.budgetMax, 130)
  const evidence = [...result.evidence.values()][0]
  assert.equal(evidence.source, 'coinpaprika_historical')
  assert.equal(evidence.evidenceStatus, 'partial_unverified')
  assert.equal(result.audit.lotsCompleted, 0)
  assert.equal(result.audit.coverageAfter, result.audit.coverageBefore)
  assert.equal(result.audit.historicalEndpointUsed, 'ohlcv_historical_paid')
  assert.equal(result.audit.paidHistoryRequests, 1)
  assert.equal(result.audit.freeHistoryRequests, 0)
})

test('keyless Free mode uses ticker history, parses price, and coalesces a coin/day', async () => {
  clearCoinPaprikaCachesForTests(); delete process.env.COINPAPRIKA_API_KEY
  delete process.env.COINPAPRIKA_API_BASE_URL
  const requestedDay = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10)
  const requestedTimestamp = `${requestedDay}T10:00:00Z`
  const returnedTimestamp = `${requestedDay}T00:00:00Z`
  const urls: string[] = []
  const headers: HeadersInit[] = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); urls.push(url); headers.push(init?.headers ?? {})
    if (url.includes('/contracts/')) return Response.json({ id: 'same-coin', platform_id: 'base-base', contract_address: ADDRESS })
    return Response.json([
      { timestamp: new Date(Date.parse(returnedTimestamp) + 86_400_000).toISOString(), price: 9, close: 999 },
      { timestamp: returnedTimestamp, price: 2.5, close: 999, volume_24h: 10, market_cap: 20 },
    ])
  }
  const result = await resolveCoinPaprikaHistorical([
    requirement({ timestamp: requestedTimestamp }),
    requirement({ timestamp: requestedTimestamp }),
  ], { fetchImpl })
  const historicalUrls = urls.filter((url) => url.includes('/historical'))
  assert.equal(historicalUrls.length, 1)
  assert.match(historicalUrls[0], /\/v1\/tickers\/same-coin\/historical\?start=\d{4}-\d{2}-\d{2}&end=\d{4}-\d{2}-\d{2}&interval=1d$/)
  assert.equal(urls.some((url) => url.includes('/ohlcv/historical')), false)
  assert.equal(headers.some((value) => new Headers(value).has('Authorization')), false)
  const evidence = [...result.evidence.values()][0]
  assert.equal(evidence.priceUsd, 2.5)
  assert.equal(evidence.returnedTimestamp, returnedTimestamp)
  assert.equal(evidence.deltaSeconds, 36_000)
  assert.equal(result.audit.historicalEndpointUsed, 'ticker_historical_free')
  assert.equal(result.audit.freeHistoryRequests, 1)
  assert.equal(result.audit.paidHistoryRequests, 0)
  assert.equal(result.audit.uniqueRequestsAfterDedupe, 1)
})

test('keyless Free mode explicitly rejects requests outside its rolling history window', async () => {
  clearCoinPaprikaCachesForTests(); delete process.env.COINPAPRIKA_API_KEY
  let historicalCalls = 0
  const result = await resolveCoinPaprikaHistorical([requirement()], { fetchImpl: async (input) => {
    if (String(input).includes('/historical')) historicalCalls++
    return Response.json({ id: 'same-coin', platform_id: 'base-base', contract_address: ADDRESS })
  } })
  assert.equal(historicalCalls, 0)
  assert.equal(result.audit.freeHistoryOutOfRange, 1)
  assert.equal(result.audit.failuresByReason.free_history_out_of_range, 1)
  assert.equal(result.audit.exactDropReason, 'coinpaprika_free_history_out_of_range')
  assert.equal(result.evidence.size, 0)
})

test('HTTP 402 remains explicitly classified and produces no historical evidence', async () => {
  clearCoinPaprikaCachesForTests(); delete process.env.COINPAPRIKA_API_KEY
  const timestamp = new Date(Date.now() - 10 * 86_400_000).toISOString()
  const result = await resolveCoinPaprikaHistorical([requirement({ timestamp })], { fetchImpl: async (input) =>
    String(input).includes('/contracts/')
      ? Response.json({ id: 'same-coin', platform_id: 'base-base', contract_address: ADDRESS })
      : new Response('', { status: 402 })
  })
  assert.equal(result.audit.failuresByReason.http_402, 1)
  assert.equal(result.audit.freeHistoryRequests, 1)
  assert.equal(result.evidence.size, 0)
})

test('same ticker cannot bypass wrong contract or wrong chain identity', async () => {
  clearCoinPaprikaCachesForTests(); process.env.COINPAPRIKA_API_KEY = 'test'
  const fetchImpl = async () => Response.json({ id: 'first-symbol-result', platform_id: 'eth-ethereum', contract_address: '0x9999999999999999999999999999999999999999' })
  const result = await resolveCoinPaprikaHistorical([requirement()], { fetchImpl })
  assert.equal(result.evidence.size, 0)
  assert.equal(result.audit.identityRejected, 1)
  assert.equal(result.audit.failuresByReason.identity_mismatch, 1)
})

test('current or far-away prices are never accepted as historical', async () => {
  clearCoinPaprikaCachesForTests(); process.env.COINPAPRIKA_API_KEY = 'test'
  const fetchImpl = async (input: string | URL | Request) => String(input).includes('/contracts/')
    ? Response.json({ id: 'same-coin', platform_id: 'base-base', contract_address: ADDRESS })
    : Response.json([{ time_open: '2026-09-07T00:00:00Z', close: 999 }])
  const result = await resolveCoinPaprikaHistorical([requirement()], { fetchImpl })
  assert.equal(result.evidence.size, 0)
  assert.equal(result.audit.failuresByReason.timestamp_mismatch, 1)
})

test('hard request ceiling is never above 130 and provider failure is contained', async () => {
  clearCoinPaprikaCachesForTests(); process.env.COINPAPRIKA_API_KEY = 'test'; process.env.COINPAPRIKA_MAX_CALLS_PER_SCAN = '999'
  const many = Array.from({ length: 150 }, (_, i) => requirement({ contractAddress: uniqueAddress(i) }))
  const result = await resolveCoinPaprikaHistorical(many, { fetchImpl: async () => new Response('', { status: 500 }) })
  assert.equal(result.audit.callsAttempted, 130)
  assert.equal(result.audit.stoppedBecauseBudget, true)
  assert.equal(result.evidence.size, 0)
})

test('positive cache avoids repeat provider calls', async () => {
  clearCoinPaprikaCachesForTests(); process.env.COINPAPRIKA_API_KEY = 'test'; process.env.COINPAPRIKA_MAX_CALLS_PER_SCAN = '130'
  let calls = 0
  const fetchImpl = async (input: string | URL | Request) => {
    calls++
    return String(input).includes('/contracts/')
      ? Response.json({ id: 'same-coin', platform_id: 'base-base', contract_address: ADDRESS })
      : Response.json([{ time_open: '2024-01-02T00:00:00Z', close: 2.5 }])
  }
  await resolveCoinPaprikaHistorical([requirement()], { fetchImpl })
  await resolveCoinPaprikaHistorical([requirement()], { fetchImpl })
  assert.equal(calls, 2)
})

test('HARD ASSERTION: zero unresolved requirements make zero CoinPaprika HTTP calls', async () => {
  clearCoinPaprikaCachesForTests()
  process.env.COINPAPRIKA_API_KEY = 'test'
  let calls = 0
  const result = await resolveCoinPaprikaHistorical([], { fetchImpl: async () => { calls += 1; return new Response() } })
  assert.equal(calls, 0)
  assert.equal(result.audit.unresolvedRequirementsReceived, 0)
  assert.equal(result.audit.callsAttempted, 0)
  assert.equal(result.audit.identityLookupsAttempted, 0)
  assert.equal(result.audit.historicalRequestsPlanned, 0)
  assert.equal(result.audit.callsSucceeded, 0)
  assert.equal(result.audit.callsFailed, 0)
  assert.equal(result.audit.stoppedBecauseBudget, false)
  assert.equal(result.audit.budgetMax, COINPAPRIKA_HARD_MAX_CALLS)
})

test('HARD ASSERTION: accepted/persisted evidence and stronger sources still available make zero CoinPaprika HTTP calls', async () => {
  clearCoinPaprikaCachesForTests()
  process.env.COINPAPRIKA_API_KEY = 'test'
  let calls = 0
  const fetchImpl = async () => { calls += 1; return new Response() }
  const accepted = await resolveCoinPaprikaHistorical([requirement({ hasAcceptedEvidence: true })], { fetchImpl })
  const stronger = await resolveCoinPaprikaHistorical([requirement({ strongerSourcesExhausted: false })], { fetchImpl })
  assert.equal(calls, 0)
  assert.equal(accepted.audit.callsAttempted, 0)
  assert.equal(accepted.audit.filteredAcceptedEvidence, 1)
  assert.equal(stronger.audit.callsAttempted, 0)
  assert.equal(stronger.audit.filteredStrongerEvidenceAvailable, 1)
})

test('HARD ASSERTION: identity lookups and historical price requests share one global budget', async () => {
  clearCoinPaprikaCachesForTests()
  process.env.COINPAPRIKA_API_KEY = 'test'
  process.env.COINPAPRIKA_MAX_CALLS_PER_SCAN = '5'
  const many = Array.from({ length: 10 }, (_, i) => requirement({ contractAddress: uniqueAddress(i) }))
  let http = 0
  let identityHttp = 0
  let historicalHttp = 0
  const result = await resolveCoinPaprikaHistorical(many, {
    fetchImpl: async (input) => {
      http += 1
      const url = String(input)
      if (url.includes('/contracts/')) identityHttp += 1
      else historicalHttp += 1
      return contractAndDailyPriceFetch(input)
    },
  })
  assert.equal(result.audit.budgetMax, 5)
  assert.equal(http, 5)
  assert.equal(result.audit.callsAttempted, 5)
  assert.equal(result.audit.callsAttempted <= result.audit.budgetMax, true)
  assert.equal(result.audit.stoppedBecauseBudget, true)
  assert.ok(identityHttp > 0, 'identity lookups must consume the shared budget')
  assert.ok(historicalHttp > 0, 'historical requests must consume the same budget')
  assert.equal(identityHttp + historicalHttp, result.audit.callsAttempted)
  assert.ok(result.audit.identityLookupsAttempted > 0)
  assert.ok(result.audit.historicalRequestsPlanned > 0)
  delete process.env.COINPAPRIKA_MAX_CALLS_PER_SCAN
})

test('HARD ASSERTION: many unresolved assets never exceed the 130 hard ceiling across identity + historical HTTP', async () => {
  clearCoinPaprikaCachesForTests()
  process.env.COINPAPRIKA_API_KEY = 'test'
  process.env.COINPAPRIKA_MAX_CALLS_PER_SCAN = '999'
  const many = Array.from({ length: 200 }, (_, i) => requirement({ contractAddress: uniqueAddress(i) }))
  let http = 0
  const result = await resolveCoinPaprikaHistorical(many, {
    fetchImpl: async (input) => {
      http += 1
      return contractAndDailyPriceFetch(input)
    },
  })
  assert.equal(result.audit.budgetMax, COINPAPRIKA_HARD_MAX_CALLS)
  assert.equal(http, COINPAPRIKA_HARD_MAX_CALLS)
  assert.equal(result.audit.callsAttempted, COINPAPRIKA_HARD_MAX_CALLS)
  assert.equal(result.audit.callsAttempted <= result.audit.budgetMax, true)
  assert.equal(result.audit.stoppedBecauseBudget, true)
  assert.ok(result.audit.identityLookupsAttempted > 0)
  assert.ok(result.audit.historicalRequestsPlanned > 0)
  assert.ok(result.evidence.size > 0)
  assert.ok(result.evidence.size < many.length, 'uncapped remainder must stay unresolved')
  delete process.env.COINPAPRIKA_MAX_CALLS_PER_SCAN
})

test('HARD ASSERTION: 429/500 failures are not retried and cannot bypass the cap', async () => {
  clearCoinPaprikaCachesForTests()
  process.env.COINPAPRIKA_API_KEY = 'test'
  process.env.COINPAPRIKA_MAX_CALLS_PER_SCAN = '4'
  const urls: string[] = []
  const many = Array.from({ length: 12 }, (_, i) => requirement({ contractAddress: uniqueAddress(i) }))
  const result = await resolveCoinPaprikaHistorical(many, {
    fetchImpl: async (input) => {
      urls.push(String(input))
      return new Response('', { status: urls.length % 2 === 0 ? 500 : 429 })
    },
  })
  assert.equal(urls.length, 4)
  assert.equal(result.audit.callsAttempted, 4)
  assert.equal(result.audit.callsFailed, 4)
  assert.equal(result.audit.callsSucceeded, 0)
  assert.equal(result.audit.stoppedBecauseBudget, true)
  assert.equal(result.evidence.size, 0)
  assert.equal(new Set(urls).size, urls.length, 'a failed URL must not be retried')
  delete process.env.COINPAPRIKA_MAX_CALLS_PER_SCAN
})

test('HARD ASSERTION: once the cap is exhausted remaining requirements fail closed', async () => {
  clearCoinPaprikaCachesForTests()
  process.env.COINPAPRIKA_API_KEY = 'test'
  process.env.COINPAPRIKA_MAX_CALLS_PER_SCAN = '3'
  const many = Array.from({ length: 8 }, (_, i) => requirement({ contractAddress: uniqueAddress(i) }))
  const result = await resolveCoinPaprikaHistorical(many, { fetchImpl: contractAndDailyPriceFetch })
  assert.equal(result.audit.callsAttempted, 3)
  assert.equal(result.audit.stoppedBecauseBudget, true)
  // 3 shared-budget calls: identity, historical, identity. One priced coin, rest unresolved.
  assert.equal(result.evidence.size, 1)
  assert.equal(result.audit.callsAttempted <= result.audit.budgetMax, true)
  assert.equal(typeof result.audit.budgetMax, 'number')
  assert.equal(typeof result.audit.identityLookupsAttempted, 'number')
  assert.equal(typeof result.audit.historicalRequestsPlanned, 'number')
  assert.equal(typeof result.audit.callsSucceeded, 'number')
  assert.equal(typeof result.audit.callsFailed, 'number')
  delete process.env.COINPAPRIKA_MAX_CALLS_PER_SCAN
})
