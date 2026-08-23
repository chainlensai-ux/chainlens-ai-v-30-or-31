// PERF-SPRINT TASK, DISCLOSED: static source check for the identity-check-loop parallelization —
// see fetchPricing.ts's own PERF-SPRINT comment right above the loop for the full "why this is
// safe" disclosure (bounded to 2 rows, each touches only its own p/h, never a shared accumulator).
// The existing fetchPricing.test.ts suite (real assertions on the identity-check behavior itself)
// already covers correctness — this file only locks in the mechanism, so a future edit can't
// silently revert the loop back to sequential without a visible test failure.
// Run directly with:
//   npx tsx --test lib/engine/modules/pricing/fetchPricing.identityCheckConcurrency.staticCheck.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./fetchPricing.ts', import.meta.url)), 'utf8')

describe('top-2-holding identity check runs concurrently (perf-sprint: "detect sequential operations that could safely run in parallel")', () => {
  it('the TOP_N_FOR_IDENTITY_CHECK loop is wrapped in Promise.all, not a sequential for-of', () => {
    assert.match(src, /await Promise\.all\(topByValue\.map\(async \(\{ p, h \}\) => \{/, 'the identity-check loop must open with Promise.all(topByValue.map(async ...)), not a sequential for-of')
    assert.match(src, /^ {2}\}\)\)\s*$/m, 'the identity-check loop must close with the matching }))')
    assert.doesNotMatch(src, /for \(const \{ p, h \} of topByValue\)/, 'must not regress back to a sequential for-of over topByValue')
  })

  it('the dominant-holding loop (which mutates a shared totalValueUsd accumulator) is deliberately left sequential', () => {
    // Correctness guard, not a perf assertion: this loop is NOT touched by this task because it
    // mutates shared totalValueUsd/chainValueUsd across iterations — parallelizing it would be a
    // real race condition, not just a style change.
    assert.match(src, /for \(let i = 0; i < holdings\.length; i \+= 1\) \{/, 'the dominant-holding loop must remain a sequential for-loop (it mutates shared totalValueUsd/chainValueUsd)')
  })
})
