// SELL VENUE CLASSIFIER (audit labels only — never a proof, never feeds a sell decision).
//
// Labels the venue of a one-legged outbound event's receipt so the [sell-receipt-proof] log can show
// where unproven sells actually trade:
//   aggregator      the tx was sent to a verified aggregator router in src/lib/knownDexRouters.ts
//   v4              a Swap from the chain's canonical Uniswap V4 PoolManager
//   aerodrome       Aerodrome Classic's own Swap event, or a pool whose factory() is an Aerodrome factory
//   v3 / v2         V3- / V2-shaped Swap on a pool whose factory() is the chain's Uniswap V3 / V2 factory
//   plain_transfer  only ERC-20 Transfers; the wallet sent and received nothing
//   unknown         anything else (unrecognised swap events, unknown factories, other contracts)
// A pool's factory() is the pool's own claim — fine for a label, not proof (proof stays factory-side).

import { toEventSelector } from 'viem'
import { knownDexRouterProtocol, type KnownDexRouterProtocol } from './knownDexRouters'
import { V4_POOL_MANAGERS, V4_SWAP_TOPIC0 } from './v4RouteQuote'
import { classifyNoSwapReceipt } from '../modules/receiptSwapDecoder/unmatchedSellReceiptProof'
import { getSharedBaseClient, getSharedEthereumClient } from '../modules/receiptSwapDecoder/rpcClient'
import type { RawReceiptLog } from '../modules/receiptSwapDecoder/types'

export type SellVenue = 'v2' | 'v3' | 'v4' | 'aerodrome' | 'aggregator' | 'plain_transfer' | 'unknown'
export const SELL_VENUES: readonly SellVenue[] = ['v2', 'v3', 'v4', 'aerodrome', 'aggregator', 'plain_transfer', 'unknown']

export const V2_SWAP_TOPIC0 = toEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)')
export const AERODROME_CLASSIC_SWAP_TOPIC0 = toEventSelector('Swap(address,address,uint256,uint256,uint256,uint256)')
export const V3_SWAP_TOPIC0 = toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24)')

const AGGREGATOR_PROTOCOLS: ReadonlySet<KnownDexRouterProtocol> = new Set([
  'OneInchRouter', 'OneInchRouterV5', 'OneInchRouterV6', 'ZeroExExchangeProxy', 'ZeroExSettler', 'Paraswap', 'ParaswapV6', 'LiFiDiamond',
])

// Factories already used elsewhere in this repo (poolValidator.ts, uniswapV3PoolValidator.ts,
// lib/pricing/onchainPoolSource.ts). Lowercased.
const FACTORY_VENUES: Record<'base' | 'eth', Record<string, SellVenue>> = {
  base: {
    '0x420dd381b31aef6683db6b902084cb0ffece40da': 'aerodrome', // Aerodrome Classic
    '0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a': 'aerodrome', // Aerodrome Slipstream
    '0x33128a8fc17869897dce68ed026d694621f6fdfd': 'v3', // Uniswap V3
    '0x8909dc15e40173ff4699343b6eb8132c65e18ec6': 'v2', // Uniswap V2
  },
  eth: {
    '0x1f98431c8ad98523631ae4a59f267346ea31f984': 'v3', // Uniswap V3
    '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f': 'v2', // Uniswap V2
  },
}

export type PoolFactoryReader = (chain: 'base' | 'eth', pool: string) => Promise<string | null>

const POOL_FACTORY_ABI = [{ type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] }] as const

/** pool.factory() on the chain's shared client; cached per scan instance. Any failure → null. */
export function createLivePoolFactoryReader(): PoolFactoryReader {
  const cache = new Map<string, Promise<string | null>>()
  return (chain, pool) => {
    const key = `${chain}:${pool.toLowerCase()}`
    const hit = cache.get(key)
    if (hit) return hit
    const run = (async () => {
      const client = chain === 'eth' ? getSharedEthereumClient() : getSharedBaseClient()
      if (!client) return null
      try {
        const factory = await client.readContract({ address: pool as `0x${string}`, abi: POOL_FACTORY_ABI, functionName: 'factory' })
        return typeof factory === 'string' ? factory.toLowerCase() : null
      } catch {
        return null
      }
    })()
    cache.set(key, run)
    return run
  }
}

const PRIORITY: readonly SellVenue[] = ['v4', 'aerodrome', 'v3', 'v2']

export async function classifySellVenue(params: {
  chain: 'base' | 'eth'
  walletAddress: string
  logs: readonly RawReceiptLog[]
  txTo?: string | null
  readPoolFactory?: PoolFactoryReader
}): Promise<SellVenue> {
  const protocol = knownDexRouterProtocol(params.txTo ?? null)
  if (protocol && AGGREGATOR_PROTOCOLS.has(protocol)) return 'aggregator'

  const manager = V4_POOL_MANAGERS[params.chain]
  const found = new Set<SellVenue>()
  let unrecognisedSwap = false
  for (const log of params.logs) {
    const topic0 = (log.topics[0] ?? '').toLowerCase()
    const address = log.address.toLowerCase()
    if (topic0 === V4_SWAP_TOPIC0) {
      if (address === manager) found.add('v4')
      else unrecognisedSwap = true
    } else if (topic0 === AERODROME_CLASSIC_SWAP_TOPIC0) {
      found.add('aerodrome')
    } else if (topic0 === V3_SWAP_TOPIC0 || topic0 === V2_SWAP_TOPIC0) {
      const factory = params.readPoolFactory ? await params.readPoolFactory(params.chain, address).catch(() => null) : null
      const venue = factory ? FACTORY_VENUES[params.chain][factory] : undefined
      // A V2-shaped event from a V3 factory (or the reverse) is not a recognised venue.
      const shapeMatches = venue === 'aerodrome' || (venue === 'v3' && topic0 === V3_SWAP_TOPIC0) || (venue === 'v2' && topic0 === V2_SWAP_TOPIC0)
      if (venue && shapeMatches) found.add(venue)
      else unrecognisedSwap = true
    }
  }
  for (const venue of PRIORITY) if (found.has(venue)) return venue
  if (unrecognisedSwap) return 'unknown'
  if (params.logs.length > 0 && classifyNoSwapReceipt(params.logs, params.walletAddress) === 'one_way_transfer_only') return 'plain_transfer'
  return 'unknown'
}
