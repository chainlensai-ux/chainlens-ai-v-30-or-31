import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearCoinPaprikaCachesForTests,
  coinPaprikaPlatformForChain,
  isCoinPaprikaEligible,
  rankCoinPaprikaRequirements,
  resolveCoinPaprikaHistorical,
  type CoinPaprikaRequirement,
} from './coinPaprikaHistorical'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const requirement = (overrides: Partial<CoinPaprikaRequirement> = {}): CoinPaprikaRequirement => ({
  chainId: '8453', contractAddress: ADDRESS, symbol: 'SAME', timestamp: '2024-01-02T12:00:00.000Z',
  lotCount: 1, lotsCompletedIfResolved: 1, sidesCompleted: 1, coverageGain: 10, notionalUsd: 100,
  hasRealTradeEvidence: true, canCompleteClosedLot: true, strongerSourcesExhausted: true, ...overrides,
})

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
  assert.equal(result.audit.failuresByReason.timestamp_outside_daily_window, 1)
})

test('hard request ceiling is never above 130 and provider failure is contained', async () => {
  clearCoinPaprikaCachesForTests(); process.env.COINPAPRIKA_API_KEY = 'test'; process.env.COINPAPRIKA_MAX_CALLS_PER_SCAN = '999'
  const many = Array.from({ length: 150 }, (_, i) => requirement({ contractAddress: `0x${(i + 1).toString(16).padStart(40, '0')}` }))
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
