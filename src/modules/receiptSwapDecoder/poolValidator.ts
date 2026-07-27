// MODULE — receiptSwapDecoder: pool/factory validation.
//
// A pool address alone (even one that emits a byte-identical Swap event) is not sufficient
// evidence it's a real Aerodrome pool — any contract can emit an arbitrary log. Validation confirms
// the pool address was actually returned by the canonical Aerodrome factory for the pair of tokens
// the decoded Swap event claims to involve. `PoolValidator` is an injectable interface so decode
// logic stays pure/offline-testable via fixtures; `createLiveBaseDexPoolValidator` is the real,
// on-chain implementation used outside tests, reusing the exact same canonical factory addresses
// already verified and shipped in basedex.ts (not re-derived or guessed here).

import { createPublicClient, http, type PublicClient } from 'viem'
import { base } from 'viem/chains'
import type { ReceiptSwapProtocol } from './types'

// Same canonical, previously-verified addresses as basedex.ts — see that file's own header for the
// full provenance/verification disclosure. Not re-derived here; imported by value would create a
// pricing<->decoder coupling this module doesn't need, so the constants are restated (identical
// values, same source of truth: aerodrome-finance repositories).
export const AERODROME_CLASSIC_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da'
export const AERODROME_SLIPSTREAM_FACTORY = '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A'

const CLASSIC_FACTORY_ABI = [
  {
    type: 'function', name: 'getPool', stateMutability: 'view',
    inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'stable', type: 'bool' }],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const

const SLIPSTREAM_FACTORY_ABI = [
  {
    type: 'function', name: 'getPool', stateMutability: 'view',
    inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'tickSpacing', type: 'int24' }],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const

// Same tick-spacing enumeration basedex.ts uses for Slipstream pool discovery.
const SLIPSTREAM_TICK_SPACINGS = [1, 50, 100, 200, 2000] as const

export type PoolValidator = {
  isValidPool(protocol: ReceiptSwapProtocol, poolAddress: string, token0: string, token1: string): Promise<boolean>
}

let cachedClient: PublicClient | null = null
function getClient(): PublicClient | null {
  const rpcUrl = process.env.ALCHEMY_BASE_RPC_URL
    ?? (process.env.ALCHEMY_BASE_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BASE_KEY}` : null)
  if (!rpcUrl) return null
  if (!cachedClient) cachedClient = createPublicClient({ chain: base, transport: http(rpcUrl) })
  return cachedClient
}

// FAIL-CLOSED, DISCLOSED: any RPC failure, missing config, or a factory returning the zero address
// for every attempted key resolves to `false` (not validated) — never treated as "validated" by
// default. Callers (index.ts) fail closed to the inference path whenever validation isn't `true`.
export function createLiveBaseDexPoolValidator(): PoolValidator {
  return {
    async isValidPool(protocol, poolAddress, token0, token1): Promise<boolean> {
      const client = getClient()
      if (!client) return false
      const target = poolAddress.toLowerCase()
      try {
        if (protocol === 'aerodrome_classic') {
          const pool = await client.readContract({
            address: AERODROME_CLASSIC_FACTORY as `0x${string}`,
            abi: CLASSIC_FACTORY_ABI,
            functionName: 'getPool',
            args: [token0 as `0x${string}`, token1 as `0x${string}`, false],
          })
          return typeof pool === 'string' && pool.toLowerCase() === target
        }
        for (const tickSpacing of SLIPSTREAM_TICK_SPACINGS) {
          const pool = await client.readContract({
            address: AERODROME_SLIPSTREAM_FACTORY as `0x${string}`,
            abi: SLIPSTREAM_FACTORY_ABI,
            functionName: 'getPool',
            args: [token0 as `0x${string}`, token1 as `0x${string}`, tickSpacing],
          })
          if (typeof pool === 'string' && pool.toLowerCase() === target) return true
        }
        return false
      } catch {
        return false
      }
    },
  }
}
