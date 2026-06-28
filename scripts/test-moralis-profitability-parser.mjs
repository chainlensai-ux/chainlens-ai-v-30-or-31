import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const source = fs.readFileSync('lib/server/moralis.ts', 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const sandbox = { exports: {}, require, process: { env: {} }, console, fetch: async () => { throw new Error('fetch should not run') }, AbortSignal, setTimeout, clearTimeout, Map }
vm.runInNewContext(js, sandbox)

const { parseMoralisProfitabilitySummary, isUsableProviderPnlSummary, parseNumberish } = sandbox.exports
assert.equal(parseNumberish(null), null)
assert.equal(parseNumberish(undefined), null)
assert.equal(parseNumberish(Number.NaN), null)
assert.equal(parseNumberish(Infinity), null)
assert.equal(parseNumberish('not-a-number'), null)
assert.equal(parseNumberish(0), 0)
assert.equal(parseNumberish('0'), 0)
assert.equal(parseNumberish('-17941.249298805833'), -17941.249298805833)

const ethPayload = {
  total_count_of_trades: 77,
  total_trade_volume: '49211.793635730166',
  total_realized_profit_usd: '-17941.249298805833',
  total_realized_profit_percentage: -55.51,
  total_buys: 57,
  total_sells: 20,
  total_sold_volume_usd: '16892.592398160687',
  total_bought_volume_usd: '32319.201237569476',
}
const eth = parseMoralisProfitabilitySummary(ethPayload)
assert.equal(eth.totalTrades, 77)
assert.equal(eth.realizedPnlUsd, -17941.249298805833)
assert.equal(eth.realizedPnlPercent, -55.51)
assert.equal(eth.totalTradeVolumeUsd, 49211.793635730166)
assert.equal(eth.totalBoughtVolumeUsd, 32319.201237569476)
assert.equal(eth.totalSoldVolumeUsd, 16892.592398160687)
assert.equal(isUsableProviderPnlSummary(eth), true)

const base = parseMoralisProfitabilitySummary({
  total_count_of_trades: '443',
  total_trade_volume: '120000.42',
  total_realized_profit_usd: '-250.25',
  total_realized_profit_percentage: '-1.25',
  total_buys: '300',
  total_sells: '143',
  total_sold_volume_usd: '59000.21',
  total_bought_volume_usd: '61000.21',
})
assert.equal(base.totalTrades, 443)
assert.equal(base.realizedPnlUsd, -250.25)
assert.equal(base.totalTradeVolumeUsd, 120000.42)
assert.equal(base.totalBoughtVolumeUsd, 61000.21)
assert.equal(base.totalSoldVolumeUsd, 59000.21)
assert.equal(isUsableProviderPnlSummary(base), true)

console.log('moralis profitability parser checks passed')
