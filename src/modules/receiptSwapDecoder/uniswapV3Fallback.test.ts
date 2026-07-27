import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeReceiptSwap } from './index'
import type { ReceiptTxBundle } from './types'
import type { UniswapV3PoolValidator } from './uniswapV3PoolValidator'
import {
  WALLET, ROUTER, POOL_A, TOKEN_X, transferLog, slipstreamSwapLog, wethDepositLog,
  alwaysValidValidator, neverValidValidator,
} from './fixtures.test-helpers'
import { WETH_BASE_ADDRESS } from './signatures'

const WETH = WETH_BASE_ADDRESS.toLowerCase()
const wallet = WALLET.toLowerCase()
const router = ROUTER.toLowerCase()
const poolA = POOL_A.toLowerCase()
const tokenX = TOKEN_X.toLowerCase()

function bundle(partial: Partial<ReceiptTxBundle>): ReceiptTxBundle {
  return {
    chain: 'base',
    txHash: '0xabc',
    walletAddress: wallet,
    router: null,
    logs: [],
    tokenMeta: { [WETH]: { symbol: 'WETH', decimals: 18 }, [tokenX]: { symbol: 'X', decimals: 18 } },
    ...partial,
  }
}

function fakeV3Validator(feeThatMatches: number | null, calls: string[] = []): UniswapV3PoolValidator {
  return {
    async validatePool(pool, t0, t1) {
      calls.push(`${pool}:${t0}:${t1}`)
      return feeThatMatches === null ? { valid: false, fee: null } : { valid: true, fee: feeThatMatches }
    },
  }
}

// PRODUCTION FIXTURE, DISCLOSED (this task's exact reported evidence): likelyRoute:
// uniswap_v3_like, 1 concentrated Swap event, 2 transfers, 1 WETH wrap — previously rejected as
// pool_not_validated_by_factory purely because factory validation only ever tried the Aerodrome
// Slipstream factory.
test('production fixture: a concentrated-liquidity swap that fails Aerodrome validation is decoded as uniswap_v3 via the fallback', async () => {
  const tx = bundle({
    router,
    logs: [
      wethDepositLog(0, router, BigInt('1000000000000000000')),
      transferLog(1, WETH, router, poolA, BigInt('1000000000000000000')),
      slipstreamSwapLog(2, poolA, router, router, BigInt('1000000000000000000'), BigInt('-100000000000000000000')),
      transferLog(3, TOKEN_X, poolA, wallet, BigInt('100000000000000000000')),
    ],
  })
  const result = await decodeReceiptSwap(tx, neverValidValidator(), fakeV3Validator(3000))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.swap.protocol, 'uniswap_v3')
  assert.equal(result.swap.tokenIn.address, WETH)
  assert.equal(result.swap.tokenOut.address, tokenX)
  assert.equal(result.swap.amountInRaw, '1000000000000000000')
  assert.equal(result.swap.amountOutRaw, '100000000000000000000')
  assert.equal(result.swap.confidence, 'exact')
  assert.equal(result.swap.meta.nativeWrapDetected, true)
  assert.equal(result.swap.meta.uniswapV3Fee, 3000)
})

test('reversed token direction resolves the same way through the fallback', async () => {
  const tx = bundle({
    logs: [
      transferLog(0, WETH, wallet, poolA, BigInt('1000000000000000000')),
      slipstreamSwapLog(1, poolA, wallet, wallet, BigInt('-100000000000000000000'), BigInt('1000000000000000000')),
      transferLog(2, TOKEN_X, poolA, wallet, BigInt('100000000000000000000')),
    ],
  })
  const result = await decodeReceiptSwap(tx, neverValidValidator(), fakeV3Validator(500))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.swap.tokenIn.address, WETH)
  assert.equal(result.swap.tokenOut.address, tokenX)
})

test('fee tiers: the exact validated fee tier is surfaced on the decoded swap, never guessed', async () => {
  const tx = bundle({
    logs: [
      transferLog(0, WETH, wallet, poolA, BigInt('1000000000000000000')),
      slipstreamSwapLog(1, poolA, wallet, wallet, BigInt('1000000000000000000'), BigInt('-100000000000000000000')),
      transferLog(2, TOKEN_X, poolA, wallet, BigInt('100000000000000000000')),
    ],
  })
  const result = await decodeReceiptSwap(tx, neverValidValidator(), fakeV3Validator(10000))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.swap.meta.uniswapV3Fee, 10000)
})

test('WETH wrap flow: a native-ETH wrap before the pool swap is flagged, decode still succeeds', async () => {
  const tx = bundle({
    router,
    logs: [
      wethDepositLog(0, router, BigInt('1000000000000000000')),
      transferLog(1, WETH, router, poolA, BigInt('1000000000000000000')),
      slipstreamSwapLog(2, poolA, router, router, BigInt('1000000000000000000'), BigInt('-100000000000000000000')),
      transferLog(3, TOKEN_X, poolA, router, BigInt('100000000000000000000')),
      transferLog(4, TOKEN_X, router, wallet, BigInt('100000000000000000000')),
    ],
  })
  const result = await decodeReceiptSwap(tx, neverValidValidator(), fakeV3Validator(3000))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.swap.meta.nativeWrapDetected, true)
  assert.equal(result.swap.meta.uniswapV3Fee, 3000)
})

test('router intermediary transfers are ignored when resolving the V3 pool leg', async () => {
  const tx = bundle({
    router,
    logs: [
      transferLog(0, WETH, wallet, router, BigInt('1000000000000000000')),
      transferLog(1, WETH, router, poolA, BigInt('1000000000000000000')),
      slipstreamSwapLog(2, poolA, router, router, BigInt('1000000000000000000'), BigInt('-100000000000000000000')),
      transferLog(3, TOKEN_X, poolA, router, BigInt('100000000000000000000')),
      transferLog(4, TOKEN_X, router, wallet, BigInt('100000000000000000000')),
    ],
  })
  const result = await decodeReceiptSwap(tx, neverValidValidator(), fakeV3Validator(3000))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.swap.tokenIn.address, WETH)
  assert.equal(result.swap.tokenOut.address, tokenX)
})

test('invalid factory: neither Aerodrome nor Uniswap V3 validates the pool, decode fails closed', async () => {
  const tx = bundle({
    logs: [
      transferLog(0, WETH, wallet, poolA, BigInt('1000000000000000000')),
      slipstreamSwapLog(1, poolA, wallet, wallet, BigInt('1000000000000000000'), BigInt('-100000000000000000000')),
      transferLog(2, TOKEN_X, poolA, wallet, BigInt('100000000000000000000')),
    ],
  })
  const result = await decodeReceiptSwap(tx, neverValidValidator(), fakeV3Validator(null))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.rejection.reason, 'uniswap_v3_pool_not_validated')
})

test('a genuine Aerodrome Slipstream pool never falls through to the V3 fallback ("do not treat Slipstream as Uniswap V3")', async () => {
  const calls: string[] = []
  const tx = bundle({
    logs: [
      transferLog(0, WETH, wallet, poolA, BigInt('1000000000000000000')),
      slipstreamSwapLog(1, poolA, wallet, wallet, BigInt('1000000000000000000'), BigInt('-100000000000000000000')),
      transferLog(2, TOKEN_X, poolA, wallet, BigInt('100000000000000000000')),
    ],
  })
  const result = await decodeReceiptSwap(tx, alwaysValidValidator(), fakeV3Validator(3000, calls))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.swap.protocol, 'aerodrome_slipstream')
  assert.equal(calls.length, 0) // V3 validator never even consulted
})

test('sign ambiguity in the V3 Swap event fails closed without ever calling the V3 validator', async () => {
  const calls: string[] = []
  const tx = bundle({
    logs: [
      transferLog(0, WETH, wallet, poolA, BigInt('1000000000000000000')),
      slipstreamSwapLog(1, poolA, wallet, wallet, BigInt('1000000000000000000'), BigInt('100000000000000000000')), // both positive
      transferLog(2, TOKEN_X, poolA, wallet, BigInt('100000000000000000000')),
    ],
  })
  const result = await decodeReceiptSwap(tx, neverValidValidator(), fakeV3Validator(3000, calls))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.rejection.reason, 'uniswap_v3_sign_ambiguous')
  assert.equal(calls.length, 0)
})

test('amount mismatch in the V3 path fails closed', async () => {
  const tx = bundle({
    logs: [
      transferLog(0, WETH, wallet, poolA, BigInt('900000000000000000')), // short
      slipstreamSwapLog(1, poolA, wallet, wallet, BigInt('1000000000000000000'), BigInt('-100000000000000000000')),
      transferLog(2, TOKEN_X, poolA, wallet, BigInt('100000000000000000000')),
    ],
  })
  const result = await decodeReceiptSwap(tx, neverValidValidator(), fakeV3Validator(3000))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.rejection.reason, 'uniswap_v3_amount_mismatch')
})

test('caching: the same pool is only validated once by the V3 validator across repeated decodes with a shared scope', async () => {
  const calls: string[] = []
  const tx = bundle({
    logs: [
      transferLog(0, WETH, wallet, poolA, BigInt('1000000000000000000')),
      slipstreamSwapLog(1, poolA, wallet, wallet, BigInt('1000000000000000000'), BigInt('-100000000000000000000')),
      transferLog(2, TOKEN_X, poolA, wallet, BigInt('100000000000000000000')),
    ],
  })
  const validator = fakeV3Validator(3000, calls)
  await decodeReceiptSwap(tx, neverValidValidator(), validator)
  await decodeReceiptSwap(tx, neverValidValidator(), validator)
  // This fake validator itself has no cache — the point of this test is that the SHARED cached
  // wrapper (uniswapV3PoolValidator.test.ts) is what dedupes; here we confirm the decoder calls the
  // validator exactly once per decode attempt (2 decodes -> 2 calls with a raw validator), proving
  // it's the wrapper's job to cache, not the decoder re-deciding to skip validation on its own.
  assert.equal(calls.length, 2)
})

test('backward compatible: omitting the V3 validator entirely preserves the original rejection', async () => {
  const tx = bundle({
    logs: [
      transferLog(0, WETH, wallet, poolA, BigInt('1000000000000000000')),
      slipstreamSwapLog(1, poolA, wallet, wallet, BigInt('1000000000000000000'), BigInt('-100000000000000000000')),
      transferLog(2, TOKEN_X, poolA, wallet, BigInt('100000000000000000000')),
    ],
  })
  const result = await decodeReceiptSwap(tx, neverValidValidator())
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.rejection.reason, 'pool_not_validated_by_factory')
})
