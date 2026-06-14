import assert from 'node:assert/strict'
import {
  buildRadarSignals,
  buildWhyItMatters,
  buildRadarTimeline,
  buildNextFiveMinuteRead,
} from '../lib/baseRadarSignals.ts'

const VALID_SEVERITIES = new Set(['positive', 'neutral', 'watch', 'risk', 'critical'])
const VALID_CATEGORIES = new Set([
  'Momentum likely to continue',
  'Momentum slowing',
  'Momentum reversing',
  'No clear short-term signal',
])

// ─── Realistic Radar token fixture (mirrors RadarSignalsToken / RadarSignalsEnrichment shapes) ───
const realToken = {
  contract: '0xabc1234567890abc1234567890abc1234567890',
  ageMinutes: 7,
  liquidityUsd: 20_000,
  volume24h: 150_000,
  radarScore: 78,
  momentum: 'rising',
  flags: ['new-pool'],
  simulationStatus: 'open_check',
  simulationReason: 'timeout',
}

const realEnrichment = {
  market: {
    liquidityUsd: 20_000,
    volume24hUsd: 150_000,
    poolActivity: { pairCreatedAt: new Date(Date.now() - 7 * 60_000).toISOString() },
  },
  lp: {
    lpLockStatus: 'unlocked',
    lpControl: { status: 'team_controlled' },
    displayLpModel: 'standard',
    lpProofApplicability: 'standard',
    primaryMarketPool: '0xpool1234567890abc1234567890abc1234567890',
    lpModelProof: { dexName: 'Aerodrome' },
  },
  holders: {
    top10: 72.5,
    top20: 85,
    holderCount: 41,
    creatorInTopHolders: true,
    creatorHolderPercent: 12,
  },
  deployer: {
    deployerAddress: '0xdeployer1234567890abc1234567890abc12345',
    pastLaunches: { status: 'checked', count: 2, sample: ['0xlinked1234567890abc1234567890abc1234567'], reason: null },
    rugHistory: { verified: false, count: 0, reason: null },
    clusterEvidence: { confirmed: true, devClusterSupplyPercent: 15.4, linkedWalletSupplyPercent: 22.1 },
  },
  security: {
    devOwnership: {
      ownerAddress: '0xowner1234567890abc1234567890abc12345678',
      adminAddress: null,
      isRenounced: false,
      ownershipVerified: true,
      ownershipStatus: 'active_owner',
    },
  },
  priceChart: {
    points: [
      { timestamp: 1, close: 1.0 },
      { timestamp: 2, close: 1.05 },
      { timestamp: 3, close: 1.12 },
      { timestamp: 4, close: 1.2 },
    ],
    timeframe: '5m',
  },
}

// ─── 1. buildRadarSignals — real fixture ───
const signals = buildRadarSignals(realToken, realEnrichment)
assert.ok(Array.isArray(signals) && signals.length > 0, 'signals array must be non-empty')
for (const s of signals) {
  assert.ok(typeof s.label === 'string' && s.label.length > 0, 'signal label must be non-empty')
  assert.ok(VALID_SEVERITIES.has(s.severity), `signal severity must be valid, got ${s.severity}`)
  assert.ok(typeof s.reason === 'string' && s.reason.length > 0, 'signal reason must be non-empty')
}
// High concentration + unlocked LP + active owner should all surface as risk-ish signals
assert.ok(signals.some((s) => s.label === 'High concentration'), 'expected a High concentration signal')
assert.ok(signals.some((s) => s.label === 'LP unlocked'), 'expected an LP unlocked signal')
assert.ok(signals.some((s) => s.label === 'New pool'), 'expected a New pool signal for a 7-minute-old pool')

// ─── 2. buildWhyItMatters — real fixture ───
const whyItMatters = buildWhyItMatters(realToken, realEnrichment)
assert.ok(Array.isArray(whyItMatters) && whyItMatters.length >= 1, 'whyItMatters must have at least one sentence')
for (const sentence of whyItMatters) {
  assert.ok(typeof sentence === 'string' && sentence.trim().length > 0, 'each whyItMatters entry must be a non-empty sentence')
}
assert.ok(whyItMatters.length <= 5, 'whyItMatters must return at most 5 sentences')

// ─── 3. buildRadarTimeline — real fixture (has >= 2 price chart points) ───
const timeline = buildRadarTimeline(realToken, realEnrichment)
assert.ok(timeline.points.length >= 2, 'timeline should have points from price chart data')
assert.ok(['up', 'flat', 'down', 'unknown'].includes(timeline.trend), 'timeline trend must be valid')
assert.ok(typeof timeline.label === 'string' && timeline.label.length > 0, 'timeline label must be non-empty')
assert.equal(timeline.trend, 'up', 'rising price chart should produce an "up" trend')

// ─── 4. buildNextFiveMinuteRead — real fixture ───
const prediction = buildRadarTimeline ? buildNextFiveMinuteRead(realToken, realEnrichment) : null
assert.ok(VALID_CATEGORIES.has(prediction.category), `prediction category must be valid, got ${prediction.category}`)
assert.ok(typeof prediction.explanation === 'string' && prediction.explanation.length > 0, 'prediction explanation must be non-empty')

// ─── 5. Minimal/empty-evidence fixture — must never crash, always valid fallback output ───
const emptyToken = { contract: '0xempty1234567890abc1234567890abc1234567890' }
const emptyEnrichment = {}

const emptySignals = buildRadarSignals(emptyToken, emptyEnrichment)
assert.ok(Array.isArray(emptySignals) && emptySignals.length > 0, 'signals must never be empty, even with no evidence')
for (const s of emptySignals) {
  assert.ok(typeof s.label === 'string' && s.label.length > 0)
  assert.ok(VALID_SEVERITIES.has(s.severity))
  assert.ok(typeof s.reason === 'string' && s.reason.length > 0)
}

const emptyWhyItMatters = buildWhyItMatters(emptyToken, emptyEnrichment)
assert.ok(Array.isArray(emptyWhyItMatters) && emptyWhyItMatters.length >= 1)
for (const sentence of emptyWhyItMatters) {
  assert.ok(typeof sentence === 'string' && sentence.trim().length > 0)
}

const emptyTimeline = buildRadarTimeline(emptyToken, emptyEnrichment)
assert.deepEqual(emptyTimeline, { points: [], trend: 'unknown', label: 'Limited timeline data — pool is still forming.' })

const emptyPrediction = buildNextFiveMinuteRead(emptyToken, emptyEnrichment)
assert.ok(VALID_CATEGORIES.has(emptyPrediction.category))
assert.ok(typeof emptyPrediction.explanation === 'string' && emptyPrediction.explanation.length > 0)

// ─── 6. No-args / fully missing data must also never crash ───
assert.doesNotThrow(() => buildRadarSignals(null, null))
assert.doesNotThrow(() => buildWhyItMatters(undefined, undefined))
assert.doesNotThrow(() => buildRadarTimeline(null, undefined))
assert.doesNotThrow(() => buildNextFiveMinuteRead(undefined, null))

console.log('base radar signals tests passed')
