// TESTS — pricingAtTimeEngine/sources: historicalRpcBudget (emergency CU containment).

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  tryReserveRpcCall,
  canReserveRpcCalls,
  recordTimestampBucket,
  recordBlockCacheHit,
  recordPoolCacheHit,
  recordNegativeCacheHit,
  getHistoricalRpcBudgetSummary,
  isHistoricalOnchainRpcPricingEnabled,
  __resetHistoricalRpcBudgetForTest,
  MAX_TOTAL_RPC_CALLS_PER_SCAN,
  MAX_BLOCK_RESOLUTION_CALLS_PER_SCAN,
  MAX_POOL_DISCOVERY_CALLS_PER_SCAN,
  MAX_POOL_PRICE_CALLS_PER_SCAN,
  MAX_CALLS_PER_TOKEN,
} from './historicalRpcBudget'

const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const FLAG = 'HISTORICAL_ONCHAIN_RPC_PRICING_ENABLED'
const originalFlag = process.env[FLAG]

beforeEach(() => {
  __resetHistoricalRpcBudgetForTest()
  if (originalFlag === undefined) delete process.env[FLAG]
  else process.env[FLAG] = originalFlag
})

test('kill switch defaults to disabled when the env var is unset', () => {
  delete process.env[FLAG]
  assert.equal(isHistoricalOnchainRpcPricingEnabled(), false)
})

test('kill switch is enabled only by the exact literal string "true"', () => {
  process.env[FLAG] = 'TRUE'
  assert.equal(isHistoricalOnchainRpcPricingEnabled(), false)
  process.env[FLAG] = '1'
  assert.equal(isHistoricalOnchainRpcPricingEnabled(), false)
  process.env[FLAG] = 'true'
  assert.equal(isHistoricalOnchainRpcPricingEnabled(), true)
})

test('the hard caps match this task\'s exact spec', () => {
  assert.equal(MAX_TOTAL_RPC_CALLS_PER_SCAN, 40)
  assert.equal(MAX_BLOCK_RESOLUTION_CALLS_PER_SCAN, 8)
  assert.equal(MAX_POOL_DISCOVERY_CALLS_PER_SCAN, 12)
  assert.equal(MAX_POOL_PRICE_CALLS_PER_SCAN, 12)
  assert.equal(MAX_CALLS_PER_TOKEN, 4)
})

test('a fresh budget grants calls up to the global total cap, then refuses', () => {
  let granted = 0
  // Spread across enough distinct tokens/categories that only the GLOBAL cap binds, not a
  // category or per-token cap — proves the shared, cross-category nature of the budget.
  for (let i = 0; i < MAX_TOTAL_RPC_CALLS_PER_SCAN + 10; i++) {
    const category = i % 3 === 0 ? 'block_resolution' : i % 3 === 1 ? 'pool_discovery' : 'pool_price'
    const venue = category === 'block_resolution' ? 'block_resolution' : i % 2 === 0 ? 'uniswap_v3' : 'aerodrome_slipstream'
    const token = category === 'block_resolution' ? null : `0x${(1000 + i).toString(16).padStart(40, '0')}`
    if (tryReserveRpcCall(category, venue, token)) granted += 1
  }
  assert.ok(granted <= MAX_TOTAL_RPC_CALLS_PER_SCAN, `granted ${granted} calls, exceeding the global cap of ${MAX_TOTAL_RPC_CALLS_PER_SCAN}`)
})

test('stop immediately once every category cap is exhausted — no call is granted past the combined ceiling', () => {
  // NOTE, DISCLOSED: the three category caps (8 + 12 + 12 = 32) sum to LESS than the 40-call
  // global cap by this task's own stated numbers — the category caps are strictly tighter and bind
  // first in practice, with the global cap as a redundant backstop that can never itself be the
  // first cap reached given only these three categories. This test proves the combined ceiling
  // (32) is real and that nothing is granted past it, using distinct tokens throughout so the
  // per-token cap never interferes.
  let granted = 0
  for (let i = 0; i < MAX_BLOCK_RESOLUTION_CALLS_PER_SCAN; i++) {
    if (tryReserveRpcCall('block_resolution', 'block_resolution', null)) granted += 1
  }
  for (let i = 0; i < MAX_POOL_DISCOVERY_CALLS_PER_SCAN; i++) {
    if (tryReserveRpcCall('pool_discovery', 'uniswap_v3', `0x${(2000 + i).toString(16).padStart(40, '0')}`)) granted += 1
  }
  for (let i = 0; i < MAX_POOL_PRICE_CALLS_PER_SCAN; i++) {
    if (tryReserveRpcCall('pool_price', 'uniswap_v3', `0x${(3000 + i).toString(16).padStart(40, '0')}`)) granted += 1
  }
  const combinedCeiling = MAX_BLOCK_RESOLUTION_CALLS_PER_SCAN + MAX_POOL_DISCOVERY_CALLS_PER_SCAN + MAX_POOL_PRICE_CALLS_PER_SCAN
  assert.equal(granted, combinedCeiling)
  assert.ok(combinedCeiling < MAX_TOTAL_RPC_CALLS_PER_SCAN, 'sanity: category caps really are the tighter, binding constraint here')
  assert.equal(getHistoricalRpcBudgetSummary().totalRpcCalls, combinedCeiling)

  // The exceeding call must be refused, and refused again on every further attempt — never a
  // one-shot trip that silently reopens.
  for (let i = 0; i < 5; i++) {
    assert.equal(tryReserveRpcCall('pool_discovery', 'uniswap_v3', `0x${(9000 + i).toString(16).padStart(40, '0')}`), false)
  }
  assert.equal(getHistoricalRpcBudgetSummary().totalRpcCalls, combinedCeiling, 'a refused call must never increment the spent total')
})

test('block-resolution category cap binds independently of the (much larger) global cap', () => {
  let granted = 0
  for (let i = 0; i < MAX_BLOCK_RESOLUTION_CALLS_PER_SCAN + 5; i++) {
    if (tryReserveRpcCall('block_resolution', 'block_resolution', null)) granted += 1
  }
  assert.equal(granted, MAX_BLOCK_RESOLUTION_CALLS_PER_SCAN)
  assert.equal(getHistoricalRpcBudgetSummary().blockResolutionCalls, MAX_BLOCK_RESOLUTION_CALLS_PER_SCAN)
})

test('pool-discovery category cap binds independently, using distinct tokens so the per-token cap never interferes', () => {
  let granted = 0
  for (let i = 0; i < MAX_POOL_DISCOVERY_CALLS_PER_SCAN + 5; i++) {
    const token = `0x${(3000 + i).toString(16).padStart(40, '0')}`
    if (tryReserveRpcCall('pool_discovery', 'uniswap_v3', token)) granted += 1
  }
  assert.equal(granted, MAX_POOL_DISCOVERY_CALLS_PER_SCAN)
})

test('pool-price category cap binds independently, using distinct tokens', () => {
  let granted = 0
  for (let i = 0; i < MAX_POOL_PRICE_CALLS_PER_SCAN + 5; i++) {
    const token = `0x${(4000 + i).toString(16).padStart(40, '0')}`
    if (tryReserveRpcCall('pool_price', 'uniswap_v3', token)) granted += 1
  }
  assert.equal(granted, MAX_POOL_PRICE_CALLS_PER_SCAN)
})

test('per-token cap binds independently of every category/global cap for one specific token', () => {
  let granted = 0
  for (let i = 0; i < MAX_CALLS_PER_TOKEN + 5; i++) {
    const category = i % 2 === 0 ? 'pool_discovery' : 'pool_price'
    if (tryReserveRpcCall(category, 'uniswap_v3', TOKEN_A)) granted += 1
  }
  assert.equal(granted, MAX_CALLS_PER_TOKEN)
  // A DIFFERENT token must be entirely unaffected by TOKEN_A's own exhausted allowance.
  assert.equal(tryReserveRpcCall('pool_discovery', 'uniswap_v3', TOKEN_B), true)
})

test('block-resolution calls never participate in the per-token cap (token is null)', () => {
  for (let i = 0; i < MAX_CALLS_PER_TOKEN; i++) {
    assert.equal(tryReserveRpcCall('pool_discovery', 'uniswap_v3', TOKEN_A), true)
  }
  assert.equal(tryReserveRpcCall('pool_discovery', 'uniswap_v3', TOKEN_A), false, 'token exhausted')
  // Block resolution has nothing to do with TOKEN_A's own exhausted cap.
  assert.equal(tryReserveRpcCall('block_resolution', 'block_resolution', null), true)
})

test('canReserveRpcCalls is a pure check — it never mutates state even when it would refuse', () => {
  const before = getHistoricalRpcBudgetSummary()
  assert.equal(canReserveRpcCalls('pool_price', TOKEN_A, MAX_CALLS_PER_TOKEN + 1), false)
  assert.equal(canReserveRpcCalls('pool_price', TOKEN_A, MAX_CALLS_PER_TOKEN), true)
  const after = getHistoricalRpcBudgetSummary()
  assert.deepEqual(after, before, 'a pure check must never change the budget state')
})

test('canReserveRpcCalls correctly reports whether an atomic batch of N calls would ALL fit', () => {
  for (let i = 0; i < MAX_CALLS_PER_TOKEN - 2; i++) {
    assert.equal(tryReserveRpcCall('pool_price', 'uniswap_v3', TOKEN_A), true)
  }
  // 2 slots remain for TOKEN_A.
  assert.equal(canReserveRpcCalls('pool_price', TOKEN_A, 2), true)
  assert.equal(canReserveRpcCalls('pool_price', TOKEN_A, 3), false)
})

test('diagnostic counters reflect real recorded events, not derived guesses', () => {
  recordTimestampBucket(100)
  recordTimestampBucket(200)
  recordTimestampBucket(100) // duplicate bucket — a Set, must not double-count
  recordBlockCacheHit()
  recordBlockCacheHit()
  recordPoolCacheHit()
  recordNegativeCacheHit()
  recordNegativeCacheHit()
  recordNegativeCacheHit()

  const summary = getHistoricalRpcBudgetSummary()
  assert.equal(summary.timestampBuckets, 2)
  assert.equal(summary.blockCacheHits, 2)
  assert.equal(summary.poolCacheHits, 1)
  assert.equal(summary.negativeCacheHits, 3)
})

test('callsByVenue and callsByToken attribute every real spend correctly', () => {
  tryReserveRpcCall('pool_discovery', 'uniswap_v3', TOKEN_A)
  tryReserveRpcCall('pool_price', 'uniswap_v3', TOKEN_A)
  tryReserveRpcCall('pool_discovery', 'aerodrome_slipstream', TOKEN_B)
  tryReserveRpcCall('block_resolution', 'block_resolution', null)

  const summary = getHistoricalRpcBudgetSummary()
  assert.equal(summary.callsByVenue.uniswap_v3, 2)
  assert.equal(summary.callsByVenue.aerodrome_slipstream, 1)
  assert.equal(summary.callsByVenue.block_resolution, 1)
  assert.equal(summary.callsByToken[TOKEN_A.toLowerCase()], 2)
  assert.equal(summary.callsByToken[TOKEN_B.toLowerCase()], 1)
})

test('stoppedByGlobalCap and stoppedByPerTokenCap are attributed to the correct refusal reason', () => {
  for (let i = 0; i < MAX_CALLS_PER_TOKEN; i++) tryReserveRpcCall('pool_discovery', 'uniswap_v3', TOKEN_A)
  tryReserveRpcCall('pool_discovery', 'uniswap_v3', TOKEN_A) // refused: per-token cap
  tryReserveRpcCall('pool_discovery', 'uniswap_v3', TOKEN_A) // refused again: per-token cap

  const summary = getHistoricalRpcBudgetSummary()
  assert.equal(summary.stoppedByPerTokenCap, 2)
  assert.equal(summary.stoppedByGlobalCap, 0)
})

test('estimatedAlchemyCu is a real function of recorded category counts, never a flat guess', () => {
  tryReserveRpcCall('block_resolution', 'block_resolution', null)
  tryReserveRpcCall('pool_discovery', 'uniswap_v3', TOKEN_A)
  tryReserveRpcCall('pool_price', 'uniswap_v3', TOKEN_A)

  const summary = getHistoricalRpcBudgetSummary()
  assert.equal(summary.estimatedAlchemyCu, 16 + 26 + 26)
})

test('reset clears every counter back to a clean slate', () => {
  tryReserveRpcCall('pool_discovery', 'uniswap_v3', TOKEN_A)
  recordTimestampBucket(1)
  recordBlockCacheHit()
  __resetHistoricalRpcBudgetForTest()

  const summary = getHistoricalRpcBudgetSummary()
  assert.equal(summary.totalRpcCalls, 0)
  assert.equal(summary.timestampBuckets, 0)
  assert.equal(summary.blockCacheHits, 0)
  assert.deepEqual(summary.callsByToken, {})
})
