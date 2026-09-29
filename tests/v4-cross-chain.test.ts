// Uniswap V4 on-chain swap candles on every Token Scanner EVM chain (lib/server/v4SwapCandlesRpc.ts
// V4_SWAP_CHAIN_CONFIG): Base (fixed 2s blocks, unchanged), Ethereum and BNB (header-anchored time),
// Robinhood (exact log timestamps only). Exact manager + exact PoolId, chain-aware native USD, the
// call budget, caching and on-demand history. Logs are ABI-encoded exactly as PoolManager emits them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem'
import { V4_INITIALIZE_TOPIC0, V4_POOL_MANAGER_ABI, V4_SWAP_TOPIC0, type RawEvmLog } from '../lib/v4SwapCandles.ts'
import {
  V4_HISTORY_MAX_CALLS,
  V4_SWAP_CHAIN_CONFIG,
  V4_SWAP_MAX_CALLS,
  interpolateBlockTime,
  loadV4SwapCandles,
  loadV4SwapHistoryWindow,
  resetV4SwapCandleCache,
  v4ProtocolSupported,
  type V4HistoryDeps,
  type V4SwapDeps,
} from '../lib/server/v4SwapCandlesRpc.ts'
import { V4_POOL_ID_OHLCV_SUPPORT, runEvmCandleLadder, v4PoolIdOhlcvSupported, type LadderPool } from '../lib/evmChartCandles.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const NATIVE = '0x0000000000000000000000000000000000000000'
const POOL = ('0x' + '9f3c'.repeat(16)) as Hex
const OTHER_POOL = ('0x' + '51ab'.repeat(16)) as Hex
const TOKEN = '0x1bc0c42215582d5a085795f4badbac3ff36d1bcb'
const SENDER = '0x000000000000000000000000000000000000beef'
const Q96 = BigInt(2) ** BigInt(96)
const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`
const ETH_MANAGER = '0x000000000004444c5dc75cb358380d2e3de08a90'
const BNB_MANAGER = '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df'
const RH_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const WETH_ETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'
const USDT_BSC = '0x55d398326f99059ff775485246999027b3197955'

function sqrtX96(price0in1Human: number, dec0: number, dec1: number): bigint {
  return BigInt(Math.round(Math.sqrt(price0in1Human * 10 ** (dec1 - dec0)) * 2 ** 96))
}
function initLog(manager: string, poolId: Hex, c0: string, c1: string, block: number): RawEvmLog {
  const topics = encodeEventTopics({ abi: V4_POOL_MANAGER_ABI, eventName: 'Initialize', args: { id: poolId, currency0: c0 as Hex, currency1: c1 as Hex } })
  const data = encodeAbiParameters([{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }], [3000, 60, NATIVE, Q96, 0])
  return { address: manager, topics: topics as string[], data, blockNumber: hex(block), logIndex: '0x0' }
}
function swapLog(manager: string, poolId: Hex, block: number, sqrtP: bigint, a0: bigint, a1: bigint, ts: number | null): RawEvmLog {
  const topics = encodeEventTopics({ abi: V4_POOL_MANAGER_ABI, eventName: 'Swap', args: { id: poolId, sender: SENDER } })
  const data = encodeAbiParameters([{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }], [a0, a1, sqrtP, BigInt(1e18), 0, 3000])
  return { address: manager, topics: topics as string[], data, blockNumber: hex(block), logIndex: '0x0', ...(ts != null ? { blockTimestamp: hex(ts) } : {}) }
}

type Chain = { name: string; latest: number; latestTs: number; blockSec: number; manager: string; initBlock: number }
const NOW_TS = 1_800_000_000
const CHAINS: Record<string, Chain> = {
  eth: { name: 'eth', latest: 20_000_000, latestTs: NOW_TS, blockSec: 12, manager: ETH_MANAGER, initBlock: 20_000_000 - 30 * 7200 },
  bnb: { name: 'bnb', latest: 60_000_000, latestTs: NOW_TS, blockSec: 0.75, manager: BNB_MANAGER, initBlock: 60_000_000 - 30 * 115_200 },
  robinhood: { name: 'robinhood', latest: 9_000_000, latestTs: NOW_TS, blockSec: 0.25, manager: RH_MANAGER, initBlock: 9_000_000 - 3 * 345_600 },
}
/** Real chain time for a block (the fixture's ground truth). ETH gets missed slots every 50 blocks. */
const tsOf = (c: Chain, b: number) => (c.name === 'eth' ? c.latestTs - (c.latest - b) * 12 - Math.floor((c.latest - b) / 50) * 12 : Math.round(c.latestTs - (c.latest - b) * c.blockSec))

function fakeRpc(c: Chain, opts: {
  currency0: string
  currency1: string
  initManager?: string
  initPoolId?: Hex
  price0in1?: number
  dec0?: number
  dec1?: number
  withTimestamps?: boolean
  everySec?: number
  extra?: (from: number, to: number) => RawEvmLog[]
}) {
  const calls: Array<{ method: string; params: unknown[] }> = []
  const rpc: V4SwapDeps['rpc'] = async (method, params) => {
    calls.push({ method, params })
    if (method === 'eth_getBlockByNumber') {
      const tag = params[0] as string
      const b = tag === 'latest' ? c.latest : Number(BigInt(tag))
      return { result: { number: hex(b), timestamp: hex(tsOf(c, b)) }, error: false }
    }
    if (method === 'eth_call') return { result: hex(18), error: false }
    const f = params[0] as { address: string | string[]; topics: string[]; fromBlock: string; toBlock: string }
    if (f.topics[0] === V4_INITIALIZE_TOPIC0) return { result: [initLog(opts.initManager ?? c.manager, opts.initPoolId ?? POOL, opts.currency0, opts.currency1, c.initBlock)], error: false }
    const from = Number(BigInt(f.fromBlock))
    const to = Number(BigInt(f.toBlock))
    const out: RawEvmLog[] = []
    const step = Math.max(1, Math.round((opts.everySec ?? 300) / (c.name === 'eth' ? 12 : c.blockSec)))
    for (let b = Math.ceil(from / step) * step; b <= to; b += step) {
      out.push(swapLog(f.address as string, POOL, b, sqrtX96(opts.price0in1 ?? 1000, opts.dec0 ?? 18, opts.dec1 ?? 18), BigInt(-1e16), BigInt(1e19), opts.withTimestamps ? tsOf(c, b) : null))
    }
    return { result: [...out, ...(opts.extra ? opts.extra(from, to) : [])], error: false }
  }
  return { rpc, calls }
}
const series = (usd: number) => async () => ({ points: Array.from({ length: 300 }, (_, i) => [(NOW_TS - 24 * 3600 + i * 300) * 1000, usd] as [number, number]), cacheHit: false })
const logQueries = (calls: Array<{ method: string; params: unknown[] }>, topic: string) => calls.filter((x) => x.method === 'eth_getLogs' && (x.params[0] as { topics: string[] }).topics[0] === topic)

// ── Support matrix ───────────────────────────────────────────────────────────────────────────────
test('config: every Token Scanner EVM chain has an evidence-backed Uniswap V4 PoolManager and its own timestamp policy', () => {
  assert.deepEqual(Object.keys(V4_SWAP_CHAIN_CONFIG).sort(), ['base', 'bnb', 'eth', 'robinhood'])
  const lp = read('lib/server/concentratedLpPositions.ts')
  for (const [chain, id] of [['eth', 1], ['base', 8453], ['bnb', 56]] as const) {
    const cfg = V4_SWAP_CHAIN_CONFIG[chain]
    assert.equal(cfg.chainId, id)
    assert.match(lp, new RegExp(`${id}: "${cfg.poolManager}"`), `${chain} manager matches the repo's official-deployments table`)
  }
  assert.match(read('lib/server/uniswapV4RobinhoodRpc.ts'), new RegExp(V4_SWAP_CHAIN_CONFIG.robinhood.poolManager, 'i'))
  assert.deepEqual(Object.fromEntries(Object.entries(V4_SWAP_CHAIN_CONFIG).map(([k, v]) => [k, v.timestampMode])), {
    base: 'fixed_block_time', eth: 'header_anchor_interpolation', bnb: 'header_anchor_interpolation', robinhood: 'log_timestamp_only',
  })
  assert.equal(V4_SWAP_CHAIN_CONFIG.base.blockTimeSec, 2, 'Base keeps its fixed 2s blocks')
  assert.deepEqual([V4_SWAP_CHAIN_CONFIG.eth.native.coinId, V4_SWAP_CHAIN_CONFIG.bnb.native.coinId, V4_SWAP_CHAIN_CONFIG.robinhood.native.coinId], ['ethereum', 'binancecoin', 'ethereum'])
  assert.deepEqual(V4_SWAP_CHAIN_CONFIG.robinhood.nativeLike, { [NATIVE]: 18, '0x0bd7d308f8e1639fab988df18a8011f41eacad73': 18 }, 'Robinhood: native ETH + WETH verified by Uniswap deployments/4663.md')
  assert.equal(V4_SWAP_CHAIN_CONFIG.bnb.usdStable[USDT_BSC], 18, 'BSC USDT has 18 decimals')
  for (const cfg of Object.values(V4_SWAP_CHAIN_CONFIG)) assert.ok(cfg.managers.every((m) => m.protocol === 'uniswap_v4' && m.source.length > 10))
})

test('provider PoolId support is per provider AND per chain — none proven, so every V4 pool uses on-chain swaps', () => {
  for (const provider of ['coingecko', 'geckoterminal'] as const) {
    for (const net of ['base', 'eth', 'bsc', 'robinhood']) {
      assert.equal(V4_POOL_ID_OHLCV_SUPPORT[provider][net], false)
      assert.equal(v4PoolIdOhlcvSupported(provider, net), false)
    }
  }
  assert.doesNotMatch(read('lib/evmChartCandles.ts'), /cgPoolIdOk = input\.poolIdSupport\?\.coingecko \?\? COINGECKO_V4_POOL_ID_OHLCV_CONFIRMED/)
})

// ── Ethereum ─────────────────────────────────────────────────────────────────────────────────────
test('ETH V4 (WETH quote): exact manager + PoolId, one real header ~24h back, interpolated times, correct USD OHLC, 7 cold calls', async () => {
  resetV4SwapCandleCache()
  const c = CHAINS.eth
  const f = fakeRpc(c, { currency0: WETH_ETH, currency1: TOKEN, extra: (from, to) => [swapLog(ETH_MANAGER, OTHER_POOL, to, sqrtX96(1, 18, 18), BigInt(-1), BigInt(1), null)] })
  let ethSeriesCalls = 0
  const r = await loadV4SwapCandles({ chain: 'eth', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 3 }, { rpc: f.rpc, ethUsdSeries: async () => { ethSeriesCalls++; return series(3000)() } })
  assert.equal(r.ok, true, String(r.code))
  assert.deepEqual([r.chain, r.protocol, r.poolManager, r.initializeFound, r.timestampMode, r.counterAsset], ['eth', 'uniswap_v4', ETH_MANAGER, true, 'header_anchor_interpolation', 'eth'])
  for (const q of [...logQueries(f.calls, V4_INITIALIZE_TOPIC0), ...logQueries(f.calls, V4_SWAP_TOPIC0)]) {
    const p = q.params[0] as { address: string; topics: string[] }
    assert.equal(p.address, ETH_MANAGER, 'only the ETH PoolManager is read')
    assert.equal(p.topics[1], POOL, 'exact 32-byte PoolId topic, never truncated')
  }
  assert.ok(r.candles.every((k) => Math.abs(k.close - 3) < 1e-6), 'another pool on the shared manager never leaks in')
  const headers = f.calls.filter((x) => x.method === 'eth_getBlockByNumber').map((x) => x.params[0])
  assert.deepEqual(headers, ['latest', hex(c.latest - 7200 + 1)], 'latest + one real anchor header ~24h (7,200 ETH blocks) back — no per-block fanout')
  assert.equal(r.timeResolution, 'block_timestamp_lookup')
  assert.equal(r.intervalSec, 900)
  assert.deepEqual([r.callsUsed, ethSeriesCalls], [7, 1])
  assert.ok(r.callsUsed <= V4_SWAP_MAX_CALLS)
  // Interpolated times stay within one 15m bucket of the real chain time despite missed slots.
  const first = Date.parse(r.candles[0].timestamp) / 1000
  assert.ok(first >= tsOf(c, c.latest - 7200 + 1) - 900 && first <= NOW_TS)
  const pages = logQueries(f.calls, V4_SWAP_TOPIC0).map((q) => { const p = q.params[0] as { fromBlock: string; toBlock: string }; return Number(BigInt(p.toBlock)) - Number(BigInt(p.fromBlock)) + 1 })
  // The anchor showed 7,200 blocks span MORE than 24h (missed slots), so the window is trimmed to exactly
  // 24h at the measured rate, then split 1/6 : 1/3 : 1/2 (4h + 8h + 12h) — not Base block counts.
  const anchorBlock = c.latest - 7200 + 1
  const measured = (NOW_TS - tsOf(c, anchorBlock)) / (c.latest - anchorBlock)
  const total = Math.floor(24 * 3600 / measured)
  assert.ok(measured > 12, 'missed slots make the real block time longer than 12s')
  assert.deepEqual(pages, [Math.ceil(total / 6), Math.ceil(total / 3), total - Math.ceil(total / 6) - Math.ceil(total / 3)])
})

test('ETH: every log carrying its own blockTimestamp => exact 5M; the interpolation helper is exact on real anchors', async () => {
  resetV4SwapCandleCache()
  const f = fakeRpc(CHAINS.eth, { currency0: WETH_ETH, currency1: TOKEN, withTimestamps: true })
  const r = await loadV4SwapCandles({ chain: 'eth', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 3 }, { rpc: f.rpc, ethUsdSeries: series(3000) })
  assert.deepEqual([r.ok, r.timeResolution, r.intervalSec], [true, 'exact_log_timestamps', 300])
  const interp = interpolateBlockTime([{ block: 100, ts: 1000 }, { block: 200, ts: 2200 }, { block: 300, ts: 3000 }])
  assert.deepEqual([interp(100), interp(150), interp(200), interp(250), interp(300)], [1000, 1600, 2200, 2600, 3000])
})

test('ETH quote-side token (token is currency0 vs USDC currency1, 18 vs 6 decimals) and an arbitrary quote token via the one-hop lane', async () => {
  resetV4SwapCandleCache()
  const f = fakeRpc(CHAINS.eth, { currency0: TOKEN, currency1: USDC_ETH, price0in1: 0.5, dec0: 18, dec1: 6, withTimestamps: true })
  const r = await loadV4SwapCandles({ chain: 'eth', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 0.5 }, { rpc: f.rpc, ethUsdSeries: series(3000) })
  assert.equal(r.ok, true, String(r.code))
  assert.deepEqual([r.counterAsset, r.tokenCurrencyIndex], ['usd_stable', 0])
  assert.deepEqual([r.quote?.classification, r.quote?.attempt, r.quote?.decimals, r.quote?.failureReason], ['verified_stable', 'stable_usd', 6, null], 'exact verified stable ($1) on its own chain')
  assert.equal(f.calls.filter((c) => c.method === 'eth_call').length, 0, 'no registry proof call on a chain with static entries')
  assert.ok(r.candles.every((k) => Math.abs(k.close - 0.5) < 1e-9))
  resetV4SwapCandleCache()
  const OTHER = '0x' + '77'.repeat(20)
  const g = fakeRpc(CHAINS.eth, { currency0: OTHER, currency1: TOKEN, price0in1: 1000, withTimestamps: true })
  let anchorsSeen: string[] = []
  const r2 = await loadV4SwapCandles({ chain: 'eth', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 0.002 }, {
    rpc: g.rpc, ethUsdSeries: series(3000),
    quoteUsd: async (q) => { anchorsSeen = [...q.anchors]; return { ok: true, reason: null, detail: null, quoteSymbol: 'OTH', quoteDecimals: 18, pool: '0x' + 'ab'.repeat(20), pairedWith: WETH_ETH, points: Array.from({ length: 300 }, (_, i) => [(NOW_TS - 24 * 3600 + i * 300) * 1000, 2] as [number, number]), callsUsed: 2, cache: { discovery: false, series: false } } },
  })
  assert.equal(r2.ok, true, String(r2.code))
  assert.equal(r2.counterAsset, 'independent_quote')
  assert.ok(anchorsSeen.includes(WETH_ETH) && anchorsSeen.includes(USDC_ETH), 'ETH anchors: ETH/WETH + ETH stables')
  assert.ok(r2.candles.every((k) => Math.abs(k.close - 0.002) < 1e-9))
})

// ── BNB ──────────────────────────────────────────────────────────────────────────────────────────
test('BNB V4 (WBNB quote): BSC manager, independently priced BNB/USD series (never ETH), correct candles', async () => {
  resetV4SwapCandleCache()
  const f = fakeRpc(CHAINS.bnb, { currency0: WBNB, currency1: TOKEN, price0in1: 1000 })
  const coins: string[] = []
  let ethCalls = 0
  const deps: V4SwapDeps = { rpc: f.rpc, ethUsdSeries: async () => { ethCalls++; return series(3000)() }, nativeUsdSeries: async (coinId) => { coins.push(coinId); return series(600)() } }
  const r = await loadV4SwapCandles({ chain: 'bnb', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 0.6 }, deps)
  assert.equal(r.ok, true, String(r.code))
  assert.deepEqual([r.poolManager, r.counterAsset, r.quote?.symbol, r.quote?.source, r.timeResolution], [BNB_MANAGER, 'bnb', 'BNB', 'bnb_usd_series', 'block_timestamp_lookup'])
  assert.deepEqual([coins, ethCalls], [['binancecoin'], 0])
  assert.ok(r.candles.every((k) => Math.abs(k.close - 0.6) < 1e-9), '0.001 BNB x $600')
  assert.ok(logQueries(f.calls, V4_SWAP_TOPIC0).every((q) => (q.params[0] as { address: string }).address === BNB_MANAGER))
  // No BNB/USD source => honest gap, never ETH/USD in its place.
  resetV4SwapCandleCache()
  const noBnb = await loadV4SwapCandles({ chain: 'bnb', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 0.6 }, { rpc: fakeRpc(CHAINS.bnb, { currency0: WBNB, currency1: TOKEN }).rpc, ethUsdSeries: series(3000) })
  assert.equal(noBnb.code, 'quote_usd_price_unproven')
  // BSC USDT (18 decimals) as the quote.
  resetV4SwapCandleCache()
  const usdt = await loadV4SwapCandles({ chain: 'bnb', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 0.25 }, { rpc: fakeRpc(CHAINS.bnb, { currency0: TOKEN, currency1: USDT_BSC, price0in1: 0.25 }).rpc, ethUsdSeries: series(3000) })
  assert.equal(usdt.ok, true, String(usdt.code))
  assert.ok(usdt.candles.every((k) => Math.abs(k.close - 0.25) < 1e-9))
})

test('BNB PancakeSwap Infinity pool: v4_protocol_unsupported with zero calls (no verified Infinity contracts here)', async () => {
  resetV4SwapCandleCache()
  const f = fakeRpc(CHAINS.bnb, { currency0: WBNB, currency1: TOKEN })
  const r = await loadV4SwapCandles({ chain: 'bnb', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 0.6, dexHint: 'pancakeswap-infinity-cl-bsc' }, { rpc: f.rpc, ethUsdSeries: series(3000) })
  assert.deepEqual([r.code, f.calls.length], ['v4_protocol_unsupported', 0])
  assert.equal(v4ProtocolSupported('base', 'uniswap-v4-base'), true)
  assert.equal(v4ProtocolSupported('base', 'zora-v4-hooks'), true, 'hook launchpads on the Uniswap PoolManager are judged by their Initialize, not their label')
})

// ── Robinhood ────────────────────────────────────────────────────────────────────────────────────
test('Robinhood: native ETH quote with exact log timestamps => real candles; without them => v4_timestamps_unproven (never guessed)', async () => {
  resetV4SwapCandleCache()
  const f = fakeRpc(CHAINS.robinhood, { currency0: NATIVE, currency1: TOKEN, withTimestamps: true })
  const r = await loadV4SwapCandles({ chain: 'robinhood', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 3 }, { rpc: f.rpc, ethUsdSeries: series(3000) })
  assert.equal(r.ok, true, String(r.code))
  assert.deepEqual([r.poolManager, r.timeResolution, r.intervalSec, r.counterAsset], [RH_MANAGER, 'exact_log_timestamps', 300, 'eth'])
  resetV4SwapCandleCache()
  const g = fakeRpc(CHAINS.robinhood, { currency0: NATIVE, currency1: TOKEN, withTimestamps: false })
  const r2 = await loadV4SwapCandles({ chain: 'robinhood', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 3 }, { rpc: g.rpc, ethUsdSeries: series(3000) })
  assert.equal(r2.code, 'v4_timestamps_unproven')
  assert.equal(r2.candles.length, 0)
})

test('Robinhood without an RPC endpoint: the scan reports v4_rpc_unavailable (not v4_chain_not_supported)', () => {
  const route = read('app/api/token/route.ts')
  assert.match(route, /if \(!rpc\) return \{ ok: false, code: V4_SWAP_CHAIN_CONFIG\[chain\] \? 'v4_rpc_unavailable' : 'v4_chain_not_supported'/)
  assert.match(read('lib/server/v4SwapCandlesRpc.ts'), /rpcUrl: \(\) => getRobinhoodRpcUrl\(\) \?\? ''/)
})

// ── Integrity ────────────────────────────────────────────────────────────────────────────────────
test('wrong manager or wrong PoolId in the Initialize response => v4_initialize_not_found; nothing attributed', async () => {
  resetV4SwapCandleCache()
  const wrongMgr = await loadV4SwapCandles({ chain: 'eth', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 3 }, { rpc: fakeRpc(CHAINS.eth, { currency0: WETH_ETH, currency1: TOKEN, initManager: BNB_MANAGER }).rpc, ethUsdSeries: series(3000) })
  assert.equal(wrongMgr.code, 'v4_initialize_not_found')
  resetV4SwapCandleCache()
  const wrongId = await loadV4SwapCandles({ chain: 'eth', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 3 }, { rpc: fakeRpc(CHAINS.eth, { currency0: WETH_ETH, currency1: TOKEN, initPoolId: OTHER_POOL }).rpc, ethUsdSeries: series(3000) })
  assert.equal(wrongId.code, 'v4_initialize_not_found')
})

test('a swap log from another contract in the page is ignored', async () => {
  resetV4SwapCandleCache()
  const f = fakeRpc(CHAINS.eth, { currency0: WETH_ETH, currency1: TOKEN, withTimestamps: true, extra: (from, to) => [swapLog('0x' + 'de'.repeat(20), POOL, to, sqrtX96(1, 18, 18), BigInt(-1), BigInt(1), tsOf(CHAINS.eth, to))] })
  const r = await loadV4SwapCandles({ chain: 'eth', poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: 3 }, { rpc: f.rpc, ethUsdSeries: series(3000) })
  assert.ok(r.ok && r.candles.every((k) => Math.abs(k.close - 3) < 1e-6))
})

// ── Budget / cache ───────────────────────────────────────────────────────────────────────────────
test('cold / warm / cache-hit calls per chain; the whole ladder stays <= 10', async () => {
  const cold: Record<string, number> = {}
  const warm: Record<string, number> = {}
  const hit: Record<string, number> = {}
  for (const chain of ['eth', 'bnb', 'robinhood'] as const) {
    resetV4SwapCandleCache()
    const c = CHAINS[chain]
    const quote = chain === 'bnb' ? WBNB : chain === 'eth' ? WETH_ETH : NATIVE
    const mk = () => fakeRpc(c, { currency0: quote, currency1: TOKEN, withTimestamps: chain === 'robinhood' })
    const live = chain === 'bnb' ? 0.6 : 3
    const deps = (f: ReturnType<typeof fakeRpc>, cached: boolean, nowMs = NOW_TS * 1000): V4SwapDeps => ({ rpc: f.rpc, now: () => nowMs, ethUsdSeries: async () => ({ ...(await series(3000)()), cacheHit: cached }), nativeUsdSeries: async () => ({ ...(await series(600)()), cacheHit: cached }) })
    const a = await loadV4SwapCandles({ chain, poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: live }, deps(mk(), false))
    cold[chain] = a.callsUsed
    const h = await loadV4SwapCandles({ chain, poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: live }, deps(mk(), true))
    hit[chain] = h.callsUsed
    // 4 minutes later: the 3-minute result cache has expired; Initialize (24h) and the native series are warm.
    const b = await loadV4SwapCandles({ chain, poolId: POOL, token: TOKEN, tokenDecimals: 18, livePriceUsd: live }, deps(mk(), true, (NOW_TS + 240) * 1000))
    warm[chain] = b.callsUsed
    assert.equal(a.ok, true, `${chain} ${a.code}`)
  }
  assert.deepEqual(cold, { eth: 7, bnb: 7, robinhood: 7 })
  assert.deepEqual(warm, { eth: 5, bnb: 5, robinhood: 5 }, 'Initialize cached per PoolId, native series shared')
  assert.deepEqual(hit, { eth: 0, bnb: 0, robinhood: 0 })

  resetV4SwapCandleCache()
  const rel = { base_token: { data: { id: `eth_${TOKEN}` } }, quote_token: { data: { id: `eth_${WETH_ETH}` } }, dex: { data: { id: 'uniswap-v4-ethereum' } } }
  const lp = (addr: string): LadderPool => ({ poolId: `eth_${addr}`, address: addr, name: 'TKN / WETH', liquidityUsd: 1e5, pool: { id: `eth_${addr}`, relationships: rel } })
  const f = fakeRpc(CHAINS.eth, { currency0: WETH_ETH, currency1: TOKEN })
  const r = await runEvmCandleLadder(
    { pools: [lp(POOL), lp('0x' + '7a'.repeat(20)), lp('0x' + '7b'.repeat(20))], contract: TOKEN, networkId: 'eth', coingeckoNetworkId: 'eth', currentPriceUsd: 3 },
    {
      fetchCoingeckoPoolOhlcv: async () => ({ httpStatus: 404, json: null }),
      fetchPoolOhlcv: async () => ({ httpStatus: 404, json: null }),
      fetchTrades: async () => ({ httpStatus: 200, json: { data: [] } }),
      fetchV4SwapCandles: async (p, budget) => loadV4SwapCandles({ chain: 'eth', poolId: p.address, token: TOKEN, tokenDecimals: 18, livePriceUsd: 3 }, { rpc: f.rpc, ethUsdSeries: series(3000) }, budget),
    },
  )
  assert.equal(r.candleProvider, 'v4_swap_events')
  assert.ok(r.totalHttpCalls <= 10, String(r.totalHttpCalls))
  assert.equal(r.v4Swap?.chain, 'eth')
})

// ── On-demand history ────────────────────────────────────────────────────────────────────────────
test('ETH on-demand history: one real header near the cursor + one at the oldest block read; hourly candles strictly before the cursor; <= 8 calls', async () => {
  resetV4SwapCandleCache()
  const c = CHAINS.eth
  const f = fakeRpc(c, { currency0: WETH_ETH, currency1: TOKEN, everySec: 1200 })
  const ranges: Array<[number, number]> = []
  const deps: V4HistoryDeps = {
    rpc: f.rpc,
    now: () => NOW_TS * 1000,
    ethUsdRange: async (from, to) => { ranges.push([from, to]); const pts: Array<[number, number]> = []; for (let t = Math.floor(from / 3600) * 3600; t <= to; t += 3600) pts.push([t * 1000, 3000]); return { points: pts, cacheHit: false } },
  }
  const before = Math.floor((NOW_TS - 24 * 3600) / 3600) * 3600
  const h = await loadV4SwapHistoryWindow({ chain: 'eth', poolId: POOL, token: TOKEN, beforeSec: before }, deps)
  assert.equal(h.ok, true, String(h.code))
  assert.ok(h.callsUsed <= V4_HISTORY_MAX_CALLS)
  assert.equal(h.timeResolution, 'block_timestamp_lookup')
  assert.ok(h.candles.length > 24)
  assert.ok(h.candles.every((k) => Date.parse(k.timestamp) / 1000 < before && Math.abs(k.close - 3) < 1e-6))
  assert.ok(h.hasMore && h.nextBeforeSec! < before)
  const headerCalls = f.calls.filter((x) => x.method === 'eth_getBlockByNumber').length
  assert.equal(headerCalls, 3, 'latest + anchor near the cursor + oldest block read — no per-block fanout')
  for (const q of logQueries(f.calls, V4_SWAP_TOPIC0)) assert.equal((q.params[0] as { address: string }).address, ETH_MANAGER)
  assert.equal(ranges.length, 1)
})

test('Base unchanged and Solana untouched', () => {
  const src = read('lib/server/v4SwapCandlesRpc.ts')
  assert.match(src, /pagePlan = V4_SWAP_PAGE_PLAN/, 'Base keeps its fixed 7,200 / 14,400 / 21,600 block pages')
  assert.match(src, /: \(b: number\) => latestTs - \(latestBlock - b\) \* cfg\.blockTimeSec/, 'Base keeps fixed-2s inference')
  assert.doesNotMatch(src, /solana/i)
  assert.ok(!('solana' in V4_SWAP_CHAIN_CONFIG))
})
