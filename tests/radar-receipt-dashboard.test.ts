import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildReceiptDashboard, type ReceiptDashboardInput } from '../lib/radarReceiptDashboard'

function input(over: Partial<ReceiptDashboardInput> = {}): ReceiptDashboardInput {
  return {
    enrichmentLoading: false,
    score: 47, verdictLabel: 'Moderate', verdictTone: 'amber',
    evidenceQualityLabel: 'Limited Evidence', evidenceQualityTone: 'risk',
    openCheckCount: 6, riskFactCount: 0,
    mainConcern: 'No verified lock/burn proof for the primary LP position.',
    positiveSignal: null, liquidityUsdLabel: '$182.4K',
    lp: { applicability: 'applicable', lockStatus: 'unverified', proofStatus: 'missing', burnProofLabel: 'No burn proof', controlStatus: null, secondaryTeamControlled: false },
    simulation: { status: 'open_check', reason: 'provider_unavailable', isHoneypot: null, buyTax: null, sellTax: null },
    socials: { status: 'checked_not_found', linkCount: 0 },
    ownership: { status: 'open_check' },
    deployerKnown: false,
    holders: { concentrationStatus: 'unavailable', concentrationRisk: 'Unknown', top10Pct: null },
    cluster: { confirmed: true, linkedWallets: 15, supplyPct: 22.4 },
    ...over,
  }
}
const check = (d: ReturnType<typeof buildReceiptDashboard>, id: string) => d.checks.find(c => c.id === id)!

test('the example from the brief: grouped statuses instead of four repeated sentences', () => {
  const d = buildReceiptDashboard(input())
  assert.deepEqual([check(d, 'lp_lock').value, check(d, 'lp_lock').status], ['Unverified', 'warning'])
  assert.deepEqual([check(d, 'lp_burn').value, check(d, 'lp_burn').status], ['Unverified', 'warning'])
  assert.deepEqual([check(d, 'simulation').value, check(d, 'simulation').status], ['Unsupported', 'unavailable'])
  assert.deepEqual([check(d, 'honeypot').value, check(d, 'honeypot').status], ['Unknown', 'unknown'])
  assert.deepEqual([check(d, 'socials').value, check(d, 'socials').status], ['Missing', 'warning'])
  assert.deepEqual(d.heroChips.map(c => c.label), ['LP lock unverified', 'No socials', '15 linked wallets', 'Simulation unsupported'])
})

test('nothing is ever upgraded to confirmed without positive evidence', () => {
  const d = buildReceiptDashboard(input({
    lp: { applicability: null, lockStatus: null, proofStatus: null, burnProofLabel: null, controlStatus: null, secondaryTeamControlled: false },
    simulation: { status: null, reason: null, isHoneypot: null, buyTax: null, sellTax: null },
    socials: { status: 'open_check', linkCount: 0 },
    cluster: { confirmed: false, linkedWallets: 0, supplyPct: null },
  }))
  assert.equal(d.checks.filter(c => c.status === 'confirmed').length, 0)
  assert.equal(check(d, 'cluster').value, 'None confirmed', 'no cluster link found is not proof of no cluster')
  assert.equal(check(d, 'cluster').status, 'unknown')
  assert.equal(check(d, 'socials').status, 'unknown', 'socials never checked ≠ missing')
  assert.equal(d.summary.confidence.confirmed, 0)
})

test('real positive evidence is shown as confirmed', () => {
  const d = buildReceiptDashboard(input({
    lp: { applicability: 'applicable', lockStatus: 'burned', proofStatus: 'confirmed', burnProofLabel: 'Burned', controlStatus: 'burned', secondaryTeamControlled: false },
    simulation: { status: 'passed', reason: null, isHoneypot: false, buyTax: 0, sellTax: 1.5 },
    socials: { status: 'verified', linkCount: 2 },
    ownership: { status: 'renounced' },
    deployerKnown: true,
    holders: { concentrationStatus: 'resolved', concentrationRisk: 'Low', top10Pct: 18 },
    cluster: { confirmed: false, linkedWallets: 0, supplyPct: null },
    positiveSignal: 'Market Cap Verified',
  }))
  for (const id of ['lp_lock', 'lp_burn', 'lp_control', 'simulation', 'honeypot', 'socials', 'ownership', 'deployer', 'holders']) {
    assert.equal(check(d, id).status, 'confirmed', id)
  }
  assert.equal(check(d, 'honeypot').value, 'B 0.0% · S 1.5%')
  assert.ok(d.heroChips.some(c => c.label === 'Market Cap Verified' && c.status === 'confirmed'))
  assert.equal(d.findings.find(f => f.id === 'trading')!.status, 'confirmed')
})

test('pool-managed (concentrated) LP is not presented as safe', () => {
  const d = buildReceiptDashboard(input({ lp: { applicability: 'not_applicable', lockStatus: null, proofStatus: null, burnProofLabel: null, controlStatus: 'concentrated_liquidity', secondaryTeamControlled: false } }))
  assert.equal(check(d, 'lp_lock').status, 'unavailable')
  assert.equal(check(d, 'lp_lock').value, 'Not applicable')
  assert.equal(check(d, 'lp_control').status, 'unavailable')
  assert.notEqual(d.findings.find(f => f.id === 'liquidity')!.status, 'confirmed')
})

test('honeypot and high tax are warnings; tax is only shown after a passed simulation', () => {
  assert.equal(check(buildReceiptDashboard(input({ simulation: { status: 'passed', reason: null, isHoneypot: true, buyTax: 0, sellTax: 99 } })), 'honeypot').status, 'warning')
  const high = buildReceiptDashboard(input({ simulation: { status: 'passed', reason: null, isHoneypot: false, buyTax: 4, sellTax: 25 } }))
  assert.equal(check(high, 'honeypot').status, 'warning')
  assert.ok(high.heroChips.some(c => c.label === 'High tax'))
  const unconfirmed = buildReceiptDashboard(input({ simulation: { status: 'open_check', reason: 'timeout_after_retry', isHoneypot: false, buyTax: 0, sellTax: 0 } }))
  assert.equal(check(unconfirmed, 'honeypot').status, 'unknown', 'taxes from an unconfirmed simulation are not presented')
  assert.equal(check(unconfirmed, 'simulation').value, 'Pending')
})

test('loading enrichment shows "Checking", never "Unknown" or a fake verdict', () => {
  const d = buildReceiptDashboard(input({ enrichmentLoading: true }))
  for (const id of ['lp_lock', 'lp_burn', 'lp_control', 'socials', 'ownership', 'deployer', 'holders', 'cluster']) {
    assert.equal(check(d, id).status, 'loading', id)
  }
  assert.ok(d.heroChips.every(c => c.status !== 'loading'))
  assert.equal(d.summary.confidence.confirmed + d.summary.confidence.warning + d.summary.confidence.unresolved, 2, 'ring counts only resolved feed checks while loading')
})

test('hero chips: warnings lead, max 5, no duplicates', () => {
  const d = buildReceiptDashboard(input({
    ownership: { status: 'active_owner' },
    holders: { concentrationStatus: 'resolved', concentrationRisk: 'Extreme', top10Pct: 91 },
    lp: { applicability: 'applicable', lockStatus: 'unverified', proofStatus: 'missing', burnProofLabel: null, controlStatus: 'team_controlled', secondaryTeamControlled: true },
  }))
  assert.ok(d.heroChips.length <= 5)
  assert.equal(new Set(d.heroChips.map(c => c.label)).size, d.heroChips.length)
  const firstNonWarning = d.heroChips.findIndex(c => c.status !== 'warning')
  assert.ok(firstNonWarning === -1 || d.heroChips.slice(firstNonWarning).every(c => c.status !== 'warning'))
})

test('findings take the worst status of their checks; summary counts are consistent', () => {
  const d = buildReceiptDashboard(input())
  assert.equal(d.findings.length, 4)
  assert.equal(d.findings.find(f => f.id === 'control')!.status, 'warning')
  assert.match(d.findings.find(f => f.id === 'control')!.summary, /Linked-wallet cluster confirmed holding 22%/)
  assert.equal(d.findings.find(f => f.id === 'liquidity')!.metric, '$182.4K liquidity')
  const c = d.summary.confidence
  assert.equal(c.confirmed + c.warning + c.unresolved, d.checks.length)
  assert.equal(d.summary.openChecks.count, 6, 'open-check count is the drawer\'s own evidence-gap count')
  assert.equal(d.summary.mainConcern.tone, 'risk')
})

test('actions follow the evidence; Token Scanner and Watchlist are always available', () => {
  const risky = buildReceiptDashboard(input({ holders: { concentrationStatus: 'resolved', concentrationRisk: 'High', top10Pct: 70 } }))
  assert.deepEqual(risky.actions.map(a => a.id), ['verify_lp', 'watch_holders', 'scanner', 'watchlist'])
  assert.equal(risky.actions.filter(a => a.emphasis).length, 1)
  const clean = buildReceiptDashboard(input({
    lp: { applicability: 'applicable', lockStatus: 'locked', proofStatus: 'confirmed', burnProofLabel: null, controlStatus: 'locked', secondaryTeamControlled: false },
    cluster: { confirmed: false, linkedWallets: 0, supplyPct: null },
  }))
  assert.deepEqual(clean.actions.map(a => a.id), ['scanner', 'watchlist'])
  assert.equal(clean.actions[0].emphasis, true)
})

test('wiring: the drawer renders the dashboard in hierarchy order and keeps every long-form line in Evidence notes', () => {
  const src = readFileSync(new URL('../app/terminal/base-radar/ProjectOverviewDrawer.tsx', import.meta.url), 'utf8')
  const order = ['<ReceiptSummaryStrip', '<ReceiptFindings', '<ReceiptChecksMatrix', '<ReceiptActions', 'title="Market Snapshot"', 'id="notes"']
  const at = order.map(x => src.indexOf(x))
  assert.ok(at.every(i => i > 0), JSON.stringify(at))
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'risk → why → missing → next → market → notes')
  for (const kept of ['dedupedRiskFacts', 'dedupedEvidenceGaps', 'dedupedWatchNext', '<WhyItMattersBox sentences={whyItMatters} />', 'Primary risk: ${cortexMainRisk}']) {
    assert.ok(src.includes(kept), `${kept} still rendered`)
  }
  assert.match(src, /return sectionOverrides\[id\] \?\? id !== 'notes'/, 'only the notes group defaults closed')
})
