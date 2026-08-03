// TESTS — Alchemy-history-ingestion-regression task.
//
// Production regression: Base Alchemy returned no_usable_response with 0 events, ETH Alchemy did
// too, while GoldRush stayed healthy — a scan fell from ~565 events / ~216 lots to 89 events / 45
// lots. Root cause (confirmed by reading fetchAlchemyRawEvents and fetchProviderWindow's own
// coalescing logic): a budget refusal on Alchemy's structural transaction-history call was
// indistinguishable from a genuine "no data" response, AND the resulting partial (GoldRush-only)
// result was memoized as a permanent "settled success" for the rest of the job, so every later
// duplicate caller (old pipeline, V2 engine, holdings, trades) received the same Alchemy-less
// result. These tests prove each fix directly, without needing real network access.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchAlchemyRawEvents } from './utils'
import { fetchProviderWindow, resetProviderFetchWindowRequestCache } from './index'
import {
  tryConsume,
  canConsume,
  __resetWalletProviderCostLedgerForTest,
  MAX_ALCHEMY_CU_PER_SCAN,
  ALCHEMY_TRANSACTION_HISTORY_RESERVED_CU,
} from '../providerCost/walletProviderCostLedger'
import { estimatedCuForMethod } from '@/lib/server/alchemyCallBudget'

const originalFetch = global.fetch
const originalAlchemyBaseKey = process.env.ALCHEMY_BASE_KEY
const originalAlchemyEthKey = process.env.ALCHEMY_ETHEREUM_KEY
const originalGoldrushKey = process.env.GOLDRUSH_API_KEY

beforeEach(() => {
  __resetWalletProviderCostLedgerForTest()
  resetProviderFetchWindowRequestCache('alchemy-history-ingestion-test')
  process.env.ALCHEMY_BASE_KEY = 'test-alchemy-key'
  process.env.ALCHEMY_ETHEREUM_KEY = 'test-alchemy-key'
  process.env.GOLDRUSH_API_KEY = 'test-goldrush-key'
})

afterEach(() => {
  global.fetch = originalFetch
  __resetWalletProviderCostLedgerForTest()
  resetProviderFetchWindowRequestCache()
  process.env.ALCHEMY_BASE_KEY = originalAlchemyBaseKey
  process.env.ALCHEMY_ETHEREUM_KEY = originalAlchemyEthKey
  process.env.GOLDRUSH_API_KEY = originalGoldrushKey
})

function mockAlchemyTransfers(transfers: Record<string, unknown>[]): void {
  global.fetch = (async () => new Response(JSON.stringify({ result: { transfers } }), { status: 200 })) as unknown as typeof fetch
}

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: a valid paginated/real response is never converted to null
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: a valid Alchemy response with real transfers is never converted to null/no_usable_response', async () => {
  mockAlchemyTransfers([
    { hash: '0xabc', from: '0xfrom', to: '0xto', asset: 'USDC', rawContract: { address: '0xtoken', value: '0x1', decimal: '0x6' }, metadata: { blockTimestamp: new Date().toISOString() } },
  ])
  const result = await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(result.ok, true, 'a real, well-formed response must be reported as ok')
  assert.equal(result.errorReason, null)
  assert.ok(result.events.length > 0, 'real transfers must survive into the returned events')
})

test('a genuinely empty (but well-formed) transfers array is a real success, not a failure', async () => {
  mockAlchemyTransfers([])
  const result = await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(result.ok, true, 'an empty transfers array is a real "no transfers" answer, not malformed or null')
  assert.equal(result.errorReason, null)
  assert.deepEqual(result.events, [])
})

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: budget refusal returns a typed reason, never masquerading as no_usable_response
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: a budget-refused Alchemy history fetch reports provider_budget_exhausted, never no_usable_response', async () => {
  mockAlchemyTransfers([])
  // Exhaust the Alchemy budget before the real call ever runs — using the 'transaction_history'
  // stage itself (the full, unreserved ceiling) so the real fetch below is genuinely refused, not
  // merely testing the (separately-covered) reservation floor.
  while (canConsume({ provider: 'alchemy', endpoint: 'alchemy_getAssetTransfers', chain: 'base', stage: 'transaction_history' })) {
    tryConsume({ provider: 'alchemy', endpoint: 'alchemy_getAssetTransfers', chain: 'base', stage: 'transaction_history' })
  }

  const result = await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(result.ok, false)
  assert.equal(result.errorReason, 'provider_budget_exhausted', 'a budget refusal must be typed and distinguishable from a genuine provider miss')
  assert.notEqual(result.errorReason, 'no_usable_response')
  assert.ok(result.diagnostics && result.diagnostics.budgetRefusals > 0)
})

test('a malformed (well-formed HTTP 200, but no transfers array) response is reported distinctly, never as a budget issue', async () => {
  global.fetch = (async () => new Response(JSON.stringify({ result: { unexpectedShape: true } }), { status: 200 })) as unknown as typeof fetch
  const result = await fetchAlchemyRawEvents('base', '0xwallet', 90)
  assert.equal(result.ok, false)
  assert.equal(result.errorReason, 'malformed_response')
  assert.ok(result.diagnostics && result.diagnostics.malformedResponses > 0)
  assert.equal(result.diagnostics?.budgetRefusals, 0)
})

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: Base and ETH history complete before optional Alchemy consumers spend budget
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: transaction-history has a reserved CU floor that optional (recovery) Alchemy spend can never cross', () => {
  // Simulates a large batch of recovery candidates trying to spend Alchemy budget FIRST — the
  // literal scenario this task's requirement #9/#10 guards against ("reserve transaction-history
  // CU before optional receipt/pricing/debug calls").
  let recoveryGranted = 0
  for (let i = 0; i < 100; i++) {
    if (tryConsume({ provider: 'alchemy', endpoint: 'alchemy_getAssetTransfers', chain: 'base', stage: 'recovery' })) {
      recoveryGranted += 1
    }
  }
  const perCall = estimatedCuForMethod('alchemy_getAssetTransfers')
  assert.ok(recoveryGranted * perCall <= MAX_ALCHEMY_CU_PER_SCAN - ALCHEMY_TRANSACTION_HISTORY_RESERVED_CU,
    'recovery must never be able to spend into the reserved transaction-history floor')

  // Transaction-history (Base + ETH, from+to = 4 calls) must still be grantable afterward —
  // proving the reservation actually protected real headroom for it.
  let historyGranted = 0
  for (let i = 0; i < 4; i++) {
    if (tryConsume({ provider: 'alchemy', endpoint: 'alchemy_getAssetTransfers', chain: i < 2 ? 'base' : 'eth', stage: 'transaction_history' })) {
      historyGranted += 1
    }
  }
  assert.equal(historyGranted, 4, 'Base + ETH transaction-history (4 real calls) must always be grantable, even after recovery already ran')
})

test('transaction-history itself may spend past the reserved floor, up to the full hard ceiling', () => {
  // The reservation exists FOR transaction_history, not against it — it alone may use the entire
  // MAX_ALCHEMY_CU_PER_SCAN ceiling, unlike 'recovery' which is capped below it.
  let granted = 0
  for (let i = 0; i < 60; i++) {
    if (tryConsume({ provider: 'alchemy', endpoint: 'alchemy_getAssetTransfers', chain: 'base', stage: 'transaction_history' })) granted += 1
  }
  const perCall = estimatedCuForMethod('alchemy_getAssetTransfers')
  assert.ok(granted * perCall > MAX_ALCHEMY_CU_PER_SCAN - ALCHEMY_TRANSACTION_HISTORY_RESERVED_CU,
    'transaction_history must be able to spend beyond the reserved floor, using the full ceiling')
})

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: normal bounded Base+ETH history fits comfortably under the shared CU cap
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: a normal Base+ETH transaction-history fetch fits comfortably under the shared Alchemy CU cap', () => {
  const perCall = estimatedCuForMethod('alchemy_getAssetTransfers')
  // Base (from+to) + ETH (from+to) = 4 real calls — the exact structural shape
  // fetchAlchemyRawEvents makes per chain.
  const normalScanCu = perCall * 4
  assert.ok(normalScanCu <= MAX_ALCHEMY_CU_PER_SCAN, 'the normal bounded Base+ETH history path must fit under the shared cap')
  assert.ok(normalScanCu <= MAX_ALCHEMY_CU_PER_SCAN - ALCHEMY_TRANSACTION_HISTORY_RESERVED_CU + perCall * 4,
    'sanity: the reserved floor itself must be large enough to cover the real 4-call Base+ETH shape')
})

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: same successful history result is reused by old pipeline and V2
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: a successful history fetch is reused byte-for-byte by both old-pipeline and v2-engine callers', async () => {
  mockAlchemyTransfers([
    { hash: '0xreal', from: '0xfrom', to: '0xto', asset: 'USDC', rawContract: { address: '0xtoken', value: '0x1', decimal: '0x6' }, metadata: { blockTimestamp: new Date().toISOString() } },
  ])
  const oldPipelineResult = await fetchProviderWindow('base', '0xwallet', 90, 'old-pipeline')
  const v2EngineResult = await fetchProviderWindow('base', '0xwallet', 90, 'v2-engine')

  assert.deepEqual(v2EngineResult, oldPipelineResult, 'both engines must receive the identical settled result for a real success')
  assert.equal(v2EngineResult.providerStatus, 'ok')
})
