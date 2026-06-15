import assert from 'node:assert/strict'
import {
  classifyClarkPrompt,
  formatEoaLpCheckReply,
  formatBaseMarketReadFromRows,
  formatBaseRadarRead,
} from '../lib/server/clarkRouting.ts'

// ─── base_market_discovery vs base_radar ─────────────────────────────────────
assert.equal(classifyClarkPrompt("what's pumping on Base?").intent, 'base_market_discovery')
assert.equal(classifyClarkPrompt("what's pumping on Base Radar?").intent, 'base_radar')
assert.equal(classifyClarkPrompt("who's pumping on Base?").intent, 'base_market_discovery')
assert.equal(classifyClarkPrompt("show Base pumpers").intent, 'base_market_discovery')
assert.equal(classifyClarkPrompt("what tokens are moving on Base").intent, 'base_market_discovery')
assert.equal(classifyClarkPrompt("what's hot on Base").intent, 'base_market_discovery')
assert.equal(classifyClarkPrompt("Base movers").intent, 'base_market_discovery')
assert.equal(classifyClarkPrompt("Base trending tokens").intent, 'base_market_discovery')

// ─── wallet_scan ──────────────────────────────────────────────────────────────
{
  const r = classifyClarkPrompt('scan this wallet 0x1234567890123456789012345678901234567890')
  assert.equal(r.intent, 'wallet_scan')
  assert.equal(r.deep, false)
}
{
  const r = classifyClarkPrompt('deep scan this wallet 0x1234567890123456789012345678901234567890')
  assert.equal(r.intent, 'wallet_scan')
  assert.equal(r.deep, true)
}
{
  const r = classifyClarkPrompt('0x1234567890123456789012345678901234567890')
  assert.equal(r.intent, 'wallet_scan')
}

// ─── liquidity_scan ───────────────────────────────────────────────────────────
// NOTE: classifyClarkPrompt only classifies by phrase+address — it cannot know
// whether the address is an EOA or a contract (that requires eth_getCode at
// runtime). Both EOA and contract addresses classify as "liquidity_scan" here;
// the EOA-vs-contract branch behavior is tested in test-clark-execution.mjs.
{
  const r = classifyClarkPrompt('lp check 0x1234567890123456789012345678901234567890')
  assert.equal(r.intent, 'liquidity_scan')
  assert.equal(r.address, '0x1234567890123456789012345678901234567890')
}

// ─── formatting helpers behave as documented ─────────────────────────────────
assert.equal(formatBaseMarketReadFromRows([]), null)
assert.equal(formatBaseMarketReadFromRows(null), null)
assert.equal(formatBaseRadarRead([]), null)
assert.equal(formatBaseRadarRead(null), null)

const eoaReply = formatEoaLpCheckReply()
assert.ok(eoaReply.includes('wallet, not a token contract'))
assert.ok(eoaReply.includes('CTA:'))

console.log('test-clark-intent.mjs: all assertions passed')
