// Provider gates: pacing spaces request starts evenly; the concurrency gate never exceeds its limit.
//   npx tsx --test src/lib/providerGates.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConcurrencyGate, createPacingGate, envRate } from './providerGates'

test('pacing gate: 9 requests at 20/s start ~50ms apart, in order', async () => {
  const gate = createPacingGate(20)
  const t0 = Date.now()
  const starts = await Promise.all(Array.from({ length: 9 }, async () => { await gate.wait(); return Date.now() - t0 }))
  assert.ok(starts[0] < 30)
  assert.ok(starts[8] >= 380 && starts[8] < 700, `last start at ${starts[8]}ms`)
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] >= starts[i - 1])
})

test('concurrency gate: never more than the limit in flight, and every task completes', async () => {
  const gate = createConcurrencyGate(3)
  let active = 0, peak = 0
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => gate.run(async () => {
    active++; peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 5))
    active--
    return i
  })))
  assert.equal(peak, 3)
  assert.deepEqual(results, Array.from({ length: 20 }, (_, i) => i))
  assert.equal(gate.inFlight(), 0)
})

test('concurrency gate: a failing task frees its slot', async () => {
  const gate = createConcurrencyGate(1)
  await assert.rejects(gate.run(async () => { throw new Error('boom') }))
  assert.equal(await gate.run(async () => 'ok'), 'ok')
})

test('envRate accepts only positive finite numbers', () => {
  assert.equal(envRate('10', 4), 10)
  assert.equal(envRate('0', 4), 4)
  assert.equal(envRate('abc', 4), 4)
  assert.equal(envRate(undefined, 4), 4)
})
