import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  detectKnownLpProtocol,
  resolveLpSafetyFinalState,
  type LpSafetyResolutionInput,
} from '../lib/lpSafetyResolution.ts'

const base: LpSafetyResolutionInput = {
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

test('Uniswap V2 with missing holder proof finishes Partial with an exact reason', () => {
  const result = resolveLpSafetyFinalState(base)
  assert.equal(result.model, 'Uniswap V2 LP')
  assert.match(result.lockBurnStatus, /^Partial: LP holder proof unavailable:/)
  assert.match(result.controlStatus, /^Partial:/)
  assert.doesNotMatch(JSON.stringify(result), /Open Check/i)
  assert.equal(result.audit.totalSupplyRead, true)
  assert.equal(result.audit.alchemyRpcAttempted, true)
  assert.equal(result.finalDecisionAudit.fallbackTriggered, false)
  assert.equal(result.finalDecisionAudit.proofPathUsed, 'v2_holder_burn_controller')
})

test('detected Uniswap V2 cannot end as generic unavailable when poolType is still unknown', () => {
  const result = resolveLpSafetyFinalState({
    ...base,
    selectedPoolDex: 'uniswap-v2',
    poolType: 'unknown',
    rpcPoolType: 'unknown',
    controlPoolType: 'unknown',
  })
  assert.equal(result.model, 'Uniswap V2 LP')
  assert.doesNotMatch(result.model, /Unavailable/)
  assert.equal(result.finalDecisionAudit.successfulDetector, 'dex_metadata')
  assert.equal(result.finalDecisionAudit.fallbackTriggered, false)
  assert.equal(result.finalDecisionAudit.proofPathUsed, 'v2_holder_burn_controller')
})

test('Uniswap V3 uses concentrated position proof and never failed-V2 wording', () => {
  const result = resolveLpSafetyFinalState({
    ...base,
    selectedPoolDex: 'uniswap-v3',
    poolType: 'concentrated',
    lpTokenAddress: null,
    totalSupplyRead: false,
    positionProofAttempted: true,
    positionProofStatus: 'partial',
    failureReason: 'top position owner was not indexed',
  })
  assert.equal(result.model, 'Uniswap V3 Concentrated')
  assert.match(result.lockBurnStatus, /^Not applicable: concentrated LP model/)
  assert.match(result.controlStatus, /^Partial:/)
  assert.equal(result.audit.concentratedDetected, true)
  assert.equal(result.audit.lpTokenAddress, null)
  assert.doesNotMatch(JSON.stringify(result), /failed V2|Open Check/i)
  assert.equal(result.finalDecisionAudit.proofPathUsed, 'concentrated_position_ownership')
})

test('detected Uniswap V3/V4 cannot end as generic unavailable', () => {
  const v3 = resolveLpSafetyFinalState({
    ...base,
    selectedPoolDex: 'uniswap_v3_base',
    poolType: 'unknown',
    rpcPoolType: 'unknown',
    lpTokenAddress: null,
    positionProofAttempted: true,
    positionProofStatus: 'partial',
    failureReason: 'Owner unavailable: active positions not found in indexed window',
  })
  assert.equal(v3.model, 'Uniswap V3 Concentrated')
  assert.match(v3.lockBurnStatus, /^Not applicable/)
  assert.doesNotMatch(v3.model, /Unavailable/)
  assert.equal(v3.finalDecisionAudit.fallbackTriggered, false)

  const v4 = resolveLpSafetyFinalState({
    ...base,
    selectedPoolDex: 'uniswap-v4',
    poolType: 'unknown',
    poolId: `0x${'ab'.repeat(32)}`,
    poolAddressType: 'pool_id',
    selectedPoolAddress: null,
    lpTokenAddress: null,
    positionProofAttempted: true,
    positionProofStatus: 'partial',
    failureReason: 'Position index unavailable: no Alchemy/RPC URL configured for chain 8453',
  })
  assert.equal(v4.model, 'Uniswap V4 Concentrated')
  assert.match(v4.lockBurnStatus, /^Not applicable/)
  assert.doesNotMatch(v4.model, /Unavailable/)
  assert.equal(v4.finalDecisionAudit.proofPathUsed, 'concentrated_position_ownership')
})

test('Aerodrome, Slipstream, and Pancake resolve to the correct LP model', () => {
  const aero = resolveLpSafetyFinalState({ ...base, selectedPoolDex: 'aerodrome', poolType: 'unknown' })
  assert.equal(aero.model, 'Aerodrome V2 LP')
  assert.equal(aero.finalDecisionAudit.proofPathUsed, 'v2_holder_burn_controller')

  const slip = resolveLpSafetyFinalState({
    ...base,
    selectedPoolDex: 'aerodrome-slipstream',
    poolType: 'unknown',
    lpTokenAddress: null,
    positionProofAttempted: true,
    positionProofStatus: 'partial',
    failureReason: 'position ownership proof unavailable',
  })
  assert.equal(slip.model, 'Aerodrome Slipstream')
  assert.match(slip.lockBurnStatus, /^Not applicable/)
  assert.equal(slip.finalDecisionAudit.proofPathUsed, 'concentrated_position_ownership')

  const cakeV2 = resolveLpSafetyFinalState({ ...base, selectedPoolDex: 'pancakeswap-v2', poolType: 'unknown' })
  assert.equal(cakeV2.model, 'PancakeSwap V2 LP')
  assert.equal(cakeV2.finalDecisionAudit.proofPathUsed, 'v2_holder_burn_controller')

  const cakeV3 = resolveLpSafetyFinalState({
    ...base,
    selectedPoolDex: 'pancakeswap-v3',
    poolType: 'unknown',
    lpTokenAddress: null,
    positionProofAttempted: true,
    positionProofStatus: 'partial',
    failureReason: 'position ownership proof unavailable',
  })
  assert.equal(cakeV3.model, 'PancakeSwap V3 Concentrated')
  assert.match(cakeV3.lockBurnStatus, /^Not applicable/)
})

test('a successful detector is not overwritten by a later unknown/generic result', () => {
  const detected = detectKnownLpProtocol({
    dex: 'uniswap-v3',
    poolType: 'unknown',
    rpcPoolType: 'unknown',
    controlPoolType: 'unknown',
    displayLpModel: 'open_check',
  })
  assert.equal(detected.protocol, 'uniswap_v3')
  assert.equal(detected.detector, 'dex_metadata')
  assert.ok(detected.detectorsTried.includes('dex_metadata'))

  const result = resolveLpSafetyFinalState({
    ...base,
    selectedPoolDex: 'uniswap-v3',
    poolType: 'unknown',
    rpcPoolType: 'unknown',
    controlPoolType: 'unknown',
    displayLpModel: 'open_check',
    lpTokenAddress: null,
    positionProofAttempted: true,
    positionProofStatus: 'partial',
    failureReason: 'RPC token0/token1 probes timed out',
  })
  assert.equal(result.model, 'Uniswap V3 Concentrated')
  assert.equal(result.finalDecisionAudit.successfulDetector, 'dex_metadata')
  assert.equal(result.finalDecisionAudit.fallbackTriggered, false)
  assert.equal(result.finalDecisionAudit.modelBeforeFallback, 'Uniswap V3 Concentrated')
  assert.notEqual(result.finalDecisionAudit.finalModel, result.finalDecisionAudit.fallbackReason)
})

test('selected pool with unresolved model returns exact unavailable state', () => {
  const result = resolveLpSafetyFinalState({
    ...base,
    selectedPoolDex: 'unknown-dex',
    poolType: 'unknown',
    totalSupplyRead: false,
    failureReason: 'RPC token0/token1 probes timed out',
  })
  assert.match(result.model, /^Unavailable:/)
  assert.match(result.status, /RPC token0\/token1 probes timed out/)
  assert.equal(result.audit.poolTypeDetected, 'unknown')
  assert.equal(result.finalDecisionAudit.fallbackTriggered, true)
  assert.doesNotMatch(JSON.stringify(result), /Open Check/i)
  assert.doesNotMatch(JSON.stringify(result), /no usable evidence/i)
})

test('route exposes one canonical LP view model and RPC classification fallback', () => {
  const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  const page = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
  assert.match(route, /classifyPoolByRpc\(chain, _rpcProbePool\.address\)/)
  assert.match(route, /lpSafetyResolutionAudit: lpSafetyResolution\.audit/)
  assert.match(route, /lpFinalDecisionAudit: lpSafetyResolution\.finalDecisionAudit/)
  assert.match(route, /detectKnownLpProtocol\(/)
  assert.match(page, /result\.lpSafetyResolution\?\.model/)
  assert.match(page, /result\.lpSafetyResolution\?\.lockBurnStatus/)
  assert.match(page, /result\.lpSafetyResolution\?\.controlStatus/)
  assert.match(page, /result\.lpSafetyResolution\?\.exitRisk/)
  assert.match(page, /if \(result\.lpSafetyResolution\?\.model\) return result\.lpSafetyResolution\.model/)
})
