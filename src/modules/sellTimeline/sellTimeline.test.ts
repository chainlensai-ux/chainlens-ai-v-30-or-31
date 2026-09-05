// Tests for src/modules/sellTimeline (the "sellTimelineV2" read model — the richer sell
// reconstruction the Wallet Scanner audit names explicitly: "Universal Router sell detected by
// shared registry", "known router + missing side can reach receipt priority", "transfer-only tx
// does not become swap"). This module had zero direct unit tests before this task.
//
// Run directly with:
//   npx tsx --test src/modules/sellTimeline/sellTimeline.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSellTimeline } from './index'
import { KNOWN_DEX_ROUTER_ADDRESSES } from '../../lib/knownDexRouters'
import type { NormalizedEvent } from '../normalization/types'
import type { ChainSelectionResult } from '../chainSelection/types'
import type { RecoveryPolicyResult } from '../recoveryPolicy/types'
import { DEFAULT_RECOVERY_CAPS, DEFAULT_TRIGGER_RECOVERY_WHEN } from '../recoveryPolicy/types'

const WALLET = '0xwa11e7000000000000000000000000000000001'
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const RANDOM_EOA = '0xcccccccccccccccccccccccccccccccccccccccccccccc'.slice(0, 42)
// The Uniswap Universal Router (Base) address — added to the shared registry as part of Priority 1
// (was previously ONLY in walletSnapshot.ts's tables, absent from swapNormalizer/pipeline copies).
const UNIVERSAL_ROUTER_BASE = '0x198ef79f1f515f02dfe9e3115ed9fc07183f02fc'

const ACTIVE_CHAIN_SELECTION: ChainSelectionResult = {
  chains: [{
    chain: 'base', visible_value_usd: 1000, wallet_side_transactions: 10, swapCandidateEvents: 5,
    gates: { valueGate: true, activityGate: true, swapGate: true }, status: 'active_intelligence',
  }],
  activeChainCount: 1, dustChainCount: 0,
}

const EMPTY_RECOVERY: RecoveryPolicyResult = {
  triggerRecoveryWhen: DEFAULT_TRIGGER_RECOVERY_WHEN, caps: DEFAULT_RECOVERY_CAPS, evaluation: [], totalPagesUsedThisWallet: 0,
}

function event(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    provider: 'goldrush', chain: 'base', txHash: '0xtx1', timestamp: '2024-01-01T00:00:00Z',
    fromAddress: WALLET, toAddress: RANDOM_EOA, contract: TOKEN_A, symbol: 'TOKA', amount: 100,
    amountRaw: '100000000000000000000', tokenDecimals: 18, direction: 'outbound',
    ...overrides,
  }
}

describe('buildSellTimeline — mechanism 2 (transfer-out to a known router)', () => {
  it('a plain outbound transfer to a random EOA (no router, no same-tx pairing) is NEVER a sell — transfer-only tx does not become a swap', () => {
    const result = buildSellTimeline({
      normalizedEvents: [event({ toAddress: RANDOM_EOA })],
      chainSelection: ACTIVE_CHAIN_SELECTION, bridgeTimeline: [], recoveryPolicy: EMPTY_RECOVERY, walletAddress: WALLET,
      knownDexRouterAddresses: KNOWN_DEX_ROUTER_ADDRESSES,
    })
    assert.equal(result.totalSells, 0, 'a plain transfer to an unknown address must never be fabricated into a sell')
  })

  it('THE FIX: an outbound transfer to the Uniswap Universal Router (Base) — no same-tx pairing needed — is detected as a sell via the shared registry', () => {
    const result = buildSellTimeline({
      normalizedEvents: [event({ toAddress: UNIVERSAL_ROUTER_BASE })],
      chainSelection: ACTIVE_CHAIN_SELECTION, bridgeTimeline: [], recoveryPolicy: EMPTY_RECOVERY, walletAddress: WALLET,
      knownDexRouterAddresses: KNOWN_DEX_ROUTER_ADDRESSES,
    })
    assert.equal(result.totalSells, 1, 'a transfer-out to a verified router must establish a sell candidate on its own, without router inference or same-tx pairing')
    assert.equal(result.entries[0].confidence, 'medium', 'router-only evidence (no same-tx pairing) is medium confidence, never fabricated high')
  })

  it('same-tx opposing-leg proof establishes a sell WITHOUT any router involvement at all', () => {
    const result = buildSellTimeline({
      normalizedEvents: [
        event({ txHash: '0xswap', toAddress: RANDOM_EOA, contract: TOKEN_A, direction: 'outbound' }),
        event({ txHash: '0xswap', toAddress: WALLET, fromAddress: RANDOM_EOA, contract: TOKEN_B, direction: 'inbound' }),
      ],
      chainSelection: ACTIVE_CHAIN_SELECTION, bridgeTimeline: [], recoveryPolicy: EMPTY_RECOVERY, walletAddress: WALLET,
      knownDexRouterAddresses: new Set(), // deliberately empty — proves router inference is not required
    })
    assert.equal(result.totalSells, 1, 'a same-tx opposing leg of a different token proves a swap without any router evidence')
  })

  it('same-tx pairing AND a known router together reach high confidence — tx/log proof stacks with router proof', () => {
    const result = buildSellTimeline({
      normalizedEvents: [
        event({ txHash: '0xswap2', toAddress: UNIVERSAL_ROUTER_BASE, contract: TOKEN_A, direction: 'outbound' }),
        event({ txHash: '0xswap2', toAddress: WALLET, fromAddress: UNIVERSAL_ROUTER_BASE, contract: TOKEN_B, direction: 'inbound' }),
      ],
      chainSelection: ACTIVE_CHAIN_SELECTION, bridgeTimeline: [], recoveryPolicy: EMPTY_RECOVERY, walletAddress: WALLET,
      knownDexRouterAddresses: KNOWN_DEX_ROUTER_ADDRESSES,
    })
    assert.equal(result.totalSells, 1)
    assert.equal(result.entries[0].confidence, 'high', 'same-tx pairing through a verified router is the strongest evidence, correctly promoted to high')
  })

  it('router inference accepted=0 does not erase known-router evidence — the registry lookup alone is sufficient', () => {
    // No inference signal supplied at all (this module never consults router inference) — proves
    // mechanism 2 depends only on the static, verified registry, never a behavioral inference result.
    const result = buildSellTimeline({
      normalizedEvents: [event({ toAddress: UNIVERSAL_ROUTER_BASE })],
      chainSelection: ACTIVE_CHAIN_SELECTION, bridgeTimeline: [], recoveryPolicy: EMPTY_RECOVERY, walletAddress: WALLET,
      knownDexRouterAddresses: KNOWN_DEX_ROUTER_ADDRESSES,
    })
    assert.equal(result.totalSells, 1)
  })

  it('respects chainSelection gating — a dust/excluded chain never contributes a sell entry', () => {
    const dustChainSelection: ChainSelectionResult = {
      chains: [{ chain: 'base', visible_value_usd: 0, wallet_side_transactions: 0, swapCandidateEvents: 0, gates: { valueGate: false, activityGate: false, swapGate: false }, status: 'dust_low_signal' }],
      activeChainCount: 0, dustChainCount: 1,
    }
    const result = buildSellTimeline({
      normalizedEvents: [event({ toAddress: UNIVERSAL_ROUTER_BASE })],
      chainSelection: dustChainSelection, bridgeTimeline: [], recoveryPolicy: EMPTY_RECOVERY, walletAddress: WALLET,
      knownDexRouterAddresses: KNOWN_DEX_ROUTER_ADDRESSES,
    })
    assert.equal(result.totalSells, 0, 'a chain downgraded to dust_low_signal must never contribute a sell entry, even with a verified router hit')
  })

  it('never fabricates a sell for an inbound event — direction is respected exactly', () => {
    const result = buildSellTimeline({
      normalizedEvents: [event({ direction: 'inbound', toAddress: WALLET, fromAddress: UNIVERSAL_ROUTER_BASE })],
      chainSelection: ACTIVE_CHAIN_SELECTION, bridgeTimeline: [], recoveryPolicy: EMPTY_RECOVERY, walletAddress: WALLET,
      knownDexRouterAddresses: KNOWN_DEX_ROUTER_ADDRESSES,
    })
    assert.equal(result.totalSells, 0, 'an inbound transfer must never be counted as a sell, regardless of counterparty')
  })
})
