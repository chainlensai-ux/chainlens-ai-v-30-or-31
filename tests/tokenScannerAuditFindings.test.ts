import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  clarkPartialMustNotBecomeOpenCheck,
  formatTokenScannerPublicStatus,
  hasForbiddenTokenScannerStatusVocab,
  rewriteForbiddenStatusVocab,
} from '../lib/tokenScannerPublicStatus.ts'
import { formatHolderCountDisplay } from '../lib/tokenScannerHolderCount.ts'
import {
  buildTokenScannerPipelineAudit,
  cortexIdentityMatchesScanner,
  TOKEN_SCANNER_RISK_SCORE_SOURCE,
} from '../lib/tokenScannerPipelineAudit.ts'
import {
  buildTradingSimulationCacheKey,
  classifyTradingSimulation,
  isTradingSimulationCacheHitValid,
  isTradingSimulationSuccessCacheable,
  robinhoodSimulationCacheTtlMs,
  tradingSimulationCacheTtlSeconds,
  TRADING_SIM_FAILURE_TTL_SECONDS,
  TRADING_SIM_SUCCESS_TTL_SECONDS,
} from '../lib/tradingSimulation.ts'
import {
  detectKnownLpProtocol,
  resolveLpSafetyFinalState,
  type LpSafetyResolutionInput,
} from '../lib/lpSafetyResolution.ts'
import { calculateTokenRiskScore } from '../lib/server/riskScore.ts'
import {
  DEV_SUPPLY_DEPLOYER_UNRESOLVED,
  GRAPH_NOT_RUN_PREFIX,
  GRAPH_RAN_NONE_LABEL,
  NOT_IN_INDEXED_HOLDER_ROWS,
  classifyTokenScannerEvidence,
} from '../lib/tokenScannerEvidence.ts'
import {
  formatFastTokenRead,
  formatTokenScanResult,
  formatTokenSecurityStatus,
  renderClarkTokenVerdictForEvm,
  type TokenScanEvidence,
} from '../lib/server/clarkRouting.ts'
import { calculateCortexScoreV2 } from '../lib/token/scoring.ts'

const page = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
const simServer = readFileSync(new URL('../lib/server/tradingSimulation.ts', import.meta.url), 'utf8')
const rhSim = readFileSync(new URL('../lib/server/robinhoodHoneypotSimulation.ts', import.meta.url), 'utf8')

const lpBase: LpSafetyResolutionInput = {
  chainId: 8453,
  tokenAddress: '0x0000000000000000000000000000000000000001',
  selectedPoolAddress: '0x0000000000000000000000000000000000000002',
  selectedPoolDex: 'uniswap-v2',
  selectedPoolSource: 'primary_market',
  poolType: 'v2',
  token0: '0x0000000000000000000000000000000000000001',
  token1: '0x0000000000000000000000000000000000000003',
  lpTokenAddress: '0x0000000000000000000000000000000000000002',
  totalSupplyRead: true,
  rpcAttempted: true,
  rpcCallsMade: 6,
  proofAttempted: true,
  holdersReturned: 0,
  burnSharePct: null,
  deadSharePct: null,
  dominantHolder: null,
  controllerType: 'unknown',
  positionProofAttempted: false,
  positionProofStatus: null,
  lockStatus: 'unverified',
  burnStatus: 'unverified',
  exitRisk: 'open_check',
  exitRiskReason: 'LP holder endpoint returned no rows.',
  failureReason: 'holder_rows_missing',
}

test('status vocabulary never emits Open Check / Model Open Check / bare Unknown', () => {
  assert.equal(formatTokenScannerPublicStatus('unknown'), 'Unavailable: evidence was not confirmed in this scan')
  assert.equal(formatTokenScannerPublicStatus('open_check', 'ownership not confirmed'), 'Unavailable: ownership not confirmed')
  assert.equal(formatTokenScannerPublicStatus('Model Open Check'), 'Unavailable: evidence was not confirmed in this scan')
  assert.equal(formatTokenScannerPublicStatus(null, 'rpc timed out'), 'Unavailable: rpc timed out')
  assert.equal(formatTokenScannerPublicStatus('partial', 'holder rows incomplete'), 'Partial: holder rows incomplete')
  assert.equal(formatTokenScannerPublicStatus('not_applicable', 'concentrated LP'), 'Not Applicable: concentrated LP')
  assert.equal(formatTokenScannerPublicStatus('verified'), 'Verified')
  assert.equal(
    formatTokenScannerPublicStatus('pending', null, { fastModeSkipped: true }),
    'Not Checked: fast scan skipped security simulation',
  )
  assert.equal(hasForbiddenTokenScannerStatusVocab(formatTokenScannerPublicStatus('unknown')), false)
  assert.equal(hasForbiddenTokenScannerStatusVocab(rewriteForbiddenStatusVocab('Open Check — simulation timed out')), false)
  assert.match(clarkPartialMustNotBecomeOpenCheck('Partial Evidence', 'LP and holders incomplete'), /^Partial:/)
  assert.doesNotMatch(clarkPartialMustNotBecomeOpenCheck('Partial Evidence'), /Open Check/i)
})

test('cleanStatusLabel in Token Scanner uses the shared public status helper', () => {
  assert.match(page, /function cleanStatusLabel\(/)
  assert.match(page, /return formatTokenScannerPublicStatus\(value, reason\)/)
  assert.doesNotMatch(page, /case 'unknown': return 'Open Check'/)
})

test('Clark Partial Evidence and token formatters never become Open Check', () => {
  const ev: TokenScanEvidence = {
    ok: false,
    token: { name: 'Test', symbol: 'TEST', address: '0x0000000000000000000000000000000000000001' },
    riskScore: 75,
    riskLabel: 'High Risk',
    riskScoreType: 'risk_score',
  }
  const answer = renderClarkTokenVerdictForEvm(ev, ev.token!.address!, 'Base', false)
  assert.doesNotMatch(answer, /Open Check/i)
  assert.match(answer, /Partial:/)
  const scan = formatTokenScanResult(ev, 'Base')
  assert.doesNotMatch(scan, /Open Check/i)
  const fast = formatFastTokenRead(ev, 'Base')
  assert.doesNotMatch(fast, /Open Check/i)
  assert.match(fast, /Not Checked: fast scan skipped/)
  assert.match(formatTokenSecurityStatus({ simulationStatus: 'timeout' }), /^Unavailable:/)
  assert.match(formatTokenSecurityStatus({ simulationStatus: 'not_supported' }), /^Unsupported:/)
})

test('canonical risk source is calculateTokenRiskScore for all public surfaces', () => {
  const scored = calculateTokenRiskScore({
    marketCapUsd: 50_000_000,
    liquidityUsd: 2_000_000,
    holderDistribution: { top1: 8, top5: 20, top10: 35 },
    lpControl: { status: 'burned', burnStatus: 'burned', lpControllerType: 'burn' },
    lpLockStatus: 'burned',
    sourceVerified: true,
  })
  assert.equal(scored.riskScoreSource, TOKEN_SCANNER_RISK_SCORE_SOURCE)
  assert.ok(Array.isArray(scored.riskInputsUsed) && scored.riskInputsUsed.length > 0)
  assert.equal(typeof scored.riskInputStatuses.holders, 'string')
  assert.match(route, /riskScoreSource = tokenRiskScoreResult\.riskScoreSource/)
  assert.match(page, /rawScore: result\.riskScore/)
  assert.doesNotMatch(page, /const cx = calculateCortexScoreV2\(result\)/)
  const cortex = calculateCortexScoreV2({ honeypot: { isHoneypot: false, buyTax: 0, sellTax: 0 } })
  assert.notEqual(cortex.displayScore, 'Open Check')
  assert.notEqual(cortex.cortexVerdict, 'Open Check')
})

test('unsupported or missing evidence does not inflate safety as if the check passed', () => {
  const missing = calculateTokenRiskScore({})
  const locked = calculateTokenRiskScore({
    lpControl: { status: 'burned', burnStatus: 'burned' },
    lpLockStatus: 'burned',
    holderDistribution: { top1: 5, top10: 20 },
    liquidityUsd: 2_000_000,
    marketCapUsd: 80_000_000,
  })
  assert.ok(missing.riskScore >= locked.riskScore, 'missing evidence must not score safer than verified lock/spread')
  const partialHolders = calculateTokenRiskScore({
    holderDistribution: { top1: 8, top10: 30 },
    holderCountReason: 'holder_count_from_normalized_rows',
    concentrationStatus: 'partial',
    holderRowsStatus: 'partial',
  })
  const exactHolders = calculateTokenRiskScore({
    holderDistribution: { top1: 8, top10: 30 },
    holderCountReason: 'holder_count_from_provider_total',
    concentrationStatus: 'verified',
  })
  assert.ok(partialHolders.safetyScore <= exactHolders.safetyScore)
  assert.ok(partialHolders.riskBreakdown.marketMaturity.reasons.includes('holder_concentration_partial_rows'))
})

test('simulation cache is chain+token+pool sensitive and splits success/failure TTL', () => {
  const keyA = buildTradingSimulationCacheKey(8453, '0xabc', 'honeypot_is', '0xpool1')
  const keyB = buildTradingSimulationCacheKey(1, '0xabc', 'honeypot_is', '0xpool1')
  const keyC = buildTradingSimulationCacheKey(8453, '0xabc', 'honeypot_is', '0xpool2')
  assert.notEqual(keyA, keyB)
  assert.notEqual(keyA, keyC)
  assert.equal(
    isTradingSimulationCacheHitValid(
      { chainId: 8453, tokenAddress: '0xabc', provider: 'honeypot_is', poolAddress: '0xpool1' },
      { chainId: 1, tokenAddress: '0xabc', provider: 'honeypot_is', poolAddress: '0xpool1' },
    ),
    false,
  )
  const timeout = classifyTradingSimulation({
    chainSlug: 'robinhood',
    chainId: 4663,
    tokenAddress: '0x0000000000000000000000000000000000000001',
    poolAddress: '0x0000000000000000000000000000000000000002',
    providerSelected: 'chainlens_robinhood_sim',
    requestAttempted: true,
    timedOut: true,
  })
  assert.equal(timeout.finalStatus, 'provider_timeout')
  assert.equal(isTradingSimulationSuccessCacheable(timeout.finalStatus), false)
  assert.equal(tradingSimulationCacheTtlSeconds(timeout.finalStatus), TRADING_SIM_FAILURE_TTL_SECONDS)
  assert.ok(TRADING_SIM_FAILURE_TTL_SECONDS < TRADING_SIM_SUCCESS_TTL_SECONDS)
  assert.equal(robinhoodSimulationCacheTtlMs('timeout'), 8_000)
  assert.equal(robinhoodSimulationCacheTtlMs('sellable'), 10 * 60_000)
  assert.equal(timeout.buyTax, null)
  const uiTax = timeout.buyTax == null ? 'Unavailable' : '0%'
  assert.equal(uiTax, 'Unavailable')
  assert.match(simServer, /tradingSimulationCacheTtlSeconds/)
  assert.match(rhSim, /robinhoodSimulationCacheTtlMs/)
  assert.match(route, /skipCache/)
  const matrix = [
    { chainSlug: 'robinhood', chainId: 4663, providerSelected: 'chainlens_robinhood_sim' as const, honeypotStatus: 'timeout' },
    { chainSlug: 'base', chainId: 8453, providerSelected: 'honeypot_is' as const, honeypotStatus: 'failed' },
    { chainSlug: 'eth', chainId: 1, providerSelected: 'honeypot_is' as const, honeypotResult: false, simulationSuccess: true, honeypotStatus: 'confirmed' },
    { chainSlug: 'bnb', chainId: 56, providerSelected: 'honeypot_is' as const, honeypotResult: true },
    { chainSlug: 'solana', chainId: null, providerSelected: 'none' as const },
  ]
  for (const row of matrix) {
    const audit = classifyTradingSimulation({
      tokenAddress: '0x0000000000000000000000000000000000000001',
      requestAttempted: true,
      ...row,
    })
    assert.ok(audit.finalStatus)
    assert.ok(audit.exactReason)
    assert.equal(audit.tokenAddress, '0x0000000000000000000000000000000000000001')
  }
})

test('known Uniswap / Aerodrome / Pancake models are never overwritten by residual fallback', () => {
  const cases: Array<{ dex: string; model: string; concentrated?: boolean }> = [
    { dex: 'uniswap-v2', model: 'Uniswap V2 LP' },
    { dex: 'uniswap-v3', model: 'Uniswap V3 Concentrated', concentrated: true },
    { dex: 'uniswap-v4', model: 'Uniswap V4 Concentrated', concentrated: true },
    { dex: 'aerodrome', model: 'Aerodrome V2 LP' },
    { dex: 'aerodrome-slipstream', model: 'Aerodrome Slipstream', concentrated: true },
    { dex: 'pancakeswap-v2', model: 'PancakeSwap V2 LP' },
    { dex: 'pancakeswap-v3', model: 'PancakeSwap V3 Concentrated', concentrated: true },
  ]
  for (const row of cases) {
    const result = resolveLpSafetyFinalState({
      ...lpBase,
      selectedPoolDex: row.dex,
      poolType: 'unknown',
      displayLpModel: 'open_check',
      lpTokenAddress: row.concentrated ? null : lpBase.lpTokenAddress,
      positionProofAttempted: Boolean(row.concentrated),
      positionProofStatus: row.concentrated ? 'partial' : null,
      failureReason: row.concentrated ? 'Owner unavailable: active positions not found in indexed window' : 'holder_rows_missing',
    })
    assert.equal(result.model, row.model)
    assert.equal(result.finalDecisionAudit.fallbackTriggered, false)
    assert.doesNotMatch(JSON.stringify(result), /Open Check/i)
    if (row.concentrated) {
      assert.match(result.lockBurnStatus, /^Not applicable/)
      assert.match(result.controlStatus, /Owner unavailable|Partial:/)
    }
  }
  const detected = detectKnownLpProtocol({ dex: 'uniswap-v3', poolType: 'unknown', displayLpModel: 'open_check' })
  assert.equal(detected.protocol, 'uniswap_v3')
  assert.equal(detected.detector, 'dex_metadata')
})

test('holderCountReason distinguishes exact, capped, zero, and unavailable', () => {
  const exact = formatHolderCountDisplay({ holderCount: 1842, holderCountReason: 'holder_count_from_provider_total' })
  assert.equal(exact.display, '1,842')
  assert.equal(exact.exact, true)
  assert.equal(exact.usableForConcentration, true)
  const capped = formatHolderCountDisplay({ holderCount: 100, holderCountReason: 'ok', isCapped: true })
  assert.equal(capped.display, '100+')
  assert.equal(capped.exact, false)
  const rows = formatHolderCountDisplay({ holderCount: 12, holderCountReason: 'holder_count_from_normalized_rows', holderRowsReturned: 12 })
  assert.equal(rows.display, '12+')
  assert.equal(rows.concentrationStatus, 'partial')
  const none = formatHolderCountDisplay({ holderCount: 0, holderCountReason: 'holder_count_unavailable_with_reason', holderRowsReturned: 0 })
  assert.match(none.display, /^Unavailable:/)
  assert.equal(none.holderCount, null)
  const skipped = formatHolderCountDisplay({ holderCountReason: 'not_attempted' })
  assert.match(skipped.display, /^Not Checked:/)
})

test('deployer and cluster unresolved reasons stay honest', () => {
  const evidence = classifyTokenScannerEvidence({
    holdersVerified: true,
    holderRows: [{ address: '0x0000000000000000000000000000000000000002', percent: 8 }],
    deployerAddress: null,
    graphStatus: 'not_run',
    graphFailureReason: 'transfer graph did not run',
  })
  assert.equal(evidence.labels.supplyControl, DEV_SUPPLY_DEPLOYER_UNRESOLVED)
  assert.equal(evidence.labels.creatorInTop, DEV_SUPPLY_DEPLOYER_UNRESOLVED)
  assert.match(evidence.labels.linkedWallets, new RegExp(GRAPH_NOT_RUN_PREFIX))
  const inRows = classifyTokenScannerEvidence({
    holdersVerified: true,
    holderRows: [{ address: '0x0000000000000000000000000000000000000002', percent: 8 }],
    deployerAddress: '0x0000000000000000000000000000000000000001',
    graphStatus: 'ran_none',
  })
  assert.equal(inRows.labels.supplyControl, NOT_IN_INDEXED_HOLDER_ROWS)
  assert.equal(inRows.labels.linkedWallets, GRAPH_RAN_NONE_LABEL)
})

test('pipeline audit pins CORTEX identity to the scanned token and force-rescan skips cache', () => {
  const audit = buildTokenScannerPipelineAudit({
    requestId: 'req-1',
    chainSlug: 'base',
    chainId: 8453,
    tokenAddress: '0xAbC',
    selectedPool: '0xpool',
    cacheKey: 'tokenScan:base:8453:0xabc',
    riskScore: 61,
    skipCache: true,
  })
  assert.equal(audit.cortexTokenAddress, '0xabc')
  assert.equal(audit.cortexChainId, 8453)
  assert.equal(cortexIdentityMatchesScanner(audit), true)
  assert.equal(audit.riskScoreSource, TOKEN_SCANNER_RISK_SCORE_SOURCE)
  assert.equal(audit.skipCache, true)
  assert.match(route, /const skipCache = skipCacheRequested === true \|\| forceRescan === true/)
  assert.match(route, /tokenScannerPipelineAudit/)
  assert.match(page, /scanGenerationRef/)
  assert.match(page, /forceRescan/)
  assert.match(page, /if \(scanGeneration !== scanGenerationRef\.current\) return/)
})
