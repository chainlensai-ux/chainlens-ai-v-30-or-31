import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { awaitHistoricalPricePriority, runWithScanContext } from './scanRunContext'

describe('awaitHistoricalPricePriority', () => {
  it('waits for the gate inside a gated scan context', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const order: string[] = []
    const run = runWithScanContext({ deadlineAtMs: Date.now() + 60_000, historicalPricePriority: gate }, async () => {
      await awaitHistoricalPricePriority()
      order.push('priced')
    })
    await new Promise((r) => setTimeout(r, 10))
    order.push('released')
    release()
    await run
    assert.deepEqual(order, ['released', 'priced'])
  })

  it('does not wait outside a scan context (Robinhood lane, routes, tests)', async () => {
    let done = false
    await Promise.race([
      awaitHistoricalPricePriority().then(() => { done = true }),
      new Promise((r) => setTimeout(r, 50)),
    ])
    assert.equal(done, true)
  })

  it('does not wait in a scan context without a gate', async () => {
    await runWithScanContext({ deadlineAtMs: Date.now() + 60_000 }, () => awaitHistoricalPricePriority())
  })
})
