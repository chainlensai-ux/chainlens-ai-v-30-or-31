// LP SAFETY END-TO-END FIX, DISCLOSED — locks in protocol/model detection for every pool type
// this task names explicitly (Uni V2, Uni V3, Uni V4, Aerodrome Classic, Slipstream, Pancake
// V2/V3), using the two real, already-existing classifiers (classifyPoolModel for the ERC-20-LP-
// token-vs-not question, resolveConcentratedProtocol for the concentrated-pool protocol identity
// and position-manager lookup) — no new detection logic invented, this only asserts the behavior
// this task's fix relies on.
//
// Run directly with:
//   npx tsx --test lib/server/lpProof.protocolDetection.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyPoolModel, resolveConcentratedProtocol } from './lpProof'

describe('classifyPoolModel — every protocol/model this task names', () => {
  it('Uniswap V2 (versioned and bare) is a real ERC-20 LP token — proof applicable', () => {
    for (const id of ['uniswap_v2', 'uniswap-v2', 'uniswap']) {
      const cls = classifyPoolModel(id)
      assert.equal(cls.poolModel, 'constant_product', `expected ${id} to be constant_product`)
      assert.equal(cls.proofApplicability, 'applicable')
      assert.equal(cls.standardLockApplies, true)
    }
  })

  it('Uniswap V3 is concentrated — NFT positions, standard lock/burn does not apply', () => {
    const cls = classifyPoolModel('uniswap_v3')
    assert.equal(cls.poolModel, 'concentrated')
    assert.equal(cls.proofApplicability, 'not_applicable')
    assert.equal(cls.standardLockApplies, false)
  })

  it('Uniswap V4 is concentrated — same as V3, never treated as a failed V2 proof', () => {
    const cls = classifyPoolModel('uniswap_v4')
    assert.equal(cls.poolModel, 'concentrated')
    assert.equal(cls.proofApplicability, 'not_applicable')
  })

  it('Aerodrome Classic (V2-style, no concentrated marker) is a real ERC-20 LP token', () => {
    const cls = classifyPoolModel('aerodrome')
    assert.equal(cls.poolModel, 'aerodrome_v2')
    assert.equal(cls.proofApplicability, 'applicable')
    assert.equal(cls.standardLockApplies, true)
  })

  it('Aerodrome Slipstream is concentrated — never runs the ERC-20 LP lock/burn proof', () => {
    const cls = classifyPoolModel('aerodrome-slipstream')
    assert.equal(cls.poolModel, 'concentrated')
    assert.equal(cls.proofApplicability, 'not_applicable')
  })

  it('PancakeSwap V2 is a real ERC-20 LP token', () => {
    const cls = classifyPoolModel('pancakeswap_v2')
    assert.equal(cls.poolModel, 'constant_product')
    assert.equal(cls.proofApplicability, 'applicable')
  })

  it('PancakeSwap V3 is concentrated', () => {
    const cls = classifyPoolModel('pancakeswap_v3')
    assert.equal(cls.poolModel, 'concentrated')
    assert.equal(cls.proofApplicability, 'not_applicable')
  })
})

describe('resolveConcentratedProtocol — protocol identity + honest position-manager confidence', () => {
  it('Uniswap V3 on base resolves protocol "uniswap_v3" with a real, high-confidence position manager', () => {
    const info = resolveConcentratedProtocol('base', 'uniswap_v3', 'contract')
    assert.equal(info.protocol, 'uniswap_v3')
    assert.equal(info.confidence, 'high')
    assert.ok(info.positionManager, 'a verified position manager address must be present for Uniswap V3')
  })

  // UPDATED, DISCLOSED (merge with a concurrent "Index concentrated LP positions" change): a
  // verified Uniswap V4 PositionManager registry (lib/server/concentratedLpPositions.ts,
  // cross-checked against Uniswap's official deployments) now covers ETH/Base/BNB, plus this
  // codebase's own independently-verified Robinhood V4 address — so V4 legitimately resolves a
  // real manager everywhere this codebase has one, never a guess where it doesn't.
  it('Uniswap V4 resolves protocol "uniswap_v4" with a real, verified position manager on every chain this codebase has confirmed one for', () => {
    for (const chain of ['eth', 'base', 'bnb', 'robinhood'] as const) {
      const info = resolveConcentratedProtocol(chain, 'uniswap_v4', 'pool_id')
      assert.equal(info.protocol, 'uniswap_v4')
      assert.ok(info.positionManager, `expected a verified V4 position manager on ${chain}`)
      assert.equal(info.confidence, 'high')
    }
  })

  // UPDATED, DISCLOSED: Aerodrome Slipstream's NonfungiblePositionManager on Base is now a
  // verified address (lib/server/concentratedLpPositions.ts, from Aerodrome's own deployments
  // table) — verified only for Base, since that is the only chain Aerodrome/Slipstream deploys
  // to in this codebase; every other chain still never guesses one.
  it('Aerodrome Slipstream resolves protocol "slipstream" with a real, verified position manager on Base only — never elsewhere', () => {
    const base = resolveConcentratedProtocol('base', 'aerodrome-slipstream', 'contract')
    assert.equal(base.protocol, 'slipstream')
    assert.ok(base.positionManager, 'expected a verified Slipstream position manager on Base')
    assert.equal(base.confidence, 'high')

    for (const chain of ['eth', 'bnb', 'robinhood'] as const) {
      const info = resolveConcentratedProtocol(chain, 'aerodrome-slipstream', 'contract')
      assert.equal(info.protocol, 'slipstream')
      assert.equal(info.positionManager, null, `Slipstream on ${chain} must never guess a position manager address`)
      assert.equal(info.confidence, 'low')
    }
  })

  it('PancakeSwap V3 resolves protocol "pancakeswap_v3" with a real, high-confidence position manager', () => {
    const info = resolveConcentratedProtocol('bnb', 'pancakeswap_v3', 'contract')
    assert.equal(info.protocol, 'pancakeswap_v3')
    assert.equal(info.confidence, 'high')
    assert.ok(info.positionManager)
  })
})
