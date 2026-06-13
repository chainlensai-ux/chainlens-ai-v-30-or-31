import assert from 'node:assert/strict'
import { getRadarValuationBasis } from '../lib/baseRadarValuation.ts'
import {
  getRadarValuationEvidence,
  getRadarSocialsEvidence,
  getRadarOwnershipEvidence,
  getRadarPastLaunchesEvidence,
  getRadarRugHistoryEvidence,
} from '../lib/baseRadarEvidence.ts'

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

console.log('base radar evidence tests passed')
