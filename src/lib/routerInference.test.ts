import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { analyzeDistributorRouterFlows } from '../modules/distributorRecovery/index'
import { reconstructRouterTrades } from '../modules/routerTradeReconstruction/index'
import type { NormalizedEvent } from '../modules/normalization/types'
import { createRouterInference } from './routerInference'

const WALLET = '0xwallet'
const ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43'
const OTHER = '0xd0a40c6526acdebd4f6d87931098ff37a9f8e4bf'

function event(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    provider: 'goldrush',
    chain: 'base',
    txHash: '0xtx',
    timestamp: '2026-01-01T00:00:00.000Z',
    fromAddress: WALLET,
    toAddress: ROUTER,
    contract: '0xtoken',
    symbol: 'TOK',
    amount: 1,
    amountRaw: '1',
    tokenDecimals: 18,
    direction: 'outbound',
    ...overrides,
  }
}

function routerSwap(router: string, tx: number, token: string, minutes: number): NormalizedEvent[] {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, minutes, 0)).toISOString()
  return [
    event({ txHash: `0xtx${tx}`, timestamp, toAddress: router, contract: token, direction: 'outbound' }),
    event({ txHash: `0xtx${tx}`, timestamp, fromAddress: router, toAddress: WALLET, contract: `0xin${token.slice(-1)}`, direction: 'inbound' }),
  ]
}

function quietInference(config = {}) {
  return createRouterInference({ logger: { warn() {} }, knownRouterAddresses: new Set([ROUTER]), ...config })
}

describe('routerInference', () => {
  it('accepts a repeated-pattern high-confidence router', () => {
    const events = [0, 1, 2, 3].flatMap((i) => routerSwap(ROUTER, i, `0xtoken${i % 2}`, i))
    const result = quietInference().build(events)
    assert.equal(result.highConfidenceRouters.has(ROUTER), true)
    assert.match(result.evidenceByAddress.get(ROUTER)?.reasons.join(',') ?? '', /repeated-pattern:4/)
  })

  it('scores token-diversity routers', () => {
    const events = [0, 1, 2, 3].flatMap((i) => routerSwap(ROUTER, i, `0xtoken${i}`, i))
    const evidence = quietInference().build(events).evidenceByAddress.get(ROUTER)
    assert.equal(evidence?.tokens.length, 8)
    assert.ok(evidence?.reasons.some((reason) => reason.startsWith('token-diversity:')))
  })

  it('scores temporal clustering routers and builds deterministic clusters', () => {
    const events = [
      ...routerSwap(ROUTER, 1, '0xtokenA', 0),
      ...routerSwap(ROUTER, 2, '0xtokenA', 1),
      ...routerSwap(ROUTER, 3, '0xtokenA', 20),
      ...routerSwap(ROUTER, 4, '0xtokenB', 21),
    ]
    const result = quietInference().build(events)
    assert.ok(result.evidenceByAddress.get(ROUTER)?.temporalClusterCount ?? 0 >= 2)
    assert.ok((result.tokenFlowClustersByAddress.get(ROUTER)?.length ?? 0) >= 2)
  })

  it('rejects ambiguous routers', () => {
    const events = [0, 1, 2, 3].flatMap((i) => [
      ...routerSwap(ROUTER, i, `0xtoken${i % 2}`, i),
      ...routerSwap(OTHER, i + 10, `0xother${i % 2}`, i),
    ])
    const result = quietInference({ knownRouterAddresses: new Set([ROUTER, OTHER]) }).build(events)
    assert.equal(result.highConfidenceRouters.size, 0)
    assert.equal(result.ambiguousRouters.has(ROUTER), true)
    assert.equal(result.ambiguousRouters.has(OTHER), true)
  })

  it('is deterministic for the same input', () => {
    const events = [0, 1, 2, 3].flatMap((i) => routerSwap(ROUTER, i, `0xtoken${i % 2}`, i))
    const first = quietInference().build(events)
    const second = quietInference().build([...events].reverse())
    assert.deepEqual(first.candidates, second.candidates)
    assert.deepEqual(first.tokenFlowClustersByAddress.get(ROUTER), second.tokenFlowClustersByAddress.get(ROUTER))
  })

  it('pipeline integration: distributorRecovery receives only accepted routers', () => {
    const events = [0, 1, 2, 3].flatMap((i) => routerSwap(ROUTER, i, `0xtoken${i % 2}`, i))
    events.push(event({ txHash: '0xnoise', toAddress: OTHER, contract: '0xnoise' }))
    const inferred = quietInference().build(events)
    const result = analyzeDistributorRouterFlows(events, inferred.highConfidenceRouters, true)
    assert.equal(result.totalOutboundToKnownRouter, 4)
    assert.equal(result.groups.every((group) => group.outboundEvent.toAddress.toLowerCase() === ROUTER), true)
  })

  it('pipeline integration: routerTradeReconstruction receives only accepted routers', () => {
    const events = [0, 1, 2, 3].flatMap((i) => routerSwap(ROUTER, i, `0xtoken${i % 2}`, i))
    events.push(event({ txHash: '0xnoise', toAddress: OTHER, contract: '0xnoise' }))
    const inferred = quietInference().build(events)
    const result = reconstructRouterTrades(events, inferred.highConfidenceRouters, true)
    assert.equal(result.candidateTrades.length, 4)
    assert.equal(result.ambiguousCount, 0)
  })
})
