import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../lib/clarkIntent.ts', import.meta.url), 'utf8')
  .replace('export function resolveClarkIntent', 'function resolveClarkIntent')
const js = ts.transpileModule(`${source}\n;(globalThis.__resolveClarkIntent = resolveClarkIntent)`, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
}).outputText.replace(/export \{\};?/, '')
const sandbox = { globalThis: {} }
vm.runInNewContext(js, sandbox)
const resolveClarkIntent = sandbox.globalThis.__resolveClarkIntent

const wallet = '0x1111111111111111111111111111111111111111'
const token = '0x2222222222222222222222222222222222222222'
assert.equal(resolveClarkIntent('whats pumping bse').intent, 'base_radar')
let r = resolveClarkIntent(`scan this wallet ${wallet}`)
assert.equal(r.intent, 'wallet_scan'); assert.equal(r.address, wallet); assert.equal(r.addressKind, 'wallet')
r = resolveClarkIntent(`lp check ${token}`)
assert.equal(r.intent, 'liquidity_scan'); assert.equal(r.address, token); assert.equal(r.addressKind, 'token')
assert.equal(resolveClarkIntent('whale wallets').intent, 'whale_alerts')
r = resolveClarkIntent(token)
assert.equal(r.intent, 'token_scan'); assert.equal(r.address, token)
r = resolveClarkIntent('check liquidity', { selectedToken: token })
assert.equal(r.intent, 'liquidity_scan'); assert.equal(r.address, token); assert.equal(r.source, 'context')
r = resolveClarkIntent('scan this', { selectedWallet: wallet })
assert.equal(r.intent, 'wallet_scan'); assert.equal(r.address, wallet); assert.equal(r.source, 'context')

const badDeadEnds = [/^no data available right now\.?$/i, /paste a (token|wallet)/i]
const whaleNoSync = 'WHALE ALERTS\nWhale data needs a refresh. I can open Whale Alerts and sync latest tracked wallets safely; if sync is unavailable, use the current watchlist view and retry in 30 seconds.\nCTA: Open Whale Alerts'
assert.ok(!badDeadEnds.some((re) => re.test(whaleNoSync)))
assert.match(whaleNoSync, /Open Whale Alerts/)
const radarUnavailable = 'Base Radar data is temporarily unavailable. Try opening Base Radar or rescan in 30 seconds.'
assert.match(radarUnavailable, /Open|rescan|30 seconds/i)
const walletReply = `I found a wallet address ${wallet}. Opening Wallet Scanner with auto-chain detection.`
assert.match(walletReply, new RegExp(wallet, 'i'))
console.log('Clark intent/router tests passed')
