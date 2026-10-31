// CORTEX Risk Evolution view model: comparisons use only stored observations of the latest scanner/methodology,
// missing evidence is reported as not comparable (never estimated), one observation is "Building History", and
// a 404 from the history API hides the panel.
//   npx tsx --test tests/cortex-risk-evolution.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRiskEvolution, buildWhatChanged, compareFactors, containsObservation, createCortexHistoryStore, formatSpan, labelledPointIndexes,
  loadCortexHistory, storedUsd, type CortexObservation, type ObservationFactors,
} from '../app/terminal/token-scanner/cortexRiskEvolutionModel'
import { recordedFactors } from '../lib/server/scanMemory/historyFactors'

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

// ─── Redesign: factors, view selection, "what changed" ────────────────────────────────────────────────────────

const factors = (over: Partial<ObservationFactors> = {}): ObservationFactors => ({
  honeypot: false, mint: 'not_detected', blacklist: 'not_detected', pause: 'not_detected', lpStatus: 'locked', devStatus: 'confirmed', ...over,
})

describe('recorded risk checks', () => {
  it('ranks only known severity scales and never guesses a direction', () => {
    const first = obs({ observedAt: at(0), factors: factors() })
    const latest = obs({ observedAt: at(1), factors: factors({ mint: 'verified', lpStatus: 'burned', pause: 'inferred', devStatus: 'possible_match', blacklist: 'unavailable', honeypot: null }) })
    const byKey = Object.fromEntries(compareFactors(first, latest).map((f) => [f.key, f.direction]))
    assert.equal(byKey.mint, 'worsened', 'not detected → confirmed capability is worse')
    assert.equal(byKey.lpStatus, 'changed', 'locked → burned: both safe, so a change without a risk direction')
    assert.equal(byKey.pause, 'changed', 'inferred has no defined severity')
    assert.equal(byKey.devStatus, 'changed', 'deployer identity has no risk direction')
    assert.equal(byKey.blacklist, 'not_comparable', 'unavailable in the latest scan')
    assert.equal(byKey.honeypot, 'not_comparable', 'simulation not recorded in the latest scan')
  })
  it('improvements are detected, and missing factor data gives no rows rather than invented ones', () => {
    const improved = compareFactors(obs({ factors: factors({ honeypot: true, lpStatus: 'unlocked' }) }), obs({ factors: factors() }))
    assert.equal(improved.find((f) => f.key === 'honeypot')?.direction, 'improved')
    assert.equal(improved.find((f) => f.key === 'lpStatus')?.direction, 'improved')
    assert.deepEqual(compareFactors(obs(), obs({ factors: factors() })), [])
  })
  it('the history API only returns enumerated check outcomes from the stored signal', () => {
    assert.deepEqual(recordedFactors({
      honeypot: { known: true, is_honeypot: false },
      contract_flags: { mint: 'verified', blacklist: 'not_detected', pause: '<script>' },
      lp_status: 'locked', dev_status: 'confirmed', risk_input_statuses: { secret: 'x' },
    }), { honeypot: false, mint: 'verified', blacklist: 'not_detected', pause: null, lpStatus: 'locked', devStatus: 'confirmed' })
    assert.equal(recordedFactors(null), null)
  })
})

describe('view selection and summary', () => {
  it('two comparable scans get a before/after comparison; three or more get the chart', () => {
    const two = buildRiskEvolution([obs({ observedAt: at(0) }), obs({ observedAt: at(1) })])
    const three = buildRiskEvolution([obs({ observedAt: at(0) }), obs({ observedAt: at(1) }), obs({ observedAt: at(2) })])
    assert.equal(two.state === 'trend' && two.chartReady, false)
    assert.equal(three.state === 'trend' && three.chartReady, true)
  })
  it('summarises only what the stored first and latest observations show, separating risk from market and evidence', () => {
    const model = buildRiskEvolution([
      obs({ observedAt: at(0), riskScore: 40, liquidityUsd: '10000', marketCapUsd: '50000', factors: factors() }),
      obs({ observedAt: at(1), riskScore: 52, liquidityUsd: '7500', marketCapUsd: '50100', coverage: 'partial', coverageReason: 'simulation', factors: factors({ mint: 'verified' }) }),
    ])
    assert.equal(model.state, 'trend')
    if (model.state !== 'trend') return
    const notes = buildWhatChanged(model)
    assert.deepEqual(notes.map((n) => n.group), ['risk', 'risk', 'market', 'evidence'])
    assert.match(notes[0].text, /rose 12 points, from 40 to 52/)
    assert.match(notes[1].text, /Mint capability: not detected → verified/)
    assert.match(notes[2].text, /liquidity down 25\.0%/)
    assert.ok(!notes.some((n) => /market cap/.test(n.text)), 'a 0.2% market-cap move is not reported as a change')
    assert.match(notes[3].text, /latest missing: trading simulation/)
  })
  it('an unchanged score says so instead of implying a trend', () => {
    const model = buildRiskEvolution([obs({ observedAt: at(0) }), obs({ observedAt: at(1) })])
    assert.equal(model.state === 'trend' && buildWhatChanged(model)[0].text, 'CORTEX risk score unchanged at 40/100 across 2 recorded scans.')
  })
})

// ─── Loading: shared store, bounded retries, races ────────────────────────────────────────────────────────────

type Reply = number | { observations: unknown[] }
function scripted(replies: Reply[]) {
  const calls: string[] = []
  const fetchImpl = (async (url: string) => {
    calls.push(url)
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]
    return typeof r === 'number' ? new Response('{}', { status: r }) : new Response(JSON.stringify(r), { status: 200 })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}
const noSleep = async () => {}
const session = (userId: string) => async () => ({ token: 't', userId })

describe('createCortexHistoryStore', () => {
  it('concurrent loads of one token share a single request, and a fresh cache answers without one', async () => {
    const { calls, fetchImpl } = scripted([{ observations: [obs()] }])
    const store = createCortexHistoryStore({ fetchImpl, getSession: session('u1'), sleep: noSleep })
    const [a, b] = await Promise.all([store.load('base', '0xabc'), store.load('base', '0xabc')])
    assert.equal(calls.length, 1)
    assert.equal(a.outcome.kind, 'ok')
    assert.equal(b.outcome.kind, 'ok')
    await store.load('base', '0xabc')
    assert.equal(calls.length, 1, 'cached')
    assert.equal((await store.peek('base', '0xabc'))?.kind, 'ok')
  })
  it('never shares history across users or tokens', async () => {
    const { calls, fetchImpl } = scripted([{ observations: [obs()] }])
    let user = 'u1'
    const store = createCortexHistoryStore({ fetchImpl, getSession: async () => ({ token: 't', userId: user }), sleep: noSleep })
    await store.load('base', '0xabc')
    user = 'u2'
    assert.equal(await store.peek('base', '0xabc'), null)
    await store.load('base', '0xabc')
    await store.load('eth', '0xabc')
    assert.equal(calls.length, 3)
  })
  it('first observation: an empty history is a valid answer, not an error', async () => {
    const { fetchImpl } = scripted([{ observations: [] }])
    const snap = await createCortexHistoryStore({ fetchImpl, getSession: session('u'), sleep: noSleep }).load('base', '0xabc')
    assert.deepEqual(snap.outcome, { kind: 'ok', observations: [] })
    assert.equal(snap.currentScanRecorded, null)
  })
  it('slow write: re-reads with backoff until the just-finished scan appears, then stops', async () => {
    const current = obs({ observedAt: at(5) })
    const { calls, fetchImpl } = scripted([{ observations: [obs()] }, { observations: [obs()] }, { observations: [obs(), current] }])
    const waits: number[] = []
    const store = createCortexHistoryStore({ fetchImpl, getSession: session('u'), sleep: async (ms) => { waits.push(ms) } })
    const snap = await store.load('base', '0xabc', { expectedObservedAt: current.observedAt })
    assert.equal(snap.currentScanRecorded, true)
    assert.equal(snap.attempts, 3)
    assert.deepEqual(waits, [800, 1600])
    assert.equal(calls.length, 3)
    assert.equal(snap.outcome.kind === 'ok' && snap.outcome.observations.length, 2)
  })
  it('a write that never appears (deduplicated or skipped) stops after the retry budget and keeps the history', async () => {
    const { calls, fetchImpl } = scripted([{ observations: [obs()] }])
    const snap = await createCortexHistoryStore({ fetchImpl, getSession: session('u'), sleep: noSleep }).load('base', '0xabc', { expectedObservedAt: at(9) })
    assert.equal(snap.currentScanRecorded, false)
    assert.equal(calls.length, 4, 'one read plus three bounded re-reads, no polling')
    assert.equal(snap.outcome.kind, 'ok')
  })
  it('a failed re-read keeps the last good history; a failed only read is an error', async () => {
    const { fetchImpl } = scripted([{ observations: [obs()] }, 503])
    const kept = await createCortexHistoryStore({ fetchImpl, getSession: session('u'), sleep: noSleep }).load('base', '0xabc', { expectedObservedAt: at(9) })
    assert.equal(kept.outcome.kind, 'ok')
    const failing = scripted([500])
    const failed = await createCortexHistoryStore({ fetchImpl: failing.fetchImpl, getSession: session('u'), sleep: noSleep }).load('base', '0xabc')
    assert.equal(failed.outcome.kind, 'error')
  })
  it('switching token abandons the pending wait instead of applying a stale response', async () => {
    const { calls, fetchImpl } = scripted([{ observations: [obs()] }])
    let current = true
    const store = createCortexHistoryStore({ fetchImpl, getSession: session('u'), sleep: async () => { current = false } })
    await store.load('base', '0xabc', { expectedObservedAt: at(9), isCurrent: () => current })
    assert.equal(calls.length, 1, 'no further reads once the panel moved to another token')
  })
  it('a 404 is remembered for the session: no further requests', async () => {
    const { calls, fetchImpl } = scripted([404])
    const store = createCortexHistoryStore({ fetchImpl, getSession: session('u'), sleep: noSleep })
    assert.equal((await store.load('base', '0xabc', { expectedObservedAt: at(9) })).outcome.kind, 'disabled')
    assert.equal((await store.load('eth', '0xdef')).outcome.kind, 'disabled')
    assert.equal(calls.length, 1)
    assert.equal(store.isDisabled(), true)
  })
  it('containsObservation matches the exact stored instant only', () => {
    assert.equal(containsObservation([obs({ observedAt: '2026-10-01T00:00:00.000Z' })], '2026-10-01T00:00:00Z'), true)
    assert.equal(containsObservation([obs()], '2026-10-01T00:00:01.000Z'), false)
    assert.equal(containsObservation([obs()], null), false)
  })
})
