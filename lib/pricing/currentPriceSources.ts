// lib/pricing/currentPriceSources.ts — production sources for the canonical current-price resolver.
// Every source here is an EXISTING ChainLens client (see currentPriceResolver.ts's reuse audit); this file
// only adapts them to the resolver's contracts. Server-only.

import { fetchDexscreenerPriceShared } from '@/src/lib/dexscreenerRequestCache'
import { GeckoTerminalClient } from '@/src/modules/fallbackPricing/geckoTerminalClient'
import { canonicalQuoteAssetAddresses } from '@/src/modules/quoteLegPricing/index'
import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'
import { fetchCoingeckoEthUsdRecent, isCoingeckoOnchainConfigured } from '@/lib/server/coingeckoOnchainOhlcv'
import { getRpcClientForChain, verifyOnchainDecimals } from '@/lib/engine/modules/pricing/rpcDecimals'
import { createOnchainPoolSource } from './onchainPoolSource'
import { kv as vercelKv } from '@vercel/kv'
import { getKvCircuitBreakerState } from '@/lib/server/cache/tokenCache'
import type { CurrentPriceL2Store, CurrentPriceResolverDeps, DexscreenerLookup, EthUsdLookup, GeckoTerminalLookup } from './currentPriceResolver'

const CHAIN: Record<number, SupportedChain> = { 1: 'eth', 8453: 'base', 42161: 'arbitrum' }
const ETH_USD_MAX_AGE_MS = 30 * 60 * 1000

export const dexscreenerSource: DexscreenerLookup = async (chainId, token) => {
  const chain = CHAIN[chainId]
  if (!chain) return { priceUsd: null, reason: 'unsupported_chain' }
  const r = await fetchDexscreenerPriceShared(token, chain, Date.now(), 'holdings')
  return { priceUsd: r.priceUsd, reason: r.reason, pairAddress: r.pairAddress, liquidityUsd: r.liquidityUsd }
}

const gtClients = new Map<SupportedChain, GeckoTerminalClient>()
export const geckoTerminalSource: GeckoTerminalLookup = async (chainId, token) => {
  const chain = CHAIN[chainId]
  if (!chain) return { network: null, pools: [], reason: 'unsupported_chain' }
  let client = gtClients.get(chain)
  if (!client) { client = new GeckoTerminalClient(chain); gtClients.set(chain, client) }
  return client.getTokenPools(token)
}

/** ETH/USD: CoinGecko's recent series (when configured and fresh), else DexScreener on the canonical WETH address. */
export const ethUsdSource: EthUsdLookup = async (chainId) => {
  if (isCoingeckoOnchainConfigured()) {
    // Same read as robinhoodWalletScanner.ts defaultEthUsdLatest: the latest [ms, price] point, if fresh.
    const s = await fetchCoingeckoEthUsdRecent(5_000).catch(() => null)
    const last = s?.points && s.points.length > 0 ? s.points[s.points.length - 1] : null
    if (last && Number.isFinite(last[1]) && last[1] > 0 && Date.now() - last[0] <= ETH_USD_MAX_AGE_MS) {
      return { priceUsd: last[1], observedAt: last[0], source: 'coingecko_eth_usd' }
    }
  }
  const chain = CHAIN[chainId]
  const weth = chain ? canonicalQuoteAssetAddresses(chain).weth[0] : undefined
  if (!chain || !weth) return null
  const r = await fetchDexscreenerPriceShared(weth, chain, Date.now(), 'holdings')
  return r.priceUsd != null && r.priceUsd > 0 ? { priceUsd: r.priceUsd, observedAt: Date.now(), source: 'dexscreener_canonical_weth' } : null
}

export const onchainPoolSource = createOnchainPoolSource(getRpcClientForChain, verifyOnchainDecimals)

// ─── L2: the existing ChainLens Vercel KV (same KV_REST_API_URL / KV_REST_API_TOKEN as lib/server/cache/
// tokenCache.ts and lib/server/kv.ts). Not routed through getTokenCache: that helper turns every failure
// into a silent miss (so read failures could not be counted), retries for up to ~1.9s per key, and has no
// batch read. This adapter instead does ONE `mget` per scan with a short timeout, throws on failure (the
// resolver counts it and falls through to the network), and honours tokenCache's open circuit breaker so
// a KV outage already detected elsewhere costs zero extra roundtrips here.
const L2_READ_TIMEOUT_MS = 250
const L2_WRITE_TIMEOUT_MS = 1_000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([p, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('kv_timeout')), ms) })]).finally(() => clearTimeout(timer))
}

export function kvConfiguredForCurrentPrice(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
}

export const vercelKvCurrentPriceL2: CurrentPriceL2Store = {
  async mget(keys) {
    if (keys.length === 0) return []
    if (getKvCircuitBreakerState().state === 'open') throw new Error('kv_circuit_open')
    return await withTimeout(vercelKv.mget<unknown[]>(...keys), L2_READ_TIMEOUT_MS)
  },
  async set(key, value, ttlSeconds) {
    if (getKvCircuitBreakerState().state === 'open') throw new Error('kv_circuit_open')
    await withTimeout(vercelKv.set(key, value, { ex: ttlSeconds }), L2_WRITE_TIMEOUT_MS)
  },
}

export function defaultCurrentPriceDeps(): CurrentPriceResolverDeps {
  return {
    l2: kvConfiguredForCurrentPrice() ? vercelKvCurrentPriceL2 : null,
    dexscreener: dexscreenerSource, geckoterminal: geckoTerminalSource, onchain: onchainPoolSource, ethUsd: ethUsdSource,
  }
}
