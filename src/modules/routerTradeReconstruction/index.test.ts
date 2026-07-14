// Tests for src/modules/routerTradeReconstruction. Uses node:test, same convention as this
// codebase's other module tests. Run directly with:
//   npx tsx --test src/modules/routerTradeReconstruction/index.test.ts
//
// SYNTHETIC WALLET PATTERN, DISCLOSED: fixtures below model the described "Base memecoin degen
// wallet" shape (heavy router usage, many small tokens) — this sandbox has no network access to
// fetch any real wallet's actual on-chain history, so synthetic fixtures matching the DESCRIBED
// pattern are the honest choice, same convention already used by distributorRecovery's own tests.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { reconstructRouterTrades, classifyPoolLiquidity } from './index'
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

describe('reconstructRouterTrades — routerDistributorMode gate (no-op for normal wallets)', () => {
  it('is a no-op (applied: false, no candidates) when routerDistributorMode is false', () => {
    const events = [
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound' }),
      event({ txHash: '0xtx1', contract: '0xtokenB', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }),
    ]
    const result = reconstructRouterTrades(events, KNOWN_ROUTERS, false)
    assert.equal(result.applied, false)
    assert.deepEqual(result.candidateTrades, [])
  })
})

describe('reconstructRouterTrades — high confidence (unambiguous 1:1 same-tx pairing)', () => {
  it('produces a high-confidence candidate trade for a clean 1-out/1-in router swap', () => {
    const events = [
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound', amount: 100 }),
      event({ txHash: '0xtx1', contract: '0xtokenB', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET, amount: 50 }),
    ]
    const result = reconstructRouterTrades(events, KNOWN_ROUTERS, true)
    assert.equal(result.applied, true)
    assert.equal(result.candidateTrades.length, 1)
    const trade = result.candidateTrades[0]
    assert.equal(trade.confidence, 'high')
    assert.equal(trade.tokenIn, '0xtokenA')
    assert.equal(trade.tokenOut, '0xtokenB')
    assert.equal(trade.amountIn, 100)
    assert.equal(trade.amountOut, 50)
    assert.equal(result.highConfidenceCount, 1)
  })
})

describe('reconstructRouterTrades — medium confidence (same-tx but multi-leg/ambiguous pairing)', () => {
  it('classifies as medium confidence when the tx has multiple inbound legs', () => {
    const events = [
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound' }),
      event({ txHash: '0xtx1', contract: '0xtokenB', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }),
      event({ txHash: '0xtx1', contract: '0xtokenC', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }),
    ]
    const result = reconstructRouterTrades(events, KNOWN_ROUTERS, true)
    assert.equal(result.candidateTrades.length, 1)
    assert.equal(result.candidateTrades[0].confidence, 'medium')
    assert.equal(result.highConfidenceCount, 0)
  })
})

describe('reconstructRouterTrades — ambiguous flows are NEVER turned into trades', () => {
  it('no same-tx inbound leg at all -> no candidate trade produced, counted as ambiguous', () => {
    const events = [event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound' })]
    const result = reconstructRouterTrades(events, KNOWN_ROUTERS, true)
    assert.equal(result.candidateTrades.length, 0)
    assert.equal(result.ambiguousCount, 1)
  })

  it('an inbound leg in a DIFFERENT transaction is never paired (never fabricated across txs)', () => {
    const events = [
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound' }),
      event({ txHash: '0xtx2', contract: '0xtokenB', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }),
    ]
    const result = reconstructRouterTrades(events, KNOWN_ROUTERS, true)
    assert.equal(result.candidateTrades.length, 0)
    assert.equal(result.ambiguousCount, 1)
  })

  it('an inbound leg for the SAME token as the outbound is never treated as a swap return', () => {
    const events = [
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound' }),
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }),
    ]
    const result = reconstructRouterTrades(events, KNOWN_ROUTERS, true)
    assert.equal(result.candidateTrades.length, 0)
    assert.equal(result.ambiguousCount, 1)
  })

  it('outbound events to a non-router counterparty are ignored entirely (no candidate, not counted ambiguous)', () => {
    const events = [event({ txHash: '0xtx1', toAddress: '0xnotarouter' })]
    const result = reconstructRouterTrades(events, KNOWN_ROUTERS, true)
    assert.equal(result.candidateTrades.length, 0)
    assert.equal(result.ambiguousCount, 0)
  })
})

describe('reconstructRouterTrades — high-frequency degen wallet pattern (thousands of small trades)', () => {
  it('produces consistent, deterministic candidate trades across repeated runs for a large synthetic trace', () => {
    const events: NormalizedEvent[] = []
    for (let i = 0; i < 500; i++) {
      events.push(event({ txHash: `0xtx${i}`, contract: `0xmeme${i}`, direction: 'outbound', amount: 10 + i }))
      if (i % 3 !== 0) {
        // 2/3 of swaps have clean same-tx evidence; 1/3 are genuinely ambiguous (no return leg seen).
        events.push(event({ txHash: `0xtx${i}`, contract: `0xreturn${i}`, direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET, amount: i }))
      }
    }
    const first = reconstructRouterTrades(events, KNOWN_ROUTERS, true)
    const second = reconstructRouterTrades(events, KNOWN_ROUTERS, true)
    assert.equal(first.candidateTrades.length, second.candidateTrades.length)
    assert.equal(first.highConfidenceCount, second.highConfidenceCount)
    assert.equal(first.ambiguousCount, second.ambiguousCount)
    assert.equal(first.highConfidenceCount, Math.round((500 * 2) / 3))
    assert.equal(first.ambiguousCount, Math.round(500 / 3))
  })
})

describe('classifyPoolLiquidity — memecoin pool awareness (Part 2)', () => {
  it('classifies a well-liquidated pool as real', () => {
    assert.equal(classifyPoolLiquidity(50_000), 'real')
  })

  it('classifies a small pool as dust', () => {
    assert.equal(classifyPoolLiquidity(500), 'dust')
  })

  it('classifies a near-zero-liquidity pool as abandoned', () => {
    assert.equal(classifyPoolLiquidity(10), 'abandoned')
  })

  it('null/NaN liquidity is treated as abandoned, never assumed real', () => {
    assert.equal(classifyPoolLiquidity(null), 'abandoned')
    assert.equal(classifyPoolLiquidity(NaN), 'abandoned')
  })
})
