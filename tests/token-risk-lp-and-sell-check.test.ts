// Fix 3: concentrated-liquidity (V3/V4) LP risk follows the position-ownership proof, never a blanket
// "protocol-managed" verified signal. Fix 4: "low visible risk" needs a sell check.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  classifyConcentratedLpRisk, applySellCheckLabelFloor, sellCheckRan, NO_SELL_CHECK_OPEN_CHECK, LP_POSITION_DOMINANT_SHARE_PCT,
} from '../lib/server/tokenRiskLpAndSellCheck.ts'

const proof = (ownershipStatus: string, topPositionSharePercent: number | null = 100) =>
  ({ ownershipStatus, topPositionSharePercent }) as Parameters<typeof classifyConcentratedLpRisk>[0]['proof']
const cl = (p: ReturnType<typeof proof> | null, lpState = 'concentrated_liquidity') => classifyConcentratedLpRisk({ lpState, proof: p })

test('V4 position owned by a single wallet (dominant) scores like team-controlled LP: +28 driver, no verified signal', () => {
  const r = cl(proof('ownership_verified_team', 92.5))
  assert.deepEqual([r.kind, r.scoreDelta, r.verifiedSignal, r.lpProofStatus, r.lpEvidenceMissing], ['team_dominant', 28, null, 'partial', false])
  assert.match(r.riskDriver!, /single wallet \(92\.5% of pool liquidity\)/)
})

test('team wallet owning a minority position is a smaller driver', () => {
  const r = cl(proof('ownership_verified_team', LP_POSITION_DOMINANT_SHARE_PCT - 1))
  assert.deepEqual([r.kind, r.scoreDelta], ['team_minority', 10])
  assert.ok(r.riskDriver)
})

test('unproven ownership (open check / unavailable / no proof) is an open check, never a positive signal', () => {
  for (const p of [proof('ownership_open_check', null), proof('ownership_unavailable_with_reason', null), null]) {
    const r = cl(p)
    assert.deepEqual([r.kind, r.scoreDelta, r.verifiedSignal, r.lpProofStatus, r.lpEvidenceMissing], ['ownership_unproven', 10, null, 'inferred', true])
    assert.match(r.openCheck!, /ownership not proven/)
  }
})

test('burned / locked dominant position is a verified signal (-12); a minority burn/lock is not', () => {
  assert.deepEqual([cl(proof('ownership_verified_burned', 80)).kind, cl(proof('ownership_verified_burned', 80)).scoreDelta], ['burned_or_locked', -12])
  assert.equal(cl(proof('ownership_verified_locked', 60)).lpProofStatus, 'verified')
  const minority = cl(proof('ownership_verified_locked', 10))
  assert.deepEqual([minority.kind, minority.scoreDelta, minority.verifiedSignal], ['controller_unproven', 5, null])
})

test('contract / multisig owners are resolved but not proven locked → open check', () => {
  for (const s of ['ownership_verified_contract', 'ownership_verified_multisig', 'ownership_verified']) {
    const r = cl(proof(s, 90))
    assert.deepEqual([r.kind, r.scoreDelta, r.verifiedSignal], ['controller_unproven', 5, null])
    assert.ok(r.openCheck)
  }
})

test('protocol-owned positions and plain protocol pools keep the existing +3 protocol treatment', () => {
  const owned = cl(proof('ownership_verified_protocol', 99))
  assert.deepEqual([owned.kind, owned.scoreDelta, owned.lpProofStatus], ['protocol', 3, 'not_applicable'])
  assert.equal(cl(null, 'protocol').kind, 'protocol')
})

test('sell check: a provider result or a sellable/blocked verdict counts; unavailable/unsupported does not', () => {
  assert.equal(sellCheckRan({ ok: true, honeypot: null }), true)
  assert.equal(sellCheckRan({ ok: false, honeypot: false }), true, 'Robinhood sim sellable')
  assert.equal(sellCheckRan({ ok: false, honeypot: true }), true, 'Robinhood sim blocked')
  assert.equal(sellCheckRan({ ok: false, honeypot: null }), false, 'unsupported V4 / timeout / unavailable')
})

test('"low visible risk" without a sell check is floored to "watch"; other labels and checked scans are unchanged', () => {
  assert.deepEqual(applySellCheckLabelFloor('low_visible_risk', false), { label: 'watch', floored: true })
  assert.deepEqual(applySellCheckLabelFloor('low_visible_risk', true), { label: 'low_visible_risk', floored: false })
  for (const l of ['watch', 'high', 'critical', 'partial_data']) assert.deepEqual(applySellCheckLabelFloor(l, false), { label: l, floored: false })
})

test('audit scenario: V4 token, deployer-owned position, no sell check, clean holders, renounced → no longer "low visible risk"', () => {
  // Same arithmetic as the route: base 35, holders verified (-5), renounced (-6), unsupported sim open check (+8).
  const base = 35 - 5 - 6 + 8
  const before = base + 3 // old blanket "protocol-managed" +3
  assert.ok(before < 40, 'old score sat in the low band')
  const lp = cl(proof('ownership_verified_team', 100))
  const after = base + lp.scoreDelta
  assert.ok(after >= 40, `new score ${after} leaves the low band`)
  // Even an unproven-ownership V4 pool with no sell check can no longer read low: the label floor applies.
  const unproven = base + cl(null).scoreDelta
  const label = unproven < 40 ? 'low_visible_risk' : 'watch'
  assert.equal(applySellCheckLabelFloor(label, sellCheckRan({ ok: false, honeypot: null })).label, 'watch')
})

test('route wiring: concentrated LP goes through the helper and the label floor runs before confidence', () => {
  const src = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  assert.match(src, /classifyConcentratedLpRisk\(\{ lpState, proof: concentratedPositionProof \}\)/)
  assert.doesNotMatch(src, /lpState === 'concentrated_liquidity'\) \{ riskVerifiedSignals\.push\('LP Control indicates protocol-managed/)
  assert.match(src, /applySellCheckLabelFloor\(rugRiskLabel, sellCheckRan\(hpResult\)\)[\s\S]{0,300}const riskConfidence/)
  assert.ok(NO_SELL_CHECK_OPEN_CHECK.length > 0)
})
