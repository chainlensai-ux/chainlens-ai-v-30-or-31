import assert from 'node:assert/strict'
import { getRadarValuationBasis, getRadarValuationCardDisplay, getRadarValuationDrawerDisplay, getRadarCortexValuationLine, getRadarValuationEvidenceGap, tokenPassesRadarValuationFilters, resolveFallbackMarketCap, resolveBaseRadarMarketCap, selectDexScreenerMarketCapRescuePair, DEFAULT_RADAR_MIN_LIQUIDITY_USD } from '../lib/baseRadarValuation.ts'

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
assert.equal(getRadarValuationEvidenceGap(fdvOnly), 'Verified market cap not returned; FDV is shown as fallback valuation.')
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

assert.equal(dexFixture1.marketCapFieldPath, 'dexPair.marketCap')

const dexInfoFixture = resolveBaseRadarMarketCap({ dexPair: { info: { marketCap: '654321' }, fdv: 1 } })
assert.equal(dexInfoFixture.marketCapUsd, 654321)
assert.equal(dexInfoFixture.marketCapStatus, 'verified')
assert.equal(dexInfoFixture.marketCapFieldPath, 'dexPair.info.marketCap')

// ─── resolveBaseRadarMarketCap: DexScreener marketCapUsd field ────────────
const dexFixture2 = resolveBaseRadarMarketCap({ dexPair: { marketCapUsd: 123456 } })
assert.equal(dexFixture2.marketCapUsd, 123456)
assert.equal(dexFixture2.marketCapStatus, 'verified')
assert.equal(dexFixture2.marketCapFieldPath, 'dexPair.marketCapUsd')

// ─── resolveBaseRadarMarketCap: GeckoTerminal pool attributes fixture ─────
const geckoFixture = resolveBaseRadarMarketCap({ geckoPool: { attributes: { market_cap_usd: '123456', fdv_usd: '120000', reserve_in_usd: '30000' } } })
assert.equal(geckoFixture.marketCapUsd, 123456)
assert.equal(geckoFixture.marketCapStatus, 'verified')
assert.equal(geckoFixture.marketCapFieldPath, 'geckoPool.attributes.market_cap_usd')

const geckoIncludedFixture = resolveBaseRadarMarketCap({ geckoIncludedToken: { attributes: { market_cap_usd: '777777' } } })
assert.equal(geckoIncludedFixture.marketCapUsd, 777777)
assert.equal(geckoIncludedFixture.marketCapStatus, 'verified')
assert.equal(geckoIncludedFixture.marketCapFieldPath, 'geckoIncludedToken.attributes.market_cap_usd')

const normalizedFixture = resolveBaseRadarMarketCap({ normalized: { marketCapUsd: 888888 } })
assert.equal(normalizedFixture.marketCapUsd, 888888)
assert.equal(normalizedFixture.marketCapFieldPath, 'normalized.marketCapUsd')

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

// ─── Fjorn fixture: impossible FDV rejected despite liquidity ─────────────
const fjornFixture = getRadarValuationBasis({ marketCapUsd: null, marketCapStatus: 'unavailable', fdvUsd: 0.017, liquidityUsd: 31_070 })
assert.equal(fjornFixture.basis, 'unavailable')
assert.equal(fjornFixture.valueUsd, null)
assert.equal(fjornFixture.reason, 'FDV VALUE FAILED SANITY CHECK')

// ─── Route-level public/debug shape regression from raw MC resolver output ─
const routeResolved = resolveBaseRadarMarketCap({ dexPair: { marketCapUsd: 222222 } })
const routeValuation = getRadarValuationBasis({ marketCapUsd: routeResolved.marketCapUsd, marketCapStatus: routeResolved.marketCapStatus, fdvUsd: 1, liquidityUsd: 5_000 })
const publicMarket = {
  marketCapUsd: routeResolved.marketCapUsd,
  marketCapStatus: routeResolved.marketCapStatus,
  valuationBasis: routeValuation.basis,
  marketCapDiagnostics: {
    selectedMarketCapUsd: routeResolved.marketCapUsd,
    selectedMarketCapStatus: routeResolved.marketCapStatus,
    selectedMarketCapFieldPath: routeResolved.marketCapFieldPath,
    selectedValuationBasis: routeValuation.basis,
    fdvUsd: 1,
    rawCandidates: routeResolved.rawCandidates,
    resolverReason: routeResolved.reason,
  },
}
assert.equal(publicMarket.marketCapUsd, 222222)
assert.equal(publicMarket.marketCapStatus, 'verified')
assert.equal(publicMarket.marketCapDiagnostics.selectedMarketCapFieldPath, 'dexPair.marketCapUsd')

// ─── Dex rescue: resolver has no MC, rescue pair has explicit marketCap ───
const noPrimaryMc = resolveBaseRadarMarketCap({ normalized: { marketCapUsd: null } })
const rescueMc = selectDexScreenerMarketCapRescuePair({
  chain: 'base',
  pairs: [{ chainId: 'base', pairAddress: '0xpair1', dexId: 'uniswap', liquidity: { usd: 25_000 }, marketCap: 123456, fdv: 130000 }],
})
const rescueValuation = getRadarValuationBasis({
  marketCapUsd: noPrimaryMc.marketCapUsd ?? rescueMc.marketCapUsd,
  marketCapStatus: rescueMc.marketCapStatus,
  fdvUsd: 130_000,
  liquidityUsd: 25_000,
})
assert.equal(rescueMc.marketCapUsd, 123456)
assert.equal(rescueMc.marketCapStatus, 'verified')
assert.equal(rescueMc.marketCapFieldPath, 'dexPair[0xpair1].marketCapRescue.marketCap')
assert.equal(rescueValuation.basis, 'verified_market_cap')

// ─── Dex rescue: multiple pairs; highest-liquidity active pair with MC wins ─
const rescueMulti = selectDexScreenerMarketCapRescuePair({
  chain: 'base',
  pairs: [
    { chainId: 'base', pairAddress: '0xlow', dexId: 'dex-a', liquidity: { usd: 10_000 }, marketCap: 111 },
    { chainId: 'base', pairAddress: '0xzero', dexId: 'dex-b', liquidity: { usd: 0 }, marketCap: 999 },
    { chainId: 'ethereum', pairAddress: '0xeth', dexId: 'dex-c', liquidity: { usd: 1_000_000 }, marketCap: 888 },
    { chainId: 'base', pairAddress: '0xhigh', dexId: 'dex-d', liquidity: { usd: 99_000 }, info: { marketCapUsd: '777777' } },
  ],
})
assert.equal(rescueMulti.marketCapUsd, 777777)
assert.equal(rescueMulti.selectedPairAddress, '0xhigh')
assert.equal(rescueMulti.selectedDexId, 'dex-d')
assert.equal(rescueMulti.selectedLiquidityUsd, 99_000)
assert.equal(rescueMulti.marketCapFieldPath, 'dexPair[0xhigh].marketCapRescue.info.marketCapUsd')

// ─── Dex rescue: no MC + valid FDV remains FDV fallback ───────────────────
const rescueNoMc = selectDexScreenerMarketCapRescuePair({
  chain: 'base',
  pairs: [{ chainId: 'base', pairAddress: '0xfdv', liquidity: { usd: 12_000 }, fdv: 44_000 }],
})
const rescueFdvFallback = getRadarValuationBasis({ marketCapUsd: rescueNoMc.marketCapUsd, marketCapStatus: rescueNoMc.marketCapStatus, fdvUsd: 44_000, liquidityUsd: 12_000 })
assert.equal(rescueNoMc.marketCapUsd, null)
assert.equal(rescueFdvFallback.basis, 'fdv_fallback')

// ─── Dex rescue: no MC + invalid FDV remains open check ───────────────────
const rescueInvalidFdv = getRadarValuationBasis({ marketCapUsd: rescueNoMc.marketCapUsd, marketCapStatus: rescueNoMc.marketCapStatus, fdvUsd: 1, liquidityUsd: 12_000 })
assert.equal(rescueInvalidFdv.basis, 'unavailable')
assert.equal(rescueInvalidFdv.valueUsd, null)

// ─── Debug diagnostics include rescue flags and selected field path ───────
const rescueDebug = {
  selectedMarketCapUsd: rescueMc.marketCapUsd,
  selectedMarketCapStatus: rescueMc.marketCapStatus,
  selectedMarketCapFieldPath: rescueMc.marketCapFieldPath,
  selectedValuationBasis: rescueValuation.basis,
  resolverReason: rescueMc.reason,
  rescueAttempted: true,
  rescueCacheHit: false,
  rescuePairCount: rescueMc.pairCount,
  rescueSelectedPairAddress: rescueMc.selectedPairAddress,
  rescueSelectedDexId: rescueMc.selectedDexId,
  rescueSelectedLiquidityUsd: rescueMc.selectedLiquidityUsd,
  rescueRawCandidates: rescueMc.rawCandidates,
}
assert.equal(rescueDebug.rescueAttempted, true)
assert.equal(rescueDebug.selectedMarketCapFieldPath, 'dexPair[0xpair1].marketCapRescue.marketCap')
assert.ok(rescueDebug.rescueRawCandidates.some(candidate => candidate.path === 'dexPair[0xpair1].marketCapRescue.marketCap' && candidate.value === 123456))

console.log('base radar valuation tests passed')
