// lib/server/v4SwapHistoryDeps.ts — production wiring for on-demand Uniswap V4 chart history
// (lib/server/v4SwapCandlesRpc.ts loadV4SwapHistoryWindow). Used ONLY by GET /api/token/chart-candles
// with timeframe=history, i.e. after the user asks for older candles — never during a scan.
//
// Quote USD for a history window: CoinGecko's hourly ETH/USD for that window, or the quote token's
// independent WETH/stable pool's hourly candles ending at the window's end (CoinGecko on-chain when
// configured, else GeckoTerminal). The CoinGecko key stays inside lib/server/coingeckoOnchainOhlcv.ts.

import { EVM_CHART_NETWORK } from '../evmChartCandles.ts'
import { fetchCoingeckoEthUsdRange, fetchCoingeckoNativeUsdRange, fetchCoingeckoOnchainPoolOhlcv, isCoingeckoOnchainConfigured } from './coingeckoOnchainOhlcv.ts'
import { resolveIndependentQuoteUsdWindow } from './v4QuoteUsd.ts'
import { makeV4Rpc, V4_SWAP_CHAIN_CONFIG, type V4HistoryDeps } from './v4SwapCandlesRpc.ts'

const gtBase = () => (process.env.GECKO_BASE_URL ?? 'https://api.geckoterminal.com').replace(/\/$/, '')

async function gtJson(url: string, timeoutMs: number): Promise<{ json: unknown; httpStatus: number | null }> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json;version=20230302' }, cache: 'no-store', signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, timeoutMs))) })
    return { json: res.ok ? await res.json().catch(() => null) : null, httpStatus: res.status }
  } catch {
    return { json: null, httpStatus: null }
  }
}

export function makeV4HistoryDeps(chain: string): V4HistoryDeps | null {
  const rpc = makeV4Rpc(chain)
  const network = EVM_CHART_NETWORK[chain]
  if (!rpc || !network || !V4_SWAP_CHAIN_CONFIG[chain]) return null
  return {
    rpc,
    ethUsdRange: (fromSec, toSec, timeoutMs) => fetchCoingeckoEthUsdRange(fromSec, toSec, timeoutMs),
    nativeUsdRange: (coinId, fromSec, toSec, timeoutMs) => fetchCoingeckoNativeUsdRange(coinId, fromSec, toSec, timeoutMs),
    quoteUsdWindow: (q) => resolveIndependentQuoteUsdWindow({ chain, ...q }, {
      fetchTokenPools: (_c, quoteToken, timeoutMs) => gtJson(`${gtBase()}/api/v2/networks/${network}/tokens/${quoteToken}/pools?page=1&include=base_token%2Cquote_token`, timeoutMs),
      fetchPoolUsdOhlcvBefore: (_c, pool, side, req, beforeSec, timeoutMs) => isCoingeckoOnchainConfigured()
        ? fetchCoingeckoOnchainPoolOhlcv(chain, pool, req, side, undefined, beforeSec)
        : gtJson(`${gtBase()}/api/v2/networks/${network}/pools/${pool}/ohlcv/${req.resolution}?aggregate=${req.aggregate}&limit=${req.limit}&currency=usd&token=${side}&before_timestamp=${beforeSec}`, timeoutMs),
    }),
  }
}
