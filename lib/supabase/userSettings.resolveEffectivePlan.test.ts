// Tests for lib/supabase/userSettings.ts's resolveEffectivePlan — crypto-payment audit fix
// (paid-plan expiry via current_period_end, checked lazily at read time, same shape as the
// pre-existing trial_ends_at check).
//
// Run with:
//   npx tsx --test lib/supabase/userSettings.resolveEffectivePlan.test.ts

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveEffectivePlan } from './userSettings'

const NOW = Date.parse('2026-06-15T00:00:00.000Z')
const FUTURE = new Date(NOW + 10 * 24 * 60 * 60 * 1000).toISOString()
const PAST = new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString()

describe('resolveEffectivePlan — paid-plan expiry', () => {
  it('keeps a pro plan active while current_period_end is in the future', () => {
    const plan = resolveEffectivePlan({ plan: 'pro', subscription_status: 'active', current_period_end: FUTURE }, NOW)
    assert.equal(plan, 'pro')
  })

  it('keeps an elite plan active while current_period_end is in the future', () => {
    const plan = resolveEffectivePlan({ plan: 'elite', subscription_status: 'active', current_period_end: FUTURE }, NOW)
    assert.equal(plan, 'elite')
  })

  it('lapses a pro plan back to free once current_period_end has passed — this is the crypto-payment expiry fix', () => {
    const plan = resolveEffectivePlan({ plan: 'pro', subscription_status: 'active', current_period_end: PAST }, NOW)
    assert.equal(plan, 'free')
  })

  it('lapses an elite plan back to free once current_period_end has passed', () => {
    const plan = resolveEffectivePlan({ plan: 'elite', subscription_status: 'active', current_period_end: PAST }, NOW)
    assert.equal(plan, 'free')
  })

  it('never expires a paid plan with no current_period_end set — legacy/admin-granted rows stay backwards compatible', () => {
    const plan = resolveEffectivePlan({ plan: 'pro', subscription_status: 'active', current_period_end: null }, NOW)
    assert.equal(plan, 'pro')
  })

  it('never expires a paid plan when current_period_end is missing entirely from the row', () => {
    const plan = resolveEffectivePlan({ plan: 'elite', subscription_status: 'active' }, NOW)
    assert.equal(plan, 'elite')
  })

  it('ignores a malformed current_period_end rather than incorrectly expiring the plan', () => {
    const plan = resolveEffectivePlan({ plan: 'pro', subscription_status: 'active', current_period_end: 'not-a-date' }, NOW)
    assert.equal(plan, 'pro')
  })

  it('an expired elite plan still falls through to an active elite trial', () => {
    const plan = resolveEffectivePlan({
      plan: 'elite', subscription_status: 'active', current_period_end: PAST,
      trial_plan: 'elite', trial_ends_at: FUTURE,
    }, NOW)
    assert.equal(plan, 'elite')
  })

  it('a free plan is unaffected by current_period_end regardless of value', () => {
    const plan = resolveEffectivePlan({ plan: 'free', current_period_end: PAST }, NOW)
    assert.equal(plan, 'free')
  })

  it('a null settings row still resolves to free (pre-existing behavior, unaffected by this fix)', () => {
    const plan = resolveEffectivePlan(null, NOW)
    assert.equal(plan, 'free')
  })
})
