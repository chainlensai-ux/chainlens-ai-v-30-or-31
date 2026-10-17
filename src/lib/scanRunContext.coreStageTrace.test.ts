// A scan cut off by the worker's deadline still reports which pipeline steps finished and which were
// running, via the live trace on the scan context.
//   npx tsx --test src/lib/scanRunContext.coreStageTrace.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCoreStageTrace, runWithScanContext, summarizeCoreStageTrace, traceCoreStageEnd, traceCoreStageStart } from '@/src/lib/scanRunContext'
import { createScanStageProfiler } from '@/src/pipeline/scanStageProfiler'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('core stage trace', () => {
  it('reports finished steps, the step still running, and the last one to finish', async () => {
    const trace = createCoreStageTrace()
    const profiler = createScanStageProfiler()
    let release!: () => void
    const stuck = new Promise<void>((resolve) => { release = resolve })
    const scan = runWithScanContext({ deadlineAtMs: Date.now() + 60_000, coreStageTrace: trace }, async () => {
      traceCoreStageStart('providerFetchWindow')
      await wait(20)
      traceCoreStageEnd('providerFetchWindow')
      await profiler.stage('canonicalSampleSelection', { awaitedSerially: true }, () => stuck)
    })
    await wait(30)
    const summary = summarizeCoreStageTrace(trace)
    assert.ok(Number(summary['core.providerFetchWindow']) >= 15)
    assert.ok(Number(summary['core.canonicalSampleSelection.running']) >= 0)
    assert.equal(summary['core.lastFinished'], 'providerFetchWindow')
    release()
    await scan
    const after = summarizeCoreStageTrace(trace)
    assert.equal(after['core.canonicalSampleSelection.running'], undefined)
    assert.equal(typeof after['core.canonicalSampleSelection'], 'number')
    assert.equal(after['core.lastFinished'], 'canonicalSampleSelection')
  })

  it('does nothing outside a traced scan', async () => {
    traceCoreStageStart('x')
    traceCoreStageEnd('x')
    const profiler = createScanStageProfiler()
    assert.equal(await profiler.stage('y', { awaitedSerially: true }, async () => 7), 7)
  })
})
