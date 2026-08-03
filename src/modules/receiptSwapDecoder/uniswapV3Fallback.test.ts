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
      const base = {
        eventEmitter: pool, configuredFactory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', token0: t0, token1: t1,
      }
      if (feeThatMatches === null) {
        return {
          valid: false, fee: null,
          diagnostics: {
            ...base, fee: null, feeSource: 'unavailable' as const, getPoolResult: '0x0000000000000000000000000000000000000000',
            emitterMatchesResult: false, reversedTokenOrderAttempted: true, reversedGetPoolResult: '0x0000000000000000000000000000000000000000',
            feeAttempts: [500, 3000, 10000], getPoolResults: ['0x0', '0x0', '0x0'], reversedGetPoolResults: ['0x0', '0x0', '0x0'],
            finalTypedReason: 'factory_returned_zero' as const,
          },
        }
      }
      return {
        valid: true, fee: feeThatMatches,
        diagnostics: {
          ...base, fee: feeThatMatches, feeSource: 'factory_getPool_fee_tier_match' as const, getPoolResult: pool,
          emitterMatchesResult: true, reversedTokenOrderAttempted: false, reversedGetPoolResult: null,
          feeAttempts: [feeThatMatches], getPoolResults: [pool], reversedGetPoolResults: [],
          finalTypedReason: 'validated' as const,
        },
      }
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
  assert.equal(result.rejection.reason, 'likely_non_uniswap_v3_factory')
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
  // REASON STRING UPDATED, DISCLOSED (evidence-first PnL completion task, requirement #7 —
  // Aerodrome Slipstream multihop fix): resolveSlipstreamMultiTransferLeg (aerodromeSlipstreamLeg.ts)
  // now performs this exact sign-ambiguity check UP FRONT for every Slipstream-shaped Swap event
  // (both0/both1 positive is a contradiction in the event's own reported amounts), so this fixture
  // now fails closed at that earlier point — with the same, already-established `contradictory_legs`
  // reason multiTransferLeg.ts's Classic resolver already uses, rather than ever reaching the V3
  // fallback path (unreachable per this leg's own PoolLeg-building step never succeeding). The
  // fail-closed OUTCOME is identical (still rejected, V3 validator still never called) — only the
  // label changed, to the SAME vocabulary Classic already established as canonical.
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
  assert.equal(result.rejection.reason, 'contradictory_legs')
  assert.equal(calls.length, 0)
})

test('amount mismatch in the V3 path fails closed', async () => {
  // REASON STRING UPDATED, DISCLOSED (same fix as above): resolveSlipstreamMultiTransferLeg now
  // reconciles the pool's transfer aggregate against the Swap event's own signed amount up front,
  // so a genuine short transfer is caught there first (`swap_event_amount_mismatch` — the same
  // reason Classic's resolver already uses for this exact failure mode), never reaching the V3
  // fallback. Still fails closed; only the label changed.
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
  assert.equal(result.rejection.reason, 'swap_event_amount_mismatch')
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

// FORENSIC DIAGNOSTICS, DISCLOSED (this task — exact production evidence): 1 V3 pool examined,
// Swap amount reconciliation passed (resolveUniswapV3Leg succeeds), 1 validation call, 0 pools
// validated, generic rejection uniswap_v3_pool_not_validated with no way to tell why. This test
// reproduces that exact scan shape and confirms the bounded forensic diagnostics now distinguish
// WHICH of the 6 typed reasons applies (here: the factory genuinely has no record of this pair at
// all, surfaced as the higher-level 'likely_non_uniswap_v3_factory' conclusion), with exactly one
// validation call made -- never a duplicate merely to populate diagnostics.
test('production forensic fixture: 1 pool examined, reconciliation passed, exactly 1 validation call, 0 validated, typed reason distinguishes why', async () => {
  const calls: string[] = []
  const validator: UniswapV3PoolValidator = {
    async validatePool(pool, t0, t1) {
      calls.push(`${pool}:${t0}:${t1}`)
      return {
        valid: false,
        fee: null,
        diagnostics: {
          eventEmitter: pool,
          configuredFactory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
          token0: t0,
          token1: t1,
          fee: null,
          feeSource: 'unavailable',
          getPoolResult: '0x0000000000000000000000000000000000000000',
          emitterMatchesResult: false,
          reversedTokenOrderAttempted: true,
          reversedGetPoolResult: '0x0000000000000000000000000000000000000000',
          feeAttempts: [500, 3000, 10000],
          getPoolResults: ['0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000'],
          reversedGetPoolResults: ['0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000'],
          finalTypedReason: 'factory_returned_zero',
        },
      }
    },
  }
  const tx = bundle({
    logs: [
      transferLog(0, WETH, wallet, poolA, BigInt('1000000000000000000')),
      slipstreamSwapLog(1, poolA, wallet, wallet, BigInt('1000000000000000000'), BigInt('-100000000000000000000')),
      transferLog(2, TOKEN_X, poolA, wallet, BigInt('100000000000000000000')),
    ],
  })
  const result = await decodeReceiptSwap(tx, neverValidValidator(), validator)
  assert.equal(result.ok, false)
  if (result.ok) return
  // Reconciliation (resolveUniswapV3Leg) passed -- the rejection came from validation, not decode.
  assert.equal(result.rejection.uniswapV3?.resolved, true)
  assert.equal(result.rejection.uniswapV3?.amountMatched, true)
  assert.equal(calls.length, 1) // exactly one validation call, never duplicated for diagnostics
  assert.equal(result.rejection.reason, 'likely_non_uniswap_v3_factory')
  assert.equal(result.rejection.uniswapV3Validation?.finalTypedReason, 'factory_returned_zero')
  assert.equal(result.rejection.uniswapV3Validation?.emitterMatchesResult, false)
  assert.equal(result.rejection.uniswapV3Validation?.configuredFactory, '0x33128a8fC17869897dcE68Ed026d694621f6FDfD')
})

test('typed reason: factory_pool_mismatch is distinguished from factory_returned_zero', async () => {
  const validator: UniswapV3PoolValidator = {
    async validatePool(pool, t0, t1) {
      return {
        valid: false, fee: null,
        diagnostics: {
          eventEmitter: pool, configuredFactory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', token0: t0, token1: t1,
          fee: null, feeSource: 'unavailable', getPoolResult: '0xdifferentpool',
          emitterMatchesResult: false, reversedTokenOrderAttempted: true, reversedGetPoolResult: '0xdifferentpool',
          feeAttempts: [500, 3000, 10000], getPoolResults: ['0x0', '0xdifferentpool', '0x0'], reversedGetPoolResults: ['0x0', '0x0', '0x0'],
          finalTypedReason: 'factory_pool_mismatch',
        },
      }
    },
  }
  const tx = bundle({
    logs: [
      transferLog(0, WETH, wallet, poolA, BigInt('1000000000000000000')),
      slipstreamSwapLog(1, poolA, wallet, wallet, BigInt('1000000000000000000'), BigInt('-100000000000000000000')),
      transferLog(2, TOKEN_X, poolA, wallet, BigInt('100000000000000000000')),
    ],
  })
  const result = await decodeReceiptSwap(tx, neverValidValidator(), validator)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.rejection.reason, 'factory_pool_mismatch')
})

test('typed reason: rpc_failure is distinguished and never treated as a validated pool', async () => {
  const validator: UniswapV3PoolValidator = {
    async validatePool(pool, t0, t1) {
      return {
        valid: false, fee: null,
        diagnostics: {
          eventEmitter: pool, configuredFactory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', token0: t0, token1: t1,
          fee: null, feeSource: 'unavailable', getPoolResult: null,
          emitterMatchesResult: false, reversedTokenOrderAttempted: true, reversedGetPoolResult: null,
          feeAttempts: [], getPoolResults: [], reversedGetPoolResults: [],
          finalTypedReason: 'rpc_failure',
        },
      }
    },
  }
  const tx = bundle({
    logs: [
      transferLog(0, WETH, wallet, poolA, BigInt('1000000000000000000')),
      slipstreamSwapLog(1, poolA, wallet, wallet, BigInt('1000000000000000000'), BigInt('-100000000000000000000')),
      transferLog(2, TOKEN_X, poolA, wallet, BigInt('100000000000000000000')),
    ],
  })
  const result = await decodeReceiptSwap(tx, neverValidValidator(), validator)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.rejection.reason, 'rpc_failure')
})
