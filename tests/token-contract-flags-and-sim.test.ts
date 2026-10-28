// Real POST /api/token handler against fake providers: a rate-limited contract-code read no longer blanks
// Contract Flags, a still-failed read is labelled as failed, and taxes returned without a sell-simulation
// verdict are shown as Partial instead of being hidden behind "Unavailable". No network: fetch is replaced.
import assert from 'node:assert/strict'
import test from 'node:test'
import { __setAuthTokenVerifierForTest } from '../lib/server/requireAuth'
import { __setGeckoTerminalGuardForTest } from '../lib/server/providers/geckoTerminalGuard'
import { buildTradingSimulationUi, classifyTradingSimulation } from '../lib/tradingSimulation'

process.env.ALCHEMY_BASE_KEY = 'test-key'
const WETH = '0x4200000000000000000000000000000000000006'
let alchemy: 'ok' | 'rate_limited' = 'ok'
let publicRpc: 'ok' | 'down' = 'ok'
let honeypot: 'pool_unsupported' | 'ok' = 'pool_unsupported'
let goplus: 'taxes_only' | 'full' = 'taxes_only'
const rpcHits = { alchemy: 0, public: 0 }
const warnings: string[] = []

const realFetch = globalThis.fetch
const realWarn = console.warn
const rpcReply = (body: { method: string }) => {
  if (body.method === 'eth_getCode') return Response.json({ jsonrpc: '2.0', id: 1, result: '0x6080604052' + '6340c10f19' + '00'.repeat(200) })
  if (body.method === 'eth_getStorageAt') return Response.json({ jsonrpc: '2.0', id: 1, result: '0x' + '0'.repeat(64) })
  return Response.json({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } })
}
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input))
  if (url.host === 'api.geckoterminal.com') {
    const m = url.pathname.match(/networks\/([a-z_]+)\/tokens\/(0x[0-9a-f]{40})\/pools/i)
    if (m) {
      if (m[1] !== 'base') return Response.json({ data: [] })
      return Response.json({ data: [{ id: `base_0x${'a'.repeat(40)}`, type: 'pool', attributes: { address: `0x${'a'.repeat(40)}`, name: 'TKN / WETH', reserve_in_usd: '250000', base_token_price_usd: '1.25', volume_usd: { h24: '50000' }, pool_created_at: '2026-01-01T00:00:00Z', fdv_usd: '1250000' }, relationships: { base_token: { data: { id: `base_${m[2].toLowerCase()}` } }, quote_token: { data: { id: `base_${WETH}` } }, dex: { data: { id: 'uniswap_v2_base' } } } }] })
    }
    if (/tokens\/0x[0-9a-f]{40}$/i.test(url.pathname)) return Response.json({ data: { attributes: { name: 'Token', symbol: 'TKN', price_usd: '1.25', decimals: 18 } } })
    return Response.json({ data: { attributes: { ohlcv_list: [] } } })
  }
  if (url.host === 'base-mainnet.g.alchemy.com') {
    rpcHits.alchemy++
    if (alchemy === 'rate_limited') return new Response('{"error":"capacity"}', { status: 429 })
    return rpcReply(JSON.parse(String(init?.body)))
  }
  if (url.host === 'mainnet.base.org') {
    rpcHits.public++
    if (publicRpc === 'down') return new Response('{}', { status: 503 })
    return rpcReply(JSON.parse(String(init?.body)))
  }
  if (url.host === 'api.honeypot.is') {
    if (honeypot === 'pool_unsupported') return Response.json({ token: {}, summary: {}, simulationSuccess: false, simulationError: 'Pool type is not supported for simulation' })
    return Response.json({ honeypotResult: { isHoneypot: false }, simulationSuccess: true, simulationResult: { buyTax: 0, sellTax: 0, transferTax: 0 } })
  }
  if (url.host === 'api.gopluslabs.io') {
    const addr = url.searchParams.get('contract_addresses')!
    return Response.json({ result: { [addr]: goplus === 'full' ? { is_honeypot: '0', buy_tax: '0', sell_tax: '0' } : { buy_tax: '0.01', sell_tax: '0.02' } } })
  }
  if (url.host === 'api.dexscreener.com') return Response.json({ pairs: [] })
  return new Response('{}', { status: 503 })
}) as typeof fetch
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
test.after(() => { globalThis.fetch = realFetch; console.warn = realWarn; __setAuthTokenVerifierForTest(null); __setGeckoTerminalGuardForTest(null) })

let n = 0
__setAuthTokenVerifierForTest((async () => ({ userId: `flags-test-${++n}`, email: 'flags-test@example.com', plan: 'elite' })) as never)
type Body = {
  security?: { contractFlags?: Record<string, boolean | null>; contractFlagsRead?: string; tax?: { status: string } }
  tradingSimulationAudit?: Parameters<typeof buildTradingSimulationUi>[0]
  riskEngine?: { verifiedSignals?: string[]; openChecks?: string[] }
}
async function scan(set: () => void): Promise<Body> {
  set(); rpcHits.alchemy = 0; rpcHits.public = 0; warnings.length = 0
  __setGeckoTerminalGuardForTest({ kv: { configured: () => false, get: async () => null, set: async () => undefined }, log: () => undefined })
  const { POST } = await import('../app/api/token/route')
  const contract = '0x' + (0xb200 + ++n).toString(16).padStart(40, 'c')
  const res = await POST(new Request('http://localhost/api/token', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer t', 'x-forwarded-for': `10.8.0.${n % 250}` }, body: JSON.stringify({ contract, chain: 'base' }) }))
  assert.equal(res.status, 200)
  return await res.json() as Body
}

test('Alchemy rate-limits the contract-code read: the public Base RPC answers and the flags are analysed', async () => {
  const b = await scan(() => { alchemy = 'rate_limited'; publicRpc = 'ok'; honeypot = 'ok'; goplus = 'full' })
  assert.deepEqual(b.security?.contractFlags, { mint: true, blacklist: false, pause: false, withdraw: false, proxy: false })
  assert.equal(b.security?.contractFlagsRead, 'ok')
  assert.ok(rpcHits.public > 0)
  const logged = warnings.filter((w) => w.includes('token_rpc_read_failed'))
  assert.ok(logged.some((w) => w.includes('"method":"eth_getCode"') && w.includes('"recovered":true') && w.includes('"status":429')))
  assert.ok(logged.every((w) => !w.includes('test-key') && !w.includes('alchemy.com')), 'endpoint URLs and keys are never logged')
})

test('a contract revert (no owner() function) is an answer: not retried, not logged', async () => {
  await scan(() => { alchemy = 'ok'; publicRpc = 'ok'; honeypot = 'ok'; goplus = 'full' })
  assert.equal(rpcHits.public, 0)
  assert.equal(warnings.filter((w) => w.includes('token_rpc_read_failed')).length, 0)
})

test('both RPCs fail: flags are marked as a failed read and listed as an evidence gap', async () => {
  const b = await scan(() => { alchemy = 'rate_limited'; publicRpc = 'down'; honeypot = 'ok'; goplus = 'full' })
  assert.deepEqual(b.security?.contractFlags, { mint: null, blacklist: null, pause: null, withdraw: null, proxy: null })
  assert.equal(b.security?.contractFlagsRead, 'failed')
  assert.ok(b.riskEngine?.openChecks?.some((c) => /Contract Flags: contract code could not be read/.test(c)))
})

test('honeypot.is cannot simulate the pool and GoPlus only has taxes: Partial with taxes and the real reason', async () => {
  const b = await scan(() => { alchemy = 'ok'; publicRpc = 'ok'; honeypot = 'pool_unsupported'; goplus = 'taxes_only' })
  const audit = b.tradingSimulationAudit!
  assert.equal(audit.finalStatus, 'unavailable_with_reason', 'still an open risk: classification unchanged')
  assert.equal(audit.finalReason, 'Pool type is not supported for simulation')
  const ui = buildTradingSimulationUi(audit)
  assert.equal(ui.badge, 'PARTIAL')
  assert.equal(ui.showTaxRows, true)
  assert.equal(ui.buyTaxValue, '1.0%')
  assert.equal(ui.sellTaxValue, '2.0%')
  assert.equal(ui.honeypotValue, 'Not simulated')
  assert.equal(ui.treatAsOpenRisk, true)
  assert.ok(b.riskEngine?.verifiedSignals?.includes('Tax data returned (no sell-simulation result).'))
  assert.ok(!b.riskEngine?.verifiedSignals?.includes('Trading simulation returned tax and transfer signals.'))
})

test('no taxes and no verdict stays Unavailable', () => {
  const ui = buildTradingSimulationUi(classifyTradingSimulation({ chainSlug: 'base', chainId: 8453, tokenAddress: '0x' + '1'.repeat(40), providerSelected: 'honeypot_is', requestAttempted: true, honeypotStatus: 'unavailable', honeypotReason: 'Security simulation unavailable' }))
  assert.equal(ui.badge, 'UNAVAILABLE')
  assert.equal(ui.showTaxRows, false)
})
