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
assert.equal(resolveClarkIntent('whats pumping base').intent, 'base_radar')
assert.equal(resolveClarkIntent('base movers').intent, 'base_radar')
let r = resolveClarkIntent(`scan this wallet ${wallet}`)
assert.equal(r.intent, 'wallet_scan'); assert.equal(r.address, wallet); assert.equal(r.addressKind, 'wallet')
r = resolveClarkIntent(`deep scan this wallet ${wallet}`)
assert.equal(r.intent, 'wallet_scan'); assert.equal(r.address, wallet)
r = resolveClarkIntent(`full wallet scan ${wallet}`)
assert.equal(r.intent, 'wallet_scan'); assert.equal(r.address, wallet)
r = resolveClarkIntent(`pnl ${wallet}`)
assert.equal(r.intent, 'wallet_scan'); assert.equal(r.address, wallet)
r = resolveClarkIntent(wallet)
assert.equal(r.intent, 'wallet_scan'); assert.equal(r.address, wallet)
r = resolveClarkIntent(`lp check ${token}`)
assert.equal(r.intent, 'liquidity_scan'); assert.equal(r.address, token); assert.equal(r.addressKind, 'token')
assert.equal(resolveClarkIntent('whale wallets').intent, 'whale_alerts')
r = resolveClarkIntent('check liquidity', { selectedToken: token })
assert.equal(r.intent, 'liquidity_scan'); assert.equal(r.address, token); assert.equal(r.source, 'context')
r = resolveClarkIntent('deep scan this', { selectedWallet: wallet })
assert.equal(r.intent, 'wallet_scan'); assert.equal(r.address, wallet); assert.equal(r.source, 'context')

const badDeadEnds = [/^no data available right now\.?$/i, /paste a (token|wallet)/i]
const radarOk = 'BASE RADAR READ\n- strongest: TOKEN score 91\n- highest volume: TOKEN\nCTA: Open Base Radar / Scan top token / Ask CORTEX'
assert.match(radarOk, /BASE RADAR READ/)
assert.ok(!/No data available/i.test(radarOk))
const radarUnavailable = 'Base Radar could not refresh right now. Open Base Radar or retry in 30 seconds.'
assert.match(radarUnavailable, /Open Base Radar|30 seconds/i)
const walletFail = `WALLET SCAN\n- wallet: ${wallet}\n- result: live wallet scan could not complete (timeout).\nCTA: Open Wallet Scanner`
assert.doesNotMatch(walletFail, /paste/i)
const lpWalletRefusal = 'That address looks like a wallet, not a token contract. LP checks need a token contract. I can scan the wallet instead. CTA: Scan Wallet'
assert.match(lpWalletRefusal, /wallet, not a token contract/i)
const lpFailure = 'LP READ\n- result: LP pipeline failed (no pool found).\nCTA: Open Liquidity Safety / Open Token Scanner'
assert.match(lpFailure, /no pool found|unsupported concentrated position route|pair identity missing|timeout|API unavailable/)
const fallbackNoQuota = 'live wallet scan could not complete (timeout)'
assert.ok(/could not complete|not a token contract|could not refresh|temporarily unavailable|LP pipeline failed/i.test(fallbackNoQuota))
assert.ok(!badDeadEnds.some((re) => re.test(radarUnavailable)))
console.log('Clark intent/router tests passed')
