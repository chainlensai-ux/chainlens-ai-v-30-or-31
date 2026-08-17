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

// ── Coverage-materiality allocation (verified-coverage recovery task) ────────────────────────
// The wallet budget only ever covers floor(6/2) = 3 triggered tokens. These assert the scarce
// budget goes to the tokens that can actually move the verified-coverage gate, rather than to
// whichever token happened to appear first in the timelines.

function materialCandidate(token: string, sellCount: number, cumulativeBuyUsd = 0): CandidateEvaluation {
  return {
    ...candidate(token),
    coverageMateriality: { sellCount, cumulativeBuyUsd },
  }
}

describe('planRecoveryFetches — coverage materiality ordering', () => {
  it('THE REAL BUG: a high-sell-count token later in the list is funded over earlier single-sell tokens', () => {
    // 5 triggered tokens, budget for only 3. 'e' is worth 12 closed lots but appears last.
    const plan = planRecoveryFetches([
      materialCandidate('a', 1), materialCandidate('b', 1), materialCandidate('c', 1),
      materialCandidate('d', 9), materialCandidate('e', 12),
    ], CAPS)
    const funded = plan.filter((p) => p.pageBudget > 0).map((p) => p.candidate.token)
    assert.deepEqual(funded.sort(), ['a', 'd', 'e'], 'the two highest-sell tokens must be funded, plus one of the equal-materiality remainder')
    assert.ok(plan.find((p) => p.candidate.token === 'e')!.pageBudget > 0, 'the 12-sell token must not be starved')
    assert.ok(plan.find((p) => p.candidate.token === 'd')!.pageBudget > 0, 'the 9-sell token must not be starved')
  })

  it('returns the plan in the caller\'s original candidate order, not the allocation order', () => {
    const plan = planRecoveryFetches([
      materialCandidate('a', 1), materialCandidate('b', 12), materialCandidate('c', 5),
    ], CAPS)
    assert.deepEqual(plan.map((p) => p.candidate.token), ['a', 'b', 'c'], 'output order is unchanged')
  })

  it('cumulative buy USD breaks ties when sell counts are equal', () => {
    const plan = planRecoveryFetches([
      materialCandidate('low', 2, 100), materialCandidate('high', 2, 50_000),
    ], { maxHistoricalPagesPerWallet: 2, maxHistoricalPagesPerToken: 4 })
    assert.ok(plan.find((p) => p.candidate.token === 'high')!.pageBudget > 0, 'higher-value token wins the single available slot')
    assert.equal(plan.find((p) => p.candidate.token === 'low')!.pageBudget, 0)
  })

  it('never funds a non-triggered candidate regardless of how material it looks', () => {
    const untriggered: CandidateEvaluation = { ...candidate('x', false), coverageMateriality: { sellCount: 999, cumulativeBuyUsd: 1e9 } }
    const plan = planRecoveryFetches([untriggered, materialCandidate('y', 1)], CAPS)
    assert.equal(plan[0].pageBudget, 0, 'materiality never overrides the trigger gate')
    assert.ok(plan[1].pageBudget > 0)
  })

  it('total pages allocated never exceeds the wallet cap — ordering must not raise spend', () => {
    const plan = planRecoveryFetches([
      materialCandidate('a', 5), materialCandidate('b', 4), materialCandidate('c', 3),
      materialCandidate('d', 2), materialCandidate('e', 1),
    ], CAPS)
    const actualPagesConsumed = plan.reduce((sum, p) => sum + Math.min(p.pageBudget, 2), 0)
    assert.ok(actualPagesConsumed <= CAPS.maxHistoricalPagesPerWallet, `consumed ${actualPagesConsumed} must stay within the ${CAPS.maxHistoricalPagesPerWallet}-page wallet cap`)
    assert.equal(plan.filter((p) => p.pageBudget > 0).length, 3, 'still exactly 3 funded candidates — same volume, better targeting')
  })

  it('candidates with no materiality data keep first-come order (backward compatible)', () => {
    const plan = planRecoveryFetches([candidate('a'), candidate('b'), candidate('c'), candidate('d')], CAPS)
    assert.deepEqual(plan.map((p) => p.pageBudget), [4, 4, 2, 0], 'unmeasured candidates allocate exactly as before')
  })
})
