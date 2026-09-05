// Tests for src/modules/chainSelection (Wallet Scanner audit, Item 5 — "chain selection hardcodes
// swapCandidateEvents=0, visible_value_usd=0... wire real available signals where safe so a
// swap-active chain is not incorrectly downgraded to dust_low_signal"). This module had zero direct
// unit tests before this task.
//
// Run directly with:
//   npx tsx --test src/modules/chainSelection/chainSelection.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildChainSelectionObject, computeChainMetrics, evaluateGates } from './index'
import type { NormalizedEvent } from '../normalization/types'

const WALLET = '0xwa11e7000000000000000000000000000000001'
const ROUTER = '0x198ef79f1f515f02dfe9e3115ed9fc07183f02fc' // Uniswap Universal Router (Base)
const RANDOM_EOA = '0xccccccccccccccccccccccccccccccccccccccc'

function event(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    provider: 'goldrush', chain: 'base', txHash: '0xtx1', timestamp: '2024-01-01T00:00:00Z',
    fromAddress: WALLET, toAddress: RANDOM_EOA, contract: '0xtoken', symbol: 'TOK', amount: 100,
    amountRaw: '100', tokenDecimals: 18, direction: 'outbound',
    ...overrides,
  }
}

describe('computeChainMetrics / evaluateGates — no fabrication', () => {
  it('defaults visible_value_usd and swapCandidateEvents to 0 when not supplied — never fabricated', () => {
    const metrics = computeChainMetrics([], { chain: 'base', providerStatus: 'ok' })
    assert.equal(metrics.visible_value_usd, 0)
    assert.equal(metrics.swapCandidateEvents, 0)
  })

  it('a chain with zero of all three real signals fails every gate', () => {
    const metrics = computeChainMetrics([], { chain: 'base', providerStatus: 'ok' })
    const gates = evaluateGates(metrics)
    assert.deepEqual(gates, { valueGate: false, activityGate: false, swapGate: false })
  })

  it('a real, caller-supplied swapCandidateEvents count passes swapGate honestly', () => {
    const metrics = computeChainMetrics([], { chain: 'base', providerStatus: 'ok', swapCandidateEvents: 3 })
    assert.equal(evaluateGates(metrics).swapGate, true)
  })
})

describe('buildChainSelectionObject — real router-touching activity must not be downgraded to dust', () => {
  it('THE BUG: a chain whose entire real swap activity normalized to direction:unknown (pool-to-pool routing) previously had every gate false and was always dust_low_signal', () => {
    // wallet_side_transactions excludes direction:'unknown' by construction (countWalletSideTransactions)
    // — this reproduces exactly that shape: real router activity, zero resolved wallet-side direction.
    const events: NormalizedEvent[] = [
      event({ txHash: '0xa', direction: 'unknown', fromAddress: ROUTER, toAddress: '0xpool' }),
      event({ txHash: '0xb', direction: 'unknown', fromAddress: '0xpool', toAddress: ROUTER }),
    ]
    // Without a real swapCandidateEvents signal wired in (the pre-fix state), this chain would fail
    // every gate and be misclassified — demonstrated directly via evaluateGates on the honest-zero input.
    const staleMetrics = computeChainMetrics(events, { chain: 'base', providerStatus: 'ok' })
    assert.equal(evaluateGates(staleMetrics).activityGate, false, 'wallet_side_transactions is 0 — every event is direction:unknown')
    assert.equal(evaluateGates(staleMetrics).swapGate, false, 'swapCandidateEvents defaults to 0 when not supplied')
  })

  it('THE FIX: wiring a real, router-derived swapCandidateEvents count rescues that same chain into active_intelligence', () => {
    const events: NormalizedEvent[] = [
      event({ txHash: '0xa', direction: 'unknown', fromAddress: ROUTER, toAddress: '0xpool' }),
      event({ txHash: '0xb', direction: 'unknown', fromAddress: '0xpool', toAddress: ROUTER }),
    ]
    const result = buildChainSelectionObject(events, [
      { chain: 'base', providerStatus: 'ok', swapCandidateEvents: 2 },
    ])
    assert.equal(result.chains[0].status, 'active_intelligence', 'real router-touching activity must rescue this chain from dust_low_signal')
    assert.equal(result.activeChainCount, 1)
    assert.equal(result.dustChainCount, 0)
  })

  it('a genuinely inactive chain (no real signal of any kind) is honestly dust_low_signal, never activated from a fabricated estimate', () => {
    const result = buildChainSelectionObject([], [{ chain: 'base', providerStatus: 'ok' }])
    assert.equal(result.chains[0].status, 'dust_low_signal')
    assert.equal(result.chains[0].swapCandidateEvents, 0)
    assert.equal(result.chains[0].visible_value_usd, 0)
  })

  it('provider_unavailable forces dust_low_signal unconditionally, even with real swap activity', () => {
    const events: NormalizedEvent[] = [event({ txHash: '0xa', toAddress: ROUTER })]
    const result = buildChainSelectionObject(events, [
      { chain: 'base', providerStatus: 'provider_unavailable', swapCandidateEvents: 5 },
    ])
    assert.equal(result.chains[0].status, 'dust_low_signal', 'a failed provider fetch must never be overridden by a swap signal')
  })

  it('a chain with real wallet_side_transactions alone (no router signal) still activates — activityGate is untouched by this fix', () => {
    const events: NormalizedEvent[] = [event({ txHash: '0xa', direction: 'outbound', toAddress: RANDOM_EOA })]
    const result = buildChainSelectionObject(events, [{ chain: 'base', providerStatus: 'ok' }])
    assert.equal(result.chains[0].status, 'active_intelligence')
  })
})
