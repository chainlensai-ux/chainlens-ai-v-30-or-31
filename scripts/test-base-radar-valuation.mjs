import assert from 'node:assert/strict'
import { getRadarValuationBasis, getRadarValuationCardDisplay, getRadarValuationDrawerDisplay, getRadarCortexValuationLine, getRadarValuationEvidenceGap, tokenPassesRadarValuationFilters } from '../lib/baseRadarValuation.ts'

const fmtUSD = (v) => {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

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

// ─── Card display: verified MC -> "Market cap" / Verified ─────────────────
const verifiedMc = getRadarValuationBasis({ marketCapUsd: 25_000_000, marketCapStatus: 'verified', fdvUsd: 26_000_000 })
const verifiedCard = getRadarValuationCardDisplay(verifiedMc, fmtUSD)
assert.equal(verifiedCard.label, 'Market cap')
assert.equal(verifiedCard.value, '$25.0M')
assert.equal(verifiedCard.sublabel, 'Verified')

// ─── Card display: MC missing + FDV -> "FDV" / Market cap unavailable ─────
const fdvFallback = getRadarValuationBasis({ marketCapUsd: null, marketCapStatus: null, fdvUsd: 18_000 })
const fdvCard = getRadarValuationCardDisplay(fdvFallback, fmtUSD)
assert.equal(fdvCard.label, 'FDV')
assert.equal(fdvCard.value, '$18.0K')
assert.equal(fdvCard.sublabel, 'Market cap unavailable')
assert.notEqual(fdvCard.label, 'Market cap', 'FDV fallback must never be labeled as Market cap (verified)')

// ─── Card display: nothing available -> "Valuation" / Open check ──────────
const noneCard = getRadarValuationCardDisplay(unavailable, fmtUSD)
assert.equal(noneCard.label, 'Valuation')
assert.equal(noneCard.value, 'Open check')

// ─── Drawer display: FDV fallback never marked as verified MC ─────────────
const fdvDrawer = getRadarValuationDrawerDisplay(fdvFallback, 18_000, fmtUSD)
assert.equal(fdvDrawer.marketCapValue, 'Unverified')
assert.equal(fdvDrawer.fdvValue, '$18.0K')
assert.equal(fdvDrawer.note, 'FDV shown because verified market cap is unavailable.')

// ─── Drawer display: verified MC shows real market cap, no fallback note ──
const verifiedDrawer = getRadarValuationDrawerDisplay(verifiedMc, 26_000_000, fmtUSD)
assert.equal(verifiedDrawer.marketCapValue, '$25.0M')
assert.equal(verifiedDrawer.note, null)

// ─── CORTEX wording: only fires for FDV fallback ───────────────────────────
assert.equal(getRadarCortexValuationLine(fdvFallback), 'Verified market cap is unavailable, so FDV is shown as fallback valuation.')
assert.equal(getRadarCortexValuationLine(verifiedMc), null)
assert.equal(getRadarCortexValuationLine(unavailable), null)

console.log('base radar valuation tests passed')
