// TESTS — evidence-first PnL completion follow-up task, requirement #2: [contradictory-legs-audit].

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeReceiptSwap } from './index'
import type { ReceiptTxBundle } from './types'
import {
  WALLET, POOL_A, USDC, TOKEN_X, transferLog, slipstreamSwapLog, alwaysValidValidator,
} from './fixtures.test-helpers'
import { WETH_BASE_ADDRESS } from './signatures'

const WETH = WETH_BASE_ADDRESS.toLowerCase()
const wallet = WALLET.toLowerCase()
const poolA = POOL_A.toLowerCase()

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

const originalConsoleWarn = console.warn
function captureWarnings(): { calls: unknown[][]; restore: () => void } {
  const calls: unknown[][] = []
  console.warn = (...args: unknown[]) => { calls.push(args) }
  return { calls, restore: () => { console.warn = originalConsoleWarn } }
}

test('HARD ASSERTION: a real contradictory_legs rejection logs ordered swaps, pool-touching transfers, per-token net totals, and expected/observed deltas', async () => {
  const { calls, restore } = captureWarnings()
  try {
    const tx = bundle({
      logs: [
        transferLog(0, WETH, wallet, poolA, BigInt('2000000000000000000')),
        transferLog(1, USDC, wallet, poolA, BigInt('2000000000000000000')),
        slipstreamSwapLog(2, poolA, wallet, wallet, BigInt('2000000000000000000'), BigInt('-500000000000000000000')),
        transferLog(3, TOKEN_X, poolA, wallet, BigInt('500000000000000000000')),
      ],
    })
    const result = await decodeReceiptSwap(tx, alwaysValidValidator())
    restore()
    assert.equal(result.ok, false)

    const auditCall = calls.find((c) => c[0] === '[contradictory-legs-audit]')
    assert.ok(auditCall, 'a contradictory_legs rejection must log the required audit entry')
    const payload = auditCall![1] as Record<string, unknown>
    assert.equal(payload.txHash, '0xabc')
    assert.equal((payload.orderedSwaps as unknown[]).length, 1)
    const swapEntry = (payload.orderedSwaps as Record<string, unknown>[])[0]
    assert.equal(swapEntry.poolAddress, poolA)
    assert.equal(swapEntry.amount0, '2000000000000000000')
    assert.equal(swapEntry.amount1, '-500000000000000000000')
    assert.ok(Array.isArray(swapEntry.incomingTransfersByToken))
    assert.equal((swapEntry.incomingTransfersByToken as unknown[]).length, 2, 'both WETH and USDC candidates must be reported')
    assert.ok(Array.isArray(payload.poolTouchingTransfers))
    assert.equal((payload.poolTouchingTransfers as unknown[]).length, 3)
    assert.ok(Array.isArray(payload.perTokenNetTotalsRaw))
  } finally {
    restore()
  }
})

test('a successful (non-contradictory) decode never logs the contradictory-legs audit', async () => {
  const { calls, restore } = captureWarnings()
  try {
    const tx = bundle({
      logs: [
        transferLog(0, WETH, wallet, poolA, BigInt('1000000000000000000')),
        slipstreamSwapLog(1, poolA, wallet, wallet, BigInt('1000000000000000000'), BigInt('-500000000000000000000')),
        transferLog(2, TOKEN_X, poolA, wallet, BigInt('500000000000000000000')),
      ],
    })
    const result = await decodeReceiptSwap(tx, alwaysValidValidator())
    restore()
    assert.equal(result.ok, true)
    assert.equal(calls.find((c) => c[0] === '[contradictory-legs-audit]'), undefined)
  } finally {
    restore()
  }
})

test('a swap_event_amount_mismatch rejection (not contradictory_legs) does not log this specific audit', async () => {
  const { calls, restore } = captureWarnings()
  try {
    const tx = bundle({
      logs: [
        transferLog(0, WETH, wallet, poolA, BigInt('900000000000000000')), // short
        slipstreamSwapLog(1, poolA, wallet, wallet, BigInt('1000000000000000000'), BigInt('-500000000000000000000')),
        transferLog(2, TOKEN_X, poolA, wallet, BigInt('500000000000000000000')),
      ],
    })
    const result = await decodeReceiptSwap(tx, alwaysValidValidator())
    restore()
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.rejection.reason, 'swap_event_amount_mismatch')
    assert.equal(calls.find((c) => c[0] === '[contradictory-legs-audit]'), undefined)
  } finally {
    restore()
  }
})
