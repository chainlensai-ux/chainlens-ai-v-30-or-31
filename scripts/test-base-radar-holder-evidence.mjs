import assert from 'node:assert/strict'
import { buildBaseRadarHolderEvidence, holderEvidenceBlocksTopTier, getHolderCountCopy, HOLDER_GATE_MIN_COUNT } from '../lib/baseRadarHolderEvidence.ts'

// exact 45 holders passes holder gate and holderVerified=true
let ev = buildBaseRadarHolderEvidence({ holderCount: 45, countIsMinimum: false, holderProviderReachable: true })
assert.equal(ev.holderCountStatus, 'exact')
assert.equal(ev.holderCountExact, 45)
assert.equal(ev.holderCountDisplay, '45')
assert.equal(ev.holderGatePassed, true)
assert.equal(ev.holderVerified, true)
assert.equal(ev.evidenceGaps.includes('exact_holder_count_unconfirmed'), false)

// minimum 100+ holders passes holder gate but holderVerified=false/partial
ev = buildBaseRadarHolderEvidence({ holderCount: 100, countIsMinimum: true, holderProviderReachable: true })
assert.equal(ev.holderCountStatus, 'minimum')
assert.equal(ev.holderCountMinimum, 100)
assert.equal(ev.holderCountDisplay, '100+')
assert.equal(ev.holderGatePassed, true)
assert.equal(ev.holderVerified, false)
assert.ok(ev.evidenceGaps.includes('exact_holder_count_unconfirmed'))

// minimum 20+ holders does not pass 30-holder gate
ev = buildBaseRadarHolderEvidence({ holderCount: 20, countIsMinimum: true, holderProviderReachable: true })
assert.equal(ev.holderGatePassed, false)
assert.equal(HOLDER_GATE_MIN_COUNT, 30)

// no holder data creates holder_provider_unreachable when the provider itself failed
ev = buildBaseRadarHolderEvidence({ holderCount: null, countIsMinimum: false, holderProviderReachable: false })
assert.equal(ev.holderCountStatus, 'unavailable')
assert.equal(ev.holderGatePassed, false)
assert.equal(ev.holderVerified, false)
assert.ok(ev.evidenceGaps.includes('holder_provider_unreachable'))

// no holder data, but the provider was reachable and simply had nothing -> holder_count_unavailable
ev = buildBaseRadarHolderEvidence({ holderCount: null, countIsMinimum: false, holderProviderReachable: true })
assert.ok(ev.evidenceGaps.includes('holder_count_unavailable'))
assert.equal(ev.evidenceGaps.includes('holder_provider_unreachable'), false)

// no top holder balances means Top 1/10/20 remain N/A (undefined), even with a real exact count
ev = buildBaseRadarHolderEvidence({ holderCount: 45, countIsMinimum: false, holderProviderReachable: true })
assert.equal(ev.concentrationStatus, 'unavailable')
assert.equal(ev.top1Percent, undefined)
assert.equal(ev.top10Percent, undefined)
assert.equal(ev.top20Percent, undefined)
assert.ok(ev.evidenceGaps.includes('holder_concentration_unavailable'))

// concentration is never inferred from minimum holder count — "100+" alone never produces top1/10/20
ev = buildBaseRadarHolderEvidence({ holderCount: 100, countIsMinimum: true, holderProviderReachable: true })
assert.equal(ev.concentrationStatus, 'unavailable')
assert.equal(ev.top1Percent, undefined)

// when real top-holder balances ARE resolved, concentration is populated from them
ev = buildBaseRadarHolderEvidence({
  holderCount: 100, countIsMinimum: true, holderProviderReachable: true,
  top1Percent: 12.5, top10Percent: 41.2, top20Percent: 58.9,
})
assert.equal(ev.concentrationStatus, 'resolved')
assert.equal(ev.top1Percent, 12.5)
assert.equal(ev.top10Percent, 41.2)
assert.equal(ev.top20Percent, 58.9)
assert.equal(ev.evidenceGaps.includes('holder_concentration_unavailable'), false)
// still not "verified" — minimum count evidence, resolved concentration is a separate fact
assert.equal(ev.holderVerified, false)

// minimum count (or unavailable concentration) cannot create a top-tier / fully-verified status
ev = buildBaseRadarHolderEvidence({ holderCount: 100, countIsMinimum: true, holderProviderReachable: true, top1Percent: 5, top10Percent: 20, top20Percent: 30 })
assert.equal(holderEvidenceBlocksTopTier(ev), true)

ev = buildBaseRadarHolderEvidence({ holderCount: 45, countIsMinimum: false, holderProviderReachable: true })
assert.equal(holderEvidenceBlocksTopTier(ev), true) // concentration still unavailable here

ev = buildBaseRadarHolderEvidence({ holderCount: 45, countIsMinimum: false, holderProviderReachable: true, top1Percent: 5, top10Percent: 20, top20Percent: 30 })
assert.equal(holderEvidenceBlocksTopTier(ev), false) // exact count + resolved concentration -> top tier allowed

// UI copy says "minimum confirmed" not "verified" for 100+
ev = buildBaseRadarHolderEvidence({ holderCount: 100, countIsMinimum: true, holderProviderReachable: true })
const copy = getHolderCountCopy(ev)
assert.ok(copy.includes('minimum confirmed'))
assert.ok(!copy.toLowerCase().startsWith('holder count verified'))

console.log('test-base-radar-holder-evidence.mjs: all assertions passed')
