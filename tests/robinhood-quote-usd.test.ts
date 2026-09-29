// Robinhood Chain V4 quote-asset -> historical USD (lib/server/chainAssetRegistry.ts +
// lib/server/v4SwapCandlesRpc.ts + lib/server/v4QuoteUsd.ts).
//
// Live failure (preview 9ce7cb7): Robinhood WETH was only usable after a runtime WETH9() read; when that
// read did not prove it, the independent quote lane's anchors were {native 0x0} alone — an address no
// ordinary GeckoTerminal pool ever lists — so every arbitrary quote token failed discovery. WETH
// 0x0bd7…ad73 is now statically verified from Uniswap's official deployments/4663.md (the _WETH9 of the
// V3 NPM, V4 PositionManager, SwapRouter02, QuoterV2 and UniversalRouter), so it is always an anchor.
// Token / pool addresses are fixtures, except the registry's own Robinhood WETH / manager addresses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem'
import { V4_INITIALIZE_TOPIC0, V4_POOL_MANAGER_ABI, type RawEvmLog } from '../lib/v4SwapCandles.ts'
import { V4_SWAP_CHAIN_CONFIG, explainQuoteFailure, loadV4SwapCandles, loadV4SwapHistoryWindow, quoteLaneSelection, resetV4SwapCandleCache, type V4SwapDeps } from '../lib/server/v4SwapCandlesRpc.ts'
import { CHAIN_ASSET_REGISTRY, classifyQuoteAsset, normalPoolAnchors } from '../lib/server/chainAssetRegistry.ts'
import { QUOTE_POOL_MIN_LIQUIDITY_USD, providerIdAddress, resetQuoteUsdCache, resolveIndependentQuoteUsd, resolveIndependentQuoteUsdWindow, selectIndependentQuotePool, type QuoteUsdDeps } from '../lib/server/v4QuoteUsd.ts'
import { ROBINHOOD_SIM_V2_ROUTER, ROBINHOOD_SIM_V3_ROUTER, ROBINHOOD_SIM_WETH } from '../lib/server/robinhoodHoneypotSimulation.ts'
import { EVM_MAX_OHLCV_CALLS, runEvmCandleLadder, type LadderPool } from '../lib/evmChartCandles.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const NATIVE = '0x0000000000000000000000000000000000000000'
const RH_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const RH_WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
const BASE_WETH = '0x4200000000000000000000000000000000000006'
const ETH_WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const ETH_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const POOL = ('0x' + '9f3c'.repeat(16)) as Hex
const TOKEN = '0xf1bc0c42215582d5a085795f4badbac3ff36d1bc'
const QT = '0x2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a' // arbitrary quote token
const FAKE_WETH = '0x3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b'
const FAKE_USDC = '0x4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c'
const THIRD = '0x5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d'
const QT_WETH_POOL = '0x' + '61'.repeat(20)
const QT_THIRD_POOL = '0x' + '62'.repeat(20)
const QT_WETH_THIN = '0x' + '63'.repeat(20)
const QT_WETH_SMALLER = '0x' + '64'.repeat(20)
const SENDER = '0x000000000000000000000000000000000000beef'
const Q96 = BigInt(2) ** BigInt(96)
const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`
const NOW_TS = 1_800_000_000
const LATEST = 9_000_000
const BLOCK_SEC = 0.25
const INIT_BLOCK = LATEST - 3 * 345_600
const tsOf = (b: number) => Math.round(NOW_TS - (LATEST - b) * BLOCK_SEC)

function initLog(c0: string, c1: string): RawEvmLog {
  const topics = encodeEventTopics({ abi: V4_POOL_MANAGER_ABI, eventName: 'Initialize', args: { id: POOL, currency0: c0 as Hex, currency1: c1 as Hex } })
  const data = encodeAbiParameters([{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }], [3000, 60, NATIVE, Q96, 0])
  return { address: RH_MANAGER, topics: topics as string[], data, blockNumber: hex(INIT_BLOCK), logIndex: '0x0' }
}
// price0in1 = 1000: one quote unit buys 1000 TOKEN, so TOKEN/USD = quoteUsd / 1000.
function swapLog(block: number): RawEvmLog {
  const topics = encodeEventTopics({ abi: V4_POOL_MANAGER_ABI, eventName: 'Swap', args: { id: POOL, sender: SENDER } })
  const data = encodeAbiParameters([{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }], [BigInt(-1e16), BigInt(1e19), BigInt(Math.round(Math.sqrt(1000) * 2 ** 96)), BigInt(1e18), 0, 3000])
  return { address: RH_MANAGER, topics: topics as string[], data, blockNumber: hex(block), logIndex: '0x0', blockTimestamp: hex(tsOf(block)) }
}

/** Robinhood RPC: headers, the pool's Initialize, a swap every 5 minutes, and ERC-20 decimals(). */
function fakeRpc(quote: string, opts: { decimals?: number | 'error' } = {}) {
  const calls: Array<{ method: string; to?: string; data?: string }> = []
  const rpc: V4SwapDeps['rpc'] = async (method, params) => {
    if (method === 'eth_call') {
      const { to, data } = params[0] as { to: string; data: string }
      calls.push({ method, to: to.toLowerCase(), data })
      return opts.decimals === 'error' ? { result: null, error: true } : { result: hex(opts.decimals ?? 18), error: false }
    }
    calls.push({ method })
    if (method === 'eth_getBlockByNumber') {
      const tag = params[0] as string
      const b = tag === 'latest' ? LATEST : Number(BigInt(tag))
      return { result: { number: hex(b), timestamp: hex(tsOf(b)) }, error: false }
    }
    const f = params[0] as { topics: string[]; fromBlock: string; toBlock: string }
    if (f.topics[0] === V4_INITIALIZE_TOPIC0) return { result: [initLog(quote, TOKEN)], error: false }
    const from = Number(BigInt(f.fromBlock))
    const to = Number(BigInt(f.toBlock))
    const step = Math.round(300 / BLOCK_SEC)
    const out: RawEvmLog[] = []
    for (let b = Math.ceil(from / step) * step; b <= to; b += step) out.push(swapLog(b))
    return { result: out, error: false }
  }
  return { rpc, calls }
}
const ethSeries = (usd: number, calls?: string[]) => async () => { calls?.push('eth_usd'); return { points: Array.from({ length: 300 }, (_, i) => [(NOW_TS - 24 * 3600 + i * 300) * 1000, usd] as [number, number]), cacheHit: false } }

type FixturePool = { address: string; other: string; reserve: number | null; dex?: string; id?: string; quoteIsBase?: boolean }
// GeckoTerminal-shaped discovery for a Robinhood quote token (network 'robinhood').
function discovery(quote: string, symbol: string, pools: FixturePool[], opts: { decimals?: number | null } = {}) {
  return {
    data: pools.map((p) => ({
      id: p.id ?? `robinhood_${p.address}`, type: 'pool', attributes: { address: p.address, reserve_in_usd: p.reserve == null ? null : String(p.reserve) },
      relationships: {
        base_token: { data: { id: `robinhood_${p.quoteIsBase === false ? p.other : quote}`, type: 'token' } },
        quote_token: { data: { id: `robinhood_${p.quoteIsBase === false ? quote : p.other}`, type: 'token' } },
        dex: { data: { id: p.dex ?? 'uniswap_v2_robinhood', type: 'dex' } },
      },
    })),
    included: [
      { id: `robinhood_${quote}`, type: 'token', attributes: { address: quote, symbol, ...(opts.decimals === null ? { decimals: null } : { decimals: opts.decimals ?? 18 }) } },
      { id: `robinhood_${RH_WETH}`, type: 'token', attributes: { address: RH_WETH, symbol: 'WETH', decimals: 18 } },
    ],
  }
}
/** The independent pool's own 5m USD candles for the quote token (newest first), flat at `usd`. */
function quoteDeps(json: unknown, usd = 2, provider = 'geckoterminal') {
  const calls: string[] = []
  const deps: QuoteUsdDeps = {
    now: () => NOW_TS * 1000,
    fetchTokenPools: async (_c, token) => { calls.push(`pools ${token}`); return { json, httpStatus: 200 } },
    fetchPoolUsdOhlcv: async (_c, pool, side) => {
      calls.push(`ohlcv ${pool} ${side}`)
      const rows = Array.from({ length: 290 }, (_, i) => [NOW_TS - 300 - i * 300, usd, usd, usd, usd, 10])
      return { json: { data: { attributes: { ohlcv_list: rows } } }, httpStatus: 200, provider }
    },
  }
  return { deps, calls }
}
const reset = () => { resetV4SwapCandleCache(); resetQuoteUsdCache() }
const input = (livePriceUsd: number) => ({ chain: 'robinhood', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd })
function deps(f: ReturnType<typeof fakeRpc>, q?: ReturnType<typeof quoteDeps>, ethCalls?: string[], nowMs = NOW_TS * 1000): V4SwapDeps {
  return { rpc: f.rpc, now: () => nowMs, ethUsdSeries: ethSeries(3000, ethCalls), ...(q ? { quoteUsd: (i) => resolveIndependentQuoteUsd({ chain: 'robinhood', ...i }, q.deps) } : {}) }
}

// ── Registry / evidence ──────────────────────────────────────────────────────────────────────────
test('1. Robinhood WETH is statically verified and always a usable anchor (no runtime proof read)', () => {
  const rh = CHAIN_ASSET_REGISTRY.robinhood
  assert.deepEqual([rh.chainId, rh.native.address, rh.native.coinId], [4663, NATIVE, 'ethereum'])
  assert.deepEqual([rh.wrappedNative?.address, rh.wrappedNative?.decimals], [RH_WETH, 18])
  assert.match(rh.wrappedNative!.source, /deployments\/4663\.md/)
  assert.equal(rh.verifiedUsdStables.length, 0, 'no verified Robinhood USD stable')
  assert.deepEqual(V4_SWAP_CHAIN_CONFIG.robinhood.nativeLike, { [NATIVE]: 18, [RH_WETH]: 18 })
  assert.deepEqual(V4_SWAP_CHAIN_CONFIG.robinhood.usdStable, {})
  assert.ok(quoteLaneSelection('robinhood').anchors.has(RH_WETH))
  assert.deepEqual(normalPoolAnchors('robinhood'), [RH_WETH])
  // Cross-evidence already in the repo agrees with the same Uniswap deployment metadata: the live trading
  // simulation's WETH / SwapRouter02 / V2 router, and lpProof's NPM + PoolManager + PositionManager.
  assert.equal(ROBINHOOD_SIM_WETH.toLowerCase(), RH_WETH)
  assert.equal(ROBINHOOD_SIM_V3_ROUTER, '0xcaf681a66d020601342297493863e78c959e5cb2', 'SwapRouter02 in deployments/4663.md')
  assert.equal(ROBINHOOD_SIM_V2_ROUTER, '0x89e5db8b5aa49aa85ac63f691524311aeb649eba', 'UniswapV2Router02 in deployments/4663.md')
  assert.match(read('lib/server/lpProof.ts'), /raw\.githubusercontent\.com\/Uniswap\/contracts\/main\/deployments\/4663\.md/)
  assert.doesNotMatch(read('lib/server/chainAssetRegistry.ts'), /process\.env|fetch\(|eth_call/, 'no runtime proof, no secrets')
})

test('12. Base / ETH / BNB registry values and lane ranking are exactly as before', () => {
  assert.deepEqual(V4_SWAP_CHAIN_CONFIG.base.nativeLike, { [NATIVE]: 18, [BASE_WETH]: 18 })
  assert.deepEqual(V4_SWAP_CHAIN_CONFIG.base.usdStable, { '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6, '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 6 })
  assert.deepEqual(V4_SWAP_CHAIN_CONFIG.eth.nativeLike, { [NATIVE]: 18, [ETH_WETH]: 18 })
  assert.deepEqual(V4_SWAP_CHAIN_CONFIG.eth.usdStable, { [ETH_USDC]: 6, '0xdac17f958d2ee523a2206206994597c13d831ec7': 6 })
  assert.deepEqual(V4_SWAP_CHAIN_CONFIG.bnb.nativeLike, { [NATIVE]: 18, '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 18 })
  assert.deepEqual(V4_SWAP_CHAIN_CONFIG.bnb.usdStable, { '0x55d398326f99059ff775485246999027b3197955': 18, '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 18 })
  for (const c of ['base', 'eth', 'bnb']) assert.equal(quoteLaneSelection(c).anchorPriority, 'liquidity', `${c}: most liquid anchored pool, unchanged`)
  assert.equal(quoteLaneSelection('robinhood').anchorPriority, 'wrapped_native_first')
  assert.equal(QUOTE_POOL_MIN_LIQUIDITY_USD, 25_000, 'one $25k floor on every chain (no product policy supports a lower Robinhood floor)')
})

test('8. wrong-chain canonical addresses are rejected (exact address, exact chain)', () => {
  assert.equal(classifyQuoteAsset('robinhood', BASE_WETH), 'arbitrary_quote', 'Base WETH on Robinhood')
  assert.equal(classifyQuoteAsset('robinhood', ETH_WETH), 'arbitrary_quote', 'Ethereum WETH on Robinhood')
  assert.equal(classifyQuoteAsset('robinhood', ETH_USDC), 'arbitrary_quote', 'Ethereum USDC on Robinhood')
  assert.equal(classifyQuoteAsset('base', RH_WETH), 'arbitrary_quote', 'Robinhood WETH on Base')
  assert.equal(classifyQuoteAsset('robinhood', RH_WETH), 'verified_wrapped_native')
  assert.equal(classifyQuoteAsset('robinhood', NATIVE), 'native')
  assert.equal(classifyQuoteAsset('eth', ETH_USDC), 'verified_stable')
  assert.equal(classifyQuoteAsset('polygon', ETH_USDC), 'unverified', 'unregistered chain')
  // And a wrong-chain WETH as the other side of a normal pool is not an anchor on Robinhood.
  const sel = selectIndependentQuotePool(discovery(QT, 'QT', [{ address: QT_WETH_POOL, other: BASE_WETH, reserve: 5e6 }]), { quoteToken: QT, scannedToken: TOKEN, excludePool: POOL, ...quoteLaneSelection('robinhood') })
  assert.deepEqual([sel.choice, sel.debug?.candidates[0].rejected], [null, 'wrong_anchor'])
})

// ── Discovery parser ─────────────────────────────────────────────────────────────────────────────
test('5. native 0x0 alone is NOT a sufficient anchor for normal-pool discovery (the pre-fix failure)', () => {
  const pools = [{ address: QT_WETH_POOL, other: RH_WETH, reserve: 300_000 }]
  const before = selectIndependentQuotePool(discovery(QT, 'QT', pools), { quoteToken: QT, scannedToken: TOKEN, excludePool: POOL, anchors: new Set([NATIVE]) })
  assert.deepEqual([before.choice, before.failure, before.debug?.anchoredFound, before.debug?.candidates[0].rejected], [null, 'quote_pool_not_found', 0, 'wrong_anchor'])
  const after = selectIndependentQuotePool(discovery(QT, 'QT', pools), { quoteToken: QT, scannedToken: TOKEN, excludePool: POOL, ...quoteLaneSelection('robinhood') })
  assert.equal(after.choice?.pool, QT_WETH_POOL)
})

test('6. malformed GeckoTerminal pool ids are rejected; any network slug (incl. underscores) parses', () => {
  assert.equal(providerIdAddress(`robinhood_${QT}`), QT)
  assert.equal(providerIdAddress(`robinhood_chain_${QT}`), QT, 'slug with an underscore')
  assert.equal(providerIdAddress(QT.toUpperCase().replace('0X', '0x')), QT)
  assert.equal(providerIdAddress('robinhood_0x1234'), null)
  assert.equal(providerIdAddress(`robinhood_${POOL}`), null, '64-hex V4 id is not a pool address')
  const json = discovery(QT, 'QT', [
    { address: QT_WETH_POOL, other: RH_WETH, reserve: 900_000, id: 'robinhood_0xnotanaddress' }, // id/address disagree
    { address: POOL, other: RH_WETH, reserve: 900_000 }, // V4 PoolId, not an ordinary pool
    { address: QT_WETH_SMALLER, other: RH_WETH, reserve: 60_000 },
  ])
  const sel = selectIndependentQuotePool(json, { quoteToken: QT, scannedToken: TOKEN, excludePool: '0x' + '00'.repeat(32), ...quoteLaneSelection('robinhood') })
  assert.deepEqual(sel.debug?.candidates.map((c) => c.rejected), ['pool_id_invalid', 'pool_id_invalid', null])
  assert.equal(sel.choice?.pool, QT_WETH_SMALLER)
})

test('7. circular (scanned-token) pool and the V4 source pool are rejected with their reasons', () => {
  const json = discovery(QT, 'QT', [{ address: QT_THIRD_POOL, other: TOKEN, reserve: 5e6 }, { address: QT_WETH_POOL, other: RH_WETH, reserve: 5e6 }])
  const sel = selectIndependentQuotePool(json, { quoteToken: QT, scannedToken: TOKEN, excludePool: QT_WETH_POOL, ...quoteLaneSelection('robinhood') })
  assert.deepEqual([sel.choice, sel.debug?.candidates.map((c) => c.rejected)], [null, ['circular', 'excluded_source_pool']])
})

test('4. several pools: the valid quote/WETH pool wins; thin, third-token and quote-side pools handled; side exact', () => {
  const json = discovery(QT, 'QT', [
    { address: QT_THIRD_POOL, other: THIRD, reserve: 9e6, dex: 'uniswap_v3_robinhood' },
    { address: QT_WETH_THIN, other: RH_WETH, reserve: QUOTE_POOL_MIN_LIQUIDITY_USD - 1 },
    { address: QT_WETH_SMALLER, other: RH_WETH, reserve: 40_000 },
    { address: QT_WETH_POOL, other: RH_WETH, reserve: 300_000, dex: 'uniswap_v3_robinhood', quoteIsBase: false }, // QT is the quote token here
  ])
  const sel = selectIndependentQuotePool(json, { quoteToken: QT, scannedToken: TOKEN, excludePool: POOL, ...quoteLaneSelection('robinhood') })
  assert.deepEqual([sel.choice?.pool, sel.choice?.side, sel.choice?.pairedWith, sel.choice?.dex, sel.choice?.liquidityUsd], [QT_WETH_POOL, 'quote', RH_WETH, 'uniswap_v3_robinhood', 300_000])
  assert.deepEqual(sel.debug?.candidates.map((c) => c.rejected), ['wrong_anchor', 'thin_liquidity', null, null])
  assert.deepEqual([sel.debug?.poolsReturned, sel.debug?.anchoredFound, sel.debug?.anchoredRejected], [4, 3, 1])
  // A missing reserve_in_usd is thin, never assumed liquid.
  const noReserve = selectIndependentQuotePool(discovery(QT, 'QT', [{ address: QT_WETH_POOL, other: RH_WETH, reserve: null }]), { quoteToken: QT, scannedToken: TOKEN, excludePool: POOL, ...quoteLaneSelection('robinhood') })
  assert.deepEqual([noReserve.choice, noReserve.failure], [null, 'quote_pool_liquidity_too_low'])
})

// ── End to end ───────────────────────────────────────────────────────────────────────────────────
test('3. WETH-quoted Robinhood V4 pool => native ETH/USD lane => real USD candles, no extra read', async () => {
  reset()
  const f = fakeRpc(RH_WETH)
  const r = await loadV4SwapCandles(input(3), deps(f))
  assert.equal(r.ok, true, `${r.code} ${r.quote?.failureReason}`)
  assert.deepEqual([r.counterAsset, r.quote?.classification, r.quote?.attempt, r.quote?.source, r.quote?.decimals, r.quote?.decimalsSource], ['eth', 'verified_wrapped_native', 'native_usd', 'eth_usd_series', 18, 'registry'])
  assert.deepEqual(r.quote?.wrappedNative, { address: RH_WETH, proof: 'static', source: CHAIN_ASSET_REGISTRY.robinhood.wrappedNative!.source, status: 'verified' })
  assert.ok(r.candles.length > 10 && r.candles.every((k) => Math.abs(k.close - 3) < 1e-9), '1 WETH = 1000 TOKEN at ETH $3000 => $3')
  assert.equal(f.calls.filter((c) => c.method === 'eth_call').length, 0, 'no WETH9() proof read any more')
})

test('2 + 10. arbitrary quote + valid quote/WETH pool => real USD candles from GeckoTerminal history, full debug', async () => {
  reset()
  const q = quoteDeps(discovery(QT, 'QT', [
    { address: QT_THIRD_POOL, other: THIRD, reserve: 9e6 },
    { address: QT_WETH_POOL, other: RH_WETH, reserve: 300_000, dex: 'uniswap_v3_robinhood' },
  ]), 2, 'geckoterminal')
  const r = await loadV4SwapCandles(input(0.002), deps(fakeRpc(QT), q))
  assert.equal(r.ok, true, `${r.code} ${r.quote?.failureReason} ${r.quote?.reason}`)
  assert.deepEqual(
    [r.counterAsset, r.quote?.classification, r.quote?.attempt, r.quote?.pool, r.quote?.poolProtocol, r.quote?.poolSide, r.quote?.pairedWith, r.quote?.decimals, r.quote?.evidence, r.quote?.failureReason],
    ['independent_quote', 'arbitrary_quote', 'independent_quote_pool', QT_WETH_POOL, 'uniswap_v3_robinhood', 'base', RH_WETH, 18, 'verified', null],
  )
  assert.ok(r.quote!.anchors!.includes(RH_WETH))
  assert.deepEqual([r.quote?.discovery?.httpStatus, r.quote?.discovery?.poolsReturned, r.quote?.discovery?.anchoredFound, r.quote?.discovery?.selectedLiquidityUsd], [200, 2, 1, 300_000])
  assert.deepEqual([r.quote?.history?.provider, r.quote?.history?.httpStatus, r.quote?.history?.rows, r.quote?.history?.validRows], ['geckoterminal', 200, 290, 290])
  assert.equal(r.quote?.history?.latestSec, NOW_TS - 300)
  assert.ok(r.candles.every((k) => Math.abs(k.close - 0.002) < 1e-12), '1 QT = 1000 TOKEN at QT $2 => $0.002')
  assert.deepEqual(q.calls, [`pools ${QT}`, `ohlcv ${QT_WETH_POOL} base`])
})

test('provider without the quote token\'s decimals: one on-chain decimals() read, else quote_asset_unverified', async () => {
  reset()
  const json = discovery(QT, 'QT', [{ address: QT_WETH_POOL, other: RH_WETH, reserve: 300_000 }], { decimals: null })
  const f = fakeRpc(QT, { decimals: 18 })
  const r = await loadV4SwapCandles(input(0.002), deps(f, quoteDeps(json)))
  assert.equal(r.ok, true, `${r.code} ${r.quote?.failureReason}`)
  assert.deepEqual([r.quote?.decimals, r.quote?.decimalsSource], [18, 'onchain'])
  assert.deepEqual(f.calls.filter((c) => c.method === 'eth_call').map((c) => c.to), [QT])
  reset()
  const g = await loadV4SwapCandles(input(0.002), deps(fakeRpc(QT, { decimals: 'error' }), quoteDeps(json)))
  assert.deepEqual([g.code, g.quote?.failureReason, g.quote?.reason], ['quote_usd_price_unproven', 'quote_asset_unverified', 'quote_decimals_unavailable'])
})

test('no independent USD history => honest quote_usd_price_unproven with the exact first failing stage', async () => {
  const cases: Array<[string, FixturePool[], string]> = [
    ['only a third-token pool', [{ address: QT_THIRD_POOL, other: THIRD, reserve: 9e6 }], 'quote_pool_not_found'],
    ['no pool at all', [], 'quote_pool_not_found'],
    ['WETH pool below $25k', [{ address: QT_WETH_THIN, other: RH_WETH, reserve: QUOTE_POOL_MIN_LIQUIDITY_USD - 1 }], 'quote_pool_liquidity_too_low'],
  ]
  for (const [name, pools, reason] of cases) {
    reset()
    const r = await loadV4SwapCandles(input(0.002), deps(fakeRpc(QT), quoteDeps(discovery(QT, 'QT', pools))))
    assert.deepEqual([r.code, r.candles.length, r.quote?.evidence, r.quote?.failureReason], ['quote_usd_price_unproven', 0, 'unavailable', reason], name)
  }
  reset()
  const empty = quoteDeps(discovery(QT, 'QT', [{ address: QT_WETH_POOL, other: RH_WETH, reserve: 300_000 }]))
  empty.deps.fetchPoolUsdOhlcv = async () => ({ json: { data: { attributes: { ohlcv_list: [] } } }, httpStatus: 200, provider: 'geckoterminal' })
  const e = await loadV4SwapCandles(input(0.002), deps(fakeRpc(QT), empty))
  assert.deepEqual([e.code, e.quote?.failureReason, e.quote?.history?.rows, e.quote?.history?.provider], ['quote_usd_price_unproven', 'quote_history_unavailable', 0, 'geckoterminal'])
  reset()
  const stale = quoteDeps(discovery(QT, 'QT', [{ address: QT_WETH_POOL, other: RH_WETH, reserve: 300_000 }]))
  stale.deps.fetchPoolUsdOhlcv = async () => ({ json: { data: { attributes: { ohlcv_list: [[NOW_TS - 40 * 3600, 2, 2, 2, 2, 1], [NOW_TS - 41 * 3600, 2, 2, 2, 2, 1]] } } }, httpStatus: 200 })
  const s = await loadV4SwapCandles(input(0.002), deps(fakeRpc(QT), stale))
  assert.deepEqual([s.code, s.quote?.failureReason], ['quote_usd_price_unproven', 'quote_history_stale'])
})

test('9. fake tokens named WETH / USDC are never treated as wrapped native / $1 stable', async () => {
  reset()
  const eth: string[] = []
  const w = await loadV4SwapCandles(input(3), deps(fakeRpc(FAKE_WETH), quoteDeps(discovery(FAKE_WETH, 'WETH', [{ address: QT_THIRD_POOL, other: THIRD, reserve: 9e5 }])), eth))
  assert.deepEqual([w.code, w.counterAsset, w.quote?.classification, w.quote?.failureReason], ['quote_usd_price_unproven', 'other', 'arbitrary_quote', 'wrapped_native_unverified'])
  assert.deepEqual(eth, [], 'ETH/USD never requested for it')
  reset()
  const u = await loadV4SwapCandles(input(0.001), deps(fakeRpc(FAKE_USDC), quoteDeps(discovery(FAKE_USDC, 'USDC', [{ address: QT_THIRD_POOL, other: THIRD, reserve: 9e5 }]))))
  assert.deepEqual([u.code, u.counterAsset, u.quote?.classification, u.quote?.failureReason, u.candles.length], ['quote_usd_price_unproven', 'other', 'arbitrary_quote', 'stable_asset_unverified', 0])
  // With a real independent USDC/WETH pool, the USDC-named token is priced from ITS history, never $1.
  reset()
  const u2 = await loadV4SwapCandles(input(0.000999), deps(fakeRpc(FAKE_USDC), quoteDeps(discovery(FAKE_USDC, 'USDC', [{ address: QT_WETH_POOL, other: RH_WETH, reserve: 4e5 }]), 0.999)))
  assert.equal(u2.ok, true)
  assert.ok(u2.candles.every((k) => Math.abs(k.close - 0.000999) < 1e-12))
  assert.equal(explainQuoteFailure({ detail: 'no_quote_token_pool_found', selectionFailure: 'quote_pool_not_found', quoteSymbol: 'QT' }), 'quote_pool_not_found')
})

// ── Budget / cache ───────────────────────────────────────────────────────────────────────────────
test('call counts: WETH quote cold 7 / warm 5 / hit 0; arbitrary quote cold 7 / warm 5', async () => {
  reset()
  const wethCold = await loadV4SwapCandles(input(3), deps(fakeRpc(RH_WETH)))
  const wethHit = await loadV4SwapCandles(input(3), deps(fakeRpc(RH_WETH)))
  const wethWarm = await loadV4SwapCandles(input(3), { ...deps(fakeRpc(RH_WETH), undefined, undefined, (NOW_TS + 240) * 1000), ethUsdSeries: async () => ({ ...(await ethSeries(3000)()), cacheHit: true }) })
  assert.deepEqual([wethCold.ok, wethHit.ok, wethWarm.ok], [true, true, true])
  // cold: header, Initialize, anchor header, 3 pages (full 24h), ETH/USD = 7; warm: Initialize + series cached.
  assert.deepEqual([wethCold.callsUsed, wethWarm.callsUsed, wethHit.callsUsed], [7, 5, 0])
  assert.equal(wethCold.pagesFetched, 3)
  reset()
  const q = quoteDeps(discovery(QT, 'QT', [{ address: QT_WETH_POOL, other: RH_WETH, reserve: 300_000 }]), 2)
  const cold = await loadV4SwapCandles(input(0.002), deps(fakeRpc(QT), q))
  const warm = await loadV4SwapCandles(input(0.002), deps(fakeRpc(QT), q, undefined, (NOW_TS + 240) * 1000))
  assert.deepEqual([cold.ok, warm.ok], [true, true])
  // cold: header, Initialize, anchor header, discovery, quote history, 2 pages = 7.
  // warm (Initialize, discovery and the 10-min quote slot cached): header, anchor header, 3 pages = 5.
  assert.deepEqual([cold.callsUsed, warm.callsUsed], [7, 5])
  assert.equal(q.calls.filter((c) => c.startsWith('pools')).length, 1, 'discovery cached')
})

test('11. whole Robinhood initial candle path (GT ladder + V4 with an arbitrary quote) stays <= 10 calls', async () => {
  reset()
  const q = quoteDeps(discovery(QT, 'QT', [{ address: QT_WETH_POOL, other: RH_WETH, reserve: 300_000 }]), 2)
  const f = fakeRpc(QT)
  const rel = { base_token: { data: { id: `robinhood_${TOKEN}` } }, quote_token: { data: { id: `robinhood_${QT}` } }, dex: { data: { id: 'uniswap-v4-robinhood' } } }
  const lp = (addr: string): LadderPool => ({ poolId: `robinhood_${addr}`, address: addr, name: 'TKN / QT', liquidityUsd: 1e5, pool: { id: `robinhood_${addr}`, relationships: rel } })
  const r = await runEvmCandleLadder(
    { pools: [lp(POOL), lp('0x' + '7a'.repeat(20)), lp('0x' + '7b'.repeat(20))], contract: TOKEN, networkId: 'robinhood', coingeckoNetworkId: null, currentPriceUsd: 0.002 },
    {
      fetchCoingeckoPoolOhlcv: async () => { throw new Error('CoinGecko has no Robinhood network') },
      fetchPoolOhlcv: async () => ({ httpStatus: 404, json: null }),
      fetchTrades: async () => ({ httpStatus: 200, json: { data: [] } }),
      fetchV4SwapCandles: async (p, budget) => loadV4SwapCandles({ ...input(0.002), poolId: p.address }, deps(f, q), budget),
    },
  )
  assert.ok(r.callBudget.used <= EVM_MAX_OHLCV_CALLS && EVM_MAX_OHLCV_CALLS <= 10, `used ${r.callBudget.used}`)
  assert.equal(r.v4Swap?.code ?? null, null, `${r.v4Swap?.code}`)
  assert.equal(r.v4Swap?.quote?.classification, 'arbitrary_quote')
})

// ── History ──────────────────────────────────────────────────────────────────────────────────────
test('history: Robinhood WETH window prices by ETH/USD; arbitrary quote uses its WETH pool\'s hourly GeckoTerminal history', async () => {
  reset()
  const weth = await loadV4SwapHistoryWindow({ chain: 'robinhood', poolId: POOL, token: TOKEN, beforeSec: NOW_TS - 24 * 3600 }, {
    rpc: fakeRpc(RH_WETH).rpc, now: () => NOW_TS * 1000,
    ethUsdRange: async (from, to) => ({ points: Array.from({ length: Math.ceil((to - from) / 3600) + 1 }, (_, i) => [(from + i * 3600) * 1000, 3000] as [number, number]), cacheHit: false }),
  })
  assert.equal(weth.ok, true, `${weth.code} ${weth.quote?.reason}`)
  assert.equal(weth.quote?.source, 'eth_usd_series')
  assert.ok(weth.candles.length > 0 && weth.candles.every((k) => Math.abs(k.close - 3) < 1e-9))

  reset()
  const seen: Array<{ anchors: string[]; priority: string | undefined }> = []
  const json = discovery(QT, 'QT', [{ address: QT_WETH_POOL, other: RH_WETH, reserve: 300_000 }])
  const h = await loadV4SwapHistoryWindow({ chain: 'robinhood', poolId: POOL, token: TOKEN, beforeSec: NOW_TS - 24 * 3600 }, {
    rpc: fakeRpc(QT).rpc, now: () => NOW_TS * 1000,
    quoteUsdWindow: (qi) => {
      seen.push({ anchors: [...qi.anchors], priority: qi.anchorPriority })
      return resolveIndependentQuoteUsdWindow({ chain: 'robinhood', ...qi }, {
        now: () => NOW_TS * 1000,
        fetchTokenPools: async () => ({ json, httpStatus: 200 }),
        fetchPoolUsdOhlcvBefore: async (_c, _p, _s, req, beforeSec) => ({ json: { data: { attributes: { ohlcv_list: Array.from({ length: req.limit }, (_, i) => [beforeSec - 3600 - i * 3600, 2, 2, 2, 2, 5]) } } }, httpStatus: 200, provider: 'geckoterminal' }),
      })
    },
  })
  assert.equal(h.ok, true, `${h.code} ${h.quote?.reason}`)
  assert.ok(seen[0].anchors.includes(RH_WETH) && seen[0].priority === 'wrapped_native_first')
  assert.ok(h.candles.length > 0 && h.candles.every((k) => Math.abs(k.close - 0.002) < 1e-9))
})

// ── Wiring ───────────────────────────────────────────────────────────────────────────────────────
test('wiring: Robinhood quote history goes to GeckoTerminal (labelled); debug panel shows every stage', () => {
  const route = read('app/api/token/route.ts')
  assert.match(route, /fetchPoolUsdOhlcv: async \(_c, quotePool, side\) => _chartCoingeckoNetwork\s*\n\s*\? \{ \.\.\.\(await fetchCoingeckoOnchainPoolOhlcv\(chain, quotePool, QUOTE_SERIES_REQUEST, side\)\), provider: 'coingecko_onchain' \}\s*\n\s*: \{ \.\.\.\(await fetchGeckoTerminalPoolOhlcv\(quotePool, chain, QUOTE_SERIES_REQUEST, side\)\), provider: 'geckoterminal' \}/)
  assert.match(route, /const _chartCoingeckoNetwork = isCoingeckoOnchainConfigured\(\) \? coingeckoOnchainNetwork\(chain\) : null/)
  assert.match(read('lib/server/v4SwapHistoryDeps.ts'), /isCoingeckoOnchainConfigured\(\) && coingeckoOnchainNetwork\(chain\)\s*\n\s*\? \{ \.\.\.\(await fetchCoingeckoOnchainPoolOhlcv/)
  const page = read('app/terminal/token-scanner/page.tsx')
  for (const label of ['Wrapped native', 'Wrapped native source', 'Quote anchors', 'Quote token', 'Quote address', 'Quote decimals', 'Quote classification', 'Discovery', 'Selected quote pool liquidity', 'Quote history', 'Independent quote pool', 'Independent pool protocol', 'Independent pool side', 'Failure reason']) {
    assert.ok(page.includes(`${label}: `), label)
  }
  assert.match(page, /rejected: \$\{c\.rejected\}/)
})
