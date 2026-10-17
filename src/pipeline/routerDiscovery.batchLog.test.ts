// Router candidates found in one scan are logged as a single summary line, not two lines each.
//   npx tsx --test src/pipeline/routerDiscovery.batchLog.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { logRouterCandidateBatch, recordRouterCandidate, type RouterCandidate } from './routerDiscovery'

describe('router-discovery batch logging', () => {
  it('collects a scan’s candidates and logs them once', () => {
    const lines: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { lines.push(args) }
    try {
      const batch: RouterCandidate[] = []
      for (let i = 0; i < 25; i++) {
        const address = `0x${(i + 1).toString(16).padStart(40, 'a')}`
        recordRouterCandidate('base', address, { tokensInvolved: ['0xusdc'], txHash: `0xtx${i}`, chain: 'base', heuristic: 'repeated-pattern' }, batch)
      }
      assert.equal(lines.length, 0, 'nothing logged per candidate')
      assert.equal(batch.length, 25)
      logRouterCandidateBatch(batch)
      assert.equal(lines.length, 1, 'exactly one line for the whole scan')
      const summary = JSON.parse(lines[0][1] as string) as { count: number; byChain: Record<string, number>; sample: string[] }
      assert.equal(summary.count, 25)
      assert.deepEqual(summary.byChain, { base: 25 })
      assert.equal(summary.sample.length, 10)
      logRouterCandidateBatch([])
      assert.equal(lines.length, 1, 'silent when there are no new candidates')
    } finally {
      console.warn = originalWarn
    }
  })
})
