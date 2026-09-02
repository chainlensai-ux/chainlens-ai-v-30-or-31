import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildConcentratedLpPositionOwnershipAudit,
  POSITION_PROOF_NOT_INDEXED_REASON,
} from '../lib/server/lpProof.ts'

const FINAL_STATUSES = new Set([
  'verified_position_owner',
  'protocol_managed',
  'contract_owner_unverified',
  'owner_unavailable',
  'unsupported_with_reason',
  'not_applicable',
])

function baseProof(overrides = {}) {
  return {
    status: 'partial',
    poolModel: 'uniswap_v3',
    poolAddress: '0xpool0000000000000000000000000000000000',
    poolId: null,
    poolIdentity: '0xpool0000000000000000000000000000000000',
    poolIdentityType: 'contract',
    positionManager: '0x03a520b32c04bf3beef7beb72e919cf822ed34f1',
    positionCount: null,
    totalPositionLiquidity: null,
    topPositionOwner: null,
    topPositionOwnerType: null,
    topPositionSharePercent: null,
    topOwners: [],
    lockedOrManagedPositionFound: null,
    controllerRisk: 'unknown',
    confidence: 'low',
    reason: 'The pool is confirmed active, but the largest liquidity owner could not be verified from currently available evidence.',
    evidence: [],
    missingEvidence: ['topPositionOwner'],
    nextAction: 'Re-check.',
    ownershipStatus: 'ownership_open_check',
    ownershipDebug: { source: 'rpc_liquidity_probe', type: null, confidence: 'low', proofPath: 'pool_liquidity_confirmed_no_owner' },
    sampledPositionCount: null,
    sampledOwnerCount: null,
    sampledOwners: [],
    topSampledOwner: null,
    topSampledOwnerType: null,
    topSampledOwnerShareOfSamplePercent: null,
    samplingStatus: 'attempted_no_candidates',
    samplingReason: 'no_bounded_candidate_source',
    samplingDebug: { candidateSource: null, candidateCount: 0, candidateCap: 20, matchingPositionCount: 0, ownerOfCalls: 0, positionCalls: 0, failures: 0, cacheHit: false },
    ...overrides,
  }
}

function main() {
  // ── No proof at all (non-concentrated pool) → not_applicable, never a vague "unsupported" ──
  {
    const a = buildConcentratedLpPositionOwnershipAudit(null, { chainId: 8453, tokenAddress: '0xtoken' })
    assert.equal(a.finalStatus, 'not_applicable')
    assert.ok(a.finalReason.length > 0, 'not_applicable always carries a reason')
    assert.equal(a.positionOwnerProofAttempted, false)
    assert.equal(a.chainId, 8453)
    assert.equal(a.tokenAddress, '0xtoken')
  }

  // ── Real evidence exists: a wallet holds the top position → verified_position_owner, never vague ──
  {
    const proof = baseProof({
      status: 'verified',
      positionCount: 3,
      topPositionOwner: '0xowner00000000000000000000000000000000',
      topPositionOwnerType: 'wallet',
      topPositionSharePercent: 62.4,
      confidence: 'high',
      reason: 'Position ownership resolved from 3 position record(s); top owner controls 62.4% of resolved concentrated liquidity.',
      ownershipStatus: 'ownership_verified_team',
      ownershipDebug: { source: 'external_resolver', type: 'wallet', confidence: 'high', proofPath: 'v3_external_resolver' },
    })
    const a = buildConcentratedLpPositionOwnershipAudit(proof, { chainId: 8453, tokenAddress: '0xtoken' })
    assert.equal(a.finalStatus, 'verified_position_owner')
    assert.equal(a.topLiquidityOwner, '0xowner00000000000000000000000000000000')
    assert.equal(a.topLiquidityOwnerSharePct, 62.4)
    assert.equal(a.ownerIsEOA, true)
    assert.equal(a.ownerIsContract, false)
    assert.equal(a.indexedPositionsFound, 3)
    assert.equal(a.activePositionsFound, 3)
    assert.equal(a.positionManagerResolved, true)
    assert.equal(a.proofSource, 'external_resolver')
    assert.ok(!/not verified/i.test(a.finalReason), 'verified state must never read as "not verified"')
  }

  // ── Verified but the top owner is a protocol contract (e.g. locker/protocol manager) ──
  {
    const proof = baseProof({
      status: 'verified',
      positionCount: 1,
      topPositionOwner: '0x0000000000000000000000000000000000dead',
      topPositionOwnerType: 'protocol',
      topPositionSharePercent: 100,
      ownershipStatus: 'ownership_verified_protocol',
      ownershipDebug: { source: 'rpc_candidate_probe', type: 'protocol', confidence: 'high', proofPath: 'nft_position_manager_candidate_probe' },
    })
    const a = buildConcentratedLpPositionOwnershipAudit(proof, { chainId: 8453, tokenAddress: '0xtoken' })
    assert.equal(a.finalStatus, 'protocol_managed')
    assert.equal(a.ownerIsContract, true)
  }

  // ── Verified with a contract owner whose beneficial owner is unknown ──
  {
    const proof = baseProof({
      status: 'verified',
      positionCount: 1,
      topPositionOwner: '0xcontract000000000000000000000000000000',
      topPositionOwnerType: 'contract',
      topPositionSharePercent: 80,
      ownershipStatus: 'ownership_verified_contract',
      ownershipDebug: { source: 'external_resolver', type: 'contract', confidence: 'medium', proofPath: 'v3_external_resolver' },
    })
    const a = buildConcentratedLpPositionOwnershipAudit(proof, { chainId: 8453, tokenAddress: '0xtoken' })
    assert.equal(a.finalStatus, 'contract_owner_unverified')
    assert.match(a.finalReason, /0xcontract000000000000000000000000000000/)
  }

  // ── Not indexed: partial status, no sample → EXACT required message, no invented positions ──
  {
    const proof = baseProof({ status: 'partial' })
    const a = buildConcentratedLpPositionOwnershipAudit(proof, { chainId: 8453, tokenAddress: '0xtoken' })
    assert.equal(a.finalStatus, 'owner_unavailable')
    assert.equal(a.finalReason, POSITION_PROOF_NOT_INDEXED_REASON)
    assert.equal(a.finalReason, 'Position owner proof unavailable — active liquidity positions not indexed.')
  }

  // ── not_supported (e.g. V4 with no resolver) → same exact required message ──
  {
    const proof = baseProof({ status: 'not_supported', poolModel: 'uniswap_v4', positionManager: null, poolAddress: null, poolId: '0xpoolid' })
    const a = buildConcentratedLpPositionOwnershipAudit(proof, { chainId: 4663, tokenAddress: '0xtoken' })
    assert.equal(a.finalStatus, 'owner_unavailable')
    assert.equal(a.finalReason, POSITION_PROOF_NOT_INDEXED_REASON)
    assert.equal(a.positionManagerResolved, false)
  }

  // ── Zero active liquidity → not_applicable, not a scary "unavailable" ──
  {
    const proof = baseProof({ status: 'not_found', reason: 'Pool contract confirmed on-chain, but reports zero active liquidity — no position to attribute ownership to.' })
    const a = buildConcentratedLpPositionOwnershipAudit(proof, { chainId: 8453, tokenAddress: '0xtoken' })
    assert.equal(a.finalStatus, 'not_applicable')
    assert.match(a.finalReason, /zero active liquidity/)
  }

  // ── RPC failure → unsupported_with_reason, reason is the real RPC failure text ──
  {
    const proof = baseProof({ status: 'failed', reason: 'RPC call to the pool contract failed while attempting position-proof verification.' })
    const a = buildConcentratedLpPositionOwnershipAudit(proof, { chainId: 8453, tokenAddress: '0xtoken' })
    assert.equal(a.finalStatus, 'unsupported_with_reason')
    assert.match(a.finalReason, /RPC call to the pool contract failed/)
  }

  // ── A bounded sample DID find a real owner even though full-pool coverage is not proven ──
  {
    const proof = baseProof({
      status: 'partial',
      topSampledOwner: '0xsampledowner000000000000000000000000000',
      topSampledOwnerType: 'wallet',
      topSampledOwnerShareOfSamplePercent: 44,
      sampledPositionCount: 5,
      sampledOwnerCount: 2,
      samplingStatus: 'sampled_partial',
      samplingReason: 'Sampled 5 position(s) across 2 owner(s) from a bounded candidate source — not full-pool coverage.',
    })
    const a = buildConcentratedLpPositionOwnershipAudit(proof, { chainId: 8453, tokenAddress: '0xtoken' })
    assert.equal(a.finalStatus, 'unsupported_with_reason')
    assert.equal(a.topLiquidityOwner, '0xsampledowner000000000000000000000000000')
    assert.ok(a.finalReason.includes('bounded sample'))
  }

  // ── No pool address/id at all → not_applicable ──
  {
    const proof = baseProof({ status: 'open_check', poolAddress: null, poolId: null, positionManager: null, reason: 'No pool address or pool ID is available to attempt a position-proof check.' })
    const a = buildConcentratedLpPositionOwnershipAudit(proof, { chainId: 8453, tokenAddress: '0xtoken' })
    assert.equal(a.finalStatus, 'not_applicable')
  }

  // ── Every branch produces a value from the exact required enum, and finalReason is never empty ──
  for (const status of ['verified', 'partial', 'not_found', 'not_supported', 'failed', 'open_check']) {
    const proof = baseProof({ status })
    const a = buildConcentratedLpPositionOwnershipAudit(proof, { chainId: 1, tokenAddress: '0xt' })
    assert.ok(FINAL_STATUSES.has(a.finalStatus), `${status} maps to a valid finalStatus`)
    assert.ok(typeof a.finalReason === 'string' && a.finalReason.trim().length > 0, `${status} always carries a non-empty finalReason`)
  }

  // ── Shape check: every field the task spec requires is present on the returned object ──
  {
    const proof = baseProof({ status: 'verified', topPositionOwner: '0xowner', topPositionOwnerType: 'wallet', topPositionSharePercent: 10, positionCount: 1 })
    const a = buildConcentratedLpPositionOwnershipAudit(proof, { chainId: 1, tokenAddress: '0xt' })
    const requiredKeys = [
      'chainId', 'tokenAddress', 'poolAddress', 'poolType', 'positionManagerResolved', 'positionManagerAddress',
      'positionOwnerProofAttempted', 'indexedPositionsFound', 'activePositionsFound', 'topLiquidityOwner',
      'topLiquidityOwnerSharePct', 'ownerIsContract', 'ownerIsEOA', 'proofSource', 'finalStatus', 'finalReason',
    ]
    for (const key of requiredKeys) assert.ok(key in a, `audit object has required key ${key}`)
  }

  // ── Wired into the token API response and the UI/Clark evidence pipeline ──
  {
    const routeSrc = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
    assert.ok(routeSrc.includes('concentratedLpPositionOwnershipAudit: buildConcentratedLpPositionOwnershipAudit('), 'API response attaches the audit object')

    const uiSrc = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
    assert.ok(uiSrc.includes('concentratedLpPositionOwnershipAudit'), 'Token Scanner UI reads the audit object')
    assert.ok(uiSrc.includes("audit.finalReason || 'No reason returned"), 'Position Ownership row always shows a reason')

    const clarkRouteSrc = readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
    assert.ok(clarkRouteSrc.includes('positionOwnershipFinalStatus'), 'Clark evidence mapping carries finalStatus through')
    assert.ok(clarkRouteSrc.includes('positionOwnershipFinalReason'), 'Clark evidence mapping carries finalReason through')

    const analystSrc = readFileSync(new URL('../lib/server/clarkTokenAnalyst.ts', import.meta.url), 'utf8')
    assert.ok(!/verified\.push\("Concentrated LP position ownership is verified\."\)/.test(analystSrc), 'Clark no longer hardcodes the old simplified ownership-verified string')
    assert.ok(analystSrc.includes('lpOwnershipCopy('), 'Clark ownership text is derived through the shared lpOwnershipCopy() mapping')
  }

  console.log('test-concentrated-lp-ownership-audit.mjs: all assertions passed')
}

main()
