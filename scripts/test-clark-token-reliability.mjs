// Clark token reliability: routing, picker identity, TOKEN READ heading, no fake High Risk.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clarkTokenReadHeading, parseClarkTokenCommand } from '../lib/clark/commandFormats.ts'
import {
  buildTickerPickerActions,
  createTickerSearchId,
  resolveTickerPickerSelection,
  stampTickerPickerMatches,
} from '../lib/clark/tickerSelection.ts'
import { classifyClarkMarketIntent } from '../lib/server/clarkMarketIntent.ts'
import { classifyClarkPrompt, computeClarkTokenVerdictCore, renderClarkTokenVerdictForEvm } from '../lib/server/clarkRouting.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const route = fs.readFileSync(path.join(root, 'app/api/clark/route.ts'), 'utf8')
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
let passed = 0
function check(label, cond) {
  assert.ok(cond, label)
  passed++
}

check('/token 0xAAA parses the exact CA', parseClarkTokenCommand(`/token ${A}`)?.address === A)
check('/token 0xAAA then 0xBBB is a new command', parseClarkTokenCommand(`/token ${B}`)?.address === B)
check('route always calls fetchTokenEvidence for token_scan CAs', route.includes('const ev = await fetchTokenEvidence(tokenAddress'))
check('route does not skip Token Scanner for explicit /token', /explicitTokenCommand[\s\S]{0,200}fetchTokenEvidence/.test(route) || route.includes('fetchTokenEvidence(tokenAddress'))
check('picker buttons carry exact token identity via tickerSelection', route.includes('buildTickerPickerOptions') && route.includes('body.tickerSelection') && route.includes('resolveTickerSelection'))
check('requestId is stamped on Clark responses', route.includes('stampClarkRequestId'))
check('failed scanner copy uses an exact reason', route.includes('Token Scanner returned no usable evidence') && route.includes('TOKEN READ — unavailable'))
check('ETH price is live_price', classifyClarkMarketIntent('what is ETH price').detectedIntent === 'live_price')
check('BTC price is live_price', classifyClarkMarketIntent('what is BTC price').detectedIntent === 'live_price')
check('SOL price is live_price', classifyClarkMarketIntent('what is SOL price').detectedIntent === 'live_price')
check('/token ETH is token_scan', classifyClarkPrompt('/token ETH').intent === 'token_scan')
check('PEPE ticker command parses', parseClarkTokenCommand('/token PEPE')?.ticker === 'PEPE')

const searchId = createTickerSearchId()
const actions = buildTickerPickerActions([
  { name: 'Pepe', symbol: 'PEPE', chainSlug: 'eth', tokenAddress: A, pairAddress: null, liquidityUsd: 2_000_000, marketCapUsd: 1, fdvUsd: null, volume24hUsd: 1, confidence: 88 },
  { name: 'Pepe Base', symbol: 'PEPE', chainSlug: 'base', tokenAddress: B, pairAddress: null, liquidityUsd: 1_000_000, marketCapUsd: 1, fdvUsd: null, volume24hUsd: 1, confidence: 80 },
], searchId)
check('multiple ticker matches show numbered scan actions', actions.length === 2)
check('scan 1 button has option 1 address', actions[0].tokenAddress === A && actions[0].prompt.includes(A))
check('scan 2 button has option 2 address', actions[1].tokenAddress === B && actions[1].prompt.includes(B))

const matches = stampTickerPickerMatches([
  { name: 'Pepe', symbol: 'PEPE', chainSlug: 'eth', tokenAddress: A, pairAddress: null, liquidityUsd: 1, marketCapUsd: 1, fdvUsd: null, volume24hUsd: 1, confidence: 88 },
  { name: 'Pepe Base', symbol: 'PEPE', chainSlug: 'base', tokenAddress: B, pairAddress: null, liquidityUsd: 1, marketCapUsd: 1, fdvUsd: null, volume24hUsd: 1, confidence: 80 },
], searchId)
check('typed scan 1 hits displayed option 1', resolveTickerPickerSelection({ prompt: 'scan 1', matches, tickerSearchId: searchId }).picked?.tokenAddress === A)
check('typed scan 2 hits displayed option 2', resolveTickerPickerSelection({ prompt: 'scan 2', matches, tickerSearchId: searchId }).picked?.tokenAddress === B)
check('old search id is ignored', resolveTickerPickerSelection({ prompt: 'scan 1', matches, tickerSearchId: searchId, incomingSearchId: 'clkts_old' }).stale === true)

const ev = {
  ok: false,
  token: { name: null, symbol: null, address: A },
  market: { price: null, change24h: null, volume24h: null, liquidity: null, marketCap: null, fdv: null },
  holders: { top1: null, top10: null, holderCount: null, status: 'unavailable' },
  security: { honeypot: null, buyTax: null, sellTax: null, ownerRenounced: null, mintable: null, proxy: null, blacklist: null, securityStatus: 'unavailable', simulationStatus: 'unavailable', riskLevel: null, missing: [], missingReason: 'provider failed' },
  lpControl: null,
}
const rendered = renderClarkTokenVerdictForEvm(ev, A, 'Base', false)
check('TOKEN READ never titles with ?', !/^TOKEN READ — \?/m.test(rendered) && rendered.startsWith('TOKEN READ — '))
check('no-evidence scan is Partial Evidence not High Risk', /Partial Evidence/.test(rendered) && !/Verdict:\nHigh Risk/.test(rendered))
check('heading helper rejects ?', clarkTokenReadHeading('?', A) !== '?')

const vocab = { ownerLabel: 'owner', mintLabel: 'mint() callable', controlLabel: 'Blacklist/transfer restriction' }
const fakeRisk = computeClarkTokenVerdictCore({
  honeypot: null, buyTaxPct: null, sellTaxPct: null, ownerRenounced: null, mintable: null, proxy: null,
  blacklist: null, lpStatus: null, liquidityUsd: null, top1Pct: null, top10Pct: null,
  deployerRugHistoryCount: null, vocab,
}, false)
check('no scanner result is Partial Evidence', fakeRisk.verdict === 'Partial Evidence' && fakeRisk.riskLevel === 'Unknown')

check('/lp /holders /deployer only reuse on bare slash', /slashCmd\.bare && slashFill\.address/.test(route))
check('new /token clears lastClarkSubject', /sessionMem\.lastClarkSubject = null/.test(route) && /if \(explicitTokenCommand\)/.test(route))
check('ticker picker is echoed for cold start', route.includes('genericMemoryEcho.lastTickerMatches'))
check('picker identity uses lastTickerSearchId', route.includes('sessionMem.lastTickerSearchId') && !route.includes('createTickerSearchId(') && !route.includes('buildTickerPickerActions'))
check('explicit /token clears picker atomically', route.includes('if (explicitTokenCommand) { sessionMem.lastTickerMatches = undefined; sessionMem.lastTickerSearchId = null; }'))
check('TOKEN READ sanitize never leaves a question-mark heading', route.includes('TOKEN READ — ${clarkTokenReadHeading') && route.includes('TOKEN READ — unavailable'))

console.log(`clark-token-reliability: ${passed} assertions passed`)
