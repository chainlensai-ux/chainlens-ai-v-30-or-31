// MODULE — swapNormalizer: known router registry.
//
// VERIFICATION DISCLOSURE: Uniswap V2 Router02, Uniswap V3 SwapRouter, Uniswap V3 SwapRouter02, and
// SushiSwap's Ethereum RouteProcessor/Router addresses below are widely-documented, long-standing
// canonical deployments. Aerodrome's and BaseSwap's router addresses are real, publicly documented
// Base deployments at the time this module was written, but — unlike addresses reused elsewhere in
// this codebase that were cross-checked against an installed SDK's own type declarations — this
// sandbox has no network access to re-verify them against a live block explorer right now. Treat
// AERODROME and BASESWAP specifically as best-effort and re-confirm against BaseScan before relying
// on them for anything beyond this module's own classification label.
//
// Uniswap V3 SwapRouter02 (0x2626...481) is deployed at the SAME address on Ethereum, Base,
// Arbitrum, and Optimism (Uniswap Labs' deterministic multi-chain deploy) — real, not a coincidence.

import type { SwapNormalizerChain } from './types'

export type RouterType =
  | 'UNISWAP_V2'
  | 'UNISWAP_V3'
  | 'AERODROME'
  | 'BASESWAP'
  | 'SUSHI'
  | 'UNKNOWN_ROUTER'

type RouterEntry = { type: RouterType; name: string }

const ROUTER_REGISTRY: Record<SwapNormalizerChain, Record<string, RouterEntry>> = {
  eth: {
    '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': { type: 'UNISWAP_V2', name: 'Uniswap V2 Router02' },
    '0xe592427a0aece92de3edee1f18e0157c05861564': { type: 'UNISWAP_V3', name: 'Uniswap V3 SwapRouter' },
    '0x2626664c2603336e57b271c5c0b26f421741e481': { type: 'UNISWAP_V3', name: 'Uniswap V3 SwapRouter02' },
    '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f': { type: 'SUSHI', name: 'SushiSwap Router' },
  },
  base: {
    '0x2626664c2603336e57b271c5c0b26f421741e481': { type: 'UNISWAP_V3', name: 'Uniswap V3 SwapRouter02' },
    '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43': { type: 'AERODROME', name: 'Aerodrome Router' },
    '0x327df1e6de05895d2ab08513aadd9313fe505d86': { type: 'BASESWAP', name: 'BaseSwap Router' },
  },
  arbitrum: {
    '0x2626664c2603336e57b271c5c0b26f421741e481': { type: 'UNISWAP_V3', name: 'Uniswap V3 SwapRouter02' },
  },
  optimism: {
    '0x2626664c2603336e57b271c5c0b26f421741e481': { type: 'UNISWAP_V3', name: 'Uniswap V3 SwapRouter02' },
  },
}

// PURE. Never throws; an unrecognized address returns null rather than guessing a router type.
export function detectRouterType(chain: SwapNormalizerChain, routerAddress: string | null | undefined): RouterType | null {
  if (!routerAddress) return null
  const entry = ROUTER_REGISTRY[chain]?.[routerAddress.toLowerCase()]
  return entry ? entry.type : null
}

export function isKnownRouter(chain: SwapNormalizerChain, address: string | null | undefined): boolean {
  if (!address) return false
  return Boolean(ROUTER_REGISTRY[chain]?.[address.toLowerCase()])
}

export function routerName(chain: SwapNormalizerChain, routerAddress: string | null | undefined): string | null {
  if (!routerAddress) return null
  return ROUTER_REGISTRY[chain]?.[routerAddress.toLowerCase()]?.name ?? null
}
