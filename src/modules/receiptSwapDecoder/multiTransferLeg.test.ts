import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveClassicMultiTransferLeg, mergeMultiTransferDiagnostics } from './multiTransferLeg'
import type { DecodedLogs, DecodedPoolSwap, DecodedTransfer } from './decodeLogs'

const POOL = '0x3333333333333333333333333333333333333333'
const ROUTER = '0x2222222222222222222222222222222222222222'
const WALLET = '0x1111111111111111111111111111111111111111'
const WETH = '0x4200000000000000000000000000000000000006'
const TOKEN_X = '0x5555555555555555555555555555555555555555'

function transfer(logIndex: number, token: string, from: string, to: string, value: bigint): DecodedTransfer {
  return { logIndex, token, from, to, value }
}

function classicSwap(amount0In: bigint, amount1In: bigint, amount0Out: bigint, amount1Out: bigint): DecodedPoolSwap {
  return {
    logIndex: 100, protocol: 'aerodrome_classic', poolAddress: POOL, sender: ROUTER,
    amount0: amount0In - amount0Out, amount1: amount1In - amount1Out,
    classicGross: { amount0In, amount1In, amount0Out, amount1Out },
  }
}

function decoded(transfers: DecodedTransfer[]): DecodedLogs {
  return { swaps: [], lpEvents: [], transfers, nativeWraps: [], malformed: 0 }
}

test('two transfers into the same pool aggregate to exactly match the Swap event amount', () => {
  const swap = classicSwap(BigInt('1000000000000000000'), BigInt('0'), BigInt('0'), BigInt('500000000000000000000'))
  const logs = decoded([
    transfer(0, WETH, WALLET, POOL, BigInt('600000000000000000')),
    transfer(1, WETH, WALLET, POOL, BigInt('400000000000000000')),
    transfer(2, TOKEN_X, POOL, WALLET, BigInt('500000000000000000000')),
  ])
  const result = resolveClassicMultiTransferLeg(swap, logs)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.leg.tokenIn, WETH)
  assert.equal(result.leg.tokenOut, TOKEN_X)
  assert.equal(result.leg.amountIn, BigInt('1000000000000000000'))
  assert.equal(result.diagnostics.swapEventAmountMatched, true)
  assert.equal(result.diagnostics.resolved, true)
})

test('router intermediary transfers (not touching the pool) are ignored when resolving the pool leg', () => {
  const swap = classicSwap(BigInt('1000000000000000000'), BigInt('0'), BigInt('0'), BigInt('500000000000000000000'))
  const logs = decoded([
    transfer(0, WETH, WALLET, ROUTER, BigInt('1000000000000000000')), // wallet -> router: does NOT touch pool
    transfer(1, WETH, ROUTER, POOL, BigInt('1000000000000000000')), // router -> pool: touches pool
    transfer(2, TOKEN_X, POOL, ROUTER, BigInt('500000000000000000000')), // pool -> router: touches pool
    transfer(3, TOKEN_X, ROUTER, WALLET, BigInt('500000000000000000000')), // router -> wallet: does NOT touch pool
  ])
  const result = resolveClassicMultiTransferLeg(swap, logs)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.diagnostics.routerIntermediaryTransfersIgnored, 2)
  assert.equal(result.leg.tokenIn, WETH)
  assert.equal(result.leg.tokenOut, TOKEN_X)
})

test('a refund transfer back to the wallet does not affect pool-leg resolution (netted separately)', () => {
  const swap = classicSwap(BigInt('1000000000000000000'), BigInt('0'), BigInt('0'), BigInt('500000000000000000000'))
  const logs = decoded([
    transfer(0, WETH, WALLET, ROUTER, BigInt('1200000000000000000')), // wallet sends extra (excess)
    transfer(1, WETH, ROUTER, POOL, BigInt('1000000000000000000')), // router forwards exact amount to pool
    transfer(2, TOKEN_X, POOL, ROUTER, BigInt('500000000000000000000')),
    transfer(3, TOKEN_X, ROUTER, WALLET, BigInt('500000000000000000000')),
    transfer(4, WETH, ROUTER, WALLET, BigInt('200000000000000000')), // refund of unused input
  ])
  const result = resolveClassicMultiTransferLeg(swap, logs)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.leg.amountIn, BigInt('1000000000000000000')) // authoritative Swap event amount, not the gross wallet send
  assert.equal(result.diagnostics.routerIntermediaryTransfersIgnored, 3) // wallet->router, router->wallet x2
})

test('amount mismatch beyond the 1-raw-unit tolerance is rejected as swap_event_amount_mismatch', () => {
  const swap = classicSwap(BigInt('1000000000000000000'), BigInt('0'), BigInt('0'), BigInt('500000000000000000000'))
  const logs = decoded([
    transfer(0, WETH, WALLET, POOL, BigInt('900000000000000000')), // 0.1 WETH short of the Swap event's amount
    transfer(1, TOKEN_X, POOL, WALLET, BigInt('500000000000000000000')),
  ])
  const result = resolveClassicMultiTransferLeg(swap, logs)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'swap_event_amount_mismatch')
  assert.equal(result.diagnostics.swapEventAmountMatched, false)
})

test('fee-on-transfer token (pool receives less than the Swap event claims) is rejected, never silently accepted', () => {
  const swap = classicSwap(BigInt('1000000000000000000'), BigInt('0'), BigInt('0'), BigInt('500000000000000000000'))
  const logs = decoded([
    // Sender "sent" 1e18 per the Swap event's own accounting, but a fee-on-transfer token actually
    // delivered only 990000000000000000 to the pool — a real, attributable mismatch.
    transfer(0, WETH, WALLET, POOL, BigInt('990000000000000000')),
    transfer(1, TOKEN_X, POOL, WALLET, BigInt('500000000000000000000')),
  ])
  const result = resolveClassicMultiTransferLeg(swap, logs)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'swap_event_amount_mismatch')
})

test('a 1-raw-unit rounding difference is within tolerance and still resolves', () => {
  const swap = classicSwap(BigInt('1000000000000000000'), BigInt('0'), BigInt('0'), BigInt('500000000000000000000'))
  const logs = decoded([
    transfer(0, WETH, WALLET, POOL, BigInt('999999999999999999')), // off by exactly 1 raw unit
    transfer(1, TOKEN_X, POOL, WALLET, BigInt('500000000000000000000')),
  ])
  const result = resolveClassicMultiTransferLeg(swap, logs)
  assert.equal(result.ok, true)
})

test('ambiguous Swap event (both amount0In and amount1In nonzero) is rejected as contradictory_legs', () => {
  const swap = classicSwap(BigInt('1000000000000000000'), BigInt('1'), BigInt('0'), BigInt('500000000000000000000'))
  const logs = decoded([
    transfer(0, WETH, WALLET, POOL, BigInt('1000000000000000000')),
    transfer(1, TOKEN_X, POOL, WALLET, BigInt('500000000000000000000')),
  ])
  const result = resolveClassicMultiTransferLeg(swap, logs)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'contradictory_legs')
})

test('ambiguous token mapping (two different tokens both plausibly match the incoming amount) is rejected', () => {
  const swap = classicSwap(BigInt('1000'), BigInt('0'), BigInt('0'), BigInt('500'))
  const logs = decoded([
    transfer(0, WETH, WALLET, POOL, BigInt('1000')),
    transfer(1, TOKEN_X, WALLET, POOL, BigInt('1000')), // a second, different token also matches exactly
    transfer(2, TOKEN_X, POOL, WALLET, BigInt('500')),
  ])
  const result = resolveClassicMultiTransferLeg(swap, logs)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'contradictory_legs')
})

test('deterministic output: identical input resolves to an identical result across repeated calls', () => {
  const swap = classicSwap(BigInt('1000000000000000000'), BigInt('0'), BigInt('0'), BigInt('500000000000000000000'))
  const logs = decoded([
    transfer(0, WETH, WALLET, POOL, BigInt('600000000000000000')),
    transfer(1, WETH, WALLET, POOL, BigInt('400000000000000000')),
    transfer(2, TOKEN_X, POOL, WALLET, BigInt('500000000000000000000')),
  ])
  const r1 = resolveClassicMultiTransferLeg(swap, logs)
  const r2 = resolveClassicMultiTransferLeg(swap, logs)
  assert.deepEqual(r1, r2)
})

test('mergeMultiTransferDiagnostics sums routerIntermediaryTransfersIgnored and ORs boolean flags across multiple legs', () => {
  const merged = mergeMultiTransferDiagnostics([
    { examined: true, resolved: true, swapEventAmountMatched: true, routerIntermediaryTransfersIgnored: 2, refundNetted: false },
    { examined: true, resolved: true, swapEventAmountMatched: true, routerIntermediaryTransfersIgnored: 3, refundNetted: true },
  ])
  assert.deepEqual(merged, { examined: true, resolved: true, swapEventAmountMatched: true, routerIntermediaryTransfersIgnored: 5, refundNetted: true })
})

test('mergeMultiTransferDiagnostics returns undefined for an empty list', () => {
  assert.equal(mergeMultiTransferDiagnostics([]), undefined)
})
