// Tests for the Wallet Scanner stage profiler (src/pipeline/scanStageProfiler.ts).
//
// The profiler exists to close a ~70s attribution gap between the wallet scan's real total and the
// seven stages the legacy scanTimer could observe. These tests defend the two properties that make
// it trustworthy: (1) it is PURE INSTRUMENTATION — values pass through untouched, errors rethrow
// untouched, so it can never change scan behavior or fail-closed semantics; and (2) its
// reconciliation arithmetic is honest — nested stages never double-count, the retention cap never
// silently hides time, and residue is reported rather than absorbed.
//
// Run directly with: npx tsx --test src/pipeline/scanStageProfiler.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createScanStageProfiler } from './scanStageProfiler.ts'

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms) })

describe('scanStageProfiler — pure instrumentation', () => {
  it('returns the wrapped region\'s own value completely unchanged', async () => {
    const profiler = createScanStageProfiler()
    const marker = { deep: { value: 42 } }
    const returned = await profiler.stage('x', { awaitedSerially: true }, async () => marker)
    assert.equal(returned, marker, 'must return the identical object reference, never a copy')
  })

  it('rethrows the wrapped region\'s error unchanged, and still records the stage as failed', async () => {
    const profiler = createScanStageProfiler()
    const boom = new Error('kv unavailable')
    await assert.rejects(
      () => profiler.stage('failing', { awaitedSerially: true }, async () => { throw boom }),
      (error: unknown) => error === boom,
    )
    const sample = profiler.samples().find((s) => s.name === 'failing')
    assert.ok(sample, 'a throwing stage must still be measured, never dropped')
    assert.equal(sample.failed, true)
  })

  it('stageSync passes values and errors through the same way', () => {
    const profiler = createScanStageProfiler()
    assert.equal(profiler.stageSync('sync', { awaitedSerially: false }, () => 7), 7)
    const boom = new Error('sync boom')
    assert.throws(() => profiler.stageSync('syncFail', { awaitedSerially: false }, () => { throw boom }), (e: unknown) => e === boom)
    assert.equal(profiler.samples().find((s) => s.name === 'syncFail')?.failed, true)
  })
})

describe('scanStageProfiler — measurement shape', () => {
  it('records the full requested per-stage shape with real monotonic durations', async () => {
    const profiler = createScanStageProfiler()
    await profiler.stage('slowStage', { awaitedSerially: true }, async () => {
      profiler.count({ providerCalls: 3, kvReads: 5, cacheHits: 11 })
      await sleep(25)
    })
    const [sample] = profiler.samples()
    assert.equal(sample.name, 'slowStage')
    assert.ok(sample.durationMs >= 20, `expected a real measured duration, got ${sample.durationMs}`)
    assert.equal(sample.endedAt - sample.startedAt, sample.durationMs)
    assert.equal(sample.providerCalls, 3)
    assert.equal(sample.kvReads, 5)
    assert.equal(sample.cacheHits, 11)
    assert.equal(sample.awaitedSerially, true)
    assert.equal(sample.depth, 0)
    assert.equal(sample.failed, false)
  })

  it('reports zero counters honestly for a region that declares none — never a guess', async () => {
    const profiler = createScanStageProfiler()
    await profiler.stage('uncounted', { awaitedSerially: false }, async () => undefined)
    const [sample] = profiler.samples()
    assert.deepEqual(
      { providerCalls: sample.providerCalls, kvReads: sample.kvReads, cacheHits: sample.cacheHits },
      { providerCalls: 0, kvReads: 0, cacheHits: 0 },
    )
  })

  it('attributes counters to the INNERMOST open stage, never leaking to the parent', async () => {
    const profiler = createScanStageProfiler()
    await profiler.stage('parent', { awaitedSerially: true }, async () => {
      profiler.count({ kvReads: 1 })
      await profiler.stage('child', { awaitedSerially: true }, async () => {
        profiler.count({ kvReads: 100 })
      })
    })
    const byName = new Map(profiler.samples().map((s) => [s.name, s]))
    assert.equal(byName.get('child')!.kvReads, 100)
    assert.equal(byName.get('parent')!.kvReads, 1, 'the child\'s counters must not leak into the parent')
  })

  it('count() with no stage open is a safe no-op', () => {
    const profiler = createScanStageProfiler()
    assert.doesNotThrow(() => profiler.count({ kvReads: 5 }))
    assert.equal(profiler.samples().length, 0)
  })
})

describe('scanStageProfiler — reconciliation arithmetic', () => {
  it('sums only depth-0 stages, so a nested stage is visible but never double-counted', async () => {
    const profiler = createScanStageProfiler()
    await profiler.stage('outer', { awaitedSerially: true }, async () => {
      await sleep(15)
      await profiler.stage('inner', { awaitedSerially: true }, async () => { await sleep(15) })
    })
    const samples = profiler.samples()
    const outer = samples.find((s) => s.name === 'outer')!
    const inner = samples.find((s) => s.name === 'inner')!
    assert.equal(outer.depth, 0)
    assert.equal(inner.depth, 1, 'a stage opened inside another must record depth 1')

    const profile = profiler.build({ totalMs: outer.durationMs })
    assert.equal(profile.reconciliation.measuredMs, outer.durationMs, 'only the depth-0 stage counts toward measuredMs')
    assert.equal(profile.reconciliation.topLevelStageCount, 1)
    assert.ok(
      profile.reconciliation.measuredMs < outer.durationMs + inner.durationMs,
      'the nested stage must NOT be added on top of its parent',
    )
  })

  it('computes unexplained time and the 5% tolerance flag honestly', async () => {
    const profiler = createScanStageProfiler()
    profiler.record({
      name: 'measured', startedAt: 0, endedAt: 900, durationMs: 900,
      providerCalls: 0, kvReads: 0, cacheHits: 0, awaitedSerially: true,
    })
    const within = profiler.build({ totalMs: 1000, knownPrePostMs: 60 })
    assert.equal(within.reconciliation.measuredMs, 900)
    assert.equal(within.reconciliation.knownPrePostMs, 60)
    assert.equal(within.reconciliation.unexplainedMs, 40)
    assert.equal(within.reconciliation.unexplainedPercent, 4)
    assert.equal(within.reconciliation.withinTolerance, true)

    const outside = profiler.build({ totalMs: 2000 })
    assert.equal(outside.reconciliation.unexplainedMs, 1100)
    assert.equal(outside.reconciliation.unexplainedPercent, 55)
    assert.equal(outside.reconciliation.withinTolerance, false, '>5% residue must fail tolerance, never be absorbed')
  })

  it('never reports negative unexplained time when stages overlap the total', () => {
    const profiler = createScanStageProfiler()
    profiler.record({
      name: 'long', startedAt: 0, endedAt: 5000, durationMs: 5000,
      providerCalls: 0, kvReads: 0, cacheHits: 0, awaitedSerially: true,
    })
    const profile = profiler.build({ totalMs: 1000 })
    assert.equal(profile.reconciliation.unexplainedMs, 0)
    assert.equal(profile.reconciliation.unexplainedPercent, 0)
  })

  it('ranks the slowest top-level stages with their percent of total', () => {
    const profiler = createScanStageProfiler()
    for (const [name, durationMs] of [['a', 100], ['b', 700], ['c', 200]] as const) {
      profiler.record({
        name, startedAt: 0, endedAt: durationMs, durationMs,
        providerCalls: 0, kvReads: 0, cacheHits: 0, awaitedSerially: true,
      })
    }
    const profile = profiler.build({ totalMs: 1000 })
    assert.deepEqual(profile.slowest.map((s) => s.name), ['b', 'c', 'a'])
    assert.equal(profile.slowest[0].percentOfTotal, 70)
  })
})

describe('scanStageProfiler — bounded retention', () => {
  it('caps retained samples but still counts and sums the overflow, never hiding time', () => {
    const profiler = createScanStageProfiler()
    for (let i = 0; i < 80; i += 1) {
      profiler.record({
        name: `stage-${i}`, startedAt: 0, endedAt: 10, durationMs: 10,
        providerCalls: 0, kvReads: 0, cacheHits: 0, awaitedSerially: true,
      })
    }
    const profile = profiler.build({ totalMs: 800 })
    assert.equal(profile.samples.length, 64, 'retention is hard-capped at MAX_SAMPLES')
    assert.equal(profile.reconciliation.overflowStageCount, 16)
    assert.equal(profile.reconciliation.overflowMs, 160, 'dropped stages still contribute their real ms')
    // 64 retained * 10ms + 160ms overflow = the full 800ms — nothing silently vanished.
    assert.equal(profile.reconciliation.measuredMs, 800)
    assert.equal(profile.reconciliation.unexplainedMs, 0)
  })
})
