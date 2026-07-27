import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeReceiptSwap } from './index'
import type { ReceiptTxBundle } from './types'
import {
  WALLET, ROUTER, POOL_A, POOL_B, USDC, TOKEN_X, ZERO,
  transferLog, classicSwapLog, slipstreamSwapLog, classicMintLog, classicBurnLog,
  wethDepositLog, alwaysValidValidator, neverValidValidator,
} from './fixtures.test-helpers'
import { WETH_BASE_ADDRESS, CLASSIC_SWAP_TOPIC0 } from './signatures'

const WETH = WETH_BASE_ADDRESS.toLowerCase()
const wallet = WALLET.toLowerCase()
const poolA = POOL_A.toLowerCase()
const poolB = POOL_B.toLowerCase()

function bundle(partial: Partial<ReceiptTxBundle>): ReceiptTxBundle {
  return {
    chain: 'base',
    txHash: '0xabc',
    walletAddress: wallet,
    router: null,
    logs: [],
    tokenMeta: {
      [WETH]: { symbol: 'WETH', decimals: 18 },
      [USDC]: { symbol: 'USDC', decimals: 6 },
      [TOKEN_X.toLowerCase()]: { symbol: 'X', decimals: 18 },
    },
    ...partial,
  }
}

test('Classic buy: wallet spends WETH, receives TOKEN_X — receipt-decoded, exact, two-sided', async () => {
  const tx = bundle({
    logs: [
      transferLog(0, WETH, wallet, poolA, BigInt("1000000000000000000")),
      classicSwapLog(1, poolA, wallet, BigInt("1000000000000000000"), BigInt("0"), BigInt("0"), BigInt("500000000000000000000")),
      transferLog(2, TOKEN_X, poolA, wallet, BigInt("500000000000000000000")),
    ],
  })
  const result = await decodeReceiptSwap(tx, alwaysValidValidator())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.swap.protocol, 'aerodrome_classic')
  assert.equal(result.swap.tokenIn.address, WETH)
  assert.equal(result.swap.tokenOut.address, TOKEN_X.toLowerCase())
  assert.equal(result.swap.walletDirection, 'wallet_bought_tokenOut')
  assert.equal(result.swap.evidenceSource, 'receipt_pool_swap_event')
  assert.equal(result.swap.confidence, 'exact')
  assert.equal(result.swap.amountInRaw, '1000000000000000000')
  assert.equal(result.swap.normalizedAmountIn, 1)
})

test('Classic sell: wallet spends TOKEN_X, receives WETH', async () => {
  const tx = bundle({
    logs: [
      transferLog(0, TOKEN_X, wallet, poolA, BigInt("500000000000000000000")),
      classicSwapLog(1, poolA, wallet, BigInt("0"), BigInt("500000000000000000000"), BigInt("1000000000000000000"), BigInt("0")),
      transferLog(2, WETH, poolA, wallet, BigInt("1000000000000000000")),
    ],
  })
  const result = await decodeReceiptSwap(tx, alwaysValidValidator())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.swap.tokenIn.address, TOKEN_X.toLowerCase())
  assert.equal(result.swap.tokenOut.address, WETH)
  assert.equal(result.swap.walletDirection, 'wallet_sold_tokenIn')
})

test('Slipstream buy: wallet spends WETH, receives USDC', async () => {
  const tx = bundle({
    logs: [
      transferLog(0, WETH, wallet, poolA, BigInt("2000000000000000000")),
      slipstreamSwapLog(1, poolA, wallet, wallet, BigInt("2000000000000000000"), BigInt("-5000000000")),
      transferLog(2, USDC, poolA, wallet, BigInt("5000000000")),
    ],
  })
  const result = await decodeReceiptSwap(tx, alwaysValidValidator())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.swap.protocol, 'aerodrome_slipstream')
  assert.equal(result.swap.tokenIn.address, WETH)
  assert.equal(result.swap.tokenOut.address, USDC)
  assert.equal(result.swap.walletDirection, 'wallet_bought_tokenOut')
  assert.equal(result.swap.normalizedAmountOut, 5000)
})

test('Slipstream sell: wallet spends USDC, receives WETH', async () => {
  const tx = bundle({
    logs: [
      transferLog(0, USDC, wallet, poolA, BigInt("5000000000")),
      slipstreamSwapLog(1, poolA, wallet, wallet, BigInt("-2000000000000000000"), BigInt("5000000000")),
      transferLog(2, WETH, poolA, wallet, BigInt("2000000000000000000")),
    ],
  })
  const result = await decodeReceiptSwap(tx, alwaysValidValidator())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.swap.tokenIn.address, USDC)
  assert.equal(result.swap.tokenOut.address, WETH)
  assert.equal(result.swap.walletDirection, 'wallet_sold_tokenIn')
})

test('multi-hop: WETH -> TOKEN_X (poolA) -> USDC (poolB), nets to one WETH->USDC swap', async () => {
  const tx = bundle({
    logs: [
      transferLog(0, WETH, wallet, poolA, BigInt("1000000000000000000")),
      classicSwapLog(1, poolA, wallet, BigInt("1000000000000000000"), BigInt("0"), BigInt("0"), BigInt("400000000000000000000")),
      transferLog(2, TOKEN_X, poolA, poolB, BigInt("400000000000000000000")),
      classicSwapLog(3, poolB, wallet, BigInt("0"), BigInt("400000000000000000000"), BigInt("3000000000"), BigInt("0")),
      transferLog(4, USDC, poolB, wallet, BigInt("3000000000")),
    ],
  })
  const result = await decodeReceiptSwap(tx, alwaysValidValidator())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.swap.tokenIn.address, WETH)
  assert.equal(result.swap.tokenOut.address, USDC)
  assert.equal(result.swap.meta.hops, 2)
  assert.deepEqual(result.swap.meta.poolsVisited, [poolA, poolB])
  assert.equal(result.swap.evidenceSource, 'receipt_pool_swap_event_multi_hop')
})

test('ETH/WETH wrap: native ETH wrapped via router before the pool swap is flagged, not a separate leg', async () => {
  const router = ROUTER.toLowerCase()
  const tx = bundle({
    router,
    logs: [
      wethDepositLog(0, router, BigInt("1000000000000000000")),
      transferLog(1, WETH, router, poolA, BigInt("1000000000000000000")),
      classicSwapLog(2, poolA, router, BigInt("1000000000000000000"), BigInt("0"), BigInt("0"), BigInt("500000000000000000000")),
      transferLog(3, TOKEN_X, poolA, wallet, BigInt("500000000000000000000")),
    ],
  })
  const result = await decodeReceiptSwap(tx, alwaysValidValidator())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.swap.meta.nativeWrapDetected, true)
  assert.equal(result.swap.tokenIn.address, WETH)
})

test('refund: excess input token routed back to wallet after the swap is diagnostic-only, never re-added to amountInRaw', async () => {
  const router = ROUTER.toLowerCase()
  const tokenX = TOKEN_X.toLowerCase()
  const tx = bundle({
    router,
    logs: [
      transferLog(0, TOKEN_X, wallet, router, BigInt("100000000000000000000")),
      transferLog(1, TOKEN_X, router, poolA, BigInt("80000000000000000000")),
      classicSwapLog(2, poolA, router, BigInt("0"), BigInt("80000000000000000000"), BigInt("1000000000000000000"), BigInt("0")),
      transferLog(3, WETH, poolA, router, BigInt("1000000000000000000")),
      transferLog(4, WETH, router, wallet, BigInt("1000000000000000000")),
      transferLog(5, TOKEN_X, router, wallet, BigInt("20000000000000000000")),
    ],
  })
  const result = await decodeReceiptSwap(tx, alwaysValidValidator())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.swap.tokenIn.address, tokenX)
  assert.equal(result.swap.amountInRaw, '80000000000000000000')
  assert.equal(result.swap.meta.refundDetected, true)
})

test('LP add/remove is never classified as a swap, even alongside a Swap-shaped log', async () => {
  const tx = bundle({
    logs: [
      classicMintLog(0, poolA, wallet),
      transferLog(1, WETH, wallet, poolA, BigInt("1000000000000000000")),
    ],
  })
  const result = await decodeReceiptSwap(tx, alwaysValidValidator())
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.rejection.reason, 'lp_add_or_remove_detected')
})

test('LP burn is rejected the same way', async () => {
  const tx = bundle({ logs: [classicBurnLog(0, poolA, wallet)] })
  const result = await decodeReceiptSwap(tx, alwaysValidValidator())
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.rejection.reason, 'lp_add_or_remove_detected')
})

test('ordinary transfer (no swap event at all) is rejected, not misread as a swap', async () => {
  const tx = bundle({ logs: [transferLog(0, TOKEN_X, wallet, ROUTER.toLowerCase(), BigInt("1"))] })
  const result = await decodeReceiptSwap(tx, alwaysValidValidator())
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.rejection.reason, 'plain_transfer_no_swap_event')
})

test('malformed receipt data fails closed instead of throwing or fabricating a swap', async () => {
  const tx = bundle({
    logs: [{ logIndex: 0, address: poolA, topics: [CLASSIC_SWAP_TOPIC0, `0x${'0'.repeat(64)}`], data: '0xdead' }],
  })
  const result = await decodeReceiptSwap(tx, alwaysValidValidator())
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.rejection.reason, 'malformed_log_data')
})

test('Classic: two transfers into the same pool that sum exactly to the Swap event amount are aggregated, not rejected', async () => {
  // AGGREGATION, DISCLOSED (multiTransferLeg.ts): a duplicated/split incoming transfer whose sum
  // matches the Swap event's own authoritative amount0In is a real, aggregatable pool leg — never
  // "double counted" (the swap event amount, not the transfer sum, is what's reported), and never
  // rejected merely for having more than one transfer on a side.
  const tx = bundle({
    logs: [
      transferLog(0, WETH, wallet, poolA, BigInt("1000000000000000000")),
      transferLog(1, WETH, wallet, poolA, BigInt("1000000000000000000")),
      classicSwapLog(2, poolA, wallet, BigInt("2000000000000000000"), BigInt("0"), BigInt("0"), BigInt("500000000000000000000")),
      transferLog(3, TOKEN_X, poolA, wallet, BigInt("500000000000000000000")),
    ],
  })
  const result = await decodeReceiptSwap(tx, alwaysValidValidator())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.swap.amountInRaw, '2000000000000000000')
  assert.equal(result.swap.tokenIn.address, WETH)
})

test('Slipstream: duplicate identical transfer logs remain contradictory (strict resolver, unchanged)', async () => {
  const tx = bundle({
    logs: [
      transferLog(0, WETH, wallet, poolA, BigInt("1000000000000000000")),
      transferLog(1, WETH, wallet, poolA, BigInt("1000000000000000000")), // duplicate incoming leg
      slipstreamSwapLog(2, poolA, wallet, wallet, BigInt("2000000000000000000"), BigInt("-500000000000000000000")),
      transferLog(3, TOKEN_X, poolA, wallet, BigInt("500000000000000000000")),
    ],
  })
  const result = await decodeReceiptSwap(tx, alwaysValidValidator())
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.rejection.reason, 'contradictory_legs')
})

test('deterministic output: identical input decodes to a byte-identical result across repeated runs', async () => {
  const tx = bundle({
    logs: [
      transferLog(0, WETH, wallet, poolA, BigInt("1000000000000000000")),
      classicSwapLog(1, poolA, wallet, BigInt("1000000000000000000"), BigInt("0"), BigInt("0"), BigInt("500000000000000000000")),
      transferLog(2, TOKEN_X, poolA, wallet, BigInt("500000000000000000000")),
    ],
  })
  const r1 = await decodeReceiptSwap(tx, alwaysValidValidator())
  const r2 = await decodeReceiptSwap(tx, alwaysValidValidator())
  assert.deepEqual(r1, r2)
})

test('pool not confirmed by the canonical factory fails closed to inference', async () => {
  const tx = bundle({
    logs: [
      transferLog(0, WETH, wallet, poolA, BigInt("1000000000000000000")),
      classicSwapLog(1, poolA, wallet, BigInt("1000000000000000000"), BigInt("0"), BigInt("0"), BigInt("500000000000000000000")),
      transferLog(2, TOKEN_X, poolA, wallet, BigInt("500000000000000000000")),
    ],
  })
  const result = await decodeReceiptSwap(tx, neverValidValidator())
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.rejection.reason, 'pool_not_validated_by_factory')
})

test('empty receipt (no logs) is rejected as no_logs, not silently treated as a swap', async () => {
  const tx = bundle({ logs: [] })
  const result = await decodeReceiptSwap(tx, alwaysValidValidator())
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.rejection.reason, 'no_logs')
})

// PRODUCTION FIXTURE, DISCLOSED (this task's exact reported evidence): likelyRoute: aerodrome_classic,
// aerodromeSwapEventCount: 1, transferCount: 6, wrapCount: 1 — previously rejected as
// contradictory_legs purely because the old resolver required exactly one incoming and one outgoing
// transfer touching the pool. Reconstructed here: wallet wraps ETH via the router (wrap #1), the
// router forwards the WETH to the pool split across two transfers (aggregated), the pool pays out
// TOKEN_X to the router which forwards it to the wallet, and the router refunds a small leftover
// WETH amount back to the wallet — 6 total ERC20 transfers, 1 wrap, 1 recognized Swap event.
test('production fixture: multi-transfer router-mediated Classic swap (6 transfers, 1 wrap) resolves exactly instead of contradictory_legs', async () => {
  const router = ROUTER.toLowerCase()
  const tx = bundle({
    router,
    logs: [
      wethDepositLog(0, router, BigInt('1000000000000000000')), // wrap #1
      transferLog(1, WETH, wallet, router, BigInt('1000000000000000000')), // #1: wallet -> router (ignored, doesn't touch pool)
      transferLog(2, WETH, router, poolA, BigInt('600000000000000000')), // #2: router -> pool (split leg A)
      transferLog(3, WETH, router, poolA, BigInt('400000000000000000')), // #3: router -> pool (split leg B)
      classicSwapLog(4, poolA, router, BigInt('1000000000000000000'), BigInt('0'), BigInt('0'), BigInt('500000000000000000000')),
      transferLog(5, TOKEN_X, poolA, router, BigInt('500000000000000000000')), // #4: pool -> router
      transferLog(6, TOKEN_X, router, wallet, BigInt('500000000000000000000')), // #5: router -> wallet (ignored, doesn't touch pool)
      transferLog(7, WETH, router, wallet, BigInt('50000000000000000')), // #6: refund of unused WETH (ignored, doesn't touch pool)
    ],
  })
  const result = await decodeReceiptSwap(tx, alwaysValidValidator())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.swap.protocol, 'aerodrome_classic')
  assert.equal(result.swap.tokenIn.address, WETH)
  assert.equal(result.swap.tokenOut.address, TOKEN_X)
  assert.equal(result.swap.amountInRaw, '1000000000000000000')
  assert.equal(result.swap.amountOutRaw, '500000000000000000000')
  assert.equal(result.swap.meta.nativeWrapDetected, true)
  assert.equal(result.swap.meta.refundDetected, true)
  assert.ok(result.swap.meta.multiTransfer)
  assert.equal(result.swap.meta.multiTransfer?.resolved, true)
  assert.equal(result.swap.meta.multiTransfer?.swapEventAmountMatched, true)
  assert.equal(result.swap.meta.multiTransfer?.routerIntermediaryTransfersIgnored, 3)
  assert.equal(result.swap.meta.multiTransfer?.refundNetted, true)
})

void ZERO
