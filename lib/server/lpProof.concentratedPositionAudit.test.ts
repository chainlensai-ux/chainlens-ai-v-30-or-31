// FINISH-CONCENTRATED-LP-OWNERSHIP-PROOF, DISCLOSED — tests for resolveConcentratedProtocol's
// position-manager resolution (this task's own requirement: never guess an unverified manager
// address). The dedicated audit-shape tests for this task originally lived here too
// (buildConcentratedPositionAudit) but that function was superseded by main's own more complete
// buildConcentratedLpPositionAudit (lib/server/lpProof.ts, backed by lib/server/
// concentratedLpPositions.ts's verified NonfungiblePositionManager registry across ETH/Base/BNB)
// during a later merge — see that module's own tests (scripts/test-concentrated-lp-*.mjs) for the
// audit-shape coverage.
//
// Run directly with:
//   npx tsx --test lib/server/lpProof.concentratedPositionAudit.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConcentratedProtocol } from './lpProof'

describe('resolveConcentratedProtocol — position-manager resolution never guesses an unverified address', () => {
  it('Uniswap V3 gets a verified position manager on every chain this codebase has confirmed one for', () => {
    for (const chain of ['eth', 'base', 'bnb', 'robinhood'] as const) {
      const info = resolveConcentratedProtocol(chain, 'uniswap_v3', 'contract')
      assert.equal(info.protocol, 'uniswap_v3')
      assert.ok(info.positionManager, `expected a verified V3 position manager on ${chain}`)
      assert.equal(info.confidence, 'high')
    }
  })

  it('Uniswap V4 resolves a verified position manager on ETH/Base/BNB (concentratedLpPositions.ts registry) and on Robinhood (this codebase\'s own verified address) — never a guess anywhere else', () => {
    for (const chain of ['eth', 'base', 'bnb', 'robinhood'] as const) {
      const info = resolveConcentratedProtocol(chain, 'uniswap_v4', 'pool_id')
      assert.equal(info.protocol, 'uniswap_v4')
      assert.ok(info.positionManager, `expected a verified V4 position manager on ${chain}`)
      assert.equal(info.confidence, 'high')
    }
  })

  it('Aerodrome Slipstream resolves a verified position manager on Base only — never elsewhere', () => {
    const base = resolveConcentratedProtocol('base', 'aerodrome-slipstream', 'contract')
    assert.equal(base.protocol, 'slipstream')
    assert.ok(base.positionManager, 'expected a verified Slipstream position manager on Base')

    for (const chain of ['eth', 'bnb', 'robinhood'] as const) {
      const info = resolveConcentratedProtocol(chain, 'aerodrome-slipstream', 'contract')
      assert.equal(info.protocol, 'slipstream')
      assert.equal(info.positionManager, null, `Slipstream on ${chain} must never guess a position manager address`)
    }
  })

  it('PancakeSwap V3 gets a verified position manager on BNB Chain', () => {
    const info = resolveConcentratedProtocol('bnb', 'pancakeswap_v3', 'contract')
    assert.equal(info.positionManager, '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364')
    assert.equal(info.confidence, 'high')
  })
})
