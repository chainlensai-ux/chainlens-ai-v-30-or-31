// Tests for planRecoveryFetches's budget-allocation arithmetic (src/modules/recoveryPolicy/
// index.ts). NOT wired into `npm test`. Run directly with:
//   npx tsx --test src/modules/recoveryPolicy/planRecoveryFetches.test.ts
//
// Regression coverage for the scan-latency parallelization fix: buildRecoveryPolicyObject used to
// compute each candidate's page budget INSIDE a sequential for-loop, only after awaiting the
// previous candidate's real network fetch. That budget arithmetic was extracted into this pure,
// synchronous function (planRecoveryFetches) so every candidate's fetch could run concurrently
// instead — these tests assert the extracted arithmetic produces the EXACT same allocation the old
// sequential loop would have, for the same caps and candidate list, so the parallelization is a
// pure latency win with zero change to which pages get fetched or how the wallet-level cap is
// enforced.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planRecoveryFetches, type CandidateEvaluation } from './index'
import type { RecoveryPolicyCaps } from './types'

function candidate(token: string, recoveryTriggered = true): CandidateEvaluation {
  return { token, chain: 'base', triggeredBy: recoveryTriggered ? [{ rule: 'token_value_usd_gte', evidenceSource: 'buyTimeline', evidenceEntryRefs: [], detail: '' }] : [], recoveryTriggered }
}

const CAPS: RecoveryPolicyCaps = { maxHistoricalPagesPerWallet: 6, maxHistoricalPagesPerToken: 4 }

describe('planRecoveryFetches', () => {
  it('a non-triggered candidate always gets a zero page budget', () => {
    const plan = planRecoveryFetches([candidate('a', false)], CAPS)
    assert.equal(plan[0].pageBudget, 0)
  })

  it('a single triggered candidate gets min(perTokenCap, walletBudget) — capped by the per-token cap here', () => {
    // maxHistoricalPagesPerToken=4 < maxHistoricalPagesPerWallet=6, so the per-token cap binds.
    const plan = planRecoveryFetches([candidate('a')], CAPS)
    assert.equal(plan[0].pageBudget, 4)
  })

  it('THE REAL-WORLD CASE: 3 triggered candidates each consume actual pages (capped at 2 each), matching the old sequential wallet-budget math', () => {
    // Matches DEFAULT_RECOVERY_CAPS exactly (6 wallet / 4 per-token). Each candidate's pageBudget is
    // min(4, remaining) — but fetchHistoricalPages only ever actually uses min(pageBudget, 2) pages,
    // so the OLD sequential code's running total advanced by 2 per candidate, not 4.
    const plan = planRecoveryFetches([candidate('a'), candidate('b'), candidate('c')], CAPS)
    assert.equal(plan[0].pageBudget, 4, 'candidate a: min(4, 6 remaining) = 4')
    assert.equal(plan[1].pageBudget, 4, 'candidate b: min(4, 4 remaining after a\'s actual 2 pages used) = 4')
    assert.equal(plan[2].pageBudget, 2, 'candidate c: min(4, 2 remaining after b\'s actual 2 pages used) = 2')
  })

  it('a 4th triggered candidate gets zero once the wallet cap is exhausted', () => {
    const plan = planRecoveryFetches([candidate('a'), candidate('b'), candidate('c'), candidate('d')], CAPS)
    assert.equal(plan[3].pageBudget, 0, 'wallet cap (6) is fully consumed by a+b+c\'s actual 2+2+2=6 pages')
  })

  it('order matters: an earlier non-triggered candidate does not consume any wallet budget', () => {
    const plan = planRecoveryFetches([candidate('a', false), candidate('b'), candidate('c'), candidate('d')], CAPS)
    assert.equal(plan[0].pageBudget, 0)
    assert.equal(plan[1].pageBudget, 4, 'b is first-in-line for the full wallet budget')
    assert.equal(plan[2].pageBudget, 4)
    assert.equal(plan[3].pageBudget, 2, 'd only gets the remaining 2 after b+c\'s actual 2+2=4 pages used')
  })

  it('zero triggered candidates produces an all-zero plan', () => {
    const plan = planRecoveryFetches([candidate('a', false), candidate('b', false)], CAPS)
    assert.deepEqual(plan.map((p) => p.pageBudget), [0, 0])
  })

  it('a wallet cap smaller than the per-token cap correctly binds instead', () => {
    const tightCaps: RecoveryPolicyCaps = { maxHistoricalPagesPerWallet: 1, maxHistoricalPagesPerToken: 4 }
    const plan = planRecoveryFetches([candidate('a'), candidate('b')], tightCaps)
    assert.equal(plan[0].pageBudget, 1, 'wallet cap (1) binds over the per-token cap (4)')
    assert.equal(plan[1].pageBudget, 0, 'wallet budget fully exhausted by a\'s single page')
  })
})
