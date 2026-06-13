import assert from 'node:assert/strict'
import { getRadarSimulationDisplay } from '../lib/baseRadarSimulation.ts'

const VALID = '0x1111111111111111111111111111111111111111'

// ─── No pool/liquidity evidence -> not attempted, explicit reason ──────────
let result = getRadarSimulationDisplay({ contract: VALID, liquidityUsd: 0, honeypot: null })
assert.equal(result.attempted, false)
assert.equal(result.status, 'open_check')
assert.equal(result.reason, 'insufficient_route')
assert.equal(result.label, 'Route evidence missing')

// ─── Invalid contract address -> not attempted ─────────────────────────────
result = getRadarSimulationDisplay({ contract: 'not-an-address', liquidityUsd: 10_000, honeypot: null })
assert.equal(result.attempted, false)
assert.equal(result.reason, 'insufficient_route')

// ─── Valid token + pool evidence -> simulation is attempted ────────────────
result = getRadarSimulationDisplay({ contract: VALID, liquidityUsd: 10_000, honeypot: { simulationSuccess: true, isHoneypot: false, buyTax: 2, sellTax: 3 } })
assert.equal(result.attempted, true)

// ─── Passed simulation -> real tax values, no open-check label ─────────────
assert.equal(result.status, 'passed')
assert.equal(result.reason, null)
assert.equal(result.buyTax, 2)
assert.equal(result.sellTax, 3)
assert.equal(result.label, 'B 2.0% / S 3.0%')
assert.ok(!/unconfirmed|open check/i.test(result.label))

// ─── Simulation attempted but result missing -> provider unavailable, not timeout ──
result = getRadarSimulationDisplay({ contract: VALID, liquidityUsd: 10_000, honeypot: null })
assert.equal(result.attempted, true)
assert.equal(result.status, 'open_check')
assert.equal(result.reason, 'provider_unavailable')
assert.equal(result.label, 'Simulation temporarily unavailable')

// ─── Simulation attempted but provider reports failure -> explicit reason ──
result = getRadarSimulationDisplay({ contract: VALID, liquidityUsd: 10_000, honeypot: { simulationSuccess: false } })
assert.equal(result.attempted, true)
assert.equal(result.status, 'open_check')
assert.equal(result.reason, 'unsupported_pool_model')
assert.equal(result.label, 'Simulation unsupported')

// ─── SPHINCS-style fixture: pool/liquidity evidence but no pair address ────
result = getRadarSimulationDisplay({ contract: VALID, liquidityUsd: 23_568, pairAddress: null, honeypot: null })
assert.equal(result.attempted, false)
assert.equal(result.status, 'open_check')
assert.equal(result.reason, 'missing_pair_address')
assert.equal(result.label, 'Pair route missing')

// ─── Orbit-style fixture: simulation passed with 0% buy / 0% sell ──────────
result = getRadarSimulationDisplay({ contract: VALID, liquidityUsd: 2.45, honeypot: { simulationSuccess: true, isHoneypot: false, buyTax: 0, sellTax: 0 } })
assert.equal(result.attempted, true)
assert.equal(result.status, 'passed')
assert.equal(result.reason, null)
assert.equal(result.buyTax, 0)
assert.equal(result.sellTax, 0)
assert.equal(result.label, 'B 0.0% / S 0.0%')
assert.ok(!/unconfirmed/i.test(result.cortexLine), 'CORTEX must not say simulation unconfirmed when it passed')
assert.equal(result.cortexLine, 'Buy/sell simulation passed — values reflect the latest simulation result.')

console.log('base radar simulation tests passed')

// Additional reason-label regressions.
{
  const missing = getRadarSimulationDisplay({ contract: '0x1111111111111111111111111111111111111111', liquidityUsd: 10000, pairAddress: null, honeypot: null })
  assert('missing pair returns Pair route missing', missing.label === 'Pair route missing' && missing.reason === 'missing_pair_address', missing)
  const unsupported = getRadarSimulationDisplay({ contract: '0x1111111111111111111111111111111111111111', liquidityUsd: 10000, pairAddress: '0x2222222222222222222222222222222222222222', honeypot: { simulationSuccess: false } })
  assert('unsupported pool returns Simulation unsupported', unsupported.label === 'Simulation unsupported' && unsupported.reason === 'unsupported_pool_model', unsupported)
  const unavailable = getRadarSimulationDisplay({ contract: '0x1111111111111111111111111111111111111111', liquidityUsd: 10000, pairAddress: '0x2222222222222222222222222222222222222222', honeypot: { simulationSuccess: null, failureReason: 'provider_unavailable' } })
  assert('provider unavailable is not timeout', unavailable.reason === 'provider_unavailable' && unavailable.label === 'Simulation temporarily unavailable', unavailable)
  const timeout = getRadarSimulationDisplay({ contract: '0x1111111111111111111111111111111111111111', liquidityUsd: 10000, pairAddress: '0x2222222222222222222222222222222222222222', honeypot: { simulationSuccess: null, failureReason: 'timeout_after_retry' } })
  assert('timeout appears only for timeout reason', timeout.reason === 'timeout_after_retry' && timeout.label === 'Tax check timed out', timeout)
}
