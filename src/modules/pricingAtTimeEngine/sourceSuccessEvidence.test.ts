// TESTS — pricingAtTimeEngine/sourceSuccessEvidence: deterministic per-source success evidence.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  recordPricingAttemptOutcome,
  resetSourceSuccessEvidence,
  snapshotSourceSuccessEvidence,
  emptySourceSuccessEvidence,
  estimateSourceSuccessProbability,
  estimateRouteSuccess,
  observedFailureReasonsForAsset,
  isPermanentlyMissingAsset,
  routeSourceOrderFor,
  DEFAULT_UNSEEN_SUCCESS_PROBABILITY,
  HARD_FAILURE_REASONS,
  PERMANENT_SKIP_REASONS,
  type PricingAttemptOutcome,
} from './sourceSuccessEvidence'

const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER_TOKEN = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function outcome(over: Partial<PricingAttemptOutcome> = {}): PricingAttemptOutcome {
  return {
    chain: 'base',
    token: TOKEN,
    source: 'geckoterminal',
    assetClass: 'other',
    requirementType: 'entry',
    ok: false,
    reason: null,
    ...over,
  }
}

function probeFor(over: Partial<PricingAttemptOutcome> = {}) {
  const o = outcome(over)
  return { chain: o.chain, token: o.token, source: o.source, assetClass: o.assetClass, requirementType: o.requirementType }
}

beforeEach(() => resetSourceSuccessEvidence())

test('an entirely unseen requirement receives exactly the deterministic fallback probability', () => {
  const evidence = snapshotSourceSuccessEvidence()
  assert.equal(estimateSourceSuccessProbability(evidence, probeFor()), DEFAULT_UNSEEN_SUCCESS_PROBABILITY)
  assert.equal(evidence.totalObservations, 0)
})

test('emptySourceSuccessEvidence behaves identically to a never-touched ledger', () => {
  assert.equal(
    estimateSourceSuccessProbability(emptySourceSuccessEvidence(), probeFor()),
    DEFAULT_UNSEEN_SUCCESS_PROBABILITY,
  )
})

test('repeated real successes raise the estimate above the fallback; repeated plain failures lower it', () => {
  for (let i = 0; i < 10; i += 1) recordPricingAttemptOutcome(outcome({ ok: true, reason: null }))
  const good = estimateSourceSuccessProbability(snapshotSourceSuccessEvidence(), probeFor())
  assert.ok(good > DEFAULT_UNSEEN_SUCCESS_PROBABILITY, `expected success evidence to raise the estimate, got ${good}`)

  resetSourceSuccessEvidence()
  for (let i = 0; i < 10; i += 1) recordPricingAttemptOutcome(outcome({ ok: false, reason: null }))
  const bad = estimateSourceSuccessProbability(snapshotSourceSuccessEvidence(), probeFor())
  assert.ok(bad < DEFAULT_UNSEEN_SUCCESS_PROBABILITY, `expected failure evidence to lower the estimate, got ${bad}`)
})

test('repeated typed HARD failures reduce the estimate strictly more than the same number of untyped failures', () => {
  for (let i = 0; i < 5; i += 1) recordPricingAttemptOutcome(outcome({ ok: false, reason: null }))
  const untyped = estimateSourceSuccessProbability(snapshotSourceSuccessEvidence(), probeFor())

  resetSourceSuccessEvidence()
  for (let i = 0; i < 5; i += 1) recordPricingAttemptOutcome(outcome({ ok: false, reason: 'no_pool' }))
  const hard = estimateSourceSuccessProbability(snapshotSourceSuccessEvidence(), probeFor())

  assert.ok(hard < untyped, `expected 5 typed no_pool (${hard}) to hurt more than 5 untyped nulls (${untyped})`)
})

test('every failure reason named in the spec is classified, and only token_not_found is a permanent skip', () => {
  for (const reason of ['no_pool', 'token_not_found', 'blockResolutionFailure', 'temporal_distance_exceeded']) {
    assert.ok(HARD_FAILURE_REASONS.has(reason), `${reason} must be a recognised hard failure`)
  }
  assert.deepEqual([...PERMANENT_SKIP_REASONS], ['token_not_found'])
})

test('token_not_found marks the asset permanently missing; no_pool alone never does', () => {
  recordPricingAttemptOutcome(outcome({ ok: false, reason: 'no_pool' }))
  assert.equal(isPermanentlyMissingAsset(snapshotSourceSuccessEvidence(), 'base', TOKEN), false,
    'no_pool is venue/time specific and must never permanently skip an asset')

  recordPricingAttemptOutcome(outcome({ ok: false, reason: 'token_not_found' }))
  assert.equal(isPermanentlyMissingAsset(snapshotSourceSuccessEvidence(), 'base', TOKEN), true)
})

test('evidence is source-specific, never global — one source failing does not condemn another', () => {
  for (let i = 0; i < 8; i += 1) recordPricingAttemptOutcome(outcome({ source: 'geckoterminal', ok: false, reason: 'no_pool' }))
  const evidence = snapshotSourceSuccessEvidence()
  const gecko = estimateSourceSuccessProbability(evidence, probeFor({ source: 'geckoterminal' }))
  const goldrush = estimateSourceSuccessProbability(evidence, probeFor({ source: 'goldrush' }))
  assert.ok(gecko < 0.2, `expected GeckoTerminal to be heavily discounted, got ${gecko}`)
  assert.equal(goldrush, DEFAULT_UNSEEN_SUCCESS_PROBABILITY, 'an unobserved source must keep the fallback prior')
})

test('evidence is token-specific at its narrowest level — one dead token does not condemn its whole asset class alone', () => {
  for (let i = 0; i < 8; i += 1) recordPricingAttemptOutcome(outcome({ token: TOKEN, ok: false, reason: 'no_pool' }))
  const evidence = snapshotSourceSuccessEvidence()
  const dead = estimateSourceSuccessProbability(evidence, probeFor({ token: TOKEN }))
  const sibling = estimateSourceSuccessProbability(evidence, probeFor({ token: OTHER_TOKEN }))
  assert.ok(dead < sibling, `the observed token (${dead}) must rank below an unobserved sibling (${sibling})`)
})

test('estimates depend only on COUNTS, never on the order outcomes arrived in', () => {
  const sequence: PricingAttemptOutcome[] = [
    outcome({ ok: true }),
    outcome({ ok: false, reason: 'no_pool' }),
    outcome({ ok: false, reason: null }),
    outcome({ ok: true }),
    outcome({ ok: false, reason: 'blockResolutionFailure' }),
  ]

  for (const o of sequence) recordPricingAttemptOutcome(o)
  const forward = estimateSourceSuccessProbability(snapshotSourceSuccessEvidence(), probeFor())

  resetSourceSuccessEvidence()
  for (const o of [...sequence].reverse()) recordPricingAttemptOutcome(o)
  const reversed = estimateSourceSuccessProbability(snapshotSourceSuccessEvidence(), probeFor())

  assert.equal(forward, reversed, 'the same multiset of outcomes must yield an identical estimate in any order')
})

test('a snapshot is immutable — later recordings never mutate an already-taken snapshot', () => {
  recordPricingAttemptOutcome(outcome({ ok: true }))
  const snapshot = snapshotSourceSuccessEvidence()
  const before = estimateSourceSuccessProbability(snapshot, probeFor())

  for (let i = 0; i < 20; i += 1) recordPricingAttemptOutcome(outcome({ ok: false, reason: 'no_pool' }))

  assert.equal(estimateSourceSuccessProbability(snapshot, probeFor()), before,
    'a snapshot taken before an async pass must not shift underneath its holder')
  assert.ok(estimateSourceSuccessProbability(snapshotSourceSuccessEvidence(), probeFor()) < before,
    'a fresh snapshot must reflect the new evidence')
})

test('observed failure reasons are reported exactly as providers returned them, never relabelled', () => {
  recordPricingAttemptOutcome(outcome({ ok: false, reason: 'no_pool' }))
  recordPricingAttemptOutcome(outcome({ ok: false, reason: 'no_pool' }))
  recordPricingAttemptOutcome(outcome({ ok: false, reason: 'blockResolutionFailure' }))
  const reasons = observedFailureReasonsForAsset(snapshotSourceSuccessEvidence(), 'base', TOKEN)
  assert.equal(reasons.get('no_pool'), 2)
  assert.equal(reasons.get('blockResolutionFailure'), 1)
})

test('a SUCCESS never records a failure reason', () => {
  recordPricingAttemptOutcome(outcome({ ok: true, reason: 'no_pool' }))
  const reasons = observedFailureReasonsForAsset(snapshotSourceSuccessEvidence(), 'base', TOKEN)
  assert.equal(reasons.size, 0, 'a source that answered must never be tallied as having failed for a reason')
})

test('route order matches the real per-chain dispatch order the pricing router uses', () => {
  assert.deepEqual(routeSourceOrderFor('base'), ['geckoterminal', 'dexscreener', 'goldrush'])
  assert.deepEqual(routeSourceOrderFor('eth'), ['goldrush', 'dexscreener', 'geckoterminal'])
})

test('route success combines sources as "at least one answers", and costs only the calls expected to happen', () => {
  const evidence = emptySourceSuccessEvidence()
  const route = estimateRouteSuccess(evidence, { chain: 'base', token: TOKEN, assetClass: 'other', requirementType: 'entry' })

  // Three sources at the 0.5 fallback each: 1 - 0.5^3 = 0.875.
  assert.equal(route.probability, 0.875)
  assert.equal(route.primarySource, 'geckoterminal', 'Base dispatches GeckoTerminal first')
  // Expected attempts: 1 + 0.5 + 0.25 = 1.75 — never the full 3, since the chain stops at the first
  // source that answers.
  assert.equal(route.estimatedCalls, 1.75)
  assert.ok(route.estimatedCu > 0)
})

test('a route whose every source has proven dead scores far below an unobserved one', () => {
  for (const source of routeSourceOrderFor('base')) {
    for (let i = 0; i < 8; i += 1) {
      recordPricingAttemptOutcome(outcome({ source, ok: false, reason: 'no_pool' }))
    }
  }
  const evidence = snapshotSourceSuccessEvidence()
  const dead = estimateRouteSuccess(evidence, { chain: 'base', token: TOKEN, assetClass: 'other', requirementType: 'entry' })
  const unseen = estimateRouteSuccess(evidence, { chain: 'base', token: OTHER_TOKEN, assetClass: 'stable', requirementType: 'entry' })
  assert.ok(dead.probability < unseen.probability,
    `a route with real repeated hard failures (${dead.probability}) must rank below an unobserved one (${unseen.probability})`)
})

test('probabilities always stay within [0,1] no matter how lopsided the evidence', () => {
  for (let i = 0; i < 500; i += 1) recordPricingAttemptOutcome(outcome({ ok: false, reason: 'token_not_found' }))
  const low = estimateSourceSuccessProbability(snapshotSourceSuccessEvidence(), probeFor())
  assert.ok(low >= 0 && low <= 1, `estimate escaped [0,1]: ${low}`)

  resetSourceSuccessEvidence()
  for (let i = 0; i < 500; i += 1) recordPricingAttemptOutcome(outcome({ ok: true }))
  const high = estimateSourceSuccessProbability(snapshotSourceSuccessEvidence(), probeFor())
  assert.ok(high >= 0 && high <= 1, `estimate escaped [0,1]: ${high}`)
  assert.ok(high < 1, 'shrinkage must keep even overwhelming evidence short of absolute certainty')
})
