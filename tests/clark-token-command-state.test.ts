import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { clarkTokenReadHeading, doesClarkTokenResponseMatch, parseClarkTokenCommand } from '../lib/clark/commandFormats'
import { createClarkRequestGate } from '../lib/client/clarkRequestLifecycle'
import {
  buildTickerPickerActions,
  createTickerSearchId,
  resolveTickerPickerSelection,
  stampTickerPickerMatches,
} from '../lib/clark/tickerSelection'
import { classifyClarkMarketIntent } from '../lib/server/clarkMarketIntent'
import { classifyClarkPrompt, computeClarkTokenVerdictCore } from '../lib/server/clarkRouting'
import { classifyClarkAnalystIntent } from '../lib/server/clarkAnalystIntent'

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

test('/token current contract wins over the previous active token', () => {
  const command = parseClarkTokenCommand(`/token ${B}`)
  assert.ok(command)
  assert.equal(command.address, B)
  assert.equal(doesClarkTokenResponseMatch(command, A, B), true)
  assert.equal(doesClarkTokenResponseMatch(command, A, A), false)
})

test('newer in-flight /token request makes older response stale', () => {
  const gate = createClarkRequestGate()
  const first = gate.begin(`/token ${A}`)
  const second = gate.begin(`/token ${B}`)
  assert.equal(first.proceed, true)
  assert.equal(second.proceed, true)
  if (first.proceed && second.proceed) {
    assert.equal(first.abortSignal.aborted, true)
    assert.equal(gate.shouldApply(first.requestId), false)
    assert.equal(gate.shouldApply(second.requestId), true)
  }
})

test('fresh ticker does not accept the old active token as its response', () => {
  const command = parseClarkTokenCommand('/token BRETT')
  assert.ok(command)
  assert.equal(command.ticker, 'BRETT')
  assert.equal(doesClarkTokenResponseMatch(command, A, A), false)
  assert.equal(doesClarkTokenResponseMatch(command, A, B), true)
  assert.equal(doesClarkTokenResponseMatch(command, A, B, true), false)
})

test('Clark client and API keep explicit /token state isolated from stale context', () => {
  const root = path.resolve(import.meta.dirname, '..')
  const page = fs.readFileSync(path.join(root, 'app/terminal/clark-ai/page.tsx'), 'utf8')
  const route = fs.readFileSync(path.join(root, 'app/api/clark/route.ts'), 'utf8')
  assert.match(page, /selectedToken: tokenCommand \? null/)
  assert.match(page, /currentTokenAddress: tokenCommand \? null/)
  assert.match(page, /clarkTokenCommandAudit/)
  assert.match(route, /parseClarkTokenCommand\(body\.prompt \?\? ''\)/)
  assert.match(route, /response_token_did_not_match_current_token_command/)
  assert.match(route, /Boolean\(explicitTokenCommand\) \|\|/)
  assert.match(route, /slashCmd\.bare && slashFill\.address/)
  assert.match(route, /clarkTokenPickerRequired: true/)
  assert.match(route, /clarkTokenScanFailed: true/)
  assert.match(route, /responseTokenChain/)
  assert.match(route, /fetchTokenEvidence\(tokenAddress/)
  assert.match(route, /buildTickerPickerOptions/)
  assert.match(route, /body\.tickerSelection/)
  assert.match(route, /tickerSelectionAudit/)
  assert.match(route, /clarkIntentAudit/)
  assert.match(route, /lastTickerSearchId/)
})

test('TOKEN READ heading never uses a question mark', () => {
  assert.equal(clarkTokenReadHeading('?', A), '0xaaaa…aaaa')
  assert.equal(clarkTokenReadHeading(null, A), '0xaaaa…aaaa')
  assert.equal(clarkTokenReadHeading('PEPE', A), 'PEPE')
  assert.equal(clarkTokenReadHeading('?', null), 'unverified')
})

test('ETH/BTC/SOL price questions route to live market, /token ETH stays a ticker lookup', () => {
  assert.equal(classifyClarkMarketIntent('what is ETH price').detectedIntent, 'live_price')
  assert.equal(classifyClarkMarketIntent('what is BTC price').detectedIntent, 'live_price')
  assert.equal(classifyClarkMarketIntent('what is SOL price').detectedIntent, 'live_price')
  assert.equal(classifyClarkPrompt('what is ETH price').intent, 'live_market')
  assert.equal(classifyClarkPrompt('/token ETH').intent, 'token_scan')
  assert.equal(classifyClarkPrompt('/token ETH').symbol, 'ETH')
})

test('scan 1 is not a Base Radar route by itself', () => {
  assert.notEqual(classifyClarkAnalystIntent('scan 1').domain, 'radar')
  assert.equal(classifyClarkAnalystIntent('Scan token number 3.').domain, 'radar')
})

test('ticker option buttons carry exact tokenAddress + chainId', () => {
  const searchId = createTickerSearchId()
  const actions = buildTickerPickerActions([
    { name: 'Pepe', symbol: 'PEPE', chainSlug: 'eth', tokenAddress: A, pairAddress: null, liquidityUsd: 1, marketCapUsd: 1, fdvUsd: null, volume24hUsd: 1, confidence: 80 },
    { name: 'Brett', symbol: 'BRETT', chainSlug: 'base', tokenAddress: B, pairAddress: null, liquidityUsd: 1, marketCapUsd: 1, fdvUsd: null, volume24hUsd: 1, confidence: 70 },
  ], searchId)
  assert.equal(actions[0].prompt.includes(A), true)
  assert.equal(actions[0].tokenAddress, A)
  assert.equal(actions[0].chainId, 1)
  assert.equal(actions[1].prompt.includes(B), true)
  assert.equal(actions[1].tokenAddress, B)
  assert.equal(actions[1].chainId, 8453)
  assert.match(actions[0].prompt, /^\/token 0x/)
  assert.doesNotMatch(actions[0].prompt, /^scan 1$/i)
})

test('scan 1 and scan 2 select the displayed picker options exactly', () => {
  const searchId = 'clkts_current'
  const matches = stampTickerPickerMatches([
    { name: 'Pepe', symbol: 'PEPE', chainSlug: 'eth', tokenAddress: A, pairAddress: null, liquidityUsd: 1, marketCapUsd: 1, fdvUsd: null, volume24hUsd: 1, confidence: 80 },
    { name: 'Brett', symbol: 'BRETT', chainSlug: 'base', tokenAddress: B, pairAddress: null, liquidityUsd: 1, marketCapUsd: 1, fdvUsd: null, volume24hUsd: 1, confidence: 70 },
  ], searchId)
  const one = resolveTickerPickerSelection({ prompt: 'scan 1', matches, tickerSearchId: searchId })
  const two = resolveTickerPickerSelection({ prompt: 'scan 2', matches, tickerSearchId: searchId })
  assert.equal(one.picked?.tokenAddress, A)
  assert.equal(one.audit.selectionMatchesDisplayedOption, true)
  assert.equal(two.picked?.tokenAddress, B)
  assert.equal(two.rewritePrompt?.includes(B), true)
})

test('old ticker options cannot scan after a newer ticker search', () => {
  const current = stampTickerPickerMatches([
    { name: 'Brett', symbol: 'BRETT', chainSlug: 'base', tokenAddress: B, pairAddress: null, liquidityUsd: 1, marketCapUsd: 1, fdvUsd: null, volume24hUsd: 1, confidence: 70 },
  ], 'clkts_new')
  const stale = resolveTickerPickerSelection({
    prompt: 'scan 1',
    matches: current,
    tickerSearchId: 'clkts_new',
    incomingSearchId: 'clkts_old',
  })
  assert.equal(stale.stale, true)
  assert.equal(stale.audit.staleSearchIgnored, true)
  assert.equal(stale.picked, null)
})

test('missing LP/security is Partial/Watch, not fake High Risk', () => {
  const vocab = { ownerLabel: 'owner', mintLabel: 'mint() callable', controlLabel: 'Blacklist/transfer restriction' }
  const missing = computeClarkTokenVerdictCore({
    honeypot: null, buyTaxPct: null, sellTaxPct: null, ownerRenounced: null, mintable: null, proxy: null,
    blacklist: null, lpStatus: null, liquidityUsd: null, top1Pct: null, top10Pct: null,
    deployerRugHistoryCount: null, vocab,
  }, false)
  assert.equal(missing.verdict, 'Partial Evidence')
  const unclearLp = computeClarkTokenVerdictCore({
    honeypot: false, buyTaxPct: 1, sellTaxPct: 1, ownerRenounced: true, mintable: false, proxy: false,
    blacklist: false, lpStatus: 'unknown', liquidityUsd: 80_000, top1Pct: 4, top10Pct: 18,
    deployerRugHistoryCount: 0, vocab,
  }, true)
  assert.notEqual(unclearLp.verdict, 'High Risk')
})
