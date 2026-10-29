// CORTEX Risk Evolution view model: comparisons use only stored observations of the latest scanner/methodology,
// missing evidence is reported as not comparable (never estimated), one observation is "Building History", and
// a 404 from the history API hides the panel.
//   npx tsx --test tests/cortex-risk-evolution.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildRiskEvolution, formatSpan, labelledPointIndexes, loadCortexHistory, storedUsd, type CortexObservation } from '../app/terminal/token-scanner/cortexRiskEvolutionModel'

const SCANNER = 'token_scanner_response:8'
const METHOD = 'evm_token_risk_score:v1'
const obs = (over: Partial<CortexObservation> = {}): CortexObservation => ({
  observedAt: '2026-10-01T00:00:00.000Z',
  riskScore: 40,
  riskLabel: 'Moderate Risk',
  coverage: 'complete',
  coverageReason: null,
  liquidityUsd: '10000.00',
  marketCapUsd: '50000.00',
  holderPoints: 30,
  holderBasis: 'total_supply:rpc_total_supply',
  scannerVersion: SCANNER,
  riskMethodologyVersion: METHOD,
  ...over,
})
const at = (hours: number) => new Date(Date.UTC(2026, 9, 1) + hours * 3_600_000).toISOString()

describe('buildRiskEvolution — states', () => {
  it('no valid observations is empty, not a trend or a placeholder score', () => {
    assert.deepEqual(buildRiskEvolution([]), { state: 'empty' })
    assert.deepEqual(buildRiskEvolution(null), { state: 'empty' })
    assert.deepEqual(buildRiskEvolution([obs({ riskScore: 101 }), obs({ observedAt: 'not a date' }), obs({ riskScore: 40.5 })]), { state: 'empty' })
  })

  it('one observation is Building History, never a trend', () => {
    const model = buildRiskEvolution([obs()])
    assert.equal(model.state, 'building')
    assert.equal(model.state === 'building' && model.latest.riskScore, 40)
  })

  it('two comparable observations give a trend from the first to the latest stored score', () => {
    const model = buildRiskEvolution([obs({ observedAt: at(5), riskScore: 62 }), obs({ observedAt: at(0), riskScore: 40 })])
    assert.equal(model.state, 'trend')
    if (model.state !== 'trend') return
    assert.equal(model.first.riskScore, 40, 'sorted by observation time, not input order')
    assert.equal(model.latest.riskScore, 62)
    assert.equal(model.riskDelta, 22)
    assert.equal(model.spanMs, 5 * 3_600_000)
  })

  it('never adds observations: chart points are exactly the comparable stored rows', () => {
    const rows = [obs({ observedAt: at(0) }), obs({ observedAt: at(1), riskScore: 44 }), obs({ observedAt: at(30), riskScore: 70 })]
    const model = buildRiskEvolution(rows)
    assert.equal(model.state, 'trend')
    if (model.state !== 'trend') return
    assert.equal(model.points.length, 3)
    assert.deepEqual(model.points.map((p) => p.observation.riskScore), [40, 44, 70])
  })
})

describe('buildRiskEvolution — methodology changes', () => {
  it('compares only observations with the latest scanner and risk methodology', () => {
    const model = buildRiskEvolution([
      obs({ observedAt: at(0), riskScore: 90, riskMethodologyVersion: 'evm_token_risk_score:v0' }),
      obs({ observedAt: at(1), riskScore: 40 }),
      obs({ observedAt: at(2), riskScore: 45 }),
    ])
    assert.equal(model.state, 'trend')
    if (model.state !== 'trend') return
    assert.equal(model.excludedForMethodology, 1)
    assert.equal(model.first.riskScore, 40, 'the old-methodology 90 is never the baseline')
    assert.equal(model.riskDelta, 5)
  })

  it('a methodology change leaves one comparable observation as Building History', () => {
    const model = buildRiskEvolution([
      obs({ observedAt: at(0), riskScore: 20, scannerVersion: 'token_scanner_response:7' }),
      obs({ observedAt: at(1), riskScore: 80 }),
    ])
    assert.equal(model.state, 'building')
    assert.equal(model.state === 'building' && model.excludedForMethodology, 1)
  })
})

describe('buildRiskEvolution — missing evidence', () => {
  it('a value missing from the first or latest observation is not comparable, and a middle one is never used to fill it', () => {
    const model = buildRiskEvolution([
      obs({ observedAt: at(0), liquidityUsd: null, marketCapUsd: '50000' }),
      obs({ observedAt: at(1), liquidityUsd: '12000', marketCapUsd: '55000' }),
      obs({ observedAt: at(2), liquidityUsd: '9000', marketCapUsd: null }),
    ])
    assert.equal(model.state, 'trend')
    if (model.state !== 'trend') return
    assert.deepEqual(model.liquidity, { comparable: false, reason: 'Not recorded in the first observation' })
    assert.deepEqual(model.marketCap, { comparable: false, reason: 'Not recorded in the latest observation' })
  })

  it('liquidity and market cap changes are computed from stored values only', () => {
    const model = buildRiskEvolution([obs({ observedAt: at(0), liquidityUsd: '10000.00' }), obs({ observedAt: at(1), liquidityUsd: 7500 })])
    assert.equal(model.state, 'trend')
    if (model.state !== 'trend') return
    assert.deepEqual(model.liquidity, { comparable: true, from: 10000, to: 7500, change: -25 })
  })

  it('zero, negative and unparseable amounts count as missing', () => {
    for (const v of [0, -5, '0', 'abc', '', null, undefined]) assert.equal(storedUsd(v as never), null)
  })

  it('holder concentration needs both values and the same supply basis', () => {
    const differentBasis = buildRiskEvolution([obs({ observedAt: at(0), holderPoints: 20 }), obs({ observedAt: at(1), holderPoints: 35, holderBasis: 'provider_reported_percent' })])
    assert.equal(differentBasis.state === 'trend' && differentBasis.topHolders.comparable, false)
    const missing = buildRiskEvolution([obs({ observedAt: at(0), holderPoints: null }), obs({ observedAt: at(1), holderPoints: 35 })])
    assert.equal(missing.state === 'trend' && missing.topHolders.comparable, false)
    const same = buildRiskEvolution([obs({ observedAt: at(0), holderPoints: 20 }), obs({ observedAt: at(1), holderPoints: 35 })])
    assert.deepEqual(same.state === 'trend' && same.topHolders, { comparable: true, from: 20, to: 35, change: 15 })
  })

  it('partial-coverage observations are counted so the panel can say so', () => {
    const model = buildRiskEvolution([obs({ observedAt: at(0), coverage: 'partial' }), obs({ observedAt: at(1) }), obs({ observedAt: at(2), coverage: 'provider_unavailable' })])
    assert.equal(model.state === 'trend' && model.partialEvidenceCount, 2)
  })
})

describe('buildRiskEvolution — chart geometry', () => {
  it('points are placed by real observation time, not evenly by index', () => {
    const model = buildRiskEvolution([obs({ observedAt: at(0), riskScore: 0 }), obs({ observedAt: at(1), riskScore: 100 }), obs({ observedAt: at(10), riskScore: 50 })])
    assert.equal(model.state, 'trend')
    if (model.state !== 'trend') return
    assert.deepEqual(model.points.map((p) => Math.round(p.xPct)), [0, 10, 100])
    assert.deepEqual(model.points.map((p) => p.yPct), [100, 0, 50], 'higher risk is drawn higher')
  })

  it('observations recorded at the same instant stay distinguishable', () => {
    const model = buildRiskEvolution([obs({ riskScore: 40 }), obs({ riskScore: 60 })])
    assert.equal(model.state === 'trend' && model.points.map((p) => p.xPct).join(), '0,100')
  })

  it('crowded score labels are skipped, the latest is always labelled, and every point is kept', () => {
    const pts = [{ xPct: 0, yPct: 62 }, { xPct: 2, yPct: 59 }, { xPct: 3, yPct: 53 }, { xPct: 40, yPct: 37 }, { xPct: 100, yPct: 29 }]
    const shown = labelledPointIndexes(pts)
    assert.ok(shown.has(4), 'latest labelled')
    assert.ok(shown.has(3))
    assert.equal([0, 1, 2].filter((i) => shown.has(i)).length, 1, 'only one label in the crowded cluster')
    assert.deepEqual([...labelledPointIndexes([{ xPct: 0, yPct: 10 }, { xPct: 2, yPct: 90 }])].sort(), [0, 1], 'far apart vertically: both labelled')
  })

  it('formats observation spans', () => {
    assert.equal(formatSpan(30 * 60_000), '30 min')
    assert.equal(formatSpan(5 * 3_600_000), '5 h')
    assert.equal(formatSpan(72 * 3_600_000), '3 days')
  })
})

describe('loadCortexHistory', () => {
  const respond = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  it('a 404 disables the panel', async () => {
    assert.deepEqual(await loadCortexHistory('base', '0xabc', 'token', respond(404)), { kind: 'disabled' })
  })
  it('other failures are errors, never an empty history', async () => {
    for (const status of [401, 429, 500, 503]) assert.deepEqual(await loadCortexHistory('base', '0xabc', 'token', respond(status)), { kind: 'error' })
    const throwing = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    assert.deepEqual(await loadCortexHistory('base', '0xabc', null, throwing), { kind: 'error' })
  })
  it('sends one request with the bearer token and returns the stored observations', async () => {
    const calls: Array<{ url: string; auth: string | null }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
      return new Response(JSON.stringify({ observations: [obs()] }), { status: 200 })
    }) as unknown as typeof fetch
    const outcome = await loadCortexHistory('base', '0xabc', 'tok', fetchImpl)
    assert.equal(outcome.kind, 'ok')
    assert.equal(outcome.kind === 'ok' && outcome.observations.length, 1)
    assert.deepEqual(calls, [{ url: '/api/cortex/history?chain=base&contract=0xabc', auth: 'Bearer tok' }])
  })
})
