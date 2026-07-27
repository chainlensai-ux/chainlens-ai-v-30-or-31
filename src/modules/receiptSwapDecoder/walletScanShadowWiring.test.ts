import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWalletScanReceiptShadowMode, type WalletScanSwapCandidate } from './walletScanShadowWiring'
import type { RawReceiptLog } from './types'
import {
  WALLET, POOL_A, USDC, TOKEN_X, transferLog, classicSwapLog, alwaysValidValidator, neverValidValidator,
} from './fixtures.test-helpers'
import { WETH_BASE_ADDRESS } from './signatures'

const WETH = WETH_BASE_ADDRESS.toLowerCase()
const wallet = WALLET.toLowerCase()
const poolA = POOL_A.toLowerCase()
const tokenX = TOKEN_X.toLowerCase()

function decodableLogs(): RawReceiptLog[] {
  return [
    transferLog(0, WETH, wallet, poolA, BigInt('1000000000000000000')),
    classicSwapLog(1, poolA, wallet, BigInt('1000000000000000000'), BigInt('0'), BigInt('0'), BigInt('500000000000000000000')),
    transferLog(2, TOKEN_X, poolA, wallet, BigInt('500000000000000000000')),
  ]
}

function tokenMeta() {
  return { [WETH]: { symbol: 'WETH', decimals: 18 }, [USDC]: { symbol: 'USDC', decimals: 6 }, [tokenX]: { symbol: 'X', decimals: 18 } }
}

test('existing receipt data is reused: a candidate with logs already supplied is examined, no fetch happens', async () => {
  const candidates: WalletScanSwapCandidate[] = [
    { chain: 'base', txHash: '0x1', inferredTokenIn: WETH, inferredTokenOut: tokenX, inferredAmountIn: 1, inferredAmountOut: 500, inferredMissingSide: 'none' },
  ]
  const result = await runWalletScanReceiptShadowMode({
    walletAddress: wallet,
    candidates,
    logsByTxHash: new Map([['0x1', decodableLogs()]]),
    tokenMeta: tokenMeta(),
    validator: alwaysValidValidator(),
  })
  assert.equal(result.counters.receiptsAvailable, 1)
  assert.equal(result.counters.receiptsMissing, 0)
  assert.equal(result.counters.receiptsExamined, 1)
  assert.equal(result.counters.aerodromeSwapsDecoded, 1)
  assert.equal(result.counters.inferenceAgreements, 1)
  assert.equal(result.counters.inferenceDisagreements, 0)
})

test('missing receipts cause no fetch: a candidate with no logs in the map is counted as receiptsMissing, decode never runs', async () => {
  const candidates: WalletScanSwapCandidate[] = [
    { chain: 'base', txHash: '0x1', inferredTokenIn: WETH, inferredTokenOut: tokenX, inferredAmountIn: 1, inferredAmountOut: 500, inferredMissingSide: 'none' },
    { chain: 'base', txHash: '0x2', inferredTokenIn: WETH, inferredTokenOut: null, inferredAmountIn: 2, inferredAmountOut: null, inferredMissingSide: 'tokenOut' },
  ]
  const result = await runWalletScanReceiptShadowMode({
    walletAddress: wallet,
    candidates,
    logsByTxHash: new Map(), // genuinely absent for every candidate — this codebase's real today
    tokenMeta: tokenMeta(),
    validator: alwaysValidValidator(),
  })
  assert.equal(result.counters.receiptsMissing, 2)
  assert.equal(result.counters.receiptsAvailable, 0)
  assert.equal(result.counters.receiptsExamined, 0)
  assert.equal(result.counters.aerodromeSwapsDecoded, 0)
  // No pool-factory validation call was ever triggered — decode was never attempted.
  assert.equal(result.counters.newProviderCalls, 0)
})

test('counters are deterministic: identical input produces byte-identical diagnostics across repeated runs', async () => {
  const candidates: WalletScanSwapCandidate[] = [
    { chain: 'base', txHash: '0x1', inferredTokenIn: WETH, inferredTokenOut: USDC, inferredAmountIn: 1, inferredAmountOut: 5000, inferredMissingSide: 'none' },
  ]
  const opts = {
    walletAddress: wallet,
    candidates,
    logsByTxHash: new Map([['0x1', decodableLogs()]]),
    tokenMeta: tokenMeta(),
    validator: alwaysValidValidator(),
  }
  const r1 = await runWalletScanReceiptShadowMode(opts)
  const r2 = await runWalletScanReceiptShadowMode(opts)
  assert.deepEqual(r1, r2)
})

test('disagreements do not alter FIFO: shadow mode input candidates and logs are never mutated', async () => {
  const candidates: WalletScanSwapCandidate[] = [
    { chain: 'base', txHash: '0x1', inferredTokenIn: WETH, inferredTokenOut: USDC, inferredAmountIn: 1, inferredAmountOut: 999, inferredMissingSide: 'none' },
  ]
  const logs = decodableLogs()
  const candidatesSnapshot = JSON.parse(JSON.stringify(candidates))
  const logsSnapshot = JSON.parse(JSON.stringify(logs))

  const result = await runWalletScanReceiptShadowMode({
    walletAddress: wallet,
    candidates,
    logsByTxHash: new Map([['0x1', logs]]),
    tokenMeta: tokenMeta(),
    validator: alwaysValidValidator(),
  })

  // A real disagreement occurred (inferred USDC, decoded X) — proves the assertion isn't vacuous.
  assert.equal(result.counters.inferenceDisagreements, 1)
  // The function's own inputs were never touched — this is a pure read, never a write path into
  // whatever produced these candidates (routerTradeReconstruction's real output in the live pipeline).
  assert.deepEqual(candidates, candidatesSnapshot)
  assert.deepEqual(logs, logsSnapshot)
  // The returned diagnostics carry no lot/event-shaped structure at all — only counters/strings.
  assert.equal('matchedLots' in result, false)
  assert.equal('normalizedEvents' in result, false)
})

test('candidateLotsUnlocked is attribution-only: it counts, but returns no lot object, no FIFO structure', async () => {
  const candidates: WalletScanSwapCandidate[] = [
    { chain: 'base', txHash: '0x1', inferredTokenIn: WETH, inferredTokenOut: null, inferredAmountIn: 1, inferredAmountOut: null, inferredMissingSide: 'tokenOut' },
  ]
  const result = await runWalletScanReceiptShadowMode({
    walletAddress: wallet,
    candidates,
    logsByTxHash: new Map([['0x1', decodableLogs()]]),
    tokenMeta: tokenMeta(),
    validator: alwaysValidValidator(),
  })
  assert.equal(result.counters.candidateLotsUnlocked, 1)
  assert.equal(result.counters.oneLegTransactionsUpgraded, 1)
  // The sample records the attribution reason without ever exposing a lot-shaped object.
  const sample = result.disagreementSamples.find((s) => s.txHash === '0x1')
  assert.ok(sample)
  assert.equal(sample?.wouldCompleteMissingLotSide, true)
  assert.equal(typeof sample?.decodedTokenIn, 'string')
})

test('provider call count is unchanged: pool validation is only invoked once per decoded candidate, never per missing-receipt candidate', async () => {
  const candidates: WalletScanSwapCandidate[] = [
    { chain: 'base', txHash: '0x1', inferredTokenIn: WETH, inferredTokenOut: tokenX, inferredAmountIn: 1, inferredAmountOut: 500, inferredMissingSide: 'none' },
    { chain: 'base', txHash: '0x2', inferredTokenIn: null, inferredTokenOut: null, inferredAmountIn: null, inferredAmountOut: null, inferredMissingSide: 'none' },
    { chain: 'base', txHash: '0x3', inferredTokenIn: null, inferredTokenOut: null, inferredAmountIn: null, inferredAmountOut: null, inferredMissingSide: 'none' },
  ]
  const result = await runWalletScanReceiptShadowMode({
    walletAddress: wallet,
    candidates,
    logsByTxHash: new Map([['0x1', decodableLogs()]]), // only one of three candidates has logs
    tokenMeta: tokenMeta(),
    validator: alwaysValidValidator(),
  })
  assert.equal(result.counters.newProviderCalls, 1)
  assert.equal(result.counters.receiptsMissing, 2)
})

test('a rejected pool validation still fails closed and is never silently treated as an agreement', async () => {
  const candidates: WalletScanSwapCandidate[] = [
    { chain: 'base', txHash: '0x1', inferredTokenIn: WETH, inferredTokenOut: tokenX, inferredAmountIn: 1, inferredAmountOut: 500, inferredMissingSide: 'none' },
  ]
  const result = await runWalletScanReceiptShadowMode({
    walletAddress: wallet,
    candidates,
    logsByTxHash: new Map([['0x1', decodableLogs()]]),
    tokenMeta: tokenMeta(),
    validator: neverValidValidator(),
  })
  assert.equal(result.counters.aerodromeSwapsDecoded, 0)
  assert.equal(result.rejectionReasons.pool_not_validated_by_factory, 1)
  assert.equal(result.counters.inferenceAgreements, 0)
})

test('non-base candidates are never processed, even if logs are supplied for them', async () => {
  const candidates: WalletScanSwapCandidate[] = [
    { chain: 'eth', txHash: '0x1', inferredTokenIn: WETH, inferredTokenOut: tokenX, inferredAmountIn: 1, inferredAmountOut: 500, inferredMissingSide: 'none' },
  ]
  const result = await runWalletScanReceiptShadowMode({
    walletAddress: wallet,
    candidates,
    logsByTxHash: new Map([['0x1', decodableLogs()]]),
    tokenMeta: tokenMeta(),
    validator: alwaysValidValidator(),
  })
  assert.deepEqual(result.counters, {
    receiptsAvailable: 0, receiptsMissing: 0, receiptsExamined: 0, aerodromeSwapsDecoded: 0,
    exactTwoSidedSwapsRecovered: 0, oneLegTransactionsUpgraded: 0, inferenceAgreements: 0,
    inferenceDisagreements: 0, rejectedNonSwapTransactions: 0, candidateLotsUnlocked: 0, newProviderCalls: 0,
  })
})

test('disagreement samples are bounded to 10 even with many disagreeing candidates', async () => {
  const candidates: WalletScanSwapCandidate[] = Array.from({ length: 15 }, (_, i) => ({
    chain: 'base', txHash: `0x${i}`, inferredTokenIn: WETH, inferredTokenOut: USDC, inferredAmountIn: 1, inferredAmountOut: 1, inferredMissingSide: 'none' as const,
  }))
  const logsByTxHash = new Map(candidates.map((c) => [c.txHash, decodableLogs()]))
  const result = await runWalletScanReceiptShadowMode({
    walletAddress: wallet, candidates, logsByTxHash, tokenMeta: tokenMeta(), validator: alwaysValidValidator(),
  })
  assert.equal(result.counters.inferenceDisagreements, 15)
  assert.equal(result.disagreementSamples.length, 10)
})
