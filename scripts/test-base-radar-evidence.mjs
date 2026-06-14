import assert from 'node:assert/strict'
import { getRadarValuationBasis } from '../lib/baseRadarValuation.ts'
import {
  getRadarValuationEvidence,
  getRadarSocialsEvidence,
  getRadarOwnershipEvidence,
  getRadarPastLaunchesEvidence,
  getRadarRugHistoryEvidence,
  getRadarSimulationEvidence,
  getRadarAgeEvidence,
  getRadarLpPositionEvidence,
} from '../lib/baseRadarEvidence.ts'

const fmtUSD = (v) => {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

// ─── Item 1: valuation — marketCap null + valid FDV → single FDV-fallback item ─
const fdvFallbackValuation = getRadarValuationBasis({ marketCapUsd: null, marketCapStatus: null, fdvUsd: 50_000, liquidityUsd: 10_000 })
assert.equal(fdvFallbackValuation.basis, 'fdv_fallback')
const valuationEvidence = getRadarValuationEvidence(fdvFallbackValuation)
assert.ok(valuationEvidence)
assert.equal(valuationEvidence.status, 'checked_not_found')
assert.equal(valuationEvidence.label, 'Verified market cap not returned; FDV is shown as fallback valuation.')

// Verified market cap → no valuation evidence entry at all (no gap to show)
const verifiedValuation = getRadarValuationBasis({ marketCapUsd: 1_000_000, marketCapStatus: 'verified', fdvUsd: 1_200_000, liquidityUsd: 10_000 })
assert.equal(getRadarValuationEvidence(verifiedValuation), null)

// Both MC and FDV missing/invalid → open check
const unavailableValuation = getRadarValuationBasis({ marketCapUsd: null, marketCapStatus: null, fdvUsd: null, liquidityUsd: 10_000 })
const unavailableEvidence = getRadarValuationEvidence(unavailableValuation)
assert.ok(unavailableEvidence)
assert.equal(unavailableEvidence.status, 'open_check')
assert.ok(unavailableEvidence.reason)

// ─── Item 2: socials — null socials → checked_not_found, not a lazy "missing" string ─
const socialsNone = getRadarSocialsEvidence({ website: null, twitter: null, telegram: null, status: 'unavailable_with_reason', reason: 'No social links found in any metadata provider' })
assert.equal(socialsNone.status, 'checked_not_found')
assert.equal(socialsNone.label, 'Social links checked — none found in current token/pair metadata.')
assert.ok(!/is an open check/i.test(socialsNone.label))

// socials found → links shown
const socialsFound = getRadarSocialsEvidence({ website: 'https://example.xyz', twitter: 'https://x.com/example', telegram: null, status: 'partial', reason: null })
assert.equal(socialsFound.status, 'verified')
assert.ok(socialsFound.label.includes('https://example.xyz'))
assert.ok(socialsFound.label.includes('https://x.com/example'))

// socials check never attempted (no projectSocials) → open check with specific reason
const socialsUnattempted = getRadarSocialsEvidence({ website: null, twitter: null, telegram: null, status: null, reason: null })
assert.equal(socialsUnattempted.status, 'open_check')
assert.ok(socialsUnattempted.reason && socialsUnattempted.reason.length > 0)

// ─── Item 3: ownership — active owner → risk_fact, not open_check ───────────────
const activeOwnerEvidence = getRadarOwnershipEvidence({
  ownerAddress: '0x1234567890123456789012345678901234abcd',
  adminAddress: null,
  isRenounced: false,
  ownershipVerified: true,
  ownershipStatus: 'active_owner',
})
assert.ok(activeOwnerEvidence)
assert.equal(activeOwnerEvidence.status, 'risk_fact')
assert.ok(activeOwnerEvidence.label.startsWith('Ownership/admin is active:'))
assert.ok(activeOwnerEvidence.known.includes('renounced=false'))
assert.ok(activeOwnerEvidence.known.some((k) => k.startsWith('ownershipVerified=')))

// renounced ownership → no evidence entry (not an open check, not a risk fact)
const renouncedOwnerEvidence = getRadarOwnershipEvidence({
  ownerAddress: null,
  adminAddress: null,
  isRenounced: true,
  ownershipVerified: true,
  ownershipStatus: 'renounced',
})
assert.equal(renouncedOwnerEvidence, null)

// ─── Item 4: deployer past launches ─────────────────────────────────────────────
const deployerAddress = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'

// deployerAddress present, pastLaunches null (unavailable) → open check with specific reason
const pastLaunchesUnavailable = getRadarPastLaunchesEvidence({ deployerAddress, pastLaunches: null })
assert.equal(pastLaunchesUnavailable.status, 'open_check')
assert.ok(/open check —/.test(pastLaunchesUnavailable.label))
assert.ok(!pastLaunchesUnavailable.label.endsWith('is an open check.'))

// deployerAddress present, checked, none found
const pastLaunchesNone = getRadarPastLaunchesEvidence({ deployerAddress, pastLaunches: { status: 'checked', count: 0, sample: [], reason: null } })
assert.equal(pastLaunchesNone.status, 'checked_not_found')
assert.equal(pastLaunchesNone.label, 'Past launches checked — none found in current evidence.')

// deployerAddress present, checked, some found
const pastLaunchesFound = getRadarPastLaunchesEvidence({ deployerAddress, pastLaunches: { status: 'checked', count: 2, sample: ['0x1111111111111111111111111111111111111a'], reason: null } })
assert.equal(pastLaunchesFound.status, 'verified')
assert.ok(pastLaunchesFound.label.includes('2 linked wallets/contracts'))

// no deployerAddress → open check
const pastLaunchesNoDeployer = getRadarPastLaunchesEvidence({ deployerAddress: null, pastLaunches: null })
assert.equal(pastLaunchesNoDeployer.status, 'open_check')
assert.ok(pastLaunchesNoDeployer.reason)

// ─── Item 5: rug history ─────────────────────────────────────────────────────────

// deployerAddress present, rugHistoryVerified null → open check with specific reason
const rugHistoryUnavailable = getRadarRugHistoryEvidence({ deployerAddress, rugHistory: null })
assert.equal(rugHistoryUnavailable.status, 'open_check')
assert.ok(/open check —/.test(rugHistoryUnavailable.label))
assert.ok(!rugHistoryUnavailable.label.endsWith('is an open check.'))

// deployerAddress present, checked, none found
const rugHistoryNone = getRadarRugHistoryEvidence({ deployerAddress, rugHistory: { verified: false, count: 0, reason: null } })
assert.equal(rugHistoryNone.status, 'checked_not_found')
assert.equal(rugHistoryNone.label, 'Rug history checked — no confirmed prior rug pattern found in current evidence.')

// deployerAddress present, flagged
const rugHistoryFlagged = getRadarRugHistoryEvidence({ deployerAddress, rugHistory: { verified: true, count: 3, reason: null } })
assert.equal(rugHistoryFlagged.status, 'risk_fact')
assert.ok(rugHistoryFlagged.label.includes('3 linked wallet/cluster patterns'))

// no deployerAddress → open check
const rugHistoryNoDeployer = getRadarRugHistoryEvidence({ deployerAddress: null, rugHistory: null })
assert.equal(rugHistoryNoDeployer.status, 'open_check')
assert.ok(rugHistoryNoDeployer.reason)

// ─── Item 6: simulation — timeout → specific reason + tax/honeypot not confirmed ─
const simTimeout = getRadarSimulationEvidence({ status: 'open_check', reason: 'timeout' })
assert.ok(simTimeout)
assert.equal(simTimeout.status, 'open_check')
assert.ok(/timed out/i.test(simTimeout.label))
assert.ok(/tax and honeypot status are not confirmed/i.test(simTimeout.label))
assert.ok(!/remains open check because/i.test(simTimeout.label))

// simulation unsupported pool model → specific reason
const simUnsupported = getRadarSimulationEvidence({ status: 'open_check', reason: 'unsupported pool model' })
assert.ok(simUnsupported)
assert.ok(/unsupported pool model/i.test(simUnsupported.label))

// simulation missing pair address → specific reason
const simMissingPair = getRadarSimulationEvidence({ status: 'open_check', reason: 'missing pair address' })
assert.ok(simMissingPair)
assert.ok(/missing pair address/i.test(simMissingPair.label))

// simulation passed → no evidence gap
assert.equal(getRadarSimulationEvidence({ status: 'passed', reason: null }), null)

// ─── Item 7: age — token under 15 minutes is a verified risk fact ──────────────
const veryNewEvidence = getRadarAgeEvidence({ ageMinutes: 7 })
assert.ok(veryNewEvidence)
assert.equal(veryNewEvidence.status, 'risk_fact')
assert.ok(/very new/i.test(veryNewEvidence.label))
assert.ok(/7 minute/.test(veryNewEvidence.label))

// token older than 15 minutes → no age evidence entry
assert.equal(getRadarAgeEvidence({ ageMinutes: 45 }), null)
assert.equal(getRadarAgeEvidence({ ageMinutes: null }), null)

// ─── Item 8: LP position — concentrated pools show "Position verification required"
// with pool ID/dex/liquidity facts, not a generic open check ────────────────────
const lpConcentrated = getRadarLpPositionEvidence({
  isConcentrated: true,
  poolId: '0xpool1234567890123456789012345678901234ab',
  dex: 'Uniswap V3',
  liquidityUsd: 42_000,
  fmtUSD,
})
assert.ok(lpConcentrated)
assert.equal(lpConcentrated.status, 'open_check')
assert.ok(lpConcentrated.label.startsWith('Position verification required'))
assert.ok(lpConcentrated.label.includes('Uniswap V3'))
assert.ok(lpConcentrated.label.includes('$42.0K'))
assert.ok(!/^Open check/i.test(lpConcentrated.label))

// non-concentrated pools → no LP position evidence entry
assert.equal(getRadarLpPositionEvidence({ isConcentrated: false, poolId: null, dex: null, liquidityUsd: null, fmtUSD }), null)

console.log('base radar evidence tests passed')
