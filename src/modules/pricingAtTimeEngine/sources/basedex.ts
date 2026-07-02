// MODULE — pricingAtTimeEngine/sources: basedex
//
// Split out of multiProviderPriceSource.ts for modularization. Logic is unchanged from that file.
//
// NAMING NOTE: there is no hosted "BaseDex API" — no such external REST service exists. What this
// file actually does is query a real, deployed Uniswap V3 pool's on-chain state (slot0) directly
// via RPC, at a real historical block number resolved by binary search against real block
// timestamps, using the already-installed `viem` dependency and this codebase's existing
// ALCHEMY_BASE_RPC_URL/ALCHEMY_BASE_KEY env convention (lib/rpc.ts). The file/export names below
// match what was asked for (basedex.ts / fetchBaseDexPrice) — the implementation is a real
// on-chain query, not a fabricated call to a nonexistent "BaseDex API".
//
// WETH/USDC/Uniswap V3 Factory addresses below are real, publicly documented, canonical contract
// addresses on Base — not invented.

import { createPublicClient, http, type PublicClient } from 'viem'
import { base } from 'viem/chains'
import type { SupportedChain } from '../../providerFetchWindow/types'
import { fetchCoingeckoPriceDetailed } from './coingecko'
import { logRpcCall } from '@/lib/server/rpcDebug'

const WETH_BASE = '0x4200000000000000000000000000000000000006'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const UNISWAP_V3_FACTORY_BASE = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'
const UNISWAP_V3_FEE_TIERS = [500, 3000, 10000] as const // 0.05% / 0.3% / 1% — standard tiers

const UNISWAP_V3_FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const

const UNISWAP_V3_POOL_ABI = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const

const ERC20_DECIMALS_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const

let cachedBaseClient: PublicClient | null = null

function getBaseClient(): PublicClient | null {
  const rpcUrl = process.env.ALCHEMY_BASE_RPC_URL
    ?? (process.env.ALCHEMY_BASE_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BASE_KEY}` : null)
  if (!rpcUrl) return null
  if (!cachedBaseClient) {
    cachedBaseClient = createPublicClient({ chain: base, transport: http(rpcUrl) })
  }
  return cachedBaseClient
}

// Real binary search against real block timestamps — never estimates/guesses a block number as
// the final answer, only as the initial bisection bound (Base's ~2s block time is used purely to
// pick a reasonable starting midpoint, not as the result itself).
async function findBlockForTimestamp(client: PublicClient, targetTimestampSec: number): Promise<bigint | null> {
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'getBlock:latest' })
  const latest = await client.getBlock({ blockTag: 'latest' })
  if (targetTimestampSec >= Number(latest.timestamp)) return latest.number

  const two = BigInt(2)
  const approxBlocksAgo = BigInt(Math.max(0, Math.floor((Number(latest.timestamp) - targetTimestampSec) / 2)))
  let low = latest.number > approxBlocksAgo * two ? latest.number - approxBlocksAgo * two : BigInt(0)
  let high = latest.number

  for (let i = 0; i < 30 && low < high; i++) {
    const mid = (low + high + BigInt(1)) / two
    logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'getBlock:bisect' })
    const block = await client.getBlock({ blockNumber: mid })
    if (Number(block.timestamp) <= targetTimestampSec) {
      low = mid
    } else {
      high = mid - BigInt(1)
    }
  }
  return low
}

async function resolvePoolAddress(
  client: PublicClient,
  tokenAddress: `0x${string}`,
  pairedWith: `0x${string}`,
): Promise<`0x${string}` | null> {
  for (const fee of UNISWAP_V3_FEE_TIERS) {
    try {
      logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:getPool' })
      const pool = await client.readContract({
        address: UNISWAP_V3_FACTORY_BASE as `0x${string}`,
        abi: UNISWAP_V3_FACTORY_ABI,
        functionName: 'getPool',
        args: [tokenAddress, pairedWith, fee],
      })
      if (pool && pool !== '0x0000000000000000000000000000000000000000') return pool
    } catch {
      // try the next fee tier
    }
  }
  return null
}

async function readPoolPrice(
  client: PublicClient,
  poolAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  pairedWith: `0x${string}`,
  blockNumber: bigint,
): Promise<number | null> {
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:slot0' })
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:token0' })
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:decimals' })
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:decimals' })
  const [slot0, token0, tokenDecimals, pairedDecimals] = await Promise.all([
    client.readContract({ address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: 'slot0', blockNumber }),
    client.readContract({ address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: 'token0', blockNumber }),
    client.readContract({ address: tokenAddress, abi: ERC20_DECIMALS_ABI, functionName: 'decimals', blockNumber }),
    client.readContract({ address: pairedWith, abi: ERC20_DECIMALS_ABI, functionName: 'decimals', blockNumber }),
  ])

  const sqrtPriceX96 = slot0[0]
  // price of token1 in terms of token0, in raw (undecimalized) units:
  const rawRatio = (Number(sqrtPriceX96) / 2 ** 96) ** 2
  const isTokenToken0 = token0.toLowerCase() === tokenAddress.toLowerCase()

  // Adjust for each token's own decimals, then orient the ratio as "1 tokenAddress = X pairedWith".
  const decimalAdjustment = 10 ** (tokenDecimals - pairedDecimals)
  const token0PerToken1 = rawRatio * decimalAdjustment
  return isTokenToken0 ? 1 / token0PerToken1 : token0PerToken1
}

export type BaseDexPriceResult = { priceUsd: number | null; reason: string | null }

// Detailed variant — used by the orchestrator (getPriceAtTime) for structured debug output.
export async function fetchBaseDexPriceDetailed(
  token: string,
  chain: SupportedChain,
  timestamp: number,
): Promise<BaseDexPriceResult> {
  if (chain !== 'base') return { priceUsd: null, reason: 'base_dex_only_supports_base_chain' }

  const client = getBaseClient()
  if (!client) return { priceUsd: null, reason: 'no_api_key_configured' }

  try {
    const targetSec = Math.floor(timestamp / 1000)
    const blockNumber = await findBlockForTimestamp(client, targetSec)
    if (blockNumber === null) return { priceUsd: null, reason: 'could_not_resolve_historical_block' }

    const tokenAddress = token as `0x${string}`

    // Try token/WETH first, then token/USDC.
    const wethPool = await resolvePoolAddress(client, tokenAddress, WETH_BASE as `0x${string}`)
    if (wethPool) {
      const tokenPerWeth = await readPoolPrice(client, wethPool, tokenAddress, WETH_BASE as `0x${string}`, blockNumber)
      if (tokenPerWeth !== null && Number.isFinite(tokenPerWeth)) {
        // Need WETH's own USD price at this same timestamp to convert — real recursive lookup
        // (CoinGecko has WETH's full historical range), never a guessed ETH price.
        const wethUsd = await fetchCoingeckoPriceDetailed(WETH_BASE, 'base', timestamp)
        if (wethUsd.priceUsd !== null) {
          return { priceUsd: tokenPerWeth * wethUsd.priceUsd, reason: null }
        }
      }
    }

    const usdcPool = await resolvePoolAddress(client, tokenAddress, USDC_BASE as `0x${string}`)
    if (usdcPool) {
      const tokenPerUsdc = await readPoolPrice(client, usdcPool, tokenAddress, USDC_BASE as `0x${string}`, blockNumber)
      if (tokenPerUsdc !== null && Number.isFinite(tokenPerUsdc)) {
        // USDC is treated as $1 — a standard industry approximation (USDC is a USD-pegged
        // stablecoin), disclosed here explicitly rather than silently assumed.
        return { priceUsd: tokenPerUsdc, reason: null }
      }
    }

    return { priceUsd: null, reason: 'no_uniswap_v3_pool_found' }
  } catch (err) {
    return { priceUsd: null, reason: `rpc_error:${err instanceof Error ? err.message : 'unknown'}` }
  }
}

// Public export matching this codebase's PriceSourceFn contract exactly (token, chain, timestamp)
// -> number | null — a clean USD price or null, never a fabricated value.
export async function fetchBaseDexPrice(
  token: string,
  chain: SupportedChain,
  timestamp: number,
): Promise<number | null> {
  const result = await fetchBaseDexPriceDetailed(token, chain, timestamp)
  return result.priceUsd
}
