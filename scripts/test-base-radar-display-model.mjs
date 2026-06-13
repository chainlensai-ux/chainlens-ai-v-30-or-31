import assert from 'node:assert/strict'
import { buildBaseRadarDisplayModel } from '../lib/baseRadarDisplayModel.ts'

const verifiedFeed = { name: 'Alpha', symbol: 'ALP', contract: '0x0000000000000000000000000000000000000001', ageMinutes: 12, liquidityUsd: 20000, volume24h: 9000, marketCapStatus: 'verified', valuationBasis: 'verified_market_cap', marketCapUsd: 250000, valuationVerified: true, fdvUsd: 260000, simulationStatus: 'open_check', simulationReason: 'provider_unavailable', honeypot: null }

// A) feed token verified MC + drawer enrichment null => drawer keeps verified MC.
const feedModel = buildBaseRadarDisplayModel(verifiedFeed)
const drawerModel = buildBaseRadarDisplayModel(verifiedFeed, null)
assert.equal(drawerModel.valuation.label, 'Market Cap')
assert.equal(drawerModel.valuation.status, 'verified')
assert.equal(drawerModel.valuation.valueUsd, 250000)

// B) feed score and drawer score use same final score model.
assert.equal(feedModel.score, drawerModel.score)

// C) different token evidence creates different whyOnRadar strings.
const highVolume = buildBaseRadarDisplayModel({ ...verifiedFeed, symbol: 'VOL', volume24h: 50000, liquidityUsd: 100000, simulationStatus: 'passed', honeypot: { simulationSuccess: true, buyTax: 0, sellTax: 0 } })
const thin = buildBaseRadarDisplayModel({ ...verifiedFeed, symbol: 'THIN', marketCapUsd: null, marketCapStatus: 'unavailable', valuationBasis: 'fdv_fallback', valuationVerified: false, fdvUsd: 20000, liquidityUsd: 1000, volume24h: 200, ageMinutes: 200, simulationStatus: 'passed', honeypot: { simulationSuccess: true, buyTax: 0, sellTax: 0 } })
assert.notEqual(highVolume.whyOnRadar, thin.whyOnRadar)

// D) unresolved tokens do not all collapse to 49 unless final formula returns 49.
const unresolvedScores = [
  buildBaseRadarDisplayModel({ ...verifiedFeed, liquidityUsd: 4000, volume24h: 500, ageMinutes: 4, marketCapUsd: null, marketCapStatus: 'unavailable', valuationVerified: false, fdvUsd: 30000, simulationReason: 'timeout_after_retry' }).score,
  buildBaseRadarDisplayModel({ ...verifiedFeed, liquidityUsd: 12000, volume24h: 8000, ageMinutes: 12, simulationReason: 'unsupported_pool_model' }).score,
  buildBaseRadarDisplayModel({ ...verifiedFeed, liquidityUsd: 25000, volume24h: 18000, ageMinutes: 28, simulationReason: 'provider_unavailable' }).score,
]
assert.ok(new Set(unresolvedScores).size > 1 && !unresolvedScores.every((s) => s === 49), unresolvedScores)

// E) simulation label is consistent between card and drawer.
assert.equal(feedModel.simulation.label, drawerModel.simulation.label)

// F) FDV fallback warning only appears when final valuation status is fdv_fallback.
assert.equal(feedModel.valuation.warning, null)
assert.equal(thin.valuation.status, 'fdv_fallback')
assert.ok(thin.valuation.warning)
const open = buildBaseRadarDisplayModel({ ...verifiedFeed, marketCapUsd: null, marketCapStatus: 'unavailable', valuationVerified: false, fdvUsd: null })
assert.equal(open.valuation.status, 'open_check')
assert.equal(open.valuation.warning, null)

console.log('base radar display model tests passed')
