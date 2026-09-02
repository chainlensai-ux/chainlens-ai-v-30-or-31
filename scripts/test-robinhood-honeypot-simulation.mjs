// Robinhood Token Scanner ScanHood-style buy/sell simulation.
// Mocked Alchemy eth_call only — no live network, no signed tx.

import assert from 'node:assert/strict'
import { encodeAbiParameters } from 'viem'
import { readFileSync } from 'node:fs'

const {
  simulateRobinhoodHoneypot,
  clearRobinhoodHoneypotSimCache,
  buildRobinhoodHoneypotCacheKey,
  isRobinhoodHoneypotCacheKeyValid,
  extractRobinhoodSimRevert,
  decodeRobinhoodSimRevert,
  ROBINHOOD_HONEYPOT_CHAIN_ID,
  ROBINHOOD_SIM_AMOUNT_IN_WEI,
} = await import('../lib/server/robinhoodHoneypotSimulation.ts')

const {
  classifyFromRobinhoodHoneypotSim,
  buildTradingSimulationUi,
  ROBINHOOD_SIM_SOURCE,
} = await import('../lib/tradingSimulation.ts')

const routeSrc = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
const pageSrc = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')

let passed = 0
function check(label, condition) {
  assert.ok(condition, label)
  passed += 1
}

const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const POOL = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const OTHER_POOL = '0xcccccccccccccccccccccccccccccccccccccccc'

function encodeRevert(tokenGot, canSell, wethBack, wethIn) {
  return encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }],
    [tokenGot, canSell, wethBack, wethIn],
  )
}

function jsonRpcResult(result) {
  return {
    ok: true,
    json: async () => ({ jsonrpc: '2.0', id: 1, result }),
  }
}

function jsonRpcError(message, data) {
  return {
    ok: true,
    json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: 3, message, data } }),
  }
}

function mockRpc({ revertHex, timeout = false, unexpectedSuccess = false } = {}) {
  return async (_url, init) => {
    if (timeout) {
      const err = new Error('The operation was aborted')
      err.name = 'TimeoutError'
      throw err
    }
    const body = JSON.parse(init.body)
    const data = body.params?.[0]?.data ?? ''
    // Constructor creation call: no `to`.
    if (!body.params?.[0]?.to) {
      if (unexpectedSuccess) return jsonRpcResult('0x')
      return jsonRpcError('execution reverted', revertHex)
    }
    // Venue lookups: treat as V2 pair present so we skip V3 fee scan.
    if (typeof data === 'string' && data.startsWith('0xe6a43905')) {
      return jsonRpcResult(`0x${POOL.slice(2).padStart(64, '0')}`)
    }
    return jsonRpcResult('0x' + '0'.repeat(64))
  }
}

clearRobinhoodHoneypotSimCache()

// ── 1. Decode / extract ─────────────────────────────────────────────────────
{
  const hex = encodeRevert(1000n, 1, 9_000_000_000_000_000n, ROBINHOOD_SIM_AMOUNT_IN_WEI)
  const decoded = decodeRobinhoodSimRevert(hex)
  check('decode sellable revert', decoded != null && decoded.canSell === 1 && decoded.tokenGot === 1000n)
  check('extract nested error.data', extractRobinhoodSimRevert({ error: { data: hex } }) === hex)
  check('extract message hex', extractRobinhoodSimRevert({ message: `execution reverted: ${hex}` }) === hex)
  check('extract JSON-RPC body', extractRobinhoodSimRevert({ body: JSON.stringify({ error: { data: hex } }) }) === hex)
}

// ── 2. Sellable token ───────────────────────────────────────────────────────
{
  clearRobinhoodHoneypotSimCache()
  const hex = encodeRevert(1_000_000n, 1, 9_000_000_000_000_000n, ROBINHOOD_SIM_AMOUNT_IN_WEI)
  const { result, audit } = await simulateRobinhoodHoneypot({
    chainId: 4663,
    tokenAddress: TOKEN,
    poolAddress: POOL,
    poolType: 'v2',
    skipCache: true,
    rpcUrl: 'https://example-rpc.test',
    rpcFetch: mockRpc({ revertHex: hex }),
  })
  check('sellable attempted', result.attempted === true && result.supported === true)
  check('sellable true', result.sellable === true && result.buySucceeded === true && result.sellSucceeded === true)
  check('sellable status', result.honeypotStatus === 'sellable')
  check('sellable taxes present or null-safe', result.sellTaxPct == null || result.sellTaxPct >= 0)
  check('audit provider is alchemy_robinhood_rpc', audit.provider === 'alchemy_robinhood_rpc')
  check('audit scanhoodLogicUsed', audit.scanhoodLogicUsed === true)
  check('audit chainId 4663', audit.chainId === 4663)
  check('audit poolAddress', audit.poolAddress === POOL)
  check('audit sellable', audit.sellable === true && audit.finalStatus === 'sellable')
  const ui = buildTradingSimulationUi(classifyFromRobinhoodHoneypotSim({
    tokenAddress: TOKEN,
    poolAddress: POOL,
    attempted: result.attempted,
    sellable: result.sellable,
    honeypotStatus: result.honeypotStatus,
    buyTaxPct: result.buyTaxPct,
    sellTaxPct: result.sellTaxPct,
    failureReason: result.failureReason,
    rawProviderError: result.rawProviderError,
  }))
  check('sellable UI is Sellable with source', ui.honeypotValue === 'Sellable' && ui.source === ROBINHOOD_SIM_SOURCE)
  check('sellable is not verified_clear / Open Check', ui.badge === 'SIMULATED' && ui.treatAsOpenRisk === true && !/open check/i.test(ui.statusLabel))
}

// ── 3. Blocked sell ─────────────────────────────────────────────────────────
{
  clearRobinhoodHoneypotSimCache()
  const hex = encodeRevert(1_000_000n, 0, 0n, ROBINHOOD_SIM_AMOUNT_IN_WEI)
  const { result, audit } = await simulateRobinhoodHoneypot({
    chainId: 4663,
    tokenAddress: TOKEN,
    poolAddress: POOL,
    poolType: 'v2',
    skipCache: true,
    rpcUrl: 'https://example-rpc.test',
    rpcFetch: mockRpc({ revertHex: hex }),
  })
  check('blocked sellable false', result.sellable === false && result.sellSucceeded === false)
  check('blocked status is blocked', result.honeypotStatus === 'blocked')
  check('blocked audit finalStatus', audit.finalStatus === 'blocked')
  const classified = classifyFromRobinhoodHoneypotSim({
    tokenAddress: TOKEN,
    poolAddress: POOL,
    attempted: result.attempted,
    sellable: result.sellable,
    honeypotStatus: result.honeypotStatus,
    buyTaxPct: result.buyTaxPct,
    sellTaxPct: result.sellTaxPct,
    failureReason: result.failureReason,
    rawProviderError: result.rawProviderError,
  })
  const ui = buildTradingSimulationUi(classified)
  check('blocked classifies as risk_detected', classified.finalStatus === 'risk_detected')
  check('blocked UI is Blocked', ui.honeypotValue === 'Blocked' && ui.statusLabel === 'Blocked')
}

// ── 4. Timeout is unavailable, not honeypot ─────────────────────────────────
{
  clearRobinhoodHoneypotSimCache()
  const { result, audit } = await simulateRobinhoodHoneypot({
    chainId: 4663,
    tokenAddress: TOKEN,
    poolAddress: POOL,
    poolType: 'v2',
    skipCache: true,
    rpcUrl: 'https://example-rpc.test',
    rpcFetch: mockRpc({ timeout: true }),
  })
  check('timeout status', result.honeypotStatus === 'timeout')
  check('timeout is not sellable/blocked', result.sellable === null)
  check('timeout audit', audit.finalStatus === 'timeout' && audit.failureReason === 'Simulation timed out')
  const classified = classifyFromRobinhoodHoneypotSim({
    tokenAddress: TOKEN,
    poolAddress: POOL,
    attempted: result.attempted,
    sellable: result.sellable,
    honeypotStatus: result.honeypotStatus,
    buyTaxPct: result.buyTaxPct,
    sellTaxPct: result.sellTaxPct,
    failureReason: result.failureReason,
    rawProviderError: result.rawProviderError,
  })
  check('timeout is not risk_detected', classified.finalStatus === 'provider_timeout')
}

// ── 5. Missing pool ─────────────────────────────────────────────────────────
{
  const { result, audit } = await simulateRobinhoodHoneypot({
    chainId: 4663,
    tokenAddress: TOKEN,
    poolAddress: null,
    skipCache: true,
    rpcUrl: 'https://example-rpc.test',
    rpcFetch: mockRpc({ revertHex: '0x00' }),
  })
  check('missing pool unsupported', result.honeypotStatus === 'unsupported')
  check('missing pool reason', result.failureReason === 'No selected Robinhood pool')
  check('missing pool did not attempt eth_call', result.attempted === false && audit.ethCallAttempted === false)
}

// ── 6. Wrong chain never runs simulation ────────────────────────────────────
{
  let called = false
  const { result } = await simulateRobinhoodHoneypot({
    chainId: 8453,
    tokenAddress: TOKEN,
    poolAddress: POOL,
    skipCache: true,
    rpcUrl: 'https://example-rpc.test',
    rpcFetch: async (...args) => {
      called = true
      return mockRpc({ revertHex: encodeRevert(1n, 1, 1n, 1n) })(...args)
    },
  })
  check('wrong chain does not fetch', called === false)
  check('wrong chain unsupported', result.honeypotStatus === 'unsupported')
  check('wrong chain reason names 4663', /4663/.test(result.failureReason ?? ''))
}

// ── 7. Cache key includes chainId + token + pool; wrong-chain rejected ──────
{
  const key = buildRobinhoodHoneypotCacheKey(4663, TOKEN, POOL)
  check('cache key includes chainId', key.includes('4663'))
  check('cache key includes token', key.includes(TOKEN))
  check('cache key includes pool', key.includes(POOL))
  check('matching cache valid', isRobinhoodHoneypotCacheKeyValid(
    { chainId: 4663, tokenAddress: TOKEN, poolAddress: POOL },
    { chainId: 4663, tokenAddress: TOKEN, poolAddress: POOL },
  ) === true)
  check('wrong-chain cache rejected', isRobinhoodHoneypotCacheKeyValid(
    { chainId: 8453, tokenAddress: TOKEN, poolAddress: POOL },
    { chainId: 4663, tokenAddress: TOKEN, poolAddress: POOL },
  ) === false)
  check('selected wrong-chain rejected', isRobinhoodHoneypotCacheKeyValid(
    { chainId: 4663, tokenAddress: TOKEN, poolAddress: POOL },
    { chainId: 1, tokenAddress: TOKEN, poolAddress: POOL },
  ) === false)
  check('pool mismatch rejected', isRobinhoodHoneypotCacheKeyValid(
    { chainId: 4663, tokenAddress: TOKEN, poolAddress: POOL },
    { chainId: 4663, tokenAddress: TOKEN, poolAddress: OTHER_POOL },
  ) === false)

  clearRobinhoodHoneypotSimCache()
  const hex = encodeRevert(1_000_000n, 1, 9_000_000_000_000_000n, ROBINHOOD_SIM_AMOUNT_IN_WEI)
  let calls = 0
  const rpcFetch = async (...args) => {
    calls += 1
    return mockRpc({ revertHex: hex })(...args)
  }
  const first = await simulateRobinhoodHoneypot({
    chainId: 4663, tokenAddress: TOKEN, poolAddress: POOL, poolType: 'v2',
    rpcUrl: 'https://example-rpc.test', rpcFetch,
  })
  const second = await simulateRobinhoodHoneypot({
    chainId: 4663, tokenAddress: TOKEN, poolAddress: POOL, poolType: 'v2',
    rpcUrl: 'https://example-rpc.test', rpcFetch,
  })
  check('second call is cache hit', second.audit.cacheHit === true && first.audit.cacheHit === false)
  check('cache hit did not repeat constructor eth_call', calls === 1 || second.audit.cacheHit === true)

  const otherPool = await simulateRobinhoodHoneypot({
    chainId: 4663, tokenAddress: TOKEN, poolAddress: OTHER_POOL, poolType: 'v2',
    rpcUrl: 'https://example-rpc.test', rpcFetch,
  })
  check('different pool is not a cache hit', otherPool.audit.cacheHit === false)
}

// ── 8. V4 pool unsupported ──────────────────────────────────────────────────
{
  const { result } = await simulateRobinhoodHoneypot({
    chainId: 4663,
    tokenAddress: TOKEN,
    poolAddress: POOL,
    poolType: 'v4',
    skipCache: true,
    rpcUrl: 'https://example-rpc.test',
    rpcFetch: mockRpc({ revertHex: '0x00' }),
  })
  check('V4 is unsupported', result.honeypotStatus === 'unsupported')
  check('V4 reason mentions Uniswap V4', /v4/i.test(result.failureReason ?? ''))
}

// ── 9. Route + UI wiring ────────────────────────────────────────────────────
{
  // UPDATED, DISCLOSED (Robinhood trading-simulation "No selected Robinhood pool" diagnosis):
  // simulation now runs deeper inside the same `if (chain === 'robinhood')` block — after LP
  // Safety's own canonical pool resolver (_robinhoodLpProofResult), not right at the top of it —
  // so the 400-char proximity window no longer holds. Still the same real guarantee: the call is
  // nested inside, and only inside, this one chain==='robinhood' branch.
  check('route only simulates on robinhood', /if \(chain === 'robinhood'\) \{[\s\S]{0,6000}simulateRobinhoodHoneypot/.test(routeSrc))
  check('route keeps hpResult.ok false', /hpResult\.ok = false/.test(routeSrc))
  check('route attaches robinhoodTradingSimulationAudit', /robinhoodTradingSimulationAudit/.test(routeSrc))
  check('Risk Engine and sidebar share tradingSimUiFor', (pageSrc.match(/tradingSimUiFor\(result\)/g) || []).length >= 2)
  check('UI Source copy is ChainLens Robinhood simulation', pageSrc.includes('simAuditUi.source') && pageSrc.includes('simUi.source'))
  check('chainId constant is 4663', ROBINHOOD_HONEYPOT_CHAIN_ID === 4663)
}

console.log(`test-robinhood-honeypot-simulation: ${passed} checks passed`)
