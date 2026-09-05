// FINISH-CONCENTRATED-LP-OWNERSHIP-PROOF, DISCLOSED — tests for buildConcentratedPositionAudit
// (this task's required concentratedPositionAudit shape/status vocabulary) and the
// resolveConcentratedProtocol V4-manager-for-Robinhood addition. Confirms: known V3 proof
// resolves verified_position_owner; V4/Slipstream only ever get a positionManager address when it
// is independently verified (Robinhood V4 only — never Base/eth/bnb); the audit never fabricates
// an owner/share the underlying proof did not itself resolve; every non-verified/non-protocol
// status carries an exact, non-empty failureReason.
//
// Run directly with:
//   npx tsx --test lib/server/lpProof.concentratedPositionAudit.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildConcentratedPositionAudit, resolveConcentratedProtocol, type ConcentratedPositionProof } from './lpProof'

function proof(overrides: Partial<ConcentratedPositionProof> = {}): ConcentratedPositionProof {
  return {
    status: 'verified',
    poolModel: 'uniswap_v3',
    poolAddress: '0xpool0000000000000000000000000000000001',
    poolId: null,
    poolIdentity: '0xpool0000000000000000000000000000000001',
    poolIdentityType: 'contract',
    positionManager: '0xc36442b4a4522e871399cd717abdd847ab11fe88',
    positionCount: 3,
    totalPositionLiquidity: '1000',
    topPositionOwner: null,
    topPositionOwnerType: null,
    topPositionSharePercent: null,
    topOwners: [],
    lockedOrManagedPositionFound: null,
    controllerRisk: 'unknown',
    confidence: 'high',
    reason: 'Position ownership resolved from 3 position record(s); top owner controls 80% of resolved concentrated liquidity.',
    evidence: [],
    missingEvidence: [],
    nextAction: '',
    ownershipStatus: 'ownership_verified',
    ownershipDebug: { source: 'external_resolver', type: null, confidence: 'high', proofPath: 'v3_external_resolver' },
    sampledPositionCount: null,
    sampledOwnerCount: null,
    sampledOwners: [],
    topSampledOwner: null,
    topSampledOwnerType: null,
    topSampledOwnerShareOfSamplePercent: null,
    samplingStatus: 'not_attempted',
    samplingReason: '',
    samplingDebug: { candidateSource: null, candidateCount: 0, candidateCap: 25, matchingPositionCount: 0, ownerOfCalls: 0, positionCalls: 0, failures: 0, cacheHit: false },
    ...overrides,
  }
}

describe('resolveConcentratedProtocol — position-manager resolution never guesses an unverified address', () => {
  it('Uniswap V3 gets a verified position manager on every chain this codebase has confirmed one for', () => {
    for (const chain of ['eth', 'base', 'bnb', 'robinhood'] as const) {
      const info = resolveConcentratedProtocol(chain, 'uniswap_v3', 'contract')
      assert.equal(info.protocol, 'uniswap_v3')
      assert.ok(info.positionManager, `expected a verified V3 position manager on ${chain}`)
      assert.equal(info.confidence, 'high')
    }
  })

  it('Uniswap V4 only resolves a position manager for Robinhood — the one chain with an independently-verified V4 periphery address', () => {
    const robinhood = resolveConcentratedProtocol('robinhood', 'uniswap_v4', 'pool_id')
    assert.equal(robinhood.protocol, 'uniswap_v4')
    assert.equal(robinhood.positionManager, '0x58daec3116aae6d93017baaea7749052e8a04fa7')
    assert.equal(robinhood.confidence, 'high')

    for (const chain of ['base', 'eth', 'bnb'] as const) {
      const info = resolveConcentratedProtocol(chain, 'uniswap_v4', 'pool_id')
      assert.equal(info.protocol, 'uniswap_v4')
      assert.equal(info.positionManager, null, `V4 on ${chain} must never guess a position manager address`)
      assert.equal(info.confidence, 'low')
    }
  })

  it('Aerodrome Slipstream never resolves a position manager address — ownership is proven from the pool contract itself, not a guessed periphery address', () => {
    const info = resolveConcentratedProtocol('base', 'aerodrome-slipstream', 'contract')
    assert.equal(info.protocol, 'slipstream')
    assert.equal(info.positionManager, null)
    assert.equal(info.confidence, 'low')
  })

  it('PancakeSwap V3 gets a verified position manager on BNB Chain', () => {
    const info = resolveConcentratedProtocol('bnb', 'pancakeswap_v3', 'contract')
    assert.equal(info.positionManager, '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364')
    assert.equal(info.confidence, 'high')
  })
})

describe('buildConcentratedPositionAudit — known-good V3 proof', () => {
  it('a verified Uniswap V3 wallet-owner proof resolves finalStatus "verified_position_owner" with the real owner/share, never fabricated', () => {
    const p = proof({ topPositionOwner: '0xowner000000000000000000000000000000001', topPositionOwnerType: 'wallet', topPositionSharePercent: 80 })
    const audit = buildConcentratedPositionAudit(p, { chainId: 8453 })
    assert.equal(audit.finalStatus, 'verified_position_owner')
    assert.equal(audit.topOwner, '0xowner000000000000000000000000000000001')
    assert.equal(audit.topSharePct, 80)
    assert.equal(audit.managerResolved, true)
    assert.equal(audit.managerVerified, true)
    assert.equal(audit.managerAddress, p.positionManager)
    assert.equal(audit.failureReason, null)
  })

  it('a verified proof whose top owner is the protocol itself resolves "protocol_managed"', () => {
    const p = proof({ topPositionOwner: '0xprotocol0000000000000000000000000000001', topPositionOwnerType: 'protocol', topPositionSharePercent: 100 })
    const audit = buildConcentratedPositionAudit(p, { chainId: 8453 })
    assert.equal(audit.finalStatus, 'protocol_managed')
    assert.equal(audit.failureReason, null)
  })

  it('a verified proof whose top owner is an unverified contract resolves "contract_owner_unverified" with an exact reason', () => {
    const p = proof({ topPositionOwner: '0xcontract000000000000000000000000000001', topPositionOwnerType: 'contract', topPositionSharePercent: 60 })
    const audit = buildConcentratedPositionAudit(p, { chainId: 8453 })
    assert.equal(audit.finalStatus, 'contract_owner_unverified')
    assert.match(audit.failureReason ?? '', /beneficial owner is not independently verified/)
  })
})

describe('buildConcentratedPositionAudit — V4/Slipstream: attempt only with a verified manager/source, exact reasons otherwise', () => {
  it('a real bounded-sample owner (partial proof) resolves "partial_position_owner" — never conflated with "unsupported"', () => {
    const p = proof({
      status: 'partial', topPositionOwner: null, topPositionOwnerType: null,
      topSampledOwner: '0xsampled00000000000000000000000000000001', topSampledOwnerType: 'wallet', topSampledOwnerShareOfSamplePercent: 45,
      samplingReason: 'Sampled 2 position(s) across 1 owner(s) from a bounded candidate source — not full-pool coverage.',
    })
    const audit = buildConcentratedPositionAudit(p, { chainId: 8453 })
    assert.equal(audit.finalStatus, 'partial_position_owner')
    assert.equal(audit.topOwner, '0xsampled00000000000000000000000000000001')
    assert.equal(audit.topSharePct, 45)
    assert.match(audit.failureReason ?? '', /Sampled 2 position/)
  })

  it('a genuinely not-yet-implemented indexing path (V4/Slipstream with no resolver configured) resolves "unsupported_with_reason" with the exact reason, never a bare/vague message', () => {
    const p = proof({
      status: 'not_supported', poolModel: 'uniswap_v4', poolAddress: null, poolId: '0x' + 'ab'.repeat(32),
      positionManager: null, topPositionOwner: null, topPositionOwnerType: null,
      reason: 'The pool is confirmed active but ownership of its concentrated liquidity positions could not be fully resolved.',
    })
    const audit = buildConcentratedPositionAudit(p, { chainId: 1 })
    assert.equal(audit.finalStatus, 'unsupported_with_reason')
    assert.equal(audit.failureReason, p.reason)
    assert.equal(audit.managerResolved, false, 'no fabricated manager for an unsupported chain')
    assert.equal(audit.topOwner, null, 'no fake ownership for an unsupported proof')
  })

  it('a real RPC/provider failure resolves "unavailable_with_reason" — distinct from "unsupported" (a real attempt failed, vs. not built yet)', () => {
    const p = proof({ status: 'failed', topPositionOwner: null, topPositionOwnerType: null, reason: 'RPC call to the pool contract failed while attempting position-proof verification.' })
    const audit = buildConcentratedPositionAudit(p, { chainId: 8453 })
    assert.equal(audit.finalStatus, 'unavailable_with_reason')
    assert.equal(audit.failureReason, p.reason)
  })

  it('no proof at all (not a concentrated pool / nothing selected) resolves "unavailable_with_reason" with a concrete reason, never null/undefined', () => {
    const audit = buildConcentratedPositionAudit(null, { chainId: null })
    assert.equal(audit.finalStatus, 'unavailable_with_reason')
    assert.ok(audit.failureReason && audit.failureReason.length > 0)
    assert.equal(audit.topOwner, null)
    assert.equal(audit.managerResolved, false)
  })
})
