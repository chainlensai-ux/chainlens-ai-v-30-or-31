import assert from 'node:assert/strict'
import { getRadarValuationBasis, getRadarValuationEvidenceGap, tokenPassesRadarValuationFilters } from '../lib/baseRadarValuation.ts'

const base = { liquidityUsd: 5_000 }

let result = tokenPassesRadarValuationFilters({ ...base, marketCapUsd: 20_000, marketCapStatus: 'verified', fdvUsd: null })
assert.equal(result.included, true)
assert.equal(result.valuation.basis, 'verified_market_cap')

result = tokenPassesRadarValuationFilters({ ...base, marketCapUsd: null, marketCapStatus: null, fdvUsd: 20_000 })
assert.equal(result.included, true)
assert.equal(result.valuation.basis, 'fdv_fallback')

result = tokenPassesRadarValuationFilters({ ...base, marketCapUsd: null, marketCapStatus: null, fdvUsd: 1_500 })
assert.equal(result.included, false)

result = tokenPassesRadarValuationFilters({ ...base, marketCapUsd: 10_000, marketCapStatus: 'verified', fdvUsd: null })
assert.equal(result.included, false)

result = tokenPassesRadarValuationFilters({ ...base, marketCapUsd: 20_000, marketCapStatus: 'inferred', fdvUsd: 20_000 })
assert.equal(result.included, true)
assert.equal(result.valuation.basis, 'fdv_fallback')
assert.equal(result.valuation.verified, false)

result = tokenPassesRadarValuationFilters({ liquidityUsd: 1_000, marketCapUsd: 20_000, marketCapStatus: 'verified', fdvUsd: null })
assert.equal(result.included, false)

const fdvOnly = getRadarValuationBasis({ marketCapUsd: null, marketCapStatus: null, fdvUsd: 20_000 })
assert.equal(getRadarValuationEvidenceGap(fdvOnly), 'Market cap unavailable; FDV used as fallback valuation.')
assert.equal(fdvOnly.label, 'FDV')
assert.equal(fdvOnly.verified, false)

result = tokenPassesRadarValuationFilters({ ...base, marketCapUsd: null, marketCapStatus: null, fdvUsd: 20_000, allowFdvFallback: false })
assert.equal(result.included, false)
assert.equal(result.valuation.basis, 'unavailable')

const unavailable = getRadarValuationBasis({ marketCapUsd: null, marketCapStatus: null, fdvUsd: null })
assert.equal(getRadarValuationEvidenceGap(unavailable), 'Market valuation unavailable.')

console.log('base radar valuation tests passed')
