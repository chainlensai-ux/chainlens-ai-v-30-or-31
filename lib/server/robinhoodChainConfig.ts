// ROBINHOOD CHAIN CONFIG, DISCLOSED (env verification + feature flag wiring task): SERVER-ONLY —
// this module reads ALCHEMY_ROBINHOOD_RPC_URL directly, which embeds an Alchemy API key. It must
// never be imported from a 'use client' component. The frontend only ever learns booleans via
// app/api/base-radar/chain-status/route.ts, never the URL itself.
//
// Scope, disclosed: this task is env verification + flag wiring ONLY. No function here performs an
// RPC/network call, and nothing in the app calls Robinhood Chain from any default scan, the Base
// Radar feed, or a background refresh — the only caller is the chain-status route, which itself
// only reports config presence, never fetches from the RPC.

export const ROBINHOOD_CHAIN_ID = 4663
export const ROBINHOOD_CHAIN_SLUG = 'robinhood'
export const ROBINHOOD_CHAIN_NAME = 'Robinhood Chain'
export const ROBINHOOD_CHAIN_EXPLORER_URL = 'https://robinhoodchain.blockscout.com'
export const ROBINHOOD_CHAIN_NATIVE_CURRENCY = 'ETH'

export interface RobinhoodChainConfig {
  chainId: number
  slug: string
  name: string
  rpcUrl: string | null
  explorerUrl: string
  nativeCurrency: string
}

export function isRobinhoodChainFeatureEnabled(): boolean {
  return process.env.ENABLE_ROBINHOOD_CHAIN === 'true'
}

export function getRobinhoodRpcUrl(): string | null {
  const url = process.env.ALCHEMY_ROBINHOOD_RPC_URL
  return typeof url === 'string' && url.trim().length > 0 ? url.trim() : null
}

export function isRobinhoodRpcConfigured(): boolean {
  return getRobinhoodRpcUrl() != null
}

// Both the feature flag AND a configured RPC URL are required — this is the single source of
// truth the frontend selector gates on (via /api/base-radar/chain-status) for whether Robinhood
// Chain should even appear as an option.
export function isRobinhoodChainAvailable(): boolean {
  return isRobinhoodChainFeatureEnabled() && isRobinhoodRpcConfigured()
}

export function getRobinhoodChainConfig(): RobinhoodChainConfig {
  return {
    chainId: ROBINHOOD_CHAIN_ID,
    slug: ROBINHOOD_CHAIN_SLUG,
    name: ROBINHOOD_CHAIN_NAME,
    rpcUrl: getRobinhoodRpcUrl(),
    explorerUrl: ROBINHOOD_CHAIN_EXPLORER_URL,
    nativeCurrency: ROBINHOOD_CHAIN_NATIVE_CURRENCY,
  }
}

export interface RobinhoodChainConfigAudit {
  enabled: boolean
  rpcConfigured: boolean
  chainId: number
  selectedChain: string
}

// NEVER-LOG-SECRETS, DISCLOSED: returns only booleans/chainId/the caller-supplied selectedChain
// string — never the RPC URL (which embeds an Alchemy API key) or any substring of it. Safe to
// log verbatim or return in an API response.
export function robinhoodChainConfigAudit(selectedChain: string): RobinhoodChainConfigAudit {
  return {
    enabled: isRobinhoodChainFeatureEnabled(),
    rpcConfigured: isRobinhoodRpcConfigured(),
    chainId: ROBINHOOD_CHAIN_ID,
    selectedChain,
  }
}
