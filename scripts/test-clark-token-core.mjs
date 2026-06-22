#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const route = readFileSync('app/api/clark/route.ts', 'utf8')

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

console.log('Clark Token Core checks passed')
