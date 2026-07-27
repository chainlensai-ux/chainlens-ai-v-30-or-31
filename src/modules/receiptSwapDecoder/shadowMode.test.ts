import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runShadowMode, type ExistingInferenceForTx } from './shadowMode'
import type { ReceiptTxBundle } from './types'
import {
  WALLET, POOL_A, USDC, TOKEN_X, transferLog, classicSwapLog, classicMintLog, alwaysValidValidator,
} from './fixtures.test-helpers'
import { WETH_BASE_ADDRESS } from './signatures'

const WETH = WETH_BASE_ADDRESS.toLowerCase()
const wallet = WALLET.toLowerCase()
const poolA = POOL_A.toLowerCase()
const tokenX = TOKEN_X.toLowerCase()

function bundle(txHash: string, logs: ReceiptTxBundle['logs']): ReceiptTxBundle {
  return {
    chain: 'base', txHash, walletAddress: wallet, router: null, logs,
    tokenMeta: { [WETH]: { symbol: 'WETH', decimals: 18 }, [USDC]: { symbol: 'USDC', decimals: 6 }, [tokenX]: { symbol: 'X', decimals: 18 } },
  }
}

test('shadow mode aggregates counters across a batch without altering any existing inference', async () => {
  const decodable = bundle('0x1', [
    transferLog(0, WETH, wallet, poolA, BigInt("1000000000000000000")),
    classicSwapLog(1, poolA, wallet, BigInt("1000000000000000000"), BigInt("0"), BigInt("0"), BigInt("500000000000000000000")),
    transferLog(2, TOKEN_X, poolA, wallet, BigInt("500000000000000000000")),
  ])
  const lpTx = bundle('0x2', [classicMintLog(0, poolA, wallet)])
  const plainTransferTx = bundle('0x3', [transferLog(0, TOKEN_X, wallet, poolA, BigInt("1"))])

  const existingInference = new Map<string, ExistingInferenceForTx>([
    ['0x1', { txHash: '0x1', tokenIn: WETH, tokenOut: null, missingSide: 'tokenOut' }],
  ])

  const { counters } = await runShadowMode([decodable, lpTx, plainTransferTx], alwaysValidValidator(), existingInference)

  assert.equal(counters.receiptsExamined, 3)
  assert.equal(counters.aerodromeSwapsDecoded, 1)
  assert.equal(counters.exactTwoSidedSwapsRecovered, 1)
  assert.equal(counters.oneLegTransactionsUpgraded, 1)
  assert.equal(counters.candidateLotsUnlocked, 1)
  assert.equal(counters.rejectedNonSwapTransactions, 2)
  assert.equal(counters.newProviderCalls, 1)
})

test('shadow mode flags a disagreement when inference and receipt decode land on different tokens', async () => {
  const decodable = bundle('0x1', [
    transferLog(0, WETH, wallet, poolA, BigInt("1000000000000000000")),
    classicSwapLog(1, poolA, wallet, BigInt("1000000000000000000"), BigInt("0"), BigInt("0"), BigInt("500000000000000000000")),
    transferLog(2, TOKEN_X, poolA, wallet, BigInt("500000000000000000000")),
  ])
  const existingInference = new Map<string, ExistingInferenceForTx>([
    ['0x1', { txHash: '0x1', tokenIn: WETH, tokenOut: USDC, missingSide: 'none' }],
  ])
  const { counters } = await runShadowMode([decodable], alwaysValidValidator(), existingInference)
  assert.equal(counters.inferenceDisagreements, 1)
})

test('shadow mode never reports a disagreement when inference and receipt decode agree', async () => {
  const decodable = bundle('0x1', [
    transferLog(0, WETH, wallet, poolA, BigInt("1000000000000000000")),
    classicSwapLog(1, poolA, wallet, BigInt("1000000000000000000"), BigInt("0"), BigInt("0"), BigInt("500000000000000000000")),
    transferLog(2, TOKEN_X, poolA, wallet, BigInt("500000000000000000000")),
  ])
  const existingInference = new Map<string, ExistingInferenceForTx>([
    ['0x1', { txHash: '0x1', tokenIn: WETH, tokenOut: tokenX, missingSide: 'none' }],
  ])
  const { counters } = await runShadowMode([decodable], alwaysValidValidator(), existingInference)
  assert.equal(counters.inferenceDisagreements, 0)
})

test('shadow mode counters are all zero for an empty batch', async () => {
  const { counters } = await runShadowMode([], alwaysValidValidator(), new Map())
  assert.deepEqual(counters, {
    receiptsExamined: 0,
    aerodromeSwapsDecoded: 0,
    exactTwoSidedSwapsRecovered: 0,
    oneLegTransactionsUpgraded: 0,
    inferenceDisagreements: 0,
    rejectedNonSwapTransactions: 0,
    newProviderCalls: 0,
    candidateLotsUnlocked: 0,
  })
})
