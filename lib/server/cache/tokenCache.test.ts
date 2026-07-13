// Tests for lib/server/cache/tokenCache.ts's circuit breaker state machine.
//
// Uses the module's own test-support exports (same double-underscore convention as this
// codebase's other __resetXForTest helpers) to drive the real circuitBreakerOpen/recordKvTimeout/
// recordKvSuccess logic deterministically. This sandbox has no real KV_REST_API_URL/TOKEN, so
// getTokenCache/setTokenCache themselves would just take the "not configured" branch and never
// touch this state machine at all — these tests exercise the actual code under test directly
// instead of a mock of something else.
//
// Run with: npx tsx --test lib/server/cache/tokenCache.test.ts

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  getKvCircuitBreakerState,
  __resetKvCircuitBreakerForTest,
  __simulateKvOutcomeForTest,
  __forceKvCircuitBreakerCooldownElapsedForTest,
  __overrideKvCooldownForTest,
  __checkKvCircuitBreakerForTest,
  __resolveKvCircuitBreakerTrialForTest,
} from './tokenCache'

beforeEach(() => {
  __resetKvCircuitBreakerForTest()
})

describe('KV circuit breaker — opens under sustained failure', () => {
  it('stays closed under fewer than the failure threshold', () => {
    __simulateKvOutcomeForTest('timeout')
    __simulateKvOutcomeForTest('timeout')
    assert.equal(getKvCircuitBreakerState().state, 'closed')
  })

  it('opens after 3 consecutive timeouts', () => {
    __simulateKvOutcomeForTest('timeout')
    __simulateKvOutcomeForTest('timeout')
    const { blocked } = __simulateKvOutcomeForTest('timeout')
    assert.equal(blocked, false) // the 3rd call itself still gets attempted — it's what trips the breaker
    assert.equal(getKvCircuitBreakerState().state, 'open')
  })

  it('blocks calls while open (before the cooldown elapses)', () => {
    __simulateKvOutcomeForTest('timeout')
    __simulateKvOutcomeForTest('timeout')
    __simulateKvOutcomeForTest('timeout')
    assert.equal(getKvCircuitBreakerState().state, 'open')
    const { blocked } = __simulateKvOutcomeForTest('timeout')
    assert.equal(blocked, true) // breaker is open — this call never even gets attempted
  })

  it('a single success resets the consecutive-timeout counter while closed', () => {
    __simulateKvOutcomeForTest('timeout')
    __simulateKvOutcomeForTest('timeout')
    __simulateKvOutcomeForTest('success')
    assert.equal(getKvCircuitBreakerState().consecutiveTimeouts, 0)
    assert.equal(getKvCircuitBreakerState().state, 'closed')
  })
})

describe('KV circuit breaker — gradual (half-open) auto-recovery', () => {
  function tripBreaker(): void {
    __simulateKvOutcomeForTest('timeout')
    __simulateKvOutcomeForTest('timeout')
    __simulateKvOutcomeForTest('timeout')
    assert.equal(getKvCircuitBreakerState().state, 'open')
  }

  it('transitions open -> half_open once the cooldown elapses, allowing exactly one trial call', () => {
    tripBreaker()
    __forceKvCircuitBreakerCooldownElapsedForTest()

    // Model two genuinely concurrent calls: both check in before either resolves an outcome.
    const first = __checkKvCircuitBreakerForTest() // becomes the half-open trial
    assert.equal(first.blocked, false)
    const second = __checkKvCircuitBreakerForTest() // arrives while the trial is still in flight
    assert.equal(second.blocked, true)

    __resolveKvCircuitBreakerTrialForTest('success') // the trial call finally resolves
    assert.equal(getKvCircuitBreakerState().state, 'closed')
  })

  it('closes fully when the half-open trial succeeds', () => {
    tripBreaker()
    __forceKvCircuitBreakerCooldownElapsedForTest()
    __simulateKvOutcomeForTest('success') // trial succeeds
    assert.equal(getKvCircuitBreakerState().state, 'closed')
    assert.equal(getKvCircuitBreakerState().consecutiveTimeouts, 0)
  })

  it('reopens with a longer backoff when the half-open trial fails, instead of a flat reopen', () => {
    tripBreaker()
    const baseCooldownMs = getKvCircuitBreakerState().nextRetryAt! - Date.now()

    __forceKvCircuitBreakerCooldownElapsedForTest()
    __simulateKvOutcomeForTest('timeout') // trial fails -> reopens with a longer (doubled) cooldown

    const snapshot = getKvCircuitBreakerState()
    assert.equal(snapshot.state, 'open')
    const newCooldownMs = snapshot.nextRetryAt! - Date.now()
    // The new cooldown is meaningfully larger than the base one (exponential backoff, doubled),
    // not the same fixed window repeated forever. A generous lower bound (1.5x) avoids test
    // flakiness from the few ms of real wall-clock time this test itself takes to run.
    assert.ok(newCooldownMs > baseCooldownMs * 1.5, `expected newCooldownMs (${newCooldownMs}) > 1.5x baseCooldownMs (${baseCooldownMs})`)
  })

  it('under normal conditions (success), the breaker never opens at all', () => {
    for (let i = 0; i < 20; i++) {
      __simulateKvOutcomeForTest('success')
    }
    assert.equal(getKvCircuitBreakerState().state, 'closed')
  })
})

describe('getKvCircuitBreakerState — typed diagnostic snapshot', () => {
  it('reports state/currentCooldownMs/nextRetryAt correctly across closed -> open -> half_open -> closed', () => {
    let snapshot = getKvCircuitBreakerState()
    assert.equal(snapshot.state, 'closed')
    assert.equal(snapshot.nextRetryAt, null)

    __simulateKvOutcomeForTest('timeout')
    __simulateKvOutcomeForTest('timeout')
    __simulateKvOutcomeForTest('timeout')
    snapshot = getKvCircuitBreakerState()
    assert.equal(snapshot.state, 'open')
    assert.equal(snapshot.currentCooldownMs, 10_000) // base cooldown, per this task's own spec
    assert.ok(snapshot.nextRetryAt !== null && snapshot.nextRetryAt > Date.now())

    __forceKvCircuitBreakerCooldownElapsedForTest()
    __checkKvCircuitBreakerForTest() // becomes the half-open trial, transitions open -> half_open
    assert.equal(getKvCircuitBreakerState().state, 'half_open')

    __resolveKvCircuitBreakerTrialForTest('success')
    snapshot = getKvCircuitBreakerState()
    assert.equal(snapshot.state, 'closed')
    assert.equal(snapshot.nextRetryAt, null)
    assert.equal(snapshot.currentCooldownMs, 10_000) // reset to base after a successful recovery
  })
})

describe('__overrideKvCooldownForTest — direct cooldown control', () => {
  it('lets a test shrink the cooldown to a small value instead of only force-expiring it', () => {
    __simulateKvOutcomeForTest('timeout')
    __simulateKvOutcomeForTest('timeout')
    __simulateKvOutcomeForTest('timeout')
    assert.equal(getKvCircuitBreakerState().state, 'open')

    __overrideKvCooldownForTest(1) // 1ms — effectively immediate
    // A tiny real sleep-free wait: nextRetryAt is now Date.now() + 1 at the moment of the override,
    // so by the time this assertion runs it has almost certainly already elapsed.
    assert.equal(getKvCircuitBreakerState().currentCooldownMs, 1)
  })
})
