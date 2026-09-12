// MODULE 2 — canonical token decimals.
//
// CONFIRMED PRODUCTION BUG, DISCLOSED (same-tx Base USDC quote scaling): Base USDC
// 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 is a 6-decimal token. When providerDecimals is
// missing/null or wrongly reported as 18, parseAmount's fallback of 18 divides a raw integer such
// as 2996415704 by 10^18 instead of 10^6, producing quoteQuantity 2.996415704e-9 (and derived
// token prices 10^12 too small). That is NOT a double-application of 10^6; it is a single
// normalize using the wrong decimals. This module is the single source of truth for the
// address-verified tokens whose decimals are a protocol invariant — canonical ALWAYS wins over
// provider/RPC/fallback 18.
//
// HARD INVARIANT: Base USDC must normalize exactly once at 6 decimals. Callers must never
// re-divide an already-normalized amount.

import type { SupportedChain } from '../providerFetchWindow/types'

export const BASE_USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

// 10^(18-6): the exact scale error of treating a 6-decimal raw integer as 18-decimal wei.
export const EIGHTEEN_VS_SIX_SCALE = 1e12

// Address-verified stables / native wrappers whose decimals are a protocol invariant. Kept as an
// independent copy of the same well-known addresses quoteLegPricing / quoteLegRecovery already
// recognize (no runtime coupling between those modules and this one). Unknown tokens are NOT
// listed — they keep using the provider's own decimals, then fallback 18.
const CANONICAL_TOKEN_DECIMALS: Partial<Record<SupportedChain, Record<string, number>>> = {
  eth: {
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6, // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 6, // USDT
    '0x6b175474e89094c44da98b954eedeac495271d0f': 18, // DAI
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 18, // WETH
  },
  base: {
    [BASE_USDC_ADDRESS]: 6, // USDC
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 6, // USDbC
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 18, // DAI
    '0x4200000000000000000000000000000000000006': 18, // WETH
  },
  arbitrum: {
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 6, // USDC
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 6, // USDC.e
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 6, // USDT
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 18, // DAI
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 18, // WETH
  },
}

export type DecimalSource = 'canonical' | 'provider' | 'fallback_18'

export type TokenDecimalResolution = {
  decimals: number
  source: DecimalSource
  canonicalDecimals: number | null
  providerDisagreedWithCanonical: boolean
}

export function canonicalTokenDecimals(chain: string | null | undefined, token: string | null | undefined): number | null {
  if (!chain || !token) return null
  const map = CANONICAL_TOKEN_DECIMALS[chain as SupportedChain]
  if (!map) return null
  return map[token.toLowerCase()] ?? null
}

export function resolveTokenDecimals(params: {
  chain?: string | null
  token?: string | null
  providerDecimals?: number | null
}): TokenDecimalResolution {
  const canonical = canonicalTokenDecimals(params.chain, params.token)
  const provider = typeof params.providerDecimals === 'number' && Number.isFinite(params.providerDecimals) && params.providerDecimals >= 0
    ? params.providerDecimals
    : null
  if (canonical != null) {
    return {
      decimals: canonical,
      source: 'canonical',
      canonicalDecimals: canonical,
      providerDisagreedWithCanonical: provider != null && provider !== canonical,
    }
  }
  if (provider != null) {
    return { decimals: provider, source: 'provider', canonicalDecimals: null, providerDisagreedWithCanonical: false }
  }
  return { decimals: 18, source: 'fallback_18', canonicalDecimals: null, providerDisagreedWithCanonical: false }
}

export function isAlreadyNormalizedAmountString(value: string): boolean {
  const s = value.trim()
  if (!s) return false
  if (/^0x[0-9a-fA-F]+$/i.test(s)) return false
  if (/[eE]/.test(s)) return true
  return s.includes('.')
}

export function hexAmountToIntegerString(value: string): string | null {
  const s = value.trim()
  if (!/^0x[0-9a-fA-F]+$/i.test(s)) return null
  try {
    return BigInt(s).toString(10)
  } catch {
    return null
  }
}
