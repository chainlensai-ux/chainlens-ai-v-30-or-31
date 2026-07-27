import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveUniswapV3Leg } from './uniswapV3Leg'
import type { DecodedLogs, DecodedPoolSwap, DecodedTransfer } from './decodeLogs'

const POOL = '0x3333333333333333333333333333333333333333'
const ROUTER = '0x2222222222222222222222222222222222222222'
const WALLET = '0x1111111111111111111111111111111111111111'
const WETH = '0x4200000000000000000000000000000000000006'
const TOKEN_X = '0x5555555555555555555555555555555555555555'

function transfer(logIndex: number, token: string, from: string, to: string, value: bigint): DecodedTransfer {
  return { logIndex, token, from, to, value }
}

function v3Swap(amount0: bigint, amount1: bigint): DecodedPoolSwap {
  return { logIndex: 100, protocol: 'aerodrome_slipstream', poolAddress: POOL, sender: ROUTER, amount0, amount1 }
}

function decoded(transfers: DecodedTransfer[]): DecodedLogs {
  return { swaps: [], lpEvents: [], transfers, nativeWraps: [], malformed: 0 }
}

test('exact swap: wallet pays WETH (positive amount0), receives TOKEN_X (negative amount1)', () => {
  const swap = v3Swap(BigInt('1000000000000000000'), BigInt('-100000000000000000000'))
  const logs = decoded([
    transfer(0, WETH, WALLET, POOL, BigInt('1000000000000000000')),
    transfer(1, TOKEN_X, POOL, WALLET, BigInt('100000000000000000000')),
  ])
  const result = resolveUniswapV3Leg(swap, logs)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.leg.tokenIn, WETH)
  assert.equal(result.leg.tokenOut, TOKEN_X)
  assert.equal(result.leg.amountIn, BigInt('1000000000000000000'))
  assert.equal(result.leg.amountOut, BigInt('100000000000000000000'))
  assert.equal(result.diagnostics.signValid, true)
  assert.equal(result.diagnostics.resolved, true)
})

test('reversed token direction: negative amount0 (token0 out), positive amount1 (token1 in)', () => {
  const swap = v3Swap(BigInt('-100000000000000000000'), BigInt('1000000000000000000'))
  const logs = decoded([
    transfer(0, WETH, WALLET, POOL, BigInt('1000000000000000000')),
    transfer(1, TOKEN_X, POOL, WALLET, BigInt('100000000000000000000')),
  ])
  const result = resolveUniswapV3Leg(swap, logs)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.leg.tokenIn, WETH)
  assert.equal(result.leg.tokenOut, TOKEN_X)
})

test('router intermediary transfers (not touching the pool) are ignored', () => {
  const swap = v3Swap(BigInt('1000000000000000000'), BigInt('-100000000000000000000'))
  const logs = decoded([
    transfer(0, WETH, WALLET, ROUTER, BigInt('1000000000000000000')), // does not touch pool
    transfer(1, WETH, ROUTER, POOL, BigInt('1000000000000000000')),
    transfer(2, TOKEN_X, POOL, ROUTER, BigInt('100000000000000000000')),
    transfer(3, TOKEN_X, ROUTER, WALLET, BigInt('100000000000000000000')), // does not touch pool
  ])
  const result = resolveUniswapV3Leg(swap, logs)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.diagnostics.routerIntermediaryTransfersIgnored, 2)
})

test('sign ambiguity: both amounts positive is rejected as uniswap_v3_sign_ambiguous', () => {
  const swap = v3Swap(BigInt('1000000000000000000'), BigInt('100000000000000000000'))
  const logs = decoded([transfer(0, WETH, WALLET, POOL, BigInt('1000000000000000000'))])
  const result = resolveUniswapV3Leg(swap, logs)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'uniswap_v3_sign_ambiguous')
  assert.equal(result.diagnostics.signValid, false)
})

test('sign ambiguity: both amounts negative is rejected', () => {
  const swap = v3Swap(BigInt('-1000000000000000000'), BigInt('-100000000000000000000'))
  const logs = decoded([])
  const result = resolveUniswapV3Leg(swap, logs)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'uniswap_v3_sign_ambiguous')
})

test('sign ambiguity: both amounts zero is rejected', () => {
  const swap = v3Swap(BigInt('0'), BigInt('0'))
  const result = resolveUniswapV3Leg(swap, decoded([]))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'uniswap_v3_sign_ambiguous')
})

test('amount mismatch beyond the 1-raw-unit tolerance is rejected as uniswap_v3_amount_mismatch', () => {
  const swap = v3Swap(BigInt('1000000000000000000'), BigInt('-100000000000000000000'))
  const logs = decoded([
    transfer(0, WETH, WALLET, POOL, BigInt('900000000000000000')), // short by 0.1 WETH
    transfer(1, TOKEN_X, POOL, WALLET, BigInt('100000000000000000000')),
  ])
  const result = resolveUniswapV3Leg(swap, logs)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'uniswap_v3_amount_mismatch')
})

test('a 1-raw-unit rounding difference is within tolerance and still resolves', () => {
  const swap = v3Swap(BigInt('1000000000000000000'), BigInt('-100000000000000000000'))
  const logs = decoded([
    transfer(0, WETH, WALLET, POOL, BigInt('999999999999999999')),
    transfer(1, TOKEN_X, POOL, WALLET, BigInt('100000000000000000000')),
  ])
  const result = resolveUniswapV3Leg(swap, logs)
  assert.equal(result.ok, true)
})

test('ambiguous token mapping: two tokens both plausibly match the incoming amount is rejected', () => {
  const swap = v3Swap(BigInt('1000'), BigInt('-500'))
  const logs = decoded([
    transfer(0, WETH, WALLET, POOL, BigInt('1000')),
    transfer(1, TOKEN_X, WALLET, POOL, BigInt('1000')),
    transfer(2, TOKEN_X, POOL, WALLET, BigInt('500')),
  ])
  const result = resolveUniswapV3Leg(swap, logs)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'uniswap_v3_ambiguous_token_mapping')
})

test('no candidate token on the outgoing side is rejected as ambiguous, never guessed', () => {
  const swap = v3Swap(BigInt('1000'), BigInt('-500'))
  const logs = decoded([transfer(0, WETH, WALLET, POOL, BigInt('1000'))])
  const result = resolveUniswapV3Leg(swap, logs)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'uniswap_v3_ambiguous_token_mapping')
})

test('deterministic output: identical input resolves identically across repeated calls', () => {
  const swap = v3Swap(BigInt('1000000000000000000'), BigInt('-100000000000000000000'))
  const logs = decoded([
    transfer(0, WETH, WALLET, POOL, BigInt('1000000000000000000')),
    transfer(1, TOKEN_X, POOL, WALLET, BigInt('100000000000000000000')),
  ])
  const r1 = resolveUniswapV3Leg(swap, logs)
  const r2 = resolveUniswapV3Leg(swap, logs)
  assert.deepEqual(r1, r2)
})
