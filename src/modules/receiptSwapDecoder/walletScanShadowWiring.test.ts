import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runWalletScanReceiptShadowMode, buildWalletScanShadowLogPayload,
  type WalletScanSwapCandidate,
} from './walletScanShadowWiring'
import type { CandidateTxEvidence } from './candidateSelector'
import type { RawReceiptLog } from './types'
import {
  WALLET, ROUTER, POOL_A, USDC, TOKEN_X, transferLog, classicSwapLog, wethDepositLog, alwaysValidValidator, neverValidValidator,
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
    multiTransferPoolFlowsExamined: 0, multiTransferPoolFlowsResolved: 0, swapEventAmountMatches: 0,
    swapEventAmountMismatches: 0, routerIntermediaryTransfersIgnored: 0, refundsNetted: 0,
    uniswapV3PoolsExamined: 0, uniswapV3PoolsValidated: 0, uniswapV3ValidationCalls: 0,
    uniswapV3SwapsDecoded: 0, uniswapV3AmountMatches: 0, uniswapV3AmountMismatches: 0,
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

// ─── Pipeline-integration tests: buildWalletScanShadowLogPayload ────────────────────────────────
// These exercise the EXACT function src/pipeline/index.ts calls and unconditionally logs the
// return value of — proving the real production pipeline emits diagnostics even when
// logsByTxHash is empty (today's real-world case), and that it emits a typed skip reason instead
// of silence whenever the shadow module is skipped.

function ev(overrides: Partial<CandidateTxEvidence> & { txHash: string }): CandidateTxEvidence {
  return {
    chain: 'base',
    legs: [
      { contract: WETH, direction: 'outbound', amount: 1 },
      { contract: tokenX, direction: 'inbound', amount: 500 },
    ],
    walletInvolved: true,
    isKnownRouter: false,
    routerConfidence: null,
    hasVerifiedQuoteAddress: false,
    isExistingSwapCandidate: true,
    isBridgeCandidate: false,
    isLpStakingOrBurn: false,
    missingClosedLotSide: null,
    economicValueUsd: null,
    ...overrides,
  }
}

function missingFetcher() {
  return async () => ({ status: 'missing' as const })
}

function okFetcher(logs: ReturnType<typeof decodableLogs>) {
  return async () => ({ status: 'ok' as const, logs })
}

test('production pipeline shape: non-empty base evidence with no receipts available still produces enabled:true diagnostics', async () => {
  const evidence: CandidateTxEvidence[] = [ev({ txHash: '0x1' }), ev({ txHash: '0x2' })]
  const payload = await buildWalletScanShadowLogPayload({
    walletAddress: wallet,
    evidence,
    tokenMeta: tokenMeta(),
    validator: alwaysValidValidator(),
    disabledByEnv: false,
    receiptFetcher: missingFetcher(),
  })
  assert.equal(payload.enabled, true)
  if (!payload.enabled) return
  assert.equal(payload.baseSwapCandidates, 2)
  assert.equal(payload.selectorTransactionsConsidered, 2)
  assert.equal(payload.selectorEligibleCandidates, 2)
  assert.equal(payload.receiptCandidatesSelected, 2)
  assert.equal(payload.receiptProviderCalls, 2)
  assert.equal(payload.receiptMissingResults, 2)
  assert.equal(payload.receiptsMissing, 2)
  assert.equal(payload.receiptsAvailable, 0)
  assert.equal(payload.receiptsExamined, 0)
  assert.equal(payload.aerodromeSwapsDecoded, 0)
  assert.equal(payload.candidateLotsUnlocked, 0)
  assert.equal(payload.poolValidationProviderCalls, 0)
  assert.equal(payload.newProviderCalls, 2)
})

test('production pipeline shape: zero evidence logs a typed no_candidates skip reason, never silence', async () => {
  const payload = await buildWalletScanShadowLogPayload({
    walletAddress: wallet,
    evidence: [],
    validator: alwaysValidValidator(),
    disabledByEnv: false,
  })
  assert.deepEqual(payload, { enabled: false, skipReason: 'no_candidates', baseSwapCandidates: 0 })
})

test('production pipeline shape: evidence exists but none is on base logs unsupported_chain', async () => {
  const evidence: CandidateTxEvidence[] = [ev({ txHash: '0x1', chain: 'eth' })]
  const payload = await buildWalletScanShadowLogPayload({
    walletAddress: wallet,
    evidence,
    validator: alwaysValidValidator(),
    disabledByEnv: false,
  })
  assert.deepEqual(payload, { enabled: false, skipReason: 'unsupported_chain', baseSwapCandidates: 0 })
})

test('production pipeline shape: evidence exists on base but none is eligible logs no_candidates', async () => {
  const evidence: CandidateTxEvidence[] = [ev({
    txHash: '0x1',
    isExistingSwapCandidate: false,
    legs: [{ contract: tokenX, direction: 'outbound', amount: 1 }], // one-leg, no router, no other signal
  })]
  const payload = await buildWalletScanShadowLogPayload({
    walletAddress: wallet,
    evidence,
    validator: alwaysValidValidator(),
    disabledByEnv: false,
  })
  assert.deepEqual(payload, { enabled: false, skipReason: 'no_candidates', baseSwapCandidates: 0 })
})

test('production pipeline shape: the env kill switch produces shadow_disabled, independent of candidate count', async () => {
  const evidence: CandidateTxEvidence[] = [ev({ txHash: '0x1' })]
  const payload = await buildWalletScanShadowLogPayload({
    walletAddress: wallet,
    evidence,
    validator: alwaysValidValidator(),
    disabledByEnv: true,
  })
  assert.deepEqual(payload, { enabled: false, skipReason: 'shadow_disabled', baseSwapCandidates: 0 })
})

test('production pipeline shape: when a receipt IS successfully fetched for a base candidate, real decode diagnostics surface', async () => {
  const evidence: CandidateTxEvidence[] = [ev({ txHash: '0x1' })]
  const payload = await buildWalletScanShadowLogPayload({
    walletAddress: wallet,
    evidence,
    tokenMeta: tokenMeta(),
    validator: alwaysValidValidator(),
    disabledByEnv: false,
    receiptFetcher: okFetcher(decodableLogs()),
  })
  assert.equal(payload.enabled, true)
  if (!payload.enabled) return
  assert.equal(payload.receiptsAvailable, 1)
  assert.equal(payload.aerodromeSwapsDecoded, 1)
  assert.equal(payload.receiptProviderCalls, 1)
  assert.equal(payload.poolValidationProviderCalls, 1)
  assert.equal(payload.newProviderCalls, 2)
})

test('production pipeline shape: receipt fetching is capped at 10 even with more than 10 eligible candidates', async () => {
  const evidence: CandidateTxEvidence[] = Array.from({ length: 25 }, (_, i) => ev({ txHash: `0x${i.toString().padStart(3, '0')}` }))
  const payload = await buildWalletScanShadowLogPayload({
    walletAddress: wallet,
    evidence,
    validator: alwaysValidValidator(),
    disabledByEnv: false,
    receiptFetcher: missingFetcher(),
  })
  assert.equal(payload.enabled, true)
  if (!payload.enabled) return
  assert.equal(payload.baseSwapCandidates, 25)
  assert.equal(payload.receiptCandidatesTotal, 25)
  assert.equal(payload.receiptCandidatesSelected, 10)
  assert.equal(payload.receiptCandidatesCapped, 15)
  assert.equal(payload.receiptProviderCalls, 10)
  assert.ok(payload.receiptProviderCalls <= 10)
})

test('production pipeline shape: identical inputs produce a deterministic payload across repeated calls', async () => {
  const evidence: CandidateTxEvidence[] = [ev({ txHash: '0x1' })]
  const opts = {
    walletAddress: wallet,
    evidence,
    validator: alwaysValidValidator(),
    disabledByEnv: false,
    receiptFetcher: missingFetcher(),
  }
  const p1 = await buildWalletScanShadowLogPayload(opts)
  const p2 = await buildWalletScanShadowLogPayload(opts)
  assert.deepEqual(p1, p2)
})

test('production pipeline shape: receiptForensics is bounded to 10 and never increases provider-call counts', async () => {
  const evidence: CandidateTxEvidence[] = Array.from({ length: 25 }, (_, i) => ev({ txHash: `0x${i.toString().padStart(3, '0')}` }))
  const payload = await buildWalletScanShadowLogPayload({
    walletAddress: wallet,
    evidence,
    validator: alwaysValidValidator(),
    disabledByEnv: false,
    receiptFetcher: okFetcher(decodableLogs()),
  })
  assert.equal(payload.enabled, true)
  if (!payload.enabled) return
  assert.ok(payload.receiptForensics.length <= 10)
  assert.equal(payload.receiptForensics.length, 10)
  // Pool validation happens once per examined receipt, exactly matching the real decode path --
  // the forensic recording wrapper never triggers an extra validation call.
  assert.equal(payload.poolValidationProviderCalls, 10)
  assert.equal(payload.receiptProviderCalls, 10)
})

test('production pipeline shape: a multi-transfer router-mediated Classic swap resolves and surfaces the new multi-transfer counters', async () => {
  const router = ROUTER.toLowerCase()
  const multiTransferLogs = [
    wethDepositLog(0, router, BigInt('1000000000000000000')),
    transferLog(1, WETH, wallet, router, BigInt('1000000000000000000')),
    transferLog(2, WETH, router, poolA, BigInt('600000000000000000')),
    transferLog(3, WETH, router, poolA, BigInt('400000000000000000')),
    classicSwapLog(4, poolA, router, BigInt('1000000000000000000'), BigInt('0'), BigInt('0'), BigInt('500000000000000000000')),
    transferLog(5, TOKEN_X, poolA, router, BigInt('500000000000000000000')),
    transferLog(6, TOKEN_X, router, wallet, BigInt('500000000000000000000')),
    transferLog(7, WETH, router, wallet, BigInt('50000000000000000')),
  ]
  const evidence: CandidateTxEvidence[] = [ev({ txHash: '0x1' })]
  const payload = await buildWalletScanShadowLogPayload({
    walletAddress: wallet,
    evidence,
    tokenMeta: tokenMeta(),
    validator: alwaysValidValidator(),
    disabledByEnv: false,
    receiptFetcher: okFetcher(multiTransferLogs),
  })
  assert.equal(payload.enabled, true)
  if (!payload.enabled) return
  assert.equal(payload.aerodromeSwapsDecoded, 1)
  assert.equal(payload.multiTransferPoolFlowsExamined, 1)
  assert.equal(payload.multiTransferPoolFlowsResolved, 1)
  assert.equal(payload.swapEventAmountMatches, 1)
  assert.equal(payload.swapEventAmountMismatches, 0)
  assert.equal(payload.routerIntermediaryTransfersIgnored, 3)
  assert.equal(payload.refundsNetted, 1)
  assert.equal(payload.exactTwoSidedSwapsRecovered, 1)
})
