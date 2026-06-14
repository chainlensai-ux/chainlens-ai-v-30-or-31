import assert from 'node:assert/strict'
import { getRadarSimulationDisplay } from '../lib/baseRadarSimulation.ts'

const VALID = '0x1111111111111111111111111111111111111111'

// ─── No pool/liquidity evidence -> not attempted, explicit reason ──────────
let result = getRadarSimulationDisplay({ contract: VALID, liquidityUsd: 0, honeypot: null })
assert.equal(result.attempted, false)
assert.equal(result.status, 'open_check')
assert.equal(result.reason, 'insufficient route/pool evidence')
assert.equal(result.label, 'Simulation open check — insufficient route/pool evidence')

// ─── Invalid contract address -> not attempted ─────────────────────────────
result = getRadarSimulationDisplay({ contract: 'not-an-address', liquidityUsd: 10_000, honeypot: null })
assert.equal(result.attempted, false)
assert.equal(result.reason, 'insufficient route/pool evidence')

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

// ─── Simulation attempted but result missing (timeout) -> explicit reason ──
result = getRadarSimulationDisplay({ contract: VALID, liquidityUsd: 10_000, honeypot: null })
assert.equal(result.attempted, true)
assert.equal(result.status, 'open_check')
assert.equal(result.reason, 'timeout')
assert.equal(result.label, 'Simulation open check — timeout')
assert.equal(result.cortexLine, 'Buy/sell simulation timed out, so tax and honeypot status are not confirmed yet.')
assert.ok(!/remains open check because timeout/i.test(result.cortexLine), 'timeout CORTEX line must not use the lazy "remains open check" wording')

// ─── Simulation attempted but provider reports failure -> explicit reason ──
result = getRadarSimulationDisplay({ contract: VALID, liquidityUsd: 10_000, honeypot: { simulationSuccess: false } })
assert.equal(result.attempted, true)
assert.equal(result.status, 'open_check')
assert.equal(result.reason, 'unsupported pool model')
assert.equal(result.label, 'Simulation open check — unsupported pool model')

// ─── SPHINCS-style fixture: pool/liquidity evidence but no pair address ────
result = getRadarSimulationDisplay({ contract: VALID, liquidityUsd: 23_568, pairAddress: null, honeypot: null })
assert.equal(result.attempted, false)
assert.equal(result.status, 'open_check')
assert.equal(result.reason, 'missing pair address')
assert.equal(result.label, 'Simulation open check — missing pair address')

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
