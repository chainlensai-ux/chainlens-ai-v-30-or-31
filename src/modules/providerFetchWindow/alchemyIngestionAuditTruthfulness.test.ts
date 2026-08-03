// TESTS — observability/public-evidence-truthfulness task, bug #1: [alchemy-history-ingestion-audit]
// counters.
//
// Production proof: 2 Base Alchemy calls returned HTTP 429, the circuit prevented both ETH calls,
// actual Alchemy calls = 2, estimated CU = 300. The OLD `pagesSucceeded` formula
// (`liveCalls - malformedResponses - nullResponses`) reported 2 — since a 429 counts toward neither
// counter after the prior tasks' fixes — falsely claiming both real calls "succeeded" when both
// actually returned 429 and produced 0 events. `httpErrors` also reported 0 (correct, since 429 is no
// longer bucketed as a generic HTTP error) but with nothing surfacing the real 429 count in its place.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchProviderWindow, resetProviderFetchWindowRequestCache } from './index'
import { __resetWalletProviderCostLedgerForTest } from '../providerCost/walletProviderCostLedger'

const originalFetch = global.fetch
const originalConsoleWarn = console.warn
const originalAlchemyBaseKey = process.env.ALCHEMY_BASE_KEY
const originalAlchemyEthKey = process.env.ALCHEMY_ETHEREUM_KEY
const originalGoldrushKey = process.env.GOLDRUSH_API_KEY

let warnCalls: unknown[][] = []

beforeEach(() => {
  __resetWalletProviderCostLedgerForTest()
  resetProviderFetchWindowRequestCache('ingestion-audit-truthfulness-test')
  process.env.ALCHEMY_BASE_KEY = 'test-alchemy-key'
  process.env.ALCHEMY_ETHEREUM_KEY = 'test-alchemy-key'
  process.env.GOLDRUSH_API_KEY = 'test-goldrush-key'
  warnCalls = []
  console.warn = (...args: unknown[]) => { warnCalls.push(args) }
})

afterEach(() => {
  global.fetch = originalFetch
  console.warn = originalConsoleWarn
  __resetWalletProviderCostLedgerForTest()
  resetProviderFetchWindowRequestCache()
  process.env.ALCHEMY_BASE_KEY = originalAlchemyBaseKey
  process.env.ALCHEMY_ETHEREUM_KEY = originalAlchemyEthKey
  process.env.GOLDRUSH_API_KEY = originalGoldrushKey
})

function findIngestionAuditLogs(): Record<string, unknown>[] {
  return warnCalls
    .filter((args) => args[0] === '[alchemy-history-ingestion-audit]')
    .map((args) => args[1] as Record<string, unknown>)
}

function mockGoldrushSuccess(): Response {
  return new Response(JSON.stringify({ data: { items: [] } }), { status: 200 })
}

test('HARD ASSERTION: the exact production scenario — 2 real Base 429s, then ETH fully circuit-prevented — never reports pagesSucceeded > 0 or httpErrors masking the 429s', async () => {
  global.fetch = (async (url: unknown) => {
    if (typeof url === 'string' && url.includes('covalenthq.com')) return mockGoldrushSuccess()
    return new Response('rate limited', { status: 429 })
  }) as unknown as typeof fetch

  await fetchProviderWindow('base', '0xwallet', 90, 'old-pipeline')
  await fetchProviderWindow('eth', '0xwallet', 90, 'old-pipeline')

  const logs = findIngestionAuditLogs()
  assert.equal(logs.length, 2, 'one ingestion-audit log per real (non-coalesced) fetch')

  const baseLog = logs.find((l) => l.chain === 'base')!
  assert.equal(baseLog.liveCalls, 2, 'Base made exactly 2 real Alchemy calls (from + to)')
  assert.equal(baseLog.pagesSucceeded, 0, 'HARD ASSERTION: 2 real 429s must never be counted as 2 succeeded pages')
  assert.equal(baseLog.http429Errors, 2, 'the 2 real 429s must be counted in their own dedicated counter')
  assert.equal(baseLog.httpErrors, 0, 'a 429 must never inflate the generic httpErrors counter either')
  assert.equal(baseLog.finalStatus, 'rate_limited')

  const ethLog = logs.find((l) => l.chain === 'eth')!
  assert.equal(ethLog.liveCalls, 0, 'HARD ASSERTION: circuit-prevented calls must never count as liveCalls')
  assert.equal(ethLog.preventedCalls, 2, 'both ETH sub-calls were prevented by the already-open circuit')
  assert.equal(ethLog.pagesSucceeded, 0)
  assert.equal(ethLog.finalStatus, 'circuit_open')
  assert.equal(ethLog.estimatedCu, 0, 'a circuit-prevented call must never contribute to the real spent-CU figure')
})

test('a genuine success is still counted as pagesSucceeded (no regression on the happy path)', async () => {
  global.fetch = (async (url: unknown) => {
    if (typeof url === 'string' && url.includes('covalenthq.com')) return mockGoldrushSuccess()
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { transfers: [] } }), { status: 200 })
  }) as unknown as typeof fetch

  await fetchProviderWindow('base', '0xwallet', 90, 'old-pipeline')

  const logs = findIngestionAuditLogs()
  const baseLog = logs.find((l) => l.chain === 'base')!
  assert.equal(baseLog.pagesSucceeded, 2)
  assert.equal(baseLog.http429Errors, 0)
  assert.equal(baseLog.finalStatus, 'ok')
})
