import assert from 'node:assert/strict'
import { getRadarValuationBasis, getRadarValuationCardDisplay, getRadarValuationDrawerDisplay, getRadarCortexValuationLine, getRadarValuationEvidenceGap, tokenPassesRadarValuationFilters, resolveFallbackMarketCap, resolveBaseRadarMarketCap, DEFAULT_RADAR_MIN_LIQUIDITY_USD } from '../lib/baseRadarValuation.ts'

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

// ─── Orbit-style fixture: $2.45 liquidity, FDV $35K, marketCap null ────────
const orbitValuation = tokenPassesRadarValuationFilters({ liquidityUsd: 2.45, marketCapUsd: null, marketCapStatus: null, fdvUsd: 35_000 })
assert.equal(orbitValuation.included, false, 'Orbit must be excluded from default feed (liquidity below $5K threshold)')
assert.equal(orbitValuation.valuation.basis, 'fdv_fallback')
assert.ok(2.45 < DEFAULT_RADAR_MIN_LIQUIDITY_USD)

const orbitCard = getRadarValuationCardDisplay(orbitValuation.valuation, fmtUSD)
assert.equal(orbitCard.label, 'FDV')
assert.equal(orbitCard.sublabel, 'Market cap unavailable')
assert.notEqual(orbitCard.label, 'Market cap')

// ─── resolveFallbackMarketCap: real marketCap -> verified marketCapUsd ─────
const realMc = resolveFallbackMarketCap(48_000)
assert.equal(realMc.marketCapUsd, 48_000)
assert.equal(realMc.marketCapStatus, 'verified')

// ─── resolveFallbackMarketCap: missing marketCap -> never inferred from FDV ─
const missingMc = resolveFallbackMarketCap(null)
assert.equal(missingMc.marketCapUsd, null)
assert.equal(missingMc.marketCapStatus, null)

// ─── resolveBaseRadarMarketCap: DexScreener-style pair fixture ────────────
const dexFixture1 = resolveBaseRadarMarketCap({ dexPair: { marketCap: 123456, fdv: 120000, liquidity: { usd: 30000 } } })
assert.equal(dexFixture1.marketCapUsd, 123456)
assert.equal(dexFixture1.marketCapStatus, 'verified')
assert.equal(dexFixture1.sourceKind, 'market_api')

// ─── resolveBaseRadarMarketCap: DexScreener marketCapUsd field ────────────
const dexFixture2 = resolveBaseRadarMarketCap({ dexPair: { marketCapUsd: 123456 } })
assert.equal(dexFixture2.marketCapUsd, 123456)
assert.equal(dexFixture2.marketCapStatus, 'verified')

// ─── resolveBaseRadarMarketCap: GeckoTerminal pool attributes fixture ─────
const geckoFixture = resolveBaseRadarMarketCap({ geckoPool: { attributes: { market_cap_usd: '123456', fdv_usd: '120000', reserve_in_usd: '30000' } } })
assert.equal(geckoFixture.marketCapUsd, 123456)
assert.equal(geckoFixture.marketCapStatus, 'verified')

// ─── No market cap + valid FDV -> FDV fallback, not verified market cap ──
const noMcValidFdv = getRadarValuationBasis({ marketCapUsd: null, marketCapStatus: 'unavailable', fdvUsd: 50_000, liquidityUsd: 5_000 })
assert.equal(noMcValidFdv.basis, 'fdv_fallback')
assert.equal(noMcValidFdv.verified, false)
assert.notEqual(noMcValidFdv.basis, 'verified_market_cap')

// ─── Valid market cap + invalid FDV -> market cap still verified ─────────
const validMcInvalidFdv = getRadarValuationBasis({ marketCapUsd: 123456, marketCapStatus: 'verified', fdvUsd: 1, liquidityUsd: 5_000 })
assert.equal(validMcInvalidFdv.basis, 'verified_market_cap')
assert.equal(validMcInvalidFdv.valueUsd, 123456)
assert.equal(validMcInvalidFdv.verified, true)

// ─── Invalid FDV + no market cap -> open check + sanity-check reason ─────
const invalidFdvNoMc = getRadarValuationBasis({ marketCapUsd: null, marketCapStatus: 'unavailable', fdvUsd: 1, liquidityUsd: 5_000 })
assert.equal(invalidFdvNoMc.basis, 'unavailable')
assert.equal(invalidFdvNoMc.reason, 'FDV VALUE FAILED SANITY CHECK')

console.log('base radar valuation tests passed')
