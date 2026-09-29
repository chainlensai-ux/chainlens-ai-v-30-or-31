// Robinhood Chain V4 quote-asset -> historical USD (lib/server/chainAssetRegistry.ts +
// lib/server/v4SwapCandlesRpc.ts + lib/server/v4QuoteUsd.ts). Live failure: a Robinhood Uniswap V4 pool
// reached the swap-candle path but its other asset had "no proven USD price history" — Robinhood's
// registry held only native ETH (0x0), so WETH was never priced as ETH and the independent one-hop lane
// had no anchor any normal pool could pair with. Robinhood's WETH is now accepted only when the chain's
// verified Uniswap V3 NonfungiblePositionManager returns exactly that address from WETH9().
// Token / pool addresses below are fixtures, except the registry's own Robinhood WETH + NPM addresses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem'
import { V4_INITIALIZE_TOPIC0, V4_POOL_MANAGER_ABI, type RawEvmLog } from '../lib/v4SwapCandles.ts'
import { V4_SWAP_CHAIN_CONFIG, explainQuoteFailure, loadV4SwapCandles, loadV4SwapHistoryWindow, resetV4SwapCandleCache, type V4SwapDeps } from '../lib/server/v4SwapCandlesRpc.ts'
import { CHAIN_ASSET_REGISTRY, WETH9_SELECTOR, classifyQuoteAsset, resetChainAssetRegistryCache } from '../lib/server/chainAssetRegistry.ts'
import { QUOTE_POOL_MIN_LIQUIDITY_USD, resetQuoteUsdCache, resolveIndependentQuoteUsd, type QuoteUsdDeps } from '../lib/server/v4QuoteUsd.ts'
import { ROBINHOOD_SIM_WETH } from '../lib/server/robinhoodHoneypotSimulation.ts'
import { EVM_MAX_OHLCV_CALLS, runEvmCandleLadder, type LadderPool } from '../lib/evmChartCandles.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const NATIVE = '0x0000000000000000000000000000000000000000'
const RH_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const RH_NPM = '0x73991a25c818bf1f1128deaab1492d45638de0d3'
const RH_WETH = ROBINHOOD_SIM_WETH.toLowerCase()
const BASE_WETH = '0x4200000000000000000000000000000000000006'
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
const SENDER = '0x000000000000000000000000000000000000beef'
const Q96 = BigInt(2) ** BigInt(96)
const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`
const NOW_TS = 1_800_000_000
const LATEST = 9_000_000
const BLOCK_SEC = 0.25
const INIT_BLOCK = LATEST - 3 * 345_600
const tsOf = (b: number) => Math.round(NOW_TS - (LATEST - b) * BLOCK_SEC)
const word = (addr: string) => '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase()

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

/** Robinhood RPC: headers, the pool's Initialize, a swap every 5 minutes, and the NPM's WETH9() answer. */
function fakeRpc(quote: string, opts: { weth9?: string | 'error' } = {}) {
  const calls: Array<{ method: string; to?: string; data?: string }> = []
  const rpc: V4SwapDeps['rpc'] = async (method, params) => {
    if (method === 'eth_call') {
      const { to, data } = params[0] as { to: string; data: string }
      calls.push({ method, to: to.toLowerCase(), data })
      if (to.toLowerCase() === RH_NPM && data === WETH9_SELECTOR) return opts.weth9 === 'error' ? { result: null, error: true } : { result: word(opts.weth9 ?? RH_WETH), error: false }
      return { result: hex(18), error: false }
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

// GeckoTerminal-shaped discovery for a Robinhood quote token (network 'robinhood').
function discovery(quote: string, symbol: string, pools: Array<{ address: string; other: string; reserve: number; dex?: string }>) {
  return {
    data: pools.map((p) => ({
      id: `robinhood_${p.address}`, type: 'pool', attributes: { address: p.address, reserve_in_usd: String(p.reserve) },
      relationships: { base_token: { data: { id: `robinhood_${quote}` } }, quote_token: { data: { id: `robinhood_${p.other}` } }, dex: { data: { id: p.dex ?? 'uniswap_v2_robinhood' } } },
    })),
    included: [{ id: `robinhood_${quote}`, type: 'token', attributes: { address: quote, symbol, decimals: 18 } }],
  }
}
/** The independent pool's own 5m USD candles for the quote token (newest first), flat at `usd`. */
function quoteDeps(json: unknown, usd = 2) {
  const calls: string[] = []
  const deps: QuoteUsdDeps = {
    now: () => NOW_TS * 1000,
    fetchTokenPools: async (_c, token) => { calls.push(`pools ${token}`); return { json, httpStatus: 200 } },
    fetchPoolUsdOhlcv: async (_c, pool, side) => {
      calls.push(`ohlcv ${pool} ${side}`)
      const rows = Array.from({ length: 290 }, (_, i) => [NOW_TS - 300 - i * 300, usd, usd, usd, usd, 10])
      return { json: { data: { attributes: { ohlcv_list: rows } } }, httpStatus: 200 }
    },
  }
  return { deps, calls }
}
const reset = () => { resetV4SwapCandleCache(); resetQuoteUsdCache(); resetChainAssetRegistryCache() }
const input = (livePriceUsd: number) => ({ chain: 'robinhood', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd })
function deps(f: ReturnType<typeof fakeRpc>, q?: ReturnType<typeof quoteDeps>, ethCalls?: string[], nowMs = NOW_TS * 1000): V4SwapDeps {
  return { rpc: f.rpc, now: () => nowMs, ethUsdSeries: ethSeries(3000, ethCalls), ...(q ? { quoteUsd: (i) => resolveIndependentQuoteUsd({ chain: 'robinhood', ...i }, q.deps) } : {}) }
}

// ── Registry ─────────────────────────────────────────────────────────────────────────────────────
test('Robinhood registry: native ETH, WETH proven on-chain via the verified V3 NPM, no verified USD stable', () => {
  const rh = CHAIN_ASSET_REGISTRY.robinhood
  assert.deepEqual([rh.chainId, rh.native.address, rh.native.symbol, rh.native.coinId], [4663, NATIVE, 'ETH', 'ethereum'])
  assert.ok(rh.wrappedNative && rh.wrappedNative.proof === 'onchain_getter')
  if (rh.wrappedNative?.proof !== 'onchain_getter') return
  assert.deepEqual([rh.wrappedNative.address, rh.wrappedNative.decimals, rh.wrappedNative.verifier, rh.wrappedNative.selector], [RH_WETH, 18, RH_NPM, '0x4aa4a4fc'])
  assert.equal(rh.verifiedUsdStables.length, 0)
  // Evidence is the repo's own: the NPM from Uniswap's deployments/4663.md, the candidate from the trading sim.
  assert.match(read('lib/server/lpProof.ts'), /0x73991a25c818bf1f1128deaab1492d45638de0d3", \/\/ Uniswap V3 NonfungiblePositionManager \(Robinhood Chain\)/)
  assert.match(read('lib/server/robinhoodHoneypotSimulation.ts'), /export const ROBINHOOD_SIM_WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'/)
  // Nothing copied from Ethereum / Base.
  assert.notEqual(RH_WETH, BASE_WETH)
  assert.notEqual(RH_WETH, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
  // V4 config keeps only static entries for Robinhood (the proof happens at runtime).
  assert.deepEqual(V4_SWAP_CHAIN_CONFIG.robinhood.nativeLike, { [NATIVE]: 18 })
  assert.deepEqual(V4_SWAP_CHAIN_CONFIG.robinhood.usdStable, {})
})

test('Base / ETH / BNB registry values are exactly the ones the V4 reader used before', () => {
  assert.deepEqual(V4_SWAP_CHAIN_CONFIG.base.nativeLike, { [NATIVE]: 18, [BASE_WETH]: 18 })
  assert.deepEqual(V4_SWAP_CHAIN_CONFIG.base.usdStable, { '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6, '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 6 })
  assert.deepEqual(V4_SWAP_CHAIN_CONFIG.eth.nativeLike, { [NATIVE]: 18, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 18 })
  assert.deepEqual(V4_SWAP_CHAIN_CONFIG.eth.usdStable, { [ETH_USDC]: 6, '0xdac17f958d2ee523a2206206994597c13d831ec7': 6 })
  assert.deepEqual(V4_SWAP_CHAIN_CONFIG.bnb.nativeLike, { [NATIVE]: 18, '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 18 })
  assert.deepEqual(V4_SWAP_CHAIN_CONFIG.bnb.usdStable, { '0x55d398326f99059ff775485246999027b3197955': 18, '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 18 })
})

test('G. classification is exact-address, exact-chain: wrong-chain canonical addresses are rejected', () => {
  assert.equal(classifyQuoteAsset('robinhood', BASE_WETH, RH_WETH), 'arbitrary_quote', 'Base WETH on Robinhood')
  assert.equal(classifyQuoteAsset('robinhood', ETH_USDC, RH_WETH), 'arbitrary_quote', 'Ethereum USDC on Robinhood')
  assert.equal(classifyQuoteAsset('base', RH_WETH, null), 'arbitrary_quote', 'Robinhood WETH on Base')
  assert.equal(classifyQuoteAsset('robinhood', RH_WETH, RH_WETH), 'verified_wrapped_native')
  assert.equal(classifyQuoteAsset('robinhood', RH_WETH, null), 'unverified', 'registry address without its on-chain proof')
  assert.equal(classifyQuoteAsset('robinhood', NATIVE, null), 'native')
  assert.equal(classifyQuoteAsset('eth', ETH_USDC, null), 'verified_stable')
  assert.equal(classifyQuoteAsset('polygon', ETH_USDC, null), 'unverified', 'unregistered chain')
})

// ── A. Verified wrapped native ───────────────────────────────────────────────────────────────────
test('A. Robinhood WETH-quoted V4 pool: WETH9() proves the address -> priced by ETH/USD -> real USD candles', async () => {
  reset()
  const f = fakeRpc(RH_WETH)
  const r = await loadV4SwapCandles(input(3), deps(f))
  assert.equal(r.ok, true, `${r.code} ${r.quote?.failureReason}`)
  assert.deepEqual([r.counterAsset, r.quote?.classification, r.quote?.attempt, r.quote?.source, r.quote?.decimals, r.quote?.wrappedNative, r.quote?.evidence], ['eth', 'verified_wrapped_native', 'native_usd', 'eth_usd_series', 18, 'proven', 'verified'])
  assert.ok(r.candles.length > 10 && r.candles.every((k) => Math.abs(k.close - 3) < 1e-9), '1 WETH = 1000 TOKEN at ETH $3000 => $3')
  assert.equal(r.timeResolution, 'exact_log_timestamps')
  const proof = f.calls.filter((c) => c.method === 'eth_call')
  assert.deepEqual(proof, [{ method: 'eth_call', to: RH_NPM, data: WETH9_SELECTOR }], 'exactly one proof read, to the verified NPM')
})

test('A. WETH proof mismatch or RPC failure: never priced as ETH, exact wrapped_native_unverified, no USD lane spent', async () => {
  for (const weth9 of ['0x' + '99'.repeat(20), 'error'] as const) {
    reset()
    const eth: string[] = []
    const q = quoteDeps(discovery(RH_WETH, 'WETH', []))
    const r = await loadV4SwapCandles(input(3), deps(fakeRpc(RH_WETH, { weth9 }), q, eth))
    assert.equal(r.code, 'quote_usd_price_unproven')
    assert.deepEqual([r.quote?.classification, r.quote?.attempt, r.quote?.failureReason, r.quote?.wrappedNative], ['unverified', 'none', 'wrapped_native_unverified', weth9 === 'error' ? 'rpc_error' : 'mismatch'])
    assert.deepEqual([eth, q.calls], [[], []], 'no ETH/USD read, no independent-pool read')
  }
})

// ── B. Stable quote ──────────────────────────────────────────────────────────────────────────────
test('B. Robinhood has no verified USD stable: a USDC-named quote is never $1; with an independent USDC/WETH pool it gets real USD candles', async () => {
  reset()
  const q = quoteDeps(discovery(FAKE_USDC, 'USDC', [{ address: QT_WETH_POOL, other: RH_WETH, reserve: 400_000 }]), 0.999)
  const r = await loadV4SwapCandles(input(0.000999), deps(fakeRpc(FAKE_USDC), q))
  assert.equal(r.ok, true, `${r.code} ${r.quote?.failureReason}`)
  assert.deepEqual([r.counterAsset, r.quote?.classification, r.quote?.attempt, r.quote?.source, r.quote?.pairedWith], ['independent_quote', 'arbitrary_quote', 'independent_quote_pool', 'independent_pool', RH_WETH])
  assert.ok(r.candles.every((k) => Math.abs(k.close - 0.000999) < 1e-12), 'priced from its own pool history ($0.999), not a $1 assumption')
})

// ── C. Arbitrary quote with an independent normal pool ───────────────────────────────────────────
test('C. arbitrary quote QT: independent QT/WETH normal pool (proven WETH anchor) -> real USD candles, full debug', async () => {
  reset()
  const q = quoteDeps(discovery(QT, 'QT', [
    { address: QT_THIRD_POOL, other: THIRD, reserve: 9_000_000 }, // third token: a second hop — never used
    { address: QT_WETH_THIN, other: RH_WETH, reserve: QUOTE_POOL_MIN_LIQUIDITY_USD - 1 }, // too thin
    { address: QT_WETH_POOL, other: RH_WETH, reserve: 300_000, dex: 'uniswap_v3_robinhood' },
  ]), 2)
  const f = fakeRpc(QT)
  const r = await loadV4SwapCandles(input(0.002), deps(f, q))
  assert.equal(r.ok, true, `${r.code} ${r.quote?.failureReason} ${r.quote?.reason}`)
  assert.deepEqual(
    [r.counterAsset, r.quote?.classification, r.quote?.attempt, r.quote?.pool, r.quote?.poolProtocol, r.quote?.poolSide, r.quote?.pairedWith, r.quote?.decimals, r.quote?.evidence, r.quote?.failureReason],
    ['independent_quote', 'arbitrary_quote', 'independent_quote_pool', QT_WETH_POOL, 'uniswap_v3_robinhood', 'base', RH_WETH, 18, 'verified', null],
  )
  assert.ok(r.quote!.points >= 2 && r.quote!.maxGapMs != null && r.quote!.maxGapMs <= 15 * 60_000)
  assert.ok(r.candles.every((k) => Math.abs(k.close - 0.002) < 1e-12), '1 QT = 1000 TOKEN at QT $2 => $0.002')
  assert.deepEqual(q.calls, [`pools ${QT}`, `ohlcv ${QT_WETH_POOL} base`])
  assert.ok(r.callsUsed <= 7)
})

test('C. the independent lane never uses the V4 pool itself or a pool containing the scanned token', async () => {
  reset()
  const q = quoteDeps(discovery(QT, 'QT', [{ address: QT_WETH_POOL, other: TOKEN, reserve: 5_000_000 }]))
  const r = await loadV4SwapCandles(input(0.002), deps(fakeRpc(QT), q))
  assert.equal(r.code, 'quote_usd_price_unproven')
  assert.equal(r.quote?.failureReason, 'quote_pool_not_found')
})

// ── D. No independent USD history ────────────────────────────────────────────────────────────────
test('D. arbitrary quote with no independent USD history -> honest quote_usd_price_unproven with the exact reason', async () => {
  const cases: Array<[string, Array<{ address: string; other: string; reserve: number }>, string]> = [
    ['only a third-token pool', [{ address: QT_THIRD_POOL, other: THIRD, reserve: 9_000_000 }], 'quote_pool_not_found'],
    ['no pool at all', [], 'quote_pool_not_found'],
    ['WETH pool below the liquidity threshold', [{ address: QT_WETH_THIN, other: RH_WETH, reserve: QUOTE_POOL_MIN_LIQUIDITY_USD - 1 }], 'quote_pool_liquidity_too_low'],
  ]
  for (const [name, pools, reason] of cases) {
    reset()
    const r = await loadV4SwapCandles(input(0.002), deps(fakeRpc(QT), quoteDeps(discovery(QT, 'QT', pools))))
    assert.deepEqual([r.code, r.candles.length, r.quote?.evidence, r.quote?.failureReason], ['quote_usd_price_unproven', 0, 'unavailable', reason], name)
  }
  // Pool found but its history is empty / stale.
  reset()
  const empty = quoteDeps(discovery(QT, 'QT', [{ address: QT_WETH_POOL, other: RH_WETH, reserve: 300_000 }]))
  empty.deps.fetchPoolUsdOhlcv = async () => ({ json: { data: { attributes: { ohlcv_list: [] } } }, httpStatus: 200 })
  const e = await loadV4SwapCandles(input(0.002), deps(fakeRpc(QT), empty))
  assert.deepEqual([e.code, e.quote?.failureReason], ['quote_usd_price_unproven', 'quote_history_unavailable'])
  reset()
  const stale = quoteDeps(discovery(QT, 'QT', [{ address: QT_WETH_POOL, other: RH_WETH, reserve: 300_000 }]))
  stale.deps.fetchPoolUsdOhlcv = async () => ({ json: { data: { attributes: { ohlcv_list: [[NOW_TS - 40 * 3600, 2, 2, 2, 2, 1], [NOW_TS - 41 * 3600, 2, 2, 2, 2, 1]] } } }, httpStatus: 200 })
  const s = await loadV4SwapCandles(input(0.002), deps(fakeRpc(QT), stale))
  assert.deepEqual([s.code, s.quote?.failureReason], ['quote_usd_price_unproven', 'quote_history_stale'])
})

// ── E / F. Fake symbols ──────────────────────────────────────────────────────────────────────────
test('E. a fake token named WETH is NOT treated as wrapped native (no ETH/USD pricing)', async () => {
  reset()
  const eth: string[] = []
  const r = await loadV4SwapCandles(input(3), deps(fakeRpc(FAKE_WETH), quoteDeps(discovery(FAKE_WETH, 'WETH', [{ address: QT_THIRD_POOL, other: THIRD, reserve: 900_000 }])), eth))
  assert.deepEqual([r.code, r.counterAsset, r.quote?.classification, r.quote?.attempt, r.quote?.failureReason], ['quote_usd_price_unproven', 'other', 'arbitrary_quote', 'independent_quote_pool', 'wrapped_native_unverified'])
  assert.deepEqual(eth, [], 'ETH/USD never requested for it')
})

test('F. a fake token named USDC is NOT treated as a $1 stable', async () => {
  reset()
  const r = await loadV4SwapCandles(input(0.001), deps(fakeRpc(FAKE_USDC), quoteDeps(discovery(FAKE_USDC, 'USDC', [{ address: QT_THIRD_POOL, other: THIRD, reserve: 900_000 }]))))
  assert.deepEqual([r.code, r.counterAsset, r.quote?.classification, r.quote?.source, r.quote?.failureReason], ['quote_usd_price_unproven', 'other', 'arbitrary_quote', 'independent_pool', 'stable_asset_unverified'])
  assert.equal(r.candles.length, 0)
  assert.equal(explainQuoteFailure({ detail: 'no_quote_token_pool_found', selectionFailure: 'quote_pool_not_found', quoteSymbol: 'QT' }), 'quote_pool_not_found')
})

test('G. a wrong-chain canonical address as the quote (Base WETH on Robinhood) is an arbitrary quote, not ETH', async () => {
  reset()
  const eth: string[] = []
  const r = await loadV4SwapCandles(input(3), deps(fakeRpc(BASE_WETH), quoteDeps(discovery(BASE_WETH, 'WETH', [])), eth))
  assert.deepEqual([r.code, r.quote?.classification, r.quote?.attempt], ['quote_usd_price_unproven', 'arbitrary_quote', 'independent_quote_pool'])
  assert.deepEqual(eth, [])
})

// ── Budget / cache ───────────────────────────────────────────────────────────────────────────────
test('calls: WETH quote cold 7 (incl. 1 proof) / warm 5 / hit 0; arbitrary quote cold 7 / warm 5; proof cached 24h', async () => {
  reset()
  const wethCold = await loadV4SwapCandles(input(3), deps(fakeRpc(RH_WETH)))
  const wethHit = await loadV4SwapCandles(input(3), deps(fakeRpc(RH_WETH)))
  const warmF = fakeRpc(RH_WETH)
  const wethWarm = await loadV4SwapCandles(input(3), { ...deps(warmF, undefined, undefined, (NOW_TS + 240) * 1000), ethUsdSeries: async () => ({ ...(await ethSeries(3000)()), cacheHit: true }) })
  assert.deepEqual([wethCold.ok, wethHit.ok, wethWarm.ok], [true, true, true])
  assert.deepEqual([wethCold.callsUsed, wethWarm.callsUsed, wethHit.callsUsed], [7, 5, 0])
  assert.equal(warmF.calls.filter((c) => c.method === 'eth_call').length, 0, 'proof served from the 24h cache')

  reset()
  const json = discovery(QT, 'QT', [{ address: QT_WETH_POOL, other: RH_WETH, reserve: 300_000 }])
  const q = quoteDeps(json, 2)
  const cold = await loadV4SwapCandles(input(0.002), deps(fakeRpc(QT), q))
  const warm = await loadV4SwapCandles(input(0.002), deps(fakeRpc(QT), q, undefined, (NOW_TS + 240) * 1000))
  assert.deepEqual([cold.ok, warm.ok], [true, true])
  // cold: header, Initialize, anchor header, WETH9 proof, discovery, quote history, 1 page = 7.
  // warm (4 min later; Initialize, proof, discovery and the 10-min quote slot cached): header, anchor header, 3 pages = 5.
  assert.equal(cold.callsUsed, 7)
  assert.equal(warm.callsUsed, 5, `warm ${warm.callsUsed}`)
  assert.deepEqual(q.calls.filter((c) => c.startsWith('pools')).length, 1, 'discovery cached')
})

test('whole Robinhood candle path (GT ladder + V4 with an arbitrary quote) stays <= 10 calls', async () => {
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
test('history: Robinhood WETH-quoted window prices by ETH/USD using the same proof (cached from the scan)', async () => {
  reset()
  await loadV4SwapCandles(input(3), deps(fakeRpc(RH_WETH)))
  const f = fakeRpc(RH_WETH)
  const h = await loadV4SwapHistoryWindow({ chain: 'robinhood', poolId: POOL, token: TOKEN, beforeSec: NOW_TS - 24 * 3600 }, {
    rpc: f.rpc, now: () => NOW_TS * 1000,
    ethUsdRange: async (from, to) => ({ points: Array.from({ length: Math.ceil((to - from) / 3600) + 1 }, (_, i) => [(from + i * 3600) * 1000, 3000] as [number, number]), cacheHit: false }),
  })
  assert.equal(h.ok, true, `${h.code} ${h.quote?.reason}`)
  assert.equal(h.quote?.source, 'eth_usd_series')
  assert.ok(h.candles.length > 0 && h.candles.every((k) => Math.abs(k.close - 3) < 1e-9))
  assert.equal(f.calls.filter((c) => c.method === 'eth_call' && c.to === RH_NPM).length, 0, 'proof reused')
})

// ── Wiring ───────────────────────────────────────────────────────────────────────────────────────
test('wiring: Robinhood quote history goes to GeckoTerminal (CoinGecko on-chain has no Robinhood network)', () => {
  const route = read('app/api/token/route.ts')
  assert.match(route, /fetchPoolUsdOhlcv: \(_c, quotePool, side\) => _chartCoingeckoNetwork\s*\n\s*\? fetchCoingeckoOnchainPoolOhlcv\(chain, quotePool, QUOTE_SERIES_REQUEST, side\)\s*\n\s*: fetchGeckoTerminalPoolOhlcv\(quotePool, chain, QUOTE_SERIES_REQUEST, side\)/)
  assert.match(route, /const _chartCoingeckoNetwork = isCoingeckoOnchainConfigured\(\) \? coingeckoOnchainNetwork\(chain\) : null/)
  assert.match(read('lib/server/v4SwapHistoryDeps.ts'), /isCoingeckoOnchainConfigured\(\) && coingeckoOnchainNetwork\(chain\)\s*\n\s*\? fetchCoingeckoOnchainPoolOhlcv/)
  const page = read('app/terminal/token-scanner/page.tsx')
  for (const label of ['Quote token', 'Quote address', 'Quote decimals', 'Quote classification', 'Quote USD attempt', 'Independent quote pool', 'Independent pool protocol', 'Independent pool side', 'Historical rows', 'Nearest historical match', 'Quote USD status', 'Failure reason']) {
    assert.ok(page.includes(`${label}: `), label)
  }
  assert.doesNotMatch(read('lib/server/chainAssetRegistry.ts'), /process\.env|fetch\(/, 'registry never reads secrets or the network itself')
})
