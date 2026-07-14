// Tests for src/modules/distributorRecovery — analyzeDistributorRouterFlows. Uses node:test, same
// convention as this codebase's other module tests. Run directly with:
//   npx tsx --test src/modules/distributorRecovery/index.test.ts
//
// SYNTHETIC WALLET PATTERN, DISCLOSED: fixtures below model the real reported pattern (many
// outbound-to-router transfers, multiple tokens) without claiming to be the literal on-chain history
// of 0xe896465b95d5edb49e26de47b6718442227c980f — this sandbox has no network access to fetch that
// wallet's real events, so a synthetic fixture matching the DESCRIBED shape is the honest choice.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeDistributorRouterFlows } from './index'
import type { NormalizedEvent } from '../normalization/types'

const ROUTER = '0xrouter'.toLowerCase()
const KNOWN_ROUTERS = new Set([ROUTER])
const WALLET = '0xwallet'.toLowerCase()

function event(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    provider: 'goldrush',
    chain: 'base',
    txHash: '0xtx',
    timestamp: '2024-01-01T00:00:00Z',
    fromAddress: WALLET,
    toAddress: ROUTER,
    contract: '0xtokenA',
    symbol: 'TKA',
    amount: 100,
    amountRaw: '100',
    tokenDecimals: 18,
    direction: 'outbound',
    ...overrides,
  }
}

describe('analyzeDistributorRouterFlows — routerDistributorMode gate', () => {
  it('is a no-op (applied: false) when routerDistributorMode is false, even with router-mediated events present', () => {
    const events = [event({ txHash: '0xtx1' })]
    const result = analyzeDistributorRouterFlows(events, KNOWN_ROUTERS, false)
    assert.equal(result.applied, false)
    assert.equal(result.groups.length, 0)
    assert.equal(result.stablePnlCandidate, false)
  })
})

describe('analyzeDistributorRouterFlows — evidence classification (routerDistributorMode = true)', () => {
  it('classifies evidence "complete" when a real same-tx inbound leg on a different token exists', () => {
    const events = [
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound' }),
      event({ txHash: '0xtx1', contract: '0xtokenB', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }),
    ]
    const result = analyzeDistributorRouterFlows(events, KNOWN_ROUTERS, true)
    assert.equal(result.applied, true)
    assert.equal(result.groups.length, 1)
    assert.equal(result.groups[0].evidence, 'complete')
    assert.equal(result.groups[0].matchedInboundEvent?.contract, '0xtokenB')
    assert.equal(result.missingEvidenceCount, 0)
    assert.equal(result.stablePnlCandidate, true)
  })

  it('classifies evidence "missing" when no same-tx inbound leg exists (multi-hop / off-wallet return)', () => {
    const events = [event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound' })]
    const result = analyzeDistributorRouterFlows(events, KNOWN_ROUTERS, true)
    assert.equal(result.groups[0].evidence, 'missing')
    assert.equal(result.groups[0].matchedInboundEvent, null)
    assert.equal(result.missingEvidenceCount, 1)
    assert.equal(result.stablePnlCandidate, false)
  })

  it('never pairs an inbound leg from a DIFFERENT transaction, even for the same token pair', () => {
    const events = [
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound' }),
      event({ txHash: '0xtx2', contract: '0xtokenB', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }), // different tx
    ]
    const result = analyzeDistributorRouterFlows(events, KNOWN_ROUTERS, true)
    assert.equal(result.groups[0].evidence, 'missing')
  })

  it('never pairs an inbound leg for the SAME token as the outbound (not a real swap-return signal)', () => {
    const events = [
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound' }),
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }),
    ]
    const result = analyzeDistributorRouterFlows(events, KNOWN_ROUTERS, true)
    assert.equal(result.groups[0].evidence, 'missing')
  })

  it('ignores outbound events to a non-router counterparty entirely', () => {
    const events = [event({ txHash: '0xtx1', toAddress: '0xnotarouter' })]
    const result = analyzeDistributorRouterFlows(events, KNOWN_ROUTERS, true)
    assert.equal(result.totalOutboundToKnownRouter, 0)
    assert.equal(result.groups.length, 0)
  })

  it('real reported pattern: many outbound-to-router events across multiple tokens, mixed evidence -> not a stable candidate', () => {
    const events: NormalizedEvent[] = []
    for (let i = 0; i < 10; i++) {
      events.push(event({ txHash: `0xtx${i}`, contract: `0xtoken${i}`, direction: 'outbound' }))
      if (i % 2 === 0) {
        // Only every other swap has a verifiable same-tx return leg — the rest are genuinely missing evidence.
        events.push(event({ txHash: `0xtx${i}`, contract: `0xreturn${i}`, direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }))
      }
    }
    const result = analyzeDistributorRouterFlows(events, KNOWN_ROUTERS, true)
    assert.equal(result.totalOutboundToKnownRouter, 10)
    assert.equal(result.missingEvidenceCount, 5)
    assert.equal(result.stablePnlCandidate, false)
  })

  it('all evidence complete across many tokens -> stablePnlCandidate is true', () => {
    const events: NormalizedEvent[] = []
    for (let i = 0; i < 10; i++) {
      events.push(event({ txHash: `0xtx${i}`, contract: `0xtoken${i}`, direction: 'outbound' }))
      events.push(event({ txHash: `0xtx${i}`, contract: `0xreturn${i}`, direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }))
    }
    const result = analyzeDistributorRouterFlows(events, KNOWN_ROUTERS, true)
    assert.equal(result.missingEvidenceCount, 0)
    assert.equal(result.stablePnlCandidate, true)
  })

  it('no router-mediated events at all -> stablePnlCandidate is false (nothing to be confident about)', () => {
    const result = analyzeDistributorRouterFlows([], KNOWN_ROUTERS, true)
    assert.equal(result.totalOutboundToKnownRouter, 0)
    assert.equal(result.stablePnlCandidate, false)
  })
})

describe('analyzeDistributorRouterFlows — determinism (repeated-call stability)', () => {
  it('produces identical results across repeated calls with the same input (no hidden state/randomness)', () => {
    const events = [
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound' }),
      event({ txHash: '0xtx1', contract: '0xtokenB', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }),
      event({ txHash: '0xtx2', contract: '0xtokenC', direction: 'outbound' }),
    ]
    const first = analyzeDistributorRouterFlows(events, KNOWN_ROUTERS, true)
    const second = analyzeDistributorRouterFlows(events, KNOWN_ROUTERS, true)
    assert.deepEqual(
      { missingEvidenceCount: first.missingEvidenceCount, stablePnlCandidate: first.stablePnlCandidate, total: first.totalOutboundToKnownRouter },
      { missingEvidenceCount: second.missingEvidenceCount, stablePnlCandidate: second.stablePnlCandidate, total: second.totalOutboundToKnownRouter },
    )
  })
})
