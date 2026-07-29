import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildUniswapV3ForensicLogRecord, UNISWAP_V3_FORENSIC_LOG_LABEL } from './uniswapV3ForensicLog'
import type { UniswapV3ValidationDiagnostics } from './types'

const POOL = '0x3333333333333333333333333333333333333333'
const WETH = '0x4200000000000000000000000000000000000006'
const TOKEN_X = '0x5555555555555555555555555555555555555555'
const FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'
const ZERO = '0x0000000000000000000000000000000000000000'
const OTHER_POOL = '0x9999999999999999999999999999999999999999'

function diag(overrides: Partial<UniswapV3ValidationDiagnostics> = {}): UniswapV3ValidationDiagnostics {
  return {
    eventEmitter: POOL, configuredFactory: FACTORY, token0: WETH, token1: TOKEN_X,
    fee: null, feeSource: 'unavailable', getPoolResult: null, emitterMatchesResult: false,
    reversedTokenOrderAttempted: false, reversedGetPoolResult: null,
    feeAttempts: [500, 3000, 10000], getPoolResults: [ZERO, ZERO, ZERO], reversedGetPoolResults: [],
    finalTypedReason: 'factory_returned_zero',
    ...overrides,
  }
}

// NO NESTED [Array]/[Object], DISCLOSED: the exact defect this task fixes — every field on the
// built record must be a string, number, or boolean, never an array or plain object, so a
// console.warn(label, record) call is fully flat under Vercel's/Node's default inspect depth.
test('every field of the built log record is a flat scalar, never an array or object', () => {
  const record = buildUniswapV3ForensicLogRecord('0xabc', diag({
    fee: 3000, feeSource: 'factory_getPool_fee_tier_match', getPoolResult: POOL, emitterMatchesResult: true,
    getPoolResults: [ZERO, POOL, ZERO], finalTypedReason: 'validated',
  }))
  for (const [key, value] of Object.entries(record)) {
    assert.notEqual(Array.isArray(value), true, `field ${key} must not be an array`)
    assert.notEqual(typeof value, 'object', `field ${key} must not be an object`)
    assert.ok(['string', 'number', 'boolean'].includes(typeof value), `field ${key} must be a scalar`)
  }
})

test('label is the exact required production log string', () => {
  assert.equal(UNISWAP_V3_FORENSIC_LOG_LABEL, '[pipeline] Uniswap V3 receipt validation forensic')
})

test('addresses are lowercased consistently', () => {
  const record = buildUniswapV3ForensicLogRecord('0xABC', diag({
    eventEmitter: POOL.toUpperCase(), token0: WETH.toUpperCase(), token1: TOKEN_X.toUpperCase(),
    getPoolResult: POOL.toUpperCase(),
  }))
  assert.equal(record.eventEmitter, POOL.toLowerCase())
  assert.equal(record.token0, WETH.toLowerCase())
  assert.equal(record.token1, TOKEN_X.toLowerCase())
  assert.equal(record.matchingGetPoolResult, POOL.toLowerCase())
  assert.equal(record.configuredFactory, FACTORY.toLowerCase())
})

test('fee attempts and getPool results are serialized as compact aligned strings', () => {
  const record = buildUniswapV3ForensicLogRecord('0xabc', diag({
    getPoolResults: [ZERO, OTHER_POOL, ZERO],
  }))
  assert.equal(record.feeAttempts, '500,3000,10000')
  assert.equal(record.getPoolResults, `500=${ZERO},3000=${OTHER_POOL.toLowerCase()},10000=${ZERO}`)
  assert.equal(record.matchingFee, 'none')
})

test('reversedGetPoolResults reports not_attempted when the reversed pass never ran', () => {
  const record = buildUniswapV3ForensicLogRecord('0xabc', diag({ reversedTokenOrderAttempted: false }))
  assert.equal(record.reversedGetPoolResults, 'not_attempted')
})

test('reversedGetPoolResults serializes the reversed pass when it did run', () => {
  const record = buildUniswapV3ForensicLogRecord('0xabc', diag({
    reversedTokenOrderAttempted: true,
    reversedGetPoolResults: [ZERO, ZERO, OTHER_POOL],
  }))
  assert.equal(record.reversedGetPoolResults, `500=${ZERO},3000=${ZERO},10000=${OTHER_POOL.toLowerCase()}`)
})

// MISMATCH DISAMBIGUATION, DISCLOSED (this task's own requirement): distinguish a single fee tier
// returning a real, differing pool from multiple/ambiguous fee-tier hits.
test('mismatchDetail identifies a single fee tier returning a differing non-zero pool', () => {
  const record = buildUniswapV3ForensicLogRecord('0xabc', diag({
    finalTypedReason: 'factory_pool_mismatch',
    getPoolResults: [ZERO, OTHER_POOL, ZERO],
  }))
  assert.equal(record.mismatchDetail, `single_fee_tier_pool_mismatch:fee=3000,returnedPool=${OTHER_POOL.toLowerCase()}`)
})

test('mismatchDetail identifies multiple fee-tier hits as ambiguous', () => {
  const record = buildUniswapV3ForensicLogRecord('0xabc', diag({
    finalTypedReason: 'factory_pool_mismatch',
    getPoolResults: [OTHER_POOL, OTHER_POOL, ZERO],
  }))
  assert.equal(record.mismatchDetail, 'multiple_or_ambiguous_fee_tier_pools')
})

test('mismatchDetail is not_applicable for any reason other than factory_pool_mismatch', () => {
  const record = buildUniswapV3ForensicLogRecord('0xabc', diag({ finalTypedReason: 'factory_returned_zero' }))
  assert.equal(record.mismatchDetail, 'not_applicable')
})
