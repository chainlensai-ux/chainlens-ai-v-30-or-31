import assert from 'node:assert/strict'
import fs from 'node:fs'
import { resolvePumpIntelligenceChain, toPumpIntelligenceChain, classifyClarkPrompt } from '../lib/server/clarkRouting.ts'

// Clark/CORTEX audit Item 12: Pump Intelligence must use the exact asset/list chain.
// Never hardcode Base when the token/list identity is ETH/Robinhood/Solana.
// Do NOT change major-asset (ETH/BTC/SOL/BNB) market intent routing.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
assert.doesNotMatch(
  routeSrc,
  /async function handlePumpIntelligenceQuestion\([\s\S]{0,400}chain:\s*"base"\s*\}/,
  'handlePumpIntelligenceQuestion must not hardcode chain: "base"',
)
assert.match(routeSrc, /resolvePumpIntelligenceChain\(/, 'pump analysis branch resolves chain from asset/list identity')
assert.match(routeSrc, /chain=\$\{pumpChain\}/, 'Pump Report CTA retains the resolved chain')
assert.match(routeSrc, /Unsupported: Pump Intelligence reports Base, Ethereum, and Robinhood Chain only/, 'unsupported chains must not fall through to Base')

// Major-asset market intent must stay untouched (not reclassified as pump_analysis).
assert.notEqual(classifyClarkPrompt('What is BTC doing?').intent, 'pump_analysis')
assert.notEqual(classifyClarkPrompt("What's ETH price?").intent, 'pump_analysis')
assert.equal(classifyClarkPrompt("What's pumping on Base?").intent, 'base_market_discovery')

const ADDR = '0x' + 'a'.repeat(40)

assert.equal(toPumpIntelligenceChain('ethereum'), 'eth')
assert.equal(toPumpIntelligenceChain('eth'), 'eth')
assert.equal(toPumpIntelligenceChain('robinhood'), 'robinhood')
assert.equal(toPumpIntelligenceChain('solana'), 'unsupported')
assert.equal(toPumpIntelligenceChain('bnb'), 'unsupported')
assert.equal(toPumpIntelligenceChain(null), null)

assert.equal(resolvePumpIntelligenceChain({ contract: ADDR }), 'base', 'unknown identity still defaults to the Pump Intelligence product chain')

assert.equal(resolvePumpIntelligenceChain({
  contract: ADDR,
  lastToken: { address: ADDR, chain: 'eth' },
}), 'eth')

assert.equal(resolvePumpIntelligenceChain({
  contract: ADDR,
  lastToken: { address: ADDR, chain: 'ethereum' },
}), 'eth')

assert.equal(resolvePumpIntelligenceChain({
  contract: ADDR,
  lastMomentumList: [{ address: ADDR, chain: 'robinhood' }],
}), 'robinhood')

assert.equal(resolvePumpIntelligenceChain({
  contract: ADDR,
  lastToken: { address: ADDR, chain: 'solana' },
}), 'unsupported', 'known Solana identity must not fall through to Base')

assert.equal(resolvePumpIntelligenceChain({
  contract: ADDR,
  prompt: `why is this pumping on ethereum ${ADDR}`,
  lastToken: { address: ADDR, chain: 'base' },
}), 'eth', 'explicit prompt chain wins')

assert.equal(resolvePumpIntelligenceChain({
  contract: ADDR,
  lastToken: { address: '0x' + 'b'.repeat(40), chain: 'eth' },
}), 'base', 'a different lastToken must not steal this contract onto ETH')

console.log('test-clark-pump-chain.mjs: all assertions passed')
