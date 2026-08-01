// Integration tests for the success-probability-weighted scheduling wiring in priceLotsForWallet.ts.
// Run directly with:
//   npx tsx --test src/pipeline/priceLotsForWallet.successWeighting.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { priceLotsForWallet } from './priceLotsForWallet.ts'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { PriceSourceFn, PriceSources } from '../modules/pricingAtTimeEngine/types'
import {
  recordPricingAttemptOutcome,
  resetSourceSuccessEvidence,
} from '../modules/pricingAtTimeEngine/sourceSuccessEvidence'

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'alchemy', chain: 'base', txHash: '0xtx', timestamp: '2026-01-01T00:00:00.000Z',
    fromAddress: '0xfrom', toAddress: '0xto', contract: '0xtoken', symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

function countingPriceSources(): { sources: PriceSources; state: { calls: number } } {
  const state = { calls: 0 }
  const fn: PriceSourceFn = () => {
    state.calls += 1
    return 1
  }
  return { sources: { primary: fn, fallback: fn }, state }
}

const FLAGS = [
  'HISTORICAL_PRICING_YIELD_SCHEDULER_ENABLED',
  'HISTORICAL_PRICING_SUCCESS_WEIGHTING_ENABLED',
  'HISTORICAL_PRICING_EVIDENCE_PERSISTENCE_ENABLED',
] as const
const originals = new Map(FLAGS.map((f) => [f, process.env[f]]))

// Captures the shadow diagnostic without letting it flood the test output.
function captureWarn(): { lines: Array<{ tag: string; payload: unknown }>; restore: () => void } {
  const lines: Array<{ tag: string; payload: unknown }> = []
  const original = console.warn
  console.warn = (tag: unknown, payload?: unknown) => { lines.push({ tag: String(tag), payload }) }
  return { lines, restore: () => { console.warn = original } }
}

beforeEach(() => {
  for (const f of FLAGS) delete process.env[f]
  resetSourceSuccessEvidence()
})

afterEach(() => {
  for (const f of FLAGS) {
    const original = originals.get(f)
    if (original === undefined) delete process.env[f]
    else process.env[f] = original
  }
  resetSourceSuccessEvidence()
})

describe('priceLotsForWallet — success-weighted scheduling wiring', () => {
  it('always logs [historical-pricing-success-weighted-shadow] with every required field, even with both flags OFF', async () => {
    const buy = event({ txHash: '0xbuy', direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' })
    const sell = event({ txHash: '0xsell', direction: 'outbound', timestamp: '2026-01-02T00:00:00.000Z' })
    const { sources } = countingPriceSources()

    const capture = captureWarn()
    try {
      await priceLotsForWallet({ normalizedEvents: [buy, sell], recoveredEvents: [], priceSources: sources })
    } finally {
      capture.restore()
    }

    const shadow = capture.lines.find((l) => l.tag === '[historical-pricing-success-weighted-shadow]')
    assert.ok(shadow, 'the shadow diagnostic must always be emitted, regardless of flag state')
    const payload = shadow.payload as Record<string, unknown>
    for (const field of [
      'baselineSelected', 'weightedSelected', 'overlap',
      'baselineExpectedLots', 'weightedExpectedLots',
      'baselineExpectedResolvedLots', 'weightedExpectedResolvedLots',
      'selectedBySource', 'discountedByFailureReason', 'skippedHardFailures',
      'estimatedCalls', 'estimatedCu',
    ]) {
      assert.ok(field in payload, `missing required diagnostic field: ${field}`)
    }
  })

  it('with the weighting flag OFF, real pricing output is byte-identical to the unweighted baseline', async () => {
    const buy = event({ txHash: '0xbuy', direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' })
    const sell = event({ txHash: '0xsell', direction: 'outbound', timestamp: '2026-01-02T00:00:00.000Z' })

    // Real, recorded evidence that this token's sources never answer. With the flag OFF this must
    // have ZERO effect on what actually gets priced.
    for (let i = 0; i < 20; i += 1) {
      recordPricingAttemptOutcome({
        chain: 'base', token: '0xtoken', source: 'geckoterminal',
        assetClass: 'other', requirementType: 'entry', ok: false, reason: 'no_pool',
      })
    }

    const a = countingPriceSources()
    const captureA = captureWarn()
    let resultA
    try {
      resultA = await priceLotsForWallet({ normalizedEvents: [buy, sell], recoveredEvents: [], priceSources: a.sources })
    } finally {
      captureA.restore()
    }

    resetSourceSuccessEvidence()
    const b = countingPriceSources()
    const captureB = captureWarn()
    let resultB
    try {
      resultB = await priceLotsForWallet({ normalizedEvents: [buy, sell], recoveredEvents: [], priceSources: b.sources })
    } finally {
      captureB.restore()
    }

    assert.equal(a.state.calls, b.state.calls, 'evidence must not change call volume while the flag is off')
    assert.deepEqual(resultA.sourceBreakdown, resultB.sourceBreakdown)
    assert.equal(resultA.priceUsdLookup(buy), resultB.priceUsdLookup(buy))
    assert.equal(resultA.priceUsdLookup(sell), resultB.priceUsdLookup(sell))
  })

  it('with the weighting flag ON, provider call volume is never increased', async () => {
    const events = Array.from({ length: 12 }, (_, i) => event({
      txHash: `0xtx${i}`,
      contract: `0xtoken${i % 3}`,
      direction: i % 2 === 0 ? 'inbound' : 'outbound',
      timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
    }))

    const off = countingPriceSources()
    const captureOff = captureWarn()
    try {
      await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: off.sources })
    } finally {
      captureOff.restore()
    }

    process.env.HISTORICAL_PRICING_YIELD_SCHEDULER_ENABLED = 'true'
    process.env.HISTORICAL_PRICING_SUCCESS_WEIGHTING_ENABLED = 'true'
    const on = countingPriceSources()
    const captureOn = captureWarn()
    try {
      await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: on.sources })
    } finally {
      captureOn.restore()
    }

    assert.ok(on.state.calls <= off.state.calls,
      `success weighting must redistribute, never grow, the budget (on=${on.state.calls}, off=${off.state.calls})`)
  })

  it('always logs [source-success-evidence-summary] with every required field', async () => {
    const buy = event({ txHash: '0xbuy', direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' })
    const sell = event({ txHash: '0xsell', direction: 'outbound', timestamp: '2026-01-02T00:00:00.000Z' })
    const { sources } = countingPriceSources()

    const capture = captureWarn()
    try {
      await priceLotsForWallet({ normalizedEvents: [buy, sell], recoveredEvents: [], priceSources: sources })
    } finally {
      capture.restore()
    }

    const summary = capture.lines.find((l) => l.tag === '[source-success-evidence-summary]')
    assert.ok(summary, 'the evidence summary must always be emitted')
    const payload = summary.payload as Record<string, unknown>
    for (const field of [
      'persistenceEnabled', 'evidenceLoadedBeforeScan', 'evidenceRecordedThisScan',
      'aggregateKeysLoaded', 'tokenKeysLoaded', 'readTimedOut', 'writeTimedOut',
      'usedDefaultPriors', 'processInstanceId',
    ]) {
      assert.ok(field in payload, `missing required diagnostic field: ${field}`)
    }
    assert.equal(payload.persistenceEnabled, false, 'persistence stays off unless explicitly enabled')
  })

  it('scheduler budgets and provider calls are unchanged when persistence is unavailable', async () => {
    const events = Array.from({ length: 10 }, (_, i) => event({
      txHash: `0xtx${i}`,
      contract: `0xtoken${i % 3}`,
      direction: i % 2 === 0 ? 'inbound' : 'outbound',
      timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
    }))

    const off = countingPriceSources()
    const captureOff = captureWarn()
    try {
      await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: off.sources })
    } finally {
      captureOff.restore()
    }

    // Persistence ON but with no KV credentials configured in this environment — the real
    // fail-open path. Call volume and pricing output must be identical.
    process.env.HISTORICAL_PRICING_EVIDENCE_PERSISTENCE_ENABLED = 'true'
    const on = countingPriceSources()
    const captureOn = captureWarn()
    let summaryPayload: Record<string, unknown> | undefined
    try {
      await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: on.sources })
      summaryPayload = captureOn.lines.find((l) => l.tag === '[source-success-evidence-summary]')?.payload as Record<string, unknown>
    } finally {
      captureOn.restore()
    }

    assert.equal(on.state.calls, off.state.calls,
      'an unreachable KV must never change how many pricing provider calls a scan makes')
    assert.equal(summaryPayload?.usedDefaultPriors, true,
      'with no reachable KV the scan must fall back to default priors')
  })

  it('the shadow diagnostic is deterministic across identical runs', async () => {
    const buy = event({ txHash: '0xbuy', direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' })
    const sell = event({ txHash: '0xsell', direction: 'outbound', timestamp: '2026-01-02T00:00:00.000Z' })

    async function runOnce(): Promise<unknown> {
      const { sources } = countingPriceSources()
      const capture = captureWarn()
      try {
        await priceLotsForWallet({ normalizedEvents: [buy, sell], recoveredEvents: [], priceSources: sources })
      } finally {
        capture.restore()
      }
      return capture.lines.find((l) => l.tag === '[historical-pricing-success-weighted-shadow]')?.payload
    }

    const first = await runOnce()
    resetSourceSuccessEvidence()
    const second = await runOnce()
    assert.deepEqual(second, first)
  })
})
