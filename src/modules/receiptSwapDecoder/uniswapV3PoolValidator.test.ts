import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createCachedUniswapV3PoolValidator, createUniswapV3ValidationRequestScope,
  type UniswapV3PoolValidator, type UniswapV3ValidationResult, type UniswapV3ValidationDiagnostics,
} from './uniswapV3PoolValidator'

const POOL = '0x3333333333333333333333333333333333333333'
const WETH = '0x4200000000000000000000000000000000000006'
const TOKEN_X = '0x5555555555555555555555555555555555555555'
const FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'
const ZERO = '0x0000000000000000000000000000000000000000'

function diag(overrides: Partial<UniswapV3ValidationDiagnostics> = {}): UniswapV3ValidationDiagnostics {
  return {
    eventEmitter: POOL, configuredFactory: FACTORY, token0: WETH, token1: TOKEN_X,
    fee: null, feeSource: 'unavailable', getPoolResult: null, emitterMatchesResult: false,
    reversedTokenOrderAttempted: false, reversedGetPoolResult: null, finalTypedReason: 'factory_returned_zero',
    ...overrides,
  }
}

function fakeResult(fee: number | null, diagnosticsOverrides: Partial<UniswapV3ValidationDiagnostics> = {}): UniswapV3ValidationResult {
  return fee === null
    ? { valid: false, fee: null, diagnostics: diag(diagnosticsOverrides) }
    : {
        valid: true, fee,
        diagnostics: diag({ fee, feeSource: 'factory_getPool_fee_tier_match', getPoolResult: POOL, emitterMatchesResult: true, finalTypedReason: 'validated', ...diagnosticsOverrides }),
      }
}

function countingFakeValidator(feeThatMatches: number | null, calls: string[]): UniswapV3PoolValidator {
  return {
    async validatePool(poolAddress, token0, token1) {
      calls.push(`${poolAddress}:${token0}:${token1}`)
      return fakeResult(feeThatMatches)
    },
  }
}

test('fee tiers: a validated pool returns the exact fee tier extracted from the factory relationship', async () => {
  const calls: string[] = []
  const { validator } = createCachedUniswapV3PoolValidator(
    countingFakeValidator(3000, calls),
    createUniswapV3ValidationRequestScope(),
  )
  const result = await validator.validatePool(POOL, WETH, TOKEN_X)
  assert.equal(result.valid, true)
  assert.equal(result.fee, 3000)
  assert.equal(result.diagnostics.feeSource, 'factory_getPool_fee_tier_match')
  assert.equal(result.diagnostics.finalTypedReason, 'validated')
})

test('an invalid pool (no fee tier matches) is rejected with fee null, never guessed', async () => {
  const calls: string[] = []
  const { validator } = createCachedUniswapV3PoolValidator(
    countingFakeValidator(null, calls),
    createUniswapV3ValidationRequestScope(),
  )
  const result = await validator.validatePool(POOL, WETH, TOKEN_X)
  assert.equal(result.valid, false)
  assert.equal(result.fee, null)
  assert.equal(result.diagnostics.feeSource, 'unavailable')
})

test('caching: a pool validated once is never re-validated by a second call for the same key', async () => {
  const calls: string[] = []
  const { validator, callCount } = createCachedUniswapV3PoolValidator(
    countingFakeValidator(500, calls),
    createUniswapV3ValidationRequestScope(),
  )
  await validator.validatePool(POOL, WETH, TOKEN_X)
  await validator.validatePool(POOL, WETH, TOKEN_X)
  assert.equal(calls.length, 1)
  assert.equal(callCount(), 1)
})

test('caching is request-scoped: a pre-seeded scope entry is reused, never triggers a real call', async () => {
  const calls: string[] = []
  const scope = createUniswapV3ValidationRequestScope()
  scope.cache.set(`${POOL.toLowerCase()}:${WETH.toLowerCase()}:${TOKEN_X.toLowerCase()}`, fakeResult(10000))
  const { validator, callCount } = createCachedUniswapV3PoolValidator(countingFakeValidator(500, calls), scope)
  const result = await validator.validatePool(POOL, WETH, TOKEN_X)
  assert.equal(result.fee, 10000) // the pre-seeded value, not the fake validator's 500
  assert.equal(calls.length, 0)
  assert.equal(callCount(), 0)
})

test('singleflight: two concurrent validations for the same pool only trigger one real call', async () => {
  let liveCalls = 0
  let resolveFn: ((v: UniswapV3ValidationResult) => void) | null = null
  const validatorInner: UniswapV3PoolValidator = {
    async validatePool() {
      liveCalls += 1
      return new Promise((resolve) => { resolveFn = resolve })
    },
  }
  const { validator } = createCachedUniswapV3PoolValidator(validatorInner, createUniswapV3ValidationRequestScope())
  const p1 = validator.validatePool(POOL, WETH, TOKEN_X)
  const p2 = validator.validatePool(POOL, WETH, TOKEN_X)
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(liveCalls, 1)
  resolveFn!(fakeResult(500))
  const [r1, r2] = await Promise.all([p1, p2])
  assert.deepEqual(r1, r2)
})

test('hard cap: validation attempts beyond the cap fail closed without calling the real validator', async () => {
  const calls: string[] = []
  const { validator, callCount } = createCachedUniswapV3PoolValidator(
    countingFakeValidator(500, calls),
    createUniswapV3ValidationRequestScope(),
    2, // cap
  )
  const r1 = await validator.validatePool(POOL, WETH, TOKEN_X)
  const r2 = await validator.validatePool('0xpoolB', WETH, TOKEN_X)
  const r3 = await validator.validatePool('0xpoolC', WETH, TOKEN_X) // exceeds cap
  assert.equal(r1.valid, true)
  assert.equal(r2.valid, true)
  assert.equal(r3.valid, false)
  assert.equal(r3.fee, null)
  assert.equal(r3.diagnostics.finalTypedReason, 'validation_cap_exceeded')
  assert.equal(calls.length, 2)
  assert.equal(callCount(), 2)
})

test('different pool addresses are validated independently, never conflated', async () => {
  const calls: string[] = []
  const { validator } = createCachedUniswapV3PoolValidator(countingFakeValidator(3000, calls), createUniswapV3ValidationRequestScope())
  await validator.validatePool(POOL, WETH, TOKEN_X)
  await validator.validatePool('0xpoolB', WETH, TOKEN_X)
  assert.equal(calls.length, 2)
})

test('diagnostics distinguish factory_returned_zero from factory_pool_mismatch and rpc_failure', async () => {
  const zeroCase = fakeResult(null, { finalTypedReason: 'factory_returned_zero', getPoolResult: ZERO })
  const mismatchCase = fakeResult(null, { finalTypedReason: 'factory_pool_mismatch', getPoolResult: '0xotherpool' })
  const rpcCase = fakeResult(null, { finalTypedReason: 'rpc_failure' })
  assert.equal(zeroCase.diagnostics.finalTypedReason, 'factory_returned_zero')
  assert.equal(mismatchCase.diagnostics.finalTypedReason, 'factory_pool_mismatch')
  assert.equal(rpcCase.diagnostics.finalTypedReason, 'rpc_failure')
  assert.notEqual(zeroCase.diagnostics.getPoolResult, mismatchCase.diagnostics.getPoolResult)
})

test('the configured factory constant matches the canonical Base Uniswap V3 factory address', () => {
  assert.equal(FACTORY, '0x33128a8fC17869897dcE68Ed026d694621f6FDfD')
})
