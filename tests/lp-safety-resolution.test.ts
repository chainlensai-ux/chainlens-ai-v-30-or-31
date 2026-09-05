import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resolveLpSafetyFinalState, type LpSafetyResolutionInput } from '../lib/lpSafetyResolution.ts'

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
  assert.doesNotMatch(JSON.stringify(result), /Open Check/i)
})

test('route exposes one canonical LP view model and RPC classification fallback', () => {
  const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  const page = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
  assert.match(route, /classifyPoolByRpc\(chain, _rpcProbePool\.address\)/)
  assert.match(route, /lpSafetyResolutionAudit: lpSafetyResolution\.audit/)
  assert.match(page, /result\.lpSafetyResolution\?\.model/)
  assert.match(page, /result\.lpSafetyResolution\?\.lockBurnStatus/)
  assert.match(page, /result\.lpSafetyResolution\?\.controlStatus/)
  assert.match(page, /result\.lpSafetyResolution\?\.exitRisk/)
})
