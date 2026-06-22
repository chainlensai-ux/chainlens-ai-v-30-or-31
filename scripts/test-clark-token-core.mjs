#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const route = readFileSync('app/api/clark/route.ts', 'utf8')
const routing = readFileSync('lib/server/clarkRouting.ts', 'utf8')

for (const field of [
  'tokenRouteAttempted',
  'tokenRouteStatus',
  'tokenRouteDurationMs',
  'honeypotAttempted',
  'honeypotStatus',
  'honeypotDurationMs',
  'partialEvidenceUsed',
  'evidenceSectionsPresent',
  'evidenceSectionsMissing',
]) {
  assert.ok(route.includes(field), `missing debug field ${field}`)
}

for (const status of ['loaded', 'partial', 'timed_out', 'failed', 'unavailable', 'auth_failed', 'open_check']) {
  assert.ok(route.includes(`"${status}"`) || route.includes(`'${status}'`), `missing status ${status}`)
}

assert.ok(route.includes('await Promise.all([tokenFetchPromise, honeypotPromise])'), 'token and security branches must run independently')
assert.ok(route.includes('const totalFailure = tokenRouteFailed && honeypotFailed'), 'total timeout/failure only when all evidence branches fail')
assert.ok(route.includes('const partialEvidenceUsed = !totalFailure'), 'partial evidence must be recognized when one branch succeeds')
assert.ok(route.includes('TOKEN READ — ${title}'), 'token reads must use section-aware title')
assert.ok(route.includes('partial evidence'), 'partial evidence title must be supported')
assert.ok(route.includes('Open Check because'), 'missing evidence engine must explain reasons')
assert.ok(route.includes('normalizedEvidence'), 'token memory must store structured normalized evidence')
assert.ok(route.includes('cachedEvidence && mem.address'), 'follow-ups must use token memory first')
assert.ok(route.includes('toolsUsed: ["memory"]'), 'follow-up responses must identify memory usage')
assert.ok(route.includes('LP proof unavailable'), 'LP missing evidence must not be faked as locked')
assert.ok(route.includes('Not enough evidence to conclude'), 'safety with missing evidence must remain Open Check')
assert.ok(!/intent:\s*"wallet_analysis"[\s\S]{0,120}token_scan/.test(route), 'token scan branch must not route to Wallet Read')
assert.ok(!route.includes('generic analysis fallback for known token intents'), 'no generic token fallback marker should be present')

// Pack 1 polish/fix pass checks.
assert.ok(route.includes('tokenFollowupRefreshRequested'), 'token follow-ups need an explicit refresh gate')
assert.ok(route.includes('followUpUsedMemory'), 'missing follow-up memory debug')
assert.ok(route.includes('followUpTriggeredRefresh'), 'missing follow-up refresh debug')
assert.ok(route.includes('tokenMemoryAgeMs'), 'missing token memory age debug')
assert.ok(route.includes('evidenceSource'), 'missing evidence source debug')
assert.ok(route.includes('resolveTokenForFollowup({ fromMemoryOnly: true })'), 'LP follow-ups must use lastToken memory before live LP calls')
assert.ok(/toolsUsed:\s*\["memory"\][\s\S]{0,260}intent:\s*"lp_lock_check"|intent:\s*"lp_lock_check"[\s\S]{0,260}toolsUsed:\s*\["memory"\]/.test(route), 'LP follow-up should be memory-backed')

const publicTokenFormatterBlock = routing.slice(routing.indexOf('export function formatTokenSecurityStatus'), routing.indexOf('export function formatNoTokenInMemory'))
for (const forbidden of ['current provider', 'provider path', 'honeypot provider', 'API path', 'route path']) {
  assert.ok(!publicTokenFormatterBlock.toLowerCase().includes(forbidden.toLowerCase()), `public token formatter leaks internal wording: ${forbidden}`)
}
assert.ok(publicTokenFormatterBlock.includes('Security simulation unavailable'), 'security gaps should use public-safe wording')
assert.ok(publicTokenFormatterBlock.includes('Position/controller proof required'), 'concentrated LP needs position/controller proof wording')

assert.ok(routing.includes('h.top1 >= 40') && routing.includes('Major single-wallet dominance'), 'top-1 >= 40% must be major single-wallet dominance risk')
assert.ok(routing.includes('h.top10 >= 40') && routing.includes('Elevated holder concentration'), 'top-10 >= 40% must be elevated concentration risk')
assert.ok(!routing.includes('positiveSignals.push(`Holder concentration: top-10'), 'top-10 concentration must not be a positive signal')
assert.ok(routing.includes('h?.holderCount != null && !(h?.top1 != null && h.top1 >= 20) && !(h?.top10 != null && h.top10 >= 40)'), 'holder count can be positive only when concentration is not dominating')

assert.ok(routing.includes('isConcentratedLp(lp)') && routing.includes('open_check'), 'concentrated LP missing proof should return open_check/low confidence')
assert.ok(!routing.includes('lp?.confidence ?? "medium"'), 'concentrated LP without controller proof must not default to medium confidence')
assert.ok(routing.includes('standard LP-token lock/burn proof does not apply'), 'concentrated LP must not be called a normal locked LP')

assert.ok(routing.includes('Conclusion: Contract-level rug powers look reduced'), 'dev/rug answer needs a clear conclusion')
assert.ok(routing.includes('But that does not clear liquidity or holder-distribution risk'), 'dev/rug conclusion must not fake full safety')
assert.ok(routing.includes('Safe? Not enough confirmed evidence to call it safe'), 'safety answer should stay Open Check when evidence is missing')
assert.ok(routing.includes('CTA: Run LP Check'), 'LP question CTA should be contextual')
assert.ok(routing.includes('CTA: Review Dev Control / Open Token Scanner'), 'dev/rug CTA should be contextual')
assert.ok(routing.includes('CTA: Open Token Scanner'), 'safety/token CTA should be contextual')

console.log('Clark Token Core checks passed')
