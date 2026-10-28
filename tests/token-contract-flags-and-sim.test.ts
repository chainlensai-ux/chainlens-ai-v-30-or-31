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
let alchemy: 'ok' | 'rate_limited' | 'getcode_rpc_error' | 'short_code' = 'ok'
let publicRpc: 'ok' | 'down' = 'ok'
let honeypot: 'pool_unsupported' | 'ok' = 'pool_unsupported'
let goplus: 'taxes_only' | 'full' | 'with_flags' | 'all_absent' | 'proxy_only' = 'taxes_only'
let goplusCalls = 0
const alchemyPaths: string[] = []
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
    alchemyPaths.push(url.pathname)
    if (alchemy === 'rate_limited') return new Response('{"error":"capacity"}', { status: 429 })
    const body = JSON.parse(String(init?.body))
    if (body.method === 'eth_getCode' && alchemy === 'getcode_rpc_error') return Response.json({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } })
    if (body.method === 'eth_getCode' && alchemy === 'short_code') return Response.json({ jsonrpc: '2.0', id: 1, result: '0x1234' })
    return rpcReply(JSON.parse(String(init?.body)))
  }
  if (url.host === 'mainnet.base.org') {
    rpcHits.public++
    if (publicRpc === 'down') return new Response('{}', { status: 503 })
    return rpcReply(JSON.parse(String(init?.body)))
  }
  if (url.host === 'api.honeypot.is') {
    if (honeypot === 'pool_unsupported') return Response.json({ token: {}, summary: {}, simulationSuccess: false, simulationError: 'execution reverted: HP: BUY_FAILED' })
    return Response.json({ honeypotResult: { isHoneypot: false }, simulationSuccess: true, simulationResult: { buyTax: 0, sellTax: 0, transferTax: 0 } })
  }
  if (url.host === 'api.gopluslabs.io') {
    goplusCalls++
    const addr = url.searchParams.get('contract_addresses')!
    return Response.json({ result: { [addr]: goplus === 'full' ? { is_honeypot: '0', buy_tax: '0', sell_tax: '0' } : goplus === 'with_flags' ? { buy_tax: '0', sell_tax: '0', is_mintable: '0', is_proxy: '1', is_blacklisted: '0', transfer_pausable: '0' }
      : goplus === 'all_absent' ? { is_honeypot: '0', buy_tax: '0', sell_tax: '0', is_mintable: '0', is_proxy: '0', is_blacklisted: '0', transfer_pausable: '0' }
      : goplus === 'proxy_only' ? { is_honeypot: '0', buy_tax: '0', sell_tax: '0', is_proxy: '1', is_mintable: '' } : { buy_tax: '0.01', sell_tax: '0.02' } } })
  }
  if (url.host === 'api.dexscreener.com') return Response.json({ pairs: [] })
  return new Response('{}', { status: 503 })
}) as typeof fetch
const logs: string[] = []
const realLog = console.log
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
console.log = (...args: unknown[]) => { const line = args.map(String).join(' '); if (line.includes('"evt":"token_contract_read"')) logs.push(line); else realLog(...args) }
test.after(() => { globalThis.fetch = realFetch; console.warn = realWarn; console.log = realLog; __setAuthTokenVerifierForTest(null); __setGeckoTerminalGuardForTest(null) })

let n = 0
__setAuthTokenVerifierForTest((async () => ({ userId: `flags-test-${++n}`, email: 'flags-test@example.com', plan: 'elite' })) as never)
type Body = {
  riskScore?: number
  security?: {
    contractFlags?: Record<string, boolean | null>
    contractFlagEvidence?: { flags: Record<string, boolean | null>; sources: Record<string, string | null>; confidence: Record<string, string | null>; conflicts: unknown[] }
    contractFlagsRead?: string
    contractReadDiagnostics?: { outcome: string; endpointSource: string | null; httpStatus: number | null; rpcErrorCode: number | null; retry: string | null; codeLength: number | null; scannedAt: string; build: string | null }
    tax?: { status: string }
  }
  tradingSimulationAudit?: Parameters<typeof buildTradingSimulationUi>[0]
  riskEngine?: { verifiedSignals?: string[]; openChecks?: string[]; riskDrivers?: string[]; riskScore?: number }
}
async function scan(set: () => void, fixedContract?: string): Promise<Body> {
  set(); rpcHits.alchemy = 0; rpcHits.public = 0; warnings.length = 0; logs.length = 0; alchemyPaths.length = 0; goplusCalls = 0
  __setGeckoTerminalGuardForTest({ kv: { configured: () => false, get: async () => null, set: async () => undefined }, log: () => undefined })
  const { POST } = await import('../app/api/token/route')
  const contract = fixedContract ?? '0x' + (0xb200 + ++n).toString(16).padStart(40, 'c')
  ++n
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
  assert.match(audit.finalReason, /test buy failed \(HP: BUY_FAILED\).*Selling was not tested/)
  assert.doesNotMatch(audit.finalReason, /V4|safe/i, 'BUY_FAILED proves neither a V4 limitation nor safety')
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

const NO_FLAGS = { mint: null, proxy: null, blacklist: null, pause: null, withdraw: null }
const scores = (b: Body) => ({ riskScore: b.riskScore, engine: b.riskEngine?.riskScore, drivers: b.riskEngine?.riskDrivers })

test('code read fails on both RPCs, GoPlus has contract analysis: shown as provider evidence only; scoring inputs unchanged', async () => {
  const b = await scan(() => { alchemy = 'rate_limited'; publicRpc = 'down'; honeypot = 'pool_unsupported'; goplus = 'with_flags' })
  assert.deepEqual(b.security?.contractFlags, NO_FLAGS, 'the field the CORTEX score, Clark and Base Radar read never carries provider data')
  assert.deepEqual(b.security?.contractFlagEvidence?.flags, { mint: false, proxy: true, blacklist: false, pause: false, withdraw: null })
  assert.deepEqual(b.security?.contractFlagEvidence?.sources, { mint: 'provider', proxy: 'provider', blacklist: 'provider', pause: 'provider', withdraw: null })
  assert.deepEqual(b.security?.contractFlagEvidence?.confidence, { mint: 'medium', proxy: 'medium', blacklist: 'medium', pause: 'medium', withdraw: null })
  assert.equal(b.security?.contractFlagsRead, 'provider_only')
  assert.ok(b.riskEngine?.openChecks?.some((c) => /could not be read this scan — flags shown are security-provider analysis/.test(c)), 'the RPC failure stays an evidence gap')
  assert.ok(b.riskEngine?.openChecks?.some((c) => /security-provider analysis reports a proxy\/upgradeable function — not verified on-chain/.test(c)))
  assert.ok(!b.riskEngine?.riskDrivers?.some((d) => /provider/i.test(d)), 'not a risk driver: no new scoring policy')
  assert.equal(goplusCalls, 1, 'one GoPlus read shared by the simulation fallback and Contract Flags')
})

test('risk scores are identical with and without provider flags (reported present, reported absent, or none)', async () => {
  const none = await scan(() => { alchemy = 'rate_limited'; publicRpc = 'down'; honeypot = 'ok'; goplus = 'full' })
  assert.equal(none.security?.contractFlagsRead, 'failed')
  const absent = await scan(() => { alchemy = 'rate_limited'; publicRpc = 'down'; honeypot = 'ok'; goplus = 'all_absent' })
  const present = await scan(() => { alchemy = 'rate_limited'; publicRpc = 'down'; honeypot = 'ok'; goplus = 'proxy_only' })
  assert.equal(typeof none.riskScore, 'number')
  assert.deepEqual(scores(absent), scores(none), 'zero provider flags never make a token look safer')
  assert.deepEqual(scores(present), scores(none), 'a provider-reported function adds no score')
  assert.deepEqual(absent.security?.contractFlags, NO_FLAGS)
  assert.ok((absent.riskEngine?.openChecks?.length ?? 0) >= (none.riskEngine?.openChecks?.length ?? 0), 'no evidence gap is removed')
})

test('missing and empty GoPlus fields stay unknown, never "not detected"', async () => {
  const b = await scan(() => { alchemy = 'rate_limited'; publicRpc = 'down'; honeypot = 'ok'; goplus = 'proxy_only' })
  assert.deepEqual(b.security?.contractFlagEvidence?.flags, { mint: null, proxy: true, blacklist: null, pause: null, withdraw: null })
  assert.deepEqual(b.security?.contractFlagEvidence?.sources, { mint: null, proxy: 'provider', blacklist: null, pause: null, withdraw: null })
})

test('malformed GoPlus values are unknown', async () => {
  const { goPlusContractFlagsFrom } = await import('../lib/server/goplusSecurity')
  assert.equal(goPlusContractFlagsFrom(null), null)
  assert.equal(goPlusContractFlagsFrom({}), null)
  assert.equal(goPlusContractFlagsFrom({ is_mintable: '', is_proxy: '2', is_blacklisted: 'yes', transfer_pausable: 1 }), null)
  assert.deepEqual(goPlusContractFlagsFrom({ is_mintable: ' 1', is_proxy: null, is_blacklisted: true, transfer_pausable: '0' }), { mint: null, proxy: null, blacklist: null, pause: false })
})

test('on-chain and GoPlus disagree: conflict in the evidence view, scoring keeps the on-chain answer exactly as before', async () => {
  // Bytecode has a mint selector (on-chain: present), no proxy (on-chain: absent); GoPlus says no mint, proxy.
  const b = await scan(() => { alchemy = 'ok'; publicRpc = 'ok'; honeypot = 'pool_unsupported'; goplus = 'with_flags' })
  const ev = b.security?.contractFlagEvidence
  assert.equal(ev?.flags.mint, null)
  assert.equal(ev?.flags.proxy, null)
  assert.equal(ev?.sources.mint, 'conflict')
  assert.equal(ev?.sources.proxy, 'conflict')
  assert.equal(ev?.confidence.mint, 'low')
  assert.equal(ev?.flags.blacklist, false)
  assert.equal(ev?.sources.blacklist, 'onchain')
  assert.equal(b.security?.contractFlags?.mint, true, 'scoring field: the on-chain answer, as before')
  assert.equal(b.security?.contractFlags?.proxy, false)
  assert.ok(b.riskEngine?.openChecks?.some((c) => /on-chain scan and security-provider analysis disagree on mint — unresolved/.test(c)))
  assert.ok(b.riskEngine?.openChecks?.some((c) => /on-chain scan and security-provider analysis disagree on proxy\/upgradeable — unresolved/.test(c)))
  // Same scan with GoPlus reporting no contract fields: the score must match.
  const baseline = await scan(() => { alchemy = 'ok'; publicRpc = 'ok'; honeypot = 'pool_unsupported'; goplus = 'taxes_only' })
  assert.deepEqual(scores(b), scores(baseline))
})

test('a healthy scan never reads GoPlus for Contract Flags', async () => {
  const b = await scan(() => { alchemy = 'ok'; publicRpc = 'ok'; honeypot = 'ok'; goplus = 'with_flags' })
  assert.equal(goplusCalls, 0)
  assert.equal(b.security?.contractFlagEvidence?.sources.mint, 'onchain')
  assert.equal(b.security?.contractFlagEvidence?.confidence.mint, 'high')
})

test('BASE_RPC_URL override fails: the second attempt goes to the Alchemy endpoint the V4 position index uses', async () => {
  process.env.BASE_RPC_URL = 'https://broken-rpc.example'
  try {
    const b = await scan(() => { alchemy = 'ok'; publicRpc = 'down'; honeypot = 'ok'; goplus = 'full' })
    assert.equal(b.security?.contractFlags?.mint, true)
    assert.equal(b.security?.contractFlagsRead, 'ok')
    assert.ok(warnings.some((w) => w.includes('token_rpc_read_failed') && w.includes('"retry":"alchemy"') && w.includes('"recovered":true')))
  } finally {
    delete process.env.BASE_RPC_URL
  }
})

test('the GoPlus reader is per scan and per token: one request per reader, never reused across tokens or chains', async () => {
  const { createGoPlusScanReader, fetchGoPlusHoneypotFallback } = await import('../lib/server/goplusSecurity')
  goplus = 'full'; goplusCalls = 0
  const t = '0x' + 'ab'.repeat(20)
  const r = createGoPlusScanReader(8453, t)
  await r.read(); await r.read()
  assert.equal(goplusCalls, 1)
  await createGoPlusScanReader(8453, t).read()
  assert.equal(goplusCalls, 2, 'a new scan reads again')
  assert.equal(await fetchGoPlusHoneypotFallback(8453, '0x' + 'cd'.repeat(20), r), null, 'a reader for another token is refused')
  assert.equal(await fetchGoPlusHoneypotFallback(1, t, r), null, 'a reader for another chain is refused')
})

// "Read failed" with no token_rpc_read_failed log: the paths that produce it, reproduced on the real handler.
const readLog = () => logs.map((l) => JSON.parse(l) as Record<string, unknown>)

test('a JSON-RPC error on the code read shows Read failed WITHOUT token_rpc_read_failed — now diagnosed', async () => {
  const b = await scan(() => { alchemy = 'getcode_rpc_error'; publicRpc = 'ok'; honeypot = 'ok'; goplus = 'full' })
  assert.equal(b.security?.contractFlagsRead, 'failed')
  assert.equal(warnings.filter((w) => w.includes('token_rpc_read_failed')).length, 0, 'reproduced: this path never wrote the failure log')
  assert.equal(rpcHits.public, 0, 'and was never retried')
  assert.deepEqual({ ...b.security?.contractReadDiagnostics, scannedAt: undefined, build: undefined }, { outcome: 'rpc_error', endpointSource: 'provider_key', httpStatus: 200, rpcErrorCode: 3, retry: null, codeLength: null, scannedAt: undefined, build: undefined })
  const line = readLog().find((l) => l.contractFlagsRead === 'failed')
  assert.equal(line?.outcome, 'rpc_error')
  assert.equal(line?.endpointSource, 'ALCHEMY_BASE_KEY', 'the log names the configuration variable')
  assert.ok(logs.every((l) => !l.includes('test-key') && !l.includes('alchemy.com/')), 'never the key or URL')
})

test('an endpoint answering with no real code also shows Read failed without the failure log — now diagnosed', async () => {
  const b = await scan(() => { alchemy = 'short_code'; publicRpc = 'ok'; honeypot = 'ok'; goplus = 'full' })
  assert.equal(b.security?.contractFlagsRead, 'failed')
  assert.equal(warnings.filter((w) => w.includes('token_rpc_read_failed')).length, 0)
  assert.equal(b.security?.contractReadDiagnostics?.outcome, 'no_code')
  assert.equal(b.security?.contractReadDiagnostics?.codeLength, 6)
})

test('a healthy read is diagnosed ok and never shows Read failed', async () => {
  const b = await scan(() => { alchemy = 'ok'; publicRpc = 'ok'; honeypot = 'ok'; goplus = 'full' })
  assert.equal(b.security?.contractFlagsRead, 'ok')
  assert.equal(b.security?.contractReadDiagnostics?.outcome, 'ok')
  assert.equal(readLog().length, 1, 'one diagnostic line per fresh scan')
})

test('BASE_RPC_URL takes precedence: the diagnostic names it as the endpoint source', async () => {
  process.env.BASE_RPC_URL = 'https://broken-rpc.example'
  try {
    const b = await scan(() => { alchemy = 'ok'; publicRpc = 'down'; honeypot = 'ok'; goplus = 'full' })
    assert.equal(b.security?.contractReadDiagnostics?.endpointSource, 'explicit_rpc_url')
    assert.equal(b.security?.contractReadDiagnostics?.outcome, 'recovered_on_retry')
    assert.equal(b.security?.contractReadDiagnostics?.retry, 'provider_rpc')
    assert.equal(readLog()[0]?.endpointSource, 'BASE_RPC_URL')
  } finally {
    delete process.env.BASE_RPC_URL
  }
})

test('a cached scan replays the earlier result: no read, no log, and the diagnostic keeps the original read time', async () => {
  const { POST } = await import('../app/api/token/route')
  const contract = '0x' + 'c0ffee'.padEnd(40, '0')
  alchemy = 'getcode_rpc_error'; publicRpc = 'ok'; honeypot = 'ok'; goplus = 'full'
  __setGeckoTerminalGuardForTest({ kv: { configured: () => false, get: async () => null, set: async () => undefined }, log: () => undefined })
  const req = () => POST(new Request('http://localhost/api/token', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer t', 'x-forwarded-for': `10.8.1.${++n % 250}` }, body: JSON.stringify({ contract, chain: 'base' }) }))
  const first = await (await req()).json() as Body
  logs.length = 0; warnings.length = 0
  alchemy = 'ok'
  const second = await (await req()).json() as Body & { tokenScannerChainStrictnessAudit?: { cacheHit?: boolean } }
  assert.equal(second.tokenScannerChainStrictnessAudit?.cacheHit, true)
  assert.equal(second.security?.contractFlagsRead, 'failed', 'the RPC is healthy now, but the cached Read failed is replayed')
  assert.equal(second.security?.contractReadDiagnostics?.scannedAt, first.security?.contractReadDiagnostics?.scannedAt)
  assert.equal(logs.length, 0, 'a cache hit writes no read log')
})
